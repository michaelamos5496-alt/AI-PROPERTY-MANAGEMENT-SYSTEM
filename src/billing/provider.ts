import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../lib/env.js';

/** What the database understands about a provider event, whatever the provider calls it. */
export interface NormalizedEvent {
  kind: 'paid' | 'subscribed' | 'failed' | 'cancel_scheduled' | 'ended' | 'snapshot';
  reference?: string | null; customer_ref?: string | null; subscription_ref?: string | null; plan_ref?: string | null;
  amount_minor?: number | null; currency?: string | null; occurred_at?: string | null; period_end?: string | null; status?: string | null;
}
export interface ParsedWebhook { eventId: string; type: string; normalized: NormalizedEvent }

export class BillingError extends Error {
  constructor(message: string, public readonly kind: 'pending' | 'unsupported' | 'provider' | 'timeout') { super(message); this.name = 'BillingError'; }
}

export interface BillingProvider {
  readonly name: 'paystack';
  /** Currencies this deployment is configured to charge through the provider. Configuration, not an assumption. */
  readonly currencies: string[];
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** null = a valid event we deliberately do not act on. */
  parseWebhook(body: any): ParsedWebhook | null;
  initializeCheckout(i: { email: string; amountMinor: number; currency: string; planRef: string | null; reference: string; callbackUrl: string; metadata: Record<string, string> }): Promise<{ url: string }>;
  fetchSubscription(ref: string): Promise<NormalizedEvent>;
  cancelSubscription(ref: string): Promise<void>;
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v && v.length <= max ? v : null);
const iso = (v: unknown): string | null => { const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

/**
 * Paystack. Signature: HMAC-SHA512 of the raw body with the secret key, hex, header `x-paystack-signature` (Paystack docs, Webhooks).
 * Event names handled: charge.success, subscription.create, invoice.payment_failed, subscription.not_renew, subscription.disable.
 * Request shapes for initialize/fetch/disable follow Paystack's public API reference and are NOT yet verified against a live account.
 * Paystack's events carry no event id, so one is derived from the object they describe: replays of the same event map to the same id.
 */
export class PaystackProvider implements BillingProvider {
  readonly name = 'paystack' as const;
  constructor(private env: Env, private f: typeof fetch = fetch) {}
  get currencies() { return this.env.BILLING_PAYSTACK_CURRENCIES; }
  private base = 'https://api.paystack.co';

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const given = headers['x-paystack-signature']; const sig = Array.isArray(given) ? given[0] : given;
    if (!sig || !this.env.PAYSTACK_SECRET_KEY || !/^[0-9a-fA-F]{128}$/.test(sig)) return false;
    return timingSafeEqual(createHmac('sha512', this.env.PAYSTACK_SECRET_KEY).update(raw).digest(), Buffer.from(sig, 'hex'));
  }

  parseWebhook(body: any): ParsedWebhook | null {
    const ev = str(body?.event, 60); const d = body?.data;
    if (!ev || !d || typeof d !== 'object') return null;
    const customer = str(d.customer?.customer_code); const sub = str(d.subscription_code) ?? str(d.subscription?.subscription_code) ?? str(d.subscription?.code);
    if (ev === 'charge.success') {
      if (d.status !== 'success') return null;
      const id = str(String(d.id ?? d.reference ?? '')); if (!id) return null;
      return { eventId: `charge.success:${id}`, type: ev, normalized: { kind: 'paid', reference: str(d.reference, 100), customer_ref: customer, plan_ref: str(d.plan?.plan_code ?? d.plan_object?.plan_code), amount_minor: Number.isInteger(d.amount) ? d.amount : null,
        currency: str(d.currency, 3), occurred_at: iso(d.paid_at ?? d.paidAt ?? d.created_at) } };
    }
    if (ev === 'subscription.create') {
      const code = str(d.subscription_code); if (!code) return null;
      return { eventId: `subscription.create:${code}`, type: ev, normalized: { kind: 'subscribed', customer_ref: customer, subscription_ref: code, plan_ref: str(d.plan?.plan_code), period_end: iso(d.next_payment_date), occurred_at: iso(d.createdAt ?? d.created_at) } };
    }
    if (ev === 'invoice.payment_failed') {
      const key = str(d.invoice_code) ?? (sub ? `${sub}:${iso(d.created_at ?? d.createdAt) ?? ''}` : null); if (!key) return null;
      return { eventId: `invoice.payment_failed:${key}`, type: ev, normalized: { kind: 'failed', customer_ref: customer, subscription_ref: sub, occurred_at: iso(d.created_at ?? d.createdAt ?? d.paid_at) } };
    }
    if (ev === 'subscription.not_renew' || ev === 'subscription.disable') {
      const code = sub; if (!code) return null;
      return { eventId: `${ev}:${code}:${iso(d.next_payment_date) ?? iso(d.cancelledAt) ?? ''}`, type: ev, normalized: { kind: ev === 'subscription.disable' ? 'ended' : 'cancel_scheduled', customer_ref: customer, subscription_ref: code, occurred_at: iso(d.cancelledAt ?? d.createdAt) } };
    }
    return null;
  }

  private async call(path: string, init: RequestInit = {}) {
    let res: Response;
    try { res = await this.f(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${this.env.PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) }); }
    catch (e) { throw new BillingError((e as Error).name === 'TimeoutError' ? 'The billing provider took too long to answer.' : 'Could not reach the billing provider.', 'timeout'); }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.status === false) throw new BillingError(String(json?.message ?? `The billing provider refused the request (HTTP ${res.status}).`).slice(0, 200), 'provider');
    return json?.data;
  }

  async initializeCheckout(i: Parameters<BillingProvider['initializeCheckout']>[0]) {
    const d = await this.call('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email: i.email, amount: i.amountMinor, currency: i.currency, reference: i.reference, callback_url: i.callbackUrl, metadata: i.metadata, ...(i.planRef ? { plan: i.planRef } : {}) }) });
    const url = str(d?.authorization_url, 1000); if (!url || !/^https:\/\//.test(url)) throw new BillingError('The billing provider did not return a checkout link.', 'provider');
    return { url };
  }

  async fetchSubscription(ref: string): Promise<NormalizedEvent> {
    const d = await this.call(`/subscription/${encodeURIComponent(ref)}`);
    const status = d?.status === 'non-renewing' ? 'non_renewing' : d?.status === 'completed' ? 'cancelled' : str(d?.status, 30);
    return { kind: 'snapshot', subscription_ref: ref, customer_ref: str(d?.customer?.customer_code), status, period_end: iso(d?.next_payment_date), occurred_at: new Date().toISOString() };
  }

  async cancelSubscription(ref: string): Promise<void> {
    const d = await this.call(`/subscription/${encodeURIComponent(ref)}`);
    const token = str(d?.email_token, 100); if (!token) throw new BillingError('The provider did not return a cancellation token.', 'provider');
    await this.call('/subscription/disable', { method: 'POST', body: JSON.stringify({ code: ref, token }) });
  }
}

export function createBillingProvider(env: Env, f?: typeof fetch): BillingProvider | null {
  return env.BILLING_PROVIDER === 'paystack' ? new PaystackProvider(env, f) : null;
}
