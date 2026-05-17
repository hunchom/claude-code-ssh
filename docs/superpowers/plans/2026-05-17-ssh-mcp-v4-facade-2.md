# ssh-mcp v4 Dispatcher Facade Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the remaining ten v4 fat verb-tool dispatchers — `ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan` — each routing an `action` arg to the existing, unchanged handlers in `src/tools/*.js`.

**Architecture:** Additive only. Ten new modules under `src/dispatchers/`, each exporting one `handle<Tool>({ deps, handlers, args })` function built on the Part 1 `ctx-factory` (`makeCtx`) and `action-validate` (`requireArgs`) helpers. No handler in `src/tools/*.js` is modified. No `src/index.js` registration changes — Part 3 does the cutover. New routing test suites per dispatcher. Nothing is wired into `index.js`, so this plan ships zero runtime risk and leaves `npm test` green.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`, zod v4.

This is Plan 4 of 6, Part 2 of 3. Part 1 (framework + `ssh_run`, `ssh_file`) is complete. Part 3: the `index.js` / `tool-registry.js` / `tool-annotations.js` registration cutover and the four coupled-suite rewrites. Plan 5: new capabilities (`ssh_find`, `ssh_run` `script`/`detach`/job actions). Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` section 3.

### Scope notes

- `ssh_logs` here covers `tail`, `follow-start`, `follow-read`, `follow-stop`, `journal` — all five map onto existing handlers (`handleSshTail`, `handleSshTailStart`, `handleSshTailRead`, `handleSshTailStop`, `handleSshJournalctl`). Nothing in `ssh_logs` is deferred.
- `ssh_docker` keeps its existing multi-action handler (`handleSshDocker`) first-class — the dispatcher is a thin pass-through that re-labels but does not re-implement Docker's own action enum.
- `ssh_plan`'s injected dispatch table is keyed by the **plan-step action enum** (`exec`, `exec_sudo`, `upload`, `download`, `edit`, `systemctl`, `backup`, `health_check`, ...), not by tool names — see Task 10 for the verified reason.

---

## File Structure

- **Create `src/dispatchers/ssh-logs.js`** — `handleSshLogs`; actions `tail`, `follow-start`, `follow-read`, `follow-stop`, `journal`.
- **Create `src/dispatchers/ssh-service.js`** — `handleSshService`; actions `status`, `start`, `stop`, `restart`, `enable`, `disable`.
- **Create `src/dispatchers/ssh-health.js`** — `handleSshHealth`; actions `check`, `watch`, `procs`, `alerts`.
- **Create `src/dispatchers/ssh-db.js`** — `handleSshDb`; actions `query`, `list`, `dump`, `import`.
- **Create `src/dispatchers/ssh-backup.js`** — `handleSshBackup`; actions `create`, `list`, `restore`, `schedule`.
- **Create `src/dispatchers/ssh-session.js`** — `handleSshSession`; actions `start`, `send`, `list`, `close`, `replay`, `memory`.
- **Create `src/dispatchers/ssh-net.js`** — `handleSshNet`; actions `tunnel-open`, `tunnel-list`, `tunnel-close`, `port-test`.
- **Create `src/dispatchers/ssh-docker.js`** — `handleSshDocker` dispatcher wrapper; actions `ps`, `logs`, `exec`, `restart`, `inspect`, `compose`.
- **Create `src/dispatchers/ssh-fleet.js`** — `handleSshFleet`; actions `servers`, `groups`, `aliases`, `profiles`, `hooks`, `keys`, `history`, `connections`.
- **Create `src/dispatchers/ssh-plan.js`** — `handleSshPlanTool`; actions `run`, `approve`.
- **Create** one `tests/test-dispatcher-<name>.js` per dispatcher (ten suites), auto-discovered by `scripts/run-tests.mjs`.

### Handler-context cheat sheet (verified against `src/tools/*.js`)

| Handler | Context object | ctx kind |
|---|---|---|
| `handleSshTail` | `{ getConnection, args }` | `conn` |
| `handleSshTailStart` | `{ getConnection, args }` | `conn` |
| `handleSshTailRead` / `handleSshTailStop` | `{ args }` | `args` |
| `handleSshJournalctl` | `{ getConnection, args }` | `conn` |
| `handleSshSystemctl` | `{ getConnection, args }` | `conn` |
| `handleSshServiceStatus` | `{ getConnection, args }` | `conn` |
| `handleSshHealthCheck` / `handleSshMonitor` / `handleSshProcessManager` | `{ getConnection, args }` | `conn` |
| `handleSshAlertSetup` | `{ getConnection, args }` | `conn` |
| `handleSshDbQuery` / `handleSshDbList` / `handleSshDbDump` / `handleSshDbImport` | `{ getConnection, args }` | `conn` |
| `handleSshBackupCreate` / `handleSshBackupList` / `handleSshBackupRestore` / `handleSshBackupSchedule` | `{ getConnection, args }` | `conn` |
| `handleSshSessionStart` | `{ getConnection, args, _openShellStream? }` | `conn` |
| `handleSshSessionSend` / `List` / `Close` / `Replay` / `Memory` | `{ args }` | `args` |
| `handleSshTunnelCreate` | `{ getConnection, args }` (reads `ctx`) | `conn` |
| `handleSshTunnelList` / `handleSshTunnelClose` | `{ args }` (reads `ctx`) | `args` |
| `handleSshPortTest` | `{ getConnection, args }` (reads `ctx`) | `conn` |
| `handleSshDocker` | `{ getConnection, args }` | `conn` |
| `handleSshKeyManage` | `{ getServerConfig, args }` (reads `ctx`) | `cfg` |
| `handleSshPlan` | `{ dispatch, args }` | custom — see Task 10 |

`handleSshSessionStart` reads `_openShellStream` only as an injectable test seam; production omits it and the handler opens the shell itself. The dispatcher uses `makeCtx('conn', ...)` and never supplies `_openShellStream`.

`handleSshTunnelCreate`/`List`/`Close`, `handleSshPortTest`, `handleSshKeyManage` declare their parameter as `ctx = {}` then destructure — `makeCtx` produces exactly that object, so passing `makeCtx(...)` directly as the single argument works.

---

## Task 1: `ssh_logs` dispatcher

`ssh_logs` collapses `ssh_tail`, `ssh_tail_start`, `ssh_tail_read`, `ssh_tail_stop`, `ssh_journalctl`. Five actions: `tail`, `follow-start`, `follow-read`, `follow-stop`, `journal`.

**Files:**
- Create: `src/dispatchers/ssh-logs.js`
- Test: `tests/test-dispatcher-logs.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-logs.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_logs v4 dispatcher (src/dispatchers/ssh-logs.js).
 * Run: node tests/test-dispatcher-logs.js
 */
import assert from 'assert';
import { handleSshLogs } from '../src/dispatchers/ssh-logs.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_logs dispatcher\n');

await test('tail routes to handlers.tail with { getConnection, args }', async () => {
  const tail = spy();
  await handleSshLogs({
    deps: DEPS, handlers: { tail },
    args: { server: 's', action: 'tail', file: '/var/log/x', lines: 30 },
  });
  assert.strictEqual(tail.calls.length, 1);
  assert.strictEqual(tail.calls[0].getConnection, DEPS.getConnection);
  assert.strictEqual(tail.calls[0].args.file, '/var/log/x');
  assert.strictEqual(tail.calls[0].args.lines, 30);
});

await test('follow-start routes to handlers.tailStart', async () => {
  const tailStart = spy();
  await handleSshLogs({
    deps: DEPS, handlers: { tailStart },
    args: { server: 's', action: 'follow-start', file: '/var/log/x' },
  });
  assert.strictEqual(tailStart.calls.length, 1);
  assert.strictEqual(tailStart.calls[0].args.file, '/var/log/x');
});

await test('follow-read routes to handlers.tailRead with { args } only', async () => {
  const tailRead = spy();
  await handleSshLogs({
    deps: DEPS, handlers: { tailRead },
    args: { action: 'follow-read', session_id: 'sess-1', since_offset: 12 },
  });
  assert.strictEqual(tailRead.calls.length, 1);
  assert.deepStrictEqual(Object.keys(tailRead.calls[0]), ['args']);
  assert.strictEqual(tailRead.calls[0].args.session_id, 'sess-1');
  assert.strictEqual(tailRead.calls[0].args.since_offset, 12);
});

await test('follow-stop routes to handlers.tailStop with { args } only', async () => {
  const tailStop = spy();
  await handleSshLogs({
    deps: DEPS, handlers: { tailStop },
    args: { action: 'follow-stop', session_id: 'sess-1' },
  });
  assert.strictEqual(tailStop.calls.length, 1);
  assert.deepStrictEqual(Object.keys(tailStop.calls[0]), ['args']);
});

await test('journal routes to handlers.journal', async () => {
  const journal = spy();
  await handleSshLogs({
    deps: DEPS, handlers: { journal },
    args: { server: 's', action: 'journal', unit: 'sshd.service', since: '1 hour ago' },
  });
  assert.strictEqual(journal.calls.length, 1);
  assert.strictEqual(journal.calls[0].args.unit, 'sshd.service');
  assert.strictEqual(journal.calls[0].args.since, '1 hour ago');
});

await test('tail missing file -> structured fail, handler not called', async () => {
  const tail = spy();
  const r = await handleSshLogs({
    deps: DEPS, handlers: { tail },
    args: { server: 's', action: 'tail' },
  });
  assert.strictEqual(tail.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('file'));
});

await test('follow-read missing session_id -> structured fail', async () => {
  const r = await handleSshLogs({
    deps: DEPS, handlers: { tailRead: spy() },
    args: { action: 'follow-read' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('session_id'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshLogs({ deps: DEPS, handlers: {}, args: { action: 'sniff' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('sniff'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-logs.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-logs.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-logs.js`:

