import { get, newKey, postIdem, post } from '../api.js';
import { clear, confirmDialog, emptyState, h, skeleton, toast } from '../ui.js';
import { LABELS, crumbs, dataTable, dl, errorState, fmtDate, fmtMoney, fmtTimestamp, formDialog, loadOptions, options, pageHeader, section, statusBadge } from '../kit.js';

export const CHARGE_STATUS = { unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid', waived: 'Waived', void: 'Void' };
export const PAYMENT_STATUS = { unallocated: 'Unallocated', partial: 'Partly allocated', allocated: 'Allocated', reversed: 'Reversed' };
const EXPENSE_CATEGORY = { maintenance: 'Maintenance', repairs: 'Repairs', utilities: 'Utilities', insurance: 'Insurance', taxes: 'Taxes', management_fees: 'Management fees', legal: 'Legal', supplies: 'Supplies', other: 'Other' };
const METHOD = { bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card', cheque: 'Cheque', other: 'Other' };
const CHARGE_KIND = { rent: 'Rent', deposit: 'Deposit', fee: 'Fee', other: 'Other' };
const AUDIT_ACTION = {
  'payment.recorded': 'Payment recorded', 'payment.reversed': 'Payment reversed', 'allocation.created': 'Payment allocated', 'allocation.reversed': 'Allocation reversed',
  'charge.created': 'Charge created', 'charge.voided': 'Charge voided', 'charge.adjusted': 'Charge adjusted', 'charges.generated': 'Charges generated',
  'schedule.created': 'Rent schedule created', 'schedule.stopped': 'Rent schedule stopped', 'receipt.issued': 'Receipt issued',
  'expense.recorded': 'Expense recorded', 'expense.voided': 'Expense voided',
};

/* ------------------------------------------------------------------ helpers */
const todayLocal = () => new Date().toLocaleDateString('en-CA');
/** Today's date in a property's own time zone (what the server judges "in the future" against). */
const todayIn = (tz) => { try { return new Date().toLocaleDateString('en-CA', { timeZone: tz }); } catch { return todayLocal(); } };
const monthStart = () => `${todayLocal().slice(0, 8)}01`;
const rate = (bps) => (bps == null ? '—' : `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`);
const money = (v, cur, { bad = false } = {}) => h('span', { class: bad && v > 0 ? 'money-neg' : false }, fmtMoney(v, cur));

export const manualNotice = () => h('div', { class: 'notice', role: 'note' }, h('span', { 'aria-hidden': 'true' }, 'ℹ️'),
  h('span', {}, h('strong', {}, 'Manually recorded. '), 'Payments are entered by staff. They are not verified against a bank or payment provider, and receipts say so.'));

/** One idempotency key per distinct request body: retrying the same data reuses the key, edited data gets a new one. */
function keyFor() {
  let last = ''; let key = newKey();
  return (body) => { const j = JSON.stringify(body); if (j !== last) { last = j; key = newKey(); } return key; };
}

const totalsStrip = (rows, fields) => h('div', { class: 'totals', role: 'group', 'aria-label': 'Totals for the filtered results, by currency' },
  rows.map((r) => h('dl', {}, h('span', { class: 'totals__cur' }, r.currency),
    ...fields.flatMap(([k, label]) => [h('span', { class: 'k' }, `${label} `), h('strong', {}, fmtMoney(r[k], r.currency)), ' ']))));

const tenancyLabel = (t) => `${t.property_name} · ${t.unit_reference} — ${t.primary_tenant ?? 'no tenant'}`;
async function tenancyOptions(ctx, filter = () => true) {
  const r = await loadOptions(ctx, '/tenancies', (t) => [t.id, tenancyLabel(t), t.currency, t.status, t.timezone], '&sort=property&dir=asc');
  return { ...r, options: r.options.filter((o) => o[3] !== 'cancelled' && filter(o)) };
}
async function propertyFilterOptions(ctx) {
  const r = await loadOptions(ctx, '/properties', (p) => [p.id, p.name], '&sort=name');
  return r.options;
}
const currencyOptions = () => ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF'].map((c) => [c, c]);

function reasonDialog({ title, intro, submitLabel, onSubmit, danger = true, label = 'Reason' }) {
  formDialog({ title, intro, danger, submitLabel, fields: [{ name: 'reason', label, type: 'textarea', required: true, wide: true, maxLength: 500, hint: 'Recorded permanently in the audit history.' }], onSubmit });
}

/* ------------------------------------------------------------------ dialogs */
export async function openRecordPayment(ctx, { tenancy } = {}, done) {
  let tenancies;
  try { tenancies = await tenancyOptions(ctx); } catch (e) { return toast(e.message, 'error'); }
  if (!tenancies.options.length) return toast('There are no tenancies to record a payment against yet.', 'error');
  const session = keyFor();
  const cur = (inputs) => tenancies.options.find((o) => o[0] === (inputs.tenancy?.value ?? tenancy))?.[2] ?? 'USD';
  const tz = (tenancies.options.find((o) => o[0] === tenancy) ?? tenancies.options[0])[4];
  formDialog({
    title: 'Record a payment', intro: 'Enter a payment you have received. It is saved as a manual record, not verified against a bank.',
    fields: [
      { name: 'tenancy', label: 'Tenancy', type: 'select', required: true, options: tenancies.options.map(([v, l]) => [v, l]), default: tenancy, wide: true },
      { name: 'amountMinor', label: 'Amount received', type: 'money', currency: cur, required: true, positive: true, hintFn: (i) => `In ${cur(i)}. Exact amount, no rounding.` },
      { name: 'receivedOn', label: 'Date received', type: 'date', required: true, default: todayIn(tz), max: tenancy ? todayIn(tz) : undefined, hint: `Cannot be in the future in the property's time zone (${tz}).` },
      { name: 'method', label: 'Method', type: 'select', required: true, options: options(METHOD), default: 'bank_transfer' },
      { name: 'reference', label: 'Reference', required: true, maxLength: 100, hint: 'Bank reference or receipt number. The same reference cannot be entered twice for a tenancy.' },
      { name: 'note', label: 'Note', type: 'textarea', wide: true, maxLength: 1000 },
      { name: 'autoAllocate', label: 'Apply to the oldest unpaid charges now', type: 'checkbox', default: true, wide: true, hint: 'Anything left over is kept as credit on the tenancy.' },
    ],
    submitLabel: 'Record payment',
    onSubmit: async (v) => {
      const { tenancy: tn, ...body } = v;
      const p = await postIdem(`${ctx.base}/tenancies/${tn}/payments`, body, session({ tn, ...body }));
      toast(p.replayed ? 'That payment was already recorded.' : 'Payment recorded.', 'success');
      location.hash = `#/payments/${p.id}`;
      done?.(p);
    },
  });
}

export async function openAllocate(ctx, payment, done) {
  let ledger;
  try { ledger = await get(`${ctx.base}/tenancies/${payment.tenancy_id}/ledger`); } catch (e) { return toast(e.message, 'error'); }
  const open = ledger.charges.filter((c) => !c.voided_at && c.outstanding_minor > 0).sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (!open.length) return toast('There are no unpaid charges on this tenancy. The payment stays as credit.', 'info');
  let remaining = payment.unallocated_minor;
  const initial = {};
  for (const c of open) { const take = Math.min(c.outstanding_minor, remaining); if (take > 0) { initial[`c_${c.id}`] = take; remaining -= take; } }
  const session = keyFor();
  formDialog({
    title: 'Allocate payment', intro: `${fmtMoney(payment.unallocated_minor, payment.currency)} is available. Allocations are in ${payment.currency}; there is no currency conversion.`,
    fields: open.map((c) => ({ name: `c_${c.id}`, label: `${fmtDate(c.due_date)} — ${c.description}`, type: 'money', currency: payment.currency, wide: true,
      hint: `Outstanding ${fmtMoney(c.outstanding_minor, payment.currency)}${c.is_overdue ? ' · overdue' : ''}` })),
    initial, submitLabel: 'Allocate',
    onSubmit: async (v) => {
      const allocations = Object.entries(v).filter(([k, a]) => k.startsWith('c_') && a > 0).map(([k, a]) => ({ chargeId: k.slice(2), amountMinor: a }));
      const total = allocations.reduce((n, a) => n + a.amountMinor, 0);
      const fail = (message) => { throw Object.assign(new Error(message), { details: [] }); };
      if (!allocations.length) fail('Enter an amount for at least one charge.');
      if (total > payment.unallocated_minor) fail(`That is ${fmtMoney(total - payment.unallocated_minor, payment.currency)} more than this payment has available.`);
      await postIdem(`${ctx.base}/payments/${payment.id}/allocations`, { allocations }, session({ allocations }));
      toast('Payment allocated.', 'success');
      done();
    },
  });
}

async function openChargeForm(ctx, { tenancy } = {}, done) {
  let tenancies;
  try { tenancies = await tenancyOptions(ctx); } catch (e) { return toast(e.message, 'error'); }
  const session = keyFor();
  const cur = (i) => tenancies.options.find((o) => o[0] === (i.tenancy?.value ?? tenancy))?.[2] ?? 'USD';
  formDialog({
    title: 'Add a charge', intro: 'For one-off amounts such as deposits and fees. Recurring rent comes from the rent schedule.',
    fields: [
      { name: 'tenancy', label: 'Tenancy', type: 'select', required: true, options: tenancies.options.map(([v, l]) => [v, l]), default: tenancy, wide: true },
      { name: 'kind', label: 'Type', type: 'select', required: true, options: options(CHARGE_KIND), default: 'fee' },
      { name: 'dueDate', label: 'Due date', type: 'date', required: true, default: todayLocal() },
      { name: 'description', label: 'Description', required: true, maxLength: 200, wide: true },
      { name: 'amountMinor', label: 'Amount', type: 'money', currency: cur, required: true, positive: true, hintFn: (i) => `In ${cur(i)}.` },
    ],
    submitLabel: 'Add charge',
    onSubmit: async (v) => {
      const { tenancy: tn, ...body } = v;
      await postIdem(`${ctx.base}/tenancies/${tn}/charges`, body, session({ tn, ...body }));
      toast('Charge added.', 'success'); done();
    },
  });
}

const openVoidCharge = (ctx, c, done) => reasonDialog({
  title: `Void “${c.description}”?`, intro: 'A void charge is kept on record but no longer counts toward what is owed. Charges with payments applied must have those allocations reversed first.', submitLabel: 'Void charge',
  onSubmit: async (v) => { await post(`${ctx.base}/charges/${c.id}/void`, v); toast('Charge voided.', 'success'); done(); },
});

function openAdjust(ctx, c, done) {
  const session = keyFor();
  formDialog({
    title: 'Adjust charge', intro: `${c.description} · now ${fmtMoney(c.effective_minor, c.currency)}, ${fmtMoney(c.allocated_minor, c.currency)} paid. Adjustments are permanent entries; to undo one, add an opposite adjustment.`,
    fields: [
      { name: 'amountMinor', label: `Adjustment (${c.currency})`, type: 'money', currency: c.currency, required: true, allowNegative: true, positive: true, hint: 'Negative reduces the charge (waiver or discount); positive increases it. Cannot go below what is already paid.' },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true, wide: true, maxLength: 500 },
    ],
    submitLabel: 'Apply adjustment',
    onSubmit: async (v) => { await postIdem(`${ctx.base}/charges/${c.id}/adjustments`, v, session(v)); toast('Charge adjusted.', 'success'); done(); },
  });
}

function openScheduleForm(ctx, t, done) {
  formDialog({
    title: 'Set up recurring rent', intro: 'Charges are generated from this schedule, once per period, and never duplicated. Due dates follow the first due date (a 31st clamps to the month’s last day without drifting).',
    fields: [
      { name: 'amountMinor', label: `Rent per period (${t.currency})`, type: 'money', currency: t.currency, required: true, positive: true },
      { name: 'period', label: 'Period', type: 'select', required: true, options: options(LABELS.rentPeriod), default: t.rent_period },
      { name: 'firstDueDate', label: 'First due date', type: 'date', required: true, default: t.start_date },
      { name: 'endDate', label: 'Last due date (optional)', type: 'date' },
    ],
    initial: { amountMinor: t.rent_amount_minor },
    submitLabel: 'Create schedule',
    onSubmit: async (v) => { await post(`${ctx.base}/tenancies/${t.id}/rent-schedules`, v); toast('Rent schedule created.', 'success'); done(); },
  });
}

async function generateCharges(ctx, done, tenancy = null) {
  if (!(await confirmDialog({ title: 'Generate due rent charges?', message: 'Creates any rent charges that are due but missing. It is safe to run repeatedly: charges that already exist are never duplicated.', confirmLabel: 'Generate' }))) return;
  try {
    const r = await post(`${ctx.base}/finance/generate-charges`, { tenancy, through: null });
    toast(r.created ? `${r.created} charge${r.created === 1 ? '' : 's'} created.` : 'Already up to date. Nothing new was due.', 'success');
    done();
  } catch (e) { toast(e.message, 'error'); }
}

async function openExpenseForm(ctx, done) {
  let props;
  try { props = await loadOptions(ctx, '/properties', (p) => [p.id, `${p.name} (${p.currency})`, p.currency], '&sort=name'); } catch (e) { return toast(e.message, 'error'); }
  if (!props.options.length) return toast('Add a property first.', 'error');
  const session = keyFor();
  const cur = (i) => props.options.find((o) => o[0] === i.property?.value)?.[2] ?? props.options[0][2];
  formDialog({
    title: 'Record an expense', intro: 'Expenses are recorded against a property, in that property’s currency.',
    fields: [
      { name: 'property', label: 'Property', type: 'select', required: true, options: props.options.map(([v, l]) => [v, l]), wide: true },
      { name: 'category', label: 'Category', type: 'select', required: true, options: options(EXPENSE_CATEGORY), default: 'maintenance' },
      { name: 'incurredOn', label: 'Date', type: 'date', required: true, default: todayLocal(), max: todayLocal() },
      { name: 'description', label: 'Description', required: true, maxLength: 200, wide: true },
      { name: 'vendor', label: 'Vendor', maxLength: 160 }, { name: 'reference', label: 'Invoice / reference', maxLength: 100 },
      { name: 'amountMinor', label: 'Amount', type: 'money', currency: cur, required: true, positive: true, hintFn: (i) => `In ${cur(i)}.` },
    ],
    submitLabel: 'Record expense',
    onSubmit: async (v) => {
      const { property, ...body } = v;
      await postIdem(`${ctx.base}/properties/${property}/expenses`, body, session({ property, ...body }));
      toast('Expense recorded.', 'success'); done();
    },
  });
}

/* ------------------------------------------------------------- finance tabs */
const TABS = [['overview', 'Overview'], ['balances', 'Balances'], ['charges', 'Charges'], ['payments', 'Payments'], ['expenses', 'Expenses'], ['audit', 'Audit & reconciliation', 'finance:audit']];

export async function financeView(ctx, tab = 'overview') {
  const tabs = TABS.filter(([, , need]) => !need || ctx.can(need));
  const current = tabs.some(([k]) => k === tab) ? tab : 'overview';
  const body = h('div', {}, skeleton(3));
  const render = async () => {
    try {
      const node = await ({ overview: overviewTab, balances: balancesTab, charges: chargesTab, payments: paymentsTab, expenses: expensesTab, audit: auditTab }[current])(ctx, render);
      clear(body).append(node);
    } catch (e) { clear(body).append(errorState(e, render)); }
  };
  render();
  return h('div', {}, pageHeader('Finance', { subtitle: 'Charges, payments, balances and expenses.',
      actions: [ctx.can('payments:write') && h('button', { class: 'btn', type: 'button', onclick: () => openRecordPayment(ctx) }, 'Record payment')] }),
    h('nav', { class: 'tabs', 'aria-label': 'Finance sections' }, tabs.map(([k, label]) => h('a', { href: `#/finance/${k}`, 'aria-current': k === current ? 'page' : false }, label))),
    manualNotice(), body);
}

async function overviewTab(ctx, rerender) {
  const props = await propertyFilterOptions(ctx);
  const q = { from: monthStart(), to: todayLocal(), property: '', currency: '' };
  const out = h('div', {});
  async function run() {
    clear(out).append(skeleton(2));
    try {
      const params = new URLSearchParams({ from: q.from, to: q.to, ...(q.property && { property: q.property }), ...(q.currency && { currency: q.currency }) });
      const rows = await get(`${ctx.base}/finance/performance?${params}`);
      clear(out).append(rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Rent performance by property'),
            h('thead', {}, h('tr', {}, ['Property', 'Billed', 'Collected', 'Outstanding', 'Overdue', 'Collection rate', 'Payments received', 'Expenses', 'Net cash'].map((c, i) => h('th', { scope: 'col', class: i ? 'num' : false }, c)))),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', { 'data-label': 'Property' }, h('a', { href: `#/properties/${r.property_id}` }, r.property_name), ' ', h('span', { class: 'badge' }, r.currency)),
              ...[['billed_minor'], ['collected_minor'], ['outstanding_minor'], ['overdue_minor', true], ['_rate'], ['payments_received_minor'], ['expenses_minor'], ['net_cash_minor']].map(([k, bad], i) =>
                h('td', { class: 'num', 'data-label': ['Billed', 'Collected', 'Outstanding', 'Overdue', 'Collection rate', 'Payments received', 'Expenses', 'Net cash'][i] },
                  k === '_rate' ? rate(r.collection_rate_bps) : money(r[k], r.currency, { bad }))))))))
        : emptyState({ icon: '📊', title: 'No financial activity in this period', text: 'Charges, payments and expenses dated within the period appear here.' }));
    } catch (e) { clear(out).append(errorState(e, run)); }
  }
  const field = (id, label, node) => h('div', { class: 'field field--inline' }, h('label', { for: id }, label), node);
  const bar = h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); run(); } },
    field('p-from', 'From', h('input', { class: 'input input--inline', type: 'date', id: 'p-from', value: q.from, required: true, onchange: (e) => { q.from = e.target.value; run(); } })),
    field('p-to', 'To', h('input', { class: 'input input--inline', type: 'date', id: 'p-to', value: q.to, required: true, onchange: (e) => { q.to = e.target.value; run(); } })),
    field('p-prop', 'Property', h('select', { class: 'select select--inline', id: 'p-prop', onchange: (e) => { q.property = e.target.value; run(); } }, h('option', { value: '' }, 'All properties'), props.map(([v, l]) => h('option', { value: v }, l)))),
    field('p-cur', 'Currency', h('select', { class: 'select select--inline', id: 'p-cur', onchange: (e) => { q.currency = e.target.value; run(); } }, h('option', { value: '' }, 'All currencies'), currencyOptions().map(([v, l]) => h('option', { value: v }, l)))));
  run();
  return h('div', {},
    ctx.can('finance:manage') && h('div', { class: 'row no-print' }, h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => generateCharges(ctx, rerender) }, 'Generate due rent charges')),
    section('Rent performance', h('div', {}, bar, out, h('p', { class: 'muted small' }, 'Billed = charges due in the period. Collected = payments applied to those charges. Each currency is reported separately and never combined. Collection rate is rounded down to 0.01%.'))));
}

