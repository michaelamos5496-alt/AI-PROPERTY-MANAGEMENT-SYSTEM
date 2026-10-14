import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseCookies } from '../../src/lib/cookies.js';
import { loadEnv } from '../../src/lib/env.js';
import { createLogger } from '../../src/lib/logger.js';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { PERMISSIONS, can, hasRole, ROLES } from '../../src/lib/roles.js';
import { orgName, password, validate } from '../../src/lib/validate.js';
import { errorHandler } from '../../src/middleware/errors.js';
import { z } from 'zod';

const good = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'x'.repeat(30) };

describe('env validation', () => {
  it('applies defaults', () => {
    const env = loadEnv(good);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });
  it('lists every problem and never echoes values', () => {
    expect(() => loadEnv({ SUPABASE_URL: 'nope', SUPABASE_ANON_KEY: 'short-secret' })).toThrow(/SUPABASE_URL[\s\S]*SUPABASE_ANON_KEY/);
    try { loadEnv({ SUPABASE_URL: 'nope', SUPABASE_ANON_KEY: 'short-secret' }); } catch (e) {
      expect(String(e)).not.toContain('short-secret');
    }
  });
  it('requires https APP_URL in production', () => {
    expect(() => loadEnv({ ...good, NODE_ENV: 'production', APP_URL: 'http://example.com' })).toThrow(/https/);
    expect(loadEnv({ ...good, NODE_ENV: 'production', APP_URL: 'https://example.com' }).APP_URL).toBe('https://example.com');
  });
});

describe('roles', () => {
  it('orders roles owner > admin > manager > staff > viewer', () => {
    for (let i = 0; i < ROLES.length; i++) for (let j = 0; j < ROLES.length; j++)
      expect(hasRole(ROLES[i]!, ROLES[j]!)).toBe(i <= j);
  });
  it('maps permissions to minimum roles', () => {
    expect(can('viewer', 'org:read')).toBe(true);
    expect(can('manager', 'members:manage')).toBe(false);
    expect(can('admin', 'members:manage')).toBe(true);
    expect(Object.keys(PERMISSIONS).length).toBeGreaterThan(3);
  });
});

describe('validation helpers', () => {
  it('enforces password length and org name bounds', () => {
    expect(password.safeParse('short').success).toBe(false);
    expect(password.safeParse('long enough password').success).toBe(true);
    expect(orgName.safeParse(' A ').success).toBe(false);
    expect(orgName.parse('  Acme  ')).toBe('Acme');
  });
  it('parses cookies defensively', () => {
    expect(parseCookies('a=1; b=hello%20world; bad=%E0%A4%A; =x')).toEqual({ a: '1', b: 'hello world' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('rate limiter', () => {
  const build = (now: () => number) => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimit({ name: 't', windowSeconds: 10, max: 2, now }));
    app.get('/', (_q, r) => void r.json({ ok: true }));
    app.use(errorHandler);
    return app;
  };
  it('blocks after the limit with Retry-After, then recovers', async () => {
    let t = 1_000_000;
    const app = build(() => t);
    expect((await supertest(app).get('/')).status).toBe(200);
    expect((await supertest(app).get('/')).status).toBe(200);
    const blocked = await supertest(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    t += 11_000;
    expect((await supertest(app).get('/')).status).toBe(200);
  });
  it('tracks clients independently', async () => {
    const app = build(() => 5);
    for (let i = 0; i < 3; i++) await supertest(app).get('/').set('X-Forwarded-For', '1.1.1.1');
    expect((await supertest(app).get('/').set('X-Forwarded-For', '2.2.2.2')).status).toBe(200);
  });
});

describe('logger', () => {
  it('emits JSON and redacts sensitive keys', () => {
    const lines: string[] = [];
    const log = createLogger('info', {}, (l) => lines.push(l)).child({ requestId: 'r1' });
    log.info('hello', { password: 'hunter2', nested: { access_token: 'abc' }, ok: 1 });
    log.debug('hidden');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', requestId: 'r1', ok: 1, password: '[redacted]' });
    expect(rec.nested.access_token).toBe('[redacted]');
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('validate() and error handler', () => {
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => { req.id = 'test-id'; next(); });
  app.post('/x', validate({ body: z.object({ n: z.number().int() }) }), (req, res) => void res.json(req.body));
  app.get('/boom', () => { throw new Error('secret db password leaked'); });
  app.use(errorHandler);

  it('returns structured 422 with field details', async () => {
    const r = await supertest(app).post('/x').send({ n: 'a' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'validation_failed', requestId: 'test-id' });
    expect(r.body.error.details[0]).toMatchObject({ in: 'body', path: 'n' });
  });
  it('strips unknown keys', async () => {
    expect((await supertest(app).post('/x').send({ n: 1, admin: true })).body).toEqual({ n: 1 });
  });
  it('hides internal error details', async () => {
    const r = await supertest(app).get('/boom');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
    expect(r.body.error.code).toBe('internal_error');
  });
  it('reports malformed JSON as 400', async () => {
    const r = await supertest(app).post('/x').set('content-type', 'application/json').send('{bad');
    expect(r.status).toBe(400);
  });
});
