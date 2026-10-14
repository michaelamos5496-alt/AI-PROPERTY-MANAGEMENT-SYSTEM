/**
 * A local DEMO of the whole app with fake data and a throwaway in-memory database. No Supabase account needed.
 *   npm run demo        then open the address it prints and sign in with the printed login.
 * Listens on 127.0.0.1 only. Everything disappears when you stop it. The login below exists ONLY inside this demo process;
 * it is not a default password of the real application (which has none).
 */
import { createDevServer } from '../src/dev.js';
import { loadEnv } from '../src/lib/env.js';
import { startMockSupabase } from '../tests/support/mock-supabase.js';

const PORT = Number(process.env.DEMO_PORT ?? 3200);
const EMAIL = 'owner@demo.test'; const PASSWORD = 'Demo-Passw0rd-2026';
const mock = await startMockSupabase();
const env = loadEnv({ NODE_ENV: 'test', PORT: String(PORT), APP_URL: `http://localhost:${PORT}`, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: mock.anonKey, SUPABASE_SERVICE_ROLE_KEY: mock.serviceKey,
  CRON_SECRET: 'demo-cron-secret-0123456789-0123456789', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '100000', RATE_LIMIT_AUTH_MAX: '1000', EMAIL_INLINE_DELIVERY: 'false' });
const server = createDevServer(env).listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${PORT}`;

let cookie = '';
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, origin: base, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie?.() ?? []; if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`);
  return json;
};
await call('POST', '/auth/register', { email: EMAIL, password: PASSWORD, fullName: 'Demo Owner' });
const org = await call('POST', '/organizations', { name: 'Demo Properties Ltd' });
const b = `/organizations/${org.id}`;
await call('PUT', `${b}/market`, { country: 'GH' });
const prop = await call('POST', `${b}/properties`, { name: 'Cedi Court', addressLine1: '12 Ring Road', city: 'Accra', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' });
const people = [['Ama Mensah', '2B', 150000, 'ama@example.test'], ['Kofi Boateng', '3A', 120000, 'kofi@example.test'], ['Esi Owusu', '1C', 95000, 'esi@example.test']] as const;
let first = '';
for (const [name, unitRef, rent, email] of people) {
  const unit = await call('POST', `${b}/properties/${prop.id}/units`, { reference: unitRef });
  const t = await call('POST', `${b}/tenants`, { fullName: name, email });
  const tn = await call('POST', `${b}/tenancies`, { unit: unit.id, tenantIds: [t.id], startDate: '2026-01-01', rentAmountMinor: rent });
  await call('POST', `${b}/tenancies/${tn.id}/activate`, { expectedVersion: tn.version });
  await call('POST', `${b}/tenancies/${tn.id}/charges`, { kind: 'fee', description: 'September rent', dueDate: '2026-09-01', amountMinor: rent }, { 'idempotency-key': crypto.randomUUID() });
  if (!first) first = unit.id;
}
await call('POST', `${b}/maintenance`, { property: prop.id, unit: first, title: 'Kitchen tap dripping', description: 'The cold tap drips all day.', category: 'plumbing' });
await call('POST', '/auth/logout', {});

console.log(`\nProperty AI demo is running (fake data, in memory, this computer only)\n\n  Open:      ${base}\n  Email:     ${EMAIL}\n  Password:  ${PASSWORD}\n  Role:      owner (the highest role: sees everything, can invite and manage others)\n\nTry: Copilot → "Who is overdue on rent?", Maintenance, Finance, Plan.\nPress Ctrl+C to stop.\n`);
process.on('SIGINT', async () => { server.close(); await mock.close(); process.exit(0); });
