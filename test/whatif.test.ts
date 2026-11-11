import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shiftUsage } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { divRound } from '../src/decimal.js';
import { toCsv, toMarkdown, toText, WHAT_IF_CSV_COLUMNS } from '../src/report.js';
import { FIXTURES } from '../scripts/gen-fixtures.mjs';
import { analyzeCsv, tariff } from './helpers.js';
import { loadMeterData } from '../src/intervals.js';
import { parseCsv } from '../src/csv.js';
import { analyze } from '../src/analyze.js';

const KWH = 1_000_000n;
const KW = 1_000_000n;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function withShift(name: string, cls: 'lv' | 'mv', shiftBasisPoints: bigint) {
  const data = loadMeterData(parseCsv(FIXTURES[name]()));
  return analyze(data, tariff, cls, new Set(), { shiftBasisPoints });
}

describe('shiftUsage', () => {
  const usage = {
    totalMWh: 150_000n * KWH,
    peakMWh: 67_500n * KWH,
    anytimeMdMW: 500n * KW,
    peakMdMW: 500n * KW,
  };

  it('moves the share of peak kWh and scales peak MD; totals and anytime MD stay', () => {
    expect(shiftUsage(usage, 2_000n)).toEqual({
      totalMWh: 150_000n * KWH,
      peakMWh: 54_000n * KWH,
      anytimeMdMW: 500n * KW,
      peakMdMW: 400n * KW,
    });
  });

  it('is the identity at 0 and empties peak at 100%', () => {
    expect(shiftUsage(usage, 0n)).toEqual(usage);
    expect(shiftUsage(usage, 10_000n)).toMatchObject({
      peakMWh: 0n,
      peakMdMW: 0n,
    });
  });

  it('rounds half away from zero to the mWh', () => {
    expect(shiftUsage({ totalMWh: 3n, peakMWh: 3n, anytimeMdMW: 0n, peakMdMW: 0n }, 5_000n).peakMWh).toBe(2n);
  });

  it('rejects shares outside 0..100%', () => {
    expect(() => shiftUsage(usage, -1n)).toThrow(RangeError);
    expect(() => shiftUsage(usage, 10_001n)).toThrow(RangeError);
  });
});

describe('analyze what-if', () => {
  it('is absent unless requested', () => {
    expect(analyzeCsv(FIXTURES['mv-factory-a.csv'](), 'mv').whatIf).toBeUndefined();
  });

  it('a 0% shift reproduces the base ToU bill', () => {
    const a = withShift('mv-factory-a.csv', 'mv', 0n);
    expect(a.whatIf!.touTotal).toBe(a.summary.touTotal);
    expect(a.whatIf!.delta).toBe(a.summary.delta);
    expect(a.whatIf!.months[0].tou).toEqual(a.months[0].tou);
    expect(a.whatIf!.recommendation).toBe(a.summary.recommendation);
  });

  it('MV factory A, 20% shift: hand-checked ToU RM82,077.60 and the verdict flips to switch', () => {
    // 13,500 kWh x (31.32 - 27.23) sen = RM552.15 energy; 100 kW x RM(30.19 + 66.87) = RM9,706.00 demand.
    // 92,335.75 - 552.15 - 9,706.00 = 82,077.60.
    const a = withShift('mv-factory-a.csv', 'mv', 2_000n);
    expect(a.summary.recommendation).toBe('stay');
    const w = a.whatIf!;
    expect(w.months[0].shiftedMWh).toBe(13_500n * KWH);
    expect(w.months[0].peakMdMW).toBe(400n * KW);
    expect(w.months[0].tou.energy).toBe(a.months[0].tou.energy - 55_215n);
    expect(w.touTotal).toBe(8_207_760n);
    expect(w.delta).toBe(8_207_760n - 8_958_000n);
    expect(w.touCheaperMonths).toBe(1);
    expect(w.recommendation).toBe('switch');
  });

  it('LV cold room, 100% shift: ToU energy is all kWh at the off-peak rate', () => {
    const a = withShift('lv-cold-room.csv', 'lv', 10_000n);
    const m = a.months[0];
    const offPeak = tariff.classes.lv.tou.energyOffPeak.centisenPerKwh;
    expect(a.whatIf!.months[0].tou.energy).toBe(divRound(m.totalMWh * offPeak, 100_000_000n));
    expect(a.whatIf!.months[0].tou.total).toBeLessThan(m.tou.total);
  });

  it('a larger shift never costs more (monotonic)', () => {
    let previous: bigint | null = null;
    for (const bp of [0n, 1_000n, 2_500n, 5_000n, 10_000n]) {
      const total = withShift('mv-factory-b.csv', 'mv', bp).whatIf!.touTotal;
      if (previous !== null) {
        expect(total).toBeLessThanOrEqual(previous);
      }
      previous = total;
    }
  });
});

describe('what-if reports', () => {
  const a = withShift('mv-factory-a.csv', 'mv', 2_000n);

  it('text and Markdown show the what-if section and its assumption', () => {
    expect(toText(a)).toMatch(/What-if: move 20% of peak kWh to off-peak/);
    expect(toText(a)).toMatch(/ToU RM 82077\.60 vs General RM 89580\.00; ToU - General = RM -7502\.40/);
    expect(toText(a)).toMatch(/What-if verdict: switch/);
    const md = toMarkdown(a);
    expect(md).toMatch(/## What-if: 20% of peak kWh moved to off-peak/);
    expect(md).toMatch(/\| 2025-09 \| 13500\.000 \| 400\.000 \| 82077\.60 \| -7502\.40 \| complete \|/);
    expect(md).toMatch(/Assumption:/);
  });

  it('CSV appends what-if columns only when requested', () => {
    const [header, row] = toCsv(a).trim().split('\n');
    expect(header.endsWith(WHAT_IF_CSV_COLUMNS.join(','))).toBe(true);
    expect(row.endsWith('20,13500.000,400.000,82077.60,-7502.40')).toBe(true);
    const plain = toCsv(analyzeCsv(FIXTURES['mv-factory-a.csv'](), 'mv'));
    expect(plain).not.toMatch(/whatif_/);
  });
});

describe('cli --shift-peak', () => {
  it('adds whatIf to JSON', () => {
    const r = run(['analyze', fixture('mv-factory-a.csv'), '--class', 'mv', '--json', '--shift-peak', '20']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.summary.recommendation).toBe('stay');
    expect(json.whatIf).toMatchObject({
      shiftPercent: '20',
      touRm: '82077.60',
      deltaRm: '-7502.40',
      recommendation: 'switch',
    });
    expect(json.whatIf.months[0]).toMatchObject({
      shiftedKwh: '13500.000',
      peakMdKw: '400.000',
    });
  });

  it('accepts a trailing % and two decimals', () => {
    const r = run(['analyze', fixture('mv-factory-a.csv'), '--class', 'mv', '--json', '--shift-peak', '12.5%']);
    expect(JSON.parse(r.stdout).whatIf.shiftPercent).toBe('12.5');
  });

  it.each(['101', '-5', 'abc', '1.234', ''])('rejects --shift-peak %j with exit 2', (value) => {
    const r = run(['analyze', fixture('mv-factory-a.csv'), '--class', 'mv', '--shift-peak', value]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--shift-peak/);
  });
});
