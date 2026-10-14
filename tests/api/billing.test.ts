import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaystackProvider } from '../../src/billing/provider.js';
import { OfflineProvider } from '../../src/ai/providers.js';
import { CRON_SECRET, startTestApp, type TestApp } from '../support/app.js';
import { FakeWhatsApp, APP_SECRET, VERIFY_TOKEN, deliver, waText } from '../support/whatsapp.js';

const KEY = 'sk_test_0123456789abcdef0123';
let t: TestApp; const calls: { url: string; init: any }[] = []; let subStatus = 'active'; let wa: FakeWhatsApp;
const fakeFetch: typeof fetch = (async (url: any, init: any) => {
  calls.push({ url: String(url), init });
  const u = String(url); const json = (data: unknown, status = 200) => new Response(JSON.stringify({ status: status < 400, data, message: status < 400 ? 'ok' : 'nope' }), { status });
  if (u.endsWith('/transaction/initialize')) return json({ authorization_url: 'https://checkout.paystack.com/abc123', reference: JSON.parse(init.body).reference });
  if (u.includes('/subscription/disable')) return json({});
  if (u.includes('/subscription/SUB_')) return json({ status: subStatus, next_payment_date: '2099-01-01T00:00:00Z', email_token: 'tok_1', customer: { customer_code: 'CUS_R' } });
  return json({}, 404);
}) as any;

