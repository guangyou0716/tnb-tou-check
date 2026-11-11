import { divRound } from './decimal.js';
import { InputError } from './errors.js';
import type { MeterData } from './intervals.js';
import type { PerKw, PerKwh, Tariff, VoltageClass } from './tariff.js';
import { daysInMonth, isPeak, localParts } from './time.js';

/** Money is accumulated in 10^-8 sen (exact for mWh x 0.01 sen/kWh and mW x sen/kW). */
const UNITS_PER_SEN = 100_000_000n;
/** A month counts toward the verdict when at least this share of its intervals is present. */
export const COMPLETE_COVERAGE_PERCENT = 95;
/** |ToU - General| within this percent of General is "borderline". */
export const BORDERLINE_PERCENT = 1;

export interface Charges {
  /** All amounts in sen, each rounded to the nearest sen. */
  energy: bigint;
  capacity: bigint;
  network: bigint;
  retail: bigint;
  total: bigint;
}

export interface MonthResult {
  month: string;
  status: 'complete' | 'incomplete';
  intervals: number;
  expectedIntervals: number;
  /** Energy in mWh (10^-6 kWh). */
  totalMWh: bigint;
  peakMWh: bigint;
  /** Maximum demand in mW (10^-6 kW) = max 30-minute energy x 2. */
  anytimeMdMW: bigint;
  anytimeMdAt: number | null;
  peakMdMW: bigint;
  peakMdAt: number | null;
  general: Charges;
  tou: Charges;
  /** tou.total - general.total, in sen. Negative means ToU is cheaper. */
  delta: bigint;
}

export type Recommendation = 'switch' | 'stay' | 'borderline' | 'insufficient-data';

export interface Indicators {
  /** Peak share of kWh at which ToU energy cost equals General energy cost. */
  energyBreakEvenPeakShare: number;
  /** For demand-charged classes: General demand rate / ToU demand rate. ToU demand is cheaper below it. */
  mdRatioThreshold: number | null;
}

export interface Analysis {
  voltageClass: VoltageClass;
  tariffId: string;
  intervalMinutes: number;
  months: MonthResult[];
  indicators: Indicators;
  summary: {
    monthsCompared: number;
    touCheaperMonths: number;
    generalTotal: bigint;
    touTotal: bigint;
    delta: bigint;
    /** Peak kWh share over compared months. */
    peakShare: number | null;
    /** Sum of monthly peak MD / sum of monthly anytime MD over compared months. */
    mdRatio: number | null;
    worstMonth: string | null;
    recommendation: Recommendation;
  };
  /** Present when a what-if peak shift was requested. */
  whatIf?: WhatIf;
  warnings: string[];
}

/** Basis points per 100%. */
export const SHIFT_SCALE = 10_000n;

export interface WhatIfMonth {
  month: string;
  status: MonthResult['status'];
  /** Peak energy moved to off-peak, in mWh. */
  shiftedMWh: bigint;
  /** Peak MD after the shift, in mW. Anytime MD is assumed unchanged. */
  peakMdMW: bigint;
  tou: Charges;
  /** tou.total - general.total (General is unchanged by a shift), in sen. */
  delta: bigint;
}

/**
 * "What if this share of peak-period energy moved to off-peak?" Every peak half-hour is scaled down
 * by the same share, so peak MD falls by that share too. General bills do not change (same kWh,
 * anytime MD assumed unchanged because the moved load is assumed to fit under the existing MD).
 */
export interface WhatIf {
  /** Share of peak kWh moved, in basis points (10000 = 100%). */
  shiftBasisPoints: bigint;
  months: WhatIfMonth[];
  touCheaperMonths: number;
  touTotal: bigint;
  /** touTotal - summary.generalTotal over compared months, in sen. */
  delta: bigint;
  recommendation: Recommendation;
}

