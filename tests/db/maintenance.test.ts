import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { as, call, code, createUser } from '../support/db.js';
import { count, freshOps, key, portalArgs, reqArgs, settingsArgs, urgency, type Ops } from '../support/ops.js';

let db: PGlite; let o: Ops;
beforeEach(async () => { ({ db, o } = await freshOps()); });
afterEach(async () => { await db.close(); });

const mk = (over: Record<string, unknown> = {}, actor = o.staff) => call(db, actor, 'create_maintenance_request', reqArgs(o, over));
const get = (id: string, actor = o.staff) => call(db, actor, 'get_request', { p_org: o.orgA, p_request: id });
const triage = async (id: string, actor = o.staff) => call(db, actor, 'triage_request', { p_org: o.orgA, p_request: id, p_expected_version: (await get(id)).version, p_category: null, p_note: 'looks real' });
const assign = (id: string, over: Record<string, unknown> = {}, actor = o.staff) => call(db, actor, 'assign_work',
  { p_org: o.orgA, p_request: id, p_vendor: null, p_assignee: o.staff.sub, p_scope: 'Replace the washer', p_estimate_minor: null, p_estimate_note: null, ...over });
const wo = async (id: string) => (await get(id)).work_orders[0].id as string;
const unread = (user: string, event: string) => count(db, `select count(*) n from public.notifications where user_id = $1 and event_type = $2`, [user, event]);
const emails = (to: string, event?: string) => count(db, `select count(*) n from public.email_queue where recipient_email = $1 and ($2::text is null or event_type = $2)`, [to, event ?? null]);

describe('lifecycle', () => {
  it('walks submitted → triaged → assigned → in progress → resolved with a complete history', async () => {
    const r = await mk();
    expect(r).toMatchObject({ status: 'submitted', reported_via: 'staff', escalation_required: false });
    await triage(r.id);
    const a = await assign(r.id);
    expect(a.status).toBe('assigned');
    await call(db, o.staff, 'start_work', { p_org: o.orgA, p_work_order: await wo(r.id) });
    expect((await get(r.id)).status).toBe('in_progress');
    await call(db, o.staff, 'complete_work', { p_org: o.orgA, p_work_order: await wo(r.id), p_actual_cost_minor: 4500, p_notes: 'washer replaced' });
    const done = await call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: (await get(r.id)).version, p_resolution_notes: 'Replaced the washer; tested for leaks.' });
    expect(done).toMatchObject({ status: 'resolved', resolution_notes: 'Replaced the washer; tested for leaks.' });
    expect(done.history.map((h: any) => h.to_status)).toEqual(['submitted', 'triaged', 'assigned', 'in_progress', 'resolved']);
    expect(done.history.every((h: any, i: number) => h.from_status === (i ? done.history[i - 1].to_status : null))).toBe(true);
  });

  it('assigning straight from "submitted" triages first, so every step is lawful and recorded', async () => {
    const r = await mk();
    const a = await assign(r.id);
    expect(a.history.map((h: any) => h.to_status)).toEqual(['submitted', 'triaged', 'assigned']);
  });

  it('rejects invalid transitions in the service layer', async () => {
    const r = await mk();
    const v = (await get(r.id)).version;
    expect(await code(call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: v, p_resolution_notes: 'done' }))).toBe('PT409');   // not in progress
    expect(await code(call(db, o.manager, 'reopen_request', { p_org: o.orgA, p_request: r.id, p_expected_version: v, p_reason: 'because' }))).toBe('PT409');          // not resolved
    await triage(r.id);
    expect(await code(triage(r.id))).toBe('PT409');                                                                                                                  // already triaged
    const a = await assign(r.id);
    expect(await code(call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: a.version, p_resolution_notes: 'done' }))).toBe('PT409');
  });

  it('the database itself refuses illegal status changes, even from raw SQL', async () => {
    const r = await mk();
    for (const to of ['resolved', 'in_progress', 'assigned', 'awaiting_approval']) {
      expect(await code(db.query(`update public.maintenance_requests set status = $1 where id = $2`, [to, r.id])), `submitted → ${to}`).toBe('PT409');
    }
    await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r.id, p_expected_version: r.version, p_reason: 'duplicate' });
    for (const to of ['submitted', 'triaged', 'in_progress', 'resolved']) {
      expect(await code(db.query(`update public.maintenance_requests set status = $1 where id = $2`, [to, r.id])), `cancelled → ${to}`).toBe('PT409');
    }
    expect(await code(db.query(`update public.maintenance_requests set org_id = $1 where id = $2`, [o.orgB, r.id]))).toBe('PT409');
    expect(await code(db.query(`delete from public.maintenance_requests where id = $1`, [r.id]))).toBe('23503');
    expect(await code(db.query(`delete from public.maintenance_status_history`))).toBe('PT409');
    await call(db, o.manager, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'a note', p_visibility: 'internal' });
    expect(await code(db.query(`update public.maintenance_notes set body = 'edited'`))).toBe('PT409');
    expect(await code(db.query(`delete from public.maintenance_notes`))).toBe('PT409');
  });

  it('resolution needs notes and every work order closed; resolved requests can be reopened by managers only', async () => {
    const r = await mk();
    const a = await assign(r.id);
    await call(db, o.staff, 'start_work', { p_org: o.orgA, p_work_order: await wo(r.id) });
    const v = () => get(r.id).then((x) => x.version);
    expect(await code(call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_resolution_notes: 'fixed' }))).toBe('PT409');   // work still open
    await call(db, o.staff, 'complete_work', { p_org: o.orgA, p_work_order: await wo(r.id), p_actual_cost_minor: null, p_notes: null });
    expect(await code(call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_resolution_notes: '  ' }))).toBe('PT422');
    await call(db, o.staff, 'resolve_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_resolution_notes: 'All good now.' });
    expect(await code(call(db, o.staff, 'reopen_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_reason: 'leak is back' }))).toBe('PT403');
    expect(await code(call(db, o.manager, 'reopen_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_reason: '' }))).toBe('PT422');
    const reopened = await call(db, o.manager, 'reopen_request', { p_org: o.orgA, p_request: r.id, p_expected_version: await v(), p_reason: 'leak is back' });
    expect(reopened).toMatchObject({ status: 'in_progress', resolution_notes: null });
    void a;
  });

  it('cancelling follows who may do it, and cascades to work orders', async () => {
    const r1 = await mk();
    expect(await code(call(db, o.viewer, 'cancel_request', { p_org: o.orgA, p_request: r1.id, p_expected_version: 1, p_reason: 'nope' }))).toBe('PT404');
    expect(await code(call(db, o.staff, 'cancel_request', { p_org: o.orgA, p_request: r1.id, p_expected_version: 1, p_reason: '' }))).toBe('PT422');
    expect((await call(db, o.staff, 'cancel_request', { p_org: o.orgA, p_request: r1.id, p_expected_version: 1, p_reason: 'duplicate request' })).status).toBe('cancelled');   // staff may cancel early
    const r2 = await mk({ p_title: 'Second job' });
    const a = await assign(r2.id);
    expect(await code(call(db, o.staff, 'cancel_request', { p_org: o.orgA, p_request: r2.id, p_expected_version: a.version, p_reason: 'changed mind' }))).toBe('PT403');       // work arranged → manager
    const c = await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r2.id, p_expected_version: a.version, p_reason: 'owner withdrew it' });
    expect(c).toMatchObject({ status: 'cancelled', cancel_reason: 'owner withdrew it' });
    expect(c.work_orders[0].status).toBe('cancelled');
    expect(await code(call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r2.id, p_expected_version: c.version, p_reason: 'again' }))).toBe('PT409');
  });

  it('stale edits get 409', async () => {
    const r = await mk();
    await triage(r.id);
    expect(await code(call(db, o.staff, 'triage_request', { p_org: o.orgA, p_request: r.id, p_expected_version: r.version, p_category: null, p_note: null }))).toBe('PT409');
    expect(await code(call(db, o.staff, 'change_urgency', { p_org: o.orgA, p_request: r.id, p_expected_version: 1, p_urgency: await urgency(db, o, 'urgent'), p_reason: null }))).toBe('PT409');
  });

  it('notes are append-only; tenants never see internal ones', async () => {
    const r = await mk();
    await call(db, o.staff, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'Landlord says do not use contractor X', p_visibility: 'internal' });
    expect((await get(r.id)).notes.map((n: any) => n.visibility)).toContain('internal');
    expect(await code(call(db, o.viewer, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'hi', p_visibility: 'internal' }))).toBe('PT404');
    expect(await code(call(db, o.outsider, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'hi', p_visibility: 'internal' }))).toBe('PT404');
  });
});

