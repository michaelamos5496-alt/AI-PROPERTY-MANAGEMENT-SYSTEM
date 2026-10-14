import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { as, call, code, createTestDb } from '../support/db.js';
import { key, paymentArgs, propertyArgs, scheduleArgs, seedFinance, tenancyArgs, tenantArgs, unitArgs, type Fin } from '../support/fixtures.js';

let db: PGlite;
let f: Fin;
// A fresh database per test keeps money assertions exact and independent.
beforeEach(async () => { db = await createTestDb(); f = await seedFinance(db); });

const ledger = (actor = f.staff, tenancy = f.tenancy) => call(db, actor, 'get_tenancy_ledger', { p_org: f.orgA, p_tenancy: tenancy });
const generate = (through: string, actor = f.manager, tenancy: string | null = f.tenancy) => call(db, actor, 'generate_charges', { p_org: f.orgA, p_tenancy: tenancy, p_through: through });
const manualCharge = (amount: number, due = '2026-01-01', over: Record<string, unknown> = {}) =>
  call(db, f.manager, 'create_charge', { p_org: f.orgA, p_tenancy: f.tenancy, p_kind: 'fee', p_description: 'Fee', p_due_date: due, p_amount_minor: amount, p_idempotency_key: key(), ...over });
const pay = (over: Record<string, unknown> = {}) => call(db, f.staff, 'record_payment', paymentArgs(f.orgA, f.tenancy, over));
const allocate = (payment: string, items: [string, number][], k = key(), actor = f.staff) =>
  call(db, actor, 'allocate_payment', { p_org: f.orgA, p_payment: payment, p_allocations: items.map(([c, a]) => ({ charge_id: c, amount_minor: a })), p_idempotency_key: k });
const charges = async () => (await ledger()).charges as any[];
const sumRows = async (sql: string) => Number((await db.query<{ s: string }>(sql)).rows[0]!.s);
const reconcile = (actor = f.manager) => call(db, actor, 'reconcile_finance', { p_org: f.orgA });

describe('recurring schedules and idempotent charge generation', () => {
  it('generates one charge per period, and re-running changes nothing', async () => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    expect((await generate('2026-03-31')).created).toBe(3);
    expect((await generate('2026-03-31')).created).toBe(0);
    expect((await generate('2026-03-31', f.manager, null)).created).toBe(0);
    expect((await generate('2026-04-30')).created).toBe(1);
    const cs = await charges();
    expect(cs.map((c) => c.due_date).sort()).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
    expect(cs.every((c) => c.amount_minor === 150000 && c.currency === 'USD')).toBe(true);
    expect(cs.find((c) => c.due_date === '2026-01-01').period_end).toBe('2026-01-31');
  });

  it('anchors month-end schedules without drift (31st → 28th → 31st → 30th)', async () => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_first_due_date: '2026-01-31' }));
    await generate('2026-05-31');
    expect((await charges()).map((c) => c.due_date).sort()).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it.each([
    ['weekly', '2026-01-01', '2026-01-29', ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29']],
    ['fortnightly', '2026-01-01', '2026-02-12', ['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12']],
    ['quarterly', '2026-01-15', '2026-10-01', ['2026-01-15', '2026-04-15', '2026-07-15']],
    ['annually', '2026-02-28', '2027-03-01', ['2026-02-28', '2027-02-28']],   // look-ahead is capped at 366 days from today
  ])('%s due dates', async (period, first, through, expected) => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_period: period, p_first_due_date: first }));
    await generate(through as string);
    expect((await charges()).map((c) => c.due_date).sort()).toEqual(expected);
  });

  it('a leap-day anniversary clamps to 28 Feb in common years', async () => {
    const t0 = await call(db, f.staff, 'create_tenancy', tenancyArgs(f.orgA, (await call(db, f.manager, 'create_unit', unitArgs(f.orgA, f.prop, 'LP'))).id, [f.tenant], { p_start_date: '2024-02-29', p_end_date: null }));
    await call(db, f.manager, 'activate_tenancy', { p_org: f.orgA, p_tenancy: t0.id, p_expected_version: t0.version });
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, t0.id, { p_period: 'annually', p_first_due_date: '2024-02-29' }));
    await call(db, f.manager, 'generate_charges', { p_org: f.orgA, p_tenancy: t0.id, p_through: '2026-03-01' });
    const l = await ledger(f.staff, t0.id);
    expect(l.charges.map((c: any) => c.due_date).sort()).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
  });

  it('honours the schedule end date and never generates for draft or ended tenancies', async () => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_end_date: '2026-02-15' }));
    expect((await generate('2026-12-31')).created).toBe(2);
    const u2 = (await call(db, f.manager, 'create_unit', unitArgs(f.orgA, f.prop, '2B'))).id;
    const draft = await call(db, f.staff, 'create_tenancy', tenancyArgs(f.orgA, u2, [f.tenant]));
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, draft.id));
    const r = await call(db, f.manager, 'generate_charges', { p_org: f.orgA, p_tenancy: draft.id, p_through: '2026-12-31' });
    expect(r.created).toBe(0);
  });

  it('caps look-ahead so a far-future date cannot create unbounded charges', async () => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    const r = await generate('2099-12-31');
    expect(r.created).toBeLessThan(30);
  });

  it('allows one active schedule; a replacement may not re-bill earlier periods', async () => {
    const s = await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    expect(await code(call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_first_due_date: '2026-06-01' })))).toBe('PT409');
    await generate('2026-03-31');
    await call(db, f.manager, 'stop_rent_schedule', { p_org: f.orgA, p_schedule: s.id, p_reason: 'rent review' });
    await call(db, f.manager, 'stop_rent_schedule', { p_org: f.orgA, p_schedule: s.id, p_reason: 'again' });      // idempotent
    expect(await code(call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_first_due_date: '2026-03-15' })))).toBe('PT409');
    const s2 = await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_first_due_date: '2026-04-01', p_amount_minor: 160000 }));
    expect(s2.amount_minor).toBe(160000);
    await generate('2026-05-31');
    const cs = await charges();
    expect(cs.filter((c) => c.due_date >= '2026-04-01').every((c) => c.amount_minor === 160000)).toBe(true);
    expect(cs.filter((c) => c.due_date < '2026-04-01').every((c) => c.amount_minor === 150000)).toBe(true);
  });

  it('a voided generated charge is not silently recreated', async () => {
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    await generate('2026-02-28');
    const c = (await charges()).find((x) => x.due_date === '2026-01-01');
    await call(db, f.manager, 'void_charge', { p_org: f.orgA, p_charge: c.id, p_reason: 'billed in error' });
    expect((await generate('2026-02-28')).created).toBe(0);
    expect((await charges()).find((x) => x.id === c.id).status).toBe('void');
  });

  it('rejects schedules for the wrong tenancy state or dates', async () => {
    expect(await code(call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_first_due_date: '2025-12-31' })))).toBe('PT422');
    expect(await code(call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_amount_minor: 0 })))).toBe('23514');
    expect(await code(call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy, { p_end_date: '2025-06-01' })))).toBe('23514');
  });
});

