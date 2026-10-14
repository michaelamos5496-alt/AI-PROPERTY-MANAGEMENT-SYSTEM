import { timingSafeEqual, createHash } from 'node:crypto';
import express, { Router } from 'express';
import type { Env } from '../lib/env.js';
import type { Logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { ServiceApi } from '../services/supabase.js';
import { extractBatches, verifySignature } from '../whatsapp/webhook.js';
import { processEvents, sendOutbound, type WaRuntime } from '../whatsapp/worker.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Meta's webhook. It is public by design, so nothing is trusted until the signature over the exact bytes received verifies.
 *  GET  = one-time subscription handshake (verify token).
 *  POST = events. Order of work: verify signature -> save every event durably -> (bounded) process -> answer 200.
 * If saving fails we answer 500 so Meta redelivers; once saved, processing problems never cause a non-200 because the
 * events are already safe in the inbox and the worker will retry them.
 */
export function whatsappWebhook(env: Env, service: ServiceApi, rt: WaRuntime, log: Logger): Router {
  const r = Router();
  r.get('/', (req, res) => {
    const token = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
    const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';
    const ok = !!env.WHATSAPP_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && timingSafeEqual(digest(token), digest(env.WHATSAPP_VERIFY_TOKEN));
    if (!ok || !/^[\w\-.~]{1,200}$/.test(challenge)) { res.status(403).type('text/plain').send('Forbidden'); return; }
    res.status(200).type('text/plain').send(challenge);
  });

  r.post('/', rateLimit({ name: 'wa-webhook', windowSeconds: 60, max: 3000 }), express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!env.WHATSAPP_APP_SECRET || !service.configured) { res.status(503).json({ error: 'not configured' }); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) {
      log.warn('whatsapp webhook rejected: bad signature', { bytes: raw.length, ip: req.ip });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'invalid json' }); return; }
    const { batches, skipped } = extractBatches(body);
    let received = 0; let duplicates = 0; let unknown = 0;
    try {
      for (const b of batches) {
        const out = await service.rpc<{ unknown_channel: boolean; received: number; duplicates: number }>('wa_svc_ingest', { p_phone_number_id: b.phoneNumberId, p_events: b.events });
        if (out.unknown_channel) unknown += b.events.length; else { received += out.received; duplicates += out.duplicates; }
      }
    } catch (e) {
      log.error('whatsapp webhook could not save events', { error: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'could not store events' });                     // Meta will redeliver
      return;
    }
    if (received && env.WHATSAPP_INLINE_BUDGET_MS > 0) {
      // Bounded best effort so replies are fast; whatever is left is picked up by the scheduler.
      const budget = env.WHATSAPP_INLINE_BUDGET_MS;
      await Promise.race([
        (async () => { await processEvents(rt, { deadlineMs: budget }); await sendOutbound(rt, { deadlineMs: budget, maxBatches: 2 }); })().catch((e) => log.warn('inline whatsapp processing failed', { error: String(e) })),
        new Promise((resolve) => setTimeout(resolve, budget)),
      ]);
    }
    res.status(200).json({ ok: true, received, duplicates, skipped, unknown_channel: unknown });
  });
  return r;
}
