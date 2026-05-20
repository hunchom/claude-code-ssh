# ssh-mcp v4 Wiring: ssh_find + ssh_run script/jobs Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development

## Goal

Plan 5 shipped three pure library modules — `remote-search.js`, `script-runner.js`, `job-tracker.js` — fully tested but **unwired**: no tool surface reaches them. This plan connects them.

Two deliverables:

1. **A new 13th v4 tool, `ssh_find`** — a remote-search verb-tool with actions `grep` / `locate` / `ls`. A new dispatcher `src/dispatchers/ssh-find.js` builds a bounded POSIX command via `remote-search.js`, runs it through `streamExecCommand`, feeds raw stdout to the matching parser, and renders structured hits with `renderRows`. Registered in `index.js`, `tool-registry.js`, `tool-annotations.js` — the surface grows from 12 to 13 tools.

2. **Four new `ssh_run` actions** — `script`, `detach`, `job-status`, `job-kill` — wiring `script-runner.js` + `job-tracker.js` into the existing `src/dispatchers/ssh-run.js`. `script` MUST thread the `buildScriptCommand` nonce into `parseScriptSegments`. New actions + args land in the `ssh_run` `inputSchema` in `index.js`.

## Architecture

The existing v4 dispatchers (`ssh-run`, `ssh-fleet`, `ssh-docker`, ...) route an `action` arg to a handler in `src/tools/*.js`. The Plan-5 modules have **no `src/tools/*.js` handler** — they are builder/parser pairs. So both deliverables follow a different shape, already used inside `handleSshExecute` (`src/tools/exec-tools.js:31`): the dispatcher itself resolves a connection via `deps.getConnection`, calls `streamExecCommand` directly, then post-processes.

- `ssh-find.js` is a self-contained dispatcher: no injected `handlers`, only `deps` (`getConnection`). It owns the build → exec → parse → render pipeline for all three actions.
- `ssh-run.js` keeps its three existing handler-delegating actions (`exec`, `sudo`, `fleet`) unchanged and gains four new actions that exec directly, exactly like `ssh-find`. The new actions need `deps.getConnection`; that is already passed in the `DEPS` bundle.
- Both dispatchers return MCP responses built from `structured-result.js` (`ok` / `fail` / `toMcp`). Success payloads carry structured `data` plus a rendered markdown face built with `renderRows` / `renderKV`.

Boundary: builders and parsers stay pure (Plan 5, untouched). Dispatchers do all I/O. `streamExecCommand` is called with `raw: true` — every Plan-5 command is *already* `timeout`-wrapped server-side, so the outer `wrapWithTimeout` shell would be redundant; an in-process `timeoutMs` ceiling still guards a stuck channel.

## Tech Stack

- Node.js ESM (`import`/`export`), same as the rest of `src/`.
- `streamExecCommand` / `shQuote` from `src/stream-exec.js`.
- `ok` / `fail` / `toMcp` from `src/structured-result.js`.
- `renderHeader` / `renderRows` / `renderKV` / `indentBody` from `src/output-formatter.js`.
- `requireArgs` from `src/dispatchers/action-validate.js`.
- Plan-5 modules: `src/remote-search.js`, `src/script-runner.js`, `src/job-tracker.js`.
- Zod schema fragments in `src/index.js` registration blocks.
- Tests: plain `node tests/test-*.js`, `import assert`, local `test()` helper, prints `N passed, M failed`, `process.exit(1)` on any fail. Discovered by `scripts/run-tests.mjs`.

**Baseline:** `node scripts/run-tests.mjs` currently reports `54 files, 955 passed, 0 failed`. Every task below ends green with a strictly higher pass count and no regression.

## File Structure

```
src/
  dispatchers/
    ssh-find.js          NEW  -- 13th tool dispatcher: grep/locate/ls
    ssh-run.js           EDIT -- + script/detach/job-status/job-kill actions
  index.js               EDIT -- register ssh_find; extend ssh_run inputSchema
  tool-registry.js       EDIT -- ssh_find -> core group; counts 12->13
  tool-annotations.js    EDIT -- ssh_find annotations entry
tests/
  test-dispatcher-find.js   NEW  -- routing + build/parse/render for ssh_find
  test-dispatcher-run.js    EDIT -- + script/detach/job-status/job-kill routing
  test-tool-registry.js     EDIT -- 12 -> 13 assertions
  test-index-registration.js EDIT -- 12 -> 13 assertions
  test-tool-annotations.js  EDIT -- 12 -> 13 assertions
docs/superpowers/plans/
  2026-05-17-ssh-mcp-v4-wiring.md   THIS FILE
```

No file outside this list is touched. The Plan-5 modules and their test suites are read-only here.

---

## Task 1: ssh_find dispatcher — `grep` action

Create `src/dispatchers/ssh-find.js` handling only the `grep` action end to end: validate args, `buildGrepCommand`, `streamExecCommand`, `parseGrepHits`, render hits as a table. Locate/ls are stubbed as "unknown action" until Tasks 2-3.

- [ ] **Write the failing test.** Create `tests/test-dispatcher-find.js`:

