import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/lib/env.js';
import { createLogger } from '../../src/lib/logger.js';
import { SendError, type EmailMessage, type EmailProvider } from '../../src/services/email.js';
import type { LlmProvider } from '../../src/ai/types.js';
import type { BillingProvider } from '../../src/billing/provider.js';
import type { WhatsAppProvider } from '../../src/whatsapp/provider.js';
import { startMockSupabase, type MockSupabase } from './mock-supabase.js';

/** Records every email and can be told to fail, so retry and dead-letter behaviour can be proven end to end. */
export class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake';
  sent: EmailMessage[] = [];
  attempts: EmailMessage[] = [];
  private script: ('ok' | 'transient' | 'permanent')[] = [];
  /** Queue outcomes for the next sends, in order; once exhausted every send succeeds. */
  failNext(...outcomes: ('ok' | 'transient' | 'permanent')[]) { this.script.push(...outcomes); }
  async send(m: EmailMessage) {
    this.attempts.push(m);
    const next = this.script.shift() ?? 'ok';
    if (next === 'transient') throw new SendError('provider 503: try later', false);
    if (next === 'permanent') throw new SendError('provider 422: invalid recipient', true);
    this.sent.push(m);
    return { id: `fake-${this.sent.length}` };
  }
}

export const CRON_SECRET = 'test-cron-secret-0123456789-0123456789';

export async function startTestApp(over: Record<string, string> = {}, mockOpts: { confirmEmails?: boolean } = {}, deps: { llm?: LlmProvider; whatsapp?: WhatsAppProvider; billing?: BillingProvider | null | ((env: ReturnType<typeof loadEnv>) => BillingProvider) } = {}) {
  const mock = await startMockSupabase(mockOpts);
  const env = loadEnv({
    NODE_ENV: 'test', SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: mock.anonKey,
    APP_URL: 'http://localhost:3000', LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: '1000', RATE_LIMIT_AUTH_MAX: '1000',
    SUPABASE_SERVICE_ROLE_KEY: mock.serviceKey, CRON_SECRET, EMAIL_INLINE_DELIVERY: 'false', RATE_LIMIT_INTERNAL_MAX: '1000', ...over,
  });
  const email = new FakeEmailProvider();
  const app = createApp({ env, logger: createLogger('silent'), emailProvider: email, llm: deps.llm, whatsapp: deps.whatsapp, billing: typeof deps.billing === 'function' ? deps.billing(env) : deps.billing });
  /** A fresh browser-like client with its own cookie jar. */
  const client = () => supertest.agent(app);
  let n = 0;
  /** Register a new user through the real endpoint; returns a signed-in client. */
  async function signUp(email = `user${++n}-${Math.random().toString(36).slice(2, 7)}@test.dev`, fullName = 'Test User') {
    const c = client();
    const r = await c.post('/api/auth/register').send({ email, password: 'correct horse battery', fullName });
    if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { c, email };
  }
  /** Create an org with a fresh owner; returns the owner's client and org id. */
  async function newOrg(name = 'Test Org') {
    const owner = await signUp();
    const r = await owner.c.post('/api/organizations').send({ name });
    return { ...owner, orgId: r.body.id as string, base: `/api/organizations/${r.body.id}` };
  }
  /** Add a new user to an org with a role, via the real invitation flow. */
  async function addMember(org: { c: ReturnType<typeof client>; orgId: string }, role: string) {
    const u = await signUp();
    const inv = await org.c.post(`/api/organizations/${org.orgId}/invitations`).send({ email: u.email, role });
    const token = (inv.body.inviteUrl as string).split('token=')[1];
    const r = await u.c.post('/api/invitations/accept').send({ token });
    if (r.status !== 200) throw new Error(`accept failed ${r.status} ${JSON.stringify(r.body)}`);
    return u.c;
  }
  return { app, env, mock, email, client, signUp, newOrg, addMember, close: () => mock.close() };
}
export type TestApp = Awaited<ReturnType<typeof startTestApp>>;
export type { MockSupabase };
