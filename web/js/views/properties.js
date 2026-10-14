import { get, patch, post, del } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { LABELS, address, archivedBadge, countries, crumbs, currencies, dataTable, dl, errorState, formDialog, loadOptions, localDefaults, options, pageHeader, section, timeZones } from '../kit.js';
import { openUnitForm, propertyUnitsTable } from './units.js';

const propertyFields = () => [
  { name: 'name', label: 'Property name', required: true, maxLength: 120, wide: true, placeholder: 'e.g. Maple Court' },
  { name: 'propertyType', label: 'Type', type: 'select', required: true, options: options(LABELS.propertyType), default: 'residential' },
  { name: 'reference', label: 'Internal reference', maxLength: 60 },
  { name: 'addressLine1', label: 'Address line 1', required: true, maxLength: 200, wide: true, autocomplete: 'address-line1' },
  { name: 'addressLine2', label: 'Address line 2', maxLength: 200, wide: true, autocomplete: 'address-line2' },
  { name: 'city', label: 'City', required: true, maxLength: 100, autocomplete: 'address-level2' },
  { name: 'region', label: 'State / region', maxLength: 100, autocomplete: 'address-level1' },
  { name: 'postalCode', label: 'Postal code', maxLength: 20, autocomplete: 'postal-code' },
  { name: 'country', label: 'Country', type: 'select', required: true, options: countries() },
  { name: 'timezone', label: 'Property time zone', type: 'select', required: true, options: timeZones().map((z) => [z, z]),
    hint: 'Dates such as “occupied today” follow this zone.' },
  { name: 'currency', label: 'Currency', type: 'select', required: true, options: currencies(),
    hint: 'Rent and deposits use this currency. It cannot be changed once tenancies exist.' },
  { name: 'notes', label: 'Notes', type: 'textarea', wide: true, maxLength: 4000 },
];
const toForm = (p) => ({ name: p.name, propertyType: p.property_type, reference: p.reference, addressLine1: p.address_line1, addressLine2: p.address_line2,
  city: p.city, region: p.region, postalCode: p.postal_code, country: p.country, timezone: p.timezone, currency: p.currency, notes: p.notes });

function openPropertyForm(ctx, property, done) {
  const editing = !!property;
  formDialog({
    title: editing ? 'Edit property' : 'Add property', fields: propertyFields(),
    initial: editing ? toForm(property) : localDefaults(), submitLabel: editing ? 'Save changes' : 'Add property',
    onSubmit: async (v) => {
      const saved = editing ? await patch(`${ctx.base}/properties/${property.id}`, { ...v, expectedVersion: property.version })
        : await post(`${ctx.base}/properties`, v);
      toast(editing ? 'Property updated.' : 'Property added.', 'success');
      done(saved);
    },
  });
}

export function propertiesView(ctx) {
  const canWrite = ctx.can('properties:write');
  // A factory: a DOM node can only live in one place, and this button appears in the header and the empty state.
  const add = () => canWrite && h('button', { class: 'btn', type: 'button', onclick: () => openPropertyForm(ctx, null, (p) => { location.hash = `#/properties/${p.id}`; }) }, 'Add property');
  return h('div', {}, pageHeader('Properties', { subtitle: 'Your portfolio.', actions: [add()] }),
    dataTable({
      ctx, endpoint: '/properties', defaultSort: 'name', searchLabel: 'Search name, address or city', archivable: true, caption: 'Property portfolio',
      empty: { icon: '🏢', title: 'Add your first property', text: canWrite ? 'Properties hold your units, owners and tenancies.' : 'No properties have been added yet. A manager can add them.', action: add() },
      filters: [{ key: 'type', label: 'Type', options: options(LABELS.propertyType) }],
      columns: [
        { label: 'Property', sort: 'name', render: (p) => [h('a', { href: `#/properties/${p.id}` }, p.name), ' ', archivedBadge(p)] },
        { label: 'Address', render: (p) => `${p.address_line1}, ${p.city}` },
        { label: 'Type', sort: 'type', render: (p) => LABELS.propertyType[p.property_type] },
        { label: 'Units', sort: 'units', class: 'num', render: (p) => p.unit_count },
        { label: 'Occupied', class: 'num', render: (p) => (p.unit_count ? `${p.occupied_count} / ${p.unit_count}` : '—') },
        { label: 'Currency', render: (p) => p.currency },
      ],
    }));
}

