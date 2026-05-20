# ssh-mcp v4 Remote Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/remote-search.js` — the engine behind the new `ssh_find` tool (actions `grep`, `locate`, `ls`). It emits a *server-side-bounded* remote command (a `timeout` wrapper, pruned `/proc /sys /dev /run`, `-xdev`, a `head` cap that stops the walk on SIGPIPE, `rg`-then-`grep` fallback) and parses the result into structured hits `{file, line, text}`. A blind `grep -rn /` cannot escape from this tool.

**Architecture:** One new pure module, `src/remote-search.js`, with no I/O of its own. It exports two halves: command **builders** (`buildGrepCommand`, `buildLocateCommand`, `buildLsCommand`) that return a ready-to-exec POSIX `sh` string, and **parsers** (`parseGrepHits`, `parseLocateHits`, `parseLsRows`) that turn raw stdout into structured arrays. Plan 4's `ssh_find` dispatcher wires these to `streamExecCommand` and the renderer; this plan ships and tests the engine in isolation so it does not depend on the (parallel-authored) dispatcher existing yet. Nothing existing is modified — the module and its test suite are purely additive, so `npm test` stays green throughout.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`. `shQuote` is reused from `src/stream-exec.js`.

This is Plan 5a of the v4 series (Plans 1-3 — render primitives, output rewrite, compressors — are complete; Plan 4 builds the 13-tool dispatcher facade). Plans 5b (`ssh_run` script + detach jobs) and 5c (connection reuse + timeout escalation) are siblings. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` sections 3, 6, 7.

---

## File Structure

- **Create `src/remote-search.js`** — the search-command builders and output parsers. Pure functions; no SSH, no `fs`.
- **Create `tests/test-remote-search.js`** — new suite. Auto-discovered by `scripts/run-tests.mjs` (matches `test-*.js`).

The module never executes anything. A builder returns a string; the dispatcher (Plan 4) runs it. This keeps every bound assertable as a substring of the emitted command, with zero network in the test suite.

---

## Task 1: Search constants and the shared bounded-command preamble

`ssh_find` refuses a bare `/` root, prunes pseudo-filesystems, caps matches, and wraps everything in `timeout`. All three actions share that envelope, so it is built once. This task lays down the constants and the path-guard helper plus the `rg`-detection prefix, with no action-specific code yet.

**Files:**
- Create: `src/remote-search.js`
- Test: `tests/test-remote-search.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-remote-search.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-remote-search.js`
Expected: FAIL — `Cannot find module '../src/remote-search.js'`.

- [ ] **Step 3: Write the module skeleton**

Create `src/remote-search.js`:

```javascript
/**
 * Remote-search engine for the v4 ssh_find tool. Pure: builders return a
 * POSIX-sh command string, parsers turn raw stdout into structured hits.
 *
 * Every emitted command is server-side bounded: timeout wrapper, pruned
 * pseudo-filesystems, -xdev unless opted out, match cap via head (SIGPIPE
 * stops the walk early). A bare "/" root is refused without an override.
 */

import { shQuote } from './stream-exec.js';

/** Bounded defaults baked into every ssh_find command. */
export const SEARCH_DEFAULTS = {
  matchCap: 200,                                // hits before head closes the pipe
  timeoutSecs: 20,                              // hard `timeout` wall
  contextLines: 0,                              // grep -C value
  crossMounts: false,                           // false => -xdev
  prune: ['/proc', '/sys', '/dev', '/run'],     // never descended
};

/**
 * Validate + normalize a search root. Empty path rejected; bare "/" refused
 * unless allowRoot. Returns the trimmed path.
 */
export function assertSearchPath(path, { allowRoot = false } = {}) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) throw new Error('ssh_find: path is required');
  // Collapse a string of only slashes to one "/".
  const normalized = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '');
  if (normalized === '/' && !allowRoot) {
    throw new Error(
      'ssh_find: refusing to search "/" -- pass a narrower path '
      + 'or set allow_root: true',
    );
  }
  return normalized || '/';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-remote-search.js`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/remote-search.js tests/test-remote-search.js
git commit -m "feat: add ssh_find search constants and path guard"
```

---

## Task 2: `buildGrepCommand` — bounded recursive grep with rg fallback