```js
#!/usr/bin/env node
/**
 * Routing + pipeline suite for the ssh_find v4 dispatcher
 * (src/dispatchers/ssh-find.js). A fake ssh2 client returns canned stdout so
 * the build -> exec -> parse -> render path is exercised without a network.
 * Run: node tests/test-dispatcher-find.js
 */
import assert from 'assert';
import { handleSshFind } from '../src/dispatchers/ssh-find.js';

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

// Fake ssh2 client: client.exec(cmd, cb) -> a stream emitting canned stdout.
// `script` records every command string the dispatcher runs.
function fakeClient(stdoutByMatch) {
  const script = [];
  const client = {
    exec(command, cb) {
      script.push(command);
      let chosen = '';
      for (const [needle, out] of stdoutByMatch) {
        if (command.includes(needle)) { chosen = out; break; }
      }
      const listeners = {};
      const stream = {
        stderr: { on() { return stream.stderr; } },
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return stream; },
        close() {},
        signal() {},
      };
      cb(null, stream);
      setImmediate(() => {
        for (const fn of listeners.data || []) fn(Buffer.from(chosen));
        for (const fn of listeners.close || []) fn(0, null);
      });
      return client;
    },
  };
  client.script = script;
  return client;
}

const depsWith = (client) => ({ getConnection: async () => client });

console.log('[test] Testing ssh_find dispatcher\n');

// --- arg validation ------------------------------------------------------
await test('missing action -> structured fail', async () => {
  const r = await handleSshFind({ deps: depsWith(fakeClient([])), args: { server: 's' } });
  assert.strictEqual(r.isError, true);
});

await test('unknown action -> structured fail naming the action', async () => {
  const r = await handleSshFind({
    deps: depsWith(fakeClient([])), args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

await test('grep without pattern -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'grep', path: '/srv' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('pattern'));
  assert.strictEqual(client.script.length, 0, 'no command run when args invalid');
});

await test('grep without server -> structured fail', async () => {
  const r = await handleSshFind({
    deps: depsWith(fakeClient([])), args: { action: 'grep', pattern: 'x', path: '/srv' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

// --- grep pipeline -------------------------------------------------------
await test('grep builds an rg/grep command and runs it through the client', async () => {
  const client = fakeClient([['rg', '/srv/app/main.js:42:const TODO = 1;\n']]);
  await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'TODO', path: '/srv/app' },
  });
  assert.strictEqual(client.script.length, 1, 'exactly one command run');
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'Plan-5 timeout wrapper preserved');
  assert(cmd.includes('command -v rg'), 'rg-preferred grep command');
  assert(cmd.includes("'TODO'"), 'pattern shell-quoted');
});

await test('grep parses file:line:text stdout into structured hits', async () => {
  const client = fakeClient([['rg',
    '/srv/app/main.js:42:const TODO = 1;\n/srv/app/util.js:7:// TODO refactor\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: {
      server: 's', action: 'grep', pattern: 'TODO', path: '/srv/app', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'grep');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.hits[0], {
    file: '/srv/app/main.js', line: 42, text: 'const TODO = 1;',
  });
});

await test('grep renders a hits table in the markdown face', async () => {
  const client = fakeClient([['rg', '/a/x.js:3:hit one\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'hit', path: '/a' },
  });
  assert.strictEqual(r.isError, false);
  const text = r.content[0].text;
  assert(text.includes('/a/x.js'), 'file path rendered');
  assert(text.includes('hit one'), 'match text rendered');
});

await test('grep with zero hits -> success, empty hit list', async () => {
  const client = fakeClient([['rg', '']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'nope', path: '/a', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.count, 0);
  assert.deepStrictEqual(res.data.hits, []);
});

await test('grep refusing bare root -> structured fail (Plan-5 guard surfaced)', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'x', path: '/' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('refusing to search'));
  assert.strictEqual(client.script.length, 0, 'builder threw before exec');
});

await test('grep allow_root threads through to the builder', async () => {
  const client = fakeClient([['rg', '']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'x', path: '/', allow_root: true },
  });
  assert.strictEqual(r.isError, false, 'allow_root lets a / search through');
  assert.strictEqual(client.script.length, 1);
});

await test('a connection failure -> structured fail, not a throw', async () => {
  const deps = { getConnection: async () => { throw new Error('host down'); } };
  const r = await handleSshFind({
    deps, args: { server: 's', action: 'grep', pattern: 'x', path: '/a' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host down'));
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-find.js` — fails: `Cannot find module '../src/dispatchers/ssh-find.js'`.

- [ ] **Implement.** Create `src/dispatchers/ssh-find.js`:

```js
/**
 * ssh_find -- v4 fat verb-tool dispatcher.
 *
 * Remote search: grep (recursive content), locate (find -name), ls (one dir).
 * No src/tools/*.js handler exists -- the dispatcher owns build -> exec ->
 * parse -> render itself, like handleSshExecute. Commands come from the pure
 * builders in remote-search.js; each is already server-side bounded (timeout,
 * pruned pseudo-fs, match cap), so streamExecCommand runs raw:true with only
 * an in-process timeoutMs guarding a stuck channel.
 *
 * deps (injected): { getConnection }.
 */

import { streamExecCommand } from '../stream-exec.js';
import { ok, fail, toMcp } from '../structured-result.js';
import { renderHeader, renderRows, indentBody } from '../output-formatter.js';
import { requireArgs } from './action-validate.js';
import {
  buildGrepCommand, buildLocateCommand, buildLsCommand,
  parseGrepHits, parseLocateHits, parseLsRows,
} from '../remote-search.js';

// in-process channel guard; Plan-5 commands carry their own server-side timeout
const EXEC_TIMEOUT_MS = 60_000;

const REQUIRED = {
  grep: ['server', 'pattern', 'path'],
  locate: ['server', 'name', 'path'],
  ls: ['server', 'path'],
};

/** grep hits -> file/line/text table. */
function renderGrep(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'grep', server: result.server,
    status: result.success ? `${result.data.count} hits` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.hits.map((h) => [h.file, h.line, h.text]);
  return `${header}\n${indentBody(renderRows(['file', 'line', 'text'], rows))}`;
}

/** locate paths -> single-column path table. */
function renderLocate(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'locate', server: result.server,
    status: result.success ? `${result.data.count} paths` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.paths.map((p) => [p]);
  return `${header}\n${indentBody(renderRows(['path'], rows))}`;
}

/** ls rows -> perms/size/type/name table. */
function renderLs(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'ls', server: result.server,
    status: result.success ? `${result.data.count} entries` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.entries.map((e) => [e.perms, e.size, e.type, e.name]);
  return `${header}\n${indentBody(renderRows(['perms', 'size', 'type', 'name'], rows))}`;
}

export async function handleSshFind({ deps, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_find', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_find', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_find', action, a, REQUIRED);
  if (bad) return bad;

  // builders throw on a bad path (bare "/", empty) -- surface as a clean fail
  let command;
  try {
    if (action === 'grep') {
      command = buildGrepCommand({
        pattern: a.pattern, path: a.path, matchCap: a.match_cap,
        timeoutSecs: a.timeout_secs, contextLines: a.context_lines,
        crossMounts: a.cross_mounts, allowRoot: a.allow_root,
      });
    } else if (action === 'locate') {
      command = buildLocateCommand({
        name: a.name, path: a.path, matchCap: a.match_cap,
        timeoutSecs: a.timeout_secs, crossMounts: a.cross_mounts,
        allowRoot: a.allow_root,
      });
    } else {
      command = buildLsCommand({ path: a.path, timeoutSecs: a.timeout_secs });
    }
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server }));
  }

  const startedAt = Date.now();
  let client;
  try {
    client = await deps.getConnection(a.server);
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server }));
  }

  let raw;
  try {
    // raw:true -- builder already wrapped the command in `timeout`
    const r = await streamExecCommand(client, command, {
      raw: true, timeoutMs: EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
    });
    raw = r.stdout;
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server, action }));
  }

  const meta = { server: a.server, duration_ms: Date.now() - startedAt };
  const fmt = a.format;

  if (action === 'grep') {
    const hits = parseGrepHits(raw);
    return toMcp(ok('ssh_find', { action, count: hits.length, hits }, meta),
      { format: fmt, renderer: renderGrep });
  }
  if (action === 'locate') {
    const paths = parseLocateHits(raw);
    return toMcp(ok('ssh_find', { action, count: paths.length, paths }, meta),
      { format: fmt, renderer: renderLocate });
  }
  const entries = parseLsRows(raw);
  return toMcp(ok('ssh_find', { action, count: entries.length, entries }, meta),
    { format: fmt, renderer: renderLs });
}
```

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-find.js` — all grep + validation tests pass (locate/ls actions are already wired in this implementation; their dedicated tests arrive in Tasks 2-3).

- [ ] **Commit.**

```
feat(ssh-find): add ssh_find dispatcher with grep action
```

---

## Task 2: ssh_find dispatcher — `locate` action

The implementation in Task 1 already wires `locate`. This task pins its behavior with dedicated tests.

- [ ] **Write the failing test.** Append to `tests/test-dispatcher-find.js`, before the `--- Summary ---` block:

```js
// --- locate pipeline -----------------------------------------------------
await test('locate without name -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'locate', path: '/etc' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('name'));
  assert.strictEqual(client.script.length, 0);
});

