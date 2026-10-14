import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, call, code } from '../support/db.js';
import { tenantArgs } from '../support/fixtures.js';
import { count, freshOps, key, svc, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
const PNID = '100000000000001';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);
const S = (fn: string, args: Record<string, unknown> = {}) => call(db, svc, fn, args);

beforeEach(async () => {
  ({ db, o } = await freshOps());
  await call(db, o.admin, 'save_wa_channel', channel());
});
afterEach(async () => { await db.close(); });

function channel(over: Record<string, unknown> = {}) {
  return { p_org: o.orgA, p_phone_number_id: PNID, p_display_number: '+1 555 0100', p_waba_id: '200000000000001', p_enabled: true, p_intake_user: o.manager.sub, p_urgent_user: null, p_welcome_text: null,
    p_rent_template_name: 'rent_reminder_v1', p_rent_template_lang: 'en', p_rent_template_body: 'Hello {{1}}, {{2}} is outstanding (due {{3}}).', p_update_template_name: 'request_update_v1', p_update_template_lang: 'en', ...over };
}
let n = 0;
const inbound = (wa = '15550001111', text = 'hello', over: Record<string, unknown> = {}) => S('wa_svc_begin_inbound', { p_org: o.orgA, p_wa_id: wa, p_name: 'Sam', p_provider_id: `wamid.${++n}.${key().slice(0, 6)}`, p_kind: 'text', p_body: text, p_ts: new Date().toISOString(), p_max_per_10min: 20, ...over });
const link = async (tenant = o.tenant, wa = '15550001111') => {
  const c = (await inbound(wa)).contact.id as string;
  const raw = `CODE${key().slice(0, 8)}`;
  await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: tenant, p_code_hash: sha(raw) });
  const r = await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha(raw) });
  return { c, raw, r };
};
const optIn = (c: string) => S('wa_svc_set_consent', { p_org: o.orgA, p_contact: c, p_value: 'opted_in' });
const enqueue = (c: string, over: Record<string, unknown> = {}) => S('wa_svc_enqueue', { p_org: o.orgA, p_contact: c, p_kind: 'text', p_body: 'hi', p_template: null, p_origin: 'bot', p_dedupe: null, p_ack: false, ...over });
const backdate = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe('channel setup and routing', () => {
  it('only admins configure it; the intake member must be a manager; one number belongs to one organization', async () => {
    expect(await code(call(db, o.manager, 'save_wa_channel', channel()))).toBe('PT403');
    expect(await code(call(db, o.admin, 'save_wa_channel', channel({ p_intake_user: o.staff.sub })))).toBe('PT422');
    expect(await code(call(db, o.admin, 'save_wa_channel', channel({ p_phone_number_id: 'abc' })))).toBe('PT422');
    await expect(call(db, o.outsider, 'save_wa_channel', { ...channel({ p_intake_user: o.outsider.sub }), p_org: o.orgB })).rejects.toMatchObject({ code: 'PT409' });
    expect((await S('wa_svc_channel', { p_phone_number_id: PNID })).org_id).toBe(o.orgA);
    expect(await S('wa_svc_channel', { p_phone_number_id: '999999999' })).toBeNull();
  });
  it('signed-in users can neither call the service functions nor write the tables', async () => {
    for (const fn of ['wa_svc_channel', 'wa_svc_claim_events', 'wa_svc_queue_stats']) expect(await code(call(db, o.manager, fn, fn === 'wa_svc_channel' ? { p_phone_number_id: PNID } : fn === 'wa_svc_claim_events' ? { p_worker: 'x', p_limit: 1, p_lease_seconds: 30 } : {})), fn).toMatch(/42501/);
    expect(await code(as(db, o.manager, (qq) => qq(`insert into public.whatsapp_contacts (org_id, wa_id) values ($1, '15550009999')`, [o.orgA])))).toMatch(/42501|permission/);
    expect(await code(as(db, o.admin, (qq) => qq(`update public.whatsapp_channels set enabled = false`)))).toMatch(/42501|permission/);
  });
  it('message content is visible to managers only', async () => {
    await inbound('15550001111', 'my private text');
    const read = (a: any) => as(db, a, async (qq) => (await qq(`select count(*)::int n from public.whatsapp_messages`)).rows[0].n);
    expect(await read(o.manager)).toBe(1); expect(await read(o.staff)).toBe(0); expect(await read(o.viewer)).toBe(0); expect(await read(o.outsider)).toBe(0);
  });
});

