import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export type PhoneResult = { ok: true; e164: string; digits: string } | { ok: false; error: string };

/**
 * Normalizes a typed phone number to E.164 ("+233241234567"). A number written with a leading + is read as international;
 * otherwise it is read as a national number of `region` (the organization's country, e.g. GH, NG, KE).
 * Validity is checked against libphonenumber's rules for that country; nothing is guessed.
 */
export function normalizePhone(input: string, region?: string | null): PhoneResult {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a phone number.' };
  const hasPlus = raw.startsWith('+') || raw.startsWith('00');
  const cleaned = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  const r = parsePhoneNumberFromString(cleaned, hasPlus ? undefined : ((region && /^[A-Z]{2}$/.test(region) ? region : undefined) as CountryCode | undefined));
  if (!r) return { ok: false, error: hasPlus || region ? 'That does not look like a phone number.' : 'Include the country code, like +233 24 123 4567.' };
  if (!r.isValid()) return { ok: false, error: 'That phone number is not valid for its country.' };
  return { ok: true, e164: r.number, digits: r.number.slice(1) };
}
