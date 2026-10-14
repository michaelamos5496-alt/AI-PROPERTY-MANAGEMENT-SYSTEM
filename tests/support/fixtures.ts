import type { PGlite } from '@electric-sql/pglite';
import { call, createUser, type Actor } from './db.js';

export type Person = NonNullable<Actor>;
export const person = async (db: PGlite, email: string): Promise<Person> => ({ sub: await createUser(db, email), email });

export const propertyArgs = (org: string, over: Record<string, unknown> = {}) => ({
  p_org: org, p_name: 'Maple Court', p_reference: null, p_property_type: 'apartment_building',
  p_address_line1: '1 Maple St', p_address_line2: null, p_city: 'Austin', p_region: 'TX', p_postal_code: '78701',
  p_country: 'US', p_timezone: 'America/Chicago', p_currency: 'USD', p_notes: null, ...over,
});
export const unitArgs = (org: string, property: string, ref = '1A', over: Record<string, unknown> = {}) => ({
  p_org: org, p_property: property, p_reference: ref, p_bedrooms: 2, p_bathrooms: 1, p_floor_area_sqm: 55,
  p_market_rent_minor: 150000, p_is_available: true, p_notes: null, ...over,
});
export const tenantArgs = (org: string, name = 'Tina Tenant', over: Record<string, unknown> = {}) => ({
  p_org: org, p_full_name: name, p_email: `${name.split(' ')[0]!.toLowerCase()}@mail.test`, p_phone: null,
  p_emergency_name: null, p_emergency_phone: null, p_notes: null, ...over,
});
export const tenancyArgs = (org: string, unit: string, tenants: string[], over: Record<string, unknown> = {}) => ({
  p_org: org, p_unit: unit, p_start_date: '2026-01-01', p_end_date: '2026-12-31', p_rent_amount_minor: 150000,
  p_rent_period: 'monthly', p_rent_due_day: 1, p_deposit_amount_minor: 150000, p_deposit_scheme: null,
  p_notice_days: 30, p_notes: null, p_tenant_ids: tenants, ...over,
});

/** Two organizations with a full owner/manager/staff/viewer cast, for isolation + role tests. */
export async function seedWorld(db: PGlite) {
  const owner = await person(db, 'owner@a.test');
  const manager = await person(db, 'manager@a.test');
  const staff = await person(db, 'staff@a.test');
  const viewer = await person(db, 'viewer@a.test');
  const admin = await person(db, 'admin@a.test');
  const outsider = await person(db, 'outsider@b.test');
  const orgA = (await call(db, owner, 'create_organization', { p_name: 'Org Alpha' })).id as string;
  const orgB = (await call(db, outsider, 'create_organization', { p_name: 'Org Bravo' })).id as string;
  for (const [p, role] of [[admin, 'admin'], [manager, 'manager'], [staff, 'staff'], [viewer, 'viewer']] as const) {
    await call(db, owner, 'create_invitation', { p_org: orgA, p_email: p.email, p_role: role, p_token_hash: `h-${role}` });
    await call(db, p, 'accept_invitation', { p_token_hash: `h-${role}` });
  }
  return { owner, admin, manager, staff, viewer, outsider, orgA, orgB };
}
export type World = Awaited<ReturnType<typeof seedWorld>>;

export const key = () => crypto.randomUUID();

/** World + an active tenancy (USD, 1,500.00/month from 2026-01-01) ready for ledger tests. */
export async function seedFinance(db: PGlite) {
  const w = await seedWorld(db);
  const prop = (await call(db, w.manager, 'create_property', propertyArgs(w.orgA))).id as string;
  const unit = (await call(db, w.manager, 'create_unit', unitArgs(w.orgA, prop, '1A'))).id as string;
  const tenant = (await call(db, w.staff, 'create_tenant', tenantArgs(w.orgA))).id as string;
  const t = await call(db, w.staff, 'create_tenancy', tenancyArgs(w.orgA, unit, [tenant], { p_end_date: null }));
  await call(db, w.manager, 'activate_tenancy', { p_org: w.orgA, p_tenancy: t.id, p_expected_version: t.version });
  return { ...w, prop, unit, tenant, tenancy: t.id as string };
}
export type Fin = Awaited<ReturnType<typeof seedFinance>>;

export const scheduleArgs = (org: string, tenancy: string, over: Record<string, unknown> = {}) => ({
  p_org: org, p_tenancy: tenancy, p_amount_minor: 150000, p_period: 'monthly', p_first_due_date: '2026-01-01', p_end_date: null, ...over });
export const paymentArgs = (org: string, tenancy: string, over: Record<string, unknown> = {}) => ({
  p_org: org, p_tenancy: tenancy, p_amount_minor: 150000, p_received_on: '2026-02-01', p_method: 'bank_transfer',
  p_reference: `REF-${key().slice(0, 8)}`, p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: false, ...over });