describe('assignment and role rules', () => {
  it('staff may assign only to themselves; managers to any staff member; never to viewers or non-members', async () => {
    const r = await mk();
    expect(await code(assign(r.id, { p_assignee: o.manager.sub }, o.staff))).toBe('PT403');
    expect(await code(assign(r.id, { p_assignee: o.viewer.sub }, o.manager))).toBe('PT422');
    expect(await code(assign(r.id, { p_assignee: o.outsider.sub }, o.manager))).toBe('PT422');
    expect(await code(assign(r.id, { p_assignee: o.staff.sub }, o.viewer))).toBe('PT403');
    expect(await code(assign(r.id, { p_assignee: o.staff.sub }, o.outsider))).toBe('PT404');
    expect(await code(assign(r.id, { p_assignee: o.staff.sub, p_vendor: o.vendor }))).toBe('PT422');            // exactly one assignee
    expect(await code(assign(r.id, { p_assignee: null, p_vendor: null }))).toBe('PT422');
    const a = await assign(r.id, { p_assignee: o.staff.sub }, o.manager);
    expect(a.work_orders[0]).toMatchObject({ assignee_user_id: o.staff.sub, status: 'assigned' });
  });

  it('assigns vendors (not users), emailing the vendor; archived vendors are refused', async () => {
    const r = await mk();
    const a = await assign(r.id, { p_assignee: null, p_vendor: o.vendor, p_scope: 'Fix the tap' });
    expect(a.work_orders[0].vendor).toMatchObject({ name: 'HeatCo Plumbing' });
    expect(await emails('hal@heatco.test', 'maintenance.assigned')).toBe(1);
    await call(db, o.manager, 'set_vendor_archived', { p_org: o.orgA, p_vendor: o.vendor, p_archived: true });
    const r2 = await mk({ p_title: 'Another job' });
    expect(await code(assign(r2.id, { p_assignee: null, p_vendor: o.vendor }))).toBe('PT409');
    expect(await code(assign(r2.id, { p_assignee: null, p_vendor: crypto.randomUUID() }))).toBe('PT404');
  });

  it('only the assignee or a manager can start, estimate and complete work', async () => {
    const r = await mk();
    await assign(r.id, { p_assignee: o.staff.sub }, o.manager);
    const w = await wo(r.id);
    const other = await createUser(db, 'staff2@a.test');
    await call(db, o.owner, 'create_invitation', { p_org: o.orgA, p_email: 'staff2@a.test', p_role: 'staff', p_token_hash: 'h-staff2' });
    const staff2 = { sub: other, email: 'staff2@a.test' };
    await call(db, staff2, 'accept_invitation', { p_token_hash: 'h-staff2' });
    expect(await code(call(db, staff2, 'start_work', { p_org: o.orgA, p_work_order: w }))).toBe('PT403');
    expect(await code(call(db, staff2, 'submit_estimate', { p_org: o.orgA, p_work_order: w, p_amount_minor: 100, p_note: null }))).toBe('PT403');
    expect(await code(call(db, o.viewer, 'start_work', { p_org: o.orgA, p_work_order: w }))).toBe('PT403');
    await call(db, o.manager, 'start_work', { p_org: o.orgA, p_work_order: w });
    expect(await code(call(db, staff2, 'complete_work', { p_org: o.orgA, p_work_order: w, p_actual_cost_minor: null, p_notes: null }))).toBe('PT403');
    expect((await call(db, o.staff, 'complete_work', { p_org: o.orgA, p_work_order: w, p_actual_cost_minor: 100, p_notes: 'ok' })).work_orders[0].status).toBe('completed');
    expect(await code(call(db, o.staff, 'start_work', { p_org: o.orgA, p_work_order: w }))).toBe('PT409');
  });

  it('refuses to assign on closed requests, and work orders have their own lawful states', async () => {
    const r = await mk();
    await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r.id, p_expected_version: r.version, p_reason: 'dup' });
    expect(await code(assign(r.id))).toBe('PT409');
    const r2 = await mk({ p_title: 'Fresh job' });
    await assign(r2.id);
    const w = await wo(r2.id);
    expect(await code(db.query(`update public.work_orders set status = 'completed', completed_at = now() where id = $1`, [w]))).toBe('PT409');   // assigned → completed skips in_progress
    expect(await code(db.query(`update public.work_orders set assignee_user_id = $1 where id = $2`, [o.manager.sub, w]))).toBe('PT409');            // assignment is immutable; cancel and re-assign
    await call(db, o.manager, 'cancel_work_order', { p_org: o.orgA, p_work_order: w, p_reason: 'wrong person' });
    expect((await get(r2.id)).status).toBe('triaged');                                                                                               // request settles back, nothing orphaned
    expect((await assign(r2.id, { p_assignee: o.manager.sub }, o.manager)).status).toBe('assigned');
  });
});

