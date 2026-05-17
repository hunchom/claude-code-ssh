#!/usr/bin/env node
/**
 * Test suite for src/command-compressors.js.
 * Run: node tests/test-command-compressors.js
 */
import assert from 'assert';
import { compress, compressLs } from '../src/command-compressors.js';

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

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