async function balancesTab(ctx) {
  const props = await propertyFilterOptions(ctx);
  return dataTable({
    ctx, endpoint: '/finance/balances', defaultSort: 'outstanding', defaultDir: 'desc', searchLabel: 'Search tenant, property or unit', caption: 'Tenant balances',
    empty: { icon: '🧾', title: 'No balances yet', text: 'Balances appear once a tenancy has charges or payments.' },
    totals: (d) => totalsStrip(d.totals, [['charged_minor', 'Charged'], ['outstanding_minor', 'Outstanding'], ['overdue_minor', 'Overdue'], ['credit_minor', 'Credit']]),
    filters: [{ key: 'property', label: 'Property', options: props }, { key: 'currency', label: 'Currency', options: currencyOptions() },
      { key: 'from', label: 'Due from', type: 'date' }, { key: 'to', label: 'Due to', type: 'date' }, { key: 'arrearsOnly', label: 'Only tenants in arrears', type: 'checkbox' }],
    columns: [
      { label: 'Tenant', sort: 'tenant', render: (r) => h('a', { href: `#/tenancies/${r.tenancy_id}` }, r.primary_tenant ?? 'Tenancy') },
      { label: 'Property', sort: 'property', render: (r) => `${r.property_name} · ${r.unit_reference}` },
      { label: 'Charged', class: 'num', render: (r) => fmtMoney(r.charged_minor, r.currency) },
      { label: 'Paid', class: 'num', render: (r) => fmtMoney(r.allocated_minor, r.currency) },
      { label: 'Outstanding', sort: 'outstanding', class: 'num', render: (r) => money(r.outstanding_minor, r.currency) },
      { label: 'Overdue', sort: 'overdue', class: 'num', render: (r) => money(r.overdue_minor, r.currency, { bad: true }) },
      { label: 'Credit', sort: 'credit', class: 'num', render: (r) => (r.credit_minor ? h('span', { class: 'money-pos' }, fmtMoney(r.credit_minor, r.currency)) : '—') },
    ],
  });
}

