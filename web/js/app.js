import { del, get, patch, post, requireSession, signOut } from './api.js';
import { clear, confirmDialog, copyText, emptyState, h, handleForm, openDialog, skeleton, toast } from './ui.js';
import { approvalsView, notificationsView, operationsView } from './views/approvals.js';
import { copilotView } from './views/copilot.js';
import { financeView, paymentView, receiptView } from './views/finance.js';
import { leaseView } from './views/leases.js';
import { maintenanceDetailView, maintenanceListView, vendorsView } from './views/maintenance.js';
import { propertiesView, propertyView } from './views/properties.js';
import { tenanciesView, tenancyView } from './views/tenancies.js';
import { tenantView, tenantsView } from './views/tenants.js';
import { unitView, unitsView } from './views/units.js';

const ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const orgSelect = document.getElementById('org-select');

const me = await requireSession();
if (!me.memberships.length) location.replace('/onboarding');

const params = new URLSearchParams(location.search);
let orgId = me.memberships.some((m) => m.org_id === params.get('org')) ? params.get('org') : me.memberships[0].org_id;
history.replaceState(null, '', `/app?org=${orgId}${location.hash}`);
let ws; // workspace summary: { organization, role, permissions, memberCount }

document.getElementById('user-name').textContent = me.profile.full_name || me.profile.email;
document.getElementById('signout').addEventListener('click', signOut);
for (const m of me.memberships) orgSelect.append(h('option', { value: m.org_id, selected: m.org_id === orgId }, m.name));
orgSelect.addEventListener('change', () => { orgId = orgSelect.value; history.replaceState(null, '', `/app?org=${orgId}${location.hash}`); load(); });
window.addEventListener('hashchange', render);

const can = (p) => ws.permissions.includes(p);
const base = () => `/organizations/${orgId}`;
const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

// Shared with the record views.
const ctx = { me, get orgId() { return orgId; }, get base() { return base(); }, get role() { return ws.role; }, can: (p) => can(p) };
let pendingApprovals = 0;

const routes = {
  overview: { label: 'Overview', view: () => overview() },
  properties: { label: 'Properties', view: (id) => (id ? propertyView(ctx, id) : propertiesView(ctx)) },
  units: { label: 'Units', view: (id) => (id ? unitView(ctx, id) : unitsView(ctx)) },
  tenants: { label: 'Tenants', view: (id) => (id ? tenantView(ctx, id) : tenantsView(ctx)) },
  tenancies: { label: 'Tenancies', view: (id) => (id ? tenancyView(ctx, id) : tenanciesView(ctx)) },
  leases: { view: (id) => (id ? leaseView(ctx, id) : tenanciesView(ctx)), highlight: 'tenancies' },
  finance: { label: 'Finance', view: (id) => financeView(ctx, id), needs: 'finance:read' },
  payments: { view: (id) => (id ? paymentView(ctx, id) : financeView(ctx, 'payments')), highlight: 'finance', needs: 'finance:read' },
  receipts: { view: (id) => receiptView(ctx, id), highlight: 'finance', needs: 'finance:read' },
  copilot: { label: 'Copilot', view: (id) => copilotView(ctx, id), needs: 'copilot:use' },
  maintenance: { label: 'Maintenance', view: (id) => (id ? maintenanceDetailView(ctx, id) : maintenanceListView(ctx)), needs: 'maintenance:read' },
  approvals: { label: () => (pendingApprovals ? `Approvals (${pendingApprovals})` : 'Approvals'), view: (id) => approvalsView(ctx, id), needs: 'approvals:request' },
  vendors: { label: 'Vendors', view: () => vendorsView(ctx), needs: 'maintenance:read' },
  operations: { label: 'Operations', view: (id) => operationsView(ctx, id), needs: 'delivery:manage' },
  notifications: { view: () => notificationsView(), highlight: 'overview' },
  members: { label: 'Members', view: () => members() },
  invitations: { label: 'Invitations', view: () => invitations(), needs: 'invitations:manage' },
  settings: { label: 'Settings', view: () => settings() },
};
const current = () => {
  const [key, id] = (location.hash.replace('#/', '').split('?')[0] || 'overview').split('/');
  const r = routes[key];
  return r && (!r.needs || can(r.needs)) ? { key, id } : { key: 'overview' };
};

async function load() {
  clear(main).append(skeleton(4));
  try { ws = await get(`${base()}/workspace`); }
  catch (e) { return fail(e); }
  pendingApprovals = 0;
  if (can('approvals:decide')) pendingApprovals = await get(`${base()}/approvals?scope=inbox&limit=1`).then((r) => r.pending_for_me).catch(() => 0);
  render();
  refreshBell();
}

