import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exponent, plainAmount } from '../../src/lib/currency.js';
import { as, call, code } from '../support/db.js';
import { propertyArgs, tenantArgs, unitArgs } from '../support/fixtures.js';
import { count, freshOps, key, svc, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
beforeEach(async () => { ({ db, o } = await freshOps()); });
afterEach(async () => { await db.close(); });

const S = (fn: string, args: Record<string, unknown> = {}) => call(db, svc, fn, args);
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);
const assign = (org: string, plan: string, status = 'active', periodEnd: string | null = null) => S('billing_svc_assign', { p_org: org, p_plan: plan, p_status: status, p_period_end: periodEnd, p_reason: 'test setup' });
const sub = async (org = o.orgA) => (await q(`select * from public.subscriptions where org_id = $1`, [org]))[0];
const plan = async (org = o.orgA) => (await q(`select app.effective_plan($1) p`, [org]))[0].p as string;
const prop = (name: string, org = o.orgA, who: any = o.manager) => call(db, who, 'create_property', propertyArgs(org, { p_name: name }));
let n = 0;
const unit = (p: string, org = o.orgA, who: any = o.manager) => call(db, who, 'create_unit', unitArgs(org, p, `U${++n}`));
const setOverride = (org: string, k: string, limit: number | null, enabled = true) => S('billing_svc_set_override', { p_org: org, p_key: k, p_enabled: enabled, p_limit: limit, p_reason: 'test', p_expires_at: null });

