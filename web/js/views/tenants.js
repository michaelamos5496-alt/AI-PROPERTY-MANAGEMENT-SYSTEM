import { get, patch, post } from '../api.js';
import { clear, confirmDialog, copyText, emptyState, h, openDialog, skeleton, toast } from '../ui.js';
import { LABELS, archivedBadge, crumbs, dataTable, dl, errorState, fmtDate, fmtMoney, fmtTimestamp, formDialog, pageHeader, section, statusBadge } from '../kit.js';
import { openTenancyForm } from './tenancies.js';

const tenantFields = [
  { name: 'fullName', label: 'Full name', required: true, maxLength: 160, wide: true, autocomplete: 'name' },
  { name: 'email', label: 'Email', type: 'email', maxLength: 254, autocomplete: 'email' },
  { name: 'phone', label: 'Phone', type: 'tel', maxLength: 40, autocomplete: 'tel' },
  { name: 'emergencyName', label: 'Emergency contact', maxLength: 160 },
  { name: 'emergencyPhone', label: 'Emergency phone', type: 'tel', maxLength: 40 },
  { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 },
];
const toForm = (t) => ({ fullName: t.full_name, email: t.email, phone: t.phone, emergencyName: t.emergency_name, emergencyPhone: t.emergency_phone, notes: t.notes });

export function openTenantForm(ctx, tenant, done) {
  const editing = !!tenant;
  formDialog({
    title: editing ? 'Edit tenant' : 'Add tenant', fields: tenantFields, initial: editing ? toForm(tenant) : {}, submitLabel: editing ? 'Save changes' : 'Add tenant',
    onSubmit: async (v) => {
      const saved = editing ? await patch(`${ctx.base}/tenants/${tenant.id}`, { ...v, expectedVersion: tenant.version }) : await post(`${ctx.base}/tenants`, v);
      toast(editing ? 'Tenant updated.' : 'Tenant added.', 'success');
      done(saved);
    },
  });
}

export function tenantsView(ctx) {
  const add = () => ctx.can('tenants:write') && h('button', { class: 'btn', type: 'button', onclick: () => openTenantForm(ctx, null, (t) => { location.hash = `#/tenants/${t.id}`; }) }, 'Add tenant');
  return h('div', {}, pageHeader('Tenants', { subtitle: 'Everyone who rents from you, current and former.', actions: [add()] }),
    dataTable({
      ctx, endpoint: '/tenants', defaultSort: 'name', searchLabel: 'Search name, email or phone', archivable: true, caption: 'Tenant directory',
      empty: { icon: '🧑‍🤝‍🧑', title: 'No tenants yet', text: ctx.can('tenants:write') ? 'Add a tenant, then link them to a unit with a tenancy.' : 'No tenants have been added yet.', action: add() },
      filters: [{ key: 'status', label: 'Tenancy', all: 'All tenants', options: [['current', 'Current'], ['former', 'Former / none']] }],
      columns: [
        { label: 'Name', sort: 'name', render: (t) => [h('a', { href: `#/tenants/${t.id}` }, t.full_name), ' ', archivedBadge(t)] },
        { label: 'Email', sort: 'email', render: (t) => t.email ?? '—' },
        { label: 'Phone', render: (t) => t.phone ?? '—' },
        { label: 'Status', sort: 'tenancies', render: (t) => (t.active_tenancies > 0 ? h('span', { class: 'badge badge--active' }, 'Current') : h('span', { class: 'badge badge--ended' }, 'No active tenancy')) },
        { label: 'Added', sort: 'created', render: (t) => fmtTimestamp(t.created_at).split(',')[0] },
      ],
    }));
}

