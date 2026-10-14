import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, code } from '../support/db.js';
import { paymentArgs } from '../support/fixtures.js';
import { addDays, count, freshOps, key, reqArgs, svc, today, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
beforeEach(async () => { ({ db, o } = await freshOps()); });
afterEach(async () => { await db.close(); });

const mk = (over: Record<string, unknown> = {}) => call(db, o.staff, 'create_maintenance_request', reqArgs(o, over));
const claim = (worker = 'w1', limit = 10) => call(db, svc, 'claim_emails', { p_worker: worker, p_limit: limit, p_lease_seconds: 120 });
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);
const row = async (id: string) => (await q(`select * from public.email_queue where id = $1`, [id]))[0];
const manualCharge = (due: string, amount = 150000, over: Record<string, unknown> = {}) => call(db, o.manager, 'create_charge',
  { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'rent', p_description: `Rent due ${due}`, p_due_date: due, p_amount_minor: amount, p_idempotency_key: key(), ...over });
const jobs = (actor: any = o.manager) => call(db, actor, 'run_org_jobs', { p_org: o.orgA });
const rentMails = () => q(`select * from public.email_queue where event_type = 'reminder.rent_due' order by created_at`);

describe('email queue: delivery states, retries and failure visibility', () => {
  beforeEach(async () => { await mk(); });         // queues an email to each manager+ (manager, admin, owner)

  it('claims a batch exactly once, and only the service role can', async () => {
    expect(await code(call(db, o.manager, 'claim_emails', { p_worker: 'x', p_limit: 5, p_lease_seconds: 60 }))).toBe('42501');
    expect(await code(call(db, null as any, 'claim_emails', { p_worker: 'x', p_limit: 5, p_lease_seconds: 60 }))).toBe('42501');
    const first = await claim('w1');
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first[0]).toMatchObject({ attempts: 1, event_type: 'maintenance.submitted' });
    expect(await claim('w2')).toEqual([]);                                  // already leased to w1
    expect((await row(first[0].id))).toMatchObject({ status: 'sending', locked_by: 'w1', attempts: 1 });
  });

  it('marks sent only for the worker that claimed it, and is idempotent', async () => {
    const [e] = await claim('w1', 1);
    expect(await code(call(db, svc, 'complete_email', { p_id: e.id, p_worker: 'w2', p_provider_message_id: 'm1' }))).toBe('PT409');
    expect(await call(db, svc, 'complete_email', { p_id: e.id, p_worker: 'w1', p_provider_message_id: 'msg-123' })).toMatchObject({ status: 'sent', replayed: false });
    expect(await call(db, svc, 'complete_email', { p_id: e.id, p_worker: 'w1', p_provider_message_id: 'msg-123' })).toMatchObject({ replayed: true });
    expect(await row(e.id)).toMatchObject({ status: 'sent', provider_message_id: 'msg-123', locked_by: null });
    expect(await code(call(db, svc, 'fail_email', { p_id: e.id, p_worker: 'w1', p_error: 'late', p_permanent: false }))).toBe('PT409');   // a sent email can't be failed
  });

  it('retries with exponential backoff, then gives up (dead) after max attempts, keeping the last error', async () => {
    const [e] = await claim('w1', 1);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const out = await call(db, svc, 'fail_email', { p_id: e.id, p_worker: 'w1', p_error: `SMTP 451 try ${attempt}`, p_permanent: false });
      const r = await row(e.id);
      if (attempt < 5) {
        expect(out).toMatchObject({ status: 'failed', attempts: attempt });
        delays.push(Math.round((new Date(r.next_attempt_at).getTime() - Date.now()) / 1000));
        expect((await claim('w1')).map((x: any) => x.id)).not.toContain(e.id);            // not due yet
        await db.query(`update public.email_queue set next_attempt_at = now() - interval '1 second' where id = $1`, [e.id]);
        expect((await claim('w1')).map((x: any) => x.id)).toContain(e.id);
      } else {
        expect(out).toMatchObject({ status: 'dead', attempts: 5 });
        expect(r).toMatchObject({ status: 'dead', last_error: 'SMTP 451 try 5' });
      }
    }
    expect(delays[0]).toBeGreaterThanOrEqual(25); expect(delays[0]).toBeLessThanOrEqual(31);
    expect(delays[1]).toBeGreaterThanOrEqual(55); expect(delays[1]).toBeLessThanOrEqual(61);
    expect(delays[2]).toBeGreaterThanOrEqual(115);
    await db.query(`update public.email_queue set next_attempt_at = now() - interval '1 hour' where id = $1`, [e.id]);
    expect((await claim('w1')).map((x: any) => x.id)).not.toContain(e.id);                 // dead emails are never retried automatically
  });

  it('permanent failures (e.g. an invalid address) go straight to dead', async () => {
    const [e] = await claim('w1', 1);
    expect(await call(db, svc, 'fail_email', { p_id: e.id, p_worker: 'w1', p_error: 'mailbox does not exist', p_permanent: true })).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('a crashed worker\'s lease expires and the email is picked up again (counted as an attempt)', async () => {
    const [e] = await claim('crashed', 1);
    expect(await claim('w2')).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: e.id })]));
    await db.query(`update public.email_queue set locked_until = now() - interval '1 second' where id = $1`, [e.id]);
    const again = await claim('w2');
    expect(again.find((x: any) => x.id === e.id)).toMatchObject({ attempts: 2 });
    expect(await code(call(db, svc, 'complete_email', { p_id: e.id, p_worker: 'crashed', p_provider_message_id: 'x' }))).toBe('PT409');
  });

  it('managers can see failures and requeue them; nobody else can', async () => {
    const [e] = await claim('w1', 1);
    await call(db, svc, 'fail_email', { p_id: e.id, p_worker: 'w1', p_error: 'provider 503', p_permanent: true });
    const list = await call(db, o.manager, 'list_email_queue', { p_org: o.orgA, p_status: 'dead' });
    expect(list.counts.dead).toBe(1);
    expect(list.items[0]).toMatchObject({ id: e.id, status: 'dead', last_error: 'provider 503', attempts: 1 });
    expect(list.items[0]).not.toHaveProperty('body_text');
    expect(await code(call(db, o.staff, 'list_email_queue', { p_org: o.orgA }))).toBe('PT403');
    expect(await code(call(db, o.outsider, 'list_email_queue', { p_org: o.orgA }))).toBe('PT404');
    expect(await code(call(db, o.staff, 'requeue_email', { p_org: o.orgA, p_email: e.id }))).toBe('PT403');
    expect(await code(call(db, o.outsider, 'requeue_email', { p_org: o.orgB, p_email: e.id }))).toBe('PT404');
    expect(await call(db, o.manager, 'requeue_email', { p_org: o.orgA, p_email: e.id })).toMatchObject({ status: 'queued' });
    expect(await row(e.id)).toMatchObject({ status: 'queued', attempts: 0, requeued_count: 1, last_error: null });
    expect((await claim('w1', 50)).map((x: any) => x.id)).toContain(e.id);
    expect(await code(call(db, o.manager, 'requeue_email', { p_org: o.orgA, p_email: e.id }))).toBe('PT409');                              // sending, not failed
    expect((await q(`select count(*)::int n from public.email_queue where org_id = $1`, [o.orgB]))[0].n).toBe(0);
  });

  it('never sends the same logical email twice, however often the event fires', async () => {
    const before = await count(db, `select count(*) n from public.email_queue`);
    const r = await mk({ p_title: 'Second' });
    const afterOne = await count(db, `select count(*) n from public.email_queue`);
    expect(afterOne).toBeGreaterThan(before);
    await db.query(`select app.notify_role($1, 'manager', 'maintenance.submitted', 't', 'b', null, $2, $3)`, [o.orgA, `mr:${r.id}:submitted`, o.staff.sub]);   // same dedupe key again
    expect(await count(db, `select count(*) n from public.email_queue`)).toBe(afterOne);
    expect(await code(db.query(`insert into public.email_queue (org_id, recipient_email, event_type, subject, body_text, dedupe_key) select org_id, recipient_email, event_type, subject, body_text, dedupe_key from public.email_queue limit 1`))).toBe('23505');
  });
});

