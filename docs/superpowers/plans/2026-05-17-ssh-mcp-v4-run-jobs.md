# ssh-mcp v4 Run Script and Detach Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two engines behind the new `ssh_run` actions. `src/script-runner.js` turns a `commands` array into ONE remote exec with per-segment exit codes (sentinel-delimited), so `cmd1; cmd2; cmd3` chains run in one round-trip with shared shell state. `src/job-tracker.js` powers `detach` / `job-status` / `job-kill`: a backgrounded job lands an `rc`/`pid`/`log` trio in `~/.ssh-manager/jobs/<id>/` on the remote host, and completion is decided by the *presence of the `rc` file*, not PID liveness.

**Architecture:** Two new pure modules. `src/script-runner.js` exports a command **builder** (`buildScriptCommand`) and an output **parser** (`parseScriptSegments`). `src/job-tracker.js` exports `buildDetachCommand`, `buildJobStatusCommand`, `buildJobKillCommand`, `parseJobStatus`, plus `newJobId`. Both modules are I/O-free: builders return POSIX-`sh` strings, parsers turn raw stdout into structured objects. Plan 4's `ssh_run` dispatcher wires these to `streamExecCommand` and the incremental-offset log reader. Shipping the engines standalone means this plan does not depend on the parallel-authored dispatcher existing yet. Nothing existing is modified — purely additive, so `npm test` stays green throughout.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`. `shQuote` is reused from `src/stream-exec.js`.

This is Plan 5b of the v4 series (Plans 1-3 — render primitives, output rewrite, compressors — are complete; Plan 4 builds the 13-tool dispatcher facade). Plans 5a (`ssh_find`) and 5c (connection reuse + timeout escalation) are siblings. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` sections 6, 7.

---

## File Structure

- **Create `src/script-runner.js`** — `buildScriptCommand` joins a `commands` array with exit-capturing sentinels; `parseScriptSegments` splits the result back into per-segment `{index, command, stdout, exitCode}`. Pure.
- **Create `src/job-tracker.js`** — `newJobId`, `buildDetachCommand`, `buildJobStatusCommand`, `buildJobKillCommand`, `parseJobStatus`. Pure; the remote job dir is `~/.ssh-manager/jobs/<id>/`.
- **Create `tests/test-script-runner.js`** — new suite. Auto-discovered by `scripts/run-tests.mjs`.
- **Create `tests/test-job-tracker.js`** — new suite. Auto-discovered.

The modules execute nothing. Each builder returns a string the Plan 4 dispatcher runs; every server-side guarantee is therefore assertable as a substring with zero network in the suite.

---

## Task 1: `buildScriptCommand` — one exec, exit-capturing sentinels

`ssh_run action: script` replaces a raw `ssh host 'cmd1; cmd2; cmd3'`. The spec is explicit: a **single exec** over the pooled connection, segments joined server-side, each followed by an exit-capturing sentinel `printf '\n##SEG %d %d##\n' <idx> $?`. One round-trip; per-segment exit codes; `cd`/env state shared across segments because it is one shell.

**Files:**
- Create: `src/script-runner.js`
- Test: `tests/test-script-runner.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-script-runner.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for src/script-runner.js -- ssh_run action:script engine.
 * Run: node tests/test-script-runner.js
 */
import assert from 'assert';
import { SEG_RE, buildScriptCommand } from '../src/script-runner.js';

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

console.log('[test] Testing script-runner\n');

// --- buildScriptCommand --------------------------------------------------
test('buildScriptCommand: joins commands into a single exec string', () => {
  const cmd = buildScriptCommand(['echo a', 'echo b']);
  assert.strictEqual(typeof cmd, 'string');
  assert(cmd.includes('echo a'), 'first segment present');
  assert(cmd.includes('echo b'), 'second segment present');
});