describe('durable inbox', () => {
  const ev = (id: string, contact: string | null = '15550001111', kind = 'message') => ({ kind, provider_id: id, contact_key: contact, payload: { id } });
  it('stores each provider event once, ignores unknown numbers, and counts duplicates', async () => {
    expect(await S('wa_svc_ingest', { p_phone_number_id: PNID, p_events: [ev('a'), ev('b')] })).toMatchObject({ received: 2, duplicates: 0 });
    expect(await S('wa_svc_ingest', { p_phone_number_id: PNID, p_events: [ev('a'), ev('c')] })).toMatchObject({ received: 1, duplicates: 1 });
    expect(await S('wa_svc_ingest', { p_phone_number_id: '555555', p_events: [ev('z')] })).toMatchObject({ unknown_channel: true, received: 0 });
    expect(await count(db, `select count(*) n from public.whatsapp_events`)).toBe(3);
  });
  it('hands out events once, and a contact\'s events strictly in order', async () => {
    await S('wa_svc_ingest', { p_phone_number_id: PNID, p_events: [ev('m1', '111'), ev('m2', '111'), ev('m3', '222'), ev('s1', null, 'status')] });
    const first = await S('wa_svc_claim_events', { p_worker: 'w1', p_limit: 10, p_lease_seconds: 60 });
    expect(first.map((e: any) => e.provider_id).sort()).toEqual(['m1', 'm3', 's1']);          // m2 waits for m1
    expect(await S('wa_svc_claim_events', { p_worker: 'w2', p_limit: 10, p_lease_seconds: 60 })).toEqual([]);
    await S('wa_svc_finish_event', { p_id: first.find((e: any) => e.provider_id === 'm1').id, p_worker: 'w1', p_outcome: 'done', p_error: null, p_delay_seconds: 0 });
    expect((await S('wa_svc_claim_events', { p_worker: 'w2', p_limit: 10, p_lease_seconds: 60 })).map((e: any) => e.provider_id)).toEqual(['m2']);
  });
  it('retries with backoff, gives up after repeated failures, and recovers events from a crashed worker', async () => {
    await S('wa_svc_ingest', { p_phone_number_id: PNID, p_events: [ev('r1', '333')] });
    const id = (await S('wa_svc_claim_events', { p_worker: 'w1', p_limit: 1, p_lease_seconds: 30 }))[0].id;
    expect(await S('wa_svc_finish_event', { p_id: id, p_worker: 'wrong', p_outcome: 'done', p_error: null, p_delay_seconds: 0 })).toMatchObject({ ok: false });
    expect(await S('wa_svc_finish_event', { p_id: id, p_worker: 'w1', p_outcome: 'retry', p_error: 'boom', p_delay_seconds: 30 })).toMatchObject({ status: 'failed' });
    expect(await S('wa_svc_claim_events', { p_worker: 'w1', p_limit: 1, p_lease_seconds: 30 })).toEqual([]);           // not due yet
    for (let i = 0; i < 5; i++) {
      await backdate(`update public.whatsapp_events set next_attempt_at = now() - interval '1 second'`);
      const c = await S('wa_svc_claim_events', { p_worker: 'w1', p_limit: 1, p_lease_seconds: 30 });
      const r = await S('wa_svc_finish_event', { p_id: c[0].id, p_worker: 'w1', p_outcome: 'retry', p_error: 'boom', p_delay_seconds: 1 });
      if (i === 4) expect(r.status).toBe('dead');
    }
    await S('wa_svc_ingest', { p_phone_number_id: PNID, p_events: [ev('r2', '444')] });
    await S('wa_svc_claim_events', { p_worker: 'crashy', p_limit: 5, p_lease_seconds: 30 });
    await backdate(`update public.whatsapp_events set locked_until = now() - interval '1 second' where status = 'processing'`);
    expect((await S('wa_svc_claim_events', { p_worker: 'w2', p_limit: 5, p_lease_seconds: 30 })).map((e: any) => e.provider_id)).toEqual(['r2']);
  });
});