describe('preferences', () => {
  it('opt-outs apply per event and channel; mandatory alerts cannot be disabled', async () => {
    const prefs = await call(db, o.manager, 'get_my_notification_prefs', { p_org: o.orgA });
    expect(prefs.find((p: any) => p.event_type === 'maintenance.escalated')).toMatchObject({ mandatory: true, email: true, in_app: true });
    expect(prefs.find((p: any) => p.event_type === 'maintenance.note')).toMatchObject({ mandatory: false, email: false, in_app: true });
    await call(db, o.manager, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'maintenance.submitted', p_email: false, p_in_app: true });
    await call(db, o.admin, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'maintenance.submitted', p_email: true, p_in_app: false });
    await mk();
    expect(await count(db, `select count(*) n from public.email_queue where recipient_email = 'manager@a.test'`)).toBe(0);
    expect(await count(db, `select count(*) n from public.notifications where user_id = $1`, [o.manager.sub])).toBe(1);
    expect(await count(db, `select count(*) n from public.email_queue where recipient_email = 'admin@a.test'`)).toBe(1);
    expect(await count(db, `select count(*) n from public.notifications where user_id = $1`, [o.admin.sub])).toBe(0);
    expect(await code(call(db, o.manager, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'approval.requested', p_email: true, p_in_app: true }).then(() => call(db, o.manager, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'nonsense', p_email: true, p_in_app: true })))).toBe('PT404');
    // preferences belong to the user: another user's settings are unaffected
    expect((await call(db, o.admin, 'get_my_notification_prefs', { p_org: o.orgA })).find((p: any) => p.event_type === 'maintenance.submitted')).toMatchObject({ email: true, in_app: false });
  });
});

