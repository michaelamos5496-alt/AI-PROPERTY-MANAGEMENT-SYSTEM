import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrationFiles, migrationsDir, type Actor } from './db.js';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

/**
 * A REAL PostgreSQL server (embedded binary) with true parallel connections, used where in-process
 * Postgres (single connection) cannot prove concurrency behaviour: row locks, races, deadlocks.
 */
export async function startPostgres() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'pai-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false,
    postgresFlags: ['-c', 'max_connections=200', '-c', 'deadlock_timeout=200ms', '-c', 'fsync=off'],
    onLog: () => {}, onError: () => {},
  });
  await server.initialise();
  await server.start();
  const conn = { host: '127.0.0.1', port, user: 'postgres', password: 'pw', database: 'postgres' };
  const admin = new pg.Pool({ ...conn, max: 4 });
  await admin.query(readFileSync(join(import.meta.dirname, 'auth-stub.sql'), 'utf8'));
  for (const f of migrationFiles()) await admin.query(readFileSync(join(migrationsDir, f), 'utf8'));
  const pool = new pg.Pool({ ...conn, max: 60 });
  pool.on('error', () => {});
  admin.on('error', () => {});

  type Q = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  /** One transaction on its own connection, acting as `authenticated` with the actor's JWT claims. */
  async function as<T>(actor: NonNullable<Actor>, fn: (q: Q) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: actor.sub, email: actor.email, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const out = await fn((sql, params) => c.query(sql, params as any[]));
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  const call = (actor: NonNullable<Actor>, fn: string, args: Record<string, unknown> = {}) => as(actor, async (q) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    return (await q(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])))).rows[0].r;
  });
  const createUser = async (email: string) => {
    const r = await admin.query(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [email]);
    return { sub: r.rows[0].id as string, email };
  };
  return {
    pool, admin, as, call, createUser, port,
    version: async () => (await admin.query('show server_version')).rows[0].server_version as string,
    stop: async () => { await pool.end().catch(() => {}); await admin.end().catch(() => {}); await server.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); },
  };
}
export type Pg = Awaited<ReturnType<typeof startPostgres>>;