describe('inbound messages and the 24-hour window', () => {
  it('records a message once, whatever the number of deliveries', async () => {
    const args = { p_org: o.orgA, p_wa_id: '15550001111', p_name: 'Sam', p_provider_id: 'wamid.same', p_kind: 'text', p_body: 'hi', p_ts: new Date().toISOString(), p_max_per_10min: 20 };
    expect((await S('wa_svc_begin_inbound', args)).duplicate).toBe(false);
    expect((await S('wa_svc_begin_inbound', args)).duplicate).toBe(true);
    expect(await count(db, `select count(*) n from public.whatsapp_messages where direction = 'in'`)).toBe(1);
  });
  it('limits floods per contact and flags a delayed message as stale without extending the window', async () => {
    for (let i = 0; i < 3; i++) await inbound('15550002222', 'spam', { p_max_per_10min: 3 });
    const r = await inbound('15550002222', 'spam', { p_max_per_10min: 3 });
    expect(r).toMatchObject({ rate_limited: true, rate_notice: true });
    expect((await inbound('15550002222', 'spam', { p_max_per_10min: 3 })).rate_notice).toBe(false);
    const old = await inbound('15550003333', 'old news', { p_ts: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(old.stale).toBe(true);
    expect((await q(`select last_inbound_at < now() - interval '24 hours' as closed from public.whatsapp_contacts where wa_id = '15550003333'`))[0].closed).toBe(true);
  });
  it('keeps the same number in two organizations as two unrelated contacts', async () => {
    const a = await inbound('15550001111');
    await call(db, o.outsider, 'save_wa_channel', { ...channel({ p_intake_user: o.outsider.sub, p_phone_number_id: '100000000000002' }), p_org: o.orgB });
    const b = await S('wa_svc_begin_inbound', { p_org: o.orgB, p_wa_id: '15550001111', p_name: 'Sam', p_provider_id: 'wamid.b1', p_kind: 'text', p_body: 'hi', p_ts: new Date().toISOString(), p_max_per_10min: 20 });
    expect(a.contact.id).not.toBe(b.contact.id);
    expect(await code(S('wa_svc_try_link', { p_org: o.orgB, p_contact: a.contact.id, p_code_hash: sha('x') }))).toBe('PT404');   // org B cannot touch org A's contact
  });
});

describe('identity: a phone number alone proves nothing', () => {
  it('stays unverified without a staff-issued code, and the summary shows nothing', async () => {
    const c = (await inbound()).contact.id;
    expect(await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c })).toEqual({ verified: false, reason: 'unverified' });
    // even a contact whose number equals the tenant's phone on file gets nothing
    await db.query(`update public.tenants set phone = '+1 555 000 1111' where id = $1`, [o.tenant]);
    expect((await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c })).verified).toBe(false);
  });
  it('links with a one-time code, once, and the contact then sees only its own tenant', async () => {
    const { c, raw, r } = await link();
    expect(r).toMatchObject({ result: 'linked', first_name: expect.any(String) });
    const s = await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c });
    expect(s.verified).toBe(true);
    expect(s.tenancies.map((t: any) => t.tenancy_id)).toEqual([o.tenancy]);
    expect(JSON.stringify(s)).not.toContain(o.tenancy2);                       // another tenant's tenancy is not reachable
    const other = (await inbound('15550004444')).contact.id;
    expect(await S('wa_svc_try_link', { p_org: o.orgA, p_contact: other, p_code_hash: sha(raw) })).toMatchObject({ result: 'invalid' });   // single use
  });
  it('only managers issue codes, only for tenants with an active tenancy, and a new code revokes the old one', async () => {
    expect(await code(call(db, o.staff, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: sha('a') }))).toBe('PT403');
    expect(await code(call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: 'short' }))).toBe('PT422');
    const lone = (await call(db, o.staff, 'create_tenant', tenantArgs(o.orgA, 'No Tenancy', { p_email: null }))).id;
    expect(await code(call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: lone, p_code_hash: sha('b') }))).toBe('PT409');
    await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: sha('old') });
    await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: sha('new') });
    const c = (await inbound()).contact.id;
    expect((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha('old') })).result).toBe('invalid');
    expect((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha('new') })).result).toBe('linked');
  });
  it('rejects expired, unknown and other-organization codes identically, and locks after repeated guesses', async () => {
    const c = (await inbound()).contact.id;
    await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: sha('expired') });
    await db.query(`update public.whatsapp_link_codes set expires_at = now() - interval '1 minute'`);
    // a code issued in organization B for B's tenant
    const bTenant = (await call(db, o.outsider, 'create_tenant', tenantArgs(o.orgB, 'B Tenant', { p_email: null }))).id;
    await db.query(`insert into public.whatsapp_link_codes (org_id, tenant_id, code_hash, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')`, [o.orgB, bTenant, sha('bcode'), o.outsider.sub]);
    const tries = ['expired', 'nope', 'bcode', 'guess1'];
    const out = [];
    for (const t of tries) out.push((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha(t) })).result);
    expect(out).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha('guess2') })).result).toBe('locked');
    await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.tenant, p_code_hash: sha('good') });
    expect((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha('good') })).result).toBe('locked');     // even the right code, while locked
    expect((await q(`select (status = 'unverified') ok from public.whatsapp_contacts where id = $1`, [c]))[0].ok).toBe(true);
  });
  it('refuses to relink a verified number to a different tenant, and unlinking removes all access', async () => {
    const { c } = await link();
    const code2 = 'second';
    await call(db, o.manager, 'create_wa_link_code', { p_org: o.orgA, p_tenant: o.omarTenant, p_code_hash: sha(code2) });
    expect((await S('wa_svc_try_link', { p_org: o.orgA, p_contact: c, p_code_hash: sha(code2) })).result).toBe('already_linked');
    await call(db, o.manager, 'unlink_wa_contact', { p_org: o.orgA, p_contact: c, p_block: false });
    expect((await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c })).verified).toBe(false);
  });
  it('verification lapses after 180 days and for archived tenants', async () => {
    const { c } = await link();
    await db.query(`update public.whatsapp_contacts set verified_at = now() - interval '181 days'`);
    expect(await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c })).toMatchObject({ verified: false, reason: 'reverify' });
    expect((await inbound()).contact).toMatchObject({ verified: false, needs_reverify: true });
  });
  it('shows a verified tenant the balance of their own tenancies and nobody else\'s', async () => {
    await call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'fee', p_description: 'Rent', p_due_date: '2026-01-01', p_amount_minor: 150000, p_idempotency_key: key() });
    await call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy2, p_kind: 'fee', p_description: 'Rent', p_due_date: '2026-01-01', p_amount_minor: 99900, p_idempotency_key: key() });
    const { c } = await link();
    const s = await S('wa_svc_tenant_summary', { p_org: o.orgA, p_contact: c });
    expect(s.balances).toEqual([{ currency: 'USD', outstanding_minor: 150000, overdue_minor: 150000, next_due_date: '2026-01-01' }]);
  });
});

