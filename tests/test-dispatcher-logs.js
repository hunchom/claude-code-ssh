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