describe('critical escalation', () => {
  const notifs = (user: string) => unread(user, 'maintenance.escalated');

  it('a critical urgency escalates to the designated human, and the alert cannot be switched off', async () => {
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.manager.sub }));
    await call(db, o.manager, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'maintenance.submitted', p_email: false, p_in_app: false });
    expect(await code(call(db, o.manager, 'set_my_notification_pref', { p_org: o.orgA, p_event_type: 'maintenance.escalated', p_email: false, p_in_app: true }))).toBe('PT422');
    const r = await mk({ p_urgency: await urgency(db, o, 'emergency'), p_title: 'Water coming through ceiling' });
    expect(r).toMatchObject({ escalation_required: true, escalation_fallback: false, escalated_to: o.manager.sub });
    expect(r.escalated_at).not.toBeNull();
    expect(await notifs(o.manager.sub)).toBe(1);
    expect(await emails('manager@a.test', 'maintenance.escalated')).toBe(1);
    expect(await unread(o.manager.sub, 'maintenance.submitted')).toBe(0);            // opt-out respected for ordinary events
    expect(await notifs(o.admin.sub)).toBe(0);                                      // designated, not broadcast
    expect((await get(r.id)).notes.some((n: any) => /ESCALATED as critical/.test(n.body))).toBe(true);
  });

  it('with no designated contact, every owner and admin is alerted instead of nobody', async () => {
    const r = await mk({ p_urgency: await urgency(db, o, 'emergency') });
    expect(r).toMatchObject({ escalation_fallback: true, escalated_to: null });
    expect([await notifs(o.owner.sub), await notifs(o.admin.sub), await notifs(o.manager.sub), await notifs(o.staff.sub)]).toEqual([1, 1, 0, 0]);
  });

  it('a designated contact who has since lost the role is bypassed', async () => {
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.manager.sub }));
    await call(db, o.owner, 'change_member_role', { p_org: o.orgA, p_user: o.manager.sub, p_role: 'viewer' });
    const r = await mk({ p_urgency: await urgency(db, o, 'emergency') });
    expect(r.escalation_fallback).toBe(true);
    expect(await notifs(o.admin.sub)).toBe(1);
  });

  it('a safety keyword escalates even when the requester picked a routine urgency', async () => {
    const r = await mk({ p_title: 'Smell of gas leak in kitchen', p_description: 'Please come quickly', p_urgency: await urgency(db, o, 'low') });
    expect(r).toMatchObject({ safety_flag: true, escalation_required: true });
    expect(r.urgency.label).toBe('Low');
    expect((await get(r.id)).notes.find((n: any) => n.author_kind === 'system').body).toMatch(/safety keyword “gas leak”/);
    const calm = await mk({ p_title: 'Squeaky door', p_description: 'Needs oil' });
    expect(calm.escalation_required).toBe(false);
  });

  it('keyword matching uses the organization\'s configured list', async () => {
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_critical_keywords: ['squeaky'] }));
    expect((await mk({ p_title: 'Squeaky door' })).escalation_required).toBe(true);
    expect((await mk({ p_title: 'Gas leak', p_description: 'smells' })).escalation_required).toBe(false);     // no longer listed
  });

  it('an AI-style suggestion can only raise handling; it can never suppress or lower anything', async () => {
    const low = await urgency(db, o, 'low'); const emergency = await urgency(db, o, 'emergency');
    const quiet = await mk();
    const raised = await call(db, o.staff, 'set_suggested_urgency', { p_org: o.orgA, p_request: quiet.id, p_urgency: emergency, p_source: 'classifier-v1' });
    expect(raised).toMatchObject({ escalation_required: true, suggestion_source: 'classifier-v1' });
    expect(raised.urgency.label).toBe('Routine');                                         // the human-set urgency is untouched
    expect(await notifs(o.owner.sub)).toBe(1);

    const loud = await mk({ p_urgency: emergency, p_title: 'Fire damage' });
    await call(db, o.staff, 'set_suggested_urgency', { p_org: o.orgA, p_request: loud.id, p_urgency: low, p_source: 'classifier-v1' });
    const after = await get(loud.id);
    expect(after).toMatchObject({ escalation_required: true });
    expect(after.urgency.label).toBe('Emergency');
    expect(after.escalated_at).not.toBeNull();
    expect(await notifs(o.owner.sub)).toBe(2);                                             // still exactly one alert per escalated request
  });

  it('only managers may lower urgency, and only after the escalation is acknowledged; the escalation is never cleared', async () => {
    const emergency = await urgency(db, o, 'emergency'); const routine = await urgency(db, o, 'routine'); const urgent = await urgency(db, o, 'urgent');
    const r = await mk({ p_urgency: emergency });
    const lower = (actor: any, u: string, reason: string | null, v?: number) => get(r.id).then((x) => call(db, actor, 'change_urgency', { p_org: o.orgA, p_request: r.id, p_expected_version: v ?? x.version, p_urgency: u, p_reason: reason }));
    expect(await code(lower(o.staff, routine, 'calm down'))).toBe('PT403');
    expect(await code(lower(o.manager, routine, null))).toBe('PT422');
    expect(await code(lower(o.manager, routine, 'owner confirmed minor'))).toBe('PT409');   // unacknowledged
    const acked = await call(db, o.manager, 'acknowledge_escalation', { p_org: o.orgA, p_request: r.id });
    expect(acked.escalation_ack_by_name).toBe('manager@a.test');
    await call(db, o.manager, 'acknowledge_escalation', { p_org: o.orgA, p_request: r.id });       // idempotent
    expect((await get(r.id)).notes.filter((n: any) => /acknowledged/.test(n.body))).toHaveLength(1);
    const lowered = await lower(o.manager, routine, 'owner confirmed it is minor');
    expect(lowered.urgency.label).toBe('Routine');
    expect(lowered).toMatchObject({ escalation_required: true });                                  // sticky
    expect(lowered.escalated_at).not.toBeNull();
    expect((await lower(o.staff, urgent, null)).urgency.label).toBe('Urgent');                      // anyone staff+ can raise
    expect(await code(call(db, o.staff, 'acknowledge_escalation', { p_org: o.orgA, p_request: r.id }))).toBe('PT403');
  });

  it('unacknowledged escalations are chased on a schedule, once per window, until a human acknowledges', async () => {
    await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.manager.sub, p_backup_user: o.admin.sub, p_ack_hours: 2 }));
    const r = await mk({ p_urgency: await urgency(db, o, 'emergency') });
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).escalation_followups.created).toBe(0);              // not overdue yet
    await db.query(`update public.maintenance_requests set escalated_at = now() - interval '2 hours 10 minutes' where id = $1`, [r.id]);
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).escalation_followups.created).toBe(1);               // window 1 → designated
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).escalation_followups.created).toBe(0);               // same window: no duplicate
    await db.query(`update public.maintenance_requests set escalated_at = now() - interval '4 hours 10 minutes' where id = $1`, [r.id]);
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).escalation_followups.created).toBe(2);               // window 2 → designated + backup
    await db.query(`update public.maintenance_requests set escalated_at = now() - interval '6 hours 10 minutes' where id = $1`, [r.id]);
    const w3 = await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA });
    expect(w3.escalation_followups.created).toBeGreaterThanOrEqual(2);                                                           // window 3 → widened to admins/owners
    expect(await unread(o.owner.sub, 'maintenance.escalated')).toBe(1);
    await call(db, o.manager, 'acknowledge_escalation', { p_org: o.orgA, p_request: r.id });
    await db.query(`update public.maintenance_requests set escalated_at = now() - interval '9 hours' where id = $1`, [r.id]);
    expect((await call(db, o.manager, 'run_org_jobs', { p_org: o.orgA })).escalation_followups.created).toBe(0);               // acknowledged: silence
  });

  it('settings are validated and admin-only; the contact must be a manager or above', async () => {
    expect(await code(call(db, o.manager, 'update_maintenance_settings', settingsArgs(o.orgA)))).toBe('PT403');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.staff.sub })))).toBe('PT422');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.outsider.sub })))).toBe('PT422');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_ack_hours: 0 })))).toBe('23514');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_approval_thresholds: { usd: 5 } })))).toBe('PT422');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_approval_thresholds: { USD: 1.5 } })))).toBe('PT422');
    expect(await code(call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_critical_keywords: ['x'] })))).toBe('PT422');
    const ok = await call(db, o.admin, 'update_maintenance_settings', settingsArgs(o.orgA, { p_escalation_user: o.owner.sub, p_approval_thresholds: { USD: 50000 } }));
    expect(ok).toMatchObject({ escalation_user: 'owner@a.test', approval_thresholds: { USD: 50000 } });
    expect((await call(db, o.staff, 'get_maintenance_settings', { p_org: o.orgA })).ack_hours).toBe(2);
    expect(await code(call(db, o.viewer, 'get_maintenance_settings', { p_org: o.orgA }))).toBe('PT403');
  });
});

