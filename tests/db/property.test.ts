import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { as, call, code, createTestDb } from '../support/db.js';
import { propertyArgs, seedWorld, tenancyArgs, tenantArgs, unitArgs, type World } from '../support/fixtures.js';

let db: PGlite;
let w: World;
let prop: string, unit: string, tenant: string, tenancy: string, lease: string;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  prop = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA))).id;
  unit = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop))).id;
  tenant = (await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA))).id;
  tenancy = (await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, unit, [tenant]))).id;
  lease = (await call(db, w.staff, 'create_lease', {
    p_org: w.orgA, p_tenancy: tenancy, p_kind: 'initial', p_start_date: '2026-01-01', p_end_date: '2026-12-31',
    p_signed_on: '2025-12-15', p_notes: null })).id;
});

describe('cross-organization isolation (tables)', () => {
  const tables = ['properties', 'owners', 'property_owners', 'units', 'tenants', 'tenancies', 'tenancy_tenants', 'leases', 'lease_documents'];
  it('an outsider sees no rows in any Phase 2 table', async () => {
    for (const t of tables) {
      const r = await as(db, w.outsider, (q) => q(`select * from public.${t}`));
      expect(r.rows, t).toEqual([]);
    }
  });
  it('members of the owning org do see their rows', async () => {
    for (const t of ['properties', 'units', 'tenants', 'tenancies', 'leases']) {
      const r = await as(db, w.viewer, (q) => q(`select id from public.${t}`));
      expect(r.rows.length, t).toBe(1);
    }
  });
  it('no role can write tables directly', async () => {
    for (const actor of [w.owner, w.manager, w.staff, w.outsider]) {
      expect(await code(as(db, actor, (q) => q(`insert into public.tenants (org_id, full_name, created_by) values ($1,'x',$2)`, [w.orgA, actor.sub])))).toBe('42501');
      expect(await code(as(db, actor, (q) => q(`update public.tenancies set rent_amount_minor = 1`)))).toBe('42501');
      expect(await code(as(db, actor, (q) => q(`delete from public.properties`)))).toBe('42501');
    }
  });
  it('composite foreign keys reject cross-organization links even for a superuser', async () => {
    const orgBProp = (await call(db, w.outsider, 'create_property', propertyArgs(w.orgB, { p_name: 'B Tower' }))).id;
    // unit claiming org A but pointing at org B's property
    expect(await code(db.query(`insert into public.units (org_id, property_id, reference, created_by) values ($1,$2,'X',$3)`,
      [w.orgA, orgBProp, w.owner.sub]))).toBe('23503');
    // tenancy of org A tying org B's tenant
    const bTenant = (await call(db, w.outsider, 'create_tenant', tenantArgs(w.orgB, 'Bea Bravo'))).id;
    expect(await code(db.query(`insert into public.tenancy_tenants (org_id, tenancy_id, tenant_id) values ($1,$2,$3)`,
      [w.orgA, tenancy, bTenant]))).toBe('23503');
  });
});

