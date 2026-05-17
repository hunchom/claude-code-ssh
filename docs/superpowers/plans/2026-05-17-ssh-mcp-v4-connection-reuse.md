# ssh-mcp v4 Connection Reuse and Timeout Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two robustness fixes from spec section 7. (1) **Connection reuse:** the pool currently revalidates every reused connection with a `ping()` — a real `echo` round-trip on the wire before *every single command*. Replace it with a synchronous liveness check (`connected && !destroyed`); a genuinely dead connection is caught on the command's own failure and reconnected then. (2) **Timeout escalation:** a timed-out command currently gets one `INT` and a stream close. Add a grace-then-`KILL` escalation, and wrap non-raw commands in the OS `timeout` utility so a process that ignores signals is still bounded server-side.

**Architecture:** Three existing files change. `src/ssh-manager.js` gains a synchronous `isAlive()` method. `src/index.js`'s `isConnectionValid` stops awaiting `ping()` and calls `isAlive()` instead. `src/stream-exec.js`'s `streamExecCommand` schedules a `KILL` on a grace timer after the timeout `INT`, and a new `wrapWithTimeout` helper prefixes a `timeout` utility call onto non-raw commands. Each task that changes existing behavior rewrites the affected test assertions in the same task. `ssh-manager.js`'s `ping()` method is *kept* — `ssh_health` and `ssh_fleet connections` still use it for an explicit, opt-in liveness probe; it is only removed from the *per-call hot path*.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`.

This is Plan 5c of the v4 series (Plans 1-3 — render primitives, output rewrite, compressors — are complete; Plan 4 builds the 13-tool dispatcher facade). Plans 5a (`ssh_find`) and 5b (`ssh_run` script + detach jobs) are siblings. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` section 7.

---

## File Structure

- **Modify `src/ssh-manager.js`** — add a synchronous `isAlive()` method (`connected && client && !client.destroyed`). `isConnected()` and `ping()` are untouched.
- **Modify `src/index.js`** — `isConnectionValid` becomes synchronous, returns `ssh.isAlive()`, no `await`. Its three call sites lose their `await`.
- **Modify `src/stream-exec.js`** — `streamExecCommand` escalates a timeout `INT` to `KILL` after a grace window; export a new `wrapWithTimeout` and apply it to non-raw commands.
- **Modify `tests/test-stream-exec.js`** — extend with timeout-escalation and `wrapWithTimeout` coverage; existing timeout tests are checked and adjusted only if the escalation changes their observable behavior.

`src/ssh-manager.js` has no dedicated method-level test suite for `isAlive` to break; `test-ssh-manager-exec-passthrough.js` covers the exec shim only. A small focused suite is added for `isAlive`.

---

## Task 1: Synchronous `isAlive()` on `SSHManager`

`SSHManager` has `isConnected()` (`this.connected && this.client && !this.client.destroyed`) and `ping()` (an `echo` round-trip). The pool hot path needs a *synchronous* liveness verdict with no network. `isConnected()` is already exactly that — but it is also used elsewhere with `isConnected()`'s existing semantics, and the spec names a distinct check. Add `isAlive()` as the named, intention-revealing method the pool will call, so the hot-path check is greppable and decoupled from any future change to `isConnected()`.

**Files:**
- Modify: `src/ssh-manager.js`
- Test: `tests/test-ssh-manager-isalive.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-ssh-manager-isalive.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for SSHManager.isAlive() -- the synchronous pool liveness check.
 * Run: node tests/test-ssh-manager-isalive.js
 */
import assert from 'assert';
import SSHManager from '../src/ssh-manager.js';

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

console.log('[test] Testing SSHManager.isAlive\n');

// --- isAlive -------------------------------------------------------------
test('isAlive: fresh manager (not yet connected) is not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: connected and client not destroyed -> alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: false };
  assert.strictEqual(m.isAlive(), true);
});

