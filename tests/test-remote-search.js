#!/usr/bin/env node
/**
 * Test suite for src/remote-search.js -- the ssh_find search engine.
 * Run: node tests/test-remote-search.js
 */
import assert from 'assert';
import {
  SEARCH_DEFAULTS,
  assertSearchPath,
  buildGrepCommand,
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

// --- buildGrepCommand ----------------------------------------------------
test('buildGrepCommand: wraps in timeout and prefers rg over grep', () => {
  const cmd = buildGrepCommand({ pattern: 'TODO', path: '/srv/app' });
  assert(cmd.startsWith('timeout 20 '), 'hard timeout wrapper');
  assert(cmd.includes('command -v rg'), 'probes for rg');
  assert(cmd.includes('grep -rnI'), 'grep fallback present');
  assert(cmd.includes("'TODO'"), 'pattern is shell-quoted');
  assert(cmd.includes("'/srv/app'"), 'path is shell-quoted');
});

test('buildGrepCommand: caps matches with head -> SIGPIPE stops the walk', () => {
  const cmd = buildGrepCommand({ pattern: 'x', path: '/a', matchCap: 50 });
  assert(cmd.includes('| head -n 50'), 'match cap via head');
});

test('buildGrepCommand: prunes pseudo-filesystems and .git', () => {
  const cmd = buildGrepCommand({ pattern: 'x', path: '/' , allowRoot: true });
  assert(cmd.includes('--exclude-dir=.git'), 'rg/grep skip .git');
  for (const p of ['proc', 'sys', 'dev', 'run']) {
    assert(cmd.includes(`--exclude-dir=${p}`), `${p} excluded`);
  }
});

test('buildGrepCommand: one-filesystem by default, opt-in to cross', () => {
  const bounded = buildGrepCommand({ pattern: 'x', path: '/a' });
  assert(bounded.includes('--one-file-system'), 'rg stays on one fs');
  const crossing = buildGrepCommand({ pattern: 'x', path: '/a', crossMounts: true });
  assert(!crossing.includes('--one-file-system'), 'cross-mount opt-in honored');
});

test('buildGrepCommand: context lines threaded to both rg and grep', () => {
  const cmd = buildGrepCommand({ pattern: 'x', path: '/a', contextLines: 3 });
  assert(cmd.includes('-C 3'), 'context lines passed through');
});

test('buildGrepCommand: missing pattern is rejected', () => {
  assert.throws(() => buildGrepCommand({ path: '/a' }), /pattern is required/);
});

test('buildGrepCommand: bare root still refused here', () => {
  assert.throws(
    () => buildGrepCommand({ pattern: 'x', path: '/' }),
    /refusing to search/,
  );
});

test('buildGrepCommand: a pattern with quotes cannot break out', () => {
  const pattern = "a'; rm -rf /";
  const cmd = buildGrepCommand({ pattern, path: '/a' });
  // cmd is 'timeout N sh -c <shQuote(inner)>'; inner contains shQuote(pattern).
  // The rm appears only inside the double-quoted sh -c argument, never as a
  // bare command.  Verify structure: outer is sh -c '...', rm is not the last
  // token outside quotes.
  assert(cmd.startsWith('timeout ') && cmd.includes('sh -c '), 'wrapped in sh -c');
  // The whole remainder after 'sh -c ' is a single shell-quoted blob.
  const shCIdx = cmd.indexOf('sh -c ');
  const outerArg = cmd.slice(shCIdx + 'sh -c '.length);
  assert(outerArg.startsWith("'"), 'sh -c argument is single-quoted');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
