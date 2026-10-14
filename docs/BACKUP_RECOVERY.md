# Backup and recovery

## Objectives (decided before launch; revisit quarterly)

The data is financial (rent ledgers, payments, receipts) and operational (maintenance, approvals, messages). Losing a day of payments or approvals is not acceptable; a few minutes is.

| Objective | Target | Why | What it requires |
|---|---|---|---|
| **RPO** (data we can lose) | **≤ 15 minutes** | A day of recorded payments cannot be re-keyed reliably; tenants and staff would disagree about what was paid | **Point-in-time recovery** on the production database (continuous WAL archiving), not just daily snapshots |
| **RTO** (time to be back) | **≤ 4 hours** to a verified, serving database | Rent and maintenance can wait hours, not days; staff have manual fallbacks (the app is not the only record of tenancies) | A rehearsed procedure and a person who can run it (two named people, see below) |
| Independent copy | nightly encrypted logical dump held **outside** the database provider's account | Protects against account/provider failure, mistaken deletion of the project, and ransomware-style credential abuse | `.github/workflows/backup.yml` + an object store with versioning, retention 35 days |

> **Launch gate:** Supabase *daily backups only* means an RPO of up to 24 hours. That does **not** meet the target. Enable PITR (a paid add-on on Pro plans at the time of writing; confirm current plan features in the Supabase dashboard) before production data is entered, or consciously accept and document a worse RPO. The nightly logical dump alone is also an RPO of up to 24 hours: it is a second line of defence, not the first.

## What is protected, and by what

| Asset | Mechanism | Notes |
|---|---|---|
| Postgres (all tenant data, ledger, audit, queues) | Supabase PITR + nightly encrypted `pg_dump` | The ledger tables are append-only with an audit trail; the cached balances are reconstructible from them (`reconcile_finance` proves it) |
| Uploaded files (lease documents, maintenance photos) | Supabase Storage: **not** covered by database backups | Replicate the buckets nightly to the same object store (`aws s3 sync` / `rclone`) or accept loss of files; metadata rows survive in Postgres. Open item for launch: add this job and rehearse it |
| Configuration and secrets | Vercel project settings, GitHub secrets, password manager | Keep an offline, access-controlled inventory of *which* secrets exist and where (not their values); the recovery procedure must be runnable by someone who has to re-create every secret |
| Code and migrations | Git (GitHub) | The database can be rebuilt from migrations, but that gives an *empty* schema, not data |
| WhatsApp / billing provider state | the providers | Webhook events are replayable from the provider dashboards (Meta, Paystack) for a few days; the inbox/dedupe tables make replays safe |

## Recovering from the common failures

**A. A bad change or deletion (the usual case): point-in-time recovery**
1. Decide the **target time**: the last moment the data was known good. Put the app in read-only mode if you can (disable the WhatsApp channel, set `LLM_PROVIDER` off, pause the scheduler workflow) so nothing new is written while you work.
2. In the Supabase dashboard, restore to that time. Prefer restoring into a **new project** first when the dashboard offers it, verify there, then cut over (change `SUPABASE_URL`/keys in Vercel, update Auth URLs, Storage, Meta/Paystack webhook URLs only if the project URL is part of them: it is not, they point at the app). If the only option is restore-in-place, first take a fresh logical dump of the damaged state for forensics.
3. **Verify** (acceptance criteria below). 4. Re-enable integrations. 5. Reconcile what happened between the target time and the incident: tenants' payments recorded that day, emails sent, WhatsApp messages (the provider keeps delivery history), approvals executed. Communicate the gap to affected customers.

**B. Provider/account loss, or PITR unavailable: restore from the nightly dump**
1. Create a new Supabase project; apply migrations (`supabase db push`) to get the schema, roles and policies; then `pg_restore --data-only --disable-triggers` from the decrypted dump (or restore the full dump into an empty project; test which your Supabase tier permits **during the rehearsal**, not during the incident).
2. Decrypt with the offline `age` private key (held by the two named restorers).
3. Verify, then repoint the app.

**C. Application bug that corrupted data but not the database:** use the audit tables (`finance_audit`, `subscription_events`, `approval_events`, `copilot_tool_calls`, `whatsapp_messages`) to see what changed; correct with *new* ledger entries (reversals/adjustments), never by editing history.

**Lesson from the drill (write it on the runbook):** a restore replaying WAL refuses to start if its `max_connections` (and similar capacity settings) are lower than the source's ("recovery aborted because of insufficient parameter settings"). Restore with settings at least as large as production. Also: the data directory must be mode 0700 and owned by the server user.

## Acceptance criteria for any restore (run `scripts/verify-restore.mjs` against the restored database)
1. Row counts for every business table are within the expected range for the target time; no table is empty that should not be.
2. `reconcile_finance` returns `ok: true` for **every** organization (ledger invariants and the cached balances).
3. Policies and functions are present (counts equal to the source); anonymous and signed-in roles still cannot read across organizations.
4. A real user can sign in and see their own organization; a user of another organization sees none of it.
5. The scheduler runs (`/api/internal/jobs/run`) and `/api/internal/health` returns 200.

## Rehearsals

| What | When | Result |
|---|---|---|
| Base backup + WAL archive + **point-in-time recovery into a new server**, destructive accident, fingerprint comparison, reconciliation, RLS checks (`scripts/restore-drill.ts`, also run in CI) | every release (CI) | **Passed.** Latest numbers: `docs/RESTORE_DRILL_RESULTS.md` |
| Supabase PITR restore in the real staging project (dashboard) | **before launch, then every 6 months** | **NOT DONE YET.** Fill in below |
| Restore from the nightly encrypted dump into a fresh project | **before launch, then every 6 months** | **NOT DONE YET** (the workflow is written but untested: `pg_dump` is not available in the environment this was built in) |
| Storage bucket restore | before launch | **NOT DONE YET** (the replication job does not exist yet) |

**Honesty note.** The drill proves our procedure and our verification on a real PostgreSQL server using the same physical-backup-plus-WAL mechanism managed PITR uses. It does **not** prove Supabase's managed service, the encrypted-dump workflow, or storage recovery. Do not mark backups verified until the three "NOT DONE" rows have a dated entry.

### Rehearsal log (fill in)
| Date | Exercise | Who | Target time → restored | Measured RTO | Verification criteria 1–5 | Problems found |
|---|---|---|---|---|---|---|
| | | | | | | |

## People and access
Two named people can perform a restore (primary, backup). Each has: Supabase owner access, the `age` private key (stored offline, e.g. password-manager emergency kit + one hardware token), access to the backup bucket, and this document. Test that access at each rehearsal; the failure mode of backups is usually "nobody can open them".

## Retention and privacy
Nightly dumps: 35 days, versioned bucket, encrypted with `age` before upload, bucket private, access logged. Deleted customer data persists in backups until they expire: state that in the privacy notice. A deletion request for a person is applied to live data immediately and to backups by expiry; if you restore, re-apply deletions made since (keep a deletion log).