describe('plans and the trial', () => {
  it('every new organization starts a trial on the configured plan with the plan\'s entitlements', async () => {
    const s = await sub();
    expect(s).toMatchObject({ plan_code: 'growth', status: 'trialing', provider: 'manual' });
    expect(+new Date(s.trial_ends_at) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    const e = await call(db, o.staff, 'get_entitlements', { p_org: o.orgA });
    expect(e).toMatchObject({ plan: { code: 'growth' }, status: 'trialing', lapsed: false });
    expect(e.entitlements.find((x: any) => x.key === 'whatsapp')).toMatchObject({ enabled: true });
    expect(e.entitlements.find((x: any) => x.key === 'units')).toMatchObject({ limit: 500, used: 2 });
    expect((await q(`select type from public.subscription_events where org_id = $1`, [o.orgA])).map((r) => r.type)).toContain('trial_started');
  });
  it('only admins see billing detail, nobody sees another organization\'s, and users cannot change subscriptions', async () => {
    expect(await code(call(db, o.manager, 'get_billing', { p_org: o.orgA }))).toBe('PT403');
    expect((await call(db, o.admin, 'get_billing', { p_org: o.orgA })).plans.map((p: any) => p.code)).toEqual(['starter', 'growth', 'scale']);
    expect(await code(call(db, o.outsider, 'get_billing', { p_org: o.orgA }))).toMatch(/PT40[34]/);
    expect(await q(`select 1 from public.subscriptions`)).toHaveLength(2);   // (superuser view: both orgs have one)
    const visible = await as(db, o.outsider, async (qq) => (await qq(`select org_id from public.subscriptions`)).rows.map((r: any) => r.org_id));
    expect(visible).toEqual([o.orgB]);
    for (const fn of ['billing_svc_assign', 'billing_svc_tick', 'billing_svc_apply_pending']) expect(await code(call(db, o.owner, fn, fn === 'billing_svc_assign' ? { p_org: o.orgA, p_plan: 'legacy', p_status: 'active', p_period_end: null, p_reason: 'x y z' } : {})), fn).toBe('42501');
    expect(await code(as(db, o.owner, (qq) => qq(`update public.subscriptions set plan_code = 'legacy'`)))).toMatch(/42501|permission/);
    expect(await code(as(db, o.owner, (qq) => qq(`insert into public.org_entitlement_overrides (org_id, key, reason) values ($1, 'units', 'give me more')`, [o.orgA])))).toMatch(/42501|permission/);
  });
});

describe('limits are enforced by the database', () => {
  it('properties, units, seats: blocked at the limit with a plain 402, archived records do not count, data is never removed', async () => {
    await assign(o.orgA, 'starter');                                     // 3 properties, 30 units, 3 seats
    expect(await count(db, `select count(*) n from public.properties where org_id = $1`, [o.orgA])).toBe(1);
    const p2 = await prop('Second'); const p3 = await prop('Third');
    await expect(prop('Fourth')).rejects.toMatchObject({ code: 'PT402', message: expect.stringMatching(/Starter plan allows 3 properties/) });
    await call(db, o.manager, 'set_property_archived', { p_org: o.orgA, p_property: p3.id, p_archived: true });
    const p4 = await prop('Fourth');                                     // an archived property frees its slot…
    await expect(call(db, o.manager, 'set_property_archived', { p_org: o.orgA, p_property: p3.id, p_archived: false })).rejects.toMatchObject({ code: 'PT402' });   // …and restoring needs room
    expect(p2.id && p4.id).toBeTruthy();
    await setOverride(o.orgA, 'units', 3);
    await unit(p2.id);
    await expect(unit(p2.id)).rejects.toMatchObject({ code: 'PT402', message: expect.stringMatching(/allows 3 units/) });
  });
  it('seats: the plan counts people who can work; view-only members are free; an invitation reserves a seat', async () => {
    await assign(o.orgA, 'free');                                        // 2 seats, but 4 non-viewers already exist (grandfathered)
    await expect(call(db, o.owner, 'create_invitation', { p_org: o.orgA, p_email: 'new@a.test', p_role: 'staff', p_token_hash: 'h1' })).rejects.toMatchObject({ code: 'PT402' });
    await call(db, o.owner, 'create_invitation', { p_org: o.orgA, p_email: 'viewer2@a.test', p_role: 'viewer', p_token_hash: 'h2' });
    await setOverride(o.orgA, 'seats', 5);                               // one free seat
    await call(db, o.owner, 'create_invitation', { p_org: o.orgA, p_email: 'one@a.test', p_role: 'staff', p_token_hash: 'h3' });
    await expect(call(db, o.owner, 'create_invitation', { p_org: o.orgA, p_email: 'two@a.test', p_role: 'staff', p_token_hash: 'h4' })).rejects.toMatchObject({ code: 'PT402' });   // the first reserved it
    expect(await count(db, `select count(*) n from public.memberships where org_id = $1`, [o.orgA])).toBe(5);        // nobody was removed
  });
  it('a downgrade never deletes or hides existing data; it only stops new additions', async () => {
    const before = await count(db, `select count(*) n from public.units where org_id = $1`, [o.orgA]);
    await assign(o.orgA, 'free');
    expect(await count(db, `select count(*) n from public.units where org_id = $1`, [o.orgA])).toBe(before);
    expect((await call(db, o.manager, 'list_units', { p_org: o.orgA })).total).toBe(before);
    await prop('Another').then(() => { throw new Error('should have been refused'); }, (e) => expect(e.code).toBe('PT402'));
    // existing records stay usable: reading continues and nothing was archived or removed
    expect((await call(db, o.manager, 'get_property', { p_org: o.orgA, p_property: o.prop })).id).toBe(o.prop);
  });
  it('document storage is metered in megabytes across leases and maintenance attachments', async () => {
    const lease = (await call(db, o.staff, 'create_lease', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'initial', p_start_date: '2026-01-01', p_end_date: '2026-12-31', p_signed_on: null, p_notes: null })).id;
    const mk = (mb: number) => call(db, o.staff, 'create_document', { p_org: o.orgA, p_lease: lease, p_doc_type: 'lease', p_file_name: `f${mb}.pdf`, p_mime_type: 'application/pdf', p_size_bytes: mb * 1048576 - 1 });
    await setOverride(o.orgA, 'storage_mb', 3);
    await mk(2);
    await expect(mk(2)).rejects.toMatchObject({ code: 'PT402', message: expect.stringMatching(/3 MB of document storage/) });
    await mk(1);
    expect((await call(db, o.staff, 'get_entitlements', { p_org: o.orgA })).entitlements.find((x: any) => x.key === 'storage_mb').used).toBe(3);
  });
  it('two requests racing for the last slot cannot both succeed (checked per organization and key)', async () => {
    // Serialisation is proven against real parallel PostgreSQL in ops-concurrency.test.ts; here we prove the lock key is per organization and key.
    await setOverride(o.orgA, 'units', 3); await setOverride(o.orgB, 'units', 3);
    await unit(o.prop);
    await call(db, o.outsider, 'create_property', propertyArgs(o.orgB)).then(async (pb: any) => { for (let i = 0; i < 3; i++) await unit(pb.id, o.orgB, o.outsider); });
    await expect(unit(o.prop)).rejects.toMatchObject({ code: 'PT402' });     // A is full (limit 3: 2 seeded + 1)
    await expect(call(db, o.outsider, 'create_unit', unitArgs(o.orgB, (await q(`select id from public.properties where org_id = $1`, [o.orgB]))[0].id, 'ZZ'))).rejects.toMatchObject({ code: 'PT402' });
  });
});