export interface AnalyzeOptions {
  /** Share of peak kWh to move to off-peak for the what-if, in basis points (0..10000). */
  shiftBasisPoints?: bigint;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses holidays.json: an array of { date: "YYYY-MM-DD", name: string }. */
export function parseHolidays(json: unknown): Set<string> {
  if (!Array.isArray(json)) {
    throw new InputError('holidays file must be a JSON array of { "date": "YYYY-MM-DD", "name": "..." }.');
  }
  const dates = new Set<string>();
  json.forEach((entry, index) => {
    const date = (entry as { date?: unknown } | null)?.date;
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof date !== 'string' || !DATE.test(date) || typeof name !== 'string') {
      throw new InputError(`holidays file entry ${index + 1} needs "date" (YYYY-MM-DD) and "name".`);
    }
    const [y, m, d] = date.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
      throw new InputError(`holidays file entry ${index + 1}: "${date}" is not a real date.`);
    }
    dates.add(date);
  });
  return dates;
}

function perKwhUnits(mWh: bigint, rate: PerKwh): bigint {
  return mWh * rate.centisenPerKwh;
}

function perKwUnits(mdMW: bigint, rate: PerKw): bigint {
  return mdMW * rate.senPerKw * 100n;
}

function toSen(units: bigint): bigint {
  return divRound(units, UNITS_PER_SEN);
}

function demandOrEnergy(rate: PerKwh | PerKw, totalMWh: bigint, mdMW: bigint): bigint {
  return toSen(rate.kind === 'perKwh' ? perKwhUnits(totalMWh, rate) : perKwUnits(mdMW, rate));
}

function charges(parts: Omit<Charges, 'total'>): Charges {
  return { ...parts, total: parts.energy + parts.capacity + parts.network + parts.retail };
}

function ratio(a: bigint, b: bigint): number {
  return Number(a) / Number(b);
}

export function indicatorsFor(tariff: Tariff, voltageClass: VoltageClass): Indicators {
  const { general, tou } = tariff.classes[voltageClass];
  const energyBreakEvenPeakShare = ratio(
    general.energy.centisenPerKwh - tou.energyOffPeak.centisenPerKwh,
    tou.energyPeak.centisenPerKwh - tou.energyOffPeak.centisenPerKwh,
  );
  let mdRatioThreshold: number | null = null;
  if (
    general.capacity.kind === 'perKw' &&
    general.network.kind === 'perKw' &&
    tou.capacity.kind === 'perKw' &&
    tou.network.kind === 'perKw'
  ) {
    mdRatioThreshold = ratio(
      general.capacity.senPerKw + general.network.senPerKw,
      tou.capacity.senPerKw + tou.network.senPerKw,
    );
  }
  return { energyBreakEvenPeakShare, mdRatioThreshold };
}

export interface MonthUsage {
  /** mWh (10^-6 kWh). */
  totalMWh: bigint;
  peakMWh: bigint;
  /** mW (10^-6 kW). */
  anytimeMdMW: bigint;
  peakMdMW: bigint;
}

/** Prices one month of usage under General and ToU. Each subtotal is rounded to the sen. */
export function priceMonth(
  tariff: Tariff,
  voltageClass: VoltageClass,
  usage: MonthUsage,
): { general: Charges; tou: Charges } {
  const { general, tou } = tariff.classes[voltageClass];
  if (usage.peakMWh > usage.totalMWh || usage.peakMdMW > usage.anytimeMdMW) {
    throw new RangeError('peak usage cannot exceed total usage');
  }
  const offPeakMWh = usage.totalMWh - usage.peakMWh;
  return {
    general: charges({
      energy: toSen(perKwhUnits(usage.totalMWh, general.energy)),
      capacity: demandOrEnergy(general.capacity, usage.totalMWh, usage.anytimeMdMW),
      network: demandOrEnergy(general.network, usage.totalMWh, usage.anytimeMdMW),
      retail: general.retail.sen,
    }),
    tou: charges({
      energy: toSen(
        perKwhUnits(usage.peakMWh, tou.energyPeak) + perKwhUnits(offPeakMWh, tou.energyOffPeak),
      ),
      capacity: demandOrEnergy(tou.capacity, usage.totalMWh, usage.peakMdMW),
      network: demandOrEnergy(tou.network, usage.totalMWh, usage.peakMdMW),
      retail: tou.retail.sen,
    }),
  };
}