test('buildScriptCommand: a sentinel with index + $? follows each segment', () => {
  const cmd = buildScriptCommand(['true', 'false']);
  // printf '\n##SEG %d %d##\n' 0 $?  -- one per segment
  const sentinels = cmd.match(/##SEG %d %d##/g) || [];
  assert.strictEqual(sentinels.length, 2, 'one sentinel per segment');
  assert(cmd.includes("printf '\\n##SEG %d %d##\\n' 0 $?"), 'segment 0 sentinel');
  assert(cmd.includes("printf '\\n##SEG %d %d##\\n' 1 $?"), 'segment 1 sentinel');
});

test('buildScriptCommand: segments are NOT && chained -- a failure does not abort', () => {
  const cmd = buildScriptCommand(['false', 'echo still-runs']);
  assert(!cmd.includes('&&'), 'no && between segments');
  // `;` lets the next segment run even after a non-zero exit.
  assert(cmd.includes(';'), 'segments separated so all run');
});

test('buildScriptCommand: default joins segments in one shell (shared state)', () => {
  const cmd = buildScriptCommand(['cd /tmp', 'pwd']);
  // No `sh -c` wrapper per segment: it is one process, so `cd` carries over.
  assert(!/sh -c .* sh -c /.test(cmd), 'not one sub-shell per segment');
});

test('buildScriptCommand: isolate:true wraps each segment in its own sh -c', () => {
  const cmd = buildScriptCommand(['cd /tmp', 'pwd'], { isolate: true });
  const subs = cmd.match(/sh -c /g) || [];
  assert.strictEqual(subs.length, 2, 'one sub-shell per segment when isolated');
});

test('buildScriptCommand: empty / non-array commands is rejected', () => {
  assert.throws(() => buildScriptCommand([]), /at least one command/);
  assert.throws(() => buildScriptCommand(null), /at least one command/);
});

test('buildScriptCommand: a non-string segment is rejected', () => {
  assert.throws(() => buildScriptCommand(['ok', 42]), /must be a string/);
});

test('SEG_RE: matches the emitted sentinel and captures index + code', () => {
  const m = '\n##SEG 3 127##\n'.match(SEG_RE);
  assert(m, 'sentinel matched');
  assert.strictEqual(m[1], '3', 'segment index captured');
  assert.strictEqual(m[2], '127', 'exit code captured');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-script-runner.js`
Expected: FAIL — `Cannot find module '../src/script-runner.js'`.

- [ ] **Step 3: Write `buildScriptCommand`**

Create `src/script-runner.js`:

```javascript
/**
 * ssh_run action:script engine. Joins a commands array into ONE remote exec
 * with exit-capturing sentinels, so a cmd1;cmd2;cmd3 chain runs in a single
 * round-trip with shared shell state. parseScriptSegments splits it back.
 *
 * Pure: buildScriptCommand returns a POSIX-sh string, parseScriptSegments
 * turns raw stdout into per-segment results. The dispatcher (Plan 4) execs.
 */

/**
 * Matches one emitted sentinel: `\n##SEG <index> <exit-code>##\n`.
 * Group 1 = segment index, group 2 = that segment's $?.
 */
export const SEG_RE = /\n##SEG (\d+) (\d+)##\n/;

/** Global twin of SEG_RE for splitting a whole stdout blob. */
const SEG_RE_G = /\n##SEG (\d+) (\d+)##\n/g;

/**
 * Build the single-exec script string.
 * Each segment is followed by `printf '\n##SEG %d %d##\n' <idx> $?` so $?
 * is captured BEFORE the next segment runs. Segments are `;`-separated, not
 * `&&`-chained: a non-zero segment never aborts the rest.
 *
 * isolate:true wraps each segment in its own `sh -c` -- separate shells, no
 * shared cd/env -- for the rare caller that needs state isolation.
 */
export function buildScriptCommand(commands, { isolate = false } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('ssh_run script: at least one command is required');
  }
  const parts = [];
  commands.forEach((c, i) => {
    if (typeof c !== 'string') {
      throw new Error(`ssh_run script: command ${i} must be a string`);
    }
    // isolate => run the segment in a child shell; $? is the child's exit.
    const body = isolate
      ? `sh -c ${shQuoteLocal(c)}`
      : `{ ${c}\n; }`;
    parts.push(`${body}; printf '\\n##SEG %d %d##\\n' ${i} $?`);
  });
  return parts.join('\n');
}

/**
 * Split raw script stdout into per-segment results using the sentinels.
 * Returns [{ index, command, stdout, exitCode }]. `commands` is the original
 * array, used to label each segment; a segment with no sentinel (the script
 * was killed mid-run) gets exitCode null.
 */
export function parseScriptSegments(stdout, commands = []) {
  const s = stdout == null ? '' : String(stdout);
  const segments = [];
  let lastIndex = 0;
  let m;
  SEG_RE_G.lastIndex = 0;
  while ((m = SEG_RE_G.exec(s)) !== null) {
    const idx = Number(m[1]);
    segments.push({
      index: idx,
      command: commands[idx] != null ? commands[idx] : null,
      stdout: s.slice(lastIndex, m.index),
      exitCode: Number(m[2]),
    });
    lastIndex = m.index + m[0].length;
  }
  // Trailing output after the last sentinel = an unfinished segment.
  const tail = s.slice(lastIndex);
  if (tail.trim() !== '') {
    const idx = segments.length;
    segments.push({
      index: idx,
      command: commands[idx] != null ? commands[idx] : null,
      stdout: tail,
      exitCode: null,
    });
  }
  return segments;
}

/**
 * Local POSIX shell-quoter. A copy of stream-exec.js's shQuote kept here so
 * script-runner has no cross-module coupling for one tiny helper.
 */
function shQuoteLocal(str) {
  return `'${String(str).replace(/'/g, '\'\\\'\'')}'`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-script-runner.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/script-runner.js tests/test-script-runner.js
git commit -m "feat: add buildScriptCommand for ssh_run action script"
```

---

## Task 2: `parseScriptSegments` — split a result back into per-segment exits

`buildScriptCommand` is half the contract; the renderer needs the result split back into `{index, command, stdout, exitCode}` per segment. The function is already present in the Task 1 module body — this task adds its test coverage, including the killed-mid-run case.

**Files:**
- Modify: `tests/test-script-runner.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-script-runner.js`, change the import to add `parseScriptSegments`:

```javascript
import {
  SEG_RE,
  buildScriptCommand,
  parseScriptSegments,
} from '../src/script-runner.js';
```

Add these tests before the `// --- Summary` section:

```javascript
// --- parseScriptSegments -------------------------------------------------
test('parseScriptSegments: splits stdout into per-segment results', () => {
  const raw = 'a-out\n##SEG 0 0##\nb-out\n##SEG 1 0##\n';
  const segs = parseScriptSegments(raw, ['echo a', 'echo b']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].stdout, 'a-out');
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[0].command, 'echo a');
  assert.strictEqual(segs[1].stdout, 'b-out');
});

test('parseScriptSegments: a non-zero segment exit is reported per segment', () => {
  const raw = 'ok\n##SEG 0 0##\n\n##SEG 1 127##\n';
  const segs = parseScriptSegments(raw, ['true', 'nosuchcmd']);
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[1].exitCode, 127, 'failure surfaced for its segment');
});

test('parseScriptSegments: output after the last sentinel = unfinished segment', () => {
  // Script killed mid-segment 1: no closing sentinel for it.
  const raw = 'done\n##SEG 0 0##\nhalf-out';
  const segs = parseScriptSegments(raw, ['echo done', 'sleep 99']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[1].stdout, 'half-out');
  assert.strictEqual(segs[1].exitCode, null, 'no exit code for a killed segment');
  assert.strictEqual(segs[1].command, 'sleep 99');
});

test('parseScriptSegments: trailing whitespace after last sentinel is not a segment', () => {
  const raw = 'x\n##SEG 0 0##\n\n  \n';
  const segs = parseScriptSegments(raw, ['echo x']);
  assert.strictEqual(segs.length, 1, 'blank tail ignored');
});

test('parseScriptSegments: empty / nullish stdout -> empty array', () => {
  assert.deepStrictEqual(parseScriptSegments('', []), []);
  assert.deepStrictEqual(parseScriptSegments(null, []), []);
});

test('parseScriptSegments: command label is null when commands array is short', () => {
  const segs = parseScriptSegments('o\n##SEG 0 0##\n', []);
  assert.strictEqual(segs[0].command, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-script-runner.js`
Expected: the `import` line resolves (`parseScriptSegments` is exported), so the failure is in the new tests only — except it should actually PASS, because `parseScriptSegments` was written in Task 1. If every new test passes immediately, that is acceptable: the function shipped with its sibling in Task 1 and this task is its dedicated coverage. Proceed to the commit.

If any test fails, the function has a real bug — fix `parseScriptSegments` in `src/script-runner.js` before continuing.

- [ ] **Step 3: Run the full script-runner suite**

Run: `node tests/test-script-runner.js`
Expected: PASS — `14 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add tests/test-script-runner.js
git commit -m "test: cover parseScriptSegments per-segment splitting"
```

---

## Task 3: Job-tracker — `newJobId` and `buildDetachCommand`

`ssh_run action: detach` runs a long job in the background and returns immediately. The spec's job model: state lives on the *remote* host in `~/.ssh-manager/jobs/<id>/`, holding `rc` (exit code, written on completion), `pid`, and `log`. The launch line is `setsid sh -c '<cmd>; echo $? > rc' > log 2>&1 & echo $! > pid`, so the job survives an MCP restart or a pooled-connection eviction.

**Files:**
- Create: `src/job-tracker.js`
- Test: `tests/test-job-tracker.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-job-tracker.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for src/job-tracker.js -- ssh_run detach/job-status/job-kill.
 * Run: node tests/test-job-tracker.js
 */
import assert from 'assert';
import {
  JOBS_ROOT,
  newJobId,
  buildDetachCommand,
} from '../src/job-tracker.js';

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

console.log('[test] Testing job-tracker\n');

// --- JOBS_ROOT -----------------------------------------------------------
test('JOBS_ROOT: jobs live under ~/.ssh-manager/jobs', () => {
  assert.strictEqual(JOBS_ROOT, '$HOME/.ssh-manager/jobs');
});

// --- newJobId ------------------------------------------------------------
test('newJobId: returns a non-empty, shell-safe id', () => {
  const id = newJobId();
  assert(typeof id === 'string' && id.length > 0);
  // Only safe characters -- the id becomes a directory name.
  assert(/^[A-Za-z0-9_-]+$/.test(id), 'id is filesystem/shell safe');
});

test('newJobId: successive ids are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newJobId());
  assert.strictEqual(seen.size, 200, 'no collisions across 200 ids');
});

// --- buildDetachCommand --------------------------------------------------
test('buildDetachCommand: creates the per-job dir and returns {jobId, command, ...}', () => {
  const r = buildDetachCommand('long-build.sh');
  assert(r.jobId, 'job id present');
  assert(r.command.includes('mkdir -p'), 'job dir created');
  assert(r.command.includes(r.jobId), 'job dir path uses the id');
  assert(r.logPath.includes(r.jobId), 'log path under the job dir');
});

test('buildDetachCommand: detaches with setsid and writes rc on completion', () => {
  const r = buildDetachCommand('make all');
  assert(r.command.includes('setsid'), 'detached from the SSH session');
  // `echo $? > .../rc` -- completion marker, written after the command.
  assert(/echo \$\? >/.test(r.command), 'rc file captures the exit code');
  assert(r.command.includes('/rc'), 'rc file inside the job dir');
});

test('buildDetachCommand: records the pid for later job-kill', () => {
  const r = buildDetachCommand('sleep 100');
  // `echo $! > .../pid` -- the backgrounded pid.
  assert(/echo \$! >/.test(r.command), 'pid recorded');
  assert(r.command.includes('/pid'), 'pid file inside the job dir');
});

test('buildDetachCommand: log + stderr both redirected into the job log', () => {
  const r = buildDetachCommand('noisy.sh');
  assert(r.command.includes('2>&1'), 'stderr folded into stdout');
  assert(r.command.includes('/log'), 'job log inside the job dir');
});

test('buildDetachCommand: the user command is shell-quoted (injection-safe)', () => {
  const r = buildDetachCommand("x'; rm -rf /");
  // The rm text may appear only inside a quoted literal.
  assert(!/[^']rm -rf \//.test(r.command), 'no unquoted rm in the command');
});

test('buildDetachCommand: an explicit job id is honored', () => {
  const r = buildDetachCommand('echo hi', { jobId: 'fixed-id-1' });
  assert.strictEqual(r.jobId, 'fixed-id-1');
  assert(r.command.includes('fixed-id-1'));
});

test('buildDetachCommand: empty command is rejected', () => {
  assert.throws(() => buildDetachCommand(''), /command is required/);
  assert.throws(() => buildDetachCommand(null), /command is required/);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-job-tracker.js`
Expected: FAIL — `Cannot find module '../src/job-tracker.js'`.

- [ ] **Step 3: Write the module skeleton with `newJobId` + `buildDetachCommand`**

Create `src/job-tracker.js`:

```javascript
/**
 * ssh_run detach / job-status / job-kill engine. Job state lives on the
 * REMOTE host under ~/.ssh-manager/jobs/<id>/ as three files: rc (exit code,
 * written on completion), pid, log. Completion is decided by the rc file's
 * presence -- never by PID liveness -- so there is no PID-reuse race and a
 * job survives an MCP restart or a pooled-connection eviction.
 *
 * Pure: builders return POSIX-sh strings, parseJobStatus turns raw stdout
 * into a structured status. The dispatcher (Plan 4) execs and reads the log
 * incrementally by offset.
 */

import crypto from 'crypto';

/** Remote root for job directories. `$HOME` expands on the remote shell. */
export const JOBS_ROOT = '$HOME/.ssh-manager/jobs';

/** A short, unique, filesystem/shell-safe job id. */
export function newJobId() {
  // 9 random bytes -> 12 base64url chars; collision-free for practical use.
  return crypto.randomBytes(9).toString('base64url');
}

/** Shell-quote a token for POSIX sh (single-quote wrap, escape inner quote). */
function shQuoteLocal(str) {
  return `'${String(str).replace(/'/g, '\'\\\'\'')}'`;
}

