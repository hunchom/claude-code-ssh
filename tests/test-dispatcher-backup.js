#!/usr/bin/env node
/**
 * Routing suite for the ssh_backup v4 dispatcher (src/dispatchers/ssh-backup.js).
 * Run: node tests/test-dispatcher-backup.js
 */
import assert from 'assert';
import { handleSshBackup } from '../src/dispatchers/ssh-backup.js';

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

console.log('[test] Testing ssh_backup dispatcher\n');

await test('create routes to handlers.create, maps backup_type', async () => {
  const create = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { create },
    args: { server: 's', action: 'create', backup_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(create.calls.length, 1);
  assert.strictEqual(create.calls[0].args.backup_type, 'mysql');
  assert.strictEqual(create.calls[0].getConnection, DEPS.getConnection);
});

await test('list routes to handlers.list', async () => {
  const list = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { list },
    args: { server: 's', action: 'list', backup_type: 'files' },
  });
  assert.strictEqual(list.calls.length, 1);
});

await test('restore routes to handlers.restore with backup_id + preview', async () => {
  const restore = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { restore },
    args: { server: 's', action: 'restore', backup_id: 'bk-1', preview: true },
  });
  assert.strictEqual(restore.calls.length, 1);
  assert.strictEqual(restore.calls[0].args.backup_id, 'bk-1');
  assert.strictEqual(restore.calls[0].args.preview, true);
});

await test('schedule routes to handlers.schedule with cron', async () => {
  const schedule = spy();
  await handleSshBackup({
    deps: DEPS, handlers: { schedule },
    args: { server: 's', action: 'schedule', cron: '0 3 * * *', backup_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(schedule.calls.length, 1);
  assert.strictEqual(schedule.calls[0].args.cron, '0 3 * * *');
});

await test('restore missing backup_id -> structured fail, handler not called', async () => {
  const restore = spy();
  const r = await handleSshBackup({
    deps: DEPS, handlers: { restore },
    args: { server: 's', action: 'restore' },
  });
  assert.strictEqual(restore.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('backup_id'));
});

await test('schedule missing cron -> structured fail', async () => {
  const r = await handleSshBackup({
    deps: DEPS, handlers: { schedule: spy() },
    args: { server: 's', action: 'schedule' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('cron'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshBackup({ deps: DEPS, handlers: {}, args: { server: 's', action: 'purge' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('purge'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