```javascript
/**
 * ssh_logs -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_tail / ssh_tail_start / ssh_tail_read / ssh_tail_stop /
 * ssh_journalctl. Routes `action` to an existing handler.
 *
 * handlers (injected): { tail, tailStart, tailRead, tailStop, journal }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  tail: ['server', 'file'],
  'follow-start': ['server', 'file'],
  'follow-read': ['session_id'],
  'follow-stop': ['session_id'],
  journal: ['server'],
};

export async function handleSshLogs({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_logs', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_logs', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_logs', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'tail':
      return handlers.tail(makeCtx('conn', deps, {
        server: a.server, file: a.file, lines: a.lines, grep: a.grep, format: a.format,
      }));

    case 'follow-start':
      return handlers.tailStart(makeCtx('conn', deps, {
        server: a.server, file: a.file, lines: a.lines, grep: a.grep, format: a.format,
      }));

    case 'follow-read':
      return handlers.tailRead(makeCtx('args', deps, {
        session_id: a.session_id, since_offset: a.since_offset, format: a.format,
      }));

    case 'follow-stop':
      return handlers.tailStop(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));

    case 'journal':
    default:
      return handlers.journal(makeCtx('conn', deps, {
        server: a.server, unit: a.unit, since: a.since, until: a.until,
        priority: a.priority, lines: a.lines, grep: a.grep, format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-logs.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-logs.js tests/test-dispatcher-logs.js
git commit -m "feat: add ssh_logs v4 dispatcher"
```

---

## Task 2: `ssh_service` dispatcher

`ssh_service` collapses `ssh_service_status` and `ssh_systemctl`. Six actions: `status`, `start`, `stop`, `restart`, `enable`, `disable`. `status` is best served by `handleSshServiceStatus` (typed snapshot); the four mutating actions plus `enable`/`disable` route to `handleSshSystemctl`, whose own `action` enum already includes those verbs.

**Files:**
- Create: `src/dispatchers/ssh-service.js`
- Test: `tests/test-dispatcher-service.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-service.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_service v4 dispatcher (src/dispatchers/ssh-service.js).
 * Run: node tests/test-dispatcher-service.js
 */
import assert from 'assert';
import { handleSshService } from '../src/dispatchers/ssh-service.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_service dispatcher\n');

await test('status routes to handlers.serviceStatus, maps service through', async () => {
  const serviceStatus = spy();
  await handleSshService({
    deps: DEPS, handlers: { serviceStatus },
    args: { server: 's', action: 'status', service: 'nginx' },
  });
  assert.strictEqual(serviceStatus.calls.length, 1);
  assert.strictEqual(serviceStatus.calls[0].args.service, 'nginx');
  assert.strictEqual(serviceStatus.calls[0].getConnection, DEPS.getConnection);
});

await test('restart routes to handlers.systemctl with action+unit set', async () => {
  const systemctl = spy();
  await handleSshService({
    deps: DEPS, handlers: { systemctl },
    args: { server: 's', action: 'restart', service: 'nginx' },
  });
  assert.strictEqual(systemctl.calls.length, 1);
  assert.strictEqual(systemctl.calls[0].args.action, 'restart');
  assert.strictEqual(systemctl.calls[0].args.unit, 'nginx');
});

await test('start/stop/enable/disable all route to handlers.systemctl', async () => {
  for (const action of ['start', 'stop', 'enable', 'disable']) {
    const systemctl = spy();
    await handleSshService({
      deps: DEPS, handlers: { systemctl },
      args: { server: 's', action, service: 'sshd' },
    });
    assert.strictEqual(systemctl.calls.length, 1, `${action} reached systemctl`);
    assert.strictEqual(systemctl.calls[0].args.action, action);
    assert.strictEqual(systemctl.calls[0].args.unit, 'sshd');
  }
});

await test('restart forwards preview flag to systemctl', async () => {
  const systemctl = spy();
  await handleSshService({
    deps: DEPS, handlers: { systemctl },
    args: { server: 's', action: 'restart', service: 'nginx', preview: true },
  });
  assert.strictEqual(systemctl.calls[0].args.preview, true);
});

await test('status missing service -> structured fail, handler not called', async () => {
  const serviceStatus = spy();
  const r = await handleSshService({
    deps: DEPS, handlers: { serviceStatus },
    args: { server: 's', action: 'status' },
  });
  assert.strictEqual(serviceStatus.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('service'));
});

await test('restart missing service -> structured fail', async () => {
  const r = await handleSshService({
    deps: DEPS, handlers: { systemctl: spy() },
    args: { server: 's', action: 'restart' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('service'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshService({ deps: DEPS, handlers: {}, args: { server: 's', action: 'reload-all' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('reload-all'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-service.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-service.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-service.js`:

```javascript
/**
 * ssh_service -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_service_status / ssh_systemctl.
 * status -> handleSshServiceStatus (typed snapshot).
 * start/stop/restart/enable/disable -> handleSshSystemctl (its action enum
 * already has these verbs); v4 `service` arg maps to systemctl's `unit`.
 *
 * handlers (injected): { serviceStatus, systemctl }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  status: ['server', 'service'],
  start: ['server', 'service'],
  stop: ['server', 'service'],
  restart: ['server', 'service'],
  enable: ['server', 'service'],
  disable: ['server', 'service'],
};

export async function handleSshService({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_service', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_service', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_service', action, a, REQUIRED);
  if (bad) return bad;

  if (action === 'status') {
    return handlers.serviceStatus(makeCtx('conn', deps, {
      server: a.server, service: a.service, format: a.format,
    }));
  }

  // start / stop / restart / enable / disable -> systemctl
  return handlers.systemctl(makeCtx('conn', deps, {
    server: a.server,
    action,
    unit: a.service,
    preview: a.preview,
    format: a.format,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-service.js`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-service.js tests/test-dispatcher-service.js
git commit -m "feat: add ssh_service v4 dispatcher"
```

---

## Task 3: `ssh_health` dispatcher

`ssh_health` collapses `ssh_health_check`, `ssh_monitor`, `ssh_process_manager`, `ssh_alert_setup`. Four actions: `check` -> `handleSshHealthCheck`; `watch` -> `handleSshMonitor`; `procs` -> `handleSshProcessManager`; `alerts` -> `handleSshAlertSetup`.

**Files:**
- Create: `src/dispatchers/ssh-health.js`
- Test: `tests/test-dispatcher-health.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-health.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_health v4 dispatcher (src/dispatchers/ssh-health.js).
 * Run: node tests/test-dispatcher-health.js
 */
import assert from 'assert';
import { handleSshHealth } from '../src/dispatchers/ssh-health.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_health dispatcher\n');

await test('check routes to handlers.healthCheck', async () => {
  const healthCheck = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { healthCheck },
    args: { server: 's', action: 'check' },
  });
  assert.strictEqual(healthCheck.calls.length, 1);
  assert.strictEqual(healthCheck.calls[0].args.server, 's');
  assert.strictEqual(healthCheck.calls[0].getConnection, DEPS.getConnection);
});

await test('watch routes to handlers.monitor, maps watch_type -> type', async () => {
  const monitor = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { monitor },
    args: { server: 's', action: 'watch', watch_type: 'cpu' },
  });
  assert.strictEqual(monitor.calls.length, 1);
  assert.strictEqual(monitor.calls[0].args.type, 'cpu');
});

await test('procs routes to handlers.processManager, passing proc_action -> action', async () => {
  const processManager = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { processManager },
    args: { server: 's', action: 'procs', proc_action: 'list', limit: 10 },
  });
  assert.strictEqual(processManager.calls.length, 1);
  assert.strictEqual(processManager.calls[0].args.action, 'list');
  assert.strictEqual(processManager.calls[0].args.limit, 10);
});

