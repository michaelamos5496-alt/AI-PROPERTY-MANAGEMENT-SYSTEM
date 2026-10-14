import { get, patch, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { archivedBadge, crumbs, dataTable, dl, errorState, fmtMoney, fmtTimestamp, formDialog, loadOptions, options, pageHeader, section } from '../kit.js';

export const MAINT_STATUS = { submitted: 'Submitted', triaged: 'Triaged', awaiting_approval: 'Awaiting approval', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', cancelled: 'Cancelled' };
export const MAINT_CATEGORY = { plumbing: 'Plumbing', electrical: 'Electrical', heating_cooling: 'Heating & cooling', appliances: 'Appliances', structural: 'Structural', pest: 'Pests', security: 'Security', cleaning: 'Cleaning', grounds: 'Grounds', other: 'Other' };
const WO_STATUS = { assigned: 'Assigned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };

export const statusPill = (s) => h('span', { class: `badge badge--m-${s}` }, MAINT_STATUS[s] ?? s);
export const urgencyPill = (label, critical) => h('span', { class: `badge ${critical ? 'badge--critical' : ''}` }, critical ? `⚠ ${label}` : label);
const fail = (message) => { throw Object.assign(new Error(message), { details: [] }); };

/* --------------------------------------------------------------------- forms */
const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

export async function openRequestForm(ctx, { property, unit } = {}, done) {
  let props; let units; let levels;
  try {
    [props, units, levels] = await Promise.all([loadOptions(ctx, '/properties', (p) => [p.id, p.name], '&sort=name'), loadOptions(ctx, '/units', (u) => [u.id, u.property_name, u.reference, u.property_id], '&sort=property'), get(`${ctx.base}/urgency-levels`)]);
  } catch (e) { return toast(e.message, 'error'); }
  if (!props.options.length) return toast('Add a property first.', 'error');
  const where = [...units.options.map(([id, pn, ref, pid]) => [`unit:${id}:${pid}`, `${pn} · unit ${ref}`]), ...props.options.map(([id, name]) => [`property:${id}`, `${name} — common area / whole property`])];
  const preset = unit ? where.find(([v]) => v.startsWith(`unit:${unit}:`))?.[0] : property ? `property:${property}` : undefined;
  const def = levels.find((l) => l.is_default)?.id;
  formDialog({
    title: 'New maintenance request', intro: 'Anything mentioning a safety risk (for example a gas leak) is escalated to a human automatically, whatever urgency you choose.',
    fields: [
      { name: 'where', label: 'Location', type: 'select', required: true, options: where, default: preset, wide: true, hint: units.truncated ? 'Showing the first 100 units.' : undefined },
      { name: 'title', label: 'Title', required: true, maxLength: 160, wide: true },
      { name: 'description', label: 'What is wrong?', type: 'textarea', required: true, maxLength: 4000, wide: true, rows: 4 },
      { name: 'category', label: 'Category', type: 'select', required: true, options: options(MAINT_CATEGORY), default: 'other' },
      { name: 'urgency', label: 'Urgency', type: 'select', required: true, options: levels.map((l) => [l.id, l.label]), default: def },
    ],
    submitLabel: 'Submit request',
    onSubmit: async (v) => {
      const [kind, id, pid] = v.where.split(':');
      const r = await post(`${ctx.base}/maintenance`, { property: kind === 'unit' ? pid : id, unit: kind === 'unit' ? id : null, tenancy: null, title: v.title, description: v.description, category: v.category, urgency: v.urgency });
      toast(r.escalation_required ? 'Request submitted and escalated as critical.' : 'Request submitted.', 'success');
      location.hash = `#/maintenance/${r.id}`;
      done?.(r);
    },
  });
}

async function openAssign(ctx, r, done) {
  let members; let vendors;
  try { [members, vendors] = await Promise.all([get(`${ctx.base}/members`), get(`${ctx.base}/vendors?limit=100`)]); } catch (e) { return toast(e.message, 'error'); }
  const self = ctx.me.profile.id;
  const people = members.filter((m) => ['owner', 'admin', 'manager', 'staff'].includes(m.role) && (ctx.can('maintenance:manage') || m.user_id === self))
    .map((m) => [m.user_id, `${m.full_name || m.email}${m.user_id === self ? ' (me)' : ''}`]);
  formDialog({
    title: 'Assign work', intro: ctx.can('maintenance:manage') ? 'Assign to a staff member or an outside vendor.' : 'You can assign work to yourself, or to a vendor.',
    fields: [
      { name: 'assignee', label: 'Staff member', type: 'select', options: people, placeholder: '— none —', wide: true },
      { name: 'vendor', label: 'or vendor', type: 'select', options: vendors.items.map((v) => [v.id, v.name]), placeholder: '— none —', wide: true },
      { name: 'scope', label: 'What needs doing', type: 'textarea', required: true, maxLength: 2000, wide: true },
      { name: 'estimateMinor', label: `Estimate (${r.property.currency}, optional)`, type: 'money', currency: r.property.currency, positive: true, hint: 'A cost estimate may need a manager’s approval before work starts.' },
      { name: 'estimateNote', label: 'Estimate note', maxLength: 1000 },
    ],
    submitLabel: 'Assign',
    onSubmit: async (v) => {
      if ((v.assignee == null) === (v.vendor == null)) fail('Choose either a staff member or a vendor.');
      const out = await post(`${ctx.base}/maintenance/${r.id}/work-orders`, v);
      toast(out.status === 'awaiting_approval' ? 'Assigned. The estimate was sent for approval.' : 'Work assigned.', 'success');
      done();
    },
  });
}

const openEstimate = (ctx, r, wo, done) => formDialog({
  title: 'Submit estimate', intro: 'A new estimate replaces the previous one and withdraws any approval that was waiting on it.',
  fields: [{ name: 'amountMinor', label: `Estimate (${wo.currency})`, type: 'money', currency: wo.currency, required: true, positive: true }, { name: 'note', label: 'Note', maxLength: 1000, wide: true }],
  submitLabel: 'Submit estimate', onSubmit: async (v) => { await post(`${ctx.base}/work-orders/${wo.id}/estimates`, v); toast('Estimate submitted.', 'success'); done(); },
});

const reason = ({ title, intro, submitLabel, danger = true, fields, onSubmit }) => formDialog({
  title, intro, submitLabel, danger, onSubmit,
  fields: fields ?? [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, wide: true, maxLength: 500 }],
});

/* ---------------------------------------------------------------------- list */
export async function maintenanceListView(ctx) {
  let levels; let props;
  try { [levels, props] = await Promise.all([get(`${ctx.base}/urgency-levels`), loadOptions(ctx, '/properties', (p) => [p.id, p.name], '&sort=name')]); } catch (e) { return errorState(e); }
  const add = () => h('button', { class: 'btn', type: 'button', onclick: () => openRequestForm(ctx) }, 'New request');
  return h('div', {}, pageHeader('Maintenance', { subtitle: 'Requests from tenants and staff, from report to resolution.', actions: [add()] }),
    dataTable({
      ctx, endpoint: '/maintenance', defaultSort: 'created', defaultDir: 'desc', searchLabel: 'Search requests', caption: 'Maintenance requests',
      empty: { icon: '🛠️', title: 'No maintenance requests', text: 'Requests raised by tenants or staff appear here.', action: add() },
      totals: (d) => (d.attention ? h('div', { class: 'notice notice--critical', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⚠'),
        h('span', {}, h('strong', {}, `${d.attention} critical issue${d.attention === 1 ? '' : 's'} need${d.attention === 1 ? 's' : ''} acknowledgement. `), h('a', { href: '#/maintenance?attention=true' }, 'Show them'))) : ''),
      filters: [{ key: 'status', label: 'Status', options: options(MAINT_STATUS) }, { key: 'urgency', label: 'Urgency', options: levels.map((l) => [l.id, l.label]) },
        { key: 'property', label: 'Property', options: props.options }, { key: 'category', label: 'Category', options: options(MAINT_CATEGORY) },
        { key: 'attention', label: 'Needs acknowledgement', type: 'checkbox' }],
      columns: [
        { label: 'Request', sort: 'created', render: (r) => [h('a', { href: `#/maintenance/${r.id}` }, r.title), r.escalation_required && !r.escalation_ack_at && !['resolved', 'cancelled'].includes(r.status) ? [' ', h('span', { class: 'badge badge--critical' }, 'Unacknowledged')] : '', r.reported_via === 'tenant' ? [' ', h('span', { class: 'badge' }, 'Tenant')] : ''] },
        { label: 'Property', sort: 'property', render: (r) => `${r.property_name}${r.unit_reference ? ` · ${r.unit_reference}` : ''}` },
        { label: 'Urgency', sort: 'urgency', render: (r) => urgencyPill(r.urgency_label, r.urgency_critical) },
        { label: 'Status', sort: 'status', render: (r) => [statusPill(r.status), r.pending_approvals > 0 ? [' ', h('span', { class: 'badge badge--m-awaiting_approval' }, 'Approval pending')] : ''] },
        { label: 'Category', render: (r) => MAINT_CATEGORY[r.category] },
        { label: 'Updated', sort: 'updated', render: (r) => fmtTimestamp(r.updated_at) },
      ],
    }));
}

/* -------------------------------------------------------------------- detail */
export function maintenanceDetailView(ctx, id) {
  const root = h('div', {}, skeleton(5));
  async function render() {
    let r;
    try { r = await get(`${ctx.base}/maintenance/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const run = async (fn, msg) => { try { await fn(); toast(msg, 'success'); render(); } catch (e) { toast(e.message, 'error'); } };
    const closed = ['resolved', 'cancelled'].includes(r.status);
    const u = r.urgency;
    const active = r.work_orders.filter((w) => ['assigned', 'in_progress'].includes(w.status));
    const actions = [
      r.status === 'submitted' && h('button', { class: 'btn', type: 'button', onclick: () => run(() => post(`${ctx.base}/maintenance/${r.id}/triage`, { expectedVersion: r.version, category: null, note: null }), 'Request triaged.') }, 'Triage'),
      ['submitted', 'triaged', 'assigned', 'in_progress', 'awaiting_approval'].includes(r.status) && h('button', { class: r.status === 'submitted' ? 'btn btn--secondary' : 'btn', type: 'button', onclick: () => openAssign(ctx, r, render) }, 'Assign work'),
      r.status === 'in_progress' && !active.length && h('button', { class: 'btn', type: 'button', onclick: () => formDialog({
        title: 'Resolve request', intro: 'Describe what was done. The tenant can see this note.', submitLabel: 'Resolve',
        fields: [{ name: 'resolutionNotes', label: 'Resolution notes', type: 'textarea', required: true, wide: true, maxLength: 4000, rows: 4 }],
        onSubmit: async (v) => { await post(`${ctx.base}/maintenance/${r.id}/resolve`, { expectedVersion: r.version, ...v }); toast('Request resolved.', 'success'); render(); } }) }, 'Resolve'),
      r.status === 'resolved' && ctx.can('maintenance:manage') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => reason({ title: 'Reopen request', danger: false, submitLabel: 'Reopen',
        onSubmit: async (v) => { await post(`${ctx.base}/maintenance/${r.id}/reopen`, { expectedVersion: r.version, ...v }); toast('Request reopened.', 'success'); render(); } }) }, 'Reopen'),
      !closed && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
        const levels = await get(`${ctx.base}/urgency-levels`);
        formDialog({ title: 'Change urgency', intro: 'Raising urgency is open to staff. Lowering it needs a manager, a reason, and an acknowledged escalation. A critical escalation is never cleared.', submitLabel: 'Change urgency',
          fields: [{ name: 'urgency', label: 'Urgency', type: 'select', required: true, options: levels.map((l) => [l.id, l.label]), default: r.urgency_id, wide: true }, { name: 'reason', label: 'Reason', maxLength: 500, wide: true }],
          onSubmit: async (v) => { await post(`${ctx.base}/maintenance/${r.id}/urgency`, { expectedVersion: r.version, ...v }); toast('Urgency updated.', 'success'); render(); } });
      } }, 'Change urgency'),
      !closed && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => reason({ title: 'Cancel this request?', intro: 'The request stays on record as cancelled, and any open work orders and approvals are withdrawn.', submitLabel: 'Cancel request',
        onSubmit: async (v) => { await post(`${ctx.base}/maintenance/${r.id}/cancel`, { expectedVersion: r.version, ...v }); toast('Request cancelled.', 'success'); render(); } }) }, 'Cancel request'),
    ];

    const escalation = r.escalation_required ? h('div', { class: `notice ${r.escalation_ack_at ? '' : 'notice--critical'}`, role: r.escalation_ack_at ? 'note' : 'alert' },
      h('span', { 'aria-hidden': 'true' }, r.escalation_ack_at ? '✔' : '⚠'),
      h('span', {}, h('strong', {}, r.escalation_ack_at ? `Critical issue acknowledged by ${r.escalation_ack_by_name}. ` : 'Critical issue: a human must acknowledge this. '),
        r.escalated_at ? `Escalated ${fmtTimestamp(r.escalated_at)} to ${r.escalation_fallback ? 'all owners and admins (no designated contact is set)' : r.escalated_to_name}. ` : '',
        r.safety_flag ? 'A safety keyword was detected in the report. ' : '',
        !r.escalation_ack_at && ctx.can('maintenance:manage') && !closed ? h('button', { class: 'btn btn--danger btn--sm', type: 'button', onclick: () => run(() => post(`${ctx.base}/maintenance/${r.id}/acknowledge`, {}), 'Escalation acknowledged.') }, 'Acknowledge') : '')) : null;

    const woRows = r.work_orders.map((w) => {
      const mine = w.assignee_user_id === ctx.me.profile.id || ctx.can('maintenance:manage');
      const open = ['assigned', 'in_progress'].includes(w.status);
      return h('tr', { class: w.status === 'cancelled' ? 'row--archived' : false },
        h('td', { 'data-label': 'Assigned to' }, w.vendor ? [w.vendor.name, ' ', h('span', { class: 'badge' }, 'Vendor')] : w.assignee, h('div', { class: 'muted small' }, w.scope)),
        h('td', { 'data-label': 'Status' }, h('span', { class: 'badge' }, WO_STATUS[w.status])),
        h('td', { class: 'num', 'data-label': 'Estimate' }, w.current_estimate ? fmtMoney(w.current_estimate.amount_minor, w.currency) : '—'),
        h('td', { 'data-label': 'Approved cost' }, w.approved_cost_minor != null ? h('span', { class: 'money-pos' }, fmtMoney(w.approved_cost_minor, w.currency))
          : w.approval ? h('a', { href: `#/approvals/${w.approval.id}` }, `Approval ${w.approval.status}`) : w.current_estimate ? 'Not approved' : '—'),
        h('td', { class: 'num', 'data-label': 'Actual' }, w.actual_cost_minor != null ? fmtMoney(w.actual_cost_minor, w.currency) : '—'),
        h('td', { class: 'actions' }, open && mine && h('span', { class: 'row' },
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => openEstimate(ctx, r, w, render) }, 'Estimate'),
          w.status === 'assigned' && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => run(() => post(`${ctx.base}/work-orders/${w.id}/start`, {}), 'Work started.') }, 'Start'),
          w.status === 'in_progress' && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => formDialog({ title: 'Complete work', submitLabel: 'Mark complete',
            fields: [{ name: 'actualCostMinor', label: `Actual cost (${w.currency}, optional)`, type: 'money', currency: w.currency }, { name: 'notes', label: 'Completion notes', type: 'textarea', wide: true, maxLength: 2000 }],
            onSubmit: async (v) => { await post(`${ctx.base}/work-orders/${w.id}/complete`, v); toast('Work completed.', 'success'); render(); } }) }, 'Complete'),
          ctx.can('maintenance:manage') && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => reason({ title: 'Cancel this work order?', submitLabel: 'Cancel work order',
            onSubmit: async (v) => { await post(`${ctx.base}/work-orders/${w.id}/cancel`, v); toast('Work order cancelled.', 'success'); render(); } }) }, 'Cancel'))));
    });
    const work = r.work_orders.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Work orders'),
      h('thead', {}, h('tr', {}, ['Assigned to', 'Status', 'Estimate', 'Approved cost', 'Actual', ''].map((c) => h('th', { scope: 'col', class: ['Estimate', 'Actual'].includes(c) ? 'num' : false }, c || h('span', { class: 'visually-hidden' }, 'Actions'))))), h('tbody', {}, woRows)))
      : emptyState({ icon: '🔧', title: 'No work assigned yet', text: closed ? 'This request was closed without work.' : 'Assign the job to a staff member or a vendor.' });

    const noteForm = h('form', { class: 'note-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); const f = e.currentTarget; const body = f.elements.body.value.trim(); if (!body) return;
      try { await post(`${ctx.base}/maintenance/${r.id}/notes`, { body, visibility: f.elements.visibility.value }); render(); } catch (err) { toast(err.message, 'error'); }
    } }, h('label', { class: 'visually-hidden', for: 'note-body' }, 'Add a note'),
      h('textarea', { class: 'textarea', id: 'note-body', name: 'body', rows: 2, maxlength: 4000, placeholder: 'Add a note…' }),
      h('div', { class: 'row' }, h('select', { class: 'select select--inline', name: 'visibility', 'aria-label': 'Who can see this note' }, h('option', { value: 'internal' }, 'Internal (staff only)'), r.tenant ? h('option', { value: 'tenant' }, 'Visible to the tenant') : ''), h('button', { class: 'btn btn--sm', type: 'submit' }, 'Add note')));
    const notes = h('ul', { class: 'timeline' }, r.notes.map((n) => h('li', { class: n.author_kind === 'system' ? 'timeline__system' : '' },
      h('div', { class: 'small muted' }, `${n.author_kind === 'system' ? 'System' : n.author ?? n.author_kind} · ${fmtTimestamp(n.created_at)} `, n.visibility === 'tenant' ? h('span', { class: 'badge' }, 'Tenant can see') : h('span', { class: 'badge badge--ended' }, 'Internal')), h('div', { class: 'prewrap' }, n.body))));

    const attachments = h('div', {}, r.attachments.length ? h('ul', { class: 'plain-list' }, r.attachments.map((a) => h('li', { class: 'row row--between' },
      h('span', {}, a.file_name, h('span', { class: 'muted small' }, ` · ${a.uploader_kind === 'tenant' ? 'tenant' : a.uploaded_by} · ${a.visibility === 'tenant' ? 'tenant-visible' : 'internal'}`)),
      h('span', { class: 'row' }, h('button', { class: 'btn btn--secondary btn--sm', type: 'button', 'aria-label': `Download ${a.file_name}`, onclick: async () => { try { location.assign((await get(`${ctx.base}/attachments/${a.id}/download`)).url); } catch (e) { toast(e.message, 'error'); } } }, 'Download'),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Remove ${a.file_name}`, onclick: () => run(() => post(`${ctx.base}/attachments/${a.id}/archive`, {}), 'Attachment removed.') }, 'Remove')))))
      : h('p', { class: 'muted' }, 'No attachments.'),
      !closed && h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => uploadDialog(r, render, `${ctx.base}`) }, 'Add photo or file'));

    clear(root).append(
      crumbs({ label: 'Maintenance', href: '#/maintenance' }, { label: r.title }),
      pageHeader(r.title, { subtitle: `${r.property.name}${r.unit ? ` · unit ${r.unit.reference}` : ''}`, badges: [statusPill(r.status), urgencyPill(u.label, u.is_critical)], actions }),
      escalation,
      h('div', { class: 'cols-2' },
        section('Details', dl([['Description', h('span', { class: 'prewrap' }, r.description)], ['Category', MAINT_CATEGORY[r.category]], ['Reported by', `${r.reporter}${r.reported_via === 'tenant' ? ' (tenant)' : ''}`],
          ['Tenant', r.tenant && h('a', { href: `#/tenants/${r.tenant.id}` }, r.tenant.full_name)], ['Reported', fmtTimestamp(r.created_at)], r.suggested_urgency ? ['Suggested urgency', `${r.suggested_urgency.label} (${r.suggestion_source}) — advisory only`] : null,
          r.resolution_notes ? ['Resolution', h('span', { class: 'prewrap' }, r.resolution_notes)] : null, r.cancel_reason ? ['Cancelled because', r.cancel_reason] : null])),
        section('History', h('ol', { class: 'timeline' }, r.history.map((x) => h('li', {}, h('strong', {}, MAINT_STATUS[x.to_status]), h('div', { class: 'small muted' }, `${x.actor ?? 'System'} · ${fmtTimestamp(x.created_at)}`), x.note ? h('div', {}, x.note) : ''))))),
      section('Work orders', work),
      section('Notes', h('div', {}, notes, noteForm)),
      section('Attachments', attachments));
  }
  render();
  return root;
}