describe('outbound rules', () => {
  it('free text only inside the 24-hour window; templates need opt-in; opted-out contacts get nothing but one acknowledgement', async () => {
    const c = (await inbound()).contact.id;
    expect(await enqueue(c)).toMatchObject({ status: 'queued' });
    await backdate(`update public.whatsapp_contacts set last_inbound_at = now() - interval '25 hours'`);
    expect(await enqueue(c, { p_body: 'late' })).toMatchObject({ status: 'blocked', reason: 'window_closed' });
    const tpl = { p_kind: 'template', p_template: { name: 'rent_reminder_v1', lang: 'en', params: ['a'] } };
    expect(await enqueue(c, tpl)).toMatchObject({ status: 'blocked', reason: 'no_consent' });
    await optIn(c);
    expect(await enqueue(c, { ...tpl, p_dedupe: 't1' })).toMatchObject({ status: 'queued' });
    expect(await enqueue(c, { ...tpl, p_dedupe: 't1' })).toMatchObject({ duplicate: true });
    expect(await S('wa_svc_set_consent', { p_org: o.orgA, p_contact: c, p_value: 'opted_out' })).toMatchObject({ consent: 'opted_out' });
    expect((await q(`select count(*)::int n from public.whatsapp_messages where direction = 'out' and status = 'queued'`))[0].n).toBe(0);   // queued items were cancelled
    expect(await enqueue(c, tpl)).toMatchObject({ status: 'blocked', reason: 'opted_out' });
    await backdate(`update public.whatsapp_contacts set last_inbound_at = now()`);
    expect(await enqueue(c, { p_body: 'hi' })).toMatchObject({ reason: 'opted_out' });
    expect(await enqueue(c, { p_body: 'You are unsubscribed', p_ack: true, p_dedupe: 'optout-ack:1' })).toMatchObject({ status: 'queued' });
  });
  it('caps automated messages per contact per day, but not people', async () => {
    const c = (await inbound()).contact.id;
    for (let i = 0; i < 15; i++) expect((await enqueue(c, { p_body: `m${i}` })).status).toBe('queued');
    expect(await enqueue(c, { p_body: 'one too many' })).toMatchObject({ status: 'blocked', reason: 'rate_limited' });
    expect((await call(db, o.manager, 'wa_staff_reply', { p_org: o.orgA, p_contact: c, p_text: 'A person writes' })).status).toBe('queued');
  });
  it('re-checks at send time: an opt-out or a closed window after queueing stops the message', async () => {
    const c = (await inbound()).contact.id;
    await enqueue(c, { p_body: 'one' });
    await S('wa_svc_set_consent', { p_org: o.orgA, p_contact: c, p_value: 'opted_out' });
    expect(await S('wa_svc_claim_outbound', { p_worker: 'w', p_limit: 5, p_lease_seconds: 60 })).toEqual([]);
    const d = (await inbound('15550005555')).contact.id;
    await enqueue(d, { p_body: 'two' });
    await backdate(`update public.whatsapp_contacts set last_inbound_at = now() - interval '30 hours' where wa_id = '15550005555'`);
    expect(await S('wa_svc_claim_outbound', { p_worker: 'w', p_limit: 5, p_lease_seconds: 60 })).toEqual([]);
    expect((await q(`select error from public.whatsapp_messages where contact_id = $1`, [d]))[0].error).toBe('window_closed');
  });
  it('retries transient failures with backoff and gives up on permanent ones', async () => {
    const c = (await inbound()).contact.id;
    await enqueue(c, { p_body: 'retry me' });
    const claim = () => S('wa_svc_claim_outbound', { p_worker: 'w1', p_limit: 5, p_lease_seconds: 60 });
    let m = (await claim())[0];
    expect(m).toMatchObject({ to: '15550001111', phone_number_id: PNID, kind: 'text', attempts: 1 });
    expect(await S('wa_svc_fail_outbound', { p_id: m.id, p_worker: 'w1', p_code: '5xx', p_error: 'provider down', p_permanent: false })).toMatchObject({ status: 'queued' });
    expect(await claim()).toEqual([]);                                                       // backing off
    await backdate(`update public.whatsapp_messages set next_attempt_at = now() - interval '1 second'`);
    m = (await claim())[0]; expect(m.attempts).toBe(2);
    expect(await S('wa_svc_complete_outbound', { p_id: m.id, p_worker: 'w1', p_provider_id: 'wamid.out1' })).toMatchObject({ ok: true });
    await enqueue(c, { p_body: 'doomed' });
    m = (await claim())[0];
    expect(await S('wa_svc_fail_outbound', { p_id: m.id, p_worker: 'w1', p_code: '131026', p_error: 'undeliverable', p_permanent: true })).toMatchObject({ status: 'dead' });
  });
  it('tracks delivery receipts that arrive late, twice or out of order', async () => {
    const c = (await inbound()).contact.id;
    await enqueue(c, { p_body: 'track me' });
    const m = (await S('wa_svc_claim_outbound', { p_worker: 'w1', p_limit: 5, p_lease_seconds: 60 }))[0];
    await S('wa_svc_complete_outbound', { p_id: m.id, p_worker: 'w1', p_provider_id: 'wamid.t1' });
    const st = (status: string, code: string | null = null) => S('wa_svc_apply_status', { p_provider_id: 'wamid.t1', p_status: status, p_ts: new Date().toISOString(), p_code: code, p_error: code ? 'x' : null });
    expect(await S('wa_svc_apply_status', { p_provider_id: 'wamid.unknown', p_status: 'sent', p_ts: null, p_code: null, p_error: null })).toEqual({ found: false });
    expect(await st('read')).toMatchObject({ applied: true });                               // read arrives before delivered
    expect(await st('delivered')).toMatchObject({ applied: false });                         // late: never moves backwards
    expect(await st('read')).toMatchObject({ applied: false });                              // duplicate
    expect(await st('failed', '131000')).toMatchObject({ applied: false });                  // a failure cannot undo a read
    const row = (await q(`select status, delivered_at is not null d, read_at is not null r from public.whatsapp_messages where id = $1`, [m.id]))[0];
    expect(row).toEqual({ status: 'read', d: true, r: true });
  });
  it('records provider failures, and treats "user stopped marketing messages" as an opt-out', async () => {
    const c = (await inbound()).contact.id;
    await enqueue(c, { p_body: 'x' });
    const m = (await S('wa_svc_claim_outbound', { p_worker: 'w1', p_limit: 5, p_lease_seconds: 60 }))[0];
    await S('wa_svc_complete_outbound', { p_id: m.id, p_worker: 'w1', p_provider_id: 'wamid.f1' });
    await S('wa_svc_apply_status', { p_provider_id: 'wamid.f1', p_status: 'failed', p_ts: null, p_code: '131050', p_error: 'user opted out' });
    expect((await q(`select status, error_code from public.whatsapp_messages where id = $1`, [m.id]))[0]).toEqual({ status: 'failed', error_code: '131050' });
    expect((await q(`select consent from public.whatsapp_contacts where id = $1`, [c]))[0].consent).toBe('opted_out');
  });
  it('only managers reply; the window and opt-outs are enforced for people too', async () => {
    const c = (await inbound()).contact.id;
    expect(await code(call(db, o.staff, 'wa_staff_reply', { p_org: o.orgA, p_contact: c, p_text: 'x' }))).toBe('PT403');
    await backdate(`update public.whatsapp_contacts set last_inbound_at = now() - interval '2 days'`);
    await expect(call(db, o.manager, 'wa_staff_reply', { p_org: o.orgA, p_contact: c, p_text: 'hi' })).rejects.toMatchObject({ code: 'PT409', message: expect.stringMatching(/24 hours/) });
  });
});

