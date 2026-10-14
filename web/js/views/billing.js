import { api, get, post } from '../api.js';
import { clear, h, skeleton, toast } from '../ui.js';
import { errorState, fmtMoney, fmtTimestamp, formDialog, pageHeader, section } from '../kit.js';

const rerender = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const STATUS = { trialing: 'Free trial', active: 'Active', past_due: 'Payment overdue', cancelled: 'Cancelled', expired: 'Expired' };
const num = (n) => (n == null ? 'Unlimited' : Number(n).toLocaleString());

export function billingView(ctx, tab = 'plan') {
  const tabs = [['plan', 'Plan and usage'], ['market', 'Country and currency']];
  const t = tabs.some(([k]) => k === tab) ? tab : 'plan';
  const body = h('div', {}, skeleton(3));
  (async () => { try { clear(body).append(await ({ plan: planTab, market: marketTab }[t])(ctx)); } catch (e) { clear(body).append(errorState(e, rerender)); } })();
  return h('div', {}, pageHeader('Plan and settings', { subtitle: 'What your plan includes, how much you have used, and how this organization is set up for its country.' }),
    h('nav', { class: 'tabs', 'aria-label': 'Billing sections' }, tabs.map(([k, l]) => h('a', { href: `#/billing/${k}`, 'aria-current': k === t ? 'page' : false }, l))), body);
}

