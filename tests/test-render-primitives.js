#!/usr/bin/env node
/**
 * Test suite for the v4 render primitives in src/output-formatter.js.
 * Run: node tests/test-render-primitives.js
 */
import assert from 'assert';
import { renderHeader } from '../src/output-formatter.js';

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

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
