#!/usr/bin/env node
// Migration safety lint. Run in CI and before every deploy:  node scripts/check-migrations.mjs
// 1. files are named <14-digit timestamp>_<name>.sql, unique and in strictly increasing order
// 2. a migration that already shipped is never edited (compared with the git tag/ref in BASE_REF, default origin/main, when available)
// 3. destructive statements need an explicit, reviewed marker:   -- reviewed-destructive: <ticket / reason>
//    (drop table, drop column, truncate, delete/update without where, alter column type, drop schema, drop type, disable row level security)
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const problems = [];
let prev = '';
for (const f of files) {
  const m = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) { problems.push(`${f}: name must be <14 digit timestamp>_<snake_case>.sql`); continue; }
  if (m[1] <= prev) problems.push(`${f}: timestamp is not greater than the previous migration (${prev})`);
  prev = m[1];
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, (m) => (/\b(drop|truncate|delete|alter)\b/i.test(m) ? m : ''));
const DANGEROUS = [
  [/\bdrop\s+table\b/i, 'drop table'], [/\bdrop\s+column\b/i, 'drop column'], [/\btruncate\b/i, 'truncate'], [/\bdrop\s+schema\b/i, 'drop schema'], [/\bdrop\s+type\b/i, 'drop type'],
  [/\balter\s+column\b[^;]*\btype\b/i, 'alter column type'], [/\bdisable\s+row\s+level\s+security\b/i, 'disable row level security'], [/\bno\s+force\s+row\s+level\s+security\b/i, 'no force rls'],
  [/\bdelete\s+from\b(?![^;]*\bwhere\b)/i, 'delete without where'], [/\bupdate\s+[\w."]+\s+set\b(?![^;]*\bwhere\b)[^;]*;/i, 'update without where'],
];
for (const f of files) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const marked = /--\s*reviewed-destructive:\s*\S+/i.test(raw);
  const body = strip(raw);
  for (const [re, label] of DANGEROUS) if (re.test(body) && !marked) problems.push(`${f}: contains "${label}" without a "-- reviewed-destructive: <reason>" marker`);
  if (/\bgrant\b[^;]*\bto\s+(public|anon)\b/i.test(body) && !/revoke/i.test(body)) problems.push(`${f}: grants to public/anon; review the exposure`);
}

// shipped migrations are immutable
const base = process.env.BASE_REF ?? 'origin/main';
try {
  execSync(`git rev-parse --verify ${base}`, { stdio: 'ignore' });
  const changed = execSync(`git diff --name-status ${base} -- supabase/migrations`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const line of changed) { const [status, file] = line.split('\t'); if (status !== 'A') problems.push(`${file}: a migration that already exists on ${base} was ${status === 'D' ? 'deleted' : 'modified'}; add a new migration instead`); }
} catch { console.log(`(git ref ${base} not available: skipping the immutability check)`); }

if (problems.length) { console.error('Migration check FAILED:\n' + problems.map((p) => '  - ' + p).join('\n')); process.exit(1); }
console.log(`check-migrations: ${files.length} migrations, ordering and safety rules satisfied.`);
