import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { BillingError, type BillingProvider } from '../billing/provider.js';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import type { DataApi, ServiceApi } from '../services/supabase.js';
import { mountDefs, type Def } from './defs.js';

const nul = <T extends z.ZodTypeAny>(s: T) => s.nullish().transform((v) => v ?? null);
const marketBody = z.object({
  country: nul(z.string().regex(/^[A-Z]{2}$/)), currency: nul(z.string().regex(/^[A-Z]{3}$/)), timezone: nul(z.string().max(64)), locale: nul(z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)),
  dateFormat: nul(z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'])), paymentProviders: z.array(z.string().max(40)).max(10).default([]),
  comms: z.object({ preferred_channels: z.array(z.enum(['whatsapp', 'sms', 'email'])).max(3).optional(), quiet_hours: nul(z.object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) })).optional(), languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(5).optional() }).strict().default({}),
  rulePacks: z.array(z.string().max(60)).max(20).default([]),
}).strict();
const checkoutBody = z.object({ planCode: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), interval: z.enum(['monthly', 'annual']).default('monthly'), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const noBody = z.object({});

const defs: Def[] = [
  { method: 'get', path: '/entitlements', min: 'staff', fn: 'get_entitlements' },
  { method: 'get', path: '/market', min: 'viewer', fn: 'get_market' },
  { method: 'put', path: '/market', min: 'admin', fn: 'save_market', body: marketBody },
];

/** Plans, usage, checkout, market settings and exports. Authorization is checked here (fast fail) and again in the database. */
export function billingRoutes(env: Env, data: DataApi, service: ServiceApi, provider: BillingProvider | null): Router {
  const r = Router({ mergeParams: true });
  mountDefs(r, defs, data);

  r.get('/billing', requireOrgRole(data, 'admin'), async (req, res) => {
    const b = await data.rpc<any>(req.auth!.token, 'get_billing', { p_org: req.org!.id });
    res.json({ ...b, provider: { configured: !!provider, name: provider?.name ?? null, currencies: provider?.currencies ?? [],
      status: provider ? 'enabled (not yet verified against a live account)' : 'pending: no billing provider is configured, plans are assigned by an operator' } });
  });

  // Starts a checkout. It changes NOTHING about the subscription: only a verified provider event (or our own fetch) can do that.
  r.post('/billing/checkout', requireOrgRole(data, 'admin'), validate({ body: checkoutBody }), async (req, res) => {
    if (!provider) throw new AppError(503, 'upstream_error', 'Online payment is not enabled yet. Contact us to change your plan.');
    if (!provider.currencies.includes(req.body.currency)) throw new AppError(422, 'validation_failed', `Payments in ${req.body.currency} are not enabled on this deployment. Enabled: ${provider.currencies.join(', ') || 'none'}.`);
    const reference = `pai_${randomBytes(12).toString('hex')}`;
    const q = await data.rpc<any>(req.auth!.token, 'begin_checkout', { p_org: req.org!.id, p_plan: req.body.planCode, p_interval: req.body.interval, p_currency: req.body.currency, p_provider: provider.name, p_reference: reference });
    try {
      const { url } = await provider.initializeCheckout({ email: req.auth!.user.email, amountMinor: q.amount_minor, currency: q.currency, planRef: q.provider_plan_ref, reference, callbackUrl: `${env.APP_URL}/app?org=${req.org!.id}#/billing`,
        metadata: { org_id: req.org!.id, plan_code: q.plan } });
      res.status(201).json({ url, reference, amount_minor: q.amount_minor, currency: q.currency, note: 'Your plan changes only after the payment is confirmed by the provider.' });
    } catch (e) {
      if (e instanceof BillingError) throw new AppError(502, 'upstream_error', e.kind === 'timeout' ? 'The payment provider is slow right now. Nothing was charged. Try again shortly.' : 'The payment provider could not start the checkout. Nothing was charged.');
      throw e;
    }
  });

  // Ask the provider what it knows. Recovers from a missed webhook; does not trust the browser.
  r.post('/billing/reconcile', requireOrgRole(data, 'admin'), validate({ body: noBody }), async (req, res) => {
    if (!provider) throw new AppError(503, 'upstream_error', 'No billing provider is configured, so there is nothing to reconcile.');
    const sub = await service.rpc<any>('billing_svc_subscription', { p_org: req.org!.id });
    if (!sub?.provider_subscription_ref) throw AppError.conflict('There is no provider subscription for this organization yet.');
    try {
      const snap = await provider.fetchSubscription(sub.provider_subscription_ref);
      const rec = await service.rpc<{ id: number }>('billing_svc_record_event', { p_provider: provider.name, p_event_id: `snapshot:${sub.provider_subscription_ref}:${Date.now()}`, p_type: 'snapshot', p_payload: {}, p_normalized: snap });
      const out = await service.rpc<any>('billing_svc_apply', { p_id: rec.id });
      res.json({ status: out.status, billing: await data.rpc(req.auth!.token, 'get_billing', { p_org: req.org!.id }) });
    } catch (e) {
      if (e instanceof BillingError) throw new AppError(502, 'upstream_error', 'Could not reach the payment provider. Try again shortly.');
      throw e;
    }
  });

  r.post('/billing/cancel', requireOrgRole(data, 'owner'), validate({ body: noBody }), async (req, res) => {
    const sub = await service.rpc<any>('billing_svc_subscription', { p_org: req.org!.id });
    if (!provider || !sub?.provider_subscription_ref) throw AppError.conflict('This subscription is managed by our team. Contact us to change or cancel it.');
    try { await provider.cancelSubscription(sub.provider_subscription_ref); } catch (e) { if (e instanceof BillingError) throw new AppError(502, 'upstream_error', 'The payment provider could not cancel it right now. Try again shortly.'); throw e; }
    res.json({ ok: true, note: 'Cancellation requested. Your plan stays until the end of the paid period.' });
  });

  // ------------------------------------------------------------------ CSV exports (a plan feature, enforced here and in the database function it calls)
  r.get('/exports/:kind', requireOrgRole(data, 'staff'), validate({ params: z.object({ kind: z.enum(['charges.csv', 'payments.csv']) }).passthrough() }), async (req, res) => {
    await data.rpc(req.auth!.token, 'require_entitlement', { p_org: req.org!.id, p_key: 'exports' });
    const fn = req.params.kind === 'charges.csv' ? 'list_charges' : 'list_payments';
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 10_000; offset += 200) {
      const page = await data.rpc<{ items: Record<string, unknown>[]; total: number }>(req.auth!.token, fn, { p_org: req.org!.id, p_limit: 200, p_offset: offset });
      rows.push(...page.items);
      if (offset + 200 >= page.total) break;
    }
    const cols = rows.length ? Object.keys(rows[0]!).filter((k) => typeof rows[0]![k] !== 'object' || rows[0]![k] === null) : [];
    const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };   // spreadsheet formula injection guard
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind}"`);
    res.send([cols.join(','), ...rows.map((row) => cols.map((c) => cell(row[c])).join(','))].join('\r\n') + '\r\n');
  });
  void uuid;
  return r;
}