/* Notification bell: unread count, refreshed periodically and after navigation. */
const bell = document.getElementById('bell-count');
async function refreshBell() {
  try {
    const d = await get('/me/notifications?unreadOnly=true&limit=1');
    bell.textContent = d.unread > 99 ? '99+' : String(d.unread);
    bell.hidden = d.unread === 0;
    document.getElementById('bell').setAttribute('aria-label', d.unread ? `Notifications, ${d.unread} unread` : 'Notifications');
    if (can('approvals:decide')) { const n = await get(`${base()}/approvals?scope=inbox&limit=1`).then((r) => r.pending_for_me); if (n !== pendingApprovals) { pendingApprovals = n; render(); } }
  } catch { /* the bell is a convenience; failures stay quiet */ }
}
setInterval(() => { if (!document.hidden) refreshBell(); }, 60_000);
window.addEventListener('hashchange', () => setTimeout(refreshBell, 300));

function fail(e) {
  clear(main).append(emptyState({
    icon: '⚠️', title: e.status === 404 ? 'Workspace not found' : 'Could not load this page',
    text: e.message, action: h('button', { class: 'btn', onclick: load }, 'Try again'),
  }));
}

let renderSeq = 0;
async function render() {
  if (!ws) return;
  const mine = ++renderSeq; // a slower, older render must never overwrite a newer page
  const { key, id } = current();
  const active = routes[key].highlight ?? key;
  clear(nav).append(...Object.entries(routes)
    .filter(([, r]) => r.label && (!r.needs || can(r.needs)))
    .map(([k, r]) => h('a', { href: `#/${k}`, 'aria-current': k === active ? 'page' : false }, typeof r.label === 'function' ? r.label() : r.label)));
  clear(main).append(skeleton(4));
  try {
    const node = await routes[key].view(id);
    if (mine !== renderSeq) return;
    clear(main).append(node); main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  } catch (e) { if (mine === renderSeq) fail(e); }
}

const header = (title, ...actions) => h('div', { class: 'page-header' }, h('h1', {}, title), h('div', { class: 'row' }, ...actions));
const roleBadge = (r) => h('span', { class: `badge ${r === 'owner' ? 'badge--owner' : ''}` }, r);

/* ------------------------------------------------------------------ views */
async function overview() {
  const count = (path) => get(`${base()}${path}${path.includes('?') ? '&' : '?'}limit=1`).then((r) => r.total);
  const [properties, units, tenants, active, vacant] = await Promise.all([count('/properties'), count('/units'), count('/tenants'),
    count('/tenancies?status=active'), count('/units?occupancy=vacant')]);
  const stat = (value, label, href) => h('a', { class: 'card stat', href }, h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__label' }, label));
  return h('div', {},
    header(ws.organization.name, roleBadge(ws.role)),
    h('div', { class: 'grid grid--stats' }, stat(properties, 'Properties', '#/properties'), stat(units, 'Units', '#/units'), stat(vacant, 'Vacant units', '#/units?occupancy=vacant'),
      stat(tenants, 'Tenants', '#/tenants'), stat(active, 'Active tenancies', '#/tenancies?status=active'), stat(ws.memberCount, ws.memberCount === 1 ? 'Team member' : 'Team members', '#/members')),
    !properties && h('div', { class: 'mt-5' }, emptyState({ icon: '🏢', title: 'Start with your first property',
      text: can('properties:write') ? 'Add a property, then its units, then onboard tenants and record their tenancies.' : 'A manager needs to add the first property.',
      action: can('properties:write') ? h('a', { class: 'btn', href: '#/properties' }, 'Add a property') : null })));
}

async function members() {
  const list = await get(`${base()}/members`);
  const canManage = can('members:manage');
  const rows = list.map((m) => {
    const isSelf = m.user_id === me.profile.id;
    const roleCell = canManage && !(m.role === 'owner' && ws.role !== 'owner')
      ? h('select', {
          class: 'select select--inline', 'aria-label': `Role for ${m.full_name || m.email}`,
          onchange: async (e) => {
            try { await patch(`${base()}/members/${m.user_id}`, { role: e.target.value }); toast('Role updated.', 'success'); render(); }
            catch (err) { toast(err.message, 'error'); render(); }
          },
        }, ROLES.filter((r) => r !== 'owner' || ws.role === 'owner').map((r) => h('option', { value: r, selected: r === m.role }, r)))
      : roleBadge(m.role);
    const canRemove = isSelf || (canManage && !(m.role === 'owner' && ws.role !== 'owner'));
    return h('tr', {},
      h('td', {}, h('strong', {}, m.full_name || '—'), isSelf && h('span', { class: 'muted' }, ' (you)')),
      h('td', {}, m.email), h('td', {}, roleCell), h('td', {}, fmtDate(m.joined_at)),
      h('td', { class: 'actions' }, canRemove && h('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: isSelf ? 'Leave this organization?' : 'Remove member?', danger: true,
            message: isSelf ? `You will lose access to ${ws.organization.name}.` : `${m.full_name || m.email} will lose access to ${ws.organization.name}.`,
            confirmLabel: isSelf ? 'Leave' : 'Remove',
          });
          if (!ok) return;
          try {
            await del(`${base()}/members/${m.user_id}`);
            if (isSelf) return location.assign('/app');
            toast('Member removed.', 'success'); await load();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, isSelf ? 'Leave' : 'Remove')));
  });
  return h('div', {}, header('Members', can('invitations:manage') && h('a', { class: 'btn', href: '#/invitations' }, 'Invite people')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('caption', { class: 'visually-hidden' }, 'Organization members'),
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Joined', ''].map((t) => h('th', { scope: 'col' }, t || h('span', { class: 'visually-hidden' }, 'Actions'))))),
      h('tbody', {}, rows))));
}

