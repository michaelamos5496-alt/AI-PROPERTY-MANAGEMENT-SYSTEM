import { Router, type RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from '../lib/errors.js';
import type { Role } from '../lib/roles.js';
import { uuid, validate } from '../lib/validate.js';
import { requireOrgRole } from '../middleware/auth.js';
import type { DataApi } from '../services/supabase.js';

const snake = (k: string) => k.replace(/([A-Z])/g, '_$1').toLowerCase();
export const prefixed = (o: object = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`p_${snake(k)}`, v]));

/** Declarative description of one endpoint that maps 1:1 onto a Postgres function. */
export interface Def {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  /** Minimum role, checked first (fast fail); the database re-checks it. */
  min: Role;
  fn: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  extra?: Record<string, unknown>;
  status?: number;
  /** Requires an Idempotency-Key header, forwarded as p_idempotency_key. A replayed result returns 200. */
  idempotent?: boolean;
  /**
   * 'org' (default): path is under /organizations/:orgId, caller must be a member with at least `min`.
   * 'portal': path contains :orgId but the caller is NOT a member (a verified tenant); the database function decides access.
   * 'user': no organization; acts on the signed-in user's own data.
   */
  scope?: 'org' | 'portal' | 'user';
}

export interface MountOptions {
  /** Called after a successful write (e.g. to flush the email queue right away). Must never throw into the request. */
  afterWrite?: (def: Def) => Promise<void>;
}

const KEY = /^[A-Za-z0-9_-]{8,80}$/;

export const idempotencyKey = (header: string | undefined): string => {
  if (!header || !KEY.test(header)) {
    throw AppError.badRequest('An Idempotency-Key header (8-80 letters, digits, - or _) is required for this request.');
  }
  return header;
};

/** Mounts each def: org-role gate -> validation -> RPC as the signed-in user. Params must be UUIDs. */
export function mountDefs(r: Router, defs: Def[], data: DataApi, opts: MountOptions = {}): void {
  for (const d of defs) {
    const scope = d.scope ?? 'org';
    const handlers: RequestHandler[] = [
      ...(scope === 'org' ? [requireOrgRole(data, d.min)] : []),
      validate({
        params: z.object(Object.fromEntries([...d.path.matchAll(/:(\w+)/g)].map((m) => [m[1]!, uuid]))).passthrough(),
        ...(d.body ? { body: d.body } : {}), ...(d.query ? { query: d.query } : {}),
      }),
      async (req, res) => {
        const { orgId, ...ids } = req.params as Record<string, string>;
        const args: Record<string, unknown> = { ...prefixed(ids), ...prefixed(req.body), ...prefixed(req.query as object), ...prefixed(d.extra) };
        if (scope === 'org') args.p_org = req.org!.id;
        else if (scope === 'portal') args.p_org = orgId;
        if (d.idempotent) args.p_idempotency_key = idempotencyKey(req.get('idempotency-key'));
        const out = await data.rpc<any>(req.auth!.token, d.fn, args);
        if (d.method !== 'get' && opts.afterWrite) await opts.afterWrite(d).catch((e) => req.log.warn('after-write hook failed', { error: String(e) }));
        // A function can report a handled-but-unsuccessful outcome ({ ok: false }): that is a conflict, not a success.
        res.status(out?.ok === false ? 409 : out?.replayed === true ? 200 : d.status ?? 200).json(out);
      },
    ];
    r[d.method](d.path, ...handlers);
  }
}