await test('locate builds a timeout-wrapped find -name command', async () => {
  const client = fakeClient([['find', '/etc/nginx/nginx.conf\n']]);
  await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: '*.conf', path: '/etc' },
  });
  assert.strictEqual(client.script.length, 1);
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'timeout wrapper preserved');
  assert(cmd.includes('find '), 'uses find');
  assert(cmd.includes("-name '*.conf'"), 'name glob shell-quoted');
});

await test('locate parses one-path-per-line stdout into a path list', async () => {
  const client = fakeClient([['find',
    '/etc/nginx/nginx.conf\n/etc/ssl/openssl.conf\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: {
      server: 's', action: 'locate', name: '*.conf', path: '/etc', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.action, 'locate');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.paths,
    ['/etc/nginx/nginx.conf', '/etc/ssl/openssl.conf']);
});

await test('locate renders a path table in the markdown face', async () => {
  const client = fakeClient([['find', '/etc/hosts\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: 'hosts', path: '/etc' },
  });
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('/etc/hosts'), 'path rendered');
});

await test('locate refusing bare root -> structured fail', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: 'x', path: '/' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('refusing to search'));
  assert.strictEqual(client.script.length, 0);
});
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-find.js` — the five new tests reference behavior that... is in fact already implemented in Task 1. To make this a genuine red step, write the tests *before* Task 1's implement step is squashed in. If implementing strictly task-by-task: temporarily comment out the `locate` branch in `ssh-find.js` (`if (action === 'locate')` build + parse) so the new tests fail with a real error, confirm RED, then restore.

  Practically: run `node tests/test-dispatcher-find.js`; if all pass because Task 1 already wired locate, that is acceptable — the dedicated tests still pin behavior and guard regressions. Note in the commit that locate was wired in Task 1 and this task adds coverage.

- [ ] **Implement.** No code change — `buildLocateCommand` + `parseLocateHits` + `renderLocate` were wired in Task 1. If the RED step required commenting out the `locate` branch, restore it now verbatim.

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-find.js` — all locate tests green.

- [ ] **Commit.**

```
test(ssh-find): pin locate action build/parse/render behavior
```

---

## Task 3: ssh_find dispatcher — `ls` action

Pin `ls` behavior, including the deliberate Plan-5 choice that `ls /` is allowed.

- [ ] **Write the failing test.** Append to `tests/test-dispatcher-find.js`, before `--- Summary ---`:

```js
// --- ls pipeline ---------------------------------------------------------
await test('ls without path -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('path'));
  assert.strictEqual(client.script.length, 0);
});

await test('ls builds a timeout-wrapped ls -la command', async () => {
  const client = fakeClient([['ls -la', 'total 0\n']]);
  await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/var/log' },
  });
  assert.strictEqual(client.script.length, 1);
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'timeout wrapper preserved');
  assert(cmd.includes("ls -la '/var/log'"), 'long listing, path shell-quoted');
});

await test('ls parses long-format rows into perms/size/type/name entries', async () => {
  const client = fakeClient([['ls -la',
    'total 12\n'
    + '-rw-r--r-- 1 root root 1024 May 17 10:00 app.conf\n'
    + 'drwxr-xr-x 2 root root 4096 May 16 09:30 logs\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'ls', path: '/etc', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.action, 'ls');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.entries[0], {
    perms: '-rw-r--r--', size: '1024', name: 'app.conf', type: 'file',
  });
  assert.strictEqual(res.data.entries[1].type, 'dir');
});

await test('ls renders a perms/size/type/name table in the markdown face', async () => {
  const client = fakeClient([['ls -la',
    'total 0\n-rw-r--r-- 1 u g 9 May 17 10:00 notes.txt\n']]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/tmp' },
  });
  assert.strictEqual(r.isError, false);
  const text = r.content[0].text;
  assert(text.includes('notes.txt'), 'name rendered');
  assert(text.includes('perms'), 'header rendered');
});

await test('ls of bare root is allowed (Plan-5: listing / is cheap)', async () => {
  const client = fakeClient([['ls -la', 'total 0\n']]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/' },
  });
  assert.strictEqual(r.isError, false, 'ls / is not refused');
  assert.strictEqual(client.script.length, 1);
});
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-find.js` — same situation as Task 2: `ls` was wired in Task 1. For a genuine RED, temporarily comment out the final `else` build branch + the `ls` parse/render in `ssh-find.js`, confirm failure, then restore. Otherwise accept that Task 1 wired it and this task adds pinning coverage.