async function planTab(ctx) {
  const b = await get(`${ctx.base}/billing`);
  const currencies = [...new Set(b.plans.flatMap((p) => p.prices.map((x) => x.currency)))];
  let currency = currencies.includes(ctx.market?.currency) ? ctx.market.currency : currencies[0];
  let interval = 'monthly';
  const plansBox = h('div', { class: 'plan-grid' });
  const drawPlans = () => clear(plansBox).append(...b.plans.map((p) => {
    const price = p.prices.find((x) => x.currency === currency && x.interval === interval);
    const current = b.subscribed_plan === p.code;
    return h('div', { class: `card plan-card ${current ? 'plan-card--current' : ''}` },
      h('h3', {}, p.name, current ? h('span', { class: 'badge badge--active' }, 'Current') : null), h('p', { class: 'muted small' }, p.description),
      h('div', { class: 'plan-price' }, price ? [fmtMoney(price.amount_minor, currency), h('span', { class: 'muted small' }, ` / ${interval === 'annual' ? 'year' : 'month'}`)] : h('span', { class: 'muted' }, `Not offered in ${currency} ${interval}`)),
      h('ul', { class: 'plan-list' }, p.entitlements.map((e) => h('li', {}, e.kind === 'feature' ? `${e.enabled ? '✓' : '✗'} ${e.label}` : `${e.enabled ? num(e.limit) : 'No'} ${e.label.toLowerCase()}${e.unit && e.enabled ? ` (${e.unit})` : ''}`))),
      h('button', { class: 'btn', type: 'button', disabled: !price || current, onclick: () => choose(p, price) }, current ? 'Your plan' : 'Choose plan'));
  }));
  const choose = async (p) => {
    try {
      const r = await post(`${ctx.base}/billing/checkout`, { planCode: p.code, interval, currency });
      if (/^https:\/\//.test(r.url)) location.assign(r.url);
    } catch (e) { toast(e.message, 'error', 9000); }
  };
  const sel = (label, value, opts, on) => h('label', { class: 'inline-field' }, label, ' ', h('select', { class: 'select select--inline', onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
  drawPlans();
  const meter = (e) => {
    const pct = e.limit ? Math.min(100, Math.round((e.used / e.limit) * 100)) : 0;
    return h('tr', {}, h('th', { scope: 'row' }, e.label), h('td', {}, e.kind === 'feature' ? (e.enabled ? 'Included' : 'Not included')
      : [`${num(e.used)} of ${e.enabled ? num(e.limit) : 'none'}${e.unit ? ' ' + e.unit : ''}`, e.limit ? h('meter', { class: 'meter', min: 0, max: e.limit, low: Math.round(e.limit * 0.8), high: Math.round(e.limit * 0.9), optimum: 0, value: Math.min(e.used, e.limit), 'aria-label': `${e.label}: ${pct}% used` }) : null]),
      h('td', { class: 'muted small' }, e.source === 'override' ? 'Special arrangement' : ''));
  };
  const s = b.subscription;
  return h('div', {},
    !b.provider.configured ? h('div', { class: 'notice' }, h('span', { 'aria-hidden': 'true' }, 'ℹ️'), h('span', {}, h('strong', {}, 'Online payment is not switched on yet. '), 'To change or pay for a plan, contact us; we will update it for you. Everything below is enforced already.')) : null,
    b.lapsed ? h('div', { class: 'notice notice--critical', role: 'alert' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, `Your ${b.subscribed_plan} plan is not active, so the ${b.plan.name} limits apply. Nothing is deleted; you just cannot add more than the limits.`)) : null,
    section('Your subscription', h('dl', { class: 'dl' }, ...[['Plan', b.plan.name], ['Status', STATUS[b.status] ?? b.status], ['Trial ends', b.trial_ends_at ? fmtTimestamp(b.trial_ends_at) : null],
      ['Paid until', s.current_period_end ? fmtTimestamp(s.current_period_end) : null], ['Payment grace until', b.grace_until ? fmtTimestamp(b.grace_until) : null], ['Renews', b.cancel_at_period_end ? 'No: set to end' : s.provider === 'paystack' ? 'Automatically' : null],
      ['Billing', s.provider === 'manual' ? 'Managed by our team' : s.provider]].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      s.has_provider_subscription ? h('div', { class: 'row' }, h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: async () => { try { await post(`${ctx.base}/billing/reconcile`, {}); toast('Checked with the payment provider.', 'success'); rerender(); } catch (e) { toast(e.message, 'error'); } } }, 'Check payment status')) : null),
    section('Usage', h('table', { class: 'table' }, h('caption', { class: 'visually-hidden' }, 'Plan usage'), h('tbody', {}, b.entitlements.map(meter)))),
    section('Plans', h('div', {}, h('div', { class: 'row' }, sel('Currency', currency, currencies.map((c) => [c, c]), (v) => { currency = v; drawPlans(); }), sel('Billed', interval, [['monthly', 'Monthly'], ['annual', 'Yearly']], (v) => { interval = v; drawPlans(); })),
      h('p', { class: 'muted small' }, 'Your plan changes only after the payment provider confirms the payment, never because you returned from a checkout page.'), plansBox)),
    section('History', b.events.length ? h('ol', { class: 'timeline' }, b.events.map((e) => h('li', {}, h('strong', {}, e.type.replace(/_/g, ' ')), h('div', { class: 'small muted' }, `${fmtTimestamp(e.at)}${e.plan ? ' · ' + e.plan : ''}${e.to ? ' · ' + e.to : ''}`)))) : h('p', { class: 'muted' }, 'Nothing yet.')));
}

async function marketTab(ctx) {
  const m = await get(`${ctx.base}/market`);
  const cty = m.countries.find((c) => c.iso2 === m.country);
  const provs = new Set(m.payment_providers);
  const edit = () => formDialog({ title: 'Country and currency', intro: 'These are defaults for new properties, formatting, reminders and the AI copilot. Existing records keep their own currency and time zone.', submitLabel: 'Save',
    initial: { country: m.country, currency: m.currency, timezone: m.timezone, locale: m.locale, dateFormat: m.date_format, qs: m.comms?.quiet_hours?.start, qe: m.comms?.quiet_hours?.end, channels: (m.comms?.preferred_channels ?? []).join(', ') },
    fields: [
      { name: 'country', label: 'Country', type: 'select', options: m.countries.map((c) => [c.iso2, c.name]), required: true },
      { name: 'currency', label: 'Currency', type: 'select', options: m.currencies.map((c) => [c.code, `${c.code} · ${c.name}`]) },
      { name: 'timezone', label: 'Time zone (IANA)', hint: 'For example Africa/Accra, Africa/Lagos, Africa/Nairobi.' }, { name: 'locale', label: 'Language and number format', hint: 'For example en-GH.' },
      { name: 'dateFormat', label: 'Date format', type: 'select', options: [['DD/MM/YYYY', 'DD/MM/YYYY'], ['MM/DD/YYYY', 'MM/DD/YYYY'], ['YYYY-MM-DD', 'YYYY-MM-DD']] },
      { name: 'channels', label: 'Preferred channels (comma separated)', hint: 'whatsapp, sms, email' },
      { name: 'qs', label: 'Quiet hours start (HH:MM)', hint: 'Proactive reminders wait until quiet hours end. Replies are never delayed.' }, { name: 'qe', label: 'Quiet hours end (HH:MM)' },
      ...m.payment_provider_options.map((p) => ({ name: `prov_${p.code}`, label: `${p.name}${p.status === 'planned' ? ' (not integrated)' : ''}`, type: 'checkbox', default: provs.has(p.code) }))],
    onSubmit: async (v) => {
      const channels = (v.channels ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      await api('PUT', `${ctx.base}/market`, { country: v.country, currency: v.currency, timezone: v.timezone, locale: v.locale, dateFormat: v.dateFormat,
        paymentProviders: m.payment_provider_options.filter((p) => v[`prov_${p.code}`]).map((p) => p.code),
        comms: { ...(channels.length ? { preferred_channels: channels } : {}), ...(v.qs && v.qe ? { quiet_hours: { start: v.qs, end: v.qe } } : {}) }, rulePacks: m.rule_packs });
      toast('Saved.', 'success'); window.location.reload();
    } });
  return h('div', {}, section('Regional settings', h('div', {}, h('dl', { class: 'dl' }, ...[['Country', cty?.name ?? 'Not set'], ['Currency', m.currency], ['Time zone', m.timezone], ['Language and number format', m.locale], ['Date format', m.date_format], ['Phone numbers read as', m.calling_code ? `+${m.calling_code}` : 'must include the country code'],
      ['Quiet hours', m.comms?.quiet_hours ? `${m.comms.quiet_hours.start}–${m.comms.quiet_hours.end}` : 'None'], ['Payment methods', m.payment_providers.join(', ') || 'None chosen']].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')])),
    h('button', { class: 'btn', type: 'button', onclick: edit }, 'Edit'))),
    section('Country-specific legal and tenancy rules', h('p', { class: 'muted' }, m.rule_pack_options.length ? `Reviewed rule packs available for your country: ${m.rule_pack_options.map((p) => p.title).join(', ')}.` : 'None. No legal or tenancy rules are built in for any country. They can only be added as packs that a qualified person has reviewed, and none exist yet. Check local requirements with a qualified adviser.')));
}