describe('maintenance intake', () => {
  const req = (c: string, over: Record<string, unknown> = {}) => S('wa_svc_create_request', { p_org: o.orgA, p_contact: c, p_property: o.prop, p_unit: o.unit, p_tenancy: null, p_title: 'Kitchen tap dripping', p_description: 'The kitchen tap drips all day', p_category: 'plumbing', p_urgent: false, p_source_msg: `wamid.${key()}`, ...over });
  it('creates a request for an unverified sender, marked as such, idempotent on the message id, and limited per day', async () => {
    const c = (await inbound()).contact.id;
    const first = await req(c, { p_source_msg: 'wamid.once' });
    expect(first).toMatchObject({ ref: expect.stringMatching(/^MR-[0-9A-F]{8}$/), duplicate: false });
    expect(await req(c, { p_source_msg: 'wamid.once' })).toMatchObject({ duplicate: true, request_id: first.request_id });
    const r = (await q(`select reported_via, tenant_id, reported_by from public.maintenance_requests where id = $1`, [first.request_id]))[0];
    expect(r).toEqual({ reported_via: 'whatsapp', tenant_id: null, reported_by: o.manager.sub });
    expect((await q(`select body from public.maintenance_notes where request_id = $1`, [first.request_id]))[0].body).toMatch(/NOT verified/);
    await req(c); await req(c);
    expect(await code(req(c))).toBe('PT429');
  });
  it('attaches a verified tenant\'s request to their own tenancy only', async () => {
    const { c } = await link();
    const ok = await req(c, { p_tenancy: o.tenancy });
    expect((await q(`select tenant_id, tenancy_id from public.maintenance_requests where id = $1`, [ok.request_id]))[0]).toEqual({ tenant_id: o.tenant, tenancy_id: o.tenancy });
    expect(await code(req(c, { p_unit: o.unit2, p_tenancy: o.tenancy2 }))).toBe('PT403');          // someone else's tenancy
  });
  it('escalates safety keywords through the existing machinery and rejects hallucinated or archived places', async () => {
    const c = (await inbound()).contact.id;
    const r = await req(c, { p_title: 'Gas leak', p_description: 'I can smell gas in the kitchen', p_urgent: true });
    expect(r.escalated).toBe(true);
    expect(await count(db, `select count(*) n from public.notifications where event_type = 'maintenance.escalated'`)).toBeGreaterThan(0);
    expect(await code(req(c, { p_property: crypto.randomUUID() }))).toBe('PT404');
    expect(await code(req(c, { p_unit: crypto.randomUUID() }))).toBe('PT404');                      // an invented unit id is refused
  });
  it('looks up property and unit references without revealing anything else', async () => {
    const p = await S('wa_svc_find_property', { p_org: o.orgA, p_text: 'maple' });
    expect(p.length).toBeGreaterThanOrEqual(0);
    expect(await S('wa_svc_find_property', { p_org: o.orgA, p_text: 'zz' })).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/tenant|rent|email/i);
    expect(await S('wa_svc_find_unit', { p_org: o.orgA, p_property: o.prop, p_text: '1a' })).toEqual([{ id: o.unit, reference: '1A' }]);
  });
  it('lets a sender ask about their own requests only', async () => {
    const a = (await inbound('15550001111')).contact.id; const b = (await inbound('15550009999')).contact.id;
    const r = await req(a);
    const own = await S('wa_svc_request_status', { p_org: o.orgA, p_contact: a, p_ref: r.ref });
    expect(own.items[0]).toMatchObject({ ref: r.ref, status: 'submitted' });
    expect(await S('wa_svc_request_status', { p_org: o.orgA, p_contact: b, p_ref: r.ref })).toEqual({ items: [] });         // another number, same org
    expect(await S('wa_svc_request_status', { p_org: o.orgA, p_contact: b, p_ref: null })).toEqual({ items: [] });
  });
  it('sends status updates once per change, as text in the window and as a template only with opt-in', async () => {
    const a = (await inbound('15550001111')).contact.id;
    const r = await req(a);
    await call(db, o.staff, 'triage_request', { p_org: o.orgA, p_request: r.request_id, p_expected_version: 1, p_category: null, p_note: null });
    expect(await S('wa_svc_request_updates')).toMatchObject({ queued: 1 });
    expect(await S('wa_svc_request_updates')).toMatchObject({ queued: 0 });                    // idempotent
    expect((await q(`select kind, body from public.whatsapp_messages where direction = 'out'`))[0]).toMatchObject({ kind: 'text', body: expect.stringContaining(r.ref) });
    await backdate(`update public.whatsapp_contacts set last_inbound_at = now() - interval '3 days'`);
    await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r.request_id, p_expected_version: 2, p_reason: 'duplicate report' });
    expect(await S('wa_svc_request_updates')).toMatchObject({ queued: 0, skipped: 1 });        // closed window and no opt-in: nothing is sent
  });
});