describe('payments: recording, duplicates and idempotency', () => {
  it('records a manual payment that is explicitly unverified', async () => {
    const p = await pay({ p_reference: 'BANK-123', p_note: 'cheque deposited' });
    expect(p).toMatchObject({ amount_minor: 150000, currency: 'USD', status: 'unallocated', unallocated_minor: 150000, verification: 'manual_unverified', replayed: false });
    expect(await code(db.query(`update public.payments set verification = 'verified' where id = $1`, [p.id]))).toBe('PT409');   // immutable
    expect(await code(db.query(`insert into public.payments (org_id,tenancy_id,currency,amount_minor,received_on,method,reference,verification,idempotency_key,created_by)
      values ($1,$2,'USD',100,'2026-01-01','cash','V-1','verified','verified-key-1',$3)`, [f.orgA, f.tenancy, f.owner.sub]))).toBe('23514');   // can never be claimed verified
  });

  it('a repeated request with the same idempotency key creates nothing new', async () => {
    const args = paymentArgs(f.orgA, f.tenancy, { p_reference: 'ONCE' });
    const a = await call(db, f.staff, 'record_payment', args);
    const b = await call(db, f.staff, 'record_payment', args);
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect(await sumRows(`select count(*) s from public.payments`)).toBe(1);
    expect(await sumRows(`select count(*) s from public.finance_audit where action = 'payment.recorded'`)).toBe(1);
  });

  it('refuses to reuse a key for a different payment', async () => {
    const args = paymentArgs(f.orgA, f.tenancy, { p_reference: 'KEYREUSE' });
    await call(db, f.staff, 'record_payment', args);
    expect(await code(call(db, f.staff, 'record_payment', { ...args, p_amount_minor: 1 }))).toBe('PT409');
  });

  it('rejects the same bank reference twice (case/space-insensitive) until the first is reversed', async () => {
    const first = await pay({ p_reference: 'Ref 42' });
    expect(await code(pay({ p_reference: ' ref 42 ' }))).toBe('PT409');
    await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: first.id, p_reason: 'bounced' });
    expect((await pay({ p_reference: 'Ref 42' })).status).toBe('unallocated');
  });

  it('rejects future dates, foreign currencies and payers who are not on the tenancy', async () => {
    expect(await code(pay({ p_received_on: '2999-01-01' }))).toBe('PT422');
    expect(await code(pay({ p_currency: 'EUR' }))).toBe('PT422');
    const stranger = (await call(db, f.staff, 'create_tenant', tenantArgs(f.orgA, 'Sam Stranger'))).id;
    expect(await code(pay({ p_tenant: stranger }))).toBe('PT422');
    expect(await code(pay({ p_amount_minor: 0 }))).toBe('23514');
    expect(await code(pay({ p_amount_minor: 1_000_000_000_001 }))).toBe('23514');
    expect(await code(pay({ p_reference: '   ' }))).toBe('23514');
  });
});

