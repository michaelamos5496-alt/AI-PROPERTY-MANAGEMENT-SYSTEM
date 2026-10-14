/**
 * Exact money handling for the browser. Amounts are integers in minor units (cents, pence, yen…);
 * no floating-point arithmetic is ever used to convert, sum or compare them.
 */
export const MAX_MINOR = 1_000_000_000_000;

const digitsCache = new Map();
/** Number of decimal places the currency uses (2 for USD, 0 for JPY, 3 for KWD). */
export function decimalPlaces(currency) {
  if (!digitsCache.has(currency)) {
    digitsCache.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  }
  return digitsCache.get(currency);
}

/**
 * Parse what a person typed ("1,234.50") into integer minor units.
 * Never rounds: more decimals than the currency allows is an error, not a silent change of value.
 * Returns { ok: true, minor } or { ok: false, error }.
 */
export function parseMoney(text, currency, { allowNegative = false, allowZero = true } = {}) {
  const places = decimalPlaces(currency);
  let s = String(text ?? '').trim();
  if (s === '') return { ok: false, error: 'Enter an amount.' };
  let negative = false;
  if (s.startsWith('-')) {
    if (!allowNegative) return { ok: false, error: 'Amount cannot be negative.' };
    negative = true; s = s.slice(1).trim();
  }
  if (!(/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) || /^\d+(\.\d+)?$/.test(s))) return { ok: false, error: 'Enter a valid amount, like 1250.00.' };
  const [whole, frac = ''] = s.replace(/,/g, '').split('.');
  if (frac.length > places) {
    return { ok: false, error: places === 0 ? `${currency} has no decimal places.` : `${currency} allows at most ${places} decimal places.` };
  }
  const minor = BigInt(whole + frac.padEnd(places, '0'));
  if (minor > BigInt(MAX_MINOR)) return { ok: false, error: 'Amount is too large.' };
  if (minor === 0n && !allowZero) return { ok: false, error: 'Amount must be greater than zero.' };
  const n = Number(minor);
  return { ok: true, minor: negative ? -n : n };
}

/** Integer minor units -> exact decimal string ("123456" -> "1234.56"), without division. */
export function toDecimalString(minor, currency) {
  const places = decimalPlaces(currency);
  const neg = minor < 0;
  const digits = BigInt(Math.abs(minor)).toString().padStart(places + 1, '0');
  const body = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return neg ? `-${body}` : body;
}

/** Display formatting. Intl formats the exact decimal string, so no float rounding creeps in. */
export function formatMoney(minor, currency, locale) {
  if (minor == null) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(toDecimalString(minor, currency));
}
