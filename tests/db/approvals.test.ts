import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, call, code } from '../support/db.js';
import { count, freshOps, key, reqArgs, settingsArgs, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
beforeEach(async () => { ({ db, o } = await freshOps()); });
afterEach(async () => { await db.close(); });

const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);
const getReq = (id: string) => call(db, o.staff, 'get_request', { p_org: o.orgA, p_request: id });
const unread = (user: string, event: string) => count(db, `select count(*) n from public.notifications where user_id = $1 and event_type = $2`, [user, event]);

/** A request with a work order assigned to staff, carrying an estimate that needs approval. */
async function pendingCost(amount = 80000, over: Record<string, unknown> = {}) {
  const r = await call(db, o.staff, 'create_maintenance_request', reqArgs(o, { p_title: `Boiler job ${amount}`, ...over }));
  const a = await call(db, o.staff, 'assign_work', { p_org: o.orgA, p_request: r.id, p_vendor: null, p_assignee: o.staff.sub, p_scope: 'Replace the boiler valve', p_estimate_minor: amount, p_estimate_note: 'quote #17' });
  const approval = a.work_orders[0].approval;
  return { r, wo: a.work_orders[0].id as string, approvalId: approval.id as string };
}
const decide = (id: string, decision: string, actor: any = o.manager, note: string | null = null) => call(db, actor, 'decide_approval', { p_org: o.orgA, p_approval: id, p_decision: decision, p_note: note });
const getA = (id: string, actor: any = o.manager) => call(db, actor, 'get_approval', { p_org: o.orgA, p_approval: id });
const statusOf = async (id: string) => (await q(`select status from public.approvals where id = $1`, [id]))[0].status;
const charge = (amount = 20000, due = '2026-01-01') => call(db, o.manager, 'create_charge', { p_org: o.orgA, p_tenancy: o.tenancy, p_kind: 'fee', p_description: 'Late fee', p_due_date: due, p_amount_minor: amount, p_idempotency_key: key() });
const voidProposal = (c: string, over: Record<string, unknown> = {}) => ({ p_org: o.orgA, p_action: 'finance.void_charge', p_target: c, p_payload: { charge_id: c, reason: 'Fee was charged in error' }, p_note: 'please check', p_expires_in_hours: 48, ...over });
/** Test-only: the append-only guard rightly blocks editing timestamps, so backdating needs the guard off for a moment. */
const raw = async (sql: string, params: unknown[] = []) => {
  await db.exec('alter table public.approvals disable trigger approvals_guard');
  try { await db.query(sql, params); } finally { await db.exec('alter table public.approvals enable trigger approvals_guard'); }
};
const events = async (id: string) => (await q(`select from_status, to_status from public.approval_events where approval_id = $1 order by id`, [id])).map((e) => `${e.from_status ?? '∅'}→${e.to_status}`);