describe('configurable urgency levels', () => {
  it('seeds sensible defaults and lets managers add, edit and archive levels', async () => {
    const levels = await call(db, o.staff, 'list_urgency_levels', { p_org: o.orgA });
    expect(levels.map((l: any) => [l.key, l.is_critical, l.is_default])).toEqual([['low', false, false], ['routine', false, true], ['urgent', false, false], ['emergency', true, false]]);
    const added = await call(db, o.manager, 'save_urgency_level', { p_org: o.orgA, p_id: null, p_key: 'life_safety', p_label: 'Life safety', p_rank: 50, p_is_critical: true, p_tenant_selectable: false, p_is_default: false });
    expect(added).toMatchObject({ key: 'life_safety', is_critical: true });
    expect(await code(call(db, o.manager, 'save_urgency_level', { p_org: o.orgA, p_id: null, p_key: 'life_safety', p_label: 'Dup', p_rank: 51, p_is_critical: false, p_tenant_selectable: true, p_is_default: false }))).toBe('PT409');
    expect(await code(call(db, o.staff, 'save_urgency_level', { p_org: o.orgA, p_id: null, p_key: 'x_level', p_label: 'X', p_rank: 5, p_is_critical: false, p_tenant_selectable: true, p_is_default: false }))).toBe('PT403');
    const r = await mk({ p_urgency: added.id });
    expect(r.escalation_required).toBe(true);                                       // a custom critical level escalates just like the built-in
  });

  it('can never be configured into a state where emergencies are not escalated', async () => {
    const levels = await call(db, o.manager, 'list_urgency_levels', { p_org: o.orgA });
    const emergency = levels.find((l: any) => l.key === 'emergency'); const routine = levels.find((l: any) => l.key === 'routine');
    expect(await code(call(db, o.manager, 'set_urgency_archived', { p_org: o.orgA, p_id: emergency.id, p_archived: true }))).toBe('PT409');
    expect(await code(call(db, o.manager, 'save_urgency_level', { p_org: o.orgA, p_id: emergency.id, p_key: 'emergency', p_label: 'Emergency', p_rank: 40, p_is_critical: false, p_tenant_selectable: true, p_is_default: false }))).toBe('PT409');
    expect(await code(call(db, o.manager, 'set_urgency_archived', { p_org: o.orgA, p_id: routine.id, p_archived: true }))).toBe('PT409');   // the default
  });

  it('archived levels cannot be chosen for new requests, but old requests keep theirs', async () => {
    const low = await urgency(db, o, 'low');
    const r = await mk({ p_urgency: low });
    await call(db, o.manager, 'set_urgency_archived', { p_org: o.orgA, p_id: low, p_archived: true });
    expect(await code(mk({ p_urgency: low }))).toBe('PT404');
    expect((await get(r.id)).urgency.label).toBe('Low');
  });
});