async function chargesTab(ctx, rerender) {
  const props = await propertyFilterOptions(ctx);
  const add = () => ctx.can('finance:manage') && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openChargeForm(ctx, {}, rerender) }, 'Add charge');
  return h('div', {}, h('div', { class: 'row no-print' }, add()),
    dataTable({
      ctx, endpoint: '/charges', defaultSort: 'due', defaultDir: 'desc', searchLabel: 'Search', caption: 'Charges',
      empty: { icon: '🧾', title: 'No charges yet', text: ctx.can('finance:manage') ? 'Set up a rent schedule on a tenancy, or add a one-off charge.' : 'No charges have been created yet.' },
      totals: (d) => totalsStrip(d.totals, [['charged_minor', 'Charged'], ['allocated_minor', 'Paid'], ['outstanding_minor', 'Outstanding'], ['overdue_minor', 'Overdue']]),
      filters: [{ key: 'status', label: 'Status', options: [...options(CHARGE_STATUS), ['overdue', 'Overdue']] }, { key: 'property', label: 'Property', options: props },
        { key: 'currency', label: 'Currency', options: currencyOptions() }, { key: 'from', label: 'Due from', type: 'date' }, { key: 'to', label: 'Due to', type: 'date' }],
      columns: [
        { label: 'Due', sort: 'due', render: (c) => fmtDate(c.due_date) },
        { label: 'Tenant', sort: 'tenant', render: (c) => h('a', { href: `#/tenancies/${c.tenancy_id}` }, c.primary_tenant ?? 'Tenancy') },
        { label: 'Property', sort: 'property', render: (c) => `${c.property_name} · ${c.unit_reference}` },
        { label: 'Description', render: (c) => c.description },
        { label: 'Amount', sort: 'amount', class: 'num', render: (c) => [fmtMoney(c.effective_minor, c.currency), c.adjusted_minor ? h('span', { class: 'muted small', title: 'Includes adjustments' }, ' (adj.)') : ''] },
        { label: 'Outstanding', sort: 'outstanding', class: 'num', render: (c) => money(c.outstanding_minor, c.currency, { bad: c.is_overdue }) },
        { label: 'Status', sort: 'status', render: (c) => [statusBadge(c.status, CHARGE_STATUS), c.is_overdue ? [' ', h('span', { class: 'badge badge--cancelled' }, 'Overdue')] : ''] },
        { label: null, class: 'actions', render: (c) => chargeActions(ctx, c, rerender) },
      ],
    }));
}
const chargeActions = (ctx, c, done) => (c.voided_at ? '' : h('span', { class: 'row' },
  ctx.can('finance:adjust') && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Adjust ${c.description}`, onclick: () => openAdjust(ctx, c, done) }, 'Adjust'),
  ctx.can('finance:manage') && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Void ${c.description}`, onclick: () => openVoidCharge(ctx, c, done) }, 'Void')));

