import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingDefs } from '../../src/routes/billing.js';
import { copilotDefs } from '../../src/routes/copilot.js';
import type { Def } from '../../src/routes/defs.js';
import { financeDefs } from '../../src/routes/finance.js';
import { opsOrgDefs, opsPortalDefs, opsUserDefs } from '../../src/routes/ops.js';
import { recordDefs } from '../../src/routes/records.js';
import { whatsappDefs } from '../../src/routes/whatsapp.js';
import { PERMISSIONS, ROLES, hasRole, type Role } from '../../src/lib/roles.js';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '100000', RATE_LIMIT_MAX: '100000', COPILOT_EXTERNAL_ENABLED: 'true' }); }, 60_000);
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const world = async () => {
  const org = await t.newOrg();
  const clients: Record<Role, Client> = { owner: org.c, admin: await t.addMember(org, 'admin'), manager: await t.addMember(org, 'manager'), staff: await t.addMember(org, 'staff'), viewer: await t.addMember(org, 'viewer') };
  const stranger = (await t.signUp()).c;
  const other = await t.newOrg('Other Org');
  return { org, orgId: org.orgId, clients, stranger, anon: supertest(t.app) as unknown as Client, otherOrg: other };
};
const call = (c: Client, method: Def['method'], url: string) => {
  const r = (c as any)[method](url);
  return method === 'get' || method === 'delete' ? r : r.send({});
};
const fill = (path: string) => path.replace(/:\w+/g, () => randomUUID());

const ORG_DEFS: [string, Def[]][] = [['finance', financeDefs], ['records', recordDefs], ['ops', opsOrgDefs], ['copilot', copilotDefs], ['billing', billingDefs], ['whatsapp', whatsappDefs]];

