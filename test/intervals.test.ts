import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { InputError } from '../src/errors.js';
import { loadMeterData, loadMeterDataFiles } from '../src/intervals.js';
import { parseTimestamp } from '../src/time.js';
import { FIXTURES } from '../scripts/gen-fixtures.mjs';
import { csvOf } from './helpers.js';

const load = (csv: string, options = {}) => loadMeterData(parseCsv(csv), options);

describe('loadMeterData', () => {
  it('detects 30-minute data and keys blocks by start', () => {
    const data = load(csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:30', '2.5'], ['2025-09-01 01:00', '0']]));
    expect(data.intervalMinutes).toBe(30);
    expect(data.intervalCount).toBe(3);
    expect(data.blocks.get(parseTimestamp('2025-09-01 00:30'))).toBe(2_500_000n);
  });

  it('aggregates 15-minute data into the same 30-minute blocks', () => {
    const data = load(
      csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:15', '2'], ['2025-09-01 00:30', '3'], ['2025-09-01 00:45', '4']]),
    );
    expect(data.intervalMinutes).toBe(15);
    expect([...data.blocks.values()]).toEqual([3_000_000n, 7_000_000n]);
  });

  it('gives identical blocks for the 15- and 30-minute versions of a fixture', () => {
    const thirty = load(FIXTURES['mv-factory-b.csv']());
    const fifteen = load(FIXTURES['mv-factory-b-15min.csv']());
    expect(fifteen.intervalMinutes).toBe(15);
    expect(fifteen.blocks).toEqual(thirty.blocks);
  });

  it('shifts interval-end timestamps back by one interval', () => {
    const data = load(csvOf([['2025-09-01 14:00', '1'], ['2025-09-01 14:30', '2']]), { timestamp: 'end' });
    expect(data.firstStart).toBe(parseTimestamp('2025-09-01 13:30'));
    expect(data.blocks.get(parseTimestamp('2025-09-01 13:30'))).toBe(1_000_000n);
  });

  it('converts average kW to energy per interval', () => {
    const data = load(csvOf([['2025-09-01 00:00', '100'], ['2025-09-01 00:15', '50']], 'timestamp,kw'), {
      value: 'kw',
    });
    // 100 kW x 15 min = 25 kWh; 50 kW x 15 min = 12.5 kWh; same 30-minute block.
    expect(data.blocks.get(parseTimestamp('2025-09-01 00:00'))).toBe(37_500_000n);
  });

  it('matches custom column names case-insensitively', () => {
    const data = load(csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:30', '1']], 'Read_Time,Energy'), {
      timestampColumn: 'read_time',
      valueColumn: 'ENERGY',
    });
    expect(data.intervalCount).toBe(2);
  });

  it('accepts unsorted rows', () => {
    const data = load(csvOf([['2025-09-01 00:30', '2'], ['2025-09-01 00:00', '1']]));
    expect(data.firstStart).toBe(parseTimestamp('2025-09-01 00:00'));
  });

  it.each([
    ['duplicate timestamps', csvOf([['2025-09-01 00:00', '1'], ['2025-09-01T00:00+08:00', '1'], ['2025-09-01 00:30', '1']]), /duplicate/],
    ['20-minute data', csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:20', '1'], ['2025-09-01 00:40', '1']]), /20 minutes/],
    ['hourly data', csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 01:00', '1']]), /60 minutes/],
    ['off-grid 30-minute data', csvOf([['2025-09-01 00:10', '1'], ['2025-09-01 00:40', '1']]), /grid/],
    ['a negative value', csvOf([['2025-09-01 00:00', '-1'], ['2025-09-01 00:30', '1']]), /row 2/],
    ['a bad timestamp', csvOf([['2025-09-01 00:00', '1'], ['yesterday', '1']]), /row 3/],
    ['a missing column', 'timestamp,kwh\n2025-09-01 00:00,1\n2025-09-01 00:30', /missing/],
    ['no data rows', 'timestamp,kwh\n2025-09-01 00:00,1', /at least two/],
    ['no kwh column', csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:30', '1']], 'timestamp,kw'), /no "kwh" column/],
  ])('rejects %s', (_name, csv, message) => {
    expect(() => load(csv)).toThrow(InputError);
    expect(() => load(csv)).toThrow(message);
  });
});

describe('loadMeterDataFiles', () => {
  const split = (csv: string): [string, string] => {
    const lines = csv.trimEnd().split('\n');
    const mid = Math.floor(lines.length / 2);
    return [lines.slice(0, mid).join('\n'), [lines[0], ...lines.slice(mid)].join('\n')];
  };

  it('gives the same series as one file when the export is split in two', () => {
    const whole = FIXTURES['mv-factory-b.csv']();
    const [first, second] = split(whole);
    const combined = loadMeterDataFiles([
      { name: 'b.csv', rows: parseCsv(second) },
      { name: 'a.csv', rows: parseCsv(first) },
    ]);
    expect(combined).toEqual(load(whole));
  });

  it('accepts files with a single data row when several are combined', () => {
    const data = loadMeterDataFiles([
      { name: 'a.csv', rows: parseCsv(csvOf([['2025-09-01 00:00', '1']])) },
      { name: 'b.csv', rows: parseCsv(csvOf([['2025-09-01 00:30', '2']])) },
    ]);
    expect(data.intervalCount).toBe(2);
    expect(data.intervalMinutes).toBe(30);
  });

  it('names both files for a timestamp found in two files', () => {
    const run = () =>
      loadMeterDataFiles([
        { name: 'aug.csv', rows: parseCsv(csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:30', '1']])) },
        { name: 'sep.csv', rows: parseCsv(csvOf([['2025-09-01 00:30', '1'], ['2025-09-01 01:00', '1']])) },
      ]);
    expect(run).toThrow(InputError);
    expect(run).toThrow(/duplicate timestamp "2025-09-01 00:30" \(aug\.csv row 3 and sep\.csv row 2\)/);
  });

  it('prefixes per-file errors with the file name', () => {
    const good = parseCsv(csvOf([['2025-09-01 00:00', '1']]));
    expect(() =>
      loadMeterDataFiles([
        { name: 'a.csv', rows: good },
        { name: 'b.csv', rows: parseCsv(csvOf([['yesterday', '1']])) },
      ]),
    ).toThrow(/CSV b\.csv row 2:/);
    expect(() =>
      loadMeterDataFiles([
        { name: 'a.csv', rows: good },
        { name: 'b.csv', rows: parseCsv('time,kwh\n2025-09-01 00:30,1\n') },
      ]),
    ).toThrow(/b\.csv: has no "timestamp" column/);
    expect(() =>
      loadMeterDataFiles([
        { name: 'a.csv', rows: good },
        { name: 'b.csv', rows: [['timestamp', 'kwh']] },
      ]),
    ).toThrow(/b\.csv: needs a header row and at least one data row/);
  });

  it('rejects a mix of 15-minute and 30-minute files, naming both', () => {
    const quarter = csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:15', '1'], ['2025-09-01 00:30', '1']]);
    const half = csvOf([['2025-09-02 00:00', '2'], ['2025-09-02 00:30', '2'], ['2025-09-02 01:00', '2']]);
    const run = () =>
      loadMeterDataFiles([
        { name: 'aug.csv', rows: parseCsv(half) },
        { name: 'sep.csv', rows: parseCsv(quarter) },
      ]);
    expect(run).toThrow(InputError);
    expect(run).toThrow(/aug\.csv is 30-minute data but sep\.csv is 15-minute data/);
    expect(() => loadMeterDataFiles([{ rows: parseCsv(quarter) }, { rows: parseCsv(half) }])).toThrow(/file 1 is 15-minute data but file 2 is 30-minute data/);
  });

  it('still combines same-length files and single-row files', () => {
    const data = loadMeterDataFiles([
      { name: 'a.csv', rows: parseCsv(csvOf([['2025-09-01 00:00', '1'], ['2025-09-01 00:15', '1']])) },
      { name: 'b.csv', rows: parseCsv(csvOf([['2025-09-01 01:00', '1']])) },
      { name: 'c.csv', rows: parseCsv(csvOf([['2025-09-02 00:00', '1'], ['2025-09-02 00:15', '1']])) },
    ]);
    expect(data.intervalMinutes).toBe(15);
    expect(data.intervalCount).toBe(5);
  });

  it('keeps the single-file rules for one source and rejects none', () => {
    expect(() => loadMeterDataFiles([{ rows: parseCsv(csvOf([['2025-09-01 00:00', '1']])) }])).toThrow(
      /at least two data rows/,
    );
    expect(() => loadMeterDataFiles([])).toThrow(/no CSV files/);
  });
});
