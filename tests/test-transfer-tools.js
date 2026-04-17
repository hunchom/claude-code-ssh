#!/usr/bin/env node
/**
 * Tests for src/tools/transfer-tools.js -- mocks getConnection / sftp / rsync spawn.
 *
 * Coverage:
 *   - ssh_upload: happy, verify match, verify mismatch, preview stat, preview no-op, local missing
 *   - ssh_download: mirror of upload
 *   - ssh_sync: argv shape, exclude, dry_run, preview, keypath vs password auth
 *   - ssh_diff: same-server diff -u, cross-server downloads both + local diff, preview
 *   - ssh_edit: preview plan+stat, full-replace flow with base64+mv, syntax check dispatch,
 *               syntax failure cleans tmp, backup path recorded, patch regex mode,
 *               path-shell-quoting fail-safe
 */

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import {
  handleSshUpload,
  handleSshDownload,
  handleSshSync,
  handleSshDiff,
  handleSshEdit,
  buildRsyncArgv,
} from '../src/tools/transfer-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

// --- Fake ssh2 client (exec + sftp) --------------------------------------
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = []; this.endCalls = 0;
  }
  write(d) { this.writes.push(String(d)); return true; }
  end() { this.endCalls++; }
  signal() {}
  close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}

class FakeSftp {
  constructor() {
    this.fastPutCalls = [];
    this.fastGetCalls = [];
    this.fastPutImpl = null; // override in tests
    this.fastGetImpl = null;
  }
  fastPut(local, remote, cb) {
    this.fastPutCalls.push({ local, remote });
    if (this.fastPutImpl) return this.fastPutImpl(local, remote, cb);
    setImmediate(() => cb(null));
  }
  fastGet(remote, local, cb) {
    this.fastGetCalls.push({ remote, local });
    if (this.fastGetImpl) return this.fastGetImpl(remote, local, cb);
    setImmediate(() => cb(null));
  }
}

class FakeClient {
  constructor({ script, sftp } = {}) {
    this.script = script || (() => ({ stdout: '', stderr: '', code: 0 }));
    this.commands = [];
    this.streams = [];
    this._sftp = sftp || new FakeSftp();
    this.sftpCalls = 0;
  }
  exec(cmd, cb) {
    this.commands.push(cmd);
    const s = new FakeStream();
    this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      const out = this.script(cmd, this.commands.length - 1) || {};
      const { stdout = '', stderr = '', code = 0, delay = 0, execError } = out;
      if (execError) return s.emit('error', execError);
      setTimeout(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code);
      }, delay);
    });
  }
  sftp(cb) {
    this.sftpCalls++;
    setImmediate(() => cb(null, this._sftp));
  }
}

// Helper: make a tmp file with known content, return {path, sha256}
function mkTmpFile(content = 'hello world\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshmgr-test-'));
  const p = path.join(dir, 'f');
  fs.writeFileSync(p, content);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { path: p, dir, sha256: hash, bytes: Buffer.byteLength(content) };
}

function cleanupPath(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
}

console.log('[test] Testing transfer-tools\n');

