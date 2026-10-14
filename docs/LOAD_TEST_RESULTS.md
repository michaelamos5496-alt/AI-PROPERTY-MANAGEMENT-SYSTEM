# Database load test results

Run: 2026-10-14T16:36:50.405Z · scale **standard** · PostgreSQL 18.4 (embedded, local, `fsync=off`) · darwin/arm64

> **What this is:** the database functions the API calls, on a real PostgreSQL server with the real migrations, RLS on, as the signed-in role, at realistic volume and concurrency.
> **What it is not:** PostgREST, the network, Vercel cold starts, or Supabase hardware. Use it to catch slow queries and growth problems; confirm production latency in staging with the same data volume.

## Data

```
{
 "units": "2640",
 "tenancies": "2440",
 "charges": "61000",
 "payments": "13116",
 "allocations": "25677",
 "requests": "4020",
 "notifications": "12060",
 "emails": "12060",
 "size": "104 MB"
}
```

Organizations: 20 (one with 1500 units, 1395 tenancies, 24 months of rent history; the rest small).

## Realistic load: 60 active users with think time, reads and writes together (1461 requests, 27/s)

This is the phase the thresholds judge. Each simulated person acts every 1–3 seconds; 60 of them active at once is far more than a 1,500-unit portfolio's staff plus its tenants will produce at any moment.

| Operation | calls | errors | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|---:|
| copilot_overdue_rent (AI tool) | 29 | 0 | 149 | 220 | 246 | 246 |
| list_charges (page, overdue) | 161 | 0 | 117 | 134 | 153 | 158 |
| list_tenant_balances | 56 | 0 | 92.8 | 101 | 109 | 109 |
| property_performance (report) | 38 | 0 | 34.6 | 63.9 | 68.9 | 68.9 |
| list_payments | 88 | 0 | 46.0 | 60.6 | 72.0 | 72.0 |
| list_properties | 87 | 0 | 24.3 | 40.5 | 45.5 | 45.5 |
| copilot_rent_collection_summary (AI tool) | 27 | 0 | 14.8 | 24.0 | 26.4 | 26.4 |
| list_requests (unresolved) | 130 | 0 | 10.0 | 18.8 | 23.6 | 26.3 |
| list_tenancies | 115 | 0 | 6.3 | 12.7 | 15.9 | 16.9 |
| W record_payment (+auto-allocate) | 41 | 0 | 4.8 | 12.6 | 53.7 | 53.7 |
| list_units (page, search) | 143 | 0 | 4.0 | 10.9 | 17.6 | 17.9 |
| W create_maintenance_request | 31 | 0 | 3.5 | 10.0 | 13.3 | 13.3 |
| W create_charge | 27 | 0 | 3.0 | 7.6 | 8.2 | 8.2 |
| get_entitlements | 35 | 0 | 2.5 | 6.6 | 7.2 | 7.2 |
| list_charges (by tenancy) | 116 | 0 | 2.8 | 6.2 | 8.5 | 9.4 |
| get_tenancy_ledger | 108 | 0 | 2.5 | 6.2 | 9.9 | 14.9 |
| list_my_notifications | 63 | 0 | 1.8 | 4.8 | 36.4 | 36.4 |
| list_approvals (inbox) | 38 | 0 | 1.4 | 3.8 | 7.1 | 7.1 |

## Saturation: 20 users with no pause, reads only (7011 requests, 153/s)

Informational: where the server stops keeping up (a CPU-bound single instance). Not judged.

| Operation | calls | errors | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| copilot_overdue_rent (AI tool) | 225 | 0 | 835 | 1135 | 3013 |
| list_charges (page, overdue) | 900 | 0 | 592 | 678 | 1060 |
| list_tenant_balances | 289 | 0 | 483 | 569 | 760 |
| property_performance (report) | 177 | 0 | 227 | 350 | 2051 |
| list_payments | 415 | 0 | 263 | 327 | 459 |
| list_properties | 517 | 0 | 134 | 195 | 237 |
| copilot_rent_collection_summary (AI tool) | 149 | 0 | 67.3 | 119 | 147 |
| list_requests (unresolved) | 695 | 0 | 35.9 | 87.0 | 132 |
| list_tenancies | 676 | 0 | 11.1 | 60.1 | 86.1 |
| list_units (page, search) | 818 | 0 | 6.7 | 52.9 | 88.0 |
| get_entitlements | 241 | 0 | 4.0 | 26.6 | 48.0 |
| list_charges (by tenancy) | 546 | 0 | 4.5 | 19.4 | 49.3 |
| get_tenancy_ledger | 694 | 0 | 3.4 | 15.5 | 48.3 |
| list_my_notifications | 410 | 0 | 3.1 | 12.0 | 25.0 |
| list_approvals (inbox) | 259 | 0 | 1.6 | 10.5 | 22.2 |

## Background work at volume

| Job | ms |
|---|---:|
| job_run_all (reminders, expiry, escalation follow-ups for ALL orgs) | 648 |
| billing_svc_tick | 2 |
| wa_svc_claim_events (20,000 queued, 50 per claim) | 754 |
| claim_emails (batch of 20, repeated 20×) | 150 |
| reconcile_finance (largest organization: every ledger invariant) | 520 |

## Query plans for the hottest queries (EXPLAIN ANALYZE)

| Query | execution ms | sequential scans |
|---|---:|---|
| list_charges overdue (large org) | 39.18 | charges, tenancies, units, properties |
| tenancy ledger charges | 0.18 | none |
| unresolved requests | 1.17 | maintenance_requests |
| unread notifications | 0.08 | none |
| pending emails | 5.62 | email_queue |
| wa events ready | 3.03 | none |

## Monitoring queries to run in production (pg_stat_statements is available on Supabase)

```sql
select query, calls, mean_exec_time, total_exec_time from pg_stat_statements order by total_exec_time desc limit 20;
select relname, seq_scan, seq_tup_read, n_live_tup from pg_stat_user_tables where n_live_tup > 5000 order by seq_tup_read desc limit 10;
select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) from pg_stat_user_indexes where idx_scan = 0 order by pg_relation_size(indexrelid) desc;
```

Tables read sequentially often at this size: payment_allocations (13171 scans), charge_balances (1541 scans), charges (1069 scans), payments (568 scans).

Largest unused indexes during this run (workload-specific; do not drop on this evidence alone): finance_audit_entity_idx (1872 kB), finance_audit_time_idx (1832 kB), payment_allocations_org_id_id_key (1680 kB), whatsapp_events_kind_provider_id_key (1232 kB), payments_reference_idx (1184 kB), payment_allocations_pkey (1104 kB), finance_audit_pkey (976 kB), charge_balances_org_idx (848 kB).

## Verdict

All thresholds met (page loads p95 ≤ 750 ms, reports and AI lookups p95 ≤ 1500 ms, no errors, indexed access on the must-be-indexed queries, background jobs within budget).
