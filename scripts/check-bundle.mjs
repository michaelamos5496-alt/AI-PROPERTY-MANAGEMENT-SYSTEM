// Fails the build if anything secret-looking ended up in files served to browsers.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../public', import.meta.url));
const patterns = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT-like token'],
  [/service_role/i, '"service_role" reference'],
  [/sb_secret_[A-Za-z0-9_-]+/, 'Supabase secret key'],
  [/SUPABASE_[A-Z_]+/, 'Supabase env var name'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'Anthropic API key'],
  [/ANTHROPIC_[A-Z_]+/, 'Anthropic env var name'],
  [/PAYSTACK_[A-Z_]+/, 'Paystack env var name'],
  [/sk_(live|test)_[A-Za-z0-9]{10,}/, 'Paystack secret key'],
  [/WHATSAPP_(APP_SECRET|ACCESS_TOKEN|VERIFY_TOKEN)/, 'WhatsApp secret env var name'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];
const secretValues = ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'ANTHROPIC_API_KEY', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN', 'PAYSTACK_SECRET_KEY']
  .map((k) => process.env[k]).filter((v) => v && v.length >= 12);

async function* walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
const problems = [];
let files = 0;
for await (const f of walk(dir)) {
  files++;
  const text = await readFile(f, 'utf8');
  for (const [re, label] of patterns) if (re.test(text)) problems.push(`${f}: ${label}`);
  for (const v of secretValues) if (text.includes(v)) problems.push(`${f}: contains a configured environment value`);
}
if (!files) { console.error('check-bundle: public/ is empty. Run build:web first.'); process.exit(1); }
if (problems.length) { console.error('Secret leak check FAILED:\n' + problems.map((p) => '  - ' + p).join('\n')); process.exit(1); }
console.log(`check-bundle: ${files} client files scanned, no secrets found.`);
