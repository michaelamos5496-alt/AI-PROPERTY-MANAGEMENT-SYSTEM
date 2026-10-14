import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: Logger;
    auth?: { token: string; user: { id: string; email: string } };
    org?: { id: string; role: import('../lib/roles.js').Role };
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns a request ID (honouring a sane inbound one), echoes it, and logs the request. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      req.log.info('request', {
        method: req.method, path: req.path, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        userId: req.auth?.user.id,
      });
    });
    next();
  };
}
