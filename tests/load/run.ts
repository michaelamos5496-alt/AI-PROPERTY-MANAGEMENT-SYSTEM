import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { startPostgres } from '../support/pg.js';
import { key } from '../support/fixtures.js';
import { SCALES, rpc, seedVolume, type OrgSeed } from './volume.js';

/**
 * Database load test on a REAL PostgreSQL server (embedded, PG 18), with migrations applied and realistic volumes.
 * It measures the database functions the API calls, under concurrency, as the signed-in role with RLS on.
 * It does NOT include PostgREST, the network, Vercel cold starts or Supabase's hardware: treat the numbers as "does a query get slow as data grows",
 * not as production latency.     Usage:  npx tsx tests/load/run.ts [smoke|standard] [--report docs/LOAD_TEST_RESULTS.md]
 */
const scaleName = process.argv[2] === 'smoke' ? 'smoke' : 'standard';
const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
const s = SCALES[scaleName]!;
const pct = (a: number[], p: number) => { const x = [...a].sort((m, n) => m - n); return x.length ? x[Math.min(x.length - 1, Math.floor((p / 100) * x.length))]! : 0; };
const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const pg = await startPostgres();
const out: string[] = [];
const fail: string[] = [];
try {
  log(`PostgreSQL ${await pg.version()} · scale ${scaleName}`);
  const orgs = await seedVolume(pg, s, log);
  const q = async (sql: string) => (await pg.admin.query(sql)).rows;
  await pg.admin.query('analyze');
  await pg.admin.query('checkpoint');                 // do not let the seeding's checkpoint land in the middle of the measurement
  const counts = (await q(`select (select count(*) from public.units) units, (select count(*) from public.tenancies) tenancies, (select count(*) from public.charges) charges, (select count(*) from public.payments) payments,
    (select count(*) from public.payment_allocations) allocations, (select count(*) from public.maintenance_requests) requests, (select count(*) from public.notifications) notifications, (select count(*) from public.email_queue) emails,
    pg_size_pretty(pg_database_size(current_database())) size`))[0];
  log(`data: ${JSON.stringify(counts)}`);
  const big = orgs[0]!;

  // ---------------------------------------------------------------- read mix
  type Op = { name: string; w: number; run: (o: OrgSeed) => Promise<unknown> };
  const as = (o: OrgSeed) => rnd([o.manager, o.staff, o.admin, o.owner]);
  const ops: Op[] = [
    { name: 'list_properties', w: 8, run: (o) => rpc(pg, as(o), 'list_properties', { p_org: o.id }) },
    { name: 'list_units (page, search)', w: 12, run: (o) => rpc(pg, as(o), 'list_units', { p_org: o.id, p_search: `U${1 + Math.floor(Math.random() * 40)}`, p_limit: 25 }) },
    { name: 'list_tenancies', w: 10, run: (o) => rpc(pg, as(o), 'list_tenancies', { p_org: o.id, p_limit: 25 }) },
    { name: 'list_charges (page, overdue)', w: 14, run: (o) => rpc(pg, as(o), 'list_charges', { p_org: o.id, p_status: 'overdue', p_limit: 25 }) },
    { name: 'list_charges (by tenancy)', w: 8, run: (o) => rpc(pg, as(o), 'list_charges', { p_org: o.id, p_tenancy: rnd(o.tenancies), p_limit: 25 }) },
    { name: 'get_tenancy_ledger', w: 10, run: (o) => rpc(pg, as(o), 'get_tenancy_ledger', { p_org: o.id, p_tenancy: rnd(o.tenancies) }) },
    { name: 'list_payments', w: 6, run: (o) => rpc(pg, as(o), 'list_payments', { p_org: o.id, p_limit: 25 }) },
    { name: 'list_tenant_balances', w: 4, run: (o) => rpc(pg, as(o), 'list_tenant_balances', { p_org: o.id, p_limit: 25 }) },
    { name: 'property_performance (report)', w: 3, run: (o) => rpc(pg, as(o), 'property_performance', { p_org: o.id, p_from: '2026-01-01', p_to: '2026-12-31', p_property: null, p_currency: null }) },
    { name: 'list_requests (unresolved)', w: 10, run: (o) => rpc(pg, as(o), 'list_requests', { p_org: o.id, p_limit: 25 }) },
    { name: 'list_approvals (inbox)', w: 4, run: (o) => rpc(pg, o.manager, 'list_approvals', { p_org: o.id, p_scope: 'inbox' }) },
    { name: 'list_my_notifications', w: 6, run: (o) => rpc(pg, as(o), 'list_my_notifications', { p_unread_only: true, p_limit: 30, p_offset: 0 }) },
    { name: 'get_entitlements', w: 3, run: (o) => rpc(pg, as(o), 'get_entitlements', { p_org: o.id }) },
    { name: 'copilot_overdue_rent (AI tool)', w: 3, run: (o) => rpc(pg, as(o), 'copilot_overdue_rent', { p_org: o.id, p_property: null, p_min_days: 1, p_limit: 25 }) },
    { name: 'copilot_rent_collection_summary (AI tool)', w: 2, run: (o) => rpc(pg, as(o), 'copilot_rent_collection_summary', { p_org: o.id, p_from: null, p_to: null, p_property: null }) },
  ];
  type Stats = Map<string, { ms: number[]; errors: number }>;
  let stats: Stats = new Map();
  const total = ops.reduce((a, o) => a + o.w, 0);
  const pick = () => { let r = Math.random() * total; for (const o of ops) if ((r -= o.w) <= 0) return o; return ops[0]!; };
  const phase = async (label: string, seconds: number, workers: number, pickOp: () => Op, pickOrg: () => OrgSeed, thinkMs: [number, number] = [0, 0], rampMs = 0) => {
    log(`${label}: ${workers} concurrent users for ${seconds}s`);
    const end = Date.now() + (seconds * 1000) + rampMs; let n = 0; const t0 = Date.now(); const measureFrom = t0 + rampMs;
    await Promise.all(Array.from({ length: workers }, async () => {
      // people arrive over a few seconds rather than all in the same millisecond; the ramp itself is not measured
      if (rampMs) await new Promise((r) => setTimeout(r, Math.random() * rampMs));
      while (Date.now() < end) {
        const op = pickOp(); const st = stats.get(op.name) ?? { ms: [], errors: 0 }; stats.set(op.name, st);
        const t = performance.now();
        try { await op.run(pickOrg()); if (Date.now() >= measureFrom) st.ms.push(performance.now() - t); } catch (e) { st.errors++; if (st.errors < 3) console.log(`  ! ${op.name}: ${(e as Error).message}`); }
        n++;
        if (thinkMs[1]) await new Promise((r) => setTimeout(r, thinkMs[0] + Math.random() * (thinkMs[1] - thinkMs[0])));
      }
    }));
    return { n, rps: n / ((Date.now() - t0) / 1000) };
  };
  const mixOrg = () => (Math.random() < 0.6 ? big : rnd(orgs));
  const writes: Op[] = [
    { name: 'W create_maintenance_request', w: 4, run: (o) => rpc(pg, o.staff, 'create_maintenance_request', { p_org: o.id, p_property: rnd(o.properties), p_unit: null, p_tenancy: null, p_title: 'Load test request', p_description: 'created by the load test', p_category: 'other', p_urgency: null }) },
    { name: 'W record_payment (+auto-allocate)', w: 3, run: (o) => rpc(pg, o.staff, 'record_payment', { p_org: o.id, p_tenancy: rnd(o.tenancies), p_amount_minor: 5000, p_received_on: '2026-10-01', p_method: 'cash', p_reference: `LT-${key().slice(0, 8)}`, p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: key(), p_auto_allocate: true }) },
    { name: 'W create_charge', w: 2, run: (o) => rpc(pg, o.manager, 'create_charge', { p_org: o.id, p_tenancy: rnd(o.tenancies), p_kind: 'fee', p_description: 'Load fee', p_due_date: '2026-10-05', p_amount_minor: 1000, p_idempotency_key: key() }) },
  ];
  // Realistic: 60 people with think time (each acts every 1–3 s while "active"), a mix of reads and writes at once. This phase is what the thresholds judge.
  const SECS = scaleName === 'smoke' ? 5 : 45;
  const both: Op[] = [...ops, ...writes];
  const bothTotal = both.reduce((a, o) => a + o.w, 0);
  const pickBoth = () => { let r = Math.random() * bothTotal; for (const o of both) if ((r -= o.w) <= 0) return o; return both[0]!; };
  const realistic = await phase('realistic: 60 active users with think time, reads and writes together', SECS, scaleName === 'smoke' ? 10 : 60, pickBoth, mixOrg, [1000, 3000], 6000);
  const realisticStats = stats; stats = new Map();
  // Saturation: 20 users with NO think time, reads only. Informational: it shows where the server stops keeping up, not what people will feel.
  const stress = await phase('saturation: 20 users hammering reads with no pause', SECS, 20, pick, mixOrg);
  const stressStats = stats; stats = realisticStats;
  const reads = realistic; const mixed = stress;
  // ------------------------------------------------------- background work at volume
  const timed = async (label: string, fn: () => Promise<unknown>) => { const t = performance.now(); const r = await fn(); const ms = Math.round(performance.now() - t); log(`${label}: ${ms} ms`); return { label, ms, r }; };
  const bg: { label: string; ms: number }[] = [];
  bg.push(await timed('job_run_all (reminders, expiry, escalation follow-ups for ALL orgs)', () => pg.svcCall('job_run_all')));
  bg.push(await timed('billing_svc_tick', () => pg.svcCall('billing_svc_tick')));
  await pg.admin.query(`insert into public.whatsapp_channels (org_id, phone_number_id, enabled, intake_user_id) values ($1, '999000111', true, $2)`, [big.id, big.manager.sub]);
  await pg.admin.query(`insert into public.whatsapp_events (org_id, phone_number_id, kind, provider_id, contact_key, payload) select $1, '999000111', 'message', 'lt-' || g, '2335' || (g % 3000), '{}' from generate_series(1, 20000) g`, [big.id]);
  bg.push(await timed('wa_svc_claim_events (20,000 queued, 50 per claim)', async () => { for (let i = 0; i < 20; i++) await pg.svcCall('wa_svc_claim_events', { p_worker: `w${i}`, p_limit: 50, p_lease_seconds: 60 }); }));
  bg.push(await timed('claim_emails (batch of 20, repeated 20×)', async () => { for (let i = 0; i < 20; i++) await pg.svcCall('claim_emails', { p_worker: `e${i}`, p_limit: 20, p_lease_seconds: 60 }); }));
  bg.push(await timed('reconcile_finance (largest organization: every ledger invariant)', () => rpc(pg, big.owner, 'reconcile_finance', { p_org: big.id })));

  // -------------------------------------------------------------------- plans
  const hot = [
    ['list_charges overdue (large org)', `select * from app.charge_state cs where cs.org_id = '${big.id}' and cs.is_overdue order by cs.due_date desc limit 25`],
    ['tenancy ledger charges', `select * from app.charge_state cs where cs.tenancy_id = '${big.tenancies[0]}'`],
    ['unresolved requests', `select * from public.maintenance_requests where org_id = '${big.id}' and status not in ('resolved','cancelled') order by created_at desc limit 25`],
    ['unread notifications', `select * from public.notifications where user_id = '${big.manager.sub}' and read_at is null order by created_at desc limit 30`],
    ['pending emails', `select id from public.email_queue where status = 'queued' and next_attempt_at <= now() order by created_at limit 20 for update skip locked`],
    ['wa events ready', `select id from public.whatsapp_events where status in ('pending','failed') and next_attempt_at <= now() order by id limit 50`],
  ] as const;
  const plans: { name: string; seq: string[]; ms: number }[] = [];
  for (const [name, sql] of hot) {
    const c = await pg.pool.connect();
    try {
      await c.query('begin'); const r = await c.query(`explain (analyze, buffers, format json) ${sql}`); await c.query('rollback');
      const plan = r.rows[0]['QUERY PLAN'][0]; const text = JSON.stringify(plan.Plan);
      const seq = [...text.matchAll(/"Node Type":"Seq Scan"[^}]*?"Relation Name":"([a-z_]+)"/g)].map((m) => m[1]!);
      plans.push({ name, seq, ms: Math.round(plan['Execution Time'] * 100) / 100 });
    } finally { c.release(); }
  }
  const unusedIdx = await q(`select relname, indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) size from pg_stat_user_indexes where idx_scan = 0 and schemaname = 'public' and pg_relation_size(indexrelid) > 262144 order by pg_relation_size(indexrelid) desc limit 8`);
  const seqHeavy = await q(`select relname, seq_scan, seq_tup_read, n_live_tup from pg_stat_user_tables where schemaname = 'public' and n_live_tup > 5000 and seq_scan > 50 order by seq_tup_read desc limit 6`);

  // ------------------------------------------------------------------- report
  const toRows = (m: Stats) => [...m.entries()].map(([name, st]) => ({ name, n: st.ms.length, errors: st.errors, p50: pct(st.ms, 50), p95: pct(st.ms, 95), p99: pct(st.ms, 99), max: Math.max(0, ...st.ms) })).sort((a, b) => b.p95 - a.p95);
  const rows = toRows(realisticStats); const stressRows = toRows(stressStats);
  const f = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
  out.push(`# Database load test results`, '', `Run: ${new Date().toISOString()} · scale **${scaleName}** · PostgreSQL ${await pg.version()} (embedded, local, \`fsync=off\`) · ${process.platform}/${process.arch}`, '',
    '> **What this is:** the database functions the API calls, on a real PostgreSQL server with the real migrations, RLS on, as the signed-in role, at realistic volume and concurrency.',
    '> **What it is not:** PostgREST, the network, Vercel cold starts, or Supabase hardware. Use it to catch slow queries and growth problems; confirm production latency in staging with the same data volume.', '',
    `## Data`, '', '```', JSON.stringify(counts, null, 1), '```', '', `Organizations: ${orgs.length} (one with ${big.units.length} units, ${big.tenancies.length} tenancies, ${s.months} months of rent history; the rest small).`, '',
    `## Realistic load: 60 active users with think time, reads and writes together (${reads.n} requests, ${reads.rps.toFixed(0)}/s)`, '',
    'This is the phase the thresholds judge. Each simulated person acts every 1–3 seconds; 60 of them active at once is far more than a 1,500-unit portfolio\'s staff plus its tenants will produce at any moment.', '',
    '| Operation | calls | errors | p50 ms | p95 ms | p99 ms | max ms |', '|---|---:|---:|---:|---:|---:|---:|', ...rows.map((r) => `| ${r.name} | ${r.n} | ${r.errors} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} |`), '',
    `## Saturation: 20 users with no pause, reads only (${mixed.n} requests, ${mixed.rps.toFixed(0)}/s)`, '', 'Informational: where the server stops keeping up (a CPU-bound single instance). Not judged.', '',
    '| Operation | calls | errors | p50 ms | p95 ms | p99 ms |', '|---|---:|---:|---:|---:|---:|', ...stressRows.map((r) => `| ${r.name} | ${r.n} | ${r.errors} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} |`), '',
    '## Background work at volume', '', '| Job | ms |', '|---|---:|', ...bg.map((b) => `| ${b.label} | ${b.ms} |`), '',
    '## Query plans for the hottest queries (EXPLAIN ANALYZE)', '', '| Query | execution ms | sequential scans |', '|---|---:|---|', ...plans.map((p) => `| ${p.name} | ${p.ms} | ${p.seq.length ? p.seq.join(', ') : 'none'} |`), '',
    '## Monitoring queries to run in production (pg_stat_statements is available on Supabase)', '', '```sql', 'select query, calls, mean_exec_time, total_exec_time from pg_stat_statements order by total_exec_time desc limit 20;', 'select relname, seq_scan, seq_tup_read, n_live_tup from pg_stat_user_tables where n_live_tup > 5000 order by seq_tup_read desc limit 10;', 'select indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) from pg_stat_user_indexes where idx_scan = 0 order by pg_relation_size(indexrelid) desc;', '```', '',
    `Tables read sequentially often at this size: ${seqHeavy.map((r) => `${r.relname} (${r.seq_scan} scans)`).join(', ') || 'none'}.`, '', `Largest unused indexes during this run (workload-specific; do not drop on this evidence alone): ${unusedIdx.map((r) => `${r.indexrelname} (${r.size})`).join(', ') || 'none'}.`, '');

  // Page loads must feel instant; reports and AI lookups are allowed to be slower. All figures are at 20 concurrent users on one laptop-class server.
  const HEAVY = /property_performance|copilot_|list_tenant_balances/;
  const LIMIT_PAGE = scaleName === 'smoke' ? 2000 : 750; const LIMIT_HEAVY = scaleName === 'smoke' ? 4000 : 1500;
  for (const r of rows) { if (r.errors) fail.push(`${r.name}: ${r.errors} errors`); const lim = HEAVY.test(r.name) ? LIMIT_HEAVY : LIMIT_PAGE; if (r.p95 > lim) fail.push(`${r.name}: p95 ${f(r.p95)} ms exceeds ${lim} ms`); }
  // queries that must be served from an index no matter how big the tables get (the others legitimately read most of a table: org-wide totals, or a queue that is mostly unprocessed in this synthetic run)
  const MUST_INDEX = ['tenancy ledger charges', 'unread notifications', 'wa events ready'];
  for (const p of plans) if (MUST_INDEX.includes(p.name) && p.seq.length && scaleName === 'standard') fail.push(`plan "${p.name}" reads ${p.seq.join(', ')} sequentially`);
  for (const b of bg) if (scaleName === 'standard' && b.ms > (b.label.startsWith('job_run_all') ? 60_000 : 30_000)) fail.push(`${b.label}: ${b.ms} ms`);
  out.push(`## Verdict`, '', fail.length ? `**FAILED**: ${fail.map((x) => `\n- ${x}`).join('')}` : `All thresholds met (page loads p95 ≤ ${LIMIT_PAGE} ms, reports and AI lookups p95 ≤ ${LIMIT_HEAVY} ms, no errors, indexed access on the must-be-indexed queries, background jobs within budget).`, '');
  console.log(out.join('\n'));
  if (reportPath) { mkdirSync(new URL('.', `file://${process.cwd()}/${reportPath}`).pathname, { recursive: true }); writeFileSync(reportPath, out.join('\n')); log(`report written to ${reportPath}`); }
} finally { await pg.stop(); }
process.exit(fail.length ? 1 : 0);