describe('cross-organization isolation (functions)', () => {
  it('an outsider gets 404 for every record family in org A', async () => {
    const o = w.outsider;
    const probes: [string, Record<string, unknown>][] = [
      ['get_property', { p_org: w.orgA, p_property: prop }], ['get_unit', { p_org: w.orgA, p_unit: unit }],
      ['get_tenant', { p_org: w.orgA, p_tenant: tenant }], ['get_tenancy', { p_org: w.orgA, p_tenancy: tenancy }],
      ['get_lease', { p_org: w.orgA, p_lease: lease }], ['list_properties', { p_org: w.orgA }],
      ['list_units', { p_org: w.orgA }], ['list_tenants', { p_org: w.orgA }], ['list_tenancies', { p_org: w.orgA }],
    ];
    for (const [fn, a] of probes) expect(await code(call(db, o, fn, a)), fn).toBe('PT404');
  });
  it('ids from org A are not found when addressed through org B', async () => {
    const o = w.outsider;
    expect(await code(call(db, o, 'get_property', { p_org: w.orgB, p_property: prop }))).toBe('PT404');
    expect(await code(call(db, o, 'get_tenant', { p_org: w.orgB, p_tenant: tenant }))).toBe('PT404');
    expect(await code(call(db, o, 'create_unit', unitArgs(w.orgB, prop, 'Z9')))).toBe('PT404');
    expect(await code(call(db, o, 'create_tenancy', tenancyArgs(w.orgB, unit, [tenant])))).toBe('PT404');
  });
  it('an org-B manager cannot use org-A tenants on an org-B tenancy', async () => {
    const bProp = (await call(db, w.outsider, 'list_properties', { p_org: w.orgB })).items[0].id;
    const bUnit = (await call(db, w.outsider, 'create_unit', unitArgs(w.orgB, bProp, 'B1'))).id;
    expect(await code(call(db, w.outsider, 'create_tenancy', tenancyArgs(w.orgB, bUnit, [tenant])))).toBe('PT404');
  });
});

describe('role restrictions', () => {
  it('viewer is read-only', async () => {
    expect((await call(db, w.viewer, 'list_properties', { p_org: w.orgA })).total).toBe(1);
    expect(await code(call(db, w.viewer, 'create_tenant', tenantArgs(w.orgA, 'Nope Nope')))).toBe('PT403');
    expect(await code(call(db, w.viewer, 'create_property', propertyArgs(w.orgA, { p_name: 'x' })))).toBe('PT403');
  });
  it('staff manage tenants/tenancies/leases but not properties, units or status changes', async () => {
    expect(await code(call(db, w.staff, 'create_property', propertyArgs(w.orgA, { p_name: 'y' })))).toBe('PT403');
    expect(await code(call(db, w.staff, 'create_unit', unitArgs(w.orgA, prop, 'S1')))).toBe('PT403');
    expect(await code(call(db, w.staff, 'activate_tenancy', { p_org: w.orgA, p_tenancy: tenancy, p_expected_version: 1 }))).toBe('PT403');
    expect(await code(call(db, w.staff, 'set_tenant_archived', { p_org: w.orgA, p_tenant: tenant, p_archived: true }))).toBe('PT403');
    expect((await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, 'Sam Staffcreated'))).full_name).toBe('Sam Staffcreated');
  });
  it('lease documents are hidden from viewers entirely', async () => {
    const l = await call(db, w.viewer, 'get_lease', { p_org: w.orgA, p_lease: lease });
    expect(l.documents_visible).toBe(false);
    expect(l.documents).toEqual([]);
    expect(await code(call(db, w.viewer, 'create_document', {
      p_org: w.orgA, p_lease: lease, p_doc_type: 'lease', p_file_name: 'a.pdf', p_mime_type: 'application/pdf', p_size_bytes: 10 }))).toBe('PT403');
  });
});

describe('validation', () => {
  it('rejects unknown time zones and invalid codes', async () => {
    expect(await code(call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_timezone: 'Mars/Olympus' })))).toBe('PT422');
    expect(await code(call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_country: 'USA' })))).not.toBe('NO_ERROR');
    expect(await code(call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_currency: 'US' })))).not.toBe('NO_ERROR');
  });
  it('rejects end dates before start dates and negative money', async () => {
    expect(await code(call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, unit, [tenant], { p_end_date: '2025-01-01' })))).toBe('23514');
    expect(await code(call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, unit, [tenant], { p_rent_amount_minor: -5 })))).toBe('23514');
  });
  it('requires at least one tenant', async () => {
    expect(await code(call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, unit, [])))).toBe('PT422');
  });
  it('rejects duplicate unit references within a property (case-insensitive) but allows them across properties', async () => {
    expect(await code(call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, '1a')))).toBe('PT409');
    const p2 = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_name: 'Second' }))).id;
    expect((await call(db, w.manager, 'create_unit', unitArgs(w.orgA, p2, '1A'))).reference).toBe('1A');
  });
  it('rejects disallowed document types and oversize files', async () => {
    const base = { p_org: w.orgA, p_lease: lease, p_doc_type: 'lease', p_file_name: 'x', p_mime_type: 'application/pdf', p_size_bytes: 100 };
    expect(await code(call(db, w.staff, 'create_document', { ...base, p_mime_type: 'application/x-msdownload' }))).toBe('PT422');
    expect(await code(call(db, w.staff, 'create_document', { ...base, p_size_bytes: 10485761 }))).toBe('PT422');
  });
});

