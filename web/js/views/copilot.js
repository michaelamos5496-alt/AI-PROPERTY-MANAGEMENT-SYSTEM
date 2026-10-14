import { api, get, post } from '../api.js';
import { clear, emptyState, h, skeleton, toast } from '../ui.js';
import { errorState, formDialog, fmtTimestamp, pageHeader } from '../kit.js';

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const REF_LINK = { tenancy: 'tenancies', tenant: 'tenants', property: 'properties', maintenance_request: 'maintenance', unit: 'units' };
const STATUS = {
  draft: ['Draft only', 'badge--draft'], proposed: ['Waiting for you', 'badge--draft'], awaiting_approval: ['Waiting for a manager', 'badge--draft'], approved: ['Approved', 'badge--active'],
  executing: ['Running', 'badge--draft'], executed: ['Done', 'badge--active'], rejected: ['Rejected', 'badge--cancelled'], failed: ['Failed', 'badge--cancelled'],
  cancelled: ['Cancelled', 'badge--ended'], expired: ['Expired', 'badge--ended'], withdrawn: ['Withdrawn', 'badge--ended'],
};
const PROMPTS = ['Who is overdue on rent?', 'Income by property this month', 'Which leases expire in the next 60 days?', 'Any unresolved maintenance?', 'Draft a reminder for the largest overdue balance'];

