import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const property = (over: object = {}) => ({
  name: 'Maple Court', propertyType: 'apartment_building', addressLine1: '1 Maple St', city: 'Austin', region: 'TX',
  postalCode: '78701', country: 'US', timezone: 'America/Chicago', currency: 'USD', ...over,
});
const terms = (unit: string, tenantIds: string[], over: object = {}) => ({
  unit, tenantIds, startDate: '2026-01-01', endDate: '2026-12-31', rentAmountMinor: 185000, rentPeriod: 'monthly',
  rentDueDay: 1, depositAmountMinor: 185000, depositScheme: 'State deposit scheme', noticeDays: 30, ...over,
});
const ok = async (p: Promise<any>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const pdf = Buffer.from('%PDF-1.4 fake lease contents');

/** Upload through the exact steps the browser performs. */
async function uploadDocument(c: Client, base: string, lease: string, bytes = pdf, mimeType = 'application/pdf', fileName = 'Lease 2026.pdf') {
  const reg = await ok(c.post(`${base}/leases/${lease}/documents`).send({ fileName, mimeType, sizeBytes: bytes.length, docType: 'lease' }), 201);
  const put = await fetch(reg.upload.url, { method: 'PUT', headers: reg.upload.headers, body: bytes });
  return { reg, put };
}

describe('acceptance: property → units → tenant → tenancy → lease → private document', () => {
  it('completes the whole workflow, persists across sessions, and serves the file back', async () => {
    const org = await t.newOrg('Maple Management');
    const { c, base } = org;

    const prop = await ok(c.post(`${base}/properties`).send(property()), 201);
    expect(prop).toMatchObject({ name: 'Maple Court', currency: 'USD', timezone: 'America/Chicago', version: 1 });
    const unit = await ok(c.post(`${base}/properties/${prop.id}/units`).send({ reference: '1A', bedrooms: 2, bathrooms: 1.5, marketRentMinor: 190000 }), 201);
    expect(unit.occupancy).toBe('vacant');
    await ok(c.post(`${base}/properties/${prop.id}/units`).send({ reference: '1B' }), 201);

    const tenant = await ok(c.post(`${base}/tenants`).send({ fullName: 'Tina Tenant', email: 'Tina@Mail.test', phone: '+1 512 555 0100' }), 201);
    expect(tenant.email).toBe('tina@mail.test');

    const draft = await ok(c.post(`${base}/tenancies`).send(terms(unit.id, [tenant.id])), 201);
    expect(draft).toMatchObject({ status: 'draft', currency: 'USD', rent_amount_minor: 185000, unit_reference: '1A', primary_tenant: 'Tina Tenant' });
    const active = await ok(c.post(`${base}/tenancies/${draft.id}/activate`).send({ expectedVersion: draft.version }));
    expect(active.status).toBe('active');
    expect((await ok(c.get(`${base}/units/${unit.id}`))).occupancy).toBe('occupied');

    const lease = await ok(c.post(`${base}/tenancies/${draft.id}/leases`).send({ kind: 'initial', startDate: '2026-01-01', endDate: '2026-12-31', signedOn: '2025-12-20' }), 201);
    const { reg, put } = await uploadDocument(c, base, lease.id);
    expect(put.status).toBe(200);
    expect(reg.document).not.toHaveProperty('storage_path');
    expect(JSON.stringify(reg.document)).not.toContain(org.orgId + '/');
    const confirmed = await ok(c.post(`${base}/documents/${reg.document.id}/confirm`).send({}));
    expect(confirmed).toMatchObject({ status: 'available', size_bytes: pdf.length, mime_type: 'application/pdf' });

    const dl = await ok(c.get(`${base}/documents/${reg.document.id}/download`));
    expect(dl.expiresInSeconds).toBe(60);
    const file = await fetch(dl.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(pdf)).toBe(true);

    // "survives a reload": a brand-new session sees everything
    const email = (await c.get('/api/me')).body.profile.email;
    const later = t.client();
    await ok(later.post('/api/auth/login').send({ email, password: 'correct horse battery' }));
    expect((await ok(later.get(`${base}/properties`))).total).toBe(1);
    expect((await ok(later.get(`${base}/units?property=${prop.id}`))).total).toBe(2);
    const reread = await ok(later.get(`${base}/tenancies/${draft.id}`));
    expect(reread).toMatchObject({ status: 'active', tenants: [{ full_name: 'Tina Tenant', is_primary: true }] });
    expect(reread.leases[0].document_count).toBe(1);
    expect((await ok(later.get(`${base}/leases/${lease.id}`))).documents[0]).toMatchObject({ file_name: 'Lease 2026.pdf', status: 'available' });
  });
});

describe('validation', () => {
  let org: Awaited<ReturnType<TestApp['newOrg']>>;
  beforeAll(async () => { org = await t.newOrg(); });
  const fieldErrors = (r: any) => r.body.error.details.map((d: any) => d.path);

  it('rejects bad property fields with per-field messages', async () => {
    const r = await org.c.post(`${org.base}/properties`).send(property({ name: '', country: 'USA', timezone: 'Mars/Base', currency: 'ZZZ' }));
    expect(r.status).toBe(422);
    expect(fieldErrors(r).sort()).toEqual(['country', 'currency', 'name', 'timezone']);
  });
  it('rejects bad dates, negative money, and end-before-start', async () => {
    const p = await ok(org.c.post(`${org.base}/properties`).send(property()), 201);
    const u = await ok(org.c.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'V1' }), 201);
    const tn = await ok(org.c.post(`${org.base}/tenants`).send({ fullName: 'Val Idator' }), 201);
    for (const [over, path] of [
      [{ startDate: '2026-02-30' }, 'startDate'], [{ endDate: '2025-12-31' }, 'endDate'],
      [{ rentAmountMinor: -1 }, 'rentAmountMinor'], [{ rentAmountMinor: 12.5 }, 'rentAmountMinor'], [{ rentPeriod: 'daily' }, 'rentPeriod'],
    ] as const) {
      const r = await org.c.post(`${org.base}/tenancies`).send(terms(u.id, [tn.id], over));
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect(fieldErrors(r)).toContain(path);
    }
    expect((await org.c.post(`${org.base}/tenancies`).send(terms(u.id, []))).status).toBe(422);
  });
  it('rejects malformed ids, unknown query params, bad sort and unsupported files', async () => {
    expect((await org.c.get(`${org.base}/properties/not-a-uuid`)).status).toBe(422);
    expect((await org.c.get(`${org.base}/properties?bogus=1`)).status).toBe(422);
    expect((await org.c.get(`${org.base}/properties?sort=password`)).status).toBe(422);
    expect((await org.c.get(`${org.base}/properties?limit=1000`)).status).toBe(422);
  });
  it('rejects unsupported or oversize documents before any upload URL is issued', async () => {
    const p = await ok(org.c.post(`${org.base}/properties`).send(property({ name: 'Docs' })), 201);
    const u = await ok(org.c.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'D1' }), 201);
    const tn = await ok(org.c.post(`${org.base}/tenants`).send({ fullName: 'Doc Tenant' }), 201);
    const tc = await ok(org.c.post(`${org.base}/tenancies`).send(terms(u.id, [tn.id])), 201);
    const l = await ok(org.c.post(`${org.base}/tenancies/${tc.id}/leases`).send({ startDate: '2026-01-01' }), 201);
    expect((await org.c.post(`${org.base}/leases/${l.id}/documents`).send({ fileName: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 5 })).status).toBe(422);
    expect((await org.c.post(`${org.base}/leases/${l.id}/documents`).send({ fileName: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 11 * 1024 * 1024 })).status).toBe(422);
    expect((await org.c.post(`${org.base}/leases/${l.id}/documents`).send({ fileName: 'z.pdf', mimeType: 'application/pdf', sizeBytes: 0 })).status).toBe(422);
  });
});