describe('tenancy status transitions', () => {
  let t2: string, u2: string;
  beforeAll(async () => {
    u2 = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'T2'))).id;
    t2 = (await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u2, [tenant], { p_start_date: '2025-01-01', p_end_date: null }))).id;
  });
  const v = async (id: string) => (await call(db, w.manager, 'get_tenancy', { p_org: w.orgA, p_tenancy: id })).version as number;

  it('draft → active → ended; ended is terminal', async () => {
    const active = await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2) });
    expect(active.status).toBe('active');
    expect(await code(call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2) }))).toBe('PT409');
    expect(await code(call(db, w.manager, 'cancel_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2), p_reason: null }))).toBe('PT409');
    const ended = await call(db, w.manager, 'end_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2), p_end_date: '2025-12-31', p_reason: 'moved out' });
    expect(ended).toMatchObject({ status: 'ended', end_date: '2025-12-31', end_reason: 'moved out' });
    expect(await code(call(db, w.manager, 'end_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2), p_end_date: '2025-12-31', p_reason: null }))).toBe('PT409');
    expect(await code(call(db, w.staff, 'update_tenancy', { p_org: w.orgA, p_tenancy: t2, p_expected_version: await v(t2), p_start_date: '2025-01-01', p_end_date: '2025-12-31',
      p_rent_amount_minor: 1, p_rent_period: 'monthly', p_rent_due_day: 1, p_deposit_amount_minor: 0, p_deposit_scheme: null, p_notice_days: 1, p_notes: null }))).toBe('PT409');
  });
  it('the database trigger blocks illegal transitions even for direct SQL', async () => {
    const u = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'TRG'))).id;
    const d = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [tenant], { p_start_date: '2025-01-01', p_end_date: null }));
    expect(await code(db.query(`update public.tenancies set status = 'ended', end_date = '2025-02-01' where id = $1`, [d.id]))).toBe('PT409');
    await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: d.version });
    expect(await code(db.query(`update public.tenancies set status = 'draft' where id = $1`, [d.id]))).toBe('PT409');
    expect(await code(db.query(`update public.tenancies set status = 'cancelled' where id = $1`, [d.id]))).toBe('PT409');
  });
  it('only drafts can be cancelled, and cancelled stays on record', async () => {
    const u3 = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'T3'))).id;
    const d = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u3, [tenant]));
    const c = await call(db, w.manager, 'cancel_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: d.version, p_reason: 'deal fell through' });
    expect(c.status).toBe('cancelled');
    expect((await call(db, w.viewer, 'list_tenancies', { p_org: w.orgA, p_status: 'cancelled' })).items.map((x: any) => x.id)).toContain(d.id);
  });
  it('cannot end a tenancy in the future', async () => {
    const u4 = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'T4'))).id;
    const d = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u4, [tenant], { p_start_date: '2025-01-01', p_end_date: null }));
    const a = await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: d.version });
    expect(await code(call(db, w.manager, 'end_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: a.version, p_end_date: '2999-01-01', p_reason: null }))).toBe('PT422');
    expect(await code(call(db, w.manager, 'end_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: a.version, p_end_date: '2024-12-31', p_reason: null }))).toBe('PT422');
  });
  it('identity columns are immutable', async () => {
    expect(await code(db.query(`update public.tenancies set unit_id = $1 where id = $2`, [u2, tenancy]))).toBe('PT409');
    expect(await code(db.query(`update public.units set property_id = gen_random_uuid() where id = $1`, [unit]))).toBe('PT409');
  });
});

describe('overlapping tenancies', () => {
  it('prevents two active tenancies with overlapping dates on one unit, allows adjacent ones', async () => {
    const u = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'OV'))).id;
    const mk = (start: string, end: string | null) => call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [tenant], { p_start_date: start, p_end_date: end }));
    const a = await mk('2026-01-01', '2026-06-30');
    const b = await mk('2026-06-01', '2026-12-31');   // overlaps a
    const c = await mk('2026-07-01', null);            // adjacent to a, open-ended
    const act = (t: any) => call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: t.id, p_expected_version: t.version });
    await act(a);
    expect(await code(act(b))).toBe('PT409');
    await act(c);
    // a second draft can overlap freely while draft; the second *activation* is what is refused
    const d = await mk('2026-08-01', '2026-09-01');
    expect(await code(act(d))).toBe('PT409');
  });
  it('requires a primary tenant to activate, and keeps one when tenants change', async () => {
    const u = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'PT'))).id;
    const t2 = (await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, 'Pat Partner'))).id;
    const d = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [tenant, t2]));
    const g = await call(db, w.staff, 'get_tenancy', { p_org: w.orgA, p_tenancy: d.id });
    expect(g.tenants.filter((x: any) => x.is_primary)).toHaveLength(1);
    expect(await code(call(db, w.staff, 'remove_tenancy_tenant', { p_org: w.orgA, p_tenancy: d.id, p_tenant: tenant }))).toBe('PT409');
    const swapped = await call(db, w.staff, 'add_tenancy_tenant', { p_org: w.orgA, p_tenancy: d.id, p_tenant: t2, p_is_primary: true });
    expect(swapped.tenants.find((x: any) => x.tenant_id === t2).is_primary).toBe(true);
    const removed = await call(db, w.staff, 'remove_tenancy_tenant', { p_org: w.orgA, p_tenancy: d.id, p_tenant: tenant });
    expect(removed.tenants).toHaveLength(1);
  });
});

