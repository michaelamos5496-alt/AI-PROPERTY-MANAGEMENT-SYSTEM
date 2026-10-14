import { expect, test } from '@playwright/test';

const password = 'correct horse battery';
// Any CSP violation or uncaught page error fails the test (same policy as production, see vercel.json).
const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

const unique = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;

test('anonymous visitors are sent to sign in when opening the workspace', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp/);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
});

test('register, create an organization, sign out and back in', async ({ page }) => {
  const email = unique();

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Ada Landlord');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Organization name').fill('Maple Court Apartments');
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page).toHaveURL(/\/app\?org=/);
  await expect(page.getByRole('heading', { name: 'Maple Court Apartments' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Invitations' })).toBeVisible();

  // Session cookies are HttpOnly: page scripts can't read them.
  expect(await page.evaluate(() => document.cookie)).toBe('');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  await expect(page.getByRole('heading', { name: 'Maple Court Apartments' })).toBeVisible();
});

test('wrong password shows an accessible error and does not sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('nobody@test.dev');
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
  await expect(page).toHaveURL(/\/login/);
});

test('account recovery gives the same answer for any address', async ({ page }) => {
  await page.goto('/recover');
  await page.getByLabel('Email').fill('ghost@test.dev');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
});

test('a second account cannot open another organization by editing the URL', async ({ browser, page }) => {
  const ownerEmail = unique();
  await page.goto('/register');
  await page.getByLabel('Work email').fill(ownerEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Owner Holdings');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const ownerOrgId = new URL(page.url()).searchParams.get('org')!;

  const intruder = await (await browser.newContext()).newPage();
  await intruder.goto('/register');
  await intruder.getByLabel('Work email').fill(unique());
  await intruder.getByLabel('Password').fill(password);
  await intruder.getByRole('button', { name: 'Create account' }).click();
  await intruder.getByLabel('Organization name').fill('Intruder LLC');
  await intruder.getByRole('button', { name: 'Create organization' }).click();
  await expect(intruder).toHaveURL(/\/app\?org=/);

  // Same-origin API probe with the intruder's session, using the owner's org id.
  const status = await intruder.evaluate(async (id) => (await fetch(`/api/organizations/${id}/members`)).status, ownerOrgId);
  expect(status).toBe(404);

  // Editing the URL falls back to the intruder's own organization; Owner Holdings never renders.
  await intruder.goto(`/app?org=${ownerOrgId}`);
  await expect(intruder.getByRole('heading', { name: 'Intruder LLC' })).toBeVisible();
  await expect(intruder.getByText('Owner Holdings')).toHaveCount(0);
});
