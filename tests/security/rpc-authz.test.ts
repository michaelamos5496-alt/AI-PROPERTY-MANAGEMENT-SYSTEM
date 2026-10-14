import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as } from '../support/db.js';
import { freshOps, type Ops } from '../support/ops.js';

/**
 * Negative authorization sweep over EVERY public database function that takes an organization id.
 * Each one is called with dummy-but-well-typed arguments by people who must not get anything: strangers (not members), anonymous callers,
 * and members of a DIFFERENT organization addressing this one. A call that returns instead of raising is a finding.
 */
let db: PGlite; let o: Ops;
beforeAll(async () => { ({ db, o } = await freshOps()); }, 60_000);
afterAll(async () => { await db.close(); });

interface Fn { name: string; args: { name: string; type: string }[] }
async function functions(): Promise<Fn[]> {
  const rows = (await db.query<any>(`select p.proname, p.proargnames, (select array_agg(format_type(t, null) order by ord) from unnest(p.proargtypes::oid[]) with ordinality as x(t, ord)) types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname not like '%\\_svc\\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows;
  return rows.map((r) => ({ name: r.proname, args: (r.types ?? []).map((t: string, i: number) => ({ name: r.proargnames[i], type: t })) })).filter((f) => f.args[0]?.name === 'p_org');
}
const enums = new Map<string, string>();
async function dummy(type: string, name: string, org: string): Promise<unknown> {
  if (name === 'p_org') return org;
  if (type === 'uuid') return crypto.randomUUID();
  if (type === 'text' || type === 'character') return name.includes('hash') ? 'a'.repeat(64) : 'dummy value 123';
  if (type === 'boolean') return false;
  if (['integer', 'bigint', 'smallint', 'numeric'].includes(type)) return 1;
  if (type === 'date') return '2026-01-01';
  if (type.startsWith('timestamp')) return new Date().toISOString();
  if (type === 'jsonb' || type === 'json') return '{}';
  if (type.endsWith('[]')) return '{}';
  if (type.startsWith('character(') || type === 'bpchar') return 'USD';
  if (!enums.has(type)) enums.set(type, (await db.query<any>(`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where format_type(t.oid, null) = $1 or t.typname = $2 order by e.enumsortorder limit 1`, [type, type.replace('public.', '')])).rows[0]?.enumlabel ?? 'x');
  return enums.get(type);
}
const reasons = new Map<string, Map<string, number>>();
const AUTH = new Set(['PT401', 'PT403', 'PT404', '42501']);
async function attempt(fn: Fn, actor: any, org: string, label = 'x'): Promise<'denied' | 'ALLOWED'> {
  const vals = await Promise.all(fn.args.map((a) => dummy(a.type, a.name, org)));
  const sql = `select public.${fn.name}(${fn.args.map((a, i) => `$${i + 1}::${a.type}`).join(', ')}) as r`;
  try { await as(db, actor, (q) => q(sql, vals)); return 'ALLOWED'; }
  catch (e) {
    const code = String((e as { code?: string }).code ?? 'none');
    const m = reasons.get(label) ?? new Map<string, number>(); reasons.set(label, m); m.set(code, (m.get(code) ?? 0) + 1);
    if (!AUTH.has(code)) (m as Map<string, number> & { other?: string[] }).other = [...((m as { other?: string[] }).other ?? []), `${fn.name}:${code}`];
    return 'denied';
  }
}

describe('every organization-scoped RPC refuses people who have no business calling it', () => {
  it('finds a meaningful number of functions to sweep', async () => { expect((await functions()).length).toBeGreaterThan(150); });
  it('strangers (signed in, not members) get nothing from any of them', async () => {
    const bad: string[] = [];
    for (const f of await functions()) if (await attempt(f, o.outsider, o.orgA, 'stranger') === 'ALLOWED') bad.push(f.name);
    expect(bad).toEqual([]);
  }, 120_000);
  it('anonymous callers get nothing from any of them', async () => {
    const bad: string[] = [];
    for (const f of await functions()) if (await attempt(f, null, o.orgA, 'anon') === 'ALLOWED') bad.push(f.name);
    expect(bad).toEqual([]);
  }, 120_000);
  it('a member of one organization addressing another organization gets nothing', async () => {
    const bad: string[] = [];
    for (const f of await functions()) {
      if (await attempt(f, o.owner, o.orgB, 'cross') === 'ALLOWED') bad.push(`${f.name} (owner of A → B)`);
    }
    expect(bad).toEqual([]);
  }, 120_000);
  it('view-only members cannot call any function that changes data', async () => {
    const writers = (await functions()).filter((f) => /^(create|update|save|set|delete|archive|restore|void|record|allocate|reverse|issue|assign|triage|cancel|resolve|reopen|acknowledge|submit|request|decide|retry|invite|revoke|accept|add|change|generate|activate|end|run|confirm|unlink|wa_staff|begin_checkout|copilot_(confirm|submit|cancel|demo))/.test(f.name));
    expect(writers.length).toBeGreaterThan(60);
    const bad: string[] = [];
    for (const f of writers) if (await attempt(f, o.viewer, o.orgA, 'viewer') === 'ALLOWED') bad.push(f.name);
    expect(bad).toEqual([]);
  }, 120_000);
});

describe('the sweep is conclusive, not accidental', () => {
  it('almost every refusal is a real authorization refusal, not a malformed dummy argument', () => {
    for (const [label, m] of reasons) {
      const total = [...m.entries()].filter(([k]) => k !== 'other').reduce((a, [, n]) => a + n, 0);
      const other = (m as unknown as { other?: string[] }).other ?? [];
      console.log(label, Object.fromEntries([...m.entries()].filter(([k]) => k !== 'other')), other.length ? `non-authorization failures: ${other.join(', ')}` : '');
      expect(other.length / Math.max(total, 1), `${label}: ${other.join(', ')}`).toBeLessThan(0.1);
    }
  });
});