async function paymentsTab(ctx, rerender) {
  const props = await propertyFilterOptions(ctx);
  const add = () => ctx.can('payments:write') && h('button', { class: 'btn', type: 'button', onclick: () => openRecordPayment(ctx, {}, rerender) }, 'Record payment');
  return dataTable({
    ctx, endpoint: '/payments', defaultSort: 'received', defaultDir: 'desc', searchLabel: 'Search', caption: 'Payments',
    empty: { icon: '💷', title: 'No payments recorded', text: 'Record a payment you have received to start reducing balances.', action: add() },
    totals: (d) => totalsStrip(d.totals, [['received_minor', 'Received'], ['allocated_minor', 'Allocated'], ['unallocated_minor', 'Unallocated']]),
    filters: [{ key: 'status', label: 'Status', options: options(PAYMENT_STATUS) }, { key: 'property', label: 'Property', options: props },
      { key: 'currency', label: 'Currency', options: currencyOptions() }, { key: 'from', label: 'Received from', type: 'date' }, { key: 'to', label: 'Received to', type: 'date' }],
    columns: [
      { label: 'Received', sort: 'received', render: (p) => h('a', { href: `#/payments/${p.id}` }, fmtDate(p.received_on)) },
      { label: 'Tenant', sort: 'tenant', render: (p) => p.primary_tenant ?? '—' },
      { label: 'Property', sort: 'property', render: (p) => `${p.property_name} · ${p.unit_reference}` },
      { label: 'Reference', render: (p) => p.reference },
      { label: 'Amount', sort: 'amount', class: 'num', render: (p) => fmtMoney(p.amount_minor, p.currency) },
      { label: 'Unallocated', sort: 'unallocated', class: 'num', render: (p) => (p.unallocated_minor ? h('span', { class: 'money-pos' }, fmtMoney(p.unallocated_minor, p.currency)) : '—') },
      { label: 'Status', sort: 'status', render: (p) => statusBadge(p.status, PAYMENT_STATUS) },
      { label: 'Receipt', render: (p) => p.receipt_number ?? '—' },
    ],
  });
}

