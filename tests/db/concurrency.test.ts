import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { key, propertyArgs, scheduleArgs, tenancyArgs, tenantArgs, unitArgs } from '../support/fixtures.js';
import { startPostgres, type Pg } from '../support/pg.js';

// These run against a real PostgreSQL server with many simultaneous connections.
let pg: Pg;
let w: Awaited<ReturnType<typeof world>>;

async function world(pg: Pg) {
  const owner = await pg.createUser('owner@a.test');
  const admin = await pg.createUser('admin@a.test');
  const manager = await pg.createUser('manager@a.test');
  const staff = await pg.createUser('staff@a.test');
  const org = (await pg.call(owner, 'create_organization', { p_name: 'Org Alpha' })).id as string;
  for (const [p, role] of [[admin, 'admin'], [manager, 'manager'], [staff, 'staff']] as const) {
    await pg.call(owner, 'create_invitation', { p_org: org, p_email: p.email, p_role: role, p_token_hash: `h-${role}` });
    await pg.call(p, 'accept_invitation', { p_token_hash: `h-${role}` });
  }
  const prop = (await pg.call(manager, 'create_property', propertyArgs(org))).id as string;
  return { owner, admin, manager, staff, org, prop };
}

beforeAll(async () => { pg = await startPostgres(); w = await world(pg); }, 180_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

let unitN = 0;
/** A brand-new active tenancy so each test starts from a clean ledger. */
async function tenancy(over: Record<string, unknown> = {}) {
  const unit = (await pg.call(w.manager, 'create_unit', unitArgs(w.org, w.prop, `U${++unitN}`))).id;
  const tenant = (await pg.call(w.staff, 'create_tenant', tenantArgs(w.org, `Tenant ${unitN}`))).id;
  const t = await pg.call(w.staff, 'create_tenancy', tenancyArgs(w.org, unit, [tenant], { p_end_date: null, ...over }));
  await pg.call(w.manager, 'activate_tenancy', { p_org: w.org, p_tenancy: t.id, p_expected_version: t.version });
  return t.id as string;
}
const charge = (t: string, amount: number, due = '2026-01-01') => pg.call(w.manager, 'create_charge',
  { p_org: w.org, p_tenancy: t, p_kind: 'fee', p_description: 'Fee', p_due_date: due, p_amount_minor: amount, p_idempotency_key: key() });
const payment = (t: string, amount: number, over: Record<string, unknown> = {}) => pg.call(w.staff, 'record_payment', {
  p_org: w.org, p_tenancy: t, p_amount_minor: amount, p_received_on: '2026-02-01', p_method: 'bank_transfer', p_reference: `R-${key().slice(0, 10)}`,
  p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: false, ...over });
const allocate = (p: string, charges: [string, number][], k = key()) => pg.call(w.staff, 'allocate_payment', {
  p_org: w.org, p_payment: p, p_allocations: charges.map(([c, a]) => ({ charge_id: c, amount_minor: a })), p_idempotency_key: k });
const num = async (sql: string, params: unknown[] = []) => Number((await pg.admin.query(sql, params)).rows[0].n);
const codes = (rs: PromiseSettledResult<unknown>[]) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as any).code));
const tally = (cs: string[]) => cs.reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
const reconcile = () => pg.call(w.manager, 'reconcile_finance', { p_org: w.org });

describe('PostgreSQL (real server)', () => {
  it('runs on a modern PostgreSQL and every migration is repeatable', async () => {
    expect(Number((await pg.version()).split('.')[0])).toBeGreaterThanOrEqual(15);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { migrationFiles, migrationsDir } = await import('../support/db.js');
    for (const f of migrationFiles()) await pg.admin.query(readFileSync(join(migrationsDir, f), 'utf8'));
    expect((await reconcile()).ok).toBe(true);
  });
});

describe('concurrent charge generation', () => {
  it('20 simultaneous runs create each charge exactly once, with no errors', async () => {
    const t = await tenancy({ p_start_date: '2026-01-01' });
    await pg.call(w.manager, 'create_rent_schedule', scheduleArgs(w.org, t));
    const runs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      pg.call(w.manager, 'generate_charges', { p_org: w.org, p_tenancy: i % 2 ? t : null, p_through: '2026-12-01' })));
    expect(tally(codes(runs))).toEqual({ ok: 20 });
    const created = runs.reduce((n, r) => n + (r.status === 'fulfilled' ? (r.value as any).created : 0), 0);
    expect(created).toBe(12);                                                                // Jan..Dec, each created by exactly one run
    expect(await num(`select count(*) n from public.charges where tenancy_id = $1`, [t])).toBe(12);
    expect(await num(`select count(distinct due_date) n from public.charges where tenancy_id = $1`, [t])).toBe(12);
  });
});