- [ ] **Implement.** No code change — `buildLsCommand` + `parseLsRows` + `renderLs` were wired in Task 1. Restore any branch commented out for the RED step.

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-find.js` — all ls tests green.

- [ ] **Commit.**

```
test(ssh-find): pin ls action build/parse/render, including ls /
```

---

## Task 4: Register `ssh_find` as the 13th tool

Wire `ssh_find` into `tool-registry.js` (core group), `tool-annotations.js`, and `index.js`. `ssh_find` is read-only — grep/locate/ls never mutate remote state — so `readOnlyHint: true`. This bumps the surface from 12 to 13; the three "exactly 12" tests are updated in lockstep so the suite stays green.

- [ ] **Write the failing test.** Update the three registry tests to expect 13.

  In `tests/test-tool-registry.js`, replace each `12` with `13` and the core-group count `3` with `4`:
  - `getAllTools().length, 12` → `13` (two occurrences: `All 12 v4 tools...` and `No duplicate tools...`)
  - `'Should have exactly 12 tools'` → `'Should have exactly 13 tools'`
  - `'All 12 tools should be unique'` → `'All 13 tools should be unique'`
  - `getGroupTools('core').length, 3` → `4`; `'core group should have 3 tools'` → `'core group should have 4 tools'`
  - `stats.totalTools, 12` → `13`; `'Should have 12 total tools'` → `'Should have 13 total tools'`
  - `validation.total, 12` → `13`; `validation.registered, 12` → `13`; matching messages
  - `TOOL_GROUPS.core.length, 3` → `4`; `'core should have 3 tools'` → `'core should have 4 tools'`
  - the test title `'All 12 v4 tools are defined in groups'` → `'All 13 v4 tools are defined in groups'`

  In `tests/test-index-registration.js`:
  - `registered.size, 12` → `13`; `'expected 12 registered tools, got '` → `'expected 13 registered tools, got '`
  - the test title `'exactly 12 tools are registered'` → `'exactly 13 tools are registered'`

  In `tests/test-tool-annotations.js`:
  - `Object.keys(TOOL_ANNOTATIONS).length, 12` → `13`; `'expected 12 annotated tools, got '` → `'expected 13 annotated tools, got '`
  - the test title `'exactly 12 tools are annotated'` → `'exactly 13 tools are annotated'`

  Also add an `ssh_find`-specific assertion to `tests/test-tool-registry.js`, right after the `'core group contains expected tools'` test:

```js
test('ssh_find is registered in the core group', () => {
  assertEqual(findToolGroup('ssh_find'), 'core', 'ssh_find should be in core group');
  assertTrue(getGroupTools('core').includes('ssh_find'), 'core should include ssh_find');
});
```

  And add an `ssh_find` readonly assertion to `tests/test-tool-annotations.js`, inside the existing `'purely-inspecting fat tools are marked readOnlyHint'` test — extend its loop array from `['ssh_logs', 'ssh_fleet']` to `['ssh_logs', 'ssh_fleet', 'ssh_find']`.

- [ ] **Run the test, expect FAIL.** `node tests/test-tool-registry.js` and `node tests/test-index-registration.js` and `node tests/test-tool-annotations.js` — each fails: registry still has 12 tools / no `ssh_find` group / no `ssh_find` annotation.

- [ ] **Implement.** Three edits.

  Edit `src/tool-registry.js` — add `ssh_find` to the core group, bump counts and doc comments:

```js
  // Core (4) -- run commands, find files, move files, read logs
  core: [
    'ssh_run',
    'ssh_find',
    'ssh_file',
    'ssh_logs',
  ],
```

  In the same file, update `TOOL_GROUP_DESCRIPTIONS.core`, `TOOL_GROUP_COUNTS.core` (3 → 4), the `getAllTools` doc comment (`12 across 3 groups` → `13 across 3 groups`), and the `TOOL_GROUPS` header comment (`Total: 12 v4 fat verb-tools` → `Total: 13 v4 fat verb-tools`):

```js
  core: 'Run remote commands, search/list files, transfer/read/edit files, read logs',
```

```js
export const TOOL_GROUP_COUNTS = {
  core: 4,
  ops: 5,
  advanced: 4,
};
```

  Edit `src/tool-annotations.js` — add an entry (place it after `ssh_run` to mirror tool order):

```js
  ssh_find: {
    title: 'Search and List Files',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
```

  Edit `src/index.js` — add a `registerToolConditional('ssh_find', ...)` block. Place it directly after the `ssh_run` block (before `ssh_file`), so registration order matches the core group. `ssh_find` takes no `handlers` — `handleSshFind` is self-contained:

```js
registerToolConditional('ssh_find', {
  description: 'Search and list files on a configured SSH server. Use instead '
    + 'of `ssh host grep -r` / `ssh host find` / `ssh host ls` via Bash -- '
    + 'every search is timeout-bounded, prunes pseudo-filesystems, and caps '
    + 'match count so it will not flood context.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['grep', 'locate', 'ls'])
      .describe('grep recursive content, locate files by name, or ls one directory'),
    path: z.string().describe('Search root (grep, locate) or directory to list (ls)'),
    pattern: z.string().optional().describe('Content regex to search for (action: grep)'),
    name: z.string().optional().describe('Filename glob to match (action: locate)'),
    context_lines: z.number().optional().describe('Lines of context around each grep hit (action: grep)'),
    match_cap: z.number().optional().describe('Max hits before the search stops (actions: grep, locate)'),
    timeout_secs: z.number().optional().describe('Server-side wall-clock limit in seconds'),
    cross_mounts: z.boolean().optional().describe('Descend into other filesystems (actions: grep, locate)'),
    allow_root: z.boolean().optional().describe('Permit searching the bare "/" root (actions: grep, locate)'),
    format: FORMAT,
  },
}, async (args) => handleSshFind({
  deps: DEPS,
  args,
}));
```

  Add the import near the other dispatcher imports (`src/index.js` ~line 82, beside `import { handleSshRun }`):

```js
import { handleSshFind } from './dispatchers/ssh-find.js';
```

- [ ] **Run the test, expect PASS.** `node tests/test-tool-registry.js`, `node tests/test-index-registration.js`, `node tests/test-tool-annotations.js` — all green.

- [ ] **Run the full suite.** `node scripts/run-tests.mjs` — `55 files, <baseline+N> passed, 0 failed`. The pass total is strictly higher than the 955 baseline (new `test-dispatcher-find.js` file plus the new registry assertions); no regression.

- [ ] **Commit.**

```
feat(ssh-find): register ssh_find as the 13th v4 tool
```

---

## Task 5: ssh_run — `script` action

Extend `src/dispatchers/ssh-run.js` with the `script` action: `buildScriptCommand(commands)` → `streamExecCommand` → `parseScriptSegments(stdout, nonce, commands)`. The nonce returned by the builder MUST be threaded into the parser — that is the unforgeable-sentinel contract from `script-runner.js`.

- [ ] **Write the failing test.** Append to `tests/test-dispatcher-run.js`, before the `--- Summary ---` block. Reuse the existing `fakeClient` style; `ssh-run.js` has no `fakeClient` yet, so define one local to the new section:

```js
// --- fake ssh2 client for the exec-direct actions (script/detach/jobs) ---
function fakeClient(stdout) {
  const script = [];
  const client = {
    exec(command, cb) {
      script.push(command);
      const listeners = {};
      const stream = {
        stderr: { on() { return stream.stderr; } },
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return stream; },
        close() {},
        signal() {},
      };
      cb(null, stream);
      setImmediate(() => {
        const out = typeof stdout === 'function' ? stdout(command) : stdout;
        for (const fn of listeners.data || []) fn(Buffer.from(out));
        for (const fn of listeners.close || []) fn(0, null);
      });
      return client;
    },
  };
  client.script = script;
  return client;
}

