import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import { rateLimit } from '../lib/rate-limit.js';
import * as S from '../lib/schemas.js';
import type { DataApi } from '../services/supabase.js';
import { mountDefs, type Def } from './defs.js';

const noBody = z.object({});
const defs: Def[] = [
  // recurring rent
  { method: 'post', path: '/tenancies/:tenancy/rent-schedules', min: 'manager', fn: 'create_rent_schedule', body: S.scheduleBody, status: 201 },
  { method: 'post', path: '/rent-schedules/:schedule/stop', min: 'manager', fn: 'stop_rent_schedule', body: S.reasonBody },
  { method: 'post', path: '/finance/generate-charges', min: 'manager', fn: 'generate_charges', body: S.generateBody },
  // charges
  { method: 'get', path: '/charges', min: 'staff', fn: 'list_charges', query: S.chargesQuery },
  { method: 'post', path: '/tenancies/:tenancy/charges', min: 'manager', fn: 'create_charge', body: S.chargeBody, status: 201, idempotent: true },
  { method: 'post', path: '/charges/:charge/void', min: 'manager', fn: 'void_charge', body: S.reasonBody },
  { method: 'post', path: '/charges/:charge/adjustments', min: 'admin', fn: 'adjust_charge', body: S.adjustmentBody, status: 201, idempotent: true },
  // payments
  { method: 'get', path: '/payments', min: 'staff', fn: 'list_payments', query: S.chargesQuery },
  { method: 'post', path: '/tenancies/:tenancy/payments', min: 'staff', fn: 'record_payment', body: S.paymentBody, status: 201, idempotent: true },
  { method: 'get', path: '/payments/:payment', min: 'staff', fn: 'get_payment' },
  { method: 'post', path: '/payments/:payment/allocations', min: 'staff', fn: 'allocate_payment', body: S.allocationBody, status: 201, idempotent: true },
  { method: 'post', path: '/payments/:payment/auto-allocate', min: 'staff', fn: 'auto_allocate_payment', body: noBody },
  { method: 'post', path: '/payments/:payment/reverse', min: 'manager', fn: 'reverse_payment', body: S.reasonBody },
  { method: 'post', path: '/allocations/:allocation/reverse', min: 'manager', fn: 'reverse_allocation', body: S.reasonBody },
  // receipts
  { method: 'post', path: '/payments/:payment/receipt', min: 'staff', fn: 'issue_receipt', body: noBody, status: 201 },
  { method: 'get', path: '/receipts/:receipt', min: 'staff', fn: 'get_receipt' },
  // reads and reports
  { method: 'get', path: '/tenancies/:tenancy/ledger', min: 'staff', fn: 'get_tenancy_ledger' },
  { method: 'get', path: '/finance/balances', min: 'staff', fn: 'list_tenant_balances', query: S.balancesQuery },
  { method: 'get', path: '/finance/performance', min: 'staff', fn: 'property_performance', query: S.performanceQuery },
  { method: 'get', path: '/finance/reconciliation', min: 'manager', fn: 'reconcile_finance' },
  { method: 'get', path: '/finance/audit', min: 'manager', fn: 'list_finance_audit', query: S.auditQuery },
  // expenses
  { method: 'get', path: '/expenses', min: 'staff', fn: 'list_expenses', query: S.expensesQuery },
  { method: 'post', path: '/properties/:property/expenses', min: 'manager', fn: 'record_expense', body: S.expenseBody, status: 201, idempotent: true },
  { method: 'post', path: '/expenses/:expense/void', min: 'manager', fn: 'void_expense', body: S.reasonBody },
];

/** Mounted at /api/organizations/:orgId (after requireAuth). */
export function financeRoutes(env: Env, data: DataApi): Router {
  const r = Router({ mergeParams: true });
  // Money-moving requests get their own, tighter per-user budget on top of the global limiter.
  const writes = rateLimit({ name: 'finance-write', windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS, max: env.RATE_LIMIT_FINANCE_MAX, key: (req) => req.auth?.user.id ?? req.ip ?? 'anon' });
  r.use((req, res, next) => (req.method === 'GET' ? next() : writes(req, res, next)));
  mountDefs(r, defs, data);
  return r;
}
