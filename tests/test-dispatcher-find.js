#!/usr/bin/env node
/**
 * Routing + pipeline suite for the ssh_find v4 dispatcher
 * (src/dispatchers/ssh-find.js). A fake ssh2 client returns canned stdout so
 * the build -> exec -> parse -> render path is exercised without a network.
 * Run: node tests/test-dispatcher-find.js
 */
import assert from 'assert';
import { handleSshFind } from '../src/dispatchers/ssh-find.js';

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

// Fake ssh2 client: client.exec(cmd, cb) -> a stream emitting canned stdout.
// `script` records every command string the dispatcher runs.
function fakeClient(stdoutByMatch) {
  const script = [];
  const client = {
    exec(command, cb) {
      script.push(command);
      let chosen = '';
      for (const [needle, out] of stdoutByMatch) {
        if (command.includes(needle)) { chosen = out; break; }
      }
      const listeners = {};
      const stream = {
        stderr: { on() { return stream.stderr; } },
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return stream; },
        close() {},
        signal() {},
      };
      cb(null, stream);
      setImmediate(() => {
        for (const fn of listeners.data || []) fn(Buffer.from(chosen));
        for (const fn of listeners.close || []) fn(0, null);
      });
      return client;
    },
  };
  client.script = script;
  return client;
}

const depsWith = (client) => ({ getConnection: async () => client });

console.log('[test] Testing ssh_find dispatcher\n');

// --- arg validation ------------------------------------------------------
await test('missing action -> structured fail', async () => {
  const r = await handleSshFind({ deps: depsWith(fakeClient([])), args: { server: 's' } });
  assert.strictEqual(r.isError, true);
});

