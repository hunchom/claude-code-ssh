#!/usr/bin/env node
/**
 * Test suite for the v4 dispatcher framework helpers:
 * src/dispatchers/action-validate.js and src/dispatchers/ctx-factory.js.
 * Run: node tests/test-dispatcher-ctx.js
 */
import assert from 'assert';
import { requireArgs } from '../src/dispatchers/action-validate.js';

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

console.log('[test] Testing dispatcher framework helpers\n');

// --- requireArgs ---------------------------------------------------------
test('requireArgs: all required args present -> null', () => {
  const r = requireArgs('ssh_run', 'exec', { command: 'ls' }, { exec: ['command'] });
  assert.strictEqual(r, null);
});

test('requireArgs: missing arg -> structured fail MCP response', () => {
  const r = requireArgs('ssh_run', 'exec', {}, { exec: ['command'] });
  assert(r && typeof r === 'object', 'returns an object');
  assert.strictEqual(r.isError, true);
  assert.strictEqual(r.content[0].type, 'text');
  assert(r.content[0].text.includes('command'), 'names the missing arg');
  assert(r.content[0].text.includes('exec'), 'names the action');
});

test('requireArgs: lists every missing arg, not just the first', () => {
  const r = requireArgs('ssh_file', 'sync', {}, { sync: ['source', 'destination'] });
  assert(r.content[0].text.includes('source'));
  assert(r.content[0].text.includes('destination'));
});

test('requireArgs: empty string counts as missing', () => {
  const r = requireArgs('ssh_run', 'exec', { command: '' }, { exec: ['command'] });
  assert(r, 'empty-string arg is treated as absent');
});

test('requireArgs: false and 0 count as present', () => {
  assert.strictEqual(
    requireArgs('t', 'a', { flag: false, n: 0 }, { a: ['flag', 'n'] }),
    null,
    'falsey-but-present values satisfy the requirement',
  );
});

test('requireArgs: action absent from map -> null (no requirements)', () => {
  assert.strictEqual(requireArgs('t', 'unknown', {}, { other: ['x'] }), null);
});

test('requireArgs: server is validated like any other required arg', () => {
  const r = requireArgs('ssh_run', 'exec', { command: 'ls' }, { exec: ['server', 'command'] });
  assert(r.content[0].text.includes('server'), 'missing server reported');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
