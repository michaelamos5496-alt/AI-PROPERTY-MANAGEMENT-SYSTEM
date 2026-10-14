import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { key, propertyArgs, tenancyArgs, tenantArgs, unitArgs } from '../support/fixtures.js';
import { startPostgres, type Pg } from '../support/pg.js';

// Real PostgreSQL, many parallel connections.
let pg: Pg;
let w: Awaited<ReturnType<typeof world>>;

async function world(pg: Pg) {
  const owner = await pg.createUser('owner@a.test');
  const admin = await pg.createUser('admin@a.test');
  const manager = await pg.createUser('manager@a.test');
  const manager2 = await pg.createUser('manager2@a.test');
  const staff = await pg.createUser('staff@a.test');
  const org = (await pg.call(owner, 'create_organization', { p_name: 'Org Alpha' })).id as string;
  for (const [p, role] of [[admin, 'admin'], [manager, 'manager'], [manager2, 'manager'], [staff, 'staff']] as const) {
    await pg.call(owner, 'create_invitation', { p_org: org, p_email: p.email, p_role: role, p_token_hash: `h-${p.email}` });
    await pg.call(p, 'accept_invitation', { p_token_hash: `h-${p.email}` });
  }
  const prop = (await pg.call(manager, 'create_property', propertyArgs(org))).id as string;
  return { owner, admin, manager, manager2, staff, org, prop };
}
beforeAll(async () => { pg = await startPostgres(); w = await world(pg); }, 180_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

let n = 0;
async function newRequest(over: Record<string, unknown> = {}) {
  const unit = (await pg.call(w.manager, 'create_unit', unitArgs(w.org, w.prop, `M${++n}`))).id;
  return pg.call(w.staff, 'create_maintenance_request', { p_org: w.org, p_property: w.prop, p_unit: unit, p_tenancy: null, p_title: `Job ${n}`, p_description: 'Something is broken.', p_category: 'plumbing', p_urgency: null, ...over });
}
async function pendingCost(amount = 80000) {
  const r = await newRequest();
  const a = await pg.call(w.staff, 'assign_work', { p_org: w.org, p_request: r.id, p_vendor: null, p_assignee: w.staff.sub, p_scope: 'Fix it', p_estimate_minor: amount, p_estimate_note: null });
  return { r, wo: a.work_orders[0].id as string, approvalId: a.work_orders[0].approval.id as string };
}
const num = async (sql: string, params: unknown[] = []) => Number((await pg.admin.query(sql, params)).rows[0].n);
const codes = (rs: PromiseSettledResult<unknown>[]) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as any).code));
const tally = (cs: string[]) => cs.reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});

describe('email delivery workers', () => {
  it('twelve workers draining one queue claim every email exactly once', async () => {
    const TOTAL = 80;
    await pg.admin.query(`insert into public.email_queue (org_id, recipient_email, event_type, subject, body_text, dedupe_key)
                          select $1, 'user' || g || '@x.test', 'maintenance.submitted', 'Hello ' || g, 'body', 'drain:' || g from generate_series(1, $2) g`, [w.org, TOTAL]);
    const claimed: string[] = [];
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      for (;;) {
        const batch = await pg.svcCall('claim_emails', { p_worker: `worker-${i}`, p_limit: 5, p_lease_seconds: 120 });
        if (!batch.length) return;
        for (const e of batch) {
          claimed.push(e.id);
          await pg.svcCall('complete_email', { p_id: e.id, p_worker: `worker-${i}`, p_provider_message_id: `m-${e.id}` });
        }
      }
    }));
    expect(claimed).toHaveLength(TOTAL);
    expect(new Set(claimed).size).toBe(TOTAL);                                           // none claimed twice
    expect(await num(`select count(*) n from public.email_queue where dedupe_key like 'drain:%' and status = 'sent' and attempts = 1`)).toBe(TOTAL);
  });

  it('concurrent failures and retries never exceed max attempts or lose an email', async () => {
    await pg.admin.query(`insert into public.email_queue (org_id, recipient_email, event_type, subject, body_text, dedupe_key, max_attempts)
                          select $1, 'flaky' || g || '@x.test', 'maintenance.submitted', 'Flaky', 'body', 'flaky:' || g, 3 from generate_series(1, 20) g`, [w.org]);
    for (let round = 0; round < 6; round++) {
      await pg.admin.query(`update public.email_queue set next_attempt_at = now() - interval '1 second' where dedupe_key like 'flaky:%' and status = 'failed'`);
      await Promise.all(Array.from({ length: 4 }, async (_, i) => {
        for (;;) {
          const batch = await pg.svcCall('claim_emails', { p_worker: `f-${i}`, p_limit: 3, p_lease_seconds: 120 });
          if (!batch.length) return;
          for (const e of batch.filter((x: any) => x.dedupe_key.startsWith('flaky:'))) await pg.svcCall('fail_email', { p_id: e.id, p_worker: `f-${i}`, p_error: 'SMTP 451', p_permanent: false });
        }
      }));
    }
    expect(await num(`select count(*) n from public.email_queue where dedupe_key like 'flaky:%' and status = 'dead' and attempts = 3`)).toBe(20);
    expect(await num(`select count(*) n from public.email_queue where dedupe_key like 'flaky:%' and attempts > 3`)).toBe(0);
  });
});