await test('unknown action -> structured fail naming the action', async () => {
  const r = await handleSshFind({
    deps: depsWith(fakeClient([])), args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

await test('grep without pattern -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'grep', path: '/srv' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('pattern'));
  assert.strictEqual(client.script.length, 0, 'no command run when args invalid');
});

await test('grep without server -> structured fail', async () => {
  const r = await handleSshFind({
    deps: depsWith(fakeClient([])), args: { action: 'grep', pattern: 'x', path: '/srv' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

// --- grep pipeline -------------------------------------------------------
await test('grep builds an rg/grep command and runs it through the client', async () => {
  const client = fakeClient([['rg', '/srv/app/main.js:42:const TODO = 1;\n']]);
  await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'TODO', path: '/srv/app' },
  });
  assert.strictEqual(client.script.length, 1, 'exactly one command run');
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'Plan-5 timeout wrapper preserved');
  assert(cmd.includes('command -v rg'), 'rg-preferred grep command');
  assert(cmd.includes("'TODO'"), 'pattern shell-quoted');
});

await test('grep parses file:line:text stdout into structured hits', async () => {
  const client = fakeClient([['rg',
    '/srv/app/main.js:42:const TODO = 1;\n/srv/app/util.js:7:// TODO refactor\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: {
      server: 's', action: 'grep', pattern: 'TODO', path: '/srv/app', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'grep');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.hits[0], {
    file: '/srv/app/main.js', line: 42, text: 'const TODO = 1;',
  });
});

await test('grep renders a hits table in the markdown face', async () => {
  const client = fakeClient([['rg', '/a/x.js:3:hit one\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'hit', path: '/a' },
  });
  assert.strictEqual(r.isError, false);
  const text = r.content[0].text;
  assert(text.includes('/a/x.js'), 'file path rendered');
  assert(text.includes('hit one'), 'match text rendered');
});

await test('grep with zero hits -> success, empty hit list', async () => {
  const client = fakeClient([['rg', '']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'nope', path: '/a', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.count, 0);
  assert.deepStrictEqual(res.data.hits, []);
});

await test('grep refusing bare root -> structured fail (Plan-5 guard surfaced)', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'x', path: '/' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('refusing to search'));
  assert.strictEqual(client.script.length, 0, 'builder threw before exec');
});

await test('grep allow_root threads through to the builder', async () => {
  const client = fakeClient([['rg', '']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'grep', pattern: 'x', path: '/', allow_root: true },
  });
  assert.strictEqual(r.isError, false, 'allow_root lets a / search through');
  assert.strictEqual(client.script.length, 1);
});

await test('a connection failure -> structured fail, not a throw', async () => {
  const deps = { getConnection: async () => { throw new Error('host down'); } };
  const r = await handleSshFind({
    deps, args: { server: 's', action: 'grep', pattern: 'x', path: '/a' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host down'));
});

// --- locate pipeline -----------------------------------------------------
await test('locate without name -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'locate', path: '/etc' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('name'));
  assert.strictEqual(client.script.length, 0);
});

await test('locate builds a timeout-wrapped find -name command', async () => {
  const client = fakeClient([['find', '/etc/nginx/nginx.conf\n']]);
  await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: '*.conf', path: '/etc' },
  });
  assert.strictEqual(client.script.length, 1);
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'timeout wrapper preserved');
  assert(cmd.includes('find '), 'uses find');
  assert(cmd.includes("-name '*.conf'"), 'name glob shell-quoted');
});

await test('locate parses one-path-per-line stdout into a path list', async () => {
  const client = fakeClient([['find',
    '/etc/nginx/nginx.conf\n/etc/ssl/openssl.conf\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: {
      server: 's', action: 'locate', name: '*.conf', path: '/etc', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.action, 'locate');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.paths,
    ['/etc/nginx/nginx.conf', '/etc/ssl/openssl.conf']);
});

await test('locate renders a path table in the markdown face', async () => {
  const client = fakeClient([['find', '/etc/hosts\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: 'hosts', path: '/etc' },
  });
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('/etc/hosts'), 'path rendered');
});

await test('locate refusing bare root -> structured fail', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'locate', name: 'x', path: '/' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('refusing to search'));
  assert.strictEqual(client.script.length, 0);
});

// --- ls pipeline ---------------------------------------------------------
await test('ls without path -> structured fail, never connects', async () => {
  const client = fakeClient([]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('path'));
  assert.strictEqual(client.script.length, 0);
});

await test('ls builds a timeout-wrapped ls -la command', async () => {
  const client = fakeClient([['ls -la', 'total 0\n']]);
  await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/var/log' },
  });
  assert.strictEqual(client.script.length, 1);
  const cmd = client.script[0];
  assert(cmd.startsWith('timeout '), 'timeout wrapper preserved');
  assert(cmd.includes("ls -la '/var/log'"), 'long listing, path shell-quoted');
});

await test('ls parses long-format rows into perms/size/type/name entries', async () => {
  const client = fakeClient([['ls -la',
    'total 12\n'
    + '-rw-r--r-- 1 root root 1024 May 17 10:00 app.conf\n'
    + 'drwxr-xr-x 2 root root 4096 May 16 09:30 logs\n']]);
  const r = await handleSshFind({
    deps: depsWith(client),
    args: { server: 's', action: 'ls', path: '/etc', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.action, 'ls');
  assert.strictEqual(res.data.count, 2);
  assert.deepStrictEqual(res.data.entries[0], {
    perms: '-rw-r--r--', size: '1024', name: 'app.conf', type: 'file',
  });
  assert.strictEqual(res.data.entries[1].type, 'dir');
});

await test('ls renders a perms/size/type/name table in the markdown face', async () => {
  const client = fakeClient([['ls -la',
    'total 0\n-rw-r--r-- 1 u g 9 May 17 10:00 notes.txt\n']]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/tmp' },
  });
  assert.strictEqual(r.isError, false);
  const text = r.content[0].text;
  assert(text.includes('notes.txt'), 'name rendered');
  assert(text.includes('perms'), 'header rendered');
});

await test('ls of bare root is allowed (Plan-5: listing / is cheap)', async () => {
  const client = fakeClient([['ls -la', 'total 0\n']]);
  const r = await handleSshFind({
    deps: depsWith(client), args: { server: 's', action: 'ls', path: '/' },
  });
  assert.strictEqual(r.isError, false, 'ls / is not refused');
  assert.strictEqual(client.script.length, 1);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
