import type { RequestHandler } from 'express';
import type { Env } from '../lib/env.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearSessionCookies, readCookies, setSessionCookies } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';
import { hasRole, isRole, type Role } from '../lib/roles.js';
import type { AuthApi, DataApi } from '../services/supabase.js';
import { uuid } from '../lib/validate.js';

/**
 * Authenticates from the HttpOnly session cookies. An expired access token is
 * transparently renewed with the refresh token.
 */
export function requireAuth(env: Env, auth: AuthApi): RequestHandler {
  return async (req, res, next) => {
    try {
      const cookies = readCookies(req);
      let token = cookies[ACCESS_COOKIE];
      if (token) {
        try {
          const user = await auth.getUser(token);
          req.auth = { token, user: { id: user.id, email: user.email } };
          return next();
        } catch (e) {
          if (!(e instanceof AppError) || e.status !== 401) throw e;
        }
      }
      const refresh = cookies[REFRESH_COOKIE];
      if (!refresh) throw AppError.unauthenticated();
      let session;
      try { session = await auth.refresh(refresh); }
      catch (e) {
        if (e instanceof AppError && e.status < 500) { clearSessionCookies(res, env); throw AppError.unauthenticated(); }
        throw e;
      }
      setSessionCookies(res, env, session);
      token = session.access_token;
      req.auth = { token, user: { id: session.user.id, email: session.user.email } };
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Loads the caller's role in `:orgId` and enforces a minimum. Non-members receive
 * 404 (not 403) so organization IDs cannot be enumerated. The database re-checks
 * the same rule on every call, so this is a fast-fail, not the only barrier.
 */
export function requireOrgRole(data: DataApi, minimum: Role): RequestHandler {
  return async (req, _res, next) => {
    try {
      const id = uuid.safeParse(req.params.orgId);
      if (!id.success) throw AppError.notFound('Organization not found.');
      const org = await data.rpc<{ role: string }>(req.auth!.token, 'get_organization', { p_org: id.data });
      if (!isRole(org.role)) throw AppError.forbidden();
      if (!hasRole(org.role, minimum)) throw AppError.forbidden();
      req.org = { id: id.data, role: org.role };
      next();
    } catch (e) { next(e); }
  };
}