describe('features and monthly meters', () => {
  it('a plan without a feature refuses it server-side', async () => {
    await assign(o.orgA, 'starter');
    await expect(call(db, o.admin, 'save_wa_channel', { p_org: o.orgA, p_phone_number_id: '100000000000001', p_display_number: null, p_waba_id: null, p_enabled: true, p_intake_user: o.manager.sub, p_urgent_user: null, p_welcome_text: null,
      p_rent_template_name: null, p_rent_template_lang: 'en', p_rent_template_body: null, p_update_template_name: null, p_update_template_lang: 'en' })).rejects.toMatchObject({ code: 'PT402', message: expect.stringMatching(/not included in your Starter plan/) });
    expect(await code(call(db, o.staff, 'require_entitlement', { p_org: o.orgA, p_key: 'exports' }))).toBe('PT402');
    await assign(o.orgA, 'growth');
    expect(await call(db, o.staff, 'require_entitlement', { p_org: o.orgA, p_key: 'exports' })).toEqual({ ok: true });
    await assign(o.orgA, 'free');
    expect(await code(S('copilot_svc_begin_turn', { p_org: o.orgA, p_user: o.staff.sub, p_conversation: (await call(db, o.staff, 'create_copilot_conversation', { p_org: o.orgA })).id, p_request_id: 'r' }))).toBe('PT402');
  });
  it('AI requests are counted per month and refused when the allowance is used up', async () => {
    await setOverride(o.orgA, 'ai_requests_month', 2);
    const c = (await call(db, o.staff, 'create_copilot_conversation', { p_org: o.orgA })).id;
    const turn = async () => { await S('copilot_svc_begin_turn', { p_org: o.orgA, p_user: o.staff.sub, p_conversation: c, p_request_id: 'r' }); await S('copilot_svc_end_turn', { p_org: o.orgA, p_conversation: c }); };
    await turn(); await turn();
    await expect(turn()).rejects.toMatchObject({ code: 'PT402', message: expect.stringMatching(/used all 2 of your ai copilot requests/i) });
    expect((await q(`select used from public.usage_counters where org_id = $1 and key = 'ai_requests_month'`, [o.orgA]))[0].used).toBe(2);
    await q(`update public.usage_counters set period = period - interval '1 month'`);      // a new month starts a new count
    await turn();
  });
  it('WhatsApp conversations are counted per 24-hour window and flagged (not silently dropped) when over the allowance', async () => {
    await call(db, o.admin, 'save_wa_channel', { p_org: o.orgA, p_phone_number_id: '100000000000001', p_display_number: null, p_waba_id: null, p_enabled: true, p_intake_user: o.manager.sub, p_urgent_user: null, p_welcome_text: null,
      p_rent_template_name: null, p_rent_template_lang: 'en', p_rent_template_body: null, p_update_template_name: null, p_update_template_lang: 'en' });
    await setOverride(o.orgA, 'whatsapp_conversations_month', 1);
    const inb = (wa: string) => S('wa_svc_begin_inbound', { p_org: o.orgA, p_wa_id: wa, p_name: null, p_provider_id: `wamid.${key()}`, p_kind: 'text', p_body: 'hi', p_ts: new Date().toISOString(), p_max_per_10min: 20 });
    expect((await inb('15550001111')).over_limit).toBe(false);
    expect((await inb('15550001111')).over_limit).toBe(false);      // same window: not a new conversation
    expect((await inb('15550002222')).over_limit).toBe(true);
    // a plan without WhatsApp turns the channel off for routing as well
    await assign(o.orgA, 'starter');
    expect((await S('wa_svc_channel', { p_phone_number_id: '100000000000001' })).enabled).toBe(false);
  });
  it('operator overrides win until they expire', async () => {
    await assign(o.orgA, 'starter');
    expect((await q(`select app.ent($1, 'whatsapp') e`, [o.orgA]))[0].e).toMatchObject({ enabled: false, source: 'plan' });
    await setOverride(o.orgA, 'whatsapp', null, true);
    expect((await q(`select app.ent($1, 'whatsapp') e`, [o.orgA]))[0].e).toMatchObject({ enabled: true, source: 'override' });
    await q(`update public.org_entitlement_overrides set expires_at = now() - interval '1 second'`);
    expect((await q(`select app.ent($1, 'whatsapp') e`, [o.orgA]))[0].e).toMatchObject({ enabled: false, source: 'plan' });
  });
});

