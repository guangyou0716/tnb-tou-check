import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { InputError } from '../src/errors.js';

describe('parseCsv', () => {
  it('handles BOM, CRLF, quotes and blank lines', () => {
    const text = '\uFEFFtimestamp,kwh\r\n"2025-09-01 00:00","1.5"\r\n\r\n2025-09-01 00:30,"say ""hi"", ok"\n';
    expect(parseCsv(text)).toEqual([
      ['timestamp', 'kwh'],
      ['2025-09-01 00:00', '1.5'],
      ['2025-09-01 00:30', 'say "hi", ok'],
    ]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"x\ny",z')).toEqual([
      ['a', 'b'],
      ['x\ny', 'z'],
    ]);
  });

  it('rejects text after a closing quote and unterminated quotes', () => {
    expect(() => parseCsv('a,b\n"x"y,z\n')).toThrow(InputError);
    expect(() => parseCsv('a,b\n"x,z\n')).toThrow(InputError);
  });
});