describe('concurrent allocation', () => {
  it('many requests racing for one charge can never over-pay it', async () => {
    const t = await tenancy();
    const c = await charge(t, 500);
    const p = await payment(t, 100000);
    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => allocate(p.id, [[c.id, 100]])));
    expect(tally(codes(rs))).toEqual({ ok: 5, PT409: 15 });
    expect(await num(`select coalesce(sum(amount_minor),0) n from public.payment_allocations where charge_id = $1 and reversed_at is null`, [c.id])).toBe(500);
    expect((await reconcile()).ok).toBe(true);
  });

  it('many requests racing on one payment can never over-spend it', async () => {
    const t = await tenancy();
    const cs = await Promise.all(Array.from({ length: 20 }, (_, i) => charge(t, 1000, `2026-01-${String(i + 1).padStart(2, '0')}`)));
    const p = await payment(t, 7000);
    const rs = await Promise.allSettled(cs.map((c) => allocate(p.id, [[c.id, 1000]])));
    expect(tally(codes(rs))).toEqual({ ok: 7, PT409: 13 });
    expect(await num(`select coalesce(sum(amount_minor),0) n from public.payment_allocations where payment_id = $1 and reversed_at is null`, [p.id])).toBe(7000);
    expect((await reconcile()).ok).toBe(true);
  });

  it('a retried request (same idempotency key) sent 10 times in parallel applies once', async () => {
    const t = await tenancy();
    const c = await charge(t, 100000);
    const p = await payment(t, 100000);
    const k = key();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => allocate(p.id, [[c.id, 40000]], k)));
    expect(tally(codes(rs))).toEqual({ ok: 10 });
    const replayed = rs.filter((r) => r.status === 'fulfilled' && (r.value as any).replayed).length;
    expect(replayed).toBe(9);
    expect(await num(`select count(*) n from public.payment_allocations where payment_id = $1`, [p.id])).toBe(1);
    expect(await num(`select sum(amount_minor) n from public.payment_allocations where payment_id = $1`, [p.id])).toBe(40000);
  });

  it('two payments auto-allocating onto the same charges never double-apply, and never deadlock', async () => {
    const t = await tenancy();
    await Promise.all([1, 2, 3].map((i) => charge(t, 100000, `2026-0${i}-01`)));
    const ps = await Promise.all([payment(t, 250000), payment(t, 250000), payment(t, 250000)]);
    const rs = await Promise.allSettled(ps.flatMap((p) => [0, 1].map(() => pg.call(w.staff, 'auto_allocate_payment', { p_org: w.org, p_payment: p.id }))));
    expect(tally(codes(rs))).toEqual({ ok: 6 });
    expect(await num(`select coalesce(sum(a.amount_minor),0) n from public.payment_allocations a join public.charges c on c.id = a.charge_id where c.tenancy_id = $1 and a.reversed_at is null`, [t])).toBe(300000);
    const ledger = await pg.call(w.staff, 'get_tenancy_ledger', { p_org: w.org, p_tenancy: t });
    expect(ledger.summary).toMatchObject({ charged_minor: 300000, allocated_minor: 300000, outstanding_minor: 0, credit_minor: 450000 });
    expect((await reconcile()).ok).toBe(true);
  });

  it('mixed manual and automatic allocation orders do not deadlock', async () => {
    const t = await tenancy();
    const cs = await Promise.all([1, 2, 3, 4].map((i) => charge(t, 10000, `2026-0${i}-01`)));
    const ps = await Promise.all(Array.from({ length: 8 }, () => payment(t, 20000)));
    const ops = ps.map((p, i) => i % 2
      ? pg.call(w.staff, 'auto_allocate_payment', { p_org: w.org, p_payment: p.id })
      : allocate(p.id, (i % 4 ? [...cs].reverse() : cs).map((c) => [c.id, 5000] as [string, number])));
    const rs = await Promise.allSettled(ops);
    expect(codes(rs).filter((c) => c === '40P01')).toEqual([]);
    expect(codes(rs).every((c) => c === 'ok' || c === 'PT409')).toBe(true);
    expect((await reconcile()).ok).toBe(true);
  });
});

