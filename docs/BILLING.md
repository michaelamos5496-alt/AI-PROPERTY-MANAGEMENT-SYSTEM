# Plans, entitlements and billing (Phase 7)

## What is enforced (and where)

Limits live in the database, not the UI. Hiding a button is cosmetic; the control is that the write is refused.

| Entitlement | Kind | Enforced by |
|---|---|---|
| properties, units | limit (live count of non-archived records) | `BEFORE INSERT/UPDATE` triggers on `properties`, `units` (including un-archiving) |
| seats | limit (members except view-only) | trigger on `memberships` (insert / role change) **and** on `invitations` (an invitation reserves a seat) |
| storage_mb | limit (lease documents + maintenance attachments) | triggers on both tables |
| ai_requests_month | monthly meter | `app.consume()` inside `copilot_svc_begin_turn` |
| whatsapp_conversations_month | monthly meter (a conversation = a new 24-hour window) | `app.consume()` inside `wa_svc_begin_inbound`; over the allowance the sender is told a person will reply and staff get a handoff |
| copilot, whatsapp | feature | `app.require_feature()` in the copilot turn, `save_wa_channel`, and the WhatsApp channel lookup |
| exports | feature | `require_entitlement()` called by the export routes |

Violations return **HTTP 402** (`limit_reached`) with a plain sentence ("Your Starter plan allows 3 properties. Upgrade your plan to add more.").
Counting is serialised per organization and key with an advisory lock, so two simultaneous requests cannot both take the last slot (proved on real parallel PostgreSQL).

**Principle:** a lapsed, cancelled or downgraded organization is never locked out of its data and nothing is deleted. It falls back to the `free` plan's limits, which only stop *new* additions; existing records stay readable and editable.

## Plans, prices, overrides (trusted configuration)

`plans`, `plan_entitlements`, `plan_prices`, `entitlement_catalog`, `billing_config` are database tables seeded by migration `20261020000001`, changed by migration or the service role only (no user can write them).
Operator tools (credential = `CRON_SECRET`, not a user session):

* `POST /api/internal/billing/assign` `{orgId, plan, status, periodEnd, reason}`: assign a plan by hand (invoice customers, pilots, corrections). Recorded in `subscription_events`.
* `POST /api/internal/billing/override` `{orgId, key, enabled, limit, reason, expiresAt}`: a time-boxed exception to one entitlement.

> **The seeded prices are placeholders** (clearly labelled in the migration). Set real prices and the provider's plan codes (`plan_prices.provider_plan_ref`) before launch.
> The trial plan, trial length and grace days are in `billing_config` (default: Growth, 14 days, 7 days).
> Organizations that existed before this phase were moved to an unlimited `legacy` plan so nothing broke.

## Subscription lifecycle

States: `trialing` → `active` → `past_due` (grace period) → `expired`; `cancelled` keeps the plan until the paid period ends. `app.effective_plan()` decides what applies *right now* (a one-day tolerance covers a late renewal notice). `billing_svc_tick()` (scheduler, every run) records the transitions, sends one trial-ending reminder, and starts the grace period for an unpaid period.
Every change is appended to `subscription_events` (append-only).

## Billing provider: status

**Automated recurring billing is PENDING.** With `BILLING_PROVIDER=none` (default): all entitlements and limits work, the Plan page says online payment is not switched on, checkout answers 503 with that explanation, and plans are assigned by an operator.

A Paystack adapter is implemented (`src/billing/provider.ts`) and tested against fake traffic. **What was confirmed from Paystack's current documentation, and what was not:**

| Item | Status |
|---|---|
| Webhook signature: HMAC-SHA512 of the raw body with the secret key, header `x-paystack-signature` | Confirmed (docs-v2.paystack.com/payments/webhooks) |
| Events: `charge.success`, `subscription.create`, `subscription.not_renew`, `subscription.disable`, `invoice.create`, `invoice.payment_failed`, `invoice.update`; 200 OK required; live retries every 3 min ×4 then hourly up to 72 h | Confirmed |
| Subscriptions support cards (and Direct Debit in Nigeria) only; **mobile money is not a recurring option** | Confirmed from the Subscriptions page summary |
| Which of **GHS and KES** (vs NGN) your account can charge for *recurring* subscriptions | **NOT confirmed.** Only NGN appeared in the documentation I could read. That is why `BILLING_PAYSTACK_CURRENCIES` is configuration (default `NGN`) and checkout refuses any currency not listed. Confirm per currency with Paystack before listing it. |
| Request shapes for `transaction/initialize`, `subscription/:code`, `subscription/disable` | From Paystack's public API reference as I know it; **not verified against a live account** (the docs site blocked automated fetching) |
| Events carry no event id | Handled: a stable id is derived from the object (`charge.success:<transaction id>`), so replays collapse |

### Trust rules
* A payment counts only when it arrives as a **signature-verified** webhook (or our own server-side fetch of the provider's record: reconciliation). The browser redirect after checkout changes nothing (tested).
* Each event is stored once (`unique(provider, provider_event_id)`), applied once; the same payment under a different id is ignored as stale (monotonic `last_payment_at`).
* An event is attributed to an organization **only** through a checkout we started (`billing_checkouts.reference`) or a stored provider customer/subscription reference. Unmatched events wait and are retried, then ignored; never applied to a guess.
* The amount and currency must match the plan price we expected, otherwise the event is `rejected` and nothing is upgraded.
* A failure older than the last successful payment never downgrades; a replayed old event never extends a period.
* Reconciliation (`POST /billing/reconcile`, and the scheduler for subscriptions near renewal or past due) re-reads the provider's own record and corrects missed events.

### To enable Paystack
1. Create the plans at Paystack for each (plan, currency, interval) you will sell; put the codes in `plan_prices.provider_plan_ref` and set real `amount_minor`.
2. Set `BILLING_PROVIDER=paystack`, `PAYSTACK_SECRET_KEY`, `BILLING_PAYSTACK_CURRENCIES` (only currencies confirmed for your account).
3. In the Paystack dashboard set the webhook URL to `https://<app>/api/webhooks/billing/paystack` (test and live separately).
4. Run a test-mode checkout end to end and **record it** in the log below before calling billing live.

## Verification log

| Date | Environment | What was seen | By |
|---|---|---|---|
| — | **no live Paystack verification yet** | | |
