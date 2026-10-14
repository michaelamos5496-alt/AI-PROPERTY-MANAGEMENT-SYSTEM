import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
export const migrationsDir = join(root, 'supabase', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
}

export async function applyMigrations(db: PGlite): Promise<void> {
  for (const f of migrationFiles()) await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
}

/** Fresh in-memory Postgres with the auth stub and every migration applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(import.meta.dirname, 'auth-stub.sql'), 'utf8'));
  await applyMigrations(db);
  return db;
}

export async function createUser(db: PGlite, email: string, opts: { confirmed?: boolean; name?: string } = {}) {
  const r = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
     values ($1, $2::jsonb, ${opts.confirmed === false ? 'null' : 'now()'}) returning id`,
    [email, JSON.stringify({ full_name: opts.name ?? '' })],
  );
  return r.rows[0]!.id;
}

export type Actor = { sub: string; email: string } | null; // null = anon
export type Service = { service: true };

/** Run `fn` as the Postgres role PostgREST would use, with JWT claims set. */
export async function as<T>(db: PGlite, actor: Actor | Service, fn: (q: Query) => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    const isService = !!actor && 'service' in actor;
    const role = isService ? 'service_role' : actor ? 'authenticated' : 'anon';
    const claims = isService || !actor ? { role } : { sub: (actor as any).sub, email: (actor as any).email, role };
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.exec(`set local role ${role}`);
    const result = await fn((sql, params) => db.query(sql, params));
    await db.exec('reset role');
    await db.exec('commit');
    return result;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

/** Convenience: call an RPC as an actor and return its jsonb result. */
export const rpc = (db: PGlite, actor: Actor, fn: string, args: unknown[] = [], casts: string[] = []) =>
  as(db, actor, async (q) => {
    const ph = args.map((_, i) => `$${i + 1}${casts[i] ? '::' + casts[i] : ''}`).join(', ');
    return (await q(`select public.${fn}(${ph}) as r`, args)).rows[0].r;
  });

/** PostgREST-style error code for an expected failure ("PT403" etc.). */
export async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e: any) { return e.code ?? e.message; }
  return 'NO_ERROR';
}

/** Call an RPC with named arguments (`p_name => $n`) as an actor. */
export const call = (db: PGlite, actor: Actor | Service, fn: string, args: Record<string, unknown> = {}) =>
  as(db, actor, async (q) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    return (await q(sql, params)).rows[0].r;
  });
