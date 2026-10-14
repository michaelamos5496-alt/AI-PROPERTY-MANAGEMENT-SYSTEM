# Release: launch checklist, rollback, incident response, post-launch monitoring

> **Status today:** see `docs/RELEASE_REPORT.md` for the measured state and the open launch blockers. This document is what you follow; the report is what is true.

## 1. Launch checklist (every box needs evidence: a link, a date, a name)

### Security
- [ ] `npm run check` green on the release commit; CI green, including `secrets` (gitleaks), `npm audit --omit=dev` (0 high/critical) and the real-Supabase `migrations` job
- [ ] `docs/SECURITY_AUDIT.md` reviewed; **no open critical or high finding**; accepted residual risks signed off by the owner
- [ ] Supabase *Exposed schemas* = `public` only (screenshot); Email provider only; Confirm email on; custom SMTP; password minimum ≥ 10
- [ ] Auth redirect URLs contain only the production URL
- [ ] All production secrets rotated since they were last seen by anyone other than the owner; no secret in Preview/Development scopes; service-role key only in Vercel Production
- [ ] Penetration or at least independent code review by someone who did not write it (recommended before taking money or real tenants' data)
- [ ] Privacy notice, terms, data processing terms with Supabase, Vercel, Resend, Meta, Anthropic, Paystack reviewed by a qualified person; breach-notification duties for the countries you operate in understood (do not assume; ask counsel)

### Data and reliability
- [ ] Production Supabase has **PITR on**; nightly encrypted dump workflow configured and has produced a file; bucket replication for Storage configured
- [ ] **Restore rehearsed on the real platform** (see BACKUP_RECOVERY.md rehearsal log) with measured RTO ≤ 4 h and RPO ≤ 15 min
- [ ] `docs/LOAD_TEST_RESULTS.md` re-run against **staging with production-like volume** (the repo's numbers are from an embedded database on a laptop) and p95 acceptable
- [ ] Migrations deployed to staging then production through the workflow; `supabase db push --dry-run` clean
- [ ] Scheduler running every 10 minutes (Actions) and the monitor sees the heartbeat (`jobs.last_ok_at` < 1 h)
- [ ] Vercel `maxDuration` matches the plan and `COPILOT_TURN_DEADLINE_MS` is 5 s lower

### Integrations: each one *verified end to end in staging*, evidence recorded in its own log
- [ ] Email: a real message delivered, a bounce handled, SPF/DKIM/DMARC pass (WHATSAPP/BILLING logs similar)
- [ ] WhatsApp: signature checks, handshake, a real message phone→app→phone, delivery receipt, STOP/START (WHATSAPP.md verification log)
- [ ] Billing: test-mode checkout → verified webhook → plan change; failed payment → past due; reconcile (BILLING.md log) and `BILLING_PAYSTACK_CURRENCIES` lists only currencies Paystack confirmed for your account
- [ ] AI: `GET /api/internal/health?probe=1` shows Anthropic `ok`; per-organization budgets and the provider spend limit set; external messaging OFF (`COPILOT_EXTERNAL_ENABLED=false`) until the approval flow has been exercised with the test action in production
- [ ] `GET /api/internal/health?probe=1` returns 200 with every configured integration `ok`

### Product and operations
- [ ] Plans and **real prices** loaded (`plan_prices`), placeholder prices removed; legal pages linked
- [ ] On-call: who is paged, how (alert webhook → phone), who is the backup; the incident guide below printed or pinned
- [ ] Support inbox and a way for customers to report a security issue (`security@` address)
- [ ] Status communication channel decided (email list / status page)
- [ ] First customers onboarded manually (see the 7-day plan below)

**Go / no-go.** Go only when every box in *Security* and *Data and reliability* is ticked with evidence and nothing is "accepted" that touches money, isolation, or approvals. Everything else can be a dated follow-up.

## 2. Rollback procedure

Decide in minutes, not hours: **if customers are harmed or data may be wrong, stop the bleeding first (kill switch), then roll back.**

**Kill switches (no deploy needed)**
| Problem | Switch |
|---|---|
| AI behaving badly or costing too much | Copilot → Settings → off (per organization) or `LLM_PROVIDER=offline` (all) or set a tiny `daily_budget_micro` |
| Wrong/unwanted tenant messages | Copilot → Settings → *external messages* off; `COPILOT_EXTERNAL_ENABLED=false`; WhatsApp → Setup → channel off |
| WhatsApp webhook flood / abuse | Channel off (events are then ignored), rotate `WHATSAPP_APP_SECRET`/verify token |
| Billing misbehaving | `BILLING_PROVIDER=none` (entitlements keep working; operators assign plans) |
| Scheduler misbehaving | Disable the *Scheduled jobs* workflow and the Vercel cron |
| Everything | Vercel → *Deployment Protection* / pause the project (returns errors; data stays safe) |

**Application rollback:** Vercel → Deployments → promote the previous good deployment ("Instant Rollback"). Takes effect in seconds; the database is not touched.

**Database rollback.** Migrations are **forward-only**; there is no "down". Because every release follows *expand → deploy → contract*, the previous application version still works against the new schema. Therefore: roll the **app** back, then ship a **new migration** that fixes or reverses the change. Never edit or delete a shipped migration.
Only when data itself is wrong or lost: point-in-time recovery (BACKUP_RECOVERY.md scenario A), after stopping writers.

**Order of operations for a bad release:** kill switch if harm is ongoing → roll back the app → check `/api/internal/health` → write down what happened (timeline with request ids) → fix forward on a branch with a test that reproduces it.

## 3. Incident response guide

**Severity.** SEV1: tenant data exposed to the wrong party, money wrong, system down for everyone, secret leaked. SEV2: a feature down (WhatsApp, AI, billing, email), degraded performance for many, one customer's data wrong. SEV3: minor/cosmetic/one user.

**First 15 minutes (SEV1/SEV2)**
1. **Acknowledge** in the alert channel; name one **incident lead** (decides) and one **scribe** (keeps a timestamped log in a shared doc).
2. **Contain before diagnosing**: flip the relevant kill switch (table above). If a secret might be exposed, rotate it now (Vercel → redeploy → revoke at the source).
3. **Assess**: `GET /api/internal/health?probe=1`; Vercel logs filtered by `requestId`/`level=error`; Supabase logs; provider status pages (Supabase, Vercel, Resend, Meta, Anthropic, Paystack).
4. **Preserve evidence** before cleaning: export the relevant `*_audit`, `approval_events`, `subscription_events`, `whatsapp_messages`, `copilot_tool_calls` rows (they are append-only for this reason).

**Playbooks**
* **Suspected cross-tenant exposure (SEV1).** Turn the service off or restrict to read-only if you cannot rule it out. Identify the endpoint/function from logs; reproduce with the authorization matrix (`npm run test:security`) plus a new test; fix in SQL/route; deploy; determine *who saw what* from `request` logs (user id, org id, path) and audit tables; **notify affected customers and regulators as the law and contracts require: decide with counsel, do not wait for certainty about every detail.**
* **Secret leak.** Rotate immediately; check provider logs for use; invalidate sessions if Supabase keys were involved (rotate JWT secret = signs everyone out); search git history and logs for the secret; add a gitleaks rule.
* **AI sent/prepared something wrong.** Copilot actions never execute without a person: find the proposal (`copilot_actions`, tool-call audit), the approver and the payload hash; if a message was sent, it is in `email_queue`/`whatsapp_messages` with the approval id; contact the recipient, correct, then review the prompt-injection tests for the vector.
* **WhatsApp wrong or unwanted messages.** Channel off; list recent outbound (`whatsapp_messages` origin/approval); check opt-outs were honoured (`consent`); inform Meta contact if quality rating is at risk.
* **Payments/billing mismatch.** `BILLING_PROVIDER=none` if needed; compare `billing_events` with the provider dashboard; run reconcile (`POST /billing/reconcile`) per organization; correct with `billing_svc_assign` (recorded with a reason); refund via the provider if charged wrongly.
* **Ledger looks wrong.** Run `reconcile_finance`; the cache table is reconstructible from the ledger (migration `20261022000001` shows how); correct with reversal/adjustment entries, never edits.
* **Database down / slow.** Supabase status; `pg_stat_statements` top queries; check for runaway queries (statement timeouts are set); scale compute; if corruption suspected: stop writers and use PITR.
* **Email not delivering.** `Operations → Delivery`, dead letters; Resend status; after the fix, requeue from the UI (the queue is durable).

**After:** within 5 working days a blameless review: timeline, impact, root cause, what detected it (or why nothing did), what we change (tests first). Update this document. Tell affected customers what happened and what you changed.

## 4. Post-launch monitoring plan

| When | What to watch | Where | Action threshold |
|---|---|---|---|
| **First hour after each deploy** | `/api/health/ready`, `/api/internal/health?probe=1`, error rate, sign-in works | monitor, logs | any 5xx spike → roll back |
| **Day 1** (check every 2 h) | scheduler heartbeat, email dead letters, WhatsApp stuck/dead events, billing pending events, `reconcile_finance` for each customer, AI spend vs budget | `/api/internal/health`, Operations page | any item in `problems[]` |
| **Days 2–7** (daily, 10 min) | same + slow queries (`pg_stat_statements`), DB CPU/disk/connections, rate-limit 429 counts, 402 plan-limit counts (are customers hitting limits unexpectedly?), approvals backlog (pending > expiry) | dashboards | p95 page load > 1 s; CPU > 70 % sustained |
| **Weeks 2–4** | growth of `email_queue`, `notifications`, `whatsapp_*`, `copilot_*` (retention), index usage, storage size, cost per organization (AI + WhatsApp + email) | SQL (LOAD_TEST_RESULTS.md) | table > 5× expected; cost outliers |
| **Monthly** | restore rehearsal log, dependency audit, secret rotation due, access review (who has Supabase/Vercel/GitHub/Meta access), re-run `npm run load` against staging | | any overdue item |

Service-level objectives to publish internally: availability ≥ 99.5 % monthly (excluding provider outages declared on their status pages), p95 page API < 1 s, scheduler heartbeat gap < 15 min, WhatsApp inbound → reply < 30 s p95, email queue age < 15 min p95.

**First customers.** Onboard 1–3 friendly organizations manually in week 1 (you present, you watch their data and logs with their consent), keep external messaging off for them until they have used the approval test action, review every alert and support message the same day, and only then open signups.