async function expensesTab(ctx, rerender) {
  const props = await propertyFilterOptions(ctx);
  const canManage = ctx.can('finance:manage');
  const add = () => canManage && h('button', { class: 'btn', type: 'button', onclick: () => openExpenseForm(ctx, rerender) }, 'Record expense');
  return h('div', {}, h('div', { class: 'row no-print' }, add()),
    dataTable({
      ctx, endpoint: '/expenses', defaultSort: 'date', defaultDir: 'desc', searchLabel: 'Search', caption: 'Expenses',
      empty: { icon: '🧰', title: 'No expenses recorded', text: canManage ? 'Record repairs, utilities and other costs against a property.' : 'No expenses have been recorded yet.' },
      totals: (d) => totalsStrip(d.totals, [['amount_minor', 'Total']]),
      filters: [{ key: 'property', label: 'Property', options: props }, { key: 'category', label: 'Category', options: options(EXPENSE_CATEGORY) },
        { key: 'currency', label: 'Currency', options: currencyOptions() }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }, { key: 'includeVoid', label: 'Show voided', type: 'checkbox' }],
      columns: [
        { label: 'Date', sort: 'date', render: (e) => fmtDate(e.incurred_on) },
        { label: 'Property', sort: 'property', render: (e) => h('a', { href: `#/properties/${e.property_id}` }, e.property_name) },
        { label: 'Category', sort: 'category', render: (e) => EXPENSE_CATEGORY[e.category] },
        { label: 'Description', render: (e) => [e.description, e.vendor ? h('span', { class: 'muted small' }, ` · ${e.vendor}`) : '', e.voided_at ? [' ', h('span', { class: 'badge badge--archived' }, 'Void')] : ''] },
        { label: 'Amount', sort: 'amount', class: 'num', render: (e) => fmtMoney(e.amount_minor, e.currency) },
        { label: null, class: 'actions', render: (e) => (canManage && !e.voided_at ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => reasonDialog({
          title: 'Void this expense?', intro: 'It stays on record but stops counting toward totals.', submitLabel: 'Void expense',
          onSubmit: async (v) => { await post(`${ctx.base}/expenses/${e.id}/void`, v); toast('Expense voided.', 'success'); rerender(); } }) }, 'Void') : '') },
      ],
    }));
}

