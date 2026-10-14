import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/lib/env.js';
import { CloudApiProvider, WaSendError, classify } from '../../src/whatsapp/provider.js';
import { extractBatches, verifySignature } from '../../src/whatsapp/webhook.js';
import { hashCode } from '../../src/whatsapp/engine.js';
import { waStatus, waText } from '../support/whatsapp.js';

const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a'.repeat(30) };
const SECRET = 'unit-secret-0123456789';
const sig = (raw: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('signature verification', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  it('accepts only the exact HMAC-SHA256 of the raw bytes under the app secret', () => {
    expect(verifySignature(raw, sig(raw.toString()), SECRET)).toBe(true);
    expect(verifySignature(raw, sig(raw.toString()).toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toBe(true);   // hex case is irrelevant
    expect(verifySignature(raw, undefined, SECRET)).toBe(false);
    expect(verifySignature(raw, '', SECRET)).toBe(false);
    expect(verifySignature(raw, sig(raw.toString(), 'other-secret-other-secret'), SECRET)).toBe(false);
    expect(verifySignature(Buffer.from(raw.toString() + ' '), sig(raw.toString()), SECRET)).toBe(false);
    expect(verifySignature(raw, sig(raw.toString()).slice(0, -2), SECRET)).toBe(false);          // truncated
    expect(verifySignature(raw, sig(raw.toString()).replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(verifySignature(raw, 'sha256=' + 'g'.repeat(64), SECRET)).toBe(false);
  });
});

describe('payload extraction', () => {
  it('groups events by business number and keys them on Meta\'s own ids', () => {
    const a = waText('1111111111', '15550001', 'hi', { id: 'wamid.A' });
    const b = waStatus('2222222222', 'wamid.B', 'delivered', '15550002');
    const merged = { object: 'whatsapp_business_account', entry: [...a.entry, ...b.entry] };
    const { batches, skipped } = extractBatches(merged);
    expect(skipped).toBe(0);
    expect(batches.map((x) => [x.phoneNumberId, x.events.map((e) => [e.kind, e.provider_id, e.contact_key])])).toEqual([
      ['1111111111', [['message', 'wamid.A', '15550001']]], ['2222222222', [['status', 'wamid.B:delivered', null]]]]);
  });
  it('skips anything malformed instead of trusting it', () => {
    expect(extractBatches(null).batches).toEqual([]);
    expect(extractBatches({ object: 'page', entry: [] }).batches).toEqual([]);
    const bad = { object: 'whatsapp_business_account', entry: [{ changes: [
      { field: 'account_update', value: {} },
      { field: 'messages', value: { metadata: { phone_number_id: 'abc' }, messages: [{ from: '1', id: 'x' }] } },
      { field: 'messages', value: { metadata: { phone_number_id: '3333333333' }, messages: [{ from: 'not-digits', id: 'y' }, { from: '15550003', id: 5 }, { from: '15550003' }], statuses: [{ id: 'z' }] } },
    ] }] };
    const r = extractBatches(bad);
    expect(r.batches).toEqual([]); expect(r.skipped).toBe(6);
  });
});

describe('Cloud API adapter', () => {
  const env = loadEnv({ ...base, WHATSAPP_PROVIDER: 'cloud', WHATSAPP_ACCESS_TOKEN: 'token-token-token-token-1234', WHATSAPP_APP_SECRET: SECRET + 'x', WHATSAPP_VERIFY_TOKEN: 'verify-verify-verify' });
  const fakeFetch = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch => (async (url: any, init: any) => { seen.url = String(url); seen.init = init; return new Response(JSON.stringify(body), { status }); }) as any;
  it('sends text and templates in the documented shape, with the token only in the header', async () => {
    const seen: any = {};
    const p = new CloudApiProvider(env, fakeFetch(200, { messages: [{ id: 'wamid.X' }] }, seen));
    expect(await p.send({ to: '15550001', phoneNumberId: '1111111111', kind: 'text', body: 'hello' })).toEqual({ id: 'wamid.X' });
    expect(seen.url).toBe(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/1111111111/messages`);
    expect(seen.init.headers.authorization).toBe('Bearer token-token-token-token-1234');
    expect(JSON.parse(seen.init.body)).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '15550001', type: 'text', text: { preview_url: false, body: 'hello' } });
    expect(seen.init.body).not.toContain('token-token');
    await p.send({ to: '15550001', phoneNumberId: '1111111111', kind: 'template', template: { name: 'rent_reminder_v1', lang: 'en', params: ['Tina', '10 USD'] } });
    expect(JSON.parse(seen.init.body)).toMatchObject({ type: 'template', template: { name: 'rent_reminder_v1', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Tina' }, { type: 'text', text: '10 USD' }] }] } });
  });
  it('classifies failures: window/recipient/template problems are permanent; outages, throttling and auth are retried', async () => {
    const err = (status: number, code?: number) => new CloudApiProvider(env, fakeFetch(status, code ? { error: { code, message: `m${code}` } } : {})).send({ to: '1', phoneNumberId: '1', kind: 'text', body: 'x' });
    await expect(err(400, 131047)).rejects.toMatchObject({ permanent: true, code: '131047' });
    await expect(err(400, 131026)).rejects.toMatchObject({ permanent: true });
    await expect(err(400, 132001)).rejects.toMatchObject({ permanent: true });
    await expect(err(429, 130429)).rejects.toMatchObject({ permanent: false });
    await expect(err(500)).rejects.toMatchObject({ permanent: false });
    await expect(err(401, 190)).rejects.toMatchObject({ permanent: false });
    await expect(err(400, 80007)).rejects.toMatchObject({ permanent: false });
    await expect(new CloudApiProvider(env, (async () => { throw new Error('ECONNRESET'); }) as any).send({ to: '1', phoneNumberId: '1', kind: 'text', body: 'x' })).rejects.toMatchObject({ permanent: false, code: 'network' });
    await expect(new CloudApiProvider(env, fakeFetch(200, {})).send({ to: '1', phoneNumberId: '1', kind: 'text', body: 'x' })).rejects.toBeInstanceOf(WaSendError);
    expect(classify(0, null).permanent).toBe(false);
  });
  it('never leaks the access token in an error', async () => {
    try { await new CloudApiProvider(env, fakeFetch(400, { error: { code: 100, message: 'bad', error_data: { details: 'invalid parameter' } } })).send({ to: '1', phoneNumberId: '1', kind: 'text', body: 'x' }); } catch (e) { expect(String(e)).not.toContain('token-token'); expect((e as Error).message).toBe('invalid parameter'); }
  });
});

describe('link codes and configuration', () => {
  it('hashes codes case-insensitively so typing in lower case still works', () => { expect(hashCode(' abcd2345 ')).toBe(hashCode('ABCD2345')); });
  it('requires the Meta secrets for the real provider and is inert by default', () => {
    expect(() => loadEnv({ ...base, WHATSAPP_PROVIDER: 'cloud' })).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    const e = loadEnv(base); expect(e.WHATSAPP_PROVIDER).toBe('log'); expect(e.WHATSAPP_APP_SECRET).toBeUndefined();
  });
});
