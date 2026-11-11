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

/** Turns parsed CSV rows (header first) into validated 30-minute demand blocks. */
export function loadMeterData(rows: string[][], options: LoadOptions = {}): MeterData {
  const valueKind = options.value ?? 'kwh';
  const timestampMeans = options.timestamp ?? 'start';
  if (rows.length < 3) {
    throw new InputError('CSV needs a header row and at least two data rows.');
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const tsName = (options.timestampColumn ?? 'timestamp').toLowerCase();
  const valueName = (options.valueColumn ?? valueKind).toLowerCase();
  const tsIndex = header.indexOf(tsName);
  const valueIndex = header.indexOf(valueName);
  if (tsIndex < 0) {
    throw new InputError(`CSV has no "${tsName}" column (columns: ${header.join(', ')}).`);
  }
  if (valueIndex < 0) {
    throw new InputError(`CSV has no "${valueName}" column (columns: ${header.join(', ')}).`);
  }

  const readings: { ts: number; raw: bigint; row: number }[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    const tsText = row[tsIndex];
    const valueText = row[valueIndex];
    if (tsText === undefined || valueText === undefined) {
      throw new InputError(`CSV row ${rowNo}: missing columns.`);
    }
    let ts: number;
    let raw: bigint;
    try {
      ts = parseTimestamp(tsText);
      // 10^-6 kWh (mWh) for energy, 10^-6 kW (mW) for power.
      raw = scaleDecimal(valueText, 6, valueKind === 'kwh' ? 'kWh' : 'kW');
    } catch (error) {
      if (error instanceof InputError) {
        throw new InputError(`CSV row ${rowNo}: ${error.message}`);
      }
      throw error;
    }
    readings.push({ ts, raw, row: rowNo });
  }

  readings.sort((a, b) => a.ts - b.ts);
  let interval = Number.POSITIVE_INFINITY;
  for (let i = 1; i < readings.length; i++) {
    const diff = readings[i].ts - readings[i - 1].ts;
    if (diff === 0) {
      throw new InputError(
        `duplicate timestamp "${rows[readings[i].row - 1][tsIndex]}" (rows ${readings[i - 1].row} and ${readings[i].row}).`,
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
        `CSV row ${reading.row}: interval start is not on the ${minutes}-minute grid.`,
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
