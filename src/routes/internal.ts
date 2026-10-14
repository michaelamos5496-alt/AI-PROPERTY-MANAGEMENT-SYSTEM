import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import type { Logger } from '../lib/logger.js';
import { runScheduledJobs } from '../jobs/runner.js';
import type { EmailProvider } from '../services/email.js';
import type { ServiceApi } from '../services/supabase.js';
import { runBilling } from '../billing/runtime.js';
import type { BillingProvider } from '../billing/provider.js';
import { z } from 'zod';
import { runWhatsApp, type WaRuntime } from '../whatsapp/worker.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Machine-to-machine endpoint for the scheduler (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; a GitHub Actions
 * schedule can do the same). It is not reachable with a user session, and refuses to run unless both secrets are configured.
 */
export function internalRoutes(env: Env, service: ServiceApi, provider: EmailProvider, log: Logger, wa?: WaRuntime, bill?: BillingProvider | null): Router {
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
    const billing = only === 'jobs' || only === 'email' ? undefined : await runBilling(service, bill ?? null, log);
    if (billing) result.errors.push(...billing.errors.map((e) => `billing ${e}`));
    // A failing job must be visible to the scheduler, not silently swallowed.
    res.status(result.errors.length ? 500 : 200).json({ ok: result.errors.length === 0, ...result, ...(whatsapp ? { whatsapp } : {}), ...(billing ? { billing } : {}) });
  });

  // Operator actions (not reachable with a user session): assign a plan by hand, set an exception. Same credential as the scheduler.
  const operator = (req: import('express').Request) => {
    if (!env.CRON_SECRET || !service.configured) throw new AppError(503, 'upstream_error', 'Operator actions are not configured.');
    const given = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(digest(given), digest(env.CRON_SECRET))) throw AppError.unauthenticated('Invalid operator credentials.');
  };
  r.post('/billing/assign', async (req, res) => {
    operator(req);
    const b = z.object({ orgId: z.string().uuid(), plan: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']).default('active'), periodEnd: z.string().datetime().nullable().default(null), reason: z.string().min(3).max(300) }).strict().parse(req.body);
    res.json(await service.rpc('billing_svc_assign', { p_org: b.orgId, p_plan: b.plan, p_status: b.status, p_period_end: b.periodEnd, p_reason: b.reason }));
  });
  r.post('/billing/override', async (req, res) => {
    operator(req);
    const b = z.object({ orgId: z.string().uuid(), key: z.string().regex(/^[a-z_]{2,40}$/), enabled: z.boolean().default(true), limit: z.number().int().min(0).nullable().default(null), reason: z.string().min(3).max(300), expiresAt: z.string().datetime().nullable().default(null) }).strict().parse(req.body);
    res.json(await service.rpc('billing_svc_set_override', { p_org: b.orgId, p_key: b.key, p_enabled: b.enabled, p_limit: b.limit, p_reason: b.reason, p_expires_at: b.expiresAt }));
  });
  return r;
}