// --------------------------------------------------------------------------
// ssh_upload
// --------------------------------------------------------------------------
await test('ssh_upload: happy path calls fastPut with (local,remote) and reports bytes', async () => {
  const t = mkTmpFile('alpha');
  try {
    const client = new FakeClient({
      script: (cmd) => cmd.startsWith('sha256sum ')
        ? { stdout: t.sha256 + '\n', code: 0 }
        : { stdout: '', code: 0 },
    });
    const r = await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/srv/x', format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true, parsed.error);
    assert.strictEqual(client._sftp.fastPutCalls.length, 1);
    assert.strictEqual(client._sftp.fastPutCalls[0].local, t.path);
    assert.strictEqual(client._sftp.fastPutCalls[0].remote, '/srv/x');
    assert.strictEqual(parsed.data.uploaded_bytes, t.bytes);
    assert.strictEqual(parsed.data.verified, true);
    assert.strictEqual(parsed.data.local_sha256, t.sha256);
    assert.strictEqual(parsed.data.remote_sha256, t.sha256);
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: verify=true calls sha256sum with shell-quoted path', async () => {
  const t = mkTmpFile('data');
  try {
    const client = new FakeClient({
      script: () => ({ stdout: t.sha256 + '\n', code: 0 }),
    });
    await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: "/etc/odd'name", format: 'json' },
    });
    // The hash command should contain the quoted remote path (single-quoted with escape)
    const hashCmd = client.commands.find(c => c.startsWith('sha256sum '));
    assert(hashCmd, 'expected sha256sum command');
    assert(hashCmd.includes("'/etc/odd'\\''name'"), `quote not applied: ${hashCmd}`);
    assert(hashCmd.endsWith("awk '{print $1}'"));
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: verify mismatch -> structured fail, isError true', async () => {
  const t = mkTmpFile('original');
  try {
    const client = new FakeClient({
      script: (cmd) => cmd.startsWith('sha256sum ')
        ? { stdout: 'deadbeef\n', code: 0 } // wrong hash
        : { stdout: '', code: 0 },
    });
    const r = await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/x', format: 'json' },
    });
    assert.strictEqual(r.isError, true);
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert(parsed.error.includes('checksum mismatch'));
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: verify=false skips sha256sum call entirely', async () => {
  const t = mkTmpFile('skip');
  try {
    const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
    const r = await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/y', verify: false, format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.verified, false);
    assert.strictEqual(client.commands.filter(c => c.startsWith('sha256sum')).length, 0);
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: preview shows remote stat + never calls sftp/fastPut', async () => {
  const t = mkTmpFile('preview');
  try {
    const client = new FakeClient({
      script: (cmd) => cmd.startsWith('stat ')
        ? { stdout: '42 1700000000\n', code: 0 }
        : { stdout: '', code: 0 },
    });
    const r = await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/target', preview: true, format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.preview, true);
    assert.strictEqual(parsed.data.plan.action, 'upload');
    assert.strictEqual(parsed.data.plan.remote_stat, '42 1700000000');
    assert.strictEqual(client._sftp.fastPutCalls.length, 0, 'fastPut must not be called');
    // stat uses `stat -c '%s %Y' REMOTE 2>/dev/null || echo "new file"`
    const statCmd = client.commands.find(c => c.startsWith('stat '));
    assert(statCmd, 'expected stat command');
    assert(statCmd.includes("'/target'"));
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: preview with brand-new remote file falls back to "new file" stat', async () => {
  const t = mkTmpFile('p2');
  try {
    const client = new FakeClient({
      script: (cmd) => cmd.startsWith('stat ')
        ? { stdout: 'new file\n', code: 0 }
        : { stdout: '', code: 0 },
    });
    const r = await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/new', preview: true, format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.data.plan.remote_stat, 'new file');
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: preview never calls getConnection for sftp (no fastPut)', async () => {
  const t = mkTmpFile('pv');
  try {
    let sftpInvoked = 0;
    const sftp = new FakeSftp();
    const client = new FakeClient({ script: () => ({ stdout: 'new file', code: 0 }), sftp });
    // intercept sftp()
    const origSftp = client.sftp.bind(client);
    client.sftp = function (cb) { sftpInvoked++; return origSftp(cb); };
    await handleSshUpload({
      getConnection: async () => client,
      args: { server: 's', local_path: t.path, remote_path: '/z', preview: true, format: 'json' },
    });
    assert.strictEqual(sftpInvoked, 0, 'sftp() must not be invoked in preview');
  } finally { cleanupPath(t.dir); }
});

await test('ssh_upload: missing local_path returns structured failure (no connection)', async () => {
  let called = false;
  const r = await handleSshUpload({
    getConnection: async () => { called = true; throw new Error('should not connect'); },
    args: { server: 's', local_path: '/does/not/exist/here.bin', remote_path: '/x', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('local file not accessible'));
});

await test('ssh_upload: required args validation (missing remote_path)', async () => {
  const r = await handleSshUpload({
    getConnection: async () => ({}),
    args: { server: 's', local_path: '/tmp/x', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('required'));
});

// --------------------------------------------------------------------------
// ssh_download
// --------------------------------------------------------------------------
await test('ssh_download: happy path calls fastGet(remote,local) in that order', async () => {
  const content = 'downloaded content';
  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdl-'));
  const localDest = path.join(dir, 'out');
  try {
    const sftp = new FakeSftp();
    sftp.fastGetImpl = (remote, local, cb) => {
      fs.writeFileSync(local, content);
      cb(null);
    };
    const client = new FakeClient({
      sftp,
      script: () => ({ stdout: expectedHash + '\n', code: 0 }),
    });
    const r = await handleSshDownload({
      getConnection: async () => client,
      args: { server: 's', remote_path: '/srv/source', local_path: localDest, format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true, parsed.error);
    assert.strictEqual(sftp.fastGetCalls.length, 1);
    assert.strictEqual(sftp.fastGetCalls[0].remote, '/srv/source');
    assert.strictEqual(sftp.fastGetCalls[0].local, localDest);
    assert.strictEqual(parsed.data.verified, true);
    assert.strictEqual(parsed.data.downloaded_bytes, Buffer.byteLength(content));
  } finally { cleanupPath(dir); }
});

await test('ssh_download: sha256 mismatch -> isError with diagnostic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdl-'));
  const localDest = path.join(dir, 'out');
  try {
    const sftp = new FakeSftp();
    sftp.fastGetImpl = (remote, local, cb) => {
      fs.writeFileSync(local, 'actual');
      cb(null);
    };
    const client = new FakeClient({
      sftp,
      script: () => ({ stdout: 'mismatchedhash\n', code: 0 }),
    });
    const r = await handleSshDownload({
      getConnection: async () => client,
      args: { server: 's', remote_path: '/r', local_path: localDest, format: 'json' },
    });
    assert.strictEqual(r.isError, true);
    const parsed = JSON.parse(r.content[0].text);
    assert(parsed.error.includes('checksum mismatch'));
  } finally { cleanupPath(dir); }
});

await test('ssh_download: preview shows stat, never fetches', async () => {
  const sftp = new FakeSftp();
  const client = new FakeClient({
    sftp,
    script: () => ({ stdout: '100 1700000100', code: 0 }),
  });
  const r = await handleSshDownload({
    getConnection: async () => client,
    args: { server: 's', remote_path: '/r', local_path: '/tmp/out', preview: true, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.preview, true);
  assert.strictEqual(parsed.data.plan.action, 'download');
  assert.strictEqual(sftp.fastGetCalls.length, 0);
});

await test('ssh_download: verify=false skips sha256 entirely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdl-'));
  const localDest = path.join(dir, 'f');
  try {
    const sftp = new FakeSftp();
    sftp.fastGetImpl = (remote, local, cb) => {
      fs.writeFileSync(local, 'data');
      cb(null);
    };
    const client = new FakeClient({ sftp, script: () => ({ stdout: '', code: 0 }) });
    const r = await handleSshDownload({
      getConnection: async () => client,
      args: { server: 's', remote_path: '/r', local_path: localDest, verify: false, format: 'json' },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(client.commands.filter(c => c.startsWith('sha256sum')).length, 0);
  } finally { cleanupPath(dir); }
});

await test('ssh_download: fastGet error -> isError', async () => {
  const sftp = new FakeSftp();
  sftp.fastGetImpl = (remote, local, cb) => cb(new Error('remote missing'));
  const client = new FakeClient({ sftp, script: () => ({ stdout: 'hash', code: 0 }) });
  const r = await handleSshDownload({
    getConnection: async () => client,
    args: { server: 's', remote_path: '/r', local_path: '/tmp/dl', format: 'json', verify: false },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('download failed') || parsed.error.includes('remote missing'));
});

// --------------------------------------------------------------------------
// ssh_sync
// --------------------------------------------------------------------------
await test('buildRsyncArgv: keyPath auth yields direct rsync with -i key (canonical field)', () => {
  const argv = buildRsyncArgv({
    serverConfig: { user: 'u', host: 'h', keyPath: '/k' },
    direction: 'push', localPath: '/src', remotePath: '/dst',
    exclude: [], dry_run: false, delete: false, compress: true,
  });
  assert.strictEqual(argv[0], '-avz');
  const eIdx = argv.indexOf('-e');
  assert(eIdx > -1);
  const sshCmd = argv[eIdx + 1];
  assert(sshCmd.includes('-o BatchMode=yes'));
  assert(sshCmd.includes('-i /k'));
  assert(argv[argv.length - 2] === '/src');
  assert(argv[argv.length - 1] === 'u@h:/dst');
});

await test('buildRsyncArgv: keypath (legacy alias) still accepted for backward compat', () => {
  const argv = buildRsyncArgv({
    serverConfig: { user: 'u', host: 'h', keypath: '/legacy' },
    direction: 'push', localPath: '/s', remotePath: '/d',
  });
  const eIdx = argv.indexOf('-e');
  assert(argv[eIdx + 1].includes('-i /legacy'),
    'legacy lowercase keypath field should resolve the same as keyPath');
});

await test('buildRsyncArgv: password auth is NOT embedded in argv (regression: no secret leak via ps aux)', () => {
  const argv = buildRsyncArgv({
    serverConfig: { user: 'u', host: 'h', password: 'sekret' },
    direction: 'push', localPath: '/s', remotePath: '/d',
  });
  // Password must not appear anywhere in the rsync argv. The handler uses
  // `sshpass -e` + SSHPASS env var -- proven by the ssh_sync test below.
  for (const v of argv) {
    assert(!String(v).includes('sekret'),
      `password leaked into rsync argv: ${JSON.stringify(argv)}`);
  }
  assert.strictEqual(argv[0], '-avz'); // pure rsync flags, no sshpass prefix
});

await test('buildRsyncArgv: exclude + dry_run + delete flags honored', () => {
  const argv = buildRsyncArgv({
    serverConfig: { user: 'u', host: 'h', keypath: '/k' },
    direction: 'pull', localPath: '/l', remotePath: '/r',
    exclude: ['.git', 'node_modules'], dry_run: true, delete: true, compress: false,
  });
  assert(argv.includes('--dry-run'));
  assert(argv.includes('--delete'));
  assert.strictEqual(argv[0], '-av'); // no z
  // Each --exclude appears with its pattern
  for (const pat of ['.git', 'node_modules']) {
    const i = argv.indexOf('--exclude');
    assert(i > -1 && argv.includes(pat));
    // verify pairing at least once
    assert(argv.filter((v, idx) => v === '--exclude' && argv[idx + 1] === pat).length >= 1);
  }
  // pull: remote first, local last
  assert.strictEqual(argv[argv.length - 2], 'u@h:/r');
  assert.strictEqual(argv[argv.length - 1], '/l');
});

await test('ssh_sync: preview shows direction + target without spawning rsync', async () => {
  let spawned = 0;
  const r = await handleSshSync({
    getConnection: async () => { throw new Error('no'); },
    getServerConfig: async () => ({ user: 'u', host: 'h', keypath: '/k' }),
    args: {
      server: 's', source: 'local:/l', destination: 'remote:/r',
      preview: true, format: 'json',
      spawnFn: () => { spawned++; throw new Error('must not spawn'); },
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.preview, true);
  assert.strictEqual(parsed.data.plan.action, 'sync');
  assert.strictEqual(spawned, 0);
});

await test('ssh_sync: spawn called with rsync + parsed stats on success', async () => {
  const fakeOut = [
    'sending incremental file list',
    '',
    'Number of files transferred: 7',
    'Total transferred file size: 12,345 bytes',
    '',
  ].join('\n');

  const spawnCalls = [];
  const fakeSpawn = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from(fakeOut));
      proc.emit('close', 0);
    });
    return proc;
  };

  const r = await handleSshSync({
    getConnection: async () => ({}),
    getServerConfig: async () => ({ user: 'u', host: 'h', keypath: '/k' }),
    args: {
      server: 'prod', source: 'local:/app', destination: 'remote:/srv/app',
      format: 'json',
      spawnFn: fakeSpawn,
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, parsed.error);
  assert.strictEqual(spawnCalls.length, 1);
  assert.strictEqual(spawnCalls[0].cmd, 'rsync');
  assert.strictEqual(parsed.data.files_transferred, 7);
  assert.strictEqual(parsed.data.bytes_transferred, 12345);
  assert.strictEqual(parsed.data.direction, 'push');
});

await test('ssh_sync: non-zero exit -> structured failure', async () => {
  const fakeSpawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('permission denied'));
      proc.emit('close', 23);
    });
    return proc;
  };
  const r = await handleSshSync({
    getConnection: async () => ({}),
    getServerConfig: async () => ({ user: 'u', host: 'h', keypath: '/k' }),
    args: {
      server: 's', source: 'local:/l', destination: 'remote:/r',
      format: 'json', spawnFn: fakeSpawn,
    },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('rsync exited 23'));
});

await test('ssh_sync: same-prefix source/dest rejected with helpful error', async () => {
  const r = await handleSshSync({
    getConnection: async () => ({}),
    getServerConfig: async () => ({}),
    args: { server: 's', source: 'local:/a', destination: 'local:/b', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('one local + one remote'));
});

await test('ssh_sync: password config drives `sshpass -e rsync ...` with SSHPASS env (no secret in argv)', async () => {
  const spawnCalls = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => proc.emit('close', 0));
    return proc;
  };
  await handleSshSync({
    getConnection: async () => ({}),
    getServerConfig: async () => ({ user: 'u', host: 'h', password: 'pw' }),
    args: {
      server: 's', source: 'local:/s', destination: 'remote:/d',
      format: 'json', spawnFn: fakeSpawn,
    },
  });
  const call = spawnCalls[0];
  assert.strictEqual(call.cmd, 'sshpass');
  assert.strictEqual(call.args[0], '-e', 'sshpass must read password from SSHPASS env, not argv');
  assert.strictEqual(call.args[1], 'rsync');
  // Password must not be in argv at all
  for (const a of call.args) {
    assert(!String(a).includes('pw'), `password leaked into argv: ${JSON.stringify(call.args)}`);
  }
  assert.strictEqual(call.opts.env.SSHPASS, 'pw', 'SSHPASS must be set in spawn env');
});

// --------------------------------------------------------------------------
// ssh_diff
// --------------------------------------------------------------------------
await test('ssh_diff: same-server builds `diff -u A B` with quoted paths', async () => {
  const client = new FakeClient({
    script: () => ({ stdout: '--- a\n+++ b\n@@\n-old\n+new\n', code: 1 }),
  });
  const r = await handleSshDiff({
    getConnection: async () => client,
    args: { server: 's', path_a: '/etc/a.conf', path_b: '/etc/b.conf', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.mode, 'same-server');
  assert.strictEqual(parsed.data.identical, false);
  assert(client.commands[0].startsWith("diff -u '/etc/a.conf' '/etc/b.conf'"));
});

await test('ssh_diff: identical files -> identical:true on exit 0', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  const r = await handleSshDiff({
    getConnection: async () => client,
    args: { server: 's', path_a: '/a', path_b: '/b', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.identical, true);
});

await test('ssh_diff: cross-server downloads both paths via sftp', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'diffA-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'diffB-'));
  try {
    const sftpA = new FakeSftp();
    sftpA.fastGetImpl = (remote, local, cb) => { fs.writeFileSync(local, 'A-content\n'); cb(null); };
    const sftpB = new FakeSftp();
    sftpB.fastGetImpl = (remote, local, cb) => { fs.writeFileSync(local, 'B-content\n'); cb(null); };
    const clients = {
      srv1: new FakeClient({ sftp: sftpA, script: () => ({ stdout: '', code: 0 }) }),
      srv2: new FakeClient({ sftp: sftpB, script: () => ({ stdout: '', code: 0 }) }),
    };
    const r = await handleSshDiff({
      getConnection: async (s) => clients[s],
      args: {
        server: 'srv1', server_b: 'srv2',
        path_a: '/x/a', path_b: '/y/b',
        format: 'json',
      },
    });
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true, parsed.error);
    assert.strictEqual(parsed.data.mode, 'cross-server');
    assert.strictEqual(parsed.data.identical, false, 'A vs B should differ');
    assert(parsed.data.stdout.includes('A-content') || parsed.data.stdout.includes('B-content'));
    assert.strictEqual(sftpA.fastGetCalls[0].remote, '/x/a');
    assert.strictEqual(sftpB.fastGetCalls[0].remote, '/y/b');
  } finally { cleanupPath(dirA); cleanupPath(dirB); }
});

await test('ssh_diff: preview returns plan without connecting', async () => {
  let called = false;
  const r = await handleSshDiff({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', path_a: '/a', path_b: '/b', preview: true, format: 'json' },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.preview, true);
  assert.strictEqual(parsed.data.plan.action, 'diff');
});

await test('ssh_diff: missing path_b -> structured failure', async () => {
  const r = await handleSshDiff({
    getConnection: async () => ({}),
    args: { server: 's', path_a: '/a', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('required'));
});

// --------------------------------------------------------------------------
// ssh_edit
// --------------------------------------------------------------------------
await test('ssh_edit: preview shows plan + stat + bytes, never mutates', async () => {
  const client = new FakeClient({
    script: (cmd) => cmd.startsWith('stat ')
      ? { stdout: '200 1700001000\n', code: 0 }
      : { stdout: '', code: 0 },
  });
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/app.json',
      new_content: '{"a":1}',
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.preview, true);
  assert.strictEqual(parsed.data.plan.action, 'edit');
  assert.strictEqual(parsed.data.plan.remote_stat, '200 1700001000');
  // Only the stat command should have been issued
  const mutatingCmds = client.commands.filter(c =>
    c.startsWith('mv ') || c.startsWith('cp ') || c.includes('base64 -d')
  );
  assert.strictEqual(mutatingCmds.length, 0, 'no mutation in preview');
});

await test('ssh_edit: full-replace flow writes tmp via base64, cp backup, then mv', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.startsWith(`cat `)) return { stdout: '{"old":true}\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const newJson = '{"new":true}\n';
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/app.json',
      new_content: newJson,
      syntax_check: 'none', // skip the python3 json probe to keep the test hermetic
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, parsed.error);

  // Order: cat -> base64-write -> cp -p backup && mv tmp orig -> diff
  const writeIdx = client.commands.findIndex(c => c.includes('base64 -d >'));
  const swapIdx = client.commands.findIndex(c => c.startsWith('set -e; cp -p '));
  assert(writeIdx >= 0, 'expected base64 write');
  assert(swapIdx >= 0, 'expected cp+mv swap');
  assert(swapIdx > writeIdx, 'swap must happen after write');

  // The write command's stdin should be the base64 of new_content
  const writeStream = client.streams[writeIdx];
  const expectedB64 = Buffer.from(newJson, 'utf8').toString('base64');
  assert.deepStrictEqual(writeStream.writes, [expectedB64]);
  assert.strictEqual(writeStream.endCalls, 1);

  // backup path recorded + diff present (our mock returns empty diff, but field exists)
  assert(parsed.data.backup_path.startsWith('/etc/app.json.mcp.bak.'));
  assert.strictEqual(parsed.data.mode, 'replace');
  assert.strictEqual(parsed.data.bytes_written, Buffer.byteLength(newJson, 'utf8'));
});

await test('ssh_edit: json path triggers python3 json syntax check; failure aborts + cleans tmp', async () => {
  let tmpPath = null;
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.startsWith('cat ')) return { stdout: '{}', code: 0 };
      if (cmd.includes('base64 -d >')) {
        // capture the tmp path from the command
        const m = cmd.match(/base64 -d > '([^']+)'/);
        if (m) tmpPath = m[1];
        return { stdout: '', code: 0 };
      }
      if (cmd.includes('python3 -c') && cmd.includes('json')) {
        return { stdout: '', stderr: 'json.decoder.JSONDecodeError: Expecting value', code: 1 };
      }
      if (cmd.startsWith('rm -f ')) return { stdout: '', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/app.json',
      new_content: 'not-json-at-all',
      format: 'json',
      // syntax_check default 'auto' -> json checker
    },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('syntax check'));
  assert(parsed.error.includes('json'));
  // Must have attempted to clean up tmp AND must NOT have invoked cp/mv
  const swapAttempted = client.commands.some(c => c.startsWith('set -e; cp -p '));
  assert.strictEqual(swapAttempted, false, 'swap must be skipped on syntax failure');
  const cleanupAttempted = client.commands.some(c => c.startsWith('rm -f ') && c.includes('mcp.tmp.'));
  assert.strictEqual(cleanupAttempted, true, 'tmp must be rm -f cleaned up');
});

await test('ssh_edit: yaml path triggers yaml checker (auto detection)', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.startsWith('cat ')) return { stdout: 'k: v\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/app.yaml', new_content: 'k: v2\n', format: 'json',
    },
  });
  const yamlCheck = client.commands.find(c =>
    c.includes('python3 -c') && c.includes('yaml.safe_load')
  );
  assert(yamlCheck, 'expected yaml checker command');
});

