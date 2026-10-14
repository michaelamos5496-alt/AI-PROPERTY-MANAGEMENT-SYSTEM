import { expect, test } from '@playwright/test';

const password = 'correct horse battery';
const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

test('hostile text in records is shown as text and never runs', async ({ page }) => {
  let dialogs = 0; page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
  await page.goto('/register');
  await page.getByLabel('Work email').fill(`xss-${Date.now()}@test.dev`); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('<b>Bold</b> Org'); await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const org = new URL(page.url()).searchParams.get('org')!;
  const evil = '<img src=x onerror="window.__pwned=1;alert(1)"><script>window.__pwned=1</script>';
  const res = await page.evaluate(async ([o, name]) => (await fetch(`/api/organizations/${o}/properties`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, addressLine1: '"><svg onload=alert(2)>', city: 'X', country: 'GH', timezone: 'Africa/Accra', currency: 'GHS' }) })).status, [org, evil] as const);
  expect(res).toBe(201);
  await page.goto(`/app?org=${org}#/properties`);
  await expect(page.getByText(evil, { exact: false }).first()).toBeVisible();          // shown literally
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('svg[onload]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  await page.goto(`/app?org=${org}#/overview`);
  await expect(page.getByRole('heading', { name: '<b>Bold</b> Org' })).toBeVisible();   // organization name also literal
  expect(dialogs).toBe(0);
});
