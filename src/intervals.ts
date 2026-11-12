import { divRound, scaleDecimal } from './decimal.js';
import { InputError } from './errors.js';
import { parseTimestamp } from './time.js';

export type ValueKind = 'kwh' | 'kw';
export type TimestampMeans = 'start' | 'end';

export interface LoadOptions {
  /** Timestamp column name (case-insensitive). Default "timestamp". */
  timestampColumn?: string;
  /** Value column name (case-insensitive). Default "kwh" or "kw" to match `value`. */
  valueColumn?: string;
  /** "kwh": energy per interval (default). "kw": average power over the interval. */
  value?: ValueKind;
  /** Whether the timestamp marks the start (default) or the end of the interval. */
  timestamp?: TimestampMeans;
}

export interface MeterData {
  /** Native interval length in minutes: 15 or 30. */
  intervalMinutes: 15 | 30;
  /** Number of native intervals read. */
  intervalCount: number;
  /** 30-minute demand blocks keyed by block start (epoch minutes, UTC), energy in mWh (10^-6 kWh). */
  blocks: Map<number, bigint>;
  /** First and last native interval start (epoch minutes). */
  firstStart: number;
  lastStart: number;
  /** Native interval starts, sorted, for coverage counting. */
  starts: number[];
}

export const SUPPORTED_INTERVALS = [15, 30] as const;

/** One parsed CSV file. `name` labels error messages when several files are combined. */
export interface CsvSource {
  name?: string;
  rows: string[][];
}

interface Reading {
  ts: number;
  raw: bigint;
  /** Human label such as `row 5` or `june.csv row 5`. */
  where: string;
  tsText: string;
}

