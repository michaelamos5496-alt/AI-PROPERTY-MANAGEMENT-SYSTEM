import { api, get, patch, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { crumbs, dataTable, dl, errorState, fmtMoney, fmtTimestamp, formDialog, pageHeader, section } from '../kit.js';
import { parseMoney, toDecimalString } from '../money.js';

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
export const APPROVAL_STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired', invalidated: 'Withdrawn', executing: 'Executing', executed: 'Done', failed: 'Failed' };
const statusClass = { pending: 'badge--draft', approved: 'badge--active', executed: 'badge--active', executing: 'badge--draft', rejected: 'badge--cancelled', failed: 'badge--cancelled', cancelled: 'badge--ended', expired: 'badge--ended', invalidated: 'badge--ended' };
export const approvalBadge = (s) => h('span', { class: `badge ${statusClass[s] ?? ''}` }, APPROVAL_STATUS[s] ?? s);

/** A plain-language statement of exactly what approving will do, built from the immutable payload. */
export function summarize(a) {
  const p = a.payload;
  if (a.action_type === 'maintenance.approve_cost') return `Authorize ${fmtMoney(p.amount_minor, p.currency)} for the work order on this request`;
  if (a.action_type === 'finance.void_charge') return `Void a charge. Reason: “${p.reason}”`;
  return a.action_label;
}
const targetLink = (a) => (a.action_type === 'maintenance.approve_cost' ? `#/maintenance/${a.payload.request_id}` : a.action_type === 'finance.void_charge' ? '#/finance/charges' : null);

/* ------------------------------------------------------------------ approvals */
export function approvalsView(ctx, id) { return id ? approvalDetail(ctx, id) : approvalsList(ctx); }

function approvalsList(ctx) {
  const canDecide = ctx.can('approvals:decide');
  const tabs = canDecide ? [['inbox', 'Inbox'], ['mine', 'My requests'], ['all', 'Everything']] : [['mine', 'My requests']];
  let scope = tabs[0][0];
  const body = h('div', {});
  const tabsNav = h('nav', { class: 'tabs', 'aria-label': 'Approval lists' });
  const draw = () => {
    clear(tabsNav).append(...tabs.map(([k, label]) => h('a', { href: `#/approvals`, 'aria-current': k === scope ? 'page' : false, onclick: (e) => { e.preventDefault(); scope = k; draw(); } }, label)));
    clear(body).append(dataTable({
      ctx, endpoint: '/approvals', persist: false, extraQuery: { scope }, pageSize: 15, searchLabel: 'Search', caption: 'Approvals',
      empty: { icon: '✅', title: scope === 'inbox' ? 'Nothing is waiting for you' : 'No approvals here', text: scope === 'inbox' ? 'When someone asks for sign-off on a cost or a sensitive change, it appears here.' : 'Requests you make that need a manager’s sign-off are listed here.' },
      filters: scope === 'inbox' ? [] : [{ key: 'status', label: 'Status', options: Object.entries(APPROVAL_STATUS) }],
      columns: [
        { label: 'What', render: (a) => [h('a', { href: `#/approvals/${a.id}` }, a.action_label), h('div', { class: 'muted small' }, summarize(a))] },
        { label: 'Requested by', render: (a) => a.requested_by },
        { label: 'Requested', render: (a) => fmtTimestamp(a.requested_at) },
        { label: 'Expires', render: (a) => (['pending', 'approved'].includes(a.status) ? fmtTimestamp(a.expires_at) : '—') },
        { label: 'Status', render: (a) => approvalBadge(a.status) },
        { label: null, class: 'actions', render: (a) => h('a', { class: `btn btn--sm ${a.can_decide ? '' : 'btn--secondary'}`, href: `#/approvals/${a.id}` }, a.can_decide ? 'Review' : 'View') },
      ],
    }));
  };
  draw();
  return h('div', {}, pageHeader('Approvals', { subtitle: 'Actions that need a person’s authorization before they happen.' }), tabsNav, body);
}

function approvalDetail(ctx, id) {
  const root = h('div', {}, skeleton(4));
  async function render() {
    let a;
    try { a = await get(`${ctx.base}/approvals/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const decide = (decision) => formDialog({
      title: decision === 'approve' ? 'Approve this action?' : 'Reject this action?', danger: decision === 'reject', submitLabel: decision === 'approve' ? 'Approve and run' : 'Reject',
      intro: decision === 'approve' ? `Exactly this will happen: ${summarize(a)}. If the record has changed since it was requested, the approval is withdrawn instead.` : `${summarize(a)}. The requester is told.`,
      fields: [{ name: 'note', label: decision === 'approve' ? 'Note (optional)' : 'Why? (optional)', type: 'textarea', wide: true, maxLength: 1000 }],
      onSubmit: async (v) => {
        try { const out = await post(`${ctx.base}/approvals/${a.id}/decision`, { decision, note: v.note }); toast(decision === 'approve' ? 'Approved and carried out.' : 'Rejected.', 'success'); void out; }
        catch (e) { if (e.status === 409) { toast(e.message, 'error'); } else throw e; }
        rerender();
      },
    });
    const actions = [
      a.can_decide && h('button', { class: 'btn', type: 'button', onclick: () => decide('approve') }, 'Approve'),
      a.can_decide && h('button', { class: 'btn btn--danger', type: 'button', onclick: () => decide('reject') }, 'Reject'),
      a.can_retry && h('button', { class: 'btn', type: 'button', onclick: async () => { try { await post(`${ctx.base}/approvals/${a.id}/retry`, {}); toast('Retried.', 'success'); } catch (e) { toast(e.message, 'error'); } rerender(); } }, 'Retry execution'),
      a.can_cancel && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
        if (!(await confirmDialog({ title: 'Withdraw this request?', message: 'It will no longer be actionable.', confirmLabel: 'Withdraw', danger: true }))) return;
        try { await post(`${ctx.base}/approvals/${a.id}/cancel`, { note: null }); toast('Withdrawn.', 'success'); } catch (e) { toast(e.message, 'error'); } rerender(); } }, 'Withdraw'),
    ];
    const link = targetLink(a);
    clear(root).append(
      crumbs({ label: 'Approvals', href: '#/approvals' }, { label: a.action_label }),
      pageHeader(a.action_label, { subtitle: summarize(a), badges: [approvalBadge(a.status)], actions }),
      a.status === 'failed' ? h('div', { class: 'notice notice--critical', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('strong', {}, 'It could not be completed. '), a.execution_error)) : null,
      a.status === 'invalidated' ? h('div', { class: 'notice' }, h('span', { 'aria-hidden': 'true' }, 'ℹ️'), h('span', {}, h('strong', {}, 'Withdrawn. '), a.decision_note ?? a.execution_error ?? 'The record changed after this was requested.')) : null,
      h('div', { class: 'cols-2' },
        section('Request', dl([['Requested by', a.requested_by], ['Requested', fmtTimestamp(a.requested_at)], ['Why', a.request_note], ['Expires', ['pending', 'approved'].includes(a.status) ? fmtTimestamp(a.expires_at) : null],
          ['Record', link && h('a', { href: link }, 'Open the record')]])),
        section('Decision & result', dl([['Decided by', a.decided_by], ['Decided', a.decided_at && fmtTimestamp(a.decided_at)], ['Note', a.decision_note], ['Executed', a.executed_at && fmtTimestamp(a.executed_at)],
          ['Attempts', a.execution_attempts || null], ['Result', a.execution_result && h('code', {}, JSON.stringify(a.execution_result))]]))),
      section('Exactly what was proposed', h('div', {}, h('p', { class: 'muted small' }, 'This is the immutable proposal. Approval applies only to this exact content; changing it requires a new request.'),
        h('pre', { class: 'payload' }, JSON.stringify(a.payload, null, 2)), h('p', { class: 'muted small' }, `Fingerprint ${a.payload_hash.slice(0, 16)}… · idempotency key ${a.execution_key}`))),
      section('History', h('ol', { class: 'timeline' }, a.events.map((e) => h('li', {}, h('strong', {}, APPROVAL_STATUS[e.to_status] ?? e.to_status), h('div', { class: 'small muted' }, `${e.actor ?? 'System'} · ${fmtTimestamp(e.created_at)}`), e.note ? h('div', {}, e.note) : '')))));
  }
  render();
  return root;
}

/* -------------------------------------------------------------- notifications */
export function notificationsView() {
  const root = h('div', {}, skeleton(3));
  async function render() {
    let d;
    try { d = await get('/me/notifications?limit=50'); } catch (e) { return clear(root).append(errorState(e, render)); }
    clear(root).append(pageHeader('Notifications', { subtitle: d.unread ? `${d.unread} unread` : 'You are all caught up.',
      actions: [d.unread > 0 && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => { await post('/me/notifications/read', { ids: null }); rerender(); } }, 'Mark all as read')] }),
      d.items.length ? h('ul', { class: 'notif-list' }, d.items.map((n) => h('li', { class: n.read_at ? '' : 'notif--unread' },
        h('a', { href: n.link ?? '#/notifications', onclick: () => { if (!n.read_at) post('/me/notifications/read', { ids: [n.id] }).catch(() => {}); } }, h('strong', {}, n.title)),
        n.body && h('div', { class: 'muted small' }, n.body.slice(0, 200)), h('div', { class: 'muted small' }, fmtTimestamp(n.created_at)))))
        : emptyState({ icon: '🔔', title: 'No notifications yet', text: 'Escalations, approvals and reminders will appear here.' }));
  }
  render();
  return root;
}

/* ----------------------------------------------------------------- operations */
export function operationsView(ctx, tab = 'delivery') {
  const tabs = [['delivery', 'Delivery'], ['settings', 'Escalation & approvals'], ['urgency', 'Urgency levels']];
  const t = tabs.some(([k]) => k === tab) ? tab : 'delivery';
  const body = h('div', {}, skeleton(3));
  (async () => {
    try { clear(body).append(await ({ delivery: deliveryTab, settings: settingsTab, urgency: urgencyTab }[t])(ctx)); } catch (e) { clear(body).append(errorState(e)); }
  })();
  return h('div', {}, pageHeader('Operations', { subtitle: 'How notifications are delivered and how critical issues are handled.' }),
    h('nav', { class: 'tabs', 'aria-label': 'Operations sections' }, tabs.map(([k, l]) => h('a', { href: `#/operations/${k}`, 'aria-current': k === t ? 'page' : false }, l))), body);
}

async function deliveryTab(ctx) {
  const [queue, runs] = await Promise.all([get(`${ctx.base}/email-queue?limit=1`), get(`${ctx.base}/jobs?limit=12`)]);
  const c = queue.counts;
  const card = (k, label, bad) => h('div', { class: 'card' }, h('div', { class: `stat__value ${bad && c[k] ? 'money-neg' : ''}` }, c[k] ?? 0), h('div', { class: 'stat__label' }, label));
  return h('div', {},
    h('div', { class: 'summary-cards' }, card('queued', 'Queued'), card('sending', 'Sending'), card('sent', 'Sent'), card('failed', 'Retrying', true), card('dead', 'Gave up', true)),
    h('div', { class: 'notice' }, h('span', { 'aria-hidden': 'true' }, 'ℹ️'), h('span', {}, 'Email is queued durably and retried automatically with increasing delays. After 5 failed attempts (or a permanently rejected address) it is marked “gave up” so you can fix the cause and retry it here.')),
    section('Emails', dataTable({
      ctx, endpoint: '/email-queue', persist: false, pageSize: 10, searchLabel: 'Search', caption: 'Email queue',
      empty: { icon: '📬', title: 'No emails yet', text: 'Notifications that go out by email are tracked here.' },
      filters: [{ key: 'status', label: 'Status', options: [['queued', 'Queued'], ['sending', 'Sending'], ['sent', 'Sent'], ['failed', 'Retrying'], ['dead', 'Gave up']] }],
      columns: [
        { label: 'To', render: (e) => e.recipient_email }, { label: 'Subject', render: (e) => e.subject },
        { label: 'Status', render: (e) => [h('span', { class: `badge ${e.status === 'sent' ? 'badge--active' : e.status === 'dead' ? 'badge--cancelled' : e.status === 'failed' ? 'badge--draft' : ''}` }, ({ queued: 'Queued', sending: 'Sending', sent: 'Sent', failed: 'Retrying', dead: 'Gave up' })[e.status] ?? e.status),
          e.last_error ? h('div', { class: 'small muted' }, e.last_error) : ''] },
        { label: 'Attempts', class: 'num', render: (e) => `${e.attempts}/${e.max_attempts}` },
        { label: 'When', render: (e) => fmtTimestamp(e.sent_at ?? e.next_attempt_at ?? e.created_at) },
        { label: null, class: 'actions', render: (e) => (['failed', 'dead'].includes(e.status) ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { try { await post(`${ctx.base}/email-queue/${e.id}/requeue`, {}); toast('Queued to retry.', 'success'); rerender(); } catch (err) { toast(err.message, 'error'); } } }, 'Retry') : '') },
      ],
    })),
    section('Scheduled reminders', h('div', {}, h('p', { class: 'muted' }, 'Rent-due and lease-expiry reminders run on a schedule. Running them again is always safe: nothing is ever sent twice.'),
      runs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Recent job runs'),
        h('thead', {}, h('tr', {}, ['Job', 'Started', 'Result', 'Created'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, runs.map((j) => h('tr', {}, h('td', { 'data-label': 'Job' }, j.job.replace(/_/g, ' ')), h('td', { 'data-label': 'Started' }, fmtTimestamp(j.started_at)),
          h('td', { 'data-label': 'Result' }, h('span', { class: `badge ${j.status === 'ok' ? 'badge--active' : j.status === 'error' ? 'badge--cancelled' : ''}` }, j.status), j.error ? h('div', { class: 'small muted' }, j.error) : ''), h('td', { class: 'num', 'data-label': 'Created' }, j.created_count)))))) : emptyState({ icon: '⏱️', title: 'No runs yet', text: 'The scheduler has not run for this organization.' })),
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: async () => {
        try { const r = await post(`${ctx.base}/jobs/run`, {}); const n = Object.values(r).reduce((s, j) => s + (j.created ?? 0), 0); toast(n ? `${n} reminder${n === 1 ? '' : 's'} queued.` : 'Everything is up to date.', 'success'); rerender(); } catch (e) { toast(e.message, 'error'); } } }, 'Run reminders now')));
}

