import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { formatLocal, isPeak, localParts, parseTimestamp } from '../src/time.js';

const none = new Set<string>();

describe('parseTimestamp', () => {
  it('treats timestamps without an offset as Malaysian time (+08:00)', () => {
    const local = parseTimestamp('2025-09-01 14:00');
    expect(parseTimestamp('2025-09-01T14:00:00+08:00')).toBe(local);
    expect(parseTimestamp('2025-09-01T06:00Z')).toBe(local);
    expect(parseTimestamp('2025-09-01T14:00:00.000+0800')).toBe(local);
    expect(parseTimestamp('2025-09-01T07:00:00+01:00')).toBe(local);
    expect(formatLocal(local)).toBe('2025-09-01 14:00');
  });

  it('rejects invalid dates, times, offsets and non-zero seconds', () => {
    for (const bad of [
      '2025-02-29 00:00',
      '2025-13-01 00:00',
      '2025-09-01 24:00',
      '2025-09-01 00:00:30',
      '2025-09-01 00:00+15:00',
      '01/09/2025 00:00',
      '',
    ]) {
      expect(() => parseTimestamp(bad), bad).toThrow(InputError);
    }
    expect(parseTimestamp('2024-02-29 00:00')).toBeTypeOf('number');
  });

  it('reports local calendar parts', () => {
    expect(localParts(parseTimestamp('2025-09-30T23:30:00Z'))).toMatchObject({
      month: '2025-10',
      date: '2025-10-01',
    });
  });
});

describe('isPeak (Mon-Fri, interval start in [14:00, 22:00) local, not a holiday)', () => {
  const at = (t: string, holidays = none) => isPeak(parseTimestamp(t), holidays);

  it('uses a half-open window on the interval start', () => {
    expect(at('2025-09-03 13:30')).toBe(false); // ends exactly at 14:00
    expect(at('2025-09-03 13:45')).toBe(false);
    expect(at('2025-09-03 14:00')).toBe(true);
    expect(at('2025-09-03 21:30')).toBe(true);
    expect(at('2025-09-03 21:45')).toBe(true);
    expect(at('2025-09-03 22:00')).toBe(false);
  });

  it('is off-peak at weekends and on listed holidays', () => {
    expect(at('2025-09-05 21:30')).toBe(true); // Friday
    expect(at('2025-09-06 14:00')).toBe(false); // Saturday
    expect(at('2025-09-07 15:00')).toBe(false); // Sunday
    const holidays = new Set(['2025-09-03']);
    expect(at('2025-09-03 15:00', holidays)).toBe(false); // synthetic holiday, a Wednesday
    expect(at('2025-09-04 15:00', holidays)).toBe(true);
  });

  it('classifies by local time even for UTC timestamps', () => {
    expect(at('2025-09-03T06:00:00Z')).toBe(true); // 14:00 MYT
    expect(at('2025-09-03T14:00:00Z')).toBe(false); // 22:00 MYT
  });
});
