import type { Env } from '../lib/env.js';
import { AppError, fromUpstream } from '../lib/errors.js';
import type { Session } from '../lib/cookies.js';

type Fetch = typeof fetch;

export interface AuthUser { id: string; email: string; email_confirmed_at?: string | null }
export interface SessionResult extends Session { user: AuthUser }

async function call(f: Fetch, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError(502, 'upstream_error', 'The service is temporarily unavailable.');
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    let msg = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? 'Request failed.';
    // Raw Postgres integrity errors name tables and constraints; never show those to clients.
    if (res.status === 400 && /^2[23]/.test(String(body?.code ?? ''))) msg = 'Some of the submitted values are not valid.';
    throw fromUpstream(res.status, String(msg));
  }
  return body;
}

/** GoTrue (Supabase Auth) REST client. Uses only the public anon key. */
export class AuthApi {
  constructor(private env: Env, private f: Fetch = fetch) {}

  private req(path: string, init: RequestInit = {}, token?: string) {
    return call(this.f, `${this.env.SUPABASE_URL}/auth/v1${path}`, {
      ...init,
      headers: {
        apikey: this.env.SUPABASE_ANON_KEY,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  async signUp(email: string, password: string, fullName: string): Promise<SessionResult | null> {
    const body: any = await this.req('/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, data: { full_name: fullName } }),
    });
    return body?.access_token ? (body as SessionResult) : null; // null => email confirmation required
  }

  signIn(email: string, password: string) {
    return this.req('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }) as Promise<SessionResult>;
  }

  refresh(refreshToken: string) {
    return this.req('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) }) as Promise<SessionResult>;
  }

  /** Authoritative token check (also catches revoked sessions). */
  getUser(token: string) {
    return this.req('/user', {}, token) as Promise<AuthUser>;
  }

  async signOut(token: string) {
    await this.req('/logout', { method: 'POST' }, token);
  }

  async recover(email: string) {
    const redirect = encodeURIComponent(`${this.env.APP_URL}/api/auth/confirm`);
    await this.req(`/recover?redirect_to=${redirect}`, { method: 'POST', body: JSON.stringify({ email }) });
  }

  verifyOtp(tokenHash: string, type: string) {
    return this.req('/verify', { method: 'POST', body: JSON.stringify({ token_hash: tokenHash, type }) }) as Promise<SessionResult>;
  }

  async updatePassword(token: string, password: string) {
    await this.req('/user', { method: 'PUT', body: JSON.stringify({ password }) }, token);
  }
}

/** PostgREST RPC client. Always acts as the signed-in user, so Postgres RLS applies. */
export class DataApi {
  constructor(private env: Env, private f: Fetch = fetch) {}

  rpc<T = unknown>(token: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    return call(this.f, `${this.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    }) as Promise<T>;
  }
}

export const LEASE_BUCKET = 'lease-documents';
export const MAINTENANCE_BUCKET = 'maintenance-attachments';
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Supabase Storage client. Always acts as the signed-in user so storage RLS applies. */
export class StorageApi {
  constructor(private env: Env, private f: Fetch = fetch) {}
  private base = () => `${this.env.SUPABASE_URL}/storage/v1`;
  private headers = (token: string) => ({
    apikey: this.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json',
  });

  /** One-time upload capability for exactly one registered path. */
  async signUpload(token: string, path: string, bucket = LEASE_BUCKET): Promise<string> {
    const body: any = await call(this.f, `${this.base()}/object/upload/sign/${bucket}/${encodePath(path)}`, {
      method: 'POST', headers: this.headers(token), body: '{}',
    });
    return `${this.base()}${body.url}`;
  }

  /** Short-lived download URL. Callers must have authorized the document first. */
  async signDownload(token: string, path: string, fileName: string, seconds = 60, bucket = LEASE_BUCKET): Promise<string> {
    const body: any = await call(this.f, `${this.base()}/object/sign/${bucket}/${encodePath(path)}`, {
      method: 'POST', headers: this.headers(token), body: JSON.stringify({ expiresIn: seconds }),
    });
    const url = `${this.base()}${body.signedURL}`;
    return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
  }

  /** Server-verified size/type of an uploaded object, or null if it isn't there. */
  async info(token: string, path: string, bucket = LEASE_BUCKET): Promise<{ size: number; contentType: string } | null> {
    try {
      const b: any = await call(this.f, `${this.base()}/object/info/${bucket}/${encodePath(path)}`, { headers: this.headers(token) });
      const size = Number(b?.size ?? b?.metadata?.size);
      const contentType = String(b?.contentType ?? b?.content_type ?? b?.metadata?.mimetype ?? '');
      return Number.isFinite(size) ? { size, contentType } : null;
    } catch (e) {
      if (e instanceof AppError && (e.status === 404 || e.status === 400 || e.status === 403)) return null;
      throw e;
    }
  }
}

/**
 * Service-role client for the background worker only (scheduled jobs and email delivery). It bypasses row-level security, so it
 * may only call the narrow SECURITY DEFINER functions that were granted to `service_role`. It is never used on behalf of a user.
 */
export class ServiceApi {
  constructor(private env: Env, private f: Fetch = fetch) {}
  get configured() { return !!this.env.SUPABASE_SERVICE_ROLE_KEY; }
  rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new AppError(503, 'upstream_error', 'Background jobs are not configured (SUPABASE_SERVICE_ROLE_KEY).');
    return call(this.f, `${this.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
    }) as Promise<T>;
  }
}
