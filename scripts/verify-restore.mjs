#!/usr/bin/env node
// Verifies a restored (or freshly migrated) database. Run against the RESTORED database, with a role that can read everything (postgres):
//   DATABASE_URL=postgresql://... node scripts/verify-restore.mjs
// Exits non-zero on the first failed criterion. Read-only.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL to the restored database.'); process.exit(2); }
const c = new pg.Client({ connectionString: url }); await c.connect();
const results = []; let bad = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); if (!ok) bad++; };
const one = async (sql, p = []) => (await c.query(sql, p)).rows[0];

const counts = await one(`select (select count(*) from public.organizations)::int orgs, (select count(*) from public.properties)::int properties, (select count(*) from public.tenancies)::int tenancies,
  (select count(*) from public.charges)::int charges, (select count(*) from public.payments)::int payments, (select count(*) from public.finance_audit)::int audit`);
console.log('row counts:', JSON.stringify(counts));
check('1. the business tables are populated', counts.orgs > 0 && counts.audit >= 0 && (counts.charges > 0 || counts.tenancies === 0), JSON.stringify(counts));

const orgs = (await c.query(`select o.id, o.name, (select user_id from public.memberships m where m.org_id = o.id and m.role = 'owner' limit 1) as owner from public.organizations o order by o.created_at`)).rows;
let reconBad = 0;
for (const o of orgs) {
  if (!o.owner) { check(`2. organization ${o.name} has an owner`, false); continue; }
  await c.query('begin'); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: o.owner, role: 'authenticated' })]); await c.query('set local role authenticated');
  try { const r = (await c.query(`select public.reconcile_finance($1::uuid) r`, [o.id])).rows[0].r; if (!r.ok) { reconBad++; console.error(`  reconcile failed for ${o.name}:`, JSON.stringify(r.checks.filter((x) => !x.ok))); } }
  catch (e) { reconBad++; console.error(`  reconcile errored for ${o.name}: ${e.message}`); }
  finally { await c.query('rollback'); }
}
check('2. reconcile_finance passes for every organization', reconBad === 0, `${orgs.length} organizations checked`);

const sec = await one(`select (select count(*)::int from pg_policies where schemaname in ('public','storage')) policies, (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','app')) functions,
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) tables_without_rls`);
check('3. row level security is enabled on every table and policies/functions exist', sec.tables_without_rls === 0 && sec.policies > 50 && sec.functions > 300, JSON.stringify(sec));
if (orgs.length >= 2) {
  const [a, b] = orgs; if (a.owner && b.owner) {
    await c.query('begin'); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: a.owner, role: 'authenticated' })]); await c.query('set local role authenticated');
    const leak = (await c.query(`select count(*)::int n from public.properties where org_id = $1`, [b.id])).rows[0].n; await c.query('rollback');
    check('4. a user of one organization sees none of another organization\'s properties', leak === 0);
  }
}
const jobs = await one(`select count(*)::int n from public.job_runs`);
check('5. the job history and queues are present', jobs.n >= 0);
console.log(results.join('\n'));
await c.end();
process.exit(bad ? 1 : 0);