describe('scheduled jobs under overlap', () => {
  it('ten overlapping runs of every job create each reminder exactly once', async () => {
    const unit = (await pg.call(w.manager, 'create_unit', unitArgs(w.org, w.prop, 'JOBS'))).id;
    const tenant = (await pg.call(w.staff, 'create_tenant', tenantArgs(w.org, 'Reminder Tenant', { p_email: 'reminders@x.test' }))).id;
    const t = await pg.call(w.staff, 'create_tenancy', tenancyArgs(w.org, unit, [tenant], { p_end_date: null }));
    await pg.call(w.manager, 'activate_tenancy', { p_org: w.org, p_tenancy: t.id, p_expected_version: t.version });
    const today = (await pg.admin.query(`select (now() at time zone 'America/Chicago')::date d`)).rows[0].d as Date;
    const iso = (d: number) => new Date(today.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    for (const d of [2, 0, -5]) {
      await pg.call(w.manager, 'create_charge', { p_org: w.org, p_tenancy: t.id, p_kind: 'rent', p_description: `Rent ${d}`, p_due_date: iso(d), p_amount_minor: 100000, p_idempotency_key: key() });
    }
    const t2 = await pg.call(w.manager, 'get_tenancy', { p_org: w.org, p_tenancy: t.id });
    await pg.call(w.manager, 'update_tenancy', { p_org: w.org, p_tenancy: t.id, p_expected_version: t2.version, p_start_date: '2026-01-01', p_end_date: iso(20), p_rent_amount_minor: 150000,
      p_rent_period: 'monthly', p_rent_due_day: 1, p_deposit_amount_minor: 0, p_deposit_scheme: null, p_notice_days: null, p_notes: null });
    const runs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? pg.svcCall('job_run_all') : pg.call(w.manager, 'run_org_jobs', { p_org: w.org }))));
    expect(tally(codes(runs))).toEqual({ ok: 10 });
    expect(await num(`select count(*) n from public.email_queue where recipient_email = 'reminders@x.test' and event_type = 'reminder.rent_due'`)).toBe(3);
    expect(await num(`select count(*) n from public.notifications where event_type = 'reminder.lease_expiry' and dedupe_key like 'lease:' || $1 || '%'`, [t.id])).toBe(4);   // manager, manager2, admin, owner
    // and the schedule is stable afterwards
    const again = await pg.svcCall('job_run_all');
    expect(Object.values(again[w.org]).every((j: any) => j.created === 0 || j.skipped)).toBe(true);
    expect(await num(`select count(*) n from public.job_runs where status = 'error'`)).toBe(0);
  });
});

