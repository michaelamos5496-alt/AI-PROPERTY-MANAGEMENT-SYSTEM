# Property AI — Phases 1–7: foundation, properties and tenancies, rent ledger, operations, AI copilot, WhatsApp assistant, plans and markets

Multi-tenant workspace: auth, organizations, roles, invitations. Node 20+/TypeScript API (Express 5) on Vercel,
static HTML/CSS/vanilla-JS frontend, Supabase (Auth + Postgres with RLS).

## Architecture

```
browser ──(HttpOnly cookies)──> /api/* (Express, Vercel function) ──(user JWT)──> Supabase Auth + PostgREST RPC
   static pages in /public                                                      Postgres RLS + SECURITY DEFINER RPCs
```

* The browser never holds Supabase keys or tokens. Sessions are HttpOnly cookies set by the API.
* The API always calls Postgres **as the signed-in user**; RLS and the SQL permission checks are the final authority.
  Route middleware (`requireAuth`, `requireOrgRole`) is a fast-fail layer on top.
* No service-role key is used or needed in Phase 1.
* Roles: `owner > admin > manager > staff > viewer` (`src/lib/roles.ts` mirrors `app.role_rank` in SQL).

## Local development

```bash
npm install
cp .env.example .env        # fill SUPABASE_URL / SUPABASE_ANON_KEY (see docs/SETUP.md)
npm run dev                 # http://localhost:3000
```

No Supabase project yet? Everything except a live login works offline: `npm test` and `npm run test:e2e` run
against an in-process Postgres + auth stub that executes the real migrations.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Build web, run API + static site with reload |
| `npm run check` | lint + typecheck + all tests + production build |
| `npm test` | Vitest: `tests/unit`, `tests/api`, `tests/db` |
| `npm run test:e2e` | Playwright (needs `npx playwright install chromium` once) |
| `npm run build` | typecheck, bundle `web/` → `public/`, scan bundle for secrets |

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_ANON_KEY` | yes | Public anon key; used server-side only |
| `APP_URL` | prod | Public origin; must be `https://` in production |
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | no | defaults: development, 3000, info |
| `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_AUTH_MAX` | no | 60 / 120 / 10 |
| `SESSION_DAYS` | no | Refresh-cookie lifetime, default 14 |

Invalid or missing values stop startup with a list of problems (`src/lib/env.ts`).

## Migrations

SQL files in `supabase/migrations/` (timestamp-ordered, idempotent). Apply with `supabase db push` (linked project)
or `supabase db reset` (local). Add new changes as new files; never edit applied ones. See docs/SETUP.md.

## Deployment (Vercel)

`vercel.json` sets the build, static output (`public/`), `/api/*` → `api/index.ts`, and security headers (CSP etc.).
Set the env vars above in the Vercel project, then deploy. Full steps: docs/SETUP.md.

## Phase 2: properties and tenancies

Data model, permissions, status rules and storage design: **docs/DATA_MODEL.md**.
Pages (hash-routed in `app.html`): Overview, Properties (+ detail), Units (+ detail), Tenants (+ profile),
Tenancies (+ detail), Lease detail with private documents. All lists support search, filters, sorting and pagination.

## Phase 3: rent ledger

Recurring rent schedules, idempotent charge generation, manual payments with allocation, partial/advance payments and
arrears, reversals, adjustments, expenses, printable receipts, per-property performance, an audit history and a
reconciliation check. Balances are **derived** from immutable ledger rows. Approach, definitions, concurrency design and
limits: **docs/FINANCE.md**. Payments are manual and clearly not bank-verified.

`npm run test:db` includes `tests/db/concurrency.test.ts`, which starts a real PostgreSQL server (embedded binary,
downloaded by `npm install`) to prove behaviour under parallel connections.

## Phase 4: maintenance, notifications, approvals

Maintenance requests and work orders with an enforced lifecycle, critical-issue escalation to a human, a verified tenant portal, a durable email queue with retries,
idempotent reminder jobs, and a reusable approval engine with an inbox. Design, rules and limits: **docs/OPERATIONS.md**.
Scheduled jobs need `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` (server-side only), see `.env.example`.

## Phase 5: AI copilot

A dashboard copilot that answers from live records and prepares work for people to confirm or managers to approve. Works with no key
(rules mode) or with Claude via `LLM_PROVIDER=anthropic`. The model can only call a fixed set of validated tools; the application and the
database decide what is allowed. Design, security model, limits and configuration: **docs/COPILOT.md**.

## Phase 6: WhatsApp tenant assistant

Official Meta WhatsApp Cloud API: signed webhook → durable inbox → conversation engine (FAQs, maintenance intake, status, handoffs) with
verified identity linking, consent/opt-out, template and 24-hour-window rules, delivery tracking, and approval-gated reminders.
**Not yet verified against Meta**; see **docs/WHATSAPP.md** (design, security model, prerequisites, sandbox test workflow, verification log).

## Phase 7: plans, entitlements and African markets

Database-enforced plan limits (properties, units, seats, storage, AI requests, WhatsApp conversations, exports), subscription lifecycle,
a billing-provider adapter (Paystack; **integration pending live verification**), and country/currency/time-zone/phone settings for GHS, NGN and KES.
No legal or tenancy rules are built in. See **docs/BILLING.md** and **docs/MARKETS.md**.

## Known limitations (Phases 1–4)

* Rate limiting is in-memory per function instance (best-effort). Move to a shared store before relying on it.
* Invitation emails are not sent; admins copy the single-use link. Supabase handles confirmation/recovery emails.
* Lease-document uploads go browser → Supabase Storage via signed URL, so the CSP `connect-src` allows `https://*.supabase.co`
  (`vercel.json`). A custom Supabase domain needs that entry changed.
* Storage objects are never physically deleted: "deleting" a document archives its record. A purge job is future work.
* Uploads that are registered but never confirmed stay `pending` (invisible, unusable); a cleanup job is future work.
* Pickers (unit/tenant selects) load the first 100 records; type-ahead is needed for larger portfolios.
* Amounts are stored as integer minor units; Intl decides decimals per currency. No FX or rent-payment ledger yet.
* Rent charges are generated by a button/endpoint, not on a timer. Payments are manual and unverified. No FX, proration or late fees.
