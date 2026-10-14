import { expect, test, type Browser, type Page } from '@playwright/test';

const password = 'correct horse battery';
const CRON = 'e2e-cron-secret-0123456789-0123456789';
const unique = () => `ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

const dialog = (p: Page) => p.getByRole('dialog');
const nav = (p: Page, name: string | RegExp) => p.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name });
const post = (p: Page, org: string, path: string, body: object, headers: Record<string, string> = {}) => p.evaluate(async ([o, pa, b, h]) => (await (await fetch(`/api/organizations/${o}${pa}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(h as object) }, body: JSON.stringify(b) })).json()), [org, path, body, headers] as const);

/** Owner signs up, creates an org, and a property/unit/tenant/active tenancy are seeded through the API. */
async function seed(page: Page, tenantEmail: string) {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique()); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Ops Co'); await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const org = new URL(page.url()).searchParams.get('org')!;
  const prop = await post(page, org, '/properties', { name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' });
  const unit = await post(page, org, `/properties/${prop.id}/units`, { reference: '1A' });
  const tenant = await post(page, org, '/tenants', { fullName: 'Tina Tenant', email: tenantEmail });
  const tn = await post(page, org, '/tenancies', { unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 });
  await post(page, org, `/tenancies/${tn.id}/activate`, { expectedVersion: tn.version });
  return { org, prop: prop.id as string, unit: unit.id as string, tenant: tenant.id as string, tenancy: tn.id as string };
}

async function join(browser: Browser, owner: Page, org: string, role: string): Promise<Page> {
  const email = unique();
  const invite = await owner.evaluate(async ({ org, email, role }) => (await (await fetch(`/api/organizations/${org}/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) })).json()).inviteUrl as string, { org, email, role });
  const p = await (await browser.newContext()).newPage();
  p.on('pageerror', (e) => problems.push(String(e)));
  await p.goto('/register');
  await p.getByLabel('Work email').fill(email); await p.getByLabel('Password').fill(password);
  await p.getByRole('button', { name: 'Create account' }).click();
  await expect(p).toHaveURL(/\/onboarding/);
  await p.goto(invite.replace(/^https?:\/\/[^/]+/, ''));
  await p.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(p).toHaveURL(/\/app\?org=/);
  return p;
}

test('a manager follows a request from staff, approves its cost in the inbox, and sees the outcome', async ({ browser, page }) => {
  const s = await seed(page, unique());
  const staff = await join(browser, page, s.org, 'staff');

  // staff reports and assigns, with an estimate that needs sign-off
  await staff.goto(`/app?org=${s.org}#/maintenance`);
  await expect(staff.getByRole('heading', { name: 'No maintenance requests' })).toBeVisible();
  await staff.getByRole('button', { name: 'New request' }).first().click();
  await dialog(staff).getByLabel(/^Location/).selectOption({ label: 'Maple Court · unit 1A' });
  await dialog(staff).getByLabel(/^Title/).fill('Kitchen tap dripping');
  await dialog(staff).getByLabel(/^What is wrong/).fill('The cold tap drips all day.');
  await dialog(staff).getByRole('button', { name: 'Submit request' }).click();
  await expect(staff.getByRole('heading', { name: 'Kitchen tap dripping', level: 1 })).toBeVisible();
  await staff.getByRole('button', { name: 'Assign work' }).click();
  await dialog(staff).getByLabel('Staff member').selectOption({ index: 1 });                 // themselves (the only option for staff)
  await dialog(staff).getByLabel(/^What needs doing/).fill('Replace the washer');
  await dialog(staff).getByLabel(/^Estimate \(/).fill('85.00');
  await dialog(staff).getByRole('button', { name: 'Assign' }).click();
  await expect(staff.getByText('Awaiting approval').first()).toBeVisible();
  // validation: a bad estimate is refused with a clear message (exact decimals; no silent rounding)

  // the manager (the owner here) is told, and finds it in the persistent inbox
  await page.goto(`/app?org=${s.org}#/overview`);
  await expect(nav(page, /Approvals \(1\)/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Notifications/ })).toHaveAttribute('aria-label', /unread/);
  await nav(page, /Approvals/).click();
  await expect(page.getByRole('link', { name: 'Approve maintenance cost' })).toBeVisible();
  await expect(page.getByText('Authorize $85.00')).toBeVisible();
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Approve maintenance cost', level: 1 })).toBeVisible();
  await expect(page.locator('pre.payload')).toContainText('"amount_minor": 8500');
  await expect(page.locator('#main')).not.toContainText('nullnull');                       // regression: optional notices must not render the word "null"
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog(page)).toContainText('Exactly this will happen');
  await dialog(page).getByRole('button', { name: 'Approve and run' }).click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('"approved_cost_minor":8500')).toBeVisible();
  await expect(nav(page, /^Approvals$/)).toBeVisible();                                      // inbox count cleared

  // it persisted: the request now shows the approved cost and moved on
  await page.goto(`/app?org=${s.org}#/maintenance`);
  await page.getByRole('link', { name: 'Kitchen tap dripping' }).click();
  await expect(page.getByText('Assigned', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '$85.00' }).first()).toBeVisible();

  // the staff member sees the approval outcome in their own notifications
  await staff.goto(`/app?org=${s.org}#/notifications`);
  await expect(staff.getByText(/Approved and done/)).toBeVisible();

  // delivery: queued emails go out when the scheduler runs, and managers can see it
  const run = await page.request.get('/api/internal/jobs/run', { headers: { authorization: `Bearer ${CRON}` } });
  expect(run.ok()).toBe(true);
  expect((await run.json()).email.sent).toBeGreaterThan(0);
  await page.goto(`/app?org=${s.org}#/operations/delivery`);
  await expect(page.getByRole('heading', { name: 'Emails', level: 2 })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Approval needed/ }).first()).toBeVisible();
  expect((await page.request.get('/api/internal/jobs/run')).status()).toBe(401);
});

