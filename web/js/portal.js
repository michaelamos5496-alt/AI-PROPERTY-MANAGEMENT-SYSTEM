import { get, post, requireSession, signOut } from './api.js';
import { clear, emptyState, h, skeleton, toast } from './ui.js';
import { crumbs, errorState, fmtTimestamp, formDialog, options } from './kit.js';

const CATEGORY = { plumbing: 'Plumbing', electrical: 'Electrical', heating_cooling: 'Heating & cooling', appliances: 'Appliances', structural: 'Doors, windows & structure', pest: 'Pests', security: 'Locks & security', cleaning: 'Cleaning', grounds: 'Garden & outdoor', other: 'Something else' };
// Friendlier wording for tenants than the staff workflow names.
const STATUS = { submitted: 'Received', triaged: 'Reviewed', awaiting_approval: 'Being arranged', assigned: 'Scheduled', in_progress: 'Work in progress', resolved: 'Resolved', cancelled: 'Cancelled' };
const pill = (s) => h('span', { class: `badge badge--m-${s}` }, STATUS[s] ?? s);

const me = await requireSession();
if (me.memberships.length && !me.tenant_links?.length) location.replace(`/app?org=${me.memberships[0].org_id}`);
if (!me.memberships.length && !me.tenant_links?.length) location.replace('/onboarding');
document.getElementById('user-name').textContent = me.profile.full_name || me.profile.email;
document.getElementById('signout').addEventListener('click', signOut);
const main = document.getElementById('main');
const rerender = () => route();

let ctx;
async function loadContext() { ctx = await get('/portal/context'); }

async function list() {
  const [requests, notes] = await Promise.all([get('/portal/requests'), get('/me/notifications?limit=5')]);
  const tenancies = ctx.flatMap((c) => c.tenancies.map((t) => ({ ...t, org_id: c.org_id })));
  const report = () => (tenancies.length ? h('button', { class: 'btn', type: 'button', onclick: () => newRequest(tenancies) }, 'Report a problem') : null);
  return h('div', {},
    h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, 'Your requests'), h('p', { class: 'muted page-header__sub' }, ctx.map((c) => c.org_name).join(', '))), h('div', {}, report())),
    h('div', { class: 'notice notice--critical', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('strong', {}, 'In an emergency'), ' (fire, gas smell, serious flooding, or anyone in danger), call your local emergency number first, then report it here.')),
    !tenancies.length ? h('div', { class: 'alert alert--info', role: 'status' }, 'You have no active tenancy linked to this account, so new requests are unavailable. Contact your property manager if this is a mistake.') : null,
    requests.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Your maintenance requests'),
      h('thead', {}, h('tr', {}, ['Request', 'Home', 'Status', 'Reported'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, requests.map((r) => h('tr', {}, h('td', { 'data-label': 'Request' }, h('a', { href: `#/${r.org_id}/${r.id}` }, r.title)), h('td', { 'data-label': 'Home' }, `${r.property_name}${r.unit_reference ? ` · ${r.unit_reference}` : ''}`),
        h('td', { 'data-label': 'Status' }, pill(r.status)), h('td', { 'data-label': 'Reported' }, fmtTimestamp(r.created_at)))))))
      : emptyState({ icon: '🛠️', title: 'No requests yet', text: 'If something needs fixing, report it here and follow the progress.', action: report() }),
    notes.items.length ? h('section', { class: 'card section mt-5' }, h('h2', {}, 'Recent updates'), h('ul', { class: 'notif-list' }, notes.items.map((n) => h('li', { class: n.read_at ? '' : 'notif--unread' }, h('strong', {}, n.title), n.body ? h('div', { class: 'muted small' }, n.body.slice(0, 160)) : '', h('div', { class: 'muted small' }, fmtTimestamp(n.created_at)))))) : null);
}

async function newRequest(tenancies) {
  const levels = {};
  for (const o of new Set(tenancies.map((t) => t.org_id))) levels[o] = await get(`/portal/orgs/${o}/urgency-levels`).catch(() => []);
  const labels = [...new Set(Object.values(levels).flat().map((l) => l.label))];
  formDialog({
    title: 'Report a problem', intro: 'Tell us what is wrong. Your property manager is notified straight away. Reports that mention a safety risk are escalated to a person automatically.',
    fields: [
      { name: 'tenancy', label: 'Which home?', type: 'select', required: true, options: tenancies.map((t) => [t.id, `${t.property_name} · ${t.unit_reference}`]), default: tenancies.length === 1 ? tenancies[0].id : undefined, wide: true },
      { name: 'title', label: 'What is the problem?', required: true, maxLength: 160, wide: true, placeholder: 'e.g. Kitchen tap is dripping' },
      { name: 'description', label: 'Details', type: 'textarea', required: true, maxLength: 4000, wide: true, rows: 4, hint: 'Where it is, when it started, anything that makes it worse.' },
      { name: 'category', label: 'Type', type: 'select', required: true, options: options(CATEGORY), default: 'other' },
      { name: 'urgency', label: 'How urgent is it?', type: 'select', options: labels.map((l) => [l, l]), placeholder: 'Not sure: let the manager decide' },
    ],
    submitLabel: 'Send report',
    onSubmit: async (v) => {
      const t = tenancies.find((x) => x.id === v.tenancy);
      const urgency = levels[t.org_id].find((l) => l.label === v.urgency)?.id ?? null;
      const r = await post(`/portal/orgs/${t.org_id}/requests`, { tenancy: v.tenancy, title: v.title, description: v.description, category: v.category, urgency });
      toast('Thanks, your report has been sent.', 'success');
      location.hash = `#/${t.org_id}/${r.id}`;
    },
  });
}