async function auditTab(ctx) {
  const recon = h('div', {});
  const runRecon = async () => {
    clear(recon).append(skeleton(2));
    try {
      const r = await get(`${ctx.base}/finance/reconciliation`);
      clear(recon).append(h('div', {},
        h('div', { class: `alert ${r.ok ? 'alert--success' : 'alert--error'}`, role: 'status' }, r.ok ? 'All checks passed. Balances match the underlying records.' : 'Some checks failed. Do not rely on these balances until this is resolved.'),
        h('ul', { class: 'check-list' }, r.checks.map((c) => h('li', {}, h('span', { class: c.ok ? 'ok' : 'bad', 'aria-hidden': 'true' }, c.ok ? '✓' : '✗'), h('span', {}, c.name, c.ok ? '' : ` — ${c.violations} problem${c.violations === 1 ? '' : 's'}`)))),
        r.totals.length ? h('div', { class: 'table-wrap mt-5' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Ledger totals by currency'),
          h('thead', {}, h('tr', {}, ['Currency', 'Charged', 'Allocated', 'Outstanding', 'Payments', 'Credit'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', {}, r.totals.map((t) => h('tr', {}, h('td', { 'data-label': 'Currency' }, t.currency), ...['charged_minor', 'allocated_minor', 'outstanding_minor', 'payments_minor', 'credit_minor'].map((k) => h('td', { class: 'num', 'data-label': k }, fmtMoney(t[k], t.currency)))))))) : '',
        h('p', { class: 'muted small' }, `Checked ${fmtTimestamp(r.checked_at)}. Totals are recomputed from the raw ledger rows and compared with the derived balances.`)));
    } catch (e) { clear(recon).append(errorState(e, runRecon)); }
  };
  return h('div', {},
    section('Reconciliation', h('div', {}, h('p', { class: 'muted' }, 'Recomputes every balance from the underlying records and confirms nothing is over-allocated, mismatched in currency, or out of step.'), recon),
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: runRecon }, 'Run reconciliation')),
    section('Audit history', dataTable({
      ctx, endpoint: '/finance/audit', persist: false, defaultSort: undefined, pageSize: 20, searchLabel: 'Search', caption: 'Financial audit history',
      empty: { icon: '🗂️', title: 'No financial activity yet', text: 'Every payment, allocation, charge and correction is recorded here.' },
      filters: [{ key: 'entityType', label: 'Record type', options: [['payment', 'Payment'], ['charge', 'Charge'], ['expense', 'Expense'], ['rent_schedule', 'Rent schedule'], ['tenancy', 'Tenancy']] }],
      columns: [
        { label: 'When', render: (a) => fmtTimestamp(a.created_at) },
        { label: 'Action', render: (a) => AUDIT_ACTION[a.action] ?? a.action },
        { label: 'Record', render: (a) => (a.entity_type === 'payment' && a.entity_id ? h('a', { href: `#/payments/${a.entity_id}` }, 'Payment') : a.entity_type) },
        { label: 'By', render: (a) => a.actor ?? 'System' },
        { label: 'Reason', render: (a) => a.reason ?? '—' },
      ],
    })));
}

/* ------------------------------------------------------------ payment detail */
export function paymentView(ctx, id) {
  const root = h('div', {}, skeleton(4));
  async function render() {
    let p;
    try { p = await get(`${ctx.base}/payments/${id}`); } catch (e) { return clear(root).append(errorState(e, render)); }
    const reversed = !!p.reversed_at; const run = async (fn, msg) => { try { await fn(); toast(msg, 'success'); render(); } catch (e) { toast(e.message, 'error'); } };
    const actions = [
      ctx.can('payments:write') && !reversed && p.unallocated_minor > 0 && h('button', { class: 'btn', type: 'button', onclick: () => openAllocate(ctx, p, render) }, 'Allocate'),
      ctx.can('payments:write') && !reversed && p.unallocated_minor > 0 && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => run(() => post(`${ctx.base}/payments/${p.id}/auto-allocate`, {}), 'Applied to the oldest unpaid charges.') }, 'Apply to oldest charges'),
      ctx.can('payments:write') && !reversed && (p.receipt ? h('a', { class: 'btn btn--secondary', href: `#/receipts/${p.receipt.id}` }, `View receipt ${p.receipt.number}`)
        : h('button', { class: 'btn btn--secondary', type: 'button', onclick: async () => { try { const r = await post(`${ctx.base}/payments/${p.id}/receipt`, {}); location.hash = `#/receipts/${r.id}`; } catch (e) { toast(e.message, 'error'); } } }, 'Issue receipt')),
      ctx.can('finance:manage') && !reversed && h('button', { class: 'btn btn--danger', type: 'button', onclick: () => reasonDialog({
        title: 'Reverse this payment?', intro: 'The payment stays on record as reversed. Everything it was applied to is released, and its receipt is voided. This cannot be undone.', submitLabel: 'Reverse payment',
        onSubmit: async (v) => { await post(`${ctx.base}/payments/${p.id}/reverse`, v); toast('Payment reversed.', 'success'); render(); } }) }, 'Reverse'),
    ];
    const allocs = p.allocations.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Allocations'),
      h('thead', {}, h('tr', {}, ['Applied to', 'Due', 'Amount', 'Applied', 'Status', ''].map((c) => h('th', { scope: 'col' }, c || h('span', { class: 'visually-hidden' }, 'Actions'))))),
      h('tbody', {}, p.allocations.map((a) => h('tr', { class: a.reversed_at ? 'row--archived' : false },
        h('td', { 'data-label': 'Applied to' }, a.charge_description), h('td', { 'data-label': 'Due' }, fmtDate(a.charge_due_date)), h('td', { class: 'num', 'data-label': 'Amount' }, fmtMoney(a.amount_minor, p.currency)),
        h('td', { 'data-label': 'Applied' }, fmtTimestamp(a.created_at)), h('td', { 'data-label': 'Status' }, a.reversed_at ? h('span', { class: 'badge badge--archived', title: a.reverse_reason }, 'Reversed') : h('span', { class: 'badge badge--active' }, 'Active')),
        h('td', { class: 'actions' }, ctx.can('finance:manage') && !a.reversed_at && !reversed && h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': `Reverse allocation to ${a.charge_description}`, onclick: () => reasonDialog({
          title: 'Reverse this allocation?', intro: 'The amount returns to the payment as unallocated credit, and the charge becomes outstanding again.', submitLabel: 'Reverse allocation',
          onSubmit: async (v) => { await post(`${ctx.base}/allocations/${a.id}/reverse`, v); toast('Allocation reversed.', 'success'); render(); } }) }, 'Reverse')))))))
      : emptyState({ icon: '🔗', title: 'Not applied to any charge', text: reversed ? 'This payment was reversed.' : 'Allocate it to charges, or leave it as credit toward future charges.' });
    clear(root).append(
      crumbs({ label: 'Finance', href: '#/finance/payments' }, { label: `Payment ${p.reference}` }),
      pageHeader(fmtMoney(p.amount_minor, p.currency), { subtitle: `Received ${fmtDate(p.received_on)} · ${p.reference}`,
        badges: [statusBadge(p.status, PAYMENT_STATUS), h('span', { class: 'badge', title: 'Entered manually; not verified against a bank or payment provider' }, 'Manual · unverified')], actions }),
      manualNotice(),
      h('div', { class: 'cols-2' },
        section('Payment', dl([['Tenancy', h('a', { href: `#/tenancies/${p.tenancy.id}` }, `${p.tenancy.property_name} · ${p.tenancy.unit_reference}`)], ['Tenant', p.tenancy.primary_tenant], ['Method', METHOD[p.method]],
          ['Reference', p.reference], ['Note', p.note], ['Recorded by', p.recorded_by], ['Recorded at', fmtTimestamp(p.created_at)], reversed ? ['Reversed', `${fmtTimestamp(p.reversed_at)} — ${p.reverse_reason}`] : null])),
        section('Balance of this payment', dl([['Amount', fmtMoney(p.amount_minor, p.currency)], ['Allocated', fmtMoney(p.allocated_minor, p.currency)], ['Unallocated credit', fmtMoney(p.unallocated_minor, p.currency)]]))),
      section('Allocations', allocs),
      p.history ? section('History', h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Payment history'),
        h('thead', {}, h('tr', {}, ['When', 'Action', 'By', 'Reason'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, p.history.map((x) => h('tr', {}, h('td', { 'data-label': 'When' }, fmtTimestamp(x.created_at)), h('td', { 'data-label': 'Action' }, AUDIT_ACTION[x.action] ?? x.action), h('td', { 'data-label': 'By' }, x.actor ?? '—'), h('td', { 'data-label': 'Reason' }, x.reason ?? '—'))))))) : '');
  }
  render();
  return root;
}