describe('tenant portal', () => {
  it('only a tenant verified by invitation and matching confirmed email gets access', async () => {
    const t = (await call(db, o.staff, 'create_tenant', { p_org: o.orgA, p_full_name: 'Una Unverified', p_email: 'una@mail.test', p_phone: null, p_emergency_name: null, p_emergency_phone: null, p_notes: null })).id;
    expect(await code(call(db, o.staff, 'invite_tenant_to_portal', { p_org: o.orgA, p_tenant: t, p_token_hash: 'x1' }))).toBe('PT403');
    const noEmail = (await call(db, o.staff, 'create_tenant', { p_org: o.orgA, p_full_name: 'No Email', p_email: null, p_phone: null, p_emergency_name: null, p_emergency_phone: null, p_notes: null })).id;
    expect(await code(call(db, o.manager, 'invite_tenant_to_portal', { p_org: o.orgA, p_tenant: noEmail, p_token_hash: 'x2' }))).toBe('PT422');
    await call(db, o.manager, 'invite_tenant_to_portal', { p_org: o.orgA, p_tenant: t, p_token_hash: 'tok-una' });
    const wrong = { sub: await createUser(db, 'someone.else@mail.test'), email: 'someone.else@mail.test' };
    expect(await code(call(db, wrong, 'accept_tenant_invitation', { p_token_hash: 'tok-una' }))).toBe('PT404');                       // token alone is not enough
    const unconfirmed = { sub: await createUser(db, 'una@mail.test', { confirmed: false }), email: 'una@mail.test' };
    expect(await code(call(db, unconfirmed, 'accept_tenant_invitation', { p_token_hash: 'tok-una' }))).toBe('PT404');                  // unverified address
    await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [unconfirmed.sub]);
    expect(await call(db, unconfirmed, 'accept_tenant_invitation', { p_token_hash: 'tok-una' })).toMatchObject({ org_id: o.orgA, tenant_id: t });
    expect(await code(call(db, unconfirmed, 'accept_tenant_invitation', { p_token_hash: 'tok-una' }))).toBe('PT404');                  // single use
    expect((await call(db, unconfirmed, 'get_me')).tenant_links).toHaveLength(1);
    expect((await call(db, unconfirmed, 'get_me')).memberships).toEqual([]);                                                          // NOT an org member
    const access = await call(db, o.manager, 'get_tenant_portal_access', { p_org: o.orgA, p_tenant: t });
    await call(db, o.manager, 'revoke_tenant_portal_access', { p_org: o.orgA, p_link: access.users[0].id });
    expect(await code(call(db, unconfirmed, 'portal_submit_request', portalArgs(o, { p_tenancy: crypto.randomUUID() })))).toBe('PT403');
    expect((await call(db, unconfirmed, 'get_me')).tenant_links).toEqual([]);
  });

  it('a verified tenant can raise a request for their own active tenancy and sees only what is theirs', async () => {
    const r = await call(db, o.tina, 'portal_submit_request', portalArgs(o));
    expect(r).toMatchObject({ title: 'Bedroom window will not close', status: 'submitted', property_name: 'Maple Court', unit_reference: '1A', can_cancel: true });
    const staffView = await get(r.id);
    expect(staffView).toMatchObject({ reported_via: 'tenant', tenant: { full_name: 'Tina Tenant' } });
    expect(await unread(o.manager.sub, 'maintenance.submitted')).toBe(1);
    expect((await call(db, o.tina, 'portal_list_requests')).map((x: any) => x.id)).toEqual([r.id]);
    expect(await call(db, o.omar, 'portal_list_requests')).toEqual([]);
    expect(await code(call(db, o.omar, 'portal_get_request', { p_org: o.orgA, p_request: r.id }))).toBe('PT404');              // another tenant's request
    const ctx = await call(db, o.tina, 'portal_context');
    expect(ctx).toHaveLength(1);
    expect(ctx[0].tenancies.map((t: any) => t.unit_reference)).toEqual(['1A']);
  });

  it('cannot raise requests for someone else\'s tenancy, an ended tenancy, another org, or without a link', async () => {
    expect(await code(call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_tenancy: o.tenancy2 })))).toBe('PT403');   // Omar's tenancy
    expect(await code(call(db, o.omar, 'portal_submit_request', portalArgs(o)))).toBe('PT403');                              // Tina's tenancy
    expect(await code(call(db, o.outsider, 'portal_submit_request', portalArgs(o)))).toBe('PT403');                          // not a tenant at all
    expect(await code(call(db, o.staff, 'portal_submit_request', portalArgs(o)))).toBe('PT403');                             // staff use the staff API
    expect(await code(call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_org: o.orgB })))).toBe('PT403');
    const t = await call(db, o.manager, 'get_tenancy', { p_org: o.orgA, p_tenancy: o.tenancy });
    await call(db, o.manager, 'end_tenancy', { p_org: o.orgA, p_tenancy: o.tenancy, p_expected_version: t.version, p_end_date: '2026-06-01', p_reason: 'moved out' });
    expect(await code(call(db, o.tina, 'portal_submit_request', portalArgs(o)))).toBe('PT403');                             // no longer active
  });

  it('tenants choose only tenant-selectable urgency, and a critical choice or keyword still escalates', async () => {
    const levels = await call(db, o.tina, 'portal_urgency_levels', { p_org: o.orgA });
    expect(levels.map((l: any) => l.label)).toEqual(['Low', 'Routine', 'Urgent', 'Emergency']);
    const secret = await call(db, o.manager, 'save_urgency_level', { p_org: o.orgA, p_id: null, p_key: 'staff_only', p_label: 'Staff only', p_rank: 25, p_is_critical: false, p_tenant_selectable: false, p_is_default: false });
    expect(await code(call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_urgency: secret.id })))).toBe('PT422');
    expect((await call(db, o.tina, 'portal_urgency_levels', { p_org: o.orgA })).map((l: any) => l.label)).not.toContain('Staff only');
    const em = await call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_urgency: await urgency(db, o, 'emergency') }));
    expect((await get(em.id)).escalation_required).toBe(true);
    const kw = await call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_title: 'Flooding in bathroom', p_urgency: await urgency(db, o, 'low') }));
    expect((await get(kw.id)).escalation_required).toBe(true);
    expect(await code(call(db, o.outsider, 'portal_urgency_levels', { p_org: o.orgA }))).toBe('PT404');
  });

  it('tenants see tenant-visible notes and history only; they can message and cancel only early', async () => {
    const r = await call(db, o.tina, 'portal_submit_request', portalArgs(o));
    await call(db, o.staff, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'Internal: contractor is slow', p_visibility: 'internal' });
    await call(db, o.staff, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'We will visit Tuesday morning.', p_visibility: 'tenant' });
    await call(db, o.tina, 'add_request_note', { p_org: o.orgA, p_request: r.id, p_body: 'Tuesday works, thanks.', p_visibility: 'internal' });          // a tenant cannot write internal notes
    const view = await call(db, o.tina, 'portal_get_request', { p_org: o.orgA, p_request: r.id });
    expect(view.notes.map((n: any) => n.body)).toEqual(['We will visit Tuesday morning.', 'Tuesday works, thanks.']);
    expect(JSON.stringify(view)).not.toMatch(/contractor is slow|work_orders|estimate|escalat/i);
    expect((await get(r.id)).notes.find((n: any) => n.body === 'Tuesday works, thanks.').visibility).toBe('tenant');
    expect(await unread(o.tina.sub, 'maintenance.note')).toBe(1);
    expect(await unread(o.manager.sub, 'maintenance.note')).toBe(1);
    await triage(r.id);
    await assign(r.id);
    expect(await code(call(db, o.tina, 'cancel_request', { p_org: o.orgA, p_request: r.id, p_expected_version: (await get(r.id)).version, p_reason: 'sorted it myself' }))).toBe('PT403');
    const r2 = await call(db, o.tina, 'portal_submit_request', portalArgs(o, { p_title: 'Second issue here' }));
    const c = await call(db, o.tina, 'cancel_request', { p_org: o.orgA, p_request: r2.id, p_expected_version: (await get(r2.id)).version, p_reason: 'sorted it myself' });
    expect(c.status).toBe('cancelled');
  });

  it('tenants are told when their request changes status, in-app and by email', async () => {
    const r = await call(db, o.tina, 'portal_submit_request', portalArgs(o));
    await triage(r.id);
    await call(db, o.manager, 'cancel_request', { p_org: o.orgA, p_request: r.id, p_expected_version: (await get(r.id)).version, p_reason: 'Duplicate of an earlier job' });
    expect(await unread(o.tina.sub, 'maintenance.status')).toBe(2);
    expect(await emails('tina@mail.test', 'maintenance.status')).toBe(2);
  });

  it('tenant users have no access to staff data or functions', async () => {
    const r = await mk();
    for (const t of ['maintenance_requests', 'properties', 'tenants', 'tenancies', 'units', 'charges', 'payments', 'vendors', 'work_orders', 'maintenance_notes', 'urgency_levels', 'approvals', 'organizations', 'memberships']) {
      expect((await as(db, o.tina, (q) => q(`select * from public.${t}`))).rows, t).toEqual([]);
    }
    for (const [fn, args] of [['get_request', { p_request: r.id }], ['list_requests', {}], ['list_vendors', {}], ['get_maintenance_settings', {}], ['list_approvals', { p_scope: 'mine' }]] as const) {
      expect(await code(call(db, o.tina, fn, { p_org: o.orgA, ...args })), fn).toBe('PT404');
    }
    expect(await code(assign(r.id, {}, o.tina))).toBe('PT404');
  });

  it('attachments: visible to staff always, to the tenant only when tenant-visible', async () => {
    const r = await call(db, o.tina, 'portal_submit_request', portalArgs(o));
    const mine = await call(db, o.tina, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'window latch.jpg', p_mime_type: 'image/jpeg', p_size_bytes: 1234, p_visibility: 'internal' });
    expect(mine).toMatchObject({ visibility: 'tenant', uploader_kind: 'tenant', status: 'pending' });          // forced tenant-visible for tenant uploads
    expect(mine.storage_path).toMatch(new RegExp(`^${o.orgA}/${r.id}/${mine.id}-window_latch.jpg$`));
    await db.query(`insert into storage.objects (bucket_id, name) select 'maintenance-attachments', $1`, [mine.storage_path]);                      // (superuser stand-in for the upload)
    await call(db, o.tina, 'confirm_maintenance_attachment', { p_org: o.orgA, p_attachment: mine.id, p_size_bytes: 1234, p_mime_type: 'image/jpeg' });
    const internal = await call(db, o.staff, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'inspection.pdf', p_mime_type: 'application/pdf', p_size_bytes: 99, p_visibility: 'internal' });
    await call(db, o.staff, 'confirm_maintenance_attachment', { p_org: o.orgA, p_attachment: internal.id, p_size_bytes: 99, p_mime_type: 'application/pdf' });
    expect((await call(db, o.staff, 'get_request', { p_org: o.orgA, p_request: r.id })).attachments).toHaveLength(2);
    expect((await call(db, o.tina, 'portal_get_request', { p_org: o.orgA, p_request: r.id })).attachments.map((a: any) => a.file_name)).toEqual(['window latch.jpg']);
    expect((await call(db, o.tina, 'get_attachment_access', { p_org: o.orgA, p_attachment: mine.id })).id).toBe(mine.id);
    expect(await code(call(db, o.tina, 'get_attachment_access', { p_org: o.orgA, p_attachment: internal.id }))).toBe('PT404');
    expect(await code(call(db, o.omar, 'get_attachment_access', { p_org: o.orgA, p_attachment: mine.id }))).toBe('PT404');
    expect(await code(call(db, o.outsider, 'get_attachment_access', { p_org: o.orgA, p_attachment: mine.id }))).toBe('PT404');
    expect(await code(call(db, o.omar, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'x.png', p_mime_type: 'image/png', p_size_bytes: 5, p_visibility: 'tenant' }))).toBe('PT404');
    expect(await code(call(db, o.tina, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'x.exe', p_mime_type: 'application/x-msdownload', p_size_bytes: 5, p_visibility: 'tenant' }))).toBe('PT422');
    expect(await code(call(db, o.tina, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'big.png', p_mime_type: 'image/png', p_size_bytes: 20_000_000, p_visibility: 'tenant' }))).toBe('PT422');
  });

  it('storage policies: only the uploader can write a registered path; reads follow request access', async () => {
    const r = await call(db, o.tina, 'portal_submit_request', portalArgs(o));
    const a = await call(db, o.tina, 'create_maintenance_attachment', { p_org: o.orgA, p_request: r.id, p_file_name: 'photo.png', p_mime_type: 'image/png', p_size_bytes: 10, p_visibility: 'tenant' });
    const put = (actor: any, path: string) => as(db, actor, (q) => q(`insert into storage.objects (bucket_id, name) values ('maintenance-attachments', $1)`, [path]));
    expect(await code(put(o.omar, a.storage_path))).toBe('42501');                      // another tenant
    expect(await code(put(o.outsider, a.storage_path))).toBe('42501');
    expect(await code(put(o.staff, a.storage_path))).toBe('42501');                     // not the registered uploader
    expect(await code(put(o.tina, `${o.orgA}/${r.id}/${crypto.randomUUID()}-unregistered.png`))).toBe('42501');
    await put(o.tina, a.storage_path);
    const read = (actor: any) => as(db, actor, async (q) => (await q(`select name from storage.objects where bucket_id = 'maintenance-attachments' and name = $1`, [a.storage_path])).rows.length);
    expect(await read(o.tina)).toBe(1);                                                 // uploader can verify while pending
    expect(await read(o.staff)).toBe(0);
    await call(db, o.tina, 'confirm_maintenance_attachment', { p_org: o.orgA, p_attachment: a.id, p_size_bytes: 10, p_mime_type: 'image/png' });
    expect([await read(o.tina), await read(o.staff), await read(o.manager)]).toEqual([1, 1, 1]);
    expect([await read(o.omar), await read(o.outsider), await read(o.viewer)]).toEqual([0, 0, 0]);
  });
});