describe('allocation, partial payments, arrears, advance payments', () => {
  it('a partial payment leaves the charge partially paid with the exact remainder', async () => {
    const c = await manualCharge(150000);
    const p = await pay({ p_amount_minor: 100000 });
    const out = await allocate(p.id, [[c.id, 100000]]);
    expect(out).toMatchObject({ status: 'allocated', allocated_minor: 100000, unallocated_minor: 0 });
    const cs = (await charges())[0];
    expect(cs).toMatchObject({ status: 'partial', allocated_minor: 100000, outstanding_minor: 50000, is_overdue: true });
    expect((await ledger()).summary).toMatchObject({ charged_minor: 150000, allocated_minor: 100000, outstanding_minor: 50000, overdue_minor: 50000, credit_minor: 0, net_minor: 50000 });
  });

  it('arrears: unpaid past-due charges are overdue, future ones are not', async () => {
    await manualCharge(100000, '2026-01-01');
    await manualCharge(100000, '2999-01-01');
    const l = await ledger();
    expect(l.summary).toMatchObject({ charged_minor: 200000, outstanding_minor: 200000, overdue_minor: 100000 });
    const od = await call(db, f.staff, 'list_charges', { p_org: f.orgA, p_status: 'overdue' });
    expect(od.total).toBe(1);
  });

  it('an overpayment is kept as unallocated credit, and can be applied to later charges', async () => {
    const c1 = await manualCharge(100000, '2026-01-01');
    const p = await pay({ p_amount_minor: 250000 });
    await allocate(p.id, [[c1.id, 100000]]);
    const l = await ledger();
    expect(l.summary).toMatchObject({ outstanding_minor: 0, credit_minor: 150000, net_minor: -150000 });
    expect((await call(db, f.staff, 'get_payment', { p_org: f.orgA, p_payment: p.id })).status).toBe('partial');
    await manualCharge(100000, '2026-02-01');                                   // a later charge does NOT consume credit implicitly
    expect((await ledger()).summary).toMatchObject({ outstanding_minor: 100000, credit_minor: 150000 });
    const applied = await call(db, f.staff, 'auto_allocate_payment', { p_org: f.orgA, p_payment: p.id });
    expect(applied).toMatchObject({ allocated_minor: 200000, unallocated_minor: 50000, status: 'partial' });
    expect((await ledger()).summary).toMatchObject({ outstanding_minor: 0, credit_minor: 50000 });
  });

  it('an advance payment (before any charge exists) sits as credit and then auto-applies when charges arrive', async () => {
    const p = await pay({ p_amount_minor: 300000 });
    expect((await ledger()).summary).toMatchObject({ credit_minor: 300000, outstanding_minor: 0 });
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    await generate('2026-02-28');
    await call(db, f.staff, 'auto_allocate_payment', { p_org: f.orgA, p_payment: p.id });
    expect((await ledger()).summary).toMatchObject({ outstanding_minor: 0, credit_minor: 0, allocated_minor: 300000 });
    expect((await charges()).every((c) => c.status === 'paid')).toBe(true);
  });

  it('record_payment can auto-allocate oldest-first in the same transaction', async () => {
    await manualCharge(100000, '2026-03-01'); await manualCharge(100000, '2026-01-01'); await manualCharge(100000, '2026-02-01');
    const p = await pay({ p_amount_minor: 150000, p_auto_allocate: true });
    expect(p).toMatchObject({ allocated_minor: 150000, status: 'allocated' });
    const byDue = Object.fromEntries((await charges()).map((c) => [c.due_date, c.status]));
    expect(byDue).toEqual({ '2026-01-01': 'paid', '2026-02-01': 'partial', '2026-03-01': 'unpaid' });
  });

  it('cannot allocate more than the payment holds or more than the charge needs', async () => {
    const c = await manualCharge(100000);
    const c2 = await manualCharge(100000, '2026-02-01');
    const p = await pay({ p_amount_minor: 150000 });
    expect(await code(allocate(p.id, [[c.id, 100000], [c2.id, 100000]]))).toBe('PT409');          // 200000 > 150000
    expect(await code(allocate(p.id, [[c.id, 100001]]))).toBe('PT409');                          // more than the charge
    expect(await sumRows(`select count(*) s from public.payment_allocations`)).toBe(0);          // all-or-nothing
    await allocate(p.id, [[c.id, 100000]]);
    expect(await code(allocate(p.id, [[c2.id, 60000]]))).toBe('PT409');                          // only 50000 left
    const q = await pay({ p_amount_minor: 500000 });
    expect(await code(allocate(q.id, [[c.id, 1]]))).toBe('PT409');                               // charge already fully paid
  });

  it('is idempotent for a repeated request and distinguishes separate requests', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    const k = key();
    const a = await allocate(p.id, [[c.id, 40000]], k);
    const b = await allocate(p.id, [[c.id, 40000]], k);
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(await sumRows(`select sum(amount_minor) s from public.payment_allocations`)).toBe(40000);
    await allocate(p.id, [[c.id, 40000]], key());                                                 // a genuinely new request
    expect(await sumRows(`select sum(amount_minor) s from public.payment_allocations`)).toBe(80000);
  });

  it('rejects duplicate charges in one request, non-positive amounts and unknown charges', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    expect(await code(allocate(p.id, [[c.id, 10], [c.id, 20]]))).toBe('PT422');
    expect(await code(allocate(p.id, [[c.id, 0]]))).toBe('PT422');
    expect(await code(allocate(p.id, [[c.id, -5]]))).toBe('PT422');
    expect(await code(allocate(p.id, [[crypto.randomUUID(), 5]]))).toBe('PT404');
  });

  it('never allocates across tenancies or currencies', async () => {
    // a second property in EUR with its own tenancy and charge
    const eurProp = (await call(db, f.manager, 'create_property', propertyArgs(f.orgA, { p_name: 'Euro Court', p_currency: 'EUR', p_country: 'DE', p_timezone: 'Europe/Berlin' }))).id;
    const eurUnit = (await call(db, f.manager, 'create_unit', unitArgs(f.orgA, eurProp, 'E1'))).id;
    const eurT = await call(db, f.staff, 'create_tenancy', tenancyArgs(f.orgA, eurUnit, [f.tenant]));
    await call(db, f.manager, 'activate_tenancy', { p_org: f.orgA, p_tenancy: eurT.id, p_expected_version: eurT.version });
    const eurCharge = await call(db, f.manager, 'create_charge', { p_org: f.orgA, p_tenancy: eurT.id, p_kind: 'fee', p_description: 'EUR fee', p_due_date: '2026-01-01', p_amount_minor: 5000, p_idempotency_key: key() });
    expect(eurCharge.currency).toBe('EUR');
    const usdPayment = await pay({ p_amount_minor: 10000 });
    // through the API: refused with a clear error
    expect(await code(allocate(usdPayment.id, [[eurCharge.id, 5000]]))).toBe('PT422');
    // and the database refuses it even if application code were bypassed (FKs bind tenancy + currency)
    const base = [f.orgA, usdPayment.id, eurCharge.id];
    expect(await code(db.query(`insert into public.payment_allocations (org_id,payment_id,charge_id,tenancy_id,currency,amount_minor,created_by) values ($1,$2,$3,$4,'USD',5000,$5)`,
      [...base, f.tenancy, f.owner.sub]))).toBe('23503');
    expect(await code(db.query(`insert into public.payment_allocations (org_id,payment_id,charge_id,tenancy_id,currency,amount_minor,created_by) values ($1,$2,$3,$4,'EUR',5000,$5)`,
      [...base, eurT.id, f.owner.sub]))).toBe('23503');
    // a charge cannot carry a currency different from its tenancy either
    expect(await code(db.query(`insert into public.charges (org_id,tenancy_id,currency,kind,description,due_date,amount_minor) values ($1,$2,'EUR','fee','x','2026-01-01',5)`, [f.orgA, f.tenancy]))).toBe('23503');
    expect(await sumRows(`select count(*) s from public.payment_allocations`)).toBe(0);
  });
});

