import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery';
const unique = () => `fin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

/** Register, create an org, and seed an active USD tenancy through the API. */
async function seed(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique());
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Ledger Co');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const org = new URL(page.url()).searchParams.get('org')!;
  const ids = await page.evaluate(async (org) => {
    const post = async (path: string, body: object) => (await fetch(`/api/organizations/${org}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const prop = await post('/properties', { name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' });
    const unit = await post(`/properties/${prop.id}/units`, { reference: '1A' });
    const tenant = await post('/tenants', { fullName: 'Tina Tenant' });
    const t = await post('/tenancies', { unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000, rentDueDay: 1 });
    await post(`/tenancies/${t.id}/activate`, { expectedVersion: t.version });
    return { tenancy: t.id as string, prop: prop.id as string };
  }, org);
  return { org, ...ids };
}
const dialog = (page: Page) => page.getByRole('dialog');
const api = (page: Page, org: string, path: string) => page.evaluate(async ([o, p]) => (await fetch(`/api/organizations/${o}${p}`)).json(), [org, path] as const);

test('schedule rent, generate charges, record a payment once, allocate it, issue a receipt, reverse it, and reconcile', async ({ page }) => {
  const { org, tenancy } = await seed(page);
  await page.goto(`/app?org=${org}#/tenancies/${tenancy}`);
  await expect(page.getByRole('heading', { name: 'Rent & ledger' })).toBeVisible();
  await expect(page.getByText('not verified against a bank or payment provider').first()).toBeVisible();

  // Recurring rent
  await page.getByRole('button', { name: 'Set up recurring rent' }).click();
  await dialog(page).getByLabel(/^Rent per period/).fill('1500.00');
  await dialog(page).getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByText(/Recurring rent: \$1,500\.00 monthly from/)).toBeVisible();

  // Generating is idempotent: a second run creates nothing
  await page.getByRole('button', { name: 'Generate due charges' }).click();
  await dialog(page).getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText(/\d+ charges? created\./)).toBeVisible();
  const first = (await api(page, org, `/tenancies/${tenancy}/ledger`)).charges.length;
  expect(first).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Generate due charges' }).click();
  await dialog(page).getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText('Already up to date.')).toBeVisible();
  expect((await api(page, org, `/tenancies/${tenancy}/ledger`)).charges.length).toBe(first);

  // Amounts are exact: extra precision is refused, never rounded
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  await dialog(page).getByLabel(/^Amount received/).fill('10.005');
  await dialog(page).getByLabel('Reference').fill('WIRE-E2E-1');
  await dialog(page).getByRole('button', { name: 'Record payment' }).click();
  await expect(dialog(page).getByText('USD allows at most 2 decimal places.')).toBeVisible();

  // A double-click records one payment
  await dialog(page).getByLabel(/^Amount received/).fill('2,000.00');
  await dialog(page).getByRole('button', { name: 'Record payment' }).dblclick();
  await expect(page).toHaveURL(/#\/payments\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('$2,000.00');
  await expect(page.getByText('Manual · unverified')).toBeVisible();
  expect((await api(page, org, '/payments')).total).toBe(1);

  // It was applied to the oldest charges automatically
  await expect(page.getByRole('cell', { name: /Rent 2026-01-01/ }).first()).toBeVisible();
  const detail = await api(page, org, `/payments/${new URL(page.url()).hash.split('/')[2]}`);
  expect(detail.allocated_minor + detail.unallocated_minor).toBe(200000);
  expect(detail.allocated_minor).toBe(200000);

  // Receipt
  await page.getByRole('button', { name: 'Issue receipt' }).click();
  await expect(page.getByRole('heading', { name: 'Receipt R-000001', level: 1 })).toBeVisible();
  await expect(page.getByText(/not verified against a bank or payment provider/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print receipt' })).toBeVisible();

  // Balance on the tenancy reflects the payment
  await page.goto(`/app?org=${org}#/tenancies/${tenancy}`);
  const ledger = await api(page, org, `/tenancies/${tenancy}/ledger`);
  expect(ledger.summary.allocated_minor).toBe(200000);
  expect(ledger.summary.outstanding_minor).toBe(ledger.summary.charged_minor - 200000);

  // Reversal keeps history and voids the receipt
  await page.goto(`/app?org=${org}#/payments/${detail.id}`);
  await page.getByRole('button', { name: 'Reverse', exact: true }).click();
  await dialog(page).getByLabel(/^Reason/).fill('Cheque bounced');
  await dialog(page).getByRole('button', { name: 'Reverse payment' }).click();
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Payment reversed' })).toBeVisible();   // the audit history keeps the reversal
  await expect(page.getByRole('cell', { name: 'Cheque bounced' })).toBeVisible();
  expect((await api(page, org, `/tenancies/${tenancy}/ledger`)).summary.allocated_minor).toBe(0);

  // Reconciliation
  await page.goto(`/app?org=${org}#/finance/audit`);
  await page.getByRole('button', { name: 'Run reconciliation' }).click();
  await expect(page.getByText('All checks passed.')).toBeVisible();
});

test('finance lists filter, show per-currency totals and stay readable on a phone', async ({ page }) => {
  const { org, tenancy } = await seed(page);
  await page.evaluate(async ([o, t]) => {
    const post = (path: string, body: object, key: string) => fetch(`/api/organizations/${o}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    await post(`/tenancies/${t}/charges`, { kind: 'rent', description: 'Rent Jan', dueDate: '2026-01-01', amountMinor: 100000 }, 'seed-charge-0001');
    await post(`/tenancies/${t}/charges`, { kind: 'fee', description: 'Late fee', dueDate: '2026-02-01', amountMinor: 5000 }, 'seed-charge-0002');
  }, [org, tenancy] as const);
  await page.goto(`/app?org=${org}#/finance/charges`);
  await expect(page.getByRole('group', { name: /Totals for the filtered results/ })).toContainText('$1,050.00');
  await page.getByLabel('Status', { exact: true }).selectOption('overdue');
  await expect(page.getByText('Showing 1–2 of 2')).toBeVisible();
  await page.getByLabel('Search', { exact: true }).fill('late');
  await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
  await expect(page.getByRole('group', { name: /Totals/ })).toContainText('$50.00');
  await page.getByLabel('Currency', { exact: true }).selectOption('EUR');
  await expect(page.getByRole('heading', { name: 'No matches' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('link', { name: 'Tina Tenant' }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 || document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('roles: a viewer has no Finance, and staff cannot see manager-only controls', async ({ browser, page }) => {
  const { org, tenancy } = await seed(page);
  const join = async (role: string) => {
    const email = unique();
    const invite = await page.evaluate(async ({ org, email, role }) => (await (await fetch(`/api/organizations/${org}/invitations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role }) })).json()).inviteUrl as string, { org, email, role });
    const p = await (await browser.newContext()).newPage();
    await p.goto('/register');
    await p.getByLabel('Work email').fill(email); await p.getByLabel('Password').fill(password);
    await p.getByRole('button', { name: 'Create account' }).click();
    await expect(p).toHaveURL(/\/onboarding/);
    await p.goto(invite.replace(/^https?:\/\/[^/]+/, ''));
    await p.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(p).toHaveURL(/\/app\?org=/);
    return p;
  };
  const viewer = await join('viewer');
  await expect(viewer.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Finance' })).toHaveCount(0);
  await viewer.goto(`/app?org=${org}#/finance/payments`);
  await expect(viewer.getByRole('heading', { name: 'Finance' })).toHaveCount(0);

  const staff = await join('staff');
  await staff.goto(`/app?org=${org}#/finance/overview`);
  await expect(staff.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Record payment' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Generate due rent charges' })).toHaveCount(0);
  await expect(staff.getByRole('link', { name: 'Audit & reconciliation' })).toHaveCount(0);
  await staff.goto(`/app?org=${org}#/tenancies/${tenancy}`);
  await expect(staff.getByRole('button', { name: 'Record payment' }).first()).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Set up recurring rent' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Add charge' })).toHaveCount(0);
});