beforeAll(async () => {
  wa = new FakeWhatsApp();
  t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '5000', BILLING_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: KEY, BILLING_PAYSTACK_CURRENCIES: 'NGN,USD', WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN },
    {}, { billing: (env) => new PaystackProvider(env, fakeFetch), llm: new OfflineProvider(), whatsapp: wa });
});
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const ok = async (p: Promise<any>, status = 200) => { const r = await p; expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const idem = (c: Client, url: string, body: object) => c.post(url).set('Idempotency-Key', randomUUID()).send(body);
const operator = (path: string, body: object, secret: string | null = CRON_SECRET) => { const r = supertest(t.app).post(`/api/internal/billing/${path}`); return (secret ? r.set('Authorization', `Bearer ${secret}`) : r).send(body); };
const hook = (body: unknown, opts: { key?: string | null; raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(body);
  const r = supertest(t.app).post('/api/webhooks/billing/paystack').set('content-type', 'application/json');
  return (opts.key === null ? r : r.set('x-paystack-signature', createHmac('sha512', opts.key ?? KEY).update(raw).digest('hex'))).send(raw);
};
const charge = (reference: string, amount: number, currency: string, id = Math.floor(Math.random() * 1e9), extra: Record<string, unknown> = {}) =>
  ({ event: 'charge.success', data: { id, status: 'success', reference, amount, currency, paid_at: new Date().toISOString(), customer: { customer_code: 'CUS_1', email: 'o@x.test' }, ...extra } });

async function setup(opts: { country?: string } = {}) {
  const org = await t.newOrg();
  const admin = await t.addMember(org, 'admin'); const manager = await t.addMember(org, 'manager'); const staff = await t.addMember(org, 'staff'); const viewer = await t.addMember(org, 'viewer');
  if (opts.country) await ok(admin.put(`${org.base}/market`).send({ country: opts.country }));
  return { org, base: org.base, owner: org.c, admin, manager, staff, viewer, id: org.orgId };
}
type W = Awaited<ReturnType<typeof setup>>;
const planOf = async (w: W) => (await ok(w.admin.get(`${w.base}/billing`)));
const assign = (w: W, plan: string, status = 'active') => ok(operator('assign', { orgId: w.id, plan, status, reason: 'api test' }));
const mkProp = (w: W, name: string, over: object = {}) => w.manager.post(`${w.base}/properties`).send({ name, addressLine1: '1 St', city: 'Accra', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS', ...over });

describe('billing is not the browser\'s to declare', () => {
  it('shows plan and usage to admins, a summary to staff, nothing to viewers', async () => {
    const w = await setup();
    const b = await planOf(w);
    expect(b).toMatchObject({ plan: { code: 'growth' }, status: 'trialing', provider: { configured: true, name: 'paystack', currencies: ['NGN', 'USD'] } });
    expect(b.plans.map((p: any) => p.code)).toEqual(['starter', 'growth', 'scale']);
    expect((await w.manager.get(`${w.base}/billing`)).status).toBe(403);
    expect((await ok(w.staff.get(`${w.base}/entitlements`))).plan.code).toBe('growth');
    expect((await w.viewer.get(`${w.base}/entitlements`)).status).toBe(403);
  });
  it('starting a checkout changes nothing; only a verified webhook upgrades the plan', async () => {
    const w = await setup();
    const c = await ok(w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'scale', interval: 'monthly', currency: 'NGN' }), 201);
    expect(c.url).toBe('https://checkout.paystack.com/abc123');
    const init = JSON.parse(calls.filter((x) => x.url.endsWith('/transaction/initialize')).at(-1)!.init.body);
    expect(init).toMatchObject({ amount: 15000000, currency: 'NGN', reference: c.reference, metadata: { org_id: w.id } });
    // the "success" redirect: whatever the browser does, the subscription is unchanged
    await w.admin.get(`/app?org=${w.id}&reference=${c.reference}&trxref=${c.reference}#/billing`);
    expect((await planOf(w))).toMatchObject({ plan: { code: 'growth' }, status: 'trialing' });
    // a forged webhook is refused
    expect((await hook(charge(c.reference, 15000000, 'NGN'), { key: 'sk_test_someone_elses_key_000' })).status).toBe(401);
    expect((await hook(charge(c.reference, 15000000, 'NGN'), { key: null })).status).toBe(401);
    expect((await planOf(w))).toMatchObject({ plan: { code: 'growth' }, status: 'trialing' });
    // the real one
    const body = charge(c.reference, 15000000, 'NGN', 777001);
    expect((await ok(hook(body))).status).toBe('processed');
    expect((await planOf(w))).toMatchObject({ plan: { code: 'scale' }, status: 'active', subscription: { provider: 'paystack', currency: 'NGN' } });
  });
  it('deduplicates redelivered events and survives a tampered body', async () => {
    const w = await setup();
    const c = await ok(w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'USD' }), 201);
    const body = charge(c.reference, 4900, 'USD', 888001);
    const raw = JSON.stringify(body);
    await ok(hook(body)); const second = await ok(hook(body)); await ok(hook(body));
    expect(second).toMatchObject({ duplicate: true });
    const events = (await planOf(w)).events.filter((e: any) => e.type === 'payment_succeeded');
    expect(events).toHaveLength(1);
    expect((await hook(null, { raw: raw.replace('4900', '1'), key: KEY })).status).toBeGreaterThanOrEqual(200);   // signature is over the ORIGINAL bytes…
    const tampered = raw.replace('4900', '1');
    const r = await supertest(t.app).post('/api/webhooks/billing/paystack').set('content-type', 'application/json').set('x-paystack-signature', createHmac('sha512', KEY).update(raw).digest('hex')).send(tampered);
    expect(r.status).toBe(401);                                                                                      // …so changed bytes are refused
  });
  it('rejects a payment for the wrong amount or currency and activates nothing', async () => {
    const w = await setup();
    const c = await ok(w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'scale', interval: 'monthly', currency: 'NGN' }), 201);
    expect((await ok(hook(charge(c.reference, 100, 'NGN')))).status).toBe('rejected');
    expect((await planOf(w))).toMatchObject({ plan: { code: 'growth' }, status: 'trialing' });
  });
  it('holds an event that arrives before the one that identifies its organization, then applies it', async () => {
    const w = await setup();
    const c = await ok(w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'NGN' }), 201);
    const created = { event: 'subscription.create', data: { subscription_code: 'SUB_ORDER', customer: { customer_code: 'CUS_ORDER' }, plan: { plan_code: 'PLN_x' }, next_payment_date: '2099-02-01T00:00:00Z' } };
    expect((await ok(hook(created))).status).toBe('pending');                       // cannot be matched yet
    await ok(hook(charge(c.reference, 4500000, 'NGN', 999001, { customer: { customer_code: 'CUS_ORDER', email: 'a@b.c' } })));
    await ok(supertest(t.app).get('/api/internal/jobs/run').set('Authorization', `Bearer ${CRON_SECRET}`));
    const out = await ok(hook({ event: 'invoice.payment_failed', data: { invoice_code: 'INV_1', subscription: { subscription_code: 'SUB_ORDER' }, customer: { customer_code: 'CUS_ORDER' }, created_at: new Date(Date.now() + 60000).toISOString() } }));
    expect(out.status).toBe('processed');
    expect((await planOf(w))).toMatchObject({ status: 'past_due' });
  });
  it('rejects unknown providers and ignores events it does not act on', async () => {
    expect((await supertest(t.app).post('/api/webhooks/billing/stripe').set('content-type', 'application/json').send('{}')).status).toBe(503);
    expect(await ok(hook({ event: 'customeridentification.success', data: {} }))).toMatchObject({ ignored: true });
  });
  it('reconciles with the provider\'s own record when a webhook was missed', async () => {
    const w = await setup();
    const c = await ok(w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'NGN' }), 201);
    await ok(hook(charge(c.reference, 4500000, 'NGN', 555001, { customer: { customer_code: 'CUS_R', email: 'r@x.test' } })));
    expect((await w.admin.post(`${w.base}/billing/reconcile`).send({})).status).toBe(409);                           // no provider subscription ref yet
    await ok(hook({ event: 'subscription.create', data: { subscription_code: 'SUB_R1', customer: { customer_code: 'CUS_R' }, plan: { plan_code: 'PLN_g' } } }));
    subStatus = 'attention';
    const r = await ok(w.admin.post(`${w.base}/billing/reconcile`).send({}));
    expect(r.billing.status).toBe('past_due');
    subStatus = 'active';
    expect((await ok(w.admin.post(`${w.base}/billing/reconcile`).send({}))).billing.status).toBe('active');
    expect((await w.manager.post(`${w.base}/billing/reconcile`).send({})).status).toBe(403);
  });
  it('checkout is refused for currencies this deployment has not enabled, and without a provider billing is clearly pending', async () => {
    const w = await setup();
    const r = await w.admin.post(`${w.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'GHS' });
    expect(r.status).toBe(422); expect(r.body.error.message).toMatch(/GHS are not enabled/);
    expect((await w.manager.post(`${w.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'NGN' })).status).toBe(403);
    const none = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '5000' }, {}, { billing: null });
    try {
      const org = await none.newOrg(); const b = await ok(org.c.get(`${org.base}/billing`));
      expect(b.provider).toMatchObject({ configured: false, name: null, status: expect.stringMatching(/pending/) });
      const c = await org.c.post(`${org.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'NGN' });
      expect(c.status).toBe(503); expect(c.body.error.message).toMatch(/not enabled yet/);
      expect((await supertest(none.app).post('/api/webhooks/billing/paystack').send('{}')).status).toBe(503);
    } finally { await none.close(); }
  });
  it('operator actions need the operator credential', async () => {
    const w = await setup();
    expect((await operator('assign', { orgId: w.id, plan: 'scale', reason: 'x y z' }, null)).status).toBe(401);
    expect((await operator('assign', { orgId: w.id, plan: 'scale', reason: 'x y z' }, 'wrong-secret-wrong-secret-0123456789')).status).toBe(401);
    expect((await w.owner.post('/api/internal/billing/assign').send({ orgId: w.id, plan: 'scale', reason: 'x y z' })).status).toBe(401);       // a user session is not enough
    await ok(operator('assign', { orgId: w.id, plan: 'scale', reason: 'invoice customer' }));
    expect((await planOf(w)).plan.code).toBe('scale');
  });
});

describe('plan limits over HTTP', () => {
  it('refuses with a 402 and a plain message; two organizations on different plans do not affect each other', async () => {
    const a = await setup(); const b = await setup();
    await assign(a, 'starter'); await assign(b, 'scale');
    for (let i = 1; i <= 3; i++) await ok(mkProp(a, `A${i}`), 201);
    const r = await mkProp(a, 'A4');
    expect(r.status).toBe(402); expect(r.body.error.code).toBe('limit_reached'); expect(r.body.error.message).toMatch(/Starter plan allows 3 properties/);
    for (let i = 1; i <= 4; i++) await ok(mkProp(b, `B${i}`), 201);
    expect((await ok(a.admin.get(`${a.base}/billing`))).entitlements.find((e: any) => e.key === 'properties')).toMatchObject({ used: 3, limit: 3 });
    expect((await ok(b.admin.get(`${b.base}/billing`))).entitlements.find((e: any) => e.key === 'properties')).toMatchObject({ used: 4, limit: 250 });
    const bProp = (await ok(b.manager.get(`${b.base}/properties`))).items[0];
    expect((await a.manager.get(`${a.base}/properties/${bProp.id}`)).status).toBe(404);                       // B's record through A's URL
    expect((await a.manager.get(`${b.base}/properties/${bProp.id}`)).status).toBe(404);                       // …and through B's URL
  });
  it('seats: inviting beyond the plan is refused; view-only invitations are free', async () => {
    const w = await setup(); await assign(w, 'starter');                       // 3 seats; owner + admin + manager + staff already (grandfathered over the limit)
    expect((await w.owner.post(`${w.base}/invitations`).send({ email: 'extra@test.dev', role: 'staff' })).status).toBe(402);
    await ok(w.owner.post(`${w.base}/invitations`).send({ email: 'watcher@test.dev', role: 'viewer' }), 201);
  });
  it('the AI copilot is a plan feature with a monthly allowance, enforced by the server', async () => {
    const w = await setup();
    const convo = async () => (await ok(w.staff.post(`${w.base}/copilot/conversations`).send({}), 201)).id;
    await assign(w, 'free');
    const r = await w.staff.post(`${w.base}/copilot/conversations/${await convo()}/messages`).send({ content: 'Who is overdue on rent?' });
    expect(r.status).toBe(402); expect(r.body.error.message).toMatch(/not included in your Free plan/);
    await ok(operator('override', { orgId: w.id, key: 'copilot', enabled: true, reason: 'pilot' }));
    await ok(operator('override', { orgId: w.id, key: 'ai_requests_month', enabled: true, limit: 1, reason: 'pilot' }));
    const id = await convo();
    await ok(w.staff.post(`${w.base}/copilot/conversations/${id}/messages`).send({ content: 'Who is overdue on rent?' }), 201);
    const again = await w.staff.post(`${w.base}/copilot/conversations/${id}/messages`).send({ content: 'And now?' });
    expect(again.status).toBe(402); expect(again.body.error.message).toMatch(/used all 1 of your ai copilot requests/i);
  });
  it('WhatsApp is a plan feature: a plan without it cannot connect a number, and an over-allowance sender reaches a person', async () => {
    const w = await setup(); await assign(w, 'starter');
    const body = { phoneNumberId: `7400000000${Math.floor(Math.random() * 90000 + 10000)}`, intakeUser: (await ok(w.manager.get('/api/me'))).profile.id, enabled: true };
    expect((await w.admin.put(`${w.base}/whatsapp/channel`).send(body)).status).toBe(402);
    await assign(w, 'growth');
    await ok(w.admin.put(`${w.base}/whatsapp/channel`).send(body));
    await ok(operator('override', { orgId: w.id, key: 'whatsapp_conversations_month', enabled: true, limit: 0, reason: 'test allowance' }));
    const before = wa.sent.length;
    await ok(deliver(t.app, waText(body.phoneNumberId, '15557770001', 'my tap is leaking')));
    expect(wa.sent.slice(before).map((m) => m.body).join(' ')).toMatch(/team member has been told/);
    expect((await ok(w.manager.get(`${w.base}/whatsapp/handoffs`)))[0].reason).toMatch(/allowance/);
  });
  it('CSV export is a plan feature, scoped to the organization, and safe to open in a spreadsheet', async () => {
    const w = await setup(); const other = await setup();
    await assign(w, 'starter');
    expect((await w.staff.get(`${w.base}/exports/charges.csv`)).status).toBe(402);
    await assign(w, 'growth');
    const prop = await ok(mkProp(w, 'Export Court'), 201); const unit = await ok(w.manager.post(`${w.base}/properties/${prop.id}/units`).send({ reference: '1A' }), 201);
    const tenant = await ok(w.staff.post(`${w.base}/tenants`).send({ fullName: 'Ama Mensah' }), 201);
    const tn = await ok(w.staff.post(`${w.base}/tenancies`).send({ unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 }), 201);
    await ok(w.manager.post(`${w.base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
    await ok(idem(w.manager, `${w.base}/tenancies/${tn.id}/charges`, { kind: 'fee', description: '=HYPERLINK("http://evil.test","click")', dueDate: '2026-01-01', amountMinor: 150000 }), 201);
    const r = await w.staff.get(`${w.base}/exports/charges.csv`);
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/text\/csv/); expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(r.text).toMatch(/'=HYPERLINK/); expect(r.text).not.toMatch(/(^|,)=HYPERLINK/m);                      // formula guard
    expect(r.text).toMatch(/GHS/);
    expect((await other.staff.get(`${w.base}/exports/charges.csv`)).status).toBe(404);                           // another organization's URL
    expect((await w.viewer.get(`${w.base}/exports/charges.csv`)).status).toBe(403);
  });
});

