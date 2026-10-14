import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/lib/env.js';
import { ResendProvider, SendError } from '../../src/services/email.js';

const msg = { to: 'a@b.test', name: 'Ann "The" <Admin>', subject: 'Hi', text: 'Body', idempotencyKey: 'email-123' };
const respond = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('Resend provider', () => {
  it('sends the right request, with the key only in the Authorization header and an idempotency key', async () => {
    let seen: any;
    const f = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'abc' }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await new ResendProvider('re_secret_key_1234', 'Property AI <n@x.test>', f).send(msg)).toEqual({ id: 'abc' });
    expect(seen.url).toBe('https://api.resend.com/emails');
    expect(seen.init.headers).toMatchObject({ authorization: 'Bearer re_secret_key_1234', 'idempotency-key': 'email-123' });
    const body = JSON.parse(seen.init.body);
    expect(body).toMatchObject({ from: 'Property AI <n@x.test>', subject: 'Hi', text: 'Body' });
    expect(body.to[0]).toBe('Ann The Admin <a@b.test>');                      // display name cannot inject extra recipients or markup
    expect(JSON.stringify(body)).not.toContain('re_secret_key_1234');
  });

  it.each([[400, true], [422, true], [401, false], [403, false], [429, false], [500, false], [503, false]])('HTTP %i is %s-permanent', async (status, permanent) => {
    const p = new ResendProvider('re_secret_key_1234', 'x@y.test', respond(status, { message: 'nope' }));
    const err = await p.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.permanent).toBe(permanent);
    expect(err.message).toContain(String(status));
    expect(err.message).not.toContain('re_secret_key_1234');
  });

  it('treats network failures as retryable and never leaks the key', async () => {
    const f = (async () => { throw new Error('connect ECONNRESET'); }) as unknown as typeof fetch;
    const err = await new ResendProvider('re_secret_key_1234', 'x@y.test', f).send(msg).catch((e) => e);
    expect(err).toMatchObject({ permanent: false });
    expect(err.message).toMatch(/network error/);
  });
});

describe('environment for background work', () => {
  const base = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'x'.repeat(30) };
  it('is optional, with safe defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ EMAIL_PROVIDER: 'log', EMAIL_INLINE_DELIVERY: true, EMAIL_BATCH_SIZE: 20 });
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
  it('rejects a weak cron secret and an incomplete provider setup, without echoing the values', () => {
    expect(() => loadEnv({ ...base, CRON_SECRET: 'short-secret' })).toThrow(/CRON_SECRET/);
    try { loadEnv({ ...base, CRON_SECRET: 'short-secret' }); } catch (e) { expect(String(e)).not.toContain('short-secret'); }
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(loadEnv({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_1234567890', EMAIL_FROM: 'Property AI <n@x.test>' }).EMAIL_PROVIDER).toBe('resend');
  });
});
