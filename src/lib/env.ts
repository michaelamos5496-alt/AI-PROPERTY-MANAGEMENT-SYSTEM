import { z } from 'zod';

const url = z.string().url();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: url.default('http://localhost:3000'),
  SUPABASE_URL: url,
  /** Public "anon" key. Safe for browsers in general, but this app never sends it to one. */
  SUPABASE_ANON_KEY: z.string().min(20),
  /** Service-role key. Used ONLY by the background job/email worker on the server; never sent to a browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** Shared secret for the scheduled-jobs endpoint (Vercel Cron sends it as a Bearer token). */
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters').optional(),
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().min(10).optional(),
  EMAIL_FROM: z.string().min(5).max(200).optional(),
  /** Flush the email queue right after writes that notify people (best-effort, in addition to the scheduler). */
  EMAIL_INLINE_DELIVERY: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  EMAIL_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(20),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  /** Per-user budget for financial write requests per window. */
  RATE_LIMIT_FINANCE_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_INTERNAL_MAX: z.coerce.number().int().min(1).default(12),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  /** 'offline' answers from a deterministic rules engine (no network, no key); 'anthropic' calls the Claude API. */
  LLM_PROVIDER: z.enum(['offline', 'anthropic']).default('offline'),
  /** Server-side only. Never sent to a browser and never logged. */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  LLM_MODEL: z.string().min(3).max(80).default('claude-sonnet-5-5'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(8000).default(2000),
  /** Prices in millionths of a US dollar per million tokens (so 3,000,000 = $3.00 / Mtok). Set to your contract's prices. */
  LLM_INPUT_MICRO_PER_MTOK: z.coerce.number().int().min(0).default(3_000_000),
  LLM_OUTPUT_MICRO_PER_MTOK: z.coerce.number().int().min(0).default(15_000_000),
  COPILOT_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(12).default(6),
  COPILOT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(40).default(12),
  COPILOT_MAX_RESULT_BYTES: z.coerce.number().int().min(2000).max(100_000).default(20_000),
  COPILOT_TURN_DEADLINE_MS: z.coerce.number().int().min(5000).max(280_000).default(50_000),
  /** Simultaneous model turns per server instance. */
  COPILOT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(8),
  /** First of two switches for AI-prepared external messages; the organization's own setting is the second. */
  COPILOT_EXTERNAL_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** 'log' records outbound WhatsApp messages without sending them (development/tests); 'cloud' calls the Meta WhatsApp Cloud API. */
  WHATSAPP_PROVIDER: z.enum(['log', 'cloud']).default('log'),
  /** Meta app secret: used ONLY to verify the X-Hub-Signature-256 of webhook deliveries. Without it the webhook refuses everything. */
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  /** The string you type into the webhook "Verify token" field in the Meta dashboard. */
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  /** System-user access token with whatsapp_business_messaging. Server only. */
  WHATSAPP_ACCESS_TOKEN: z.string().min(20).optional(),
  /** Check Meta's current Graph API version; this is configuration, not a pin. */
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d{1,2}\.\d$/).default('v25.0'),
  WHATSAPP_API_BASE: url.default('https://graph.facebook.com'),
  WHATSAPP_INBOUND_MAX_PER_10MIN: z.coerce.number().int().min(3).max(200).default(20),
  /** How long the webhook may spend processing before it answers Meta (events are already saved; workers finish the rest). */
  WHATSAPP_INLINE_BUDGET_MS: z.coerce.number().int().min(0).max(8000).default(3000),
  /** 'none' = billing integration pending (entitlements still work, plans are assigned by an operator). 'paystack' = Paystack subscriptions. */
  BILLING_PROVIDER: z.enum(['none', 'paystack']).default('none'),
  /** Paystack secret key. Server only. It is also the key that signs Paystack's webhooks. */
  PAYSTACK_SECRET_KEY: z.string().min(10).optional(),
  /** Currencies your Paystack account is actually enabled to charge. Confirm with Paystack; do not assume NGN, GHS and KES all work. */
  BILLING_PAYSTACK_CURRENCIES: z.string().default('NGN').transform((v) => v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
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
  if (env.EMAIL_PROVIDER === 'resend' && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
    throw new Error('Invalid environment configuration:\n  - EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM');
  }
  if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('Invalid environment configuration:\n  - LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (env.WHATSAPP_PROVIDER === 'cloud' && (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_APP_SECRET || !env.WHATSAPP_VERIFY_TOKEN)) {
    throw new Error('Invalid environment configuration:\n  - WHATSAPP_PROVIDER=cloud requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN');
  }
  if (env.BILLING_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
    throw new Error('Invalid environment configuration:\n  - BILLING_PROVIDER=paystack requires PAYSTACK_SECRET_KEY');
  }
  if (env.NODE_ENV === 'production' && !env.APP_URL.startsWith('https://')) {
    throw new Error('Invalid environment configuration:\n  - APP_URL: must be https in production');
  }
  return env;
}
