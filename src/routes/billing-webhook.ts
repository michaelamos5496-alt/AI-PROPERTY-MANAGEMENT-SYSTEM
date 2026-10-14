import express, { Router } from 'express';
import type { BillingProvider } from '../billing/provider.js';
import type { Logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { ServiceApi } from '../services/supabase.js';

/**
 * Billing provider webhooks. Order: verify the signature over the raw bytes -> record the event once (unique on a stable id) -> apply it.
 * The browser redirect after checkout is never consulted: a payment counts only when the provider says so here (or when we fetch it ourselves).
 * Saving failures answer 500 so the provider retries; everything after saving answers 200 (a later retry of the same event is a no-op).
 */
export function billingWebhook(provider: BillingProvider | null, service: ServiceApi, log: Logger): Router {
  const r = Router();
  r.post('/:provider', rateLimit({ name: 'billing-webhook', windowSeconds: 60, max: 600 }), express.raw({ type: () => true, limit: '512kb' }), async (req, res) => {
    if (!provider || req.params.provider !== provider.name || !service.configured) { res.status(503).json({ error: 'billing integration is not configured' }); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!provider.verifyWebhook(raw, req.headers)) { log.warn('billing webhook rejected: bad signature', { provider: provider.name, bytes: raw.length, ip: req.ip }); res.status(401).json({ error: 'invalid signature' }); return; }
    let body: unknown; try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'invalid json' }); return; }
    const parsed = provider.parseWebhook(body);
    if (!parsed) { res.status(200).json({ ok: true, ignored: true }); return; }
    try {
      const rec = await service.rpc<{ id: number; duplicate: boolean }>('billing_svc_record_event', { p_provider: provider.name, p_event_id: parsed.eventId, p_type: parsed.type, p_payload: redact(body), p_normalized: parsed.normalized });
      if (rec.duplicate) { res.status(200).json({ ok: true, duplicate: true }); return; }
      let status = 'recorded';
      try { status = (await service.rpc<{ status: string }>('billing_svc_apply', { p_id: rec.id })).status; } catch (e) { log.error('billing event saved but not yet applied', { id: rec.id, error: String(e) }); }
      res.status(200).json({ ok: true, status });
    } catch (e) {
      log.error('billing webhook could not save the event', { error: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'could not store event' });
    }
  });
  return r;
}

/** Keep what we need to explain an event later, not card or personal details. */
function redact(body: any): unknown {
  const d = body?.data ?? {};
  return { event: body?.event, data: { id: d.id, reference: d.reference, status: d.status, amount: d.amount, currency: d.currency, paid_at: d.paid_at, subscription_code: d.subscription_code, invoice_code: d.invoice_code,
    next_payment_date: d.next_payment_date, plan: d.plan ? { plan_code: d.plan.plan_code } : undefined, customer: d.customer ? { customer_code: d.customer.customer_code } : undefined } };
}
