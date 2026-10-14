import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, call, code } from '../support/db.js';
import { count, freshOps, key, svc, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
beforeEach(async () => { ({ db, o } = await freshOps()); });
afterEach(async () => { await db.close(); });

const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);
const propose = (kind: string, payload: Record<string, unknown>, user = o.staff, conv: string | null = null) =>
  call(db, svc, 'copilot_svc_propose_action', { p_org: o.orgA, p_user: user.sub, p_conversation: conv, p_kind: kind, p_payload: payload });
const charge = (amount = 150000, due = '2026-01-01') => call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'fee', p_description: 'January rent', p_due_date: due, p_amount_minor: amount, p_idempotency_key: key() });
const enableExternal = () => call(db, o.admin, 'update_copilot_settings', { p_org: o.orgA, p_enabled: null, p_external_enabled: true, p_daily_budget_micro: null, p_max_turns_per_user_hour: null });

describe('read functions', () => {
  it('overdue rent is exact, per currency, scoped, with record refs and a stated basis', async () => {
    await charge(150000, '2026-01-01');
    const r = await call(db, o.staff, 'copilot_overdue_rent', { p_org: o.orgA, p_property: null, p_min_days: 1, p_limit: 25 });
    expect(r.totals_by_currency).toEqual([{ currency: 'USD', overdue_minor: 150000, tenancies: 1 }]);
    expect(r.items[0]).toMatchObject({ tenancy_id: o.tenancy, overdue_minor: 150000, can_email: true });
    expect(r.basis).toMatch(/NOT netted/);
    expect(r.record_refs[0]).toMatchObject({ type: 'tenancy', id: o.tenancy });
    expect(r.as_of).toBeTruthy();
  });
  it('every read refuses viewers and outsiders', async () => {
    for (const fn of ['copilot_portfolio_summary', 'copilot_overdue_rent', 'copilot_maintenance_requests', 'copilot_lease_expiries', 'copilot_rent_collection_summary']) {
      expect(await code(call(db, o.viewer, fn, { p_org: o.orgA })), fn).toBe('PT403');
      expect(await code(call(db, o.outsider, fn, { p_org: o.orgA })), fn).toMatch(/PT40[34]/);
    }
    expect(await code(call(db, o.staff, 'copilot_tenant_record', { p_org: o.orgA, p_tenant: crypto.randomUUID() }))).toBe('PT404');
  });
  it('portfolio, tenants, maintenance, expiries and collection all answer', async () => {
    expect((await call(db, o.staff, 'copilot_portfolio_summary', { p_org: o.orgA })).properties).toBe(1);
    const f = await call(db, o.staff, 'copilot_find_tenants', { p_org: o.orgA, p_query: 'Tina' });
    expect(f.items.length).toBeGreaterThanOrEqual(0);
    const t = await call(db, o.staff, 'copilot_tenant_record', { p_org: o.orgA, p_tenant: o.tenant });
    expect(t.tenant.id).toBe(o.tenant);
    expect((await call(db, o.staff, 'copilot_maintenance_requests', { p_org: o.orgA })).total).toBe(0);
    expect((await call(db, o.staff, 'copilot_lease_expiries', { p_org: o.orgA, p_within_days: 60 })).items).toEqual([]);
    expect((await call(db, o.staff, 'copilot_rent_collection_summary', { p_org: o.orgA })).scope.period_defaulted).toBe(true);
  });
  it('another organization\'s tenant and property are invisible', async () => {
    expect(await code(call(db, o.outsider, 'copilot_tenant_record', { p_org: o.orgB, p_tenant: o.tenant }))).toBe('PT404');
    expect(await code(call(db, o.staff, 'copilot_overdue_rent', { p_org: o.orgA, p_property: crypto.randomUUID() }))).toBe('PT404');
  });
});

