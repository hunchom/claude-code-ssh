# ssh-mcp v4 Dispatcher Facade Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dispatcher framework — a `ctx-factory` helper that assembles the divergent per-handler context objects, and an `action-validate` helper that enforces per-action required-argument maps — then ship the first two fat verb-tool dispatchers (`ssh_run`, `ssh_file`) as pure modules that route `action` to the existing, unchanged handlers in `src/tools/*.js`.

**Architecture:** Additive only. Three new modules under `src/dispatchers/` plus one shared `src/dispatchers/ctx-factory.js` and `src/dispatchers/action-validate.js`. No existing handler in `src/tools/*.js` is modified — the dispatchers re-facade them. No `src/index.js` registration changes here: Part 3 does the cutover. Each dispatcher exports a single `handle<Tool>({ deps, args })` function that returns the same MCP `{ content, isError? }` shape the handlers already return, so it drops straight into `registerToolConditional` later. New test suites cover routing and arg-validation. Because nothing is wired into `index.js` yet, this plan ships zero runtime risk and leaves `npm test` green.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`, zod v4.

This is Plan 4 of 6, Part 1 of 3. Plans 1-3 (render primitives, output rewrite, compressors) are complete. Part 2: the remaining ten dispatchers (`ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan`). Part 3: the `index.js` / `tool-registry.js` / `tool-annotations.js` registration cutover and the four coupled-suite rewrites. Plan 5: new capabilities (`ssh_find`, detach/job, `;`-chain script). Plan 6: adoption. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` sections 3 and 7.

### Scope note — `ssh_run`

The spec lists `ssh_run` actions as `exec, sudo, script, fleet, detach, job-status, job-kill`. This plan builds **only `exec`, `sudo`, `fleet`**. `script`, `detach`, `job-status`, `job-kill` are new capabilities deferred to Plan 5; they are not in the `ssh_run` action enum produced here. Plan 5 extends the enum and the dispatcher.

---

## File Structure

