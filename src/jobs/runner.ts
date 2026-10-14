import { randomUUID } from 'node:crypto';
import type { Logger } from '../lib/logger.js';
import type { EmailProvider } from '../services/email.js';
import { SendError } from '../services/email.js';
import type { ServiceApi } from '../services/supabase.js';

export interface DeliveryResult { claimed: number; sent: number; retrying: number; dead: number }

interface Claimed { id: string; to: string; name: string | null; subject: string; body: string; link: string | null; dedupe_key: string }

/**
 * Delivers queued emails. The database hands out each email to one worker at a time (SKIP LOCKED + lease), so any number of
 * workers/instances can run this concurrently. Failures are classified: permanent → dead, transient → retried with backoff.
 */
export async function deliverEmails(service: ServiceApi, provider: EmailProvider, log: Logger,
  opts: { appUrl: string; batchSize: number; maxBatches?: number; deadlineMs?: number }): Promise<DeliveryResult> {
  const worker = `w-${randomUUID().slice(0, 8)}`;
  const out: DeliveryResult = { claimed: 0, sent: 0, retrying: 0, dead: 0 };
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  for (let b = 0; b < (opts.maxBatches ?? 5) && Date.now() < deadline; b++) {
    const batch = await service.rpc<Claimed[]>('claim_emails', { p_worker: worker, p_limit: opts.batchSize, p_lease_seconds: 120 });
    if (!batch.length) break;
    out.claimed += batch.length;
    await Promise.all(batch.map(async (e) => {
      const text = e.link ? `${e.body}\n\nOpen in Property AI: ${opts.appUrl}${e.link}` : e.body;
      try {
        const sent = await provider.send({ to: e.to, name: e.name, subject: e.subject, text, idempotencyKey: `email-${e.id}` });
        await service.rpc('complete_email', { p_id: e.id, p_worker: worker, p_provider_message_id: sent.id });
        out.sent++;
      } catch (err) {
        const permanent = err instanceof SendError ? err.permanent : false;
        const message = err instanceof Error ? err.message : 'unknown error';
        log.warn('email delivery failed', { emailId: e.id, permanent, error: message });
        try {
          const r = await service.rpc<{ status: string }>('fail_email', { p_id: e.id, p_worker: worker, p_error: message, p_permanent: permanent });
          if (r.status === 'dead') out.dead++; else out.retrying++;
        } catch (inner) { log.error('could not record email failure', { emailId: e.id, error: String(inner) }); }
      }
    }));
  }
  return out;
}

export interface JobsResult { jobs: Record<string, Record<string, { created?: number; skipped?: boolean; error?: string }>>; email: DeliveryResult; errors: string[] }

/** Cron entry: run every scheduled job for every organization, then flush the email queue. */
export async function runScheduledJobs(service: ServiceApi, provider: EmailProvider, log: Logger,
  opts: { appUrl: string; batchSize: number; only?: 'jobs' | 'email' }): Promise<JobsResult> {
  const jobs = opts.only === 'email' ? {} : await service.rpc<JobsResult['jobs']>('job_run_all', {});
  const errors: string[] = [];
  for (const [org, byJob] of Object.entries(jobs)) for (const [job, r] of Object.entries(byJob)) if (r.error) errors.push(`${org}/${job}: ${r.error}`);
  const email = opts.only === 'jobs' ? { claimed: 0, sent: 0, retrying: 0, dead: 0 } : await deliverEmails(service, provider, log, { ...opts, maxBatches: 10 });
  if (errors.length) log.error('scheduled job errors', { errors });
  return { jobs, email, errors };
}
