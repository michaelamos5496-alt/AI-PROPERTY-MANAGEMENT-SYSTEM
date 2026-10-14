// Performance lab: seed the standard volume once, then time arbitrary SQL from a file.   npx tsx tests/load/lab.ts /tmp/lab.sql
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { startPostgres } from '../support/pg.js';
import { SCALES, seedVolume } from './volume.js';
const pg = await startPostgres();
try {
  const orgs = await seedVolume(pg, SCALES.standard!, () => {});
  await pg.admin.query('analyze');
  const big = orgs[0]!;
  const sub = (s: string) => s.replaceAll('$ORG', big.id).replaceAll('$TENANCY', big.tenancies[0]!).replaceAll('$MANAGER', big.manager.sub).replaceAll('$EMAIL', big.manager.email);
  for (const block of readFileSync(process.argv[2]!, 'utf8').split(';;').map((x) => x.trim()).filter(Boolean)) {
    const [name, sql, mode] = block.split('|||').map((x) => x.trim()) as [string, string, string?];
    const q = sub(sql);
    if (mode === 'explain') { const r = await pg.admin.query(`explain (analyze, buffers, costs off, timing on) ${q}`); console.log(`\n=== ${name}\n` + r.rows.map((x) => x['QUERY PLAN']).join('\n')); continue; }
    const ts: number[] = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); if (mode === 'as') await pg.as({ sub: big.manager.sub, email: big.manager.email }, (c) => c(q)); else await pg.admin.query(q); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b); console.log(`${name.padEnd(60)} median ${ts[3]!.toFixed(1)} ms   min ${ts[0]!.toFixed(1)}   max ${ts[6]!.toFixed(1)}`);
  }
} finally { await pg.stop(); }
