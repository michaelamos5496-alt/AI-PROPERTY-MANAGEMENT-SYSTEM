import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery';
const SECRET = 'e2e-whatsapp-secret-0123456789';
const unique = () => `wa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.dev`;
const problems: string[] = [];
test.beforeEach(({ page }) => {
  problems.length = 0;
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
});
test.afterEach(() => { expect(problems).toEqual([]); });

const dialog = (p: Page) => p.getByRole('dialog');
const post = (p: Page, org: string, path: string, body: object) => p.evaluate(async ([o, pa, b]) => (await (await fetch(`/api/organizations/${o}${pa}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()), [org, path, body] as const);

async function webhook(page: Page, pnid: string, from: string, text: string) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid, display_phone_number: '15550100' },
    contacts: [{ profile: { name: 'Sam Sender' }, wa_id: from }], messages: [{ from, id: `wamid.E2E${Date.now()}${Math.random().toString(36).slice(2, 6)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  const r = await page.request.post('/api/webhooks/whatsapp', { data: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` } });
  expect(r.status()).toBe(200);
  return r;
}

test('an admin connects a number, a tenant asks for a person, and a manager handles it and issues a link code', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Work email').fill(unique()); await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill('Chat Co'); await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\?org=/);
  const org = new URL(page.url()).searchParams.get('org')!;
  const prop = await post(page, org, '/properties', { name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' });
  const unit = await post(page, org, `/properties/${prop.id}/units`, { reference: '1A' });
  const tenant = await post(page, org, '/tenants', { fullName: 'Tina Tenant', email: 'tina@mail.test' });
  const tn = await post(page, org, '/tenancies', { unit: unit.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: 150000 });
  await post(page, org, `/tenancies/${tn.id}/activate`, { expectedVersion: tn.version });

  // connect the number
  await page.goto(`/app?org=${org}#/whatsapp/setup`);
  await expect(page.getByText('test mode: messages are recorded, never sent')).toBeVisible();
  await page.getByRole('button', { name: 'Connect a number' }).click();
  await dialog(page).getByLabel(/^Phone number ID/).fill('730000000000001');
  await dialog(page).getByLabel(/^Log chat reports as/).selectOption({ index: 1 });
  await dialog(page).getByLabel('Channel is on').check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('730000000000001')).toBeVisible();

  // a stranger asks for a person; the assistant answers and a manager is told
  const r = await webhook(page, '730000000000001', '15559990001', 'I want to talk to a real person');
  expect((await r.json()).received).toBe(1);
  await page.goto(`/app?org=${org}#/whatsapp`);
  await expect(page.getByRole('heading', { name: /Needs a person \(1\)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  await expect(dialog(page)).toContainText('I want to talk to a real person');
  await expect(dialog(page)).toContainText('asked a team member');
  await expect(dialog(page)).toContainText('Not verified');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Mark handled' }).click();
  await expect(page.getByRole('heading', { name: /Needs a person/ })).toHaveCount(0);

  // issue a one-time link code
  await page.getByRole('button', { name: 'Create a link code' }).click();
  await dialog(page).getByLabel(/^Tenant/).selectOption({ label: 'Tina Tenant' });
  await dialog(page).getByRole('button', { name: 'Create code' }).click();
  await expect(dialog(page).locator('.code-big')).toHaveText(/^[A-Z2-9]{8}$/);
  await expect(dialog(page)).toContainText('works once');
  await dialog(page).getByRole('button', { name: 'Done' }).click();

  // the signature is checked: the same body without a valid signature is refused
  const bad = await page.request.post('/api/webhooks/whatsapp', { data: '{"object":"whatsapp_business_account","entry":[]}', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
  expect(bad.status()).toBe(401);
  await expect(page.locator('#main')).not.toContainText('nullnull');
});
