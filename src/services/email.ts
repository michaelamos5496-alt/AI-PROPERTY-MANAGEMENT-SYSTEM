import { randomUUID } from 'node:crypto';
import type { Env } from '../lib/env.js';
import type { Logger } from '../lib/logger.js';

export interface EmailMessage {
  to: string;
  name?: string | null;
  subject: string;
  text: string;
  /** Stable per queued email, so a provider that supports idempotency never sends a retry twice. */
  idempotencyKey: string;
}
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
}

/** `permanent` = retrying cannot help (bad address / rejected content). */
export class SendError extends Error {
  constructor(message: string, public readonly permanent: boolean) { super(message); this.name = 'SendError'; }
}

/** Development provider: records that an email *would* be sent. Never logs the body. */
export class LogProvider implements EmailProvider {
  readonly name = 'log';
  constructor(private log: Logger) {}
  async send(m: EmailMessage) {
    this.log.info('email (not actually sent: EMAIL_PROVIDER=log)', { to: m.to, subject: m.subject });
    return { id: `log-${randomUUID()}` };
  }
}

/** Resend (https://resend.com). Only the HTTP contract is implemented here; it has not been exercised against the live service. */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(private apiKey: string, private from: string, private f: typeof fetch = fetch) {}
  async send(m: EmailMessage) {
    let res: Response;
    try {
      res = await this.f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': m.idempotencyKey },
        body: JSON.stringify({ from: this.from, to: [m.name ? `${m.name.replace(/[<>"]/g, '')} <${m.to}>` : m.to], subject: m.subject, text: m.text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new SendError(`network error: ${(e as Error).message}`.slice(0, 200), false);
    }
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body?.id) return { id: String(body.id) };
    const msg = `provider ${res.status}: ${body?.message ?? body?.name ?? 'request failed'}`.slice(0, 300);
    // 400/422 mean the message itself is unacceptable (e.g. invalid address). Anything else (auth, rate limit, 5xx) can recover.
    throw new SendError(msg, res.status === 400 || res.status === 422);
  }
}

export function createEmailProvider(env: Env, log: Logger, f: typeof fetch = fetch): EmailProvider {
  return env.EMAIL_PROVIDER === 'resend' ? new ResendProvider(env.RESEND_API_KEY!, env.EMAIL_FROM!, f) : new LogProvider(log);
}
