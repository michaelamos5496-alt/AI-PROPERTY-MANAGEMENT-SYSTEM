# Deployment

Three separate environments, never sharing data, keys or webhooks: **development** (your machine), **staging** (production-shaped, fake data), **production**.
Rule: **no real customer data outside production**, and no production credentials anywhere else (not in Preview deployments, not in CI, not on laptops).

| | Development | Staging | Production |
|---|---|---|---|
| Supabase | local stack (`supabase start`) or a personal dev project | its own project | its own project (PITR on, see BACKUP_RECOVERY.md) |
| Vercel | `npm run dev` | **Preview** deployments + a pinned `staging` branch/domain | **Production** (branch `main`) |
| Domain | localhost:3000 | `staging.<your-domain>` | `app.<your-domain>` |
| Email | `EMAIL_PROVIDER=log` | Resend, restricted to an allow-list of test addresses | Resend, verified domain |
| WhatsApp | `WHATSAPP_PROVIDER=log` | Meta **test** number + 5 verified recipients | production number (after Meta verification) |
| AI | `LLM_PROVIDER=offline` | Anthropic key with a low spend limit | Anthropic key with a spend limit + `COPILOT` budgets |
| Billing | `BILLING_PROVIDER=none` | Paystack **test** keys | Paystack **live** keys (only after the verification log in BILLING.md is filled in) |

Vercel setting that matters most: **scope every variable to exactly one environment** (Settings → Environment Variables → tick only Production, or only Preview). A Preview deployment must point at the *staging* Supabase project, never production.

## 1. Local development
```bash
npm ci
cp .env.example .env            # SUPABASE_URL=http://127.0.0.1:54321 plus the keys `supabase status` prints
supabase start && supabase db reset     # applies supabase/migrations/*.sql to a throwaway local database
npm run dev                     # http://localhost:3000
```
**Skip the login screen locally:** put `DEV_AUTO_LOGIN_EMAIL` and `DEV_AUTO_LOGIN_PASSWORD` (a real account you registered) in `.env`; `npm run dev` then signs you in as that account when you open `/`. It is not an authentication bypass (Supabase still authenticates you and row level security still applies), it exists only in the local dev server, binds to 127.0.0.1, and the app refuses to start with these set in production, on Vercel, or with a non-local `APP_URL`. Never copy them into Vercel.

Everything external is simulated by default (`log` providers, offline AI, no billing). `npm run check` runs lint, types, every test, the build and the secret scan.
Tests need no Supabase: they run the real migrations on embedded PostgreSQL (PGlite for most, a real server for concurrency).