- **Create `src/dispatchers/ctx-factory.js`** — `makeCtx(kind, deps, args)` builds the exact context object a given handler expects. The existing handlers take six divergent shapes (`{getConnection,args}`; `{getConnection,getServerConfig,args}`; `{getConnection,resolveGroup,args}`; `{getServerConfig,args}`; `{args}`; deploy's optional `getSftp`). Centralising this keeps each dispatcher readable.
- **Create `src/dispatchers/action-validate.js`** — `requireArgs(tool, action, args, requiredMap)` returns `null` when every required arg for `action` is present, or a structured `fail()` MCP response naming the missing args. MCP `inputSchema` cannot express conditional-required args, so every dispatcher calls this at entry.
- **Create `src/dispatchers/ssh-run.js`** — `handleSshRun`, dispatching `exec` / `sudo` / `fleet`.
- **Create `src/dispatchers/ssh-file.js`** — `handleSshFile`, dispatching `upload` / `download` / `sync` / `read` / `write` / `edit` / `diff` / `deploy` / `deploy-artifact`.
- **Create `tests/test-dispatcher-ctx.js`** — suite for `ctx-factory` and `action-validate`.
- **Create `tests/test-dispatcher-run.js`** — routing suite for `ssh_run`.
- **Create `tests/test-dispatcher-file.js`** — routing suite for `ssh_file`.

All `tests/test-*.js` files are auto-discovered by `scripts/run-tests.mjs`.

### Handler-context cheat sheet (verified against `src/tools/*.js`)

| Handler | Context object it destructures |
|---|---|
| `handleSshExecute` | `{ getConnection, args }` |
| `handleSshExecuteSudo` | `{ getConnection, getServerConfig, args }` |
| `handleSshExecuteGroup` | `{ getConnection, resolveGroup, args }` |
| `handleSshUpload` / `handleSshDownload` / `handleSshDiff` / `handleSshEdit` | `{ getConnection, args }` |
| `handleSshSync` | `{ getConnection, getServerConfig, args }` (binds `getConnection` as `_getConnection`, unused) |
| `handleSshDeploy` | `{ getConnection, getSftp?, args }` — `getSftp` optional; falls back to `client.sftp` |
| `handleSshCat` | `{ getConnection, args }` |

`getConnection` and `getServerConfig` are passed in from `index.js` at registration time as `deps`. The dispatchers never construct them — Part 3 wires the real ones; the tests inject fakes.

---

## Task 1: `action-validate` helper

A dispatcher receives an `action` and a flat `args` object. The schema declared every action-scoped arg optional, so the dispatcher must itself check that the args required for the chosen `action` are present. `requireArgs` does that check and, on a miss, returns a ready-to-return structured `fail()` MCP response.

**Files:**
- Create: `src/dispatchers/action-validate.js`
- Test: `tests/test-dispatcher-ctx.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-ctx.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-ctx.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/action-validate.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/action-validate.js`:

```javascript
/**
 * Per-action required-argument validation for v4 fat verb-tools.
 *
 * MCP inputSchema cannot express "arg X required only when action = Y", so
 * every action-scoped arg is declared optional and each dispatcher calls
 * requireArgs() at entry to enforce its per-action required map.
 */

import { fail, toMcp } from '../structured-result.js';

/** Arg counts as present unless undefined/null/empty-string. */
function present(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Validate that args holds every required arg for `action`.
 * @returns null when satisfied, else a structured fail() MCP response.
 */
export function requireArgs(tool, action, args, requiredMap) {
  const required = (requiredMap && requiredMap[action]) || [];
  const missing = required.filter((k) => !present((args || {})[k]));
  if (missing.length === 0) return null;
  return toMcp(fail(
    tool,
    `action "${action}" requires: ${missing.join(', ')}`,
    { server: (args || {}).server ?? null },
  ));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-ctx.js`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/action-validate.js tests/test-dispatcher-ctx.js
git commit -m "feat: add per-action arg validation helper for v4 dispatchers"
```

---

## Task 2: `ctx-factory` helper

Each existing handler destructures a different context object. `makeCtx` returns the right shape for a named handler kind, given the registration-time `deps` (`getConnection`, `getServerConfig`, `resolveGroup`, optional `getSftp`) and the per-call `args`. Dispatchers call `makeCtx` instead of hand-assembling objects.

**Files:**
- Modify: `src/dispatchers/ctx-factory.js` (create)
- Test: `tests/test-dispatcher-ctx.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-dispatcher-ctx.js`, change the import line to add `makeCtx`:

```javascript
import { requireArgs } from '../src/dispatchers/action-validate.js';
import { makeCtx } from '../src/dispatchers/ctx-factory.js';
```

Add these tests immediately before the `// --- Summary` section:

```javascript
// --- makeCtx -------------------------------------------------------------
const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => 'CFG',
  resolveGroup: () => 'GRP',
  getSftp: () => 'SFTP',
};

test('makeCtx: "conn" kind -> { getConnection, args }', () => {
  const ctx = makeCtx('conn', DEPS, { server: 's' });
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['args', 'getConnection']);
  assert.strictEqual(ctx.getConnection, DEPS.getConnection);
  assert.deepStrictEqual(ctx.args, { server: 's' });
});

test('makeCtx: "conn-cfg" kind adds getServerConfig', () => {
  const ctx = makeCtx('conn-cfg', DEPS, { server: 's' });
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['args', 'getConnection', 'getServerConfig']);
  assert.strictEqual(ctx.getServerConfig, DEPS.getServerConfig);
});

test('makeCtx: "conn-group" kind adds resolveGroup', () => {
  const ctx = makeCtx('conn-group', DEPS, {});
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['args', 'getConnection', 'resolveGroup']);
  assert.strictEqual(ctx.resolveGroup, DEPS.resolveGroup);
});

test('makeCtx: "cfg" kind -> { getServerConfig, args } only', () => {
  const ctx = makeCtx('cfg', DEPS, {});
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['args', 'getServerConfig']);
});

test('makeCtx: "args" kind -> { args } only', () => {
  const ctx = makeCtx('args', DEPS, { x: 1 });
  assert.deepStrictEqual(Object.keys(ctx), ['args']);
  assert.deepStrictEqual(ctx.args, { x: 1 });
});

test('makeCtx: "deploy" kind -> { getConnection, getSftp, args }', () => {
  const ctx = makeCtx('deploy', DEPS, {});
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['args', 'getConnection', 'getSftp']);
  assert.strictEqual(ctx.getSftp, DEPS.getSftp);
});

test('makeCtx: unknown kind throws', () => {
  assert.throws(() => makeCtx('bogus', DEPS, {}), /unknown ctx kind/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-ctx.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ctx-factory.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ctx-factory.js`:

```javascript
/**
 * Context-object factory for v4 dispatchers.
 *
 * The existing src/tools/*.js handlers destructure six divergent context
 * shapes. makeCtx assembles the right one from registration-time deps so the
 * dispatchers stay readable. deps holds getConnection / getServerConfig /
 * resolveGroup / getSftp; only the ones a kind needs are read.
 *
 * kinds:
 *   conn        { getConnection, args }                  exec, upload, cat, ...
 *   conn-cfg    { getConnection, getServerConfig, args }  execute_sudo, sync
 *   conn-group  { getConnection, resolveGroup, args }     execute_group
 *   cfg         { getServerConfig, args }                 key_manage
 *   deploy      { getConnection, getSftp, args }          deploy / deploy-artifact
 *   args        { args }                                  session_send, tail_read, ...
 */

export function makeCtx(kind, deps, args) {
  const d = deps || {};
  switch (kind) {
    case 'conn':
      return { getConnection: d.getConnection, args };
    case 'conn-cfg':
      return { getConnection: d.getConnection, getServerConfig: d.getServerConfig, args };
    case 'conn-group':
      return { getConnection: d.getConnection, resolveGroup: d.resolveGroup, args };
    case 'cfg':
      return { getServerConfig: d.getServerConfig, args };
    case 'deploy':
      return { getConnection: d.getConnection, getSftp: d.getSftp, args };
    case 'args':
      return { args };
    default:
      throw new Error(`unknown ctx kind: ${kind}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-ctx.js`
Expected: PASS — `14 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ctx-factory.js tests/test-dispatcher-ctx.js
git commit -m "feat: add ctx-factory helper for v4 dispatchers"
```

---

## Task 3: `ssh_run` dispatcher

`ssh_run` collapses `ssh_execute`, `ssh_execute_sudo`, `ssh_execute_group`. The dispatcher validates per-action args, builds the right ctx via `makeCtx`, maps the v4 snake_case args onto each handler's expected arg names, and calls the handler. `exec` and `sudo` need `getServerConfig` for `default_dir` / sudo-password lookup; `fleet` needs `resolveGroup`.

**Files:**
- Create: `src/dispatchers/ssh-run.js`
- Test: `tests/test-dispatcher-run.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-run.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_run v4 dispatcher (src/dispatchers/ssh-run.js).
 * Confirms each action lands on the right handler with the right context
 * object and arg mapping. Handlers are replaced by spies via the deps object.
 * Run: node tests/test-dispatcher-run.js
 */
import assert from 'assert';
import { handleSshRun } from '../src/dispatchers/ssh-run.js';

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

// A spy that records the single ctx object it was called with.
function spy(ret = { content: [{ type: 'text', text: 'ok' }], isError: false }) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return ret; };
  fn.calls = calls;
  return fn;
}

