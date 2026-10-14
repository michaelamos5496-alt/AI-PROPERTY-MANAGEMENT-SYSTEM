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
import { financeRoutes } from './routes/finance.js';
import { recordRoutes } from './routes/records.js';
import { AuthApi, DataApi, StorageApi } from './services/supabase.js';

export interface AppDeps { env: Env; fetch?: typeof fetch; logger?: Logger }

export function createApp({ env, fetch: f = fetch, logger }: AppDeps): Express {
  const log = logger ?? createLogger(env.LOG_LEVEL);
  const auth = new AuthApi(env, f);
  const data = new DataApi(env, f);
  const storage = new StorageApi(env, f);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Vercel terminates TLS and sets X-Forwarded-For

  app.use(requestContext(log));
  app.use(helmet({ contentSecurityPolicy: false, hsts: env.NODE_ENV === 'production' }));
  app.use(rateLimit({ name: 'global', windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS, max: env.RATE_LIMIT_MAX }));
  app.use(express.json({ limit: '32kb' }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(csrfGuard(env));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(env, auth));
  // One authenticated router so the session is verified exactly once per request.
  const api = express.Router();
  api.use(requireAuth(env, auth));
  api.use(orgRoutes(env, data));
  api.use('/organizations/:orgId', recordRoutes(env, data, storage));
  api.use('/organizations/:orgId', financeRoutes(env, data));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