/* ------------------------------------------------------------------- receipt */
export function receiptView(ctx, id) {
  const root = h('div', {}, skeleton(4));
  (async () => {
    let r;
    try { r = await get(`${ctx.base}/receipts/${id}`); } catch (e) { return clear(root).append(errorState(e)); }
    const s = r.snapshot; const cur = s.payment.currency; const voided = !!r.voided_at;
    clear(root).append(
      crumbs({ label: 'Finance', href: '#/finance/payments' }, { label: 'Payment', href: `#/payments/${r.payment_id}` }, { label: `Receipt ${r.number}` }),
      h('div', { class: 'row no-print', 'aria-label': 'Receipt actions' }, h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print receipt'),
        h('a', { class: 'btn btn--secondary', href: `#/payments/${r.payment_id}` }, 'Back to payment')),
      h('article', { class: 'receipt-sheet', 'aria-label': `Receipt ${r.number}` },
        voided && h('div', { class: 'receipt-void', 'aria-hidden': 'true' }, 'VOID'),
        h('header', {}, h('p', { class: 'muted' }, s.organization), h('h1', {}, `Receipt ${r.number}`), h('p', { class: 'muted' }, `Issued ${fmtTimestamp(r.issued_at)}${r.issued_by ? ` by ${r.issued_by}` : ''}`)),
        voided && h('p', { role: 'alert' }, h('strong', {}, `This receipt is void: ${r.void_reason}.`)),
        h('h2', {}, 'Received from'), h('p', {}, s.received_from ?? '—'),
        h('h2', {}, 'Property'), h('p', {}, `${s.property.name}, unit ${s.property.unit}`, h('br'), h('span', { class: 'muted' }, s.property.address)),
        h('h2', {}, 'Payment'),
        h('table', {}, h('tbody', {}, [['Amount received', h('span', { class: 'receipt-total' }, fmtMoney(s.payment.amount_minor, cur))], ['Date received', fmtDate(s.payment.received_on)], ['Method', METHOD[s.payment.method]],
          ['Reference', s.payment.reference], s.payment.note ? ['Note', s.payment.note] : null].filter(Boolean).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v))))),
        h('h2', {}, 'Applied to'),
        s.applied_to.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Charge'), h('th', {}, 'Due'), h('th', { class: 'num' }, 'Amount'))),
          h('tbody', {}, s.applied_to.map((a) => h('tr', {}, h('td', {}, a.charge), h('td', {}, fmtDate(a.due_date)), h('td', { class: 'num' }, fmtMoney(a.amount_minor, cur))))))
          : h('p', { class: 'muted' }, 'Not yet applied to a specific charge.'),
        s.unallocated_minor > 0 && h('p', {}, `Held as credit at the time of issue: ${fmtMoney(s.unallocated_minor, cur)}.`),
        h('p', { class: 'receipt-notice' }, s.notice),
        h('p', { class: 'muted small' }, `Payment reference ${s.payment.id}`)));
  })();
  return root;
}

