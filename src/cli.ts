#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { analyze, parseHolidays } from './analyze.js';
import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { scaleDecimal } from './decimal.js';
import { loadMeterDataFiles, type TimestampMeans, type ValueKind } from './intervals.js';
import { toCsv, toJson, toMarkdown, toText } from './report.js';
import { DEFAULT_TARIFF_URL, loadTariffFile, VOLTAGE_CLASSES, type VoltageClass } from './tariff.js';

export const USAGE = `Usage: tnb-tou-check analyze <interval.csv>... --class lv|mv|hv [options]

Compares TNB General and ToU (Peninsular Malaysia, non-domestic) month by month
from 15- or 30-minute interval data. Works offline. Give several CSV files (for
example one export per month, same columns) to analyse them as one series; a
timestamp found in two files is an error.

Options:
  --class lv|mv|hv          Voltage class (required)
  --holidays <file>         JSON array of {"date":"YYYY-MM-DD","name":"..."}; all-day off-peak
  --timestamp start|end     Timestamp marks the interval start (default) or end
  --value kwh|kw            Column holds energy per interval (default) or average kW
  --ts-col <name>           Timestamp column name (default "timestamp")
  --value-col <name>        Value column name (default "kwh" or "kw")
  --tariff <file>           Tariff JSON (default: bundled RP4 2025-07 file)
  --shift-peak <percent>    What-if: move this share (0-100, up to 2 decimals) of peak kWh
                            to off-peak and re-price ToU; peak MD falls by the same share
  --json                    JSON output
  --md                      Markdown output
  --csv                     CSV output, one row per month with every charge
  --out <file>              Write the report to a file instead of stdout
  -h, --help                Show this help

Exit codes: 0 ok, 2 input error.
`;

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${what} "${path}" (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
}

function parseCsvFile(path: string, named: boolean): string[][] {
  const text = readText(path, 'CSV file');
  try {
    return parseCsv(text);
  } catch (error) {
    if (named && error instanceof InputError) {
      throw new InputError(`${path}: ${error.message}`);
    }
    throw error;
  }
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback?: T): T {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new InputError(`${flag} is required (${allowed.join('|')}).`);
    }
    return fallback;
  }
  const lower = value.toLowerCase() as T;
  if (!allowed.includes(lower)) {
    throw new InputError(`${flag} must be one of ${allowed.join('|')}.`);
  }
  return lower;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(argv: string[]): CliResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        class: { type: 'string' },
        holidays: { type: 'string' },
        timestamp: { type: 'string' },
        value: { type: 'string' },
        'ts-col': { type: 'string' },
        'value-col': { type: 'string' },
        tariff: { type: 'string' },
        'shift-peak': { type: 'string' },
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        csv: { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      return { code: 0, stdout: USAGE, stderr: '' };
    }
    if (positionals[0] !== 'analyze' || positionals.length < 2) {
      throw new InputError('expected: analyze <interval.csv>...');
    }
    const files = positionals.slice(1);
    const formats = (['json', 'md', 'csv'] as const).filter((f) => values[f]);
    if (formats.length > 1) {
      throw new InputError(`choose one output format, not ${formats.map((f) => `--${f}`).join(' and ')}.`);
    }
    const voltageClass = oneOf<VoltageClass>(values.class, VOLTAGE_CLASSES, '--class');
    const timestamp = oneOf<TimestampMeans>(values.timestamp, ['start', 'end'], '--timestamp', 'start');
    const value = oneOf<ValueKind>(values.value, ['kwh', 'kw'], '--value', 'kwh');

    let shiftBasisPoints: bigint | undefined;
    if (values['shift-peak'] !== undefined) {
      const text = values['shift-peak'].trim().replace(/%$/, '');
      if (/\.\d{3,}$/.test(text)) {
        throw new InputError('--shift-peak allows at most 2 decimal places.');
      }
      shiftBasisPoints = scaleDecimal(text, 2, '--shift-peak');
      if (shiftBasisPoints > 10_000n) {
        throw new InputError('--shift-peak must be between 0 and 100.');
      }
    }
    const tariff = loadTariffFile(values.tariff ?? DEFAULT_TARIFF_URL);
    let holidays = new Set<string>();
    if (values.holidays !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(readText(values.holidays, 'holidays file'));
      } catch (error) {
        if (error instanceof InputError) {
          throw error;
        }
        throw new InputError(`holidays file is not valid JSON (${(error as Error).message}).`);
      }
      holidays = parseHolidays(json);
    }
    const sources = files.map((file) => ({
      name: files.length > 1 ? file : undefined,
      rows: parseCsvFile(file, files.length > 1),
    }));
    const data = loadMeterDataFiles(sources, {
      timestamp,
      value,
      timestampColumn: values['ts-col'],
      valueColumn: values['value-col'],
    });
    const analysis = analyze(data, tariff, voltageClass, holidays, { shiftBasisPoints });
    const format = formats[0] ?? 'text';
    const report = {
      text: toText,
      json: toJson,
      md: toMarkdown,
      csv: toCsv,
    }[format](analysis);
    if (values.out !== undefined) {
      writeFileSync(values.out, report);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: report, stderr: '' };
  } catch (error) {
    if (error instanceof InputError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      return { code: 2, stdout: '', stderr: `tnb-tou-check: ${(error as Error).message}\n\n${USAGE}` };
    }
    throw error;
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) {
    return false;
  }
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