describe('service-only writes', () => {
  it('signed-in users cannot call the service functions, and cannot forge audit rows', async () => {
    for (const fn of ['copilot_svc_context', 'copilot_svc_budget']) {
      expect(await code(call(db, o.manager, fn, fn === 'copilot_svc_budget' ? { p_org: o.orgA } : { p_org: o.orgA, p_user: o.manager.sub })), fn).toMatch(/42501|permission/);
    }
    expect(await code(propose('test_action', { note: 'xyz' }, o.staff).then(() => as(db, o.staff, (qq) => qq(`insert into public.copilot_tool_calls (org_id, user_id, request_id, call_id, tool, kind, args, status) values ($1,$2,'r','c','t','read','{}','ok')`, [o.orgA, o.staff.sub]))))).toMatch(/42501|permission/);
    expect(await code(as(db, o.staff, (qq) => qq(`insert into public.copilot_actions (org_id, user_id, kind, policy, payload, payload_hash, preview) values ($1,$2,'test_action','none','{}','h','{}')`, [o.orgA, o.staff.sub])))).toMatch(/42501|permission/);
  });
  it('turn lifecycle: lease, hourly limit, budget, cancellation, append-only history', async () => {
    const c = await call(db, o.staff, 'create_copilot_conversation', { p_org: o.orgA });
    const begin = () => call(db, svc, 'copilot_svc_begin_turn', { p_org: o.orgA, p_user: o.staff.sub, p_conversation: c.id, p_request_id: 'r1' });
    expect((await begin()).external_enabled).toBe(false);
    expect(await code(begin())).toBe('PT409');                                          // already running
    expect((await call(db, o.staff, 'copilot_cancel_turn', { p_org: o.orgA, p_conversation: c.id })).requested).toBe(true);
    expect(await call(db, svc, 'copilot_svc_turn_cancelled', { p_org: o.orgA, p_conversation: c.id })).toBe(true);
    await call(db, svc, 'copilot_svc_end_turn', { p_org: o.orgA, p_conversation: c.id });
    await call(db, svc, 'copilot_svc_append_message', { p_org: o.orgA, p_user: o.staff.sub, p_conversation: c.id, p_role: 'user', p_content: 'Who is overdue?', p_blocks: null, p_request_id: 'r1', p_model: null, p_input: 0, p_output: 0, p_cost: 0, p_status: 'ok' });
    expect((await call(db, o.staff, 'get_copilot_conversation', { p_org: o.orgA, p_conversation: c.id })).title).toBe('Who is overdue?');
    await expect(db.exec(`update public.copilot_messages set content = 'edited'`)).rejects.toThrow();
    await expect(db.exec(`delete from public.copilot_messages`)).rejects.toThrow();
    // budget
    await call(db, svc, 'copilot_svc_record_usage', { p_org: o.orgA, p_input: 10, p_output: 10, p_cost: 999999999, p_turn: true });
    expect(await code(begin())).toBe('PT402');
    // hourly limit
    await call(db, o.admin, 'update_copilot_settings', { p_org: o.orgA, p_enabled: null, p_external_enabled: null, p_daily_budget_micro: 9999999999, p_max_turns_per_user_hour: 1 });
    expect(await code(begin())).toBe('PT429');
  });
  it('conversations are private to their owner', async () => {
    const c = await call(db, o.staff, 'create_copilot_conversation', { p_org: o.orgA });
    expect(await code(call(db, o.manager, 'get_copilot_conversation', { p_org: o.orgA, p_conversation: c.id }))).toBe('PT404');
    expect(await call(db, o.manager, 'list_copilot_conversations', { p_org: o.orgA })).toEqual([]);
    expect(await code(call(db, o.viewer, 'create_copilot_conversation', { p_org: o.orgA }))).toBe('PT403');
    expect(await code(call(db, svc, 'copilot_svc_begin_turn', { p_org: o.orgA, p_user: o.manager.sub, p_conversation: c.id, p_request_id: 'r' }))).toBe('PT404');
  });
});

