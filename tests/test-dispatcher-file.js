#!/usr/bin/env node
/**
 * Routing suite for the ssh_file v4 dispatcher (src/dispatchers/ssh-file.js).
 * Run: node tests/test-dispatcher-file.js
 */
import assert from 'assert';
import { handleSshFile } from '../src/dispatchers/ssh-file.js';

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

const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => ({}),
  getSftp: () => 'SFTP',
};

console.log('[test] Testing ssh_file dispatcher\n');

// --- routing -------------------------------------------------------------
await test('upload routes to handlers.upload, maps local/remote_path', async () => {
  const upload = spy();
  await handleSshFile({
    deps: DEPS, handlers: { upload },
    args: { server: 's', action: 'upload', local_path: '/l', remote_path: '/r' },
  });
  assert.strictEqual(upload.calls.length, 1);
  assert.strictEqual(upload.calls[0].args.local_path, '/l');
  assert.strictEqual(upload.calls[0].args.remote_path, '/r');
  assert.strictEqual(upload.calls[0].getConnection, DEPS.getConnection);
});

await test('download routes to handlers.download', async () => {
  const download = spy();
  await handleSshFile({
    deps: DEPS, handlers: { download },
    args: { server: 's', action: 'download', local_path: '/l', remote_path: '/r' },
  });
  assert.strictEqual(download.calls.length, 1);
});

await test('sync routes to handlers.sync with getServerConfig in ctx', async () => {
  const sync = spy();
  await handleSshFile({
    deps: DEPS, handlers: { sync },
    args: { server: 's', action: 'sync', source: 'local:/a', destination: 'remote:/b' },
  });
  assert.strictEqual(sync.calls.length, 1);
  assert.strictEqual(sync.calls[0].getServerConfig, DEPS.getServerConfig);
  assert.strictEqual(sync.calls[0].args.source, 'local:/a');
});

await test('read routes to handlers.cat, maps remote_path -> file', async () => {
  const cat = spy();
  await handleSshFile({
    deps: DEPS, handlers: { cat },
    args: { server: 's', action: 'read', remote_path: '/etc/hosts', tail: 20 },
  });
  assert.strictEqual(cat.calls.length, 1);
  assert.strictEqual(cat.calls[0].args.file, '/etc/hosts');
  assert.strictEqual(cat.calls[0].args.tail, 20);
});

await test('write routes to handlers.edit with new_content set from content', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: { server: 's', action: 'write', remote_path: '/tmp/f', content: 'hello' },
  });
  assert.strictEqual(edit.calls.length, 1);
  assert.strictEqual(edit.calls[0].args.path, '/tmp/f');
  assert.strictEqual(edit.calls[0].args.new_content, 'hello');
});

await test('edit routes to handlers.edit, maps remote_path -> path', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: {
      server: 's', action: 'edit', remote_path: '/tmp/f',
      old_text: 'a', new_text: 'b',
    },
  });
  assert.strictEqual(edit.calls.length, 1);
  assert.strictEqual(edit.calls[0].args.path, '/tmp/f');
  // old_text is literal user text -> patch carries literal:true
  assert.deepStrictEqual(edit.calls[0].args.patch, [{ find: 'a', replace: 'b', literal: true }]);
});

await test('edit marks the patch literal so regex metachars in old_text match verbatim', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: {
      server: 's', action: 'edit', remote_path: '/tmp/f',
      old_text: 'a.b(c)[d]*?', new_text: 'X',
    },
  });
  const p = edit.calls[0].args.patch[0];
  assert.strictEqual(p.literal, true, 'literal flag set so applyPatches escapes the find');
  assert.strictEqual(p.find, 'a.b(c)[d]*?', 'find passed through unescaped -- applyPatches escapes it');
});

await test('edit without old_text or content -> routes, patch undefined', async () => {
  const edit = spy();
  await handleSshFile({
    deps: DEPS, handlers: { edit },
    args: { server: 's', action: 'edit', remote_path: '/tmp/f' },
  });
  assert.strictEqual(edit.calls.length, 1);
  assert.strictEqual(edit.calls[0].args.path, '/tmp/f');
  assert.strictEqual(edit.calls[0].args.patch, undefined);
});

await test('diff routes to handlers.diff', async () => {
  const diff = spy();
  await handleSshFile({
    deps: DEPS, handlers: { diff },
    args: { server: 's', action: 'diff', path_a: '/a', path_b: '/b' },
  });
  assert.strictEqual(diff.calls.length, 1);
  assert.strictEqual(diff.calls[0].args.path_a, '/a');
});

await test('deploy routes to handlers.deploy with getSftp in ctx', async () => {
  const deploy = spy();
  await handleSshFile({
    deps: DEPS, handlers: { deploy },
    args: {
      server: 's', action: 'deploy',
      artifact_local_path: '/a', target_path: '/t',
    },
  });
  assert.strictEqual(deploy.calls.length, 1);
  assert.strictEqual(deploy.calls[0].getSftp, DEPS.getSftp);
  assert.strictEqual(deploy.calls[0].args.artifact_local_path, '/a');
});

await test('deploy-artifact routes to handlers.deploy', async () => {
  const deploy = spy();
  await handleSshFile({
    deps: DEPS, handlers: { deploy },
    args: {
      server: 's', action: 'deploy-artifact',
      artifact_local_path: '/a', target_path: '/t',
    },
  });
  assert.strictEqual(deploy.calls.length, 1);
});

// --- arg validation ------------------------------------------------------
await test('upload missing local_path -> structured fail, handler not called', async () => {
  const upload = spy();
  const r = await handleSshFile({
    deps: DEPS, handlers: { upload },
    args: { server: 's', action: 'upload', remote_path: '/r' },
  });
  assert.strictEqual(upload.calls.length, 0);
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('local_path'));
});

await test('write missing content -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: { edit: spy() },
    args: { server: 's', action: 'write', remote_path: '/tmp/f' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('content'));
});

await test('sync missing destination -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: { sync: spy() },
    args: { server: 's', action: 'sync', source: 'local:/a' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('destination'));
});

await test('unknown action -> structured fail', async () => {
  const r = await handleSshFile({
    deps: DEPS, handlers: {},
    args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
