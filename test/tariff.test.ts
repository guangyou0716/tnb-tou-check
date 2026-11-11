import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indicatorsFor } from '../src/analyze.js';
import { InputError } from '../src/errors.js';
import { DEFAULT_TARIFF_URL, parseTariff } from '../src/tariff.js';
import { tariff } from './helpers.js';

const raw = () => JSON.parse(readFileSync(DEFAULT_TARIFF_URL, 'utf8')) as TariffJson;
// Loose shape for mutating the raw file in validation tests.
interface RateJson {
  rate: string;
  unit: string;
  source: string;
}
type TariffJson = {
  schemaVersion: number;
  classes: Record<string, Record<string, Record<string, RateJson>>>;
};

const ST_URL = /^https:\/\/([a-z]+\.)?st\.gov\.my\//;

describe('bundled RP4 tariff', () => {
  it('covers 1 Jul 2025 to 31 Dec 2027', () => {
    expect(tariff.validFrom).toBe('2025-07-01');
    expect(tariff.validTo).toBe('2027-12-31');
  });

  it('cites an Energy Commission source for every rate', () => {
    const json = raw();
    let count = 0;
    for (const cls of ['lv', 'mv', 'hv']) {
      for (const part of ['general', 'tou']) {
        for (const entry of Object.values(json.classes[cls][part])) {
          expect(entry.source).toMatch(ST_URL);
          count++;
        }
      }
    }
    expect(count).toBe(27);
  });

  it('holds the published rates', () => {
    const mv = tariff.classes.mv;
    expect(mv.general.energy).toEqual({ kind: 'perKwh', centisenPerKwh: 2983n });
    expect(mv.tou.energyPeak).toEqual({ kind: 'perKwh', centisenPerKwh: 3132n });
    expect(mv.tou.energyOffPeak).toEqual({ kind: 'perKwh', centisenPerKwh: 2723n });
    expect(mv.general.capacity).toEqual({ kind: 'perKw', senPerKw: 2943n });
    expect(mv.tou.network).toEqual({ kind: 'perKw', senPerKw: 6687n });
    expect(tariff.classes.lv.general.capacity).toEqual({ kind: 'perKwh', centisenPerKwh: 883n });
    expect(tariff.classes.hv.general.retail).toEqual({ kind: 'perMonth', sen: 25_000n });
  });

  it('derives the published break-even thresholds', () => {
    const lv = indicatorsFor(tariff, 'lv');
    const mv = indicatorsFor(tariff, 'mv');
    const hv = indicatorsFor(tariff, 'hv');
    expect(lv.energyBreakEvenPeakShare).toBeCloseTo(2.6 / 4.09, 12);
    expect(lv.mdRatioThreshold).toBeNull();
    expect(mv.energyBreakEvenPeakShare).toBeCloseTo(2.6 / 4.09, 12);
    expect(mv.mdRatioThreshold).toBeCloseTo(89.27 / 97.06, 12);
    expect(hv.mdRatioThreshold).toBeCloseTo(31.21 / 44.82, 12);
  });
});

describe('parseTariff validation', () => {
  it('rejects unknown and missing keys', () => {
    const extra = raw();
    extra.classes.mv.tou.bonus = extra.classes.mv.tou.retail;
    expect(() => parseTariff(extra)).toThrow(InputError);
    const missing = raw();
    delete missing.classes.hv.general.network;
    expect(() => parseTariff(missing)).toThrow(/network/);
  });

  it('rejects wrong units, sourceless rates and over-precise rates', () => {
    const unit = raw();
    unit.classes.lv.general.energy.unit = 'RM/kW';
    expect(() => parseTariff(unit)).toThrow(InputError);
    const source = raw();
    source.classes.lv.tou.energyPeak.source = 'http://example.com';
    expect(() => parseTariff(source)).toThrow(InputError);
    const precise = raw();
    precise.classes.lv.tou.energyPeak.rate = '28.525';
    expect(() => parseTariff(precise)).toThrow(InputError);
  });

  it('rejects a different schema version', () => {
    const json = raw();
    json.schemaVersion = 2;
    expect(() => parseTariff(json)).toThrow(/schemaVersion/);
  });
});
