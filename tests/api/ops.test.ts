import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRON_SECRET, startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '5000' }); });
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const ok = async (p: Promise<any>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const idem = (c: Client, url: string, body: object, key = randomUUID()) => c.post(url).set('Idempotency-Key', key).send(body);

async function setup() {
  const org = await t.newOrg();
  const manager = await t.addMember(org, 'manager');
  const staff = await t.addMember(org, 'staff');
  const viewer = await t.addMember(org, 'viewer');
  const admin = await t.addMember(org, 'admin');
  const base = org.base;
  const prop = await ok(manager.post(`${base}/properties`).send({ name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' }), 201);
  const unit = await ok(manager.post(`${base}/properties/${prop.id}/units`).send({ reference: '1A' }), 201);
  const tenantEmail = `tenant-${randomUUID().slice(0, 8)}@mail.test`;
  const tenant = await ok(staff.post(`${base}/tenants`).send({ fullName: 'Tina Tenant', email: tenantEmail }), 201);
  const tn = await ok(staff.post(`${base}/tenancies`).send({ unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 }), 201);
  await ok(manager.post(`${base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
  const me = async (c: Client) => (await ok(c.get('/api/me'))).profile;
  return { org, base, owner: org.c, manager, staff, viewer, admin, prop, unit, tenant, tenantEmail, tenancy: tn.id as string,
    ids: { manager: (await me(manager)).id as string, staff: (await me(staff)).id as string, admin: (await me(admin)).id as string } };
}
type W = Awaited<ReturnType<typeof setup>>;
const request = (w: W, c: Client = w.staff, over: object = {}) => ok(c.post(`${w.base}/maintenance`).send({ property: w.prop.id, unit: w.unit.id, title: 'Kitchen tap dripping', description: 'The cold tap drips constantly.', category: 'plumbing', ...over }), 201);
const runJobs = (secret: string | null = CRON_SECRET, qs = '') => { const r = supertest(t.app).get(`/api/internal/jobs/run${qs}`); return secret ? r.set('Authorization', `Bearer ${secret}`) : r; };

describe('acceptance: a manager submits, tracks and approves through the persistent inbox', () => {
  it('runs the whole workflow and notifies the right people', async () => {
    const w = await setup();
    const r = await request(w);
    expect(r).toMatchObject({ status: 'submitted', reported_via: 'staff', escalation_required: false });

    // the manager is told, in-app and (after the worker runs) by email
    const feed = await ok(w.manager.get('/api/me/notifications'));
    expect(feed.unread).toBeGreaterThanOrEqual(1);
    expect(feed.items.map((n: any) => n.event_type)).toContain('maintenance.submitted');
    expect((await ok(w.staff.get('/api/me/notifications'))).items.map((n: any) => n.event_type)).not.toContain('maintenance.submitted');

    // staff assign themselves with an estimate that needs approval
    const assigned = await ok(w.staff.post(`${w.base}/maintenance/${r.id}/work-orders`).send({ assignee: w.ids.staff, scope: 'Replace the washer', estimateMinor: 8500, estimateNote: 'quote 17' }), 201);
    expect(assigned.status).toBe('awaiting_approval');
    const wo = assigned.work_orders[0];
    expect(wo.approval.status).toBe('pending');

    // the persistent inbox
    const inbox = await ok(w.manager.get(`${w.base}/approvals?scope=inbox`));
    expect(inbox).toMatchObject({ total: 1, pending_for_me: 1 });
    expect(inbox.items[0]).toMatchObject({ action_type: 'maintenance.approve_cost', status: 'pending', can_decide: true, requested_by: expect.any(String) });
    expect(inbox.items[0].payload).toMatchObject({ amount_minor: 8500, currency: 'USD' });
    expect((await w.staff.post(`${w.base}/approvals/${inbox.items[0].id}/decision`).send({ decision: 'approve' })).status).toBe(403);   // requester/staff cannot
    const decided = await ok(w.manager.post(`${w.base}/approvals/${inbox.items[0].id}/decision`).send({ decision: 'approve', note: 'ok' }));
    expect(decided).toMatchObject({ ok: true, status: 'executed', result: { approved_cost_minor: 8500 } });
    expect((await ok(w.manager.get(`${w.base}/approvals?scope=inbox`))).items).toEqual([]);                                 // out of the inbox once decided
    expect((await ok(w.manager.get(`${w.base}/approvals?scope=all&status=executed`))).total).toBe(1);

    // the work proceeds
    await ok(w.staff.post(`${w.base}/work-orders/${wo.id}/start`).send({}));
    await ok(w.staff.post(`${w.base}/work-orders/${wo.id}/complete`).send({ actualCostMinor: 8200, notes: 'washer replaced' }));
    const cur = await ok(w.staff.get(`${w.base}/maintenance/${r.id}`));
    const done = await ok(w.staff.post(`${w.base}/maintenance/${r.id}/resolve`).send({ expectedVersion: cur.version, resolutionNotes: 'Replaced the washer; no more drips.' }));
    expect(done.status).toBe('resolved');
    expect(done.history.map((h: any) => h.to_status)).toEqual(['submitted', 'triaged', 'awaiting_approval', 'assigned', 'in_progress', 'resolved']);
    expect((await ok(w.manager.get(`${w.base}/maintenance?status=resolved`))).total).toBe(1);

    // delivery: the scheduler's worker sends what was queued
    const before = t.email.sent.length;
    const run = await ok(runJobs());
    expect(run.email.sent).toBeGreaterThan(0);
    const mine = t.email.sent.slice(before);
    expect(mine.length).toBe(run.email.sent);
    expect(mine.some((m) => /Approval needed/.test(m.subject))).toBe(true);
    expect(mine.every((m) => m.idempotencyKey.startsWith('email-'))).toBe(true);
    expect((await ok(runJobs())).email.claimed).toBe(0);                                                                      // nothing left, nothing re-sent
  });
});

describe('roles over HTTP', () => {
  it('enforces who may read, write, assign, configure and see delivery', async () => {
    const w = await setup();
    const r = await request(w);
    for (const path of ['/maintenance', `/maintenance/${r.id}`, '/vendors', '/approvals?scope=mine', '/maintenance-settings']) expect((await w.viewer.get(`${w.base}${path}`)).status, `viewer ${path}`).toBe(403);
    expect((await w.viewer.post(`${w.base}/maintenance`).send({ property: w.prop.id, title: 'Nope nope', description: 'x' })).status).toBe(403);
    // staff may assign only themselves
    expect((await w.staff.post(`${w.base}/maintenance/${r.id}/work-orders`).send({ assignee: w.ids.manager, scope: 'x' })).status).toBe(403);
    expect((await w.manager.post(`${w.base}/maintenance/${r.id}/work-orders`).send({ assignee: w.ids.staff, scope: 'Fix the tap' })).status).toBe(201);
    // only managers: vendors, urgency levels, email queue, jobs, reopen, acknowledge; only admins: settings
    expect((await w.staff.post(`${w.base}/vendors`).send({ name: 'HeatCo' })).status).toBe(403);
    expect((await w.manager.post(`${w.base}/vendors`).send({ name: 'HeatCo', email: 'hal@heatco.test', categories: ['plumbing'] })).status).toBe(201);
    expect((await w.staff.get(`${w.base}/vendors`)).status).toBe(200);
    expect((await w.staff.get(`${w.base}/email-queue`)).status).toBe(403);
    expect((await w.manager.get(`${w.base}/email-queue`)).status).toBe(200);
    expect((await w.staff.post(`${w.base}/jobs/run`).send({})).status).toBe(403);
    expect((await w.manager.post(`${w.base}/jobs/run`).send({})).status).toBe(200);
    const settings = { escalationUser: w.ids.manager, backupUser: null, criticalKeywords: ['gas leak', 'flooding'], ackHours: 2, approvalThresholds: { USD: 5000 }, allowSelfApproval: false };
    expect((await w.manager.put(`${w.base}/maintenance-settings`).send(settings)).status).toBe(403);
    expect((await w.admin.put(`${w.base}/maintenance-settings`).send(settings)).status).toBe(200);
    expect((await w.staff.get(`${w.base}/maintenance-settings`)).body.approval_thresholds).toEqual({ USD: 5000 });
    expect((await w.staff.post(`${w.base}/maintenance/${r.id}/acknowledge`).send({})).status).toBe(403);
    const ws = await ok(w.staff.get(`${w.base}/workspace`));
    expect(ws.permissions).toEqual(expect.arrayContaining(['maintenance:write', 'approvals:request']));
    expect(ws.permissions).not.toEqual(expect.arrayContaining(['approvals:decide', 'maintenance:settings']));
  });
});

describe('validation', () => {
  it('rejects malformed input with per-field errors, never reaching the database', async () => {
    const w = await setup();
    const bad = async (c: Client, path: string, body: object, field: string) => {
      const r = await c.post(`${w.base}${path}`).set('Idempotency-Key', randomUUID()).send(body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(422);
      expect(r.body.error.details.map((d: any) => d.path)).toContain(field);
    };
    await bad(w.staff, '/maintenance', { property: w.prop.id, title: 'x', description: 'ok' }, 'title');
    await bad(w.staff, '/maintenance', { property: 'nope', title: 'Fine title', description: 'ok' }, 'property');
    await bad(w.staff, '/maintenance', { property: w.prop.id, title: 'Fine title', description: '' }, 'description');
    await bad(w.staff, '/maintenance', { property: w.prop.id, title: 'Fine title', description: 'ok', category: 'dragons' }, 'category');
    const r = await request(w);
    await bad(w.manager, `/maintenance/${r.id}/work-orders`, { vendor: randomUUID(), assignee: w.ids.staff, scope: 'x' }, 'assignee');
    await bad(w.manager, `/maintenance/${r.id}/work-orders`, { scope: 'x' }, 'assignee');
    await bad(w.manager, `/maintenance/${r.id}/work-orders`, { assignee: w.ids.staff, scope: 'x', estimateMinor: 12.5 }, 'estimateMinor');
    await bad(w.manager, `/maintenance/${r.id}/cancel`, { expectedVersion: 1, reason: '' }, 'reason');
    await bad(w.manager, `/maintenance/${r.id}/resolve`, { expectedVersion: 1, resolutionNotes: 'x' }, 'resolutionNotes');
    await bad(w.manager, '/vendors', { name: '' }, 'name');
    await bad(w.manager, '/urgency-levels', { key: 'Bad Key', label: 'x', rank: 5 }, 'key');
    await bad(w.manager, '/approvals', { action: 'delete.everything', target: randomUUID(), payload: {} }, 'action');
    expect((await w.staff.get(`${w.base}/maintenance?bogus=1`)).status).toBe(422);
    expect((await w.staff.get(`${w.base}/maintenance?status=weird`)).status).toBe(422);
    expect((await w.staff.get(`${w.base}/maintenance?limit=999`)).status).toBe(422);
    expect((await w.staff.get(`${w.base}/maintenance/not-a-uuid`)).status).toBe(422);
    expect((await w.manager.get(`${w.base}/email-queue?status=bogus`)).status).toBe(422);
  });
});

describe('cross-organization isolation', () => {
  it('another organization cannot read or act on anything', async () => {
    const a = await setup(); const b = await setup();
    const r = await request(a);
    const assigned = await ok(a.staff.post(`${a.base}/maintenance/${r.id}/work-orders`).send({ assignee: a.ids.staff, scope: 'x', estimateMinor: 9000 }), 201);
    const approval = assigned.work_orders[0].approval.id;
    const wo = assigned.work_orders[0].id;
    for (const path of ['/maintenance', `/maintenance/${r.id}`, '/vendors', '/approvals?scope=all', `/approvals/${approval}`, '/email-queue', '/jobs', '/maintenance-settings', '/urgency-levels']) {
      const viaA = await b.manager.get(`${a.base}${path}`);
      expect(viaA.status, `B → A ${path}`).toBe(404);
    }
    for (const path of [`/maintenance/${r.id}`, `/approvals/${approval}`]) expect((await b.manager.get(`${b.base}${path}`)).status, `B own org, A id ${path}`).toBe(404);
    for (const [path, body] of [[`/approvals/${approval}/decision`, { decision: 'approve' }], [`/work-orders/${wo}/cancel`, { reason: 'hostile cancel' }], [`/maintenance/${r.id}/cancel`, { expectedVersion: 1, reason: 'hostile' }],
      [`/maintenance/${r.id}/notes`, { body: 'hello' }]] as const) {
      for (const base of [a.base, b.base]) expect([404, 422], `${base === a.base ? 'A' : 'B'} ${path}`).toContain((await b.manager.post(`${base}${path}`).send(body)).status);
    }
    expect((await ok(a.manager.get(`${a.base}/approvals?scope=all`))).items[0].status).toBe('pending');
    expect((await ok(a.manager.get(`${a.base}/maintenance/${r.id}`))).status).toBe('awaiting_approval');
  });
});

describe('critical escalation over HTTP', () => {
  it('escalates immediately, emails the designated human at once, and cannot be silenced by the requester', async () => {
    const x = await startTestApp({ EMAIL_INLINE_DELIVERY: 'true' });
    try {
      const org = await x.newOrg();
      const manager = await x.addMember(org, 'manager');
      const staff = await x.addMember(org, 'staff');
      const admin = await x.addMember(org, 'admin');
      const prop = await ok(manager.post(`${org.base}/properties`).send({ name: 'P', addressLine1: '1 A St', city: 'X', country: 'US', timezone: 'UTC', currency: 'USD' }), 201);
      const mid = (await ok(manager.get('/api/me'))).profile;
      await ok(admin.put(`${org.base}/maintenance-settings`).send({ escalationUser: mid.id, backupUser: null, criticalKeywords: ['gas leak'], ackHours: 2, approvalThresholds: {}, allowSelfApproval: false }));
      const levels = await ok(staff.get(`${org.base}/urgency-levels`));
      const low = levels.find((l: any) => l.key === 'low').id;
      // a calm-sounding request that mentions a safety keyword, filed as LOW urgency
      const r = await ok(staff.post(`${org.base}/maintenance`).send({ property: prop.id, title: 'Smell of a gas leak', description: 'Strong smell near the stove.', urgency: low }), 201);
      expect(r).toMatchObject({ escalation_required: true, safety_flag: true, escalated_to: mid.id });
      expect(x.email.sent.some((m) => m.to === mid.email && /^CRITICAL:/.test(m.subject))).toBe(true);                   // delivered within the request
      expect((await ok(manager.get(`${org.base}/maintenance?attention=true`))).attention).toBe(1);
      await ok(staff.post(`${org.base}/maintenance/${r.id}/suggested-urgency`).send({ urgency: low, source: 'classifier' }));        // a "it's fine" suggestion changes nothing
      expect(await ok(manager.get(`${org.base}/maintenance/${r.id}`))).toMatchObject({ escalation_required: true });
      expect((await ok(manager.post(`${org.base}/maintenance/${r.id}/acknowledge`).send({}))).escalation_ack_at).not.toBeNull();
    } finally { await x.close(); }
  });
});

describe('scheduled jobs endpoint and email delivery', () => {
  it('is closed to everyone but the scheduler', async () => {
    expect((await runJobs(null)).status).toBe(401);
    expect((await runJobs('wrong-secret-wrong-secret-wrong-secret')).status).toBe(401);
    const w = await setup();
    expect((await w.manager.get('/api/internal/jobs/run')).status).toBe(401);   // a signed-in user's session is not a credential
    const off = await startTestApp({ CRON_SECRET: undefined as any, SUPABASE_SERVICE_ROLE_KEY: undefined as any });
    try { expect((await supertest(off.app).get('/api/internal/jobs/run').set('Authorization', `Bearer ${CRON_SECRET}`)).status).toBe(503); } finally { await off.close(); }
  });

  it('retries transient failures with backoff, gives up on permanent ones, and shows failures to managers who can retry', async () => {
    const w = await setup();
    await request(w);                                                                               // queues several manager+ emails
    await runJobs(CRON_SECRET, '?only=email');                                                       // flush anything older
    const queue = () => ok(w.manager.get(`${w.base}/email-queue?limit=100`));
    const baseline = (await queue()).total;
    const staffAssign = await request(w, w.staff, { title: 'Another job' });
    expect((await queue()).total).toBeGreaterThan(baseline);
    t.email.failNext('transient', 'permanent');
    const r1 = await ok(runJobs(CRON_SECRET, '?only=email'));
    expect(r1.email).toMatchObject({ retrying: 1, dead: 1 });
    const q1 = await queue();
    expect(q1.counts.failed).toBe(1);
    expect(q1.counts.dead).toBe(1);
    const failed = q1.items.find((e: any) => e.status === 'failed');
    const dead = q1.items.find((e: any) => e.status === 'dead');
    expect(failed).toMatchObject({ attempts: 1, last_error: 'provider 503: try later' });
    expect(dead).toMatchObject({ attempts: 1, last_error: 'provider 422: invalid recipient' });
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now());                    // backoff: not retried immediately
    expect((await ok(runJobs(CRON_SECRET, '?only=email'))).email.claimed).toBe(0);
    // once due, the transient one goes out; the dead one stays dead until a human requeues it
    await t.mock.db.query(`update public.email_queue set next_attempt_at = now() - interval '1 second' where id = $1`, [failed.id]);
    expect((await ok(runJobs(CRON_SECRET, '?only=email'))).email.sent).toBe(1);
    expect((await queue()).counts.dead).toBe(1);
    expect((await w.staff.post(`${w.base}/email-queue/${dead.id}/requeue`).send({})).status).toBe(403);
    await ok(w.manager.post(`${w.base}/email-queue/${dead.id}/requeue`).send({}));
    expect((await ok(runJobs(CRON_SECRET, '?only=email'))).email.sent).toBe(1);
    expect((await queue()).counts).toMatchObject({ sent: expect.any(Number) });
    expect((await queue()).counts.dead).toBeUndefined();
    void staffAssign;
  });

  it('a transient provider outage never loses mail: everything is delivered once the provider recovers', async () => {
    const w = await setup();
    await request(w, w.staff, { title: 'Outage test' });
    await runJobs(CRON_SECRET, '?only=email');
    await request(w, w.staff, { title: 'Outage test two' });
    const pending = (await ok(w.manager.get(`${w.base}/email-queue?status=queued`))).total;
    expect(pending).toBeGreaterThan(0);
    t.email.failNext(...Array(pending).fill('transient'));
    const down = await ok(runJobs(CRON_SECRET, '?only=email'));
    expect(down.email.retrying).toBe(pending);
    expect(down.email.sent).toBe(0);
    await t.mock.db.query(`update public.email_queue set next_attempt_at = now() - interval '1 second' where status = 'failed' and org_id = $1`, [w.org.orgId]);
    const up = await ok(runJobs(CRON_SECRET, '?only=email'));
    expect(up.email.sent).toBe(pending);
    expect((await ok(w.manager.get(`${w.base}/email-queue`))).counts.failed).toBeUndefined();
  });

  it('the reminder job is safe to run repeatedly: rent reminders are queued once', async () => {
    const w = await setup();
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await ok(idem(w.manager, `${w.base}/tenancies/${w.tenancy}/charges`, { kind: 'rent', description: 'Rent due soon', dueDate: day(2), amountMinor: 150000 }), 201);
    const first = await ok(runJobs());
    const created = Object.values<any>(first.jobs).reduce((n, byJob: any) => n + (byJob.rent_due_reminders?.created ?? 0), 0);
    expect(created).toBeGreaterThanOrEqual(1);
    const second = await ok(runJobs());
    expect(Object.values<any>(second.jobs).every((byJob: any) => Object.values<any>(byJob).every((j: any) => (j.created ?? 0) === 0))).toBe(true);
    expect(t.email.sent.filter((m) => m.to === w.tenantEmail && /Rent due soon: 1500\.00 USD/.test(m.subject))).toHaveLength(1);
    expect((await ok(w.manager.get(`${w.base}/jobs`))).some((j: any) => j.job === 'rent_due_reminders' && j.status === 'ok')).toBe(true);
  });
});

describe('tenant portal over HTTP', () => {
  async function portalTenant(w: W) {
    const inv = await ok(w.manager.post(`${w.base}/tenants/${w.tenant.id}/portal-invitations`).send({}), 201);
    const token = (inv.inviteUrl as string).split('token=')[1]!;
    const { c } = await t.signUp(w.tenantEmail);
    return { c, token };
  }

  it('a tenant is verified by invitation, raises a request for their own tenancy, and sees only what is theirs', async () => {
    const w = await setup();
    const { c: tina, token } = await portalTenant(w);
    expect((await tina.get(`${w.base}/maintenance`)).status).toBe(404);                             // not an org member: staff API is closed
    expect((await ok(tina.get('/api/me'))).memberships).toEqual([]);
    const stranger = await t.signUp();
    expect((await stranger.c.post('/api/portal/invitations/accept').send({ token })).status).toBe(404);   // wrong person, even with the token
    expect((await ok(tina.post('/api/portal/invitations/accept').send({ token }))).org_id).toBe(w.org.orgId);
    expect((await tina.post('/api/portal/invitations/accept').send({ token })).status).toBe(404);          // single use
    expect((await ok(tina.get('/api/me'))).tenant_links).toHaveLength(1);

    const ctx = await ok(tina.get('/api/portal/context'));
    expect(ctx[0].tenancies.map((x: any) => x.unit_reference)).toEqual(['1A']);
    const levels = await ok(tina.get(`/api/portal/orgs/${w.org.orgId}/urgency-levels`));
    const urgent = levels.find((l: any) => l.label === 'Urgent').id;
    const req = await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests`).send({ tenancy: w.tenancy, title: 'Heating not working', description: 'The radiator is cold.', category: 'heating_cooling', urgency: urgent }), 201);
    expect(req).toMatchObject({ status: 'submitted', unit_reference: '1A', can_cancel: true });
    expect(JSON.stringify(req)).not.toMatch(/work_orders|escalat|internal/i);
    expect((await ok(tina.get('/api/portal/requests'))).map((x: any) => x.id)).toEqual([req.id]);
    const staffView = await ok(w.staff.get(`${w.base}/maintenance/${req.id}`));
    expect(staffView).toMatchObject({ reported_via: 'tenant', tenant: { full_name: 'Tina Tenant' } });

    // messages: staff choose what the tenant sees
    await ok(w.staff.post(`${w.base}/maintenance/${req.id}/notes`).send({ body: 'Internal: owner is travelling', visibility: 'internal' }), 201);
    await ok(w.staff.post(`${w.base}/maintenance/${req.id}/notes`).send({ body: 'We will visit tomorrow morning.', visibility: 'tenant' }), 201);
    await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}/notes`).send({ body: 'Thanks, I will be in.' }), 201);
    const view = await ok(tina.get(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}`));
    expect(view.notes.map((n: any) => n.body)).toEqual(['We will visit tomorrow morning.', 'Thanks, I will be in.']);
    expect(JSON.stringify(view)).not.toContain('owner is travelling');
    expect((await ok(tina.get('/api/me/notifications'))).items.map((n: any) => n.event_type)).toContain('maintenance.note');

    // cannot touch other tenancies/orgs, and cannot cancel once work is arranged
    const other = await setup();
    expect((await tina.post(`/api/portal/orgs/${other.org.orgId}/requests`).send({ tenancy: other.tenancy, title: 'Not mine', description: 'x' })).status).toBe(403);
    expect((await tina.get(`/api/portal/orgs/${other.org.orgId}/requests/${req.id}`)).status).toBe(404);
    await ok(w.staff.post(`${w.base}/maintenance/${req.id}/work-orders`).send({ assignee: w.ids.staff, scope: 'Bleed radiator' }), 201);
    const fresh = await ok(tina.get(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}`));
    expect(fresh.can_cancel).toBe(false);
    expect((await tina.post(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}/cancel`).send({ expectedVersion: fresh.version, reason: 'fixed it myself' })).status).toBe(403);
    // another tenant of the same org (no link) has nothing
    const nobody = await t.signUp();
    expect(await ok(nobody.c.get('/api/portal/requests'))).toEqual([]);
    expect((await nobody.c.get('/api/portal/context')).body).toEqual([]);
  });

  it('a tenant can cancel an early request, and the manager can revoke their access', async () => {
    const w = await setup();
    const { c: tina, token } = await portalTenant(w);
    await ok(tina.post('/api/portal/invitations/accept').send({ token }));
    const req = await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests`).send({ tenancy: w.tenancy, title: 'Squeaky door', description: 'It squeaks.' }), 201);
    const gone = await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}/cancel`).send({ expectedVersion: req.version, reason: 'It stopped on its own.' }));
    expect(gone.status).toBe('cancelled');
    const access = await ok(w.manager.get(`${w.base}/tenants/${w.tenant.id}/portal-access`));
    expect(access.users).toHaveLength(1);
    expect((await w.staff.post(`${w.base}/portal-access/${access.users[0].id}/revoke`).send({})).status).toBe(403);
    await ok(w.manager.post(`${w.base}/portal-access/${access.users[0].id}/revoke`).send({}));
    expect((await tina.post(`/api/portal/orgs/${w.org.orgId}/requests`).send({ tenancy: w.tenancy, title: 'Another one', description: 'x' })).status).toBe(403);
    expect((await ok(tina.get('/api/me'))).tenant_links).toEqual([]);
  });

  it('attachments: a tenant uploads a photo privately; staff see it; other tenants and orgs cannot', async () => {
    const w = await setup();
    const { c: tina, token } = await portalTenant(w);
    await ok(tina.post('/api/portal/invitations/accept').send({ token }));
    const req = await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests`).send({ tenancy: w.tenancy, title: 'Mould on wall', description: 'There is mould.' }), 201);
    const photo = Buffer.from('fake-png-bytes');
    const reg = await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}/attachments`).send({ fileName: 'wall.png', mimeType: 'image/png', sizeBytes: photo.length }), 201);
    expect(reg.attachment).not.toHaveProperty('storage_path');
    expect(reg.attachment).toMatchObject({ visibility: 'tenant', uploader_kind: 'tenant' });
    expect((await fetch(reg.upload.url, { method: 'PUT', headers: reg.upload.headers, body: photo })).status).toBe(200);
    await ok(tina.post(`/api/portal/orgs/${w.org.orgId}/attachments/${reg.attachment.id}/confirm`).send({}));
    const dl = await ok(tina.get(`/api/portal/orgs/${w.org.orgId}/attachments/${reg.attachment.id}/download`));
    expect(Buffer.from(await (await fetch(dl.url)).arrayBuffer()).equals(photo)).toBe(true);
    const staffDl = await ok(w.staff.get(`${w.base}/attachments/${reg.attachment.id}/download`));
    expect(staffDl.url).toContain('/object/sign/');
    expect((await ok(w.staff.get(`${w.base}/maintenance/${req.id}`))).attachments).toHaveLength(1);
    expect((await w.viewer.get(`${w.base}/attachments/${reg.attachment.id}/download`)).status).toBe(403);
    const other = await setup();
    expect((await other.staff.get(`${w.base}/attachments/${reg.attachment.id}/download`)).status).toBe(404);
    const stranger = await t.signUp();
    expect((await stranger.c.get(`/api/portal/orgs/${w.org.orgId}/attachments/${reg.attachment.id}/download`)).status).toBe(404);
    expect((await tina.post(`/api/portal/orgs/${w.org.orgId}/requests/${req.id}/attachments`).send({ fileName: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 5 })).status).toBe(422);
  });
});