describe('concurrent edits (optimistic locking)', () => {
  it('the second writer holding a stale version gets 409 and nothing is overwritten', async () => {
    const t = await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, 'Cleo Concurrent'));
    const edit = (name: string, version: number) => call(db, w.staff, 'update_tenant', {
      p_org: w.orgA, p_tenant: t.id, p_expected_version: version, p_full_name: name, p_email: null, p_phone: null,
      p_emergency_name: null, p_emergency_phone: null, p_notes: null });
    expect((await edit('First Writer', t.version)).version).toBe(2);
    expect(await code(edit('Second Writer', t.version))).toBe('PT409');
    expect((await call(db, w.staff, 'get_tenant', { p_org: w.orgA, p_tenant: t.id })).full_name).toBe('First Writer');
  });
  it('applies to properties, units and leases too', async () => {
    const p = await call(db, w.manager, 'get_property', { p_org: w.orgA, p_property: prop });
    const upd = (version: number) => call(db, w.manager, 'update_property', { ...propertyArgs(w.orgA, { p_name: 'Renamed' }), p_property: prop, p_expected_version: version });
    await upd(p.version);
    expect(await code(upd(p.version))).toBe('PT409');
    expect(await code(call(db, w.staff, 'update_lease', { p_org: w.orgA, p_lease: lease, p_expected_version: 99, p_kind: 'initial',
      p_start_date: '2026-01-01', p_end_date: null, p_signed_on: null, p_notes: null }))).toBe('PT409');
  });
});