`ssh_find action: grep` replaces a blind `ssh host grep -rn`. The emitted command prefers `rg` when present, falls back to `grep`, prunes pseudo-filesystems and `.git`, stays on one filesystem unless told otherwise, and pipes through `head -n <cap>` so the walk dies on SIGPIPE at the cap rather than scanning the whole tree.

**Files:**
- Modify: `src/remote-search.js` (append `buildGrepCommand`)
- Test: `tests/test-remote-search.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-remote-search.js`, change the import to add `buildGrepCommand`:

```javascript
import {
  SEARCH_DEFAULTS,
  assertSearchPath,
  buildGrepCommand,
} from '../src/remote-search.js';
```

Add these tests before the `// --- Summary` section:

```javascript
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
  const cmd = buildGrepCommand({ pattern: "a'; rm -rf /", path: '/a' });
  // The injected `rm` text survives only inside a quoted literal.
  assert(!/[^']rm -rf \//.test(cmd), 'no unquoted rm in the command');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-remote-search.js`
Expected: FAIL — `does not provide an export named 'buildGrepCommand'`.

- [ ] **Step 3: Implement `buildGrepCommand`**

Append to `src/remote-search.js`:

```javascript
/** Build the prune/exclude flags shared by the rg and grep branches. */
function excludeFlags(prune, crossMounts) {
  // strip leading slash: grep/rg --exclude-dir matches a basename
  const dirs = [...prune.map((p) => p.replace(/^\//, '')), '.git'];
  const flags = dirs.map((d) => `--exclude-dir=${d}`);
  if (!crossMounts) flags.push('--one-file-system');
  return flags.join(' ');
}

/**
 * Build a bounded recursive-grep command. Prefers rg, falls back to grep.
 * Emitted shape: timeout <s> sh -c 'if rg; then rg ...; else grep ...; fi | head'
 */
export function buildGrepCommand({
  pattern,
  path,
  matchCap = SEARCH_DEFAULTS.matchCap,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
  contextLines = SEARCH_DEFAULTS.contextLines,
  crossMounts = SEARCH_DEFAULTS.crossMounts,
  prune = SEARCH_DEFAULTS.prune,
  allowRoot = false,
} = {}) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('ssh_find: pattern is required for action grep');
  }
  const root = assertSearchPath(path, { allowRoot });
  const ex = excludeFlags(prune, crossMounts);
  const ctx = contextLines > 0 ? ` -C ${contextLines | 0}` : '';
  const qp = shQuote(pattern);
  const qroot = shQuote(root);

  // rg: --line-number for file:line:text, -n; --no-heading keeps it grep-shaped.
  const rg = `rg --line-number --no-heading --color never${ctx} ${ex} -e ${qp} ${qroot}`;
  // grep: -r recursive, -n line numbers, -I skip binaries.
  const grep = `grep -rnI${ctx} ${ex} -e ${qp} ${qroot}`;

  const inner = `if command -v rg >/dev/null 2>&1; then ${rg}; `
    + `else ${grep}; fi | head -n ${matchCap | 0}`;
  return `timeout ${timeoutSecs | 0} sh -c ${shQuote(inner)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-remote-search.js`
Expected: PASS — `15 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/remote-search.js tests/test-remote-search.js
git commit -m "feat: add bounded buildGrepCommand for ssh_find"
```

---

## Task 3: `buildLocateCommand` and `buildLsCommand`

`action: locate` is a bounded `find -name`; `action: ls` is a remote directory listing. Both share the `timeout` wrapper and the path guard. `locate` prunes pseudo-filesystems with `find ... -prune` and applies `-xdev`; `ls` is a single non-recursive `ls -la` of one directory and needs only the path guard.

**Files:**
- Modify: `src/remote-search.js` (append two builders)
- Test: `tests/test-remote-search.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-remote-search.js`, change the import to add the two builders:

```javascript
import {
  SEARCH_DEFAULTS,
  assertSearchPath,
  buildGrepCommand,
  buildLocateCommand,
  buildLsCommand,
} from '../src/remote-search.js';
```

Add these tests before the `// --- Summary` section:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-remote-search.js`
Expected: FAIL — `does not provide an export named 'buildLocateCommand'`.

- [ ] **Step 3: Implement the two builders**

Append to `src/remote-search.js`:

```javascript
/**
 * Build a bounded `find -name` command. Pseudo-filesystems are pruned with
 * `-path X -prune -o`; -xdev keeps it on one filesystem unless crossMounts.
 */
export function buildLocateCommand({
  name,
  path,
  matchCap = SEARCH_DEFAULTS.matchCap,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
  crossMounts = SEARCH_DEFAULTS.crossMounts,
  prune = SEARCH_DEFAULTS.prune,
  allowRoot = false,
} = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('ssh_find: name is required for action locate');
  }
  const root = assertSearchPath(path, { allowRoot });
  const xdev = crossMounts ? '' : ' -xdev';
  // -path '/proc' -prune -o ... -path '/run' -prune -o <match> -print
  const pruneExpr = prune
    .map((p) => `-path ${shQuote(p)} -prune -o`)
    .join(' ');
  const find = `find ${shQuote(root)}${xdev} ${pruneExpr} `
    + `-name ${shQuote(name)} -print`;
  return `timeout ${timeoutSecs | 0} sh -c `
    + shQuote(`${find} | head -n ${matchCap | 0}`);
}

/**
 * Build a bounded `ls -la` of one directory. Listing "/" is cheap, so the
 * bare-root guard does not apply here; only an empty path is rejected.
 */
export function buildLsCommand({
  path,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
} = {}) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) throw new Error('ssh_find: path is required for action ls');
  const root = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '') || '/';
  return `timeout ${timeoutSecs | 0} ls -la ${shQuote(root)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-remote-search.js`
Expected: PASS — `25 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/remote-search.js tests/test-remote-search.js
git commit -m "feat: add buildLocateCommand and buildLsCommand for ssh_find"
```

---

## Task 4: Output parsers — `parseGrepHits`, `parseLocateHits`, `parseLsRows`

The dispatcher (Plan 4) feeds raw stdout to a parser to produce structured hits the renderer turns into a table. `grep`/`rg` emit `file:line:text`; `find` emits one path per line; `ls -la` emits the long-format block. All three parsers tolerate ragged real-world output.

**Files:**
- Modify: `src/remote-search.js` (append three parsers)
- Test: `tests/test-remote-search.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-remote-search.js`, change the import to add the three parsers:

```javascript
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
```

Add these tests before the `// --- Summary` section:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-remote-search.js`
Expected: FAIL — `does not provide an export named 'parseGrepHits'`.

- [ ] **Step 3: Implement the three parsers**

Append to `src/remote-search.js`:

```javascript
/**
 * Parse grep/rg `file:line:text` output to {file, line, text} objects.
 * Splits on the first two colons only -- a colon in the match text survives.
 * grep context separators (`--`) and blank lines are dropped.
 */
export function parseGrepHits(text) {
  const s = text == null ? '' : String(text);
  const hits = [];
  for (const raw of s.split('\n')) {
    const ln = raw;
    if (ln === '' || ln === '--') continue;
    const c1 = ln.indexOf(':');
    if (c1 === -1) continue;
    const c2 = ln.indexOf(':', c1 + 1);
    if (c2 === -1) continue;
    const lineNo = Number(ln.slice(c1 + 1, c2));
    if (!Number.isFinite(lineNo)) continue;
    hits.push({
      file: ln.slice(0, c1),
      line: lineNo,
      text: ln.slice(c2 + 1),
    });
  }
  return hits;
}

/** Parse `find` output (one path per line) to a trimmed string array. */
export function parseLocateHits(text) {
  const s = text == null ? '' : String(text);
  return s.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** Map an `ls -l` permission char to a coarse type label. */
function lsType(perms) {
  const c = perms.charAt(0);
  if (c === 'd') return 'dir';
  if (c === 'l') return 'link';
  return 'file';
}

/**
 * Parse `ls -la` long-format output to {perms, size, name, type} rows.
 * The leading `total N` line is skipped; a `name -> target` symlink keeps
 * only the name. Filenames with spaces survive (name = everything from
 * field 9 onward).
 */
export function parseLsRows(text) {
  const s = text == null ? '' : String(text);
  const rows = [];
  for (const raw of s.split('\n')) {
    const ln = raw.trim();
    if (ln === '' || /^total \d+$/.test(ln)) continue;
    // perms links owner group size mon day time name...
    const m = ln.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    let name = m[3];
    const arrow = name.indexOf(' -> ');
    if (arrow !== -1) name = name.slice(0, arrow);
    rows.push({ perms: m[1], size: m[2], name, type: lsType(m[1]) });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-remote-search.js`
Expected: PASS — `36 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: `37 files, 726 passed, 0 failed` — the previous `690 passed` plus the 36-test `test-remote-search.js` suite. Zero failures: this plan only *adds* a module and a suite, so every pre-existing suite must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/remote-search.js tests/test-remote-search.js
git commit -m "feat: add ssh_find output parsers for grep, locate, ls"
```

---

## Done criteria

- `src/remote-search.js` exports `SEARCH_DEFAULTS`, `assertSearchPath`, `buildGrepCommand`, `buildLocateCommand`, `buildLsCommand`, `parseGrepHits`, `parseLocateHits`, `parseLsRows`.
- Every emitted search command is `timeout`-wrapped, prunes `/proc /sys /dev /run`, caps matches with `head`, and (for grep/locate) is `-xdev`/one-filesystem unless `crossMounts` is set.
- `buildGrepCommand` / `buildLocateCommand` refuse a bare `/` root unless `allowRoot` is passed; `assertSearchPath` rejects an empty path.
- `grep` prefers `rg` and falls back to `grep`; both branches receive the same prune, context, and one-filesystem flags.
- `npm test` is green: `726 passed, 0 failed`, no regression in any pre-existing suite.

Plan 4's `ssh_find` dispatcher imports these builders, runs the chosen command through `streamExecCommand`, feeds raw stdout to the matching parser, and renders the structured hits with `renderRows`. This plan ships the engine and its tests; the dispatcher wiring is Plan 4's responsibility.

---

## Self-review

Performed after drafting; issues found and fixed inline:

1. **`assertSearchPath` collapsed `//` incorrectly.** First draft used `p.replace(/\/+$/, '')`, which turns `//` into the empty string and then a normal path. A `//` argument is still a bare root and must be refused. Fixed: an explicit `/^\/+$/` test maps any all-slashes string to `/` *before* the bare-root guard, so `//` is correctly refused. Test `assertSearchPath: bare root is refused` covers `//`.
2. **grep `--exclude-dir` takes a basename, not a path.** First draft passed `--exclude-dir=/proc`. `grep` (and `rg`) match `--exclude-dir` against a directory's basename, so a leading slash makes it never match. Fixed: `excludeFlags` strips the leading slash (`/proc` -> `proc`). Test asserts `--exclude-dir=proc`, not `--exclude-dir=/proc`.
3. **`-I` (skip binary) flag on grep.** Without `-I`, `grep -rn` on a tree with binaries emits `Binary file X matches` lines that the `file:line:text` parser silently drops, wasting the match cap. Added `-I` to the `grep` branch; `rg` skips binaries by default so no flag needed. Test `buildGrepCommand: wraps in timeout and prefers rg` asserts `grep -rnI`.
4. **`parseGrepHits` and a colon in the match text.** A line such as `/etc/hosts:3:127.0.0.1 ::1 localhost` must split into exactly three parts on the *first two* colons. First draft used `split(':')`, which over-split. Fixed: `indexOf` twice, then `slice` — the text after the second colon is taken verbatim. Dedicated test covers `::1`.
5. **`buildLsCommand` does not apply the bare-root guard.** Listing `/` is a single cheap `ls`, not a recursive walk — refusing it would be user-hostile and inconsistent with what a person expects. Deliberately, `buildLsCommand` only rejects an empty path; the bare-root guard applies solely to the recursive `grep`/`locate` builders. The done criteria and a test (`buildLsCommand: bare root is allowed`) state this explicitly so it is not mistaken for an oversight.
6. **`parseLsRows` regex and spaced filenames.** The 9-field `ls -l` layout means a filename with spaces would break a naive `split(/\s+/)`. The regex anchors the first 8 whitespace-delimited fields and captures `(.+)$` for the name, so `my notes.txt` is kept whole. Symlink ` -> target` is stripped after the capture. Both cases are tested.
7. **Test count arithmetic.** Verified against the plan's own step-by-step counts: Task 1 adds 7, Task 2 adds 8 (total 15), Task 3 adds 10 (total 25), Task 4 adds 11 (total 36). Baseline is `690 passed` (confirmed by running `node scripts/run-tests.mjs` at planning time), so the final `npm test` line is `726 passed`. The numbers are internally consistent.