function readRows(source: CsvSource, options: LoadOptions, minRows: number): Reading[] {
  const valueKind = options.value ?? 'kwh';
  const { rows } = source;
  const prefix = source.name === undefined ? 'CSV' : `${source.name}:`;
  const label = (rowNo: number) => (source.name === undefined ? `row ${rowNo}` : `${source.name} row ${rowNo}`);
  if (rows.length < minRows) {
    throw new InputError(
      minRows >= 3
        ? `${prefix} needs a header row and at least two data rows.`
        : `${prefix} needs a header row and at least one data row.`,
    );
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const tsName = (options.timestampColumn ?? 'timestamp').toLowerCase();
  const valueName = (options.valueColumn ?? valueKind).toLowerCase();
  const tsIndex = header.indexOf(tsName);
  const valueIndex = header.indexOf(valueName);
  if (tsIndex < 0) {
    throw new InputError(`${prefix} has no "${tsName}" column (columns: ${header.join(', ')}).`);
  }
  if (valueIndex < 0) {
    throw new InputError(`${prefix} has no "${valueName}" column (columns: ${header.join(', ')}).`);
  }

  const readings: Reading[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    const tsText = row[tsIndex];
    const valueText = row[valueIndex];
    if (tsText === undefined || valueText === undefined) {
      throw new InputError(`CSV ${label(rowNo)}: missing columns.`);
    }
    let ts: number;
    let raw: bigint;
    try {
      ts = parseTimestamp(tsText);
      // 10^-6 kWh (mWh) for energy, 10^-6 kW (mW) for power.
      raw = scaleDecimal(valueText, 6, valueKind === 'kwh' ? 'kWh' : 'kW');
    } catch (error) {
      if (error instanceof InputError) {
        throw new InputError(`CSV ${label(rowNo)}: ${error.message}`);
      }
      throw error;
    }
    readings.push({ ts, raw, where: label(rowNo), tsText });
  }
  return readings;
}

/** Turns parsed CSV rows (header first) into validated 30-minute demand blocks. */
export function loadMeterData(rows: string[][], options: LoadOptions = {}): MeterData {
  return buildMeterData(readRows({ rows }, options, 3), options);
}

/**
 * Combines several CSV files (for example one export per month) into one series. Every file
 * needs a header and at least one data row; the same column options apply to all files.
 * A timestamp that appears in two files is rejected like any other duplicate.
 */
export function loadMeterDataFiles(sources: CsvSource[], options: LoadOptions = {}): MeterData {
  if (sources.length === 0) {
    throw new InputError('no CSV files given.');
  }
  if (sources.length === 1) {
    return buildMeterData(readRows(sources[0], options, 3), options);
  }
  const perFile = sources.map((source) => readRows(source, options, 2));
  checkSameNativeInterval(sources, perFile);
  const readings = perFile.flat();
  if (readings.length < 2) {
    throw new InputError('CSV files need at least two data rows in total.');
  }
  return buildMeterData(readings, options);
}

/** Smallest positive step between sorted timestamps, or undefined with fewer than two distinct ones. */
function smallestStep(readings: Reading[]): number | undefined {
  const ts = readings.map((r) => r.ts).sort((a, b) => a - b);
  let step: number | undefined;
  for (let i = 1; i < ts.length; i++) {
    const diff = ts[i] - ts[i - 1];
    if (diff > 0 && (step === undefined || diff < step)) {
      step = diff;
    }
  }
  return step;
}

/**
 * Rejects a mix of 15-minute and 30-minute files. Without this, 30-minute rows inside a
 * 15-minute series would be read as 15-minute intervals: coverage would look half empty and
 * `--value kw` readings would count only half their energy. Files with one data row (no step)
 * or with an unsupported step are left to the combined-series check.
 */
function checkSameNativeInterval(sources: CsvSource[], perFile: Reading[][]): void {
  let first: { name: string; minutes: number } | undefined;
  perFile.forEach((readings, i) => {
    const step = smallestStep(readings);
    if (step !== 15 && step !== 30) {
      return;
    }
    const name = sources[i].name ?? `file ${i + 1}`;
    if (first === undefined) {
      first = { name, minutes: step };
    } else if (first.minutes !== step) {
      throw new InputError(
        `files mix interval lengths: ${first.name} is ${first.minutes}-minute data but ${name} is ${step}-minute data; ` +
          'give files with one interval length.',
      );
    }
  });
}

function buildMeterData(readings: Reading[], options: LoadOptions): MeterData {
  const valueKind = options.value ?? 'kwh';
  const timestampMeans = options.timestamp ?? 'start';
  readings.sort((a, b) => a.ts - b.ts);
  let interval = Number.POSITIVE_INFINITY;
  for (let i = 1; i < readings.length; i++) {
    const diff = readings[i].ts - readings[i - 1].ts;
    if (diff === 0) {
      throw new InputError(
        `duplicate timestamp "${readings[i].tsText}" (${readings[i - 1].where} and ${readings[i].where}).`,
      );
    }
    interval = Math.min(interval, diff);
  }
  if (interval !== 15 && interval !== 30) {
    throw new InputError(
      `interval length ${interval} minutes is not supported; use 15- or 30-minute data.`,
    );
  }
  const minutes = interval as 15 | 30;
  const shift = timestampMeans === 'end' ? minutes : 0;

  const blocks = new Map<number, bigint>();
  const starts: number[] = [];
  for (const reading of readings) {
    const start = reading.ts - shift;
    if (((start % minutes) + minutes) % minutes !== 0) {
      throw new InputError(
        `CSV ${reading.where}: interval start is not on the ${minutes}-minute grid.`,
      );
    }
    const mWh =
      valueKind === 'kwh' ? reading.raw : divRound(reading.raw * BigInt(minutes), 60n);
    const blockStart = start - (((start % 30) + 30) % 30);
    blocks.set(blockStart, (blocks.get(blockStart) ?? 0n) + mWh);
    starts.push(start);
  }

  return {
    intervalMinutes: minutes,
    intervalCount: readings.length,
    blocks,
    firstStart: starts[0],
    lastStart: starts[starts.length - 1],
    starts,
  };
}
