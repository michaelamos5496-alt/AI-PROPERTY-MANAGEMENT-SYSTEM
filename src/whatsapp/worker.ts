import { randomUUID } from 'node:crypto';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ServiceApi } from '../services/supabase.js';
import { handleInbound } from './engine.js';
import { WaSendError, type WhatsAppProvider } from './provider.js';

export interface WaRuntime { env: Env; service: ServiceApi; provider: WhatsAppProvider; log: Logger }
export interface WaRun { events: { claimed: number; done: number; retried: number; dead: number }; outbound: { claimed: number; sent: number; retrying: number; dead: number }; updates: number; errors: string[] }

interface ClaimedEvent { id: number; org_id: string; phone_number_id: string; kind: 'message' | 'status'; provider_id: string; payload: any; attempts: number }
const safeErr = (e: unknown) => (e instanceof AppError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : 'unknown error').slice(0, 300);

/** Drains the durable inbox. Each event is handled by exactly one worker at a time; a failure leaves it queued for a later retry. */
export async function processEvents(rt: WaRuntime, opts: { limit?: number; deadlineMs?: number } = {}): Promise<WaRun['events']> {
  const out = { claimed: 0, done: 0, retried: 0, dead: 0 };
  const worker = `wa-${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const channels = new Map<string, any>();
  while (Date.now() < deadline) {
    const batch = await rt.service.rpc<ClaimedEvent[]>('wa_svc_claim_events', { p_worker: worker, p_limit: opts.limit ?? 20, p_lease_seconds: 120 });
    if (!batch.length) break;
    out.claimed += batch.length;
    // events for different contacts are independent; a contact's own events are never offered together
    await Promise.all(batch.map(async (e) => {
      const finish = (outcome: 'done' | 'ignored' | 'retry', error: string | null, delay = 30) =>
        rt.service.rpc<{ status: string }>('wa_svc_finish_event', { p_id: e.id, p_worker: worker, p_outcome: outcome, p_error: error, p_delay_seconds: delay }).catch((x) => { rt.log.error('could not record event outcome', { eventId: e.id, error: safeErr(x) }); return { status: 'unknown' }; });
      try {
        if (e.kind === 'status') {
          const s = e.payload.status ?? {};
          const err = Array.isArray(s.errors) ? s.errors[0] : null;
          const r = await rt.service.rpc<{ found: boolean }>('wa_svc_apply_status', { p_provider_id: s.id, p_status: s.status, p_ts: s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null,
            p_code: err?.code != null ? String(err.code) : null, p_error: err ? String(err.error_data?.details ?? err.title ?? err.message ?? 'failed') : null });
          // the receipt can beat our own bookkeeping of the send; give it a few chances before concluding it is not ours
          if (!r.found && e.attempts < 4) { out.retried++; await finish('retry', 'message not recorded yet', 20); return; }
          out.done++; await finish(r.found ? 'done' : 'ignored', r.found ? null : 'unknown message id');
          return;
        }
        let ch = channels.get(e.phone_number_id);
        if (!ch) { ch = await rt.service.rpc<any>('wa_svc_channel', { p_phone_number_id: e.phone_number_id }); channels.set(e.phone_number_id, ch); }
        if (!ch || !ch.enabled) { out.done++; await finish('ignored', ch ? 'channel disabled' : 'unknown channel'); return; }
        const msg = e.payload.message ?? {};
        const body = msg.type === 'text' ? msg.text?.body : msg.type === 'button' ? msg.button?.text : msg.type === 'interactive' ? (msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title) : null;
        await handleInbound({ env: rt.env, service: rt.service, log: rt.log }, { org_id: ch.org_id, org_name: ch.org_name, welcome_text: ch.welcome_text },
          { id: e.provider_id, from: String(msg.from), name: e.payload.contacts?.[0]?.profile?.name ?? null, ts: new Date(Number(msg.timestamp) * 1000 || Date.now()), type: String(msg.type ?? 'unknown'), text: typeof body === 'string' ? body : null });
        out.done++; await finish('done', null);
      } catch (err) {
        rt.log.warn('whatsapp event failed', { eventId: e.id, attempts: e.attempts, error: safeErr(err) });
        const r = await finish('retry', safeErr(err));
        if (r.status === 'dead') out.dead++; else out.retried++;
      }
    }));
  }
  return out;
}

/** Sends queued messages. The database re-checks opt-out, consent and the 24-hour window at the moment of sending. */
export async function sendOutbound(rt: WaRuntime, opts: { limit?: number; deadlineMs?: number; maxBatches?: number } = {}): Promise<WaRun['outbound']> {
  const out = { claimed: 0, sent: 0, retrying: 0, dead: 0 };
  const worker = `wo-${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  for (let b = 0; b < (opts.maxBatches ?? 5) && Date.now() < deadline; b++) {
    const batch = await rt.service.rpc<{ id: string; to: string; phone_number_id: string; kind: 'text' | 'template'; body: string | null; template: any; attempts: number }[]>('wa_svc_claim_outbound', { p_worker: worker, p_limit: opts.limit ?? 20, p_lease_seconds: 120 });
    if (!batch.length) break;
    out.claimed += batch.length;
    await Promise.all(batch.map(async (m) => {
      try {
        const r = await rt.provider.send({ to: m.to, phoneNumberId: m.phone_number_id, kind: m.kind, body: m.body, template: m.template ? { name: m.template.name, lang: m.template.lang, params: m.template.params ?? [] } : null });
        await rt.service.rpc('wa_svc_complete_outbound', { p_id: m.id, p_worker: worker, p_provider_id: r.id });
        out.sent++;
      } catch (err) {
        const permanent = err instanceof WaSendError ? err.permanent : false;
        const code = err instanceof WaSendError ? err.code : 'error';
        rt.log.warn('whatsapp send failed', { messageId: m.id, code, permanent });
        try {
          const r = await rt.service.rpc<{ status: string }>('wa_svc_fail_outbound', { p_id: m.id, p_worker: worker, p_code: code, p_error: safeErr(err), p_permanent: permanent });
          if (r.status === 'dead') out.dead++; else out.retrying++;
        } catch (inner) { rt.log.error('could not record send failure', { messageId: m.id, error: safeErr(inner) }); }
      }
    }));
  }
  return out;
}

/** Everything the scheduler does for WhatsApp, in a safe order. Idempotent. */
export async function runWhatsApp(rt: WaRuntime, opts: { deadlineMs?: number } = {}): Promise<WaRun> {
  const run: WaRun = { events: { claimed: 0, done: 0, retried: 0, dead: 0 }, outbound: { claimed: 0, sent: 0, retrying: 0, dead: 0 }, updates: 0, errors: [] };
  const deadlineMs = opts.deadlineMs ?? 25_000;
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { run.errors.push(`${name}: ${safeErr(e)}`); } };
  await step('events', async () => { run.events = await processEvents(rt, { deadlineMs }); });
  await step('updates', async () => { run.updates = (await rt.service.rpc<{ queued: number }>('wa_svc_request_updates', {})).queued; });
  await step('outbound', async () => { run.outbound = await sendOutbound(rt, { deadlineMs }); });
  await step('purge', async () => { await rt.service.rpc('wa_svc_purge', {}); });
  return run;
}
