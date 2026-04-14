#!/usr/bin/env node
// Cross-platform test runner. Iterates every tests/test-*.js, sums pass/fail counts,
// prints per-file failures, exits non-zero if any suite failed.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const TEST_DIR = 'tests';
const files = readdirSync(TEST_DIR).filter(f => /^test-.*\.js$/.test(f)).sort();

let passTotal = 0;
let failTotal = 0;
const failedFiles = [];

for (const f of files) {
  const full = join(TEST_DIR, f);
  const res = spawnSync(process.execPath, [full], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');

  // Pattern A: "N passed, M failed"
  const mA = [...out.matchAll(/(\d+)\s+passed,\s+(\d+)\s+failed/g)].pop();
  // Pattern B: "Passed: N" / "Failed: M"
  const pB = [...out.matchAll(/Passed:\s*(\d+)/g)].pop();
  const fB = [...out.matchAll(/Failed:\s*(\d+)/g)].pop();

  const p = mA ? +mA[1] : pB ? +pB[1] : 0;
  const fl = mA ? +mA[2] : fB ? +fB[1] : 0;

  passTotal += p;
  failTotal += fl;

  if (fl > 0 || res.status !== 0) {
    failedFiles.push(f);
    console.error(`FAIL ${f}`);
    console.error(out.split('\n').slice(-20).join('\n'));
  }
}

console.log(`${files.length} files, ${passTotal} passed, ${failTotal} failed`);
if (failedFiles.length) {
  console.error('failed:', failedFiles.join(', '));
  process.exit(1);
}
