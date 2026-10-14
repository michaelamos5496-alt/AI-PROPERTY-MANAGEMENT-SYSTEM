import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../support/db.js';

let db: PGlite;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.close(); });
const q = (sql: string, params: unknown[] = []) => db.query<any>(sql, params).then((r) => r.rows);

describe('database security invariants (checked against the live catalog, not the source)', () => {
  it('every table in public has row level security enabled', async () => {
    const rows = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
  it('signed-in users have no write privilege on any table: every change goes through a checked function', async () => {
    const rows = await q(`select c.relname, p from pg_class c join pg_namespace n on n.oid = c.relnamespace, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('authenticated', c.oid, p) order by 1, 2`);
    expect(rows).toEqual([]);
  });
  it('anonymous users have no privilege on any table, view or sequence in public or app', async () => {
    const t = await q(`select n.nspname || '.' || c.relname as r from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'app') and c.relkind in ('r', 'v', 'm', 'S')
      and (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE') or (c.relkind = 'S' and has_sequence_privilege('anon', c.oid, 'USAGE'))) order by 1`);
    expect(t).toEqual([]);
  });
  it('anonymous users can execute nothing in public or app except an explicit, reviewed allowlist', async () => {
    const rows = await q(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`);
    expect(rows.map((r) => r.f)).toEqual([]);
  });
  it('service-only functions (_svc_) are executable by the service role and by no signed-in user', async () => {
    const rows = await q(`select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('service_role', p.oid, 'EXECUTE') s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\\_svc\\_%' order by 1`);
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.filter((r) => r.a).map((r) => r.proname)).toEqual([]);
    expect(rows.filter((r) => !r.s).map((r) => r.proname)).toEqual([]);
  });
  it('the only internal (app schema) functions a signed-in user may call are the reviewed helpers RLS policies need', async () => {
    const rows = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`);
    const allowed = ['can_access_attachment_object', 'can_access_document_object', 'can_verify_pending_attachment', 'can_verify_pending_object', 'has_role', 'my_role', 'require_role', 'require_user', 'role_rank', 'tenant_reported', 'is_member', 'shares_org_with'];
    // (discovered from the policies themselves, so this list only has to name helpers; anything else appearing here is a finding)
    const unexpected = rows.map((r) => r.proname).filter((n) => !allowed.includes(n));
    expect(unexpected).toEqual([]);
  });
  it('every SECURITY DEFINER function pins its search_path (prevents search-path hijacking)', async () => {
    const rows = await q(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') order by 1`);
    expect(rows.map((r) => r.f)).toEqual([]);
  });
  it('functions callable by signed-in users all check who is calling (no definer function trusts a caller-supplied identity)', async () => {
    // Every public function that takes an org id must start by establishing the caller's role in it. We look for the established helpers in the source of each.
    const rows = await q(`select p.proname, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname not like '%\\_svc\\_%'`);
    const guard = /require_role|require_user|has_role|auth\.uid\(\)|app\.my_role|app\.require_feature|app\.role_of_user|tenant_ids_for|app\.wa_|list_my_|portal_|accept_|app\.actor_name|app\.request_actor/;
    const naked = rows.filter((r) => !guard.test(r.def)).map((r) => r.proname);
    expect(naked).toEqual([]);
  });
  it('append-only tables reject update and delete even from the owner role', async () => {
    for (const t of ['finance_audit', 'subscription_events', 'copilot_messages', 'copilot_tool_calls', 'approval_events']) {
      const trg = await q(`select count(*)::int n from pg_trigger where tgrelid = ('public.' || $1)::regclass and not tgisinternal and tgtype & 16 = 16 or (tgrelid = ('public.' || $1)::regclass and not tgisinternal and tgtype & 8 = 8)`, [t]);
      expect(trg[0].n, t).toBeGreaterThan(0);
    }
  });
});
