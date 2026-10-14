import type { Env } from './env.js';
import type { Logger } from './logger.js';

const lastSent = new Map<string, number>();

/**
 * Posts an operational alert to ALERT_WEBHOOK_URL (Slack-compatible). Never throws, never blocks a request for more than a few seconds,
 * and repeats of the same alert key are held back for `quietMs` per server instance so a stuck queue does not become a flood.
 * Contains no personal data: counts and names of things only.
 */
export async function sendAlert(env: Env, log: Logger, a: { key: string; title: string; lines?: string[] }, quietMs = 30 * 60_000, f: typeof fetch = fetch): Promise<boolean> {
  log.error('operational alert', { alert: a.key, title: a.title, lines: a.lines });
  if (!env.ALERT_WEBHOOK_URL) return false;
  const now = Date.now();
  if ((lastSent.get(a.key) ?? 0) + quietMs > now) return false;
  lastSent.set(a.key, now);
  try {
    const res = await f(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `:rotating_light: *Property AI (${env.NODE_ENV})* ${a.title}${a.lines?.length ? '\n' + a.lines.map((l) => `• ${l}`).join('\n') : ''}` }), signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch (e) { log.warn('alert delivery failed', { error: e instanceof Error ? e.message : String(e) }); return false; }
}
export const _resetAlertsForTests = () => lastSent.clear();
