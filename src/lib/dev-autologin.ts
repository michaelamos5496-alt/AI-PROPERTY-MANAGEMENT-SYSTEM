import type { RequestHandler } from 'express';
import type { Env } from './env.js';

/**
 * LOCAL DEVELOPMENT CONVENIENCE: skip typing a password.
 *
 * This is NOT an authentication bypass. It performs the normal sign-in for one real account (whose email and password you put in your
 * own .env) and hands the browser the normal session cookies, so Supabase still authenticates you and row level security still applies.
 *
 * It can only exist in the local dev server (src/dev.ts). The deployed function (api/index.ts) does not import this file, and loadEnv refuses
 * to start at all if the variables are set in production, on Vercel, or with a non-local APP_URL. The dev server also binds to 127.0.0.1 when it is on.
 */
export function devAutoLogin(env: Env, f: typeof fetch = fetch): RequestHandler | null {
  if (!env.DEV_AUTO_LOGIN_EMAIL || !env.DEV_AUTO_LOGIN_PASSWORD) return null;
  if (env.NODE_ENV === 'production' || process.env.VERCEL) throw new Error('DEV_AUTO_LOGIN is not allowed in production');
  const self = `http://127.0.0.1:${env.PORT}`;
  return async (req, res, next) => {
    if (req.method !== 'GET' || (req.path !== '/' && req.path !== '/login')) return next();
    if (req.path === '/' && /\bpai_at=/.test(req.headers.cookie ?? '')) return next();     // already signed in
    try {
      const r = await f(`${self}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.DEV_AUTO_LOGIN_EMAIL, password: env.DEV_AUTO_LOGIN_PASSWORD }) });
      if (!r.ok) return next();                                                             // wrong dev credentials: show the normal login page
      for (const c of r.headers.getSetCookie()) res.append('set-cookie', c);
      res.redirect(303, '/app');
    } catch { next(); }
  };
}
