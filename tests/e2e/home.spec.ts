import { expect, test } from '@playwright/test';

const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

test('the home page explains the product, is honest about its stage, and leads to sign-up', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Run your rentals');
  await expect(page.getByText('Early access · 14-day free trial')).toBeVisible();
  await expect(page.getByRole('img', { name: /Illustration of the Property AI dashboard/ })).toBeVisible();
  for (const h of ['Rent ledger you can trust', 'AI copilot with a safety catch', 'Approvals and an audit trail', 'Your data is walled off']) await expect(page.getByRole('heading', { name: h })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  // nothing here claims more than is true
  await expect(page.locator('body')).not.toContainText(/SOC ?2|ISO ?27001|guarantee|99\.9/i);
  await page.getByRole('main').getByRole('link', { name: 'Create your workspace' }).first().click();
  await expect(page).toHaveURL(/\/register/);
});

test('the FAQ opens, anchors work, and the page fits a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await page.getByText('Does the AI send messages to my tenants by itself?').click();
  await expect(page.getByText('A person must request it')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await expect(page).toHaveURL(/\/login/);
});
