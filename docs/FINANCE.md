# Phase 3: rent ledger and financial integrity

## The chosen approach: balances are DERIVED, never stored

There is **no balance column anywhere**. Every figure on screen is computed from immutable ledger rows by the views
`app.charge_state` and `app.payment_state` (schema `app`, not exposed to the API):

```
charge outstanding  = charge amount + Σ adjustments − Σ active allocations          (0 if void)
payment unallocated = payment amount − Σ active allocations                           (0 if reversed)
tenancy owed        = Σ outstanding of non-void charges        overdue = part of it past its due date
tenancy credit      = Σ unallocated of non-reversed payments   net = owed − credit
```

Why derived rather than a maintained summary: a stored total can drift from its parts (a missed update, a partial
failure, a manual fix). A derived total cannot disagree with its parts, so "reconciliation" checks that the *rules*
hold (nothing over-allocated, no currency mixing, …) rather than chasing drift. The cost is query time; the indexes on
`allocations(charge_id)` / `(payment_id)` keep it cheap at property-management scale. If volume ever demands a cache,
add a *derived* materialized summary and keep `reconcile_finance` as the check that it still equals the rows.

## Separate records, append-only

| Record | Meaning | Correction mechanism |
|---|---|---|
| `rent_schedules` | recurring rent definition | stop it, create a new one (cannot re-bill earlier periods) |
| `charges` | an amount owed (generated or manual) | **void** (needs a reason; refused while money is applied) |
| `charge_adjustments` | signed change to a charge (waiver / uplift), admin only | add an opposite adjustment |
| `payments` | money received, **manual entry** | **reverse** (needs a reason) |
| `payment_allocations` | how a payment is applied to charges | **reverse** (needs a reason) |
| `receipts` | numbered immutable snapshot of a payment | voided automatically if the payment is reversed |
| `expenses` | cost against a property | **void** (needs a reason) |
| `finance_audit` | who did what, when, why, before/after | never changes |

Triggers (`app.finance_guard`) make these tables append-only **for everyone, including admins and superusers**: rows
cannot be deleted, only the listed reversal/void marker columns can change, and a marker (`reversed_at`…) is permanent.

## Defined behaviours

* **Partial payment**: allocate less than a charge's outstanding; status `partial`, exact remainder shown.
* **Arrears / overdue**: unpaid or partial charge whose `due_date` is before *today in the property's time zone*.
* **Advance payment / overpayment**: the surplus stays on the payment as `unallocated` credit. It is **never applied
  implicitly** (a later charge does not silently consume it); staff press "Apply to oldest charges" (FIFO by due date) or
  allocate by hand. Credit is shown separately from what is owed, never netted away silently.
* **Reversal**: a reversed payment stays on record, releases all its allocations in the same transaction, and voids its
  receipt. The bank reference becomes reusable. Repeating a reversal is a no-op (no second audit row).
* **Duplicate records**: three layers. (1) every money-moving request needs an `Idempotency-Key`; a repeat returns the
  original result (HTTP 200, `replayed: true`), the same key with different data is refused (409). (2) The same bank
  reference cannot be booked twice on a tenancy (case/space-insensitive) until the first is reversed. (3) Generated rent is
  unique per `(schedule, due date)`; a voided generated charge is deliberately *not* recreated.
* **Currency**: money is `bigint` minor units + a 3-letter currency, never floats. Tenancy, charge, payment, allocation and
  adjustment currencies are bound together by **composite foreign keys**, so an allocation across currencies (or
  tenancies) is impossible at the database level, not just rejected by code. There is no FX workflow; a payment in a
  currency other than its tenancy's is refused. Reports group by currency and never add currencies together.
* **Rounding**: nothing in the ledger divides money. Rent is a fixed amount per period (no proration). The only division
  is the collection rate, in integer basis points, rounded **down**. Human input is parsed from text to minor units with
  no floating point, and **extra precision is rejected rather than rounded** (`1.005` USD → error). Per-entry limit is
  10,000,000,000.00 so every total stays an exactly representable JavaScript integer (checked by reconciliation).
* **Manual, not verified**: payments carry `verification = 'manual_unverified'` (a CHECK constraint allows no other value),
  the UI labels them, and receipts state they are not verified against a bank or payment provider. Nothing implies
  otherwise until a real integration exists.

## Concurrency

Every balance-sensitive function is one transaction with row locks, and a database trigger re-checks the limits on every
allocation insert:

* `allocate_payment` locks the **payment**, then charges in `(due_date, created_at, id)` order. Auto-allocation uses the
  same order, so concurrent operations cannot deadlock.
* `enforce_allocation_limits` (BEFORE INSERT) locks payment then charge and verifies `allocated ≤ payment` and
  `allocated ≤ charge + adjustments`, so even a code path that forgets to lock cannot over-allocate.
* Adjustments, voids and reversals lock the charge/payment row, so "pay while waiving" or "allocate while reversing"
  serialize: exactly one wins.
* `record_payment` serializes per idempotency key (advisory lock) and looks for the earlier result *before* inserting.
  (Found by the concurrency suite: relying on `ON CONFLICT` alone let a retry storm occasionally fail on the reference index.)
* Charge generation is `INSERT … ON CONFLICT DO NOTHING` on a unique index, so any number of simultaneous runs create each
  charge exactly once. Receipt numbers come from a locked counter row: gapless and per organization.

`tests/db/concurrency.test.ts` proves this against a **real PostgreSQL server** (embedded binary, many parallel
connections), not a simulation.

## Reconciliation

`GET /finance/reconciliation` (manager+, also in the UI under Finance → Audit & reconciliation) recomputes from the raw rows:
no payment over-allocated · no charge over-paid · no negative charge · every allocation matches its payment and charge in
currency and tenancy · no money on void charges or reversed payments · receipts of reversed payments are void · and, per
currency, charged / allocated / outstanding / payments / credit **equal** the derived views. Any failure is reported by name
with a count. Run it after imports, migrations or manual database work.

## Permissions

| Action | Role |
|---|---|
| Read ledger, payments, balances, expenses, receipts | staff |
| Record a payment, allocate it, apply credit, issue receipts | staff |
| Rent schedules, generate charges, manual charges, void charge/expense, record expense, **reverse payment/allocation** | manager |
| Adjust a charge | admin |
| Audit history, reconciliation | manager |
| Viewers | no access to payment data |

## Known limits
* Charge generation is **manual** (button / endpoint), not scheduled. A cron job needs a server-side credential and is future work;
  the operation is idempotent so adding one is safe.
* No proration, late fees, FX, bank feeds or payment-provider integration. Expenses have no attachments or per-unit UI yet.
* Rent schedules look ahead at most 366 days.