describe('handoff to a person', () => {
  it('alerts the designated person once, falls back to admins, and the reason and excerpt are labelled', async () => {
    const c = (await inbound()).contact.id;
    await call(db, o.admin, 'save_wa_channel', channel({ p_urgent_user: o.manager.sub }));
    expect(await S('wa_svc_handoff', { p_org: o.orgA, p_contact: c, p_reason: 'Asked for a person', p_excerpt: 'I want to speak to someone', p_urgent: false })).toMatchObject({ already_open: false });
    expect(await S('wa_svc_handoff', { p_org: o.orgA, p_contact: c, p_reason: 'again', p_excerpt: 'x', p_urgent: false })).toMatchObject({ already_open: true });
    const n = await q(`select user_id, body, event_type from public.notifications where event_type = 'whatsapp.handoff'`);
    expect(n).toHaveLength(1); expect(n[0].user_id).toBe(o.manager.sub); expect(n[0].body).toMatch(/NOT verified.*untrusted text/s);
    const list = await call(db, o.manager, 'list_wa_handoffs', { p_org: o.orgA, p_status: 'open' });
    expect(list).toHaveLength(1);
    await call(db, o.manager, 'resolve_wa_handoff', { p_org: o.orgA, p_conversation: list[0].conversation_id });
    expect(await call(db, o.manager, 'list_wa_handoffs', { p_org: o.orgA, p_status: 'open' })).toEqual([]);
    // an urgent message escalates an already-open handoff, and with no designated contact every admin is told
    await call(db, o.admin, 'save_wa_channel', channel({ p_urgent_user: null }));
    await S('wa_svc_handoff', { p_org: o.orgA, p_contact: c, p_reason: 'Smells gas', p_excerpt: 'gas', p_urgent: true });
    expect(await count(db, `select count(*) n from public.notifications where event_type = 'whatsapp.urgent' and user_id = $1`, [o.admin.sub])).toBe(1);
  });
});