/**
 * Build the detach launch command. Returns { jobId, jobDir, logPath, command }.
 *
 * The command:
 *   mkdir -p <jobDir>
 *   && setsid sh -c '<cmd>; echo $? > <jobDir>/rc' > <jobDir>/log 2>&1 &
 *   echo $! > <jobDir>/pid
 *
 * setsid detaches the job from the SSH session's process group, so closing
 * the channel does not kill it. rc is written only after the command exits.
 */
export function buildDetachCommand(command, { jobId = newJobId() } = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new Error('ssh_run detach: command is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  const logPath = `${jobDir}/log`;
  // Inner script: run the user command, then record its exit code in rc.
  const inner = `${command}; echo $? > ${jobDir}/rc`;
  const cmd =
    `mkdir -p ${jobDir} && `
    + `{ setsid sh -c ${shQuoteLocal(inner)} > ${logPath} 2>&1 & `
    + `echo $! > ${jobDir}/pid; }`;
  return { jobId, jobDir, logPath, command: cmd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-job-tracker.js`
Expected: PASS — `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/job-tracker.js tests/test-job-tracker.js
git commit -m "feat: add job-tracker detach launch builder"
```

---

## Task 4: `buildJobStatusCommand` + `parseJobStatus` — rc-presence completion

`ssh_run action: job-status` must answer "is this job done, and what is its exit code" plus stream the *new* tail of the log. The spec is emphatic: completion is `rc` file **presence**, not PID liveness — a finished short job whose PID was reused by an unrelated process must still read as `done`. The status command emits a small parseable block; the log tail is read incrementally by byte offset.

**Files:**
- Modify: `src/job-tracker.js` (append `buildJobStatusCommand`, `parseJobStatus`)
- Test: `tests/test-job-tracker.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-job-tracker.js`, change the import to add the two new functions:

```javascript
import {
  JOBS_ROOT,
  newJobId,
  buildDetachCommand,
  buildJobStatusCommand,
  parseJobStatus,
} from '../src/job-tracker.js';
```

Add these tests before the `// --- Summary` section:

```javascript
// --- buildJobStatusCommand -----------------------------------------------
test('buildJobStatusCommand: reads rc, pid, and the log size', () => {
  const cmd = buildJobStatusCommand('job-7');
  assert(cmd.includes('job-7'), 'targets the job dir');
  assert(cmd.includes('/rc'), 'reads the rc file');
  assert(cmd.includes('/pid'), 'reads the pid file');
  assert(cmd.includes('/log'), 'inspects the log');
});

test('buildJobStatusCommand: emits parseable key markers', () => {
  const cmd = buildJobStatusCommand('j');
  // The command prints lines the parser keys on.
  assert(cmd.includes('RC='), 'rc marker emitted');
  assert(cmd.includes('PID='), 'pid marker emitted');
  assert(cmd.includes('LOGSIZE='), 'log size marker emitted');
});

test('buildJobStatusCommand: reads the log tail from a byte offset', () => {
  const cmd = buildJobStatusCommand('j', { offset: 4096 });
  // Incremental read -- only bytes after the offset, like follow-read.
  assert(cmd.includes('4096'), 'offset threaded into the command');
  assert(/tail -c|dd .*bs=1.*skip=/.test(cmd), 'reads from the offset');
});

test('buildJobStatusCommand: a missing job dir is reported, not a hard error', () => {
  const cmd = buildJobStatusCommand('gone');
  // The command tolerates absence so the parser can say "unknown".
  assert(/MISSING|2>\/dev\/null|test -d/.test(cmd), 'absence handled in-band');
});

test('buildJobStatusCommand: empty job id is rejected', () => {
  assert.throws(() => buildJobStatusCommand(''), /job id is required/);
});

// --- parseJobStatus ------------------------------------------------------
test('parseJobStatus: rc file present -> done with that exit code', () => {
  const st = parseJobStatus(
    'STATE=present\nRC=0\nPID=1234\nLOGSIZE=512\n##LOG##\nbuild complete',
  );
  assert.strictEqual(st.state, 'done');
  assert.strictEqual(st.exitCode, 0);
  assert.strictEqual(st.logChunk, 'build complete');
  assert.strictEqual(st.logSize, 512);
});

test('parseJobStatus: rc present and non-zero -> done, failure exit surfaced', () => {
  const st = parseJobStatus('STATE=present\nRC=2\nPID=99\nLOGSIZE=10\n##LOG##\nerr');
  assert.strictEqual(st.state, 'done');
  assert.strictEqual(st.exitCode, 2);
});

test('parseJobStatus: no rc file -> running, exit code is null', () => {
  // rc absent: the status command prints RC= empty. Job not finished.
  const st = parseJobStatus('STATE=present\nRC=\nPID=4567\nLOGSIZE=88\n##LOG##\npartial');
  assert.strictEqual(st.state, 'running', 'rc absent => running, NOT pid-checked');
  assert.strictEqual(st.exitCode, null);
  assert.strictEqual(st.pid, 4567);
});

test('parseJobStatus: completion ignores PID liveness entirely', () => {
  // rc present even though PID would look dead -- still done. No PID-reuse race.
  const st = parseJobStatus('STATE=present\nRC=0\nPID=\nLOGSIZE=4\n##LOG##\nout');
  assert.strictEqual(st.state, 'done', 'rc presence wins; empty PID irrelevant');
});

test('parseJobStatus: missing job dir -> unknown state', () => {
  const st = parseJobStatus('STATE=missing');
  assert.strictEqual(st.state, 'unknown');
});

test('parseJobStatus: logSize feeds the next incremental read', () => {
  const st = parseJobStatus('STATE=present\nRC=\nPID=1\nLOGSIZE=2048\n##LOG##\n');
  assert.strictEqual(st.logSize, 2048, 'caller passes this back as next offset');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-job-tracker.js`
Expected: FAIL — `does not provide an export named 'buildJobStatusCommand'`.

- [ ] **Step 3: Implement `buildJobStatusCommand` + `parseJobStatus`**

Append to `src/job-tracker.js`:

```javascript
/**
 * Build the job-status command. Prints a small keyed block plus the log
 * tail from `offset` bytes onward. `rc` presence (not PID liveness) decides
 * completion -- `cat rc 2>/dev/null` yields the code, or empty if unwritten.
 *
 * Emitted block:
 *   STATE=present|missing
 *   RC=<code or empty>
 *   PID=<pid or empty>
 *   LOGSIZE=<bytes>
 *   ##LOG##
 *   <log bytes after offset>
 */
export function buildJobStatusCommand(jobId, { offset = 0 } = {}) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('ssh_run job-status: job id is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  const off = offset | 0;
  // wc -c after +<off> yields bytes-from-offset; tail -c +N is 1-indexed.
  return (
    `if test -d ${jobDir}; then `
    + `echo STATE=present; `
    + `echo "RC=$(cat ${jobDir}/rc 2>/dev/null)"; `
    + `echo "PID=$(cat ${jobDir}/pid 2>/dev/null)"; `
    + `echo "LOGSIZE=$(wc -c < ${jobDir}/log 2>/dev/null || echo 0)"; `
    + `echo '##LOG##'; `
    + `tail -c +${off + 1} ${jobDir}/log 2>/dev/null; `
    + `else echo STATE=missing; fi`
  );
}

/**
 * Parse job-status output into { state, exitCode, pid, logSize, logChunk }.
 *   state: 'done' (rc file present) | 'running' (dir present, no rc)
 *          | 'unknown' (job dir missing)
 * exitCode is the rc value when done, else null. PID liveness is never
 * consulted -- rc presence alone decides completion.
 */
export function parseJobStatus(stdout) {
  const s = stdout == null ? '' : String(stdout);
  const logMark = s.indexOf('\n##LOG##\n');
  const head = logMark === -1 ? s : s.slice(0, logMark);
  const logChunk = logMark === -1 ? '' : s.slice(logMark + '\n##LOG##\n'.length);

  const field = (key) => {
    const m = head.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  if (field('STATE') === 'missing') {
    return { state: 'unknown', exitCode: null, pid: null, logSize: 0, logChunk: '' };
  }

  const rc = field('RC');
  const pidRaw = field('PID');
  const sizeRaw = field('LOGSIZE');
  const hasRc = rc !== '';

  return {
    state: hasRc ? 'done' : 'running',
    exitCode: hasRc ? Number(rc) : null,
    pid: pidRaw === '' ? null : Number(pidRaw),
    logSize: sizeRaw === '' ? 0 : Number(sizeRaw),
    logChunk,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-job-tracker.js`
Expected: PASS — `22 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/job-tracker.js tests/test-job-tracker.js
git commit -m "feat: add job-status command and rc-presence parser"
```

---

## Task 5: `buildJobKillCommand` — terminate the job's process group

`ssh_run action: job-kill` reads the recorded `pid` and terminates the *process group* (the job was launched under `setsid`, so it leads its own group; killing the group catches children too). It escalates `TERM` then `KILL`, and tolerates an already-dead or missing job.

**Files:**
- Modify: `src/job-tracker.js` (append `buildJobKillCommand`)
- Test: `tests/test-job-tracker.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-job-tracker.js`, change the import to add `buildJobKillCommand`:

```javascript
import {
  JOBS_ROOT,
  newJobId,
  buildDetachCommand,
  buildJobStatusCommand,
  parseJobStatus,
  buildJobKillCommand,
} from '../src/job-tracker.js';
```

Add these tests before the `// --- Summary` section:

```javascript
// --- buildJobKillCommand -------------------------------------------------
test('buildJobKillCommand: reads the recorded pid for the job', () => {
  const cmd = buildJobKillCommand('job-9');
  assert(cmd.includes('job-9/pid'), 'reads the pid file');
  assert(cmd.includes('cat '), 'cat the pid file');
});

test('buildJobKillCommand: kills the process GROUP, not just the pid', () => {
  const cmd = buildJobKillCommand('j');
  // setsid makes the job a group leader; kill -<SIG> -<pgid> hits the group.
  assert(/kill -[A-Z]+ -/.test(cmd) || cmd.includes('-- -'), 'negative pid => process group');
});

test('buildJobKillCommand: escalates TERM then KILL', () => {
  const cmd = buildJobKillCommand('j');
  assert(cmd.includes('TERM'), 'graceful TERM first');
  assert(cmd.includes('KILL'), 'KILL escalation');
  // KILL must come after TERM in the command text.
  assert(cmd.indexOf('TERM') < cmd.indexOf('KILL'), 'TERM precedes KILL');
});

test('buildJobKillCommand: tolerates a missing or already-dead job', () => {
  const cmd = buildJobKillCommand('gone');
  assert(/2>\/dev\/null|test -|MISSING/.test(cmd), 'absence handled in-band');
});

test('buildJobKillCommand: empty job id is rejected', () => {
  assert.throws(() => buildJobKillCommand(''), /job id is required/);
  assert.throws(() => buildJobKillCommand(null), /job id is required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-job-tracker.js`
Expected: FAIL — `does not provide an export named 'buildJobKillCommand'`.

- [ ] **Step 3: Implement `buildJobKillCommand`**

Append to `src/job-tracker.js`:

```javascript
/**
 * Build the job-kill command. Reads the recorded pid; since the job ran
 * under setsid it leads its own process group, so a negative pid (`-PID`)
 * signals the whole group -- children included. TERM first, brief grace,
 * then KILL. A missing pid file or an already-dead group is not an error.
 */
export function buildJobKillCommand(jobId) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('ssh_run job-kill: job id is required');
  }
  const jobDir = `${JOBS_ROOT}/${jobId}`;
  // P holds the job's pid; -$P targets its process group.
  return (
    `P=$(cat ${jobDir}/pid 2>/dev/null); `
    + `if test -n "$P"; then `
    + `kill -TERM -"$P" 2>/dev/null; `
    + `sleep 2; `
    + `kill -KILL -"$P" 2>/dev/null; `
    + `echo "killed $P"; `
    + `else echo 'job-kill: no pid recorded'; fi`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-job-tracker.js`
Expected: PASS — `27 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: `39 files, 731 passed, 0 failed` — the previous `690 passed` plus the 14-test `test-script-runner.js` suite plus the 27-test `test-job-tracker.js` suite. Zero failures: this plan only *adds* two modules and two suites, so every pre-existing suite must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/job-tracker.js tests/test-job-tracker.js
git commit -m "feat: add job-kill process-group terminator"
```

---

## Done criteria

- `src/script-runner.js` exports `SEG_RE`, `buildScriptCommand`, `parseScriptSegments`. `buildScriptCommand` joins a `commands` array into one `;`-separated exec with a `printf '\n##SEG %d %d##\n' <idx> $?` sentinel after each segment; `isolate: true` wraps each segment in its own `sh -c`. `parseScriptSegments` splits the result back into per-segment `{index, command, stdout, exitCode}`, with `exitCode: null` for a segment killed before its sentinel.
- `src/job-tracker.js` exports `JOBS_ROOT`, `newJobId`, `buildDetachCommand`, `buildJobStatusCommand`, `parseJobStatus`, `buildJobKillCommand`. Job state is the remote `~/.ssh-manager/jobs/<id>/{rc,pid,log}` trio; `detach` launches under `setsid`; `parseJobStatus` decides `done` from the **presence of `rc`**, never PID liveness; `job-status` reads the log tail from a byte offset; `job-kill` signals the process group `TERM` then `KILL`.
- Every user-supplied command in both modules is shell-quoted — an injected `'; rm -rf /` survives only inside a quoted literal.
- `npm test` is green: `731 passed, 0 failed`, no regression in any pre-existing suite.

Plan 4's `ssh_run` dispatcher imports these: `action: script` runs `buildScriptCommand` through `streamExecCommand` then `parseScriptSegments`; `action: detach` runs `buildDetachCommand` and returns the job id; `action: job-status` runs `buildJobStatusCommand` with the caller's last `logSize` as `offset` and parses with `parseJobStatus`; `action: job-kill` runs `buildJobKillCommand`. This plan ships the engines and tests; the dispatcher wiring and the offset round-tripping are Plan 4's responsibility.

---

## Self-review

Performed after drafting; issues found and fixed inline:

1. **Script segments must not be `&&`-chained.** A first instinct is `cmd1 && printf... && cmd2 && printf...`, but `&&` aborts the chain on the first non-zero exit — segment 3 would never run and never get a sentinel. The spec wants *all* segments to run with *per-segment* exits. Fixed: segments are `;`-separated (each segment then its `printf` sentinel), so a failure is recorded and the next segment still runs. Test `buildScriptCommand: segments are NOT && chained` guards this.
2. **`$?` capture ordering.** The sentinel must read `$?` of the *segment*, before anything else clobbers it. The emitted form `<segment>; printf '...' <idx> $?` works because `;` runs `printf` next and `$?` still holds the segment's exit at that point. A `\n` before `;` in the non-isolate `{ ...\n; }` block guards against a segment whose last line is a comment swallowing the `;`.
3. **`isolate` shared-state semantics.** Default (non-isolate) must keep `cd`/env across segments — it is one shell, segments are just `;`-joined, so that holds. `isolate: true` wraps each segment in `sh -c '...'`: a child shell per segment, so `cd` in one does not leak. Tests assert both: `cd /tmp` then `pwd` is one shell by default, two `sh -c` when isolated.
4. **`parseScriptSegments` trailing-output case.** If the script is killed mid-segment, the last segment has output but no closing sentinel. First draft dropped it. Fixed: after the sentinel loop, any non-whitespace tail becomes a final segment with `exitCode: null`. A pure-whitespace tail (trailing newlines after the last sentinel) is *not* a segment — test `trailing whitespace after last sentinel is not a segment` pins that, otherwise every well-formed script would show a phantom empty segment.
5. **rc-presence vs PID liveness — the core spec requirement.** The dangerous bug the spec calls out: deciding completion by checking whether the PID is alive. A short job finishes, its PID is recycled by an unrelated process, and a liveness check wrongly reports the job as still running. `parseJobStatus` therefore keys completion *solely* on whether `RC=` carried a value. The status command emits `RC=` empty when `cat rc` fails (file absent). Test `parseJobStatus: completion ignores PID liveness entirely` feeds `RC=0` with an empty `PID=` and asserts `done` — proving PID is never consulted.
6. **Incremental log read offset.** `tail -c +N` is **1-indexed** — `+1` is the whole file, `+1025` skips the first 1024 bytes. The command emits `tail -c +${off + 1}`, so an `offset` of 4096 (the previous `LOGSIZE`) reads byte 4097 onward — exactly the new tail. The status block also re-emits `LOGSIZE`, which the caller passes back as the next `offset`. Test threads `offset: 4096` and asserts `4096` appears.
7. **`job-kill` must hit the process group.** The job runs under `setsid`, making its pid a process-group leader. `kill -TERM -"$P"` (negative pid) signals the whole group, so a job that spawned children is fully reaped. Killing only `$P` would orphan children. Test `kills the process GROUP` asserts the negative-pid form. `setsid` in `buildDetachCommand` is what makes this valid — the two are a matched pair.
8. **`setsid` availability.** `setsid` is in `util-linux` and effectively universal on Linux; the spec names it directly in the job-model section, so this plan follows the spec rather than adding a fallback. If a target host genuinely lacks it the detach exec fails loudly with a clear `setsid: command not found` — acceptable and diagnosable.
9. **`shQuote` duplication.** `script-runner.js` and `job-tracker.js` each define a local `shQuoteLocal` rather than importing `shQuote` from `stream-exec.js`. Deliberate: it keeps these two engine modules dependency-free of the streaming layer (they are command *builders*, conceptually upstream of exec), and the helper is four lines. The remote-search plan (5a) *does* import `shQuote` — the inconsistency is intentional and noted: remote-search is already coupled to nothing else from stream-exec, so one import is clean there, whereas pulling stream-exec into the job engine for one helper is not worth the coupling. A reviewer may consolidate all three onto one shared `sh-quote.js` later; that is a non-blocking cleanup.
10. **Task 2 may pass without first failing.** `parseScriptSegments` is written in Task 1 alongside `buildScriptCommand` (they are one cohesive module and splitting the function across two tasks would leave Task 1's module half-defined). So Task 2's tests can pass on first run. Step 2 of Task 2 states this explicitly and treats an immediate pass as acceptable — the red-green discipline is satisfied at the module level in Task 1. This is the one deliberate deviation from strict per-task red-first; flagged here so it is not read as an error.
11. **Test count arithmetic.** script-runner: Task 1 adds 8, Task 2 adds 6 (total 14). job-tracker: Task 3 adds 11, Task 4 adds 11 (total 22), Task 5 adds 5 (total 27). Baseline `690` (confirmed at planning time) + 14 + 27 = `731`. Consistent with the final `npm test` line.