describe('role restrictions over HTTP', () => {
  it('enforces the permission matrix', async () => {
    const org = await t.newOrg();
    const manager = await t.addMember(org, 'manager');
    const staff = await t.addMember(org, 'staff');
    const viewer = await t.addMember(org, 'viewer');
    const p = await ok(manager.post(`${org.base}/properties`).send(property()), 201);
    const u = await ok(manager.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'R1' }), 201);

    const ws = await ok(viewer.get(`${org.base}/workspace`));
    expect(ws.permissions).toContain('org:read');
    expect(ws.permissions).not.toContain('tenants:write');
    expect((await ok(staff.get(`${org.base}/workspace`))).permissions).toEqual(expect.arrayContaining(['tenants:write', 'documents:read']));

    // viewers: read-only
    expect((await ok(viewer.get(`${org.base}/properties`))).total).toBe(1);
    expect((await viewer.post(`${org.base}/tenants`).send({ fullName: 'No Way' })).status).toBe(403);
    // staff: tenants/tenancies yes; properties/units/transitions no
    const tn = await ok(staff.post(`${org.base}/tenants`).send({ fullName: 'Stan Staff' }), 201);
    expect((await staff.post(`${org.base}/properties`).send(property())).status).toBe(403);
    expect((await staff.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'S1' })).status).toBe(403);
    const d = await ok(staff.post(`${org.base}/tenancies`).send(terms(u.id, [tn.id])), 201);
    expect((await staff.post(`${org.base}/tenancies/${d.id}/activate`).send({ expectedVersion: d.version })).status).toBe(403);
    expect((await staff.post(`${org.base}/tenants/${tn.id}/archive`).send({})).status).toBe(403);
    // managers: transitions + archive
    await ok(manager.post(`${org.base}/tenancies/${d.id}/activate`).send({ expectedVersion: d.version }));
    // staff cannot rewrite live terms either
    const live = await ok(staff.get(`${org.base}/tenancies/${d.id}`));
    expect((await staff.patch(`${org.base}/tenancies/${d.id}`).send({ ...terms(u.id, []), expectedVersion: live.version, rentAmountMinor: 1 })).status).toBe(403);
  });
});