/* ------------------------------------------- tenancy "Rent & ledger" section */
export function ledgerSection(ctx, t, rerender) {
  const body = h('div', {}, skeleton(3));
  (async () => {
    let l;
    try { l = await get(`${ctx.base}/tenancies/${t.id}/ledger`); } catch (e) { return clear(body).append(errorState(e)); }
    const s = l.summary; const cur = l.currency; const active = l.schedules.find((x) => x.status === 'active');
    const canSchedule = ctx.can('finance:manage') && (t.status === 'draft' || t.status === 'active');
    clear(body).append(
      h('div', { class: 'summary-cards' }, [['Charged', s.charged_minor], ['Paid', s.allocated_minor], ['Outstanding', s.outstanding_minor, true], ['Overdue', s.overdue_minor, true], ['Credit', s.credit_minor]].map(([k, v, bad]) =>
        h('div', { class: 'card' }, h('div', { class: `stat__value ${bad && v > 0 ? 'money-neg' : ''}` }, fmtMoney(v, cur)), h('div', { class: 'stat__label' }, k)))),
      h('div', { class: 'row no-print' },
        ctx.can('payments:write') && t.status !== 'cancelled' && h('button', { class: 'btn', type: 'button', onclick: () => openRecordPayment(ctx, { tenancy: t.id }, rerender) }, 'Record payment'),
        ctx.can('finance:manage') && t.status !== 'cancelled' && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openChargeForm(ctx, { tenancy: t.id }, rerender) }, 'Add charge'),
        canSchedule && !active && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => openScheduleForm(ctx, t, rerender) }, 'Set up recurring rent'),
        canSchedule && active && h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => generateCharges(ctx, rerender, t.id) }, 'Generate due charges'),
        canSchedule && active && h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => reasonDialog({ title: 'Stop recurring rent?', intro: 'No further charges will be generated. Existing charges are kept. To change the rent, stop this schedule and create a new one starting after the last charged period.', submitLabel: 'Stop schedule',
          onSubmit: async (v) => { await post(`${ctx.base}/rent-schedules/${active.id}/stop`, v); toast('Rent schedule stopped.', 'success'); rerender(); } }) }, 'Stop schedule')),
      active ? h('p', { class: 'muted small' }, `Recurring rent: ${fmtMoney(active.amount_minor, cur)} ${LABELS.rentPeriod[active.period].toLowerCase()} from ${fmtDate(active.first_due_date)}${active.end_date ? ` to ${fmtDate(active.end_date)}` : ''}.`)
        : h('p', { class: 'muted small' }, 'No recurring rent schedule is active.'),
      l.charges.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Charges'),
        h('thead', {}, h('tr', {}, ['Due', 'Description', 'Amount', 'Paid', 'Outstanding', 'Status', ''].map((c) => h('th', { scope: 'col', class: ['Amount', 'Paid', 'Outstanding'].includes(c) ? 'num' : false }, c || h('span', { class: 'visually-hidden' }, 'Actions'))))),
        h('tbody', {}, l.charges.map((c) => h('tr', { class: c.voided_at ? 'row--archived' : false },
          h('td', { 'data-label': 'Due' }, fmtDate(c.due_date)), h('td', { 'data-label': 'Description' }, c.description), h('td', { class: 'num', 'data-label': 'Amount' }, fmtMoney(c.effective_minor, cur)),
          h('td', { class: 'num', 'data-label': 'Paid' }, fmtMoney(c.allocated_minor, cur)), h('td', { class: 'num', 'data-label': 'Outstanding' }, money(c.outstanding_minor, cur, { bad: c.is_overdue })),
          h('td', { 'data-label': 'Status' }, statusBadge(c.status, CHARGE_STATUS), c.is_overdue ? [' ', h('span', { class: 'badge badge--cancelled' }, 'Overdue')] : ''),
          h('td', { class: 'actions' }, chargeActions(ctx, c, rerender)))))))
        : emptyState({ icon: '🧾', title: 'No charges yet', text: active ? 'Charges appear as rent falls due. Use “Generate due charges” to create any that are missing.' : 'Set up recurring rent or add a one-off charge.' }),
      l.payments.length ? h('div', { class: 'table-wrap mt-5' }, h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Payments'),
        h('thead', {}, h('tr', {}, ['Received', 'Reference', 'Amount', 'Unallocated', 'Status'].map((c) => h('th', { scope: 'col', class: ['Amount', 'Unallocated'].includes(c) ? 'num' : false }, c)))),
        h('tbody', {}, l.payments.map((p) => h('tr', { class: p.reversed_at ? 'row--archived' : false },
          h('td', { 'data-label': 'Received' }, h('a', { href: `#/payments/${p.id}` }, fmtDate(p.received_on))), h('td', { 'data-label': 'Reference' }, p.reference),
          h('td', { class: 'num', 'data-label': 'Amount' }, fmtMoney(p.amount_minor, cur)), h('td', { class: 'num', 'data-label': 'Unallocated' }, p.unallocated_minor ? fmtMoney(p.unallocated_minor, cur) : '—'),
          h('td', { 'data-label': 'Status' }, statusBadge(p.status, PAYMENT_STATUS))))))) : '');
  })();
  return section('Rent & ledger', h('div', {}, manualNotice(), body));
}