test('isAlive: connected but client destroyed -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: true };
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: client absent -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = null;
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: returns a real boolean, never a Promise', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: false };
  const v = m.isAlive();
  assert.strictEqual(typeof v, 'boolean', 'synchronous -- no thenable');
});

test('isAlive: not connected, even with a live client -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = false;
  m.client = { destroyed: false };
  assert.strictEqual(m.isAlive(), false);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-ssh-manager-isalive.js`
Expected: FAIL — `m.isAlive is not a function`.

- [ ] **Step 3: Add `isAlive()` to `SSHManager`**

In `src/ssh-manager.js`, add the method immediately after the existing `isConnected()` method (which ends at the line `return this.connected && this.client && !this.client.destroyed;` then `}`):

```javascript
  // Synchronous liveness check for the connection-pool hot path. No network:
  // a reused pooled connection must not pay an echo round-trip per command.
  // A truly dead connection surfaces on the next command's own failure and
  // is reconnected then. Distinct from ping() (an explicit on-wire probe).
  isAlive() {
    return Boolean(this.connected && this.client && !this.client.destroyed);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-ssh-manager-isalive.js`
Expected: PASS — `6 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: `37 files, 696 passed, 0 failed` — the previous `690 passed` plus the 6-test `test-ssh-manager-isalive.js` suite. This task only *adds* a method, so no pre-existing suite changes.

- [ ] **Step 6: Commit**

```bash
git add src/ssh-manager.js tests/test-ssh-manager-isalive.js
git commit -m "feat: add synchronous isAlive liveness check to SSHManager"
```

---

## Task 2: Connection pool reuses without a per-call `ping()`

`index.js` `isConnectionValid(ssh)` does `return await ssh.ping()` — every reused pooled connection runs a remote `echo "ping"` before its real command. The spec: a synchronous `connected && !destroyed` check, no network probe; a dead connection is detected on the actual command's failure. Rewrite `isConnectionValid` to be synchronous and drop the `await` at its three call sites.

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Locate the call sites**

`isConnectionValid` is defined near line 230 and called in three places. Confirm them:

Run: `grep -n 'isConnectionValid' src/index.js`
Expected: four lines — the definition (~230) and three callers (`getConnection` ~330, the keepalive interval ~249, and the fleet/connections handler ~1363 or ~1430). The exact line numbers may drift; the grep gives the current set.

- [ ] **Step 2: Rewrite `isConnectionValid` to be synchronous**

In `src/index.js`, replace the entire `isConnectionValid` function:

```javascript
// Check if a connection is still valid
async function isConnectionValid(ssh) {
  try {
    return await ssh.ping();
  } catch (error) {
    logger.debug('Connection validation failed', { error: error.message });
    return false;
  }
}
```

with:

```javascript
// Synchronous pool-liveness check. No network: a reused connection must not
// pay an echo round-trip per command. A genuinely dead socket is caught when
// the next real command fails, and getConnection reconnects then. ssh.ping()
// is retained on SSHManager for explicit opt-in probes (ssh_health etc.).
function isConnectionValid(ssh) {
  try {
    return typeof ssh.isAlive === 'function' ? ssh.isAlive() : false;
  } catch (error) {
    logger.debug('Connection validation failed', { error: error.message });
    return false;
  }
}
```

- [ ] **Step 3: Drop `await` at the three call sites**

`isConnectionValid` is now synchronous. Each caller does `const isValid = await isConnectionValid(...)` — the `await` on a non-Promise is harmless but misleading. Remove it at all three sites. In `src/index.js`:

1. In `getConnection` — `const isValid = await isConnectionValid(existingSSH);` becomes:
   ```javascript
   const isValid = isConnectionValid(existingSSH);
   ```
2. In `setupKeepalive`'s interval callback — `const isValid = await isConnectionValid(ssh);` becomes:
   ```javascript
   const isValid = isConnectionValid(ssh);
   ```
3. In the fleet/connections handler — `const isValid = await isConnectionValid(ssh);` becomes:
   ```javascript
   const isValid = isConnectionValid(ssh);
   ```

Use `grep -n 'await isConnectionValid' src/index.js` to find every occurrence; replace each. After the edits, `grep -n 'await isConnectionValid' src/index.js` must return nothing.

The enclosing functions stay `async` — they `await` other things. Removing one redundant `await` does not change their control flow: a reused connection is now validated synchronously, then the function proceeds exactly as before.

- [ ] **Step 4: Verify the syntax and startup**

Run: `node --check src/index.js`
Expected: no output, exit 0 — the file parses.

Run: `./scripts/validate.sh`
Expected: passes — JavaScript syntax valid, MCP server starts. (`validate.sh` boots `index.js`; a synchronous `isConnectionValid` must not break startup.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `37 files, 696 passed, 0 failed` — unchanged from Task 1. No test suite exercises `getConnection`'s pool path against a live `ping()` (the handler suites inject their own fake `getConnection`), so this behavior change is invisible to the suite. Zero regressions.

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "perf: reuse pooled connections without a per-call ping probe"
```

---

## Task 3: `wrapWithTimeout` — bound non-raw commands with the OS `timeout` utility

A command can ignore `SIGINT`. The in-process JS timer then closes the *stream* but the remote *process* keeps running, holding resources. The spec: wrap non-raw commands in the OS `timeout` utility so the kernel bounds the process regardless. Add a `wrapWithTimeout` helper to `stream-exec.js` — `streamExecCommand` will apply it in Task 4.

**Files:**
- Modify: `src/stream-exec.js` (add `wrapWithTimeout`)
- Test: `tests/test-stream-exec.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-stream-exec.js`, change the import line to add `wrapWithTimeout`:

```javascript
import {
  streamExecCommand, shQuote, buildRemoteCommand, wrapWithTimeout,
} from '../src/stream-exec.js';
```

Add these tests immediately before the `// --- Abort semantics` section:

```javascript
// --- wrapWithTimeout -----------------------------------------------------
await test('wrapWithTimeout: prefixes the OS timeout utility with a seconds wall', () => {
  const w = wrapWithTimeout('make build', 30000);
  // 30000 ms -> 30 s wall, with a small ceiling buffer is fine; assert >= 30.
  assert(/^timeout -k \d+ \d+ /.test(w), 'timeout -k <kill> <wall> prefix');
  assert(w.includes('make build'), 'original command preserved');
});

await test('wrapWithTimeout: -k grace lets the OS escalate to KILL itself', () => {
  const w = wrapWithTimeout('cmd', 10000);
  // `timeout -k N` sends KILL N seconds after the initial TERM.
  const m = w.match(/^timeout -k (\d+) (\d+) /);
  assert(m, 'wrapped');
  assert(Number(m[1]) >= 1, 'a non-zero kill grace');
});

await test('wrapWithTimeout: rounds sub-second timeouts up to at least 1 s', () => {
  const w = wrapWithTimeout('cmd', 200);
  const m = w.match(/^timeout -k \d+ (\d+) /);
  assert(m, 'wrapped');
  assert(Number(m[1]) >= 1, 'wall is at least 1 s -- timeout rejects 0');
});

await test('wrapWithTimeout: no timeout (0 / undefined) returns the command unchanged', () => {
  assert.strictEqual(wrapWithTimeout('cmd', 0), 'cmd');
  assert.strictEqual(wrapWithTimeout('cmd', undefined), 'cmd');
  assert.strictEqual(wrapWithTimeout('cmd'), 'cmd');
});

await test('wrapWithTimeout: empty command returned unchanged (nothing to wrap)', () => {
  assert.strictEqual(wrapWithTimeout('', 5000), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-stream-exec.js`
Expected: FAIL — `does not provide an export named 'wrapWithTimeout'`.

- [ ] **Step 3: Implement `wrapWithTimeout`**

In `src/stream-exec.js`, add this export immediately after `buildRemoteCommand` (before `streamExecCommand`):

```javascript
/**
 * Wrap a command in the OS `timeout` utility so a process that ignores
 * SIGINT is still bounded server-side. `timeout -k <grace> <wall> CMD`
 * sends TERM at <wall> seconds, then KILL <grace> seconds later.
 *
 * timeoutMs is the same millisecond budget the in-process timer uses; here
 * it is converted to whole seconds (timeout rejects a 0 wall, so the floor
 * is 1 s). A falsy timeout returns the command unchanged -- raw / untimed
 * callers are not wrapped.
 */
export function wrapWithTimeout(command, timeoutMs) {
  if (!command || !timeoutMs || timeoutMs <= 0) return command;
  const wallSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const killGraceSecs = 5;
  return `timeout -k ${killGraceSecs} ${wallSecs} ${command}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-stream-exec.js`
Expected: PASS — all tests green, the 5 new `wrapWithTimeout` tests included.

- [ ] **Step 5: Commit**

```bash
git add src/stream-exec.js tests/test-stream-exec.js
git commit -m "feat: add wrapWithTimeout OS-timeout-utility helper"
```

---

## Task 4: Timeout escalates `INT` -> grace -> `KILL`

`streamExecCommand`'s timeout path calls `teardownStream()` once — `signal('INT')` then `close()` — then rejects. A process can ignore `INT`. Add escalation: on timeout, send `INT` and reject promptly (preserving current timing), but also arm a short grace timer that sends `KILL` if the stream has not closed by then. The grace timer is cleared the moment the stream closes, so a well-behaved process never sees `KILL`. This is the in-process counterpart to Task 3's server-side `timeout` wrapper — belt and suspenders.

**Files:**
- Modify: `src/stream-exec.js` (`streamExecCommand`)
- Test: `tests/test-stream-exec.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-stream-exec.js`, add these tests immediately before the `// --- Error surfaces` section (i.e. after the two existing `// --- Timeout semantics` tests):

```javascript
await test('timeout: escalates to KILL when the stream ignores INT', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'sleep 9999', {
    timeoutMs: 30, debounceMs: 5, killGraceMs: 20,
  });
  await sleep(5);
  const s = client.streams[0];
  // The fake stream's signal() records signals but its close() is NOT
  // auto-driven here, so the stream stays "open" past the grace window.
  await assert.rejects(() => p, /timeout after 30ms/);
  assert(s.signals.includes('INT'), 'INT sent first');
  // Wait out the kill grace; KILL must follow.
  await sleep(40);
  assert(s.signals.includes('KILL'), 'KILL escalation after the grace window');
  assert(s.signals.indexOf('INT') < s.signals.indexOf('KILL'), 'INT precedes KILL');
});

await test('timeout: a stream that closes within grace is never sent KILL', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'sleep 1', {
    timeoutMs: 20, debounceMs: 5, killGraceMs: 60,
  });
  await sleep(5);
  const s = client.streams[0];
  await assert.rejects(() => p, /timeout after 20ms/);
  // Stream closes promptly after the INT (well within the 60ms grace).
  s.finish(0, 'INT');
  await sleep(80);
  assert(s.signals.includes('INT'), 'INT was sent');
  assert(!s.signals.includes('KILL'), 'no KILL -- stream closed within grace');
});

await test('timeout: a normal completion arms no kill timer', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'ok', {
    timeoutMs: 500, debounceMs: 5, killGraceMs: 20,
  });
  await sleep(5);
  client.streams[0].finish(0);
  const r = await p;
  await sleep(40);
  assert.strictEqual(r.code, 0);
  assert(!client.streams[0].signals.includes('KILL'), 'no KILL on a clean finish');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-stream-exec.js`
Expected: FAIL — `timeout: escalates to KILL when the stream ignores INT` fails: the current `teardownStream` sends only `INT`, never `KILL`, so `s.signals.includes('KILL')` is false.

- [ ] **Step 3: Add `KILL` escalation to `streamExecCommand`**

In `src/stream-exec.js`, in `streamExecCommand`, add `killGraceMs` to the destructured options. Change:

```javascript
  const {
    cwd,
    abortSignal,
    debounceMs = 50,
    maxBufferedBytes = 1_000_000,
    timeoutMs,
    onChunk,
    stdin,
  } = options;
```

to:

```javascript
  const {
    cwd,
    abortSignal,
    debounceMs = 50,
    maxBufferedBytes = 1_000_000,
    timeoutMs,
    killGraceMs = 5_000,
    onChunk,
    stdin,
  } = options;
```

Add a `killTimer` declaration alongside the other mutable state. Change:

```javascript
    let resolved = false;
    let timeoutId = null;
```

to:

```javascript
    let resolved = false;
    let timeoutId = null;
    let killTimer = null;
```

Clear `killTimer` in `finish` so a stream that closes within the grace window is never escalated. Change the timer-cleanup line in `finish`:

```javascript
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
```

to:

```javascript
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
```

Replace the timeout block. Change:

```javascript
    // Overall deadline
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        teardownStream();
        finish(null, new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
```

to:

```javascript
    // Overall deadline. On expiry: INT now, then -- if the stream has not
    // closed within killGraceMs -- escalate to KILL. The kill timer is armed
    // before finish() (finish clears it), so a process that honours INT and
    // closes promptly never receives KILL. Server-side, wrapWithTimeout adds
    // an OS `timeout` wall as the backstop for a process that ignores both.
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (stream) {
          killTimer = setTimeout(() => {
            try { stream.signal && stream.signal('KILL'); } catch (_) { /* ignore */ }
            try { stream.close && stream.close(); } catch (_) { /* ignore */ }
          }, killGraceMs);
          if (killTimer.unref) killTimer.unref();
        }
        teardownStream();
        finish(null, new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }
```

`finish` runs synchronously inside the timeout callback and clears `killTimer` — but only if the stream closes. Here the stream has *not* closed (the process is hung), so `finish`'s `clearTimeout(killTimer)` does cancel the just-armed timer. That is wrong: the timer must outlive `finish`. Fix by arming the kill timer *after* `finish`, keyed off a separate flag. Use this corrected timeout block instead:

```javascript
    // Overall deadline. On expiry: INT immediately and reject; then, on a
    // detached timer, escalate to KILL if the stream is still open. The kill
    // timer is intentionally NOT cleared by finish() -- it self-checks the
    // stream's closed state. Server-side, wrapWithTimeout adds an OS `timeout`
    // wall as the backstop for a process that ignores both signals.
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const hung = stream;
        teardownStream();
        finish(null, new Error(`Command timeout after ${timeoutMs}ms`));
        if (hung) {
          const kt = setTimeout(() => {
            // Only escalate if the channel never actually closed.
            if (hung.closed) return;
            try { hung.signal && hung.signal('KILL'); } catch (_) { /* ignore */ }
            try { hung.close && hung.close(); } catch (_) { /* ignore */ }
          }, killGraceMs);
          if (kt.unref) kt.unref();
        }
      }, timeoutMs);
    }
```

Revert the `killTimer` additions from the two earlier edits in this step — they are not used by this corrected block. Specifically:
- Remove `let killTimer = null;` (the kill timer is now a local `kt` inside the callback).
- Remove the `if (killTimer) { clearTimeout(killTimer); killTimer = null; }` line added to `finish`.
- Keep `killGraceMs = 5_000` in the destructured options — it is used.

The escalation reads `hung.closed`. The real ssh2 exec stream sets no `closed` property, so add one: in the `client.exec` callback, after `stream = streamObj;`, mark the stream closed when it closes. Change:

```javascript
      stream.on('close', (code, signal) => {
        finish({ stdout, stderr, code: code || 0, signal: signal || null }, null);
      });
```

to:

```javascript
      stream.on('close', (code, signal) => {
        stream.closed = true;
        finish({ stdout, stderr, code: code || 0, signal: signal || null }, null);
      });
```

The test's `FakeStream` already has a `closed` field (set `true` by its own `close()`), and its `finish(code, signal)` helper emits `'close'`, which now sets `closed = true` on the real path too — so a stream closed within the grace window correctly suppresses the `KILL`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-stream-exec.js`
Expected: PASS — all tests green, the 3 new escalation tests included. The two pre-existing timeout tests still pass: `timeout: exceeds deadline` asserts `INT` is sent and the promise rejects with `/timeout after 30ms/` — both unchanged, the rejection still happens promptly at 30 ms. `timeout: command finishes before deadline` resolves normally; its stream closes, so no escalation arms.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `37 files, 704 passed, 0 failed` — the `696` after Task 2, plus the 5 `wrapWithTimeout` tests (Task 3) and the 3 escalation tests (Task 4). Zero regressions: no other suite asserts on `streamExecCommand`'s timeout internals.

- [ ] **Step 6: Commit**

```bash
git add src/stream-exec.js tests/test-stream-exec.js
git commit -m "feat: escalate command timeout from INT to KILL after a grace window"
```

---

## Task 5: Apply `wrapWithTimeout` to non-raw commands in `streamExecCommand`

`wrapWithTimeout` exists (Task 3) but nothing calls it. Wire it into `streamExecCommand`: a non-raw command with a timeout gets the OS `timeout` wrapper; a `raw: true` call does not. This is the final piece — server-side bounding for a process deaf to `INT` and `KILL` both.

**Files:**
- Modify: `src/stream-exec.js` (`streamExecCommand`)
- Test: `tests/test-stream-exec.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-stream-exec.js`, add these tests immediately before the `// --- wrapWithTimeout` section:

```javascript
// --- streamExecCommand applies the OS timeout wrapper -------------------
await test('streamExecCommand: non-raw timed command gets the OS timeout wrapper', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'make all', { timeoutMs: 5000, debounceMs: 5 });
  await sleep(5);
  client.streams[0].finish(0);
  await p;
  assert(/^timeout -k \d+ \d+ /.test(client.lastCommand), 'OS timeout wrapper applied');
  assert(client.lastCommand.includes('make all'), 'original command preserved');
});

await test('streamExecCommand: raw:true command is NOT wrapped', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'make all', {
    timeoutMs: 5000, debounceMs: 5, raw: true,
  });
  await sleep(5);
  client.streams[0].finish(0);
  await p;
  assert.strictEqual(client.lastCommand, 'make all', 'raw command sent verbatim');
});

await test('streamExecCommand: no timeout -> not wrapped even when non-raw', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'echo hi', { debounceMs: 5 });
  await sleep(5);
  client.streams[0].finish(0);
  await p;
  assert.strictEqual(client.lastCommand, 'echo hi', 'untimed command not wrapped');
});

await test('streamExecCommand: timeout wrapper composes with the cwd prefix', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'ls', { cwd: '/srv/app', timeoutMs: 3000, debounceMs: 5 });
  await sleep(5);
  client.streams[0].finish(0);
  await p;
  // cwd prefix is inside the timeout-wrapped command.
  assert(client.lastCommand.startsWith('timeout -k '), 'timeout outermost');
  assert(client.lastCommand.includes("cd '/srv/app' && ls"), 'cwd prefix preserved');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-stream-exec.js`
Expected: FAIL — `streamExecCommand: non-raw timed command gets the OS timeout wrapper` fails: `streamExecCommand` does not yet call `wrapWithTimeout`, so `client.lastCommand` is the bare `cd ... && make all` with no `timeout` prefix.

- [ ] **Step 3: Apply `wrapWithTimeout` in `streamExecCommand`**

In `src/stream-exec.js`, add `raw` to the destructured options of `streamExecCommand`. Change:

```javascript
  const {
    cwd,
    abortSignal,
    debounceMs = 50,
    maxBufferedBytes = 1_000_000,
    timeoutMs,
    killGraceMs = 5_000,
    onChunk,
    stdin,
  } = options;
```

to:

```javascript
  const {
    cwd,
    abortSignal,
    debounceMs = 50,
    maxBufferedBytes = 1_000_000,
    timeoutMs,
    killGraceMs = 5_000,
    raw = false,
    onChunk,
    stdin,
  } = options;
```

Change the command-building line:

```javascript
  const fullCommand = buildRemoteCommand(command, cwd);
```

to:

```javascript
  // cwd prefix first, then the OS timeout wrapper outside it -- so `timeout`
  // bounds the whole `cd ... && cmd`. raw:true skips the wrapper entirely.
  const withCwd = buildRemoteCommand(command, cwd);
  const fullCommand = raw ? withCwd : wrapWithTimeout(withCwd, timeoutMs);
```

`wrapWithTimeout` returns the command unchanged when `timeoutMs` is falsy, so an untimed non-raw command is still sent bare — no special-casing needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-stream-exec.js`
Expected: PASS — all tests green, the 4 new wrapper-integration tests included.

The pre-existing `buildRemoteCommand` / `shQuote` tests are unaffected — those test the helper directly, not via `streamExecCommand`. The pre-existing timeout tests pass `timeoutMs` and now also get the OS wrapper on the command string, but they assert on `signals` and rejection messages, not on `lastCommand`, so they stay green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `37 files, 708 passed, 0 failed` — the `704` after Task 4 plus these 4 tests. Zero regressions.

- [ ] **Step 6: Commit**

```bash
git add src/stream-exec.js tests/test-stream-exec.js
git commit -m "feat: wrap non-raw commands in the OS timeout utility"
```

---

## Done criteria

- `SSHManager.isAlive()` is a synchronous boolean liveness check; `isConnected()` and `ping()` are unchanged.
- `index.js` `isConnectionValid` is synchronous and calls `isAlive()`; no call site `await`s it; the pool no longer runs a remote `echo` before each reused command.
- `stream-exec.js` exports `wrapWithTimeout`; `streamExecCommand` escalates a timeout `INT` to `KILL` after `killGraceMs` (default 5 s) and wraps non-raw timed commands in the OS `timeout` utility; `raw: true` bypasses the wrapper.
- `npm test` is green: `708 passed, 0 failed`, no regression in any pre-existing suite.

Plan 4's `ssh_run` dispatcher threads its `raw` argument through to `streamExecCommand` so a `raw: true` call also skips the OS `timeout` wrapper. The `ssh_health` and `ssh_fleet connections` handlers keep using `SSHManager.ping()` for their explicit, opt-in liveness probes — only the per-call pool hot path stopped probing.

---

## Self-review

Performed after drafting; issues found and fixed inline:

1. **The kill-timer-cleared-by-`finish` bug — caught mid-draft.** The first version of Task 4 declared `killTimer` as shared mutable state and had `finish` clear it. But on a timeout, `finish` runs *synchronously inside the timeout callback*, immediately after the kill timer is armed — so `finish` would cancel the escalation timer every time, and `KILL` would never fire. The corrected block makes the kill timer a *local* `kt` armed *after* `finish` returns, and never cleared by `finish`; instead the timer self-checks `hung.closed`. Step 3 explicitly walks through this and instructs reverting the abandoned `killTimer` edits. This is the subtlest part of the plan and the step text is deliberately verbose so an implementing agent does not reintroduce the bug.
2. **`hung.closed` must exist on the real stream.** The escalation reads `hung.closed` to decide whether to skip `KILL`. ssh2's real exec stream has no such property — only the test's `FakeStream` does. Step 3 adds `stream.closed = true` in the real `'close'` handler, so the property exists on both the fake and the real path. Without this, a real well-behaved process that closed within the grace window would still be sent a redundant `KILL`. Test `timeout: a stream that closes within grace is never sent KILL` exercises exactly this via the fake's `finish()` (which emits `'close'`).
3. **Existing timeout tests must not regress.** `test-stream-exec.js` already has `timeout: exceeds deadline -> rejects` (asserts `INT` + rejection) and `timeout: command finishes before deadline` (asserts clean resolve). The escalation must not change their observable behavior: the rejection still fires promptly at `timeoutMs` (the `KILL` is on a *separate detached* timer), and a clean finish closes the stream so no escalation arms. Step 4 of Task 4 states this explicitly. Verified by reading the two tests at planning time — neither asserts on timing beyond the rejection, and neither asserts absence of `KILL`, so both stay green. Task 5 adds the OS wrapper to the command string those tests run, but they assert on `signals`/messages, not `lastCommand` — also still green.
4. **`timeout` utility wall cannot be 0.** The OS `timeout` utility rejects a `0` duration. `wrapWithTimeout` does `Math.max(1, Math.ceil(timeoutMs / 1000))` — a 200 ms budget becomes a 1 s wall. Test `rounds sub-second timeouts up to at least 1 s` covers it. A truly sub-second bound is still enforced precisely by the *in-process* JS timer; the OS wrapper is the coarse backstop, and 1 s is the finest grain it offers.
5. **`timeout -k` semantics.** `timeout -k <grace> <wall> CMD` sends `TERM` at `<wall>` seconds, then `KILL` `<grace>` seconds later if still alive. This is the OS doing its own INT/grace/KILL escalation — the server-side mirror of the in-process logic in Task 4. The two layers are independent and complementary: the JS timer handles the common case fast and precisely; the OS `timeout` handles a process that has also outlived the SSH channel itself. Both named in the spec.
6. **`ping()` is kept, not deleted.** The spec says remove the *per-call* probe, not the capability. `SSHManager.ping()` stays — `ssh_health` and `ssh_fleet connections` legitimately want an explicit on-wire liveness check. The done criteria and the architecture note both state this so a reviewer does not "finish the job" by deleting `ping()` and breaking those handlers. `index.js` keeps a `ssh.ping()` reference in the fleet/connections handler; only `isConnectionValid` stopped calling it.
7. **`async` functions keep their `async` keyword.** Removing the one redundant `await isConnectionValid(...)` does not mean the enclosing function stops being `async` — `getConnection`, the keepalive callback, and the fleet handler all `await` other operations. Step 3 of Task 2 says so explicitly, so an agent does not strip `async` and break those other awaits.
8. **Line numbers are approximate.** `isConnectionValid` is "near line 230" and the call sites "drift". The plan instructs `grep -n 'isConnectionValid' src/index.js` and `grep -n 'await isConnectionValid' src/index.js` rather than hardcoding line numbers, and gives a verification grep that must return empty. Robust against the file shifting under a parallel Plan 4.
9. **Test count arithmetic.** Baseline `690` (confirmed by `node scripts/run-tests.mjs` at planning time). Task 1 +6 = 696. Task 2 +0 (behavior change, no new tests) = 696. Task 3 +5 = 701 — but Task 3's done line is checked against the running total, and Task 4's expected `704` is `696 + 5 + 3`; Task 3 has no full-suite step so it does not print a total. Task 4 +3 → `704`. Task 5 +4 → `708`. The full-suite expectations at Task 4 (`704`) and Task 5 (`708`) are the load-bearing ones and are internally consistent: `690 + 6 + 5 + 3 + 4 = 708`.
10. **`killGraceMs` default vs the OS `-k` grace.** The in-process `killGraceMs` defaults to 5 s and the OS `wrapWithTimeout` `-k` grace is also 5 s — deliberately the same order of magnitude so the two layers escalate on a comparable schedule. They need not be identical (different layers, different failure modes) and the plan does not couple them; 5 s each is a sane, readable default. A caller can override `killGraceMs` per call; the OS `-k` is fixed at 5 s in `wrapWithTimeout`, which is acceptable for a backstop.
