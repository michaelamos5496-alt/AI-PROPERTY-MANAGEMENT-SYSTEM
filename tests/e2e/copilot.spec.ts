import { expect, test, type Browser, type Page } from '@playwright/test';

const password = 'correct horse battery';
const unique = () => `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

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

async function seed(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique()); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Copilot Co'); await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const org = new URL(page.url()).searchParams.get('org')!;
  const prop = await post(page, org, '/properties', { name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' });
  const unit = await post(page, org, `/properties/${prop.id}/units`, { reference: '1A' });
  const tenant = await post(page, org, '/tenants', { fullName: 'Tina Tenant', email: 'tina@mail.test' });
  const tn = await post(page, org, '/tenancies', { unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 });
  await post(page, org, `/tenancies/${tn.id}/activate`, { expectedVersion: tn.version });
  await post(page, org, `/tenancies/${tn.id}/charges`, { kind: 'fee', description: 'January rent', dueDate: '2026-01-01', amountMinor: 150000 }, { 'idempotency-key': `e2e-${Date.now()}-charge` });
  return { org };
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

test('staff ask the copilot, prepare a draft and a test action; a manager approves; the outcome is traceable', async ({ browser, page }) => {
  const s = await seed(page);
  const staff = await join(browser, page, s.org, 'staff');

  // a grounded answer with its basis and links to the records it used
  await staff.goto(`/app?org=${s.org}#/copilot`);
  await expect(staff.getByRole('heading', { name: 'Copilot', level: 1 })).toBeVisible();
  await expect(staff.getByText('Rules mode')).toBeVisible();
  await staff.getByRole('button', { name: 'Who is overdue on rent?' }).click();
  const answer = staff.locator('.msg--assistant').last();
  await expect(answer).toContainText('Tina Tenant');
  await expect(answer).toContainText('1,500.00 USD');
  await expect(answer).toContainText('Basis:');
  await expect(answer.getByRole('link', { name: /Tina Tenant/ })).toBeVisible();
  await expect(answer).not.toContainText('could not match');

  // a draft is only a draft: no way to send it from here
  await staff.getByRole('button', { name: 'Draft a reminder for the largest overdue balance' }).click();
  const card = staff.locator('.action-card').filter({ hasText: 'Draft rent reminder' });
  await expect(card).toContainText('Nothing has been sent');
  await expect(card).toContainText('1500.00 USD');
  await expect(card.getByRole('button', { name: /send|request approval/i })).toHaveCount(0);

  // the approval lifecycle on a harmless action
  await staff.getByRole('button', { name: 'Try the approval process safely' }).click();
  const test_ = staff.locator('.action-card').filter({ hasText: 'Test action (harmless)' });
  await expect(test_).toContainText('Waiting for you');
  await test_.getByRole('button', { name: 'Request approval' }).click();
  await expect(test_).toContainText('Waiting for a manager');

  // the manager approves in the normal inbox; the exact proposal is shown
  await page.goto(`/app?org=${s.org}#/approvals`);
  await expect(page.getByText('Record the note')).toBeVisible();
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'AI test action', level: 1 })).toBeVisible();
  await expect(page.locator('pre.payload')).toContainText('"note"');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Approve and run' }).click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();

  // the requester sees the result on the same card
  await staff.reload();
  await expect(staff.locator('.action-card').filter({ hasText: 'Test action (harmless)' })).toContainText('Test note recorded');
  await expect(staff.locator('#main')).not.toContainText('nullnull');
});

test('viewers do not see the copilot; the page respects roles', async ({ browser, page }) => {
  const s = await seed(page);
  const viewer = await join(browser, page, s.org, 'viewer');
  await viewer.goto(`/app?org=${s.org}#/overview`);
  await expect(nav(viewer, 'Copilot')).toHaveCount(0);
  await expect(nav(page, 'Copilot')).toBeVisible();
});