describe('isolation and visibility', () => {
  it('another organization sees and changes nothing', async () => {
    const r = await mk();
    const w = (await assign(r.id)).work_orders[0].id;
    for (const [fn, args] of [
      ['get_request', { p_request: r.id }], ['list_requests', {}], ['triage_request', { p_request: r.id, p_expected_version: 1, p_category: null, p_note: null }],
      ['assign_work', { p_request: r.id, p_vendor: null, p_assignee: o.outsider.sub, p_scope: 'x', p_estimate_minor: null, p_estimate_note: null }],
      ['start_work', { p_work_order: w }], ['cancel_work_order', { p_work_order: w, p_reason: 'hostile' }], ['acknowledge_escalation', { p_request: r.id }],
      ['add_request_note', { p_request: r.id, p_body: 'x', p_visibility: 'internal' }], ['list_vendors', {}],
    ] as const) expect(await code(call(db, o.outsider, fn, { p_org: o.orgA, ...args })), fn).toBe('PT404');
    expect(await code(call(db, o.outsider, 'get_request', { p_org: o.orgB, p_request: r.id }))).toBe('PT404');                                   // org A's id via org B
    expect(await code(call(db, o.outsider, 'create_maintenance_request', reqArgs(o, { p_org: o.orgB })))).toBe('PT404');                         // org A's property via org B
    for (const t of ['maintenance_requests', 'work_orders', 'vendors', 'maintenance_notes', 'maintenance_status_history', 'maintenance_attachments', 'urgency_levels'])
      expect((await as(db, o.outsider, (q) => q(`select * from public.${t}`))).rows, t).toEqual([]);
    expect(await code(call(db, o.viewer, 'get_request', { p_org: o.orgA, p_request: r.id }))).toBe('PT403');
  });

  it('notifications and preferences are private to their owner', async () => {
    await mk();
    const mine = await call(db, o.manager, 'list_my_notifications', {});
    expect(mine.unread).toBe(1);
    expect((await call(db, o.staff, 'list_my_notifications', {})).items.find((n: any) => n.event_type === 'maintenance.submitted')).toBeUndefined();   // creator isn't told
    expect((await as(db, o.staff, (q) => q(`select * from public.notifications where user_id = $1`, [o.manager.sub]))).rows).toEqual([]);
    expect(await call(db, o.manager, 'mark_my_notifications_read', { p_ids: [mine.items[0].id] })).toEqual({ marked: 1 });
    expect(await call(db, o.staff, 'mark_my_notifications_read', { p_ids: [mine.items[0].id] })).toEqual({ marked: 0 });
    expect((await call(db, o.manager, 'list_my_notifications', {})).unread).toBe(0);
    expect(await code(call(db, o.outsider, 'get_my_notification_prefs', { p_org: o.orgA }))).toBe('PT404');
    expect(await code(call(db, o.manager, 'list_my_notifications', {}).then(() => call(db, null as any, 'list_my_notifications', {})))).toBe('42501');
  });
});
void key;
