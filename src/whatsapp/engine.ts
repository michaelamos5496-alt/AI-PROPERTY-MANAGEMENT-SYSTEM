import { createHash } from 'node:crypto';
import { groupedAmount } from '../lib/currency.js';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { ServiceApi } from '../services/supabase.js';

/**
 * The tenant-facing conversation. Deliberately NOT driven by an LLM: the people writing here are unauthenticated strangers
 * until they link, so every reply comes from fixed wording, organization-approved FAQs, or the database's own answers.
 * Identity, organization and permissions never come from message text: the organization is the business number the message
 * arrived on, and what a sender may see is decided by the database from their verified link.
 */
export interface Deps { env: Env; service: ServiceApi; log: Logger }
export interface Channel { org_id: string; org_name: string; welcome_text: string | null }
export interface Inbound { id: string; from: string; name: string | null; ts: Date; type: string; text: string | null }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashCode = (code: string) => sha(code.trim().toUpperCase());

const OPT_OUT = /^(stop|stopall|stop all|unsubscribe|opt ?out|quit)\W*$/i;
const OPT_IN = /^(start|unstop|subscribe|updates|notices)\W*$/i;
const YES = /^(y|yes|yep|yeah|ok|okay|sure|confirm|correct)\W*$/i;
const NO = /^(n|no|nope|cancel|stop that|never ?mind)\W*$/i;
const HUMAN = /\b(human|person|agent|representative|real person|speak to (someone|somebody|a person|the manager)|talk to (someone|somebody|a person|the manager)|call me)\b/i;
const SENSITIVE = /\b(evict\w*|lawyer|legal action|attorney|sue\b|suing|lawsuit|(in|to|go to|take you to|taking you to) court|court (date|case|order|hearing)|police|discriminat\w*|harass\w*|threat\w*|assault\w*|abus\w*|deposit (back|dispute|return)|refund|complain\w*|complaint|compensation|notice to (quit|vacate)|unsafe|illegal)\b/i;
const URGENT = /\b(gas leak|smell(s)? (of )?gas|carbon monoxide|fire|smoke|flood\w*|burst pipe|sewage|exposed wire|sparking|sparks|electric(al)? shock|break-?in|broke in|locked out|collaps\w*|ceiling (fell|caving)|no heat(ing)?|emergency)\b/i;
const REPORT = /\b(report|repair|fix|broken|break|leak\w*|drip\w*|not working|doesn'?t work|won'?t (work|start|turn|close|open|flush)|maintenance|problem|issue|clogged|blocked|no (hot )?water|mold|mould|pest\w*|mouse|mice|cockroach\w*|rats?\b|noise|heater|boiler|toilet|sink|tap|faucet|stove|oven|fridge|dishwasher|lock|window|door|lights?|bulb|flicker\w*|outlet|socket|power|heating|radiator|pipes?|drain\w*|ceiling|roof|walls?|floors?|cracks?|cracked|damp|smell\w*|stains?|keys?|intercom|elevator|lift)\b/i;
const BALANCE = /\b(balance|how much (do i |i )?owe|rent due|amount due|what do i owe|am i behind|arrears)\b/i;
const HELP = /^(hi|hello|hey|help|menu|start over|\?|options)\W*$/i;
const STATUS_RE = /^status(?:\s+(?:of\s+)?(mr-?[0-9a-f]{4,8}))?\W*$/i;
const LINK_RE = /^(?:link|verify|code)\s*[:-]?\s*([a-z0-9]{6,20})\W*$/i;
const BARE_CODE = /^[a-z0-9]{6,20}$/i;

