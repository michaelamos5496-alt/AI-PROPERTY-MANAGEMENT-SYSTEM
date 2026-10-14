import { get, patch, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { LABELS, archivedBadge, crumbs, dataTable, dl, errorState, fmtDate, fmtMoney, formDialog, options, pageHeader, section, statusBadge } from '../kit.js';
import { openTenancyForm } from './tenancies.js';

export const unitFields = (currency) => [
  { name: 'reference', label: 'Unit reference', required: true, maxLength: 60, placeholder: 'e.g. 2B', hint: 'Unique within the property.' },
  { name: 'bedrooms', label: 'Bedrooms', type: 'number', min: 0, max: 50, step: 1 },
  { name: 'bathrooms', label: 'Bathrooms', type: 'number', min: 0, max: 50, step: 0.5 },
  { name: 'floorAreaSqm', label: 'Floor area (m²)', type: 'number', min: 0, step: 0.01 },
  { name: 'marketRentMinor', label: `Market rent (${currency}, per month)`, type: 'money', currency },
  { name: 'isAvailable', label: 'Available to let', type: 'checkbox', default: true, hint: 'Untick for units off the market (renovation, owner use).' },
  { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 },
];

export function openUnitForm(ctx, property, unit, done) {
  const editing = !!unit;
  formDialog({
    title: editing ? `Edit unit ${unit.reference}` : `Add unit to ${property.name}`, fields: unitFields(property.currency),
    initial: unit ? { ...unit, floorAreaSqm: unit.floor_area_sqm, marketRentMinor: unit.market_rent_minor, isAvailable: unit.is_available } : {},
    submitLabel: editing ? 'Save changes' : 'Add unit',
    onSubmit: async (v) => {
      const body = { ...v, isAvailable: v.isAvailable };
      if (editing) await patch(`${ctx.base}/units/${unit.id}`, { ...body, expectedVersion: unit.version });
      else await post(`${ctx.base}/properties/${property.id}/units`, body);
      toast(editing ? 'Unit updated.' : 'Unit added.', 'success');
      done();
    },
  });
}

export const occupancyBadge = (o) => h('span', { class: `badge badge--${o}` }, LABELS.occupancy[o] ?? o);

/** Unit inventory across the whole portfolio. */
export function unitsView(ctx) {
  return h('div', {}, pageHeader('Units', { subtitle: 'Every rentable unit across your portfolio.' }),
    dataTable({
      ctx, endpoint: '/units', defaultSort: 'property', searchLabel: 'Search units or properties', archivable: true, caption: 'Unit inventory',
      empty: { icon: '🚪', title: 'No units yet', text: 'Units belong to a property. Add a property first, then add its units.',
        action: ctx.can('properties:write') ? h('a', { class: 'btn', href: '#/properties' }, 'Go to properties') : null },
      filters: [{ key: 'occupancy', label: 'Occupancy', options: options(LABELS.occupancy) }],
      columns: [
        { label: 'Unit', sort: 'reference', render: (u) => [h('a', { href: `#/units/${u.id}` }, u.reference), ' ', archivedBadge(u)] },
        { label: 'Property', sort: 'property', render: (u) => h('a', { href: `#/properties/${u.property_id}` }, u.property_name) },
        { label: 'Status', sort: 'occupancy', render: (u) => occupancyBadge(u.occupancy) },
        { label: 'Current tenant', render: (u) => u.current_tenant ?? '—' },
        { label: 'Beds', sort: 'bedrooms', class: 'num', render: (u) => u.bedrooms ?? '—' },
        { label: 'Market rent', sort: 'rent', class: 'num', render: (u) => fmtMoney(u.market_rent_minor, u.currency) },
      ],
    }));
}

/** Units table scoped to one property (used on the property page). */
export const propertyUnitsTable = (ctx, property) => dataTable({
  ctx, endpoint: '/units', persist: false, defaultSort: 'reference', extraQuery: { property: property.id }, searchLabel: 'Search units',
  archivable: true, caption: `Units in ${property.name}`,
  empty: { icon: '🚪', title: 'No units yet', text: 'Add the first rentable unit in this property.' },
  filters: [{ key: 'occupancy', label: 'Occupancy', options: options(LABELS.occupancy) }],
  columns: [
    { label: 'Unit', sort: 'reference', render: (u) => [h('a', { href: `#/units/${u.id}` }, u.reference), ' ', archivedBadge(u)] },
    { label: 'Status', sort: 'occupancy', render: (u) => occupancyBadge(u.occupancy) },
    { label: 'Current tenant', render: (u) => u.current_tenant ?? '—' },
    { label: 'Beds', sort: 'bedrooms', class: 'num', render: (u) => u.bedrooms ?? '—' },
    { label: 'Market rent', sort: 'rent', class: 'num', render: (u) => fmtMoney(u.market_rent_minor, property.currency) },
  ],
});

export async function unitView(ctx, id) {
  const root = h('div', {}, skeleton(4));
  async function render() {
    let u;
    try { u = await get(`${ctx.base}/units/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const prop = u.property; const cur = prop.currency; const archived = !!u.archived_at;
    const open = u.tenancies.filter((t) => t.status === 'draft' || t.status === 'active');
    const actions = [
      ctx.can('tenancies:write') && !archived && !prop.archived && h('button', { class: 'btn', type: 'button', onclick: () => openTenancyForm(ctx, { unit: u }, render) }, 'New tenancy'),
      ctx.can('properties:write') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openUnitForm(ctx, prop, u, render) }, 'Edit'),
      ctx.can('records:archive') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
        if (!archived && !(await confirmDialog({ title: `Archive unit ${u.reference}?`, message: 'It disappears from inventory lists. Tenancy history is kept and the unit can be restored.', confirmLabel: 'Archive', danger: true }))) return;
        try { await post(`${ctx.base}/units/${u.id}/${archived ? 'restore' : 'archive'}`, {}); toast(archived ? 'Unit restored.' : 'Unit archived.', 'success'); render(); }
        catch (e) { toast(e.message, 'error'); }
      } }, archived ? 'Restore' : 'Archive'),
    ];
    clear(root).append(
      crumbs({ label: 'Properties', href: '#/properties' }, { label: prop.name, href: `#/properties/${prop.id}` }, { label: `Unit ${u.reference}` }),
      pageHeader(`Unit ${u.reference}`, { subtitle: prop.name, badges: [occupancyBadge(u.occupancy), archivedBadge(u)], actions }),
      h('div', { class: 'cols-2' },
        section('Details', dl([['Property', h('a', { href: `#/properties/${prop.id}` }, prop.name)], ['Bedrooms', u.bedrooms], ['Bathrooms', u.bathrooms],
          ['Floor area', u.floor_area_sqm ? `${u.floor_area_sqm} m²` : null], ['Market rent', fmtMoney(u.market_rent_minor, cur)],
          ['Available to let', u.is_available ? 'Yes' : 'No'], ['Notes', u.notes]])),
        section('Current status', open.length
          ? dl([['Tenancy', h('a', { href: `#/tenancies/${open[0].id}` }, `${LABELS.tenancyStatus[open[0].status]} · ${fmtDate(open[0].start_date)} →`)], ['Tenant', open[0].primary_tenant],
              ['Rent', `${fmtMoney(open[0].rent_amount_minor, open[0].currency)} / ${LABELS.rentPeriodShort[open[0].rent_period]}`]])
          : emptyState({ icon: '🔑', title: 'No open tenancy', text: 'This unit has no draft or active tenancy.' }))),
      section('Tenancy history', u.tenancies.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Tenancy history'),
            h('thead', {}, h('tr', {}, ['Tenant', 'Status', 'Start', 'End', 'Rent'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', {}, u.tenancies.map((t) => h('tr', {}, h('td', { 'data-label': 'Tenant' }, h('a', { href: `#/tenancies/${t.id}` }, t.primary_tenant ?? 'Tenancy')),
              h('td', { 'data-label': 'Status' }, statusBadge(t.status)), h('td', { 'data-label': 'Start' }, fmtDate(t.start_date)), h('td', { 'data-label': 'End' }, fmtDate(t.end_date)),
              h('td', { class: 'num', 'data-label': 'Rent' }, fmtMoney(t.rent_amount_minor, t.currency)))))))
        : emptyState({ icon: '📜', title: 'No tenancies yet', text: 'Tenancies you create for this unit will be listed here, permanently.' })));
  }
  render();
  return root;
}
