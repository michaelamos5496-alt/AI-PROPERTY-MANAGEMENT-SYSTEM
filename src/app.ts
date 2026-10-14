import express, { type Express } from 'express';
import helmet from 'helmet';
import { createLogger, type Logger } from './lib/logger.js';
import { type Env } from './lib/env.js';
import { rateLimit } from './lib/rate-limit.js';
import { requireAuth } from './middleware/auth.js';
import { csrfGuard } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { requestContext } from './middleware/request-context.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { deliverEmails } from './jobs/runner.js';
import { financeRoutes } from './routes/finance.js';
import { internalRoutes } from './routes/internal.js';
import { copilotRoutes } from './routes/copilot.js';
import { createProvider } from './ai/providers.js';
import type { LlmProvider } from './ai/types.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { whatsappWebhook } from './routes/whatsapp-webhook.js';
import { createWhatsAppProvider, type WhatsAppProvider } from './whatsapp/provider.js';
import type { WaRuntime } from './whatsapp/worker.js';
import { opsRoutes, portalRoutes, userRoutes } from './routes/ops.js';
import { createEmailProvider, type EmailProvider } from './services/email.js';
import { recordRoutes } from './routes/records.js';
import { AuthApi, DataApi, ServiceApi, StorageApi } from './services/supabase.js';

export interface AppDeps { env: Env; fetch?: typeof fetch; logger?: Logger; emailProvider?: EmailProvider; llm?: LlmProvider; whatsapp?: WhatsAppProvider }

export function createApp({ env, fetch: f = fetch, logger, emailProvider, llm, whatsapp }: AppDeps): Express {
  const log = logger ?? createLogger(env.LOG_LEVEL);
  const auth = new AuthApi(env, f);
  const data = new DataApi(env, f);
  const storage = new StorageApi(env, f);
  const service = new ServiceApi(env, f);
  const provider = emailProvider ?? createEmailProvider(env, log, f);
  // Urgent notices (e.g. a critical escalation) should not wait for the next scheduled run, so after a write we flush the email
  // queue for a moment. Best-effort and time-boxed: the durable queue + scheduler remain the source of truth for retries.
  const afterWrite = async () => {
    if (!service.configured || !env.EMAIL_INLINE_DELIVERY) return;
    await Promise.race([deliverEmails(service, provider, log, { appUrl: env.APP_URL, batchSize: env.EMAIL_BATCH_SIZE, maxBatches: 1, deadlineMs: 2500 }), new Promise((r) => setTimeout(r, 2500))]);
  };

  const wa: WaRuntime = { env, service, provider: whatsapp ?? createWhatsAppProvider(env, log, f), log };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Vercel terminates TLS and sets X-Forwarded-For

  app.use(requestContext(log));
  app.use(helmet({ contentSecurityPolicy: false, hsts: env.NODE_ENV === 'production' }));
  // Meta's webhook needs the raw body for signature checking, so it is mounted before the JSON parser, CSRF guard and global limiter.
  app.use('/api/webhooks/whatsapp', whatsappWebhook(env, service, wa, log));
  app.use(rateLimit({ name: 'global', windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS, max: env.RATE_LIMIT_MAX }));
  app.use(express.json({ limit: '32kb' }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(csrfGuard(env));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/internal', internalRoutes(env, service, provider, log, wa));
  app.use('/api/auth', authRoutes(env, auth));
  // One authenticated router so the session is verified exactly once per request.
  const api = express.Router();
  api.use(requireAuth(env, auth));
  api.use(orgRoutes(env, data));
  api.use('/me', userRoutes(data, { afterWrite }));
  api.use('/portal', portalRoutes(data, storage, { afterWrite }));
  api.use('/organizations/:orgId', recordRoutes(env, data, storage));
  api.use('/organizations/:orgId', financeRoutes(env, data));
  api.use('/organizations/:orgId', opsRoutes(env, data, storage, { afterWrite }));
  api.use('/organizations/:orgId', whatsappRoutes(env, data, service, wa.provider.name, { afterWrite }));
  api.use('/organizations/:orgId', copilotRoutes(env, data, service, llm ?? createProvider(env), { afterWrite, log }));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