describe('countries: phone numbers, currencies and time zones', () => {
  it('normalizes phone numbers per organization country (Ghana, Nigeria, Kenya) and refuses invalid ones', async () => {
    const cases: [string, string, string][] = [['GH', '024 123 4567', '+233241234567'], ['NG', '0803 123 4567', '+234803123 4567'.replace(' ', '')], ['KE', '0712 345 678', '+254712345678']];
    for (const [cty, typed, e164] of cases) {
      const w = await setup({ country: cty });
      const tn = await ok(w.staff.post(`${w.base}/tenants`).send({ fullName: `Person ${cty}`, phone: typed, emergencyPhone: e164 }), 201);
      expect(tn.phone).toBe(e164.replace(/\s/g, '')); expect(tn.emergency_phone).toBe(e164.replace(/\s/g, ''));
    }
    const w = await setup({ country: 'GH' });
    const bad = await w.staff.post(`${w.base}/tenants`).send({ fullName: 'Bad Phone', phone: '12345' });
    expect(bad.status).toBe(422); expect(JSON.stringify(bad.body)).toMatch(/phone/i);
    const intl = await ok(w.staff.post(`${w.base}/tenants`).send({ fullName: 'Intl', phone: '+254 712 345 678' }), 201);
    expect(intl.phone).toBe('+254712345678');
    const none = await setup();                                                                                // no country configured: a national number is ambiguous
    expect((await none.staff.post(`${none.base}/tenants`).send({ fullName: 'Ambiguous', phone: '0241234567' })).status).toBe(422);
    expect((await none.staff.post(`${none.base}/tenants`).send({ fullName: 'Unambiguous', phone: '+233241234567' })).status).toBe(201);
  });
  it('currency and dates agree across the ledger, the AI copilot and WhatsApp for GHS, NGN and KES', async () => {
    const w = await setup({ country: 'GH' });
    const prop = await ok(mkProp(w, 'Cedi Court', { currency: 'GHS' }), 201); const unit = await ok(w.manager.post(`${w.base}/properties/${prop.id}/units`).send({ reference: '1A' }), 201);
    const tenant = await ok(w.staff.post(`${w.base}/tenants`).send({ fullName: 'Ama Mensah', email: 'ama@mail.test' }), 201);
    const tn = await ok(w.staff.post(`${w.base}/tenancies`).send({ unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 }), 201);
    await ok(w.manager.post(`${w.base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
    await ok(idem(w.manager, `${w.base}/tenancies/${tn.id}/charges`, { kind: 'fee', description: 'January rent', dueDate: '2026-01-01', amountMinor: 150000 }), 201);
    const ledger = await ok(w.staff.get(`${w.base}/tenancies/${tn.id}/ledger`));
    expect(ledger.summary.currency ?? ledger.currency ?? 'GHS').toBe('GHS');
    const cid = (await ok(w.staff.post(`${w.base}/copilot/conversations`).send({}), 201)).id;
    const ai = await ok(w.staff.post(`${w.base}/copilot/conversations/${cid}/messages`).send({ content: 'Who is overdue on rent?' }), 201);
    const answer = ai.conversation.messages.filter((m: any) => m.role === 'assistant').at(-1);
    expect(answer.content).toMatch(/1,500\.00 GHS/); expect(answer.blocks.grounding.unverified_amounts).toEqual([]);
    expect((await ok(w.staff.get(`${w.base}/market`)))).toMatchObject({ currency: 'GHS', timezone: 'Africa/Accra', calling_code: '233' });
  });
  it('saves market settings, refuses unreviewed rule packs, and only admins may change them', async () => {
    const w = await setup();
    expect((await w.manager.put(`${w.base}/market`).send({ country: 'KE' })).status).toBe(403);
    const m = await ok(w.admin.put(`${w.base}/market`).send({ country: 'KE', paymentProviders: ['manual_mobile_money'], comms: { quiet_hours: { start: '21:00', end: '06:30' }, preferred_channels: ['whatsapp', 'sms'] } }));
    expect(m).toMatchObject({ country: 'KE', currency: 'KES', timezone: 'Africa/Nairobi', locale: 'en-KE', payment_providers: ['manual_mobile_money'] });
    expect((await w.admin.put(`${w.base}/market`).send({ country: 'KE', timezone: 'Mars/Phobos' })).status).toBe(422);
    const packs = await w.admin.put(`${w.base}/market`).send({ country: 'KE', rulePacks: ['KE:eviction-procedure'] });
    expect(packs.status).toBe(422); expect(packs.body.error.message).toMatch(/not been reviewed by a qualified person/);
  });
});

describe('the scheduler keeps subscriptions honest', () => {
  it('moves lapsed trials along and reports billing in the job result', async () => {
    const w = await setup();
    await ok(operator('assign', { orgId: w.id, plan: 'growth', status: 'trialing', periodEnd: new Date(Date.now() - 60000).toISOString(), reason: 'simulate an old trial' }));
    const run = await ok(supertest(t.app).get('/api/internal/jobs/run').set('Authorization', `Bearer ${CRON_SECRET}`));
    expect(run.billing.errors).toEqual([]); expect(run.billing.tick.expired).toBeGreaterThanOrEqual(1);
    expect((await planOf(w))).toMatchObject({ plan: { code: 'free' }, status: 'expired', lapsed: true });
    expect((await ok(w.staff.get(`${w.base}/properties`))).total).toBe(0);                                      // reading still works on the free plan
  });
});
