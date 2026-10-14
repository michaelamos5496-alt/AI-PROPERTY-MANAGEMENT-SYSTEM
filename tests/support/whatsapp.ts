import { createHmac, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { WaSendError, type OutboundMessage, type WhatsAppProvider } from '../../src/whatsapp/provider.js';

export const APP_SECRET = 'test-app-secret-0123456789abcdef';
export const VERIFY_TOKEN = 'test-verify-token-0123456789';

/** Records every message the app tries to send, and can be told to fail so retry and dead-letter paths are provable. */
export class FakeWhatsApp implements WhatsAppProvider {
  readonly name = 'fake';
  sent: (OutboundMessage & { id: string })[] = [];
  attempts = 0;
  private script: ('ok' | 'transient' | 'permanent')[] = [];
  failNext(...o: ('ok' | 'transient' | 'permanent')[]) { this.script.push(...o); }
  async send(m: OutboundMessage) {
    this.attempts++;
    const next = this.script.shift() ?? 'ok';
    if (next === 'transient') throw new WaSendError('provider unavailable', '131000', false);
    if (next === 'permanent') throw new WaSendError('recipient cannot receive messages', '131026', true);
    const id = `wamid.OUT${this.sent.length + 1}.${randomUUID().slice(0, 6)}`;
    this.sent.push({ ...m, id });
    return { id };
  }
  /** Text of everything sent to a number so far. */
  to(wa: string) { return this.sent.filter((m) => m.to === wa).map((m) => (m.kind === 'template' ? `[template ${m.template?.name}: ${m.template?.params.join(' | ')}]` : m.body ?? '')); }
  last(wa: string) { return this.to(wa).at(-1) ?? ''; }
}

const envelope = (pnid: string, value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: '200000000000001', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550100', phone_number_id: pnid }, ...value } }] }] });
let n = 0;
export const msgId = () => `wamid.IN${++n}.${randomUUID().slice(0, 8)}`;
export const waText = (pnid: string, from: string, text: string, over: { id?: string; ts?: number; name?: string; type?: string } = {}) =>
  envelope(pnid, { contacts: [{ profile: { name: over.name ?? 'Sam' }, wa_id: from }], messages: [{ from, id: over.id ?? msgId(), timestamp: String(over.ts ?? Math.floor(Date.now() / 1000)), type: over.type ?? 'text', ...(over.type && over.type !== 'text' ? { [over.type]: { id: 'media1' } } : { text: { body: text } }) }] });
export const waStatus = (pnid: string, id: string, status: string, to: string, over: { ts?: number; errors?: unknown[] } = {}) =>
  envelope(pnid, { statuses: [{ id, status, timestamp: String(over.ts ?? Math.floor(Date.now() / 1000)), recipient_id: to, ...(over.errors ? { errors: over.errors } : {}) }] });

export const sign = (raw: string | Buffer, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
/** Deliver a payload the way Meta does: raw JSON bytes plus an HMAC of them. */
export const deliver = (app: Parameters<typeof supertest>[0], body: unknown, opts: { secret?: string | null; signature?: string; raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(body);
  const r = supertest(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json');
  const sig = opts.signature ?? (opts.secret === null ? undefined : sign(raw, opts.secret ?? APP_SECRET));
  return (sig ? r.set('x-hub-signature-256', sig) : r).send(raw);
};