describe('time zones and occupancy', () => {
  it('judges occupancy by the property-local date', async () => {
    const today = async (tz: string) => (await db.query<{ d: string }>(`select to_char((now() at time zone $1)::date,'YYYY-MM-DD') d`, [tz])).rows[0]!.d;
    const east = 'Pacific/Kiritimati', west = 'Pacific/Pago_Pago';
    const start = await today(east); // a date that has begun in the east but not yet (or only just) in the west
    const mk = async (tz: string, name: string) => {
      const p = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_name: name, p_timezone: tz }))).id;
      const u = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, p, 'U1'))).id;
      const t = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [tenant], { p_start_date: start, p_end_date: null }));
      await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: t.id, p_expected_version: t.version });
      return (await call(db, w.viewer, 'get_unit', { p_org: w.orgA, p_unit: u })).occupancy;
    };
    expect(await mk(east, 'East')).toBe('occupied');
    expect(await mk(west, 'West')).toBe('upcoming');
  });
  it('shows off-market units as unavailable and empty ones as vacant', async () => {
    const p = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_name: 'Occ' }))).id;
    const a = await call(db, w.manager, 'create_unit', unitArgs(w.orgA, p, 'V'));
    const b = await call(db, w.manager, 'create_unit', unitArgs(w.orgA, p, 'N', { p_is_available: false }));
    expect(a.occupancy).toBe('vacant');
    expect(b.occupancy).toBe('unavailable');
    const filtered = await call(db, w.viewer, 'list_units', { p_org: w.orgA, p_property: p, p_occupancy: 'vacant' });
    expect(filtered.items.map((x: any) => x.reference)).toEqual(['V']);
  });
});

describe('archiving preserves history', () => {
  it('blocks archiving records with open tenancies; archived records leave default lists but stay readable', async () => {
    expect(await code(call(db, w.manager, 'set_property_archived', { p_org: w.orgA, p_property: prop, p_archived: true }))).toBe('PT409');
    expect(await code(call(db, w.manager, 'set_unit_archived', { p_org: w.orgA, p_unit: unit, p_archived: true }))).toBe('PT409');
    expect(await code(call(db, w.manager, 'set_tenant_archived', { p_org: w.orgA, p_tenant: tenant, p_archived: true }))).toBe('PT409');
  });
  it('archives a tenant with only closed tenancies and keeps tenancy history', async () => {
    const t = await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, 'Hank History'));
    const u = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, 'H1'))).id;
    const d = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [t.id], { p_start_date: '2024-01-01', p_end_date: '2024-12-31' }));
    const a = await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: d.version });
    await call(db, w.manager, 'end_tenancy', { p_org: w.orgA, p_tenancy: d.id, p_expected_version: a.version, p_end_date: '2024-12-31', p_reason: null });
    await call(db, w.manager, 'set_tenant_archived', { p_org: w.orgA, p_tenant: t.id, p_archived: true });
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Hank' })).total).toBe(0);
    const archived = await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Hank', p_archived: true });
    expect(archived.total).toBe(1);
    expect((await call(db, w.viewer, 'get_tenant', { p_org: w.orgA, p_tenant: t.id })).tenancies).toHaveLength(1);
    expect(await code(call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, u, [t.id])))).toBe('PT409');
  });
  it('no hard-delete path exists: parent rows cannot be removed while children exist', async () => {
    expect(await code(db.query(`delete from public.units where id = $1`, [unit]))).toBe('23503');
    expect(await code(db.query(`delete from public.tenants where id = $1`, [tenant]))).toBe('23503');
    expect(await code(db.query(`delete from public.organizations where id = $1`, [w.orgA]))).toBe('23503');
  });
  it('blocks changing property currency once tenancies exist', async () => {
    const p = await call(db, w.manager, 'get_property', { p_org: w.orgA, p_property: prop });
    expect(await code(call(db, w.manager, 'update_property', { ...propertyArgs(w.orgA, { p_currency: 'EUR' }), p_property: prop, p_expected_version: p.version }))).toBe('PT409');
  });
});