describe('maintenance cost approval: the inbox flow', () => {
  it('an estimate needing sign-off waits in the inbox, and the request waits with it', async () => {
    const { r, wo, approvalId } = await pendingCost();
    expect(await statusOf(approvalId)).toBe('pending');
    expect((await getReq(r.id)).status).toBe('awaiting_approval');
    expect(await code(call(db, o.staff, 'start_work', { p_org: o.orgA, p_work_order: wo }))).toBe('PT409');          // cost not approved yet
    const inbox = await call(db, o.manager, 'list_approvals', { p_org: o.orgA, p_scope: 'inbox' });
    expect(inbox.pending_for_me).toBe(1);
    expect(inbox.items[0]).toMatchObject({ id: approvalId, status: 'pending', action_type: 'maintenance.approve_cost', requested_by: 'staff@a.test', can_decide: true, can_cancel: true });
    expect(inbox.items[0].payload).toMatchObject({ work_order_id: wo, amount_minor: 80000, currency: 'USD', request_id: r.id });
    expect(inbox.items[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inbox.items[0].execution_key).toBe(`approval:${approvalId}`);
    // who is told: approvers (not the requester)
    expect(await unread(o.manager.sub, 'approval.requested')).toBe(1);
    expect(await unread(o.admin.sub, 'approval.requested')).toBe(1);
    expect(await unread(o.owner.sub, 'approval.requested')).toBe(1);
    expect(await unread(o.staff.sub, 'approval.requested')).toBe(0);
    expect(await count(db, `select count(*) n from public.email_queue where recipient_email = 'manager@a.test' and event_type = 'approval.requested'`)).toBe(1);
  });

  it('approving authorizes and executes the action, notifies people, and unblocks the work', async () => {
    const { r, wo, approvalId } = await pendingCost();
    const out = await decide(approvalId, 'approve', o.manager, 'Fine, go ahead');
    expect(out).toMatchObject({ ok: true, status: 'executed', result: { work_order_id: wo, approved_cost_minor: 80000, currency: 'USD' } });
    const a = await getA(approvalId);
    expect(a).toMatchObject({ status: 'executed', decided_by: 'manager@a.test', decision_note: 'Fine, go ahead', execution_attempts: 1, can_decide: false });
    expect(a.executed_at).not.toBeNull();
    expect(a.events.map((e: any) => e.to_status)).toEqual(['pending', 'approved', 'executing', 'executed']);
    const req = await getReq(r.id);
    expect(req.status).toBe('assigned');
    expect(req.work_orders[0]).toMatchObject({ approved_cost_minor: 80000 });
    expect((await q(`select approved_by from public.work_orders where id = $1`, [wo]))[0].approved_by).toBe(o.manager.sub);
    await call(db, o.staff, 'start_work', { p_org: o.orgA, p_work_order: wo });
    expect((await getReq(r.id)).status).toBe('in_progress');
    expect(await unread(o.staff.sub, 'approval.decided')).toBe(1);                                                    // requester told
    expect(await unread(o.staff.sub, 'maintenance.status')).toBeGreaterThanOrEqual(1);                                  // assignee told they can start
  });

  it('repeating an approval is harmless: it executes once and replays the result', async () => {
    const { approvalId } = await pendingCost();
    await decide(approvalId, 'approve');
    const again = await decide(approvalId, 'approve', o.admin);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: approvalId })).toMatchObject({ ok: true, replayed: true });
    expect((await getA(approvalId)).execution_attempts).toBe(1);
    expect(await count(db, `select count(*) n from public.notifications where event_type = 'approval.decided' and dedupe_key = $1`, [`ap:${approvalId}:executed`])).toBe(1);
    expect(await code(decide(approvalId, 'reject'))).toBe('PT409');                                                    // too late to change your mind
  });

  it('rejecting records the decision and sends the request back to triage, with nothing executed', async () => {
    const { r, wo, approvalId } = await pendingCost();
    const out = await decide(approvalId, 'reject', o.manager, 'Too expensive; get another quote');
    expect(out.approval).toMatchObject({ status: 'rejected', decision_note: 'Too expensive; get another quote', execution_result: null });
    expect((await getReq(r.id)).status).toBe('triaged');
    expect((await q(`select approved_cost_minor from public.work_orders where id = $1`, [wo]))[0].approved_cost_minor).toBeNull();
    expect(await unread(o.staff.sub, 'approval.decided')).toBe(1);
    expect(await code(decide(approvalId, 'approve'))).toBe('PT409');
    expect(await decide(approvalId, 'reject')).toMatchObject({ ok: true, replayed: true });
    // a fresh estimate starts a fresh approval
    const next = await call(db, o.staff, 'submit_estimate', { p_org: o.orgA, p_work_order: wo, p_amount_minor: 60000, p_note: 'cheaper quote' });
    expect(next.work_orders[0].approval.id).not.toBe(approvalId);
    expect(next.work_orders[0].approval.status).toBe('pending');
  });

  it('estimates within the organization threshold are approved automatically; above it they are not', async () => {
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_approval_thresholds: { USD: 100000 } }));
    const small = await call(db, o.staff, 'create_maintenance_request', reqArgs(o, { p_title: 'Small job' }));
    const a = await call(db, o.staff, 'assign_work', { p_org: o.orgA, p_request: small.id, p_vendor: null, p_assignee: o.staff.sub, p_scope: 'Small fix', p_estimate_minor: 100000, p_estimate_note: null });
    expect(a).toMatchObject({ status: 'assigned' });
    expect(a.work_orders[0]).toMatchObject({ approved_cost_minor: 100000, approval: null });
    expect((await getReq(small.id)).notes.some((n: any) => /approved automatically/.test(n.body))).toBe(true);
    const big = await call(db, o.staff, 'create_maintenance_request', reqArgs(o, { p_title: 'Big job' }));
    const b = await call(db, o.staff, 'assign_work', { p_org: o.orgA, p_request: big.id, p_vendor: null, p_assignee: o.staff.sub, p_scope: 'Big fix', p_estimate_minor: 100001, p_estimate_note: null });
    expect(b.status).toBe('awaiting_approval');
    expect(b.work_orders[0]).toMatchObject({ approved_cost_minor: null, approval: { status: 'pending' } });
  });
});

