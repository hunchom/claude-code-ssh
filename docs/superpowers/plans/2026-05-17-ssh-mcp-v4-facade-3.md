# ssh-mcp v4 Dispatcher Facade Part 3 — Registration Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the live MCP surface over from 51 tools to 12. Rewrite `src/tool-registry.js` and `src/tool-annotations.js` for the 12-tool namespace, lift the inline `ssh_fleet`-family handler bodies out of `src/index.js` into a named-adapter module, replace all 51 `registerToolConditional` blocks in `src/index.js` with 12, and rewrite the four registration-coupled test suites.

**Architecture:** This is the breaking change. Parts 1-2 added twelve dispatcher modules under `src/dispatchers/` without touching `index.js` — they were dormant. This part wires them in. `src/tool-registry.js` is rewritten (groups, counts, descriptions for 12 tools); `src/tool-annotations.js` is rewritten (one entry per fat tool); a new `src/fleet-adapters.js` holds the seven inline `ssh_fleet` action bodies lifted verbatim from `index.js` closures; `src/index.js` loses ~1700 lines of registration and gains 12 fat-tool registrations with full zod `inputSchema`s. The four coupled suites — `test-index-registration.js`, `test-tool-registry.js`, `test-tool-annotations.js`, `test-tool-config-manager.js` — are rewritten in the same task that changes their target. The ~640 handler-level tests are untouched: they call the unchanged `src/tools/*.js` handlers directly.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`, zod v4, `@modelcontextprotocol/sdk`.

This is Plan 4 of 6, Part 3 of 3 — the final part of the dispatcher facade. Parts 1-2 (framework + all twelve dispatcher modules) are complete. Plan 5: new capabilities (`ssh_find` as the 13th tool, `ssh_run` `script`/`detach`/job actions). Plan 6: adoption (CLAUDE.md rule, Bash PreToolUse hook). Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` sections 3 and 9.

### What this part deliberately defers

- `ssh_find` — the 13th tool — is Plan 5. The 12-tool registry and schema here do **not** include it.
- `ssh_run` actions `script`, `detach`, `job-status`, `job-kill` — Plan 5 extends the `ssh_run` enum and dispatcher. The `ssh_run` schema here advertises only `exec`, `sudo`, `fleet`.
- The `raw` argument is in every tool's schema (the compressor work in Plan 3 already honors it end-to-end for exec output); no new `raw` plumbing is needed here.

---

## File Structure

- **Rewrite `src/tool-registry.js`** — `TOOL_GROUPS`, `TOOL_GROUP_DESCRIPTIONS`, `TOOL_GROUP_COUNTS` for the 12 v4 tools across 3 groups. All exported functions (`getAllTools`, `findToolGroup`, `getGroupTools`, `validateToolRegistry`, `getToolStats`, `verifyIntegrity`) keep their signatures — only the data changes, so `tool-config-manager.js` keeps working untouched.
- **Rewrite `src/tool-annotations.js`** — `TOOL_ANNOTATIONS` keyed by the 12 fat-tool names; `withAnnotations` is unchanged.
- **Create `src/fleet-adapters.js`** — seven async adapter functions (`fleetServers`, `fleetGroups`, `fleetAliases`, `fleetCommandHandled` is folded in, `fleetProfiles`, `fleetHooks`, `fleetHistory`, `fleetConnections`) holding the logic currently inline in `index.js` closures. Each takes `({ args, deps })` and returns an MCP response.
- **Rewrite the registration section of `src/index.js`** — delete all 51 `registerToolConditional(...)` blocks; add 12. Keep everything above the registration section (imports, connection pooling, `getConnection`, `registerToolConditional`, `getServerConfigByName`) and below it (`SIGINT`, `main`) unchanged.
- **Rewrite `tests/test-tool-registry.js`** — assertions for 12 tools / 3 groups.
- **Rewrite `tests/test-tool-annotations.js`** — assertions for the 12 fat-tool annotations.
- **Rewrite `tests/test-index-registration.js`** — registration-drift invariants against the 12-tool registry.
- **Modify `tests/test-tool-config-manager.js`** — the `minimal`-mode and count assertions that hard-code 51/group names.

### v4 tool → group map

Three groups, twelve tools. Groups exist only for `tool-config-manager.js` enable/disable; v4's premise is all-loaded, so the default config (`mode: all`) serves every tool.

| Group | Tools |
|---|---|
| `core` | `ssh_run`, `ssh_file`, `ssh_logs` |
| `ops` | `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_docker` |
| `advanced` | `ssh_session`, `ssh_net`, `ssh_fleet`, `ssh_plan` |

---

## Task 1: Rewrite `tool-registry.js` for the 12-tool surface

Replace the 51-tool / 7-group data with the 12-tool / 3-group data. The exported helper functions are generic over `TOOL_GROUPS` and need no change.

**Files:**
- Modify: `src/tool-registry.js`
- Test: `tests/test-tool-registry.js`

- [ ] **Step 1: Rewrite the test suite (failing tests)**

Replace the entire body of `tests/test-tool-registry.js` (everything after the imports block and the `test`/`assertEqual`/`assertTrue` helpers — i.e. from the `console.log('\n' + YELLOW + ...)` line to the end) with:

```javascript
console.log('\n' + YELLOW + 'Running Tool Registry Tests...' + NC + '\n');

test('All 12 v4 tools are defined in groups', () => {
  assertEqual(getAllTools().length, 12, 'Should have exactly 12 tools');
});

test('No duplicate tools across groups', () => {
  const all = getAllTools();
  assertEqual(new Set(all).size, 12, 'All 12 tools should be unique');
});

test('Tool group counts match TOOL_GROUP_COUNTS', () => {
  for (const [groupName, tools] of Object.entries(TOOL_GROUPS)) {
    assertEqual(tools.length, TOOL_GROUP_COUNTS[groupName], `Group ${groupName} count mismatch`);
  }
});

test('All groups have descriptions', () => {
  for (const groupName of Object.keys(TOOL_GROUPS)) {
    assertTrue(groupName in TOOL_GROUP_DESCRIPTIONS, `Group ${groupName} missing description`);
    assertTrue(TOOL_GROUP_DESCRIPTIONS[groupName].length > 0, `Group ${groupName} has empty description`);
  }
});

test('findToolGroup returns correct group', () => {
  assertEqual(findToolGroup('ssh_run'), 'core', 'ssh_run should be in core group');
  assertEqual(findToolGroup('ssh_health'), 'ops', 'ssh_health should be in ops group');
  assertEqual(findToolGroup('ssh_plan'), 'advanced', 'ssh_plan should be in advanced group');
  assertEqual(findToolGroup('nonexistent_tool'), null, 'Should return null for unknown tool');
});

test('getGroupTools returns correct tools', () => {
  assertEqual(getGroupTools('core').length, 3, 'core group should have 3 tools');
  assertTrue(getGroupTools('core').includes('ssh_run'), 'core should include ssh_run');
  assertEqual(getGroupTools('ops').length, 5, 'ops group should have 5 tools');
});

test('core group contains expected tools', () => {
  const core = getGroupTools('core');
  for (const tool of ['ssh_run', 'ssh_file', 'ssh_logs']) {
    assertTrue(core.includes(tool), `core should include ${tool}`);
  }
});

test('verifyIntegrity returns valid', () => {
  const integrity = verifyIntegrity();
  assertTrue(integrity.valid, 'Integrity check should pass');
  assertEqual(integrity.duplicates.length, 0, 'Should have no duplicates');
  assertEqual(integrity.issues.length, 0, 'Should have no issues');
});

test('getToolStats returns correct statistics', () => {
  const stats = getToolStats();
  assertEqual(stats.totalGroups, 3, 'Should have 3 groups');
  assertEqual(stats.totalTools, 12, 'Should have 12 total tools');
  assertEqual(stats.groups.length, 3, 'Should have 3 group entries');
});

test('All tools follow ssh_* naming convention', () => {
  for (const tool of getAllTools()) {
    assertTrue(tool.startsWith('ssh_'), `Tool ${tool} should start with 'ssh_'`);
  }
});

test('validateToolRegistry identifies correct tools', () => {
  const validation = validateToolRegistry(getAllTools());
  assertTrue(validation.valid, 'Validation should pass for all tools');
  assertEqual(validation.missing.length, 0, 'Should have no missing tools');
  assertEqual(validation.unexpected.length, 0, 'Should have no unexpected tools');
  assertEqual(validation.total, 12, 'Should expect 12 tools');
  assertEqual(validation.registered, 12, 'Should register 12 tools');
});

test('validateToolRegistry detects missing tools', () => {
  const validation = validateToolRegistry(['ssh_run', 'ssh_file']);
  assertTrue(!validation.valid, 'Validation should fail for partial list');
  assertEqual(validation.registered, 2, 'Should show 2 registered');
  assertTrue(validation.missing.length > 0, 'Should have missing tools');
});

test('Group sizes match specifications', () => {
  assertEqual(TOOL_GROUPS.core.length, 3, 'core should have 3 tools');
  assertEqual(TOOL_GROUPS.ops.length, 5, 'ops should have 5 tools');
  assertEqual(TOOL_GROUPS.advanced.length, 4, 'advanced should have 4 tools');
});

console.log('\n' + '='.repeat(60));
console.log(`${GREEN}Passed: ${passedTests}${NC}`);
console.log(`${RED}Failed: ${failedTests}${NC}`);
console.log('='.repeat(60) + '\n');

process.exit(failedTests > 0 ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-tool-registry.js`
Expected: FAIL — the suite expects 12 tools / 3 groups; `tool-registry.js` still has 51 / 7. Multiple `Failed:` lines.

