import type { Request, Response } from 'express';
import type { Env } from './env.js';

export const ACCESS_COOKIE = 'pai_at';
export const REFRESH_COOKIE = 'pai_rt';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (header ?? '').split(';')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { /* ignore malformed */ }
  }
  return out;
}

export interface Session { access_token: string; refresh_token: string; expires_in: number }

/** HttpOnly session cookies: tokens are never readable by page scripts. */
export function setSessionCookies(res: Response, env: Env, s: Session): void {
  const base = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const };
  res.cookie(ACCESS_COOKIE, s.access_token, { ...base, path: '/', maxAge: s.expires_in * 1000 });
  res.cookie(REFRESH_COOKIE, s.refresh_token, { ...base, path: '/api/auth', maxAge: env.SESSION_DAYS * 86_400_000 });
}

export function clearSessionCookies(res: Response, env: Env): void {
  const base = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const };
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });
}

export const readCookies = (req: Request) => parseCookies(req.headers.cookie);