describe('scheduled rent-due reminders', () => {
  it('queues one reminder per charge, stage and tenant; reruns and overlaps never duplicate', async () => {
    const t = await today(db);
    await manualCharge(await addDays(db, t, 2));                       // due soon
    const first = await jobs();
    expect(first.rent_due_reminders.created).toBe(1);
    const [m] = await rentMails();
    expect(m).toMatchObject({ recipient_email: 'tina@mail.test', status: 'queued' });
    expect(m.subject).toBe(`Rent due soon: 1500.00 USD on ${await addDays(db, t, 2)}`);
    expect(m.body_text).toContain('Maple Court, unit 1A');
    for (let i = 0; i < 3; i++) expect((await jobs()).rent_due_reminders.created).toBe(0);
    expect((await call(db, svc, 'job_run_all', {}))[o.orgA].rent_due_reminders.created).toBe(0);
    expect((await rentMails())).toHaveLength(1);
  });

  it('sends distinct reminders for the "due" and "overdue" stages of other charges, and respects windows', async () => {
    const t = await today(db);
    await manualCharge(t); await manualCharge(await addDays(db, t, -5)); await manualCharge(await addDays(db, t, -40)); await manualCharge(await addDays(db, t, 10));
    const r = await jobs();
    expect(r.rent_due_reminders.created).toBe(2);                       // due today + overdue; the 40-days-old and 10-days-ahead ones are outside the window
    const subjects = (await rentMails()).map((m: any) => m.subject).sort();
    expect(subjects).toEqual(['Rent due: 1500.00 USD', 'Rent overdue: 1500.00 USD']);
  });

  it('skips paid, voided, opted-out, email-less, non-active and other-organization cases', async () => {
    const t = await today(db);
    const paid = await manualCharge(t); const voided = await manualCharge(t, 150000, { p_description: 'to void' });
    const p = await call(db, o.staff, 'record_payment', paymentArgs(o.orgA, o.tenancy, { p_received_on: await addDays(db, t, -1) }));
    await call(db, o.staff, 'allocate_payment', { p_org: o.orgA, p_payment: p.id, p_allocations: [{ charge_id: paid.id, amount_minor: 150000 }], p_idempotency_key: key() });
    await call(db, o.manager, 'void_charge', { p_org: o.orgA, p_charge: voided.id, p_reason: 'billed in error' });
    expect((await jobs()).rent_due_reminders.created).toBe(0);
    await manualCharge(t, 99900, { p_description: 'live' });
    await call(db, o.staff, 'set_tenant_reminders', { p_org: o.orgA, p_tenant: o.tenant, p_opt_out: true });
    expect((await jobs()).rent_due_reminders.created).toBe(0);
    await call(db, o.staff, 'set_tenant_reminders', { p_org: o.orgA, p_tenant: o.tenant, p_opt_out: false });
    expect((await jobs()).rent_due_reminders.created).toBe(1);
    expect((await call(db, o.outsider, 'run_org_jobs', { p_org: o.orgB })).rent_due_reminders.created).toBe(0);
    expect(await code(call(db, o.staff, 'set_tenant_reminders', { p_org: o.orgA, p_tenant: o.tenant, p_opt_out: true }).then(() => call(db, o.viewer, 'set_tenant_reminders', { p_org: o.orgA, p_tenant: o.tenant, p_opt_out: true })))).toBe('PT403');
  });

  it('reminds every tenant on the tenancy who has an email, each once', async () => {
    const t = await today(db);
    const co = (await call(db, o.staff, 'create_tenant', { p_org: o.orgA, p_full_name: 'Cory Co', p_email: 'cory@mail.test', p_phone: null, p_emergency_name: null, p_emergency_phone: null, p_notes: null })).id;
    await call(db, o.staff, 'add_tenancy_tenant', { p_org: o.orgA, p_tenancy: o.tenancy, p_tenant: co, p_is_primary: false });
    const noMail = (await call(db, o.staff, 'create_tenant', { p_org: o.orgA, p_full_name: 'No Mail', p_email: null, p_phone: null, p_emergency_name: null, p_emergency_phone: null, p_notes: null })).id;
    await call(db, o.staff, 'add_tenancy_tenant', { p_org: o.orgA, p_tenancy: o.tenancy, p_tenant: noMail, p_is_primary: false });
    await manualCharge(t);
    expect((await jobs()).rent_due_reminders.created).toBe(2);
    expect((await rentMails()).map((m: any) => m.recipient_email).sort()).toEqual(['cory@mail.test', 'tina@mail.test']);
  });

  it('formats amounts exactly for any currency precision', async () => {
    expect((await q(`select app.money_text(150000, 'USD') a, app.money_text(5, 'USD') b, app.money_text(1500, 'JPY') c, app.money_text(1234567, 'KWD') d, app.money_text(-250, 'EUR') e`))[0])
      .toEqual({ a: '1500.00', b: '0.05', c: '1500', d: '1234.567', e: '-2.50' });
  });
});

