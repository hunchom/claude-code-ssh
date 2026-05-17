#!/usr/bin/env node
/**
 * Routing suite for the ssh_db v4 dispatcher (src/dispatchers/ssh-db.js).
 * Run: node tests/test-dispatcher-db.js
 */
import assert from 'assert';
import { handleSshDb } from '../src/dispatchers/ssh-db.js';

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

console.log('[test] Testing ssh_db dispatcher\n');

await test('query routes to handlers.query with db_type + query', async () => {
  const query = spy();
  await handleSshDb({
    deps: DEPS, handlers: { query },
    args: { server: 's', action: 'query', database: 'app', query: 'SELECT 1', db_type: 'mysql' },
  });
  assert.strictEqual(query.calls.length, 1);
  assert.strictEqual(query.calls[0].args.query, 'SELECT 1');
  assert.strictEqual(query.calls[0].args.db_type, 'mysql');
  assert.strictEqual(query.calls[0].getConnection, DEPS.getConnection);
});

await test('list routes to handlers.list (database optional)', async () => {
  const list = spy();
  await handleSshDb({
    deps: DEPS, handlers: { list },
    args: { server: 's', action: 'list', db_type: 'postgresql' },
  });
  assert.strictEqual(list.calls.length, 1);
  assert.strictEqual(list.calls[0].args.db_type, 'postgresql');
});

await test('dump routes to handlers.dump', async () => {
  const dump = spy();
  await handleSshDb({
    deps: DEPS, handlers: { dump },
    args: { server: 's', action: 'dump', database: 'app', output_file: '/tmp/a.sql' },
  });
  assert.strictEqual(dump.calls.length, 1);
  assert.strictEqual(dump.calls[0].args.output_file, '/tmp/a.sql');
});

await test('import routes to handlers.import, forwards preview', async () => {
  const importH = spy();
  await handleSshDb({
    deps: DEPS, handlers: { import: importH },
    args: { server: 's', action: 'import', database: 'app', input_file: '/tmp/a.sql', preview: true },
  });
  assert.strictEqual(importH.calls.length, 1);
  assert.strictEqual(importH.calls[0].args.input_file, '/tmp/a.sql');
  assert.strictEqual(importH.calls[0].args.preview, true);
});

await test('db credential args are forwarded', async () => {
  const query = spy();
  await handleSshDb({
    deps: DEPS, handlers: { query },
    args: {
      server: 's', action: 'query', database: 'app', query: 'SELECT 1',
      user: 'u', password: 'p', host: 'h', port: 5432,
    },
  });
  const fwd = query.calls[0].args;
  assert.strictEqual(fwd.user, 'u');
  assert.strictEqual(fwd.password, 'p');
  assert.strictEqual(fwd.host, 'h');
  assert.strictEqual(fwd.port, 5432);
});

await test('query missing query -> structured fail, handler not called', async () => {
  const query = spy();
  const r = await handleSshDb({
    deps: DEPS, handlers: { query },
    args: { server: 's', action: 'query', database: 'app' },
  });
  assert.strictEqual(query.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('query'));
});

await test('dump missing database -> structured fail', async () => {
  const r = await handleSshDb({
    deps: DEPS, handlers: { dump: spy() },
    args: { server: 's', action: 'dump' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('database'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshDb({ deps: DEPS, handlers: {}, args: { server: 's', action: 'truncate' } });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('truncate'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
