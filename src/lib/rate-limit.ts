import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

export interface RateLimitOptions {
  windowSeconds: number;
  max: number;
  /** Bucket name; limiters with different names never share counters. */
  name: string;
  key?: (req: Parameters<RequestHandler>[0]) => string;
  now?: () => number;
}

/**
 * Fixed-window in-memory limiter.
 * NOTE: state is per serverless instance, so on Vercel this is a best-effort
 * brake against bursts, not a global guarantee. Swap `hits` for a shared store
 * (e.g. Upstash Redis) before relying on it for abuse prevention.
 */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? Date.now;
  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const key = `${opts.name}:${opts.key ? opts.key(req) : req.ip ?? 'unknown'}`;
    let h = hits.get(key);
    if (!h || h.resetAt <= t) hits.set(key, (h = { count: 0, resetAt: t + opts.windowSeconds * 1000 }));
    h.count += 1;
    const remaining = Math.max(0, opts.max - h.count);
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    if (h.count > opts.max) {
      const retry = Math.max(1, Math.ceil((h.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retry));
      return next(AppError.rateLimited(retry));
    }
    next();
  };
}