test('a critical report is escalated at once, stays flagged, and a manager must acknowledge it', async ({ browser, page }) => {
  const s = await seed(page, unique());
  const staff = await join(browser, page, s.org, 'staff');
  await staff.goto(`/app?org=${s.org}#/maintenance`);
  await staff.getByRole('button', { name: 'New request' }).first().click();
  await dialog(staff).getByLabel(/^Location/).selectOption({ label: 'Maple Court · unit 1A' });
  await dialog(staff).getByLabel(/^Title/).fill('Smell of gas in kitchen');
  await dialog(staff).getByLabel(/^What is wrong/).fill('A gas leak smell near the cooker.');
  await dialog(staff).getByLabel(/^Urgency/).selectOption({ label: 'Low' });                // picked LOW, but a safety keyword is in the text
  await dialog(staff).getByRole('button', { name: 'Submit request' }).click();
  await expect(staff.getByText('Critical issue: a human must acknowledge this.')).toBeVisible();
  await expect(staff.getByText(/safety keyword was detected/)).toBeVisible();

  await page.goto(`/app?org=${s.org}#/maintenance`);
  await expect(page.getByRole('alert').filter({ hasText: '1 critical issue needs acknowledgement' })).toBeVisible();
  await expect(page.getByText('Unacknowledged')).toBeVisible();
  await page.getByRole('link', { name: 'Smell of gas in kitchen' }).click();
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText(/Critical issue acknowledged by/)).toBeVisible();
  await page.goto(`/app?org=${s.org}#/maintenance`);
  await expect(page.getByRole('alert').filter({ hasText: 'critical issue' })).toHaveCount(0);
  await expect(page.getByText('Smell of gas in kitchen')).toBeVisible();                     // still on record, still flagged critical
});