describe('cross-organization isolation over HTTP', () => {
  it('another organization cannot read, edit or act on any record, by id or via its own org path', async () => {
    const a = await t.newOrg('Org A');
    const b = await t.newOrg('Org B');
    const p = await ok(a.c.post(`${a.base}/properties`).send(property()), 201);
    const u = await ok(a.c.post(`${a.base}/properties/${p.id}/units`).send({ reference: 'A1' }), 201);
    const tn = await ok(a.c.post(`${a.base}/tenants`).send({ fullName: 'Secret Tenant', email: 'secret@a.test' }), 201);
    const tc = await ok(a.c.post(`${a.base}/tenancies`).send(terms(u.id, [tn.id])), 201);
    const l = await ok(a.c.post(`${a.base}/tenancies/${tc.id}/leases`).send({ startDate: '2026-01-01' }), 201);
    const { reg } = await uploadDocument(a.c, a.base, l.id);
    await ok(a.c.post(`${a.base}/documents/${reg.document.id}/confirm`).send({}));
    const docId = reg.document.id;

    const reads = [`properties/${p.id}`, `units/${u.id}`, `tenants/${tn.id}`, `tenancies/${tc.id}`, `leases/${l.id}`,
      `leases/${l.id}/documents`, `documents/${docId}/download`, 'properties', 'units', 'tenants', 'tenancies', 'owners'];
    for (const path of reads) {
      const viaA = await b.c.get(`${a.base}/${path}`);               // B addressing A's org
      expect(viaA.status, `B → A org: ${path}`).toBe(404);
      expect(JSON.stringify(viaA.body)).not.toMatch(/Secret Tenant|secret@a\.test|Maple/);
    }
    for (const path of reads.filter((x) => /\//.test(x))) {
      const viaB = await b.c.get(`${b.base}/${path}`);                // B's own org path, A's record id
      expect(viaB.status, `B org + A id: ${path}`).toBe(404);
    }
    // B's own lists contain nothing of A's
    for (const list of ['properties', 'units', 'tenants', 'tenancies']) expect((await ok(b.c.get(`${b.base}/${list}`))).total).toBe(0);

    // writes by B against A's records
    const writes: [string, string, object][] = [
      ['patch', `properties/${p.id}`, { ...property(), expectedVersion: 1 }],
      ['post', `properties/${p.id}/archive`, {}],
      ['post', `properties/${p.id}/units`, { reference: 'EVIL' }],
      ['patch', `tenants/${tn.id}`, { fullName: 'Pwned', expectedVersion: 1 }],
      ['post', `tenancies/${tc.id}/activate`, { expectedVersion: 1 }],
      ['post', `tenancies/${tc.id}/leases`, { startDate: '2026-01-01' }],
      ['post', `leases/${l.id}/documents`, { fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 5 }],
      ['post', `documents/${docId}/archive`, {}],
    ];
    for (const [m, path, body] of writes) {
      for (const base of [a.base, b.base]) {
        const r = await (b.c as any)[m](`${base}/${path}`).send(body);
        // via A's org: not a member => 404. via B's own org: A's ids don't exist there => 404 (or 422/409 if the body is rejected first).
        if (base === a.base) expect(r.status, `${m} A ${path}`).toBe(404);
        else expect([404, 409, 422], `${m} B ${path} -> ${r.status}`).toContain(r.status);
      }
    }
    // B cannot attach A's tenant/unit to B's own tenancy
    const bp = await ok(b.c.post(`${b.base}/properties`).send(property({ name: 'B Prop' })), 201);
    const bu = await ok(b.c.post(`${b.base}/properties/${bp.id}/units`).send({ reference: 'B1' }), 201);
    expect((await b.c.post(`${b.base}/tenancies`).send(terms(bu.id, [tn.id]))).status).toBe(404);
    const bt = await ok(b.c.post(`${b.base}/tenants`).send({ fullName: 'B T' }), 201);
    expect((await b.c.post(`${b.base}/tenancies`).send(terms(u.id, [bt.id]))).status).toBe(404);   // A's unit

    // A's data is untouched
    expect((await ok(a.c.get(`${a.base}/tenants/${tn.id}`))).full_name).toBe('Secret Tenant');
    expect((await ok(a.c.get(`${a.base}/properties/${p.id}`))).archived_at).toBeNull();
  });

  it('Storage itself refuses another org\'s user, even holding a valid session token', async () => {
    const a = await t.newOrg(); const b = await t.newOrg();
    const p = await ok(a.c.post(`${a.base}/properties`).send(property()), 201);
    const u = await ok(a.c.post(`${a.base}/properties/${p.id}/units`).send({ reference: 'S1' }), 201);
    const tn = await ok(a.c.post(`${a.base}/tenants`).send({ fullName: 'S T' }), 201);
    const tc = await ok(a.c.post(`${a.base}/tenancies`).send(terms(u.id, [tn.id])), 201);
    const l = await ok(a.c.post(`${a.base}/tenancies/${tc.id}/leases`).send({ startDate: '2026-01-01' }), 201);
    const { reg } = await uploadDocument(a.c, a.base, l.id);
    await ok(a.c.post(`${a.base}/documents/${reg.document.id}/confirm`).send({}));
    const path = [...t.mock.objects.keys()].find((k) => k.includes(reg.document.id))!;
    // log B in and steal its access token to talk to Storage directly
    const login = await t.client().post('/api/auth/login').send({ email: b.email, password: 'correct horse battery' });
    const at = (login.headers['set-cookie'] as unknown as string[]).find((s) => s.startsWith('pai_at='))!.split(';')[0]!.slice(7);
    const sign = await fetch(`${t.mock.url}/storage/v1/object/sign/${path}`, {
      method: 'POST', headers: { apikey: t.mock.anonKey, authorization: `Bearer ${at}`, 'content-type': 'application/json' }, body: '{"expiresIn":60}' });
    expect(sign.status).toBe(400);
    const info = await fetch(`${t.mock.url}/storage/v1/object/info/${path}`, { headers: { apikey: t.mock.anonKey, authorization: `Bearer ${at}` } });
    expect(info.status).toBe(400);
  });
});

describe('document access rules', () => {
  let org: Awaited<ReturnType<TestApp['newOrg']>>; let staff: Client; let viewer: Client; let manager: Client;
  let lease: string; let docId: string;
  beforeAll(async () => {
    org = await t.newOrg();
    manager = await t.addMember(org, 'manager'); staff = await t.addMember(org, 'staff'); viewer = await t.addMember(org, 'viewer');
    const p = await ok(manager.post(`${org.base}/properties`).send(property()), 201);
    const u = await ok(manager.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'D1' }), 201);
    const tn = await ok(staff.post(`${org.base}/tenants`).send({ fullName: 'Docs Tenant' }), 201);
    const tc = await ok(staff.post(`${org.base}/tenancies`).send(terms(u.id, [tn.id])), 201);
    lease = (await ok(staff.post(`${org.base}/tenancies/${tc.id}/leases`).send({ startDate: '2026-01-01' }), 201)).id;
    const { reg } = await uploadDocument(staff, org.base, lease);
    docId = reg.document.id;
  });

  it('confirm fails until the bytes are really in storage', async () => {
    const reg = await ok(staff.post(`${org.base}/leases/${lease}/documents`).send({ fileName: 'ghost.pdf', mimeType: 'application/pdf', sizeBytes: 10 }), 201);
    expect((await staff.post(`${org.base}/documents/${reg.document.id}/confirm`).send({})).status).toBe(409);
    expect((await staff.get(`${org.base}/documents/${reg.document.id}/download`)).status).toBe(404);
  });
  it('a pending upload cannot be downloaded or confirmed by someone else', async () => {
    expect((await staff.get(`${org.base}/documents/${docId}/download`)).status).toBe(404);
    expect((await viewer.post(`${org.base}/documents/${docId}/confirm`).send({})).status).toBe(403);
    await ok(staff.post(`${org.base}/documents/${docId}/confirm`).send({}));
  });
  it('viewers cannot list, download or upload; staff and managers can download', async () => {
    expect((await viewer.get(`${org.base}/documents/${docId}/download`)).status).toBe(403);
    expect((await viewer.get(`${org.base}/leases/${lease}/documents`)).status).toBe(403);
    expect((await viewer.post(`${org.base}/leases/${lease}/documents`).send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 5 })).status).toBe(403);
    const lv = await ok(viewer.get(`${org.base}/leases/${lease}`));
    expect(lv).toMatchObject({ documents_visible: false, documents: [] });
    expect((await ok(staff.get(`${org.base}/documents/${docId}/download`))).url).toContain('/object/sign/');
    expect((await ok(manager.get(`${org.base}/documents/${docId}/download`))).url).toContain('/object/sign/');
  });
  it('an upload URL only works for its own registered path and only once', async () => {
    const one = await ok(staff.post(`${org.base}/leases/${lease}/documents`).send({ fileName: 'one.pdf', mimeType: 'application/pdf', sizeBytes: 5 }), 201);
    const two = await ok(staff.post(`${org.base}/leases/${lease}/documents`).send({ fileName: 'two.pdf', mimeType: 'application/pdf', sizeBytes: 5 }), 201);
    const crossed = one.upload.url.split('?')[0] + '?token=' + two.upload.url.split('token=')[1];
    expect((await fetch(crossed, { method: 'PUT', headers: one.upload.headers, body: pdf })).status).toBe(403);
    expect((await fetch(one.upload.url, { method: 'PUT', headers: one.upload.headers, body: pdf })).status).toBe(200);
    expect((await fetch(one.upload.url, { method: 'PUT', headers: one.upload.headers, body: pdf })).status).toBe(403);
  });
  it('storage rejects content types that differ from the allow-list', async () => {
    const reg = await ok(staff.post(`${org.base}/leases/${lease}/documents`).send({ fileName: 'sneaky.pdf', mimeType: 'application/pdf', sizeBytes: 5 }), 201);
    const put = await fetch(reg.upload.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<script>1</script>' });
    expect(put.status).toBe(415);
  });
  it('archiving is manager-only and removes staff download access, keeping the record', async () => {
    expect((await staff.post(`${org.base}/documents/${docId}/archive`).send({})).status).toBe(403);
    await ok(manager.post(`${org.base}/documents/${docId}/archive`).send({}));
    expect((await staff.get(`${org.base}/documents/${docId}/download`)).status).toBe(404);
    expect((await ok(manager.get(`${org.base}/documents/${docId}/download`))).url).toBeTruthy();
    await ok(manager.post(`${org.base}/documents/${docId}/restore`).send({}));
    expect((await ok(staff.get(`${org.base}/documents/${docId}/download`))).url).toBeTruthy();
  });
});