export function copilotView(ctx, conversationId) {
  const root = h('div', { class: 'copilot' }, skeleton(4));
  const state = { status: null, list: [], convo: null, busy: false, error: null, draft: '' };
  const canManage = ctx.can('copilot:manage');
  let busyAbort = null;

  async function boot() {
    try {
      const [status, list] = await Promise.all([get(`${ctx.base}/copilot/status`), get(`${ctx.base}/copilot/conversations`)]);
      state.status = status; state.list = list;
      if (conversationId) state.convo = await get(`${ctx.base}/copilot/conversations/${conversationId}`).catch(() => null);
      draw();
    } catch (e) { clear(root).append(errorState(e, boot)); }
  }

  async function reloadConvo() {
    if (!state.convo) return;
    state.convo = await get(`${ctx.base}/copilot/conversations/${state.convo.id}`);
    state.list = await get(`${ctx.base}/copilot/conversations`).catch(() => state.list);
  }

  async function send(text) {
    const content = text.trim();
    if (!content || state.busy) return;
    state.error = null;
    if (!state.convo) {
      try {
        const c = await post(`${ctx.base}/copilot/conversations`, {});
        state.convo = { id: c.id, title: c.title, messages: [], tool_calls: [], actions: [] };
        history.replaceState(null, '', `#/copilot/${c.id}`);
      } catch (e) { state.error = e.message; return draw(); }
    }
    // Show the question straight away; the server's record replaces it when the answer arrives.
    state.convo.messages = [...state.convo.messages, { id: `pending-${Date.now()}`, role: 'user', content, created_at: new Date().toISOString(), pending: true }];
    state.busy = true; state.draft = ''; busyAbort = new AbortController(); draw();
    try {
      const out = await post(`${ctx.base}/copilot/conversations/${state.convo.id}/messages`, { content });
      state.convo = out.conversation;
      state.list = await get(`${ctx.base}/copilot/conversations`).catch(() => state.list);
    } catch (e) {
      state.error = e.status === 402 ? e.message : e.status === 409 ? e.message : e.status === 429 ? 'You are asking too fast. Wait a moment and try again.' : e.message;
      state.draft = content;
      await reloadConvo().catch(() => {});
    } finally { state.busy = false; busyAbort = null; draw(); }
  }

  async function stop() {
    if (!state.convo) return;
    try { await post(`${ctx.base}/copilot/conversations/${state.convo.id}/cancel`, {}); toast('Stopping…', 'info', 2000); } catch (e) { toast(e.message, 'error'); }
  }

  async function act(action, verb, body = {}) {
    try {
      await post(`${ctx.base}/copilot/actions/${action.id}/${verb}`, body);
      toast(verb === 'confirm' ? 'Done.' : verb === 'submit' ? 'Sent to a manager for approval.' : 'Discarded.', 'success');
    } catch (e) { toast(e.message, 'error'); }
    await reloadConvo().catch(() => {}); draw();
  }

  /* ---------------------------------------------------------- rendering */
  const refChips = (refs) => (refs?.length ? h('div', { class: 'copilot__refs', 'aria-label': 'Records used' }, h('span', { class: 'muted small' }, 'Records used: '),
    refs.map((r) => (REF_LINK[r.type] ? h('a', { class: 'chip', href: `#/${REF_LINK[r.type]}/${r.id}` }, r.label || r.type) : h('span', { class: 'chip' }, r.label || r.type)))) : null);

  function actionCard(a) {
    const [label, cls] = STATUS[a.status] ?? [a.status, ''];
    const fields = a.preview?.fields ?? [];
    const buttons = [];
    if (a.status === 'proposed' && a.policy === 'user_confirmation') buttons.push(h('button', { class: 'btn btn--sm', type: 'button', onclick: () => act(a, 'confirm') }, 'Confirm'));
    if (a.status === 'proposed' && a.policy === 'human_approval') buttons.push(h('button', { class: 'btn btn--sm', type: 'button', onclick: () => act(a, 'submit') }, 'Request approval'));
    if (['draft', 'proposed', 'awaiting_approval'].includes(a.status)) buttons.push(h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => act(a, 'cancel', { note: null }) }, a.status === 'awaiting_approval' ? 'Withdraw' : 'Discard'));
    if (a.approval_id) buttons.push(h('a', { class: 'btn btn--sm btn--secondary', href: `#/approvals/${a.approval_id}` }, 'View approval'));
    const out = a.result;
    return h('div', { class: 'action-card', role: 'group', 'aria-label': a.preview?.summary ?? 'Proposed action' },
      h('div', { class: 'action-card__head' }, h('strong', {}, a.preview?.summary ?? a.kind), h('span', { class: `badge ${cls}` }, label)),
      h('dl', { class: 'action-card__fields' }, fields.flatMap((f) => [h('dt', {}, f.label), h('dd', { class: f.label === 'Message' || f.label === 'Details' ? 'copilot-body' : '' }, f.value)])),
      a.preview?.ai_authored ? h('p', { class: 'small' }, '⚠ Written by the AI. Check every word before it goes anywhere.') : null,
      a.preview?.effect ? h('p', { class: 'muted small' }, a.preview.effect) : null,
      a.status === 'executed' && out ? h('p', { class: 'small' }, h('strong', {}, 'Result: '), outcomeText(a, out)) : null,
      ['failed', 'rejected'].includes(a.status) && a.error ? h('p', { class: 'small' }, `Reason: ${a.error}`) : null,
      buttons.length ? h('div', { class: 'row' }, buttons) : null,
      h('p', { class: 'muted small' }, `Prepared ${fmtTimestamp(a.created_at)} · reference ${a.id.slice(0, 8)}`));
  }
  const outcomeText = (a, r) => (r.request_id ? h('span', {}, 'Maintenance request created. ', h('a', { href: `#/maintenance/${r.request_id}` }, 'Open it')) : r.queued ? `Email queued to ${r.to}.` : r.logged ? `Test note recorded: “${r.note}”.` : JSON.stringify(r));

  function messageNode(m) {
    if (m.role === 'user') return h('div', { class: `msg msg--user ${m.pending ? 'msg--pending' : ''}` }, h('div', { class: 'msg__text' }, m.content));
    const b = m.blocks ?? {};
    const g = b.grounding;
    const warn = [];
    if (g?.unverified_amounts?.length) warn.push(`I could not match these figures to your records: ${g.unverified_amounts.join(', ')}. Treat them as unverified.`);
    if (g?.unknown_ids?.length) warn.push('The answer mentions a record that was not looked up in this conversation. Treat that reference as unverified.');
    if (g?.no_data_used) warn.push('No records were looked up for this answer, so any figures in it are unverified.');
    const proposals = (state.convo.actions ?? []).filter((a) => (b.actions ?? []).includes(a.id));
    return h('div', { class: `msg msg--assistant ${m.status === 'fallback' ? 'msg--fallback' : ''}`, 'data-message-id': m.id },
      h('div', { class: 'msg__text' }, m.content),
      warn.map((w) => h('div', { class: 'notice notice--warn', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, w))),
      b.flagged_sources?.length ? h('div', { class: 'notice notice--critical', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, 'Some record text looked like instructions to the AI. It was treated as plain data and ignored.')) : null,
      (b.notes ?? []).map((n) => h('div', { class: 'muted small' }, n)),
      proposals.map(actionCard),
      refChips(b.refs),
      h('div', { class: 'muted small msg__meta' }, `${fmtTimestamp(m.created_at)}${m.status === 'fallback' ? ' · not answered by the AI' : ''}`,
        b.tools?.length ? h('details', { class: 'inline-details' }, h('summary', {}, `Looked up (${b.tools.length})`), h('span', {}, b.tools.join(', '))) : null,
        m.request_id ? h('span', { class: 'muted small', title: 'Quote this if you need support' }, ` · ref ${String(m.request_id).slice(0, 8)}`) : null));
  }

  function draw() {
    const { convo, status } = state;
    const transcript = h('div', { class: 'copilot__transcript', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' },
      !convo || !convo.messages.length ? emptyState({ icon: '✨', title: 'Ask about your portfolio', text: 'I can answer from your live records and prepare work for you to confirm. I never send, approve or change anything on my own.' }) : null,
      ...(convo?.messages ?? []).map(messageNode),
      state.busy ? h('div', { class: 'msg msg--assistant msg--thinking', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Looking at your records… ', h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: stop }, 'Stop')) : null,
      state.error ? h('div', { class: 'alert alert--error', role: 'alert' }, state.error) : null);
    const input = h('textarea', { class: 'textarea', rows: 2, id: 'copilot-input', placeholder: 'Ask a question, e.g. “Who is overdue on rent?”', maxlength: 4000, 'aria-label': 'Message to the copilot', disabled: state.busy,
      oninput: (e) => { state.draft = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); } } }, state.draft);
    const form = h('form', { class: 'copilot__composer', onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input,
      h('button', { class: 'btn', type: 'submit', disabled: state.busy, 'aria-busy': state.busy ? 'true' : false }, state.busy ? 'Working…' : 'Ask'));
    const chips = h('div', { class: 'copilot__prompts' }, PROMPTS.map((p) => h('button', { class: 'chip chip--button', type: 'button', disabled: state.busy, onclick: () => send(p) }, p)),
      h('button', { class: 'chip chip--button', type: 'button', disabled: state.busy, onclick: () => send('Please run a test action to try the approval flow') }, 'Try the approval process safely'));
    const side = h('aside', { class: 'copilot__side', 'aria-label': 'Conversations' },
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => { state.convo = null; state.error = null; history.replaceState(null, '', '#/copilot'); draw(); } }, 'New conversation'),
      h('ul', { class: 'copilot__list' }, state.list.map((c) => h('li', {}, h('a', { href: `#/copilot/${c.id}`, 'aria-current': convo?.id === c.id ? 'true' : false,
        onclick: async (e) => { e.preventDefault(); history.replaceState(null, '', `#/copilot/${c.id}`); state.error = null; state.convo = await get(`${ctx.base}/copilot/conversations/${c.id}`).catch(() => null); draw(); } }, c.title)))));
    const mode = status.provider === 'offline' ? h('span', { class: 'badge badge--draft', title: 'No AI model is configured; answers come from a fixed rules engine over your records.' }, 'Rules mode') : h('span', { class: 'badge badge--active' }, status.model);
    const ext = status.externalEffective ? 'Emailing tenants is on: every message still needs a manager’s approval.' : 'Emailing tenants is off: I can only write drafts.';
    clear(root).append(
      pageHeader('Copilot', { subtitle: 'Answers come from your current records. It prepares work; people confirm and managers approve.', badges: [mode],
        actions: [canManage && h('button', { class: 'btn btn--secondary', type: 'button', onclick: settingsDialog }, 'Settings')] }),
      !status.settings.enabled ? h('div', { class: 'notice notice--critical', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, 'The copilot is turned off for this organization.')) : null,
      h('div', { class: 'muted small copilot__status' }, ext, ' ', `AI spend today: ${(status.settings.used_today_micro / 1_000_000).toFixed(2)} of ${(status.settings.daily_budget_micro / 1_000_000).toFixed(2)} USD.`),
      h('div', { class: 'copilot__layout' }, side, h('div', { class: 'copilot__main' }, transcript, chips, form)));
    const t = root.querySelector('.copilot__transcript'); if (t) t.scrollTop = t.scrollHeight;
    if (!state.busy) root.querySelector('#copilot-input')?.focus({ preventScroll: true });
  }

  function settingsDialog() {
    const s = state.status.settings;
    formDialog({ title: 'Copilot settings', intro: 'Turning on external messages lets the copilot prepare emails to tenants. Each one still needs a manager’s approval.', submitLabel: 'Save',
      initial: { enabled: s.enabled, externalEnabled: s.external_enabled, budget: s.daily_budget_micro / 1_000_000, perHour: s.max_turns_per_user_hour },
      fields: [
        { name: 'enabled', label: 'Copilot is on', type: 'checkbox', wide: true },
        { name: 'externalEnabled', label: 'Allow it to prepare emails to tenants', type: 'checkbox', wide: true, hint: state.status.externalSwitchOn ? undefined : 'The server-wide switch for external messages is off, so nothing can be sent yet even if you tick this.' },
        { name: 'budget', label: 'Daily AI budget (USD)', type: 'number', min: 0, step: '0.5' },
        { name: 'perHour', label: 'Messages per person per hour', type: 'number', min: 1, max: 1000 },
      ],
      onSubmit: async (v) => {
        await api('PUT', `${ctx.base}/copilot/settings`, { enabled: v.enabled, externalEnabled: v.externalEnabled, dailyBudgetMicro: Math.round((v.budget ?? 0) * 1_000_000), maxTurnsPerUserHour: v.perHour ?? 20 });
        toast('Saved.', 'success'); rerender();
      } });
  }

  boot();
  void busyAbort;
  return root;
}