const CATEGORY: [RegExp, string][] = [
  [/\b(leak\w*|tap|faucet|toilet|drain|pipe|sink|plumb\w*|no (hot )?water|clogged|flush)\b/i, 'plumbing'], [/\b(power|outlet|socket|light|lights|electric\w*|breaker|fuse|sparks?)\b/i, 'electrical'],
  [/\b(heat\w*|boiler|radiator|air ?con\w*|\bac\b|cooling|thermostat)\b/i, 'heating_cooling'], [/\b(fridge|refrigerator|oven|stove|cooker|washer|washing machine|dryer|dishwasher|microwave)\b/i, 'appliances'],
  [/\b(mouse|mice|rats?|cockroach\w*|ants|pests?|bed ?bugs?|infest\w*)\b/i, 'pest'], [/\b(lock|key|keys|deadbolt|break-?in|intercom|alarm)\b/i, 'security'],
  [/\b(roof|ceiling|wall|window|floor|stairs|crack\w*|mold|mould|damp)\b/i, 'structural'], [/\b(clean\w*|trash|garbage|rubbish)\b/i, 'cleaning'], [/\b(garden|yard|lawn|tree|parking|driveway|fence)\b/i, 'grounds'],
];
const categoryOf = (t: string) => CATEGORY.find(([re]) => re.test(t))?.[1] ?? 'other';

// eslint-disable-next-line no-control-regex
const clean = (s: string, max = 1000) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const STATUS_WORDS: Record<string, string> = { submitted: 'received', triaged: 'reviewed', awaiting_approval: 'being arranged', assigned: 'assigned for work', in_progress: 'being worked on', resolved: 'resolved', cancelled: 'cancelled' };

interface Ctx { desc?: string; urgent?: boolean; propertyId?: string; propertyName?: string; unitId?: string; unitRef?: string; tenancyId?: string; options?: { tenancy_id: string; unit_id: string; property_id: string; label: string }[]; fails?: number; fromMsg?: string }
interface Begin {
  duplicate: boolean; blocked?: boolean; over_limit?: boolean; rate_limited?: boolean; rate_notice?: boolean; stale?: boolean; message_id?: string;
  contact: { id: string; status: string; consent: string; name: string | null; verified: boolean; needs_reverify: boolean; first_name: string | null };
  conversation: { id: string; state: string; context: Ctx; unknown_streak: number; handoff_status: string };
}

