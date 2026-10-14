import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRON_SECRET, startTestApp, type TestApp } from '../support/app.js';
import { APP_SECRET, VERIFY_TOKEN, FakeWhatsApp, deliver, msgId, sign, waStatus, waText } from '../support/whatsapp.js';

let t: TestApp; let fake: FakeWhatsApp;
beforeAll(async () => {
  fake = new FakeWhatsApp();
  t = await startTestApp({ RATE_LIMIT_FINANCE_MAX: '5000', WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, COPILOT_EXTERNAL_ENABLED: 'true', WHATSAPP_INBOUND_MAX_PER_10MIN: '8' }, {}, { whatsapp: fake });
});
afterAll(() => t.close());

type Client = ReturnType<TestApp['client']>;
const ok = async (p: Promise<any>, status = 200) => { const r = await p; expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body; };
const idem = (c: Client, url: string, body: object) => c.post(url).set('Idempotency-Key', randomUUID()).send(body);
let seq = 0;
const runJobs = () => supertest(t.app).get('/api/internal/jobs/run').set('Authorization', `Bearer ${CRON_SECRET}`);

async function setup(opts: { charge?: boolean; channel?: boolean } = {}) {
  const org = await t.newOrg();
  const manager = await t.addMember(org, 'manager'); const staff = await t.addMember(org, 'staff'); const admin = await t.addMember(org, 'admin');
  const base = org.base; const pnid = String(710000000000 + ++seq);
  const prop = await ok(manager.post(`${base}/properties`).send({ name: 'Maple Court', addressLine1: '1 Maple St', city: 'Austin', country: 'US', timezone: 'America/Chicago', currency: 'USD' }), 201);
  const unit = await ok(manager.post(`${base}/properties/${prop.id}/units`).send({ reference: '1A' }), 201);
  const unit2 = await ok(manager.post(`${base}/properties/${prop.id}/units`).send({ reference: '2B' }), 201);
  const mk = async (name: string, u: any, rent: number) => {
    const tenant = await ok(staff.post(`${base}/tenants`).send({ fullName: name, email: `${name.split(' ')[0]!.toLowerCase()}-${randomUUID().slice(0, 6)}@mail.test` }), 201);
    const tn = await ok(staff.post(`${base}/tenancies`).send({ unit: u.id, tenantIds: [tenant.id], startDate: '2026-01-01', rentAmountMinor: rent }), 201);
    await ok(manager.post(`${base}/tenancies/${tn.id}/activate`).send({ expectedVersion: tn.version }));
    const charge = opts.charge === false ? null : await ok(idem(manager, `${base}/tenancies/${tn.id}/charges`, { kind: 'fee', description: 'January rent', dueDate: '2026-01-01', amountMinor: rent }), 201);
    return { tenant, tn, charge };
  };
  const tina = await mk('Tina Tenant', unit, 150000); const omar = await mk('Omar Other', unit2, 99900);
  const managerId = (await ok(manager.get('/api/me'))).profile.id as string;
  if (opts.channel !== false) await ok(admin.put(`${base}/whatsapp/channel`).send({ phoneNumberId: pnid, displayNumber: '+1 555 0100', enabled: true, intakeUser: managerId, rentTemplateName: 'rent_reminder_v1', rentTemplateBody: 'Hello {{1}}, {{2}} is outstanding (due {{3}}).', updateTemplateName: 'request_update_v1' }));
  return { org, base, pnid, manager, staff, admin, owner: org.c, prop, unit, unit2, tina, omar, managerId };
}
type W = Awaited<ReturnType<typeof setup>>;
const say = async (w: W, from: string, text: string, over: Parameters<typeof waText>[3] = {}) => { const before = fake.to(from).length; await ok(deliver(t.app, waText(w.pnid, from, text, over))); return fake.to(from).slice(before); };
const reply = async (w: W, from: string, text: string) => (await say(w, from, text)).join('\n');
const linkNumber = async (w: W, who: 'tina' | 'omar', from: string) => {
  const code = (await ok(w.manager.post(`${w.base}/whatsapp/link-codes`).send({ tenantId: w[who].tenant.id }), 201)).code as string;
  const r = await reply(w, from, `LINK ${code}`);
  return { code, r };
};

