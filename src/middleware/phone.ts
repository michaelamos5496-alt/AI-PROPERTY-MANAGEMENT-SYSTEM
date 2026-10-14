import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { requireOrgRole } from './auth.js';
import type { DataApi } from '../services/supabase.js';

/** Stores phone numbers in one canonical form (E.164), read against the organization's country. Invalid numbers are refused, not stored. */
export function normalizePhones(data: DataApi, fields: string[]): RequestHandler[] {
  return [requireOrgRole(data, 'staff'), async (req, _res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') return next();
      const present = fields.filter((f) => typeof req.body[f] === 'string' && req.body[f].trim() !== '');
      if (!present.length) return next();
      const m = await data.rpc<{ country: string | null }>(req.auth!.token, 'get_market', { p_org: req.org!.id });
      const problems: { in: string; path: string; message: string }[] = [];
      for (const f of present) {
        const r = normalizePhone(req.body[f], m.country);
        if (r.ok) req.body[f] = r.e164; else problems.push({ in: 'body', path: f, message: r.error });
      }
      next(problems.length ? AppError.validation(problems) : undefined);
    } catch (e) { next(e); }
  }];
}