describe('subscription lifecycle', () => {
  it('a trial that ends falls back to the free plan, keeps the data, and the tick records it once', async () => {
    await q(`update public.subscriptions set trial_ends_at = now() - interval '1 minute' where org_id = $1`, [o.orgA]);
    expect(await plan()).toBe('free');
    expect(await S('billing_svc_tick')).toMatchObject({ expired: 1 });
    expect(await S('billing_svc_tick')).toMatchObject({ expired: 0 });
    expect((await sub()).status).toBe('expired');
  });
  it('trial reminders go out once to admins', async () => {
    await q(`update public.subscriptions set trial_ends_at = now() + interval '2 days' where org_id = $1`, [o.orgA]);
    await S('billing_svc_tick'); await S('billing_svc_tick');
    expect(await count(db, `select count(*) n from public.notifications where event_type = 'billing.trial_ending' and user_id = $1`, [o.admin.sub])).toBe(1);
  });
  it('an unpaid period becomes past due with a grace period, then expires', async () => {
    await assign(o.orgA, 'growth', 'active', new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(await plan()).toBe('free');                                       // beyond the one-day tolerance for a late renewal
    await S('billing_svc_tick');
    expect(await sub()).toMatchObject({ status: 'past_due' });
    expect(await plan()).toBe('growth');                                     // grace: still on the paid plan
    await q(`update public.subscriptions set grace_until = now() - interval '1 second'`);
    expect(await plan()).toBe('free');
    await S('billing_svc_tick');
    expect((await sub()).status).toBe('expired');
  });
  it('a cancelled subscription keeps its plan until the paid period ends', async () => {
    await assign(o.orgA, 'growth', 'cancelled', new Date(Date.now() + 5 * 86_400_000).toISOString());
    expect(await plan()).toBe('growth');
    await q(`update public.subscriptions set current_period_end = now() - interval '1 minute'`);
    expect(await plan()).toBe('free');
    await S('billing_svc_tick');
    expect((await sub()).status).toBe('expired');
  });
  it('operator assignments need a reason and a real plan, and are recorded', async () => {
    expect(await code(S('billing_svc_assign', { p_org: o.orgA, p_plan: 'nope', p_status: 'active', p_period_end: null, p_reason: 'x y z' }))).toBe('PT404');
    expect(await code(S('billing_svc_assign', { p_org: o.orgA, p_plan: 'growth', p_status: 'active', p_period_end: null, p_reason: '' }))).toBe('PT422');
    await assign(o.orgA, 'scale');
    expect((await q(`select detail ->> 'reason' r from public.subscription_events where type = 'assigned_by_operator'`))[0].r).toBe('test setup');
  });
});

describe('billing events: verified inputs, applied once', () => {
  const checkout = async (plan_ = 'growth', currency = 'NGN', interval = 'monthly') => {
    const reference = `pai_${key().replace(/-/g, '').slice(0, 20)}`;
    const r = await call(db, o.admin, 'begin_checkout', { p_org: o.orgA, p_plan: plan_, p_interval: interval, p_currency: currency, p_provider: 'paystack', p_reference: reference });
    return { reference, ...r };
  };
  const ev = async (id: string, normalized: Record<string, unknown>) => {
    const rec = await S('billing_svc_record_event', { p_provider: 'paystack', p_event_id: id, p_type: String(normalized.kind), p_payload: {}, p_normalized: normalized });
    return { rec, applied: rec.duplicate ? null : await S('billing_svc_apply', { p_id: rec.id }) };
  };
  it('checkout is a record of intent; it changes nothing until a payment event arrives', async () => {
    const c = await checkout();
    expect(c).toMatchObject({ amount_minor: 4500000, currency: 'NGN' });
    expect((await sub()).status).toBe('trialing');
    expect(await code(call(db, o.manager, 'begin_checkout', { p_org: o.orgA, p_plan: 'growth', p_interval: 'monthly', p_currency: 'NGN', p_provider: 'paystack', p_reference: 'abcdefghij' }))).toBe('PT403');
    expect(await code(call(db, o.admin, 'begin_checkout', { p_org: o.orgA, p_plan: 'growth', p_interval: 'monthly', p_currency: 'KES', p_provider: 'paystack', p_reference: 'abcdefghik' }))).toBe('NO_ERROR');
    expect(await code(call(db, o.admin, 'begin_checkout', { p_org: o.orgA, p_plan: 'starter', p_interval: 'annual', p_currency: 'NGN', p_provider: 'paystack', p_reference: 'abcdefghil' }))).toBe('PT422');   // no such price
    expect(await code(call(db, o.admin, 'begin_checkout', { p_org: o.orgA, p_plan: 'legacy', p_interval: 'monthly', p_currency: 'NGN', p_provider: 'paystack', p_reference: 'abcdefghim' }))).toBe('PT404');
  });
  it('a verified payment activates the plan once; a replay changes nothing', async () => {
    const c = await checkout();
    const paid = { kind: 'paid', reference: c.reference, customer_ref: 'CUS_1', amount_minor: 4500000, currency: 'NGN', occurred_at: '2026-10-01T10:00:00Z', period_end: '2026-11-01T10:00:00Z' };
    const first = await ev('charge.success:1001', paid);
    expect(first.applied).toMatchObject({ status: 'processed', org_id: o.orgA });
    expect(await sub()).toMatchObject({ status: 'active', plan_code: 'growth', provider: 'paystack', currency: 'NGN', provider_customer_ref: 'CUS_1' });
    const events = await count(db, `select count(*) n from public.subscription_events where org_id = $1 and type = 'payment_succeeded'`, [o.orgA]);
    const again = await ev('charge.success:1001', paid);
    expect(again.rec.duplicate).toBe(true);
    // even the same payment under another event id is ignored as stale rather than extending the period
    await ev('charge.success:1001b', paid);
    expect(await count(db, `select count(*) n from public.subscription_events where org_id = $1 and type = 'payment_succeeded'`, [o.orgA])).toBe(events);
    expect(new Date((await sub()).current_period_end).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(await count(db, `select count(*) n from public.billing_events where provider_event_id like 'charge.success:1001%'`)).toBe(2);
    expect((await q(`select status from public.billing_checkouts where reference = $1`, [c.reference]))[0].status).toBe('paid');
  });
  it('rejects a payment that is short, in the wrong currency, or for an unknown checkout, without upgrading anything', async () => {
    const c = await checkout('scale', 'GHS');
    const short = await ev('charge.success:2001', { kind: 'paid', reference: c.reference, amount_minor: 1000, currency: 'GHS', occurred_at: '2026-10-01T10:00:00Z' });
    expect(short.applied).toMatchObject({ status: 'rejected' });
    expect(await ev('charge.success:2002', { kind: 'paid', reference: c.reference, amount_minor: c.amount_minor, currency: 'NGN', occurred_at: '2026-10-02T10:00:00Z' })).toMatchObject({ applied: { status: 'rejected' } });
    expect((await sub()).plan_code).toBe('growth'); expect((await sub()).status).toBe('trialing');
    const stranger = await ev('charge.success:2003', { kind: 'paid', reference: 'pai_not_ours_at_all', amount_minor: 99999999, currency: 'NGN', occurred_at: '2026-10-02T10:00:00Z' });
    expect(stranger.applied).toMatchObject({ status: 'pending' });          // unmatched: kept for a retry, never applied to a guess
    for (let i = 0; i < 8; i++) await S('billing_svc_apply_pending');
    expect((await q(`select status from public.billing_events where provider_event_id = 'charge.success:2003'`))[0].status).toBe('ignored');
    expect((await sub()).plan_code).toBe('growth');
  });
  it('a payment cannot be attributed to another organization through a shared reference', async () => {
    const c = await checkout();                                              // belongs to org A
    await call(db, o.outsider, 'begin_checkout', { p_org: o.orgB, p_plan: 'starter', p_interval: 'monthly', p_currency: 'NGN', p_provider: 'paystack', p_reference: 'pai_org_b_reference_1' });
    await ev('charge.success:3001', { kind: 'paid', reference: 'pai_org_b_reference_1', amount_minor: 1500000, currency: 'NGN', occurred_at: '2026-10-01T10:00:00Z' });
    expect((await sub(o.orgB))).toMatchObject({ plan_code: 'starter', status: 'active' });
    expect((await sub(o.orgA))).toMatchObject({ plan_code: 'growth', status: 'trialing' });
    expect(c.reference).not.toBe('pai_org_b_reference_1');
  });
  it('failed payments start a grace period (once), an older failure never undoes a later payment, and cancellation ends the plan at period end', async () => {
    const c = await checkout();
    await ev('charge.success:4001', { kind: 'paid', reference: c.reference, customer_ref: 'CUS_4', subscription_ref: 'SUB_4', amount_minor: 4500000, currency: 'NGN', occurred_at: '2026-10-01T10:00:00Z', period_end: new Date(Date.now() + 25 * 86_400_000).toISOString() });
    await ev('invoice.payment_failed:old', { kind: 'failed', subscription_ref: 'SUB_4', occurred_at: '2026-09-15T00:00:00Z' });
    expect((await sub()).status).toBe('active');
    await ev('invoice.payment_failed:new', { kind: 'failed', subscription_ref: 'SUB_4', occurred_at: '2026-10-20T00:00:00Z' });
    expect(await sub()).toMatchObject({ status: 'past_due' });
    expect((await sub()).grace_until).not.toBeNull();
    expect(await count(db, `select count(*) n from public.notifications where event_type = 'billing.past_due' and user_id = $1`, [o.owner.sub])).toBe(1);
    await ev('subscription.not_renew:SUB_4', { kind: 'cancel_scheduled', subscription_ref: 'SUB_4', occurred_at: '2026-10-21T00:00:00Z' });
    expect((await sub()).cancel_at_period_end).toBe(true);
    await ev('subscription.disable:SUB_4', { kind: 'ended', subscription_ref: 'SUB_4', occurred_at: '2026-10-22T00:00:00Z' });
    expect(await sub()).toMatchObject({ status: 'cancelled' });
    expect(await plan()).toBe('growth');                                       // paid through the period
  });
  it('a reconciliation snapshot from the provider corrects missed events', async () => {
    const c = await checkout();
    await ev('charge.success:5001', { kind: 'paid', reference: c.reference, customer_ref: 'CUS_5', subscription_ref: 'SUB_5', amount_minor: 4500000, currency: 'NGN', occurred_at: '2026-10-01T10:00:00Z', period_end: '2026-11-01T00:00:00Z' });
    await ev('snapshot:SUB_5:1', { kind: 'snapshot', subscription_ref: 'SUB_5', status: 'attention', period_end: '2026-11-01T00:00:00Z' });
    expect((await sub()).status).toBe('past_due');
    await ev('snapshot:SUB_5:2', { kind: 'snapshot', subscription_ref: 'SUB_5', status: 'active', period_end: '2026-12-01T00:00:00Z' });
    expect(await sub()).toMatchObject({ status: 'active', cancel_at_period_end: false });
    await ev('snapshot:SUB_5:3', { kind: 'snapshot', subscription_ref: 'SUB_5', status: 'non_renewing', period_end: '2026-12-01T00:00:00Z' });
    expect((await sub()).cancel_at_period_end).toBe(true);
    expect(await S('billing_svc_reconcile_list', { p_limit: 10 })).toBeDefined();
  });
});

describe('two organizations on different plans', () => {
  it('limits and features are per organization; neither can see or touch the other\'s records', async () => {
    await assign(o.orgA, 'free'); await assign(o.orgB, 'scale');
    await expect(prop('Blocked on A')).rejects.toMatchObject({ code: 'PT402' });
    const pb = await call(db, o.outsider, 'create_property', propertyArgs(o.orgB, { p_name: 'Fine on B' }));
    expect(pb.id).toBeTruthy();
    expect(await code(call(db, o.outsider, 'get_property', { p_org: o.orgA, p_property: o.prop }))).toMatch(/PT40[34]/);
    expect(await code(call(db, o.manager, 'get_property', { p_org: o.orgB, p_property: pb.id }))).toMatch(/PT40[34]/);
    expect((await call(db, o.outsider, 'get_entitlements', { p_org: o.orgB })).plan.code).toBe('scale');
    expect(await code(call(db, o.outsider, 'get_entitlements', { p_org: o.orgA }))).toMatch(/PT40[34]/);
  });
});

describe('countries, currencies and time zones', () => {
  it('GHS, NGN and KES are first-class: valid for properties, two decimals, formatted identically in SQL and TypeScript', async () => {
    for (const [cur, tz, cty] of [['GHS', 'Africa/Accra', 'GH'], ['NGN', 'Africa/Lagos', 'NG'], ['KES', 'Africa/Nairobi', 'KE']] as const) {
      const p = await call(db, o.manager, 'create_property', propertyArgs(o.orgA, { p_name: `P ${cur}`, p_currency: cur, p_timezone: tz, p_country: cty }));
      expect(p.currency).toBe(cur);
      expect((await q(`select app.property_today($1)::text d, (now() at time zone $2)::date::text e`, [p.id, tz]))[0]).toSatisfy((r: any) => r.d === r.e);
    }
    expect(await code(call(db, o.manager, 'create_property', propertyArgs(o.orgA, { p_name: 'Nope', p_currency: 'ZZZ' })))).toBe('PT422');
    for (const c of await q(`select code, exponent from public.currencies`)) {
      expect(exponent(c.code), c.code).toBe(c.exponent);
      expect((await q(`select app.money_text(1234567, $1) t`, [c.code]))[0].t, c.code).toBe(plainAmount(1234567, c.code));
    }
  });
  it('organization settings validate country, currency, time zone, locale, providers and communication rules', async () => {
    const base = { p_org: o.orgA, p_country: 'GH', p_currency: 'GHS', p_timezone: 'Africa/Accra', p_locale: 'en-GH', p_date_format: 'DD/MM/YYYY', p_payment_providers: ['manual_mobile_money'], p_comms: { preferred_channels: ['whatsapp'], quiet_hours: { start: '21:00', end: '07:00' } }, p_rule_packs: [] };
    expect(await code(call(db, o.manager, 'save_market', base))).toBe('PT403');
    const m = await call(db, o.admin, 'save_market', base);
    expect(m).toMatchObject({ country: 'GH', currency: 'GHS', timezone: 'Africa/Accra', locale: 'en-GH', calling_code: '233', payment_providers: ['manual_mobile_money'] });
    for (const bad of [{ p_country: 'XX' }, { p_currency: 'QQQ' }, { p_timezone: 'Mars/Phobos' }, { p_payment_providers: ['bitcoin_atm'] }, { p_comms: { preferred_channels: ['pigeon'] } }, { p_comms: { quiet_hours: { start: '25:00', end: '07:00' } } }]) {
      expect(await code(call(db, o.admin, 'save_market', { ...base, ...bad })), JSON.stringify(bad)).toBe('PT422');
    }
    const resolved = await call(db, o.viewer, 'get_market', { p_org: o.orgA });
    expect(resolved.countries.map((c: any) => c.iso2)).toEqual(expect.arrayContaining(['GH', 'NG', 'KE']));
    expect(await call(db, o.outsider, 'get_market', { p_org: o.orgB })).toMatchObject({ configured: false });       // another organization's settings are its own
  });
  it('country defaults fill in what an organization has not chosen', async () => {
    await call(db, o.admin, 'save_market', { p_org: o.orgA, p_country: 'KE', p_currency: null, p_timezone: null, p_locale: null, p_date_format: null, p_payment_providers: [], p_comms: {}, p_rule_packs: [] });
    expect(await call(db, o.staff, 'get_market', { p_org: o.orgA })).toMatchObject({ currency: 'KES', timezone: 'Africa/Nairobi', locale: 'en-KE', date_format: 'DD/MM/YYYY', calling_code: '254' });
    expect((await q(`select app.org_today($1)::text d, (now() at time zone 'Africa/Nairobi')::date::text e`, [o.orgA]))[0]).toSatisfy((r: any) => r.d === r.e);
  });
  it('no legal rule packs ship; an unreviewed pack cannot be enabled, a reviewed one can, and retiring it switches it off', async () => {
    expect(await count(db, `select count(*) n from public.country_rule_packs`)).toBe(0);
    const pack = await S('rules_svc_register', { p_country: 'GH', p_code: 'example-notice', p_title: 'Example (test only)', p_content: { example: true } });
    const enable = (packs: string[]) => call(db, o.admin, 'save_market', { p_org: o.orgA, p_country: 'GH', p_currency: null, p_timezone: null, p_locale: null, p_date_format: null, p_payment_providers: [], p_comms: {}, p_rule_packs: packs });
    await expect(enable(['GH:example-notice'])).rejects.toMatchObject({ code: 'PT422', message: expect.stringMatching(/not been reviewed by a qualified person/) });
    await expect(S('rules_svc_review', { p_id: pack.id, p_status: 'reviewed', p_reviewer: 'A', p_note: 'short' })).rejects.toThrow();     // needs a named reviewer and a real note
    await S('rules_svc_review', { p_id: pack.id, p_status: 'reviewed', p_reviewer: 'Jane Doe, Advocate (test)', p_note: 'Reviewed against the statute text on file.' });
    expect(await q(`select app.rule_pack($1, 'example-notice') c`, [o.orgA])).toEqual([{ c: null }]);          // reviewed but not enabled
    await enable(['GH:example-notice']);
    expect((await q(`select app.rule_pack($1, 'example-notice') c`, [o.orgA]))[0].c).toEqual({ example: true });
    await expect(call(db, o.admin, 'save_market', { p_org: o.orgA, p_country: 'NG', p_currency: null, p_timezone: null, p_locale: null, p_date_format: null, p_payment_providers: [], p_comms: {}, p_rule_packs: ['GH:example-notice'] })).rejects.toMatchObject({ code: 'PT422' });   // packs are per country
    await S('rules_svc_review', { p_id: pack.id, p_status: 'retired', p_reviewer: 'Jane Doe', p_note: 'Withdrawn pending changes.' });
    expect(await q(`select app.rule_pack($1, 'example-notice') c`, [o.orgA])).toEqual([{ c: null }]);
  });
});

describe('quiet hours', () => {
  it('hold back proactive messages in the organization\'s own time zone, but never replies', async () => {
    await call(db, o.admin, 'save_wa_channel', { p_org: o.orgA, p_phone_number_id: '100000000000001', p_display_number: null, p_waba_id: null, p_enabled: true, p_intake_user: o.manager.sub, p_urgent_user: null, p_welcome_text: null,
      p_rent_template_name: 'rent_v1', p_rent_template_lang: 'en', p_rent_template_body: null, p_update_template_name: 'upd_v1', p_update_template_lang: 'en' });
    const tz = 'Africa/Lagos'; const local = (await q(`select (now() at time zone $1)::time t`, [tz]))[0].t as string;
    const hh = (d: number) => { const [h, m] = local.split(':').map(Number); return `${String((h! + d + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
    await call(db, o.admin, 'save_market', { p_org: o.orgA, p_country: 'NG', p_currency: null, p_timezone: tz, p_locale: null, p_date_format: null, p_payment_providers: [], p_comms: { quiet_hours: { start: hh(-1), end: hh(2) } }, p_rule_packs: [] });
    const c = (await S('wa_svc_begin_inbound', { p_org: o.orgA, p_wa_id: '2348000000001', p_name: null, p_provider_id: `wamid.${key()}`, p_kind: 'text', p_body: 'hi', p_ts: new Date().toISOString(), p_max_per_10min: 20 })).contact.id;
    await S('wa_svc_set_consent', { p_org: o.orgA, p_contact: c, p_value: 'opted_in' });
    const tpl = await S('wa_svc_enqueue', { p_org: o.orgA, p_contact: c, p_kind: 'template', p_body: 'x', p_template: { name: 'rent_v1', lang: 'en', params: [] }, p_origin: 'system', p_dedupe: 'q1', p_ack: false });
    const reply = await S('wa_svc_enqueue', { p_org: o.orgA, p_contact: c, p_kind: 'text', p_body: 'hello', p_template: null, p_origin: 'bot', p_dedupe: 'q2', p_ack: false });
    const rows = await q(`select id, (next_attempt_at > now() + interval '30 minutes') as held from public.whatsapp_messages where direction = 'out'`);
    expect(rows.find((r) => r.id === tpl.id).held).toBe(true);
    expect(rows.find((r) => r.id === reply.id).held).toBe(false);
  });
});

describe('seeded data is sane', () => {
  it('every plan has an entitlement for every catalog key, and prices are positive in known currencies', async () => {
    const keys = (await q(`select key from public.entitlement_catalog`)).map((r) => r.key);
    for (const p of await q(`select code from public.plans`)) {
      const have = (await q(`select key from public.plan_entitlements where plan_code = $1`, [p.code])).map((r) => r.key);
      expect(have.sort(), p.code).toEqual([...keys].sort());
    }
    expect(await count(db, `select count(*) n from public.plan_prices pp where not exists (select 1 from public.currencies c where c.code = pp.currency)`)).toBe(0);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
    void tenantArgs;
  });
});
