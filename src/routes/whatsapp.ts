import { createHash, randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import type { DataApi, ServiceApi } from '../services/supabase.js';
import { mountDefs, type Def, type MountOptions } from './defs.js';

const nul = <T extends z.ZodTypeAny>(s: T) => s.nullish().transform((v) => v ?? null);
const str = (max: number) => nul(z.string().trim().max(max).transform((v) => (v === '' ? null : v)));
const tpl = nul(z.string().trim().regex(/^[a-z0-9_]{1,255}$/, 'Use lower-case letters, digits and underscores, as in the Meta template name.'));
const lang = z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Use a language code such as en or en_GB.').default('en');
const channelBody = z.object({
  phoneNumberId: z.string().trim().regex(/^[0-9]{5,30}$/, 'This is the numeric "Phone number ID" from the Meta dashboard, not the phone number.'),
  displayNumber: str(40), wabaId: nul(z.string().trim().regex(/^[0-9]{5,30}$/)), enabled: z.boolean().default(false), intakeUser: uuid, urgentUser: nul(uuid), welcomeText: str(600),
  rentTemplateName: tpl, rentTemplateLang: lang, rentTemplateBody: str(1024), updateTemplateName: tpl, updateTemplateLang: lang,
}).strict();
const faqBody = z.object({ question: z.string().trim().min(3).max(200), keywords: z.array(z.string().trim().min(2).max(40)).max(30).default([]), answer: z.string().trim().min(1).max(1000), active: z.boolean().default(true) }).strict();
const contactsQuery = z.object({ status: nul(z.enum(['unverified', 'verified', 'blocked'])), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();
const handoffQuery = z.object({ status: z.enum(['open', 'resolved']).optional() }).strict();
const noBody = z.object({});

const defs: Def[] = [
  { method: 'put', path: '/whatsapp/channel', min: 'admin', fn: 'save_wa_channel', body: channelBody },
  { method: 'get', path: '/whatsapp/faqs', min: 'manager', fn: 'list_wa_faqs' },
  { method: 'post', path: '/whatsapp/faqs', min: 'admin', fn: 'save_wa_faq', body: faqBody, extra: { faq: null }, status: 201 },
  { method: 'put', path: '/whatsapp/faqs/:faq', min: 'admin', fn: 'save_wa_faq', body: faqBody },
  { method: 'delete', path: '/whatsapp/faqs/:faq', min: 'admin', fn: 'delete_wa_faq' },
  { method: 'get', path: '/whatsapp/contacts', min: 'manager', fn: 'list_wa_contacts', query: contactsQuery },
  { method: 'get', path: '/whatsapp/contacts/:contact', min: 'manager', fn: 'get_wa_contact' },
  { method: 'post', path: '/whatsapp/contacts/:contact/unlink', min: 'manager', fn: 'unlink_wa_contact', body: z.object({ block: z.boolean().default(false) }).strict() },
  { method: 'post', path: '/whatsapp/contacts/:contact/reply', min: 'manager', fn: 'wa_staff_reply', body: z.object({ text: z.string().trim().min(1).max(1000) }).strict(), status: 201 },
  { method: 'get', path: '/whatsapp/contacts/:contact/reminder-candidates', min: 'manager', fn: 'wa_reminder_candidates' },
  { method: 'get', path: '/whatsapp/handoffs', min: 'manager', fn: 'list_wa_handoffs', query: handoffQuery },
  { method: 'post', path: '/whatsapp/handoffs/:conversation/resolve', min: 'manager', fn: 'resolve_wa_handoff', body: noBody },
];

// no 0/O/1/I/L: codes are read aloud and typed on phones
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export function whatsappRoutes(env: Env, data: DataApi, service: ServiceApi, providerName: string, opts: MountOptions): Router {
  const r = Router({ mergeParams: true });
  r.get('/whatsapp/channel', requireOrgRole(data, 'admin'), async (req, res) => {
    const c = await data.rpc<any>(req.auth!.token, 'get_wa_channel', { p_org: req.org!.id });
    res.json({ ...c, server: { provider: providerName, webhookUrl: `${env.APP_URL}/api/webhooks/whatsapp`, verifyTokenConfigured: !!env.WHATSAPP_VERIFY_TOKEN, appSecretConfigured: !!env.WHATSAPP_APP_SECRET,
      accessTokenConfigured: !!env.WHATSAPP_ACCESS_TOKEN, serviceConfigured: service.configured, externalSwitchOn: env.COPILOT_EXTERNAL_ENABLED, graphVersion: env.WHATSAPP_GRAPH_VERSION } });
  });
  mountDefs(r, defs, data, opts);

  // The code is shown once, to the person who asked for it. Only its hash is stored.
  r.post('/whatsapp/link-codes', requireOrgRole(data, 'manager'), validate({ body: z.object({ tenantId: uuid }).strict() }), async (req, res) => {
    const code = newCode();
    const issued = await data.rpc<{ id: string; tenant_name: string; expires_at: string }>(req.auth!.token, 'create_wa_link_code',
      { p_org: req.org!.id, p_tenant: req.body.tenantId, p_code_hash: createHash('sha256').update(code).digest('hex') });
    res.status(201).json({ ...issued, code, instructions: `Ask ${issued.tenant_name} to send "LINK ${code}" to the WhatsApp number. It works once and expires in 48 hours.` });
  });

  r.post('/whatsapp/contacts/:contact/reminder-draft', requireOrgRole(data, 'manager'), validate({ params: z.object({ contact: uuid }).passthrough(), body: z.object({ chargeId: uuid }).strict() }), async (req, res) => {
    if (!service.configured) throw new AppError(503, 'upstream_error', 'The service-role key is not configured.');
    await data.rpc(req.auth!.token, 'get_wa_contact', { p_org: req.org!.id, p_contact: req.params.contact });          // proves this manager may see the contact
    const draft = await service.rpc<any>('copilot_svc_propose_action', { p_org: req.org!.id, p_user: req.auth!.user.id, p_conversation: null, p_kind: 'whatsapp_reminder_draft',
      p_payload: { contact_id: req.params.contact, charge_id: req.body.chargeId } });
    res.status(201).json(draft);
  });

  // Prepare the send from a draft this manager made, then hand it to the approval inbox. Someone else must approve it.
  r.post('/whatsapp/reminders/:draft/request-approval', requireOrgRole(data, 'manager'), validate({ params: z.object({ draft: uuid }).passthrough(), body: noBody }), async (req, res) => {
    if (!service.configured) throw new AppError(503, 'upstream_error', 'The service-role key is not configured.');
    if (!env.COPILOT_EXTERNAL_ENABLED) throw AppError.forbidden('Messages to tenants are turned off on this server (COPILOT_EXTERNAL_ENABLED).');
    const proposal = await service.rpc<any>('copilot_svc_propose_action', { p_org: req.org!.id, p_user: req.auth!.user.id, p_conversation: null, p_kind: 'send_whatsapp_reminder', p_payload: { draft_id: req.params.draft } });
    const submitted = await data.rpc<any>(req.auth!.token, 'copilot_submit_action', { p_org: req.org!.id, p_action: proposal.id });
    if (opts.afterWrite) await opts.afterWrite({ method: 'post' } as Def).catch(() => undefined);
    res.status(201).json(submitted);
  });
  return r;
}