describe('scheduled lease-expiry reminders', () => {
  const setEnd = async (end: string | null) => {
    const t = await call(db, o.manager, 'get_tenancy', { p_org: o.orgA, p_tenancy: o.tenancy });
    return call(db, o.manager, 'update_tenancy', { p_org: o.orgA, p_tenancy: o.tenancy, p_expected_version: t.version, p_start_date: '2026-01-01', p_end_date: end, p_rent_amount_minor: 150000,
      p_rent_period: 'monthly', p_rent_due_day: 1, p_deposit_amount_minor: 0, p_deposit_scheme: null, p_notice_days: null, p_notes: null });
  };
  const lease = () => count(db, `select count(*) n from public.notifications where event_type = 'reminder.lease_expiry'`);

  it('alerts managers once per threshold; shrinking windows and re-dated leases re-arm; reruns are silent', async () => {
    const t = await today(db);
    await setEnd(await addDays(db, t, 90));
    expect((await jobs()).lease_expiry_reminders.created).toBe(0);                      // beyond the 60-day horizon
    await setEnd(await addDays(db, t, 45));
    expect((await jobs()).lease_expiry_reminders.created).toBe(3);                      // stage 60 → manager, admin, owner
    expect((await jobs()).lease_expiry_reminders.created).toBe(0);
    await setEnd(await addDays(db, t, 20));                                             // a later run with fewer days left → ONE stage (30), not all
    expect((await jobs()).lease_expiry_reminders.created).toBe(3);
    expect((await jobs()).lease_expiry_reminders.created).toBe(0);
    await setEnd(await addDays(db, t, 5));
    expect((await jobs()).lease_expiry_reminders.created).toBe(3);                      // stage 7
    const titles = (await q(`select title from public.notifications where event_type = 'reminder.lease_expiry' and user_id = $1 order by created_at`, [o.manager.sub])).map((r) => r.title);
    expect(titles[0]).toMatch(/^Lease ending in 45 days: Maple Court · 1A$/);
    expect(titles).toHaveLength(3);
    expect(await lease()).toBe(9);
    await setEnd(await addDays(db, t, 6 + 30));                                          // lease extended to a NEW end date → fresh reminders
    expect((await jobs()).lease_expiry_reminders.created).toBe(3);
  });

  it('ignores open-ended, expired and non-active tenancies, and honours notification preferences', async () => {
    const t = await today(db);
    expect((await jobs()).lease_expiry_reminders.created).toBe(0);                      // open-ended
    await setEnd(await addDays(db, t, 10));
    await call(db, o.admin, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'reminder.lease_expiry', p_email: false, p_in_app: false });
    expect((await jobs()).lease_expiry_reminders.created).toBe(2);                      // admin opted out
    expect(await code(call(db, o.staff, 'run_org_jobs', { p_org: o.orgA }))).toBe('PT403');
  });
});

