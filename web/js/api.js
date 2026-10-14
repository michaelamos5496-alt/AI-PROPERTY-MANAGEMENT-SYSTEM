/** Thin fetch wrapper. Auth lives in HttpOnly cookies, so no tokens ever touch this code. */
export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message ?? 'Something went wrong. Please try again.');
    this.status = status;
    this.code = e.code ?? 'unknown';
    this.requestId = e.requestId;
    this.details = e.details ?? [];
  }
}

export async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection.', code: 'network' } });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}, headers) => api('POST', p, b, headers);
/** One key per user intent: reuse it when retrying so the server can recognise the repeat. */
export const newKey = () => crypto.randomUUID();
export const postIdem = (p, b, key) => api('POST', p, b, { 'idempotency-key': key });
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

/** Only same-site absolute paths are valid post-login destinations (no open redirects). */
export function safeNext(value, fallback = '/app') {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : fallback;
}

/** Where a signed-in user belongs. */
export async function homeFor(me) {
  return me.memberships.length ? `/app?org=${me.memberships[0].org_id}` : '/onboarding';
}

/** Resolve the current user, or redirect to sign-in. */
export async function requireSession() {
  try { return await get('/me'); }
  catch (e) {
    if (e.status === 401) {
      location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return new Promise(() => {}); // never resolves; navigating away
    }
    throw e;
  }
}

export async function signOut() {
  await post('/auth/logout').catch(() => {});
  location.assign('/login');
}