// --- script action ------------------------------------------------------
await test('script without commands -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'script' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('script runs the joined command and threads the real nonce to the parser', async () => {
  // The fake echoes back a sentinel block built from the SAME nonce the
  // dispatcher generated; only a correctly-threaded nonce parses it.
  const client = fakeClient((command) => {
    const m = command.match(/##SEG-([0-9a-f]{12}) /);
    const nonce = m ? m[1] : 'BADNONCE';
    return `a-out\n##SEG-${nonce} 0 0##\nb-out\n##SEG-${nonce} 1 0##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['echo a', 'echo b'], format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'script');
  assert.strictEqual(res.data.segments.length, 2,
    'nonce threaded correctly -> both segments parsed');
  assert.strictEqual(res.data.segments[0].stdout, 'a-out');
  assert.strictEqual(res.data.segments[0].exitCode, 0);
  assert.strictEqual(res.data.segments[0].command, 'echo a');
  assert.strictEqual(res.data.segments[1].stdout, 'b-out');
});

await test('script surfaces a per-segment non-zero exit code', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `ok\n##SEG-${nonce} 0 0##\n\n##SEG-${nonce} 1 127##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['true', 'nosuchcmd'], format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.segments[1].exitCode, 127);
});

await test('script isolate:true wraps each segment in its own sh -c', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `\n##SEG-${nonce} 0 0##\n\n##SEG-${nonce} 1 0##\n`;
  });
  await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['cd /tmp', 'pwd'], isolate: true },
  });
  const subs = client.script[0].match(/sh -c /g) || [];
  assert.strictEqual(subs.length, 2, 'one sub-shell per segment when isolated');
});

await test('script renders a per-segment table in the markdown face', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `hello\n##SEG-${nonce} 0 0##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'script', commands: ['echo hello'] },
  });
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('echo hello'), 'segment command rendered');
});

await test('script connection failure -> structured fail', async () => {
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => { throw new Error('host down'); } },
    handlers: {}, args: { server: 's', action: 'script', commands: ['echo x'] },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host down'));
});
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-run.js` — fails: `unknown action "script"` (the `REQUIRED` map has no `script` key).

- [ ] **Implement.** Edit `src/dispatchers/ssh-run.js`.

  Update the header comment — the `(script, detach, ... are added by Plan 5.)` line becomes a statement of fact:

```js
 * actions handled here: exec, sudo, fleet, script, detach, job-status,
 * job-kill. exec/sudo/fleet delegate to src/tools/exec-tools.js handlers;
 * script/detach/job-* have no handler -- the dispatcher execs them directly
 * via streamExecCommand, like handleSshExecute.
```

  Add imports at the top, beside the existing ones:

```js
import { ok } from '../structured-result.js';
import { streamExecCommand } from '../stream-exec.js';
import { renderHeader, renderRows, renderKV, indentBody } from '../output-formatter.js';
import { buildScriptCommand, parseScriptSegments } from '../script-runner.js';
import {
  buildDetachCommand, buildJobStatusCommand, parseJobStatus, buildJobKillCommand,
} from '../job-tracker.js';
```

  Add an in-process channel guard constant and extend the `REQUIRED` map:

```js
// in-process channel guard for the exec-direct actions
const RUN_EXEC_TIMEOUT_MS = 120_000;

const REQUIRED = {
  exec: ['server', 'command'],
  sudo: ['server', 'command'],
  fleet: ['group', 'command'],
  script: ['server', 'commands'],
  detach: ['server', 'command'],
  'job-status': ['server', 'job_id'],
  'job-kill': ['server', 'job_id'],
};
```

  Add a `script`-result renderer near the bottom of the module:

```js
/** script segments -> idx/exit/command/stdout table. */
function renderScript(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'script', server: result.server,
    status: result.success ? `${result.data.segments.length} segments` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.segments.map((s) => [
    s.index,
    s.exitCode == null ? '?' : s.exitCode,
    s.command == null ? '' : s.command,
    String(s.stdout || '').replace(/\r?\n/g, ' ').slice(0, 120),
  ]);
  return `${header}\n${indentBody(renderRows(['#', 'exit', 'command', 'stdout'], rows))}`;
}
```

  In `handleSshRun`, after the `fleet` block (`return handlers.executeGroup(...)`), add the `script` branch. It runs *after* `requireArgs` has already confirmed `commands` is present:

```js
  if (action === 'script') {
    if (!Array.isArray(a.commands) || a.commands.length === 0) {
      return toMcp(fail('ssh_run', 'script: commands must be a non-empty array',
        { server: a.server }));
    }
    let built;
    try {
      built = buildScriptCommand(a.commands, { isolate: a.isolate });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, built.command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    // thread the builder's nonce -> only this invocation's sentinels parse
    const segments = parseScriptSegments(raw, built.nonce, a.commands);
    return toMcp(
      ok('ssh_run', { action, segments }, { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderScript },
    );
  }
```

  Note: `requireArgs` already rejects a missing `commands`; the extra `Array.isArray` guard above catches a non-array `commands` (e.g. a string), which `requireArgs`'s `present()` check would let through. Keep both.

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-run.js` — all script tests green; the existing `exec`/`sudo`/`fleet` routing tests still pass.

- [ ] **Commit.**

```
feat(ssh-run): add script action threading the script-runner nonce
```

---

## Task 6: ssh_run — `detach` action

Add the `detach` action: `buildDetachCommand(command)` → `streamExecCommand` → return the `jobId` and `logPath` so the caller can poll with `job-status`.

- [ ] **Write the failing test.** Append to `tests/test-dispatcher-run.js`, before `--- Summary ---`:

```js
// --- detach action ------------------------------------------------------
await test('detach without command -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'detach' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('detach launches a setsid job and returns its job id', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'long-build.sh', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'detach');
  assert(typeof res.data.job_id === 'string' && res.data.job_id.length > 0,
    'job id returned for later job-status / job-kill');
  assert(client.script[0].includes('setsid'), 'job detached from the SSH session');
  assert(client.script[0].includes(res.data.job_id), 'launch command uses the job id');
});

