import { key } from '../support/fixtures.js';
import { propertyArgs, scheduleArgs, tenancyArgs, tenantArgs, unitArgs } from '../support/fixtures.js';
import type { Pg } from '../support/pg.js';

type Actor = { sub: string; email: string };
export interface Scale { orgs: number; bigProperties: number; bigUnitsPerProperty: number; smallProperties: number; smallUnitsPerProperty: number; months: number; paidMonths: number; requestsPerOrgBig: number; requestsPerOrgSmall: number }
export const SCALES: Record<string, Scale> = {
  smoke: { orgs: 3, bigProperties: 3, bigUnitsPerProperty: 10, smallProperties: 1, smallUnitsPerProperty: 5, months: 6, paidMonths: 3, requestsPerOrgBig: 30, requestsPerOrgSmall: 5 },
  // "realistic expected usage" for the first year: one 1,500-unit portfolio, 19 small landlords (60 units each), 24 months of rent history
  standard: { orgs: 20, bigProperties: 30, bigUnitsPerProperty: 50, smallProperties: 3, smallUnitsPerProperty: 20, months: 24, paidMonths: 6, requestsPerOrgBig: 2500, requestsPerOrgSmall: 80 },
};

export interface OrgSeed { id: string; owner: Actor; manager: Actor; staff: Actor; admin: Actor; properties: string[]; units: string[]; pairs: [string, string][]; tenancies: string[]; tenants: string[]; big: boolean }

/** Run `n` async jobs with at most `c` in flight. */
export async function pool<T>(items: T[], c: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: c }, async () => { for (;;) { const k = i++; if (k >= items.length) return; await fn(items[k]!, k); } }));
}

/** pg's driver turns arrays into Postgres arrays; the shared helper would JSON-encode them, so volume seeding talks to the database itself. */
export const rpc = (pg: Pg, actor: Actor, fn: string, args: Record<string, unknown>) => pg.as(actor, async (q) => {
  const keys = Object.keys(args);
  return (await q(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => { const v = args[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }))).rows[0].r;
});

export async function seedVolume(pg: Pg, s: Scale, log: (m: string) => void): Promise<OrgSeed[]> {
  const t0 = Date.now(); const orgs: OrgSeed[] = [];
  const today = (await pg.admin.query(`select current_date::text d`)).rows[0].d as string;
  for (let o = 0; o < s.orgs; o++) {
    const big = o === 0; const tag = `l${o}`;
    const owner = await pg.createUser(`owner@${tag}.test`); const manager = await pg.createUser(`manager@${tag}.test`); const staff = await pg.createUser(`staff@${tag}.test`); const admin = await pg.createUser(`admin@${tag}.test`);
    const id = (await rpc(pg, owner, 'create_organization', { p_name: big ? 'Big Portfolio Ltd' : `Landlord ${o}` })).id as string;
    for (const [p, role] of [[admin, 'admin'], [manager, 'manager'], [staff, 'staff']] as const) {
      await rpc(pg, owner, 'create_invitation', { p_org: id, p_email: p.email, p_role: role, p_token_hash: `h-${tag}-${role}` });
      await rpc(pg, p, 'accept_invitation', { p_token_hash: `h-${tag}-${role}` });
    }
    await pg.admin.query(`update public.subscriptions set plan_code = 'legacy', status = 'active' where org_id = $1`, [id]);   // volume testing is about the database, not plan limits
    const seed: OrgSeed = { id, owner, manager, staff, admin, properties: [], units: [], pairs: [], tenancies: [], tenants: [], big };
    orgs.push(seed);
    const nProps = big ? s.bigProperties : s.smallProperties; const nUnits = big ? s.bigUnitsPerProperty : s.smallUnitsPerProperty;
    const cur = ['GHS', 'NGN', 'KES', 'USD'][o % 4]!; const tz = { GHS: 'Africa/Accra', NGN: 'Africa/Lagos', KES: 'Africa/Nairobi', USD: 'America/Chicago' }[cur]!;
    for (let p = 0; p < nProps; p++) seed.properties.push((await rpc(pg, manager, 'create_property', propertyArgs(id, { p_name: `Property ${o}-${p}`, p_currency: cur, p_timezone: tz, p_country: cur === 'USD' ? 'US' : 'GH' }))).id);
    await pool(seed.properties.flatMap((p) => Array.from({ length: nUnits }, (_, u) => [p, u] as const)), 16, async ([p, u]) => { const uid = (await rpc(pg, manager, 'create_unit', unitArgs(id, p, `U${u + 1}`))).id as string; seed.units.push(uid); seed.pairs.push([p, uid]); });
    const start = new Date(); start.setMonth(start.getMonth() - s.months); const startDate = start.toISOString().slice(0, 10);
    const occupied = seed.units.slice(0, Math.floor(seed.units.length * 0.93));
    await pool(occupied, 16, async (unit, i) => {
      const t = (await rpc(pg, staff, 'create_tenant', tenantArgs(id, `Tenant ${o}-${i}`, { p_email: `t${o}-${i}@mail.test` }))).id as string; seed.tenants.push(t);
      const tn = await rpc(pg, staff, 'create_tenancy', tenancyArgs(id, unit, [t], { p_start_date: startDate, p_end_date: null, p_rent_amount_minor: 100000 + (i % 40) * 5000 }));
      await rpc(pg, manager, 'activate_tenancy', { p_org: id, p_tenancy: tn.id, p_expected_version: tn.version });
      await rpc(pg, manager, 'create_rent_schedule', scheduleArgs(id, tn.id, { p_amount_minor: tn.rent_amount_minor ?? 100000, p_first_due_date: startDate }));
      await rpc(pg, manager, 'generate_charges', { p_org: id, p_tenancy: tn.id, p_through: today });
      seed.tenancies.push(tn.id);
    });
    // payments: the first `paidMonths` months of most tenancies are paid and auto-allocated oldest-first
    await pool(seed.tenancies.filter((_, i) => i % 10 !== 0), 16, async (tn, i) => {
      for (let m = 0; m < s.paidMonths; m++) {
        const d = new Date(start); d.setMonth(d.getMonth() + m);
        await rpc(pg, staff, 'record_payment', { p_org: id, p_tenancy: tn, p_amount_minor: 100000 + (i % 40) * 5000, p_received_on: d.toISOString().slice(0, 10), p_method: 'bank_transfer', p_reference: `R-${o}-${i}-${m}`, p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: true });
      }
    });
    const nReq = big ? s.requestsPerOrgBig : s.requestsPerOrgSmall;
    await pool(Array.from({ length: nReq }, (_, i) => i), 16, async (i) => {
      await rpc(pg, staff, 'create_maintenance_request', { p_org: id, p_property: seed.pairs[i % seed.pairs.length]![0], p_unit: seed.pairs[i % seed.pairs.length]![1], p_tenancy: null, p_title: `Issue ${i}: tap dripping`, p_description: 'The tap is dripping in the kitchen.', p_category: 'plumbing', p_urgency: null });
    });
    log(`seeded org ${o + 1}/${s.orgs} (${seed.units.length} units, ${seed.tenancies.length} tenancies) after ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  return orgs;
}
