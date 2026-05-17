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
  buildLocateCommand,
  buildLsCommand,
  parseGrepHits,
  parseLocateHits,
  parseLsRows,
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

// --- buildLocateCommand --------------------------------------------------
test('buildLocateCommand: timeout-wrapped find with -name glob', () => {
  const cmd = buildLocateCommand({ name: '*.conf', path: '/etc' });
  assert(cmd.startsWith('timeout 20 '), 'timeout wrapper');
  assert(cmd.includes('find '), 'uses find');
  assert(cmd.includes("'/etc'"), 'path shell-quoted');
  assert(cmd.includes("-name '*.conf'"), 'name glob shell-quoted');
});

test('buildLocateCommand: -xdev by default, prunes pseudo-filesystems', () => {
  const cmd = buildLocateCommand({ name: 'x', path: '/', allowRoot: true });
  assert(cmd.includes('-xdev'), 'stays on one filesystem by default');
  for (const p of ['/proc', '/sys', '/dev', '/run']) {
    assert(cmd.includes(`-path ${"'" + p + "'"}`), `${p} pruned`);
  }
  assert(cmd.includes('-prune'), 'prune action present');
});

test('buildLocateCommand: crossMounts:true drops -xdev', () => {
  const cmd = buildLocateCommand({ name: 'x', path: '/a', crossMounts: true });
  assert(!cmd.includes('-xdev'), 'cross-mount opt-in drops -xdev');
});

test('buildLocateCommand: result count capped with head', () => {
  const cmd = buildLocateCommand({ name: 'x', path: '/a', matchCap: 75 });
  assert(cmd.includes('| head -n 75'), 'cap via head');
});

test('buildLocateCommand: missing name is rejected', () => {
  assert.throws(() => buildLocateCommand({ path: '/a' }), /name is required/);
});

test('buildLocateCommand: bare root refused without override', () => {
  assert.throws(
    () => buildLocateCommand({ name: 'x', path: '/' }),
    /refusing to search/,
  );
});

// --- buildLsCommand ------------------------------------------------------
test('buildLsCommand: timeout-wrapped ls -la of one directory', () => {
  const cmd = buildLsCommand({ path: '/var/log' });
  assert(cmd.startsWith('timeout 20 '), 'timeout wrapper');
  assert(cmd.includes('ls -la'), 'long listing');
  assert(cmd.includes("'/var/log'"), 'path shell-quoted');
});

test('buildLsCommand: a path with spaces survives quoting', () => {
  const cmd = buildLsCommand({ path: '/srv/my app' });
  assert(cmd.includes("'/srv/my app'"), 'spaced path quoted as one token');
});

test('buildLsCommand: empty path is rejected', () => {
  assert.throws(() => buildLsCommand({ path: '' }), /path is required/);
});

test('buildLsCommand: bare root is allowed -- listing / is cheap and safe', () => {
  const cmd = buildLsCommand({ path: '/' });
  assert(cmd.includes("ls -la '/'"), 'root listing permitted');
});

// --- parseGrepHits -------------------------------------------------------
test('parseGrepHits: file:line:text rows parsed to objects', () => {
  const hits = parseGrepHits(
    '/srv/app/main.js:42:  const TODO = 1;\n'
    + '/srv/app/util.js:7:// TODO refactor',
  );
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(hits[0], {
    file: '/srv/app/main.js', line: 42, text: '  const TODO = 1;',
  });
  assert.strictEqual(hits[1].line, 7);
});

test('parseGrepHits: a colon inside the matched text is preserved', () => {
  const hits = parseGrepHits('/etc/hosts:3:127.0.0.1 ::1 localhost');
  assert.strictEqual(hits[0].text, '127.0.0.1 ::1 localhost');
  assert.strictEqual(hits[0].line, 3);
});

test('parseGrepHits: blank lines and grep context "--" separators dropped', () => {
  const hits = parseGrepHits('/a:1:x\n--\n\n/a:5:y');
  assert.strictEqual(hits.length, 2);
});

test('parseGrepHits: empty / nullish input -> empty array', () => {
  assert.deepStrictEqual(parseGrepHits(''), []);
  assert.deepStrictEqual(parseGrepHits(null), []);
});

// --- parseLocateHits -----------------------------------------------------
test('parseLocateHits: one path per line, trimmed, blanks dropped', () => {
  const hits = parseLocateHits('/etc/nginx/nginx.conf\n\n/etc/ssl/openssl.conf\n');
  assert.deepStrictEqual(hits, ['/etc/nginx/nginx.conf', '/etc/ssl/openssl.conf']);
});

test('parseLocateHits: empty input -> empty array', () => {
  assert.deepStrictEqual(parseLocateHits(''), []);
});

// --- parseLsRows ---------------------------------------------------------
test('parseLsRows: long-format rows parsed, "total" line skipped', () => {
  const rows = parseLsRows(
    'total 12\n'
    + '-rw-r--r-- 1 root root 1024 May 17 10:00 app.conf\n'
    + 'drwxr-xr-x 2 root root 4096 May 16 09:30 logs',
  );
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    perms: '-rw-r--r--', size: '1024', name: 'app.conf', type: 'file',
  });
  assert.strictEqual(rows[1].type, 'dir');
  assert.strictEqual(rows[1].name, 'logs');
});

test('parseLsRows: a filename containing spaces is kept whole', () => {
  const rows = parseLsRows(
    'total 4\n-rw-r--r-- 1 u g 9 May 17 10:00 my notes.txt',
  );
  assert.strictEqual(rows[0].name, 'my notes.txt');
});

test('parseLsRows: symlink target is stripped from the name', () => {
  const rows = parseLsRows(
    'total 0\nlrwxrwxrwx 1 u g 7 May 17 10:00 cur -> /opt/v2',
  );
  assert.strictEqual(rows[0].name, 'cur');
  assert.strictEqual(rows[0].type, 'link');
});

test('parseLsRows: empty input -> empty array', () => {
  assert.deepStrictEqual(parseLsRows(''), []);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