describe('reversals, voids and adjustments keep history', () => {
  it('reversing an allocation restores the charge balance and keeps the row', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    const out = await allocate(p.id, [[c.id, 100000]]);
    const a = out.allocations[0].id;
    expect(await code(call(db, f.staff, 'reverse_allocation', { p_org: f.orgA, p_allocation: a, p_reason: 'wrong charge' }))).toBe('PT403');
    const r = await call(db, f.manager, 'reverse_allocation', { p_org: f.orgA, p_allocation: a, p_reason: 'wrong charge' });
    expect(r).toMatchObject({ status: 'unallocated', unallocated_minor: 100000 });
    expect((await charges())[0]).toMatchObject({ status: 'unpaid', outstanding_minor: 100000 });
    await call(db, f.manager, 'reverse_allocation', { p_org: f.orgA, p_allocation: a, p_reason: 'again' });          // repeat is a no-op
    expect(await sumRows(`select count(*) s from public.finance_audit where action = 'allocation.reversed'`)).toBe(1);
    expect(await sumRows(`select count(*) s from public.payment_allocations`)).toBe(1);
    await allocate(p.id, [[c.id, 100000]]);                                                                             // can be re-applied
    expect((await charges())[0].status).toBe('paid');
  });

  it('reversing a payment releases its allocations, voids its receipt and frees the reference', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000, p_reference: 'REV-1' });
    await allocate(p.id, [[c.id, 100000]]);
    const rc = await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id });
    expect(await code(call(db, f.staff, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'bounced' }))).toBe('PT403');
    expect(await code(call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: ' ' }))).toBe('PT422');
    const r = await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'bounced' });
    expect(r).toMatchObject({ status: 'reversed', unallocated_minor: 0, already_reversed: false });
    expect((await charges())[0]).toMatchObject({ status: 'unpaid', outstanding_minor: 100000 });
    expect((await call(db, f.staff, 'get_receipt', { p_org: f.orgA, p_receipt: rc.id })).voided_at).not.toBeNull();
    expect((await ledger()).summary.credit_minor).toBe(0);
    const again = await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'bounced' });
    expect(again.already_reversed).toBe(true);
    expect(await sumRows(`select count(*) s from public.finance_audit where action = 'payment.reversed'`)).toBe(1);
    expect(await code(allocate(p.id, [[c.id, 1]]))).toBe('PT409');
    expect(await code(call(db, f.staff, 'auto_allocate_payment', { p_org: f.orgA, p_payment: p.id }))).toBe('PT409');
    expect(await code(call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: crypto.randomUUID() }))).toBe('PT404');
  });

  it('a charge with money applied cannot be voided until the allocation is reversed', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    const out = await allocate(p.id, [[c.id, 100000]]);
    expect(await code(call(db, f.manager, 'void_charge', { p_org: f.orgA, p_charge: c.id, p_reason: 'duplicate' }))).toBe('PT409');
    await call(db, f.manager, 'reverse_allocation', { p_org: f.orgA, p_allocation: out.allocations[0].id, p_reason: 'duplicate charge' });
    const v = await call(db, f.manager, 'void_charge', { p_org: f.orgA, p_charge: c.id, p_reason: 'duplicate' });
    expect(v).toMatchObject({ status: 'void', outstanding_minor: 0 });
    expect((await ledger()).summary).toMatchObject({ charged_minor: 0, outstanding_minor: 0, credit_minor: 100000 });
    expect(await code(allocate(p.id, [[c.id, 1]]))).toBe('PT409');
    await call(db, f.manager, 'void_charge', { p_org: f.orgA, p_charge: c.id, p_reason: 'repeat' });             // idempotent
    expect(await sumRows(`select count(*) s from public.finance_audit where action = 'charge.voided'`)).toBe(1);
  });

  it('only admins may adjust charges; adjustments cannot undercut what has been paid', async () => {
    const c = await manualCharge(100000);
    const adj = (amount: number, over: Record<string, unknown> = {}, actor = f.admin) =>
      call(db, actor, 'adjust_charge', { p_org: f.orgA, p_charge: c.id, p_amount_minor: amount, p_reason: 'goodwill waiver', p_idempotency_key: key(), ...over });
    expect(await code(adj(-1000, {}, f.manager))).toBe('PT403');
    expect(await code(adj(-1000, {}, f.staff))).toBe('PT403');
    expect(await code(adj(-1000, { p_reason: 'x' }))).toBe('PT422');
    expect((await adj(-20000)).outstanding_minor).toBe(80000);
    expect((await adj(5000)).effective_minor).toBe(85000);
    const p = await pay({ p_amount_minor: 85000 });
    await allocate(p.id, [[c.id, 85000]]);
    expect(await code(adj(-1))).toBe('PT409');                                                                      // below amount already paid
    expect(await code(adj(-100000))).toBe('PT409');
    expect(await code(adj(0))).toBe('23514');
    expect((await adj(2000)).status).toBe('partial');                                                              // uplift reopens the balance
    expect(await code(db.query(`update public.charge_adjustments set amount_minor = 1`))).toBe('PT409');
    expect(await code(db.query(`delete from public.charge_adjustments`))).toBe('PT409');
  });

  it('a full waiver closes the charge as waived; an idempotent retry adjusts once', async () => {
    const c = await manualCharge(50000);
    const k = key();
    const args = { p_org: f.orgA, p_charge: c.id, p_amount_minor: -50000, p_reason: 'waived by owner', p_idempotency_key: k };
    const a = await call(db, f.admin, 'adjust_charge', args);
    const b = await call(db, f.admin, 'adjust_charge', args);
    expect([a.status, b.replayed]).toEqual(['waived', true]);
    expect(await sumRows(`select count(*) s from public.charge_adjustments`)).toBe(1);
    expect(await code(call(db, f.admin, 'adjust_charge', { ...args, p_amount_minor: -1 }))).toBe('PT409');
  });
});

