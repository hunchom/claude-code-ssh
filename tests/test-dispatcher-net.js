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