describe('who may decide', () => {
  it('requires a senior enough role and a DIFFERENT person than the requester', async () => {
    const { approvalId } = await pendingCost();
    expect(await code(decide(approvalId, 'approve', o.staff))).toBe('PT403');
    expect(await code(decide(approvalId, 'approve', o.viewer))).toBe('PT403');
    expect(await code(decide(approvalId, 'approve', o.outsider))).toBe('PT404');
    expect(await code(call(db, o.tina, 'decide_approval', { p_org: o.orgA, p_approval: approvalId, p_decision: 'approve', p_note: null }))).toBe('PT404');
    expect(await code(decide(approvalId, 'maybe'))).toBe('PT422');
    // a manager who submitted the estimate cannot approve it themselves
    const r = await call(db, o.staff, 'create_maintenance_request', reqArgs(o, { p_title: 'Manager job' }));
    await call(db, o.manager, 'assign_work', { p_org: o.orgA, p_request: r.id, p_vendor: o.vendor, p_assignee: null, p_scope: 'Vendor job', p_estimate_minor: 50000, p_estimate_note: null });
    const mine = (await call(db, o.manager, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' })).items[0];
    expect(mine).toMatchObject({ requested_by: 'manager@a.test', can_decide: false });
    expect(await code(decide(mine.id, 'approve', o.manager))).toBe('PT403');
    expect((await call(db, o.manager, 'list_approvals', { p_org: o.orgA, p_scope: 'inbox' })).items.map((x: any) => x.id)).not.toContain(mine.id);   // not in their own inbox
    expect((await decide(mine.id, 'approve', o.admin)).status).toBe('executed');
  });

  it('self-approval can be switched on by an admin for small teams, and nothing else changes', async () => {
    const r = await call(db, o.staff, 'create_maintenance_request', reqArgs(o, { p_title: 'Solo job' }));
    await call(db, o.manager, 'assign_work', { p_org: o.orgA, p_request: r.id, p_vendor: o.vendor, p_assignee: null, p_scope: 'x', p_estimate_minor: 50000, p_estimate_note: null });
    const id = (await call(db, o.manager, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' })).items[0].id;
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_allow_self_approval: true }));
    expect((await getA(id)).can_decide).toBe(true);
    expect((await decide(id, 'approve', o.manager)).status).toBe('executed');
    expect(await code(decide(id, 'approve', o.staff))).not.toBe('NO_ERROR');                                           // staff still can't approve anything
  });

  it('the inbox and approval details are visible only to those entitled to them', async () => {
    const { approvalId } = await pendingCost();
    expect(await code(call(db, o.staff, 'list_approvals', { p_org: o.orgA, p_scope: 'inbox' }))).toBe('PT403');
    expect(await code(call(db, o.staff, 'list_approvals', { p_org: o.orgA, p_scope: 'all' }))).toBe('PT403');
    expect((await call(db, o.staff, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' })).total).toBe(1);
    expect((await getA(approvalId, o.staff)).id).toBe(approvalId);
    const other = await call(db, o.manager, 'request_approval', voidProposal((await charge()).id));
    expect(await code(getA(other.id, o.staff))).toBe('PT404');                                                         // someone else's request
    expect((await call(db, o.staff, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' })).total).toBe(1);
    expect((await as(db, o.staff, (q2) => q2('select id from public.approvals'))).rows).toHaveLength(1);                // RLS agrees
    expect((await as(db, o.manager, (q2) => q2('select id from public.approvals'))).rows).toHaveLength(2);
    expect(await code(call(db, o.outsider, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' }))).toBe('PT404');
    expect(await code(call(db, o.viewer, 'list_approvals', { p_org: o.orgA, p_scope: 'mine' }))).toBe('PT403');
    expect((await as(db, o.outsider, (q2) => q2('select * from public.approvals'))).rows).toEqual([]);
    expect((await as(db, o.tina, (q2) => q2('select * from public.approval_events'))).rows).toEqual([]);
  });
});

describe('invalidation: the proposal must not drift from what is approved', () => {
  it('a replaced estimate withdraws the old approval and requests a new one', async () => {
    const { wo, approvalId } = await pendingCost(80000);
    const next = await call(db, o.staff, 'submit_estimate', { p_org: o.orgA, p_work_order: wo, p_amount_minor: 95000, p_note: 'revised' });
    const newId = next.work_orders[0].approval.id;
    expect(newId).not.toBe(approvalId);
    expect(await statusOf(approvalId)).toBe('invalidated');
    expect((await getA(approvalId)).decision_note).toBe('estimate replaced');
    expect(await code(decide(approvalId, 'approve'))).toBe('PT409');                                                   // cannot approve the withdrawn proposal
    expect((await q(`select approved_cost_minor from public.work_orders where id = $1`, [wo]))[0].approved_cost_minor).toBeNull();
    expect((await decide(newId, 'approve')).result.approved_cost_minor).toBe(95000);                                    // the NEW amount is what gets approved
    expect(await unread(o.staff.sub, 'approval.decided')).toBeGreaterThanOrEqual(2);                                    // told about the withdrawal and the result
  });

  it('cancelling the work order or the request withdraws any open approval', async () => {
    const a = await pendingCost(80000);
    await call(db, o.manager, 'cancel_work_order', { p_org: o.orgA, p_work_order: a.wo, p_reason: 'wrong contractor' });
    expect(await statusOf(a.approvalId)).toBe('invalidated');
    expect((await getReq(a.r.id)).status).toBe('triaged');
    const b = await pendingCost(70000, { p_title: 'Another' });
    await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: b.r.id, p_expected_version: (await getReq(b.r.id)).version, p_reason: 'owner declined' });
    expect(await statusOf(b.approvalId)).toBe('invalidated');
  });

  it('the proposal itself is immutable and tamper-evident', async () => {
    const { approvalId } = await pendingCost();
    const a = (await q(`select * from public.approvals where id = $1`, [approvalId]))[0];
    for (const [col, val] of [['payload', `'{"amount_minor": 1}'::jsonb`], ['payload_hash', `'abc'`], ['target_fingerprint', `'abc'`], ['action_type', `'finance.void_charge'`],
      ['target_id', `gen_random_uuid()`], ['requested_by', `'${o.owner.sub}'`], ['org_id', `'${o.orgB}'`], ['expires_at', `now() + interval '99 days'`], ['requested_at', `now()`]]) {
      expect(await code(db.query(`update public.approvals set ${col} = ${val} where id = $1`, [approvalId])), col).toBe('PT409');
    }
    expect(await code(db.query(`delete from public.approvals where id = $1`, [approvalId]))).toBe('PT409');
    expect((await q(`select app.sha256_hex(payload::text) h from public.approvals where id = $1`, [approvalId]))[0].h).toBe(a.payload_hash);
    expect(await code(db.query(`update public.approval_events set note = 'x'`))).toBe('PT409');
    expect(await code(db.query(`delete from public.approval_events`))).toBe('PT409');
  });

  it('only lawful status changes are possible, even from raw SQL', async () => {
    const { approvalId } = await pendingCost();
    expect(await code(db.query(`update public.approvals set status = 'executed' where id = $1`, [approvalId]))).toBe('PT409');        // pending → executed
    expect(await code(db.query(`update public.approvals set status = 'executing' where id = $1`, [approvalId]))).toBe('PT409');
    await decide(approvalId, 'approve');
    for (const to of ['pending', 'approved', 'rejected', 'failed', 'cancelled', 'expired']) expect(await code(db.query(`update public.approvals set status = $1 where id = $2`, [to, approvalId])), `executed → ${to}`).toBe('PT409');
    const c = await charge();
    const rej = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    await decide(rej.id, 'reject');
    for (const to of ['approved', 'pending', 'executing']) expect(await code(db.query(`update public.approvals set status = $1 where id = $2`, [to, rej.id])), `rejected → ${to}`).toBe('PT409');
  });

  it('if the target changed after it was proposed, approval is refused and nothing is executed', async () => {
    const c = await charge(20000);
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    await call(db, o.admin, 'adjust_charge', { p_org: o.orgA, p_charge: c.id, p_amount_minor: -5000, p_reason: 'partial waiver', p_idempotency_key: key() });     // the world moved on
    const out = await decide(p.id, 'approve');
    expect(out).toMatchObject({ ok: false, status: 'invalidated' });
    expect(out.message).toMatch(/changed after this was proposed/);
    expect(await statusOf(p.id)).toBe('invalidated');
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).toBeNull();
    expect(await unread(o.staff.sub, 'approval.decided')).toBe(0);                                                       // (the decider is told in the response)
  });

  it('proposing the same thing again is idempotent; proposing something different supersedes the old one', async () => {
    const c = await charge();
    const a = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    const b = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    expect(b.id).toBe(a.id);
    expect(await count(db, `select count(*) n from public.approvals`)).toBe(1);
    const changed = await call(db, o.staff, 'request_approval', voidProposal(c.id, { p_payload: { charge_id: c.id, reason: 'A different reason entirely' } }));
    expect(changed.id).not.toBe(a.id);
    expect(await statusOf(a.id)).toBe('invalidated');
    expect(await statusOf(changed.id)).toBe('pending');
    expect(await count(db, `select count(*) n from public.approvals where status in ('pending','approved','executing')`)).toBe(1);   // never two live proposals for one target
  });
});

describe('finance.void_charge: a second supported action through the same engine', () => {
  it('lets staff propose and a manager authorize a void, recorded with the approval as the reason', async () => {
    const c = await charge();
    expect(await code(call(db, o.staff, 'void_charge', { p_org: o.orgA, p_charge: c.id, p_reason: 'direct attempt' }))).toBe('PT403');       // staff cannot void directly...
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));                                                                // ...but can ask
    expect(await code(decide(p.id, 'approve', o.staff))).toBe('PT403');
    const out = await decide(p.id, 'approve', o.manager, 'agreed');
    expect(out).toMatchObject({ ok: true, status: 'executed', result: { charge_id: c.id, already_void: false } });
    const row = (await q(`select voided_at, voided_by, void_reason from public.charges where id = $1`, [c.id]))[0];
    expect(row.voided_by).toBe(o.manager.sub);
    expect(row.void_reason).toContain('Fee was charged in error');
    expect(row.void_reason).toContain(`approval ${p.id}`);
    const audit = await call(db, o.manager, 'list_finance_audit', { p_org: o.orgA, p_entity_type: 'charge', p_entity_id: c.id });
    expect(audit.items.map((i: any) => i.action)).toEqual(['charge.voided', 'charge.created']);
    expect(audit.items[0]).toMatchObject({ actor: 'manager@a.test', reason: 'approved: Fee was charged in error' });
  });

  it('validates what is proposed: payloads cannot be forged or aimed at other organizations', async () => {
    const c = await charge();
    const bad = (payload: unknown, over: Record<string, unknown> = {}) => code(call(db, o.staff, 'request_approval', voidProposal(c.id, { p_payload: payload, ...over })));
    expect(await bad({ charge_id: c.id })).toBe('PT422');                                                              // missing reason
    expect(await bad({ charge_id: c.id, reason: 'ok' })).toBe('PT422');                                                // reason too short
    expect(await bad({ charge_id: c.id, reason: 'Fine reason', amount: 1 })).toBe('PT422');                            // unexpected key
    expect(await bad({ charge_id: crypto.randomUUID(), reason: 'Fine reason' })).toBe('PT422');                        // payload ≠ target
    expect(await bad({ charge_id: c.id, reason: 'Fine reason' }, { p_action: 'nope.nothing' })).toBe('PT422');
    expect(await code(call(db, o.viewer, 'request_approval', voidProposal(c.id)))).toBe('PT403');
    expect(await code(call(db, o.outsider, 'request_approval', voidProposal(c.id)))).toBe('PT404');
    expect(await code(call(db, o.outsider, 'request_approval', voidProposal(c.id, { p_org: o.orgB })))).toBe('PT404');                       // org A's charge via org B
    expect(await code(call(db, o.staff, 'request_approval', voidProposal(crypto.randomUUID())))).toBe('PT404');
    expect(await count(db, `select count(*) n from public.approvals`)).toBe(0);
    // maintenance approvals cannot be conjured with an invented amount
    const { wo } = await pendingCost(80000);
    expect(await code(call(db, o.staff, 'request_approval', { p_org: o.orgA, p_action: 'maintenance.approve_cost', p_target: wo, p_payload: { work_order_id: wo, amount_minor: 1, currency: 'USD' }, p_note: null, p_expires_in_hours: 24 }))).toBe('PT422');
  });

  it('a charge with payments applied fails to void and says why; the failure is recorded, not hidden', async () => {
    const c = await charge(20000);
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    const pay = await call(db, o.staff, 'record_payment', { p_org: o.orgA, p_tenancy: o.tenancy, p_amount_minor: 20000, p_received_on: '2026-02-01', p_method: 'cash', p_reference: 'C-1', p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: false });
    await call(db, o.staff, 'allocate_payment', { p_org: o.orgA, p_payment: pay.id, p_allocations: [{ charge_id: c.id, amount_minor: 20000 }], p_idempotency_key: key() });
    const out = await decide(p.id, 'approve');
    expect(out).toMatchObject({ ok: false, status: 'invalidated' });                                                   // allocating changed the target
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).toBeNull();
  });
});

describe('execution: permissions and target access are rechecked NOW', () => {
  /** An approval that was approved but not yet executed (e.g. the process stopped), set up directly in the database. */
  async function approvedButPending() {
    const c = await charge(30000);
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    await raw(`update public.approvals set status = 'approved', decided_by = $2, decided_at = now(), decision_note = 'ok' where id = $1`, [p.id, o.manager.sub]);
    return { c, id: p.id as string };
  }

  it('fails if the requester no longer has the right to propose the action — and can succeed once that is restored', async () => {
    const { c, id } = await approvedButPending();
    await call(db, o.owner, 'change_member_role', { p_org: o.orgA, p_user: o.staff.sub, p_role: 'viewer' });
    const out = await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: id });
    expect(out).toMatchObject({ ok: false, status: 'failed' });
    expect(out.message).toMatch(/requester no longer has permission/);
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).toBeNull();
    expect(await getA(id)).toMatchObject({ status: 'failed', execution_attempts: 1, can_retry: true });
    await call(db, o.owner, 'change_member_role', { p_org: o.orgA, p_user: o.staff.sub, p_role: 'staff' });
    expect(await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: id })).toMatchObject({ ok: true, status: 'executed' });
    expect((await getA(id)).execution_attempts).toBe(2);
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).not.toBeNull();
    expect(await events(id)).toEqual(['∅→pending', 'approved→executing', 'executing→failed', 'failed→executing', 'executing→executed']);   // (the crafted 'approved' step bypassed the log)
  });

  it('fails if the approver has lost their authority since deciding', async () => {
    const { id } = await approvedButPending();
    await call(db, o.owner, 'change_member_role', { p_org: o.orgA, p_user: o.manager.sub, p_role: 'staff' });
    const out = await call(db, o.admin, 'retry_approval', { p_org: o.orgA, p_approval: id });
    expect(out).toMatchObject({ ok: false, status: 'failed' });
    expect(out.message).toMatch(/approver no longer has permission/);
  });

  it('fails if the requester has left the organization entirely', async () => {
    const { id } = await approvedButPending();
    await call(db, o.owner, 'remove_member', { p_org: o.orgA, p_user: o.staff.sub });
    expect((await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: id })).message).toMatch(/requester no longer has permission/);
  });

  it('only people who could approve may retry or execute', async () => {
    const { id } = await approvedButPending();
    expect(await code(call(db, o.staff, 'retry_approval', { p_org: o.orgA, p_approval: id }))).toBe('PT403');
    expect(await code(call(db, o.outsider, 'retry_approval', { p_org: o.orgA, p_approval: id }))).toBe('PT404');
    expect(await code(call(db, o.outsider, 'retry_approval', { p_org: o.orgB, p_approval: id }))).toBe('PT404');
    expect(await code(call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: crypto.randomUUID() }))).toBe('PT404');
  });

  it('an unexpected failure is recorded as failed (not lost), leaves no partial effects, and a retry completes it exactly once', async () => {
    const c = await charge(30000);
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    await db.exec(`create or replace function public.boom() returns trigger language plpgsql as $$ begin raise exception 'database is on fire'; end $$;
                   create trigger boom before update on public.charges for each row execute function public.boom();`);
    const out = await decide(p.id, 'approve');
    expect(out).toMatchObject({ ok: false, status: 'failed' });
    expect(out.message).toBe('database is on fire');
    expect(await getA(p.id)).toMatchObject({ status: 'failed', execution_error: 'database is on fire', execution_attempts: 1, execution_result: null });
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).toBeNull();            // rolled back cleanly
    expect(await count(db, `select count(*) n from public.finance_audit where action = 'charge.voided'`)).toBe(0);
    expect(await unread(o.staff.sub, 'approval.decided')).toBe(1);                                                       // requester learns it failed
    await db.exec(`drop trigger boom on public.charges`);
    expect(await call(db, o.admin, 'retry_approval', { p_org: o.orgA, p_approval: p.id })).toMatchObject({ ok: true, status: 'executed' });
    expect(await call(db, o.admin, 'retry_approval', { p_org: o.orgA, p_approval: p.id })).toMatchObject({ ok: true, replayed: true });
    expect(await count(db, `select count(*) n from public.finance_audit where action = 'charge.voided'`)).toBe(1);     // exactly one effect
    expect((await getA(p.id)).execution_attempts).toBe(2);
    expect(await events(p.id)).toEqual(['∅→pending', 'pending→approved', 'approved→executing', 'executing→failed', 'failed→executing', 'executing→executed']);
  });

  it('every approval carries a stable idempotency key for external side effects', async () => {
    const { approvalId } = await pendingCost();
    const k = (await getA(approvalId)).execution_key;
    expect(k).toBe(`approval:${approvalId}`);
    await decide(approvalId, 'approve');
    expect((await getA(approvalId)).execution_key).toBe(k);
    expect(await count(db, `select count(*) n from public.notifications where dedupe_key like $1`, [`${k}%`])).toBe(1);   // side-effect rows are keyed by it and never doubled
    expect(await code(db.query(`update public.approvals set execution_key = 'x' where id = $1`, [approvalId]))).not.toBe('NO_ERROR');
  });
});