- [ ] **Step 3: Rewrite `tool-registry.js`**

In `src/tool-registry.js`, replace the `TOOL_GROUPS`, `TOOL_GROUP_DESCRIPTIONS`, and `TOOL_GROUP_COUNTS` declarations (lines 8 through 117 in the current file — the three `export const` blocks and their leading doc comments) with:

```javascript
/**
 * Tool groups with their associated tools.
 * Total: 12 v4 fat verb-tools across 3 groups.
 */
export const TOOL_GROUPS = {
  // Core (3) -- run commands, move files, read logs
  core: [
    'ssh_run',
    'ssh_file',
    'ssh_logs',
  ],

  // Ops (5) -- services, health, databases, backups, containers
  ops: [
    'ssh_service',
    'ssh_health',
    'ssh_db',
    'ssh_backup',
    'ssh_docker',
  ],

  // Advanced (4) -- sessions, networking, fleet/config, multi-step plans
  advanced: [
    'ssh_session',
    'ssh_net',
    'ssh_fleet',
    'ssh_plan',
  ],
};

/**
 * Human-readable descriptions for each tool group.
 */
export const TOOL_GROUP_DESCRIPTIONS = {
  core: 'Run remote commands, transfer/read/edit files, read logs',
  ops: 'Service control, health checks, database ops, backups, Docker',
  advanced: 'Persistent sessions, tunnels/port probes, fleet+config metadata, multi-step plans',
};

/**
 * Tool count per group.
 */
export const TOOL_GROUP_COUNTS = {
  core: 3,
  ops: 5,
  advanced: 4,
};
```

Then update the two stale doc comments on the helper functions: change `getAllTools`'s `@returns` line from `Array of all tool names (51 across 7 groups)` to `Array of all tool names (12 across 3 groups)`. The function bodies of `getAllTools`, `findToolGroup`, `getGroupTools`, `validateToolRegistry`, `getToolStats`, `verifyIntegrity` are generic over `TOOL_GROUPS`/`TOOL_GROUP_COUNTS` and are left exactly as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-tool-registry.js`
Expected: PASS — `Passed: 13`, `Failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/tool-registry.js tests/test-tool-registry.js
git commit -m "refactor: rewrite tool registry for 12-tool v4 surface"
```

---

## Task 2: Rewrite `tool-annotations.js` for the 12 fat tools

One annotation entry per fat tool. A fat tool spans read-only and mutating actions, so `readOnlyHint`/`destructiveHint` are assigned by the tool's *worst-case* action: any tool that can mutate is `destructiveHint: true`; only the purely-inspecting tools are `readOnlyHint: true`. `withAnnotations` is unchanged.

**Files:**
- Modify: `src/tool-annotations.js`
- Test: `tests/test-tool-annotations.js`

- [ ] **Step 1: Rewrite the test suite (failing tests)**

Replace the entire body of `tests/test-tool-annotations.js` after the imports block (from `const allRegistered = ...` to the end) with:

```javascript
const allRegistered = Object.values(TOOL_GROUPS).flat();

await test('every registered tool has an annotations entry', () => {
  const missing = allRegistered.filter(name => !TOOL_ANNOTATIONS[name]);
  assert.strictEqual(missing.length, 0,
    `tools registered but missing annotations: ${missing.join(', ')}`);
});

await test('every annotated tool is actually registered (no dangling entries)', () => {
  const registered = new Set(allRegistered);
  const dangling = Object.keys(TOOL_ANNOTATIONS).filter(name => !registered.has(name));
  assert.strictEqual(dangling.length, 0,
    `annotations defined for unknown tools: ${dangling.join(', ')}`);
});

await test('exactly 12 tools are annotated', () => {
  assert.strictEqual(Object.keys(TOOL_ANNOTATIONS).length, 12,
    `expected 12 annotated tools, got ${Object.keys(TOOL_ANNOTATIONS).length}`);
});

await test('every annotated tool has a human title', () => {
  const missing = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => !v.title || typeof v.title !== 'string')
    .map(([k]) => k);
  assert.strictEqual(missing.length, 0, `tools missing title: ${missing.join(', ')}`);
});

await test('readOnlyHint and destructiveHint are never both true (spec invariant)', () => {
  const conflicts = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => v.annotations?.readOnlyHint && v.annotations?.destructiveHint)
    .map(([k]) => k);
  assert.strictEqual(conflicts.length, 0,
    `readOnly + destructive both set on: ${conflicts.join(', ')}`);
});

await test('mutation-capable fat tools are marked destructiveHint', () => {
  const expected = ['ssh_run', 'ssh_file', 'ssh_service', 'ssh_health',
    'ssh_db', 'ssh_backup', 'ssh_docker', 'ssh_session', 'ssh_net', 'ssh_plan'];
  for (const name of expected) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.destructiveHint, true,
      `${name} should be destructiveHint:true`);
  }
});

await test('purely-inspecting fat tools are marked readOnlyHint', () => {
  for (const name of ['ssh_logs', 'ssh_fleet']) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.readOnlyHint, true,
      `${name} should be readOnlyHint:true`);
  }
});

await test('every fat tool declares openWorldHint (acts on remote hosts)', () => {
  const missing = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => v.annotations?.openWorldHint !== true)
    .map(([k]) => k);
  assert.strictEqual(missing.length, 0,
    `tools missing openWorldHint: ${missing.join(', ')}`);
});

await test('withAnnotations() merges title + annotations into schema', () => {
  const out = withAnnotations('ssh_run', { description: 'x', inputSchema: {} });
  assert.strictEqual(typeof out.title, 'string');
  assert(out.title.length > 0);
  assert.strictEqual(out.annotations.destructiveHint, true);
  assert.strictEqual(out.description, 'x');
});

await test('withAnnotations() leaves unknown tools untouched', () => {
  const base = { description: 'x', inputSchema: {} };
  assert.deepStrictEqual(withAnnotations('ssh_nonexistent_tool', base), base);
});

await test('withAnnotations() does not clobber a caller-provided title', () => {
  const out = withAnnotations('ssh_run', { title: 'Custom', description: 'x', inputSchema: {} });
  assert.strictEqual(out.title, 'Custom');
});

await test('withAnnotations() caller-provided annotations override map defaults', () => {
  const out = withAnnotations('ssh_logs', {
    description: 'x', inputSchema: {}, annotations: { readOnlyHint: false },
  });
  assert.strictEqual(out.annotations.readOnlyHint, false, 'caller override must beat map default');
  assert.strictEqual(out.annotations.openWorldHint, true, 'non-overridden defaults still apply');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-tool-annotations.js`
Expected: FAIL — `TOOL_ANNOTATIONS` still holds 51 old entries; `exactly 12 tools are annotated` and the dangling-entry check fail.

- [ ] **Step 3: Rewrite `tool-annotations.js`**

In `src/tool-annotations.js`, replace the entire `TOOL_ANNOTATIONS` object (the `export const TOOL_ANNOTATIONS = { ... };` block, lines 20 through 111 in the current file) with:

