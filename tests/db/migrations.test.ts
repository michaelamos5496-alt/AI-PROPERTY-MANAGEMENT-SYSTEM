import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createTestDb, migrationFiles, migrationsDir } from '../support/db.js';

describe('migrations', () => {
  it('can be applied a second time over a populated schema without error or change (safe to re-run, safe after a partial failure)', async () => {
    const db = await createTestDb();
    const snapshot = async () => (await db.query<any>(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','v','i')) objects,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','app')) functions,
      (select count(*) from pg_policies) policies, (select count(*) from pg_trigger where not tgisinternal) triggers,
      (select count(*) from public.plans) plans, (select count(*) from public.plan_entitlements) plan_entitlements, (select count(*) from public.currencies) currencies,
      (select count(*) from public.notification_event_types) event_types, (select count(*) from public.approval_actions) approval_actions`)).rows[0];
    const before = await snapshot();
    for (const f of migrationFiles()) {
      try { await db.exec(readFileSync(join(migrationsDir, f), 'utf8')); }
      catch (e) { throw new Error(`${f} is not re-runnable: ${(e as Error).message}`); }
    }
    expect(await snapshot()).toEqual(before);
    await db.close();
  }, 120_000);

  it('start from nothing in one pass and leave the database usable by the roles the API uses', async () => {
    const db = new PGlite();
    const { readFileSync: r } = await import('node:fs');
    await db.exec(r(join(import.meta.dirname, '..', 'support', 'auth-stub.sql'), 'utf8'));
    for (const f of migrationFiles()) await db.exec(r(join(migrationsDir, f), 'utf8'));
    expect((await db.query<any>(`select count(*)::int n from pg_roles where rolname in ('anon', 'authenticated', 'service_role')`)).rows[0].n).toBe(3);
    await db.close();
  }, 120_000);
});