const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => ({ default_dir: '/srv' }),
  resolveGroup: (g) => ({ name: g, servers: ['a', 'b'] }),
};

console.log('[test] Testing ssh_run dispatcher\n');

// --- routing -------------------------------------------------------------
await test('exec routes to handlers.execute with { getConnection, args }', async () => {
  const execute = spy();
  await handleSshRun({
    deps: DEPS,
    handlers: { execute },
    args: { server: 's', action: 'exec', command: 'ls' },
  });
  assert.strictEqual(execute.calls.length, 1);
  const ctx = execute.calls[0];
  assert.strictEqual(ctx.getConnection, DEPS.getConnection);
  assert.strictEqual(ctx.args.command, 'ls');
  assert.strictEqual(ctx.args.server, 's');
  assert.strictEqual(ctx.resolveGroup, undefined, 'exec ctx carries no resolveGroup');
});

await test('exec maps timeout -> timeoutMs for the handler', async () => {
  const execute = spy();
  await handleSshRun({
    deps: DEPS, handlers: { execute },
    args: { server: 's', action: 'exec', command: 'ls', timeout: 9000 },
  });
  assert.strictEqual(execute.calls[0].args.timeoutMs, 9000);
});

await test('sudo routes to handlers.executeSudo with getServerConfig in ctx', async () => {
  const executeSudo = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeSudo },
    args: { server: 's', action: 'sudo', command: 'systemctl restart nginx' },
  });
  assert.strictEqual(executeSudo.calls.length, 1);
  assert.strictEqual(executeSudo.calls[0].getServerConfig, DEPS.getServerConfig);
});

