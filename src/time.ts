import { InputError } from './errors.js';

/** Malaysia is UTC+08:00 all year (no daylight saving). */
export const MYT_OFFSET_MINUTES = 480;

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses an ISO 8601-style timestamp into minutes since the Unix epoch (UTC).
 * Accepts "YYYY-MM-DD HH:MM[:SS]" or with "T", optionally with Z or an offset (+08:00, +0800).
 * A timestamp without an offset is local Malaysian time (+08:00). Seconds must be zero.
 */
export function parseTimestamp(text: string): number {
  const match = TIMESTAMP.exec(text.trim());
  if (!match) {
    throw new InputError(`timestamp "${text}" is not in YYYY-MM-DD HH:MM[:SS][offset] form.`);
  }
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new InputError(`timestamp "${text}" has an invalid date.`);
  }
  if (hour > 23 || minute > 59) {
    throw new InputError(`timestamp "${text}" has an invalid time.`);
  }
  if ((s !== undefined && Number(s) !== 0) || (frac !== undefined && Number(frac) !== 0)) {
    throw new InputError(`timestamp "${text}" must fall on a whole minute (seconds = 0).`);
  }
  let offset = MYT_OFFSET_MINUTES;
  if (zone === 'Z') {
    offset = 0;
  } else if (zone !== undefined) {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 14 || om > 59) {
      throw new InputError(`timestamp "${text}" has an invalid offset.`);
    }
    offset = sign * (oh * 60 + om);
  }
  const utcMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60000;
  return utcMinutes - offset;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface LocalParts {
  /** YYYY-MM-DD in +08:00. */
  date: string;
  /** YYYY-MM in +08:00. */
  month: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight, 0..1439. */
  minuteOfDay: number;
}

/** Local Malaysian calendar parts of an epoch-minute instant. */
export function localParts(epochMinutes: number): LocalParts {
  const shifted = new Date((epochMinutes + MYT_OFFSET_MINUTES) * 60000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const month = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  return {
    date: `${month}-${String(d).padStart(2, '0')}`,
    month,
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** Formats an epoch-minute instant as "YYYY-MM-DD HH:MM" local Malaysian time. */
export function formatLocal(epochMinutes: number): string {
  const parts = localParts(epochMinutes);
  const hh = String(Math.floor(parts.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(parts.minuteOfDay % 60).padStart(2, '0');
  return `${parts.date} ${hh}:${mm}`;
}

/** Peak window for TNB ToU: Monday to Friday, interval start in [14:00, 22:00), not a holiday. */
export const PEAK_START_MINUTE = 14 * 60;
export const PEAK_END_MINUTE = 22 * 60;

export function isPeak(intervalStart: number, holidays: ReadonlySet<string>): boolean {
  const parts = localParts(intervalStart);
  if (parts.weekday === 0 || parts.weekday === 6) {
    return false;
  }
  if (holidays.has(parts.date)) {
    return false;
  }
  return parts.minuteOfDay >= PEAK_START_MINUTE && parts.minuteOfDay < PEAK_END_MINUTE;
}