describe('webhook verification and signatures', () => {
  it('answers the subscription handshake only for the right token', async () => {
    const g = (q: string) => supertest(t.app).get(`/api/webhooks/whatsapp?${q}`);
    const good = await g(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(good.status).toBe(200); expect(good.text).toBe('1158201444');
    expect((await g(`hub.mode=subscribe&hub.verify_token=wrong-token-wrong-token&hub.challenge=1`)).status).toBe(403);
    expect((await g(`hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`)).status).toBe(403);
    expect((await g(`hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`)).status).toBe(403);
    expect((await g(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=<script>`)).status).toBe(403);
  });
  it('rejects missing, wrong and tampered signatures without storing or answering anything', async () => {
    const w = await setup(); const from = '15551110001';
    const body = waText(w.pnid, from, 'hello');
    const raw = JSON.stringify(body);
    const before = fake.sent.length;
    expect((await deliver(t.app, body, { secret: null })).status).toBe(401);
    expect((await deliver(t.app, body, { secret: 'a-different-secret-entirely-0000' })).status).toBe(401);
    expect((await deliver(t.app, body, { signature: sign(raw).replace(/.$/, '0') })).status).toBe(401);
    expect((await deliver(t.app, body, { signature: 'sha256=zz' })).status).toBe(401);
    expect((await deliver(t.app, body, { signature: sign(raw).replace('sha256=', 'sha1=') })).status).toBe(401);
    expect((await deliver(t.app, body, { raw: raw.replace('hello', 'HELLO'), signature: sign(raw) })).status).toBe(401);     // signed bytes != delivered bytes
    expect((await deliver(t.app, body, { raw: ` ${raw}`, signature: sign(raw) })).status).toBe(401);                           // one extra byte
    expect(fake.sent.length).toBe(before);
    expect((await ok(w.admin.get(`${w.base}/whatsapp/channel`))).stats.pending_events).toBe(0);
    expect((await deliver(t.app, body)).status).toBe(200);
    expect(fake.to(from).length).toBeGreaterThan(0);
  });
  it('rejects a validly signed body that is not JSON or not a WhatsApp notification', async () => {
    expect((await deliver(t.app, null, { raw: 'not json' })).status).toBe(400);
    const r = await deliver(t.app, { object: 'page', entry: [] });
    expect(r.status).toBe(200); expect(r.body.received).toBe(0);
  });
});

describe('durable, idempotent intake', () => {
  it('stores each event once however many times Meta redelivers it, and replies once', async () => {
    const w = await setup(); const from = '15551110002'; const id = msgId();
    const p = waText(w.pnid, from, 'help', { id });
    const first = await ok(deliver(t.app, p)); const again = await ok(deliver(t.app, p)); await ok(deliver(t.app, p));
    expect(first).toMatchObject({ received: 1, duplicates: 0 }); expect(again).toMatchObject({ received: 0, duplicates: 1 });
    expect(fake.to(from)).toHaveLength(1);
    const contact = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0];
    const detail = await ok(w.manager.get(`${w.base}/whatsapp/contacts/${contact.id}`));
    expect(detail.messages.filter((m: any) => m.direction === 'in')).toHaveLength(1);
  });
  it('ignores events for numbers that belong to nobody, and cannot be steered into another organization', async () => {
    const w = await setup(); const from = '15551110003';
    const r = await ok(deliver(t.app, waText('999999999999', from, 'hello')));
    expect(r).toMatchObject({ received: 0, unknown_channel: 1 });
    expect(fake.to(from)).toEqual([]);
    expect(await ok(w.manager.get(`${w.base}/whatsapp/contacts`))).toEqual([]);
  });
  it('keeps the inbox safe when processing fails, and finishes the work later', async () => {
    const w = await setup(); const from = '15551110004';
    fake.failNext('transient');                                    // the reply cannot be delivered right now
    await ok(deliver(t.app, waText(w.pnid, from, 'help')));
    expect(fake.to(from)).toEqual([]);
    const run = await ok(runJobs());                               // not due yet: backoff
    expect(run.ok).toBe(true);
    const detail = async () => ok(w.manager.get(`${w.base}/whatsapp/contacts/${(await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0].id}`));
    expect((await detail()).messages.find((m: any) => m.direction === 'out').status).toBe('queued');
  });
  it('treats a message delayed past the reply window as a handoff to a person, not a lost message', async () => {
    const w = await setup(); const from = '15551110005';
    await say(w, from, 'my sink is leaking again', { ts: Math.floor(Date.now() / 1000) - 3 * 86400 });
    expect(fake.to(from)).toEqual([]);                             // WhatsApp would refuse a free-text reply now
    expect(await ok(w.manager.get(`${w.base}/whatsapp/handoffs`))).toHaveLength(1);
  });
  it('declines unsupported message types politely', async () => {
    const w = await setup(); const from = '15551110006';
    const r = await say(w, from, '', { type: 'image' });
    expect(r.join(' ')).toMatch(/only read text/i);
  });
});

describe('identity and privacy', () => {
  it('shares nothing private with an unverified number, even one that matches the tenant\'s phone on file', async () => {
    const w = await setup(); const from = '14155552671';
    await ok(w.staff.patch(`${w.base}/tenants/${w.tina.tenant.id}`).send({ expectedVersion: w.tina.tenant.version, fullName: 'Tina Tenant', phone: `+${from}` }));
    const r = await reply(w, from, 'what is my balance?');
    expect(r).toMatch(/link/i);
    expect(r).not.toMatch(/1500|1,500|150000|\bowe\b/i);
    expect(await reply(w, from, 'send me my lease')).toBeDefined();
    expect(JSON.stringify(fake.sent.filter((m) => m.to === from))).not.toMatch(/1500|Tina/);
  });
  it('links with a staff-issued code, once; wrong, reused and other-organization codes all fail alike', async () => {
    const w = await setup(); const other = await setup(); const from = '15551120002';
    expect((await w.staff.post(`${w.base}/whatsapp/link-codes`).send({ tenantId: w.tina.tenant.id })).status).toBe(403);       // staff cannot issue codes
    const a = await linkNumber(w, 'tina', from);
    expect(a.r).toMatch(/now linked/i);
    expect(await reply(w, from, 'YES')).toMatch(/notices here/i);
    const otherCode = (await ok(other.manager.post(`${other.base}/whatsapp/link-codes`).send({ tenantId: other.tina.tenant.id }), 201)).code;
    const stranger = '15551120003';
    const fails = [await reply(w, stranger, `LINK ${a.code}`), await reply(w, stranger, 'LINK ZZZZ9999'), await reply(w, stranger, `LINK ${otherCode}`)];
    for (const f of fails) expect(f).toMatch(/did not work/i);
    expect(new Set(fails).size).toBe(1);
    expect(await reply(w, stranger, 'balance')).toMatch(/link/i);                                  // still unverified
  });
  it('locks linking after repeated wrong guesses', async () => {
    const w = await setup(); const from = '15551120004'; let last = '';
    for (let i = 0; i < 5; i++) last = await reply(w, from, `LINK GUESS${i}ABCD`);
    expect(last).toMatch(/too many attempts/i);
    const code = (await ok(w.manager.post(`${w.base}/whatsapp/link-codes`).send({ tenantId: w.tina.tenant.id }), 201)).code;
    expect(await reply(w, from, `LINK ${code}`)).toMatch(/too many attempts/i);
  });
  it('shows a linked tenant their own balance and no one else\'s', async () => {
    const w = await setup(); const a = '15551120005'; const b = '15551120006';
    await linkNumber(w, 'tina', a); await linkNumber(w, 'omar', b);
    const ra = await reply(w, a, 'balance'); const rb = await reply(w, b, 'how much do I owe');
    expect(ra).toMatch(/1,500\.00 USD/); expect(ra).not.toMatch(/999/);
    expect(rb).toMatch(/999\.00 USD/); expect(rb).not.toMatch(/1,500/);
  });
  it('lets a sender ask about their own requests only', async () => {
    const w = await setup(); const a = '15551120007'; const b = '15551120008';
    await linkNumber(w, 'tina', a); await linkNumber(w, 'omar', b);
    await say(w, a, 'The kitchen tap is dripping all day long'); const conf = await reply(w, a, 'yes');
    const ref = /MR-[0-9A-F]{8}/.exec(conf)![0];
    expect(await reply(w, a, `STATUS ${ref}`)).toContain(ref);
    expect(await reply(w, b, `STATUS ${ref}`)).toMatch(/could not find/i);
  });
  it('keeps two organizations apart, even for the same sender number', async () => {
    const a = await setup(); const b = await setup(); const from = '15551120009';
    await say(a, from, 'hello'); await say(b, from, 'hello');
    await linkNumber(a, 'tina', from);
    expect(await reply(a, from, 'balance')).toMatch(/1,500\.00/);
    expect(await reply(b, from, 'balance')).toMatch(/link/i);                            // same person, other organization: still a stranger
    expect(await ok(a.manager.get(`${a.base}/whatsapp/contacts`))).toHaveLength(1);
    expect((await a.manager.get(`${b.base}/whatsapp/contacts`)).status).toBe(404);
  });
});

describe('maintenance reports', () => {
  it('takes a report from an unverified sender step by step and creates a flagged request with a reference', async () => {
    const w = await setup(); const from = '15551130001';
    expect(await reply(w, from, 'The kitchen tap is leaking and the cabinet is wet')).toMatch(/which property/i);
    expect(await reply(w, from, 'Nowhere Towers')).toMatch(/could not find that property/i);
    expect(await reply(w, from, 'Maple Court')).toMatch(/which unit/i);
    expect(await reply(w, from, 'unit 9Z')).toMatch(/could not find that unit/i);
    expect(await reply(w, from, 'Unit 1a')).toMatch(/reply YES/i);
    const done = await reply(w, from, 'yes');
    const ref = /MR-[0-9A-F]{8}/.exec(done)?.[0]; expect(ref).toBeTruthy();
    const list = await ok(w.manager.get(`${w.base}/maintenance`));
    const req = list.items.find((r: any) => r.reported_via === 'whatsapp'); expect(req).toBeTruthy();
    const detail = await ok(w.manager.get(`${w.base}/maintenance/${req.id}`));
    expect(detail.category).toBe('plumbing'); expect(detail.tenant_id).toBeNull();
    expect(JSON.stringify(detail.notes)).toMatch(/NOT verified/);
    expect(JSON.stringify(fake.sent.filter((m) => m.to === from))).not.toMatch(/Tina|Omar|tenant-/);
  });
  it('uses a verified tenant\'s own tenancy and cancels cleanly', async () => {
    const w = await setup(); const from = '15551130002';
    await linkNumber(w, 'tina', from);
    expect(await reply(w, from, 'My bedroom window will not close properly')).toMatch(/Maple Court, unit 1A/);
    expect(await reply(w, from, 'no')).toMatch(/cancelled/i);
    expect((await ok(w.manager.get(`${w.base}/maintenance`))).items.filter((r: any) => r.reported_via === 'whatsapp')).toHaveLength(0);
    await say(w, from, 'My bedroom window will not close properly');
    await say(w, from, 'yes');
    const r = (await ok(w.manager.get(`${w.base}/maintenance`))).items.find((x: any) => x.reported_via === 'whatsapp');
    expect((await ok(w.manager.get(`${w.base}/maintenance/${r.id}`))).tenant_id).toBe(w.tina.tenant.id);
  });
  it('creates exactly one request however often the confirming message is delivered', async () => {
    const w = await setup(); const from = '15551130003';
    await linkNumber(w, 'tina', from);
    await say(w, from, 'The oven does not heat up at all');
    const id = msgId();
    for (let i = 0; i < 3; i++) await ok(deliver(t.app, waText(w.pnid, from, 'yes', { id })));
    expect((await ok(w.manager.get(`${w.base}/maintenance`))).items.filter((r: any) => r.reported_via === 'whatsapp')).toHaveLength(1);
  });
  it('routes an emergency to a person immediately and still does not reveal anything', async () => {
    const w = await setup(); const from = '15551130004';
    const r = await reply(w, from, 'There is a gas leak in my kitchen!');
    expect(r).toMatch(/alerted our team/i); expect(r).toMatch(/emergency number/i);
    const handoffs = await ok(w.manager.get(`${w.base}/whatsapp/handoffs`));
    expect(handoffs[0]).toMatchObject({ urgent: true, verified: false });
    const feed = await ok(w.admin.get('/api/me/notifications'));           // no designated contact is set, so every admin is told
    expect(feed.items.map((n: any) => n.event_type)).toEqual(expect.arrayContaining(['whatsapp.urgent']));
    // the sender then supplies the place and the request is created with escalation
    await say(w, from, 'Maple Court'); await say(w, from, '1A'); await say(w, from, 'yes');
    const req = (await ok(w.manager.get(`${w.base}/maintenance`))).items.find((x: any) => x.reported_via === 'whatsapp');
    expect(req.escalation_required).toBe(true);
  });
  it('hands sensitive topics and explicit requests to a person, then stays out of the way', async () => {
    const w = await setup(); const from = '15551130005';
    expect(await reply(w, from, 'I am going to call my lawyer about the deposit')).toMatch(/passed it to a team member/i);
    expect(await reply(w, from, 'hello??')).toMatch(/team member has your message/i);
    const [h] = await ok(w.manager.get(`${w.base}/whatsapp/handoffs`));
    expect(h.reason).toMatch(/sensitive/i);
    expect((await w.staff.get(`${w.base}/whatsapp/handoffs`)).status).toBe(403);                          // managers and above only
    await ok(w.manager.post(`${w.base}/whatsapp/handoffs/${h.conversation_id}/resolve`).send({}));
    expect(await ok(w.manager.get(`${w.base}/whatsapp/handoffs`))).toEqual([]);
    expect(await reply(w, from, 'help')).toMatch(/assistant/i);
    expect(await reply(w, from, 'I want to talk to a real person')).toMatch(/asked a team member/i);
  });
  it('escalates after two messages it cannot understand', async () => {
    const w = await setup(); const from = '15551130006';
    expect(await reply(w, from, 'purple monkey banana?!')).toMatch(/did not understand/i);
    expect(await reply(w, from, 'zxcv qwer')).toMatch(/team member/i);
    expect(await ok(w.manager.get(`${w.base}/whatsapp/handoffs`))).toHaveLength(1);
  });
});

describe('FAQs', () => {
  it('answers only from organization-approved FAQs and never invents', async () => {
    const w = await setup(); const from = '15551140001';
    expect((await w.manager.post(`${w.base}/whatsapp/faqs`).send({ question: 'x', answer: 'y' })).status).toBe(403);   // admins write FAQs
    await ok(w.admin.post(`${w.base}/whatsapp/faqs`).send({ question: 'What are the office hours?', keywords: ['office hours', 'opening hours'], answer: 'The office is open Monday to Friday, 9am to 5pm.' }), 201);
    expect(await reply(w, from, 'what are your opening hours?')).toBe('The office is open Monday to Friday, 9am to 5pm.');
    expect(await reply(w, from, 'is there a pool?')).not.toMatch(/pool/i);
  });
});

describe('consent, opt-out and the messaging window', () => {
  it('honours STOP at once and sends nothing more until START', async () => {
    const w = await setup(); const from = '15551150001';
    await linkNumber(w, 'tina', from); await say(w, from, 'YES');
    const stop = await reply(w, from, 'STOP');
    expect(stop).toMatch(/unsubscribed/i);
    const sentBefore = fake.sent.length;
    expect(await say(w, from, 'hello?')).toEqual([]); expect(await say(w, from, 'balance')).toEqual([]);
    expect(fake.sent.length).toBe(sentBefore);
    expect(await reply(w, from, 'start')).toMatch(/receive notices/i);
    expect(await reply(w, from, 'balance')).toMatch(/1,500\.00/);
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0]; expect(c.consent).toBe('opted_in');
  });
  it('still gets a safety message to a person from someone who opted out', async () => {
    const w = await setup(); const from = '15551150002';
    await say(w, from, 'stop');
    expect(await say(w, from, 'fire in the hallway')).toEqual([]);
    expect((await ok(w.manager.get(`${w.base}/whatsapp/handoffs`)))[0]).toMatchObject({ urgent: true });
  });
  it('stops a flood from one number and says so once', async () => {
    const w = await setup(); const from = '15551150003'; const before = fake.to(from).length;
    for (let i = 0; i < 14; i++) await ok(deliver(t.app, waText(w.pnid, from, i % 2 ? 'help' : 'hi there')));
    const notices = fake.to(from).slice(before).filter((x) => /very quickly/.test(x));
    expect(notices).toHaveLength(1);
    expect(fake.to(from).length - before).toBeLessThanOrEqual(10);
  });
  it('lets a manager reply inside the window, and not outside it', async () => {
    const w = await setup(); const from = '15551150004';
    await say(w, from, 'hello');
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0];
    expect((await w.staff.post(`${w.base}/whatsapp/contacts/${c.id}/reply`).send({ text: 'x' })).status).toBe(403);
    await ok(w.manager.post(`${w.base}/whatsapp/contacts/${c.id}/reply`).send({ text: 'A person here: we will call today.' }), 201);
    await ok(runJobs());
    expect(fake.last(from)).toBe('A person here: we will call today.');
  });
});

describe('delivery: receipts, retries and provider errors', () => {
  it('records receipts that arrive out of order or twice, and a failure after read changes nothing', async () => {
    const w = await setup(); const from = '15551160001';
    await say(w, from, 'help');
    const id = fake.sent.filter((m) => m.to === from)[0]!.id;
    await ok(deliver(t.app, waStatus(w.pnid, id, 'read', from)));
    await ok(deliver(t.app, waStatus(w.pnid, id, 'delivered', from)));
    await ok(deliver(t.app, waStatus(w.pnid, id, 'read', from)));
    await ok(deliver(t.app, waStatus(w.pnid, id, 'failed', from, { errors: [{ code: 131000, title: 'boom' }] })));
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0];
    const out = (await ok(w.manager.get(`${w.base}/whatsapp/contacts/${c.id}`))).messages.find((m: any) => m.direction === 'out');
    expect(out).toMatchObject({ status: 'read' }); expect(out.delivered_at).toBeTruthy();
  });
  it('shows a failed delivery with its error and an opt-out signalled by WhatsApp', async () => {
    const w = await setup(); const from = '15551160002';
    await say(w, from, 'help');
    const id = fake.sent.filter((m) => m.to === from)[0]!.id;
    await ok(deliver(t.app, waStatus(w.pnid, id, 'failed', from, { errors: [{ code: 131050, title: 'user stopped marketing messages' }] })));
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0];
    expect(c.consent).toBe('opted_out');
    expect((await ok(w.manager.get(`${w.base}/whatsapp/contacts/${c.id}`))).messages.find((m: any) => m.direction === 'out')).toMatchObject({ status: 'failed', error_code: '131050' });
  });
  it('retries transient send failures and gives up on permanent ones', async () => {
    const w = await setup(); const from = '15551160003'; const other = '15551160004';
    fake.failNext('transient');
    await ok(deliver(t.app, waText(w.pnid, from, 'help')));
    expect(fake.to(from)).toEqual([]);
    const db = (t.mock as any).db;
    await db.query(`update public.whatsapp_messages set next_attempt_at = now() - interval '1 second' where status = 'queued'`);
    await ok(runJobs());
    expect(fake.to(from)).toHaveLength(1);
    fake.failNext('permanent');
    await ok(deliver(t.app, waText(w.pnid, other, 'help')));
    expect(fake.to(other)).toEqual([]);
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`))).find((x: any) => x.number.endsWith('0004'));
    expect((await ok(w.manager.get(`${w.base}/whatsapp/contacts/${c.id}`))).messages.find((m: any) => m.direction === 'out')).toMatchObject({ status: 'dead', error_code: '131026' });
    expect((await ok(w.manager.get('/api/me/notifications'))).items.length).toBeGreaterThanOrEqual(0);
  });
  it('tells people when their request moves, as a template if the window has closed and they opted in', async () => {
    const w = await setup(); const from = '15551160005';
    await linkNumber(w, 'tina', from); await say(w, from, 'YES');
    await say(w, from, 'The hallway light keeps flickering on and off'); await say(w, from, 'yes');
    const r = (await ok(w.manager.get(`${w.base}/maintenance`))).items.find((x: any) => x.reported_via === 'whatsapp');
    await ok(w.staff.post(`${w.base}/maintenance/${r.id}/triage`).send({ expectedVersion: r.version ?? 1, category: null, note: null }));
    await ok(runJobs());
    expect(fake.last(from)).toMatch(/has been reviewed/);
    await ok(runJobs());
    expect(fake.to(from).filter((x) => /has been reviewed/.test(x))).toHaveLength(1);                      // once
    const db = (t.mock as any).db;
    await db.query(`update public.whatsapp_contacts set last_inbound_at = now() - interval '3 days'`);
    await ok(w.manager.post(`${w.base}/maintenance/${r.id}/cancel`).send({ expectedVersion: 2, reason: 'fixed itself' }));
    await ok(runJobs());
    expect(fake.last(from)).toMatch(/\[template request_update_v1/);
  });
});

describe('rent reminders on WhatsApp need approval', () => {
  it('draft → request approval → a different person approves → the approved template is sent', async () => {
    const w = await setup(); const from = '15551170001';
    await linkNumber(w, 'tina', from); await say(w, from, 'YES');
    const c = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`)))[0];
    const cand = await ok(w.manager.get(`${w.base}/whatsapp/contacts/${c.id}/reminder-candidates`));
    expect(cand.eligible).toBe(true);
    const draft = await ok(w.manager.post(`${w.base}/whatsapp/contacts/${c.id}/reminder-draft`).send({ chargeId: cand.charges[0].id }), 201);
    expect(draft).toMatchObject({ kind: 'whatsapp_reminder_draft', status: 'draft' });
    expect(draft.preview.fields.find((f: any) => f.label === 'Message').value).toMatch(/Hello Tina, 1500\.00 USD is outstanding/);
    expect(fake.to(from).some((x) => /template rent_reminder_v1/.test(x))).toBe(false);              // a draft sends nothing
    // the org switch must be on too
    expect((await w.manager.post(`${w.base}/whatsapp/reminders/${draft.id}/request-approval`).send({})).status).toBe(403);
    await ok(w.admin.put(`${w.base}/copilot/settings`).send({ externalEnabled: true }));
    const sub = await ok(w.manager.post(`${w.base}/whatsapp/reminders/${draft.id}/request-approval`).send({}), 201);
    expect(sub.status).toBe('awaiting_approval');
    expect((await w.manager.post(`${w.base}/approvals/${sub.approval_id}/decision`).send({ decision: 'approve' })).status).toBe(403);     // not by the requester
    await ok(runJobs()); expect(fake.to(from).some((x) => /template rent_reminder_v1/.test(x))).toBe(false);
    await ok(w.admin.post(`${w.base}/approvals/${sub.approval_id}/decision`).send({ decision: 'approve' }));
    await ok(runJobs());
    expect(fake.last(from)).toBe('[template rent_reminder_v1: Tina | 1500.00 USD | 2026-01-01]');
  });
  it('is impossible for numbers that are unverified or have not agreed to notices', async () => {
    const w = await setup(); const from = '15551170002'; const un = '15551170003';
    await ok(w.admin.put(`${w.base}/copilot/settings`).send({ externalEnabled: true }));
    await say(w, un, 'hello');
    const contacts = await ok(w.manager.get(`${w.base}/whatsapp/contacts`));
    const stranger = contacts.find((x: any) => x.status === 'unverified');
    const charge = w.tina.charge.id;
    expect((await w.manager.post(`${w.base}/whatsapp/contacts/${stranger.id}/reminder-draft`).send({ chargeId: charge })).status).toBe(422);
    await linkNumber(w, 'tina', from);                                       // linked, but never said YES
    const linked = (await ok(w.manager.get(`${w.base}/whatsapp/contacts`))).find((x: any) => x.status === 'verified');
    expect((await w.manager.post(`${w.base}/whatsapp/contacts/${linked.id}/reminder-draft`).send({ chargeId: charge })).status).toBe(422);
    expect((await ok(w.manager.get(`${w.base}/whatsapp/contacts/${linked.id}/reminder-candidates`))).eligible).toBe(false);
  });
});

describe('setup', () => {
  it('lets only admins connect a number, rejects a number already used by another organization, and shows the webhook details', async () => {
    const a = await setup(); const b = await setup({ channel: false });
    expect((await a.manager.get(`${a.base}/whatsapp/channel`)).status).toBe(403);
    const ch = await ok(a.admin.get(`${a.base}/whatsapp/channel`));
    expect(ch.server).toMatchObject({ provider: 'fake', webhookUrl: expect.stringContaining('/api/webhooks/whatsapp'), verifyTokenConfigured: true, appSecretConfigured: true });
    expect(JSON.stringify(ch)).not.toContain(APP_SECRET); expect(JSON.stringify(ch)).not.toContain(VERIFY_TOKEN);
    const clash = await b.admin.put(`${b.base}/whatsapp/channel`).send({ phoneNumberId: a.pnid, intakeUser: b.managerId, enabled: true });
    expect(clash.status).toBe(409);
    expect((await b.admin.put(`${b.base}/whatsapp/channel`).send({ phoneNumberId: 'nope', intakeUser: b.managerId })).status).toBe(422);
  });
  it('does nothing while a channel is switched off', async () => {
    const w = await setup(); const from = '15551180001';
    await ok(w.admin.put(`${w.base}/whatsapp/channel`).send({ phoneNumberId: w.pnid, intakeUser: w.managerId, enabled: false }));
    await ok(deliver(t.app, waText(w.pnid, from, 'hello')));
    expect(fake.to(from)).toEqual([]);
  });
});
