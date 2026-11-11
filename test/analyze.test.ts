import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHolidays, priceMonth } from '../src/analyze.js';
import { InputError } from '../src/errors.js';
import { buildMonth, FIXTURES, toCsv } from '../scripts/gen-fixtures.mjs';
import { analyzeCsv, csvOf, tariff } from './helpers.js';

const KWH = 1_000_000n; // mWh per kWh
const KW = 1_000_000n; // mW per kW

describe('published worked examples (September 2025 synthetic months)', () => {
  it('LV cold room: energy RM8,109.00 General vs RM7,623.48 ToU', () => {
    const [month] = analyzeCsv(FIXTURES['lv-cold-room.csv'](), 'lv').months;
    expect(month.status).toBe('complete');
    expect(month.general.energy).toBe(810_900n);
    expect(month.tou.energy).toBe(762_348n);
    // Capacity 8.83 + network 14.82 sen/kWh and RM20 retail are the same on both tariffs.
    expect(month.general.total - month.general.energy).toBe(month.tou.total - month.tou.energy);
    expect(month.general.total).toBe(1_522_400n);
  });

  it('MV factory A (45% peak, MD 500 = peak MD 500): RM89,580.00 vs RM92,335.75, stay', () => {
    const analysis = analyzeCsv(FIXTURES['mv-factory-a.csv'](), 'mv');
    const [month] = analysis.months;
    expect(month.anytimeMdMW).toBe(500n * KW);
    expect(month.peakMdMW).toBe(500n * KW);
    expect(month.general.total).toBe(8_958_000n);
    expect(month.tou.total).toBe(9_233_575n);
    expect(analysis.summary.recommendation).toBe('stay');
  });

  it('MV factory B (35% peak, MD 500 at night, peak MD 400): ToU RM82,016.25, switch', () => {
    const analysis = analyzeCsv(FIXTURES['mv-factory-b.csv'](), 'mv');
    const [month] = analysis.months;
    expect(month.peakMWh).toBe(52_500n * KWH);
    expect(month.general.total).toBe(8_958_000n);
    expect(month.tou.total).toBe(8_201_625n);
    expect(analysis.summary.recommendation).toBe('switch');
    expect(analysis.summary.mdRatio).toBeCloseTo(0.8, 12);
  });

  it('gives the same bill for the 15-minute version of factory B', () => {
    const thirty = analyzeCsv(FIXTURES['mv-factory-b.csv'](), 'mv');
    const fifteen = analyzeCsv(FIXTURES['mv-factory-b-15min.csv'](), 'mv');
    expect(fifteen.intervalMinutes).toBe(15);
    const withoutCoverage = (months: typeof thirty.months) =>
      months.map((m) => ({ ...m, intervals: 0, expectedIntervals: 0 }));
    expect(withoutCoverage(fifteen.months)).toEqual(withoutCoverage(thirty.months));
    expect(fifteen.months[0].intervals).toBe(2880);
  });

  it('Cobler large MV example (pricing only): energy and demand subtotals', () => {
    // 500,000 kWh with 60% off-peak, MD 1,000 kW anytime / 800 kW peak. The illustration does not
    // describe a load profile that fits 352 peak half-hours, so it is checked at the pricing step.
    const { general, tou } = priceMonth(tariff, 'mv', {
      totalMWh: 500_000n * KWH,
      peakMWh: 200_000n * KWH,
      anytimeMdMW: 1_000n * KW,
      peakMdMW: 800n * KW,
    });
    expect(general.energy).toBe(14_915_000n);
    expect(tou.energy).toBe(14_433_000n);
    expect(general.capacity + general.network).toBe(8_927_000n);
    expect(tou.capacity + tou.network).toBe(7_764_800n);
  });

  it('refuses usage where peak exceeds total', () => {
    expect(() =>
      priceMonth(tariff, 'mv', { totalMWh: 1n, peakMWh: 2n, anytimeMdMW: 0n, peakMdMW: 0n }),
    ).toThrow(RangeError);
  });
});

describe('rounding', () => {
  it('rounds each subtotal to the sen and sums the rounded subtotals', () => {
    // 1.001 kWh on LV General: energy 27.05703 sen -> 27, capacity 8.83883 -> 9, network 14.83482 -> 15.
    const { general } = priceMonth(tariff, 'lv', {
      totalMWh: 1_001_000n,
      peakMWh: 0n,
      anytimeMdMW: 2_002_000n,
      peakMdMW: 0n,
    });
    expect([general.energy, general.capacity, general.network]).toEqual([27n, 9n, 15n]);
    expect(general.total).toBe(27n + 9n + 15n + 2_000n);
  });
});