describe('numbers: integers, rounding boundaries and large values', () => {
  it('computes collection rates with integer basis points, flooring (never floats)', async () => {
    const c = await manualCharge(3, '2026-01-10');
    const p = await pay({ p_amount_minor: 1 });
    await allocate(p.id, [[c.id, 1]]);
    const perf = await call(db, f.staff, 'property_performance', { p_org: f.orgA, p_from: '2026-01-01', p_to: '2026-01-31' });
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ billed_minor: 3, collected_minor: 1, outstanding_minor: 2, collection_rate_bps: 3333 });   // 1/3 → 33.33%, floored
  });

  it('keeps sums exact at the largest supported values', async () => {
    const big = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) await manualCharge(big, `2026-0${i + 1}-01`);
    expect((await ledger()).summary.charged_minor).toBe(3 * big);
    expect(await code(manualCharge(big + 1))).toBe('23514');
    const r = await reconcile();
    expect(r.ok).toBe(true);
    expect(r.totals[0]).toMatchObject({ charged_minor: 3 * big, within_safe_integer: true });
  });

  it('ten thirds of a dollar: allocating amounts that do not divide evenly never loses a minor unit', async () => {
    const c = await manualCharge(100);                       // $1.00
    const p = await pay({ p_amount_minor: 100 });
    const k = key();
    for (const amount of [33, 33, 34]) await allocate(p.id, [[c.id, amount]], key());
    expect((await charges())[0]).toMatchObject({ allocated_minor: 100, outstanding_minor: 0, status: 'paid' });
    expect(await sumRows(`select sum(amount_minor) s from public.payment_allocations`)).toBe(100);
    void k;
  });

  it('property performance is reported per currency and never summed across currencies', async () => {
    const eurProp = (await call(db, f.manager, 'create_property', propertyArgs(f.orgA, { p_name: 'Euro Court', p_currency: 'EUR', p_country: 'DE', p_timezone: 'Europe/Berlin' }))).id;
    await call(db, f.manager, 'record_expense', { p_org: f.orgA, p_property: eurProp, p_unit: null, p_category: 'repairs', p_description: 'Boiler', p_vendor: null,
      p_reference: null, p_amount_minor: 7000, p_incurred_on: '2026-01-05', p_idempotency_key: key() });
    await manualCharge(100000, '2026-01-05');
    const perf = await call(db, f.staff, 'property_performance', { p_org: f.orgA, p_from: '2026-01-01', p_to: '2026-01-31' });
    expect(perf.map((r: any) => [r.property_name, r.currency, r.billed_minor, r.expenses_minor]).sort()).toEqual([
      ['Euro Court', 'EUR', 0, 7000], ['Maple Court', 'USD', 100000, 0]]);
  });
});

describe('receipts', () => {
  it('issues numbered, traceable, immutable receipts and never claims verification', async () => {
    const c = await manualCharge(100000, '2026-01-01', { p_description: 'January rent' });
    const p = await pay({ p_amount_minor: 120000, p_reference: 'WIRE-9', p_tenant: f.tenant });
    await allocate(p.id, [[c.id, 100000]]);
    const r1 = await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id });
    expect(r1).toMatchObject({ number: 'R-000001', replayed: false });
    const full = await call(db, f.staff, 'get_receipt', { p_org: f.orgA, p_receipt: r1.id });
    expect(full.snapshot).toMatchObject({
      number: 'R-000001', organization: 'Org Alpha', received_from: 'Tina Tenant', verification: 'manual_unverified',
      payment: { amount_minor: 120000, currency: 'USD', reference: 'WIRE-9' }, property: { name: 'Maple Court', unit: '1A' },
      applied_to: [{ charge: 'January rent', amount_minor: 100000 }], unallocated_minor: 20000 });
    expect(full.snapshot.notice).toMatch(/not verified against a bank or payment provider/i);
    expect((await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id }))).toMatchObject({ number: 'R-000001', replayed: true });
    const p2 = await pay({ p_amount_minor: 5000 });
    expect((await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p2.id })).number).toBe('R-000002');
    expect(await code(db.query(`update public.receipts set snapshot = '{}'::jsonb`))).toBe('PT409');
    expect(await code(db.query(`delete from public.receipts`))).toBe('PT409');
    expect(await code(call(db, f.viewer, 'issue_receipt', { p_org: f.orgA, p_payment: p.id }))).toBe('PT403');
  });

  it('receipt numbers are per organization and gapless across rolled-back attempts', async () => {
    const p = await pay({ p_amount_minor: 1000 });
    await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id });
    // a failing request in between must not burn a number
    await code(call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: crypto.randomUUID() }));
    const p2 = await pay({ p_amount_minor: 2000 });
    expect((await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p2.id })).number).toBe('R-000002');
  });
});

