import { z } from 'zod';

const url = z.string().url();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: url.default('http://localhost:3000'),
  SUPABASE_URL: url,
  /** Public "anon" key. Safe for browsers in general, but this app never sends it to one. */
  SUPABASE_ANON_KEY: z.string().min(20),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  /** Per-user budget for financial write requests per window. */
  RATE_LIMIT_FINANCE_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  /** Refresh-cookie lifetime in days. */
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
});

export type Env = z.infer<typeof schema>;

/** Validate environment variables once, failing fast with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.APP_URL.startsWith('https://')) {
    throw new Error('Invalid environment configuration:\n  - APP_URL: must be https in production');
  }
  return env;
}