await test('sudo maps sudo_password -> password and timeout -> timeoutMs', async () => {
  const executeSudo = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeSudo },
    args: { server: 's', action: 'sudo', command: 'id', sudo_password: 'pw', timeout: 5000 },
  });
  assert.strictEqual(executeSudo.calls[0].args.password, 'pw');
  assert.strictEqual(executeSudo.calls[0].args.timeoutMs, 5000);
});

await test('fleet routes to handlers.executeGroup with resolveGroup in ctx', async () => {
  const executeGroup = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeGroup },
    args: { action: 'fleet', group: 'web', command: 'uptime' },
  });
  assert.strictEqual(executeGroup.calls.length, 1);
  assert.strictEqual(executeGroup.calls[0].resolveGroup, DEPS.resolveGroup);
  assert.strictEqual(executeGroup.calls[0].getConnection, DEPS.getConnection);
});

// --- arg validation ------------------------------------------------------
await test('exec without command -> structured fail, handler never called', async () => {
  const execute = spy();
  const r = await handleSshRun({
    deps: DEPS, handlers: { execute },
    args: { server: 's', action: 'exec' },
  });
  assert.strictEqual(execute.calls.length, 0, 'handler not invoked');
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('command'));
});

await test('exec without server -> structured fail', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: { execute: spy() },
    args: { action: 'exec', command: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

await test('fleet without group -> structured fail', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: { executeGroup: spy() },
    args: { action: 'fleet', command: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('group'));
});

await test('unknown action -> structured fail naming the action', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: {},
    args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

await test('missing action -> structured fail', async () => {
  const r = await handleSshRun({ deps: DEPS, handlers: {}, args: { server: 's' } });
  assert.strictEqual(r.isError, true);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-run.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-run.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-run.js`:

```javascript
/**
 * ssh_run -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_execute / ssh_execute_sudo / ssh_execute_group. Routes the
 * `action` arg to an existing handler in src/tools/exec-tools.js, building the
 * right context object via makeCtx and mapping v4 snake_case args to the
 * handler arg names.
 *
 * actions handled here: exec, sudo, fleet.
 * (script, detach, job-status, job-kill are added by Plan 5.)
 *
 * handlers (injected): { execute, executeSudo, executeGroup }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  exec: ['server', 'command'],
  sudo: ['server', 'command'],
  fleet: ['group', 'command'],
};

export async function handleSshRun({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_run', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_run', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_run', action, a, REQUIRED);
  if (bad) return bad;

  if (action === 'exec') {
    const cfg = (deps.getServerConfig && deps.getServerConfig(a.server)) || {};
    return handlers.execute(makeCtx('conn', deps, {
      server: a.server,
      command: a.command,
      cwd: a.cwd || cfg.default_dir,
      timeoutMs: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  if (action === 'sudo') {
    return handlers.executeSudo(makeCtx('conn-cfg', deps, {
      server: a.server,
      command: a.command,
      password: a.sudo_password,
      cwd: a.cwd,
      timeoutMs: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  // action === 'fleet'
  return handlers.executeGroup(makeCtx('conn-group', deps, {
    group: a.group,
    command: a.command,
    cwd: a.cwd,
    raw: a.raw,
    format: a.format,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-run.js`
Expected: PASS — `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-run.js tests/test-dispatcher-run.js
git commit -m "feat: add ssh_run v4 dispatcher (exec, sudo, fleet)"
```

---

## Task 4: `ssh_file` dispatcher

`ssh_file` collapses `ssh_upload`, `ssh_download`, `ssh_sync`, `ssh_cat`, `ssh_edit`, `ssh_diff`, `ssh_deploy`, `ssh_deploy_artifact`. Nine actions: `upload`, `download`, `sync`, `read`, `write`, `edit`, `diff`, `deploy`, `deploy-artifact`. `sync` needs `getServerConfig`; `deploy` and `deploy-artifact` use the `deploy` ctx kind. `read` maps onto `handleSshCat`; `write` maps onto `handleSshEdit` with whole-file `new_content`.

**Files:**
- Create: `src/dispatchers/ssh-file.js`
- Test: `tests/test-dispatcher-file.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-file.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_file v4 dispatcher (src/dispatchers/ssh-file.js).
 * Run: node tests/test-dispatcher-file.js
 */
import assert from 'assert';
import { handleSshFile } from '../src/dispatchers/ssh-file.js';

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

function spy(ret = { content: [{ type: 'text', text: 'ok' }], isError: false }) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return ret; };
  fn.calls = calls;
  return fn;
}

const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => ({}),
  getSftp: () => 'SFTP',
};

console.log('[test] Testing ssh_file dispatcher\n');

// --- routing -------------------------------------------------------------
await test('upload routes to handlers.upload, maps local/remote_path', async () => {
  const upload = spy();
  await handleSshFile({
    deps: DEPS, handlers: { upload },
    args: { server: 's', action: 'upload', local_path: '/l', remote_path: '/r' },
  });
  assert.strictEqual(upload.calls.length, 1);
  assert.strictEqual(upload.calls[0].args.local_path, '/l');
  assert.strictEqual(upload.calls[0].args.remote_path, '/r');
  assert.strictEqual(upload.calls[0].getConnection, DEPS.getConnection);
});

await test('download routes to handlers.download', async () => {
  const download = spy();
  await handleSshFile({
    deps: DEPS, handlers: { download },
    args: { server: 's', action: 'download', local_path: '/l', remote_path: '/r' },
  });
  assert.strictEqual(download.calls.length, 1);
});

await test('sync routes to handlers.sync with getServerConfig in ctx', async () => {
  const sync = spy();
  await handleSshFile({
    deps: DEPS, handlers: { sync },
    args: { server: 's', action: 'sync', source: 'local:/a', destination: 'remote:/b' },
  });
  assert.strictEqual(sync.calls.length, 1);
  assert.strictEqual(sync.calls[0].getServerConfig, DEPS.getServerConfig);
  assert.strictEqual(sync.calls[0].args.source, 'local:/a');
});

await test('read routes to handlers.cat, maps remote_path -> file', async () => {
  const cat = spy();
  await handleSshFile({
    deps: DEPS, handlers: { cat },
    args: { server: 's', action: 'read', remote_path: '/etc/hosts', tail: 20 },
  });
  assert.strictEqual(cat.calls.length, 1);
  assert.strictEqual(cat.calls[0].args.file, '/etc/hosts');
  assert.strictEqual(cat.calls[0].args.tail, 20);
});

await test('write routes to handlers.edit with new_content set from content', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: { server: 's', action: 'write', remote_path: '/tmp/f', content: 'hello' },
  });
  assert.strictEqual(edit.calls.length, 1);
  assert.strictEqual(edit.calls[0].args.path, '/tmp/f');
  assert.strictEqual(edit.calls[0].args.new_content, 'hello');
});

