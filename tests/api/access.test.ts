import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(() => t.close());

async function org(c: ReturnType<TestApp['client']>, name: string) {
  const r = await c.post('/api/organizations').send({ name });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const invite = async (owner: ReturnType<TestApp['client']>, orgId: string, email: string, role: string) => {
  const r = await owner.post(`/api/organizations/${orgId}/invitations`).send({ email, role });
  expect(r.status).toBe(201);
  return (r.body.inviteUrl as string).split('token=')[1]!;
};

describe('registration, session and organization workspace', () => {
  it('registers, creates an org, and reaches its workspace', async () => {
    const { c } = await t.signUp();
    const id = await org(c, 'Maple Court Apartments');
    const ws = await c.get(`/api/organizations/${id}/workspace`);
    expect(ws.status).toBe(200);
    expect(ws.body).toMatchObject({ role: 'owner', memberCount: 1 });
    expect(ws.body.permissions).toContain('members:manage');
    const me = await c.get('/api/me');
    expect(me.body.memberships[0]).toMatchObject({ org_id: id, role: 'owner' });
  });

  it('sets HttpOnly cookies and never returns tokens in bodies', async () => {
    const c = t.client();
    const r = await c.post('/api/auth/register').send({ email: 'cookie@test.dev', password: 'correct horse battery' });
    const cookies = (r.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/pai_at=.*HttpOnly/);
    expect(cookies).toMatch(/pai_rt=.*Path=\/api\/auth.*HttpOnly/);
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
  });

  it('logs in, logs out, and the session stops working', async () => {
    await t.signUp('cycle@test.dev');
    const c = t.client();
    expect((await c.post('/api/auth/login').send({ email: 'cycle@test.dev', password: 'wrong password!!' })).status).toBe(401);
    expect((await c.post('/api/auth/login').send({ email: 'cycle@test.dev', password: 'correct horse battery' })).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(200);
    expect((await c.post('/api/auth/logout').send({})).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(401);
  });

  it('silently renews an expired access token using the refresh cookie', async () => {
    await t.signUp('renew@test.dev');
    const login = await t.client().post('/api/auth/login').send({ email: 'renew@test.dev', password: 'correct horse battery' });
    const rt = (login.headers['set-cookie'] as unknown as string[]).find((s) => s.startsWith('pai_rt='))!;
    const r = await supertest(t.app).get('/api/me').set('Cookie', [rt, 'pai_at=expired']);
    expect(r.status).toBe(200);
    expect((r.headers['set-cookie'] as unknown as string[]).some((s) => s.startsWith('pai_at='))).toBe(true);
  });
  it('rejects a forged access token with no refresh cookie', async () => {
    expect((await supertest(t.app).get('/api/me').set('Cookie', ['pai_at=forged'])).status).toBe(401);
  });
});

describe('authentication required', () => {
  it.each([
    ['get', '/api/me'], ['post', '/api/organizations'],
    ['get', '/api/organizations/00000000-0000-4000-8000-000000000000/workspace'],
  ])('%s %s returns 401 without a session', async (m, path) => {
    const r = await (t.client() as any)[m](path).send({ name: 'x' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });
});

describe('tenant isolation by changing request parameters', () => {
  it('an unaffiliated user cannot read, list, edit or invite into another organization', async () => {
    const owner = await t.signUp();
    const orgId = await org(owner.c, 'Private Holdings');
    const { c: intruder } = await t.signUp();
    await org(intruder, 'Intruder Co');
    const base = `/api/organizations/${orgId}`;

    for (const [method, path, body] of [
      ['get', base], ['get', `${base}/workspace`], ['get', `${base}/members`], ['get', `${base}/invitations`],
      ['patch', base, { name: 'Taken Over' }],
      ['post', `${base}/invitations`, { email: 'x@y.test', role: 'admin' }],
    ] as const) {
      const r = await (intruder as any)[method](path).send(body ?? {});
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('Private Holdings');
    }
    // and the owner's data is untouched
    expect((await owner.c.get(base)).body.name).toBe('Private Holdings');
  });

  it('cannot change roles or remove members of another organization', async () => {
    const owner = await t.signUp();
    const orgId = await org(owner.c, 'Owner Org');
    const me = (await owner.c.get('/api/me')).body.profile.id;
    const { c: intruder } = await t.signUp();
    expect((await intruder.patch(`/api/organizations/${orgId}/members/${me}`).send({ role: 'viewer' })).status).toBe(404);
    expect((await intruder.delete(`/api/organizations/${orgId}/members/${me}`)).status).toBe(404);
    expect((await owner.c.get(`/api/organizations/${orgId}/members`)).body).toHaveLength(1);
  });

  it('malformed organization ids are rejected without reaching the database', async () => {
    const { c } = await t.signUp();
    expect((await c.get('/api/organizations/not-a-uuid')).status).toBe(422);
  });
});

describe('role-based access to protected endpoints', () => {
  it('permits what each role may do and denies the rest', async () => {
    const owner = await t.signUp();
    const orgId = await org(owner.c, 'Role Test Org');
    const base = `/api/organizations/${orgId}`;
    const people = {} as Record<string, Awaited<ReturnType<TestApp['signUp']>>>;

    for (const role of ['admin', 'manager', 'staff', 'viewer'] as const) {
      people[role] = await t.signUp();
      const token = await invite(owner.c, orgId, people[role].email, role);
      expect((await people[role].c.post('/api/invitations/accept').send({ token })).status).toBe(200);
    }

    const expectStatus = async (who: string, method: string, path: string, body: object, status: number) => {
      const r = await (people[who]!.c as any)[method](path).send(body);
      expect(r.status, `${who} ${method} ${path}`).toBe(status);
    };

    // everyone in the org can read the workspace and members
    for (const who of Object.keys(people)) {
      await expectStatus(who, 'get', `${base}/workspace`, {}, 200);
      await expectStatus(who, 'get', `${base}/members`, {}, 200);
    }
    // only admin+ may rename the org or manage invitations
    await expectStatus('admin', 'patch', base, { name: 'Renamed By Admin' }, 200);
    for (const who of ['manager', 'staff', 'viewer']) {
      await expectStatus(who, 'patch', base, { name: 'Nope Nope' }, 403);
      await expectStatus(who, 'get', `${base}/invitations`, {}, 403);
      await expectStatus(who, 'post', `${base}/invitations`, { email: 'z@z.test', role: 'viewer' }, 403);
    }
    await expectStatus('admin', 'get', `${base}/invitations`, {}, 200);

    // an admin cannot grant owner or demote the owner; the owner can promote
    const ownerId = (await owner.c.get('/api/me')).body.profile.id;
    const adminId = (await people.admin!.c.get('/api/me')).body.profile.id;
    const viewerId = (await people.viewer!.c.get('/api/me')).body.profile.id;
    await expectStatus('admin', 'patch', `${base}/members/${adminId}`, { role: 'owner' }, 403);
    await expectStatus('admin', 'patch', `${base}/members/${ownerId}`, { role: 'viewer' }, 403);
    await expectStatus('admin', 'delete', `${base}/members/${ownerId}`, {}, 403);
    await expectStatus('manager', 'patch', `${base}/members/${viewerId}`, { role: 'staff' }, 403);
    await expectStatus('admin', 'patch', `${base}/members/${viewerId}`, { role: 'staff' }, 200);

    // the sole owner cannot be demoted or removed
    expect((await owner.c.patch(`${base}/members/${ownerId}`).send({ role: 'admin' })).status).toBe(409);
    expect((await owner.c.delete(`${base}/members/${ownerId}`)).status).toBe(409);

    // anyone may leave
    await expectStatus('staff', 'delete', `${base}/members/${(await people.staff!.c.get('/api/me')).body.profile.id}`, {}, 200);
    await expectStatus('staff', 'get', `${base}/workspace`, {}, 404);
  });
});

describe('invitations', () => {
  it('rejects tokens used by the wrong account, and reuse', async () => {
    const owner = await t.signUp();
    const orgId = await org(owner.c, 'Invite Org');
    const invited = await t.signUp();
    const other = await t.signUp();
    const token = await invite(owner.c, orgId, invited.email, 'staff');
    expect((await other.c.post('/api/invitations/accept').send({ token })).status).toBe(404);
    expect((await invited.c.post('/api/invitations/accept').send({ token })).status).toBe(200);
    expect((await invited.c.post('/api/invitations/accept').send({ token })).status).toBe(404);
  });
});

describe('account recovery', () => {
  it('emails a link, lets the user set a new password, and the new password works', async () => {
    await t.signUp('recover@test.dev');
    const c = t.client();
    expect((await c.post('/api/auth/recover').send({ email: 'recover@test.dev' })).status).toBe(202);
    // unknown addresses get the same answer (no account enumeration)
    expect((await c.post('/api/auth/recover').send({ email: 'ghost@test.dev' })).status).toBe(202);
    const tokenHash = t.mock.lastToken('recover@test.dev', 'recovery')!;
    const confirm = await c.get(`/api/auth/confirm?token_hash=${tokenHash}&type=recovery`);
    expect(confirm.status).toBe(303);
    expect(confirm.headers.location).toBe('/reset-password');
    expect((await c.post('/api/auth/password').send({ password: 'a brand new passphrase' })).status).toBe(200);
    const fresh = t.client();
    expect((await fresh.post('/api/auth/login').send({ email: 'recover@test.dev', password: 'a brand new passphrase' })).status).toBe(200);
    // links are single use
    const again = await t.client().get(`/api/auth/confirm?token_hash=${tokenHash}&type=recovery`);
    expect(again.headers.location).toBe('/login?error=link_expired');
  });

  it('requires a session to change a password', async () => {
    expect((await t.client().post('/api/auth/password').send({ password: 'a brand new passphrase' })).status).toBe(401);
  });
});
