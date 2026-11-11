import { InputError } from './errors.js';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a non-negative decimal string and scales it to an integer number of 10^-places units,
 * rounding half up on the first dropped digit. No floating point is involved.
 * Example: scaleDecimal("12.3456", 3) === 12346n.
 */
export function scaleDecimal(text: string, places: number, what = 'value'): bigint {
  const match = DECIMAL.exec(text.trim());
  if (!match) {
    throw new InputError(`${what} "${text}" is not a non-negative decimal number.`);
  }
  const whole = match[1];
  const fraction = match[2] ?? '';
  const kept = fraction.slice(0, places).padEnd(places, '0');
  let scaled = BigInt(whole + kept);
  const next = fraction.charAt(places);
  if (next !== '' && next >= '5') {
    scaled += 1n;
  }
  return scaled;
}

/** Integer division rounding half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('denominator must be positive');
  }
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs + denominator / 2n) / denominator;
  return negative ? -quotient : quotient;
}

/** Formats an integer count of 10^-places units as a fixed decimal string, e.g. (-123n, 2) -> "-1.23". */
export function formatScaled(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = places > 0 ? `.${digits.slice(digits.length - places)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