export async function handleInbound(d: Deps, ch: Channel, m: Inbound): Promise<void> {
  const { service: svc, env } = d;
  const rpc = <T = any>(fn: string, args: Record<string, unknown>) => svc.rpc<T>(fn, { p_org: ch.org_id, ...args });
  const rawText = m.text == null ? null : clean(m.text);
  const b = await rpc<Begin>('wa_svc_begin_inbound', { p_wa_id: m.from, p_name: m.name, p_provider_id: m.id, p_kind: rawText == null ? 'other' : 'text', p_body: rawText ?? `[${m.type}]`, p_ts: m.ts.toISOString(), p_max_per_10min: env.WHATSAPP_INBOUND_MAX_PER_10MIN });
  if (b.duplicate || b.blocked) return;

  let n = 0;
  /** Replies are deduplicated per (incoming message, position), so a retried event can never send the same reply twice. */
  const say = (text: string, over: { ack?: boolean; dedupe?: string } = {}) =>
    rpc('wa_svc_enqueue', { p_contact: b.contact.id, p_kind: 'text', p_body: text.slice(0, 1500), p_template: null, p_origin: 'bot', p_dedupe: over.dedupe ?? `r:${m.id}:${++n}`, p_ack: over.ack ?? false });
  const setState = (state: string, ctx: Ctx = {}, unknown = 0) => rpc('wa_svc_set_state', { p_conversation: b.conversation.id, p_state: state, p_context: ctx, p_unknown: unknown });
  const handoff = (reason: string, urgent = false) => rpc('wa_svc_handoff', { p_contact: b.contact.id, p_reason: reason, p_excerpt: rawText ?? `[${m.type} message]`, p_urgent: urgent });
  const org = ch.org_name;
  const text = rawText ?? '';
  const t = norm(text);

  if (b.over_limit) {
    // The organization's plan allowance for new conversations this month is used up: do not run the assistant, but never leave the sender or staff in the dark.
    await handoff('The plan\'s monthly allowance of WhatsApp conversations is used up, so the assistant did not answer. Reply to this person directly.');
    await say('Thanks for your message. A team member has been told and will reply to you directly.', { dedupe: `ol:${b.conversation.id}:${new Date().toISOString().slice(0, 10)}` });
    return;
  }
  if (b.rate_limited) { if (b.rate_notice) await say('You are sending messages very quickly. Please wait a few minutes and try again.', { dedupe: `rl:${b.contact.id}:${Math.floor(Date.now() / 3_600_000)}` }); return; }

  // Opt-out is honoured first, always, in any state and even for delayed messages.
  if (rawText != null && OPT_OUT.test(t)) {
    await rpc('wa_svc_set_consent', { p_contact: b.contact.id, p_value: 'opted_out' });
    await say(`You have been unsubscribed from WhatsApp messages from ${org}. We will not message you again unless you reply START.`, { ack: true, dedupe: `optout-ack:${m.id}` });
    await setState('idle', {}, 0);
    return;
  }
  if (rawText != null && OPT_IN.test(t)) {
    await rpc('wa_svc_set_consent', { p_contact: b.contact.id, p_value: 'opted_in' });
    await say(`You will now receive notices and request updates from ${org} here. Reply STOP at any time to stop.`);
    return;
  }
  if (b.contact.consent === 'opted_out') {
    // We may not reply, but a safety message must still reach a person.
    if (rawText != null && URGENT.test(text)) await handoff('Safety-related message from a number that has opted out of WhatsApp. We cannot reply on WhatsApp.', true);
    return;
  }
  if (b.stale) {
    // Delayed delivery (provider outage): too late to answer here, but never silently lost.
    await handoff('A message that WhatsApp delivered very late; the 24-hour reply window may have passed.', rawText != null && URGENT.test(text));
    return;
  }
  if (rawText == null) {
    if (m.type === 'reaction' || m.type === 'system' || m.type === 'request_welcome') return;
    await say('Sorry, I can only read text messages here. Please type your message. Photos and voice notes cannot be received yet.');
    return;
  }
  if (!rawText) return;

  const urgent = URGENT.test(text);
  // A person has taken over: stay out of the way, except for safety.
  const urgentIntake = b.conversation.state.startsWith('intake_') && !!(b.conversation.context as Ctx | null)?.urgent;   // an emergency report in progress keeps going while a person is alerted
  if (b.conversation.handoff_status === 'open' && !urgentIntake) {
    if (urgent) await handoff(`Urgent follow-up: ${text.slice(0, 120)}`, true);
    await say('A team member has your message and will reply as soon as possible.', { dedupe: `hoack:${b.conversation.id}:${Math.floor(Date.now() / 21_600_000)}` });
    return;
  }

  const emergency = 'If anyone is in danger, call your local emergency number now.';
  if (HUMAN.test(text)) { await handoff('The sender asked to speak to a person.'); await say('I have asked a team member to contact you here as soon as possible.'); await setState('idle'); return; }
  if (SENSITIVE.test(text) && !urgent) { await handoff('The message touches a sensitive topic (legal, safety, complaint or dispute).'); await say('Thank you for letting us know. This needs a person, so I have passed it to a team member who will reply here. I cannot give advice on this topic.'); await setState('idle'); return; }

  const ctx: Ctx = b.conversation.context ?? {};
  const state = b.conversation.state;

  // ---------------------------------------------------------------- linking
  const linkCode = LINK_RE.exec(text)?.[1] ?? (state === 'awaiting_code' && BARE_CODE.test(text) ? text : null);
  if (linkCode) {
    const r = await rpc<{ result: string; first_name?: string }>('wa_svc_try_link', { p_contact: b.contact.id, p_code_hash: hashCode(linkCode) });
    if (r.result === 'linked') { await say(`Thanks ${r.first_name ?? ''}, this number is now linked to your tenancy. Reply YES to also receive rent and maintenance notices here, or NO to skip.`.replace('  ', ' ')); await setState('awaiting_consent'); return; }
    await say(r.result === 'locked' ? 'Too many attempts. Please try again in an hour, or ask your property manager for help.'
      : r.result === 'already_linked' ? 'This number is already linked to a tenant account. Please contact your property manager if that is wrong.'
      : r.result === 'blocked' ? 'This number cannot be linked. Please contact your property manager.'
      : 'That code did not work. Please check it and try again, or ask your property manager for a new one.');
    return;
  }
  if (state === 'awaiting_consent') {
    if (YES.test(t)) { await rpc('wa_svc_set_consent', { p_contact: b.contact.id, p_value: 'opted_in' }); await setState('idle'); await say('Done. You will get rent and maintenance notices here. Reply STOP at any time to stop. Reply HELP for what I can do.'); return; }
    if (NO.test(t)) { await setState('idle'); await say('OK, no notices. You can still message me any time. Reply HELP for what I can do.'); return; }
  }

  // ------------------------------------------------------- urgent / safety
  const inIntake = state.startsWith('intake_');
  if (urgent && !(inIntake && ctx.urgent)) {
    await handoff(`Possible emergency: ${text.slice(0, 160)}`, true);
    const tenant = b.contact.verified ? await rpc<any>('wa_svc_tenant_summary', { p_contact: b.contact.id }) : null;
    if (tenant?.verified && tenant.tenancies.length === 1) {
      const tn = tenant.tenancies[0];
      const r = await createRequest(tn.property_id, tn.unit_id, tn.tenancy_id, { desc: text, urgent: true });
      if (r) { await say(`This sounds urgent. I have alerted our team right now and logged request ${r.ref}. ${emergency}`); await setState('idle'); return; }
    }
    await say(`This sounds urgent. I have alerted our team right now. ${emergency} To log it, reply with the property name and your unit number.`);
    await setState('intake_property', { desc: text, urgent: true, fails: 0 });
    return;
  }

  // ------------------------------------------------------------- status
  const st = STATUS_RE.exec(text);
  if (st) {
    const r = await rpc<{ items: { ref: string; title: string; status: string }[] }>('wa_svc_request_status', { p_contact: b.contact.id, p_ref: st[1] ?? null });
    if (!r.items.length) await say(st[1] ? 'I could not find that request for this number. If you reported it from another number, ask from that number.' : 'I do not see any requests from this number yet. Reply REPORT to report a problem.');
    else await say(r.items.map((i) => `${i.ref}: “${i.title.slice(0, 60)}” is ${STATUS_WORDS[i.status] ?? i.status}.`).join('\n'));
    return;
  }

  // ------------------------------------------------------------ balance
  if (BALANCE.test(text)) {
    const s = await rpc<any>('wa_svc_tenant_summary', { p_contact: b.contact.id });
    if (!s.verified) {
      await say(s.reason === 'reverify' ? 'For your privacy, please verify this number again. Ask your property manager for a new link code, then reply LINK followed by the code.'
        : 'To protect your privacy I can only share account details once this number is linked to your tenancy. Ask your property manager for a link code, then reply LINK followed by the code.');
      await setState('awaiting_code');
      return;
    }
    if (!s.balances.length) { await say('I do not see any charges on your tenancy right now.'); return; }
    await say([...s.balances.map((x: any) => `Total outstanding: ${money(x.outstanding_minor, x.currency)}${x.overdue_minor > 0 ? `, of which ${money(x.overdue_minor, x.currency)} is overdue` : ''}${x.next_due_date ? ` (earliest due date ${x.next_due_date})` : ''}.`),
      'This comes from our records and may not include a payment made in the last day. For questions about a charge, reply HUMAN.'].join('\n'));
    return;
  }

  // ----------------------------------------------------- intake sub-flows
  async function createRequest(propertyId: string, unitId: string | null, tenancyId: string | null, c: Ctx): Promise<{ ref: string; escalated: boolean } | null> {
    const title = (c.desc ?? 'Maintenance request').split(/[.!?\n]/)[0]!.trim().slice(0, 80) || 'Maintenance request';
    try {
      const r = await rpc<{ ref: string; escalated: boolean }>('wa_svc_create_request', { p_contact: b.contact.id, p_property: propertyId, p_unit: unitId, p_tenancy: tenancyId, p_title: title.length < 3 ? 'Maintenance request' : title,
        p_description: c.desc ?? title, p_category: categoryOf(c.desc ?? ''), p_urgent: !!c.urgent, p_source_msg: `wa:${m.id}` });
      return r;
    } catch (e) {
      if (e instanceof AppError && e.status === 429) { await handoff('This number reached the daily limit for new requests.'); await say('You have reached the daily limit for requests from this number. I have asked a team member to follow up.'); return null; }
      if (e instanceof AppError && e.status < 500) { d.log.warn('whatsapp intake rejected', { status: e.status }); await handoff('The assistant could not log a maintenance request for this sender.'); await say('I could not log that automatically, so I have asked a team member to help you.'); return null; }
      throw e;
    }
  }
  const finish = async (r: { ref: string; escalated: boolean } | null) => {
    if (!r) { await setState('idle'); return; }
    await say(`Thank you. I have logged your request as ${r.ref}. We will update you here. Reply STATUS ${r.ref} any time.${r.escalated ? ` It looks urgent, so our team has been alerted. ${emergency}` : ''}${b.contact.consent === 'none' ? ' Reply UPDATES to receive progress updates after 24 hours of silence.' : ''}`);
    await setState('idle');
  };
  const toConfirm = async (c: Ctx) => {
    await say(`I will log this: “${(c.desc ?? '').slice(0, 200)}”${c.propertyName ? ` at ${c.propertyName}${c.unitRef ? `, unit ${c.unitRef}` : ''}` : ''}. Reply YES to send it, or NO to cancel.`);
    await setState('intake_confirm', c);
  };
  const fail = async (c: Ctx, msg: string) => {
    const fails = (c.fails ?? 0) + 1;
    if (fails >= 3) { await handoff('The assistant could not match the property or unit this sender described.'); await say('I am having trouble finding that. I have asked a team member to help you.'); await setState('idle'); return; }
    await say(msg); await setState(state, { ...c, fails });
  };

  if (state === 'intake_confirm' && (YES.test(t) || NO.test(t))) {
    if (NO.test(t)) { await say('OK, I have cancelled that. Reply REPORT to start again.'); await setState('idle'); return; }
    if (!ctx.propertyId) { await setState('intake_property', ctx); await say('Which property is this at? Please type the property name.'); return; }
    await finish(await createRequest(ctx.propertyId, ctx.unitId ?? null, ctx.tenancyId ?? null, ctx));
    return;
  }
  if (state === 'intake_pick') {
    const idx = /^\s*(\d{1,2})\b/.exec(text)?.[1];
    const opt = idx ? ctx.options?.[Number(idx) - 1] : undefined;
    if (opt) { await toConfirm({ ...ctx, propertyId: opt.property_id, unitId: opt.unit_id, tenancyId: opt.tenancy_id, propertyName: opt.label, unitRef: undefined, options: undefined }); return; }
    await fail(ctx, `Please reply with a number from the list.`); return;
  }
  if (state === 'intake_describe') {
    if (NO.test(t)) { await say('OK, cancelled.'); await setState('idle'); return; }
    await beginTarget({ ...ctx, desc: text });
    return;
  }
  if (state === 'intake_property') {
    const found = await rpc<{ id: string; name: string }[]>('wa_svc_find_property', { p_text: text });
    if (found.length === 1 || (found[0] && norm(found[0].name) === t)) { const p = found[0]!; await say(`Thanks. Which unit or apartment number at ${p.name}?`); await setState('intake_unit', { ...ctx, propertyId: p.id, propertyName: p.name, fails: 0 }); return; }
    if (found.length > 1) { await fail(ctx, `More than one place matches. Please type the full name: ${found.map((f) => f.name).join(', ')}.`); return; }
    await fail(ctx, 'I could not find that property. Please type the property name as it appears on your lease.'); return;
  }
  if (state === 'intake_unit') {
    const ref = text.replace(/^(unit|apt\.?|apartment|flat|suite|no\.?|number|#)\s*/i, '').trim();
    const found = await rpc<{ id: string; reference: string }[]>('wa_svc_find_unit', { p_property: ctx.propertyId, p_text: ref });
    if (found.length === 1) { await toConfirm({ ...ctx, unitId: found[0]!.id, unitRef: found[0]!.reference, fails: 0 }); return; }
    await fail(ctx, 'I could not find that unit at this property. Please type the unit number exactly as on your lease.'); return;
  }

  async function beginTarget(c: Ctx) {
    const s = b.contact.verified ? await rpc<any>('wa_svc_tenant_summary', { p_contact: b.contact.id }) : null;
    const tenancies: any[] = s?.verified ? s.tenancies : [];
    if (tenancies.length === 1) { const tn = tenancies[0]; await toConfirm({ ...c, propertyId: tn.property_id, propertyName: tn.property_name, unitId: tn.unit_id, unitRef: tn.unit_reference, tenancyId: tn.tenancy_id }); return; }
    if (tenancies.length > 1) {
      const options = tenancies.slice(0, 9).map((x) => ({ tenancy_id: x.tenancy_id, unit_id: x.unit_id, property_id: x.property_id, label: `${x.property_name}, unit ${x.unit_reference}` }));
      await say(`Which home is this about?\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}\nReply with the number.`);
      await setState('intake_pick', { ...c, options });
      return;
    }
    await say('Which property is this at? Please type the property name.');
    await setState('intake_property', { ...c, fails: 0 });
  }
  const startIntake = async (desc: string | null) => {
    if (!desc || desc.length < 15) { await say('Sorry to hear that. What is the problem? Please describe it in a sentence or two.'); await setState('intake_describe', { fails: 0 }); return; }
    await beginTarget({ desc, fails: 0 });
  };

  // -------------------------------------------------------------- FAQ, report, help
  const faqs = await rpc<{ question: string; keywords: string[]; answer: string }[]>('wa_svc_faqs', {});
  const words = new Set(t.replace(/[^a-z0-9\s']/g, ' ').split(' ').filter((w) => w.length > 2));
  let best: { answer: string; score: number } | null = null;
  for (const f of faqs) {
    const kw = f.keywords.filter((k) => t.includes(k.toLowerCase())).length;
    const qw = f.question.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(' ').filter((w) => w.length > 3 && words.has(w)).length;
    const score = kw * 2 + (qw >= 2 ? qw : 0);
    if (score > 0 && (!best || score > best.score)) best = { answer: f.answer, score };
  }
  if (best) { await say(best.answer); await setState('idle'); return; }

  if (/^report\W*$/i.test(t)) { await startIntake(null); return; }
  if (REPORT.test(text)) { await startIntake(text); return; }

  if (HELP.test(t) || state === 'idle' && b.conversation.unknown_streak === 0 && t.length <= 3) {
    await say(`${ch.welcome_text ? ch.welcome_text + '\n\n' : `Hi, this is the ${org} assistant.\n`}I can:\n- take a maintenance report (reply REPORT)\n- check a request (STATUS)\n- answer common questions\n${b.contact.verified ? '- show your balance (BALANCE)\n' : '- link your number to your tenancy (ask your property manager for a code, then reply LINK and the code)\n'}Reply HUMAN to talk to a person, or STOP to stop messages.`);
    await setState('idle');
    return;
  }

  // ------------------------------------------------------------- unknown
  const unknown = (b.conversation.unknown_streak ?? 0) + 1;
  if (unknown >= 2) { await handoff('The assistant did not understand this sender twice in a row.'); await say('I am not sure how to help with that, so I have asked a team member to reply here.'); await setState('idle', {}, 0); return; }
  await say('Sorry, I did not understand that. Reply HELP to see what I can do, or HUMAN to talk to a person.');
  await setState('idle', {}, unknown);
}

const money = (minor: number, currency: string) => `${groupedAmount(minor, currency)} ${currency}`;
