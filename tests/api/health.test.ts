import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaystackProvider } from '../../src/billing/provider.js';
import { _resetAlertsForTests } from '../../src/lib/alerts.js';
import { assess, probeIntegrations } from '../../src/lib/health.js';
import { loadEnv } from '../../src/lib/env.js';
import { CRON_SECRET, startTestApp, type TestApp } from '../support/app.js';

let t: TestApp; const posts: string[] = []; let hook: ReturnType<typeof createServer>; let timeoutOnInit = false;
const fakeFetch: typeof fetch = (async (url: any) => {
  if (String(url).endsWith('/transaction/initialize') && timeoutOnInit) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  return new Response('{}', { status: 200 });
}) as any;
beforeAll(async () => {
  hook = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { posts.push(b); res.end('ok'); }); });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  t = await startTestApp({ RATE_LIMIT_INTERNAL_MAX: '1000', ALERT_WEBHOOK_URL: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/alert`, BILLING_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_0123456789abcdef0123' },
    {}, { billing: (env) => new PaystackProvider(env, fakeFetch) });
}, 60_000);
afterAll(async () => { await t.close(); hook.close(); });

const health = (qs = '', secret: string | null = CRON_SECRET) => { const r = supertest(t.app).get(`/api/internal/health${qs}`); return secret ? r.set('Authorization', `Bearer ${secret}`) : r; };

describe('health endpoints', () => {
  it('liveness and readiness are public, tiny, and reveal nothing', async () => {
    expect((await supertest(t.app).get('/api/health')).body).toEqual({ ok: true });
    const r = await supertest(t.app).get('/api/health/ready');
    expect(r.status).toBe(200); expect(r.body).toEqual({ ok: true });
  });
  it('the detailed report needs the operator credential', async () => {
    expect((await health('', null)).status).toBe(401);
    expect((await health('', 'wrong-secret-wrong-secret-0123456789')).status).toBe(401);
  });
  it('reports a healthy system as 200, and names exactly what is stuck as 503', async () => {
    await supertest(t.app).get('/api/internal/jobs/run').set('Authorization', `Bearer ${CRON_SECRET}`);          // a completed scheduler run
    const ok = await health();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body).toMatchObject({ status: 'ok', problems: [] });
    const org = await t.newOrg('Health Org');
    const db = (t.mock as any).db;
    await db.query(`insert into public.email_queue (org_id, recipient_email, event_type, subject, body_text, dedupe_key, status, attempts) values ($1, 'a@b.test', 'maintenance.submitted', 's', 'b', 'dead-1', 'dead', 6)`, [org.orgId]);
    await db.query(`insert into public.whatsapp_events (phone_number_id, kind, provider_id, payload, status, received_at) values ('100000', 'message', 'stuck-1', '{}', 'pending', now() - interval '20 minutes')`);
    const bad = await health();
    expect(bad.status).toBe(503); expect(bad.body.status).toBe('degraded');
    expect(bad.body.problems.join(' ')).toMatch(/email\(s\) gave up/); expect(bad.body.problems.join(' ')).toMatch(/WhatsApp event\(s\) unprocessed/);
    expect(JSON.stringify(bad.body)).not.toMatch(/a@b\.test|sk_test|CRON/);                   // counts and names only, never data or secrets
  });
  it('alerts an operator once, without personal data, and stays quiet about repeats', async () => {
    _resetAlertsForTests(); posts.length = 0;
    await health('?alert=1'); await health('?alert=1'); await health('?alert=1');
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toHaveLength(1);
    const text = JSON.parse(posts[0]!).text as string;
    expect(text).toMatch(/Health is degraded/); expect(text).not.toMatch(/a@b\.test/);
  });
});

describe('live integration probes', () => {
  const env = loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a'.repeat(30), EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'resend-key-0123456789', EMAIL_FROM: 'A <a@b.test>', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-0123456789',
    WHATSAPP_PROVIDER: 'cloud', WHATSAPP_ACCESS_TOKEN: 'wa-token-0123456789012345', WHATSAPP_APP_SECRET: 'wa-secret-0123456789', WHATSAPP_VERIFY_TOKEN: 'wa-verify-0123456789', BILLING_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_0123456789abcdef0123' });
  it('checks each configured integration with its own credentials, in parallel, with a timeout, and skips the rest', async () => {
    const seen: { url: string; auth: string }[] = [];
    const f: typeof fetch = (async (url: any, init: any) => { seen.push({ url: String(url), auth: JSON.stringify(init?.headers) }); return String(url).includes('anthropic') ? new Response('{}', { status: 401 }) : new Response('{}', { status: 200 }); }) as any;
    const r = await probeIntegrations(env, '100000000000001', f);
    expect(Object.fromEntries(r.map((p) => [p.name, p.status]))).toEqual({ 'supabase-auth': 'ok', 'email (resend)': 'ok', 'whatsapp (meta graph)': 'ok', 'ai (anthropic)': 'fail', 'billing (paystack)': 'ok' });
    expect(r.find((p) => p.name.startsWith('ai'))!.detail).toBe('HTTP 401');
    expect(seen.find((s) => s.url.includes('graph.facebook.com'))!.url).toContain('/100000000000001?');
    const skipped = await probeIntegrations(loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a'.repeat(30) }), null, f);
    expect(skipped.filter((p) => p.status === 'skipped').map((p) => p.name)).toEqual(['email (resend)', 'whatsapp (meta graph)', 'ai (anthropic)', 'billing (paystack)']);
    const down = await probeIntegrations(env, null, (async () => { throw new Error('ECONNREFUSED'); }) as any);
    expect(down.find((p) => p.name === 'supabase-auth')).toMatchObject({ status: 'fail' });
  });
  it('flags stale schedulers and dead letters in the assessment', () => {
    const base = { email: { queued_overdue: 0, dead: 0 }, whatsapp: { events_stuck: 0, events_dead: 0, outbound_stuck: 0, outbound_dead: 0 }, billing: { events_pending: 0 }, jobs: { errors_24h: 0, last_ok_at: new Date().toISOString() }, approvals: { pending_expired: 0 } };
    expect(assess(base)).toEqual([]);
    expect(assess({ ...base, jobs: { errors_24h: 0, last_ok_at: new Date(Date.now() - 3 * 3600_000).toISOString() } })[0]).toMatch(/scheduler has not completed/);
    expect(assess({ ...base, jobs: { errors_24h: 0, last_ok_at: null } })[0]).toMatch(/scheduler/);
  });
});

describe('provider outages are handled, not propagated', () => {
  it('a billing provider timeout becomes a clear 502 and charges nothing', async () => {
    timeoutOnInit = true;
    const org = await t.newOrg('Timeout Org');
    const r = await org.c.post(`${org.base}/billing/checkout`).send({ planCode: 'growth', interval: 'monthly', currency: 'NGN' });
    timeoutOnInit = false;
    expect(r.status).toBe(502); expect(r.body.error.message).toMatch(/slow right now.*Nothing was charged/);
    expect((await org.c.get(`${org.base}/billing`)).body.status).toBe('trialing');
  });
});
