import { describe, expect, it } from 'vitest';
import { divRound, formatScaled, scaleDecimal } from '../src/decimal.js';
import { InputError } from '../src/errors.js';

describe('scaleDecimal', () => {
  it('scales exactly without floating point', () => {
    expect(scaleDecimal('0.1', 6)).toBe(100_000n);
    expect(scaleDecimal('12', 3)).toBe(12_000n);
    expect(scaleDecimal(' 250.000 ', 6)).toBe(250_000_000n);
    expect(scaleDecimal('123456789012.123456', 6)).toBe(123_456_789_012_123_456n);
  });

  it('rounds half up on the first dropped digit', () => {
    expect(scaleDecimal('12.3455', 3)).toBe(12_346n);
    expect(scaleDecimal('12.3454999', 3)).toBe(12_345n);
    expect(scaleDecimal('0.0000005', 6)).toBe(1n);
  });

  it('rejects negatives, exponents and junk', () => {
    for (const bad of ['-1', '1e3', '', '.5', '1.', 'abc', '1,000']) {
      expect(() => scaleDecimal(bad, 3, 'kWh')).toThrow(InputError);
    }
  });
});

describe('divRound', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
  });

  it('refuses a non-positive denominator', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe('formatScaled', () => {
  it('formats fixed decimals including negatives and small values', () => {
    expect(formatScaled(-123n, 2)).toBe('-1.23');
    expect(formatScaled(5n, 2)).toBe('0.05');
    expect(formatScaled(892_700_00n, 2)).toBe('892700.00');
    expect(formatScaled(0n, 3)).toBe('0.000');
  });
});
