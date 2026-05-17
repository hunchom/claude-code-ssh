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
