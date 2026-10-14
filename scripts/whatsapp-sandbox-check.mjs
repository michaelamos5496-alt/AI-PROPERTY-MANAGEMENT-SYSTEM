#!/usr/bin/env node
// Checks a DEPLOYED instance of this app against the Meta WhatsApp Cloud API sandbox/test setup.
// It proves the pieces you can prove from a terminal, and tells you plainly which step still needs a human with a phone.
//
//   APP_URL=https://your-app.example.com \
//   WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=... WHATSAPP_PHONE_NUMBER_ID=... \
//   node scripts/whatsapp-sandbox-check.mjs --from 15551234567 [--send-test --to 15551234567 --template hello_world]
//
// WARNING: step 3 makes the app REPLY to --from through the real API (if the app runs with WHATSAPP_PROVIDER=cloud). Use your own
// test recipient number that is registered on the sandbox number. Never use a customer's number.
import { createHmac } from 'node:crypto';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(`--${n}`);
const env = (n) => process.env[n];
const need = (n) => { if (!env(n)) { console.error(`Missing ${n}`); process.exit(2); } return env(n); };
const url = need('APP_URL').replace(/\/$/, ''); const verify = need('WHATSAPP_VERIFY_TOKEN'); const secret = need('WHATSAPP_APP_SECRET'); const pnid = need('WHATSAPP_PHONE_NUMBER_ID');
const from = arg('from');
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const hook = `${url}/api/webhooks/whatsapp`;

// 1. subscription handshake
{
  const challenge = String(Math.floor(Math.random() * 1e9));
  const r = await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verify)}&hub.challenge=${challenge}`);
  check('webhook handshake echoes the challenge', r.status === 200 && (await r.text()) === challenge, `HTTP ${r.status}`);
  const bad = await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong-token-wrong-token&hub.challenge=1`);
  check('handshake refuses a wrong verify token', bad.status === 403, `HTTP ${bad.status}`);
}

// 2. signature checking
const body = (text) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
  metadata: { display_phone_number: '0', phone_number_id: pnid }, contacts: [{ profile: { name: 'Sandbox Check' }, wa_id: from ?? '15550000000' }],
  messages: [{ from: from ?? '15550000000', id: `wamid.SANDBOXCHECK${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const sign = (raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
{
  const raw = body('help');
  const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: raw });
  check('a wrong signature is rejected (401)', r.status === 401, `HTTP ${r.status}`);
  const none = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  check('a missing signature is rejected (401)', none.status === 401, `HTTP ${none.status}`);
}

// 3. a correctly signed message is accepted, stored once, and a redelivery is a no-op
if (from) {
  const raw = body('help');
  const post = () => fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw });
  const a = await post(); const aj = await a.json().catch(() => ({}));
  check('a signed message is accepted and stored', a.status === 200 && aj.received === 1, JSON.stringify(aj));
  const b = await post(); const bj = await b.json().catch(() => ({}));
  check('redelivery of the same message id is a no-op', b.status === 200 && bj.duplicates === 1 && bj.received === 0, JSON.stringify(bj));
} else console.log('SKIP  signed-message test (pass --from <your sandbox recipient number>)');

// 4. optional: send a real message with the Graph API to prove the token, the number and the recipient list
if (flag('send-test')) {
  const token = need('WHATSAPP_ACCESS_TOKEN'); const to = arg('to') ?? from; const version = env('WHATSAPP_GRAPH_VERSION') ?? 'v25.0';
  if (!to) { console.error('--send-test needs --to'); process.exit(2); }
  const r = await fetch(`https://graph.facebook.com/${version}/${pnid}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: arg('template') ?? 'hello_world', language: { code: 'en_US' } } }) });
  const j = await r.json().catch(() => ({}));
  check('Meta accepted a test template message', r.ok && !!j.messages?.[0]?.id, r.ok ? `message id ${j.messages[0].id}` : `HTTP ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
console.log(`
This script does NOT prove production connectivity. Still to do by hand, with a real phone registered as a sandbox recipient:
  [ ] 5. From that phone, send "help" to the business number and confirm the assistant replies (Meta -> webhook -> inbox -> reply -> Meta -> phone).
  [ ] 6. Confirm a "delivered"/"read" receipt appears on that message in WhatsApp > Conversations.
  [ ] 7. Run the link flow (create a code in the app, send "LINK <code>") and confirm "BALANCE" answers only after linking.
  [ ] 8. Send "STOP" and confirm nothing is sent afterwards until "START".
Record the date and the message ids you saw in docs/WHATSAPP.md ("Verification log") before calling it connected.`);
process.exit(failed ? 1 : 0);
