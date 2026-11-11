import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { CSV_COLUMNS, DISCLAIMER, toCsv, toMarkdown } from '../src/report.js';
import { buildMonth, FIXTURES, toCsv as fixtureCsv } from '../scripts/gen-fixtures.mjs';
import { analyzeCsv } from './helpers.js';

const factoryB = () => analyzeCsv(FIXTURES['mv-factory-b.csv'](), 'mv');

describe('toMarkdown', () => {
  it('has the verdict, a month table and the disclaimer', () => {
    const md = toMarkdown(factoryB());
    expect(md).toMatch(/^# TNB General vs ToU check\n/);
    expect(md).toContain('**Verdict: switch.**');
    expect(md).toContain('| 2025-09 | 150000.000 | 35.0% | 500.000 | 400.000 | 89580.00 | 82016.25 | -7563.75 | complete |');
    expect(md).toContain('Peak MD / anytime MD 80.0%');
    expect(md).toContain(`> ${DISCLAIMER}`);
    expect(md).not.toContain('## Warnings');
  });

  it('omits the MD line for LV and lists warnings', () => {
    const blocks = buildMonth({ year: 2025, month: 9, peakWh: 1_000_000, offPeakWh: 2_000_000 });
    const md = toMarkdown(analyzeCsv(fixtureCsv(blocks.slice(0, 1000)), 'lv'));
    expect(md).not.toContain('Peak MD / anytime MD');
    expect(md).toContain('## Warnings');
    expect(md).toContain('**Verdict: insufficient-data.**');
    // Every table row has the same number of cells as the header.
    const tableRows = md.split('\n').filter((l) => l.startsWith('|'));
    const cells = tableRows.map((l) => l.split('|').length);
    expect(new Set(cells).size).toBe(1);
  });
});

describe('toCsv', () => {
  it('writes one row per month with every charge component', () => {
    const rows = parseCsv(toCsv(factoryB()));
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows).toHaveLength(2);
    const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1][i]]));
    expect(row).toMatchObject({
      month: '2025-09',
      status: 'complete',
      intervals: '1440',
      kwh: '150000.000',
      peak_kwh: '52500.000',
      anytime_md_at: '2025-09-10 02:00',
      peak_md_kw: '400.000',
      general_total_rm: '89580.00',
      tou_energy_rm: '42992.25',
      tou_total_rm: '82016.25',
      tou_minus_general_rm: '-7563.75',
    });
  });

  it('components add up to the totals', () => {
    const rows = parseCsv(toCsv(analyzeCsv(FIXTURES['mv-factory-a.csv'](), 'mv')));
    const row = Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, rows[1][i]]));
    const sen = (v: string) => Math.round(Number(v) * 100);
    for (const t of ['general', 'tou']) {
      const parts = ['energy', 'capacity', 'network', 'retail'].map((p) => sen(row[`${t}_${p}_rm`]));
      expect(parts.reduce((a, b) => a + b, 0)).toBe(sen(row[`${t}_total_rm`]));
    }
  });
});