async function invitations() {
  const list = await get(`${base()}/invitations`);
  const form = h('form', { class: 'card', novalidate: true, 'aria-label': 'Invite a team member' },
    h('div', { class: 'alert alert--error', role: 'alert', tabindex: '-1', 'data-form-error': true, hidden: true }),
    h('div', { class: 'row row--end' },
      h('div', { class: 'field field--grow' }, h('label', { for: 'inv-email' }, 'Email address'),
        h('input', { class: 'input', id: 'inv-email', name: 'email', type: 'email', required: true, autocomplete: 'off' })),
      h('div', { class: 'field field--role' }, h('label', { for: 'inv-role' }, 'Role'),
        h('select', { class: 'select', id: 'inv-role', name: 'role' }, ROLES.filter((r) => r !== 'owner').map((r) => h('option', { value: r, selected: r === 'staff' }, r)))),
      h('button', { class: 'btn', type: 'submit' }, 'Create invitation')));
  handleForm(form, async (v) => {
    const r = await post(`${base()}/invitations`, { email: v.email, role: v.role });
    showInviteLink(r.inviteUrl, v.email);
    render();
  });
  const table = list.length
    ? h('div', { class: 'table-wrap mt-5' }, h('table', { class: 'table' },
        h('caption', { class: 'visually-hidden' }, 'Pending invitations'),
        h('thead', {}, h('tr', {}, ['Email', 'Role', 'Expires', ''].map((t) => h('th', { scope: 'col' }, t || h('span', { class: 'visually-hidden' }, 'Actions'))))),
        h('tbody', {}, list.map((i) => h('tr', {}, h('td', {}, i.email), h('td', {}, roleBadge(i.role)), h('td', {}, fmtDate(i.expires_at)),
          h('td', { class: 'actions' }, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => {
            try { await del(`${base()}/invitations/${i.id}`); toast('Invitation revoked.', 'success'); render(); } catch (err) { toast(err.message, 'error'); }
          } }, 'Revoke')))))))
    : h('div', { class: 'mt-5' }, emptyState({ icon: '✉️', title: 'No pending invitations', text: 'Invite a teammate by email. They join with the role you choose.' }));
  return h('div', {}, header('Invitations'), form, table);
}

function showInviteLink(url, email) {
  const input = h('input', { class: 'input', readonly: true, value: url, 'aria-label': 'Invitation link', onfocus: (e) => e.target.select() });
  openDialog({
    title: 'Invitation created',
    body: h('div', {},
      h('p', {}, `Email delivery is not set up yet. Send this single-use link to ${email} yourself. It expires in 7 days.`),
      h('div', { class: 'copy-box' }, input, h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => copyText(url) }, 'Copy'))),
  });
}

async function settings() {
  const orgForm = h('form', { class: 'card', novalidate: true },
    h('h2', {}, 'Organization'),
    h('div', { class: 'alert alert--error', role: 'alert', tabindex: '-1', 'data-form-error': true, hidden: true }),
    h('div', { class: 'field' }, h('label', { for: 'org-name' }, 'Name'),
      h('input', { class: 'input', id: 'org-name', name: 'name', required: true, minlength: '2', maxlength: '120', value: ws.organization.name, disabled: !can('org:update') })),
    can('org:update') ? h('button', { class: 'btn', type: 'submit' }, 'Save changes') : h('p', { class: 'muted small' }, 'Only admins and owners can rename the organization.'));
  handleForm(orgForm, async (v) => {
    await patch(base(), { name: v.name });
    toast('Organization updated.', 'success');
    const opt = [...orgSelect.options].find((o) => o.value === orgId); if (opt) opt.textContent = v.name;
    await load();
  });
  const profileForm = h('form', { class: 'card', novalidate: true },
    h('h2', {}, 'Your profile'),
    h('div', { class: 'alert alert--error', role: 'alert', tabindex: '-1', 'data-form-error': true, hidden: true }),
    h('div', { class: 'field' }, h('label', { for: 'full-name' }, 'Full name'),
      h('input', { class: 'input', id: 'full-name', name: 'fullName', maxlength: '120', value: me.profile.full_name, autocomplete: 'name' })),
    h('div', { class: 'field' }, h('label', { for: 'my-email' }, 'Email'),
      h('input', { class: 'input', id: 'my-email', value: me.profile.email, disabled: true })),
    h('button', { class: 'btn', type: 'submit' }, 'Save profile'));
  handleForm(profileForm, async (v) => {
    const p = await patch('/me', { fullName: v.fullName });
    me.profile.full_name = p.full_name;
    document.getElementById('user-name').textContent = p.full_name || p.email;
    toast('Profile updated.', 'success');
  });
  return h('div', { class: 'stack' }, header('Settings'), orgForm, profileForm);
}

load();