interface MonthAccumulator {
  intervals: number;
  totalMWh: bigint;
  peakMWh: bigint;
  anytimeMdMW: bigint;
  anytimeMdAt: number | null;
  peakMdMW: bigint;
  peakMdAt: number | null;
}

function recommend(monthsCompared: number, generalTotal: bigint, delta: bigint): Recommendation {
  if (monthsCompared === 0) {
    return 'insufficient-data';
  }
  const magnitude = delta < 0n ? -delta : delta;
  if (magnitude * 100n <= generalTotal * BigInt(BORDERLINE_PERCENT)) {
    return 'borderline';
  }
  return delta < 0n ? 'switch' : 'stay';
}

/** Applies a peak-to-off-peak shift (basis points) to one month's usage. Rounds to the mWh / mW. */
export function shiftUsage(usage: MonthUsage, shiftBasisPoints: bigint): MonthUsage {
  if (shiftBasisPoints < 0n || shiftBasisPoints > SHIFT_SCALE) {
    throw new RangeError('shift must be between 0 and 10000 basis points');
  }
  const keep = SHIFT_SCALE - shiftBasisPoints;
  return {
    totalMWh: usage.totalMWh,
    peakMWh: divRound(usage.peakMWh * keep, SHIFT_SCALE),
    anytimeMdMW: usage.anytimeMdMW,
    peakMdMW: divRound(usage.peakMdMW * keep, SHIFT_SCALE),
  };
}

function whatIfFor(
  tariff: Tariff,
  voltageClass: VoltageClass,
  months: MonthResult[],
  generalTotal: bigint,
  shiftBasisPoints: bigint,
): WhatIf {
  const shifted: WhatIfMonth[] = months.map((m) => {
    const usage = shiftUsage(m, shiftBasisPoints);
    const { tou } = priceMonth(tariff, voltageClass, usage);
    return {
      month: m.month,
      status: m.status,
      shiftedMWh: m.peakMWh - usage.peakMWh,
      peakMdMW: usage.peakMdMW,
      tou,
      delta: tou.total - m.general.total,
    };
  });
  const compared = shifted.filter((m) => m.status === 'complete');
  const touTotal = compared.reduce((sum, m) => sum + m.tou.total, 0n);
  const delta = touTotal - generalTotal;
  return {
    shiftBasisPoints,
    months: shifted,
    touCheaperMonths: compared.filter((m) => m.delta < 0n).length,
    touTotal,
    delta,
    recommendation: recommend(compared.length, generalTotal, delta),
  };
}

