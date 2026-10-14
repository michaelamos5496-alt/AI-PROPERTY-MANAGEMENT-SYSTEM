import type { RequestHandler } from 'express';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defence in depth on top of SameSite=Lax cookies: state-changing requests must be
 * same-origin (Origin header) and any body must be JSON, which browsers cannot send
 * cross-site without a CORS preflight (which we never approve).
 */
export function csrfGuard(env: Env): RequestHandler {
  const allowed = new Set([new URL(env.APP_URL).host]);
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid */ }
      if (host !== req.get('host') && !allowed.has(host)) return next(AppError.forbidden('Cross-origin request blocked.'));
    }
    const hasBody = (req.headers['content-length'] ?? '0') !== '0' || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !req.is('application/json')) return next(AppError.badRequest('Content-Type must be application/json.'));
    next();
  };
}
