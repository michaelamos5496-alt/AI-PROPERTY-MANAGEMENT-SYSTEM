import type { Env } from './env.js';
import type { ServiceApi } from '../services/supabase.js';

export interface ProbeResult { name: string; status: 'ok' | 'fail' | 'skipped'; ms: number; detail?: string }
export interface HealthReport { status: 'ok' | 'degraded' | 'down'; checks: Record<string, unknown>; problems: string[]; probes?: ProbeResult[] }

/** What "stuck" means, from the counts the database reports. Anything listed is worth a human's attention. */
export function assess(db: any): string[] {
  const p: string[] = [];
  if (db.email.queued_overdue > 0) p.push(`${db.email.queued_overdue} email(s) are overdue in the queue`);
  if (db.email.dead > 0) p.push(`${db.email.dead} email(s) gave up (dead letters)`);
  if (db.whatsapp.events_stuck > 0) p.push(`${db.whatsapp.events_stuck} WhatsApp event(s) unprocessed for over 10 minutes`);
  if (db.whatsapp.events_dead > 0) p.push(`${db.whatsapp.events_dead} WhatsApp event(s) failed permanently this week`);
  if (db.whatsapp.outbound_stuck > 0) p.push(`${db.whatsapp.outbound_stuck} WhatsApp message(s) stuck sending`);
  if (db.whatsapp.outbound_dead > 0) p.push(`${db.whatsapp.outbound_dead} WhatsApp message(s) could not be delivered this week`);
  if (db.billing.events_pending > 0) p.push(`${db.billing.events_pending} billing event(s) could not be matched for over an hour`);
  if (db.jobs.errors_24h > 0) p.push(`${db.jobs.errors_24h} scheduled job error(s) in 24 hours`);
  if (!db.jobs.last_ok_at || Date.now() - new Date(db.jobs.last_ok_at).getTime() > 60 * 60_000) p.push('the scheduler has not completed a job run in the last hour');
  if (db.approvals.pending_expired > 0) p.push(`${db.approvals.pending_expired} approval(s) are past expiry but still pending`);
  return p;
}

async function timed(name: string, fn: () => Promise<string | void>, skip?: string): Promise<ProbeResult> {
  if (skip) return { name, status: 'skipped', ms: 0, detail: skip };
  const t0 = Date.now();
  try { const detail = await fn(); return { name, status: 'ok', ms: Date.now() - t0, ...(detail ? { detail } : {}) }; }
  catch (e) { return { name, status: 'fail', ms: Date.now() - t0, detail: e instanceof Error ? e.message.slice(0, 160) : 'failed' }; }
}
const get = async (f: typeof fetch, url: string, headers: Record<string, string>) => {
  const r = await f(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
};

/** Live checks of each external integration, using the cheapest authenticated read each provider offers. Secrets are used, never returned. */
export async function probeIntegrations(env: Env, channel: string | null, f: typeof fetch = fetch): Promise<ProbeResult[]> {
  return Promise.all([
    timed('supabase-auth', async () => { await get(f, `${env.SUPABASE_URL}/auth/v1/health`, { apikey: env.SUPABASE_ANON_KEY }); }),
    timed('email (resend)', async () => { await get(f, 'https://api.resend.com/domains', { authorization: `Bearer ${env.RESEND_API_KEY}` }); }, env.EMAIL_PROVIDER === 'resend' ? undefined : 'EMAIL_PROVIDER is not resend'),
    timed('whatsapp (meta graph)', async () => { await get(f, `${env.WHATSAPP_API_BASE}/${env.WHATSAPP_GRAPH_VERSION}/${channel}?fields=id,quality_rating`, { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }); },
      env.WHATSAPP_PROVIDER !== 'cloud' ? 'WHATSAPP_PROVIDER is not cloud' : !channel ? 'no enabled WhatsApp channel' : undefined),
    timed('ai (anthropic)', async () => { await get(f, 'https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' }); }, env.LLM_PROVIDER === 'anthropic' ? undefined : 'LLM_PROVIDER is not anthropic'),
    timed('billing (paystack)', async () => { await get(f, 'https://api.paystack.co/balance', { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` }); }, env.BILLING_PROVIDER === 'paystack' ? undefined : 'BILLING_PROVIDER is not paystack'),
  ]);
}

export async function healthReport(env: Env, service: ServiceApi, opts: { probe?: boolean; f?: typeof fetch } = {}): Promise<HealthReport> {
  let db: any;
  try { db = await service.rpc('health_svc_check', {}); }
  catch (e) { return { status: 'down', checks: { database: false }, problems: [`the database check failed: ${e instanceof Error ? e.message : 'unknown'}`.slice(0, 200)] }; }
  const problems = assess(db);
  const probes = opts.probe ? await probeIntegrations(env, db.whatsapp.enabled_channel, opts.f) : undefined;
  for (const p of probes ?? []) if (p.status === 'fail') problems.push(`${p.name} is not responding as expected (${p.detail})`);
  return { status: problems.length ? 'degraded' : 'ok', checks: db, problems, ...(probes ? { probes } : {}) };
}