describe('tenancy lifecycle, concurrency and archive over HTTP', () => {
  it('walks draft → active → ended, blocks bad transitions, and keeps history after archiving', async () => {
    const org = await t.newOrg();
    const { c, base } = org;
    const p = await ok(c.post(`${base}/properties`).send(property()), 201);
    const u = await ok(c.post(`${base}/properties/${p.id}/units`).send({ reference: 'L1' }), 201);
    const tn = await ok(c.post(`${base}/tenants`).send({ fullName: 'Life Cycle' }), 201);
    const d = await ok(c.post(`${base}/tenancies`).send(terms(u.id, [tn.id], { startDate: '2025-01-01', endDate: null })), 201);

    expect((await c.post(`${base}/tenancies/${d.id}/end`).send({ expectedVersion: d.version, endDate: '2025-06-01' })).status).toBe(409); // draft can't end
    const a = await ok(c.post(`${base}/tenancies/${d.id}/activate`).send({ expectedVersion: d.version }));
    expect((await c.post(`${base}/tenancies/${d.id}/activate`).send({ expectedVersion: a.version })).status).toBe(409);
    expect((await c.post(`${base}/tenancies/${d.id}/cancel`).send({ expectedVersion: a.version })).status).toBe(409);
    expect((await c.post(`${base}/tenants/${tn.id}/archive`).send({})).status).toBe(409);                 // open tenancy
    expect((await c.post(`${base}/properties/${p.id}/archive`).send({})).status).toBe(409);
    const e = await ok(c.post(`${base}/tenancies/${d.id}/end`).send({ expectedVersion: a.version, endDate: '2025-12-31', reason: 'Lease expired' }));
    expect(e).toMatchObject({ status: 'ended', end_date: '2025-12-31', end_reason: 'Lease expired' });
    expect((await c.patch(`${base}/tenancies/${d.id}`).send({ ...terms(u.id, []), expectedVersion: e.version })).status).toBe(409);

    await ok(c.post(`${base}/tenants/${tn.id}/archive`).send({}));
    await ok(c.post(`${base}/units/${u.id}/archive`).send({}));
    await ok(c.post(`${base}/properties/${p.id}/archive`).send({}));
    expect((await ok(c.get(`${base}/properties`))).total).toBe(0);
    expect((await ok(c.get(`${base}/properties?archived=true`))).total).toBe(1);
    const history = await ok(c.get(`${base}/tenancies/${d.id}`));        // still fully readable
    expect(history).toMatchObject({ status: 'ended', property_name: 'Maple Court', unit_reference: 'L1' });
    expect((await c.post(`${base}/properties/${p.id}/units`).send({ reference: 'NEW' })).status).toBe(409);
    await ok(c.post(`${base}/properties/${p.id}/restore`).send({}));
  });

  it('a stale edit gets 409 instead of overwriting a colleague\'s change', async () => {
    const org = await t.newOrg();
    const other = await t.addMember(org, 'manager');
    const p = await ok(org.c.post(`${org.base}/properties`).send(property()), 201);
    await ok(other.patch(`${org.base}/properties/${p.id}`).send({ ...property({ name: 'Renamed by colleague' }), expectedVersion: p.version }));
    const stale = await org.c.patch(`${org.base}/properties/${p.id}`).send({ ...property({ name: 'My stale edit' }), expectedVersion: p.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/changed by someone else/);
    expect((await ok(org.c.get(`${org.base}/properties/${p.id}`))).name).toBe('Renamed by colleague');
  });

  it('two simultaneous activations on one unit: exactly one wins', async () => {
    const org = await t.newOrg();
    const p = await ok(org.c.post(`${org.base}/properties`).send(property()), 201);
    const u = await ok(org.c.post(`${org.base}/properties/${p.id}/units`).send({ reference: 'RACE' }), 201);
    const t1 = await ok(org.c.post(`${org.base}/tenants`).send({ fullName: 'Racer One' }), 201);
    const t2 = await ok(org.c.post(`${org.base}/tenants`).send({ fullName: 'Racer Two' }), 201);
    const d1 = await ok(org.c.post(`${org.base}/tenancies`).send(terms(u.id, [t1.id])), 201);
    const d2 = await ok(org.c.post(`${org.base}/tenancies`).send(terms(u.id, [t2.id])), 201);
    const [r1, r2] = await Promise.all([
      org.c.post(`${org.base}/tenancies/${d1.id}/activate`).send({ expectedVersion: d1.version }),
      org.c.post(`${org.base}/tenancies/${d2.id}/activate`).send({ expectedVersion: d2.version }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await ok(org.c.get(`${org.base}/tenancies?unit=${u.id}&status=active`))).total).toBe(1);
  });
});

describe('search, filter, sort and pagination over HTTP', () => {
  it('works end to end', async () => {
    const org = await t.newOrg();
    for (const [name, city] of [['Alder House', 'Austin'], ['Birch Lofts', 'Boston'], ['Cedar Court', 'Austin'], ['Dogwood Flats', 'Denver']])
      await ok(org.c.post(`${org.base}/properties`).send(property({ name, city, propertyType: name!.startsWith('B') ? 'commercial' : 'residential' })), 201);
    const page1 = await ok(org.c.get(`${org.base}/properties?limit=2&sort=name`));
    expect([page1.total, page1.items.map((i: any) => i.name)]).toEqual([4, ['Alder House', 'Birch Lofts']]);
    const page2 = await ok(org.c.get(`${org.base}/properties?limit=2&offset=2&sort=name`));
    expect(page2.items.map((i: any) => i.name)).toEqual(['Cedar Court', 'Dogwood Flats']);
    expect((await ok(org.c.get(`${org.base}/properties?sort=name&dir=desc&limit=1`))).items[0].name).toBe('Dogwood Flats');
    expect((await ok(org.c.get(`${org.base}/properties?search=austin`))).total).toBe(2);
    expect((await ok(org.c.get(`${org.base}/properties?type=commercial`))).items.map((i: any) => i.name)).toEqual(['Birch Lofts']);
    expect((await ok(org.c.get(`${org.base}/properties?search=zzz`))).total).toBe(0);
  });
});
