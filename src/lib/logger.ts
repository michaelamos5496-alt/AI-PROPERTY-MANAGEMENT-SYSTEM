const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof levels;

const REDACT = /pass|token|secret|authorization|cookie|apikey|key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

export interface Logger {
  debug(msg: string, ctx?: object): void;
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  child(ctx: object): Logger;
}

/** Structured JSON logger (one line per event, ready for Vercel log drains). */
export function createLogger(level: Level = 'info', base: object = {}, sink: (line: string) => void = console.log): Logger {
  const emit = (l: Exclude<Level, 'silent'>) => (msg: string, ctx: object = {}) => {
    if (levels[l] < levels[level]) return;
    sink(JSON.stringify({ level: l, time: new Date().toISOString(), msg, ...(redact({ ...base, ...ctx }) as object) }));
  };
  return {
    debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'),
    child: (ctx) => createLogger(level, { ...base, ...ctx }, sink),
  };
}
