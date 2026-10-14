# Backup and restore drill: results

Run: 2026-10-14T16:39:29.833Z · PostgreSQL 18.4 (embedded) · darwin/arm64

Method: continuous WAL archiving + a base backup taken while the database was live, then point-in-time recovery into a new server. Data directory 69.3 MB · 5 organizations · 2145 charges · 922 payments · WAL archive 64.0 MB (5 segments).

Scenario: backup → 65 more business operations → record a target time and a fingerprint → run a destructive script (tenant contact details wiped, notifications deleted, charges overwritten) → destroy the server → restore to the target time.

| Step | ms | note |
|---|---:|---|
| base backup (pg_backup_start → file copy → pg_backup_stop, live database) | 1570 | 37.5 MB copied |
| restore: copy base backup into a new data directory | 366 |  |
| restore: start server and replay WAL to the target time (PITR) | 302 |  |
| TOTAL time from "primary is gone" to "restored server accepting queries" | 702 |  |

## Verification

```
PASS  every row count and money total equals the fingerprint taken just before the accident (2145 charges, 922 payments, 915 notifications)
PASS  work done AFTER the base backup but BEFORE the target time was recovered (WAL replay) (305 requests)
PASS  the accident is gone: tenant contact details, notifications and charge descriptions are intact
PASS  policies and functions came back (row level security definitions, SECURITY DEFINER API) (64 policies, 342 functions)
PASS  finance reconciliation (every ledger invariant) passes on the restored data ({"ok":true,"checks":[{"ok":true,"name":"No payment is allocated beyond its amoun)
PASS  a real user can sign in and read their organization through row level security (4 properties visible)
PASS  another organization's user still sees nothing of it
```

**Measured recovery time for this data size: 0.7 s. Recovery point: any chosen instant covered by archived WAL (here, the second chosen before the accident).**

This proves the procedure and the verification script. It does **not** prove Supabase's managed backups, which must be exercised separately (see docs/BACKUP_RECOVERY.md). The embedded server is local and small: production RTO scales with database size and network.