async function detail(orgId, id) {
  const r = await get(`/portal/orgs/${orgId}/requests/${id}`);
  const closed = ['resolved', 'cancelled'].includes(r.status);
  const note = h('form', { class: 'note-form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); const body = e.currentTarget.elements.body.value.trim(); if (!body) return;
    try { await post(`/portal/orgs/${orgId}/requests/${id}/notes`, { body }); rerender(); } catch (err) { toast(err.message, 'error'); }
  } }, h('label', { class: 'visually-hidden', for: 'msg' }, 'Send a message about this request'), h('textarea', { class: 'textarea', id: 'msg', name: 'body', rows: 2, maxlength: 4000, placeholder: 'Add a message for your property manager…' }), h('div', {}, h('button', { class: 'btn btn--sm', type: 'submit' }, 'Send message')));
  const upload = () => {
    const file = h('input', { class: 'input', type: 'file', id: 'photo', accept: 'image/png,image/jpeg,image/webp,application/pdf', required: true });
    formDialog({ title: 'Add a photo', intro: 'PNG, JPEG, WebP or PDF up to 10 MB. Only you and your property manager can see it.', submitLabel: 'Upload', fields: [], extra: [h('div', { class: 'field field--wide' }, h('label', { for: 'photo' }, 'File'), file)],
      onSubmit: async () => {
        const f = file.files[0];
        const bad = (m) => { throw Object.assign(new Error(m), { details: [] }); };
        if (!f) bad('Choose a file.'); if (f.size > 10 * 1024 * 1024) bad('Files can be at most 10 MB.');
        const reg = await post(`/portal/orgs/${orgId}/requests/${id}/attachments`, { fileName: f.name, mimeType: f.type, sizeBytes: f.size });
        if (!(await fetch(reg.upload.url, { method: 'PUT', headers: reg.upload.headers, body: f })).ok) bad('Upload failed. Please try again.');
        await post(`/portal/orgs/${orgId}/attachments/${reg.attachment.id}/confirm`, {});
        toast('Photo added.', 'success'); rerender();
      } });
  };
  return h('div', {},
    crumbs({ label: 'Your requests', href: '#/' }, { label: r.title }),
    h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, r.title, ' ', pill(r.status)), h('p', { class: 'muted page-header__sub' }, `${r.property_name}${r.unit_reference ? ` · ${r.unit_reference}` : ''} · ${CATEGORY[r.category]} · reported ${fmtTimestamp(r.created_at)}`)),
      h('div', {}, r.can_cancel ? h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => formDialog({ title: 'Cancel this request?', danger: true, submitLabel: 'Cancel request', intro: 'Only possible before work is arranged.',
        fields: [{ name: 'reason', label: 'Why?', type: 'textarea', required: true, wide: true, maxLength: 500 }], onSubmit: async (v) => { await post(`/portal/orgs/${orgId}/requests/${id}/cancel`, { expectedVersion: r.version, reason: v.reason }); toast('Request cancelled.', 'success'); rerender(); } }) }, 'Cancel request') : null)),
    r.resolution_notes ? h('div', { class: 'alert alert--success', role: 'status' }, h('strong', {}, 'Resolved: '), r.resolution_notes) : null,
    r.cancel_reason ? h('div', { class: 'alert alert--info' }, h('strong', {}, 'Cancelled: '), r.cancel_reason) : null,
    h('div', { class: 'cols-2' },
      h('section', { class: 'card section' }, h('h2', {}, 'What you told us'), h('p', { class: 'prewrap' }, r.description), h('p', { class: 'muted small' }, `Urgency you chose: ${r.urgency_label}`)),
      h('section', { class: 'card section' }, h('h2', {}, 'Progress'), h('ol', { class: 'timeline' }, r.history.map((x) => h('li', {}, h('strong', {}, STATUS[x.to_status]), h('div', { class: 'small muted' }, fmtTimestamp(x.created_at))))))),
    h('section', { class: 'card section' }, h('h2', {}, 'Messages'), r.notes.length ? h('ul', { class: 'timeline' }, r.notes.map((n) => h('li', {}, h('div', { class: 'small muted' }, `${n.author_kind === 'tenant' ? 'You' : n.author_kind === 'system' ? 'Update' : 'Property manager'} · ${fmtTimestamp(n.created_at)}`), h('div', { class: 'prewrap' }, n.body)))) : h('p', { class: 'muted' }, 'No messages yet.'), closed ? null : note),
    h('section', { class: 'card section' }, h('div', { class: 'row row--between section__head' }, h('h2', {}, 'Photos & files'), closed ? null : h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: upload }, 'Add a photo')),
      r.attachments.length ? h('ul', { class: 'plain-list' }, r.attachments.map((a) => h('li', { class: 'row row--between' }, h('span', {}, a.file_name),
        h('button', { class: 'btn btn--secondary btn--sm', type: 'button', 'aria-label': `Download ${a.file_name}`, onclick: async () => { try { location.assign((await get(`/portal/orgs/${orgId}/attachments/${a.id}/download`)).url); } catch (e) { toast(e.message, 'error'); } } }, 'Download')))) : h('p', { class: 'muted' }, 'No photos yet.')));
}

let seq = 0;
async function route() {
  const mine = ++seq;
  clear(main).append(skeleton(3));
  try {
    await loadContext();
    const [org, id] = location.hash.replace(/^#\/?/, '').split('/');
    const node = org && id ? await detail(org, id) : await list();
    if (mine === seq) { clear(main).append(node); main.focus({ preventScroll: true }); }
  } catch (e) { if (mine === seq) clear(main).append(errorState(e, route)); }
}
window.addEventListener('hashchange', route);
route();