describe('actions', () => {
  it('maintenance request: needs the user\'s confirmation, executes once with their authority', async () => {
    const p = await propose('create_maintenance_request', { property_id: o.prop, unit_id: o.unit, title: 'Leaky tap', description: 'Kitchen tap drips', category: 'plumbing' });
    expect(p).toMatchObject({ policy: 'user_confirmation', status: 'proposed', duplicate: false });
    expect((await propose('create_maintenance_request', { property_id: o.prop, unit_id: o.unit, title: 'Leaky tap', description: 'Kitchen tap drips', category: 'plumbing' })).duplicate).toBe(true);
    expect(await code(call(db, o.manager, 'copilot_confirm_action', { p_org: o.orgA, p_action: p.id }))).toBe('PT404');   // not yours
    expect(await code(call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: p.id }))).toBe('PT409');        // wrong lane
    const done = await call(db, o.staff, 'copilot_confirm_action', { p_org: o.orgA, p_action: p.id });
    expect(done.status).toBe('executed');
    const again = await call(db, o.staff, 'copilot_confirm_action', { p_org: o.orgA, p_action: p.id });
    expect(again.replayed).toBe(true);
    expect(await count(db, `select count(*) n from public.maintenance_requests where title = 'Leaky tap'`)).toBe(1);
  });
  it('hallucinated and cross-org ids are rejected at proposal time', async () => {
    expect(await code(propose('create_maintenance_request', { property_id: crypto.randomUUID(), title: 'Leaky tap', description: 'x' }))).toBe('PT404');
    expect(await code(propose('rent_reminder_draft', { charge_id: crypto.randomUUID() }))).toBe('PT404');
    expect(await code(propose('tenant_message_draft', { tenant_id: crypto.randomUUID(), subject: 'Hello', body: 'Body text' }))).toBe('PT404');
    expect(await code(propose('drop_tables', {}))).toBe('PT422');
    expect(await code(call(db, svc, 'copilot_svc_propose_action', { p_org: o.orgA, p_user: o.outsider.sub, p_conversation: null, p_kind: 'test_action', p_payload: { note: 'abc' } }))).toBe('PT404');
  });
  it('full approval lifecycle with the harmless test action', async () => {
    const p = await call(db, o.staff, 'copilot_demo_action', { p_org: o.orgA, p_note: 'lifecycle check' });
    expect(p).toMatchObject({ kind: 'test_action', policy: 'human_approval', status: 'proposed' });
    expect(await code(call(db, o.manager, 'copilot_submit_action', { p_org: o.orgA, p_action: p.id }))).toBe('PT404');
    const s = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: p.id });
    expect(s).toMatchObject({ status: 'awaiting_approval' });
    expect((await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: p.id })).replayed).toBe(true);
    // the requester cannot approve their own request, and a staff member is not senior enough anyway
    expect(await code(call(db, o.staff, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: null }))).toBe('PT403');
    expect(await count(db, `select count(*) n from public.copilot_test_log`)).toBe(0);
    const d = await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: 'ok' });
    expect(d).toMatchObject({ ok: true, status: 'executed' });
    expect(await q(`select note, approved_by from public.copilot_test_log`)).toEqual([{ note: 'lifecycle check', approved_by: o.manager.sub }]);
    const list = await call(db, o.staff, 'list_copilot_actions', { p_org: o.orgA });
    expect(list[0]).toMatchObject({ status: 'executed', result: { logged: true } });
    // approving again executes nothing more
    await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: null });
    expect(await count(db, `select count(*) n from public.copilot_test_log`)).toBe(1);
  });
  it('rejection, cancellation and reuse of an approval for a different payload', async () => {
    const a = await call(db, o.staff, 'copilot_demo_action', { p_org: o.orgA, p_note: 'first note' });
    const sa = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: a.id });
    await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: sa.approval_id, p_decision: 'reject', p_note: 'no' });
    expect((await call(db, o.staff, 'list_copilot_actions', { p_org: o.orgA }))[0].status).toBe('rejected');
    expect(await count(db, `select count(*) n from public.copilot_test_log`)).toBe(0);
    // an approval cannot be created for a payload that differs from the stored proposal
    const b = await call(db, o.staff, 'copilot_demo_action', { p_org: o.orgA, p_note: 'second note' });
    expect(await code(call(db, o.staff, 'request_approval', { p_org: o.orgA, p_action: 'copilot.test_action', p_target: b.id, p_payload: { note: 'sneaky different note' }, p_note: null, p_expires_in_hours: 24 }))).toBe('PT422');
    // the payload of a stored proposal is immutable
    await expect(db.exec(`update public.copilot_actions set payload = '{"note":"changed"}'`)).rejects.toThrow();
    const sb = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: b.id });
    const c = await call(db, o.staff, 'copilot_cancel_action', { p_org: o.orgA, p_action: b.id, p_note: 'changed my mind' });
    expect(c.status).toBe('cancelled');
    expect((await q(`select status from public.approvals where id = $1`, [sb.approval_id]))[0].status).toBe('cancelled');
    expect(await code(call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: sb.approval_id, p_decision: 'approve', p_note: null }))).toBe('PT409');
  });
  it('cannot submit another user\'s proposal through the generic approval entry point', async () => {
    const a = await propose('test_action', { note: 'mine mine' }, o.staff);
    expect(await code(call(db, o.manager, 'request_approval', { p_org: o.orgA, p_action: 'copilot.test_action', p_target: a.id, p_payload: { note: 'mine mine' }, p_note: null, p_expires_in_hours: 24 }))).toBe('PT422');
  });
  it('external messages: drafts are inert, sending needs the org switch AND a manager, and the text is the draft\'s', async () => {
    const ch = await charge(150000, '2026-01-01');
    const draft = await propose('rent_reminder_draft', { charge_id: ch.id });
    expect(draft).toMatchObject({ kind: 'rent_reminder_draft', policy: 'none', status: 'draft' });
    expect(draft.preview.fields.find((f: any) => f.label === 'To').value).toContain('@');
    expect(await code(call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: draft.id }))).toBe('PT409');   // drafts are not sendable
    expect(await code(propose('send_rent_reminder', { draft_id: draft.id }))).toBe('PT403');                                  // switch is off
    await enableExternal();
    const send = await propose('send_rent_reminder', { draft_id: draft.id, body: 'ignored model-supplied text' });
    expect(send.preview.fields).toEqual(draft.preview.fields);
    const s = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: send.id });
    const before = await count(db, `select count(*) n from public.email_queue where event_type = 'reminder.rent_due'`);
    await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: null });
    expect(await count(db, `select count(*) n from public.email_queue where event_type = 'reminder.rent_due'`)).toBe(before + 1);
    const mail = (await q(`select body_text, subject from public.email_queue where event_type = 'reminder.rent_due' order by created_at desc limit 1`))[0];
    expect(mail.body_text).toBe(draft.preview.fields.find((f: any) => f.label === 'Message').value);
  });
  it('a send is withdrawn if the charge is settled or the tenant opts out before approval', async () => {
    await enableExternal();
    const ch = await charge(150000, '2026-01-01');
    const draft = await propose('rent_reminder_draft', { charge_id: ch.id });
    const send = await propose('send_rent_reminder', { draft_id: draft.id });
    const s = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: send.id });
    await call(db, o.manager, 'set_tenant_reminders', { p_org: o.orgA, p_tenant: o.tenant, p_opt_out: true });
    const d = await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: null });
    expect(d.ok).toBe(false);
    expect(await count(db, `select count(*) n from public.email_queue where subject like 'Rent reminder:%'`)).toBe(0);
  });
  it('turning external messaging off after submission stops the send', async () => {
    await enableExternal();
    const draft = await propose('tenant_message_draft', { tenant_id: o.tenant, subject: 'Parking notice', body: 'Please move your car by Friday.' });
    const send = await propose('send_tenant_message', { draft_id: draft.id });
    const s = await call(db, o.staff, 'copilot_submit_action', { p_org: o.orgA, p_action: send.id });
    await call(db, o.admin, 'update_copilot_settings', { p_org: o.orgA, p_enabled: null, p_external_enabled: false, p_daily_budget_micro: null, p_max_turns_per_user_hour: null });
    const d = await call(db, o.manager, 'decide_approval', { p_org: o.orgA, p_approval: s.approval_id, p_decision: 'approve', p_note: null });
    expect(d.ok).toBe(false);
    expect(await count(db, `select count(*) n from public.email_queue where event_type = 'tenant.message'`)).toBe(0);
  });
  it('only admins change settings; the flip is audited', async () => {
    expect(await code(call(db, o.manager, 'update_copilot_settings', { p_org: o.orgA, p_enabled: null, p_external_enabled: true, p_daily_budget_micro: null, p_max_turns_per_user_hour: null }))).toBe('PT403');
    await enableExternal();
    expect(await count(db, `select count(*) n from public.finance_audit where action = 'copilot.external_enabled'`)).toBe(1);
    expect((await call(db, o.staff, 'get_copilot_settings', { p_org: o.orgA })).external_enabled).toBe(true);
  });
});