describe('holidays', () => {
  it('moves holiday energy and demand to off-peak', () => {
    const csv = FIXTURES['mv-factory-b.csv']();
    const plain = analyzeCsv(csv, 'mv').months[0];
    // 11 Sep holds the 400 kW peak MD block.
    const holiday = analyzeCsv(csv, 'mv', {}, new Set(['2025-09-11'])).months[0];
    expect(holiday.peakMWh).toBeLessThan(plain.peakMWh);
    expect(holiday.peakMdMW).toBeLessThan(plain.peakMdMW);
    expect(holiday.tou.total).toBeLessThan(plain.tou.total);
    expect(holiday.general.total).toBe(plain.general.total);
  });

  it('parses the holidays file format', () => {
    expect(parseHolidays([{ date: '2025-08-31', name: 'Merdeka' }])).toEqual(new Set(['2025-08-31']));
    expect(() => parseHolidays({ date: '2025-08-31' })).toThrow(InputError);
    expect(() => parseHolidays([{ date: '31/08/2025', name: 'Merdeka' }])).toThrow(InputError);
  });

  it('ships a valid example holidays file', () => {
    const json = JSON.parse(readFileSync(new URL('../examples/holidays-2025-sample.json', import.meta.url), 'utf8'));
    expect(parseHolidays(json).size).toBeGreaterThan(0);
  });
});

describe('coverage and verdicts', () => {
  it('leaves months under 95% coverage out of the verdict', () => {
    const blocks = buildMonth({ year: 2025, month: 9, peakWh: 10_000_000, offPeakWh: 20_000_000 });
    const gappy = blocks.slice(0, Math.floor(blocks.length * 0.9));
    const analysis = analyzeCsv(toCsv(gappy), 'lv');
    expect(analysis.months[0].status).toBe('incomplete');
    expect(analysis.summary.monthsCompared).toBe(0);
    expect(analysis.summary.recommendation).toBe('insufficient-data');
    expect(analysis.warnings.join(' ')).toMatch(/2025-09/);
  });

  it('counts a month at exactly 95% as complete', () => {
    const blocks = buildMonth({ year: 2025, month: 9, peakWh: 10_000_000, offPeakWh: 20_000_000 });
    const analysis = analyzeCsv(toCsv(blocks.slice(0, 1368)), 'lv'); // 1368 / 1440 = 95%
    expect(analysis.months[0].status).toBe('complete');
  });

  it('calls a difference within 1% borderline', () => {
    // LV ToU energy equals General energy at the break-even peak share: 2.60 / 4.09 of kWh.
    // 4,090 kWh with 2,600 kWh peak gives the same energy charge on both tariffs.
    const blocks = buildMonth({ year: 2025, month: 9, peakWh: 2_600_000, offPeakWh: 1_490_000 });
    const analysis = analyzeCsv(toCsv(blocks), 'lv');
    expect(analysis.months[0].delta).toBe(0n);
    expect(analysis.summary.recommendation).toBe('borderline');
  });

  it('warns about months outside the tariff validity', () => {
    const csv = csvOf([
      ['2025-06-30 23:00', '1'],
      ['2025-06-30 23:30', '1'],
    ]);
    expect(analyzeCsv(csv, 'lv').warnings.join(' ')).toMatch(/2025-06/);
  });

  it('splits months on local (+08:00) time', () => {
    const csv = csvOf([
      ['2025-09-30T15:30:00Z', '1'], // 23:30 MYT, September
      ['2025-09-30T16:00:00Z', '2'], // 00:00 MYT, October
    ]);
    expect(analyzeCsv(csv, 'lv').months.map((m) => m.month)).toEqual(['2025-09', '2025-10']);
  });

  it('analyses a year of 30-minute data quickly', () => {
    const rows: string[] = ['timestamp,kwh'];
    for (let m = 1; m <= 12; m++) {
      for (const b of buildMonth({ year: 2026, month: m, peakWh: 30_000_000, offPeakWh: 70_000_000 })) {
        rows.push(`${b.timestamp},${(b.wh / 1000).toFixed(3)}`);
      }
    }
    expect(rows.length - 1).toBe(17_520);
    const started = performance.now();
    const analysis = analyzeCsv(rows.join('\n'), 'mv');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(analysis.summary.monthsCompared).toBe(12);
  });
});
