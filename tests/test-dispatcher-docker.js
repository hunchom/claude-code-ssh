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
