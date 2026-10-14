import type { Ref } from './types.js';

/**
 * Text written by tenants, vendors or uploaded documents can say anything, including "ignore your instructions".
 * It is never an instruction. These helpers (1) mark such text as data, (2) flag the obvious attacks so people and logs can see them,
 * and (3) check that what the assistant says is backed by what the tools returned. None of this grants or removes permissions:
 * authorization is decided by the application and the database, never by the model or by anything it read.
 */
const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier|your) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above|your) (instructions|rules)/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /you are now\b/i, /\bnew instructions?\b/i, /\bact as\b.{0,40}\b(admin|owner|manager|root)\b/i,
  /\b(approve|authori[sz]e) (this|the|it|all|every)\b.{0,40}\b(request|action|approval|payment|charge)s?\b/i,
  /\b(send|forward|email) (this|the|all|every)\b.{0,40}\b(to|tenant|everyone|all)\b/i,
  /<\/?(system|assistant|untrusted_data|tool_result)\b/i, /\bjailbreak\b/i, /reveal.{0,30}(prompt|key|secret|password)/i,
];

export function looksLikeInjection(text: string): boolean { return INJECTION.some((r) => r.test(text)); }

/** Walk a tool result and report which free-text fields look like instructions aimed at the assistant. */
export function scanForInjection(value: unknown, path = '', out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length >= 10) return out;
  if (typeof value === 'string') { if (looksLikeInjection(value)) out.push(path || '(root)'); }
  else if (Array.isArray(value)) value.forEach((v, i) => scanForInjection(v, `${path}[${i}]`, out, depth + 1));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) scanForInjection(v, path ? `${path}.${k}` : k, out, depth + 1);
  return out;
}

/** What the model sees for a tool result: clearly delimited, with the delimiter itself defanged inside the data. */
export function wrapUntrusted(tool: string, json: string): string {
  const safe = json.replace(/<\/?\s*untrusted_data/gi, '<_untrusted_data');
  return `<untrusted_data source="tool:${tool}">\n${safe}\n</untrusted_data>`;
}

const fmt = (minor: number, currency: string): string => {
  const exp = ['JPY', 'KRW', 'VND', 'CLP', 'ISK'].includes(currency) ? 0 : ['BHD', 'KWD', 'OMR', 'JOD', 'TND'].includes(currency) ? 3 : 2;
  const neg = minor < 0; const abs = Math.abs(minor); const div = 10 ** exp;
  const whole = Math.trunc(abs / div).toLocaleString('en-US');
  const frac = exp ? '.' + String(abs % div).padStart(exp, '0') : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
};
export const formatMinor = fmt;

/** Give the model a ready-made display amount next to every `*_minor` figure so it never has to do money arithmetic. */
export function addDisplayAmounts<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => addDisplayAmounts(v, depth + 1)) as T;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = addDisplayAmounts(v, depth + 1);
    if (k.endsWith('_minor') && typeof v === 'number' && typeof o.currency === 'string') out[k.replace(/_minor$/, '_display')] = `${fmt(v, o.currency)} ${o.currency}`;
  }
  return out as T;
}

/** Every number-ish and id-ish token a tool actually returned, so the final answer can be compared against them. */
export function collectFacts(value: unknown, facts: { numbers: Set<string>; ids: Set<string> }, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === 'number') { facts.numbers.add(String(value)); facts.numbers.add(value.toLocaleString('en-US')); }
  else if (typeof value === 'string') {
    for (const m of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) facts.ids.add(m[0].toLowerCase());
    for (const m of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) { facts.numbers.add(m[0]); facts.numbers.add(m[0].replace(/,/g, '')); }
  } else if (Array.isArray(value)) value.forEach((v) => collectFacts(v, facts, depth + 1));
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectFacts(v, facts, depth + 1);
}

export interface Grounding { unverified_amounts: string[]; unknown_ids: string[]; no_data_used: boolean }

/**
 * A cheap, honest guard: money-looking figures and record ids in the answer must appear in something a tool returned this turn.
 * Failures do not delete the answer; they are surfaced to the reader so a made-up figure is never presented as verified.
 */
export function checkGrounding(answer: string, facts: { numbers: Set<string>; ids: Set<string> }, toolsUsed: number, userSuppliedNumbers: Set<string> = new Set()): Grounding {
  const unverified = new Set<string>();
  for (const m of answer.matchAll(/(?:[$€£¥]\s?|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s?)(-?\d[\d,]*(?:\.\d+)?)|(-?\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|CAD|AUD|JPY)\b/g)) {
    const n = (m[1] ?? m[2])!;
    const plain = n.replace(/,/g, '');
    if (!facts.numbers.has(n) && !facts.numbers.has(plain) && !userSuppliedNumbers.has(plain)) unverified.add(m[0].trim());
  }
  const unknown = new Set<string>();
  for (const m of answer.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) if (!facts.ids.has(m[0].toLowerCase())) unknown.add(m[0]);
  return { unverified_amounts: [...unverified].slice(0, 10), unknown_ids: [...unknown].slice(0, 10), no_data_used: toolsUsed === 0 && /\d/.test(answer) };
}

export function dedupeRefs(refs: Ref[], max = 40): Ref[] {
  const seen = new Set<string>(); const out: Ref[] = [];
  for (const r of refs) { const k = `${r.type}:${r.id}`; if (seen.has(k) || !r.id) continue; seen.add(k); out.push({ type: String(r.type), id: String(r.id), label: String(r.label ?? '').slice(0, 120) }); if (out.length >= max) break; }
  return out;
}

/** Cap a result's size by trimming list items, saying so, rather than cutting JSON in half. */
export function capResult(result: Record<string, unknown>, maxBytes: number): { json: string; truncated: boolean } {
  let json = JSON.stringify(result);
  if (Buffer.byteLength(json) <= maxBytes) return { json, truncated: false };
  const shrunk: Record<string, unknown> = { ...result };
  for (const keep of [20, 10, 5, 2, 1, 0]) {
    for (const k of ['items', 'rows', 'tool_calls']) if (Array.isArray(shrunk[k])) shrunk[k] = (result[k] as unknown[]).slice(0, keep);
    json = JSON.stringify({ ...shrunk, truncated: true, truncated_note: 'The result was too long; only the first rows are shown. Narrow the question to see the rest.' });
    if (Buffer.byteLength(json) <= maxBytes) break;
  }
  if (Buffer.byteLength(json) > maxBytes) json = JSON.stringify({ truncated: true, truncated_note: 'The result was too large to show.' });
  return { json, truncated: true };
}
