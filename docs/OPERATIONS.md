# Phase 4: maintenance, notifications and approvals

## Maintenance lifecycle (enforced by the database)

```
submitted ─► triaged ─► assigned ─► in_progress ─► resolved ─► (reopen) in_progress
    │           │  └──► awaiting_approval ─► assigned          
    └───────────┴──► cancelled   (terminal; also from assigned / in_progress / awaiting_approval, by a manager)
```
Allowed moves are listed in `app.maintenance_transition_ok` and enforced by a trigger, so a bug or a raw SQL statement cannot skip a step.
Every move writes an append-only history row (who, when, why). Requests, work orders and estimates are never deleted.

| Action | Minimum role |
|---|---|
| Submit, triage, add notes, submit estimates, start/complete own work | staff |
| Assign work **to yourself** or to a vendor | staff |
| Assign work to **anyone**, cancel arranged work, reopen, acknowledge escalations, vendors, urgency levels, delivery & jobs | manager |
| Escalation contact, safety keywords, approval thresholds | admin |
| Tenants: raise requests for **their own active tenancy**, add messages/photos, cancel *before* work is arranged | verified tenant (portal) |

Assignees must be staff or above (never viewers or non-members); exactly one of vendor / staff member per work order.
Work orders have their own states (`assigned → in_progress → completed`, or `cancelled`) and a request resolves only when none is open.

## Critical escalation: a human is always told

A request is **critical** when *any* of: its (human-set) urgency level is critical · a deterministic **safety keyword** appears in the text
(configurable; defaults include "gas leak", "flood", "fire", "carbon monoxide") · an advisory classification **suggests** a critical level.

* Escalation goes to the **designated contact**; if none is set (or they no longer hold a manager role) it goes to **every owner and admin**, never to nobody.
  It is a mandatory notification: recipients cannot opt out of it.
* **Nothing clears it.** A suggestion can only *raise* handling (`set_suggested_urgency` never changes the human-set urgency); lowering urgency needs a
  manager, a reason, and an acknowledged escalation, and the escalation flag stays on the record.
* Unacknowledged escalations are re-sent every *N* hours (configurable), widening to owners/admins after repeated windows, until a human acknowledges.
* At least one urgency level must always be critical; the last one cannot be archived or un-flagged.

## Tenant portal and verification

Tenants are **not organization members** (a member role would expose staff data). A manager invites a tenant by their email on file; the tenant opens a
single-use link (token stored only as a hash, 7-day expiry) and must sign in/register with a **confirmed** account whose email **matches**. That creates a
`tenant_users` link. Portal functions then check, on every call: the link is active · the tenancy is active · the tenant is on it. Tenants see only their own
requests, tenant-visible notes and photos, and friendly statuses. Staff-only notes, costs, vendors and escalation details are never returned. Access can be revoked.

## Notifications and email delivery

* In-app notifications + a **durable email queue** (`email_queue`). Preferences are per user, event and channel; **mandatory** events (critical escalations) ignore opt-outs.
* **Deduplication**: every notification carries a dedupe key, unique per organization, so repeating an event or re-running a job never double-sends.
* **States**: `queued → sending → sent`, or `failed` (will retry) → `dead` (gave up). A worker *claims* rows with `FOR UPDATE SKIP LOCKED` and a lease, so any number of
  workers can run; if one crashes, the lease expires and the email is retried. Retries back off 30s, 1m, 2m, 4m… (cap 1h); after 5 attempts, or on a
  permanent rejection (invalid address), it is `dead`. Managers see counts, last error and attempts under **Operations → Delivery**, and can retry.
* Providers: `log` (development; sends nothing) and `resend` (HTTP contract implemented; **not yet exercised against the live service**).
* Critical alerts are flushed immediately after the write (best-effort, time-boxed); the scheduler is the durable safety net.

## Scheduled jobs

`GET /api/internal/jobs/run` (Bearer `CRON_SECRET`; needs `SUPABASE_SERVICE_ROLE_KEY`) runs, for every organization: **rent-due reminders** (3 days before, due, overdue: one email
per charge, stage and tenant; honours tenant opt-out), **lease-expiry reminders** (60/30/14/7-day thresholds, once each, re-armed if the end date changes), **escalation
follow-ups**, **approval expiry**; then flushes the email queue. All jobs are idempotent by dedupe key and take a per-job advisory lock, so repeating or overlapping runs cannot
duplicate anything (proved against a real PostgreSQL server). A job that errors is recorded in `job_runs` and the endpoint returns 500 so the scheduler shows a failure.

Scheduling: `vercel.json` ships a **daily** cron (valid on every plan). For retries every few minutes use `.github/workflows/scheduler.yml` (set repo secrets `APP_URL`, `CRON_SECRET`)
or a Vercel Pro cron such as `*/10 * * * *`. The service-role key is used **only** by that endpoint; the bundle scan fails the build if it ever reaches a client file.

## Approval engine (reusable)

A proposal stores: requester · action type · target · the **exact payload** · `payload_hash` · a **fingerprint** of the target's relevant state · expiry · decision · execution result.
The payload, hash, fingerprint, action and target are **immutable** (trigger); only status/decision/execution fields change, and only along lawful transitions:

```
pending ─► approved ─► executing ─► executed
   │  │        │  │          └─► failed ─► executing (retry) …
   │  │        │  └────────────────────────► invalidated
   │  └─► rejected / cancelled / expired
```

* **Different person**: the requester cannot approve their own request (an admin can enable self-approval for tiny teams). Approvers need the action's minimum role.
* **Invalidation**: replacing an estimate, cancelling the work or the request, or *any change to the target after it was proposed* withdraws the approval, and an approval can never be
  applied to a different payload. Re-proposing the identical thing is idempotent (same approval); a changed proposal supersedes the old one.
* **Recheck at execution**: requester and approver roles, target access, fingerprint and payload hash are verified *at execution time*. Failures are recorded (`failed` + error) with no partial effects; `retry` completes it exactly once.
* **Idempotency for side effects**: each approval has a stable `execution_key` (`approval:<id>`); anything it triggers is keyed by it, so a retry can never repeat an effect.
* Supported actions: `maintenance.approve_cost` and `finance.void_charge`. Add more by registering an action, a payload validator, a fingerprint and an executor.

## Known limits
* Email is not yet verified against a live provider; the delivery logic is proven with a scriptable fake and the real database.
* The unit picker for new requests lists the first 100 units. Vendors have no per-job email reply handling. No SMS/push channels.
* Scheduling on Vercel Hobby is daily; use the GitHub workflow (or Pro) for frequent retries.
