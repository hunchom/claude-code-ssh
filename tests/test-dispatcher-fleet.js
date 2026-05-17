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
