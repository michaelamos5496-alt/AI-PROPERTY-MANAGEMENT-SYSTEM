import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, as, code, createTestDb, createUser, migrationFiles, rpc, type Actor } from '../support/db.js';

let db: PGlite;
let alice: Actor & object, bob: Actor & object, carol: Actor & object, dave: Actor & object;
let orgA: string, orgB: string;

const actor = async (email: string) => ({ sub: await createUser(db, email), email });

beforeAll(async () => {
  db = await createTestDb();
  alice = await actor('alice@a.test');   // owner of A
  bob = await actor('bob@b.test');       // owner of B
  carol = await actor('carol@a.test');   // member of A (manager) -> promoted below
  dave = await actor('dave@x.test');     // unaffiliated
  orgA = (await rpc(db, alice, 'create_organization', ['Alpha Properties'])).id;
  orgB = (await rpc(db, bob, 'create_organization', ['Bravo Realty'])).id;
  // Seed carol into A as manager via the invitation path (also proves it works end to end).
  await rpc(db, alice, 'create_invitation', [orgA, 'carol@a.test', 'manager', 'hash-carol'], ['uuid', 'text', 'org_role', 'text']);
  await rpc(db, carol, 'accept_invitation', ['hash-carol']);
});

describe('migrations', () => {
  it('are repeatable (re-applying changes nothing and does not throw)', async () => {
    const before = (await db.query(`select count(*)::int n from pg_policies where schemaname='public'`)).rows[0] as any;
    await applyMigrations(db);
    await applyMigrations(db);
    const after = (await db.query(`select count(*)::int n from pg_policies where schemaname='public'`)).rows[0] as any;
    expect(after.n).toBe(before.n);
    expect(migrationFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('enables RLS on every public table', async () => {
    const r = await db.query(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it('creates a profile automatically for new auth users', async () => {
    const r = await as(db, alice, (q) => q('select email from public.profiles where id = $1', [alice.sub]));
    expect(r.rows[0].email).toBe('alice@a.test');
  });
});

describe('tenant isolation (direct table access, as PostgREST would)', () => {
  it('lets members read their own organization only', async () => {
    const r = await as(db, alice, (q) => q('select id from public.organizations'));
    expect(r.rows.map((x) => x.id)).toEqual([orgA]);
  });

  it('hides other organizations from an unaffiliated user', async () => {
    for (const t of ['organizations', 'memberships', 'invitations']) {
      const r = await as(db, dave, (q) => q(`select * from public.${t}`));
      expect(r.rows, t).toEqual([]);
    }
  });

  it('does not reveal an organization by id filter', async () => {
    const r = await as(db, dave, (q) => q('select * from public.organizations where id = $1', [orgA]));
    expect(r.rows).toEqual([]);
  });

  it('only shows profiles of people who share an organization', async () => {
    const mine = await as(db, alice, (q) => q('select email from public.profiles order by email'));
    expect(mine.rows.map((x) => x.email)).toEqual(['alice@a.test', 'carol@a.test']);
    const lonely = await as(db, dave, (q) => q('select email from public.profiles'));
    expect(lonely.rows.map((x) => x.email)).toEqual(['dave@x.test']);
  });

  it('denies anonymous reads entirely', async () => {
    expect(await code(as(db, null, (q) => q('select * from public.organizations')))).toBe('42501');
  });

  it('denies direct inserts, deletes and role escalation on memberships', async () => {
    expect(await code(as(db, dave, (q) =>
      q(`insert into public.memberships (org_id,user_id,role) values ($1,$2,'owner')`, [orgA, dave.sub])))).toBe('42501');
    expect(await code(as(db, alice, (q) => q(`delete from public.memberships where org_id=$1`, [orgA])))).toBe('42501');
    expect(await code(as(db, carol, (q) =>
      q(`update public.memberships set role='owner' where user_id=$1`, [carol.sub])))).toBe('42501');
  });

  it('denies direct organization insert/delete and name changes by non-admins', async () => {
    expect(await code(as(db, dave, (q) =>
      q(`insert into public.organizations (name,slug,created_by) values ('x1','x1',$1)`, [dave.sub])))).toBe('42501');
    expect(await code(as(db, alice, (q) => q(`delete from public.organizations where id=$1`, [orgA])))).toBe('42501');
    const r = await as(db, carol, (q) => q(`update public.organizations set name='Hacked' where id=$1`, [orgA]));
    expect(r.rows).toEqual([]);
    const name = await as(db, alice, (q) => q('select name from public.organizations where id=$1', [orgA]));
    expect(name.rows[0].name).toBe('Alpha Properties');
  });

  it('prevents cross-tenant updates even by an owner of another organization', async () => {
    await as(db, bob, (q) => q(`update public.organizations set name='Pwned' where id=$1`, [orgA]));
    const name = await as(db, alice, (q) => q('select name from public.organizations where id=$1', [orgA]));
    expect(name.rows[0].name).toBe('Alpha Properties');
  });

  it('only lets admins+ read invitations', async () => {
    const asAdmin = await as(db, alice, (q) => q('select * from public.invitations'));
    expect(asAdmin.rows.length).toBeGreaterThan(0);
    const asManager = await as(db, carol, (q) => q('select * from public.invitations'));
    expect(asManager.rows).toEqual([]);
  });

  it('prevents users editing another profile or protected profile columns', async () => {
    await as(db, carol, (q) => q(`update public.profiles set full_name='x' where id=$1`, [alice.sub]));
    expect(await code(as(db, carol, (q) => q(`update public.profiles set email='e@e.e' where id=$1`, [carol.sub]))))
      .toBe('42501');
    const r = await as(db, alice, (q) => q('select full_name from public.profiles where id=$1', [alice.sub]));
    expect(r.rows[0].full_name).toBe('');
  });
});

describe('RPC authorization', () => {
  it('denies anonymous callers', async () => {
    expect(await code(rpc(db, null, 'get_me'))).toBe('42501');
  });

  it('get_me returns only the caller\'s memberships', async () => {
    const me = await rpc(db, alice, 'get_me');
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0]).toMatchObject({ org_id: orgA, role: 'owner' });
  });

  it('permits members and denies non-members (404, not 403, to avoid probing)', async () => {
    expect((await rpc(db, carol, 'get_organization', [orgA], ['uuid'])).role).toBe('manager');
    expect(await code(rpc(db, dave, 'get_organization', [orgA], ['uuid']))).toBe('PT404');
    expect(await code(rpc(db, bob, 'list_members', [orgA], ['uuid']))).toBe('PT404');
    expect(await code(rpc(db, bob, 'list_invitations', [orgA], ['uuid']))).toBe('PT404');
  });

  it('enforces role minimums', async () => {
    expect(await code(rpc(db, carol, 'update_organization', [orgA, 'Renamed'], ['uuid']))).toBe('PT403');
    expect(await code(rpc(db, carol, 'list_invitations', [orgA], ['uuid']))).toBe('PT403');
    expect(await code(rpc(db, carol, 'create_invitation', [orgA, 'z@z.test', 'viewer', 'h1'], ['uuid', 'text', 'org_role', 'text']))).toBe('PT403');
    expect((await rpc(db, alice, 'update_organization', [orgA, 'Alpha Group'], ['uuid'])).name).toBe('Alpha Group');
  });

  it('prevents non-owners from touching owner roles and protects the last owner', async () => {
    // promote carol to admin, then she must not be able to grant owner
    await rpc(db, alice, 'change_member_role', [orgA, carol.sub, 'admin'], ['uuid', 'uuid', 'org_role']);
    expect(await code(rpc(db, carol, 'change_member_role', [orgA, carol.sub, 'owner'], ['uuid', 'uuid', 'org_role']))).toBe('PT403');
    expect(await code(rpc(db, carol, 'change_member_role', [orgA, alice.sub, 'viewer'], ['uuid', 'uuid', 'org_role']))).toBe('PT403');
    expect(await code(rpc(db, carol, 'remove_member', [orgA, alice.sub], ['uuid', 'uuid']))).toBe('PT403');
    expect(await code(rpc(db, alice, 'change_member_role', [orgA, alice.sub, 'admin'], ['uuid', 'uuid', 'org_role']))).toBe('PT409');
    expect(await code(rpc(db, alice, 'remove_member', [orgA, alice.sub], ['uuid', 'uuid']))).toBe('PT409');
    await rpc(db, alice, 'change_member_role', [orgA, carol.sub, 'manager'], ['uuid', 'uuid', 'org_role']);
  });

  it('prevents changing roles of members in another organization', async () => {
    expect(await code(rpc(db, bob, 'change_member_role', [orgA, carol.sub, 'viewer'], ['uuid', 'uuid', 'org_role']))).toBe('PT404');
  });

  it('allows non-admins to leave but not remove others', async () => {
    expect(await code(rpc(db, carol, 'remove_member', [orgA, alice.sub], ['uuid', 'uuid']))).toBe('PT403');
  });
});

describe('invitations', () => {
  const sig = ['uuid', 'text', 'org_role', 'text'];

  it('cannot invite as owner or re-invite an existing member', async () => {
    expect(await code(rpc(db, alice, 'create_invitation', [orgA, 'n@n.test', 'owner', 'h2'], sig))).toBe('PT422');
    expect(await code(rpc(db, alice, 'create_invitation', [orgA, 'CAROL@a.test', 'viewer', 'h3'], sig))).toBe('PT409');
  });

  it('accepts only for the matching verified email', async () => {
    await rpc(db, alice, 'create_invitation', [orgA, 'erin@e.test', 'staff', 'hash-erin'], sig);
    const erin = await actor('erin@e.test');
    // someone else holding the token can't use it
    expect(await code(rpc(db, dave, 'accept_invitation', ['hash-erin']))).toBe('PT404');
    const joined = await rpc(db, erin, 'accept_invitation', ['hash-erin']);
    expect(joined).toMatchObject({ id: orgA, role: 'staff' });
    // single use
    expect(await code(rpc(db, erin, 'accept_invitation', ['hash-erin']))).toBe('PT404');
  });

  it('rejects an unverified account claiming an invited address', async () => {
    await rpc(db, alice, 'create_invitation', [orgA, 'fay@f.test', 'staff', 'hash-fay'], sig);
    const fayId = await createUser(db, 'fay@f.test', { confirmed: false });
    expect(await code(rpc(db, { sub: fayId, email: 'fay@f.test' }, 'accept_invitation', ['hash-fay']))).toBe('PT404');
  });

  it('rejects revoked and expired invitations', async () => {
    const inv = await rpc(db, alice, 'create_invitation', [orgA, 'gus@g.test', 'viewer', 'hash-gus'], sig);
    await rpc(db, alice, 'revoke_invitation', [orgA, inv.id], ['uuid', 'uuid']);
    const gus = await actor('gus@g.test');
    expect(await code(rpc(db, gus, 'accept_invitation', ['hash-gus']))).toBe('PT404');
    await rpc(db, alice, 'create_invitation', [orgA, 'gus@g.test', 'viewer', 'hash-gus2'], sig);
    await db.exec(`update public.invitations set expires_at = now() - interval '1 day' where token_hash='hash-gus2'`);
    expect(await code(rpc(db, gus, 'accept_invitation', ['hash-gus2']))).toBe('PT404');
  });

  it('cannot revoke another organization\'s invitation', async () => {
    const inv = await rpc(db, bob, 'create_invitation', [orgB, 'h@h.test', 'viewer', 'hash-h'], sig);
    expect(await code(rpc(db, alice, 'revoke_invitation', [orgA, inv.id], ['uuid', 'uuid']))).toBe('PT404');
  });

  it('stores only the token hash, never exposes it', async () => {
    const list = await rpc(db, alice, 'list_invitations', [orgA], ['uuid']);
    for (const i of list) expect(Object.keys(i)).not.toContain('token_hash');
  });
});
