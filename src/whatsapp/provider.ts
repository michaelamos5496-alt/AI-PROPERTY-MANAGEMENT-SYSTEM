import type { Env } from '../lib/env.js';
import type { Logger } from '../lib/logger.js';

export interface OutboundMessage {
  to: string;                 // WhatsApp id (digits)
  phoneNumberId: string;      // Meta's id of the business number we send from
  kind: 'text' | 'template';
  body?: string | null;
  template?: { name: string; lang: string; params: string[] } | null;
}
export interface WhatsAppProvider { readonly name: string; send(m: OutboundMessage): Promise<{ id: string }> }

/** A send failure, already classified. `permanent` = retrying cannot help (bad number, window closed, template wrong). */
export class WaSendError extends Error {
  constructor(message: string, public readonly code: string, public readonly permanent: boolean) { super(message); this.name = 'WaSendError'; }
}

// https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
const TRANSIENT_CODES = new Set(['1', '2', '4', '17', '32', '613', '80007', '130429', '131000', '131016', '131056', '133004', '133016']);
const AUTH_CODES = new Set(['0', '10', '190']);               // token problems: retry, an operator can fix them without losing the queue

export function classify(status: number, code: string | null): { permanent: boolean; code: string } {
  const c = code ?? String(status);
  if (status >= 500 || status === 429 || status === 0) return { permanent: false, code: c };
  if (code && (TRANSIENT_CODES.has(code) || AUTH_CODES.has(code) || /^2\d\d$/.test(code))) return { permanent: false, code: c };
  return { permanent: true, code: c };
}

/** Real delivery through the Meta WhatsApp Cloud API. The token is only ever sent to Meta and never appears in logs or errors. */
export class CloudApiProvider implements WhatsAppProvider {
  readonly name = 'cloud';
  constructor(private env: Env, private f: typeof fetch = fetch) {}

  async send(m: OutboundMessage): Promise<{ id: string }> {
    const body = m.kind === 'template' && m.template
      ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.to, type: 'template',
          template: { name: m.template.name, language: { code: m.template.lang },
            ...(m.template.params.length ? { components: [{ type: 'body', parameters: m.template.params.map((text) => ({ type: 'text', text: text.slice(0, 1024) })) }] } : {}) } }
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.to, type: 'text', text: { preview_url: false, body: (m.body ?? '').slice(0, 4096) } };
    let res: Response;
    try {
      res = await this.f(`${this.env.WHATSAPP_API_BASE}/${this.env.WHATSAPP_GRAPH_VERSION}/${m.phoneNumberId}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new WaSendError('Could not reach WhatsApp.', 'network', false); }
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const code = json?.error?.code != null ? String(json.error.code) : null;
      const detail = String(json?.error?.error_data?.details ?? json?.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      const k = classify(res.status, code);
      throw new WaSendError(detail, k.code, k.permanent);
    }
    const id = json?.messages?.[0]?.id;
    if (typeof id !== 'string' || !id) throw new WaSendError('WhatsApp accepted the request but returned no message id.', 'no_id', false);
    return { id };
  }
}

/** Development/test provider: nothing leaves the machine. */
export class LogProvider implements WhatsAppProvider {
  readonly name = 'log';
  sent: OutboundMessage[] = [];
  constructor(private log?: Logger) {}
  async send(m: OutboundMessage) {
    this.sent.push(m);
    this.log?.info('whatsapp message (not sent: log provider)', { to: `…${m.to.slice(-4)}`, kind: m.kind });
    return { id: `wamid.LOG${Date.now().toString(36)}${this.sent.length}` };
  }
}

export function createWhatsAppProvider(env: Env, log: Logger, f?: typeof fetch): WhatsAppProvider {
  return env.WHATSAPP_PROVIDER === 'cloud' ? new CloudApiProvider(env, f) : new LogProvider(log);
}