describe('expiry and cancellation', () => {
  it('an approval past its expiry cannot be decided or executed; the job records the expiry once and tells the requester', async () => {
    const { approvalId } = await pendingCost();
    await raw(`update public.approvals set expires_at = now() - interval '1 minute' where id = $1`, [approvalId]);
    expect(await code(decide(approvalId, 'approve'))).toBe('PT409');
    expect(await getA(approvalId)).toMatchObject({ status: 'expired', stored_status: 'pending', can_decide: false });                  // shown as expired immediately
    expect((await call(db, o.manager, 'list_approvals', { p_org: o.orgA, p_scope: 'inbox' })).items).toEqual([]);
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).expire_approvals.created).toBe(1);
    expect(await statusOf(approvalId)).toBe('expired');
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).expire_approvals.created).toBe(0);
    expect(await unread(o.staff.sub, 'approval.decided')).toBe(1);
    expect(await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: approvalId }).catch((e) => e.code)).toBe('PT409');
  });

  it('an approval that expires between approval and execution is not executed', async () => {
    const c = await charge();
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    await raw(`update public.approvals set status = 'approved', decided_by = $2, decided_at = now(), expires_at = now() - interval '1 second' where id = $1`, [p.id, o.manager.sub]);
    expect(await call(db, o.manager, 'retry_approval', { p_org: o.orgA, p_approval: p.id })).toMatchObject({ ok: false, status: 'expired' });
    expect((await q(`select voided_at from public.charges where id = $1`, [c.id]))[0].voided_at).toBeNull();
  });

  it('the requester (or a manager) can withdraw a pending approval; nobody else can; repeating is harmless', async () => {
    const c = await charge();
    const p = await call(db, o.staff, 'request_approval', voidProposal(c.id));
    const other = await call(db, o.manager, 'request_approval', voidProposal((await charge(100, '2026-02-01')).id));
    expect(await code(call(db, o.staff, 'cancel_approval', { p_org: o.orgA, p_approval: other.id, p_note: 'not mine' }))).toBe('PT404');   // does not even reveal it exists
    expect((await call(db, o.staff, 'cancel_approval', { p_org: o.orgA, p_approval: p.id, p_note: 'my mistake' })).status).toBe('cancelled');
    expect((await call(db, o.staff, 'cancel_approval', { p_org: o.orgA, p_approval: p.id, p_note: 'again' })).status).toBe('cancelled');
    expect(await code(decide(p.id, 'approve'))).toBe('PT409');
    expect((await call(db, o.admin, 'cancel_approval', { p_org: o.orgA, p_approval: other.id, p_note: 'no longer needed' })).status).toBe('cancelled');
    const done = await call(db, o.staff, 'request_approval', voidProposal(c.id, { p_payload: { charge_id: c.id, reason: 'Second attempt for this' } }));
    await decide(done.id, 'approve');
    expect(await code(call(db, o.staff, 'cancel_approval', { p_org: o.orgA, p_approval: done.id, p_note: 'too late' }))).toBe('PT409');   // already executed
    expect(await events(p.id)).toEqual(['∅→pending', 'pending→cancelled']);
  });
});
