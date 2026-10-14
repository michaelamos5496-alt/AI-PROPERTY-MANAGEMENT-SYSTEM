import { api, del, get, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, openDialog, skeleton, toast, copyText } from '../ui.js';
import { errorState, fmtMoney, fmtTimestamp, formDialog, loadOptions, pageHeader, section } from '../kit.js';

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const STATUS = { unverified: ['Not verified', 'badge--draft'], verified: ['Verified tenant', 'badge--active'], blocked: ['Blocked', 'badge--cancelled'] };
const CONSENT = { none: 'Not asked', opted_in: 'Accepts notices', opted_out: 'Opted out' };
const MSG_STATUS = { queued: 'Waiting to send', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', dead: 'Could not be sent', blocked: 'Not sent', received: '' };

export function whatsappView(ctx, tab = 'inbox') {
  const admin = ctx.can('whatsapp:manage');
  const tabs = [['inbox', 'Conversations'], admin && ['faqs', 'FAQs'], admin && ['setup', 'Setup']].filter(Boolean);
  const t = tabs.some(([k]) => k === tab) ? tab : 'inbox';
  const body = h('div', {}, skeleton(3));
  (async () => {
    try { clear(body).append(await ({ inbox: inboxTab, faqs: faqsTab, setup: setupTab }[t])(ctx)); } catch (e) { clear(body).append(errorState(e, rerender)); }
  })();
  return h('div', {}, pageHeader('WhatsApp', { subtitle: 'Tenants write to your business number. The assistant answers approved FAQs and takes maintenance reports; people handle everything else.' }),
    h('nav', { class: 'tabs', 'aria-label': 'WhatsApp sections' }, tabs.map(([k, l]) => h('a', { href: `#/whatsapp/${k}`, 'aria-current': k === t ? 'page' : false }, l))), body);
}

/* ------------------------------------------------------------------ inbox */
async function inboxTab(ctx) {
  const [handoffs, contacts] = await Promise.all([get(`${ctx.base}/whatsapp/handoffs`), get(`${ctx.base}/whatsapp/contacts?limit=100`)]);
  const badge = (s) => { const [l, c] = STATUS[s] ?? [s, '']; return h('span', { class: `badge ${c}` }, l); };
  return h('div', {},
    handoffs.length ? section(`Needs a person (${handoffs.length})`, h('ul', { class: 'notif-list' }, handoffs.map((x) => h('li', { class: x.urgent ? 'notif--unread' : '' },
      h('strong', {}, `${x.urgent ? 'URGENT · ' : ''}${x.tenant_name ?? x.name ?? x.number}`), h('span', { class: 'muted small' }, ` ${x.verified ? '(verified tenant)' : '(not verified)'} · ${x.number} · since ${fmtTimestamp(x.since)}`),
      h('div', {}, x.reason), h('div', { class: 'row' },
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => contactDialog(ctx, x.contact_id) }, 'Open conversation'),
        h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: async () => { try { await post(`${ctx.base}/whatsapp/handoffs/${x.conversation_id}/resolve`, {}); toast('Marked as handled.', 'success'); } catch (e) { toast(e.message, 'error'); } rerender(); } }, 'Mark handled')))))) : null,
    section('Link a tenant', h('div', {}, h('p', { class: 'muted small' }, 'A phone number alone proves nothing. Give the tenant a one-time code; when they send it from their WhatsApp, that number is linked to them and only then can they ask about their own balance or requests.'),
      h('button', { class: 'btn', type: 'button', onclick: () => linkDialog(ctx) }, 'Create a link code'))),
    section('Contacts', contacts.length ? h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'WhatsApp contacts'),
      h('thead', {}, h('tr', {}, ['Who', 'Number', 'Identity', 'Notices', 'Last message', ''].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, contacts.map((c) => h('tr', {}, h('td', {}, c.tenant_name ?? c.name ?? '—', c.handoff === 'open' ? [' ', h('span', { class: 'badge badge--critical' }, 'Needs a person')] : ''), h('td', {}, c.number), h('td', {}, badge(c.status)),
        h('td', {}, CONSENT[c.consent]), h('td', {}, c.last_inbound_at ? fmtTimestamp(c.last_inbound_at) : '—'), h('td', { class: 'actions' }, h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => contactDialog(ctx, c.id) }, 'Open')))))
    ) : emptyState({ icon: '💬', title: 'No conversations yet', text: 'When someone messages your WhatsApp number, they appear here.' })));
}

