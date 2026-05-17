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