await test('edit routes to handlers.edit, maps remote_path -> path', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: {
      server: 's', action: 'edit', remote_path: '/tmp/f',
      old_text: 'a', new_text: 'b',
    },
  });
  assert.strictEqual(edit.calls.length, 1);
  assert.strictEqual(edit.calls[0].args.path, '/tmp/f');
  assert.deepStrictEqual(edit.calls[0].args.patch, [{ find: 'a', replace: 'b' }]);
});

await test('diff routes to handlers.diff', async () => {
  const diff = spy();
  await handleSshFile({
    deps: DEPS, handlers: { diff },
    args: { server: 's', action: 'diff', path_a: '/a', path_b: '/b' },
  });
  assert.strictEqual(diff.calls.length, 1);
  assert.strictEqual(diff.calls[0].args.path_a, '/a');
});

await test('deploy routes to handlers.deploy with getSftp in ctx', async () => {
  const deploy = spy();
  await handleSshFile({
    deps: DEPS, handlers: { deploy },
    args: {
      server: 's', action: 'deploy',
      artifact_local_path: '/a', target_path: '/t',
    },
  });
  assert.strictEqual(deploy.calls.length, 1);
  assert.strictEqual(deploy.calls[0].getSftp, DEPS.getSftp);
  assert.strictEqual(deploy.calls[0].args.artifact_local_path, '/a');
});