async function settingsTab(ctx) {
  const [s, members] = await Promise.all([get(`${ctx.base}/maintenance-settings`), get(`${ctx.base}/members`)]);
  const admin = ctx.can('maintenance:settings');
  const seniors = members.filter((m) => ['owner', 'admin', 'manager'].includes(m.role)).map((m) => [m.user_id, `${m.full_name || m.email} (${m.role})`]);
  const thresholdText = Object.entries(s.approval_thresholds).map(([cur, minor]) => `${cur} ${toDecimalString(minor, cur)}`).join('\n');
  const edit = () => formDialog({
    title: 'Escalation & approval settings', submitLabel: 'Save settings',
    initial: { escalationUser: s.escalation_user_id, backupUser: s.backup_user_id, criticalKeywords: s.critical_keywords.join('\n'), ackHours: s.ack_hours, thresholds: thresholdText, allowSelfApproval: s.allow_self_approval },
    fields: [
      { name: 'escalationUser', label: 'Critical-issue contact', type: 'select', options: seniors, placeholder: '— everyone who is an owner or admin —', wide: true, hint: 'The person alerted first. If empty or no longer a manager, all owners and admins are alerted instead, never nobody.' },
      { name: 'backupUser', label: 'Backup contact', type: 'select', options: seniors, placeholder: '— none —', wide: true },
      { name: 'ackHours', label: 'Re-alert after (hours)', type: 'number', min: 1, max: 72, step: 1, required: true, hint: 'Unacknowledged critical issues are chased every this many hours.' },
      { name: 'criticalKeywords', label: 'Safety keywords (one per line)', type: 'textarea', rows: 6, wide: true, hint: 'A report containing any of these is escalated whatever urgency was chosen.' },
      { name: 'thresholds', label: 'Auto-approve estimates up to (one per line, e.g. “USD 250.00”)', type: 'textarea', rows: 3, wide: true, hint: 'Estimates above this need a manager’s approval. With no line for a currency, every estimate needs approval.' },
      { name: 'allowSelfApproval', label: 'Allow people to approve their own requests', type: 'checkbox', wide: true, hint: 'Off by default. Only for very small teams.' },
    ],
    onSubmit: async (v) => {
      const approvalThresholds = {};
      for (const line of (v.thresholds ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) {
        const [cur, amt] = line.split(/\s+/);
        const parsed = parseMoney(amt, (cur ?? '').toUpperCase(), { allowZero: false });
        if (!cur || !amt || !/^[A-Za-z]{3}$/.test(cur) || !parsed.ok) throw Object.assign(new Error(`Could not read “${line}”. Use a currency code and an amount, like USD 250.00.`), { details: [] });
        approvalThresholds[cur.toUpperCase()] = parsed.minor;
      }
      await putSettings(ctx, { escalationUser: v.escalationUser, backupUser: v.backupUser, criticalKeywords: (v.criticalKeywords ?? '').split('\n').map((x) => x.trim()).filter(Boolean), ackHours: v.ackHours, approvalThresholds, allowSelfApproval: v.allowSelfApproval });
      toast('Settings saved.', 'success'); rerender();
    },
  });
  return section('Escalation & approvals', h('div', {}, dl([['Critical-issue contact', s.escalation_user ?? 'Not set — all owners and admins are alerted'], ['Backup contact', s.backup_user], ['Re-alert every', `${s.ack_hours} hours until acknowledged`],
    ['Safety keywords', s.critical_keywords.length ? s.critical_keywords.join(', ') : 'None'], ['Auto-approved estimates', thresholdText ? thresholdText.split('\n').map((l) => h('div', {}, l)) : 'None: every estimate needs approval'],
    ['Self-approval', s.allow_self_approval ? 'Allowed' : 'Not allowed']]), !admin && h('p', { class: 'muted small' }, 'Only admins and owners can change these settings.')), admin && h('button', { class: 'btn', type: 'button', onclick: edit }, 'Edit'));
}
const putSettings = (ctx, body) => api('PUT', `${ctx.base}/maintenance-settings`, body);

async function urgencyTab(ctx) {
  const levels = await get(`${ctx.base}/urgency-levels`);
  const canWrite = ctx.can('maintenance:manage');
  const edit = (l) => formDialog({
    title: l ? `Edit “${l.label}”` : 'Add urgency level', submitLabel: 'Save', initial: l ? { key: l.key, label: l.label, rank: l.rank, isCritical: l.is_critical, tenantSelectable: l.tenant_selectable, isDefault: l.is_default } : { rank: 25, tenantSelectable: true },
    fields: [{ name: 'key', label: 'Key', required: true, maxLength: 31, disabled: !!l, hint: l ? 'Fixed once created.' : 'Lowercase letters, digits, underscores.' }, { name: 'label', label: 'Label', required: true, maxLength: 60 },
      { name: 'rank', label: 'Rank (higher = more urgent)', type: 'number', required: true, min: 1, max: 1000, step: 1 },
      { name: 'isCritical', label: 'Critical: always escalated to a human', type: 'checkbox', wide: true }, { name: 'tenantSelectable', label: 'Tenants can choose this level', type: 'checkbox', wide: true }, { name: 'isDefault', label: 'Default for new requests', type: 'checkbox', wide: true }],
    onSubmit: async (v) => {
      const body = { key: l?.key ?? v.key, label: v.label, rank: v.rank, isCritical: v.isCritical, tenantSelectable: v.tenantSelectable, isDefault: v.isDefault };
      if (l) await patch(`${ctx.base}/urgency-levels/${l.id}`, body); else await post(`${ctx.base}/urgency-levels`, body);
      toast('Saved.', 'success'); rerender();
    },
  });
  const rows = levels.map((l) => h('tr', { class: l.archived_at ? 'row--archived' : false },
    h('td', { 'data-label': 'Level' }, l.label, h('span', { class: 'muted small' }, ` (${l.key})`)),
    h('td', { class: 'num', 'data-label': 'Rank' }, l.rank),
    h('td', { 'data-label': 'Critical' }, l.is_critical ? h('span', { class: 'badge badge--critical' }, '⚠ Critical') : '—'),
    h('td', { 'data-label': 'Tenants' }, l.tenant_selectable ? 'Yes' : 'No'),
    h('td', { 'data-label': 'Default' }, l.is_default ? 'Yes' : ''),
    h('td', { class: 'actions' }, canWrite ? h('span', { class: 'row' },
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => edit(l) }, 'Edit'),
      l.is_default ? '' : h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { try { await post(`${ctx.base}/urgency-levels/${l.id}/archive`, {}); rerender(); } catch (e) { toast(e.message, 'error'); } } }, 'Archive')) : '')));
  const head = h('thead', {}, h('tr', {}, ['Level', 'Rank', 'Critical', 'Tenants can choose', 'Default', ''].map((x) => h('th', { scope: 'col' }, x || h('span', { class: 'visually-hidden' }, 'Actions')))));
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Urgency levels'), head, h('tbody', {}, rows)));
  return section('Urgency levels', h('div', {}, h('p', { class: 'muted' }, 'At least one level must stay critical, so emergencies can never be configured away.'), table,
    canWrite ? h('div', { class: 'row mt-5' }, h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, 'Add level')) : ''));
}
