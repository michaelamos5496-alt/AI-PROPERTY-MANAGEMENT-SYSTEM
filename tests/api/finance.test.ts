import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '5000' }); });
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const ok = async (p: Promise<any>, status = 200) => {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const idem = (c: Client, method: 'post', url: string, body: object, key: string = randomUUID()) => (c as any)[method](url).set('Idempotency-Key', key).send(body);

/** An organization with one active tenancy (USD 1,500.00 monthly) and a full cast of roles. */
async function setup() {
  const org = await t.newOrg();
  const manager = await t.addMember(org, 'manager');
  const staff = await t.addMember(org, 'staff');
  const viewer = await t.addMember(org, 'viewer');
  const admin = await t.addMember(org, 'admin');
  const base = org.base;
  const prop = await ok(manager.post(`${base}/properties`).send({ name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' }), 201);
  const unit = await ok(manager.post(`${base}/properties/${prop.id}/units`).send({ reference: '1A' }), 201);
  const tenant = await ok(staff.post(`${base}/tenants`).send({ fullName: 'Tina Tenant', email: 'tina@mail.test' }), 201);
  const tn = await ok(staff.post(`${base}/tenancies`).send({ unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 }), 201);
  await ok(manager.post(`${base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
  const owner = org.c;
  return { org, base, owner, manager, staff, viewer, admin, prop, unit, tenant, tenancy: tn.id as string };
}
type W = Awaited<ReturnType<typeof setup>>;
const pay = (w: W, c: Client, over: object = {}, key?: string) => idem(c, 'post', `${w.base}/tenancies/${w.tenancy}/payments`,
  { amountMinor: 150000, receivedOn: '2026-02-01', method: 'bank_transfer', reference: `REF-${randomUUID().slice(0, 8)}`, ...over }, key);

describe('acceptance: schedule rent, record a payment, allocate it, see the balance, get a traceable receipt', () => {
  it('works end to end and reconciles', async () => {
    const w = await setup();
    const sched = await ok(w.manager.post(`${w.base}/tenancies/${w.tenancy}/rent-schedules`).send({ amountMinor: 150000, period: 'monthly', firstDueDate: '2026-01-01' }), 201);
    expect(sched).toMatchObject({ currency: 'USD', status: 'active', amount_minor: 150000 });
    const gen = await ok(w.manager.post(`${w.base}/finance/generate-charges`).send({ tenancy: w.tenancy, through: '2026-03-31' }));
    expect(gen.created).toBe(3);
    expect((await ok(w.manager.post(`${w.base}/finance/generate-charges`).send({ tenancy: w.tenancy, through: '2026-03-31' }))).created).toBe(0);   // repeat = no-op

    const before = await ok(w.staff.get(`${w.base}/tenancies/${w.tenancy}/ledger`));
    expect(before.summary).toMatchObject({ charged_minor: 450000, outstanding_minor: 450000, overdue_minor: 450000, credit_minor: 0 });

    const payment = await ok(pay(w, w.staff, { amountMinor: 200000, reference: 'WIRE-2026-02-01', note: 'transfer from Tina', tenant: w.tenant.id }), 201);
    expect(payment).toMatchObject({ status: 'unallocated', unallocated_minor: 200000, verification: 'manual_unverified', currency: 'USD' });

    const jan = before.charges.find((c: any) => c.due_date === '2026-01-01');
    const feb = before.charges.find((c: any) => c.due_date === '2026-02-01');
    const alloc = await ok(idem(w.staff, 'post', `${w.base}/payments/${payment.id}/allocations`, { allocations: [{ chargeId: jan.id, amountMinor: 150000 }, { chargeId: feb.id, amountMinor: 50000 }] }), 201);
    expect(alloc).toMatchObject({ status: 'allocated', allocated_minor: 200000, unallocated_minor: 0 });

    const after = await ok(w.staff.get(`${w.base}/tenancies/${w.tenancy}/ledger`));
    expect(after.summary).toMatchObject({ charged_minor: 450000, allocated_minor: 200000, outstanding_minor: 250000, credit_minor: 0 });
    expect(after.charges.map((c: any) => [c.due_date, c.status]).sort()).toEqual([['2026-01-01', 'paid'], ['2026-02-01', 'partial'], ['2026-03-01', 'unpaid']]);

    const rc = await ok(w.staff.post(`${w.base}/payments/${payment.id}/receipt`).send({}), 201);
    expect(rc.number).toBe('R-000001');
    const full = await ok(w.staff.get(`${w.base}/receipts/${rc.id}`));
    expect(full.payment_id).toBe(payment.id);
    expect(full.snapshot).toMatchObject({ received_from: 'Tina Tenant', verification: 'manual_unverified', payment: { reference: 'WIRE-2026-02-01', amount_minor: 200000 },
      property: { name: 'Maple Court', unit: '1A' } });
    expect(full.snapshot.applied_to).toHaveLength(2);
    expect(JSON.stringify(full)).not.toMatch(/bank-verified|provider-verified/i);

    const rec = await ok(w.manager.get(`${w.base}/finance/reconciliation`));
    expect(rec.ok).toBe(true);
    const audit = await ok(w.manager.get(`${w.base}/finance/audit?entityType=payment&entityId=${payment.id}`));
    expect(audit.items.map((i: any) => i.action).reverse()).toEqual(['payment.recorded', 'allocation.created', 'allocation.created', 'receipt.issued']);
  });
});

describe('idempotency and exact integers', () => {
  it('requires an Idempotency-Key on money-moving requests', async () => {
    const w = await setup();
    const r = await w.staff.post(`${w.base}/tenancies/${w.tenancy}/payments`).send({ amountMinor: 100, receivedOn: '2026-02-01', method: 'cash', reference: 'NOKEY' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Idempotency-Key/);
    expect((await w.staff.post(`${w.base}/tenancies/${w.tenancy}/payments`).set('Idempotency-Key', 'short').send({ amountMinor: 100, receivedOn: '2026-02-01', method: 'cash', reference: 'X' })).status).toBe(400);
  });

  it('a repeated request returns the same payment (200) and writes nothing new; a different body under the same key is refused', async () => {
    const w = await setup();
    const key = randomUUID();
    const body = { amountMinor: 75000, receivedOn: '2026-02-01', method: 'cash', reference: 'RETRY-1' };
    const first = await ok(idem(w.staff, 'post', `${w.base}/tenancies/${w.tenancy}/payments`, body, key), 201);
    const second = await ok(idem(w.staff, 'post', `${w.base}/tenancies/${w.tenancy}/payments`, body, key), 200);
    expect([second.id, second.replayed, first.replayed]).toEqual([first.id, true, false]);
    expect((await ok(w.staff.get(`${w.base}/payments`))).total).toBe(1);
    expect((await idem(w.staff, 'post', `${w.base}/tenancies/${w.tenancy}/payments`, { ...body, amountMinor: 1 }, key)).status).toBe(409);
  });

  it('duplicate submissions racing each other create one payment', async () => {
    const w = await setup();
    const key = randomUUID();
    const body = { amountMinor: 5000, receivedOn: '2026-02-01', method: 'cash', reference: 'RACE-1' };
    const rs = await Promise.all(Array.from({ length: 6 }, () => idem(w.staff, 'post', `${w.base}/tenancies/${w.tenancy}/payments`, body, key)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect((await ok(w.staff.get(`${w.base}/payments`))).total).toBe(1);
  });

  it('rejects floating-point, string and out-of-range amounts at the boundary', async () => {
    const w = await setup();
    for (const amountMinor of [12.5, 0.1 + 0.2, '1500', null, 0, -5, 1e21, 2 ** 53, 1_000_000_000_001, NaN]) {
      const r = await pay(w, w.staff, { amountMinor });
      expect(r.status, String(amountMinor)).toBe(422);
    }
    expect((await w.manager.post(`${w.base}/tenancies/${w.tenancy}/rent-schedules`).send({ amountMinor: 1500.5, period: 'monthly', firstDueDate: '2026-01-01' })).status).toBe(422);
    expect((await idem(w.admin, 'post', `${w.base}/charges/${randomUUID()}/adjustments`, { amountMinor: 0.5, reason: 'x y z' })).status).toBe(422);
    expect((await ok(w.staff.get(`${w.base}/payments`))).total).toBe(0);
  });
});

describe('currency safety', () => {
  it('refuses foreign-currency payments and cross-currency allocation; there is no conversion path', async () => {
    const w = await setup();
    expect((await pay(w, w.staff, { currency: 'EUR' })).status).toBe(422);
    // a second tenancy in EUR
    const eurProp = await ok(w.manager.post(`${w.base}/properties`).send({ name: 'Euro Court', addressLine1: '2 Rue', city: 'Paris', country: 'FR', timezone: 'Europe/Paris', currency: 'EUR' }), 201);
    const eurUnit = await ok(w.manager.post(`${w.base}/properties/${eurProp.id}/units`).send({ reference: 'E1' }), 201);
    const eurTn = await ok(w.staff.post(`${w.base}/tenancies`).send({ unit: eurUnit.id, tenantIds: [w.tenant.id], startDate: '2026-01-01', rentAmountMinor: 90000 }), 201);
    await ok(w.manager.post(`${w.base}/tenancies/${eurTn.id}/activate`).send({ expectedVersion: eurTn.version }));
    const eurCharge = await ok(idem(w.manager, 'post', `${w.base}/tenancies/${eurTn.id}/charges`, { kind: 'fee', description: 'EUR fee', dueDate: '2026-01-01', amountMinor: 5000 }), 201);
    expect(eurCharge.currency).toBe('EUR');
    const usd = await ok(pay(w, w.staff), 201);
    const r = await idem(w.staff, 'post', `${w.base}/payments/${usd.id}/allocations`, { allocations: [{ chargeId: eurCharge.id, amountMinor: 5000 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/different tenancy|currency/i);
    expect((await ok(w.staff.get(`${w.base}/payments/${usd.id}`))).allocated_minor).toBe(0);
  });
});

describe('roles', () => {
  it('enforces who may read, record, correct and adjust', async () => {
    const w = await setup();
    const sched = { amountMinor: 150000, period: 'monthly', firstDueDate: '2026-01-01' };
    const charge = { kind: 'fee', description: 'Key replacement', dueDate: '2026-01-05', amountMinor: 2500 };

    for (const path of ['/charges', '/payments', '/expenses', '/finance/balances', `/tenancies/${w.tenancy}/ledger`, '/finance/performance?from=2026-01-01&to=2026-01-31'])
      expect((await w.viewer.get(`${w.base}${path}`)).status, `viewer ${path}`).toBe(403);
    expect((await pay(w, w.viewer)).status).toBe(403);

    expect((await w.staff.post(`${w.base}/tenancies/${w.tenancy}/rent-schedules`).send(sched)).status).toBe(403);
    expect((await idem(w.staff, 'post', `${w.base}/tenancies/${w.tenancy}/charges`, charge)).status).toBe(403);
    expect((await w.staff.get(`${w.base}/finance/audit`)).status).toBe(403);
    expect((await w.staff.get(`${w.base}/finance/reconciliation`)).status).toBe(403);
    const p = await ok(pay(w, w.staff), 201);                                             // staff may record
    expect((await w.staff.post(`${w.base}/payments/${p.id}/reverse`).send({ reason: 'oops' })).status).toBe(403);

    const c = await ok(idem(w.manager, 'post', `${w.base}/tenancies/${w.tenancy}/charges`, charge), 201);   // manager may charge
    expect((await idem(w.manager, 'post', `${w.base}/charges/${c.id}/adjustments`, { amountMinor: -500, reason: 'goodwill' })).status).toBe(403);
    expect((await idem(w.admin, 'post', `${w.base}/charges/${c.id}/adjustments`, { amountMinor: -500, reason: 'goodwill' })).status).toBe(201);
    expect((await idem(w.owner, 'post', `${w.base}/charges/${c.id}/adjustments`, { amountMinor: -500, reason: 'owner approved' })).status).toBe(201);
    await ok(w.manager.post(`${w.base}/payments/${p.id}/reverse`).send({ reason: 'cheque bounced' }));
    expect((await ok(w.manager.get(`${w.base}/finance/audit`))).total).toBeGreaterThan(3);
    const ws = await ok(w.staff.get(`${w.base}/workspace`));
    expect(ws.permissions).toEqual(expect.arrayContaining(['finance:read', 'payments:write']));
    expect(ws.permissions).not.toEqual(expect.arrayContaining(['finance:manage', 'finance:adjust']));
  });
});

describe('cross-organization isolation', () => {
  it('another organization cannot read or change any financial record', async () => {
    const a = await setup();
    const b = await setup();
    await ok(a.manager.post(`${a.base}/tenancies/${a.tenancy}/rent-schedules`).send({ amountMinor: 150000, period: 'monthly', firstDueDate: '2026-01-01' }), 201);
    await ok(a.manager.post(`${a.base}/finance/generate-charges`).send({ through: '2026-02-28' }));
    const p = await ok(pay(a, a.staff), 201);
    const charge = (await ok(a.staff.get(`${a.base}/charges`))).items[0];
    const rc = await ok(a.staff.post(`${a.base}/payments/${p.id}/receipt`).send({}), 201);

    for (const path of [`/payments/${p.id}`, `/receipts/${rc.id}`, `/tenancies/${a.tenancy}/ledger`, '/payments', '/charges', '/expenses', '/finance/balances', '/finance/audit', '/finance/reconciliation']) {
      const viaA = await b.manager.get(`${a.base}${path}`);
      expect(viaA.status, `B → A ${path}`).toBe(404);
      expect(JSON.stringify(viaA.body)).not.toMatch(/Tina|WIRE|REF-/);
    }
    for (const path of [`/payments/${p.id}`, `/receipts/${rc.id}`, `/tenancies/${a.tenancy}/ledger`]) expect((await b.manager.get(`${b.base}${path}`)).status, `B own org, A id ${path}`).toBe(404);
    expect((await ok(b.manager.get(`${b.base}/payments`))).total).toBe(0);
    expect((await ok(b.manager.get(`${b.base}/charges`))).total).toBe(0);

    const hostile: [string, object][] = [
      [`/payments/${p.id}/reverse`, { reason: 'hostile reverse' }], [`/charges/${charge.id}/void`, { reason: 'hostile void' }],
      [`/payments/${p.id}/allocations`, { allocations: [{ chargeId: charge.id, amountMinor: 1 }] }], [`/payments/${p.id}/auto-allocate`, {}],
    ];
    for (const [path, body] of hostile) for (const base of [a.base, b.base]) {
      const r = await (b.manager as any).post(`${base}${path}`).set('Idempotency-Key', randomUUID()).send(body);
      expect([404, 422], `${base === a.base ? 'A' : 'B'} ${path} -> ${r.status}`).toContain(r.status);
    }
    expect((await idem(b.staff, 'post', `${b.base}/tenancies/${a.tenancy}/payments`, { amountMinor: 1, receivedOn: '2026-02-01', method: 'cash', reference: 'EVIL' })).status).toBe(404);
    expect((await ok(a.staff.get(`${a.base}/payments/${p.id}`))).status).toBe('unallocated');
    expect((await ok(a.manager.get(`${a.base}/finance/reconciliation`))).ok).toBe(true);
  });
});

describe('expenses and reports', () => {
  it('records expenses against an authorized property and reports performance per currency', async () => {
    const w = await setup();
    await ok(idem(w.manager, 'post', `${w.base}/tenancies/${w.tenancy}/charges`, { kind: 'rent', description: 'Rent Jan', dueDate: '2026-01-01', amountMinor: 150000 }), 201);
    const p = await ok(pay(w, w.staff, { amountMinor: 100000, receivedOn: '2026-01-05' }), 201);
    await ok(w.staff.post(`${w.base}/payments/${p.id}/auto-allocate`).send({}));
    const key = randomUUID();
    const exp = { category: 'repairs', description: 'Boiler service', vendor: 'HeatCo', amountMinor: 30000, incurredOn: '2026-01-10' };
    const e1 = await ok(idem(w.manager, 'post', `${w.base}/properties/${w.prop.id}/expenses`, exp, key), 201);
    const e2 = await ok(idem(w.manager, 'post', `${w.base}/properties/${w.prop.id}/expenses`, exp, key), 200);
    expect(e2.id).toBe(e1.id);
    expect((await idem(w.staff, 'post', `${w.base}/properties/${w.prop.id}/expenses`, exp)).status).toBe(403);
    const perf = await ok(w.staff.get(`${w.base}/finance/performance?from=2026-01-01&to=2026-01-31`));
    expect(perf).toHaveLength(1);
    expect(perf[0]).toMatchObject({ property_name: 'Maple Court', currency: 'USD', billed_minor: 150000, collected_minor: 100000, outstanding_minor: 50000,
      payments_received_minor: 100000, expenses_minor: 30000, net_cash_minor: 70000, collection_rate_bps: 6666 });
    await ok(w.manager.post(`${w.base}/expenses/${e1.id}/void`).send({ reason: 'entered twice' }));
    expect((await ok(w.staff.get(`${w.base}/expenses`))).total).toBe(0);
    expect((await w.staff.get(`${w.base}/finance/performance`)).status).toBe(422);                    // period is required
  });

  it('validates filters and supports period, status, currency, sort and pagination', async () => {
    const w = await setup();
    for (const m of ['01', '02', '03', '04']) await ok(idem(w.manager, 'post', `${w.base}/tenancies/${w.tenancy}/charges`, { kind: 'rent', description: `Rent ${m}`, dueDate: `2026-${m}-01`, amountMinor: 100000 }), 201);
    expect((await ok(w.staff.get(`${w.base}/charges?from=2026-02-01&to=2026-03-31`))).total).toBe(2);
    expect((await ok(w.staff.get(`${w.base}/charges?status=unpaid&currency=usd`))).total).toBe(4);
    expect((await ok(w.staff.get(`${w.base}/charges?currency=EUR`))).total).toBe(0);
    const page = await ok(w.staff.get(`${w.base}/charges?limit=2&offset=2&sort=due&dir=asc`));
    expect(page.items.map((i: any) => i.due_date)).toEqual(['2026-03-01', '2026-04-01']);
    expect(page.totals).toEqual([{ currency: 'USD', charged_minor: 400000, allocated_minor: 0, outstanding_minor: 400000, overdue_minor: 400000 }]);
    // free-text search across every list (charges: description/tenant/property/unit)
    expect((await ok(w.staff.get(`${w.base}/charges?search=rent 02`))).total).toBe(1);
    expect((await ok(w.staff.get(`${w.base}/charges?search=tina`))).total).toBe(4);
    expect((await ok(w.staff.get(`${w.base}/charges?search=100%25`))).total).toBe(0);                          // % is literal, not a wildcard
    const pm = await ok(pay(w, w.staff, { reference: 'SEARCH-ME-77', note: 'paid at the office' }), 201);
    expect((await ok(w.staff.get(`${w.base}/payments?search=search-me`))).total).toBe(1);
    expect((await ok(w.staff.get(`${w.base}/payments?search=office`))).items[0].id).toBe(pm.id);
    expect((await ok(w.staff.get(`${w.base}/payments?search=nomatch`))).total).toBe(0);
    await ok(idem(w.manager, 'post', `${w.base}/properties/${w.prop.id}/expenses`, { category: 'repairs', description: 'Roof tiles', vendor: 'Slate & Co', amountMinor: 1200, incurredOn: '2026-01-10' }), 201);
    expect((await ok(w.staff.get(`${w.base}/expenses?search=slate`))).total).toBe(1);
    expect((await ok(w.staff.get(`${w.base}/expenses?search=zzz`))).total).toBe(0);
    // each endpoint only accepts the filters it supports
    for (const q of ['/finance/balances?tenancy=' + w.tenancy, '/finance/balances?status=paid', '/expenses?tenancy=' + w.tenancy, '/finance/audit?search=x', '/charges?category=repairs'])
      expect((await w.manager.get(`${w.base}${q}`)).status, q).toBe(422);
    for (const q of ['status=weird', 'sort=password', 'bogus=1', 'from=2026-13-45', 'limit=9999', 'currency=dollars']) expect((await w.staff.get(`${w.base}/charges?${q}`)).status, q).toBe(422);
    expect((await ok(w.staff.get(`${w.base}/finance/balances?arrearsOnly=true`))).total).toBe(1);
    expect((await ok(w.staff.get(`${w.base}/payments?status=unallocated`))).total).toBe(1);   // the SEARCH-ME payment above is unallocated
  });
});
