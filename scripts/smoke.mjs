#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const fixture = (name) => join(root, 'fixtures', name);
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};

const expected = [
  ['lv-cold-room.csv', 'lv', '15224.00', '14738.48', 'switch'],
  ['mv-factory-a.csv', 'mv', '89580.00', '92335.75', 'stay'],
  ['mv-factory-b.csv', 'mv', '89580.00', '82016.25', 'switch'],
  ['mv-factory-b-15min.csv', 'mv', '89580.00', '82016.25', 'switch'],
];
for (const [file, cls, generalRm, touRm, recommendation] of expected) {
  const json = JSON.parse(execFileSync(process.execPath, [cli, 'analyze', fixture(file), '--class', cls, '--json'], { encoding: 'utf8' }));
  const s = json.summary;
  if (s.generalRm !== generalRm || s.touRm !== touRm || s.recommendation !== recommendation) {
    fail(`${file}: got ${s.generalRm} / ${s.touRm} / ${s.recommendation}`);
  }
  console.log(`smoke: ok ${file} General RM${s.generalRm} ToU RM${s.touRm} -> ${s.recommendation}`);
}

for (const [flag, marker] of [['--md', '# TNB General vs ToU check'], ['--csv', 'month,status,']]) {
  const out = execFileSync(process.execPath, [cli, 'analyze', fixture('mv-factory-b.csv'), '--class', 'mv', flag], { encoding: 'utf8' });
  if (!out.startsWith(marker) || !out.includes('82016.25')) {
    fail(`${flag} output: ${JSON.stringify(out.slice(0, 120))}`);
  }
  console.log(`smoke: ok ${flag}`);
}

{
  const json = JSON.parse(
    execFileSync(process.execPath, [cli, 'analyze', fixture('mv-factory-a.csv'), '--class', 'mv', '--json', '--shift-peak', '20'], { encoding: 'utf8' }),
  );
  if (json.summary.recommendation !== 'stay' || json.whatIf?.touRm !== '82077.60' || json.whatIf?.recommendation !== 'switch') {
    fail(`--shift-peak 20: got ${JSON.stringify(json.whatIf)}`);
  }
  console.log('smoke: ok --shift-peak 20 (factory A: stay -> what-if ToU RM82077.60, switch)');
}

const link = join(mkdtempSync(join(tmpdir(), 'tnb-smoke-')), 'tnb-tou-check');
symlinkSync(cli, link);
const viaLink = spawnSync(process.execPath, [link, 'analyze', fixture('mv-factory-b.csv'), '--class', 'mv'], { encoding: 'utf8' });
if (viaLink.status !== 0 || !viaLink.stdout.includes('Verdict: switch')) {
  fail(`symlinked bin: exit ${viaLink.status}, stdout ${JSON.stringify(viaLink.stdout.slice(0, 200))}`);
}
console.log('smoke: ok symlinked bin');

const bad = spawnSync(process.execPath, [cli, 'analyze', fixture('mv-factory-b.csv'), '--class', 'xv'], { encoding: 'utf8' });
if (bad.status !== 2 || !bad.stderr.includes('Usage')) {
  fail(`bad --class: exit ${bad.status}`);
}
console.log('smoke: ok bad input exits 2');