await test('detach returns the log path for incremental reads', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'make all', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert(res.data.log_path.includes(res.data.job_id), 'log path under the job dir');
});

await test('detach honors an explicit job_id', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: {
      server: 's', action: 'detach', command: 'echo hi',
      job_id: 'my-build-1', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.job_id, 'my-build-1');
});

await test('detach with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'echo hi', job_id: '../x' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0, 'builder threw before exec');
});
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-run.js` — fails: `unknown action "detach"`.

- [ ] **Implement.** Edit `src/dispatchers/ssh-run.js`. `detach` is already in the `REQUIRED` map (Task 5). Add a renderer and the action branch.

  Renderer, near `renderScript`:

```js
/** detach result -> job id / log path KV block. */
function renderDetach(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'detach', server: result.server,
    status: result.success ? 'launched' : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  return `${header}\n${indentBody(renderKV([
    ['job_id', result.data.job_id],
    ['log_path', result.data.log_path],
  ]))}`;
}
```

  Action branch, after the `script` block:

```js
  if (action === 'detach') {
    let built;
    try {
      built = buildDetachCommand(a.command, a.job_id ? { jobId: a.job_id } : {});
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    try {
      await streamExecCommand(client, built.command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    return toMcp(
      ok('ssh_run',
        { action, job_id: built.jobId, log_path: built.logPath },
        { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderDetach },
    );
  }
```

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-run.js` — all detach tests green.

- [ ] **Commit.**

```
feat(ssh-run): add detach action launching a setsid background job
```

---

## Task 7: ssh_run — `job-status` and `job-kill` actions

Add the last two actions. `job-status`: `buildJobStatusCommand(jobId, {offset})` → exec → `parseJobStatus`. `job-kill`: `buildJobKillCommand(jobId)` → exec → return the raw confirmation. The caller passes the previous `logSize` back as `since_offset` for an incremental log read.

- [ ] **Write the failing test.** Append to `tests/test-dispatcher-run.js`, before `--- Summary ---`:

```js
// --- job-status action --------------------------------------------------
await test('job-status without job_id -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'job-status' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('job-status reports a finished job with its exit code', async () => {
  const client = fakeClient(
    'STATE=present\nRC=0\nPID=1234\nLOGSIZE=512\n##LOG##\nbuild complete');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'job-7', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'job-status');
  assert.strictEqual(res.data.state, 'done');
  assert.strictEqual(res.data.exit_code, 0);
  assert.strictEqual(res.data.log_size, 512);
  assert.strictEqual(res.data.log_chunk, 'build complete');
});

await test('job-status reports a still-running job (rc absent)', async () => {
  const client = fakeClient(
    'STATE=present\nRC=\nPID=4567\nLOGSIZE=88\n##LOG##\npartial');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'job-8', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.state, 'running');
  assert.strictEqual(res.data.exit_code, null);
});

await test('job-status threads since_offset into the status command', async () => {
  const client = fakeClient('STATE=present\nRC=\nPID=1\nLOGSIZE=9000\n##LOG##\ntail');
  await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'j', since_offset: 4096 },
  });
  // tail -c is 1-indexed: offset 4096 -> +4097
  assert(client.script[0].includes('4097'), 'since_offset + 1 threaded into tail -c');
});

await test('job-status of a missing job -> unknown state', async () => {
  const client = fakeClient('STATE=missing');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'gone', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.state, 'unknown');
});

await test('job-status with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'a;b' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0);
});

// --- job-kill action ----------------------------------------------------
await test('job-kill without job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'job-kill' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('job-kill signals the job process group and reports back', async () => {
  const client = fakeClient('killed 4567');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-kill', job_id: 'job-9', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'job-kill');
  assert(client.script[0].includes('TERM'), 'graceful TERM in the kill command');
  assert(client.script[0].includes('KILL'), 'KILL escalation in the kill command');
  assert(String(res.data.result).includes('killed'), 'kill confirmation surfaced');
});

await test('job-kill with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-kill', job_id: '$(x)' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0);
});
```

- [ ] **Run the test, expect FAIL.** `node tests/test-dispatcher-run.js` — fails: `unknown action "job-status"`.

- [ ] **Implement.** Edit `src/dispatchers/ssh-run.js`. Both actions are already in the `REQUIRED` map (Task 5). Add two renderers and two action branches.

  Renderers, near `renderDetach`:

```js
/** job-status result -> state / exit / log KV block. */
function renderJobStatus(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'job-status', server: result.server,
    status: result.success ? result.data.state : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const d = result.data;
  const kv = renderKV([
    ['state', d.state],
    ['exit_code', d.exit_code == null ? '' : d.exit_code],
    ['pid', d.pid == null ? '' : d.pid],
    ['log_size', d.log_size],
  ]);
  const body = d.log_chunk ? `${kv}\n--\n${d.log_chunk}` : kv;
  return `${header}\n${indentBody(body)}`;
}

/** job-kill result -> the raw confirmation line. */
function renderJobKill(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'job-kill', server: result.server,
    status: result.success ? 'signalled' : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  return `${header}\n${indentBody(String(result.data.result || ''))}`;
}
```

  Action branches, after the `detach` block:

```js
  if (action === 'job-status') {
    let command;
    try {
      command = buildJobStatusCommand(a.job_id, { offset: a.since_offset });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    const st = parseJobStatus(raw);
    return toMcp(
      ok('ssh_run', {
        action,
        state: st.state,
        exit_code: st.exitCode,
        pid: st.pid,
        log_size: st.logSize,
        log_chunk: st.logChunk,
      }, { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderJobStatus },
    );
  }

  if (action === 'job-kill') {
    let command;
    try {
      command = buildJobKillCommand(a.job_id);
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    return toMcp(
      ok('ssh_run', { action, result: String(raw || '').trim() },
        { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderJobKill },
    );
  }
```

- [ ] **Run the test, expect PASS.** `node tests/test-dispatcher-run.js` — all job-status + job-kill tests green; every earlier `ssh_run` test still passes.

- [ ] **Commit.**

```
feat(ssh-run): add job-status and job-kill actions over job-tracker
```

---

## Task 8: Extend the `ssh_run` inputSchema in index.js

The dispatcher handles four new actions, but the MCP `inputSchema` in `index.js` still advertises only `exec`/`sudo`/`fleet` and lacks the new args (`commands`, `isolate`, `job_id`, `since_offset`). Extend the schema so a client can actually call the new actions.

- [ ] **Write the failing test.** The `ssh_run` schema in `index.js` is plain Zod with no dedicated unit test; assert against `index.js` as text, mirroring `test-index-registration.js`. Create `tests/test-run-schema.js`:

```js
#!/usr/bin/env node
/**
 * Pins the ssh_run inputSchema in src/index.js: the four Plan-5 actions
 * (script, detach, job-status, job-kill) and their args must be advertised,
 * else a client cannot invoke what the dispatcher now handles.
 * Run: node tests/test-run-schema.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

// Isolate the registerToolConditional('ssh_run', { ... }) block.
function runBlock(src) {
  const start = src.indexOf("registerToolConditional('ssh_run'");
  assert(start !== -1, 'ssh_run registration found');
  // up to the handler arrow that closes the schema object
  const end = src.indexOf('}, async (args) => handleSshRun', start);
  assert(end !== -1, 'ssh_run handler boundary found');
  return src.slice(start, end);
}

console.log('[test] Testing ssh_run inputSchema\n');

await test('action enum advertises all seven actions', () => {
  const block = runBlock(indexSrc);
  for (const act of ['exec', 'sudo', 'fleet', 'script', 'detach', 'job-status', 'job-kill']) {
    assert(block.includes(`'${act}'`), `action enum missing '${act}'`);
  }
});

await test('commands arg is declared for the script action', () => {
  const block = runBlock(indexSrc);
  assert(/commands:\s*z\.array\(z\.string\(\)\)/.test(block),
    'commands should be an optional string array');
});

await test('isolate arg is declared', () => {
  assert(/isolate:\s*z\.boolean\(\)/.test(runBlock(indexSrc)),
    'isolate should be an optional boolean');
});

await test('job_id arg is declared for detach / job-status / job-kill', () => {
  assert(/job_id:\s*z\.string\(\)/.test(runBlock(indexSrc)),
    'job_id should be an optional string');
});

await test('since_offset arg is declared for job-status', () => {
  assert(/since_offset:\s*z\.number\(\)/.test(runBlock(indexSrc)),
    'since_offset should be an optional number');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Run the test, expect FAIL.** `node tests/test-run-schema.js` — fails: action enum lacks `script`/`detach`/`job-status`/`job-kill`; the new args are absent.

- [ ] **Implement.** Edit the `ssh_run` `registerToolConditional` block in `src/index.js`.

  Replace the `action` enum and add the four new args. The `server` field stays `z.string()` required (every new action needs a server). The full new `inputSchema`:

```js
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['exec', 'sudo', 'fleet', 'script', 'detach', 'job-status', 'job-kill'])
      .describe('exec/sudo a command, fleet-exec across a group, run a script '
        + 'of commands, detach a long job, or check/kill a detached job'),
    command: z.string().optional().describe('Command to run (actions: exec, sudo, detach)'),
    commands: z.array(z.string()).optional()
      .describe('Commands run in one shell with shared state (action: script)'),
    isolate: z.boolean().optional()
      .describe('Run each script command in its own shell -- no shared cd/env (action: script)'),
    cwd: z.string().optional().describe('Working directory (actions: exec, sudo, fleet)'),
    group: z.string().optional().describe('Server group name (action: fleet)'),
    sudo_password: z.string().optional().describe('Sudo password, streamed via stdin (action: sudo)'),
    job_id: z.string().optional()
      .describe('Detached job id (actions: detach to set, job-status/job-kill to target)'),
    since_offset: z.number().optional()
      .describe('Log byte offset for an incremental read; pass back the prior log_size (action: job-status)'),
    timeout: z.number().optional().describe('Command timeout in ms (actions: exec, sudo)'),
    raw: RAW,
    format: FORMAT,
  },
```

  The `description` text above the `inputSchema` may stay as-is; optionally broaden it to mention scripts and jobs, but that is not required for the tests.

- [ ] **Run the test, expect PASS.** `node tests/test-run-schema.js` — all schema assertions green.

- [ ] **Run the full suite.** `node scripts/run-tests.mjs` — `56 files, <baseline+N> passed, 0 failed`. Strictly higher than the 955 baseline, no regression. (Two new test files this plan: `test-dispatcher-find.js`, `test-run-schema.js`; `test-dispatcher-run.js` grew.)

- [ ] **Commit.**

```
feat(ssh-run): advertise script/detach/job actions in the inputSchema
```

---

## Verification

After Task 8, confirm the whole deliverable:

- [ ] `node scripts/run-tests.mjs` — `56 files, <count> passed, 0 failed`; `<count>` strictly greater than 955.
- [ ] `node --check src/index.js && node --check src/dispatchers/ssh-find.js && node --check src/dispatchers/ssh-run.js` — clean.
- [ ] `node tests/test-tool-registry.js` / `test-index-registration.js` / `test-tool-annotations.js` — all assert 13 tools, green.
- [ ] `./scripts/validate.sh` — syntax + MCP startup check passes.
- [ ] Grep the new/edited files for AI-attribution markers (co-author trailers, "generated with" footers, vendor noreply emails) — zero hits. Commit messages likewise.

---

## Self-review

Performed after drafting; issues found and fixed inline:

1. **`ssh_find` has no `src/tools/*.js` handler — the dispatcher template did not fit.** First draft modelled `ssh-find.js` on `ssh-docker.js`, which forwards to an injected `handlers.docker`. There is no find handler to forward to. Corrected: `ssh-find.js` is self-contained — it resolves the connection via `deps.getConnection` and calls `streamExecCommand` itself, the exact shape of `handleSshExecute` (`src/tools/exec-tools.js:31`). The registration block passes only `deps`, no `handlers`. Same correction applied to the four new `ssh_run` actions: `exec`/`sudo`/`fleet` delegate to handlers, but `script`/`detach`/`job-*` exec directly.

2. **`streamExecCommand` would double-wrap the timeout.** Plan-5 builders already emit `timeout N sh -c '...'`. `streamExecCommand`'s default path runs `wrapWithTimeout`, producing `timeout -k 5 N sh -c 'timeout 20 sh -c ...'` — a redundant nested shell. Fixed: every Plan-5 command runs with `raw: true`, which `stream-exec.js:86` documents as skipping the wrapper. An in-process `timeoutMs` (60s find, 120s run) still guards a stuck channel. The `grep builds an rg/grep command` test asserts the emitted command still `startsWith('timeout ')` — proving the builder's own wrapper survives untouched.

3. **Adding a 13th tool breaks three hardcoded-`12` test suites.** `test-tool-registry.js`, `test-index-registration.js`, and `test-tool-annotations.js` each assert `12` (and `test-tool-registry.js` also asserts `core` group size `3`). A naive "add `ssh_find`" would turn the suite red. Task 4 updates all three in the same task as the registration so the suite never regresses — and adds positive `ssh_find` assertions (`findToolGroup` → `core`, `readOnlyHint: true`) rather than only bumping numbers.

4. **The nonce-threading contract is the load-bearing detail of `script`.** `buildScriptCommand` returns `{ command, nonce }`; `parseScriptSegments(stdout, nonce, commands)` trusts *only* `##SEG-<nonce>##` lines. An early draft passed `commands` but dropped `nonce`, which throws `nonce is required`. The Task 5 implement step threads `built.nonce` explicitly, and the test `script runs the joined command and threads the real nonce` proves it: the fake client echoes a sentinel block built from the nonce *it extracts from the command it received* — only a correctly round-tripped nonce parses, so a dropped or wrong nonce yields zero segments and fails the assertion.

5. **`requireArgs` `present()` accepts a non-array `commands`.** `action-validate.js`'s `present()` returns true for any non-empty value, including a string. `buildScriptCommand` would then throw `at least one command is required` (its own `Array.isArray` check) — caught, but with a vaguer message. Task 5 keeps an explicit `Array.isArray(a.commands)` guard in the dispatcher before the builder for a precise `commands must be a non-empty array` error. Both layers retained.

6. **Tasks 2 and 3 are not genuinely red — `ssh-find.js` is wired whole in Task 1.** Splitting the dispatcher across three tasks is artificial: a single file with a `switch` over three actions is most honest written once. The TDD `expect-FAIL` step for locate/ls would pass immediately because Task 1's implement step already wired all three. Rather than fake it, Tasks 2-3 are explicit: they add *pinning* coverage, and the RED step documents the option to temporarily comment out a branch to observe a real failure. The alternative — Task 1 ships only grep, Tasks 2-3 add branches — was rejected: it would mean editing the same `switch` three times and re-reviewing it three times for no behavioral gain. Honest task boundaries beat ceremonial ones.

7. **`detach` job-id passthrough.** `buildDetachCommand(command, { jobId })` — if `jobId` is omitted it auto-generates via `newJobId()`. Passing `{ jobId: undefined }` would hit `assertJobId(undefined)` → `invalid job id`. Fixed: the dispatcher passes `a.job_id ? { jobId: a.job_id } : {}` so an absent `job_id` lets the builder default. Test `detach launches a setsid job and returns its job id` (no `job_id` arg) covers the default path; `detach honors an explicit job_id` covers the supplied path.

8. **`job-status` offset is 1-indexed inside the builder.** `buildJobStatusCommand(jobId, { offset })` emits `tail -c +${offset + 1}`. The dispatcher passes `since_offset` straight through as `offset` — it must NOT pre-add 1, or the offset double-shifts. The test asserts `4097` appears for `since_offset: 4096`, matching `job-tracker.js`'s own `buildJobStatusCommand: reads the log tail from a byte offset` test. The dispatcher is a thin pass-through; the +1 stays the builder's job.

9. **Test count is not hardcoded.** The plan never writes a literal final pass count — the baseline (`955`, `54 files`) is stated as the current measurement, and each full-suite step says "strictly higher than 955, no regression" plus the new file-count delta. If the baseline shifts before this plan runs, the instructions still hold.

10. **Fake ssh2 client shape.** `streamExecCommand` calls `client.exec(cmd, cb)`, then on the stream binds `.on('data')`, `.on('close')`, `.stderr.on('data')`, and may call `.close()` / `.signal()`. The `fakeClient` in both test files implements exactly that surface and emits `data` then `close(0, null)` on `setImmediate` so the promise resolves. Verified against `src/stream-exec.js` lines 88-160. Both `test-dispatcher-find.js` and the new section of `test-dispatcher-run.js` carry their own copy — the two suites stay independently runnable, consistent with how the existing dispatcher tests each define their own `spy()`.
