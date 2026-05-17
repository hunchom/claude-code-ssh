#!/usr/bin/env node
/**
 * Test suite for the v4 render primitives in src/output-formatter.js.
 * Run: node tests/test-render-primitives.js
 */
import assert from 'assert';
import { renderHeader, indentBody, renderKV, renderRows } from '../src/output-formatter.js';

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

console.log('[test] Testing render primitives\n');

// --- renderHeader --------------------------------------------------------
test('renderHeader: full slots joined with middot', () => {
  const h = renderHeader({
    marker: '[ok]', tool: 'ssh_run', action: 'exec',
    server: 'devcentos', status: 'exit 0', durationMs: 245,
  });
  assert.strictEqual(h, '[ok] ssh_run · exec · devcentos · exit 0 · 245 ms');
});

test('renderHeader: optional slots collapse, order preserved', () => {
  const h = renderHeader({ marker: '[err]', tool: 'ssh_file', server: 'web1' });
  assert.strictEqual(h, '[err] ssh_file · web1');
});

test('renderHeader: default marker is [ok]', () => {
  assert.strictEqual(renderHeader({ tool: 'ssh_db' }), '[ok] ssh_db');
});

test('renderHeader: status of 0 is kept, empty string dropped', () => {
  assert(renderHeader({ tool: 't', status: 0 }).endsWith('· 0'));
  assert.strictEqual(renderHeader({ tool: 't', status: '' }), '[ok] t');
});

// --- indentBody ----------------------------------------------------------
test('indentBody: each line prefixed with 2 spaces', () => {
  assert.strictEqual(indentBody('a\nb'), '  a\n  b');
});

test('indentBody: empty or nullish input -> empty string', () => {
  assert.strictEqual(indentBody(''), '');
  assert.strictEqual(indentBody(null), '');
  assert.strictEqual(indentBody(undefined), '');
});

test('indentBody: custom prefix honored', () => {
  assert.strictEqual(indentBody('x', '| '), '| x');
});

test('indentBody: blank lines are still prefixed', () => {
  assert.strictEqual(indentBody('a\n\nb'), '  a\n  \n  b');
});

// --- renderKV ------------------------------------------------------------
test('renderKV: aligns keys to the longest, 2-space gutter', () => {
  const kv = renderKV([['exit', '0'], ['duration', '245 ms']]);
  assert.strictEqual(kv, 'exit      0\nduration  245 ms');
});

test('renderKV: empty or non-array -> empty string', () => {
  assert.strictEqual(renderKV([]), '');
  assert.strictEqual(renderKV(null), '');
});

test('renderKV: coerces non-string values, nullish value -> empty', () => {
  assert.strictEqual(renderKV([['n', 42], ['m', null]]), 'n  42\nm  ');
});

// --- renderRows ----------------------------------------------------------
test('renderRows: aligns columns, no trailing whitespace', () => {
  const t = renderRows(['name', 'exit'], [['web1', '0'], ['db1', '1']]);
  assert.strictEqual(t, 'name  exit\nweb1  0\ndb1   1');
});

test('renderRows: empty headers -> empty string', () => {
  assert.strictEqual(renderRows([], []), '');
});

test('renderRows: failures sorted to top with summary count', () => {
  const t = renderRows(
    ['name', 'ok'],
    [['a', 'y'], ['b', 'n'], ['c', 'y']],
    { isFail: (r) => r[1] === 'n' },
  );
  const lines = t.split('\n');
  assert.strictEqual(lines[0], '1/3 failed');
  assert.strictEqual(lines[1], 'name  ok');
  assert.strictEqual(lines[2], 'b     n');
});

test('renderRows: isFail with zero failures adds no summary line', () => {
  const t = renderRows(['n'], [['a'], ['b']], { isFail: () => false });
  assert.strictEqual(t.split('\n')[0], 'n');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
