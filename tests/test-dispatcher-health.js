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
    args: { server: 's', action: 'procs', proc_action: 'list' },
  });
  assert.strictEqual(processManager.calls.length, 1);
  assert.strictEqual(processManager.calls[0].args.action, 'list');
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