/** Browser → Storage upload for a maintenance request (staff side). */
function uploadDialog(r, done, base) {
  const file = h('input', { class: 'input', type: 'file', id: 'att-file', accept: 'image/png,image/jpeg,image/webp,application/pdf', required: true });
  formDialog({
    title: 'Add a photo or file', intro: 'PNG, JPEG, WebP or PDF up to 10 MB. Stored privately.', submitLabel: 'Upload',
    fields: [{ name: 'visibility', label: 'Who can see it', type: 'select', required: true, options: [['internal', 'Staff only'], ['tenant', 'Staff and the tenant']], default: 'internal', wide: true }],
    extra: [h('div', { class: 'field field--wide' }, h('label', { for: 'att-file' }, 'File'), file)],
    onSubmit: async (v) => {
      const f = file.files[0];
      if (!f) fail('Choose a file.');
      if (f.size > 10 * 1024 * 1024) fail('Files can be at most 10 MB.');
      const reg = await post(`${base}/maintenance/${r.id}/attachments`, { fileName: f.name, mimeType: f.type, sizeBytes: f.size, visibility: v.visibility });
      const put = await fetch(reg.upload.url, { method: 'PUT', headers: reg.upload.headers, body: f });
      if (!put.ok) fail('Upload failed. Please try again.');
      await post(`${base}/attachments/${reg.attachment.id}/confirm`, {});
      toast('File added.', 'success'); done();
    },
  });
}