describe('expenses', () => {
  const exp = (over: Record<string, unknown> = {}, actor = f.manager) => call(db, actor, 'record_expense', {
    p_org: f.orgA, p_property: f.prop, p_unit: null, p_category: 'maintenance', p_description: 'Gutter repair', p_vendor: 'Acme Roofing',
    p_reference: 'INV-7', p_amount_minor: 45000, p_incurred_on: '2026-02-03', p_idempotency_key: key(), ...over });

  it('records against an authorized property in that property\'s currency, idempotently', async () => {
    const k = key();
    const a = await exp({ p_idempotency_key: k });
    const b = await exp({ p_idempotency_key: k });
    expect([a.currency, a.replayed, b.replayed, b.id]).toEqual(['USD', false, true, a.id]);
    expect(await code(exp({ p_idempotency_key: k, p_amount_minor: 1 }))).toBe('PT409');
    expect(await sumRows(`select count(*) s from public.expenses`)).toBe(1);
  });
  it('enforces roles, property ownership, unit membership and sane dates', async () => {
    expect(await code(exp({}, f.staff))).toBe('PT403');
    expect(await code(exp({}, f.viewer))).toBe('PT403');
    const bProp = (await call(db, f.outsider, 'create_property', propertyArgs(f.orgB, { p_name: 'B' }))).id;
    expect(await code(exp({ p_property: bProp }))).toBe('PT404');
    const other = (await call(db, f.manager, 'create_property', propertyArgs(f.orgA, { p_name: 'Other' }))).id;
    const otherUnit = (await call(db, f.manager, 'create_unit', unitArgs(f.orgA, other, 'O1'))).id;
    expect(await code(exp({ p_unit: otherUnit }))).toBe('PT422');
    expect((await exp({ p_unit: f.unit })).unit_id).toBe(f.unit);
    expect(await code(exp({ p_incurred_on: '2999-01-01' }))).toBe('PT422');
    expect(await code(exp({ p_amount_minor: 0 }))).toBe('23514');
  });
  it('voids with a reason and excludes voided expenses from totals', async () => {
    const e = await exp();
    await exp({ p_amount_minor: 5000 });
    await call(db, f.manager, 'void_expense', { p_org: f.orgA, p_expense: e.id, p_reason: 'entered twice' });
    const list = await call(db, f.staff, 'list_expenses', { p_org: f.orgA });
    expect(list.total).toBe(1);
    expect(list.totals).toEqual([{ currency: 'USD', amount_minor: 5000 }]);
    expect((await call(db, f.staff, 'list_expenses', { p_org: f.orgA, p_include_void: true })).total).toBe(2);
  });
});

describe('roles', () => {
  it('viewers cannot read or write any financial data', async () => {
    for (const [fn, args] of [
      ['list_charges', {}], ['list_payments', {}], ['list_expenses', {}], ['list_tenant_balances', {}],
      ['get_tenancy_ledger', { p_tenancy: f.tenancy }], ['property_performance', { p_from: '2026-01-01', p_to: '2026-01-31' }],
    ] as const) expect(await code(call(db, f.viewer, fn, { p_org: f.orgA, ...args })), fn).toBe('PT403');
    for (const t of ['charges', 'payments', 'payment_allocations', 'rent_schedules', 'receipts', 'expenses', 'charge_adjustments'])
      expect((await as(db, f.viewer, (q) => q(`select * from public.${t}`))).rows, t).toEqual([]);
    expect(await code(pay_as(f.viewer))).toBe('PT403');
  });
  const pay_as = (actor: typeof f.viewer) => call(db, actor, 'record_payment', paymentArgs(f.orgA, f.tenancy));

  it('staff: payments, allocation, receipts yes; schedules, charges, reversals, expenses, audit, reconciliation no', async () => {
    const p = await pay();
    expect((await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id })).number).toBe('R-000001');
    expect(await code(call(db, f.staff, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy)))).toBe('PT403');
    expect(await code(call(db, f.staff, 'generate_charges', { p_org: f.orgA, p_tenancy: null, p_through: null }))).toBe('PT403');
    expect(await code(call(db, f.staff, 'create_charge', { p_org: f.orgA, p_tenancy: f.tenancy, p_kind: 'fee', p_description: 'x', p_due_date: '2026-01-01', p_amount_minor: 5, p_idempotency_key: key() }))).toBe('PT403');
    expect(await code(call(db, f.staff, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'because' }))).toBe('PT403');
    expect(await code(call(db, f.staff, 'list_finance_audit', { p_org: f.orgA }))).toBe('PT403');
    expect(await code(call(db, f.staff, 'reconcile_finance', { p_org: f.orgA }))).toBe('PT403');
    expect(await as(db, f.staff, (q) => q('select * from public.finance_audit'))).toMatchObject({ rows: [] });
    expect((await as(db, f.manager, (q) => q('select * from public.finance_audit'))).rows.length).toBeGreaterThan(0);
  });
  it('no role can write finance tables directly', async () => {
    for (const actor of [f.owner, f.admin, f.manager, f.staff]) {
      expect(await code(as(db, actor, (q) => q(`insert into public.charges (org_id,tenancy_id,currency,kind,description,due_date,amount_minor) values ($1,$2,'USD','fee','x','2026-01-01',1)`, [f.orgA, f.tenancy])))).toBe('42501');
      expect(await code(as(db, actor, (q) => q(`update public.payments set amount_minor = 1`)))).toBe('42501');
      expect(await code(as(db, actor, (q) => q(`delete from public.finance_audit`)))).toBe('42501');
    }
  });
});