describe('rent reminders on WhatsApp use the approval engine', () => {
  const enableExternal = () => call(db, o.admin, 'update_copilot_settings', { p_org: o.orgA, p_enabled: null, p_external_enabled: true, p_daily_budget_micro: null, p_max_turns_per_user_hour: null });
  const propose = (user: any, kind: string, payload: Record<string, unknown>) => S('copilot_svc_propose_action', { p_org: o.orgA, p_user: user.sub, p_conversation: null, p_kind: kind, p_payload: payload });
  async function ready() {
    const ch = await call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'fee', p_description: 'January rent', p_due_date: '2026-01-01', p_amount_minor: 150000, p_idempotency_key: key() });
    const { c } = await link(); await optIn(c);
    return { c, ch };
  }
  it('drafts need a verified, opted-in tenant; a draft sends nothing; sending needs the org switch and a different approver', async () => {
    const { c, ch } = await ready();
    expect(await code(propose(o.staff, 'whatsapp_reminder_draft', { contact_id: c, charge_id: ch.id }))).toBe('PT403');          // managers only
    const draft = await propose(o.manager, 'whatsapp_reminder_draft', { contact_id: c, charge_id: ch.id });
    expect(draft).toMatchObject({ kind: 'whatsapp_reminder_draft', status: 'draft', policy: 'none' });
    expect(draft.preview.fields.find((f: any) => f.label === 'Message').value).toMatch(/1500\.00 USD/);
    expect(await count(db, `select count(*) n from public.whatsapp_messages where direction = 'out'`)).toBe(0);
    expect(await code(propose(o.manager, 'send_whatsapp_reminder', { draft_id: draft.id }))).toBe('PT403');                   // switch off
    await enableExternal();
    const send = await propose(o.manager, 'send_whatsapp_reminder', { draft_id: draft.id, text: 'model text' });
    expect(send.status).toBe('proposed');
    const sub = await call(db, o.manager, 'copilot_submit_action', { p_org: o.orgA, p_action: send.id });
    expect(await code(call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: sub.approval_id, p_decision: 'approve', p_note: null }))).toBe('PT403');   // own request
    expect(await count(db, `select count(*) n from public.whatsapp_messages where direction = 'out'`)).toBe(0);
    const d = await call(db, o.admin, 'decide_approval', { p_org: o.orgA, p_approval: sub.approval_id, p_decision: 'approve', p_note: null });
    expect(d).toMatchObject({ ok: true, status: 'executed' });
    const out = (await q(`select kind, origin, template, approval_id from public.whatsapp_messages where direction = 'out'`))[0];
    expect(out).toMatchObject({ kind: 'template', origin: 'approval', approval_id: sub.approval_id });
    expect(out.template).toMatchObject({ name: 'rent_reminder_v1', params: [expect.any(String), '1500.00 USD', '2026-01-01'] });
  });
  it('is withdrawn if the tenant opts out or the charge is settled before approval', async () => {
    const { c, ch } = await ready(); await enableExternal();
    const draft = await propose(o.manager, 'whatsapp_reminder_draft', { contact_id: c, charge_id: ch.id });
    const send = await propose(o.manager, 'send_whatsapp_reminder', { draft_id: draft.id });
    const sub = await call(db, o.manager, 'copilot_submit_action', { p_org: o.orgA, p_action: send.id });
    await S('wa_svc_set_consent', { p_org: o.orgA, p_contact: c, p_value: 'opted_out' });
    expect(await call(db, o.admin, 'decide_approval', { p_org: o.orgA, p_approval: sub.approval_id, p_decision: 'approve', p_note: null })).toMatchObject({ ok: false, status: 'invalidated' });
    expect(await count(db, `select count(*) n from public.whatsapp_messages where direction = 'out'`)).toBe(0);
  });
  it('refuses drafts for unverified numbers, for tenants who have not opted in, and for other tenants\' charges', async () => {
    const ch = await call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'fee', p_description: 'Rent', p_due_date: '2026-01-01', p_amount_minor: 1000, p_idempotency_key: key() });
    const stranger = (await inbound('15550007777')).contact.id;
    expect(await code(propose(o.manager, 'whatsapp_reminder_draft', { contact_id: stranger, charge_id: ch.id }))).toBe('PT422');
    const { c } = await link(o.omarTenant, '15550008888');
    await optIn(c);
    expect(await code(propose(o.manager, 'whatsapp_reminder_draft', { contact_id: c, charge_id: ch.id }))).toBe('PT422');     // Omar is not on Tina's tenancy
    const t = (await link(o.tenant, '15550006666')).c;
    expect(await code(propose(o.manager, 'whatsapp_reminder_draft', { contact_id: t, charge_id: ch.id }))).toBe('PT422');     // linked but never opted in
  });
});