describe('owners', () => {
  it('supports multiple owners per property and owners across properties, without platform accounts', async () => {
    const p2 = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA, { p_name: 'Shared' }))).id;
    const o1 = (await call(db, w.manager, 'create_owner', { p_org: w.orgA, p_name: 'Olga Owner', p_owner_type: 'individual', p_email: null, p_phone: null, p_notes: null })).id;
    const o2 = (await call(db, w.manager, 'create_owner', { p_org: w.orgA, p_name: 'Holdings Ltd', p_owner_type: 'company', p_email: null, p_phone: null, p_notes: null })).id;
    await call(db, w.manager, 'link_property_owner', { p_org: w.orgA, p_property: p2, p_owner: o1, p_ownership_pct: 60, p_is_primary: true });
    const linked = await call(db, w.manager, 'link_property_owner', { p_org: w.orgA, p_property: p2, p_owner: o2, p_ownership_pct: 40, p_is_primary: false });
    expect(linked.owners).toHaveLength(2);
    expect(linked.owners[0].is_primary).toBe(true);
    await call(db, w.manager, 'link_property_owner', { p_org: w.orgA, p_property: prop, p_owner: o1, p_ownership_pct: null, p_is_primary: true });
    expect((await call(db, w.viewer, 'list_owners', { p_org: w.orgA })).items.find((o: any) => o.id === o1).property_count).toBe(2);
    expect(await code(call(db, w.manager, 'link_property_owner', { p_org: w.orgA, p_property: p2, p_owner: o2, p_ownership_pct: 50, p_is_primary: false }))).toBe('PT422');
  });
  it('rejects linking another organization\'s owner', async () => {
    const bo = (await call(db, w.outsider, 'create_owner', { p_org: w.orgB, p_name: 'B Owner', p_owner_type: 'individual', p_email: null, p_phone: null, p_notes: null })).id;
    expect(await code(call(db, w.manager, 'link_property_owner', { p_org: w.orgA, p_property: prop, p_owner: bo, p_ownership_pct: 10, p_is_primary: false }))).toBe('PT404');
  });
});

describe('lists: search, filter, sort, pagination', () => {
  it('paginates with a stable total, sorts both directions, and escapes LIKE wildcards', async () => {
    for (let i = 1; i <= 5; i++) await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, `Page Person ${i}`, { p_email: `pp${i}@m.test` }));
    await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA, '100% Real_Name'));
    const p1 = await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Page Person', p_limit: 2, p_offset: 0 });
    const p3 = await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Page Person', p_limit: 2, p_offset: 4 });
    expect([p1.total, p1.items.length, p3.items.length]).toEqual([5, 2, 1]);
    const desc = await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Page Person', p_sort: 'name', p_dir: 'desc' });
    expect(desc.items[0].full_name).toBe('Page Person 5');
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: '%' })).total).toBe(1);   // literal %
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'l_Na' })).total).toBe(1); // literal _
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'e%N' })).total).toBe(0);  // % is not a wildcard
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_search: 'Re_l' })).total).toBe(0); // _ is not a wildcard
    expect(await code(call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_sort: 'password; drop table x' }))).toBe('PT422');
    expect((await call(db, w.viewer, 'list_tenants', { p_org: w.orgA, p_limit: 100000 })).items.length).toBeLessThanOrEqual(100);
  });
});

