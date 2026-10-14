import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeNext } from '../../web/js/api.js';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '100000', RATE_LIMIT_MAX: '100000', RATE_LIMIT_AUTH_MAX: '100000' }); }, 60_000);
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const ok = async (p: Promise<any>, status = 200) => { const r = await p; expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const idem = (c: Client, url: string, body: object) => c.post(url).set('Idempotency-Key', randomUUID()).send(body);
const SECRET = 'ZZ-SECRET-OF-ORG-B';

/** Organization B, full of records whose names contain a marker that must never appear in a response to organization A. */
async function victim() {
  const org = await t.newOrg('Victim Org'); const base = org.base;
  const manager = await t.addMember(org, 'manager'); const staff = await t.addMember(org, 'staff');
  const prop = await ok(manager.post(`${base}/properties`).send({ name: `${SECRET} property`, addressLine1: `${SECRET} street`, city: 'Accra', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' }), 201);
  const unit = await ok(manager.post(`${base}/properties/${prop.id}/units`).send({ reference: `${SECRET}-1A` }), 201);
  const tenant = await ok(staff.post(`${base}/tenants`).send({ fullName: `${SECRET} tenant`, email: 'victim@mail.test' }), 201);
  const tn = await ok(staff.post(`${base}/tenancies`).send({ unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 }), 201);
  await ok(manager.post(`${base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
  const charge = await ok(idem(manager, `${base}/tenancies/${tn.id}/charges`, { kind: 'fee', description: `${SECRET} fee`, dueDate: '2026-01-01', amountMinor: 1000 }), 201);
  const req = await ok(staff.post(`${base}/maintenance`).send({ property: prop.id, unit: unit.id, title: `${SECRET} leak`, description: 'secret leak', category: 'plumbing' }), 201);
  const vendor = await ok(manager.post(`${base}/vendors`).send({ name: `${SECRET} vendor` }), 201);
  const convo = await ok(staff.post(`${base}/copilot/conversations`).send({}), 201);
  const wo = await ok(staff.post(`${base}/maintenance/${req.id}/work-orders`).send({ assignee: null, vendor: vendor.id, scope: 'Fix the leak', estimateMinor: 90000, estimateNote: null }), 201).catch(() => null);
  const approvalId = wo?.work_orders?.[0]?.approval?.id as string | undefined;
  return { org, base, manager, staff, prop, unit, tenant, tn, charge, req, vendor, convo, ids: [prop.id, unit.id, tenant.id, tn.id, charge.id, req.id, vendor.id, convo.id, wo?.work_orders?.[0]?.id, approvalId, org.orgId].filter(Boolean) as string[] };
}

describe('changing identifiers cannot reach another organization\'s data', () => {
  it('every endpoint, addressed through the attacker\'s own organization with every one of the victim\'s real ids, returns nothing and changes nothing', async () => {
    const [v, a] = [await victim(), await t.newOrg('Attacker Org')];
    const staff = await t.addMember(a, 'owner' as never).catch(() => a.c);
    const attacker = a.c;
    const { financeDefs } = await import('../../src/routes/finance.js'); const { recordDefs } = await import('../../src/routes/records.js'); const { opsOrgDefs } = await import('../../src/routes/ops.js');
    const { copilotDefs } = await import('../../src/routes/copilot.js'); const { whatsappDefs } = await import('../../src/routes/whatsapp.js'); const { billingDefs } = await import('../../src/routes/billing.js');
    const before = JSON.stringify([(await v.staff.get(`${v.base}/maintenance/${v.req.id}`)).body, (await v.manager.get(`${v.base}/properties/${v.prop.id}`)).body, (await v.staff.get(`${v.base}/tenants/${v.tenant.id}`)).body, (await v.manager.get(`${v.base}/approvals?scope=all`)).body]);
    const leaks: string[] = [];
    let n = 0;
    for (const d of [...financeDefs, ...recordDefs, ...opsOrgDefs, ...copilotDefs, ...whatsappDefs, ...billingDefs].filter((x) => (x.scope ?? 'org') === 'org' && x.path.includes(':'))) {
      for (const id of v.ids) {
        const url = `/api/organizations/${a.orgId}${d.path.replace(/:\w+/g, id)}`;
        const r = (attacker as any)[d.method](url); const res = await (d.method === 'get' || d.method === 'delete' ? r : r.send({}));
        n++;
        const text = JSON.stringify(res.body) + String(res.text ?? '');
        if (res.status >= 200 && res.status < 300) leaks.push(`${d.method} ${d.path} with ${id.slice(0, 8)} → ${res.status}`);
        if (text.includes(SECRET)) leaks.push(`${d.method} ${d.path} leaked the victim's data`);
        if (res.status >= 500) leaks.push(`${d.method} ${d.path} → ${res.status} (unhandled)`);
      }
    }
    expect(n).toBeGreaterThan(500);
    // creations that NAME a victim record in the body (rather than the path)
    const bodies: [string, object][] = [
      [`/tenancies`, { unit: v.unit.id, tenantIds: [v.tenant.id], startDate: '2026-02-01', rentAmountMinor: 1000 }], [`/maintenance`, { property: v.prop.id, unit: v.unit.id, title: 'sneaky', description: 'sneaky', category: 'plumbing' }],
      [`/units`, { property: v.prop.id, reference: 'X1' }], [`/properties/${v.prop.id}/units`, { reference: 'X2' }],
    ];
    for (const [p, b] of bodies) { const s = (await attacker.post(`/api/organizations/${a.orgId}${p}`).send(b)).status; if (s >= 200 && s < 300) leaks.push(`POST ${p} accepted a victim id in the body (${s})`); }
    expect(leaks).toEqual([]);
    // and nothing of the victim's changed
    const after = JSON.stringify([(await v.staff.get(`${v.base}/maintenance/${v.req.id}`)).body, (await v.manager.get(`${v.base}/properties/${v.prop.id}`)).body, (await v.staff.get(`${v.base}/tenants/${v.tenant.id}`)).body, (await v.manager.get(`${v.base}/approvals?scope=all`)).body]);
    expect(after).toBe(before);
    void staff;
  }, 300_000);

  it('organization ids in the URL cannot be enumerated: unknown and forbidden look the same', async () => {
    const w = await t.newOrg(); const stranger = (await t.signUp()).c;
    const real = (await stranger.get(`/api/organizations/${w.orgId}/workspace`)).body; const fake = (await stranger.get(`/api/organizations/${randomUUID()}/workspace`)).body;
    expect((await stranger.get(`/api/organizations/${w.orgId}/workspace`)).status).toBe(404);
    expect({ ...real, error: { ...real.error, requestId: 0 } }).toEqual({ ...fake, error: { ...fake.error, requestId: 0 } });
  });
});

describe('mass assignment and injection', () => {
  it('ignores identifiers and server-controlled fields smuggled into a body', async () => {
    const a = await t.newOrg('Org A'); const b = await t.newOrg('Org B');
    const staff = await t.addMember(a, 'staff');
    const created = await ok(staff.post(`${a.base}/tenants`).send({ fullName: 'Mallory', org: b.orgId, orgId: b.orgId, org_id: b.orgId, p_org: b.orgId, id: randomUUID(), version: 99, archived_at: '2020-01-01', created_by: randomUUID(), role: 'owner' }), 201);
    expect(created.org_id).toBe(a.orgId); expect(created.version).toBe(1); expect(created.archived_at ?? null).toBeNull();
    expect((await ok(b.c.get(`${b.base}/tenants`))).items).toEqual([]);
    const role = await t.addMember(a, 'viewer');
    expect((await role.patch(`/api/organizations/${a.orgId}`).send({ name: 'Hijacked' })).status).toBe(403);
    expect((await ok(a.c.get(`/api/organizations/${a.orgId}`))).name).toBe('Org A');
  });

  it('treats SQL metacharacters, wildcards and oversized parameters as plain data or as validation errors, never as code', async () => {
    const w = await t.newOrg('Inj'); const m = await t.addMember(w, 'manager'); const base = w.base;
    await ok(m.post(`${base}/properties`).send({ name: "Robert'); DROP TABLE properties;--", addressLine1: '1 St', city: 'X', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' }), 201);
    await ok(m.post(`${base}/properties`).send({ name: '100% sure_', addressLine1: '2 St', city: 'X', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' }), 201);
    const evil = ["' OR 1=1 --", '%', '_', '\\', 'a'.repeat(5000), '"; select pg_sleep(5);--', '${7*7}', '{{7*7}}', '\u0000'];
    for (const s of evil) {
      const r = await m.get(`${base}/properties`).query({ search: s });
      expect([200, 400, 422], `search ${JSON.stringify(s.slice(0, 20))}`).toContain(r.status);
      if (r.status === 200 && (s === '%' || s === '_')) expect(r.body.items.every((p: any) => p.name.includes(s)), 'wildcards must be literal').toBe(true);
    }
    for (const q of [{ sort: 'name; drop table properties' }, { sort: '1' }, { dir: 'desc; --' }, { limit: '1;select' }, { limit: '-5' }, { limit: '100000' }, { offset: '-1' }, { offset: 'abc' }]) {
      const r = await m.get(`${base}/properties`).query(q);
      expect([200, 422], JSON.stringify(q)).toContain(r.status);
      if (r.status === 200) expect(r.body.items.length).toBeLessThanOrEqual(100);
    }
    const list = await ok(m.get(`${base}/properties`));
    expect(list.total).toBe(2);                                                            // the "DROP TABLE" name was stored as text; nothing was dropped
    expect(list.items.map((p: any) => p.name)).toContain("Robert'); DROP TABLE properties;--");
  });

  it('returns JSON with nosniff, never HTML, so a stored script cannot execute from an API response', async () => {
    const w = await t.newOrg('Xss'); const m = await t.addMember(w, 'manager');
    const p = await ok(m.post(`${w.base}/properties`).send({ name: '<img src=x onerror=alert(1)>', addressLine1: '<script>alert(1)</script>', city: 'X', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' }), 201);
    const r = await m.get(`${w.base}/properties/${p.id}`);
    expect(r.headers['content-type']).toMatch(/^application\/json/); expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.name).toBe('<img src=x onerror=alert(1)>');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('refuses malformed, oversized and wrongly typed bodies without a stack trace', async () => {
    const w = await t.newOrg('Bad'); const m = await t.addMember(w, 'manager');
    const big = await m.post(`${w.base}/properties`).set('content-type', 'application/json').send(JSON.stringify({ name: 'x'.repeat(100_000) }));
    expect([400, 413, 422]).toContain(big.status);
    const bad = await m.post(`${w.base}/properties`).set('content-type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400); expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(ts|js):\d+|node_modules|SyntaxError/);
    for (const body of [[], 'str', 7, { name: { $ne: null } }, { name: ['a'] }]) {
      const r = await m.post(`${w.base}/properties`).set('content-type', 'application/json').send(JSON.stringify(body));
      expect([400, 422]).toContain(r.status);
    }
  });
});

describe('cross-site request forgery and redirects', () => {
  it('blocks state-changing requests from another origin and non-JSON bodies, even with a valid session', async () => {
    const w = await t.newOrg('Csrf');
    const evil = await w.c.post(`${w.base}/properties`).set('Origin', 'https://evil.example').send({ name: 'x' });
    expect(evil.status).toBe(403);
    const form = await w.c.post(`${w.base}/properties`).type('form').send({ name: 'x' });
    expect(form.status).toBe(400);
    const plain = await w.c.post(`${w.base}/properties`).set('content-type', 'text/plain').send('{"name":"x"}');
    expect(plain.status).toBe(400);
    expect((await w.c.get(`${w.base}/workspace`).set('Origin', 'https://evil.example')).status).toBe(200);        // reads carry no side effects; cookies are SameSite=Lax
  });
  it('session cookies are HttpOnly and SameSite=Lax, the refresh cookie is scoped to the auth path, and logout clears both', async () => {
    const c = t.client(); const email = `cookie-${randomUUID().slice(0, 6)}@test.dev`;
    const r = await c.post('/api/auth/register').send({ email, password: 'correct horse battery', fullName: 'Cookie Monster' });
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(cookies.length).toBe(2);
    for (const ck of cookies) { expect(ck).toMatch(/HttpOnly/i); expect(ck).toMatch(/SameSite=Lax/i); }
    expect(cookies.find((x) => x.startsWith('pai_rt='))).toMatch(/Path=\/api\/auth/);
    const out = await c.post('/api/auth/logout').send({});
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? []).join(';')).toMatch(/pai_at=;/);
    expect((await c.get('/api/me')).status).toBe(401);
  });
  it('only plain same-site paths are accepted as a post-login destination', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '/\t/evil.com', '/\n/evil.com', '/ /evil.com', '/%2F%2Fevil.com/\\', 'data:text/html,x', '', null, undefined, 42, '/app\r\nSet-Cookie: x=1', '/' + 'a'.repeat(3000)]) {
      expect(safeNext(bad as never), String(bad).slice(0, 30)).toBe('/app');
    }
    for (const good of ['/app', '/app?org=123#/properties', '/portal', '/app?org=a-b_c']) expect(safeNext(good)).toBe(good);
  });
  it('the email-link confirmation endpoint always redirects to fixed local paths', async () => {
    const r = await supertest(t.app).get('/api/auth/confirm').query({ token_hash: 'x'.repeat(20), type: 'signup' });
    expect(r.status).toBe(303); expect(r.headers.location).toBe('/login?error=link_expired');
    expect((await supertest(t.app).get('/api/auth/confirm').query({ token_hash: 'x'.repeat(20), type: 'https://evil.com' })).status).toBe(422);
  });
});

describe('sensitive data stays out of responses and logs', () => {
  it('never returns storage paths, token hashes, service credentials or provider secrets from any listing', async () => {
    const v = await victim();
    const dump = JSON.stringify([await v.manager.get(`${v.base}/properties`).then((r) => r.body), await v.manager.get(`${v.base}/tenants`).then((r) => r.body), await v.staff.get(`${v.base}/maintenance`).then((r) => r.body),
      await v.org.c.get(`${v.base}/invitations`).then((r) => r.body), await v.org.c.get(`${v.base}/workspace`).then((r) => r.body), await v.org.c.get('/api/me').then((r) => r.body)]);
    expect(dump).not.toMatch(/storage_path|token_hash|service_role|SUPABASE_|sk_(live|test)_|Bearer |password/i);
  });
  it('errors never expose internals', async () => {
    const w = await t.newOrg('Err');
    const r = await w.c.get(`${w.base}/properties/not-a-uuid`);
    expect(r.status).toBe(422); expect(JSON.stringify(r.body)).not.toMatch(/pg_|public\.|relation|SQLSTATE|node_modules|\.ts:\d+/);
    const e = await w.c.post('/api/internal/billing/assign').send({ orgId: 'nope' });
    expect(e.status).toBe(401);
    const unknown = await w.c.get('/api/does-not-exist'); expect(unknown.status).toBe(404); expect(JSON.stringify(unknown.body)).not.toMatch(/Cannot GET/);
  });
});
