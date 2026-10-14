import { createHmac, timingSafeEqual } from 'node:crypto';

/** Meta signs the RAW request body with the app secret (HMAC-SHA256) and sends it as `X-Hub-Signature-256: sha256=<hex>`. */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const hex = header.slice(7);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

export interface IncomingEvent { kind: 'message' | 'status'; provider_id: string; contact_key: string | null; payload: unknown }
export interface Batch { phoneNumberId: string; events: IncomingEvent[] }

const digits = (v: unknown, min = 5, max = 20): string | null => (typeof v === 'string' && new RegExp(`^[0-9]{${min},${max}}$`).test(v) ? v : null);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Turns a webhook body into storable events, grouped by the business number they were sent to. Anything malformed is skipped, not trusted. */
export function extractBatches(body: unknown): { batches: Batch[]; skipped: number } {
  const byNumber = new Map<string, IncomingEvent[]>();
  let skipped = 0;
  if (!isObj(body) || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return { batches: [], skipped: 1 };
  for (const entry of body.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) { skipped++; continue; }
      const v = change.value;
      const pnid = digits(v.metadata?.phone_number_id, 5, 30);
      if (!pnid) { skipped++; continue; }
      const list = byNumber.get(pnid) ?? []; byNumber.set(pnid, list);
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const from = digits(m?.from); const id = typeof m?.id === 'string' && m.id.length <= 200 ? m.id : null;
        if (!from || !id) { skipped++; continue; }
        list.push({ kind: 'message', provider_id: id, contact_key: from, payload: { message: m, contacts: Array.isArray(v.contacts) ? v.contacts.slice(0, 3) : [] } });
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        const id = typeof s?.id === 'string' && s.id.length <= 200 ? s.id : null; const st = typeof s?.status === 'string' ? s.status.slice(0, 20) : null;
        if (!id || !st) { skipped++; continue; }
        list.push({ kind: 'status', provider_id: `${id}:${st}`, contact_key: null, payload: { status: s } });
      }
    }
  }
  return { batches: [...byNumber].filter(([, e]) => e.length).map(([phoneNumberId, events]) => ({ phoneNumberId, events })), skipped };
}
