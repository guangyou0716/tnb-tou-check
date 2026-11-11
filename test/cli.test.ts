import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'tnb-tou-check-'));

describe('cli run()', () => {
  it('prints a text report with the verdict and disclaimer', () => {
    const result = run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/89580\.00/);
    expect(result.stdout).toMatch(/82016\.25/);
    expect(result.stdout).toMatch(/Verdict: switch/);
    expect(result.stdout).toMatch(/AFA/);
  });

  it('prints JSON with RM amounts as strings', () => {
    const result = run(['analyze', fixture('mv-factory-a.csv'), '--class', 'mv', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.summary).toMatchObject({ generalRm: '89580.00', touRm: '92335.75', recommendation: 'stay' });
    expect(json.months[0].anytimeMdKw).toBe('500.000');
  });

  it('writes to --out', () => {
    const out = join(tmp, 'report.json');
    const result = run(['analyze', fixture('lv-cold-room.csv'), '--class', 'lv', '--json', '--out', out]);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(JSON.parse(readFileSync(out, 'utf8')).class).toBe('lv');
  });

  it('applies --holidays', () => {
    const holidays = join(tmp, 'holidays.json');
    writeFileSync(holidays, JSON.stringify([{ date: '2025-09-11', name: 'Test' }]));
    const json = JSON.parse(
      run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv', '--json', '--holidays', holidays]).stdout,
    );
    expect(json.months[0].peakMdKw).not.toBe('400.000');
  });

  it('shows help', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: tnb-tou-check analyze/);
  });

  it.each([
    [['analyze', 'x.csv']],
    [['analyze', 'missing.csv', '--class', 'mv']],
    [['analyze', 'x.csv', '--class', 'xv']],
    [['analyze', 'x.csv', '--class', 'mv', '--bogus']],
    [['report', 'x.csv', '--class', 'mv']],
  ])('exits 2 with usage on bad input %j', (argv) => {
    const result = run(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^tnb-tou-check: /);
    expect(result.stderr).toMatch(/Usage/);
  });

  it('exits 2 on unsupported interval data', () => {
    const csv = join(tmp, 'twenty.csv');
    writeFileSync(csv, 'timestamp,kwh\n2025-09-01 00:00,1\n2025-09-01 00:20,1\n');
    const result = run(['analyze', csv, '--class', 'lv']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/20 minutes/);
  });
});

describe('fixtures', () => {
  it('match the deterministic generator', async () => {
    const { FIXTURES } = await import('../scripts/gen-fixtures.mjs');
    for (const [name, make] of Object.entries(FIXTURES)) {
      expect(readFileSync(fixture(name), 'utf8'), name).toBe(make());
    }
  });
});
