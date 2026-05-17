# ssh-mcp v4 Command-Output Compressors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-command output compression — recognise the command type and shape its output (drop `ls` `total` lines, cap `ps` rows) — running ahead of head+tail truncation, with a universal `raw: true` bypass.

**Architecture:** New `src/command-compressors.js` holds a `compress(command, text, opts)` dispatcher plus per-command compressor functions. `formatExecResult` in `src/output-formatter.js` calls `compress` between ANSI-stripping and truncation, and gains a `raw` option to bypass it. Compression is purely additive to the pipeline — when no compressor matches, output is returned unchanged.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`.

This is Plan 3 of 6. Plans 1-2 (render primitives, output rewrite) are complete. Plan 4: 13-tool dispatcher facade. Plan 5: new capabilities. Plan 6: adoption. The `df`, `git log`, and test-runner compressors are intentionally deferred to a later plan — `ps` and `ls` are the high-volume cases. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` section 4.

---

## File Structure

- **Create `src/command-compressors.js`** — the `compress` dispatcher, the per-command compressor functions (`compressLs`, `compressPs`), and a shared footer helper. One file, one responsibility: turning raw command output into shorter output.
- **Modify `src/output-formatter.js`** — `formatExecResult` calls `compress` and accepts a `raw` option.
- **Create `tests/test-command-compressors.js`** — suite for the module. Auto-discovered by `scripts/run-tests.mjs`.

Compression order in the pipeline: raw stdout → `stripAnsi` → `compress` → `truncateHeadTail` → render. Compressors must see un-truncated input, so `compress` runs before `truncateHeadTail`.

---

## Task 1: Compressor module with `ls` compressor

Create the module with the `compress` dispatcher, a shared footer, and the `ls` compressor (drops the leading `total N` summary line).

**Files:**
- Create: `src/command-compressors.js`
- Test: `tests/test-command-compressors.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-command-compressors.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-command-compressors.js`
Expected: FAIL — `Cannot find module '../src/command-compressors.js'`.

- [ ] **Step 3: Write the module**

Create `src/command-compressors.js`:

```javascript
/**
 * Command-output compressors. Per-command-type shaping that runs after
 * ANSI stripping and before head+tail truncation. raw:true bypasses all of it.
 *
 * Each compressor is pure: (text) -> { text, dropped }. The dispatcher appends
 * a footer naming the raw escape hatch whenever a compressor dropped anything.
 */

/** Escape-hatch footer appended when output was compressed. */
function footer(dropped) {
  return `\n... ${dropped} line${dropped === 1 ? '' : 's'} compressed`
    + ' -- re-run with raw: true for full output';
}

/**
 * Drop a leading `total N` summary line (the `ls -l` block-count header).
 */
export function compressLs(text) {
  const s = String(text == null ? '' : text);
  const nl = s.indexOf('\n');
  const first = (nl === -1 ? s : s.slice(0, nl)).trim();
  if (/^total \d+$/.test(first)) {
    return { text: nl === -1 ? '' : s.slice(nl + 1), dropped: 1 };
  }
  return { text: s, dropped: 0 };
}

// command-prefix -> compressor. First match wins.
const COMPRESSORS = [
  { match: /^ls(\s|$)/, fn: compressLs },
];

/**
 * Compress command output by command type. raw:true returns text unchanged.
 * Unmatched commands return unchanged. A footer is appended only when a
 * compressor actually dropped lines.
 */
export function compress(command, text, { raw = false } = {}) {
  const s = String(text == null ? '' : text);
  if (raw || s === '') return s;
  const cmd = String(command == null ? '' : command).trim();
  for (const { match, fn } of COMPRESSORS) {
    if (match.test(cmd)) {
      const out = fn(s);
      return out.dropped > 0 ? out.text + footer(out.dropped) : out.text;
    }
  }
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-command-compressors.js`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/command-compressors.js tests/test-command-compressors.js
git commit -m "feat: add command-output compressor module with ls compressor"
```

---

## Task 2: `ps` compressor

Add a `ps` compressor: keep the header line plus the top 15 rows, drop the rest. `ps` output from the v4 process tools is pre-sorted by CPU, so the top rows are the meaningful ones; the long idle tail is what floods context.

**Files:**
- Modify: `src/command-compressors.js`
- Test: `tests/test-command-compressors.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-command-compressors.js`, change the import line to add `compressPs`:

```javascript
import { compress, compressLs, compressPs } from '../src/command-compressors.js';
```

Add these tests before the `// --- Summary` section:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-command-compressors.js`
Expected: FAIL — `does not provide an export named 'compressPs'`.

- [ ] **Step 3: Add the `ps` compressor**

In `src/command-compressors.js`, add the `compressPs` function after `compressLs`:

```javascript
/** Rows to keep from a ps listing (header is kept on top of these). */
const PS_KEEP = 15;

/**
 * Keep the ps header line plus the top PS_KEEP rows; drop the idle tail.
 * Input is assumed CPU-sorted (the v4 process tools sort with --sort=-%cpu).
 */
export function compressPs(text) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  if (lines.length <= PS_KEEP + 1) return { text: s, dropped: 0 };
  const kept = lines.slice(0, PS_KEEP + 1);
  return { text: kept.join('\n'), dropped: lines.length - kept.length };
}
```

