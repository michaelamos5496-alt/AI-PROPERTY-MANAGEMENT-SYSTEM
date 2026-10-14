/** Shared building blocks for the record views: formatting, data table, form dialog. */
import { get } from './api.js';
import { formatMoney, parseMoney, toDecimalString } from './money.js';
import { clear, emptyState, h, setLoading, showFormError, skeleton } from './ui.js';

/* --------------------------------------------------------------- vocabulary */
export const LABELS = {
  propertyType: { residential: 'Residential', apartment_building: 'Apartment building', house: 'House', commercial: 'Commercial', mixed_use: 'Mixed use', land: 'Land', other: 'Other' },
  ownerType: { individual: 'Individual', company: 'Company', trust: 'Trust', other: 'Other' },
  rentPeriod: { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' },
  rentPeriodShort: { weekly: 'wk', fortnightly: '2 wks', monthly: 'mo', quarterly: 'qtr', annually: 'yr' },
  tenancyStatus: { draft: 'Draft', active: 'Active', ended: 'Ended', cancelled: 'Cancelled' },
  occupancy: { occupied: 'Occupied', vacant: 'Vacant', upcoming: 'Upcoming', unavailable: 'Unavailable' },
  leaseKind: { initial: 'Initial lease', renewal: 'Renewal', amendment: 'Amendment' },
  docType: { lease: 'Lease', addendum: 'Addendum', inspection: 'Inspection report', identification: 'Identification', other: 'Other' },
};
export const options = (map) => Object.entries(map);

/* --------------------------------------------------------------- formatting */
export { decimalPlaces as decimals } from './money.js';
export const fmtMoney = (minor, currency) => formatMoney(minor, currency);
/** Exact string-based conversion; returns NaN when the text is not a valid amount for the currency (never rounds). */
export const toMinor = (text, currency, opts) => { const r = parseMoney(text, currency, opts); return r.ok ? r.minor : NaN; };
export const fromMinor = (minor, currency) => (minor == null ? '' : toDecimalString(minor, currency));
// Date-only values ("2026-01-31") are calendar dates, not instants: format them in UTC so they never shift a day.
export const fmtDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
export const fmtTimestamp = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const address = (p) => [p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.country].filter(Boolean).join(', ');

export const statusBadge = (status, map = LABELS.tenancyStatus) => h('span', { class: `badge badge--${status}` }, map[status] ?? status);
export const archivedBadge = (row) => (row.archived_at || row.archived ? h('span', { class: 'badge badge--archived' }, 'Archived') : null);

/* ------------------------------------------------------------------ locale data */
export const timeZones = () => {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
};
export const countries = () => {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const out = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try { const n = names.of(code); if (n && n !== code) out.push([code, n]); } catch { /* invalid region */ }
  }
  return out.sort((x, y) => x[1].localeCompare(y[1]));
};
export const currencies = () => {
  const names = new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'code' });
  return Intl.supportedValuesOf('currency').map((c) => [c, `${c} — ${names.of(c)}`]);
};
export const localDefaults = () => {
  const region = (navigator.language.split('-')[1] ?? 'US').toUpperCase();
  return { country: region, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', currency: region === 'GB' ? 'GBP' : 'USD' };
};

/* --------------------------------------------------------------- hash query */
export const readQuery = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] ?? ''));
export function writeQuery(q) {
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null && v !== false));
  const path = location.hash.split('?')[0] || '#/';
  history.replaceState(null, '', `${location.pathname}${location.search}${path}${params.size ? `?${params}` : ''}`);
}

/* -------------------------------------------------------------- page chrome */
export const crumbs = (...items) =>
  h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('ol', {}, items.map((it, i) =>
    h('li', {}, it.href && i < items.length - 1 ? h('a', { href: it.href }, it.label) : h('span', { 'aria-current': i === items.length - 1 ? 'page' : false }, it.label)))));

export const pageHeader = (title, { subtitle, badges = [], actions = [] } = {}) =>
  h('div', { class: 'page-header' },
    h('div', {}, h('h1', {}, title, ...badges.map((b) => [' ', b])), subtitle && h('p', { class: 'muted page-header__sub' }, subtitle)),
    h('div', { class: 'row' }, ...actions));

