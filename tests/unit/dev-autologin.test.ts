import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/lib/env.js';
import { devAutoLogin } from '../../src/lib/dev-autologin.js';

const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a'.repeat(30), DEV_AUTO_LOGIN_EMAIL: 'me@example.test', DEV_AUTO_LOGIN_PASSWORD: 'secret-pw' };

describe('local auto-login can never be switched on where it matters', () => {
  it('is refused in production, on Vercel, and for any non-local APP_URL', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', APP_URL: 'https://app.example.com' })).toThrow(/local development only/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', APP_URL: 'https://app.example.com' })).toThrow(/local development only/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', APP_URL: 'http://localhost.evil.com:3000' })).toThrow(/local development only/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', APP_URL: 'http://localhost:3000', VERCEL: '1' } as never)).not.toThrow();   // (VERCEL is read from the process, not from the source object)
    const prev = process.env.VERCEL; process.env.VERCEL = '1';
    try { expect(() => loadEnv({ ...base, NODE_ENV: 'development', APP_URL: 'http://localhost:3000' })).toThrow(/local development only/); } finally { if (prev === undefined) delete process.env.VERCEL; else process.env.VERCEL = prev; }
    expect(() => loadEnv({ ...base, DEV_AUTO_LOGIN_PASSWORD: undefined, NODE_ENV: 'production', APP_URL: 'https://app.example.com', DEV_AUTO_LOGIN_EMAIL: 'x@y.test' })).toThrow();   // either variable alone is enough to refuse
  });
  it('is off unless both variables are set, and works on localhost when they are', async () => {
    expect(devAutoLogin(loadEnv({ SUPABASE_URL: base.SUPABASE_URL, SUPABASE_ANON_KEY: base.SUPABASE_ANON_KEY }))).toBeNull();
    const env = loadEnv({ ...base, NODE_ENV: 'development', APP_URL: 'http://localhost:3000' });
    const sent: { url: string; body: string }[] = [];
    const mw = devAutoLogin(env, (async (url: any, init: any) => { sent.push({ url: String(url), body: init.body }); return new Response('{}', { status: 200, headers: { 'set-cookie': 'pai_at=t; Path=/' } }); }) as never)!;
    const res: any = { cookies: [] as string[], loc: '', append(_k: string, v: string) { this.cookies.push(v); }, redirect(_c: number, l: string) { this.loc = l; } };
    await mw({ method: 'GET', path: '/', headers: {} } as never, res, () => { throw new Error('should have redirected'); });
    expect(res.loc).toBe('/app'); expect(sent[0]!.url).toBe('http://127.0.0.1:3000/api/auth/login');
    let passed = 0; await mw({ method: 'POST', path: '/', headers: {} } as never, res, () => { passed++; }); await mw({ method: 'GET', path: '/app', headers: {} } as never, res, () => { passed++; }); await mw({ method: 'GET', path: '/', headers: { cookie: 'pai_at=x' } } as never, res, () => { passed++; });
    expect(passed).toBe(3);                                                              // only GET / and GET /login (without a session) are touched
  });
  it('the deployed function never imports it', async () => {
    const { readFileSync } = await import('node:fs');
    const entry = readFileSync(new URL('../../api/index.ts', import.meta.url), 'utf8');
    expect(entry).not.toMatch(/dev-autologin|dev\.js/);
    const app = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    expect(app).not.toMatch(/dev-autologin/);
  });
});
