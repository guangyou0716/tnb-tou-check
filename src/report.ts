import type { Analysis, Charges, MonthResult } from './analyze.js';
import { divRound, formatScaled } from './decimal.js';
import { formatLocal } from './time.js';

export const JSON_SCHEMA_VERSION = 1;

export const DISCLAIMER =
  'Not a TNB tool. Excludes AFA, KWTBB (RE fund), SST, power-factor surcharges and any rebates; AFA is charged on total kWh and is the same under both tariffs. Indicative only.';

/** mWh or mW (10^-6) to a 3-decimal kWh / kW string. */
export function kilo3(micro: bigint): string {
  return formatScaled(divRound(micro, 1000n), 3);
}

/** sen to a 2-decimal RM string. */
export function rm(sen: bigint): string {
  return formatScaled(sen, 2);
}

function percent(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

function chargesJson(c: Charges) {
  return {
    energy: rm(c.energy),
    capacity: rm(c.capacity),
    network: rm(c.network),
    retail: rm(c.retail),
    total: rm(c.total),
  };
}

function monthJson(m: MonthResult) {
  return {
    month: m.month,
    status: m.status,
    coverage: { intervals: m.intervals, expected: m.expectedIntervals },
    kwh: kilo3(m.totalMWh),
    peakKwh: kilo3(m.peakMWh),
    peakShare: m.totalMWh > 0n ? Number(m.peakMWh) / Number(m.totalMWh) : null,
    anytimeMdKw: kilo3(m.anytimeMdMW),
    anytimeMdAt: m.anytimeMdAt === null ? null : formatLocal(m.anytimeMdAt),
    peakMdKw: kilo3(m.peakMdMW),
    peakMdAt: m.peakMdAt === null ? null : formatLocal(m.peakMdAt),
    generalRm: chargesJson(m.general),
    touRm: chargesJson(m.tou),
    deltaRm: rm(m.delta),
  };
}

export function toJson(analysis: Analysis): string {
  const { summary } = analysis;
  return `${JSON.stringify(
    {
      schemaVersion: JSON_SCHEMA_VERSION,
      class: analysis.voltageClass,
      tariff: analysis.tariffId,
      intervalMinutes: analysis.intervalMinutes,
      months: analysis.months.map(monthJson),
      indicators: analysis.indicators,
      summary: {
        monthsCompared: summary.monthsCompared,
        touCheaperMonths: summary.touCheaperMonths,
        generalRm: rm(summary.generalTotal),
        touRm: rm(summary.touTotal),
        deltaRm: rm(summary.delta),
        peakShare: summary.peakShare,
        mdRatio: summary.mdRatio,
        worstMonth: summary.worstMonth,
        recommendation: summary.recommendation,
      },
      warnings: analysis.warnings,
      disclaimer: DISCLAIMER,
    },
    null,
    2,
  )}\n`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const VERDICT: Record<Analysis['summary']['recommendation'], string> = {
  switch: 'ToU would have been cheaper: consider switching.',
  stay: 'General would have been cheaper: stay on General.',
  borderline: `The difference is within 1% of the General bill: borderline.`,
  'insufficient-data': 'No month has enough data (95% of intervals) for a verdict.',
};

export function toText(analysis: Analysis): string {
  const { summary, indicators } = analysis;
  const rows = analysis.months.map((m) => [
    m.month,
    kilo3(m.totalMWh),
    percent(m.totalMWh > 0n ? Number(m.peakMWh) / Number(m.totalMWh) : null),
    kilo3(m.anytimeMdMW),
    kilo3(m.peakMdMW),
    rm(m.general.total),
    rm(m.tou.total),
    rm(m.delta),
    m.status,
  ]);
  const out: string[] = [
    `tnb-tou-check: class ${analysis.voltageClass.toUpperCase()}, tariff ${analysis.tariffId}, ${analysis.intervalMinutes}-minute data`,
    '',
    table(
      ['Month', 'kWh', 'Peak %', 'MD kW', 'Peak MD kW', 'General RM', 'ToU RM', 'ToU-Gen RM', 'Status'],
      rows,
    ),
    '',
    `Compared months: ${summary.monthsCompared} (ToU cheaper in ${summary.touCheaperMonths})`,
    `General RM ${rm(summary.generalTotal)} vs ToU RM ${rm(summary.touTotal)}; ToU - General = RM ${rm(summary.delta)}`,
    `Peak kWh share ${percent(summary.peakShare)} (energy break-even ${percent(indicators.energyBreakEvenPeakShare)})`,
  ];
  if (indicators.mdRatioThreshold !== null) {
    out.push(
      `Peak MD / anytime MD ${percent(summary.mdRatio)} (ToU demand charges are lower below ${percent(indicators.mdRatioThreshold)})`,
    );
  }
  if (summary.worstMonth !== null) {
    out.push(`Worst month for ToU: ${summary.worstMonth}`);
  }
  out.push(`Verdict: ${summary.recommendation}. ${VERDICT[summary.recommendation]}`);
  for (const warning of analysis.warnings) {
    out.push(`Warning: ${warning}`);
  }
  out.push('', DISCLAIMER, '');
  return out.join('\n');
}

/** Markdown report: the text report's content as headings, a table and bullet lists. */
export function toMarkdown(analysis: Analysis): string {
  const { summary, indicators } = analysis;
  const header = ['Month', 'kWh', 'Peak %', 'MD kW', 'Peak MD kW', 'General RM', 'ToU RM', 'ToU - General RM', 'Status'];
  const align = ['---', ...header.slice(1, -1).map(() => '---:'), '---'];
  const rows = analysis.months.map((m) => [
    m.month,
    kilo3(m.totalMWh),
    percent(m.totalMWh > 0n ? Number(m.peakMWh) / Number(m.totalMWh) : null),
    kilo3(m.anytimeMdMW),
    kilo3(m.peakMdMW),
    rm(m.general.total),
    rm(m.tou.total),
    rm(m.delta),
    m.status,
  ]);
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out: string[] = [
    '# TNB General vs ToU check',
    '',
    `Class ${analysis.voltageClass.toUpperCase()}, tariff \`${analysis.tariffId}\`, ${analysis.intervalMinutes}-minute data.`,
    '',
    `**Verdict: ${summary.recommendation}.** ${VERDICT[summary.recommendation]}`,
    '',
    '## Months',
    '',
    row(header),
    row(align),
    ...rows.map(row),
    '',
    '## Summary',
    '',
    `- Compared months: ${summary.monthsCompared} (ToU cheaper in ${summary.touCheaperMonths})`,
    `- General RM ${rm(summary.generalTotal)} vs ToU RM ${rm(summary.touTotal)}; ToU - General = RM ${rm(summary.delta)}`,
    `- Peak kWh share ${percent(summary.peakShare)} (energy break-even ${percent(indicators.energyBreakEvenPeakShare)})`,
  ];
  if (indicators.mdRatioThreshold !== null) {
    out.push(
      `- Peak MD / anytime MD ${percent(summary.mdRatio)} (ToU demand charges are lower below ${percent(indicators.mdRatioThreshold)})`,
    );
  }
  if (summary.worstMonth !== null) {
    out.push(`- Worst month for ToU: ${summary.worstMonth}`);
  }
  if (analysis.warnings.length > 0) {
    out.push('', '## Warnings', '', ...analysis.warnings.map((w) => `- ${w}`));
  }
  out.push('', `> ${DISCLAIMER}`, '');
  return out.join('\n');
}

export const CSV_COLUMNS = [
  'month',
  'status',
  'intervals',
  'expected_intervals',
  'kwh',
  'peak_kwh',
  'anytime_md_kw',
  'anytime_md_at',
  'peak_md_kw',
  'peak_md_at',
  'general_energy_rm',
  'general_capacity_rm',
  'general_network_rm',
  'general_retail_rm',
  'general_total_rm',
  'tou_energy_rm',
  'tou_capacity_rm',
  'tou_network_rm',
  'tou_retail_rm',
  'tou_total_rm',
  'tou_minus_general_rm',
] as const;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One CSV row per month with every charge component (RM, kWh and kW as fixed decimals). */
export function toCsv(analysis: Analysis): string {
  const charges = (c: Charges) => [rm(c.energy), rm(c.capacity), rm(c.network), rm(c.retail), rm(c.total)];
  const lines = [CSV_COLUMNS.join(',')];
  for (const m of analysis.months) {
    lines.push(
      [
        m.month,
        m.status,
        String(m.intervals),
        String(m.expectedIntervals),
        kilo3(m.totalMWh),
        kilo3(m.peakMWh),
        kilo3(m.anytimeMdMW),
        m.anytimeMdAt === null ? '' : formatLocal(m.anytimeMdAt),
        kilo3(m.peakMdMW),
        m.peakMdAt === null ? '' : formatLocal(m.peakMdAt),
        ...charges(m.general),
        ...charges(m.tou),
        rm(m.delta),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
