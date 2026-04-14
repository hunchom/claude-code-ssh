#!/usr/bin/env node
/**
 * Tests for src/tools/exec-tools.js -- mocks getConnection/getServerConfig/resolveGroup.
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import {
  handleSshExecute,
  handleSshExecuteSudo,
  handleSshExecuteGroup,
} from '../src/tools/exec-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- Fake ssh2 client ----------------------------------------------------
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = []; this.endCalls = 0; this.signals = [];
  }
  write(d) { this.writes.push(String(d)); return true; }
  end() { this.endCalls++; }
  signal(n) { this.signals.push(n); }
  close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) {
    this.script = script || (() => ({ stdout: '', stderr: '', code: 0 }));
    this.streams = [];
    this.lastCommand = null;
  }
  exec(cmd, cb) {
    this.lastCommand = cmd;
    const s = new FakeStream();
    this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      // Drive the scripted response
      const { stdout, stderr, code, delay = 0, execError } = this.script(cmd);
      if (execError) { s.emit('error', execError); return; }
      setTimeout(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code || 0);
      }, delay);
    });
  }
}

console.log('[test] Testing exec-tools\n');

// --------------------------------------------------------------------------
// ssh_execute
// --------------------------------------------------------------------------
await test('ssh_execute: success renders [ok] marker + exit 0', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'hi\n', code: 0 }) });
  const r = await handleSshExecute({
    getConnection: async () => client,
    args: { server: 'prod01', command: 'echo hi', cwd: '/var/app' },
  });
  assert.strictEqual(r.isError, undefined);
  const md = r.content[0].text;
  assert(md.startsWith('[ok] **ssh_execute**'));
  assert(md.includes('exit 0'));
  assert(md.includes('hi'));
});

await test('ssh_execute: cwd shell-safely quoted in remote command', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'ok', code: 0 }) });
  await handleSshExecute({
    getConnection: async () => client,
    args: { server: 's', command: 'ls', cwd: '/tmp; rm -rf /' },
  });
  assert.strictEqual(client.lastCommand, "cd '/tmp; rm -rf /' && ls");
});

await test('ssh_execute: non-zero exit renders [err] marker (not isError)', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', stderr: 'nope', code: 127 }) });
  const r = await handleSshExecute({
    getConnection: async () => client,
    args: { server: 's', command: 'missing' },
  });
  assert.strictEqual(r.isError, undefined, 'non-zero is not tool-level error');
  assert(r.content[0].text.startsWith('[err] **ssh_execute**'));
  assert(r.content[0].text.includes('exit 127'));
});

await test('ssh_execute: connection failure -> isError with stderr explanation', async () => {
  const r = await handleSshExecute({
    getConnection: async () => { throw new Error('host unreachable'); },
    args: { server: 's', command: 'x' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host unreachable'));
});

await test('ssh_execute: preview:true returns dry-run card, does NOT call getConnection', async () => {
  let called = false;
  const r = await handleSshExecute({
    getConnection: async () => { called = true; throw new Error('should not be called'); },
    args: { server: 'prod01', command: 'rm -rf /', preview: true },
  });
  assert.strictEqual(called, false, 'getConnection must not be called in preview');
  assert(r.content[0].text.includes('dry run'));
  assert(r.content[0].text.includes('"action": "exec"'));
  assert(r.content[0].text.includes('prod01'));
});

await test('ssh_execute: format:json returns JSON-only content', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'x', code: 0 }) });
  const r = await handleSshExecute({
    getConnection: async () => client,
    args: { server: 's', command: 'c', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.exit_code, 0);
  assert.strictEqual(parsed.stdout, 'x');
});

// --------------------------------------------------------------------------
// ssh_execute_sudo
// --------------------------------------------------------------------------
await test('ssh_execute_sudo: password written to stdin, NEVER in argv', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'root', code: 0 }) });
  const secret = 'p@ss$w0rd"`'; // contains shell metachars that would break echo-pipe
  const r = await handleSshExecuteSudo({
    getConnection: async () => client,
    getServerConfig: async () => ({}),
    args: { server: 's', command: 'whoami', password: secret },
  });
  assert.strictEqual(r.isError, undefined);
  assert(!client.lastCommand.includes(secret), 'password MUST NOT appear in argv');
  assert(!client.lastCommand.includes('p@ss'), 'no password fragment in argv');
  assert(client.lastCommand.startsWith('sudo -S -p '));
  assert(client.lastCommand.includes('-- whoami'));
  assert.deepStrictEqual(client.streams[0].writes, [secret + '\n']);
  assert.strictEqual(client.streams[0].endCalls, 1);
});

await test('ssh_execute_sudo: leading "sudo " in command is stripped', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  await handleSshExecuteSudo({
    getConnection: async () => client,
    getServerConfig: async () => ({}),
    args: { server: 's', command: 'sudo systemctl restart nginx', password: 'pw' },
  });
  assert(client.lastCommand.endsWith('-- systemctl restart nginx'));
  // Must not have 'sudo sudo'
  assert(!client.lastCommand.includes('sudo sudo'));
});

await test('ssh_execute_sudo: uses config sudoPassword when arg omitted', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  await handleSshExecuteSudo({
    getConnection: async () => client,
    getServerConfig: async () => ({ sudoPassword: 'config-pass' }),
    args: { server: 's', command: 'whoami' },
  });
  assert.deepStrictEqual(client.streams[0].writes, ['config-pass\n']);
});

await test('ssh_execute_sudo: empty password when none available (passwordless sudo)', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  await handleSshExecuteSudo({
    getConnection: async () => client,
    getServerConfig: async () => ({}),
    args: { server: 's', command: 'whoami' },
  });
  assert.deepStrictEqual(client.streams[0].writes, ['\n']);
});

await test('ssh_execute_sudo: command starting with -- still works via explicit "--" separator', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  await handleSshExecuteSudo({
    getConnection: async () => client,
    getServerConfig: async () => ({}),
    args: { server: 's', command: '--help', password: 'pw' },
  });
  assert(client.lastCommand.includes('-- --help'), '-- guards sudo option parsing');
});

await test('ssh_execute_sudo: preview returns high-risk dry-run, never calls remote', async () => {
  let called = false;
  const r = await handleSshExecuteSudo({
    getConnection: async () => { called = true; throw new Error('no'); },
    getServerConfig: async () => { called = true; throw new Error('no'); },
    args: { server: 'prod01', command: 'rm -rf /', preview: true },
  });
  assert.strictEqual(called, false);
  const md = r.content[0].text;
  assert(md.includes('"action": "exec-sudo"'));
  assert(md.includes('"risk": "high"'));
  assert(md.includes('password never enters argv'));
});

// --------------------------------------------------------------------------
// ssh_execute_group
// --------------------------------------------------------------------------
await test('ssh_execute_group: runs on all servers, aggregates ok/fail counts', async () => {
  const clients = {
    s1: new FakeClient({ script: () => ({ stdout: 'ok1', code: 0 }) }),
    s2: new FakeClient({ script: () => ({ stdout: '', stderr: 'bad', code: 1 }) }),
    s3: new FakeClient({ script: () => ({ stdout: 'ok3', code: 0 }) }),
  };
  const r = await handleSshExecuteGroup({
    getConnection: async (s) => clients[s],
    resolveGroup: async () => ['s1', 's2', 's3'],
    args: { group: 'web', command: 'uptime', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, 'group call succeeds even when individual servers fail');
  assert.strictEqual(parsed.data.total, 3);
  assert.strictEqual(parsed.data.succeeded, 2);
  assert.strictEqual(parsed.data.failed, 1);
  assert.deepStrictEqual(parsed.data.results.map(r => r.server), ['s1', 's2', 's3']);
});

await test('ssh_execute_group: markdown render shows per-server mini-cards', async () => {
  const c1 = new FakeClient({ script: () => ({ stdout: 'alpha', code: 0 }) });
  const c2 = new FakeClient({ script: () => ({ stdout: 'beta', code: 0 }) });
  const r = await handleSshExecuteGroup({
    getConnection: async (s) => (s === 'a' ? c1 : c2),
    resolveGroup: async () => ['a', 'b'],
    args: { group: 'pair', command: 'hostname' },
  });
  const md = r.content[0].text;
  assert(md.includes('[ok] **ssh_execute_group**'));
  assert(md.includes('2/2 ok'));
  assert(md.includes('`a`'));
  assert(md.includes('`b`'));
  assert(md.includes('alpha'));
  assert(md.includes('beta'));
});

await test('ssh_execute_group: connection failure on one server reported as per-server error', async () => {
  const good = new FakeClient({ script: () => ({ stdout: 'ok', code: 0 }) });
  const r = await handleSshExecuteGroup({
    getConnection: async (s) => {
      if (s === 'dead') throw new Error('timed out');
      return good;
    },
    resolveGroup: async () => ['alive', 'dead'],
    args: { group: 'x', command: 'uptime', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.succeeded, 1);
  assert.strictEqual(parsed.data.failed, 1);
  const dead = parsed.data.results.find(r => r.server === 'dead');
  assert(dead.stderr.includes('timed out') || dead.error?.includes('timed out'));
});

await test('ssh_execute_group: concurrency caps parallelism', async () => {
  let inFlight = 0, peak = 0;
  const mkClient = () => ({
    exec(cmd, cb) {
      inFlight++; peak = Math.max(peak, inFlight);
      const s = new FakeStream();
      setImmediate(() => {
        cb(null, s);
        setTimeout(() => {
          s.emit('data', Buffer.from('hi'));
          s.emit('close', 0);
          inFlight--;
        }, 20);
      });
    },
  });
  await handleSshExecuteGroup({
    getConnection: async () => mkClient(),
    resolveGroup: async () => ['a','b','c','d','e','f'],
    args: { group: 'six', command: 'c', concurrency: 2, format: 'json' },
  });
  assert(peak <= 2, `expected peak <= 2, got ${peak}`);
});

await test('ssh_execute_group: empty group returns structured failure', async () => {
  const r = await handleSshExecuteGroup({
    getConnection: async () => { throw new Error('nope'); },
    resolveGroup: async () => [],
    args: { group: 'empty', command: 'x' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('has no servers'));
});

await test('ssh_execute_group: preview shows fan-out plan, never connects', async () => {
  let called = false;
  const r = await handleSshExecuteGroup({
    getConnection: async () => { called = true; throw new Error('no'); },
    resolveGroup: async () => ['s1', 's2'],
    args: { group: 'web', command: 'reboot', preview: true },
  });
  assert.strictEqual(called, false);
  assert(r.content[0].text.includes('dry run'));
  assert(r.content[0].text.includes('"action": "exec-group"'));
  assert(r.content[0].text.includes('s1, s2'));
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