describe('job runner', () => {
  it('records each run, is service-role-only across organizations, and every rerun is a no-op', async () => {
    const t = await today(db);
    await manualCharge(await addDays(db, t, 1));
    expect(await code(call(db, o.owner, 'job_run_all', {}))).toBe('42501');
    expect(await code(call(db, null as any, 'job_run_all', {}))).toBe('42501');
    const run1 = await call(db, svc, 'job_run_all', {});
    expect(Object.keys(run1).sort()).toEqual([o.orgA, o.orgB].sort());
    expect(run1[o.orgA].rent_due_reminders.created).toBe(1);
    expect(run1[o.orgB].rent_due_reminders.created).toBe(0);
    const run2 = await call(db, svc, 'job_run_all', {});
    expect(Object.values(run2[o.orgA]).every((j: any) => j.created === 0)).toBe(true);
    const runs = await call(db, o.manager, 'list_job_runs', { p_org: o.orgA });
    expect(runs.filter((r: any) => r.job === 'rent_due_reminders').map((r: any) => [r.status, r.created_count])).toEqual([['ok', 0], ['ok', 1]]);
    expect(await code(call(db, o.staff, 'list_job_runs', { p_org: o.orgA }))).toBe('PT403');
    expect(await code(call(db, o.outsider, 'list_job_runs', { p_org: o.orgA }))).toBe('PT404');
    expect(await rentMailCount()).toBe(1);
  });
  const rentMailCount = () => count(db, `select count(*) n from public.email_queue where event_type = 'reminder.rent_due'`);
});