describe('approvals over HTTP', () => {
  it('lets staff propose a supported action, enforces who decides, and records the execution', async () => {
    const w = await setup();
    const charge = await ok(idem(w.manager, `${w.base}/tenancies/${w.tenancy}/charges`, { kind: 'fee', description: 'Late fee', dueDate: '2026-01-05', amountMinor: 2500 }), 201);
    const proposal = { action: 'finance.void_charge', target: charge.id, payload: { charge_id: charge.id, reason: 'Fee was charged in error' }, note: 'please check' };
    const p = await ok(w.staff.post(`${w.base}/approvals`).send(proposal), 201);
    expect((await ok(w.staff.post(`${w.base}/approvals`).send(proposal), 201)).id).toBe(p.id);                       // same proposal → same approval
    expect((await w.staff.post(`${w.base}/approvals/${p.id}/decision`).send({ decision: 'approve' })).status).toBe(403);
    expect((await w.viewer.get(`${w.base}/approvals/${p.id}`)).status).toBe(403);
    expect((await w.manager.post(`${w.base}/approvals`).send({ ...proposal, payload: { charge_id: charge.id } })).status).toBe(422);   // payload must match what the system expects
    const out = await ok(w.manager.post(`${w.base}/approvals/${p.id}/decision`).send({ decision: 'approve', note: 'agreed' }));
    expect(out).toMatchObject({ ok: true, status: 'executed', result: { charge_id: charge.id, already_void: false } });
    const detail = await ok(w.manager.get(`${w.base}/approvals/${p.id}`));
    expect(detail.events.map((e: any) => e.to_status)).toEqual(['pending', 'approved', 'executing', 'executed']);
    expect(detail).toMatchObject({ execution_key: `approval:${p.id}`, status: 'executed' });
    const ledger = await ok(w.staff.get(`${w.base}/tenancies/${w.tenancy}/ledger`));
    expect(ledger.charges.find((c: any) => c.id === charge.id).status).toBe('void');
  });

  it('a decision on a proposal whose target changed is refused with 409 and nothing is executed', async () => {
    const w = await setup();
    const charge = await ok(idem(w.manager, `${w.base}/tenancies/${w.tenancy}/charges`, { kind: 'fee', description: 'Fee', dueDate: '2026-01-05', amountMinor: 4000 }), 201);
    const p = await ok(w.staff.post(`${w.base}/approvals`).send({ action: 'finance.void_charge', target: charge.id, payload: { charge_id: charge.id, reason: 'Wrong amount' } }), 201);
    await ok(idem(w.admin, `${w.base}/charges/${charge.id}/adjustments`, { amountMinor: -1000, reason: 'partial waiver' }), 201);
    const r = await w.manager.post(`${w.base}/approvals/${p.id}/decision`).send({ decision: 'approve' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, status: 'invalidated' });
    expect((await ok(w.staff.get(`${w.base}/tenancies/${w.tenancy}/ledger`))).charges.find((c: any) => c.id === charge.id).status).not.toBe('void');
  });
});
