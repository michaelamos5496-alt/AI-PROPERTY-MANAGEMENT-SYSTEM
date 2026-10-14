import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors.js';

interface Schemas { body?: ZodTypeAny; params?: ZodTypeAny; query?: ZodTypeAny }

/** Validate and replace body/params/query with parsed (and stripped) values. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const problems: { in: string; path: string; message: string }[] = [];
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const r = schema.safeParse(req[part] ?? {});
      if (r.success) {
        // req.query is a getter in Express 5; define over it rather than assign.
        Object.defineProperty(req, part, { value: r.data, writable: true, configurable: true });
      } else {
        for (const i of r.error.issues) problems.push({ in: part, path: i.path.join('.'), message: i.message });
      }
    }
    next(problems.length ? AppError.validation(problems) : undefined);
  };
}

export const uuid = z.string().uuid();
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(10, 'Use at least 10 characters.').max(128);
export const orgName = z.string().trim().min(2).max(120);
