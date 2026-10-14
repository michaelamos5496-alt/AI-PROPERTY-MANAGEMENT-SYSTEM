import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Env } from '../lib/env.js';
import { PERMISSIONS, ROLES, can } from '../lib/roles.js';
import { email, orgName, uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import type { DataApi } from '../services/supabase.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const role = z.enum(ROLES);
const orgParam = z.object({ orgId: uuid });

/** Mounted at /api (after requireAuth). */
export function orgRoutes(env: Env, data: DataApi): Router {
  const r = Router();
  const tok = (req: { auth?: { token: string } }) => req.auth!.token;

  r.get('/me', async (req, res) => res.json(await data.rpc(tok(req), 'get_me')));

  r.patch('/me', validate({ body: z.object({ fullName: z.string().trim().max(120) }) }), async (req, res) =>
    res.json(await data.rpc(tok(req), 'update_profile', { p_full_name: req.body.fullName })));

  r.post('/organizations', validate({ body: z.object({ name: orgName }) }), async (req, res) =>
    res.status(201).json(await data.rpc(tok(req), 'create_organization', { p_name: req.body.name })));

  r.post('/invitations/accept', validate({ body: z.object({ token: z.string().min(20).max(200) }) }), async (req, res) =>
    res.json(await data.rpc(tok(req), 'accept_invitation', { p_token_hash: sha256(req.body.token) })));

  const org = Router({ mergeParams: true });
  r.use('/organizations/:orgId', validate({ params: orgParam }), org);

  org.get('/', requireOrgRole(data, 'viewer'), async (req, res) =>
    res.json(await data.rpc(tok(req), 'get_organization', { p_org: req.org!.id })));

  org.get('/workspace', requireOrgRole(data, 'viewer'), async (req, res) => {
    const [organization, members] = await Promise.all([
      data.rpc<Record<string, unknown>>(tok(req), 'get_organization', { p_org: req.org!.id }),
      data.rpc<unknown[]>(tok(req), 'list_members', { p_org: req.org!.id }),
    ]);
    const permissions = Object.keys(PERMISSIONS).filter((p) => can(req.org!.role, p as keyof typeof PERMISSIONS));
    res.json({ organization, role: req.org!.role, permissions, memberCount: members.length });
  });

  org.patch('/', requireOrgRole(data, 'admin'), validate({ body: z.object({ name: orgName }) }), async (req, res) =>
    res.json(await data.rpc(tok(req), 'update_organization', { p_org: req.org!.id, p_name: req.body.name })));

  org.get('/members', requireOrgRole(data, 'viewer'), async (req, res) =>
    res.json(await data.rpc(tok(req), 'list_members', { p_org: req.org!.id })));

  org.patch('/members/:userId', requireOrgRole(data, 'admin'),
    validate({ params: orgParam.extend({ userId: uuid }), body: z.object({ role }) }), async (req, res) =>
      res.json(await data.rpc(tok(req), 'change_member_role',
        { p_org: req.org!.id, p_user: req.params.userId, p_role: req.body.role })));

  // Minimum is 'viewer' so anyone can leave; the database restricts removing *others* to admins.
  org.delete('/members/:userId', requireOrgRole(data, 'viewer'),
    validate({ params: orgParam.extend({ userId: uuid }) }), async (req, res) =>
      res.json(await data.rpc(tok(req), 'remove_member', { p_org: req.org!.id, p_user: req.params.userId })));

  org.get('/invitations', requireOrgRole(data, 'admin'), async (req, res) =>
    res.json(await data.rpc(tok(req), 'list_invitations', { p_org: req.org!.id })));

  org.post('/invitations', requireOrgRole(data, 'admin'),
    validate({ body: z.object({ email, role: role.exclude(['owner']) }) }), async (req, res) => {
      const token = randomBytes(32).toString('base64url');
      const invitation = await data.rpc<{ id: string }>(tok(req), 'create_invitation', {
        p_org: req.org!.id, p_email: req.body.email, p_role: req.body.role, p_token_hash: sha256(token),
      });
      // The token travels in the URL fragment so it is never sent to servers, logs or referrers.
      res.status(201).json({ invitation, inviteUrl: `${env.APP_URL}/invite#token=${token}` });
    });

  org.delete('/invitations/:id', requireOrgRole(data, 'admin'),
    validate({ params: orgParam.extend({ id: uuid }) }), async (req, res) =>
      res.json(await data.rpc(tok(req), 'revoke_invitation', { p_org: req.org!.id, p_id: req.params.id })));

  return r;
}