```javascript
export const TOOL_ANNOTATIONS = {
  ssh_run: {
    title: 'Run Remote Command',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_file: {
    title: 'Transfer / Read / Edit Files',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_logs: {
    title: 'Read Remote Logs',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_service: {
    title: 'Service Control',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_health: {
    title: 'Health, Processes, Alerts',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_db: {
    title: 'Database Operations',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_backup: {
    title: 'Backup and Restore',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_docker: {
    title: 'Docker Control',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_session: {
    title: 'Persistent SSH Sessions',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_net: {
    title: 'Tunnels and Port Probes',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_fleet: {
    title: 'Fleet and Config Metadata',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_plan: {
    title: 'Multi-Step Plan Executor',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
};
```

The leading module doc comment and the `withAnnotations` function below the object are left unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-tool-annotations.js`
Expected: PASS — `12 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/tool-annotations.js tests/test-tool-annotations.js
git commit -m "refactor: rewrite tool annotations for 12 fat v4 tools"
```

---

## Task 3: Lift the inline `ssh_fleet` handler bodies into `fleet-adapters.js`

Seven of `ssh_fleet`'s eight actions (`servers`, `groups`, `aliases`, `profiles`, `hooks`, `history`, `connections`) currently live as inline closures inside `index.js` `registerToolConditional` calls. The `ssh_fleet` dispatcher (Part 2) expects them as a `handlers` object. This task moves that logic into named functions in a new module so the dispatcher can be wired in Task 4 without `index.js` carrying 400 lines of closure.

Each adapter takes `({ args, deps })` and returns an MCP `{ content, isError? }` response. `deps` carries the same callables `index.js` already has in scope: `loadServerConfig`, `resolveServerName`, group/alias/hook/profile functions, the `connections`/`connectionTimestamps`/`keepaliveIntervals` maps, `isConnectionValid`, `closeConnection`, `cleanupOldConnections`, `getConnection`, `logger`. Passing them in as `deps` keeps `fleet-adapters.js` free of `index.js` imports.

**Files:**
- Create: `src/fleet-adapters.js`
- Test: `tests/test-fleet-adapters.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-fleet-adapters.js`:

```javascript
#!/usr/bin/env node
/**
 * Tests for src/fleet-adapters.js -- the ssh_fleet action bodies lifted out
 * of index.js inline closures. Each adapter is exercised with injected deps.
 * Run: node tests/test-fleet-adapters.js
 */
import assert from 'assert';
import {
  fleetServers, fleetGroups, fleetAliases, fleetProfiles,
  fleetHooks, fleetHistory, fleetConnections,
} from '../src/fleet-adapters.js';

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

function isMcp(r) {
  return r && Array.isArray(r.content) && r.content[0] && r.content[0].type === 'text';
}

console.log('[test] Testing fleet-adapters\n');

await test('fleetServers lists configured servers from deps.loadServerConfig', async () => {
  const r = await fleetServers({
    args: {},
    deps: { loadServerConfig: () => ({ web1: { host: 'h1', user: 'u', port: '22' } }) },
  });
  assert(isMcp(r), 'returns MCP response');
  assert(r.content[0].text.includes('web1'), 'names the server');
});

await test('fleetGroups op=list returns an MCP response', async () => {
  const r = await fleetGroups({
    args: { op: 'list' },
    deps: { listGroups: () => [], createGroup: () => ({}), updateGroup: () => ({}),
      deleteGroup: () => {}, addServersToGroup: () => ({}), removeServersFromGroup: () => ({}) },
  });
  assert(isMcp(r));
});

await test('fleetGroups op=create without name -> isError', async () => {
  const r = await fleetGroups({
    args: { op: 'create' },
    deps: { listGroups: () => [], createGroup: () => ({}), updateGroup: () => ({}),
      deleteGroup: () => {}, addServersToGroup: () => ({}), removeServersFromGroup: () => ({}) },
  });
  assert.strictEqual(r.isError, true);
});

await test('fleetAliases op=list returns an MCP response', async () => {
  const r = await fleetAliases({
    args: { op: 'list' },
    deps: { listAliases: () => [], addAlias: () => {}, removeAlias: () => {},
      loadServerConfig: () => ({}), resolveServerName: () => 'web1' },
  });
  assert(isMcp(r));
});

await test('fleetProfiles op=list returns an MCP response', async () => {
  const r = await fleetProfiles({
    args: { op: 'list' },
    deps: { listProfiles: () => [], setActiveProfile: () => true,
      getActiveProfileName: () => 'default', loadProfile: () => ({}) },
  });
  assert(isMcp(r));
});

await test('fleetHooks op=list returns an MCP response', async () => {
  const r = await fleetHooks({
    args: { op: 'list' },
    deps: { listHooks: () => [], toggleHook: () => {} },
  });
  assert(isMcp(r));
});

await test('fleetHistory returns an MCP response from deps.logger', async () => {
  const r = await fleetHistory({
    args: { limit: 5 },
    deps: { logger: { getHistory: () => [] } },
  });
  assert(isMcp(r));
});

