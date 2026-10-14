import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call } from '../support/db.js';
import { key, paymentArgs, seedFinance, type Fin } from '../support/fixtures.js';

/**
 * Property-style test for the charge_balances cache: many random ledger operations in random order, and after EVERY step the cache must equal
 * what the append-only rows add up to, the views must agree with the raw sums, and reconcile_finance must pass.
 */
let db: PGlite; let f: Fin;
import { createTestDb } from '../support/db.js';
beforeEach(async () => { db = await createTestDb(); f = await seedFinance(db); });
afterEach(async () => { await db.close(); });

const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const q = (sql: string) => db.query<any>(sql).then((r) => r.rows);

async function assertConsistent(step: string) {
  const drift = await q(`select c.id from public.charges c left join public.charge_balances b on b.charge_id = c.id
    where b.charge_id is null or b.adjusted_minor <> (select coalesce(sum(j.amount_minor), 0) from public.charge_adjustments j where j.charge_id = c.id)
       or b.allocated_minor <> (select coalesce(sum(a.amount_minor), 0) from public.payment_allocations a where a.charge_id = c.id and a.reversed_at is null)`);
  expect(drift, `cache drift after ${step}`).toEqual([]);
  const rec = await call(db, f.manager, 'reconcile_finance', { p_org: f.orgA });
  expect(rec.ok, `${step}: ${JSON.stringify(rec.checks?.filter((c: any) => !c.ok))}`).toBe(true);
}

describe('the cached balances never drift from the ledger', () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`seed ${seed}: 60 random operations`, async () => {
      const rnd = mulberry(seed); const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
      const charges: string[] = []; const payments: string[] = []; const allocations: string[] = [];
      for (let i = 0; i < 4; i++) charges.push((await call(db, f.manager, 'create_charge', { p_org: f.orgA, p_tenancy: f.tenancy, p_kind: 'fee', p_description: `Seed ${i}`, p_due_date: '2026-01-01', p_amount_minor: 10000 + i * 500, p_idempotency_key: key() })).id);
      for (let step = 1; step <= 60; step++) {
        const op = Math.floor(rnd() * 8); let label = `#${step} op${op}`;
        try {
          if (op === 0) charges.push((await call(db, f.manager, 'create_charge', { p_org: f.orgA, p_tenancy: f.tenancy, p_kind: 'fee', p_description: 'Extra', p_due_date: '2026-02-01', p_amount_minor: 1000 + Math.floor(rnd() * 20000), p_idempotency_key: key() })).id);
          else if (op === 1 || op === 2) { const p = await call(db, f.staff, 'record_payment', paymentArgs(f.orgA, f.tenancy, { p_amount_minor: 500 + Math.floor(rnd() * 15000), p_auto_allocate: op === 1 })); payments.push(p.id); }
          else if (op === 3 && payments.length) { const pay = await call(db, f.staff, 'get_payment', { p_org: f.orgA, p_payment: pick(payments) }); const open = await q(`select id, outstanding_minor from app.charge_state where tenancy_id = '${f.tenancy}' and outstanding_minor > 0 limit 3`);
            if (open.length && pay.unallocated_minor > 0) { const c = pick(open); const amt = Math.min(Number(c.outstanding_minor), Number(pay.unallocated_minor), 1 + Math.floor(rnd() * 5000)); const out = await call(db, f.staff, 'allocate_payment', { p_org: f.orgA, p_payment: pay.id, p_allocations: [{ charge_id: c.id, amount_minor: amt }], p_idempotency_key: key() }); for (const a of out.allocations ?? []) allocations.push(a.id); } }
          else if (op === 4 && payments.length) await call(db, f.staff, 'auto_allocate_payment', { p_org: f.orgA, p_payment: pick(payments) });
          else if (op === 5) { const act = await q(`select id from public.payment_allocations where reversed_at is null limit 5`); if (act.length) await call(db, f.manager, 'reverse_allocation', { p_org: f.orgA, p_allocation: pick(act).id, p_reason: 'random reversal' }); }
          else if (op === 6 && payments.length) await call(db, f.manager, 'reverse_payment', { p_org: f.orgA, p_payment: payments.splice(Math.floor(rnd() * payments.length), 1)[0]!, p_reason: 'random bounce' });
          else if (op === 7) { const c = pick(charges); await call(db, f.admin, 'adjust_charge', { p_org: f.orgA, p_charge: c, p_amount_minor: rnd() < 0.5 ? 250 : -250, p_reason: 'random adjustment', p_idempotency_key: key() }); }
        } catch (e: any) { label += ` (refused: ${e.code ?? e.message})`; if (!/^PT4/.test(String(e.code))) throw e; }   // refusals are fine; the invariants must hold regardless
        await assertConsistent(label);
      }
      expect(allocations.length + payments.length).toBeGreaterThan(5);
    }, 120_000);
  }
  it('also holds across a void and a restore of balances computed before the cache existed', async () => {
    const c = await call(db, f.manager, 'create_charge', { p_org: f.orgA, p_tenancy: f.tenancy, p_kind: 'fee', p_description: 'Void me', p_due_date: '2026-01-01', p_amount_minor: 5000, p_idempotency_key: key() });
    await call(db, f.manager, 'void_charge', { p_org: f.orgA, p_charge: c.id, p_reason: 'billed in error' });
    await assertConsistent('void');
    await db.exec(`update public.charge_balances set allocated_minor = allocated_minor + 1`);              // simulate corruption of the cache
    const rec = await call(db, f.manager, 'reconcile_finance', { p_org: f.orgA });
    expect(rec.ok).toBe(false);
    expect(rec.checks.find((x: any) => /Cached charge balances/.test(x.name))).toMatchObject({ ok: false });
  });
});