export const section = (title, body, ...actions) =>
  h('section', { class: 'card section' }, h('div', { class: 'row row--between section__head' }, h('h2', {}, title), h('div', { class: 'row' }, ...actions)), body);

export const dl = (pairs) =>
  h('dl', { class: 'detail-grid' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v == null || v === '' ? '—' : v)]));

export const errorState = (err, retry) =>
  emptyState({ icon: '⚠️', title: err.status === 404 ? 'Not found' : 'Something went wrong', text: err.message, action: retry && h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again') });

/* --------------------------------------------------------------- data table */
/**
 * Server-driven table with search, filters, sort, pagination and an archived toggle.
 * State lives in the URL hash (persist=true) so reloads and back/forward keep it.
 */
export function dataTable({ ctx, endpoint, columns, filters = [], defaultSort, defaultDir = 'asc', pageSize = 15, empty, searchLabel = 'Search',
  archivable = false, persist = true, extraQuery = {}, caption, totals }) {
  const saved = persist ? readQuery() : {};
  const state = { search: saved.q ?? '', sort: saved.sort ?? defaultSort, dir: saved.dir ?? defaultDir, page: Number(saved.page ?? 1) || 1,
    archived: saved.archived === 'true', filters: Object.fromEntries(filters.map((f) => [f.key, saved[f.key] ?? ''])) };

  const status = h('p', { class: 'muted small table-status', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'table-wrap' });
  const pager = h('nav', { class: 'pager', 'aria-label': 'Pagination' });
  let timer; let seq = 0;

  const searchInput = h('input', { class: 'input', type: 'search', id: `s-${endpoint.replace(/\W/g, '')}`, value: state.search, placeholder: 'Search…',
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.search = e.target.value.trim(); state.page = 1; load(); }, 300); } });
  const onFilter = (f) => (e) => { state.filters[f.key] = f.type === 'checkbox' ? (e.target.checked ? 'true' : '') : e.target.value; state.page = 1; load(); };
  const filterEls = filters.map((f) => (f.type === 'checkbox'
    ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `f-${f.key}`, checked: state.filters[f.key] === 'true', onchange: onFilter(f) }), ` ${f.label}`)
    : f.type === 'date'
      ? h('div', { class: 'field field--inline' }, h('label', { for: `f-${f.key}` }, f.label), h('input', { class: 'input input--inline', type: 'date', id: `f-${f.key}`, value: state.filters[f.key], onchange: onFilter(f) }))
      : h('div', { class: 'field field--inline' }, h('label', { for: `f-${f.key}` }, f.label),
          h('select', { class: 'select select--inline', id: `f-${f.key}`, onchange: onFilter(f) },
            h('option', { value: '' }, f.all ?? 'All'), f.options.map(([v, l]) => h('option', { value: v, selected: state.filters[f.key] === v }, l))))));
  const archivedEl = archivable && h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: state.archived, onchange: (e) => { state.archived = e.target.checked; state.page = 1; load(); } }), ' Show archived');
  const toolbar = h('form', { class: 'toolbar', role: 'search', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'field field--inline field--search' }, h('label', { for: searchInput.id }, searchLabel), searchInput), ...filterEls, archivedEl);

  const hasFilters = () => state.search || state.archived || Object.values(state.filters).some(Boolean);
  const clearAll = () => {
    Object.assign(state, { search: '', archived: false, page: 1, filters: Object.fromEntries(filters.map((f) => [f.key, ''])) });
    searchInput.value = ''; toolbar.querySelectorAll('select').forEach((s) => { s.value = ''; });
    toolbar.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
    load();
  };

  const headCell = (c) => {
    if (!c.sort) return h('th', { scope: 'col' }, c.label ?? h('span', { class: 'visually-hidden' }, 'Actions'));
    const active = state.sort === c.sort;
    return h('th', { scope: 'col', 'aria-sort': active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'sort-btn', onclick: () => {
        state.dir = active && state.dir === 'asc' ? 'desc' : 'asc'; state.sort = c.sort; state.page = 1; load();
      } }, c.label, h('span', { 'aria-hidden': 'true' }, active ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕')));
  };

  async function load() {
    const mine = ++seq;
    if (persist) writeQuery({ q: state.search, sort: state.sort === defaultSort ? '' : state.sort, dir: state.dir === defaultDir ? '' : state.dir,
      page: state.page > 1 ? state.page : '', archived: state.archived, ...state.filters });
    if (!wrap.firstChild) wrap.append(skeleton(3));
    const params = new URLSearchParams({ limit: pageSize, offset: (state.page - 1) * pageSize, ...extraQuery });
    if (state.search) params.set('search', state.search);
    if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
    if (state.archived) params.set('archived', 'true');
    for (const [k, v] of Object.entries(state.filters)) if (v) params.set(k, v);
    let data;
    try { data = await get(`${ctx.base}${endpoint}?${params}`); }
    catch (err) { if (mine === seq) { clear(wrap).append(errorState(err, load)); clear(pager); status.textContent = ''; } return; }
    if (mine !== seq) return; // a newer request superseded this one
    const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
    if (state.page > lastPage) { state.page = lastPage; return load(); }

    clear(wrap); clear(pager); clear(totalsSlot);
    if (totals && data.total) totalsSlot.append(totals(data));
    if (!data.total) {
      status.textContent = 'No results.';
      wrap.append(hasFilters()
        ? emptyState({ icon: '🔍', title: 'No matches', text: 'Nothing fits your search and filters.', action: h('button', { class: 'btn btn--secondary', type: 'button', onclick: clearAll }, 'Clear filters') })
        : emptyState(empty));
      wrap.classList.add('table-wrap--bare');
      return;
    }
    wrap.classList.remove('table-wrap--bare');
    const first = (state.page - 1) * pageSize + 1;
    status.textContent = `Showing ${first}–${first + data.items.length - 1} of ${data.total}`;
    wrap.append(h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, caption ?? 'Results'),
      h('thead', {}, h('tr', {}, columns.map(headCell))),
      h('tbody', {}, data.items.map((row) => h('tr', { class: row.archived_at ? 'row--archived' : false }, columns.map((c) => h('td', { class: c.class ?? false, 'data-label': c.label ?? '' }, c.render(row))))))));
    if (lastPage > 1) pager.append(
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', disabled: state.page <= 1, onclick: () => { state.page -= 1; load(); } }, '‹ Previous'),
      h('span', { class: 'muted small' }, `Page ${state.page} of ${lastPage}`),
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', disabled: state.page >= lastPage, onclick: () => { state.page += 1; load(); } }, 'Next ›'));
  }

  const totalsSlot = h('div', { class: 'totals-slot' });
  const root = h('div', { class: 'datatable' }, toolbar, totalsSlot, status, wrap, pager);
  root.reload = load;
  load();
  return root;
}