function portalSection(ctx, t, rerender) {
  const body = h('div', {}, skeleton(1));
  (async () => {
    const reminders = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !t.reminders_opt_out, disabled: !ctx.can('tenants:write'), onchange: async (e) => {
      try { await post(`${ctx.base}/tenants/${t.id}/reminders`, { optOut: !e.target.checked }); toast(e.target.checked ? 'Rent reminders are on.' : 'Rent reminders are off for this tenant.', 'success'); } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; } } }), ' Send automatic rent reminders by email');
    if (!ctx.can('portal:manage')) return clear(body).append(reminders);
    let a;
    try { a = await get(`${ctx.base}/tenants/${t.id}/portal-access`); } catch (e) { return clear(body).append(reminders, errorState(e)); }
    const invite = async () => {
      try {
        const r = await post(`${ctx.base}/tenants/${t.id}/portal-invitations`, {});
        const input = h('input', { class: 'input', readonly: true, value: r.inviteUrl, 'aria-label': 'Invitation link', onfocus: (e) => e.target.select() });
        openDialog({ title: 'Portal invitation ready', body: h('div', {}, h('p', {}, `Send this single-use link to ${t.email}. It works only for that email address, once, for 7 days. The tenant must sign in or register with that same address.`),
          h('div', { class: 'copy-box' }, input, h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => copyText(r.inviteUrl) }, 'Copy'))) });
        rerender();
      } catch (e) { toast(e.message, 'error'); }
    };
    clear(body).append(
      h('p', { class: 'muted' }, 'The tenant portal lets a verified tenant report maintenance issues for their own tenancy and follow their progress. It shows nothing else.'),
      a.users.length ? h('ul', { class: 'plain-list' }, a.users.map((u) => h('li', { class: 'row row--between' }, h('span', {}, h('strong', {}, u.name ?? u.email), h('span', { class: 'muted small' }, ` ${u.email} · verified ${fmtTimestamp(u.verified_at)}`)),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Remove portal access?', message: `${u.email} will no longer be able to use the tenant portal.`, confirmLabel: 'Remove', danger: true })) { try { await post(`${ctx.base}/portal-access/${u.id}/revoke`, {}); toast('Access removed.', 'success'); rerender(); } catch (e) { toast(e.message, 'error'); } } } }, 'Remove'))))
        : h('p', {}, 'No one has portal access yet.'),
      a.pending_invitation ? h('p', { class: 'muted small' }, `An invitation to ${a.pending_invitation.email} is waiting (expires ${fmtTimestamp(a.pending_invitation.expires_at)}).`) : '',
      t.email ? h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: invite }, a.pending_invitation ? 'Create a new invitation' : 'Invite to portal') : h('p', { class: 'muted small' }, 'Add an email address to this tenant to invite them.'),
      h('div', { class: 'mt-5' }, reminders));
  })();
  return section('Portal & reminders', body);
}

export function tenantView(ctx, id) {
  const root = h('div', {}, skeleton(4));
  async function render() {
    let t;
    try { t = await get(`${ctx.base}/tenants/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const archived = !!t.archived_at;
    const actions = [
      ctx.can('tenancies:write') && !archived && h('button', { class: 'btn', type: 'button', onclick: () => openTenancyForm(ctx, { tenant: t }, render) }, 'New tenancy'),
      ctx.can('tenants:write') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openTenantForm(ctx, t, render) }, 'Edit'),
      ctx.can('records:archive') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
        if (!archived && !(await confirmDialog({ title: `Archive ${t.full_name}?`, message: 'They leave the tenant directory but their tenancy history is kept. Tenants on an open tenancy cannot be archived.', confirmLabel: 'Archive', danger: true }))) return;
        try { await post(`${ctx.base}/tenants/${t.id}/${archived ? 'restore' : 'archive'}`, {}); toast(archived ? 'Tenant restored.' : 'Tenant archived.', 'success'); render(); }
        catch (e) { toast(e.message, 'error'); }
      } }, archived ? 'Restore' : 'Archive'),
    ];
    clear(root).append(
      crumbs({ label: 'Tenants', href: '#/tenants' }, { label: t.full_name }),
      pageHeader(t.full_name, { badges: [archivedBadge(t)], actions }),
      h('div', { class: 'cols-2' },
        section('Contact', dl([['Email', t.email && h('a', { href: `mailto:${t.email}` }, t.email)], ['Phone', t.phone], ['Emergency contact', [t.emergency_name, t.emergency_phone].filter(Boolean).join(' · ')]])),
        section('Notes', t.notes ? h('p', { class: 'prewrap' }, t.notes) : h('p', { class: 'muted' }, 'No notes.'))),
      portalSection(ctx, t, render),
      section('Tenancies', t.tenancies.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, `Tenancies of ${t.full_name}`),
            h('thead', {}, h('tr', {}, ['Unit', 'Status', 'Start', 'End', 'Rent'].map((c) => h('th', { scope: 'col' }, c)))),
            h('tbody', {}, t.tenancies.map((x) => h('tr', {},
              h('td', { 'data-label': 'Unit' }, h('a', { href: `#/tenancies/${x.id}` }, `${x.property_name} · ${x.unit_reference}`), x.is_primary ? '' : h('span', { class: 'muted small' }, ' (co-tenant)')),
              h('td', { 'data-label': 'Status' }, statusBadge(x.status)), h('td', { 'data-label': 'Start' }, fmtDate(x.start_date)), h('td', { 'data-label': 'End' }, fmtDate(x.end_date)),
              h('td', { class: 'num', 'data-label': 'Rent' }, `${fmtMoney(x.rent_amount_minor, x.currency)} / ${LABELS.rentPeriodShort[x.rent_period]}`))))))
        : emptyState({ icon: '🔑', title: 'Not on any tenancy yet', text: 'Create a tenancy to link this tenant to a unit and record rent and deposit terms.',
            action: ctx.can('tenancies:write') && !archived ? h('button', { class: 'btn', type: 'button', onclick: () => openTenancyForm(ctx, { tenant: t }, render) }, 'New tenancy') : null })));
  }
  render();
  return root;
}
