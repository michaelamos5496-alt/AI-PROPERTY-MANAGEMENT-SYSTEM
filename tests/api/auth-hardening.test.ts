import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp({ RATE_LIMIT_AUTH_MAX: '5', RATE_LIMIT_MAX: '100000' }); }, 60_000);
afterAll(() => t.close());

describe('authentication hardening', () => {
  it('slows password guessing per account and per address, with a Retry-After, and does not reveal whether an account exists', async () => {
    const email = `guess-${randomUUID().slice(0, 6)}@test.dev`;
    const c = t.client();
    await c.post('/api/auth/register').send({ email, password: 'correct horse battery', fullName: 'Target' });
    const known = await t.client().post('/api/auth/login').send({ email, password: 'wrong password 123' });
    const unknown = await t.client().post('/api/auth/login').send({ email: `nobody-${randomUUID().slice(0, 6)}@test.dev`, password: 'wrong password 123' });
    expect(known.status).toBe(401); expect(unknown.status).toBe(401);
    expect(known.body.error.message).toBe(unknown.body.error.message);                       // same words for "no such user" and "wrong password"
    const statuses: number[] = []; let last: any;
    for (let i = 0; i < 8; i++) { last = await t.client().post('/api/auth/login').send({ email, password: `guess-${i}-xxxxxxxx` }); statuses.push(last.status); }
    expect(statuses).toContain(429); expect(last.headers['retry-after']).toBeDefined();
    expect((await t.client().post('/api/auth/login').send({ email, password: 'correct horse battery' })).status).toBe(429);   // even the right password waits while limited
  });
  it('recovery always answers the same way, whether or not the address is registered', async () => {
    const a = await t.client().post('/api/auth/recover').set('X-Forwarded-For', '10.1.1.1').send({ email: `real-${randomUUID().slice(0, 6)}@test.dev` });
    const b = await t.client().post('/api/auth/recover').set('X-Forwarded-For', '10.1.1.2').send({ email: `ghost-${randomUUID().slice(0, 6)}@test.dev` });
    expect([a.status, a.body]).toEqual([b.status, b.body]);
  });
  it('rejects weak or oversized credentials before they reach the identity provider', async () => {
    const c = t.client();
    const ip = (n: string) => ({ 'X-Forwarded-For': n });
    expect((await c.post('/api/auth/register').set(ip('10.2.2.1')).send({ email: 'weak@test.dev', password: 'short', fullName: 'x' })).status).toBe(422);
    expect((await c.post('/api/auth/register').set(ip('10.2.2.2')).send({ email: 'big@test.dev', password: 'x'.repeat(500), fullName: 'x' })).status).toBe(422);
    expect((await c.post('/api/auth/register').set(ip('10.2.2.3')).send({ email: 'not-an-email', password: 'correct horse battery', fullName: 'x' })).status).toBe(422);
  });
  it('a tampered or expired session cookie is treated as signed out, never as someone else', async () => {
    const c = t.client();
    for (const cookie of ['pai_at=garbage', 'pai_at=eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.', 'pai_at=; pai_rt=forged-refresh-token', 'pai_at=' + 'a'.repeat(5000)]) {
      const r = await c.get('/api/me').set('Cookie', cookie);
      expect(r.status).toBe(401);
    }
  });
});
