import { readFileSync } from 'node:fs';
import { InputError } from './errors.js';
import { scaleDecimal } from './decimal.js';

export type VoltageClass = 'lv' | 'mv' | 'hv';
export const VOLTAGE_CLASSES: readonly VoltageClass[] = ['lv', 'mv', 'hv'];

/** Energy-based rate in 0.01 sen per kWh. */
export interface PerKwh {
  kind: 'perKwh';
  centisenPerKwh: bigint;
}
/** Demand rate in sen per kW of monthly maximum demand. */
export interface PerKw {
  kind: 'perKw';
  senPerKw: bigint;
}
/** Fixed monthly charge in sen. */
export interface PerMonth {
  kind: 'perMonth';
  sen: bigint;
}
export type Rate = PerKwh | PerKw | PerMonth;

export interface GeneralRates {
  energy: PerKwh;
  capacity: PerKwh | PerKw;
  network: PerKwh | PerKw;
  retail: PerMonth;
}

export interface TouRates {
  energyPeak: PerKwh;
  energyOffPeak: PerKwh;
  capacity: PerKwh | PerKw;
  network: PerKwh | PerKw;
  retail: PerMonth;
}

export interface Tariff {
  id: string;
  name: string;
  validFrom: string;
  validTo: string;
  classes: Record<VoltageClass, { general: GeneralRates; tou: TouRates }>;
}

export const DEFAULT_TARIFF_URL = new URL(
  '../data/tariffs/rp4-peninsular-2025-07.json',
  import.meta.url,
);

const UNITS = ['sen/kWh', 'RM/kW', 'RM/month'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^\d+(\.\d{1,2})?$/;

export function loadTariffFile(path: string | URL = DEFAULT_TARIFF_URL): Tariff {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new InputError(`tariff file: cannot read JSON (${(error as Error).message}).`);
  }
  return parseTariff(json);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new InputError(`tariff file: ${where} must be an object.`);
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new InputError(`tariff file: ${where}.${key} is missing.`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new InputError(`tariff file: ${where}.${key} is not a known field.`);
    }
  }
  return value;
}

function parseRate(value: unknown, where: string, allowed: readonly Rate['kind'][]): Rate {
  const entry = requireKeys(value, ['rate', 'unit', 'source'], where);
  const { rate, unit, source } = entry;
  if (typeof rate !== 'string' || !RATE.test(rate)) {
    throw new InputError(`tariff file: ${where}.rate must be a decimal string with at most 2 decimals.`);
  }
  if (typeof unit !== 'string' || !(UNITS as readonly string[]).includes(unit)) {
    throw new InputError(`tariff file: ${where}.unit must be one of ${UNITS.join(', ')}.`);
  }
  if (typeof source !== 'string' || !/^https:\/\/\S+$/.test(source)) {
    throw new InputError(`tariff file: ${where}.source must be an https URL.`);
  }
  let parsed: Rate;
  if (unit === 'sen/kWh') {
    parsed = { kind: 'perKwh', centisenPerKwh: scaleDecimal(rate, 2) };
  } else if (unit === 'RM/kW') {
    parsed = { kind: 'perKw', senPerKw: scaleDecimal(rate, 2) };
  } else {
    parsed = { kind: 'perMonth', sen: scaleDecimal(rate, 2) };
  }
  if (!allowed.includes(parsed.kind)) {
    throw new InputError(`tariff file: ${where}.unit "${unit}" is not allowed here.`);
  }
  return parsed;
}

export function parseTariff(json: unknown): Tariff {
  const root = requireKeys(
    json,
    ['schemaVersion', 'id', 'name', 'validFrom', 'validTo', 'checked', 'classes'],
    'root',
  );
  if (root.schemaVersion !== 1) {
    throw new InputError('tariff file: schemaVersion must be 1.');
  }
  for (const key of ['id', 'name', 'checked'] as const) {
    if (typeof root[key] !== 'string' || root[key] === '') {
      throw new InputError(`tariff file: ${key} must be a non-empty string.`);
    }
  }
  for (const key of ['validFrom', 'validTo'] as const) {
    if (typeof root[key] !== 'string' || !DATE.test(root[key])) {
      throw new InputError(`tariff file: ${key} must be YYYY-MM-DD.`);
    }
  }
  const classes = requireKeys(root.classes, VOLTAGE_CLASSES, 'classes');
  const result = {} as Tariff['classes'];
  for (const cls of VOLTAGE_CLASSES) {
    const entry = requireKeys(classes[cls], ['general', 'tou'], `classes.${cls}`);
    const g = requireKeys(entry.general, ['energy', 'capacity', 'network', 'retail'], `classes.${cls}.general`);
    const t = requireKeys(
      entry.tou,
      ['energyPeak', 'energyOffPeak', 'capacity', 'network', 'retail'],
      `classes.${cls}.tou`,
    );
    const at = (part: string, key: string) => `classes.${cls}.${part}.${key}`;
    result[cls] = {
      general: {
        energy: parseRate(g.energy, at('general', 'energy'), ['perKwh']) as PerKwh,
        capacity: parseRate(g.capacity, at('general', 'capacity'), ['perKwh', 'perKw']) as PerKwh | PerKw,
        network: parseRate(g.network, at('general', 'network'), ['perKwh', 'perKw']) as PerKwh | PerKw,
        retail: parseRate(g.retail, at('general', 'retail'), ['perMonth']) as PerMonth,
      },
      tou: {
        energyPeak: parseRate(t.energyPeak, at('tou', 'energyPeak'), ['perKwh']) as PerKwh,
        energyOffPeak: parseRate(t.energyOffPeak, at('tou', 'energyOffPeak'), ['perKwh']) as PerKwh,
        capacity: parseRate(t.capacity, at('tou', 'capacity'), ['perKwh', 'perKw']) as PerKwh | PerKw,
        network: parseRate(t.network, at('tou', 'network'), ['perKwh', 'perKw']) as PerKwh | PerKw,
        retail: parseRate(t.retail, at('tou', 'retail'), ['perMonth']) as PerMonth,
      },
    };
  }
  return {
    id: root.id as string,
    name: root.name as string,
    validFrom: root.validFrom as string,
    validTo: root.validTo as string,
    classes: result,
  };
}
