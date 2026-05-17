#!/usr/bin/env node
/**
 * Test suite for src/remote-search.js -- the ssh_find search engine.
 * Run: node tests/test-remote-search.js
 */
import assert from 'assert';
import {
  SEARCH_DEFAULTS,
  assertSearchPath,
} from '../src/remote-search.js';

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

console.log('[test] Testing remote-search\n');

// --- SEARCH_DEFAULTS -----------------------------------------------------
test('SEARCH_DEFAULTS: sane bounded defaults', () => {
  assert.strictEqual(SEARCH_DEFAULTS.matchCap, 200);
  assert.strictEqual(SEARCH_DEFAULTS.timeoutSecs, 20);
  assert.strictEqual(SEARCH_DEFAULTS.crossMounts, false);
  assert.deepStrictEqual(
    SEARCH_DEFAULTS.prune,
    ['/proc', '/sys', '/dev', '/run'],
  );
});

// --- assertSearchPath ----------------------------------------------------
test('assertSearchPath: a normal path passes through', () => {
  assert.strictEqual(assertSearchPath('/var/log'), '/var/log');
});

test('assertSearchPath: trailing slash is trimmed (except root)', () => {
  assert.strictEqual(assertSearchPath('/var/log/'), '/var/log');
});

test('assertSearchPath: empty or missing path is rejected', () => {
  assert.throws(() => assertSearchPath(''), /path is required/);
  assert.throws(() => assertSearchPath(null), /path is required/);
  assert.throws(() => assertSearchPath('   '), /path is required/);
});

test('assertSearchPath: bare root is refused without allow_root', () => {
  assert.throws(() => assertSearchPath('/'), /refusing to search "\/"/);
  assert.throws(() => assertSearchPath('//'), /refusing to search "\/"/);
});

test('assertSearchPath: bare root allowed only with explicit override', () => {
  assert.strictEqual(assertSearchPath('/', { allowRoot: true }), '/');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