await test('procs defaults proc_action to "list" when omitted', async () => {
  const processManager = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { processManager },
    args: { server: 's', action: 'procs' },
  });
  assert.strictEqual(processManager.calls[0].args.action, 'list');
});

await test('procs kill forwards pid + signal + preview', async () => {
  const processManager = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { processManager },
    args: { server: 's', action: 'procs', proc_action: 'kill', pid: 42, signal: 'KILL', preview: true },
  });
  assert.strictEqual(processManager.calls[0].args.pid, 42);
  assert.strictEqual(processManager.calls[0].args.signal, 'KILL');
  assert.strictEqual(processManager.calls[0].args.preview, true);
});

await test('alerts routes to handlers.alertSetup, maps alert_action -> action', async () => {
  const alertSetup = spy();
  await handleSshHealth({
    deps: DEPS, handlers: { alertSetup },
    args: { server: 's', action: 'alerts', alert_action: 'check' },
  });
  assert.strictEqual(alertSetup.calls.length, 1);
  assert.strictEqual(alertSetup.calls[0].args.action, 'check');
});

await test('check missing server -> structured fail', async () => {
  const r = await handleSshHealth({
    deps: DEPS, handlers: { healthCheck: spy() },
    args: { action: 'check' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

await test('alerts missing alert_action -> structured fail', async () => {
  const r = await handleSshHealth({
    deps: DEPS, handlers: { alertSetup: spy() },
    args: { server: 's', action: 'alerts' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('alert_action'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshHealth({ deps: DEPS, handlers: {}, args: { server: 's', action: 'xray' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('xray'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-health.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-health.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-health.js`:

```javascript
/**
 * ssh_health -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_health_check / ssh_monitor / ssh_process_manager /
 * ssh_alert_setup.
 *   check  -> handleSshHealthCheck
 *   watch  -> handleSshMonitor          (watch_type -> type)
 *   procs  -> handleSshProcessManager   (proc_action -> action, default 'list')
 *   alerts -> handleSshAlertSetup       (alert_action -> action)
 *
 * v4 sub-action args are renamed so the single `action` slot stays the
 * verb-tool selector and the inner tool's own action enum is a distinct arg.
 *
 * handlers (injected): { healthCheck, monitor, processManager, alertSetup }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  check: ['server'],
  watch: ['server'],
  procs: ['server'],
  alerts: ['server', 'alert_action'],
};

export async function handleSshHealth({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_health', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_health', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_health', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'check':
      return handlers.healthCheck(makeCtx('conn', deps, {
        server: a.server, format: a.format,
      }));

    case 'watch':
      return handlers.monitor(makeCtx('conn', deps, {
        server: a.server, type: a.watch_type, format: a.format,
      }));

    case 'procs':
      return handlers.processManager(makeCtx('conn', deps, {
        server: a.server,
        action: a.proc_action || 'list',
        pid: a.pid,
        signal: a.signal,
        sort_by: a.sort_by,
        limit: a.limit,
        filter: a.filter,
        preview: a.preview,
        format: a.format,
      }));

    case 'alerts':
    default:
      return handlers.alertSetup(makeCtx('conn', deps, {
        server: a.server,
        action: a.alert_action,
        cpuThreshold: a.cpu_threshold,
        memoryThreshold: a.memory_threshold,
        diskThreshold: a.disk_threshold,
        enabled: a.enabled,
        format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-health.js`
Expected: PASS — `9 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-health.js tests/test-dispatcher-health.js
git commit -m "feat: add ssh_health v4 dispatcher"
```

---

## Task 4: `ssh_db` dispatcher

`ssh_db` collapses `ssh_db_query`, `ssh_db_list`, `ssh_db_dump`, `ssh_db_import`. Four actions: `query`, `list`, `dump`, `import`. All four handlers use the `conn` ctx kind. v4 `db_type` maps onto each handler's `db_type` arg.

**Files:**
- Create: `src/dispatchers/ssh-db.js`
- Test: `tests/test-dispatcher-db.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-db.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_db v4 dispatcher (src/dispatchers/ssh-db.js).
 * Run: node tests/test-dispatcher-db.js
 */
import assert from 'assert';
import { handleSshDb } from '../src/dispatchers/ssh-db.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_db dispatcher\n');

await test('query routes to handlers.query with db_type + query', async () => {
  const query = spy();
  await handleSshDb({
    deps: DEPS, handlers: { query },
    args: { server: 's', action: 'query', database: 'app', query: 'SELECT 1', db_type: 'mysql' },
  });
  assert.strictEqual(query.calls.length, 1);
  assert.strictEqual(query.calls[0].args.query, 'SELECT 1');
  assert.strictEqual(query.calls[0].args.db_type, 'mysql');
  assert.strictEqual(query.calls[0].getConnection, DEPS.getConnection);
});

await test('list routes to handlers.list (database optional)', async () => {
  const list = spy();
  await handleSshDb({
    deps: DEPS, handlers: { list },
    args: { server: 's', action: 'list', db_type: 'postgresql' },
  });
  assert.strictEqual(list.calls.length, 1);
  assert.strictEqual(list.calls[0].args.db_type, 'postgresql');
});

await test('dump routes to handlers.dump', async () => {
  const dump = spy();
  await handleSshDb({
    deps: DEPS, handlers: { dump },
    args: { server: 's', action: 'dump', database: 'app', output_file: '/tmp/a.sql' },
  });
  assert.strictEqual(dump.calls.length, 1);
  assert.strictEqual(dump.calls[0].args.output_file, '/tmp/a.sql');
});

await test('import routes to handlers.import, forwards preview', async () => {
  const importH = spy();
  await handleSshDb({
    deps: DEPS, handlers: { import: importH },
    args: { server: 's', action: 'import', database: 'app', input_file: '/tmp/a.sql', preview: true },
  });
  assert.strictEqual(importH.calls.length, 1);
  assert.strictEqual(importH.calls[0].args.input_file, '/tmp/a.sql');
  assert.strictEqual(importH.calls[0].args.preview, true);
});

await test('db credential args are forwarded', async () => {
  const query = spy();
  await handleSshDb({
    deps: DEPS, handlers: { query },
    args: {
      server: 's', action: 'query', database: 'app', query: 'SELECT 1',
      user: 'u', password: 'p', host: 'h', port: 5432,
    },
  });
  const fwd = query.calls[0].args;
  assert.strictEqual(fwd.user, 'u');
  assert.strictEqual(fwd.password, 'p');
  assert.strictEqual(fwd.host, 'h');
  assert.strictEqual(fwd.port, 5432);
});

await test('query missing query -> structured fail, handler not called', async () => {
  const query = spy();
  const r = await handleSshDb({
    deps: DEPS, handlers: { query },
    args: { server: 's', action: 'query', database: 'app' },
  });
  assert.strictEqual(query.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('query'));
});

await test('dump missing database -> structured fail', async () => {
  const r = await handleSshDb({
    deps: DEPS, handlers: { dump: spy() },
    args: { server: 's', action: 'dump' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('database'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshDb({ deps: DEPS, handlers: {}, args: { server: 's', action: 'truncate' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('truncate'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-db.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-db.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-db.js`:

```javascript
/**
 * ssh_db -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_db_query / ssh_db_list / ssh_db_dump / ssh_db_import.
 * All four use the conn ctx kind.
 *
 * handlers (injected): { query, list, dump, import }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  query: ['server', 'database', 'query'],
  list: ['server'],
  dump: ['server', 'database'],
  import: ['server', 'database'],
};

// Args common to every db handler: connection-target credentials.
function creds(a) {
  return {
    server: a.server,
    db_type: a.db_type,
    database: a.database,
    user: a.user,
    password: a.password,
    host: a.host,
    port: a.port,
    format: a.format,
  };
}

export async function handleSshDb({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_db', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_db', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_db', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'query':
      return handlers.query(makeCtx('conn', deps, {
        ...creds(a), query: a.query, collection: a.collection,
      }));

    case 'list':
      return handlers.list(makeCtx('conn', deps, creds(a)));

    case 'dump':
      return handlers.dump(makeCtx('conn', deps, {
        ...creds(a), output_file: a.output_file, gzip: a.gzip, tables: a.tables,
      }));

    case 'import':
    default:
      return handlers.import(makeCtx('conn', deps, {
        ...creds(a), input_file: a.input_file, drop: a.drop, preview: a.preview,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-db.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-db.js tests/test-dispatcher-db.js
git commit -m "feat: add ssh_db v4 dispatcher"
```

---

## Task 5: `ssh_backup` dispatcher

`ssh_backup` collapses `ssh_backup_create`, `ssh_backup_list`, `ssh_backup_restore`, `ssh_backup_schedule`. Four actions: `create`, `list`, `restore`, `schedule`. All `conn` ctx kind.

**Files:**
- Create: `src/dispatchers/ssh-backup.js`
- Test: `tests/test-dispatcher-backup.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-backup.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_backup v4 dispatcher (src/dispatchers/ssh-backup.js).
 * Run: node tests/test-dispatcher-backup.js
 */
import assert from 'assert';
import { handleSshBackup } from '../src/dispatchers/ssh-backup.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_backup dispatcher\n');

await test('create routes to handlers.create, maps backup_type', async () => {
  const create = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { create },
    args: { server: 's', action: 'create', backup_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(create.calls.length, 1);
  assert.strictEqual(create.calls[0].args.backup_type, 'mysql');
  assert.strictEqual(create.calls[0].getConnection, DEPS.getConnection);
});

await test('list routes to handlers.list', async () => {
  const list = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { list },
    args: { server: 's', action: 'list', backup_type: 'files' },
  });
  assert.strictEqual(list.calls.length, 1);
});

await test('restore routes to handlers.restore with backup_id + preview', async () => {
  const restore = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { restore },
    args: { server: 's', action: 'restore', backup_id: 'bk-1', preview: true },
  });
  assert.strictEqual(restore.calls.length, 1);
  assert.strictEqual(restore.calls[0].args.backup_id, 'bk-1');
  assert.strictEqual(restore.calls[0].args.preview, true);
});

await test('schedule routes to handlers.schedule with cron', async () => {
  const schedule = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { schedule },
    args: { server: 's', action: 'schedule', cron: '0 3 * * *', backup_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(schedule.calls.length, 1);
  assert.strictEqual(schedule.calls[0].args.cron, '0 3 * * *');
});

await test('restore missing backup_id -> structured fail, handler not called', async () => {
  const restore = spy();
  const r = await handleSshBackup({
    deps: DEPS, handlers: { restore },
    args: { server: 's', action: 'restore' },
  });
  assert.strictEqual(restore.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('backup_id'));
});

await test('schedule missing cron -> structured fail', async () => {
  const r = await handleSshBackup({
    deps: DEPS, handlers: { schedule: spy() },
    args: { server: 's', action: 'schedule' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('cron'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshBackup({ deps: DEPS, handlers: {}, args: { server: 's', action: 'purge' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('purge'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-backup.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-backup.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-backup.js`:

```javascript
/**
 * ssh_backup -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_backup_create / ssh_backup_list / ssh_backup_restore /
 * ssh_backup_schedule. All conn ctx kind.
 *
 * handlers (injected): { create, list, restore, schedule }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  create: ['server'],
  list: ['server'],
  restore: ['server', 'backup_id'],
  schedule: ['server', 'cron'],
};

export async function handleSshBackup({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_backup', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_backup', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_backup', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'create':
      return handlers.create(makeCtx('conn', deps, {
        server: a.server, backup_type: a.backup_type, name: a.name,
        database: a.database, paths: a.paths, exclude: a.exclude,
        backup_dir: a.backup_dir, gzip: a.gzip, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'list':
      return handlers.list(makeCtx('conn', deps, {
        server: a.server, backup_type: a.backup_type, backup_dir: a.backup_dir,
        format: a.format,
      }));

    case 'restore':
      return handlers.restore(makeCtx('conn', deps, {
        server: a.server, backup_id: a.backup_id, database: a.database,
        target_path: a.target_path, backup_dir: a.backup_dir, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'schedule':
    default:
      return handlers.schedule(makeCtx('conn', deps, {
        server: a.server, cron: a.cron, backup_type: a.backup_type,
        name: a.name, database: a.database, paths: a.paths,
        retention: a.retention, preview: a.preview, format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-backup.js`
Expected: PASS — `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-backup.js tests/test-dispatcher-backup.js
git commit -m "feat: add ssh_backup v4 dispatcher"
```

---

## Task 6: `ssh_session` dispatcher

`ssh_session` collapses `ssh_session_start`, `ssh_session_send`, `ssh_session_list`, `ssh_session_close`, `ssh_session_replay`, `ssh_session_memory`. Six actions. `start` uses the `conn` ctx kind; the other five use `args` only.

**Files:**
- Create: `src/dispatchers/ssh-session.js`
- Test: `tests/test-dispatcher-session.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-session.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_session v4 dispatcher (src/dispatchers/ssh-session.js).
 * Run: node tests/test-dispatcher-session.js
 */
import assert from 'assert';
import { handleSshSession } from '../src/dispatchers/ssh-session.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_session dispatcher\n');

await test('start routes to handlers.start with { getConnection, args }', async () => {
  const start = spy();
  await handleSshSession({
    deps: DEPS, handlers: { start },
    args: { server: 's', action: 'start' },
  });
  assert.strictEqual(start.calls.length, 1);
  assert.strictEqual(start.calls[0].getConnection, DEPS.getConnection);
  assert.strictEqual(start.calls[0].args.server, 's');
});

await test('send routes to handlers.send with { args } only', async () => {
  const send = spy();
  await handleSshSession({
    deps: DEPS, handlers: { send },
    args: { action: 'send', session_id: 'sess-1', command: 'ls' },
  });
  assert.strictEqual(send.calls.length, 1);
  assert.deepStrictEqual(Object.keys(send.calls[0]), ['args']);
  assert.strictEqual(send.calls[0].args.session_id, 'sess-1');
  assert.strictEqual(send.calls[0].args.command, 'ls');
});

await test('list routes to handlers.list with { args } only', async () => {
  const list = spy();
  await handleSshSession({
    deps: DEPS, handlers: { list },
    args: { action: 'list' },
  });
  assert.strictEqual(list.calls.length, 1);
  assert.deepStrictEqual(Object.keys(list.calls[0]), ['args']);
});

await test('close routes to handlers.close', async () => {
  const close = spy();
  await handleSshSession({
    deps: DEPS, handlers: { close },
    args: { action: 'close', session_id: 'sess-1' },
  });
  assert.strictEqual(close.calls.length, 1);
  assert.strictEqual(close.calls[0].args.session_id, 'sess-1');
});

await test('replay routes to handlers.replay with limit', async () => {
  const replay = spy();
  await handleSshSession({
    deps: DEPS, handlers: { replay },
    args: { action: 'replay', session_id: 'sess-1', limit: 5 },
  });
  assert.strictEqual(replay.calls.length, 1);
  assert.strictEqual(replay.calls[0].args.limit, 5);
});

await test('memory routes to handlers.memory', async () => {
  const memory = spy();
  await handleSshSession({
    deps: DEPS, handlers: { memory },
    args: { action: 'memory', session_id: 'sess-1' },
  });
  assert.strictEqual(memory.calls.length, 1);
});

await test('start missing server -> structured fail, handler not called', async () => {
  const start = spy();
  const r = await handleSshSession({
    deps: DEPS, handlers: { start },
    args: { action: 'start' },
  });
  assert.strictEqual(start.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

await test('send missing command -> structured fail', async () => {
  const r = await handleSshSession({
    deps: DEPS, handlers: { send: spy() },
    args: { action: 'send', session_id: 'sess-1' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('command'));
});

await test('close missing session_id -> structured fail', async () => {
  const r = await handleSshSession({
    deps: DEPS, handlers: { close: spy() },
    args: { action: 'close' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('session_id'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshSession({ deps: DEPS, handlers: {}, args: { action: 'detach' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('detach'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-session.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-session.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-session.js`:

```javascript
/**
 * ssh_session -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_session_start / _send / _list / _close / _replay / _memory.
 * start uses the conn ctx kind; the other five take { args } only.
 *
 * handlers (injected): { start, send, list, close, replay, memory }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  start: ['server'],
  send: ['session_id', 'command'],
  list: [],
  close: ['session_id'],
  replay: ['session_id'],
  memory: ['session_id'],
};

export async function handleSshSession({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_session', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_session', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_session', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'start':
      return handlers.start(makeCtx('conn', deps, {
        server: a.server, format: a.format,
      }));

    case 'send':
      return handlers.send(makeCtx('args', deps, {
        session_id: a.session_id, command: a.command,
        timeout: a.timeout, format: a.format,
      }));

    case 'list':
      return handlers.list(makeCtx('args', deps, { format: a.format }));

    case 'close':
      return handlers.close(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));

    case 'replay':
      return handlers.replay(makeCtx('args', deps, {
        session_id: a.session_id, limit: a.limit, format: a.format,
      }));

    case 'memory':
    default:
      return handlers.memory(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-session.js`
Expected: PASS — `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-session.js tests/test-dispatcher-session.js
git commit -m "feat: add ssh_session v4 dispatcher"
```

---

## Task 7: `ssh_net` dispatcher

`ssh_net` collapses `ssh_tunnel_create`, `ssh_tunnel_list`, `ssh_tunnel_close`, `ssh_port_test`. Four actions: `tunnel-open`, `tunnel-list`, `tunnel-close`, `port-test`. `tunnel-open` and `port-test` use the `conn` ctx kind; `tunnel-list` and `tunnel-close` use `args` only. All four handlers declare `ctx = {}` then destructure, so `makeCtx(...)` is passed as the single argument.

**Files:**
- Create: `src/dispatchers/ssh-net.js`
- Test: `tests/test-dispatcher-net.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-net.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_net v4 dispatcher (src/dispatchers/ssh-net.js).
 * Run: node tests/test-dispatcher-net.js
 */
import assert from 'assert';
import { handleSshNet } from '../src/dispatchers/ssh-net.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_net dispatcher\n');

await test('tunnel-open routes to handlers.tunnelCreate with { getConnection, args }', async () => {
  const tunnelCreate = spy();
  await handleSshNet({
    deps: DEPS, handlers: { tunnelCreate },
    args: { server: 's', action: 'tunnel-open', tunnel_type: 'local', local_port: 8080, remote_host: 'db', remote_port: 5432 },
  });
  assert.strictEqual(tunnelCreate.calls.length, 1);
  assert.strictEqual(tunnelCreate.calls[0].getConnection, DEPS.getConnection);
  assert.strictEqual(tunnelCreate.calls[0].args.type, 'local');
  assert.strictEqual(tunnelCreate.calls[0].args.local_port, 8080);
});

await test('tunnel-list routes to handlers.tunnelList with { args } only', async () => {
  const tunnelList = spy();
  await handleSshNet({
    deps: DEPS, handlers: { tunnelList },
    args: { action: 'tunnel-list', server: 's' },
  });
  assert.strictEqual(tunnelList.calls.length, 1);
  assert.deepStrictEqual(Object.keys(tunnelList.calls[0]), ['args']);
});

await test('tunnel-close routes to handlers.tunnelClose, maps tunnel_id', async () => {
  const tunnelClose = spy();
  await handleSshNet({
    deps: DEPS, handlers: { tunnelClose },
    args: { action: 'tunnel-close', tunnel_id: 'tun-1' },
  });
  assert.strictEqual(tunnelClose.calls.length, 1);
  assert.strictEqual(tunnelClose.calls[0].args.tunnel_id, 'tun-1');
});

await test('port-test routes to handlers.portTest with { getConnection, args }', async () => {
  const portTest = spy();
  await handleSshNet({
    deps: DEPS, handlers: { portTest },
    args: { server: 's', action: 'port-test', target_host: 'db', target_port: 5432 },
  });
  assert.strictEqual(portTest.calls.length, 1);
  assert.strictEqual(portTest.calls[0].getConnection, DEPS.getConnection);
  assert.strictEqual(portTest.calls[0].args.target_host, 'db');
});

await test('tunnel-open missing tunnel_type -> structured fail, handler not called', async () => {
  const tunnelCreate = spy();
  const r = await handleSshNet({
    deps: DEPS, handlers: { tunnelCreate },
    args: { server: 's', action: 'tunnel-open' },
  });
  assert.strictEqual(tunnelCreate.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('tunnel_type'));
});

await test('tunnel-close missing tunnel_id -> structured fail', async () => {
  const r = await handleSshNet({
    deps: DEPS, handlers: { tunnelClose: spy() },
    args: { action: 'tunnel-close' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('tunnel_id'));
});

await test('port-test missing target_host -> structured fail', async () => {
  const r = await handleSshNet({
    deps: DEPS, handlers: { portTest: spy() },
    args: { server: 's', action: 'port-test' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('target_host'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshNet({ deps: DEPS, handlers: {}, args: { action: 'traceroute' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('traceroute'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-net.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-net.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-net.js`:

```javascript
/**
 * ssh_net -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_tunnel_create / _list / _close and ssh_port_test.
 * tunnel-open + port-test use conn ctx; tunnel-list + tunnel-close use args.
 * v4 `tunnel_type` maps to the tunnel handler's `type` arg.
 *
 * handlers (injected): { tunnelCreate, tunnelList, tunnelClose, portTest }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  'tunnel-open': ['server', 'tunnel_type'],
  'tunnel-list': [],
  'tunnel-close': ['tunnel_id'],
  'port-test': ['target_host'],
};

export async function handleSshNet({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_net', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_net', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_net', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'tunnel-open':
      return handlers.tunnelCreate(makeCtx('conn', deps, {
        server: a.server,
        type: a.tunnel_type,
        local_host: a.local_host,
        local_port: a.local_port,
        remote_host: a.remote_host,
        remote_port: a.remote_port,
        preview: a.preview,
        format: a.format,
      }));

    case 'tunnel-list':
      return handlers.tunnelList(makeCtx('args', deps, {
        server: a.server, format: a.format,
      }));

    case 'tunnel-close':
      return handlers.tunnelClose(makeCtx('args', deps, {
        tunnel_id: a.tunnel_id, server: a.server, format: a.format,
      }));

    case 'port-test':
    default:
      return handlers.portTest(makeCtx('conn', deps, {
        server: a.server,
        target_host: a.target_host,
        target_port: a.target_port,
        probe_chain: a.probe_chain,
        timeout_ms_per_probe: a.timeout_ms_per_probe,
        continue_on_fail: a.continue_on_fail,
        format: a.format,
      }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-net.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-net.js tests/test-dispatcher-net.js
git commit -m "feat: add ssh_net v4 dispatcher"
```

---

## Task 8: `ssh_docker` dispatcher

`ssh_docker` keeps the existing `handleSshDocker` handler first-class. The handler already owns a multi-action enum (`ps`, `images`, `inspect`, `logs`, `start`, `stop`, `restart`, `rm`, `rmi`, `pull`, `exec`). The v4 dispatcher is a thin pass-through: it validates per-action required args, then forwards to `handleSshDocker` with the v4 `action` mapped straight onto the handler's `action`. v4 advertises `ps, logs, exec, restart, inspect, compose`; `compose` is rejected at the dispatcher with a clear message (the existing handler has no compose path — adding one is out of scope for the facade).

**Files:**
- Create: `src/dispatchers/ssh-docker.js`
- Test: `tests/test-dispatcher-docker.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-docker.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_docker v4 dispatcher (src/dispatchers/ssh-docker.js).
 * Run: node tests/test-dispatcher-docker.js
 */
import assert from 'assert';
import { handleSshDockerTool } from '../src/dispatchers/ssh-docker.js';

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

const DEPS = { getConnection: () => 'CONN' };

console.log('[test] Testing ssh_docker dispatcher\n');

await test('ps routes to handlers.docker with action=ps', async () => {
  const docker = spy();
  await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'ps' },
  });
  assert.strictEqual(docker.calls.length, 1);
  assert.strictEqual(docker.calls[0].args.action, 'ps');
  assert.strictEqual(docker.calls[0].getConnection, DEPS.getConnection);
});

await test('logs routes to handlers.docker, forwards container + tail_lines', async () => {
  const docker = spy();
  await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'logs', container: 'web', tail_lines: 50 },
  });
  assert.strictEqual(docker.calls[0].args.action, 'logs');
  assert.strictEqual(docker.calls[0].args.container, 'web');
  assert.strictEqual(docker.calls[0].args.tail_lines, 50);
});

await test('exec routes to handlers.docker, forwards command', async () => {
  const docker = spy();
  await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'exec', container: 'web', command: 'ls' },
  });
  assert.strictEqual(docker.calls[0].args.action, 'exec');
  assert.strictEqual(docker.calls[0].args.command, 'ls');
});

await test('restart routes to handlers.docker, forwards preview', async () => {
  const docker = spy();
  await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'restart', container: 'web', preview: true },
  });
  assert.strictEqual(docker.calls[0].args.action, 'restart');
  assert.strictEqual(docker.calls[0].args.preview, true);
});

await test('inspect routes to handlers.docker', async () => {
  const docker = spy();
  await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'inspect', container: 'web' },
  });
  assert.strictEqual(docker.calls[0].args.action, 'inspect');
});

await test('logs missing container -> structured fail, handler not called', async () => {
  const docker = spy();
  const r = await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'logs' },
  });
  assert.strictEqual(docker.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('container'));
});

await test('exec missing command -> structured fail', async () => {
  const r = await handleSshDockerTool({
    deps: DEPS, handlers: { docker: spy() },
    args: { server: 's', action: 'exec', container: 'web' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('command'));
});

await test('compose is rejected with a clear message', async () => {
  const docker = spy();
  const r = await handleSshDockerTool({
    deps: DEPS, handlers: { docker },
    args: { server: 's', action: 'compose' },
  });
  assert.strictEqual(docker.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.toLowerCase().includes('compose'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshDockerTool({ deps: DEPS, handlers: {}, args: { server: 's', action: 'swarm' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('swarm'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-docker.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-docker.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-docker.js`:

```javascript
/**
 * ssh_docker -- v4 fat verb-tool dispatcher.
 *
 * Thin pass-through over handleSshDocker, which already owns its own action
 * enum. v4 advertises ps/logs/exec/restart/inspect/compose. compose has no
 * handler path and is rejected here; the other five forward straight through.
 *
 * handlers (injected): { docker }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  ps: ['server'],
  logs: ['server', 'container'],
  exec: ['server', 'container', 'command'],
  restart: ['server', 'container'],
  inspect: ['server', 'container'],
};

export async function handleSshDockerTool({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_docker', 'action is required', { server: a.server ?? null }));
  }
  if (action === 'compose') {
    return toMcp(fail('ssh_docker',
      'action "compose" is not supported -- use ssh_run to invoke docker compose directly',
      { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_docker', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_docker', action, a, REQUIRED);
  if (bad) return bad;

  return handlers.docker(makeCtx('conn', deps, {
    server: a.server,
    action,
    container: a.container,
    image: a.image,
    command: a.command,
    tail_lines: a.tail_lines,
    preview: a.preview,
    format: a.format,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-docker.js`
Expected: PASS — `9 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-docker.js tests/test-dispatcher-docker.js
git commit -m "feat: add ssh_docker v4 dispatcher"
```

---

## Task 9: `ssh_fleet` dispatcher

`ssh_fleet` collapses the genuine fleet/config-metadata tools: `ssh_list_servers`, `ssh_group_manage`, `ssh_alias`, `ssh_command_alias`, `ssh_profile`, `ssh_hooks`, `ssh_key_manage`, `ssh_connection_status`, `ssh_history`. Eight actions: `servers`, `groups`, `aliases`, `profiles`, `hooks`, `keys`, `history`, `connections`.

Most of those tools' handler bodies live **inline in `index.js`**, not in `src/tools/*.js`: only `ssh_key_manage` is a modular handler (`handleSshKeyManage`). The facade cannot re-facade inline closures. So `ssh_fleet`'s dispatcher takes a `handlers` object whose entries are **adapter functions supplied at registration time** (Part 3 builds them by lifting the inline `index.js` logic into named functions). This task builds the dispatcher and its routing contract; Part 3 supplies the real adapters. `keys` is the one action wired to a modular handler — its adapter is `handleSshKeyManage` via the `cfg` ctx kind.

**Files:**
- Create: `src/dispatchers/ssh-fleet.js`
- Test: `tests/test-dispatcher-fleet.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-fleet.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_fleet v4 dispatcher (src/dispatchers/ssh-fleet.js).
 * Every action routes to a named handler in the injected handlers object.
 * Run: node tests/test-dispatcher-fleet.js
 */
import assert from 'assert';
import { handleSshFleet } from '../src/dispatchers/ssh-fleet.js';

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
  const fn = async (arg) => { calls.push(arg); return ret; };
  fn.calls = calls;
  return fn;
}

const DEPS = { getServerConfig: () => ({ host: 'h', port: '22' }) };

console.log('[test] Testing ssh_fleet dispatcher\n');

await test('servers routes to handlers.servers', async () => {
  const servers = spy();
  await handleSshFleet({ deps: DEPS, handlers: { servers }, args: { action: 'servers' } });
  assert.strictEqual(servers.calls.length, 1);
});

await test('groups routes to handlers.groups, forwards op + name + members', async () => {
  const groups = spy();
  await handleSshFleet({
    deps: DEPS, handlers: { groups },
    args: { action: 'groups', op: 'create', name: 'web', members: ['a', 'b'] },
  });
  assert.strictEqual(groups.calls.length, 1);
  assert.strictEqual(groups.calls[0].args.op, 'create');
  assert.strictEqual(groups.calls[0].args.name, 'web');
  assert.deepStrictEqual(groups.calls[0].args.members, ['a', 'b']);
});

await test('aliases routes to handlers.aliases', async () => {
  const aliases = spy();
  await handleSshFleet({
    deps: DEPS, handlers: { aliases },
    args: { action: 'aliases', op: 'add', name: 'p1', target: 'prod01' },
  });
  assert.strictEqual(aliases.calls.length, 1);
  assert.strictEqual(aliases.calls[0].args.op, 'add');
});

await test('profiles routes to handlers.profiles', async () => {
  const profiles = spy();
  await handleSshFleet({ deps: DEPS, handlers: { profiles }, args: { action: 'profiles', op: 'list' } });
  assert.strictEqual(profiles.calls.length, 1);
});

await test('hooks routes to handlers.hooks', async () => {
  const hooks = spy();
  await handleSshFleet({ deps: DEPS, handlers: { hooks }, args: { action: 'hooks', op: 'list' } });
  assert.strictEqual(hooks.calls.length, 1);
});

await test('history routes to handlers.history, forwards limit', async () => {
  const history = spy();
  await handleSshFleet({ deps: DEPS, handlers: { history }, args: { action: 'history', limit: 5 } });
  assert.strictEqual(history.calls.length, 1);
  assert.strictEqual(history.calls[0].args.limit, 5);
});

await test('connections routes to handlers.connections', async () => {
  const connections = spy();
  await handleSshFleet({ deps: DEPS, handlers: { connections }, args: { action: 'connections', op: 'status' } });
  assert.strictEqual(connections.calls.length, 1);
});

await test('keys routes to handlers.keys with { getServerConfig, args }', async () => {
  const keys = spy();
  await handleSshFleet({
    deps: DEPS, handlers: { keys },
    args: { action: 'keys', op: 'list', server: 's' },
  });
  assert.strictEqual(keys.calls.length, 1);
  assert.strictEqual(keys.calls[0].getServerConfig, DEPS.getServerConfig);
  // keys handler reads `action`, not `op` -- dispatcher maps op -> action
  assert.strictEqual(keys.calls[0].args.action, 'list');
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshFleet({ deps: DEPS, handlers: {}, args: { action: 'nuke' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('nuke'));
});

await test('missing action -> structured fail', async () => {
  const r = await handleSshFleet({ deps: DEPS, handlers: {}, args: {} });
  assert.strictEqual(r.isError, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-fleet.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-fleet.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-fleet.js`:

```javascript
/**
 * ssh_fleet -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_list_servers / ssh_group_manage / ssh_alias /
 * ssh_command_alias / ssh_profile / ssh_hooks / ssh_key_manage /
 * ssh_connection_status / ssh_history -- genuine fleet/config metadata only.
 *
 * Most of these tools' bodies live inline in index.js, not src/tools/*.js, so
 * they cannot be re-faceted. The handlers object is supplied at registration
 * time (Part 3) as adapter functions. `keys` is the lone modular handler
 * (handleSshKeyManage, cfg ctx kind); v4 `op` maps to its `action` arg.
 *
 * handlers (injected): { servers, groups, aliases, profiles, hooks, keys,
 *                        history, connections }. Each is async ({ args } or a
 *                        full ctx object) -> MCP response.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';

const ACTIONS = new Set([
  'servers', 'groups', 'aliases', 'profiles',
  'hooks', 'keys', 'history', 'connections',
]);

export async function handleSshFleet({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_fleet', 'action is required', { server: a.server ?? null }));
  }
  if (!ACTIONS.has(action)) {
    return toMcp(fail('ssh_fleet', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  if (action === 'keys') {
    // handleSshKeyManage destructures `ctx` with getServerConfig + args.
    return handlers.keys(makeCtx('cfg', deps, {
      action: a.op,
      server: a.server,
      host: a.host,
      port: a.port,
      autoAccept: a.auto_accept,
      format: a.format,
    }));
  }

  // servers / groups / aliases / profiles / hooks / history / connections:
  // adapter functions take a plain { args } object.
  return handlers[action]({
    args: {
      op: a.op,
      name: a.name,
      members: a.members,
      alias: a.alias,
      target: a.target,
      server: a.server,
      limit: a.limit,
      format: a.format,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-fleet.js`
Expected: PASS — `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/dispatchers/ssh-fleet.js tests/test-dispatcher-fleet.js
git commit -m "feat: add ssh_fleet v4 dispatcher"
```

---

## Task 10: `ssh_plan` dispatcher

`ssh_plan` stays a tool but is renamed in the v4 surface. Two v4 actions: `run` (build + execute a multi-step plan) and `approve` (re-run with an `approve_token` to clear the high-risk gate). Both route to the existing `handleSshPlan`, which takes `{ dispatch, args }`.

**Verified contradiction to fix.** `handleSshPlan`'s `invokeStep` looks up `dispatch[step.action]` where `step.action` is the **plan-step action enum** — `tests/test-plan-tools.js` exclusively uses keys `exec`, `exec_sudo`, `upload`, `download`, `edit`, `systemctl`, `backup`, `health_check`. The current `index.js` `ssh_plan` registration builds a `dispatch` table keyed by **tool names** (`ssh_execute`, `ssh_cat`, ...). Those keys never match `step.action`, so every step today fails with `no handler registered for action "exec"`. This is a pre-existing latent bug. The v4 `ssh_plan` dispatcher fixes it: the dispatch table it threads through is keyed by the plan-step enum that `plan-tools.js` actually reads.

The dispatch table's handler values must accept `{ args }` — `invokeStep` calls `handler({ args: stepToHandlerArgs(...) })`. So each entry is a closure that wraps a `src/tools/*.js` handler with the right ctx. Part 3 supplies the real `getConnection`/`getServerConfig`; this task's tests inject fakes and assert the table is keyed correctly.

**Files:**
- Create: `src/dispatchers/ssh-plan.js`
- Test: `tests/test-dispatcher-plan.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-dispatcher-plan.js`:

```javascript
#!/usr/bin/env node
/**
 * Routing suite for the ssh_plan v4 dispatcher (src/dispatchers/ssh-plan.js).
 * Confirms the dispatch table threaded into handleSshPlan is keyed by the
 * plan-step action enum, and that run/approve map onto plan modes.
 * Run: node tests/test-dispatcher-plan.js
 */
import assert from 'assert';
import { handleSshPlanTool, buildPlanDispatch } from '../src/dispatchers/ssh-plan.js';

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

const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => ({}),
  resolveGroup: () => null,
};

console.log('[test] Testing ssh_plan dispatcher\n');

// --- buildPlanDispatch ---------------------------------------------------
await test('buildPlanDispatch is keyed by the plan-step action enum', () => {
  const d = buildPlanDispatch(DEPS, {
    execute: async () => ({}), executeSudo: async () => ({}),
    upload: async () => ({}), download: async () => ({}),
    edit: async () => ({}), systemctl: async () => ({}),
    backupCreate: async () => ({}), healthCheck: async () => ({}),
  });
  // plan-tools invokeStep reads dispatch[step.action]; step.action uses these:
  for (const key of ['exec', 'exec_sudo', 'upload', 'download', 'edit',
    'systemctl', 'backup', 'health_check']) {
    assert.strictEqual(typeof d[key], 'function', `dispatch has "${key}"`);
  }
  assert.strictEqual(d.ssh_execute, undefined,
    'dispatch is NOT keyed by tool names');
});

await test('dispatch "exec" entry wraps the execute handler with { getConnection, args }', async () => {
  let seenCtx = null;
  const execute = async (ctx) => { seenCtx = ctx; return { content: [], isError: false }; };
  const d = buildPlanDispatch(DEPS, { execute });
  await d.exec({ args: { server: 's', command: 'ls' } });
  assert.strictEqual(seenCtx.getConnection, DEPS.getConnection);
  assert.strictEqual(seenCtx.args.command, 'ls');
});

await test('dispatch "exec_sudo" entry passes getServerConfig through', async () => {
  let seenCtx = null;
  const executeSudo = async (ctx) => { seenCtx = ctx; return { content: [], isError: false }; };
  const d = buildPlanDispatch(DEPS, { executeSudo });
  await d.exec_sudo({ args: { server: 's', command: 'id' } });
  assert.strictEqual(seenCtx.getServerConfig, DEPS.getServerConfig);
});

// --- handleSshPlanTool ---------------------------------------------------
function fakePlan() {
  // stand-in for handleSshPlan: echoes the args it received.
  return async ({ dispatch, args }) => ({
    content: [{ type: 'text', text: JSON.stringify({ mode: args.mode, hasToken: !!args.approve_token, dispatchKeys: Object.keys(dispatch) }) }],
    isError: false,
  });
}

await test('run action invokes plan with mode "run"', async () => {
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: {}, planFn: fakePlan(),
    args: { action: 'run', steps: [{ action: 'exec', command: 'ls' }] },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.mode, 'run');
});

await test('approve action invokes plan with mode "run" and forwards approve_token', async () => {
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: {}, planFn: fakePlan(),
    args: { action: 'approve', approve_token: 'yes', steps: [{ action: 'exec', command: 'ls' }] },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.mode, 'run');
  assert.strictEqual(body.hasToken, true);
});

await test('run action threads a step-enum-keyed dispatch into the plan', async () => {
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: { execute: async () => ({}) }, planFn: fakePlan(),
    args: { action: 'run', steps: [] },
  });
  const body = JSON.parse(r.content[0].text);
  assert(body.dispatchKeys.includes('exec'), 'dispatch keyed by step enum');
  assert(!body.dispatchKeys.includes('ssh_execute'), 'not keyed by tool name');
});

await test('run missing steps -> structured fail, plan not invoked', async () => {
  let planCalled = false;
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: {},
    planFn: async () => { planCalled = true; return {}; },
    args: { action: 'run' },
  });
  assert.strictEqual(planCalled, false);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('steps'));
});

await test('approve missing approve_token -> structured fail', async () => {
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: {}, planFn: fakePlan(),
    args: { action: 'approve', steps: [{ action: 'exec', command: 'ls' }] },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('approve_token'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshPlanTool({
    deps: DEPS, handlers: {}, planFn: fakePlan(),
    args: { action: 'simulate', steps: [] },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('simulate'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-dispatcher-plan.js`
Expected: FAIL — `Cannot find module '../src/dispatchers/ssh-plan.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatchers/ssh-plan.js`:

```javascript
/**
 * ssh_plan -- v4 verb-tool dispatcher.
 *
 * ssh_plan stays its own tool (a meta-orchestrator). Two v4 actions:
 *   run     -> handleSshPlan, mode 'run'
 *   approve -> handleSshPlan, mode 'run', with approve_token forwarded
 *
 * buildPlanDispatch produces the `dispatch` map handleSshPlan threads to
 * invokeStep. invokeStep reads dispatch[step.action] where step.action is the
 * PLAN-STEP action enum (exec, exec_sudo, upload, ...). The pre-v4 index.js
 * keyed this table by tool names, which never matched -- v4 keys it by the
 * step enum so steps actually dispatch.
 *
 * Each dispatch entry is a closure taking { args } (invokeStep's call shape)
 * and wrapping a src/tools/*.js handler with the right context object.
 *
 * handlers (injected): subset of { execute, executeSudo, upload, download,
 *   edit, systemctl, backupCreate, healthCheck }.
 */

import { fail, toMcp } from '../structured-result.js';

/**
 * Build the plan-step-keyed dispatch table. Keys are the action strings
 * plan-tools.js reads from each step; values take { args } and return an
 * MCP response.
 */
export function buildPlanDispatch(deps, handlers) {
  const h = handlers || {};
  const d = {};
  if (h.execute) {
    d.exec = ({ args }) => h.execute({ getConnection: deps.getConnection, args });
  }
  if (h.executeSudo) {
    d.exec_sudo = ({ args }) => h.executeSudo({
      getConnection: deps.getConnection, getServerConfig: deps.getServerConfig, args,
    });
  }
  if (h.upload) {
    d.upload = ({ args }) => h.upload({ getConnection: deps.getConnection, args });
  }
  if (h.download) {
    d.download = ({ args }) => h.download({ getConnection: deps.getConnection, args });
  }
  if (h.edit) {
    d.edit = ({ args }) => h.edit({ getConnection: deps.getConnection, args });
  }
  if (h.systemctl) {
    d.systemctl = ({ args }) => h.systemctl({ getConnection: deps.getConnection, args });
  }
  if (h.backupCreate) {
    d.backup = ({ args }) => h.backupCreate({ getConnection: deps.getConnection, args });
  }
  if (h.healthCheck) {
    d.health_check = ({ args }) => h.healthCheck({ getConnection: deps.getConnection, args });
  }
  return d;
}

export async function handleSshPlanTool({ deps, handlers, planFn, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (action !== 'run' && action !== 'approve') {
    return toMcp(fail('ssh_plan', `unknown action "${action}"`, { server: null }));
  }
  if (a.steps === undefined || a.steps === null) {
    return toMcp(fail('ssh_plan', 'action requires: steps', { server: null }));
  }
  if (action === 'approve' && !a.approve_token) {
    return toMcp(fail('ssh_plan', 'action "approve" requires: approve_token', { server: null }));
  }

  const dispatch = buildPlanDispatch(deps, handlers);
  return planFn({
    dispatch,
    args: {
      plan: a.steps,
      mode: 'run',
      server: a.server,
      approve_token: a.approve_token,
      rollback_on_fail: a.rollback_on_fail,
      format: a.format,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-dispatcher-plan.js`
Expected: PASS — `10 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: green. This part adds ten dispatcher modules and ten test suites:
`logs` 8, `service` 7, `health` 9, `db` 8, `backup` 7, `session` 10, `net` 8, `docker` 9, `fleet` 10, `plan` 10 — 86 new tests. Added to the Part 1 end total. Re-count from the actual `npm test` output; the exact number is whatever it prints. Because nothing here touches `index.js` or any existing module, every pre-existing suite must still pass unchanged.

> If the printed total does not match expectation, do not edit a test to hit a number — verify each new suite printed its expected pass count and that no pre-existing suite regressed, then record the real total.

- [ ] **Step 6: Commit**

```bash
git add src/dispatchers/ssh-plan.js tests/test-dispatcher-plan.js
git commit -m "feat: add ssh_plan v4 dispatcher with step-enum-keyed dispatch"
```

---

## Done criteria

- `src/dispatchers/` contains all twelve v4 dispatcher modules (`ssh-run.js`, `ssh-file.js` from Part 1; `ssh-logs.js`, `ssh-service.js`, `ssh-health.js`, `ssh-db.js`, `ssh-backup.js`, `ssh-session.js`, `ssh-net.js`, `ssh-docker.js`, `ssh-fleet.js`, `ssh-plan.js` from Part 2).
- Every dispatcher validates per-action required args and returns a structured `fail()` MCP response on a miss without invoking the handler.
- `ssh_plan`'s `buildPlanDispatch` is keyed by the plan-step action enum, fixing the pre-existing tool-name-keyed mismatch.
- `npm test` is green: every new dispatcher suite passes and zero pre-existing suites regress.
- `src/index.js`, `src/tool-registry.js`, `src/tool-annotations.js` are untouched — the cutover is Part 3.
- No handler in `src/tools/*.js` was modified.

Part 3 wires all twelve dispatchers into `src/index.js` via `registerToolConditional`, rewrites `src/tool-registry.js` and `src/tool-annotations.js` for the 12-tool surface, lifts the inline `ssh_fleet` handler bodies out of `index.js` into named adapter functions, and rewrites the four coupled test suites (`test-index-registration.js`, `test-tool-registry.js`, `test-tool-annotations.js`, `test-tool-config-manager.js`).

---

## Self-review

Performed after drafting, before marking the plan ready.

**Spec coverage (section 3).**
- The action→handler table in spec section 3 was walked tool by tool: `ssh_logs` (5 actions, all mapped), `ssh_service` (status→serviceStatus, the rest→systemctl), `ssh_health` (4 actions to 4 handlers), `ssh_db` (4→4), `ssh_backup` (4→4), `ssh_session` (6→6), `ssh_net` (4→4), `ssh_docker` (pass-through, `compose` rejected), `ssh_fleet` (8 actions; 7 inline-adapter, `keys`→`handleSshKeyManage`), `ssh_plan` (run/approve→`handleSshPlan`). Together with Part 1's `ssh_run`+`ssh_file`, all twelve in-scope tools have dispatchers. `ssh_find` (13th) is Plan 5 — correctly excluded.
- "ssh_plan's steps dispatch table is rewritten to the v4 verb+action namespace" — Task 10. Investigation found the existing `index.js` table is keyed by tool names but `plan-tools.js` `invokeStep` reads `dispatch[step.action]` with the short step enum; `test-plan-tools.js` confirms (`{action:'exec'}`, `{action:'upload'}`, ...). `buildPlanDispatch` is therefore keyed by the step enum, and a test asserts `d.ssh_execute === undefined`. This is flagged in the plan as a pre-existing latent-bug fix.
- "every action-scoped arg optional; dispatcher checks per-action required-arg map; structured fail() names missing args" — every dispatcher has a `REQUIRED` map and calls `requireArgs`; `ssh_fleet` and `ssh_plan` validate inline because their required sets are action-shaped differently (op-based / steps-based). Each has unknown-action and missing-arg tests.
- "ssh_docker keeps its existing multi-action surface first-class" — `ssh-docker.js` is a pass-through to `handleSshDocker`; it does not re-implement Docker's enum. `compose` has no handler path, so it is rejected with an explicit message rather than silently routed.
- "ssh_fleet keeps only genuine fleet/config-metadata; ssh_net and ssh_docker are separate tools" — `ssh_fleet` actions are exactly the nine config/metadata tools; tunnels and docker are their own dispatchers.
- "camelCase aliases dropped; snake_case only" — dispatchers read snake_case v4 args (`tunnel_type`, `proc_action`, `cpu_threshold`, `auto_accept`, `backup_type`, `since_offset`). The handler-arg names the dispatchers *target* (`type`, `action`, `cpuThreshold`, `autoAccept`, `unit`, `timeout`) are the existing handlers' internal arg contracts, verified by reading each handler's destructure block and the `index.js` registration that calls it today.

**Placeholder scan.** Searched the draft for "TBD", "similar to", "add validation", "etc.", "...". The only `...` occurrences are JS spread syntax (`...creds(a)`) in code blocks; no prose placeholder. Every code step is complete and copy-pasteable.

**Type consistency.**
- Every dispatcher returns either a handler's MCP `{ content, isError? }` object or `toMcp(fail(...))` (same shape). Consistent.
- `makeCtx` kinds used: `conn`, `conn-cfg` (none here — `ssh_service`/`ssh_db`/`ssh_backup` use `conn`), `cfg` (`ssh_fleet` keys action), `args` (tail read/stop, session send/list/close/replay/memory, tunnel list/close). Every handler destructures only keys the chosen kind supplies — verified against the cheat-sheet table built from the handler export signatures.
- `handleSshSessionStart` reads an optional `_openShellStream`; `makeCtx('conn', ...)` omits it; the handler opens its own shell when absent — verified by reading `session-tools.js` line 478+.
- `ssh_fleet` adapters: the dispatcher calls `handlers[action]({ args: {...} })` for the seven inline actions and `handlers.keys(makeCtx('cfg', ...))` for `keys`. The test injects spies; Part 3 supplies real adapters lifted from `index.js`. The contract (an async fn taking either `{args}` or a ctx object, returning an MCP response) is stated in the module docstring.
- `ssh_plan`: `buildPlanDispatch` entries are `({ args }) => handler(ctxObject)` — matching `invokeStep`'s `handler({ args: ... })` call shape (verified at `plan-tools.js` line 318). `handleSshPlanTool` takes an injectable `planFn` so the test can substitute a fake; Part 3 passes the real `handleSshPlan`.
- Test runner contract: each suite prints `N passed, M failed` and `process.exit(1)` on failure — Pattern A of `scripts/run-tests.mjs`. `async test()` + top-level `await test(...)` valid in ESM.

**Issues found and fixed inline.**
1. First draft of `ssh-service.js` routed `status` through `handleSshSystemctl action:status`. `handleSshSystemctl`'s `status` path needs a `unit`, and its output is the generic systemctl card, not the typed snapshot `handleSshServiceStatus` produces. Fixed: `status` routes to `handleSshServiceStatus` (typed `ActiveState`/`SubState` snapshot); only the mutating verbs go to `systemctl`.
2. First draft of `ssh-fleet.js` tried to route every action through a modular handler. Reading `index.js` showed seven of the nine fleet tools (`ssh_list_servers`, `ssh_group_manage`, `ssh_alias`, `ssh_command_alias`, `ssh_profile`, `ssh_hooks`, `ssh_connection_status`, `ssh_history`) have **inline closure bodies in `index.js`**, not modular handlers — only `ssh_key_manage` is modular. A facade cannot re-facade inline closures. Fixed: `ssh_fleet`'s `handlers` object is documented as registration-time adapter functions (Part 3 lifts the inline logic into named functions); `keys` alone wires to `handleSshKeyManage`. This is called out explicitly in the Task 9 preamble so Part 3 knows it must do the lift.
3. `ssh_plan` `approve` originally mapped to a distinct plan mode. `plan-tools.js` has only `preview`/`dry_run`/`run` and gates high-risk steps inside `run` by `approve_token` presence. Fixed: both `run` and `approve` use mode `run`; `approve` simply forwards a non-empty `approve_token`, matching the spec's "inspect preview, re-invoke with any non-empty approve_token" two-call pattern.
