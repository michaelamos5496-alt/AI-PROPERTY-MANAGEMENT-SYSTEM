import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(AppError.notFound('Route not found.'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err?.type === 'entity.parse.failed') e = AppError.badRequest('Malformed JSON body.');
  else if (err?.type === 'entity.too.large') e = new AppError(413, 'bad_request', 'Request body too large.');
  else e = new AppError(500, 'internal_error', 'Something went wrong.');

  const log = req.log ?? console;
  if (e.status >= 500) (log as any).error('unhandled error', { error: String(err?.stack ?? err) });
  else (log as any).warn?.('request failed', { code: e.code, status: e.status });

  if (res.headersSent) return;
  res.status(e.status).json({
    error: { code: e.code, message: e.message, requestId: req.id, ...(e.details ? { details: e.details } : {}) },
  });
};