describe('cross-organization isolation', () => {
  it('another organization sees and touches nothing', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    await allocate(p.id, [[c.id, 100000]]);
    const rc = await call(db, f.staff, 'issue_receipt', { p_org: f.orgA, p_payment: p.id });
    const o = f.outsider;
    for (const t of ['rent_schedules', 'charges', 'payments', 'payment_allocations', 'charge_adjustments', 'expenses', 'receipts', 'finance_audit'])
      expect((await as(db, o, (q) => q(`select * from public.${t}`))).rows, t).toEqual([]);
    for (const [fn, args] of [
      ['get_payment', { p_payment: p.id }], ['get_receipt', { p_receipt: rc.id }], ['get_tenancy_ledger', { p_tenancy: f.tenancy }],
      ['list_charges', {}], ['list_payments', {}], ['reconcile_finance', {}], ['list_finance_audit', {}],
      ['allocate_payment', { p_payment: p.id, p_allocations: [{ charge_id: c.id, amount_minor: 1 }], p_idempotency_key: key() }],
      ['reverse_payment', { p_payment: p.id, p_reason: 'hostile' }], ['void_charge', { p_charge: c.id, p_reason: 'hostile' }],
    ] as const) expect(await code(call(db, o, fn, { p_org: f.orgA, ...args })), fn).toBe('PT404');
    // addressing org A's ids through org B's own path
    const bOrg = f.orgB;
    for (const [fn, args] of [
      ['get_payment', { p_payment: p.id }], ['get_receipt', { p_receipt: rc.id }], ['get_tenancy_ledger', { p_tenancy: f.tenancy }],
      ['reverse_payment', { p_payment: p.id, p_reason: 'hostile' }], ['void_charge', { p_charge: c.id, p_reason: 'hostile' }],
      ['record_payment', paymentArgs(bOrg, f.tenancy)], ['create_charge', { p_tenancy: f.tenancy, p_kind: 'fee', p_description: 'x', p_due_date: '2026-01-01', p_amount_minor: 5, p_idempotency_key: key() }],
    ] as const) expect(await code(call(db, o, fn, { ...args, p_org: bOrg })), fn).toBe('PT404');
    expect((await reconcile()).ok).toBe(true);
  });
});

describe('reads: filters, balances, performance, audit trail', () => {
  it('filters charges and payments by period, property, tenant, currency and status; balances and reports agree', async () => {
    const c1 = await manualCharge(100000, '2026-01-01');
    const c2 = await manualCharge(100000, '2026-02-01');
    await manualCharge(100000, '2026-03-01');
    const p = await pay({ p_amount_minor: 150000, p_received_on: '2026-02-02' });
    await allocate(p.id, [[c1.id, 100000], [c2.id, 50000]]);
    const L = (args: Record<string, unknown>) => call(db, f.staff, 'list_charges', { p_org: f.orgA, ...args });
    expect((await L({ p_status: 'paid' })).total).toBe(1);
    expect((await L({ p_status: 'partial' })).total).toBe(1);
    expect((await L({ p_status: 'unpaid' })).total).toBe(1);
    expect((await L({ p_from: '2026-02-01', p_to: '2026-02-28' })).total).toBe(1);
    expect((await L({ p_property: f.prop })).total).toBe(3);
    expect((await L({ p_property: crypto.randomUUID() })).total).toBe(0);
    expect((await L({ p_tenant: f.tenant })).total).toBe(3);
    expect((await L({ p_currency: 'EUR' })).total).toBe(0);
    expect((await L({})).totals).toEqual([{ currency: 'USD', charged_minor: 300000, allocated_minor: 150000, outstanding_minor: 150000, overdue_minor: 150000 }]);
    expect((await L({ p_sort: 'amount', p_dir: 'asc', p_limit: 1 })).items).toHaveLength(1);
    expect(await code(L({ p_sort: 'bogus' }))).toBe('PT422');
    expect(await code(L({ p_status: 'bogus' }))).toBe('PT422');

    const P = (args: Record<string, unknown>) => call(db, f.staff, 'list_payments', { p_org: f.orgA, ...args });
    expect((await P({ p_status: 'allocated' })).total).toBe(1);
    expect((await P({ p_status: 'unallocated' })).total).toBe(0);
    expect((await P({ p_from: '2026-03-01' })).total).toBe(0);
    expect((await P({ p_tenant: f.tenant })).total).toBe(1);

    const B = await call(db, f.staff, 'list_tenant_balances', { p_org: f.orgA });
    expect(B.items[0]).toMatchObject({ primary_tenant: 'Tina Tenant', charged_minor: 300000, outstanding_minor: 150000, overdue_minor: 150000, credit_minor: 0 });
    expect((await call(db, f.staff, 'list_tenant_balances', { p_org: f.orgA, p_arrears_only: true })).total).toBe(1);
    expect((await call(db, f.staff, 'list_tenant_balances', { p_org: f.orgA, p_from: '2026-01-01', p_to: '2026-01-31' })).items[0]).toMatchObject({ charged_minor: 100000, outstanding_minor: 0 });
    expect((await call(db, f.staff, 'list_tenant_balances', { p_org: f.orgA, p_search: 'nobody' })).total).toBe(0);

    const perf = (await call(db, f.staff, 'property_performance', { p_org: f.orgA, p_from: '2026-01-01', p_to: '2026-03-31' }))[0];
    expect(perf).toMatchObject({ billed_minor: 300000, collected_minor: 150000, outstanding_minor: 150000, payments_received_minor: 150000, collection_rate_bps: 5000, net_cash_minor: 150000 });
    expect(await code(call(db, f.staff, 'property_performance', { p_org: f.orgA, p_from: '2026-03-01', p_to: '2026-01-01' }))).toBe('PT422');
    expect(await code(call(db, f.staff, 'property_performance', { p_org: f.orgA, p_from: '2000-01-01', p_to: '2026-01-01' }))).toBe('PT422');
    expect((await reconcile()).ok).toBe(true);
  });

  it('records an auditable history of every financial change, attributed and ordered', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    const out = await allocate(p.id, [[c.id, 100000]]);
    await call(db, f.manager, 'reverse_allocation', { p_org: f.orgA, p_allocation: out.allocations[0].id, p_reason: 'applied to wrong month' });
    await call(db, f.admin, 'adjust_charge', { p_org: f.orgA, p_charge: c.id, p_amount_minor: -1000, p_reason: 'late fee waived', p_idempotency_key: key() });
    await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'cheque bounced' });
    const a = await call(db, f.manager, 'list_finance_audit', { p_org: f.orgA, p_limit: 100 });
    const actions = a.items.map((i: any) => i.action).reverse();
    expect(actions).toEqual(['charge.created', 'payment.recorded', 'allocation.created', 'allocation.reversed', 'charge.adjusted', 'payment.reversed']);
    const rev = a.items.find((i: any) => i.action === 'payment.reversed');
    expect(rev).toMatchObject({ actor: 'manager@a.test', reason: 'cheque bounced', entity_type: 'payment', entity_id: p.id });
    expect(rev.before.status).toBe('unallocated');
    expect(rev.after.status).toBe('reversed');
    expect((await call(db, f.manager, 'list_finance_audit', { p_org: f.orgA, p_entity_type: 'payment', p_entity_id: p.id })).total).toBe(4);
    const detail = await call(db, f.manager, 'get_payment', { p_org: f.orgA, p_payment: p.id });
    expect(detail.history.length).toBe(4);
    expect((await call(db, f.staff, 'get_payment', { p_org: f.orgA, p_payment: p.id })).history).toBeNull();
    expect(await code(db.query(`update public.finance_audit set reason = 'edited'`))).toBe('PT409');
    expect(await code(db.query(`delete from public.finance_audit`))).toBe('PT409');
  });
});

