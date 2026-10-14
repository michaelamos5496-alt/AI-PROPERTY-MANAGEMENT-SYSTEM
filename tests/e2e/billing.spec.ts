import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery';
const unique = () => `bill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;
const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });
const dialog = (p: Page) => p.getByRole('dialog');
const nav = (p: Page, name: string | RegExp) => p.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name });

test('an admin sees the plan, usage and honest billing status, and sets the organization\'s country', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique()); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Accra Homes'); await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  await expect(page.locator('#plan-banner')).toContainText('Free trial');

  await nav(page, 'Plan').click();
  await expect(page.getByRole('heading', { name: 'Plan and settings', level: 1 })).toBeVisible();
  await expect(page.getByText('Online payment is not switched on yet')).toBeVisible();
  await expect(page.getByRole('row', { name: /Units/ })).toContainText('of 500');
  await expect(page.getByRole('heading', { name: 'Growth', level: 3 })).toBeVisible();
  await page.getByLabel('Currency').selectOption('GHS');
  await expect(page.locator('.plan-card').filter({ hasText: 'Growth' })).toContainText(/GH₵|GHS/);
  await page.locator('.plan-card').filter({ hasText: 'Scale' }).getByRole('button', { name: 'Choose plan' }).click();
  await expect(page.getByText(/Online payment is not enabled yet/)).toBeVisible();          // honest: checkout is refused while billing is pending

  await page.getByRole('link', { name: 'Country and currency' }).click();
  await expect(page.getByText('No legal or tenancy rules are built in for any country')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await dialog(page).locator('select[name=country]').selectOption('GH');
  await dialog(page).locator('select[name=currency]').selectOption('GHS');
  await dialog(page).locator('input[name=timezone]').fill('Africa/Accra');
  await dialog(page).locator('input[name=locale]').fill('en-GH');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('+233')).toBeVisible();
  await expect(page.locator('#main')).not.toContainText('nullnull');
});
