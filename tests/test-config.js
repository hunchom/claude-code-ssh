#!/usr/bin/env node
/**
 * Tests for src/config.js -- env-driven output limits.
 *
 * The values are read at import-time so these tests focus on the helpers
 * (intFromEnv / boolFromEnv via exported symbols) and on the runtime
 * truncateOutput() shape. Wiring into output-formatter is verified in
 * test-output-formatter.
 */

import assert from 'node:assert';
import { OUTPUT_LIMITS, RESPONSE_FORMAT, truncateOutput } from '../src/config.js';

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

test('OUTPUT_LIMITS has sane defaults and is frozen', () => {
  assert(typeof OUTPUT_LIMITS.MAX_OUTPUT_LENGTH === 'number');
  assert(OUTPUT_LIMITS.MAX_OUTPUT_LENGTH >= 100);
  assert(typeof OUTPUT_LIMITS.MAX_TAIL_LINES === 'number');
  assert(typeof OUTPUT_LIMITS.MAX_RSYNC_OUTPUT === 'number');
  assert(Object.isFrozen(OUTPUT_LIMITS));
});

test('RESPONSE_FORMAT exposes boolean flags and is frozen', () => {
  assert(typeof RESPONSE_FORMAT.COMPACT_JSON === 'boolean');
  assert(typeof RESPONSE_FORMAT.DEBUG === 'boolean');
  assert(Object.isFrozen(RESPONSE_FORMAT));
});

test('truncateOutput returns short input unchanged', () => {
  assert.strictEqual(truncateOutput('short', 10_000), 'short');
});

test('truncateOutput keeps head + tail and elides middle for long input', () => {
  const input = 'A'.repeat(5_000) + 'MIDDLE' + 'B'.repeat(5_000);
  const out = truncateOutput(input, 1_000);
  assert(out.includes('A'));
  assert(out.includes('B'));
  assert(!out.includes('MIDDLE'), 'middle must be elided');
  assert(out.includes('elided'), 'should announce the elision');
  assert(out.length < input.length);
});

test('truncateOutput handles nullish input safely', () => {
  assert.strictEqual(truncateOutput(null), '');
  assert.strictEqual(truncateOutput(undefined), '');
  assert.strictEqual(truncateOutput(''), '');
});

test('truncateOutput coerces non-string input to string', () => {
  const out = truncateOutput(12345, 10_000);
  assert.strictEqual(out, '12345');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