describe('private document storage policies', () => {
  let doc: { id: string; storage_path: string };
  beforeAll(async () => {
    doc = await call(db, w.staff, 'create_document', { p_org: w.orgA, p_lease: lease, p_doc_type: 'lease', p_file_name: 'My Lease (final).pdf', p_mime_type: 'application/pdf', p_size_bytes: 1234 });
  });
  const put = (actor: any, path: string) => as(db, actor, (q) => q(`insert into storage.objects (bucket_id, name) values ('lease-documents', $1)`, [path]));
  const read = (actor: any, path: string) => as(db, actor, async (q) => (await q(`select name from storage.objects where bucket_id='lease-documents' and name=$1`, [path])).rows);

  it('paths are namespaced org/lease/doc and file names are sanitized', () => {
    expect(doc.storage_path).toMatch(new RegExp(`^${w.orgA}/${lease}/${doc.id}-My_Lease_final_.pdf$`));
  });
  it('only staff+ of the owning org may upload to a registered, pending path', async () => {
    expect(await code(put(w.outsider, doc.storage_path))).toBe('42501');
    expect(await code(put(w.viewer, doc.storage_path))).toBe('42501');
    expect(await code(put(w.staff, `${w.orgA}/${lease}/${crypto.randomUUID()}-unregistered.pdf`))).toBe('42501');
    await put(w.staff, doc.storage_path);
  });
  it('a pending file is visible only to its uploader; once confirmed it is readable by staff+ only', async () => {
    expect(await read(w.manager, doc.storage_path)).toEqual([]);   // another staff+ member cannot see it yet
    expect(await read(w.outsider, doc.storage_path)).toEqual([]);
    expect(await read(w.staff, doc.storage_path)).toHaveLength(1);  // the uploader can verify their upload
    expect(await code(call(db, w.viewer, 'confirm_document', { p_org: w.orgA, p_document: doc.id, p_size_bytes: 1234, p_mime_type: 'application/pdf' }))).toBe('PT403');
    expect(await code(call(db, w.outsider, 'confirm_document', { p_org: w.orgA, p_document: doc.id, p_size_bytes: 1234, p_mime_type: 'application/pdf' }))).toBe('PT404');
    await call(db, w.staff, 'confirm_document', { p_org: w.orgA, p_document: doc.id, p_size_bytes: 1234, p_mime_type: 'application/pdf' });
    expect(await read(w.staff, doc.storage_path)).toHaveLength(1);
    expect(await read(w.manager, doc.storage_path)).toHaveLength(1);
    expect(await read(w.viewer, doc.storage_path)).toEqual([]);
    expect(await read(w.outsider, doc.storage_path)).toEqual([]);
    expect(await code(call(db, w.staff, 'confirm_document', { p_org: w.orgA, p_document: doc.id, p_size_bytes: 1, p_mime_type: 'application/pdf' }))).toBe('PT409');
  });
  it('access checks flow through the document\'s own organization', async () => {
    expect(await code(call(db, w.outsider, 'get_document_access', { p_org: w.orgA, p_document: doc.id }))).toBe('PT404');
    expect(await code(call(db, w.outsider, 'get_document_access', { p_org: w.orgB, p_document: doc.id }))).toBe('PT404');
    expect(await code(call(db, w.viewer, 'get_document_access', { p_org: w.orgA, p_document: doc.id }))).toBe('PT403');
    expect((await call(db, w.staff, 'get_document_access', { p_org: w.orgA, p_document: doc.id })).storage_path).toBe(doc.storage_path);
  });
  it('stored objects cannot be overwritten or deleted by any app role', async () => {
    expect(await code(as(db, w.owner, (q) => q(`update storage.objects set name = name || 'x' where name = $1`, [doc.storage_path])))).toBe('42501');
    expect(await code(as(db, w.owner, (q) => q(`delete from storage.objects where name = $1`, [doc.storage_path])))).toBe('42501');
  });
  it('archiving is manager-only, hides the document from the lease, and blocks staff download', async () => {
    expect(await code(call(db, w.staff, 'set_document_archived', { p_org: w.orgA, p_document: doc.id, p_archived: true }))).toBe('PT403');
    await call(db, w.manager, 'set_document_archived', { p_org: w.orgA, p_document: doc.id, p_archived: true });
    expect(await code(call(db, w.staff, 'get_document_access', { p_org: w.orgA, p_document: doc.id }))).toBe('PT404');
    expect((await call(db, w.manager, 'get_document_access', { p_org: w.orgA, p_document: doc.id })).id).toBe(doc.id);
    expect((await call(db, w.staff, 'get_lease', { p_org: w.orgA, p_lease: lease })).documents[0].archived).toBe(true);
  });
});