/* ------------------------------------------------------------- form dialog */
let uid = 0;
const curOf = (f, inputs) => (typeof f.currency === 'function' ? f.currency(inputs ?? {}) : f.currency);
/**
 * Validated modal form. Field types: text, email, tel, number, money, date, select, textarea, checkbox.
 * Client checks cover required/format hints; the server remains the source of truth and its
 * field errors are shown next to the inputs.
 */
export function formDialog({ title, intro, fields, extra = [], initial = {}, submitLabel = 'Save', onSubmit, danger = false }) {
  const opener = document.activeElement;
  const id = ++uid;
  const titleId = `fd-title-${id}`;
  const inputs = {};
  const rows = fields.map((f) => {
    const inputId = `fd-${id}-${f.name}`;
    const val = initial[f.name];
    const hintId = f.hint || f.hintFn ? `${inputId}-hint` : undefined;
    const common = { id: inputId, name: f.name, required: f.required, 'aria-describedby': hintId, maxlength: f.maxLength, disabled: f.disabled };
    let el;
    if (f.type === 'select') {
      el = h('select', { ...common, class: 'select' }, !f.required || val == null ? h('option', { value: '' }, f.placeholder ?? (f.required ? 'Select…' : '—')) : null,
        f.options.map(([v, l]) => h('option', { value: v, selected: String(val ?? f.default ?? '') === String(v) }, l)));
    } else if (f.type === 'textarea') {
      el = h('textarea', { ...common, class: 'textarea', rows: f.rows ?? 3 }, val ?? '');
    } else if (f.type === 'checkbox') {
      el = h('input', { ...common, type: 'checkbox', checked: val ?? f.default ?? false });
    } else {
      const type = f.type === 'money' ? 'text' : f.type ?? 'text';
      const value = f.type === 'money' ? fromMinor(val, curOf(f)) : (val ?? f.default ?? '');
      el = h('input', { ...common, class: 'input', type, value, min: f.min, max: f.max, step: f.step, placeholder: f.placeholder,
        inputmode: f.type === 'money' ? 'decimal' : undefined, autocomplete: f.autocomplete ?? 'off', list: f.list });
    }
    inputs[f.name] = el;
    const labelText = f.required ? [f.label, h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')] : f.label;
    return f.type === 'checkbox'
      ? h('div', { class: `field field--check ${f.wide ? 'field--wide' : ''}` }, h('label', { for: inputId }, el, ' ', f.label), f.hint && h('span', { class: 'field__hint', id: hintId }, f.hint))
      : h('div', { class: `field ${f.wide ? 'field--wide' : ''}` }, h('label', { for: inputId }, labelText), el, (f.hint || f.hintFn) && h('span', { class: 'field__hint', id: hintId, dataset: { dyn: f.hintFn ? f.name : '' } }, f.hintFn ? f.hintFn(inputs) : f.hint));
  });

  const errBox = h('div', { class: 'alert alert--error', role: 'alert', tabindex: '-1', 'data-form-error': true, hidden: true });
  const submit = h('button', { class: `btn ${danger ? 'btn--danger' : ''}`, type: 'submit' }, submitLabel);
  const form = h('form', { novalidate: true, class: 'form-grid', 'aria-labelledby': titleId }, errBox, ...rows, ...extra);
  const dlg = h('dialog', { class: 'dialog dialog--form', 'aria-labelledby': titleId },
    h('div', { class: 'dialog__body' }, h('h2', { id: titleId }, title), intro && h('p', { class: 'muted' }, intro), form),
    h('div', { class: 'dialog__footer' }, h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => dlg.close() }, 'Cancel'), submit));
  submit.setAttribute('form', form.id = `fd-form-${id}`);
  const refreshHints = () => fields.filter((f) => f.hintFn).forEach((f) => {
    const n = form.querySelector(`[data-dyn="${f.name}"]`); if (n) n.textContent = f.hintFn(inputs);
  });
  form.addEventListener('change', refreshHints);

  const read = (f) => {
    const el = inputs[f.name];
    if (f.type === 'checkbox') return el.checked;
    const raw = el.value.trim();
    if (raw === '') return null;
    if (f.type === 'number') return Number(raw);
    if (f.type === 'money') return toMinor(raw, curOf(f, inputs), { allowNegative: f.allowNegative, allowZero: !f.positive });
    return raw;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError(form, null);
    const values = {}; const details = [];
    for (const f of fields) {
      const v = read(f);
      values[f.name] = v;
      if (f.required && f.type !== 'checkbox' && v == null) details.push({ in: 'body', path: f.name, message: 'Required.' });
      else if (f.type === 'money' && v != null && !Number.isFinite(v)) {
        const why = parseMoney(inputs[f.name].value, curOf(f, inputs), { allowNegative: f.allowNegative, allowZero: !f.positive });
        details.push({ in: 'body', path: f.name, message: why.ok ? 'Enter a valid amount.' : why.error });
      }
      else if (f.type === 'number' && v != null && !Number.isFinite(v)) details.push({ in: 'body', path: f.name, message: 'Enter a number.' });
    }
    if (details.length) { showFormError(form, { details, message: '' }); form.querySelector('[aria-invalid]')?.focus(); return; }
    setLoading(submit, true);
    try { await onSubmit(values); dlg.close(); }
    catch (err) {
      showFormError(form, err);
      (form.querySelector('[aria-invalid]') ?? errBox).focus?.();
    } finally { setLoading(submit, false); }
  });

  dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus(); });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Load option lists for selects (capped; larger sets will need type-ahead). */
export async function loadOptions(ctx, endpoint, toOption, extra = '') {
  const data = await get(`${ctx.base}${endpoint}?limit=100${extra}`);
  return { options: data.items.map(toOption), truncated: data.total > data.items.length };
}