describe('approvals under contention', () => {
  it('many approvers clicking at once execute the action exactly once', async () => {
    const { r, wo, approvalId } = await pendingCost();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => pg.call([w.manager, w.manager2, w.admin, w.owner][i % 4]!, 'decide_approval', { p_org: w.org, p_approval: approvalId, p_decision: 'approve', p_note: null })));
    expect(tally(codes(rs))).toEqual({ ok: 10 });
    const executed = rs.filter((x) => x.status === 'fulfilled' && !(x.value as any).replayed).length;
    expect(executed).toBe(1);
    const a = (await pg.admin.query(`select status, execution_attempts from public.approvals where id = $1`, [approvalId])).rows[0];
    expect(a).toMatchObject({ status: 'executed', execution_attempts: 1 });
    expect(await num(`select count(*) n from public.approval_events where approval_id = $1 and to_status = 'executed'`, [approvalId])).toBe(1);
    expect(await num(`select count(*) n from public.notifications where dedupe_key = $1`, [`ap:${approvalId}:executed`])).toBe(1);
    expect((await pg.admin.query(`select approved_cost_minor from public.work_orders where id = $1`, [wo])).rows[0].approved_cost_minor).toBe('80000');
    expect((await pg.call(w.staff, 'get_request', { p_org: w.org, p_request: r.id })).status).toBe('assigned');
  });

  it('an approve and a reject racing each other: exactly one decision wins and the outcome is consistent', async () => {
    for (let round = 0; round < 8; round++) {
      const { wo, approvalId } = await pendingCost(50000 + round);
      const [ap, rj] = await Promise.allSettled([
        pg.call(w.manager, 'decide_approval', { p_org: w.org, p_approval: approvalId, p_decision: 'approve', p_note: null }),
        pg.call(w.admin, 'decide_approval', { p_org: w.org, p_approval: approvalId, p_decision: 'reject', p_note: 'no' })]);
      const row = (await pg.admin.query(`select status from public.approvals where id = $1`, [approvalId])).rows[0];
      const cost = (await pg.admin.query(`select approved_cost_minor c from public.work_orders where id = $1`, [wo])).rows[0].c;
      expect(['executed', 'rejected']).toContain(row.status);
      expect([ap, rj].filter((x) => x.status === 'fulfilled')).toHaveLength(1);                      // the loser is told it is too late
      expect(row.status === 'executed').toBe(cost !== null);                                         // money authorized iff approved
    }
  });

  it('simultaneous identical proposals create exactly one live approval', async () => {
    const charge = await pg.call(w.manager, 'create_charge', { p_org: w.org, p_tenancy: (await (async () => {
      const unit = (await pg.call(w.manager, 'create_unit', unitArgs(w.org, w.prop, 'APR'))).id;
      const tenant = (await pg.call(w.staff, 'create_tenant', tenantArgs(w.org, 'Apr Tenant'))).id;
      const t = await pg.call(w.staff, 'create_tenancy', tenancyArgs(w.org, unit, [tenant], { p_end_date: null }));
      return t.id as string;
    })()), p_kind: 'fee', p_description: 'Disputed fee', p_due_date: '2026-01-01', p_amount_minor: 5000, p_idempotency_key: key() });
    const proposal = { p_org: w.org, p_action: 'finance.void_charge', p_target: charge.id, p_payload: { charge_id: charge.id, reason: 'Fee charged in error' }, p_note: null, p_expires_in_hours: 24 };
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => pg.call(w.staff, 'request_approval', proposal)));
    expect(tally(codes(rs))).toEqual({ ok: 10 });
    expect(new Set(rs.map((x) => (x as PromiseFulfilledResult<any>).value.id)).size).toBe(1);
    expect(await num(`select count(*) n from public.approvals where target_id = $1 and status in ('pending','approved','executing')`, [charge.id])).toBe(1);
    expect(await num(`select count(*) n from public.notifications where event_type = 'approval.requested' and link like $1`, [`%${rs[0]!.status === 'fulfilled' ? (rs[0] as any).value.id : ''}%`])).toBe(4);   // each approver told once (manager, manager2, admin, owner)
  });

  it('racing estimate revisions leave exactly one current estimate with exactly one matching live approval', async () => {
    const { wo } = await pendingCost(10000);
    const rs = await Promise.allSettled([20000, 30000, 40000, 50000, 60000].map((amount) => pg.call(w.staff, 'submit_estimate', { p_org: w.org, p_work_order: wo, p_amount_minor: amount, p_note: null })));
    expect(tally(codes(rs))).toEqual({ ok: 5 });
    expect(await num(`select count(*) n from public.work_order_estimates where work_order_id = $1 and superseded_at is null`, [wo])).toBe(1);
    const live = (await pg.admin.query(`select a.payload, e.amount_minor from public.approvals a join public.work_orders w on w.id = a.target_id join public.work_order_estimates e on e.id = w.current_estimate_id
                                         where a.target_id = $1 and a.status in ('pending','approved','executing')`, [wo])).rows;
    expect(live).toHaveLength(1);
    expect(Number(live[0].payload.amount_minor)).toBe(Number(live[0].amount_minor));            // the approval is for the estimate that is actually current
  });
});