await test('fleetConnections op=status returns an MCP response', async () => {
  const r = await fleetConnections({
    args: { op: 'status' },
    deps: {
      connections: new Map(), connectionTimestamps: new Map(),
      keepaliveIntervals: new Map(),
      isConnectionValid: async () => true, closeConnection: () => {},
      cleanupOldConnections: () => {}, getConnection: async () => ({}),
      CONNECTION_TIMEOUT: 1800000, KEEPALIVE_INTERVAL: 300000,
    },
  });
  assert(isMcp(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-fleet-adapters.js`
Expected: FAIL — `Cannot find module '../src/fleet-adapters.js'`.

- [ ] **Step 3: Write `fleet-adapters.js`**

Create `src/fleet-adapters.js`. Each function lifts the body of the matching `index.js` inline closure verbatim, with two mechanical changes: the closed-over names become `deps.<name>`, and the `op`/`limit`/etc. fields are read off `args`. The `groups` action maps the v4 `op` values (`list`/`add`/`remove`/`update`) onto `ssh_group_manage`'s original action enum (`list`/`create`/`update`/`delete`/`add-servers`/`remove-servers`) — `create` is the `op:'add'` case for a whole group, `add-servers` is `op:'update'` with members.

```javascript
/**
 * ssh_fleet action bodies. Lifted out of index.js inline closures so the
 * ssh_fleet dispatcher can wire them as a handlers object. Each adapter takes
 * { args, deps } and returns an MCP { content, isError? } response. deps
 * carries the callables/maps that were closed over in index.js.
 */

function mcp(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/** ssh_list_servers body. */
export async function fleetServers({ deps }) {
  const servers = deps.loadServerConfig();
  const info = Object.entries(servers).map(([name, c]) => ({
    name, host: c.host, user: c.user, port: c.port || '22',
    auth: c.password ? 'password' : 'key',
    defaultDir: c.default_dir || '', description: c.description || '',
  }));
  return mcp(JSON.stringify(info, null, 2));
}

/** ssh_group_manage body. v4 op -> original action enum. */
export async function fleetGroups({ args, deps }) {
  const { op, name, members, description } = args || {};
  try {
    let result;
    let output = '';
    switch (op) {
      case 'add':
        if (!name) throw new Error('group name required');
        result = deps.createGroup(name, members || [], { description });
        output = `[ok] Group '${name}' created\nServers: ${result.servers.join(', ') || 'none'}`;
        break;
      case 'update':
        if (!name) throw new Error('group name required');
        if (members && members.length) {
          result = deps.addServersToGroup(name, members);
          output = `[ok] Group '${name}' members: ${result.servers.join(', ')}`;
        } else {
          result = deps.updateGroup(name, { description });
          output = `[ok] Group '${name}' updated`;
        }
        break;
      case 'remove':
        if (!name) throw new Error('group name required');
        if (members && members.length) {
          result = deps.removeServersFromGroup(name, members);
          output = `[ok] Group '${name}' members: ${result.servers.join(', ') || 'none'}`;
        } else {
          deps.deleteGroup(name);
          output = `[ok] Group '${name}' deleted`;
        }
        break;
      case 'list':
      default: {
        const groups = deps.listGroups();
        output = '[list] Server Groups\n' + groups.map(g =>
          `  ${g.name} (${g.serverCount} servers): ${g.servers.join(', ') || 'none'}`).join('\n');
        break;
      }
    }
    return mcp(output);
  } catch (e) {
    return mcp(`[err] Group operation failed: ${e.message}`, true);
  }
}

/** ssh_alias body. */
export async function fleetAliases({ args, deps }) {
  const { op, name, target } = args || {};
  try {
    switch (op) {
      case 'add': {
        if (!name || !target) throw new Error('alias name and target required');
        const servers = deps.loadServerConfig();
        const resolved = deps.resolveServerName(target, servers);
        if (!resolved) throw new Error(`Server "${target}" not found`);
        deps.addAlias(name, resolved);
        return mcp(`[ok] Alias created: ${name} -> ${resolved}`);
      }
      case 'remove':
        if (!name) throw new Error('alias name required');
        deps.removeAlias(name);
        return mcp(`[ok] Alias removed: ${name}`);
      case 'list':
      default: {
        const aliases = deps.listAliases();
        const servers = deps.loadServerConfig();
        const text = aliases.map(({ alias, target: t }) =>
          `  ${alias} -> ${t} (${servers[t]?.host || 'unknown'})`).join('\n');
        return mcp(aliases.length ? `[log] Server aliases:\n${text}` : '[log] No aliases configured');
      }
    }
  } catch (e) {
    return mcp(`[err] Alias operation failed: ${e.message}`, true);
  }
}

/** ssh_profile body. */
export async function fleetProfiles({ args, deps }) {
  const { op, name } = args || {};
  try {
    switch (op) {
      case 'update': {
        if (!name) throw new Error('profile name required');
        if (!deps.setActiveProfile(name)) throw new Error(`Failed to switch to profile: ${name}`);
        return mcp(`[ok] Switched to profile: ${name}\n[warn] Restart Claude Code to apply`);
      }
      case 'list':
      default: {
        const profiles = deps.listProfiles();
        const current = deps.getActiveProfileName();
        const text = profiles.map(p =>
          `  ${p.name}: ${p.description} (${p.aliasCount} aliases, ${p.hookCount} hooks)`).join('\n');
        return mcp(profiles.length
          ? `[docs] Profiles (current: ${current}):\n${text}`
          : '[docs] No profiles found');
      }
    }
  } catch (e) {
    return mcp(`[err] Profile operation failed: ${e.message}`, true);
  }
}

/** ssh_hooks body. */
export async function fleetHooks({ args, deps }) {
  const { op, name } = args || {};
  try {
    switch (op) {
      case 'add':
      case 'update':
        if (!name) throw new Error('hook name required');
        deps.toggleHook(name, true);
        return mcp(`[ok] Hook enabled: ${name}`);
      case 'remove':
        if (!name) throw new Error('hook name required');
        deps.toggleHook(name, false);
        return mcp(`[ok] Hook disabled: ${name}`);
      case 'list':
      default: {
        const hooks = deps.listHooks();
        const text = hooks.map(({ name: n, enabled, description, actionCount }) =>
          `  ${enabled ? '[ok]' : '[err]'} ${n}: ${description} (${actionCount} actions)`).join('\n');
        return mcp(hooks.length ? `[hook] Hooks:\n${text}` : '[hook] No hooks configured');
      }
    }
  } catch (e) {
    return mcp(`[err] Hook operation failed: ${e.message}`, true);
  }
}

/** ssh_history body. */
export async function fleetHistory({ args, deps }) {
  const { limit = 20, server, search } = args || {};
  try {
    let history = deps.logger.getHistory(limit * 2);
    if (server) history = history.filter(h => h.server?.toLowerCase().includes(server.toLowerCase()));
    if (search) history = history.filter(h => h.command?.toLowerCase().includes(search.toLowerCase()));
    history = history.slice(-limit);
    if (history.length === 0) return mcp('[log] No commands found matching the criteria.');
    const text = history.map((e, i) =>
      `${history.length - i}. ${e.success ? '[ok]' : '[err]'} ${e.server || 'unknown'}: `
      + `${(e.command || 'N/A').substring(0, 100)}`).join('\n');
    return mcp(`[log] SSH Command History (last ${history.length})\n${text}`);
  } catch (e) {
    return mcp(`[err] Error retrieving history: ${e.message}`, true);
  }
}

/** ssh_connection_status body. */
export async function fleetConnections({ args, deps }) {
  const { op = 'status', server } = args || {};
  try {
    switch (op) {
      case 'reconnect': {
        if (!server) throw new Error('server required for reconnect');
        const n = server.toLowerCase();
        if (deps.connections.has(n)) deps.closeConnection(n);
        await deps.getConnection(server);
        return mcp(`[recycle] Reconnected to ${server}`);
      }
      case 'disconnect':
        if (!server) throw new Error('server required for disconnect');
        deps.closeConnection(server);
        return mcp(`[conn] Disconnected from ${server}`);
      case 'cleanup': {
        const before = deps.connections.size;
        deps.cleanupOldConnections();
        for (const [n, ssh] of deps.connections.entries()) {
          if (!(await deps.isConnectionValid(ssh))) deps.closeConnection(n);
        }
        return mcp(`[clean] ${before - deps.connections.size} closed, ${deps.connections.size} active`);
      }
      case 'status':
      default: {
        const now = Date.now();
        const rows = [];
        for (const [name, ssh] of deps.connections.entries()) {
          const age = Math.floor((now - deps.connectionTimestamps.get(name)) / 60000);
          const valid = await deps.isConnectionValid(ssh);
          rows.push(`  ${name}: ${valid ? '[ok] Active' : '[err] Dead'} (age ${age}m)`);
        }
        return mcp(`[conn] Connection Pool:\n${rows.join('\n') || '  No active connections'}`);
      }
    }
  } catch (e) {
    return mcp(`[err] Connection management failed: ${e.message}`, true);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-fleet-adapters.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/fleet-adapters.js tests/test-fleet-adapters.js
git commit -m "refactor: lift inline ssh_fleet handler bodies into fleet-adapters module"
```

---

## Task 4: Cut `index.js` over to the 12 fat-tool registrations

Delete the 51 `registerToolConditional(...)` blocks and add 12, each with a full zod `inputSchema` (the union of its actions' args, every action-scoped arg optional) and a dispatcher handler. This is the only task that changes `index.js`.

**Files:**
- Modify: `src/index.js`
- Test: `tests/test-index-registration.js`

- [ ] **Step 1: Rewrite the test suite (failing tests)**

Replace the entire body of `tests/test-index-registration.js` after the `registeredNames` function definition (from the first `await test(...)` to the end) with:

```javascript
await test('every TOOL_GROUPS entry is registered in index.js', () => {
  const registered = registeredNames(indexSrc);
  const missing = getAllTools().filter(name => !registered.has(name));
  assert.strictEqual(missing.length, 0,
    `tools in TOOL_GROUPS but never registered: ${missing.join(', ')}`);
});

await test('every registerToolConditional() corresponds to a TOOL_GROUPS entry', () => {
  const registered = registeredNames(indexSrc);
  const known = new Set(getAllTools());
  const orphans = [...registered].filter(name => !known.has(name));
  assert.strictEqual(orphans.length, 0,
    `tools registered in index.js but missing from TOOL_GROUPS: ${orphans.join(', ')}`);
});

await test('exactly 12 tools are registered', () => {
  const registered = registeredNames(indexSrc);
  assert.strictEqual(registered.size, 12,
    `expected 12 registered tools, got ${registered.size}: ${[...registered].join(', ')}`);
});

await test('count of registered tools matches registry exactly', () => {
  const registered = registeredNames(indexSrc);
  assert.strictEqual(registered.size, getAllTools().length,
    `registered=${registered.size} vs registry=${getAllTools().length}`);
});

await test('every registered tool has an annotations entry (drift check)', () => {
  const registered = registeredNames(indexSrc);
  const missing = [...registered].filter(name => !TOOL_ANNOTATIONS[name]);
  assert.strictEqual(missing.length, 0,
    `tools registered without annotations: ${missing.join(', ')}`);
});

await test('no legacy 51-surface tool name survives in a registration', () => {
  const registered = registeredNames(indexSrc);
  const legacy = ['ssh_execute', 'ssh_upload', 'ssh_cat', 'ssh_tail',
    'ssh_systemctl', 'ssh_tunnel_create', 'ssh_deploy_artifact'];
  const survivors = legacy.filter(name => registered.has(name));
  assert.strictEqual(survivors.length, 0,
    `legacy tool names still registered: ${survivors.join(', ')}`);
});

await test('TOOL_GROUPS has no duplicate names across groups', () => {
  const all = getAllTools();
  assert.strictEqual(all.length, new Set(all).size,
    `duplicates detected in TOOL_GROUPS`);
});

await test('every group declared in TOOL_GROUPS is non-empty', () => {
  for (const [name, tools] of Object.entries(TOOL_GROUPS)) {
    assert(Array.isArray(tools) && tools.length > 0, `group ${name} is empty`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-index-registration.js`
Expected: FAIL — `index.js` still registers 51 tools; `exactly 12 tools are registered` and `no legacy 51-surface tool name survives` fail.

- [ ] **Step 3: Add the dispatcher imports to `index.js`**

In `src/index.js`, immediately after the existing tool-handler import block (the last such line is `import { handleSshPlan } from './tools/plan-tools.js';`), add:

```javascript
// v4 dispatcher facade -- 12 fat verb-tools over the handlers above.
import { handleSshRun } from './dispatchers/ssh-run.js';
import { handleSshFile } from './dispatchers/ssh-file.js';
import { handleSshLogs } from './dispatchers/ssh-logs.js';
import { handleSshService } from './dispatchers/ssh-service.js';
import { handleSshHealth } from './dispatchers/ssh-health.js';
import { handleSshDb } from './dispatchers/ssh-db.js';
import { handleSshBackup } from './dispatchers/ssh-backup.js';
import { handleSshSession } from './dispatchers/ssh-session.js';
import { handleSshNet } from './dispatchers/ssh-net.js';
import { handleSshDockerTool } from './dispatchers/ssh-docker.js';
import { handleSshFleet } from './dispatchers/ssh-fleet.js';
import { handleSshPlanTool } from './dispatchers/ssh-plan.js';
import {
  fleetServers, fleetGroups, fleetAliases, fleetProfiles,
  fleetHooks, fleetHistory, fleetConnections,
} from './fleet-adapters.js';
```

- [ ] **Step 4: Replace the registration section of `index.js`**

Delete everything from the first `registerToolConditional(` call (currently the `ssh_execute` registration, beginning at `registerToolConditional(\n  'ssh_execute',`) through the closing `);` of the last registration (the `ssh_plan` registration that ends with `    return handleSshPlan({ dispatch, args });\n  }\n);`). That is the entire span of 51 registrations. Keep `getServerConfigByName` (defined just above the first registration) and everything after the last registration (`// Clean up connections on shutdown`, the `SIGINT` handler, `main`).

In that deleted span's place, insert the following 12 registrations. Shared zod fragments are defined once at the top to keep the schemas compact.

```javascript
// --- v4 fat verb-tool registration ----------------------------------------
// Shared schema fragments. Every action-scoped arg is optional; each
// dispatcher enforces its per-action required-arg map and returns a
// structured fail() naming any missing args.
const FORMAT = z.enum(['compact', 'json', 'markdown']).optional()
  .describe('Output format (default compact)');
const RAW = z.boolean().optional()
  .describe('Disable output compression and truncation');

// deps bundle handed to every dispatcher.
const DEPS = {
  getConnection,
  getServerConfig: getServerConfigByName,
  resolveGroup: (groupName) => {
    const g = getGroup(groupName);
    return g ? { name: g.name, servers: g.servers } : null;
  },
};

registerToolConditional('ssh_run', {
  description: 'Run a command on a configured SSH server. Use instead of '
    + '`ssh host <cmd>` via Bash -- the connection is pooled (no per-call '
    + 'handshake) and output is bounded and compressed.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['exec', 'sudo', 'fleet']).describe('exec a command, sudo a command, or fleet-exec across a group'),
    command: z.string().optional().describe('Command to run (actions: exec, sudo)'),
    cwd: z.string().optional().describe('Working directory (actions: exec, sudo, fleet)'),
    group: z.string().optional().describe('Server group name (action: fleet)'),
    sudo_password: z.string().optional().describe('Sudo password, streamed via stdin (action: sudo)'),
    timeout: z.number().optional().describe('Command timeout in ms (actions: exec, sudo)'),
    raw: RAW,
    format: FORMAT,
  },
}, async (args) => handleSshRun({
  deps: DEPS,
  handlers: {
    execute: handleSshExecute,
    executeSudo: handleSshExecuteSudo,
    executeGroup: handleSshExecuteGroup,
  },
  args,
}));

registerToolConditional('ssh_file', {
  description: 'Transfer, read, edit, diff, or deploy files on a configured '
    + 'SSH server. Use instead of `scp` / `ssh host cat` / heredocs via Bash '
    + '-- transfers are sha256-verified and writes avoid shell-quoting hazards.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['upload', 'download', 'sync', 'read', 'write', 'edit', 'diff', 'deploy', 'deploy-artifact'])
      .describe('File operation to perform'),
    local_path: z.string().optional().describe('Local path (actions: upload, download)'),
    remote_path: z.string().optional().describe('Remote path (actions: upload, download, read, write, edit)'),
    content: z.string().optional().describe('File content to write (action: write)'),
    old_text: z.string().optional().describe('Text to replace (action: edit)'),
    new_text: z.string().optional().describe('Replacement text (action: edit)'),
    source: z.string().optional().describe('Sync source, "local:"/"remote:" prefixed (action: sync)'),
    destination: z.string().optional().describe('Sync destination, "local:"/"remote:" prefixed (action: sync)'),
    exclude: z.array(z.string()).optional().describe('Exclude patterns (action: sync)'),
    delete_extra: z.boolean().optional().describe('Delete files absent from source (action: sync)'),
    head: z.number().optional().describe('Read first N lines (action: read)'),
    tail: z.number().optional().describe('Read last N lines (action: read)'),
    grep: z.string().optional().describe('Extended-regex filter (action: read)'),
    line_start: z.number().optional().describe('Start line, 1-indexed (action: read)'),
    line_end: z.number().optional().describe('End line, 1-indexed (action: read)'),
    path_a: z.string().optional().describe('First file (action: diff)'),
    path_b: z.string().optional().describe('Second file (action: diff)'),
    server_b: z.string().optional().describe('Other server hosting path_b for a cross-server diff (action: diff)'),
    artifact_local_path: z.string().optional().describe('Local artifact (actions: deploy, deploy-artifact)'),
    target_path: z.string().optional().describe('Remote target path (actions: deploy, deploy-artifact)'),
    post_hooks: z.array(z.string()).optional().describe('Post-deploy commands (actions: deploy, deploy-artifact)'),
    health_check: z.string().optional().describe('Health check command (actions: deploy, deploy-artifact)'),
    rollback_on_fail: z.boolean().optional().describe('Auto-rollback on failure (actions: deploy, deploy-artifact)'),
    preview: z.boolean().optional().describe('Show the plan without executing'),
    format: FORMAT,
  },
}, async (args) => handleSshFile({
  deps: DEPS,
  handlers: {
    upload: handleSshUpload,
    download: handleSshDownload,
    sync: handleSshSync,
    cat: handleSshCat,
    edit: handleSshEdit,
    diff: handleSshDiff,
    deploy: handleSshDeploy,
  },
  args,
}));

registerToolConditional('ssh_logs', {
  description: 'Read remote logs. Use instead of `ssh host journalctl` / '
    + '`ssh host tail` via Bash -- output is capped and filtered so it will '
    + 'not flood context.',
  inputSchema: {
    server: z.string().optional().describe('Server name (actions: tail, follow-start, journal)'),
    action: z.enum(['tail', 'follow-start', 'follow-read', 'follow-stop', 'journal'])
      .describe('Log operation to perform'),
    file: z.string().optional().describe('Log file path (actions: tail, follow-start)'),
    lines: z.number().optional().describe('Trailing line count (actions: tail, follow-start, journal)'),
    grep: z.string().optional().describe('Extended-regex filter (actions: tail, follow-start, journal)'),
    session_id: z.string().optional().describe('Tail session id (actions: follow-read, follow-stop)'),
    since_offset: z.number().optional().describe('Resume byte offset (action: follow-read)'),
    unit: z.string().optional().describe('systemd unit to filter (action: journal)'),
    since: z.string().optional().describe('Time lower bound (action: journal)'),
    until: z.string().optional().describe('Time upper bound (action: journal)'),
    priority: z.string().optional().describe('Priority filter (action: journal)'),
    format: FORMAT,
  },
}, async (args) => handleSshLogs({
  deps: DEPS,
  handlers: {
    tail: handleSshTail,
    tailStart: handleSshTailStart,
    tailRead: handleSshTailRead,
    tailStop: handleSshTailStop,
    journal: handleSshJournalctl,
  },
  args,
}));

registerToolConditional('ssh_service', {
  description: 'Inspect or control a systemd service on a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['status', 'start', 'stop', 'restart', 'enable', 'disable'])
      .describe('Service operation to perform'),
    service: z.string().describe('Service unit name, e.g. "nginx" or "nginx.service"'),
    preview: z.boolean().optional().describe('Preview a mutating action without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshService({
  deps: DEPS,
  handlers: { serviceStatus: handleSshServiceStatus, systemctl: handleSshSystemctl },
  args,
}));

registerToolConditional('ssh_health', {
  description: 'Server health snapshot, resource watch, process management, '
    + 'and threshold alerts for a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['check', 'watch', 'procs', 'alerts']).describe('Health operation to perform'),
    watch_type: z.enum(['overview', 'cpu', 'memory', 'disk', 'network', 'process'])
      .optional().describe('Subsystem to snapshot (action: watch)'),
    proc_action: z.enum(['list', 'kill', 'info']).optional().describe('Process operation (action: procs, default list)'),
    pid: z.number().optional().describe('Process id (action: procs, proc_action kill/info)'),
    signal: z.enum(['TERM', 'KILL', 'HUP', 'INT', 'QUIT']).optional().describe('Kill signal (action: procs)'),
    sort_by: z.enum(['cpu', 'memory']).optional().describe('Process sort key (action: procs)'),
    limit: z.number().optional().describe('Process row cap (action: procs)'),
    filter: z.string().optional().describe('Process name/command filter (action: procs)'),
    alert_action: z.enum(['set', 'get', 'check']).optional().describe('Alert operation (action: alerts)'),
    cpu_threshold: z.number().min(0).max(100).optional().describe('CPU alert threshold percent (action: alerts)'),
    memory_threshold: z.number().min(0).max(100).optional().describe('Memory alert threshold percent (action: alerts)'),
    disk_threshold: z.number().min(0).max(100).optional().describe('Disk alert threshold percent (action: alerts)'),
    enabled: z.boolean().optional().describe('Enable/disable alert evaluation (action: alerts)'),
    preview: z.boolean().optional().describe('Preview a process kill without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshHealth({
  deps: DEPS,
  handlers: {
    healthCheck: handleSshHealthCheck,
    monitor: handleSshMonitor,
    processManager: handleSshProcessManager,
    alertSetup: handleSshAlertSetup,
  },
  args,
}));

registerToolConditional('ssh_db', {
  description: 'Database operations (MySQL, PostgreSQL, MongoDB) on a '
    + 'configured SSH server. Queries are SELECT-only and token-validated.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['query', 'list', 'dump', 'import']).describe('Database operation to perform'),
    db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Database engine'),
    database: z.string().optional().describe('Database name (actions: query, dump, import)'),
    query: z.string().optional().describe('SELECT-only SQL or Mongo find (action: query)'),
    collection: z.string().optional().describe('MongoDB collection (action: query)'),
    output_file: z.string().optional().describe('Dump output path (action: dump)'),
    tables: z.array(z.string()).optional().describe('Specific tables (action: dump)'),
    input_file: z.string().optional().describe('Import input path (action: import)'),
    gzip: z.boolean().optional().describe('Gzip the dump (action: dump)'),
    drop: z.boolean().optional().describe('Drop existing before import, Mongo (action: import)'),
    user: z.string().optional().describe('Database user'),
    password: z.string().optional().describe('Database password'),
    host: z.string().optional().describe('Database host'),
    port: z.number().optional().describe('Database port'),
    preview: z.boolean().optional().describe('Show the plan without importing (action: import)'),
    format: FORMAT,
  },
}, async (args) => handleSshDb({
  deps: DEPS,
  handlers: {
    query: handleSshDbQuery,
    list: handleSshDbList,
    dump: handleSshDbDump,
    import: handleSshDbImport,
  },
  args,
}));

registerToolConditional('ssh_backup', {
  description: 'Create, list, restore, or schedule content-addressed backups '
    + 'on a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['create', 'list', 'restore', 'schedule']).describe('Backup operation to perform'),
    backup_type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Backup type'),
    name: z.string().optional().describe('Backup name (actions: create, schedule)'),
    database: z.string().optional().describe('Database name (actions: create, restore, schedule)'),
    paths: z.array(z.string()).optional().describe('Paths to back up (actions: create, schedule)'),
    exclude: z.array(z.string()).optional().describe('Exclude patterns (action: create)'),
    backup_dir: z.string().optional().describe('Backup directory'),
    backup_id: z.string().optional().describe('Backup id (action: restore)'),
    target_path: z.string().optional().describe('Restore target path for file backups (action: restore)'),
    cron: z.string().optional().describe('Cron schedule (action: schedule)'),
    retention: z.number().optional().describe('Retention days (action: schedule)'),
    gzip: z.boolean().optional().describe('Gzip the backup (action: create)'),
    verify: z.boolean().optional().describe('Compute/verify sha256 (actions: create, restore)'),
    preview: z.boolean().optional().describe('Show the plan without executing'),
    format: FORMAT,
  },
}, async (args) => handleSshBackup({
  deps: DEPS,
  handlers: {
    create: handleSshBackupCreate,
    list: handleSshBackupList,
    restore: handleSshBackupRestore,
    schedule: handleSshBackupSchedule,
  },
  args,
}));

registerToolConditional('ssh_docker', {
  description: 'Docker control on a configured SSH server (ps, logs, exec, '
    + 'restart, inspect).',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['ps', 'logs', 'exec', 'restart', 'inspect']).describe('Docker operation to perform'),
    container: z.string().optional().describe('Container name/id (actions: logs, exec, restart, inspect)'),
    image: z.string().optional().describe('Image reference'),
    command: z.string().optional().describe('Command for docker exec (action: exec)'),
    tail_lines: z.number().optional().describe('Log tail line count (action: logs)'),
    preview: z.boolean().optional().describe('Preview a mutating action without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshDockerTool({
  deps: DEPS,
  handlers: { docker: handleSshDocker },
  args,
}));

registerToolConditional('ssh_session', {
  description: 'Persistent SSH sessions with preserved shell state, history '
    + 'replay, and inferred memory.',
  inputSchema: {
    server: z.string().optional().describe('Server name (action: start)'),
    action: z.enum(['start', 'send', 'list', 'close', 'replay', 'memory'])
      .describe('Session operation to perform'),
    session_id: z.string().optional().describe('Session id (actions: send, close, replay, memory)'),
    command: z.string().optional().describe('Command to send (action: send)'),
    timeout: z.number().optional().describe('Command timeout in ms (action: send)'),
    limit: z.number().optional().describe('Max commands to replay (action: replay)'),
    format: FORMAT,
  },
}, async (args) => handleSshSession({
  deps: DEPS,
  handlers: {
    start: handleSshSessionStartNew,
    send: handleSshSessionSendNew,
    list: handleSshSessionListNew,
    close: handleSshSessionCloseNew,
    replay: handleSshSessionReplay,
    memory: handleSshSessionMemory,
  },
  args,
}));

registerToolConditional('ssh_net', {
  description: 'SSH tunnels (local/remote/SOCKS) and outbound port/TLS/HTTP '
    + 'reachability probes from a configured server.',
  inputSchema: {
    server: z.string().optional().describe('Server name (actions: tunnel-open, port-test)'),
    action: z.enum(['tunnel-open', 'tunnel-list', 'tunnel-close', 'port-test'])
      .describe('Network operation to perform'),
    tunnel_type: z.enum(['local', 'remote', 'dynamic']).optional().describe('Tunnel kind (action: tunnel-open)'),
    local_host: z.string().optional().describe('Local host (action: tunnel-open)'),
    local_port: z.number().optional().describe('Local port (action: tunnel-open)'),
    remote_host: z.string().optional().describe('Remote host (action: tunnel-open)'),
    remote_port: z.number().optional().describe('Remote port (action: tunnel-open)'),
    tunnel_id: z.string().optional().describe('Tunnel id (action: tunnel-close)'),
    target_host: z.string().optional().describe('Probe target host (action: port-test)'),
    target_port: z.number().optional().describe('Probe target port (action: port-test)'),
    probe_chain: z.array(z.enum(['dns', 'tcp', 'tls', 'http'])).optional().describe('Probe ordering (action: port-test)'),
    timeout_ms_per_probe: z.number().optional().describe('Per-probe timeout in ms (action: port-test)'),
    continue_on_fail: z.boolean().optional().describe('Keep probing after a failure (action: port-test)'),
    preview: z.boolean().optional().describe('Probe reachability without opening the tunnel (action: tunnel-open)'),
    format: FORMAT,
  },
}, async (args) => handleSshNet({
  deps: DEPS,
  handlers: {
    tunnelCreate: handleSshTunnelCreate,
    tunnelList: handleSshTunnelList,
    tunnelClose: handleSshTunnelClose,
    portTest: handleSshPortTest,
  },
  args,
}));

registerToolConditional('ssh_fleet', {
  description: 'Fleet and configuration metadata: configured servers, server '
    + 'groups, aliases, profiles, hooks, host keys, command history, '
    + 'connection pool.',
  inputSchema: {
    action: z.enum(['servers', 'groups', 'aliases', 'profiles', 'hooks', 'keys', 'history', 'connections'])
      .describe('Fleet/config entity to operate on'),
    op: z.enum(['list', 'add', 'remove', 'update', 'status', 'reconnect', 'disconnect', 'cleanup', 'verify', 'accept', 'check', 'show'])
      .optional().describe('Sub-operation (default list/status)'),
    name: z.string().optional().describe('Entity name (group, alias, profile, hook)'),
    members: z.array(z.string()).optional().describe('Member server names (action: groups)'),
    target: z.string().optional().describe('Alias target server (action: aliases)'),
    server: z.string().optional().describe('Server name (actions: keys, connections, history)'),
    host: z.string().optional().describe('Raw host (action: keys)'),
    port: z.number().optional().describe('Port (action: keys)'),
    auto_accept: z.boolean().optional().describe('Auto-accept new host keys (action: keys)'),
    limit: z.number().optional().describe('Row limit (action: history)'),
    format: FORMAT,
  },
}, async (args) => handleSshFleet({
  deps: DEPS,
  handlers: {
    servers: ({ args: a }) => fleetServers({ args: a, deps: { loadServerConfig } }),
    groups: ({ args: a }) => fleetGroups({
      args: a,
      deps: { listGroups, createGroup, updateGroup, deleteGroup, addServersToGroup, removeServersFromGroup },
    }),
    aliases: ({ args: a }) => fleetAliases({
      args: a, deps: { listAliases, addAlias, removeAlias, loadServerConfig, resolveServerName },
    }),
    profiles: ({ args: a }) => fleetProfiles({
      args: a, deps: { listProfiles, setActiveProfile, getActiveProfileName, loadProfile },
    }),
    hooks: ({ args: a }) => fleetHooks({ args: a, deps: { listHooks, toggleHook } }),
    history: ({ args: a }) => fleetHistory({ args: a, deps: { logger } }),
    connections: ({ args: a }) => fleetConnections({
      args: a,
      deps: {
        connections, connectionTimestamps, keepaliveIntervals,
        isConnectionValid, closeConnection, cleanupOldConnections, getConnection,
      },
    }),
    keys: handleSshKeyManage,
  },
  args,
}));

registerToolConditional('ssh_plan', {
  description: 'Declarative multi-step plan executor. Runs an ordered list of '
    + 'steps with rollback; high-risk steps need a re-run with approve_token.',
  inputSchema: {
    action: z.enum(['run', 'approve']).describe('run a plan, or approve and re-run a high-risk plan'),
    steps: z.array(z.any()).describe('Ordered list of step objects'),
    server: z.string().optional().describe('Plan-level default server for steps that omit one'),
    approve_token: z.string().optional().describe('Any non-empty token; required for high-risk plans (action: approve)'),
    rollback_on_fail: z.boolean().optional().describe('Walk completed steps in reverse and roll back on failure'),
    format: FORMAT,
  },
}, async (args) => handleSshPlanTool({
  deps: DEPS,
  handlers: {
    execute: handleSshExecute,
    executeSudo: handleSshExecuteSudo,
    upload: handleSshUpload,
    download: handleSshDownload,
    edit: handleSshEdit,
    systemctl: handleSshSystemctl,
    backupCreate: handleSshBackupCreate,
    healthCheck: handleSshHealthCheck,
  },
  planFn: handleSshPlan,
  args,
}));
```

- [ ] **Step 5: Run the registration test to verify it passes**

Run: `node tests/test-index-registration.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 6: Verify the server still starts**

Run: `./scripts/validate.sh`
Expected: JavaScript syntax check passes, MCP server startup check passes. If `validate.sh` reports a syntax error in `index.js`, the deleted span was cut at the wrong boundary — re-check that exactly the 51 `registerToolConditional` calls were removed and `getServerConfigByName` plus the `SIGINT`/`main` tail were kept.

- [ ] **Step 7: Commit**

```bash
git add src/index.js tests/test-index-registration.js
git commit -m "feat: cut MCP surface over to 12 fat v4 verb-tools"
```

---

## Task 5: Fix `test-tool-config-manager.js` for the 12-tool registry

`test-tool-config-manager.js` hard-codes the 51-surface in two places: a comment ("every one of the 50 tools") and `minimal`-mode assertions that expect `core` to contain `ssh_execute`. With the v4 registry, `minimal` mode serves the 3-tool `core` group (`ssh_run`, `ssh_file`, `ssh_logs`). Update only the count-dependent and tool-name-dependent assertions; the manager's logic is registry-generic and unchanged.

**Files:**
- Modify: `tests/test-tool-config-manager.js`

- [ ] **Step 1: Locate the coupled assertions**

Run: `grep -n "ssh_execute\|ssh_session_start\|minimal\|51\|50 tools\|core" tests/test-tool-config-manager.js`
Expected: a list of line numbers. The coupled spots are: the doc-comment "50 tools" line; any test asserting a specific legacy tool name (e.g. `isToolEnabled('ssh_execute')`); any test asserting a hard-coded group/tool count.

- [ ] **Step 2: Update the assertions**

Apply these edits to `tests/test-tool-config-manager.js`:

- In the file's doc comment, change `every one of the 50 tools` to `every one of the 12 v4 tools`.
- In any test that calls `isToolEnabled('ssh_execute')` or asserts a legacy tool, replace the tool name with a v4 name: `ssh_run` for a `core` tool, `ssh_health` for an `ops` tool, `ssh_plan` for an `advanced` tool. The assertion *intent* (a core tool is enabled in minimal mode; a non-core tool is disabled in minimal mode) is preserved; only the names change.
- In any test that asserts a hard-coded enabled-tool count under `minimal` mode, change the expected count to `3` (the v4 `core` group size) and compute it as `getGroupTools('core').length` rather than a literal where the file already imports `getGroupTools` — otherwise use the literal `3`.
- Any test asserting `getAllTools().length` equals a number: change the number to `12`, or — preferred — assert it equals `getAllTools().length` of a freshly-imported reference so it tracks the registry.

Make no other change: the `mode: all` / corrupt-JSON / invalid-structure / `disableGroup('core')`-refused tests are registry-size-agnostic and must keep passing untouched.

- [ ] **Step 3: Run the suite**

Run: `node tests/test-tool-config-manager.js`
Expected: PASS — all tests green. If a test still fails, it asserted a 51-surface fact missed in Step 2 — fix that assertion the same way (swap legacy name for a v4 name, swap a count literal for `12`/`3`).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: green. Every suite passes. The handler-level suites (`test-exec-tools.js`, `test-db-tools.js`, `test-session-tools.js`, ... — roughly 640 tests) are untouched and must still pass: they call the `src/tools/*.js` handlers directly, and those handlers were not modified anywhere in Plan 4. The dispatcher suites from Parts 1-2 pass. The four rewritten coupled suites pass. Record the real total `npm test` prints.

> If any pre-existing handler-level suite fails, Plan 4 broke something it should not have — a dispatcher or the registration cutover touched a handler. Do not patch the test; find and revert the unintended handler change.

- [ ] **Step 5: Commit**

```bash
git add tests/test-tool-config-manager.js
git commit -m "test: update tool-config-manager suite for 12-tool v4 registry"
```

---

## Done criteria

- `src/tool-registry.js` defines 12 tools across 3 groups (`core`/`ops`/`advanced`); all its exported helpers keep their signatures.
- `src/tool-annotations.js` has exactly 12 annotation entries, one per fat tool.
- `src/fleet-adapters.js` holds the seven lifted `ssh_fleet` action bodies.
- `src/index.js` registers exactly 12 tools via `registerToolConditional`; no legacy 51-surface name survives.
- `./scripts/validate.sh` passes — the MCP server starts.
- `npm test` is green: the four rewritten coupled suites pass, the new `test-fleet-adapters.js` passes, every Part 1-2 dispatcher suite passes, and the ~640 handler-level tests pass unchanged.
- The MCP surface is 12 tools. `ssh_find` (13th) and the `ssh_run` `script`/`detach`/job actions are Plan 5.

Plan 5 adds `ssh_find` as the 13th tool (a new modular handler plus a registry/annotation/registration entry), extends the `ssh_run` action enum and dispatcher with `script` (`;`-chain exit sentinels), `detach`, `job-status`, `job-kill`, and adds the `df` / `git log` / test-runner compressors. Plan 6 adds the CLAUDE.md adoption rule and the Bash PreToolUse nudge hook.

---

## Self-review

Performed after drafting, before marking the plan ready.

**Spec coverage (sections 3, 9).**
- "51 tools rewritten for the 13 tools" — this part cuts to 12; `ssh_find` (13th) is explicitly Plan 5, stated in the "deferred" section and the done criteria. The 12-tool registry/annotations/registration are complete and internally consistent (registry 12, annotations 12, `index.js` 12, asserted by `test-index-registration.js`'s `exactly 12 tools` test).
- "src/tool-registry.js and src/index.js registration rewritten for the 13 tools" — Tasks 1 and 4. `tool-config-manager.js` is *not* rewritten: confirmed by reading it that every reference (`getAllTools`, `findToolGroup`, `TOOL_GROUPS`, `TOOL_GROUP_COUNTS`) is generic over the registry data, so it tracks the new 12-tool data with zero code change. Its *test* needs the count/name fixes — Task 5.
- "Four suites coupled to tool names and registration are rewritten: test-index-registration, test-tool-registry, test-tool-annotations, test-tool-config-manager" — Tasks 1, 2, 4, 5 respectively. Each rewrite ships in the same task as the code it covers (registry→Task 1, annotations→Task 2, index registration→Task 4) so no task leaves `npm test` red.
- "~640 handler-level tests re-point to the same handler functions unchanged" — confirmed: the dispatchers and the registration cutover call the existing `src/tools/*.js` handlers; no handler file is edited in any Plan 4 part. The done criteria and Task 5 Step 4 both assert the handler-level suites pass untouched, with an explicit "do not patch the test, revert the handler change" instruction if one fails.
- "ssh_plan's steps dispatch table rewritten to the v4 namespace" — the `ssh_plan` registration threads `handleSshPlanTool` with handlers keyed `execute`/`executeSudo`/`upload`/... `buildPlanDispatch` (Part 2) maps those onto the plan-step action enum (`exec`/`exec_sudo`/...). The pre-v4 tool-name-keyed table is gone.
- "fat verb-tools: server + action enum + action-scoped args; every action-scoped arg optional" — every one of the 12 `inputSchema`s declares `action` as a `z.enum`, every action-scoped arg `.optional()`, and the dispatcher enforces the per-action required map. `server` is `z.string()` (required) on tools where every action needs it (`ssh_run`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_docker`) and `.optional()` where some actions do not (`ssh_logs` follow-read/stop, `ssh_session` non-start, `ssh_net` tunnel-list/close, `ssh_fleet`); the dispatcher's `requireArgs` still enforces `server` per-action for those. This matches "schema cannot express conditional-required; dispatcher checks".
- "selling descriptions naming the bash each tool replaces" — `ssh_run`, `ssh_file`, `ssh_logs` descriptions name `ssh host <cmd>` / `scp` / `ssh host journalctl`, per spec section 5. The remaining nine get functional descriptions (section 5's named-bash requirement is illustrated with the core tools; the others have no single bash equivalent).

**Placeholder scan.** Searched the draft for "TBD", "similar to Task", "add validation", "and so on", "...". The only `...` are in prose ranges ("roughly 640 tests") and never stand in for code. Task 4's registration block is the full 12-tool code, every schema field present. Task 5 is the one task expressed as a located-edit ("change X to Y") rather than a full file rewrite — justified because the file is large and only count/name literals change; each edit is concretely specified (which string, what new value) and Step 1 makes the agent `grep` the exact lines first. This is not a placeholder: the transformation is deterministic and bounded.

**Type consistency.**
- `registerToolConditional(name, schema, handler)` — confirmed by reading `index.js` line 430: `schema` is `{ description, inputSchema }` (plus optional `title`/`annotations`, here supplied by `withAnnotations`); `inputSchema` is a plain object of zod fields, not a `z.object(...)`. Every one of the 12 new registrations matches that shape.
- Every dispatcher handler returns an MCP `{ content, isError? }` object (Parts 1-2 established this). The `async (args) => handleSsh*({...})` wrappers return that directly. `registerToolConditional`'s `wrapped` passes `(args, extra)` through; the dispatchers ignore `extra` — acceptable, the abort-signal merge in `wrapped` still happens and lands in `args.abortSignal`, which the exec handlers already read.
- `DEPS.resolveGroup` returns `{ name, servers } | null` — matches what `handleSshExecuteGroup` expects (verified against the pre-v4 `ssh_execute_group` registration, which built the identical shape).
- `fleet-adapters.js` functions return `mcp(text, isError)` → `{ content:[{type:'text',text}], isError }` — the MCP shape. The `ssh_fleet` dispatcher wraps six of them as `({args}) => fleet*({args, deps})` and passes `handleSshKeyManage` directly for `keys`; `handleSshFleet` (Part 2) calls `handlers[action]({args})` for the inline ones and `handlers.keys(makeCtx('cfg',...))` for keys — the adapter closures accept `{args}`, `handleSshKeyManage` accepts the `cfg` ctx. Consistent.
- Test runner contract: `test-tool-registry.js` keeps its `Passed:/Failed:` Pattern-B output; the other three keep `N passed, M failed` Pattern A. Both are recognised by `scripts/run-tests.mjs`. The rewrites preserve each file's existing harness style.

**Issues found and fixed inline.**
1. First draft deleted `getServerConfigByName` along with the registration span. That function is defined just above the first `registerToolConditional` and is needed by `DEPS.getServerConfig`. Fixed: Task 4 Step 4 explicitly says keep `getServerConfigByName`, and the cut boundary is described as "first `registerToolConditional(` through the last registration's closing `);`" — `getServerConfigByName` sits above that boundary.
2. First draft gave `ssh_fleet` a `groups` adapter that forwarded `op` verbatim to `ssh_group_manage`, whose action enum is `create/update/delete/add-servers/remove-servers/list` — not `add/remove/update`. Fixed: `fleetGroups` in `fleet-adapters.js` translates the v4 `op` set onto that enum (`add`→create-group, `update`+members→add-servers, `remove`+members→remove-servers, `remove` w/o members→delete). This keeps the v4 `op` vocabulary uniform across `ssh_fleet` actions.
3. First draft's `ssh_fleet` schema omitted `op` values needed by `keys` and `connections` (`verify`/`accept`/`check`/`show`, `status`/`reconnect`/`disconnect`/`cleanup`). Fixed: the `op` enum is the union of every action's sub-operations; the dispatcher and adapters ignore values irrelevant to the chosen action.
4. `ssh_logs`/`ssh_session`/`ssh_net`/`ssh_fleet` `server` was initially `z.string()` (required). Their follow-read/stop, non-start session, tunnel-list/close, and most fleet actions take no server. Fixed: `server` is `.optional()` on those four tools; the per-action `requireArgs` map (Parts 1-2) still requires it for the actions that need it, so correctness is unchanged and the schema does not over-constrain.