/* ------------------------------------------------------------------- vendors */
export async function vendorsView(ctx) {
  const canWrite = ctx.can('maintenance:manage');
  const open = (v) => formDialog({
    title: v ? 'Edit vendor' : 'Add vendor', submitLabel: v ? 'Save' : 'Add vendor', initial: v ? { name: v.name, contactName: v.contact_name, email: v.email, phone: v.phone, notes: v.notes } : {},
    fields: [{ name: 'name', label: 'Company', required: true, maxLength: 160, wide: true }, { name: 'contactName', label: 'Contact', maxLength: 160 }, { name: 'phone', label: 'Phone', type: 'tel', maxLength: 40 },
      { name: 'email', label: 'Email', type: 'email', maxLength: 254, wide: true, hint: 'Work requests are emailed here.' }, { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 }],
    onSubmit: async (b) => {
      const body = { ...b, categories: v?.categories ?? [] };
      if (v) await patch(`${ctx.base}/vendors/${v.id}`, { ...body, expectedVersion: v.version }); else await post(`${ctx.base}/vendors`, body);
      toast('Saved.', 'success'); rerender();
    },
  });
  const add = () => canWrite && h('button', { class: 'btn', type: 'button', onclick: () => open(null) }, 'Add vendor');
  return h('div', {}, pageHeader('Vendors', { subtitle: 'Outside contractors you can assign work to.', actions: [add()] }),
    dataTable({
      ctx, endpoint: '/vendors', searchLabel: 'Search vendors', archivable: true, caption: 'Vendors',
      empty: { icon: '🧰', title: 'No vendors yet', text: canWrite ? 'Add the plumbers, electricians and other contractors you use.' : 'No vendors have been added yet.', action: add() },
      columns: [{ label: 'Company', render: (v) => [v.name, ' ', archivedBadge(v)] }, { label: 'Contact', render: (v) => v.contact_name ?? '—' }, { label: 'Email', render: (v) => v.email ?? '—' }, { label: 'Phone', render: (v) => v.phone ?? '—' },
        { label: null, class: 'actions', render: (v) => (canWrite ? h('span', { class: 'row' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => open(v) }, 'Edit'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => {
            if (!v.archived_at && !(await confirmDialog({ title: `Archive ${v.name}?`, message: 'They can no longer be assigned new work. Existing work orders are kept.', confirmLabel: 'Archive', danger: true }))) return;
            try { await post(`${ctx.base}/vendors/${v.id}/${v.archived_at ? 'restore' : 'archive'}`, {}); rerender(); } catch (e) { toast(e.message, 'error'); } } }, v.archived_at ? 'Restore' : 'Archive')) : '') }],
    }));
}
