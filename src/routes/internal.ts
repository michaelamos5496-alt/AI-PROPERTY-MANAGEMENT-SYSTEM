import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { Logger } from '../lib/logger.js';
import { runScheduledJobs } from '../jobs/runner.js';
import type { EmailProvider } from '../services/email.js';
import type { ServiceApi } from '../services/supabase.js';
import { runWhatsApp, type WaRuntime } from '../whatsapp/worker.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Machine-to-machine endpoint for the scheduler (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; a GitHub Actions
 * schedule can do the same). It is not reachable with a user session, and refuses to run unless both secrets are configured.
 */
export function internalRoutes(env: Env, service: ServiceApi, provider: EmailProvider, log: Logger, wa?: WaRuntime): Router {
  const r = Router();
  r.use(rateLimit({ name: 'internal', windowSeconds: 60, max: env.RATE_LIMIT_INTERNAL_MAX }));
  r.all('/jobs/run', async (req, res) => {
    if (!env.CRON_SECRET || !service.configured) throw new AppError(503, 'upstream_error', 'Scheduled jobs are not configured.');
    const given = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(digest(given), digest(env.CRON_SECRET))) throw AppError.unauthenticated('Invalid job credentials.');
    const only = req.query.only === 'jobs' || req.query.only === 'email' ? req.query.only : undefined;
    const result = await runScheduledJobs(service, provider, log, { appUrl: env.APP_URL, batchSize: env.EMAIL_BATCH_SIZE, only });
    const whatsapp = wa && only !== 'jobs' && only !== 'email' ? await runWhatsApp(wa) : undefined;
    if (whatsapp) result.errors.push(...whatsapp.errors.map((e) => `whatsapp ${e}`));
    // A failing job must be visible to the scheduler, not silently swallowed.
    res.status(result.errors.length ? 500 : 200).json({ ok: result.errors.length === 0, ...result, ...(whatsapp ? { whatsapp } : {}) });
  });
  return r;
}
