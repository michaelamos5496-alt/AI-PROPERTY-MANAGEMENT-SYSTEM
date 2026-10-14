-- Phase 8 hardening. Found by tests/security/db-invariants.test.ts: functions in the internal `app` schema were executable by PUBLIC
-- (Postgres grants EXECUTE to PUBLIC by default, and a schema-level "alter default privileges … revoke" cannot remove that built-in default),
-- so anon and authenticated could call them if the schema were ever exposed through the API. It is not exposed by default and must never be
-- (see docs/DEPLOYMENT.md), but a second lock costs nothing.
--
-- After this migration only the functions that row level security policies, column defaults and constraints actually need are executable by
-- signed-in users; everything else in `app` is callable only from inside other functions (which run with their owner's privileges).

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.f);
    execute format('grant execute on function %s to service_role', r.f);
  end loop;
  -- keep exactly what policies, defaults and check constraints evaluate AS THE CALLER
  for r in select distinct p.oid::regprocedure as f from pg_depend d join pg_proc p on p.oid = d.refobjid join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and d.classid in ('pg_policy'::regclass, 'pg_attrdef'::regclass, 'pg_constraint'::regclass) loop
    execute format('grant execute on function %s to authenticated', r.f);
  end loop;
end $$;

-- From now on new functions are private to their owner unless a migration grants them (all schemas, for the role that runs migrations).
alter default privileges revoke execute on functions from public;