Then extend the `COMPRESSORS` array to register it. Replace:

```javascript
const COMPRESSORS = [
  { match: /^ls(\s|$)/, fn: compressLs },
];
```

with:

```javascript
const COMPRESSORS = [
  { match: /^ls(\s|$)/, fn: compressLs },
  // ps may appear after `sudo ` or a pipe/`;`/`&`.
  { match: /(^|[|;&]\s*|^sudo\s+)ps(\s|$)/, fn: compressPs },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-command-compressors.js`
Expected: PASS — `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/command-compressors.js tests/test-command-compressors.js
git commit -m "feat: add ps command-output compressor"
```

---

## Task 3: Wire `compress` into `formatExecResult`

Make `formatExecResult` run `compress` between `stripAnsi` and `truncateHeadTail`, and accept a `raw` option that bypasses compression.

**Files:**
- Modify: `src/output-formatter.js`
- Test: `tests/test-output-formatter.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-output-formatter.js`, add these tests immediately before the `// --- formatBytes` section:

```javascript
test('formatExecResult: ps stdout is compressed by default', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `r${i}`).join('\n');
  const r = formatExecResult({
    server: 's', command: 'ps -eo pid,args', stdout: 'HEAD\n' + rows,
    stderr: '', code: 0, durationMs: 1,
  });
  assert(r.stdout.includes('compressed'), 'compressor footer present');
  assert(r.stdout.split('\n').length < 41, 'tail rows dropped');
});

test('formatExecResult: raw:true skips compression', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `r${i}`).join('\n');
  const r = formatExecResult({
    server: 's', command: 'ps -eo pid,args', stdout: 'HEAD\n' + rows,
    stderr: '', code: 0, durationMs: 1, raw: true,
  });
  assert(!r.stdout.includes('compressed'), 'no compression when raw');
  assert.strictEqual(r.stdout, 'HEAD\n' + rows);
});

test('formatExecResult: non-ps/ls command output is untouched', () => {
  const r = formatExecResult({
    server: 's', command: 'echo hi', stdout: 'hi\nthere',
    stderr: '', code: 0, durationMs: 1,
  });
  assert.strictEqual(r.stdout, 'hi\nthere');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-output-formatter.js`
Expected: FAIL — `formatExecResult: ps stdout is compressed by default` fails because `formatExecResult` does not yet call `compress`.

- [ ] **Step 3: Wire `compress` into `formatExecResult`**

In `src/output-formatter.js`, add this import at the top of the file, after the existing `import { OUTPUT_LIMITS } from './config.js';` line:

```javascript
import { compress } from './command-compressors.js';
```

Replace the entire `formatExecResult` function with:

```javascript
/**
 * Build the structured ExecResult from raw stream output.
 * Input: { server, command, cwd?, stdout, stderr, code, durationMs, maxLen?, raw? }
 * Output: wire-schema JSON object.
 *
 * stdout passes through compress() (per-command shaping) before truncation;
 * raw:true bypasses compression. stderr is never compressed -- errors stay whole.
 */
export function formatExecResult({
  server,
  command,
  cwd,
  stdout,
  stderr,
  code,
  durationMs,
  maxLen = OUTPUT_LIMITS.MAX_OUTPUT_LENGTH,
  raw = false,
}) {
  const shapedStdout = compress(command, stripAnsi(stdout), { raw });
  const out = truncateHeadTail(shapedStdout, maxLen);
  const err = truncateHeadTail(stripAnsi(stderr), maxLen);
  return {
    server,
    command,
    cwd: cwd ?? null,
    exit_code: code ?? -1,
    success: code === 0,
    duration_ms: Math.max(0, durationMs | 0),
    stdout: out.text,
    stderr: err.text,
    truncated: {
      stdout_bytes: out.truncatedBytes,
      stderr_bytes: err.truncatedBytes,
      stdout_total: out.originalBytes,
      stderr_total: err.originalBytes,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-output-formatter.js`
Expected: PASS — all tests green, including the three new ones.

The pre-existing `formatExecResult: ANSI stripped before truncation` test uses `command: 'ls --color'` with stdout `dir1\ndir2`. `compressLs` finds no `total` line, so it returns the text unchanged and that test still passes. No other pre-existing `formatExecResult` test uses an `ls`- or `ps`-prefixed command.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `36 files, 687 passed, 0 failed` — the previous 673, plus the 11-test `test-command-compressors.js` suite, plus the 3 new `formatExecResult` tests. Zero failures, no regression in any pre-existing suite.

- [ ] **Step 6: Commit**

```bash
git add src/output-formatter.js tests/test-output-formatter.js
git commit -m "feat: run command-output compression in formatExecResult"
```

---

## Done criteria

- `src/command-compressors.js` exports `compress`, `compressLs`, `compressPs`.
- `formatExecResult` compresses `stdout` (per command type) before truncating; `raw: true` bypasses it; `stderr` is never compressed.
- A compressed result carries the `re-run with raw: true` footer.
- `npm test` is green with the new `test-command-compressors.js` suite and zero regressions.

Plan 4 (13-tool dispatcher facade) threads a `raw` argument from each tool's input schema through to `formatExecResult`, and adds the `df` / `git log` / test-runner compressors when their owning tools are built.
