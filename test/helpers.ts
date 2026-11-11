import { analyze } from '../src/analyze.js';
import { parseCsv } from '../src/csv.js';
import { loadMeterData, type LoadOptions } from '../src/intervals.js';
import { loadTariffFile, type VoltageClass } from '../src/tariff.js';

export const tariff = loadTariffFile();

export function analyzeCsv(
  csv: string,
  voltageClass: VoltageClass,
  options: LoadOptions = {},
  holidays: Set<string> = new Set(),
) {
  return analyze(loadMeterData(parseCsv(csv), options), tariff, voltageClass, holidays);
}

/** Builds a header + rows CSV from [timestamp, value] pairs. */
export function csvOf(rows: [string, string][], header = 'timestamp,kwh'): string {
  return [header, ...rows.map((r) => r.join(','))].join('\n');
}
