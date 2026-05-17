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
