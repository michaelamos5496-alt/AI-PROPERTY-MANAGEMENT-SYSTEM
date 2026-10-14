import type { Logger } from '../lib/logger.js';
import type { ServiceApi } from '../services/supabase.js';
import type { BillingProvider } from './provider.js';

export interface BillingRun { applied: number; tick: unknown; reconciled: number; errors: string[] }

/** Time-based transitions, retries of events that could not yet be matched, and (when a provider is configured) reconciliation against its own records. */
export async function runBilling(service: ServiceApi, provider: BillingProvider | null, log: Logger): Promise<BillingRun> {
  const out: BillingRun = { applied: 0, tick: null, reconciled: 0, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); } };
  await step('pending events', async () => { out.applied = (await service.rpc<{ tried: number }>('billing_svc_apply_pending', {})).tried; });
  if (provider) {
    await step('reconcile', async () => {
      const list = await service.rpc<{ org_id: string; subscription_ref: string }[]>('billing_svc_reconcile_list', { p_limit: 25 });
      for (const s of list) {
        try {
          const snap = await provider.fetchSubscription(s.subscription_ref);
          const rec = await service.rpc<{ id: number; duplicate: boolean }>('billing_svc_record_event', { p_provider: provider.name, p_event_id: `snapshot:${s.subscription_ref}:${Date.now()}`, p_type: 'snapshot', p_payload: {}, p_normalized: snap });
          await service.rpc('billing_svc_apply', { p_id: rec.id }); out.reconciled++;
        } catch (e) { log.warn('billing reconciliation failed for one subscription', { org: s.org_id, error: e instanceof Error ? e.message : String(e) }); }
      }
    });
  }
  await step('tick', async () => { out.tick = await service.rpc('billing_svc_tick', {}); });
  return out;
}