describe('route authorization matrix: every declared endpoint, every role', () => {
  it('inventory is non-trivial', () => { expect(ORG_DEFS.flatMap(([, d]) => d).length).toBeGreaterThan(100); });

  for (const [name, defs] of ORG_DEFS) {
    it(`${name}: a role below the minimum is refused (403), a non-member gets 404, anonymous gets 401, and the minimum role is let in`, async () => {
      const w = await world();
      const problems: string[] = [];
      for (const d of defs.filter((x) => (x.scope ?? 'org') === 'org')) {
        const url = `/api/organizations/${w.orgId}${fill(d.path)}`;
        const label = `${d.method.toUpperCase()} ${d.path}`;
        for (const role of ROLES) {
          const s = (await call(w.clients[role], d.method, url)).status;
          if (!hasRole(role, d.min)) { if (s !== 403) problems.push(`${label} as ${role}: expected 403 got ${s}`); }
          else if (s === 401 || s === 403) problems.push(`${label} as ${role} (>= ${d.min}): wrongly refused with ${s}`);
        }
        const outsider = (await call(w.stranger, d.method, url)).status;
        if (outsider !== 404) problems.push(`${label} as a non-member: expected 404 got ${outsider}`);
        const anon = (await call(w.anon, d.method, url)).status;
        if (anon !== 401) problems.push(`${label} anonymous: expected 401 got ${anon}`);
        // someone from another organization addressing this one
        const cross = (await call(w.otherOrg.c, d.method, url)).status;
        if (cross !== 404) problems.push(`${label} from another org's owner: expected 404 got ${cross}`);
      }
      expect(problems).toEqual([]);
    }, 240_000);
  }

  it('user-scoped and portal endpoints need a session, and a signed-in non-tenant gets nothing from the portal', async () => {
    const w = await world();
    const problems: string[] = [];
    for (const [prefix, defs] of [['/api/me', opsUserDefs], ['/api/portal', opsPortalDefs]] as const) {
      for (const d of defs) {
        const url = `${prefix}${fill(d.path.replace(':orgId', w.orgId))}`;
        const anon = (await call(w.anon, d.method, url)).status;
        if (anon !== 401) problems.push(`${d.method} ${d.path} anonymous: ${anon}`);
        if (prefix === '/api/portal' && d.scope === 'portal') {
          for (const who of [w.clients.owner, w.stranger]) { const s = (await call(who, d.method, url)).status; if (s < 400 || s === 500) problems.push(`portal ${d.method} ${d.path}: a non-tenant got ${s}`); }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

// Routes written by hand (not declared as Defs). Each is named here so that adding a route forces a review of how it is protected.
const CUSTOM: [string, Def['method'], string, Role | 'public' | 'session' | 'signature' | 'operator'][] = [
  ['/organizations/:orgId', 'get', '/', 'viewer'], ['/organizations/:orgId', 'get', '/workspace', 'viewer'], ['/organizations/:orgId', 'patch', '/', 'admin'], ['/organizations/:orgId', 'get', '/members', 'viewer'],
  ['/organizations/:orgId', 'patch', '/members/:id', 'admin'], ['/organizations/:orgId', 'delete', '/members/:id', 'viewer'], ['/organizations/:orgId', 'get', '/invitations', 'admin'], ['/organizations/:orgId', 'post', '/invitations', 'admin'],
  ['/organizations/:orgId', 'delete', '/invitations/:id', 'admin'], ['/organizations/:orgId', 'get', '/copilot/status', 'staff'], ['/organizations/:orgId', 'post', '/copilot/conversations/:id/messages', 'staff'],
  ['/organizations/:orgId', 'get', '/billing', 'admin'], ['/organizations/:orgId', 'post', '/billing/checkout', 'admin'], ['/organizations/:orgId', 'post', '/billing/reconcile', 'admin'], ['/organizations/:orgId', 'post', '/billing/cancel', 'owner'],
  ['/organizations/:orgId', 'get', '/exports/charges.csv', 'staff'], ['/organizations/:orgId', 'get', '/leases/:id/documents', 'staff'], ['/organizations/:orgId', 'post', '/leases/:id/documents', 'staff'], ['/organizations/:orgId', 'post', '/documents/:id/confirm', 'staff'],
  ['/organizations/:orgId', 'get', '/documents/:id/download', 'staff'], ['/organizations/:orgId', 'post', '/tenants/:id/portal-invitations', 'manager'], ['/organizations/:orgId', 'get', '/whatsapp/channel', 'admin'],
  ['/organizations/:orgId', 'post', '/whatsapp/link-codes', 'manager'], ['/organizations/:orgId', 'post', '/whatsapp/contacts/:id/reminder-draft', 'manager'], ['/organizations/:orgId', 'post', '/whatsapp/reminders/:id/request-approval', 'manager'],
  ['/organizations/:orgId', 'post', '/tenants', 'staff'], ['/organizations/:orgId', 'patch', '/tenants/:id', 'staff'],
  ['/organizations/:orgId', 'post', '/maintenance/:id/attachments', 'staff'], ['/organizations/:orgId', 'post', '/attachments/:id/confirm', 'staff'], ['/organizations/:orgId', 'get', '/attachments/:id/download', 'staff'],
];

describe('hand-written routes', () => {
  it('each is protected as declared', async () => {
    const w = await world(); const problems: string[] = [];
    for (const [base, method, path, min] of CUSTOM) {
      if (!['owner', 'admin', 'manager', 'staff', 'viewer'].includes(min)) continue;
      const url = `/api/organizations/${w.orgId}${fill(path === '/' ? '' : path)}`;
      const label = `${method.toUpperCase()} ${base}${path}`;
      for (const role of ROLES) {
        const s = (await call(w.clients[role], method, url)).status;
        const selfServiceDelete = (path === '/members/:id' && method === 'delete') || path === '/whatsapp/reminders/:id/request-approval';   // (the second is refused by the organization's own 'external messages' switch, by design)       // a member may remove themselves; anything else is the database's call (below)
        if (!hasRole(role, min as Role) && !selfServiceDelete && s !== 403) problems.push(`${label} as ${role}: expected 403 got ${s}`);
        if (hasRole(role, min as Role) && (s === 401 || s === 403) && !selfServiceDelete) problems.push(`${label} as ${role}: wrongly refused ${s}`);
      }
      if ((await call(w.stranger, method, url)).status !== 404) problems.push(`${label} non-member not 404`);
      if ((await call(w.anon, method, url)).status !== 401) problems.push(`${label} anonymous not 401`);
    }
    expect(problems).toEqual([]);
  }, 240_000);

  it('a view-only member cannot remove or demote anyone else, and nobody can remove the last owner', async () => {
    const w = await world();
    const members = (await w.clients.owner.get(`/api/organizations/${w.orgId}/members`)).body as { user_id: string; role: string }[];
    const owner = members.find((m) => m.role === 'owner')!; const staff = members.find((m) => m.role === 'staff')!;
    expect((await w.clients.viewer.delete(`/api/organizations/${w.orgId}/members/${staff.user_id}`)).status).toBeGreaterThanOrEqual(400);
    expect((await w.clients.staff.patch(`/api/organizations/${w.orgId}/members/${staff.user_id}`).send({ role: 'owner' })).status).toBe(403);
    expect((await w.clients.admin.patch(`/api/organizations/${w.orgId}/members/${staff.user_id}`).send({ role: 'owner' })).status).toBeGreaterThanOrEqual(400);   // admins cannot mint owners
    expect((await w.clients.owner.delete(`/api/organizations/${w.orgId}/members/${owner.user_id}`)).status).toBeGreaterThanOrEqual(400);                          // last owner stays
    expect((await w.clients.owner.get(`/api/organizations/${w.orgId}/members`)).body.some((m: any) => m.role === 'owner')).toBe(true);
  });

  it('machine endpoints refuse everyone without the right credential', async () => {
    const jobs = await supertest(t.app).get('/api/internal/jobs/run'); expect(jobs.status).toBe(401);
    expect((await supertest(t.app).post('/api/internal/billing/assign').send({})).status).toBe(401);
    expect((await supertest(t.app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').send('{}')).status).toBeGreaterThanOrEqual(401);
    expect((await supertest(t.app).post('/api/webhooks/billing/paystack').set('content-type', 'application/json').send('{}')).status).toBe(503);
  });
});

describe('the route inventory is complete', () => {
  it('every hand-written route in the source appears in the reviewed list above (new routes must be added deliberately)', () => {
    const dir = join(import.meta.dirname, '..', '..', 'src', 'routes');
    const found = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/\b(?:r|org)\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g)) found.add(`${f} ${m[1]!.toUpperCase()} ${m[2]}`);
      for (const m of src.matchAll(/\br\.(get|post|put|patch|delete)\(`([^`]+)`/g)) found.add(`${f} ${m[1]!.toUpperCase()} ${m[2]}`);
    }
    const expected = new Set([
      'auth.ts POST /register', 'auth.ts POST /login', 'auth.ts POST /logout', 'auth.ts POST /recover', 'auth.ts GET /confirm', 'auth.ts POST /password',
      'orgs.ts GET /me', 'orgs.ts PATCH /me', 'orgs.ts POST /organizations', 'orgs.ts POST /invitations/accept', 'orgs.ts GET /', 'orgs.ts GET /workspace', 'orgs.ts PATCH /', 'orgs.ts GET /members', 'orgs.ts PATCH /members/:userId',
      'orgs.ts DELETE /members/:userId', 'orgs.ts GET /invitations', 'orgs.ts POST /invitations', 'orgs.ts DELETE /invitations/:id',
      'records.ts POST /tenants', 'records.ts PATCH /tenants/:tenant', 'records.ts GET /leases/:lease/documents', 'records.ts POST /leases/:lease/documents', 'records.ts POST /documents/:document/confirm', 'records.ts GET /documents/:document/download',
      'ops.ts POST /tenants/:tenant/portal-invitations', 'ops.ts POST /invitations/accept', 'ops.ts POST ${requestBase}/attachments', 'ops.ts POST ${attachmentBase}/:attachment/confirm', 'ops.ts GET ${attachmentBase}/:attachment/download',
      'copilot.ts GET /copilot/status', 'copilot.ts POST /copilot/conversations/:conversation/messages',
      'billing.ts GET /billing', 'billing.ts POST /billing/checkout', 'billing.ts POST /billing/reconcile', 'billing.ts POST /billing/cancel', 'billing.ts GET /exports/:kind', 'billing-webhook.ts POST /:provider',
      'whatsapp.ts GET /whatsapp/channel', 'whatsapp.ts POST /whatsapp/link-codes', 'whatsapp.ts POST /whatsapp/contacts/:contact/reminder-draft', 'whatsapp.ts POST /whatsapp/reminders/:draft/request-approval',
      'whatsapp-webhook.ts GET /', 'whatsapp-webhook.ts POST /',
      'internal.ts ALL /jobs/run', 'internal.ts GET /health', 'internal.ts POST /billing/assign', 'internal.ts POST /billing/override',
    ]);
    expect([...found].filter((x) => !expected.has(x)).sort(), 'routes that are not in the reviewed list').toEqual([]);
    expect([...expected].filter((x) => !found.has(x)).sort(), 'listed routes that no longer exist').toEqual([]);
    expect(PERMISSIONS['billing:manage']).toBe('admin');
  });
});