async function linkDialog(ctx) {
  let tenants;
  try { tenants = await loadOptions(ctx, '/tenants', (x) => [x.id, x.full_name]); } catch (e) { return toast(e.message, 'error'); }
  formDialog({ title: 'Create a link code', intro: 'The code works once and expires in 48 hours. The tenant must have an active tenancy. A new code replaces any earlier unused one.', submitLabel: 'Create code',
    fields: [{ name: 'tenantId', label: 'Tenant', type: 'select', required: true, options: tenants.options, hint: tenants.truncated ? 'Showing the first 100 tenants.' : undefined }],
    onSubmit: async (v) => {
      const r = await post(`${ctx.base}/whatsapp/link-codes`, { tenantId: v.tenantId });
      openDialog({ title: `Code for ${r.tenant_name}`, closeLabel: 'Done', body: h('div', {}, h('p', {}, h('strong', { class: 'code-big' }, r.code)), h('p', {}, r.instructions), h('p', { class: 'muted small' }, 'This code is shown only now. Share it privately (in person or by a trusted channel).'),
        h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => copyText(r.code).then(() => toast('Copied.', 'success')) }, 'Copy code')) });
    } });
}

async function contactDialog(ctx, id) {
  let c;
  try { c = await get(`${ctx.base}/whatsapp/contacts/${id}`); } catch (e) { return toast(e.message, 'error'); }
  const list = h('div', { class: 'wa-thread', role: 'log', 'aria-label': 'Messages', tabindex: '0' }, c.messages.map((m) => h('div', { class: `wa-msg wa-msg--${m.direction}` },
    h('div', { class: 'prewrap' }, m.kind === 'template' ? `[Template] ${m.body ?? ''}` : m.body ?? ''),
    h('div', { class: 'muted small' }, `${m.direction === 'in' ? 'Tenant' : m.origin === 'staff' ? 'Team' : m.origin === 'approval' ? 'Approved message' : 'Assistant'} · ${fmtTimestamp(m.created_at)}${MSG_STATUS[m.status] ? ' · ' + MSG_STATUS[m.status] : ''}${m.error ? ' · ' + m.error : ''}`))));
  const replyBox = h('textarea', { class: 'textarea', rows: 2, maxlength: 1000, 'aria-label': 'Reply', placeholder: c.window_open ? 'Write a reply…' : 'You can reply within 24 hours of their last message.', disabled: !c.window_open || c.consent === 'opted_out' || c.status === 'blocked' });
  const sendBtn = h('button', { class: 'btn btn--sm', type: 'button', disabled: replyBox.disabled, onclick: async () => {
    try { await post(`${ctx.base}/whatsapp/contacts/${id}/reply`, { text: replyBox.value }); toast('Queued.', 'success'); dlg.close(); } catch (e) { toast(e.message, 'error'); } } }, 'Send reply');
  const actions = h('div', { class: 'row' },
    c.status === 'verified' ? h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => reminderDialog(ctx, c) }, 'Draft rent reminder') : null,
    c.status !== 'unverified' ? h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Unlink this number?', message: 'It will lose access to tenant information until it is verified again.', confirmLabel: 'Unlink', danger: true })) { await post(`${ctx.base}/whatsapp/contacts/${id}/unlink`, { block: false }); dlg.close(); rerender(); } } }, 'Unlink') : null,
    c.status !== 'blocked' ? h('button', { class: 'btn btn--sm btn--danger', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Block this number?', message: 'The assistant will ignore every message from it.', confirmLabel: 'Block', danger: true })) { await post(`${ctx.base}/whatsapp/contacts/${id}/unlink`, { block: true }); dlg.close(); rerender(); } } }, 'Block') : null);
  const dlg = openDialog({ title: `${c.tenant_name ?? c.name ?? 'Contact'} · ${c.number}`, closeLabel: 'Close', body: h('div', {},
    h('p', { class: 'muted small' }, `${(STATUS[c.status] ?? [c.status])[0]} · ${CONSENT[c.consent]}${c.verified_at ? ' · verified ' + fmtTimestamp(c.verified_at) : ''}`),
    c.handoff === 'open' ? h('div', { class: 'notice notice--critical', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, c.handoff_reason)) : null,
    list, h('div', { class: 'wa-reply' }, replyBox, sendBtn), actions) });
}

async function reminderDialog(ctx, c) {
  let cand;
  try { cand = await get(`${ctx.base}/whatsapp/contacts/${c.id}/reminder-candidates`); } catch (e) { return toast(e.message, 'error'); }
  if (!cand.eligible) return toast(cand.reason ?? 'This tenant cannot be messaged on WhatsApp.', 'error');
  if (!cand.charges.length) return toast('Nothing is outstanding for this tenant.', 'info');
  formDialog({ title: 'Draft a rent reminder', intro: 'This only prepares a draft from the ledger and your approved template. Nothing is sent until you request approval and another manager approves.', submitLabel: 'Prepare draft',
    fields: [{ name: 'chargeId', label: 'Charge', type: 'select', required: true, options: cand.charges.map((x) => [x.id, `${x.description} · due ${x.due_date} · ${fmtMoney(x.outstanding_minor, x.currency)}${x.overdue ? ' (overdue)' : ''}`]) }],
    onSubmit: async (v) => {
      const draft = await post(`${ctx.base}/whatsapp/contacts/${c.id}/reminder-draft`, { chargeId: v.chargeId });
      const fields = draft.preview?.fields ?? [];
      openDialog({ title: 'Draft (not sent)', closeLabel: 'Close', actions: [{ label: 'Request approval', onClick: async (close) => {
        try { await post(`${ctx.base}/whatsapp/reminders/${draft.id}/request-approval`, {}); toast('Sent to the approvals inbox.', 'success'); close(); } catch (e) { toast(e.message, 'error'); } } }],
        body: h('div', {}, h('dl', { class: 'action-card__fields' }, fields.flatMap((f) => [h('dt', {}, f.label), h('dd', { class: 'prewrap' }, f.value)])), h('p', { class: 'muted small' }, draft.preview?.effect)) });
    } });
}

/* -------------------------------------------------------------------- faqs */
async function faqsTab(ctx) {
  const faqs = await get(`${ctx.base}/whatsapp/faqs`);
  const edit = (f) => formDialog({ title: f ? 'Edit FAQ' : 'New FAQ', submitLabel: 'Save', initial: f ? { question: f.question, keywords: f.keywords.join(', '), answer: f.answer, active: f.active } : { active: true },
    intro: 'The assistant only answers from these. A question is matched when a message contains one of the keywords.',
    fields: [{ name: 'question', label: 'Question', required: true, maxLength: 200, wide: true }, { name: 'keywords', label: 'Keywords (comma separated)', hint: 'For example: office hours, opening hours', wide: true },
      { name: 'answer', label: 'Answer', type: 'textarea', required: true, maxLength: 1000, wide: true }, { name: 'active', label: 'Active', type: 'checkbox' }],
    onSubmit: async (v) => {
      const body = { question: v.question, keywords: (v.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean), answer: v.answer, active: v.active };
      await (f ? api('PUT', `${ctx.base}/whatsapp/faqs/${f.id}`, body) : post(`${ctx.base}/whatsapp/faqs`, body));
      toast('Saved.', 'success'); rerender();
    } });
  return h('div', {}, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add an FAQ')),
    faqs.length ? h('ul', { class: 'notif-list' }, faqs.map((f) => h('li', {}, h('strong', {}, f.question), f.active ? '' : h('span', { class: 'badge badge--ended' }, 'Off'), h('div', { class: 'prewrap' }, f.answer), h('div', { class: 'muted small' }, f.keywords.join(', ') || 'no keywords'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => edit(f) }, 'Edit'),
        h('button', { class: 'btn btn--sm btn--danger', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Delete this FAQ?', message: f.question, confirmLabel: 'Delete', danger: true })) { await del(`${ctx.base}/whatsapp/faqs/${f.id}`); rerender(); } } }, 'Delete')))))
      : emptyState({ icon: '❓', title: 'No FAQs yet', text: 'Add the answers tenants ask for most (office hours, parking, how to pay). Without them the assistant offers a person instead of guessing.' }));
}

/* ------------------------------------------------------------------- setup */
async function setupTab(ctx) {
  const [c, members] = await Promise.all([get(`${ctx.base}/whatsapp/channel`), get(`${ctx.base}/members`)]);
  const managers = members.filter((m) => ['owner', 'admin', 'manager'].includes(m.role)).map((m) => [m.user_id, `${m.full_name || m.email} (${m.role})`]);
  const ch = c.channel; const s = c.server;
  const row = (label, ok, hint) => h('li', {}, h('span', { 'aria-hidden': 'true' }, ok ? '✅ ' : '⬜ '), h('strong', {}, label), h('span', { class: 'muted small' }, ` ${ok ? 'configured' : 'missing'}${hint ? ' · ' + hint : ''}`));
  const open = () => formDialog({ title: 'WhatsApp number', submitLabel: 'Save',
    initial: ch ? { phoneNumberId: ch.phone_number_id, displayNumber: ch.display_number, wabaId: ch.waba_id, enabled: ch.enabled, intakeUser: ch.intake_user_id, urgentUser: ch.urgent_contact_user_id, welcomeText: ch.welcome_text,
      rentTemplateName: ch.rent_template_name, rentTemplateLang: ch.rent_template_lang, rentTemplateBody: ch.rent_template_body, updateTemplateName: ch.update_template_name, updateTemplateLang: ch.update_template_lang } : { rentTemplateLang: 'en', updateTemplateLang: 'en' },
    fields: [
      { name: 'phoneNumberId', label: 'Phone number ID', required: true, hint: 'The numeric ID from Meta (WhatsApp → API setup). It is not the phone number.', wide: true },
      { name: 'displayNumber', label: 'Number shown to tenants' }, { name: 'wabaId', label: 'WhatsApp Business Account ID' },
      { name: 'intakeUser', label: 'Log chat reports as', type: 'select', required: true, options: managers, hint: 'Requests created from chat are attributed to this manager and marked as WhatsApp.' },
      { name: 'urgentUser', label: 'Who is alerted for urgent messages', type: 'select', options: managers, hint: 'If empty, every admin is alerted.' },
      { name: 'welcomeText', label: 'Welcome text (optional)', type: 'textarea', wide: true, maxLength: 600 },
      { name: 'rentTemplateName', label: 'Rent reminder template name', hint: 'Must be approved by Meta. Parameters: {{1}} first name, {{2}} amount, {{3}} due date.' }, { name: 'rentTemplateLang', label: 'Language code' },
      { name: 'rentTemplateBody', label: 'Approved wording (for previews)', type: 'textarea', wide: true, maxLength: 1024 },
      { name: 'updateTemplateName', label: 'Request update template name', hint: 'Parameters: {{1}} reference, {{2}} what happened.' }, { name: 'updateTemplateLang', label: 'Language code' },
      { name: 'enabled', label: 'Channel is on', type: 'checkbox', wide: true }],
    onSubmit: async (v) => { await api('PUT', `${ctx.base}/whatsapp/channel`, { ...v, urgentUser: v.urgentUser || null }); toast('Saved.', 'success'); rerender(); } });
  return h('div', {},
    section('Connection', h('div', {}, h('ul', { class: 'checklist' },
      row('Delivery mode', s.provider === 'cloud', s.provider === 'cloud' ? 'sending through the Meta Cloud API' : 'test mode: messages are recorded, never sent'),
      row('App secret (signature check)', s.appSecretConfigured), row('Webhook verify token', s.verifyTokenConfigured), row('Access token', s.accessTokenConfigured), row('Service role key', s.serviceConfigured),
      row('Emailing/messaging tenants allowed on this server', s.externalSwitchOn, 'needed for approved WhatsApp reminders')),
      h('p', {}, 'Callback URL for Meta: ', h('code', {}, s.webhookUrl), ' ', h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => copyText(s.webhookUrl).then(() => toast('Copied.', 'success')) }, 'Copy')),
      h('p', { class: 'muted small' }, `Subscribe the app to the “messages” field. Graph API version: ${s.graphVersion}. Nothing here proves a live connection: send a real test message and watch it appear under Conversations.`))),
    section('Number', ch ? h('div', {}, h('dl', { class: 'dl' }, ...[['Phone number ID', ch.phone_number_id], ['Shown as', ch.display_number], ['Status', ch.enabled ? 'On' : 'Off'], ['Reports logged as', ch.intake_user], ['Urgent contact', ch.urgent_contact ?? 'All admins'],
      ['Contacts', `${c.stats.contacts} (${c.stats.verified} verified)`], ['Waiting for a person', c.stats.open_handoffs], ['Unprocessed webhook events', c.stats.pending_events], ['Messages sent (7 days)', Object.entries(c.stats.outbound_7d).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none']].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')])),
      h('button', { class: 'btn', type: 'button', onclick: open }, 'Edit')) : h('div', {}, h('p', { class: 'muted' }, 'No number is connected yet.'), h('button', { class: 'btn', type: 'button', onclick: open }, 'Connect a number'))));
}