describe('concurrent corrections', () => {
  it('reversing a payment while it is being allocated leaves a consistent ledger', async () => {
    for (let round = 0; round < 12; round++) {
      const t = await tenancy();
      const c = await charge(t, 5000);
      const p = await payment(t, 5000);
      const rs = await Promise.allSettled([allocate(p.id, [[c.id, 5000]]), pg.call(w.manager, 'reverse_payment', { p_org: w.org, p_payment: p.id, p_reason: 'bounced' })]);
      expect(codes(rs).every((x) => x === 'ok' || x === 'PT409')).toBe(true);
      expect(await num(`select count(*) n from public.payment_allocations a where a.payment_id = $1 and a.reversed_at is null`, [p.id])).toBe(0);
      expect((await pg.call(w.staff, 'get_payment', { p_org: w.org, p_payment: p.id })).status).toBe('reversed');
    }
    expect((await reconcile()).ok).toBe(true);
  });

  it('adjusting a charge down while it is being paid can never leave it over-paid', async () => {
    let allocFirst = 0; let adjustFirst = 0;
    for (let round = 0; round < 15; round++) {
      const t = await tenancy();
      const c = await charge(t, 1000);
      const p = await payment(t, 1000);
      const rs = await Promise.allSettled([
        allocate(p.id, [[c.id, 500]]),
        pg.call(w.admin, 'adjust_charge', { p_org: w.org, p_charge: c.id, p_amount_minor: -900, p_reason: 'waiver', p_idempotency_key: key() })]);
      const cs = codes(rs);
      // exactly one wins: paying 500 AND waiving 900 of a 1000 charge would leave 100 owed with 500 paid
      expect(cs.filter((x) => x === 'ok')).toHaveLength(1);
      expect(cs.filter((x) => x !== 'ok')).toEqual(['PT409']);
      const st = (await pg.admin.query(`select effective_minor, allocated_minor, outstanding_minor from app.charge_state where id = $1`, [c.id])).rows[0];
      expect(Number(st.allocated_minor)).toBeLessThanOrEqual(Number(st.effective_minor));
      expect(Number(st.outstanding_minor)).toBeGreaterThanOrEqual(0);
      if (cs[0] === 'ok') allocFirst++; else adjustFirst++;
    }
    expect(allocFirst + adjustFirst).toBe(15);
    expect((await reconcile()).ok).toBe(true);
  });

  it('voiding a charge while it is being paid is all-or-nothing', async () => {
    for (let round = 0; round < 12; round++) {
      const t = await tenancy();
      const c = await charge(t, 1000);
      const p = await payment(t, 1000);
      const rs = await Promise.allSettled([allocate(p.id, [[c.id, 1000]]), pg.call(w.manager, 'void_charge', { p_org: w.org, p_charge: c.id, p_reason: 'duplicate' })]);
      expect(codes(rs).every((x) => x === 'ok' || x === 'PT409')).toBe(true);
      const voided = (await pg.admin.query(`select voided_at is not null v from public.charges where id = $1`, [c.id])).rows[0].v;
      const active = await num(`select count(*) n from public.payment_allocations where charge_id = $1 and reversed_at is null`, [c.id]);
      expect(voided && active > 0).toBe(false);                 // a void charge never holds money
    }
    expect((await reconcile()).ok).toBe(true);
  });
});

describe('concurrent payments and receipts', () => {
  it('the same payment submitted 10 times at once is recorded once', async () => {
    const t = await tenancy();
    const args = { p_org: w.org, p_tenancy: t, p_amount_minor: 99900, p_received_on: '2026-02-01', p_method: 'cash', p_reference: 'DOUBLE-CLICK', p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: false };
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => pg.call(w.staff, 'record_payment', args)));
    expect(tally(codes(rs))).toEqual({ ok: 10 });
    const ids = new Set(rs.map((r) => (r as PromiseFulfilledResult<any>).value.id));
    expect(ids.size).toBe(1);
    expect(await num(`select count(*) n from public.payments where tenancy_id = $1`, [t])).toBe(1);
    expect(await num(`select count(*) n from public.finance_audit where action = 'payment.recorded' and entity_id = $1`, [[...ids][0]])).toBe(1);
  });

  it('the same bank reference entered concurrently with different keys is accepted exactly once', async () => {
    const t = await tenancy();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => payment(t, 5000, { p_reference: 'SHARED-REF' })));
    expect(tally(codes(rs))).toEqual({ ok: 1, PT409: 9 });
    expect(await num(`select count(*) n from public.payments where tenancy_id = $1`, [t])).toBe(1);
  });

  it('concurrent receipt requests for one payment create one receipt; different payments get distinct gapless numbers', async () => {
    const t = await tenancy();
    const p = await payment(t, 1000);
    const same = await Promise.allSettled(Array.from({ length: 10 }, () => pg.call(w.staff, 'issue_receipt', { p_org: w.org, p_payment: p.id })));
    expect(tally(codes(same))).toEqual({ ok: 10 });
    expect(new Set(same.map((r) => (r as PromiseFulfilledResult<any>).value.number)).size).toBe(1);
    const before = await num(`select coalesce(max(seq),0) n from public.receipts where org_id = $1`, [w.org]);
    const ps = await Promise.all(Array.from({ length: 12 }, () => payment(t, 100)));
    const many = await Promise.allSettled(ps.map((x) => pg.call(w.staff, 'issue_receipt', { p_org: w.org, p_payment: x.id })));
    expect(tally(codes(many))).toEqual({ ok: 12 });
    const seqs = (await pg.admin.query(`select seq from public.receipts where org_id = $1 and seq > $2 order by seq`, [w.org, before])).rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => before + i + 1));
  });
});

describe('whole-organization consistency after all of the above', () => {
  it('reconciliation passes and no allocation violates a limit', async () => {
    const r = await reconcile();
    expect(r.ok).toBe(true);
    expect(r.checks.every((c: any) => c.ok)).toBe(true);
    expect(await num(`select count(*) n from app.charge_state where voided_at is null and outstanding_minor < 0`)).toBe(0);
    expect(await num(`select count(*) n from app.payment_state where reversed_at is null and unallocated_minor < 0`)).toBe(0);
  });
});