await test('deploy-artifact routes to handlers.deploy', async () => {
  const deploy = spy();
  await handleSshFile({
    deps: DEPS, handlers: { deploy },
    args: {
      server: 's', action: 'deploy-artifact',
      artifact_local_path: '/a', target_path: '/t',
    },
  });
  assert.strictEqual(deploy.calls.length, 1);
});

// --- arg validation ------------------------------------------------------
await test('upload missing local_path -> structured fail, handler not called', async () => {
  const upload = spy();
  const r = await handleSshFile({
    deps: DEPS, handlers: { upload },
    args: { server: 's', action: 'upload', remote_path: '/r' },
  });
  assert.strictEqual(upload.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('local_path'));
});

await test('write missing content -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: { edit: spy() },
    args: { server: 's', action: 'write', remote_path: '/tmp/f' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('content'));
});

await test('sync missing destination -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: { sync: spy() },
    args: { server: 's', action: 'sync', source: 'local:/a' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('destination'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: {},
    args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-file.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-file.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-file.js`:

```javascript
/**
 * ssh_file -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_upload / ssh_download / ssh_sync / ssh_cat / ssh_edit /
 * ssh_diff / ssh_deploy / ssh_deploy_artifact. Routes `action` to an existing
 * handler, mapping v4 snake_case args to each handler's arg names.
 *
 * read  -> handleSshCat (remote_path -> file).
 * write -> handleSshEdit whole-file replace (content -> new_content).
 * edit  -> handleSshEdit find/replace patch (old_text/new_text -> patch[]).
 *
 * handlers (injected): { upload, download, sync, cat, edit, diff, deploy }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  upload: ['server', 'local_path', 'remote_path'],
  download: ['server', 'local_path', 'remote_path'],
  sync: ['server', 'source', 'destination'],
  read: ['server', 'remote_path'],
  write: ['server', 'remote_path', 'content'],
  edit: ['server', 'remote_path'],
  diff: ['server', 'path_a', 'path_b'],
  deploy: ['server', 'artifact_local_path', 'target_path'],
  'deploy-artifact': ['server', 'artifact_local_path', 'target_path'],
};

export async function handleSshFile({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_file', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_file', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_file', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'upload':
      return handlers.upload(makeCtx('conn', deps, {
        server: a.server,
        local_path: a.local_path,
        remote_path: a.remote_path,
        preview: a.preview,
        format: a.format,
      }));

    case 'download':
      return handlers.download(makeCtx('conn', deps, {
        server: a.server,
        local_path: a.local_path,
        remote_path: a.remote_path,
        preview: a.preview,
        format: a.format,
      }));

    case 'sync':
      return handlers.sync(makeCtx('conn-cfg', deps, {
        server: a.server,
        source: a.source,
        destination: a.destination,
        exclude: a.exclude,
        delete: a.delete_extra,
        preview: a.preview,
        format: a.format,
      }));

    case 'read':
      return handlers.cat(makeCtx('conn', deps, {
        server: a.server,
        file: a.remote_path,
        head: a.head,
        tail: a.tail,
        grep: a.grep,
        line_start: a.line_start,
        line_end: a.line_end,
        format: a.format,
      }));

    case 'write':
      return handlers.edit(makeCtx('conn', deps, {
        server: a.server,
        path: a.remote_path,
        new_content: a.content,
        preview: a.preview,
        format: a.format,
      }));

    case 'edit':
      return handlers.edit(makeCtx('conn', deps, {
        server: a.server,
        path: a.remote_path,
        patch: a.old_text != null ? [{ find: a.old_text, replace: a.new_text ?? '' }] : undefined,
        preview: a.preview,
        format: a.format,
      }));

    case 'diff':
      return handlers.diff(makeCtx('conn', deps, {
        server: a.server,
        path_a: a.path_a,
        path_b: a.path_b,
        server_b: a.server_b,
        preview: a.preview,
        format: a.format,
      }));

    case 'deploy':
    case 'deploy-artifact':
    default:
      return handlers.deploy(makeCtx('deploy', deps, {
        server: a.server,
        artifact_local_path: a.artifact_local_path,
        target_path: a.target_path,
        post_hooks: a.post_hooks,
        health_check: a.health_check,
        rollback_on_fail: a.rollback_on_fail,
        permissions: a.permissions,
        owner: a.owner,
        preview: a.preview,
        format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-file.js`
Expected: PASS — `13 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: `39 files, 727 passed, 0 failed` — the previous 690, plus the 14-test `test-dispatcher-ctx.js`, 10-test `test-dispatcher-run.js`, and 13-test `test-dispatcher-file.js` suites (14 + 10 + 13 = 37; 690 + 37 = 727). Re-count from the actual run; the exact total is whatever `npm test` prints. Because this plan only *adds* files and never touches `index.js` or any existing module, every pre-existing suite must still pass unchanged.

> If the printed total differs from 727, do not "fix" a test to hit a number — confirm the three new suites each printed their expected pass counts (14 / 10 / 13) and that no pre-existing suite regressed, then record the real total.

- [ ] **Step 6: Commit**

```bash
git add src/dispatchers/ssh-file.js tests/test-dispatcher-file.js
git commit -m "feat: add ssh_file v4 dispatcher"
```

---

## Done criteria

- `src/dispatchers/` contains `action-validate.js`, `ctx-factory.js`, `ssh-run.js`, `ssh-file.js`.
- `ssh_run` dispatches `exec` / `sudo` / `fleet`; `ssh_file` dispatches `upload` / `download` / `sync` / `read` / `write` / `edit` / `diff` / `deploy` / `deploy-artifact`.
- Every dispatcher validates per-action required args and returns a structured `fail()` MCP response on a miss, without calling the handler.
- `npm test` is green: the three new suites pass (14 / 10 / 13) and zero pre-existing suites regress.
- `src/index.js`, `src/tool-registry.js`, `src/tool-annotations.js` are untouched — the cutover is Part 3.
- No handler in `src/tools/*.js` was modified.

Part 2 builds the remaining ten dispatchers (`ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan`) on the same `ctx-factory` + `action-validate` framework. Part 3 wires all twelve dispatchers into `index.js`, rewrites `tool-registry.js` and `tool-annotations.js` for the 12-tool surface, and rewrites the four coupled test suites.

---

## Self-review

Performed after drafting, before marking the plan ready.

**Spec coverage (sections 3, 7).**
- "13 fat verb-tools, dispatchers over existing handlers" — this part delivers the framework + 2 of the 12 in-scope tools (`ssh_find`, the 13th, is Plan 5). Covered; remaining 10 are Part 2, cutover is Part 3.
- "dispatchers assemble the correct per-action context; a ctx-factory helper centralizes this" — `ctx-factory.js`, Task 2. The six handler-context shapes were verified by reading `src/tools/exec-tools.js`, `transfer-tools.js`, `deploy-tools.js`, `cat-tools.js` export signatures and are listed in the cheat-sheet table.
- "every action-scoped argument optional; dispatcher checks a per-action required-arg map and returns structured fail() naming missing args" — `action-validate.js`, Task 1; `REQUIRED` maps in both dispatchers; tested for single + multiple missing args.
- "camelCase aliases dropped; snake_case only" — the dispatchers read snake_case args (`local_path`, `sudo_password`, `delete_extra`) only; no `localPath`/`sudoPassword` aliases. The handler-arg names the dispatcher *targets* (`timeoutMs`, `new_content`, `path`, `password`, `patch`, `delete`) are the existing handlers' internal arg names, verified against the `index.js` registration blocks that call them today — those are not the v4 schema surface, they are the unchanged handler contract.
- "ssh_run here = exec, sudo, fleet only; script/detach/job are Plan 5" — explicit scope note; `REQUIRED` for `ssh_run` has exactly `exec`/`sudo`/`fleet`; `ssh-run.js` rejects any other action.
- "ssh_file action: deploy-artifact" + "ssh_deploy_artifact becomes ssh_file action: deploy-artifact" — both `deploy` and `deploy-artifact` route to the one `handleSshDeploy` handler (which `index.js` today uses for both `ssh_deploy` and `ssh_deploy_artifact`).

**Placeholder scan.** Searched the draft for "TBD", "similar to", "add validation", "etc.", "...". The only `...` occurrences are real JS spread/rest syntax inside code blocks; no prose placeholder remains. Every code step is complete, copy-pasteable real code.

**Type consistency.**
- Dispatcher return type: every path returns either a handler's MCP `{ content, isError? }` object or `toMcp(fail(...))` — `toMcp` returns the same `{ content, isError }` shape. Consistent. Confirmed `fail()`/`toMcp()` signatures by reading `src/structured-result.js`: `fail(tool, error, meta)` and `toMcp(result, opts?)`.
- `requireArgs` returns `null | { content, isError:true }` — callers (`ssh-run.js`, `ssh-file.js`) treat a truthy return as a ready MCP response and `return` it directly. Consistent.
- `makeCtx` return: object whose keys are a strict subset of `{getConnection, getServerConfig, resolveGroup, getSftp, args}` — every handler this part touches destructures only keys present in the kind it is given (verified per the cheat-sheet table). `handleSshDeploy` reads `getSftp` optionally; `makeCtx('deploy', ...)` supplies it (test-injected or, in Part 3, omitted — the handler tolerates `undefined`).
- Test runner contract: each new suite prints `N passed, M failed` and calls `process.exit(1)` on failure — matches `scripts/run-tests.mjs` Pattern A. The `async test()` helper is used because dispatchers are async; `await test(...)` at top level is valid in an ESM module.

**Issue found and fixed inline.** First draft of `ssh-file.js` `edit` always emitted `patch: [{find, replace}]` even when `old_text` was absent (the `write` action does whole-file replace and shares no patch). Fixed: `edit` builds `patch` only when `a.old_text != null`, and `requireArgs` for `edit` requires just `server`+`remote_path` (find/replace pair is optional at the schema layer — `handleSshEdit` itself rejects an empty edit). `write` and `edit` are kept as distinct actions routing to the same handler with different arg shapes, matching `handleSshEdit`'s `new_content` XOR `patch` contract.