function openOwnerLink(ctx, property, done) {
  (async () => {
    let list;
    try { list = await loadOptions(ctx, '/owners', (o) => [o.id, `${o.name} (${LABELS.ownerType[o.owner_type]})`]); }
    catch (e) { return toast(e.message, 'error'); }
    const linked = new Set(property.owners.map((o) => o.owner_id));
    const choices = list.options.filter(([id]) => !linked.has(id));
    formDialog({
      title: 'Add owner', intro: 'Owners are people or companies. They do not need a Property AI account.',
      fields: [
        { name: 'existing', label: 'Existing owner', type: 'select', options: choices, placeholder: choices.length ? 'Choose an owner…' : 'No other owners yet', wide: true, hint: 'Or leave empty and enter a new owner below.' },
        { name: 'name', label: 'New owner name', maxLength: 160 },
        { name: 'ownerType', label: 'Owner type', type: 'select', required: true, options: options(LABELS.ownerType), default: 'individual' },
        { name: 'email', label: 'Email', type: 'email', maxLength: 254 }, { name: 'phone', label: 'Phone', type: 'tel', maxLength: 40 },
        { name: 'ownershipPct', label: 'Ownership share (%)', type: 'number', min: 0.01, max: 100, step: 0.01, hint: 'Optional. Shares across owners cannot exceed 100%.' },
        { name: 'isPrimary', label: 'Primary owner', type: 'checkbox', default: property.owners.length === 0 },
      ],
      submitLabel: 'Add owner',
      onSubmit: async (v) => {
        let ownerId = v.existing;
        if (!ownerId) {
          if (!v.name) throw Object.assign(new Error('Choose an existing owner or enter a name.'), { details: [{ in: 'body', path: 'name', message: 'Required for a new owner.' }] });
          ownerId = (await post(`${ctx.base}/owners`, { name: v.name, ownerType: v.ownerType, email: v.email, phone: v.phone })).id;
        }
        await post(`${ctx.base}/properties/${property.id}/owners/${ownerId}`, { ownershipPct: v.ownershipPct, isPrimary: v.isPrimary });
        toast('Owner added.', 'success');
        done();
      },
    });
  })();
}

export function propertyView(ctx, id) {
  const root = h('div', {}, skeleton(5));
  async function render() {
    let p;
    try { p = await get(`${ctx.base}/properties/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const archived = !!p.archived_at; const canWrite = ctx.can('properties:write');
    const actions = [
      canWrite && !archived && h('button', { class: 'btn', type: 'button', onclick: () => openUnitForm(ctx, p, null, render) }, 'Add unit'),
      canWrite && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openPropertyForm(ctx, p, render) }, 'Edit'),
      ctx.can('records:archive') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => {
        if (!archived && !(await confirmDialog({ title: `Archive ${p.name}?`, message: 'The property leaves your portfolio list. Units, tenancies and documents are kept and it can be restored. Properties with open tenancies cannot be archived.', confirmLabel: 'Archive', danger: true }))) return;
        try { await post(`${ctx.base}/properties/${p.id}/${archived ? 'restore' : 'archive'}`, {}); toast(archived ? 'Property restored.' : 'Property archived.', 'success'); render(); }
        catch (e) { toast(e.message, 'error'); }
      } }, archived ? 'Restore' : 'Archive'),
    ];
    const owners = p.owners.length
      ? h('ul', { class: 'plain-list' }, p.owners.map((o) => h('li', { class: 'row row--between' },
          h('span', {}, h('strong', {}, o.name), ' ', h('span', { class: 'muted small' }, [LABELS.ownerType[o.owner_type], o.ownership_pct != null && `${o.ownership_pct}%`, o.is_primary && 'primary', o.archived && 'archived'].filter(Boolean).join(' · ')),
            (o.email || o.phone) && h('br'), h('span', { class: 'muted small' }, [o.email, o.phone].filter(Boolean).join(' · '))),
          canWrite && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Remove owner ${o.name}`, onclick: async () => {
            if (!(await confirmDialog({ title: 'Remove owner link?', message: `${o.name} will no longer be listed as an owner of ${p.name}. The owner record is kept.`, confirmLabel: 'Remove', danger: true }))) return;
            try { await del(`${ctx.base}/properties/${p.id}/owners/${o.owner_id}`); toast('Owner removed.', 'success'); render(); } catch (e) { toast(e.message, 'error'); }
          } }, 'Remove'))))
      : emptyState({ icon: '👤', title: 'No owners recorded', text: 'A property can have several owners, and owners do not need an account.' });
    clear(root).append(
      crumbs({ label: 'Properties', href: '#/properties' }, { label: p.name }),
      pageHeader(p.name, { subtitle: address(p), badges: [archivedBadge(p)], actions }),
      h('div', { class: 'cols-2' },
        section('Details', dl([['Type', LABELS.propertyType[p.property_type]], ['Reference', p.reference], ['Time zone', p.timezone], ['Currency', p.currency],
          ['Units', `${p.unit_count} (${p.occupied_count} occupied)`], ['Notes', p.notes]])),
        section('Owners', owners, canWrite && !archived && h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: () => openOwnerLink(ctx, p, render) }, 'Add owner'))),
      section('Units', propertyUnitsTable(ctx, p)));
  }
  render();
  return root;
}