describe('append-only guarantees', () => {
  it('ledger rows cannot be edited or deleted, and reversal markers are permanent', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 100000 });
    await allocate(p.id, [[c.id, 100000]]);
    await call(db, f.manager, 'create_rent_schedule', scheduleArgs(f.orgA, f.tenancy));
    await call(db, f.manager, 'record_expense', { p_org: f.orgA, p_property: f.prop, p_unit: null, p_category: 'other', p_description: 'x', p_vendor: null, p_reference: null,
      p_amount_minor: 100, p_incurred_on: '2026-01-02', p_idempotency_key: key() });
    for (const sql of [
      `update public.payments set amount_minor = 1`, `update public.payments set received_on = '2020-01-01'`, `update public.charges set amount_minor = 1`,
      `update public.charges set due_date = '2030-01-01'`, `update public.payment_allocations set amount_minor = 1`, `update public.payment_allocations set charge_id = gen_random_uuid()`,
      `delete from public.payments`, `delete from public.charges`, `delete from public.payment_allocations`, `delete from public.rent_schedules`, `delete from public.expenses`,
    ]) expect(await code(db.query(sql)), sql).toBe('PT409');
    await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: p.id, p_reason: 'bounced' });
    expect(await code(db.query(`update public.payments set reversed_at = null, reverse_reason = null`))).not.toBe('NO_ERROR');
    expect(await code(db.query(`update public.payments set reversed_at = now()`))).toBe('PT409');
    expect(await code(db.query(`delete from public.organizations where id = $1`, [f.orgA]))).toBe('23503');
  });
});

describe('reconciliation', () => {
  it('passes on a healthy ledger and reports exactly what is wrong on a corrupted one', async () => {
    const c = await manualCharge(100000);
    const p = await pay({ p_amount_minor: 60000 });
    await allocate(p.id, [[c.id, 60000]]);
    const ok = await reconcile();
    expect(ok.ok).toBe(true);
    expect(ok.checks.every((x: any) => x.ok)).toBe(true);
    expect(ok.totals).toEqual([expect.objectContaining({ currency: 'USD', charged_minor: 100000, allocated_minor: 60000, outstanding_minor: 40000, payments_minor: 60000, credit_minor: 0, matches_views: true })]);

    // Simulate corruption by an operator who bypasses the guards (superuser, triggers off).
    await db.exec(`alter table public.payment_allocations disable trigger payment_allocations_limits`);
    await db.query(`insert into public.payment_allocations (org_id,payment_id,charge_id,tenancy_id,currency,amount_minor,created_by) values ($1,$2,$3,$4,'USD',50000,$5)`,
      [f.orgA, p.id, c.id, f.tenancy, f.owner.sub]);
    await db.exec(`alter table public.payment_allocations enable trigger payment_allocations_limits`);
    const bad = await reconcile();
    expect(bad.ok).toBe(false);
    const failed = bad.checks.filter((x: any) => !x.ok).map((x: any) => x.name);
    expect(failed).toContain('No payment is allocated beyond its amount');
    expect(failed).toContain('No charge is paid beyond what is owed');
    expect(await code(reconcile(f.staff))).toBe('PT403');
  });
});
