export const MAX_MINOR: number;
export function decimalPlaces(currency: string): number;
export function parseMoney(text: unknown, currency: string, opts?: { allowNegative?: boolean; allowZero?: boolean }): { ok: true; minor: number } | { ok: false; error: string };
export function toDecimalString(minor: number, currency: string): string;
export function formatMoney(minor: number | null | undefined, currency: string, locale?: string): string;