## 2. Supabase project (do once per environment)
1. Create the project in the region closest to your users (Africa: confirm the nearest available region; latency to the database dominates page speed). Use a long random database password; store it in a password manager.
2. **Settings → API → Exposed schemas: only `public`.** `app` holds internal helpers and must never be reachable through the REST API (it is also locked at the database level, see the hardening migration; CI checks `supabase/config.toml`). Leave "Extra search path" as `public`.
3. **Authentication**
   * Providers: Email only. Enable *Confirm email* (required: invitations are honoured only for verified addresses).
   * Password policy: minimum length ≥ 10 (the server also enforces 10–128), enable leaked-password protection if your plan has it.
   * URL Configuration: *Site URL* = the environment's `APP_URL`; *Redirect URLs* = exactly `APP_URL/api/auth/confirm` (no wildcards).
   * Email templates: confirm = `{{ .SiteURL }}/api/auth/confirm?token_hash={{ .TokenHash }}&type=signup`, recovery = `…&type=recovery` (as in SETUP.md).
   * **Custom SMTP** before any real user signs up (built-in sender is heavily limited and unbranded). Use the same provider/domain as `EMAIL_FROM`.
   * JWT expiry: 3600 s (the server renews with the refresh cookie). Refresh token rotation: on.
   * Auth rate limits: leave at Supabase defaults or stricter (the app's own limiter is per-instance only).
4. **Storage**: the private buckets (`lease-documents`, `maintenance-attachments`) are created by migrations. Do not make them public. Check *Storage → Policies* shows only our policies.
5. **Database**: enable **Point-in-Time Recovery** (production); set a spend/size alert; add *network restrictions* if you only connect from fixed addresses. Keep the `service_role` key out of everything except the Vercel server environment and (for backups) nothing at all.
6. Role timeouts (`statement_timeout`, idle-in-transaction) are set by migration `20261023000001`; revisit them with real telemetry.
7. Connection limits: the app talks to the database **only through PostgREST over HTTPS**, not through direct Postgres connections, so serverless instances cannot exhaust Postgres connections; the ceiling is PostgREST's pool (Supabase: scales with compute size). Watch *Database → Connections* in the dashboard; scale compute before the pool saturates.

## 3. Environment variables
Set in Vercel (Production / Preview separately). **Secret** = never in git, never in the browser (the build fails if one appears in `public/`).

| Variable | Required | Secret | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | no | `production` (enables Secure cookies, HSTS, https-only APP_URL) |
| `APP_URL` | yes | no | `https://app.<domain>`; used for email links and CSRF origin checks |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | yes | anon key is public by design but kept server-side | from Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (jobs, webhooks, AI audit) | **yes** | server only; bypasses RLS; used only by narrow `*_svc_*` functions |
| `CRON_SECRET` | yes | **yes** | ≥ 32 random chars; scheduler + operator endpoints + detailed health |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` | for email | key: **yes** | `resend` in staging/production |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `LLM_*_MICRO_PER_MTOK` | for AI | key: **yes** | set real prices; set a spend limit at Anthropic as well |
| `COPILOT_EXTERNAL_ENABLED` | no | no | `false` until external messaging is deliberately enabled |
| `WHATSAPP_PROVIDER`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_GRAPH_VERSION` | for WhatsApp | **yes** (all but provider/version) | see WHATSAPP.md |
| `BILLING_PROVIDER`, `PAYSTACK_SECRET_KEY`, `BILLING_PAYSTACK_CURRENCIES` | for billing | key: **yes** | see BILLING.md |
| `ALERT_WEBHOOK_URL` | recommended | **yes** (the URL is a credential) | Slack-compatible incoming webhook |
| `LOG_LEVEL`, `RATE_LIMIT_*`, `EMAIL_*`, `COPILOT_*` | no | no | defaults in `.env.example` |

Generate secrets with `openssl rand -base64 48`. **Rotation:** change in Vercel → redeploy → revoke the old one at the source. Rotate `CRON_SECRET` and the Supabase service key after any suspected exposure and whenever someone with access leaves.

## 4. Database migrations and seed data
* Schema changes exist **only** as new files in `supabase/migrations/` (never edit one that has shipped; CI refuses). Plans, currencies, countries, notification types and approval actions are seed data inside migrations, so every environment gets the same reference data and **no demo data is ever loaded into production**.
* Pull request → CI: lint, types, `scripts/check-migrations.mjs` (ordering, immutability, destructive statements need a `-- reviewed-destructive: <reason>` marker), every test incl. policy and authorization sweeps, the migrations applied twice to a real Supabase stack.
* **Deploy procedure** (Actions → *Deploy database migrations*): staging first → run the smoke checks below → production (requires the `production` environment's reviewers and `confirm_backup=YES`). The workflow does a dry run, applies, then checks `/api/health/ready` and `/api/internal/health`.
* **Expand → deploy → contract.** Add columns/tables/functions first (backwards compatible with the running code), deploy the code, remove old things in a *later* migration after a release has run cleanly. Never drop or retype a column in the same release that stops using it.
* Destructive change (drop/rename/retype, bulk delete, data rewrite) needs a written plan: why, how many rows, how to roll back, a fresh backup, and a rehearsal on a staging copy. Mark the migration `-- reviewed-destructive: <ticket>`.
* Migrations here are written to be re-runnable (`if not exists`, `create or replace`, drop-then-create) and tests prove it, so a half-applied deploy can be re-run.

## 5. Vercel
1. Import the repository; framework **Other**; `vercel.json` provides build, output, rewrites, security headers and the cron.
2. `functions."api/index.ts".maxDuration` is 60 s. **Set it to the maximum your plan allows** and keep `COPILOT_TURN_DEADLINE_MS` (default 50 s) at least 5 s below it; if your plan allows less, lower both or AI answers will be cut off.
3. Environments: Production = branch `main`; Preview = every PR (points at **staging** Supabase; enable *Deployment Protection* so previews are not public).
4. Cron: Vercel Cron runs the scheduler daily; the GitHub Actions workflow *Scheduled jobs* runs it every 10 minutes (needs repo secrets `APP_URL`, `CRON_SECRET`). Both are idempotent. Set `APP_URL`/`CRON_SECRET` as Action secrets per environment.
5. Smoke test every deploy (staging and production): `GET /api/health` (200), `GET /api/health/ready` (200), `GET /api/internal/health?probe=1` with the bearer secret (200, every configured integration `ok`), sign in, create and archive a property, open Copilot, open Plan.

## 6. Domain and HTTPS
1. Vercel → Domains → add `app.<domain>`; create the DNS record Vercel shows (CNAME to `cname.vercel-dns.com`, or A for apex). The certificate is issued and renewed automatically.
2. Redirect `www`/apex to the app host; keep **only HTTPS**. Headers set in `vercel.json`: HSTS (2 years, includeSubDomains), CSP (self + Supabase for uploads), nosniff, frame-deny, referrer policy. Before enabling HSTS `preload`, be sure every subdomain will always have HTTPS.
3. If you move to a custom Supabase domain, add it to the CSP `connect-src` and to Auth redirect URLs.
4. Set `APP_URL` to the final https origin and re-verify Auth URL configuration (a wrong value breaks sign-in links and CSRF checks).

## 7. Email (Resend)
Verify the sending domain (SPF + DKIM, and add DMARC `p=none` first, then tighten); create an API key restricted to *Sending access*; set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (an address on the verified domain). Check *Operations → Delivery* shows sent emails and that bounces land in "gave up". The queue retries transient failures with backoff (5 attempts) and exposes dead letters; the monitor alerts on them.

## 8. WhatsApp, billing, AI
Follow WHATSAPP.md, BILLING.md and COPILOT.md. For each, **staging first**, with test credentials, and record the verification evidence in the log tables at the end of those documents. Production webhooks are separate subscriptions from staging ones.

## 9. Monitoring and alerts
* **Logs:** structured JSON per request (request id, status, timing, user id; secrets redacted). Add a Vercel *Log Drain* to your log tool (Axiom, Datadog, Better Stack…). Alerts to create there: `level=error` rate > 5/min; 5xx rate > 1% over 5 min; any `operational alert`.
* **Uptime:** an external monitor on `GET /api/health/ready` every minute (alert after 2 failures) and on `GET /api/internal/health` (bearer `CRON_SECRET`) every 5 minutes; 503 means degraded and the body lists what is stuck (dead emails, stuck WhatsApp events, unmatched billing events, scheduler not run for 1 h, expired-but-pending approvals). Append `&alert=1` to also post to `ALERT_WEBHOOK_URL`.
* **Integrations:** `GET /api/internal/health?probe=1` calls Supabase Auth, Resend, Meta, Anthropic and Paystack with the configured credentials (only those configured). Run it after every credential change and from the monitor hourly.
* **Database:** Supabase dashboard alerts for CPU > 80 %, disk > 80 %, connections > 80 %; weekly `pg_stat_statements` review (queries in LOAD_TEST_RESULTS.md).
* **Cost:** Anthropic and Meta spend limits at the provider; the app's own per-organization daily AI budget; `GET /api/internal/health` does not include spend, so review the AI usage table weekly.
* **Errors in the browser** are surfaced to people with a request id they can quote; the server logs the same id.
