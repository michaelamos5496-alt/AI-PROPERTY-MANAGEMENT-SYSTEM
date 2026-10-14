import { del, get, patch, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { ledgerSection } from './finance.js';
import { LABELS, crumbs, dataTable, dl, errorState, fmtDate, fmtMoney, formDialog, loadOptions, options, pageHeader, section, statusBadge } from '../kit.js';

const termFields = (currency, { startLocked = false } = {}) => [
  { name: 'startDate', label: 'Start date', type: 'date', required: true, disabled: startLocked, hint: startLocked ? 'Fixed once a tenancy is active.' : undefined },
  { name: 'endDate', label: 'End date', type: 'date', hint: 'Leave empty for an open-ended / periodic tenancy.' },
  { name: 'rentAmountMinor', label: 'Rent', type: 'money', currency, required: true, hintFn: (i) => `In ${typeof currency === 'function' ? currency(i) : currency}.` },
  { name: 'rentPeriod', label: 'Rent period', type: 'select', required: true, options: options(LABELS.rentPeriod), default: 'monthly' },
  { name: 'rentDueDay', label: 'Rent due day of month', type: 'number', min: 1, max: 31, step: 1 },
  { name: 'noticeDays', label: 'Notice period (days)', type: 'number', min: 0, max: 365, step: 1 },
  { name: 'depositAmountMinor', label: 'Deposit', type: 'money', currency },
  { name: 'depositScheme', label: 'Deposit scheme / holder', maxLength: 200 },
  { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 },
];
const termsOf = (t) => ({ startDate: t.start_date, endDate: t.end_date, rentAmountMinor: t.rent_amount_minor, rentPeriod: t.rent_period, rentDueDay: t.rent_due_day,
  noticeDays: t.notice_days, depositAmountMinor: t.deposit_amount_minor, depositScheme: t.deposit_scheme, notes: t.notes });
const localToday = (tz) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const dueText = (t) => (t.rent_due_day ? `, due on day ${t.rent_due_day}` : '');

/** Create a draft tenancy, optionally pre-filled from a unit or tenant page. */
export async function openTenancyForm(ctx, { unit, tenant } = {}, done) {
  let units; let tenants;
  try {
    [units, tenants] = await Promise.all([
      loadOptions(ctx, '/units', (u) => [u.id, `${u.property_name} · ${u.reference}${u.occupancy === 'occupied' ? ' (occupied)' : ''}`, u.currency], '&sort=property'),
      loadOptions(ctx, '/tenants', (t) => [t.id, t.full_name]),
    ]);
  } catch (e) { return toast(e.message, 'error'); }
  if (!units.options.length) return toast('Add a property with at least one unit first.', 'error');
  if (!tenants.options.length) return toast('Add a tenant first.', 'error');
  const currencyOf = (inputs) => units.options.find((o) => o[0] === (inputs.unit?.value ?? unit?.id))?.[2] ?? unit?.property?.currency ?? 'USD';
  formDialog({
    title: 'New tenancy', intro: 'Creates a draft. A manager activates it once terms are agreed.',
    fields: [
      { name: 'unit', label: 'Unit', type: 'select', required: true, options: units.options.map(([v, l]) => [v, l]), default: unit?.id, wide: true,
        hint: units.truncated ? 'Showing the first 100 units.' : undefined },
      { name: 'tenant', label: 'Primary tenant', type: 'select', required: true, options: tenants.options, default: tenant?.id, wide: true,
        hint: 'Add co-tenants from the tenancy page.' },
      ...termFields(currencyOf),
    ],
    submitLabel: 'Create draft tenancy',
    onSubmit: async (v) => {
      const { unit: unitId, tenant: tenantId, ...terms } = v;
      const t = await post(`${ctx.base}/tenancies`, { unit: unitId, tenantIds: [tenantId], ...terms, rentPeriod: terms.rentPeriod ?? 'monthly', depositAmountMinor: terms.depositAmountMinor ?? 0 });
      toast('Draft tenancy created.', 'success');
      location.hash = `#/tenancies/${t.id}`;
      done?.(t);
    },
  });
}

export function tenanciesView(ctx) {
  const add = () => ctx.can('tenancies:write') && h('button', { class: 'btn', type: 'button', onclick: () => openTenancyForm(ctx) }, 'New tenancy');
  return h('div', {}, pageHeader('Tenancies', { subtitle: 'Who rents which unit, on what terms.', actions: [add()] }),
    dataTable({
      ctx, endpoint: '/tenancies', defaultSort: 'start', defaultDir: 'desc', searchLabel: 'Search tenant, property or unit', caption: 'Tenancies',
      empty: { icon: '🔑', title: 'No tenancies yet', text: 'A tenancy links a tenant to a unit and records rent, deposit and dates.', action: add() },
      filters: [{ key: 'status', label: 'Status', options: options(LABELS.tenancyStatus) }],
      columns: [
        { label: 'Tenant', sort: 'tenant', render: (t) => h('a', { href: `#/tenancies/${t.id}` }, t.primary_tenant ?? 'Tenancy') },
        { label: 'Unit', sort: 'property', render: (t) => [h('a', { href: `#/properties/${t.property_id}` }, t.property_name), ' · ', h('a', { href: `#/units/${t.unit_id}` }, t.unit_reference)] },
        { label: 'Status', sort: 'status', render: (t) => statusBadge(t.status) },
        { label: 'Start', sort: 'start', render: (t) => fmtDate(t.start_date) },
        { label: 'End', sort: 'end', render: (t) => fmtDate(t.end_date) },
        { label: 'Rent', sort: 'rent', class: 'num', render: (t) => `${fmtMoney(t.rent_amount_minor, t.currency)} / ${LABELS.rentPeriodShort[t.rent_period]}` },
      ],
    }));
}

export function openLeaseForm(ctx, tenancy, lease, done) {
  const editing = !!lease;
  formDialog({
    title: editing ? 'Edit lease' : 'Add lease record', intro: editing ? undefined : 'A lease is the signed agreement (or renewal/amendment) behind this tenancy. Upload the documents afterwards.',
    fields: [
      { name: 'kind', label: 'Type', type: 'select', required: true, options: options(LABELS.leaseKind), default: 'initial' },
      { name: 'signedOn', label: 'Signed on', type: 'date' },
      { name: 'startDate', label: 'Lease start', type: 'date', required: true, default: tenancy.start_date },
      { name: 'endDate', label: 'Lease end', type: 'date', default: tenancy.end_date },
      { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 },
    ],
    initial: editing ? { kind: lease.kind, signedOn: lease.signed_on, startDate: lease.start_date, endDate: lease.end_date, notes: lease.notes } : {},
    submitLabel: editing ? 'Save changes' : 'Add lease',
    onSubmit: async (v) => {
      const saved = editing ? await patch(`${ctx.base}/leases/${lease.id}`, { ...v, expectedVersion: lease.version }) : await post(`${ctx.base}/tenancies/${tenancy.id}/leases`, v);
      toast(editing ? 'Lease updated.' : 'Lease added.', 'success');
      done(saved);
    },
  });
}

export function tenancyView(ctx, id) {
  const root = h('div', {}, skeleton(5));
  async function render() {
    let t;
    try { t = await get(`${ctx.base}/tenancies/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const open = t.status === 'draft' || t.status === 'active';
    const cur = t.currency;
    const run = async (fn, okMsg) => { try { await fn(); toast(okMsg, 'success'); render(); } catch (e) { toast(e.message, 'error'); } };

    const actions = [];
    if (t.status === 'draft' && ctx.can('tenancies:transition')) actions.push(h('button', { class: 'btn', type: 'button', onclick: async () => {
      if (await confirmDialog({ title: 'Activate this tenancy?', message: `Rent of ${fmtMoney(t.rent_amount_minor, cur)} starts counting from ${fmtDate(t.start_date)}. The unit shows as occupied from that date, and no other tenancy can overlap these dates.`, confirmLabel: 'Activate' }))
        run(() => post(`${ctx.base}/tenancies/${t.id}/activate`, { expectedVersion: t.version }), 'Tenancy activated.');
    } }, 'Activate'));
    if (t.status === 'active' && ctx.can('tenancies:transition')) actions.push(h('button', { class: 'btn btn--danger', type: 'button', onclick: () => formDialog({
      title: 'End tenancy', intro: 'Ending is permanent. The tenancy, its leases and documents stay on record.', danger: true, submitLabel: 'End tenancy',
      fields: [{ name: 'endDate', label: 'Move-out / end date', type: 'date', required: true, default: localToday(t.timezone), max: localToday(t.timezone), hint: `On or before today (${t.timezone}). To schedule a future end, edit the terms instead.` },
        { name: 'reason', label: 'Reason', type: 'textarea', wide: true, maxLength: 1000 }],
      onSubmit: async (v) => { await post(`${ctx.base}/tenancies/${t.id}/end`, { expectedVersion: t.version, ...v }); toast('Tenancy ended.', 'success'); render(); },
    }) }, 'End tenancy'));
    if (t.status === 'draft' && ctx.can('tenancies:transition')) actions.push(h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => formDialog({
      title: 'Cancel draft tenancy', intro: 'The draft is kept on record as cancelled.', danger: true, submitLabel: 'Cancel tenancy',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', wide: true, maxLength: 1000 }],
      onSubmit: async (v) => { await post(`${ctx.base}/tenancies/${t.id}/cancel`, { expectedVersion: t.version, ...v }); toast('Tenancy cancelled.', 'success'); render(); },
    }) }, 'Cancel draft'));
    const canEdit = open && (t.status === 'draft' ? ctx.can('tenancies:write') : ctx.can('tenancies:transition'));
    if (canEdit) actions.push(h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => formDialog({
      title: 'Edit tenancy terms', fields: termFields(cur, { startLocked: t.status === 'active' }), initial: termsOf(t), submitLabel: 'Save changes',
      onSubmit: async (v) => { await patch(`${ctx.base}/tenancies/${t.id}`, { ...v, rentPeriod: v.rentPeriod ?? 'monthly', depositAmountMinor: v.depositAmountMinor ?? 0, expectedVersion: t.version }); toast('Terms updated.', 'success'); render(); },
    }) }, 'Edit terms'));

    const canTenants = open && ctx.can('tenancies:write');
    const tenantList = h('ul', { class: 'plain-list' }, t.tenants.map((x) => h('li', { class: 'row row--between' },
      h('span', {}, h('a', { href: `#/tenants/${x.tenant_id}` }, x.full_name), ' ', x.is_primary && h('span', { class: 'badge badge--owner' }, 'Primary'),
        h('br'), h('span', { class: 'muted small' }, [x.email, x.phone].filter(Boolean).join(' · '))),
      canTenants && h('span', { class: 'row' },
        !x.is_primary && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => run(() => post(`${ctx.base}/tenancies/${t.id}/tenants/${x.tenant_id}`, { isPrimary: true }), 'Primary tenant changed.') }, 'Make primary'),
        !x.is_primary && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Remove ${x.full_name}`, onclick: async () => {
          if (await confirmDialog({ title: 'Remove tenant from tenancy?', message: `${x.full_name} will no longer be listed on this tenancy. Their record is kept.`, confirmLabel: 'Remove', danger: true }))
            run(() => del(`${ctx.base}/tenancies/${t.id}/tenants/${x.tenant_id}`), 'Tenant removed.');
        } }, 'Remove')))));
    const addTenant = canTenants && h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: async () => {
      let tenants; try { tenants = await loadOptions(ctx, '/tenants', (x) => [x.id, x.full_name]); } catch (e) { return toast(e.message, 'error'); }
      const on = new Set(t.tenants.map((x) => x.tenant_id)); const choices = tenants.options.filter(([i]) => !on.has(i));
      if (!choices.length) return toast('Every tenant is already on this tenancy. Add a new tenant first.', 'info');
      formDialog({ title: 'Add co-tenant', submitLabel: 'Add tenant', fields: [{ name: 'tenant', label: 'Tenant', type: 'select', required: true, options: choices, wide: true }],
        onSubmit: async (v) => { await post(`${ctx.base}/tenancies/${t.id}/tenants/${v.tenant}`, { isPrimary: false }); toast('Tenant added.', 'success'); render(); } });
    } }, 'Add tenant');

    const leases = t.leases.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Leases'),
          h('thead', {}, h('tr', {}, ['Lease', 'Term', 'Signed', 'Documents'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', {}, t.leases.map((l) => h('tr', { class: l.archived ? 'row--archived' : false },
            h('td', { 'data-label': 'Lease' }, h('a', { href: `#/leases/${l.id}` }, LABELS.leaseKind[l.kind]), l.archived ? h('span', { class: 'badge badge--archived' }, 'Archived') : ''),
            h('td', { 'data-label': 'Term' }, `${fmtDate(l.start_date)} → ${l.end_date ? fmtDate(l.end_date) : 'open'}`), h('td', { 'data-label': 'Signed' }, fmtDate(l.signed_on)),
            h('td', { class: 'num', 'data-label': 'Documents' }, ctx.can('documents:read') ? l.document_count : '—'))))))
      : emptyState({ icon: '📄', title: 'No lease recorded', text: 'Record the signed lease, then attach its documents privately.' });

    clear(root).append(
      crumbs({ label: 'Tenancies', href: '#/tenancies' }, { label: `${t.property_name} · ${t.unit_reference}` }),
      pageHeader(`${t.primary_tenant ?? 'Tenancy'} — ${t.unit_reference}`, { subtitle: t.property_name, badges: [statusBadge(t.status)], actions }),
      h('div', { class: 'cols-2' },
        section('Terms', dl([['Unit', [h('a', { href: `#/properties/${t.property_id}` }, t.property_name), ' · ', h('a', { href: `#/units/${t.unit_id}` }, t.unit_reference)]],
          ['Dates', `${fmtDate(t.start_date)} → ${t.end_date ? fmtDate(t.end_date) : 'open-ended'}`],
          ['Rent', `${fmtMoney(t.rent_amount_minor, cur)} ${LABELS.rentPeriod[t.rent_period].toLowerCase()}${dueText(t)}`],
          ['Deposit', `${fmtMoney(t.deposit_amount_minor, cur)}${t.deposit_scheme ? ` · ${t.deposit_scheme}` : ''}`],
          ['Notice period', t.notice_days != null ? `${t.notice_days} days` : null], ['End reason', t.end_reason], ['Notes', t.notes]])),
        section('Tenants', tenantList, addTenant)),
      ctx.can('finance:read') && t.status !== 'cancelled' && ledgerSection(ctx, t, render),
      section('Leases', leases, ctx.can('leases:write') && t.status !== 'cancelled' && h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => openLeaseForm(ctx, t, null, (l) => { location.hash = `#/leases/${l.id}`; }) }, 'Add lease')));
  }
  render();
  return root;
}
