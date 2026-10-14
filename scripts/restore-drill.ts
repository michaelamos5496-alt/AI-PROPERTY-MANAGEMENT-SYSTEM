/**
 * Backup and restore drill on a real PostgreSQL server: base backup + continuous WAL archiving, a simulated accident, then
 * point-in-time recovery into a brand-new server, verified against a fingerprint of the data taken just before the accident.
 * This is the same mechanism a managed service uses for PITR (physical base backup + archived WAL); it proves the PROCEDURE and our
 * verification, not Supabase's service itself.
 *
 *   npx tsx scripts/restore-drill.ts [--report docs/RESTORE_DRILL_RESULTS.md]
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { startPostgres } from '../tests/support/pg.js';
import { SCALES, rpc, seedVolume } from '../tests/load/volume.js';

const free = () => new Promise<number>((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); s.on('error', rej); });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirSize = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const reportPath = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;

const root = mkdtempSync(join(tmpdir(), 'pai-drill-'));
const [primaryDir, archive, base, restoredDir] = ['primary', 'archive', 'base', 'restored'].map((d) => join(root, d)) as [string, string, string, string];
mkdirSync(archive);
const steps: { step: string; ms: number; note?: string }[] = [];
const time = async <T>(step: string, fn: () => Promise<T>, note?: (r: T) => string) => { const t = performance.now(); const r = await fn(); const ms = Math.round(performance.now() - t); steps.push({ step, ms, note: note?.(r) }); log(`${step}: ${ms} ms`); return r; };

const fingerprint = async (c: pg.Client | pg.Pool) => (await c.query(`select
  (select count(*) from public.organizations) orgs, (select count(*) from public.properties) properties, (select count(*) from public.units) units, (select count(*) from public.tenants) tenants,
  (select count(*) from public.tenancies) tenancies, (select count(*) from public.charges) charges, (select count(*) from public.payments) payments, (select count(*) from public.payment_allocations) allocations,
  (select count(*) from public.notifications) notifications, (select count(*) from public.maintenance_requests) requests,
  (select coalesce(sum(amount_minor), 0) from public.charges) charge_total, (select coalesce(sum(amount_minor), 0) from public.payments) payment_total,
  (select md5(string_agg(id::text, ',' order by id)) from public.charges) charge_ids, (select md5(string_agg(coalesce(email, '-') || coalesce(phone, '-'), ',' order by id)) from public.tenants) tenant_contact,
  (select count(*) from pg_policies where schemaname in ('public', 'storage')) policies, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app')) functions`)).rows[0];

const p2 = await free();
log(`work area ${root}`);
const primary = await startPostgres({ keep: true, dir: primaryDir, flags: ['-c', 'wal_level=replica', '-c', 'archive_mode=on', '-c', `archive_command=cp %p ${archive}/%f`, '-c', 'archive_timeout=5', '-c', 'fsync=on'] });
let restored: EmbeddedPostgres | null = null;
let ok = false; const results: string[] = [];
try {
  const pgVersion = await primary.version();
  log(`PostgreSQL ${pgVersion}`);
  const orgs = await seedVolume(primary, { ...SCALES.smoke!, orgs: 5, bigProperties: 4, bigUnitsPerProperty: 25, smallProperties: 2, smallUnitsPerProperty: 10, months: 12, paidMonths: 6, requestsPerOrgBig: 200, requestsPerOrgSmall: 20 }, log);
  const big = orgs[0]!;
  const dataBytes = dirSize(primaryDir);

  // 1. base backup while the database is live (low-level API: start → copy → stop)
  const client = new pg.Client({ host: '127.0.0.1', port: primary.port, user: 'postgres', password: 'pw', database: 'postgres' }); await client.connect();
  await time('base backup (pg_backup_start → file copy → pg_backup_stop, live database)', async () => {
    await client.query(`select pg_backup_start('restore-drill', true)`);
    cpSync(primaryDir, base, { recursive: true, filter: (src) => !/postmaster\.(pid|opts)$/.test(src) && !/\/pg_wal\/[0-9A-F]{24}/.test(src) && !/\/pg_wal\/archive_status\//.test(src) });
    const stop = await client.query(`select labelfile from pg_backup_stop(true)`);
    writeFileSync(join(base, 'backup_label'), stop.rows[0].labelfile);
    for (const d of ['pg_wal', 'pg_wal/archive_status']) mkdirSync(join(base, d), { recursive: true });
  }, () => `${mb(dirSize(base))} copied`);

  // 2. life goes on: more business after the backup, then the moment we want to get back to
  for (let i = 0; i < 40; i++) await rpc(primary, big.staff, 'record_payment', { p_org: big.id, p_tenancy: big.tenancies[i % big.tenancies.length], p_amount_minor: 12345, p_received_on: '2026-10-01', p_method: 'cash', p_reference: `DRILL-${i}`, p_note: null, p_tenant: null, p_currency: null, p_idempotency_key: crypto.randomUUID(), p_auto_allocate: true });
  for (let i = 0; i < 25; i++) await rpc(primary, big.staff, 'create_maintenance_request', { p_org: big.id, p_property: big.pairs[i]![0], p_unit: big.pairs[i]![1], p_tenancy: null, p_title: `After backup ${i}`, p_description: 'created after the base backup', p_category: 'other', p_urgency: null });
  await sleep(1500);
  const target = (await client.query(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') ts`)).rows[0].ts as string;
  const truth = await fingerprint(client);
  log(`recovery target ${target} UTC; truth: ${truth.payments} payments, ${truth.requests} requests`);
  await sleep(1500);

  // 3. the accident: a script run against the wrong database
  await client.query(`update public.tenants set email = null, phone = null`);
  await client.query(`delete from public.notifications`);
  await client.query(`alter table public.charges disable trigger user`); await client.query(`update public.charges set description = 'CORRUPTED'`); await client.query(`alter table public.charges enable trigger user`);
  const damaged = await fingerprint(client);
  log(`after the accident: ${damaged.notifications} notifications (was ${truth.notifications})`);
  await client.query(`select pg_switch_wal()`);
  for (let i = 0; i < 40; i++) { const a = await client.query(`select last_archived_wal, last_failed_wal from pg_stat_archiver`); if (a.rows[0].last_archived_wal && !(a.rows[0].last_failed_wal && a.rows[0].last_failed_wal > a.rows[0].last_archived_wal)) { await sleep(500); const b = await client.query(`select last_archived_wal from pg_stat_archiver`); if (b.rows[0].last_archived_wal === a.rows[0].last_archived_wal) break; } await sleep(500); }
  const archived = readdirSync(archive).length;
  await client.end(); await primary.stop();
  rmSync(primaryDir, { recursive: true, force: true });                   // the original server is gone
  log(`primary destroyed; ${archived} WAL segments in the archive (${mb(dirSize(archive))})`);

  // 4. restore into a new server, replaying archived WAL up to the target time
  const t0 = performance.now();
  await time('restore: copy base backup into a new data directory', async () => { cpSync(base, restoredDir, { recursive: true }); chmodSync(restoredDir, 0o700); });   // PostgreSQL refuses a data directory that others can read
  writeFileSync(join(restoredDir, 'recovery.signal'), '');
  appendFileSync(join(restoredDir, 'postgresql.auto.conf'), `\nrestore_command = 'cp ${archive}/%f %p'\nrecovery_target_time = '${target} UTC'\nrecovery_target_action = 'promote'\nrecovery_target_inclusive = true\n`);
  restored = new EmbeddedPostgres({ databaseDir: restoredDir, user: 'postgres', password: 'pw', port: p2, persistent: true, postgresFlags: ['-c', 'archive_mode=off', '-c', 'max_connections=200'], onLog: (m) => { if (process.env.DRILL_DEBUG) console.log('[pg]', String(m).trim()); }, onError: (m) => { if (process.env.DRILL_DEBUG) console.log('[pg:err]', String(m).trim()); } });
  await time('restore: start server and replay WAL to the target time (PITR)', async () => { await restored!.start(); });
  const c2 = new pg.Client({ host: '127.0.0.1', port: p2, user: 'postgres', password: 'pw', database: 'postgres' }); await c2.connect();
  for (let i = 0; i < 120; i++) { if (!(await c2.query('select pg_is_in_recovery() r')).rows[0].r) break; await sleep(500); }
  const rto = Math.round(performance.now() - t0);
  steps.push({ step: 'TOTAL time from "primary is gone" to "restored server accepting queries"', ms: rto });

  // 5. verify
  const got = await fingerprint(c2);
  const check = (name: string, pass: boolean, detail = '') => { results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); if (!pass) throw new Error(`verification failed: ${name}`); };
  check('every row count and money total equals the fingerprint taken just before the accident', JSON.stringify(got) === JSON.stringify(truth), `${got.charges} charges, ${got.payments} payments, ${got.notifications} notifications`);
  check('work done AFTER the base backup but BEFORE the target time was recovered (WAL replay)', got.payments === truth.payments && Number(got.payments) > Number(damaged.payments) - 1 && Number(got.requests) === Number(truth.requests), `${got.requests} requests`);
  check('the accident is gone: tenant contact details, notifications and charge descriptions are intact', Number((await c2.query(`select count(*) n from public.tenants where email is null`)).rows[0].n) === 0 && Number((await c2.query(`select count(*) n from public.charges where description = 'CORRUPTED'`)).rows[0].n) === 0 && got.notifications === truth.notifications);
  check('policies and functions came back (row level security definitions, SECURITY DEFINER API)', got.policies === truth.policies && got.functions === truth.functions, `${got.policies} policies, ${got.functions} functions`);
  const asUser = async (sub: string, email: string, sql: string) => { await c2.query('begin'); await c2.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, email, role: 'authenticated' })]); await c2.query('set local role authenticated'); try { return (await c2.query(sql)).rows; } finally { await c2.query('rollback'); } };
  const rec = await asUser(big.owner.sub, big.owner.email, `select public.reconcile_finance('${big.id}') r`);
  check('finance reconciliation (every ledger invariant) passes on the restored data', rec[0].r?.ok === true, JSON.stringify(rec[0].r).slice(0, 80));
  const mine = await asUser(big.manager.sub, big.manager.email, `select jsonb_array_length(public.list_properties('${big.id}'::uuid) -> 'items') n`);
  check('a real user can sign in and read their organization through row level security', Number(mine[0].n) > 0, `${mine[0].n} properties visible`);
  const other = orgs[1]!;
  const crossed = await asUser(other.manager.sub, other.manager.email, `select count(*) n from public.properties where org_id = '${big.id}'`);
  check("another organization's user still sees nothing of it", Number(crossed[0].n) === 0);
  await c2.end();
  const lines = ['# Backup and restore drill: results', '', `Run: ${new Date().toISOString()} · PostgreSQL ${pgVersion} (embedded) · ${process.platform}/${process.arch}`, '',
    `Method: continuous WAL archiving + a base backup taken while the database was live, then point-in-time recovery into a new server. Data directory ${mb(dataBytes)} · ${orgs.length} organizations · ${truth.charges} charges · ${truth.payments} payments · WAL archive ${mb(dirSize(archive))} (${archived} segments).`, '',
    'Scenario: backup → 65 more business operations → record a target time and a fingerprint → run a destructive script (tenant contact details wiped, notifications deleted, charges overwritten) → destroy the server → restore to the target time.', '',
    '| Step | ms | note |', '|---|---:|---|', ...steps.map((s) => `| ${s.step} | ${s.ms} | ${s.note ?? ''} |`), '', '## Verification', '', '```', ...results, '```', '',
    `**Measured recovery time for this data size: ${(rto / 1000).toFixed(1)} s. Recovery point: any chosen instant covered by archived WAL (here, the second chosen before the accident).**`, '',
    'This proves the procedure and the verification script. It does **not** prove Supabase\'s managed backups, which must be exercised separately (see docs/BACKUP_RECOVERY.md). The embedded server is local and small: production RTO scales with database size and network.'];
  if (reportPath) { writeFileSync(reportPath, lines.join('\n') + '\n'); log(`report written to ${reportPath}`); }
  console.log('\n' + lines.join('\n'));
  ok = true;
} catch (e) {
  console.error('DRILL FAILED:', (e as Error).message); console.log(results.join('\n'));
} finally {
  await restored?.stop().catch(() => {}); await primary.stop().catch(() => {});
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
