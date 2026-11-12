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

  it('prints Markdown and CSV', () => {
    const md = run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv', '--md']);
    expect(md.code).toBe(0);
    expect(md.stdout).toMatch(/^# TNB General vs ToU check/);
    const csv = run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv', '--csv']);
    expect(csv.code).toBe(0);
    expect(csv.stdout.split('\n')[0]).toMatch(/^month,status,/);
  });

  it('refuses more than one output format', () => {
    const result = run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv', '--json', '--csv']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/choose one output format/);
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

describe('cli run() with several CSV files', () => {
  const whole = readFileSync(fixture('mv-factory-b.csv'), 'utf8').trimEnd().split('\n');
  const mid = Math.floor(whole.length / 2);
  const first = join(tmp, 'part-1.csv');
  const second = join(tmp, 'part-2.csv');
  writeFileSync(first, whole.slice(0, mid).join('\n') + '\n');
  writeFileSync(second, [whole[0], ...whole.slice(mid)].join('\n') + '\n');

  it('analyses split exports as one series', () => {
    const one = run(['analyze', fixture('mv-factory-b.csv'), '--class', 'mv', '--json']);
    const two = run(['analyze', second, first, '--class', 'mv', '--json']);
    expect(two.code).toBe(0);
    expect(JSON.parse(two.stdout)).toEqual(JSON.parse(one.stdout));
  });

  it('exits 2 when two files share a timestamp', () => {
    const result = run(['analyze', first, first, '--class', 'mv']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/duplicate timestamp/);
    expect(result.stderr).toContain('part-1.csv row 2 and');
  });

  it('names the file with a CSV syntax error', () => {
    const broken = join(tmp, 'broken.csv');
    writeFileSync(broken, 'timestamp,kwh\n"2025-09-30 23:30,1\n');
    const result = run(['analyze', first, broken, '--class', 'mv']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`${broken}: CSV: a quoted field is not closed.`);
  });
});