test('a tenant is invited, verified, reports a problem for their own home, and follows it', async ({ browser, page }) => {
  const tenantEmail = unique();
  const s = await seed(page, tenantEmail);
  const staff = await join(browser, page, s.org, 'staff');

  // manager invites the tenant from their profile
  await page.goto(`/app?org=${s.org}#/tenants/${s.tenant}`);
  await expect(page.getByRole('heading', { name: 'Portal & reminders' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite to portal' }).click();
  const link = await dialog(page).getByLabel('Invitation link').inputValue();
  expect(link).toContain('/portal-invite#token=');
  await dialog(page).getByRole('button', { name: 'Close' }).click();

  // the tenant opens the link, registers with that email, and lands in the portal (not onboarding)
  const tenant = await (await browser.newContext()).newPage();
  tenant.on('pageerror', (e) => problems.push(String(e)));
  await tenant.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(tenant.getByRole('link', { name: 'Create account' })).toBeVisible();
  await tenant.getByRole('link', { name: 'Create account' }).click();
  await tenant.getByLabel('Work email').fill(tenantEmail); await tenant.getByLabel('Password').fill(password);
  await tenant.getByRole('button', { name: 'Create account' }).click();
  await expect(tenant.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  await tenant.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(tenant).toHaveURL(/\/portal$/);
  await expect(tenant.getByRole('heading', { name: 'Your requests' })).toBeVisible();
  await expect(tenant.getByText('In an emergency')).toBeVisible();

  // report a problem
  await tenant.getByRole('button', { name: 'Report a problem' }).first().click();
  await dialog(tenant).getByLabel(/^What is the problem/).fill('Bedroom window will not close');
  await dialog(tenant).getByLabel(/^Details/).fill('The latch is broken and the window stays open.');
  await dialog(tenant).getByRole('button', { name: 'Send report' }).click();
  await expect(tenant.getByRole('heading', { name: 'Bedroom window will not close' })).toBeVisible();
  await expect(tenant.getByText('Received').first()).toBeVisible();

  // staff see it as a tenant report and reply with a tenant-visible message
  await staff.goto(`/app?org=${s.org}#/maintenance`);
  await expect(staff.getByText('Tenant', { exact: true })).toBeVisible();
  await staff.getByRole('link', { name: 'Bedroom window will not close' }).click();
  await staff.getByLabel('Add a note').fill('We will visit tomorrow morning.');
  await staff.getByLabel('Who can see this note').selectOption('tenant');
  await staff.getByRole('button', { name: 'Add note' }).click();
  await staff.getByLabel('Add a note').fill('Internal: tenant has been difficult before.');
  await staff.getByRole('button', { name: 'Add note' }).click();

  await tenant.reload();
  await expect(tenant.getByText('We will visit tomorrow morning.')).toBeVisible();
  await expect(tenant.getByText('tenant has been difficult')).toHaveCount(0);               // internal notes never reach the tenant
  await tenant.getByLabel('Send a message about this request').fill('Thanks, I will be in.');
  await tenant.getByRole('button', { name: 'Send message' }).click();
  await expect(tenant.getByText('Thanks, I will be in.')).toBeVisible();

  // the tenant cannot reach the staff app or its data
  await tenant.goto(`/app?org=${s.org}#/maintenance`);
  await expect(tenant.getByRole('heading', { name: 'Maintenance', level: 1 })).toHaveCount(0);
  const status = await tenant.evaluate(async (org) => (await fetch(`/api/organizations/${org}/maintenance`)).status, s.org);
  expect(status).toBe(404);

  // once work is arranged the tenant can no longer cancel
  await staff.getByRole('button', { name: 'Assign work' }).click();
  await dialog(staff).getByLabel('Staff member').selectOption({ index: 1 });
  await dialog(staff).getByLabel(/^What needs doing/).fill('Fix the latch');
  await dialog(staff).getByRole('button', { name: 'Assign' }).click();
  await tenant.goto('/portal');
  await tenant.getByRole('link', { name: 'Bedroom window will not close' }).click();
  await expect(tenant.getByText('Scheduled').first()).toBeVisible();
  await expect(tenant.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
});
