import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { as, createTestDb } from './db.js';

export const MOCK_ANON_KEY = 'mock-anon-key-0123456789abcdef';
export const MOCK_SERVICE_KEY = 'mock-service-key-0123456789abcdef';

interface Options { port?: number; confirmEmails?: boolean }

/**
 * Local stand-in for Supabase: a GoTrue stub for sign-up/sign-in/recovery plus a
 * PostgREST-style /rest/v1/rpc endpoint that executes against a REAL Postgres
 * (PGlite) with our actual migrations, as the `authenticated` role with JWT claims.
 * Row Level Security and the SQL permission checks are therefore genuinely exercised.
 */
export async function startMockSupabase(opts: Options = {}) {
  const db: PGlite = await createTestDb();
  const users = new Map<string, { id: string; password: string }>();
  const access = new Map<string, { id: string; email: string }>();
  const refresh = new Map<string, { id: string; email: string }>();
  const otps = new Map<string, { email: string; type: string }>();
  const sent: { email: string; type: string; tokenHash: string }[] = [];
  let queue: Promise<unknown> = Promise.resolve(); // PGlite is single-connection

  const issue = (id: string, email: string) => {
    const a = `at-${randomUUID()}`, r = `rt-${randomUUID()}`;
    access.set(a, { id, email });
    refresh.set(r, { id, email });
    return { access_token: a, refresh_token: r, expires_in: 3600, token_type: 'bearer', user: { id, email, email_confirmed_at: new Date().toISOString() } };
  };
  const send = (email: string, type: string) => {
    const tokenHash = `th-${randomUUID()}`;
    otps.set(tokenHash, { email, type });
    sent.push({ email, type, tokenHash });
  };

  async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString();
    return t ? JSON.parse(t) : {};
  }
  const bearer = (req: IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

  const objects = new Map<string, { body: Buffer; contentType: string }>(); // `${bucket}/${path}`
  const uploadTokens = new Map<string, { key: string; actor: { sub: string; email: string } }>();
  const downloadTokens = new Map<string, string>();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return void res.end(); }
    const jsonOut = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    const sp = url.pathname.match(/^\/storage\/v1\/object\/(upload\/sign|sign|info)\/([^/]+)\/(.+)$/);
    if (sp) {
      const [, kind, bucket, rawPath] = sp as unknown as [string, string, string, string];
      const path = decodeURIComponent(rawPath);
      const key = `${bucket}/${path}`;
      const token = url.searchParams.get('token');
      try {
        // Token-bearing requests (what the browser makes directly) carry no API key.
        if (kind === 'upload/sign' && req.method === 'PUT') {
          const t = token && uploadTokens.get(token);
          if (!t || t.key !== key) return jsonOut(403, { error: 'Unauthorized', message: 'invalid token', statusCode: '403' });
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = Buffer.concat(chunks);
          const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!;
          const b = (await db.query<any>(`select file_size_limit, allowed_mime_types from storage.buckets where id=$1`, [bucket])).rows[0];
          if (body.length > b.file_size_limit) return jsonOut(413, { error: 'Payload too large', statusCode: '413' });
          if (!b.allowed_mime_types.includes(contentType)) return jsonOut(415, { error: 'invalid_mime_type', statusCode: '415' });
          try {  // the real storage INSERT policy decides, as the token's owner
            await queue.then(() => as(db, t.actor, (q) => q(`insert into storage.objects (bucket_id, name, owner) values ($1,$2,$3)`, [bucket, path, t.actor.sub])));
          } catch { return jsonOut(403, { error: 'Unauthorized', message: 'new row violates row-level security policy', statusCode: '403' }); }
          uploadTokens.delete(token!);
          objects.set(key, { body, contentType });
          return jsonOut(200, { Key: key });
        }
        if (kind === 'sign' && req.method === 'GET') {
          const f = token && downloadTokens.get(token) === key ? objects.get(key) : undefined;
          if (!f) return jsonOut(400, { error: 'InvalidJWT', message: 'invalid or expired token', statusCode: '400' });
          const dl = url.searchParams.get('download'); // real Storage turns this into Content-Disposition
          res.writeHead(200, { 'content-type': f.contentType, 'content-length': f.body.length, ...cors,
            ...(dl !== null ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(dl)}` } : {}) });
          return void res.end(f.body);
        }
        // Authenticated storage calls
        if (req.headers.apikey !== MOCK_ANON_KEY) return jsonOut(401, { message: 'No API key found' });
        const s = access.get(bearer(req));
        if (!s) return jsonOut(401, { error: 'Unauthorized', message: 'invalid JWT', statusCode: '401' });
        const actor = { sub: s.id, email: s.email };
        const visible = async () => (await queue.then(() => as(db, actor, (q) =>
          q(`select 1 from storage.objects where bucket_id=$1 and name=$2`, [bucket, path])))).rows.length > 0 && objects.has(key);
        if (kind === 'upload/sign' && req.method === 'POST') {
          const t = `up-${randomUUID()}`;
          uploadTokens.set(t, { key, actor });
          return jsonOut(200, { url: `/object/upload/sign/${bucket}/${rawPath}?token=${t}` });
        }
        if (kind === 'sign' && req.method === 'POST') {
          if (!(await visible())) return jsonOut(400, { error: 'not_found', message: 'Object not found', statusCode: '404' });
          const t = `dl-${randomUUID()}`;
          downloadTokens.set(t, key);
          return jsonOut(200, { signedURL: `/object/sign/${bucket}/${rawPath}?token=${t}` });
        }
        if (kind === 'info' && req.method === 'GET') {
          if (!(await visible())) return jsonOut(400, { error: 'not_found', message: 'Object not found', statusCode: '404' });
          const f = objects.get(key)!;
          return jsonOut(200, { name: path, size: f.body.length, contentType: f.contentType });
        }
      } catch (e: any) { return jsonOut(500, { message: String(e?.message ?? e) }); }
      return jsonOut(404, { message: 'not found' });
    }
    const send_ = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.apikey !== MOCK_ANON_KEY && req.headers.apikey !== MOCK_SERVICE_KEY) return send_(401, { message: 'No API key found' });
      const p = url.pathname;
      const body = req.method === 'GET' ? {} : await readBody(req);

      if (p === '/auth/v1/signup') {
        const email = String(body.email).toLowerCase();
        if (users.has(email)) return send_(200, { id: users.get(email)!.id, email }); // obfuscated, like GoTrue
        const row = await queue.then(() => db.query<{ id: string }>(
          `insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1,$2::jsonb,$3) returning id`,
          [email, JSON.stringify(body.data ?? {}), opts.confirmEmails ? null : new Date().toISOString()]));
        const id = row.rows[0]!.id;
        users.set(email, { id, password: body.password });
        if (opts.confirmEmails) { send(email, 'signup'); return send_(200, { id, email }); }
        return send_(200, issue(id, email));
      }
      if (p === '/auth/v1/token') {
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          const s = refresh.get(body.refresh_token);
          if (!s) return send_(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
          refresh.delete(body.refresh_token);
          return send_(200, issue(s.id, s.email));
        }
        const email = String(body.email).toLowerCase();
        const u = users.get(email);
        if (!u || u.password !== body.password) return send_(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        const confirmed = (await db.query<{ c: boolean }>(`select email_confirmed_at is not null c from auth.users where id=$1`, [u.id])).rows[0]!.c;
        if (!confirmed) return send_(400, { error: 'invalid_grant', error_description: 'Email not confirmed' });
        return send_(200, issue(u.id, email));
      }
      if (p === '/auth/v1/user') {
        const s = access.get(bearer(req));
        if (!s) return send_(401, { msg: 'invalid JWT' });
        if (req.method === 'PUT') { users.get(s.email)!.password = body.password; }
        return send_(200, { id: s.id, email: s.email });
      }
      if (p === '/auth/v1/logout') {
        const t = bearer(req);
        const s = access.get(t);
        access.delete(t);
        if (s) for (const [k, v] of refresh) if (v.id === s.id) refresh.delete(k);
        return send_(204, null);
      }
      if (p === '/auth/v1/recover') {
        const email = String(body.email).toLowerCase();
        if (users.has(email)) send(email, 'recovery');
        return send_(200, {});
      }
      if (p === '/auth/v1/verify') {
        const o = otps.get(body.token_hash);
        if (!o) return send_(403, { msg: 'Email link is invalid or has expired' });
        otps.delete(body.token_hash);
        const u = users.get(o.email)!;
        await queue.then(() => db.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id=$1`, [u.id]));
        return send_(200, issue(u.id, o.email));
      }
      if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.slice('/rest/v1/rpc/'.length);
        const isService = bearer(req) === MOCK_SERVICE_KEY && req.headers.apikey === MOCK_SERVICE_KEY;
        const s = access.get(bearer(req));
        const actor: any = isService ? { service: true } : s ? { sub: s.id, email: s.email } : null;
        const keys = Object.keys(body);
        const sql = `select public.${fn.replace(/[^a-z0-9_]/g, '')}(${keys.map((k, i) => `${k.replace(/[^a-z0-9_]/g, '')} => $${i + 1}`).join(', ')}) as r`;
        const params = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
        const run = queue.then(() => as(db, actor, async (q) => (await q(sql, params)).rows[0].r));
        queue = run.catch(() => undefined);
        try { return send_(200, await run); }
        catch (e: any) {
          const code = String(e.code ?? '');
          const status = /^PT\d{3}$/.test(code) ? Number(code.slice(2)) : code === '42501' ? (actor ? 403 : 401)
            : code === '23505' || code === '23503' ? 409 : 400;  // PostgREST's mapping
          return send_(status, { code, message: e.message });
        }
      }
      send_(404, { message: 'not found' });
    } catch (e: any) {
      send_(500, { message: String(e?.message ?? e) });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    anonKey: MOCK_ANON_KEY,
    serviceKey: MOCK_SERVICE_KEY,
    db,
    sent,
    /** Last emailed token hash for an address/type (simulates opening the email link). */
    lastToken: (email: string, type: string) => [...sent].reverse().find((s) => s.email === email && s.type === type)?.tokenHash,
    objects,
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}
export type MockSupabase = Awaited<ReturnType<typeof startMockSupabase>>;
