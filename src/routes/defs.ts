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
  method: 'get' | 'post' | 'patch' | 'delete';
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
}

const KEY = /^[A-Za-z0-9_-]{8,80}$/;

export const idempotencyKey = (header: string | undefined): string => {
  if (!header || !KEY.test(header)) {
    throw AppError.badRequest('An Idempotency-Key header (8-80 letters, digits, - or _) is required for this request.');
  }
  return header;
};

/** Mounts each def: org-role gate -> validation -> RPC as the signed-in user. Params must be UUIDs. */
export function mountDefs(r: Router, defs: Def[], data: DataApi): void {
  for (const d of defs) {
    const handlers: RequestHandler[] = [
      requireOrgRole(data, d.min),
      validate({
        params: z.object(Object.fromEntries([...d.path.matchAll(/:(\w+)/g)].map((m) => [m[1]!, uuid]))).passthrough(),
        ...(d.body ? { body: d.body } : {}), ...(d.query ? { query: d.query } : {}),
      }),
      async (req, res) => {
        const { orgId: _o, ...ids } = req.params as Record<string, string>;
        const args: Record<string, unknown> = { p_org: req.org!.id, ...prefixed(ids), ...prefixed(req.body), ...prefixed(req.query as object), ...prefixed(d.extra) };
        if (d.idempotent) args.p_idempotency_key = idempotencyKey(req.get('idempotency-key'));
        const out = await data.rpc<any>(req.auth!.token, d.fn, args);
        res.status(out?.replayed === true ? 200 : d.status ?? 200).json(out);
      },
    ];
    r[d.method](d.path, ...handlers);
  }
}
