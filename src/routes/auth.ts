import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import { clearSessionCookies, readCookies, setSessionCookies, ACCESS_COOKIE } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import { email, password, validate } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthApi } from '../services/supabase.js';

export function authRoutes(env: Env, auth: AuthApi): Router {
  const r = Router();
  const window = env.RATE_LIMIT_WINDOW_SECONDS;
  // Two buckets: per client IP, and per target email (stops distributed guessing of one account).
  const byIp = rateLimit({ name: 'auth-ip', windowSeconds: window, max: env.RATE_LIMIT_AUTH_MAX });
  const byEmail = rateLimit({
    name: 'auth-email', windowSeconds: window, max: env.RATE_LIMIT_AUTH_MAX,
    key: (req) => String(req.body?.email ?? 'none').toLowerCase(),
  });

  r.post('/register', byIp, validate({
    body: z.object({ email, password, fullName: z.string().trim().max(120).default('') }),
  }), byEmail, async (req, res) => {
    const { email, password, fullName } = req.body;
    const session = await auth.signUp(email, password, fullName);
    if (!session) return void res.status(202).json({ needsConfirmation: true });
    setSessionCookies(res, env, session);
    res.status(201).json({ needsConfirmation: false });
  });

  r.post('/login', byIp, validate({ body: z.object({ email, password: z.string().min(1).max(128) }) }), byEmail,
    async (req, res) => {
      try {
        setSessionCookies(res, env, await auth.signIn(req.body.email, req.body.password));
      } catch (e) {
        if (e instanceof AppError && e.status >= 400 && e.status < 500 && e.status !== 429) {
          const unconfirmed = /not confirmed/i.test(e.message);
          throw AppError.unauthenticated(unconfirmed ? 'Confirm your email address before signing in.' : 'Incorrect email or password.');
        }
        throw e;
      }
      res.json({ ok: true });
    });

  r.post('/logout', async (req, res) => {
    const token = readCookies(req)[ACCESS_COOKIE];
    if (token) await auth.signOut(token).catch((e) => req.log.warn('signout failed', { error: String(e) }));
    clearSessionCookies(res, env);
    res.json({ ok: true });
  });

  // Always answers 202 so the endpoint cannot be used to discover registered addresses.
  r.post('/recover', byIp, validate({ body: z.object({ email }) }), byEmail, async (req, res) => {
    try { await auth.recover(req.body.email); }
    catch (e) {
      if (e instanceof AppError && e.status === 429) throw e;
      req.log.warn('recover failed', { error: String(e) });
    }
    res.status(202).json({ ok: true });
  });

  // Target of the links in Supabase's confirmation / recovery emails (see docs/SETUP.md).
  r.get('/confirm', byIp, validate({
    query: z.object({ token_hash: z.string().min(8).max(512), type: z.enum(['recovery', 'signup', 'email']) }),
  }), async (req, res) => {
    const { token_hash, type } = req.query as unknown as { token_hash: string; type: string };
    try {
      setSessionCookies(res, env, await auth.verifyOtp(token_hash, type));
    } catch {
      return void res.redirect(303, '/login?error=link_expired');
    }
    res.redirect(303, type === 'recovery' ? '/reset-password' : '/app');
  });

  r.post('/password', byIp, requireAuth(env, auth), validate({ body: z.object({ password }) }), async (req, res) => {
    await auth.updatePassword(req.auth!.token, req.body.password);
    res.json({ ok: true });
  });

  return r;
}