export function analyze(
  data: MeterData,
  tariff: Tariff,
  voltageClass: VoltageClass,
  holidays: ReadonlySet<string> = new Set(),
  options: AnalyzeOptions = {},
): Analysis {
  const months = new Map<string, MonthAccumulator>();
  const monthOf = (month: string): MonthAccumulator => {
    let acc = months.get(month);
    if (!acc) {
      acc = {
        intervals: 0,
        totalMWh: 0n,
        peakMWh: 0n,
        anytimeMdMW: 0n,
        anytimeMdAt: null,
        peakMdMW: 0n,
        peakMdAt: null,
      };
      months.set(month, acc);
    }
    return acc;
  };

  for (const start of data.starts) {
    monthOf(localParts(start).month).intervals++;
  }
  const blockStarts = [...data.blocks.keys()].sort((a, b) => a - b);
  for (const blockStart of blockStarts) {
    const mWh = data.blocks.get(blockStart)!;
    const acc = monthOf(localParts(blockStart).month);
    const demand = mWh * 2n;
    const peak = isPeak(blockStart, holidays);
    acc.totalMWh += mWh;
    if (acc.anytimeMdAt === null || demand > acc.anytimeMdMW) {
      acc.anytimeMdMW = demand;
      acc.anytimeMdAt = blockStart;
    }
    if (peak) {
      acc.peakMWh += mWh;
      if (acc.peakMdAt === null || demand > acc.peakMdMW) {
        acc.peakMdMW = demand;
        acc.peakMdAt = blockStart;
      }
    }
  }

  const results: MonthResult[] = [...months.keys()].sort().map((month) => {
    const acc = months.get(month)!;
    const [y, m] = month.split('-').map(Number);
    const expectedIntervals = (daysInMonth(y, m) * 24 * 60) / data.intervalMinutes;
    const complete = acc.intervals * 100 >= expectedIntervals * COMPLETE_COVERAGE_PERCENT;
    const { general: g, tou: t } = priceMonth(tariff, voltageClass, acc);
    return {
      month,
      status: complete ? 'complete' : 'incomplete',
      intervals: acc.intervals,
      expectedIntervals,
      totalMWh: acc.totalMWh,
      peakMWh: acc.peakMWh,
      anytimeMdMW: acc.anytimeMdMW,
      anytimeMdAt: acc.anytimeMdAt,
      peakMdMW: acc.peakMdMW,
      peakMdAt: acc.peakMdAt,
      general: g,
      tou: t,
      delta: t.total - g.total,
    };
  });

  const compared = results.filter((r) => r.status === 'complete');
  let generalTotal = 0n;
  let touTotal = 0n;
  let totalMWh = 0n;
  let peakMWh = 0n;
  let anytimeMd = 0n;
  let peakMd = 0n;
  let worst: MonthResult | null = null;
  for (const r of compared) {
    generalTotal += r.general.total;
    touTotal += r.tou.total;
    totalMWh += r.totalMWh;
    peakMWh += r.peakMWh;
    anytimeMd += r.anytimeMdMW;
    peakMd += r.peakMdMW;
    if (worst === null || r.delta > worst.delta) {
      worst = r;
    }
  }
  const delta = touTotal - generalTotal;
  const recommendation = recommend(compared.length, generalTotal, delta);

  const warnings: string[] = [];
  const incomplete = results.filter((r) => r.status === 'incomplete').map((r) => r.month);
  if (incomplete.length > 0) {
    warnings.push(
      `Months with under ${COMPLETE_COVERAGE_PERCENT}% of intervals are left out of the verdict: ${incomplete.join(', ')}.`,
    );
  }
  const outside = results
    .map((r) => r.month)
    .filter((m) => `${m}-31` < tariff.validFrom || `${m}-01` > tariff.validTo);
  if (outside.length > 0) {
    warnings.push(
      `Tariff ${tariff.id} is valid ${tariff.validFrom} to ${tariff.validTo}; these months fall outside it: ${outside.join(', ')}.`,
    );
  }

  return {
    voltageClass,
    tariffId: tariff.id,
    intervalMinutes: data.intervalMinutes,
    months: results,
    indicators: indicatorsFor(tariff, voltageClass),
    summary: {
      monthsCompared: compared.length,
      touCheaperMonths: compared.filter((r) => r.delta < 0n).length,
      generalTotal,
      touTotal,
      delta,
      peakShare: totalMWh > 0n ? ratio(peakMWh, totalMWh) : null,
      mdRatio: anytimeMd > 0n ? ratio(peakMd, anytimeMd) : null,
      worstMonth: worst?.month ?? null,
      recommendation,
    },
    ...(options.shiftBasisPoints === undefined
      ? {}
      : {
          whatIf: whatIfFor(tariff, voltageClass, results, generalTotal, options.shiftBasisPoints),
        }),
    warnings,
  };
}
