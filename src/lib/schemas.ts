import { z } from 'zod';
import { email as emailField } from './validate.js';

/** "" and missing both become null so every RPC parameter is always sent. */
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const text = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().default(null));
export const reqText = (max: number) => z.string().trim().min(1, 'Required.').max(max);
const nullable = <T extends z.ZodTypeAny>(s: T) => z.preprocess(emptyToNull, s.nullable().default(null));

const validDate = (v: string) => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().startsWith(v); };
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(validDate, 'Not a real date.');
export const optDate = nullable(date);
export const money = z.number().int('Whole minor units only.').min(0).max(1_000_000_000_000);
export const optMoney = nullable(money);

export const timezone = z.string().max(64).refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'Unknown time zone.');
const currencies = new Set(Intl.supportedValuesOf('currency'));
export const currency = z.string().trim().toUpperCase().refine((c) => currencies.has(c), 'Unknown ISO 4217 currency.');
export const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO country code.');
export const version = z.number().int().min(1);
const optEmail = nullable(emailField);

export const PROPERTY_TYPES = ['residential', 'apartment_building', 'house', 'commercial', 'mixed_use', 'land', 'other'] as const;
export const OWNER_TYPES = ['individual', 'company', 'trust', 'other'] as const;
export const RENT_PERIODS = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually'] as const;
export const TENANCY_STATUSES = ['draft', 'active', 'ended', 'cancelled'] as const;
export const LEASE_KINDS = ['initial', 'renewal', 'amendment'] as const;
export const DOC_TYPES = ['lease', 'addendum', 'inspection', 'identification', 'other'] as const;
export const DOC_MIME = ['application/pdf', 'image/png', 'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;

export const propertyBody = z.object({
  name: reqText(120), reference: text(60), propertyType: z.enum(PROPERTY_TYPES).default('residential'),
  addressLine1: reqText(200), addressLine2: text(200), city: reqText(100), region: text(100), postalCode: text(20),
  country, timezone, currency, notes: text(4000),
});
export const ownerBody = z.object({
  name: reqText(160), ownerType: z.enum(OWNER_TYPES).default('individual'), email: optEmail, phone: text(40), notes: text(4000),
});
export const unitBody = z.object({
  reference: reqText(60), bedrooms: nullable(z.number().int().min(0).max(50)), bathrooms: nullable(z.number().min(0).max(50).multipleOf(0.5)),
  floorAreaSqm: nullable(z.number().positive().max(1_000_000)), marketRentMinor: optMoney,
  isAvailable: z.boolean().default(true), notes: text(4000),
});
export const tenantBody = z.object({
  fullName: reqText(160), email: optEmail, phone: text(40), emergencyName: text(160), emergencyPhone: text(40), notes: text(4000),
});
const tenancyTerms = {
  startDate: date, endDate: optDate, rentAmountMinor: money, rentPeriod: z.enum(RENT_PERIODS).default('monthly'),
  rentDueDay: nullable(z.number().int().min(1).max(31)), depositAmountMinor: money.default(0),
  depositScheme: text(200), noticeDays: nullable(z.number().int().min(0).max(365)), notes: text(4000),
};
const endAfterStart = (v: { startDate: string; endDate: string | null }) => !v.endDate || v.endDate >= v.startDate;
const endMsg = { message: 'End date must be on or after the start date.', path: ['endDate'] };
export const tenancyCreateBody = z.object({ unit: z.string().uuid(), ...tenancyTerms, tenantIds: z.array(z.string().uuid()).min(1).max(10) })
  .refine(endAfterStart, endMsg);
export const tenancyUpdateBody = z.object({ expectedVersion: version, ...tenancyTerms }).refine(endAfterStart, endMsg);
export const leaseBody = z.object({
  kind: z.enum(LEASE_KINDS).default('initial'), startDate: date, endDate: optDate, signedOn: optDate, notes: text(4000),
}).refine(endAfterStart, endMsg);
export const documentBody = z.object({
  docType: z.enum(DOC_TYPES).default('lease'), fileName: reqText(200),
  mimeType: z.enum(DOC_MIME, { errorMap: () => ({ message: 'Only PDF, PNG, JPEG or DOCX files are allowed.' }) }),
  sizeBytes: z.number().int().min(1).max(10 * 1024 * 1024, 'Files can be at most 10 MB.'),
});

/** List query: strings from the URL coerced to the right types. */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const listQuery = z.object({
  search: z.string().trim().max(100).optional(), sort: z.string().max(30).optional(), dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional(),
  archived: bool.optional(),
  type: z.enum(PROPERTY_TYPES).optional(), occupancy: z.enum(['occupied', 'vacant', 'upcoming', 'unavailable']).optional(),
  status: z.string().max(20).optional(), property: z.string().uuid().optional(), unit: z.string().uuid().optional(),
  tenant: z.string().uuid().optional(),
}).strict();

/* ------------------------------------------------------------------ finance */
/** Integer minor units only: JSON numbers that are not safe integers are rejected, so floats can never enter the ledger. */
export const minor = z.number({ invalid_type_error: 'Amount must be a whole number of minor units.' }).int('Amount must be a whole number of minor units.').safe();
export const positiveMinor = minor.min(1, 'Amount must be greater than zero.').max(1_000_000_000_000, 'Amount is too large.');
export const EXPENSE_CATEGORIES = ['maintenance', 'repairs', 'utilities', 'insurance', 'taxes', 'management_fees', 'legal', 'supplies', 'other'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;
export const CHARGE_KINDS = ['rent', 'deposit', 'fee', 'other'] as const;
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500);

export const scheduleBody = z.object({ amountMinor: positiveMinor, period: z.enum(RENT_PERIODS), firstDueDate: date, endDate: optDate })
  .refine((v) => !v.endDate || v.endDate >= v.firstDueDate, { message: 'End date must be on or after the first due date.', path: ['endDate'] });
export const reasonBody = z.object({ reason });
export const generateBody = z.object({ tenancy: nullable(z.string().uuid()), through: optDate });
export const chargeBody = z.object({ kind: z.enum(CHARGE_KINDS).default('other'), description: reqText(200), dueDate: date, amountMinor: positiveMinor });
export const adjustmentBody = z.object({ amountMinor: minor.refine((v) => v !== 0, 'Adjustment cannot be zero.').refine((v) => Math.abs(v) <= 1_000_000_000_000, 'Amount is too large.'), reason });
export const paymentBody = z.object({
  amountMinor: positiveMinor, receivedOn: date, method: z.enum(PAYMENT_METHODS), reference: reqText(100), note: text(1000),
  tenant: nullable(z.string().uuid()), currency: nullable(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)), autoAllocate: z.boolean().default(false),
});
export const allocationBody = z.object({
  allocations: z.array(z.object({ chargeId: z.string().uuid(), amountMinor: positiveMinor })).min(1).max(50)
    .transform((a) => a.map((x) => ({ charge_id: x.chargeId, amount_minor: x.amountMinor }))),
});
export const expenseBody = z.object({
  unit: nullable(z.string().uuid()), category: z.enum(EXPENSE_CATEGORIES), description: reqText(200), vendor: text(160), reference: text(100),
  amountMinor: positiveMinor, incurredOn: date,
});
const csv = (max: number) => z.string().max(max);
export const financeQuery = z.object({
  tenancy: z.string().uuid().optional(), property: z.string().uuid().optional(), tenant: z.string().uuid().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(), status: csv(20).optional(), category: z.enum(EXPENSE_CATEGORIES).optional(),
  from: date.optional(), to: date.optional(), search: csv(100).optional(), arrearsOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  includeVoid: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: csv(30).optional(), dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional(),
  entityType: z.enum(['payment', 'charge', 'expense', 'rent_schedule', 'tenancy']).optional(), entityId: z.string().uuid().optional(),
}).strict();
/** Each endpoint accepts only the filters it supports; anything else is a clear 422, never a database error. */
export const chargesQuery = financeQuery.pick({ tenancy: true, property: true, tenant: true, currency: true, status: true, from: true, to: true, search: true, sort: true, dir: true, limit: true, offset: true });
export const balancesQuery = financeQuery.pick({ property: true, currency: true, search: true, from: true, to: true, arrearsOnly: true, sort: true, dir: true, limit: true, offset: true });
export const expensesQuery = financeQuery.pick({ property: true, category: true, currency: true, from: true, to: true, includeVoid: true, search: true, sort: true, dir: true, limit: true, offset: true });
export const auditQuery = financeQuery.pick({ entityType: true, entityId: true, limit: true, offset: true });
export const performanceQuery = financeQuery.pick({ property: true, currency: true }).extend({ from: date, to: date }).strict();