await test('ssh_edit: patch-mode regex rules applied and base64-encoded new content sent', async () => {
  const original = 'version: 1.0\nname: alpha\n';
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.startsWith('cat ')) return { stdout: original, code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/app.txt',
      patch: [
        { find: 'version: 1\\.0', replace: 'version: 2.0' },
        { find: 'alpha', replace: 'beta' },
      ],
      syntax_check: 'none',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, parsed.error);
  assert.strictEqual(parsed.data.mode, 'patch');

  const writeIdx = client.commands.findIndex(c => c.includes('base64 -d >'));
  const writeStream = client.streams[writeIdx];
  const decoded = Buffer.from(writeStream.writes[0], 'base64').toString('utf8');
  assert.strictEqual(decoded, 'version: 2.0\nname: beta\n');
});

await test('ssh_edit: missing new_content AND patch -> structured failure', async () => {
  const r = await handleSshEdit({
    getConnection: async () => ({}),
    args: { server: 's', path: '/etc/x', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('new_content') || parsed.error.includes('patch'));
});

await test('ssh_edit: path with shell metachars is single-quoted in every remote command', async () => {
  const evil = "/etc/my'cfg; rm -rf /.conf";
  const client = new FakeClient({
    script: (cmd) => cmd.startsWith('cat ')
      ? { stdout: 'x', code: 0 }
      : { stdout: '', code: 0 },
  });
  await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: evil,
      new_content: 'safe',
      syntax_check: 'none',
      format: 'json',
    },
  });
  // Injection-safety check: shQuote() produces '...' with any embedded single
  // quote expanded to the POSIX-safe sequence '\'' (end-quote, literal, reopen).
  // Every remote reference to the evil path must contain the quoted prefix
  // "'/etc/my'\\''cfg; rm -rf /.conf" (possibly with a suffix like .mcp.tmp.XXX
  // before the closing quote). The NAKED unescaped form must never appear --
  // if it did, the embedded single quote would terminate the shell literal
  // and the trailing `; rm -rf /` would parse as a new command.
  const quotedPrefix = "'/etc/my'\\''cfg; rm -rf /.conf";
  const naked = "/etc/my'cfg; rm -rf /.conf";
  const remoteCommands = client.commands.filter(c => c.includes('/etc/my'));
  assert(remoteCommands.length > 0, 'at least one command should reference the path');
  for (const cmd of remoteCommands) {
    assert(cmd.includes(quotedPrefix),
      `expected shQuote-escaped prefix in: ${cmd}`);
    assert(!cmd.includes(naked),
      `naked injection form leaked into: ${cmd}`);
  }
});

await test('ssh_edit: cat failure (file missing) -> structured fail, no tmp write', async () => {
  const client = new FakeClient({
    script: (cmd) => cmd.startsWith('cat ')
      ? { stdout: '', stderr: 'No such file', code: 1 }
      : { stdout: '', code: 0 },
  });
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/nope', new_content: 'x',
      syntax_check: 'none', format: 'json',
    },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('cannot read'));
  const wroteTmp = client.commands.some(c => c.includes('base64 -d >'));
  assert.strictEqual(wroteTmp, false);
});

await test('ssh_edit: non-json/yaml extension auto-skips syntax check', async () => {
  const client = new FakeClient({
    script: (cmd) => cmd.startsWith('cat ')
      ? { stdout: 'old', code: 0 }
      : { stdout: '', code: 0 },
  });
  const r = await handleSshEdit({
    getConnection: async () => client,
    args: {
      server: 's', path: '/etc/plain.txt',
      new_content: 'new',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, parsed.error);
  const anyCheck = client.commands.some(c => c.includes('python3') || c.includes('nginx -t'));
  assert.strictEqual(anyCheck, false);
  assert.strictEqual(parsed.data.syntax_check, null);
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
