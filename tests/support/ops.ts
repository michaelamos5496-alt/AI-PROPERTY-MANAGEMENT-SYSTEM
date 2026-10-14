import { PGlite } from '@electric-sql/pglite';
import { call, createTestDb, createUser } from './db.js';
import { key, person, seedFinance, tenancyArgs, tenantArgs, unitArgs } from './fixtures.js';

export const svc = { service: true } as const;
export { key };

/**
 * Org A (owner, admin, manager, staff, viewer) + outsider org B, plus:
 *  - Tina: tenant on the active tenancy of unit 1A, verified for the portal
 *  - Omar: another tenant on unit 2B, verified for the portal (for isolation tests)
 *  - a vendor
 */
export async function seedOps(db: PGlite) {
  const f = await seedFinance(db);
  const link = async (tenant: string, email: string) => {
    const user = await createUser(db, email);
    const actor = { sub: user, email };
    await call(db, f.manager, 'invite_tenant_to_portal', { p_org: f.orgA, p_tenant: tenant, p_token_hash: `th-${email}` });
    await call(db, actor, 'accept_tenant_invitation', { p_token_hash: `th-${email}` });
    return actor;
  };
  const tina = await link(f.tenant, 'tina@mail.test');
  const unit2 = (await call(db, f.manager, 'create_unit', unitArgs(f.orgA, f.prop, '2B'))).id as string;
  const omarTenant = (await call(db, f.staff, 'create_tenant', tenantArgs(f.orgA, 'Omar Other', { p_email: 'omar@mail.test' }))).id as string;
  const t2 = await call(db, f.staff, 'create_tenancy', tenancyArgs(f.orgA, unit2, [omarTenant], { p_end_date: null }));
  await call(db, f.manager, 'activate_tenancy', { p_org: f.orgA, p_tenancy: t2.id, p_expected_version: t2.version });
  const omar = await link(omarTenant, 'omar@mail.test');
  const vendor = (await call(db, f.manager, 'save_vendor', { p_org: f.orgA, p_vendor: null, p_expected_version: null, p_name: 'HeatCo Plumbing', p_contact_name: 'Hal', p_email: 'hal@heatco.test', p_phone: null, p_categories: ['plumbing', 'heating_cooling'], p_notes: null })).id as string;
  return { ...f, tina, omar, unit2, tenancy2: t2.id as string, omarTenant, vendor };
}
export type Ops = Awaited<ReturnType<typeof seedOps>>;

export const reqArgs = (o: Ops, over: Record<string, unknown> = {}) => ({
  p_org: o.orgA, p_property: o.prop, p_unit: o.unit, p_tenancy: null, p_title: 'Kitchen tap dripping', p_description: 'The cold tap in the kitchen drips constantly.',
  p_category: 'plumbing', p_urgency: null, ...over });
export const portalArgs = (o: Ops, over: Record<string, unknown> = {}) => ({
  p_org: o.orgA, p_tenancy: o.tenancy, p_title: 'Bedroom window will not close', p_description: 'The latch is broken.', p_category: 'structural', p_urgency: null, ...over });
export const settingsArgs = (org: string, over: Record<string, unknown> = {}) => ({
  p_org: org, p_escalation_user: null, p_backup_user: null, p_critical_keywords: ['gas leak', 'flooding'], p_ack_hours: 2, p_approval_thresholds: {}, p_allow_self_approval: false, ...over });

export async function urgency(db: PGlite, o: Ops, k: string): Promise<string> {
  const levels = await call(db, o.staff, 'list_urgency_levels', { p_org: o.orgA });
  return levels.find((l: any) => l.key === k).id;
}
export const today = async (db: PGlite, tz = 'America/Chicago') =>
  (await db.query<{ d: string }>(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') d`, [tz])).rows[0]!.d;
export const addDays = async (db: PGlite, iso: string, n: number) =>
  (await db.query<{ d: string }>(`select to_char($1::date + $2::int, 'YYYY-MM-DD') d`, [iso, n])).rows[0]!.d;
export const count = async (db: PGlite, sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
export { person };

/* ---- fast fresh databases: seed once, restore a snapshot for every test ---- */
let baseline: { dump: Blob; world: Omit<Ops, never> } | null = null;

/** A pristine, fully seeded database. The world object (ids/actors) is identical for every call. */
export async function freshOps(): Promise<{ db: PGlite; o: Ops }> {
  if (!baseline) {
    const db = await createTestDb();
    const world = await seedOps(db);
    baseline = { dump: await db.dumpDataDir('none'), world };
    await db.close();
  }
  const db = new PGlite({ loadDataDir: baseline.dump });
  await db.waitReady;
  return { db, o: baseline.world };
}