describe('escalation under contention', () => {
  it('concurrent critical signals escalate a request exactly once', async () => {
    const levels = (await pg.call(w.staff, 'list_urgency_levels', { p_org: w.org })) as any[];
    const emergency = levels.find((l) => l.key === 'emergency').id;
    const r = await newRequest({ p_title: 'Dripping tap' });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => pg.call(w.staff, 'set_suggested_urgency', { p_org: w.org, p_request: r.id, p_urgency: emergency, p_source: `classifier-${i}` })));
    expect(tally(codes(rs))).toEqual({ ok: 10 });
    const row = (await pg.admin.query(`select escalation_required, escalated_at from public.maintenance_requests where id = $1`, [r.id])).rows[0];
    expect(row.escalation_required).toBe(true);
    expect(await num(`select count(*) n from public.maintenance_notes where request_id = $1 and body like 'ESCALATED%'`, [r.id])).toBe(1);
    expect(await num(`select count(*) n from public.notifications where event_type = 'maintenance.escalated' and dedupe_key = $1`, ['mr:' + r.id + ':esc:0'])).toBe(2);   // owner + admin (no designated contact)
  });
});

describe('copilot under parallel load', () => {
  it('only one model turn can hold a conversation; the rest are refused', async () => {
    const c = await pg.call(w.staff, 'create_copilot_conversation', { p_org: w.org });
    const rs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => pg.svcCall('copilot_svc_begin_turn', { p_org: w.org, p_user: w.staff.sub, p_conversation: c.id, p_request_id: `r${i}` })));
    expect(tally(codes(rs))).toEqual({ ok: 1, PT409: 7 });
    await pg.svcCall('copilot_svc_end_turn', { p_org: w.org, p_conversation: c.id });
  });
  it('identical proposals made at once collapse into one, and submitting twice creates one approval', async () => {
    const note = `parallel ${key().slice(0, 6)}`;
    const ps = await Promise.all(Array.from({ length: 8 }, () => pg.svcCall('copilot_svc_propose_action', { p_org: w.org, p_user: w.staff.sub, p_conversation: null, p_kind: 'test_action', p_payload: { note } })));
    expect(new Set(ps.map((p: any) => p.id)).size).toBe(1);
    expect(await num(`select count(*) n from public.copilot_actions where payload ->> 'note' = $1`, [note])).toBe(1);
    const id = ps[0].id as string;
    const subs = await Promise.allSettled(Array.from({ length: 6 }, () => pg.call(w.staff, 'copilot_submit_action', { p_org: w.org, p_action: id })));
    expect(codes(subs).every((c) => c === 'ok')).toBe(true);
    expect(await num(`select count(*) n from public.approvals where target_id = $1`, [id])).toBe(1);
  });
  it('two managers approving the same AI action at once execute it exactly once', async () => {
    const note = `race ${key().slice(0, 6)}`;
    const p = await pg.svcCall('copilot_svc_propose_action', { p_org: w.org, p_user: w.staff.sub, p_conversation: null, p_kind: 'test_action', p_payload: { note } });
    const s = await pg.call(w.staff, 'copilot_submit_action', { p_org: w.org, p_action: p.id });
    await Promise.allSettled([w.manager, w.manager2, w.manager, w.manager2].map((m) => pg.call(m, 'decide_approval', { p_org: w.org, p_approval: s.approval_id, p_decision: 'approve', p_note: null })));
    expect(await num(`select count(*) n from public.copilot_test_log where note = $1`, [note])).toBe(1);
    expect(await num(`select count(*) n from public.approvals where id = $1 and status = 'executed'`, [s.approval_id])).toBe(1);
  });
});
