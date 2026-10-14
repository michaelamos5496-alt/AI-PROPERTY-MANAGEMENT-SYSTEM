import { describe, expect, it } from 'vitest';
import { MAX_MINOR, formatMoney, parseMoney, toDecimalString } from '../../web/js/money.js';

const ok = (t: string, c = 'USD', o = {}) => { const r = parseMoney(t, c, o); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r.minor; };
const bad = (t: string, c = 'USD', o = {}) => { const r = parseMoney(t, c, o); return r.ok ? null : r.error; };

describe('parseMoney: exact, never rounds', () => {
  it('converts decimals to integer minor units', () => {
    expect([ok('0'), ok('0.01'), ok('1'), ok('12.5'), ok('12.50'), ok('1250'), ok('1,250.75'), ok('9999999999.99')]).toEqual([0, 1, 100, 1250, 1250, 125000, 125075, 999999999999]);
  });
  it('handles the classic float traps exactly', () => {
    // Number(1.005) * 100 === 100.49999999999999 and 0.1 + 0.2 !== 0.3: strings avoid all of it.
    expect(ok('1.005', 'KWD')).toBe(1005);
    expect(ok('0.29')).toBe(29);            // 0.29 * 100 === 28.999999999999996 in floating point
    expect(ok('4.35')).toBe(435);           // 4.35 * 100 === 434.99999999999994
    expect(ok('1.15')).toBe(115);           // 1.15 * 100 === 114.99999999999999
    expect(ok('8.2')).toBe(820);
  });
  it('rejects precision beyond the currency instead of rounding (rounding boundaries)', () => {
    expect(bad('1.005')).toMatch(/at most 2 decimal/);
    expect(bad('0.001')).toMatch(/at most 2/);
    expect(bad('19.999')).toMatch(/at most 2/);
    expect(bad('100.5', 'JPY')).toMatch(/no decimal places/);
    expect(ok('100', 'JPY')).toBe(100);
    expect(bad('1.0005', 'KWD')).toMatch(/at most 3/);
  });
  it('respects each currency\'s minor-unit size', () => {
    expect([ok('12.345', 'KWD'), ok('1500', 'JPY'), ok('2.50', 'EUR')]).toEqual([12345, 1500, 250]);
  });
  it('rejects malformed input', () => {
    for (const t of ['', ' ', 'abc', '1.2.3', '1,23', '12,34.5', '1e3', '0x10', '--1', '$5', '5$', '1 000', '.5', '5.', 'NaN', 'Infinity']) expect(bad(t), t).not.toBeNull();
  });
  it('enforces sign and zero rules', () => {
    expect(bad('-5')).toMatch(/negative/);
    expect(ok('-5.25', 'USD', { allowNegative: true })).toBe(-525);
    expect(bad('0', 'USD', { allowZero: false })).toMatch(/greater than zero/);
  });
  it('enforces the ledger maximum without precision loss', () => {
    expect(ok('10000000000.00')).toBe(MAX_MINOR);
    expect(bad('10000000000.01')).toMatch(/too large/);
    expect(bad('99999999999999999999999')).toMatch(/too large/);
  });
  it('round-trips every value through string formatting', () => {
    for (const minor of [0, 1, 9, 10, 99, 100, 101, 12345, 999999999999, 1000000000000]) expect(ok(toDecimalString(minor, 'USD'))).toBe(minor);
    for (const minor of [0, 1, 999, 1000, 1005]) expect(ok(toDecimalString(minor, 'KWD'), 'KWD')).toBe(minor);
    expect(toDecimalString(-5, 'USD')).toBe('-0.05');
    expect(toDecimalString(100, 'JPY')).toBe('100');
  });
  it('formats for display from the exact decimal', () => {
    expect(formatMoney(123456, 'USD', 'en-US')).toBe('$1,234.56');
    expect(formatMoney(5, 'USD', 'en-US')).toBe('$0.05');
    expect(formatMoney(1500, 'JPY', 'en-US')).toBe('¥1,500');
    expect(formatMoney(-250, 'USD', 'en-US')).toBe('-$2.50');
    expect(formatMoney(null, 'USD')).toBe('—');
  });
});
