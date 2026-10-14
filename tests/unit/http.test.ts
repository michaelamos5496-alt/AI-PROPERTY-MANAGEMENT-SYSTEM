import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(() => t.close());

describe('request ids', () => {
  it('generates one when absent and echoes a valid inbound one', async () => {
    const a = await supertest(t.app).get('/api/health');
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const b = await supertest(t.app).get('/api/health').set('X-Request-Id', 'client-req-12345');
    expect(b.headers['x-request-id']).toBe('client-req-12345');
  });
  it('rejects unsafe inbound ids (log injection)', async () => {
    const r = await supertest(t.app).get('/api/health').set('X-Request-Id', 'bad id\twith spaces');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('includes the id in error bodies', async () => {
    const r = await supertest(t.app).get('/api/nope'); // anonymous callers can't probe routes
    expect(r.status).toBe(401);
    expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
  });
});

describe('CSRF guard and headers', () => {
  it('blocks cross-origin state changes', async () => {
    const r = await supertest(t.app).post('/api/auth/logout').set('Origin', 'https://evil.example').send({});
    expect(r.status).toBe(403);
  });
  it('allows the configured app origin', async () => {
    const r = await supertest(t.app).post('/api/auth/logout').set('Origin', 'http://localhost:3000').send({});
    expect(r.status).toBe(200);
  });
  it('rejects non-JSON bodies on writes', async () => {
    const r = await supertest(t.app).post('/api/auth/login').type('form').send('email=a@b.co&password=x');
    expect(r.status).toBe(400);
  });
  it('sets security headers and disables caching of API responses', async () => {
    const r = await supertest(t.app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('input validation on auth endpoints', () => {
  it('rejects weak passwords and invalid emails with 422', async () => {
    const r = await supertest(t.app).post('/api/auth/register').send({ email: 'not-an-email', password: 'short' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.map((d: any) => d.path).sort()).toEqual(['email', 'password']);
  });
});

describe('auth rate limiting', () => {
  it('throttles repeated login attempts per IP and per target email', async () => {
    const lim = await startTestApp({ RATE_LIMIT_AUTH_MAX: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await lim.client().post('/api/auth/login').send({ email: 'victim@test.dev', password: `wrong-${i}` })).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      // a different IP is still bucketed by the target email
      const other = await lim.client().post('/api/auth/login').set('X-Forwarded-For', '9.9.9.9')
        .send({ email: 'victim@test.dev', password: 'wrong-again' });
      expect(other.status).toBe(429);
    } finally { await lim.close(); }
  });
});

describe('email confirmation mode', () => {
  it('requires confirmation, blocks login until confirmed, then signs in via the link', async () => {
    const c = await startTestApp({}, { confirmEmails: true });
    try {
      const r = await c.client().post('/api/auth/register').send({ email: 'new@test.dev', password: 'correct horse battery' });
      expect(r.status).toBe(202);
      expect(r.body.needsConfirmation).toBe(true);
      const early = await c.client().post('/api/auth/login').send({ email: 'new@test.dev', password: 'correct horse battery' });
      expect(early.status).toBe(401);
      expect(early.body.error.message).toMatch(/confirm/i);
      const agent = c.client();
      const link = await agent.get(`/api/auth/confirm?token_hash=${c.mock.lastToken('new@test.dev', 'signup')}&type=signup`);
      expect(link.headers.location).toBe('/app');
      expect((await agent.get('/api/me')).status).toBe(200);
    } finally { await c.close(); }
  });
});
