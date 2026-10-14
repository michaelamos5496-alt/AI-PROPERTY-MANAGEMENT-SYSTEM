export type ErrorCode =
  | 'bad_request' | 'validation_failed' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'conflict' | 'rate_limited' | 'upstream_error' | 'internal_error';

/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
  static badRequest = (m: string, d?: unknown) => new AppError(400, 'bad_request', m, d);
  static validation = (d: unknown) => new AppError(422, 'validation_failed', 'Some fields are invalid.', d);
  static unauthenticated = (m = 'Sign in to continue.') => new AppError(401, 'unauthenticated', m);
  static forbidden = (m = 'You do not have permission to do that.') => new AppError(403, 'forbidden', m);
  static notFound = (m = 'Not found.') => new AppError(404, 'not_found', m);
  static conflict = (m: string) => new AppError(409, 'conflict', m);
  static rateLimited = (retryAfter: number) =>
    Object.assign(new AppError(429, 'rate_limited', 'Too many requests. Please slow down.'), { retryAfter });
}

const byStatus: Record<number, ErrorCode> = {
  400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 422: 'validation_failed',
};

/** Translate a Supabase/PostgREST/GoTrue failure status into a client-safe AppError. */
export function fromUpstream(status: number, message: string): AppError {
  if (status === 429) return AppError.rateLimited(30);
  const code = byStatus[status];
  if (code) return new AppError(status, code, message);
  return new AppError(502, 'upstream_error', 'The service is temporarily unavailable.');
}
