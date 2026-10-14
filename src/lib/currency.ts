/**
 * One definition of how many decimal places each currency has, shared by server code (AI answers, WhatsApp text, exports).
 * It must agree with `app.money_text` in the database and `public.currencies`; a test compares all three.
 */
export const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'XOF', 'XAF', 'XPF', 'KMF', 'GNF', 'DJF', 'PYG', 'VUV']);
export const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);
export const exponent = (currency: string): number => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/** Exact "1234.50" style text without floating point. */
export function plainAmount(minor: number, currency: string): string {
  const e = exponent(currency); const abs = Math.abs(minor); const div = 10 ** e;
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / div)}${e ? '.' + String(abs % div).padStart(e, '0') : ''}`;
}
/** "1,234.50" with thousands separators (stable en-US grouping, so the code beside it is what carries meaning). */
export function groupedAmount(minor: number, currency: string): string {
  const e = exponent(currency); const abs = Math.abs(minor); const div = 10 ** e;
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / div).toLocaleString('en-US')}${e ? '.' + String(abs % div).padStart(e, '0') : ''}`;
}
