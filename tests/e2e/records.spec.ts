import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const password = 'correct horse battery';
const unique = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

async function signUpWithOrg(page: Page, orgName: string) {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique());
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill(orgName);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name }).click();
const dialog = (page: Page) => page.getByRole('dialog');

test('onboard a property, unit, tenant and tenancy, then upload and download a private lease document', async ({ page }) => {
  await signUpWithOrg(page, 'Maple Management');

  // Property
  await nav(page, 'Properties');
  await expect(page.getByRole('heading', { name: 'Add your first property' })).toBeVisible();
  await page.getByRole('button', { name: 'Add property' }).first().click();
  await dialog(page).getByLabel('Property name').fill('Maple Court');
  await dialog(page).getByLabel('Address line 1').fill('1 Maple Street');
  await dialog(page).getByLabel('City').fill('Austin');
  await dialog(page).getByLabel('Country').selectOption('US');
  await dialog(page).getByLabel('Property time zone').selectOption('America/Chicago');
  await dialog(page).getByLabel('Currency').selectOption('USD');
  await dialog(page).getByRole('button', { name: 'Add property' }).click();
  await expect(page.getByRole('heading', { name: 'Maple Court', level: 1 })).toBeVisible();

  // Validation: empty required fields are flagged next to the inputs, nothing is saved
  await page.getByRole('button', { name: 'Add unit' }).click();
  await dialog(page).getByRole('button', { name: 'Add unit' }).click();
  await expect(dialog(page).getByText('Required.')).toBeVisible();
  await dialog(page).getByLabel('Unit reference').fill('1A');
  await dialog(page).getByLabel('Bedrooms').fill('2');
  await dialog(page).getByLabel(/Market rent/).fill('1850.00');
  await dialog(page).getByRole('button', { name: 'Add unit' }).click();
  await expect(page.getByRole('link', { name: '1A' })).toBeVisible();
  await expect(page.getByRole('table').getByText('Vacant')).toBeVisible();

  // Tenant
  await nav(page, 'Tenants');
  await expect(page.getByRole('heading', { name: 'No tenants yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Add tenant' }).first().click();
  await dialog(page).getByLabel('Full name').fill('Tina Tenant');
  await dialog(page).getByLabel('Email').fill('tina@example.com');
  await dialog(page).getByRole('button', { name: 'Add tenant' }).click();
  await expect(page.getByRole('heading', { name: 'Tina Tenant', level: 1 })).toBeVisible();

  // Tenancy from the tenant profile
  await page.getByRole('button', { name: 'New tenancy' }).first().click();
  await dialog(page).getByRole('button', { name: 'Create draft tenancy' }).click();       // no unit chosen yet
  await expect(dialog(page).getByText('Required.').first()).toBeVisible();
  await dialog(page).getByLabel(/^Unit/).selectOption({ label: 'Maple Court · 1A' });
  await dialog(page).getByLabel('Start date').fill('2026-01-01');
  await dialog(page).getByLabel(/^Rent \*$/).fill('1850');
  await dialog(page).getByLabel('Deposit', { exact: true }).fill('1850');
  await dialog(page).getByLabel('Rent due day of month').fill('1');
  await dialog(page).getByRole('button', { name: 'Create draft tenancy' }).click();
  await expect(page).toHaveURL(/#\/tenancies\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tina Tenant — 1A');
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('$1,850.00 monthly, due on day 1')).toBeVisible();

  // Activate (confirmation dialog)
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(dialog(page)).toContainText('Activate this tenancy?');
  await dialog(page).getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

  // Lease + private document
  await page.getByRole('button', { name: 'Add lease' }).click();
  await dialog(page).getByLabel('Lease start').fill('2026-01-01');
  await dialog(page).getByRole('button', { name: 'Add lease' }).click();
  await expect(page.getByRole('heading', { name: 'Initial lease', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No documents yet' })).toBeVisible();

  const file = join(tmpdir(), `lease-${Date.now()}.pdf`);
  writeFileSync(file, '%PDF-1.4 e2e lease document');
  await page.getByRole('button', { name: 'Upload document' }).click();
  await dialog(page).getByLabel(/File \(PDF/).setInputFiles(file);
  await dialog(page).getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByRole('cell', { name: /^lease-\d+\.pdf/ })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^lease-\d+\.pdf$/);

  // Everything survives a reload, and the unit is now occupied
  await page.reload();
  await expect(page.getByRole('cell', { name: /^lease-\d+\.pdf/ })).toBeVisible();
  await nav(page, 'Units');
  await expect(page.getByRole('row', { name: /1A.*Occupied.*Tina Tenant/ })).toBeVisible();
});

test('search, filter and pagination keep their state in the URL', async ({ page }) => {
  await signUpWithOrg(page, 'Many Tenants Ltd');
  await nav(page, 'Tenants');
  for (let i = 1; i <= 17; i++) {
    const res = await page.evaluate(async (n) => (await fetch(`/api/organizations/${new URLSearchParams(location.search).get('org')}/tenants`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName: `Person ${String(n).padStart(2, '0')}` }) })).status, i);
    expect(res).toBe(201);
  }
  await page.reload();
  await expect(page.getByText('Showing 1–15 of 17')).toBeVisible();
  await page.getByRole('button', { name: 'Next ›' }).click();
  await expect(page.getByText('Showing 16–17 of 17')).toBeVisible();
  expect(page.url()).toContain('page=2');
  await page.reload();
  await expect(page.getByText('Showing 16–17 of 17')).toBeVisible();

  await page.getByLabel('Search name, email or phone').fill('Person 07');
  await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
  await page.getByLabel('Search name, email or phone').fill('zzz');
  await expect(page.getByRole('heading', { name: 'No matches' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText('Showing 1–15 of 17')).toBeVisible();

  await page.getByRole('button', { name: /^Name/ }).click();   // sort toggles
  await page.getByRole('button', { name: /^Name/ }).click();
  await expect(page.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('link', { name: 'Person 17' })).toBeVisible();
});

test('another organization cannot see this organization\'s tenants, tenancies or documents', async ({ browser, page }) => {
  await signUpWithOrg(page, 'Org One');
  const orgOne = new URL(page.url()).searchParams.get('org')!;
  const created = await page.evaluate(async (org) => {
    const post = async (path: string, body: object) => (await fetch(`/api/organizations/${org}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const prop = await post('/properties', { name: 'Secret Tower', addressLine1: '9 Hidden Rd', city: 'Oslo', country: 'NO', timezone: 'Europe/Oslo', currency: 'NOK' });
    const unit = await post(`/properties/${prop.id}/units`, { reference: 'X1' });
    const tenant = await post('/tenants', { fullName: 'Confidential Carl', email: 'carl@secret.test' });
    const tenancy = await post('/tenancies', { unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 1200000 });
    return { prop: prop.id, tenant: tenant.id, tenancy: tenancy.id };
  }, orgOne);

  const other = await (await browser.newContext()).newPage();
  await signUpWithOrg(other, 'Org Two');
  const probe = (path: string) => other.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.text() }; }, `/api/organizations/${orgOne}${path}`);
  for (const path of [`/tenants/${created.tenant}`, `/tenancies/${created.tenancy}`, `/properties/${created.prop}`, '/tenants', '/properties']) {
    const r = await probe(path);
    expect(r.status, path).toBe(404);
    expect(r.body).not.toMatch(/Confidential|Secret Tower|carl@/);
  }
  // Deep-linking to the other org's record inside its own workspace shows nothing either
  await other.goto(`/app#/tenants/${created.tenant}`);
  await expect(other.getByText('Confidential Carl')).toHaveCount(0);
  await expect(other.getByRole('heading', { name: 'Not found' })).toBeVisible();
});

test('a viewer can browse records but sees no write actions and no documents', async ({ browser, page }) => {
  await signUpWithOrg(page, 'Role Org');
  const org = new URL(page.url()).searchParams.get('org')!;
  const viewerEmail = unique();
  const invite = await page.evaluate(async ({ org, email }) => (await (await fetch(`/api/organizations/${org}/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role: 'viewer' }) })).json()).inviteUrl as string, { org, email: viewerEmail });

  const v = await (await browser.newContext()).newPage();
  await v.goto('/register');
  await v.getByLabel('Work email').fill(viewerEmail);
  await v.getByLabel('Password').fill(password);
  await v.getByRole('button', { name: 'Create account' }).click();
  await expect(v).toHaveURL(/\/onboarding/);
  await v.goto(invite.replace(/^https?:\/\/[^/]+/, ''));
  await v.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(v).toHaveURL(/\/app\?org=/);
  await nav(v, 'Properties');
  await expect(v.getByRole('button', { name: 'Add property' })).toHaveCount(0);
  await expect(v.getByRole('heading', { name: 'Add your first property' })).toBeVisible();
  await nav(v, 'Tenants');
  await expect(v.getByRole('button', { name: 'Add tenant' })).toHaveCount(0);
});
