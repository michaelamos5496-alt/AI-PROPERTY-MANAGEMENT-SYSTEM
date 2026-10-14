# Release report (Phase 8): measured state at commit time

**Verdict: not production-ready yet.** The software passes everything that can be verified from a development machine. The remaining blockers are things that can only be done against the real platforms (Supabase, Meta, Paystack, Resend, Anthropic) and by people (independent review, legal review). A running homepage or a successful deploy proves none of them. Do not take real tenant data or money until the **Launch blockers** below are closed with dated evidence.

## Results (actual, from this build)

| Check | Result |
|---|---|
| Lint, type check | clean |
| Unit, integration, database policy, API, AI tool, approval, financial reconciliation, webhook, security tests (`npm test`) | **540 passed**, 0 failed (32 files) |
| Playwright end-to-end (any content-security-policy violation fails a test) | **20 passed** |
| Production build + client bundle secret scan | clean |
| Migration lint (`scripts/check-migrations.mjs`): ordering, shipped migrations immutable, destructive statements need a reviewed marker | 39 migrations OK |
| Migrations re-applied over a populated schema | no error, no change (test) |
| `npm audit` (production and dev dependencies) | **0 vulnerabilities** (after upgrading vitest 3 → 5 and esbuild 0.25 → 0.28; before: 2 critical, 1 moderate in dev tooling) |
| Tenant isolation | RLS enabled on every table; no direct write privilege for signed-in users; none for anonymous; **157 organization-scoped functions** refuse strangers, anonymous callers and other organizations' members; **135 declared endpoints × 7 actors** behave per role; **500+ requests with the victim's real ids** reach nothing and change nothing |
| Financial invariants | `reconcile_finance` passes in every finance test, after every step of 4 randomized 60-operation runs, and on the restored database in the restore drill; cached balances proved equal to the ledger; concurrency (parallel allocations, duplicate payments, races for plan limits) proven on real PostgreSQL |
| Approval bypasses | separation of duties, payload hash, recheck at execution, expiry, idempotency, model cannot approve, approvals cannot be reused for another payload, outgoing message text pinned to the draft a person read: all tested; races proven on real PostgreSQL |
| Webhook idempotency and replay | WhatsApp (signature, duplicates, out-of-order receipts, retries) and billing (signature, duplicates, stale/out-of-order, mismatched amounts, unmatched events) tested |
| Provider outages | AI timeout/outage/budget, WhatsApp transient/permanent failures and retries, email retries/dead letters, billing provider timeout → clear 502, no charge: tested |
| Load (embedded PostgreSQL 18, 105 MB, 20 organizations, one with 1,500 units and 24 months of history, 61,000 charges) | **60 active users with think time, reads + writes together: page loads p95 ≤ 135 ms, heaviest report/AI lookup p95 220 ms, 0 errors**; saturation ≈ 150 requests/s on one laptop-class server; full numbers and query plans in `docs/LOAD_TEST_RESULTS.md` |
| Backup / point-in-time recovery drill (real server, live base backup + WAL archive, destructive accident, new server) | **7/7 verification checks passed**; 0.7 s for a 69 MB database (`docs/RESTORE_DRILL_RESULTS.md`) |
| Health | `/api/health`, `/api/health/ready`, authenticated deep health with queue/dead-letter/scheduler checks and live integration probes (tested with fake providers) |

## Defects found and fixed in this phase
See `docs/SECURITY_AUDIT.md` (9 findings). The two most important: internal functions were executable by PUBLIC (not API-reachable by default; now locked at the database and checked in CI), and an open redirect after login (`/<TAB>/evil.com`). The load test found that organization-wide finance lists were O(charges) per call (≈450 ms per call at 33,000 charges; 4–9 s at 20 simultaneous users); fixed with a reconciled balance cache and single-pass queries (list p95 9.2 s → 0.13 s on the same data).

## Launch blockers (open)

| # | Blocker | Why it matters | Who/what closes it |
|---|---|---|---|
| 1 | **No real-platform verification of any external integration.** WhatsApp (Meta), billing (Paystack), email (Resend), AI (Anthropic) and Supabase itself have been exercised only against simulators and fake clients. Paystack request shapes and recurring support for GHS/KES are unconfirmed (only NGN appeared in the documentation read; the docs site blocked automated fetching). | "Works against my fake" is not "works": signature headers, field names and limits drift | Run the staging checklist in RELEASE.md; fill the verification logs in WHATSAPP.md and BILLING.md; `GET /api/internal/health?probe=1` all `ok` |
| 2 | **Backups on the real platform are unverified.** PITR must be enabled on the production Supabase project; the Supabase restore, the nightly encrypted-dump workflow (`pg_dump` is not available where this was built) and Storage (uploaded files) replication have never been exercised. Without PITR the RPO is up to 24 h, against a 15-minute target. | Financial data | Enable PITR; do the three "NOT DONE" rehearsals in BACKUP_RECOVERY.md and log them |
| 3 | **No independent security review or penetration test.** | Everything above was done by the builders, with automated tools | Commission one against staging |
| 4 | **Legal and privacy review** (privacy notice, data-processing terms with each provider, messaging consent evidence, breach-notification duties, anything country-specific). No country-specific legal rules are built in, by design. | Cannot be answered by software | Qualified adviser |
| 5 | **Per-instance rate limits only.** Distributed password guessing or abusive traffic is slowed, not stopped. No MFA for staff. | Owners/admins control money | Vercel Firewall rules (or a shared limiter) and MFA before opening public signups |
| 6 | **Uploads are not scanned for malware** and the declared file type is not verified from bytes. | Staff open files tenants upload | Add scanning before enabling tenant uploads for untrusted audiences |
| 7 | **Load numbers are from an embedded database on one laptop**, without PostgREST, network or Supabase hardware. | Directional only | Re-run `npm run load` shape against staging with production-like volume and compute |
| 8 | **Operational readiness is paper only:** on-call, alert webhook delivery to a phone, status communication, two named restorers. | Incidents happen at night | Complete the RELEASE.md checklist |
| 9 | **Placeholder prices** and unconfirmed provider plan codes in `plan_prices`. | Customers would be charged wrong amounts | Set real prices/plan codes; billing stays `none` until blocker 1 for billing is closed |

## Known limitations that are not blockers
English only; WhatsApp text-only; one Meta app/token for all organizations; email jobs do not honour quiet hours; AI answers depend on heuristics for grounding checks; CSV export covers charges and payments only; the in-memory pieces (rate limits, concurrent AI turns per instance) reset on cold starts.

## How to reproduce this report
`npm run check` · `npx playwright test` · `npm run load` · `npx tsx scripts/restore-drill.ts` · `node scripts/check-migrations.mjs` · `npm audit`
