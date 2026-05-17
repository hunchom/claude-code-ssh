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
