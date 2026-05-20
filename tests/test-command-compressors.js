#!/usr/bin/env node
/**
 * Test suite for src/command-compressors.js.
 * Run: node tests/test-command-compressors.js
 */
import assert from 'assert';
import { compress, compressLs, compressPs } from '../src/command-compressors.js';

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

console.log('[test] Testing command-compressors\n');

// --- compressLs ----------------------------------------------------------
test('compressLs: drops a leading "total" line', () => {
  const out = compressLs('total 8\ndrwxr-xr-x  a\n-rw-r--r--  b');
  assert.strictEqual(out.text, 'drwxr-xr-x  a\n-rw-r--r--  b');
  assert.strictEqual(out.dropped, 1);
});

test('compressLs: no total line -> unchanged, dropped 0', () => {
  const out = compressLs('file1\nfile2');
  assert.strictEqual(out.text, 'file1\nfile2');
  assert.strictEqual(out.dropped, 0);
});

// --- compress dispatcher -------------------------------------------------
test('compress: ls command routes to compressLs and appends footer', () => {
  const r = compress('ls -la /tmp', 'total 8\nfile1');
  assert(r.startsWith('file1'), 'total line dropped');
  assert(r.includes('re-run with raw: true'), 'escape-hatch footer present');
});

test('compress: ls footer names the dropped total-line, not a misleading line count', () => {
  // The dropped line is always the `total N` header -- "1 line compressed"
  // wrongly implies a content row was hidden. Footer must say total-line.
  const r = compress('ls -la /tmp', 'total 8\nfile1\nfile2');
  assert(r.includes('total-line dropped'), `footer should name the total line, got: ${JSON.stringify(r)}`);
  assert(!/\b1 line compressed\b/.test(r), 'must not claim "1 line compressed"');
  assert(r.includes('re-run with raw: true'), 'raw escape-hatch hint still present');
});

test('compress: raw:true bypasses compression entirely', () => {
  const r = compress('ls -la', 'total 8\nfile1', { raw: true });
  assert.strictEqual(r, 'total 8\nfile1');
});

test('compress: unmatched command returned unchanged, no footer', () => {
  const r = compress('echo hi', 'hi');
  assert.strictEqual(r, 'hi');
});

test('compress: ls with nothing to drop adds no footer', () => {
  const r = compress('ls', 'file1\nfile2');
  assert.strictEqual(r, 'file1\nfile2');
});

test('compress: empty / nullish text is safe', () => {
  assert.strictEqual(compress('ls', ''), '');
  assert.strictEqual(compress('ls', null), '');
});

// --- compressPs ----------------------------------------------------------
test('compressPs: at or under the cap -> unchanged, dropped 0', () => {
  const out = compressPs('HEADER\nrow1\nrow2');
  assert.strictEqual(out.text, 'HEADER\nrow1\nrow2');
  assert.strictEqual(out.dropped, 0);
});

test('compressPs: over the cap keeps header + 15 rows, reports dropped', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n');
  const out = compressPs('HEADER\n' + rows);
  const lines = out.text.split('\n');
  assert.strictEqual(lines.length, 16, 'header + 15 rows');
  assert.strictEqual(lines[0], 'HEADER');
  assert.strictEqual(lines[15], 'row14', 'kept rows are the top of the list');
  assert.strictEqual(out.dropped, 15);
});

test('compress: ps command routes to compressPs with footer', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n');
  const r = compress('ps -eo pid,args', 'HEAD\n' + rows);
  assert(r.includes('15 lines compressed'), 'footer reports dropped count');
});

test('compress: ps inside a pipeline is still detected', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n');
  const r = compress('sudo ps aux | grep node', 'HEAD\n' + rows);
  assert(r.includes('compressed'), 'ps after sudo/pipe still matched');
});

test('compressPs: real ps output (trailing newline) -> dropped is exact', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n');
  const out = compressPs('HEADER\n' + rows + '\n');
  assert.strictEqual(out.dropped, 15, 'trailing newline not counted as a row');
  assert(out.text.endsWith('\n'), 'trailing newline preserved');
});

test('compressPs: exactly PS_KEEP+1 lines (header + 15 rows) -> dropped 0', () => {
  const rows = Array.from({ length: 15 }, (_, i) => `row${i}`).join('\n');
  const out = compressPs('HEADER\n' + rows + '\n');
  assert.strictEqual(out.dropped, 0, 'header + 15 rows is exactly the cap');
});

// --- negative-match guards -----------------------------------------------
test('compress: psql / tops / lsof are not matched as ps or ls', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n');
  const long = 'HEAD\n' + rows;
  assert.strictEqual(compress('psql -c "select 1"', long), long, 'psql != ps');
  assert.strictEqual(compress('tops', long), long, 'tops != ps');
  assert.strictEqual(compress('lsof -i :80', long), long, 'lsof != ls');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
