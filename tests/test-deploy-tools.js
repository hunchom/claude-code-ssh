#!/usr/bin/env node
/** Tests for src/tools/deploy-tools.js */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { handleSshDeploy } from '../src/tools/deploy-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}

// Shared fake SSH stream / client ─────────────────────────────────────────
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  write() {} end() {} signal() {} close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
function makeClient(script) {
  const commands = [];
  return {
    commands,
    _script: script,
    exec(cmd, cb) {
      commands.push(cmd);
      const s = new FakeStream();
      setImmediate(() => {
        cb(null, s);
        const res = script(cmd) || { stdout: '', code: 0 };
        setImmediate(() => {
          if (res.stdout) s.emit('data', Buffer.from(res.stdout));
          if (res.stderr) s.stderr.emit('data', Buffer.from(res.stderr));
          s.emit('close', res.code || 0);
        });
      });
    },
    sftp(cb) {
      // Pass a mock sftp — fastPut always succeeds.
      setImmediate(() => cb(null, {
        fastPut(local, remote, done) { setImmediate(() => done(null)); },
      }));
    },
  };
}

// Ephemeral local artifact for upload tests.
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-deploy-test-'));
const artifact = path.join(artifactDir, 'app.tar.gz');
fs.writeFileSync(artifact, 'deploy artifact bytes');

console.log('🧪 Testing deploy-tools\n');

// ─── Validation ─────────────────────────────────────────────────────────
await test('missing server → fail', async () => {
  const r = await handleSshDeploy({
    getConnection: async () => { throw new Error('no'); },
    args: { artifact_local_path: artifact, target_path: '/opt/app.tar.gz' },
  });
  assert.strictEqual(r.isError, true);
});

await test('missing artifact_local_path → fail', async () => {
  const r = await handleSshDeploy({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', target_path: '/opt/app.tar.gz' },
  });
  assert.strictEqual(r.isError, true);
});

await test('missing target_path → fail', async () => {
  const r = await handleSshDeploy({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', artifact_local_path: artifact },
  });
  assert.strictEqual(r.isError, true);
});

await test('artifact file does not exist → fail', async () => {
  const r = await handleSshDeploy({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', artifact_local_path: '/nonexistent/thing', target_path: '/opt/x' },
  });
  assert.strictEqual(r.isError, true);
});

// ─── Preview ────────────────────────────────────────────────────────────
await test('preview: shows plan with target stat + effects', async () => {
  const client = makeClient((cmd) => {
    if (cmd.includes('stat -c')) return { stdout: '5120 1700000000\n', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 'prod01', artifact_local_path: artifact, target_path: '/opt/app.tar.gz',
      post_hooks: ['systemctl restart app'], health_check: 'curl -sf localhost/healthz',
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.action, 'deploy');
  assert.strictEqual(parsed.data.plan.target_stat.exists, true);
  assert.strictEqual(parsed.data.plan.target_stat.size, 5120);
  assert(parsed.data.plan.effects.some(e => e.includes('systemctl restart app')));
  assert(parsed.data.plan.effects.some(e => e.includes('health_check')));
});

await test('preview: new file target shows "does not exist"', async () => {
  const client = makeClient((cmd) => {
    if (cmd.includes('stat -c')) return { stdout: 'MISSING', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/new.tar.gz',
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.target_stat.exists, false);
  assert(parsed.data.plan.effects.some(e => e.includes('does not exist')));
});

await test('preview: rollback_on_fail:true → reversibility auto', async () => {
  const client = makeClient(() => ({ stdout: '1 1\n', code: 0 }));
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: { server: 's', artifact_local_path: artifact, target_path: '/opt/x', preview: true, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'auto');
});

await test('preview: rollback_on_fail:false → reversibility manual', async () => {
  const client = makeClient(() => ({ stdout: '1 1\n', code: 0 }));
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/x',
      rollback_on_fail: false, preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'manual');
});

// ─── Happy path ─────────────────────────────────────────────────────────
await test('happy path: snapshot → upload → post_hook → health_check all ok', async () => {
  const runs = [];
  const client = makeClient((cmd) => {
    runs.push(cmd);
    if (cmd.includes('stat -c')) return { stdout: '100 1\n', code: 0 };
    if (cmd.startsWith('cp -pf')) return { stdout: '', code: 0 };
    if (cmd.startsWith('systemctl')) return { stdout: '', code: 0 };
    if (cmd.startsWith('curl')) return { stdout: 'ok', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/app.tar.gz',
      post_hooks: ['systemctl restart app'], health_check: 'curl -sf localhost',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.deployed, true);
  assert.strictEqual(parsed.data.rolled_back, false);
  assert.strictEqual(parsed.data.hook_results.length, 1);
  assert.strictEqual(parsed.data.hook_results[0].exit_code, 0);
  assert.strictEqual(parsed.data.health_check_exit_code, 0);
  assert(parsed.data.artifact_sha256);
});

// ─── Rollback ───────────────────────────────────────────────────────────
await test('health_check failure + rollback_on_fail:true → mv snapshot back', async () => {
  const seen = [];
  const client = makeClient((cmd) => {
    seen.push(cmd);
    if (cmd.includes('stat -c')) return { stdout: '1 1\n', code: 0 };
    if (cmd.startsWith('cp -pf')) return { stdout: '', code: 0 };
    if (cmd.startsWith('curl')) return { stdout: '', stderr: 'unhealthy', code: 1 };
    if (cmd.startsWith('mv -f')) return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/app.tar.gz',
      health_check: 'curl -sf unreachable', rollback_on_fail: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.data.rolled_back, true);
  assert.strictEqual(parsed.data.failure.phase, 'health_check');
  assert(seen.some(c => c.startsWith('mv -f')), 'snapshot mv happened');
});

await test('post_hook failure → short-circuit + rollback', async () => {
  const client = makeClient((cmd) => {
    if (cmd.includes('stat -c')) return { stdout: '1 1\n', code: 0 };
    if (cmd.startsWith('cp -pf')) return { stdout: '', code: 0 };
    if (cmd === 'hook1') return { stdout: '', code: 0 };
    if (cmd === 'hook2') return { stdout: '', stderr: 'boom', code: 5 };
    if (cmd === 'hook3') throw new Error('should not reach hook3');
    if (cmd.startsWith('mv -f')) return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/x',
      post_hooks: ['hook1', 'hook2', 'hook3'], rollback_on_fail: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.data.hook_results.length, 2, 'short-circuited, hook3 not run');
  assert.strictEqual(parsed.data.rolled_back, true);
});

await test('rollback_on_fail:false keeps broken deploy', async () => {
  const client = makeClient((cmd) => {
    if (cmd.includes('stat -c')) return { stdout: '1 1\n', code: 0 };
    if (cmd.startsWith('cp -pf')) return { stdout: '', code: 0 };
    if (cmd.startsWith('systemctl')) return { stdout: '', stderr: 'fail', code: 3 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/x',
      post_hooks: ['systemctl restart app'], rollback_on_fail: false, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.data.rolled_back, false);
});

await test('new-file rollback: deletes uploaded artifact, not mv', async () => {
  const seen = [];
  const client = makeClient((cmd) => {
    seen.push(cmd);
    if (cmd.includes('stat -c')) return { stdout: 'MISSING', code: 0 };
    if (cmd === 'bad_hook') return { stdout: '', code: 1 };
    if (cmd.startsWith('rm -f')) return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  });
  const r = await handleSshDeploy({
    getConnection: async () => client,
    args: {
      server: 's', artifact_local_path: artifact, target_path: '/opt/new-file',
      post_hooks: ['bad_hook'], rollback_on_fail: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.rolled_back, true);
  assert(seen.some(c => c.startsWith('rm -f')), 'used rm -f for new-file rollback');
  assert(!seen.some(c => c.startsWith('mv -f')), 'no mv since snapshot did not exist');
});

// Clean up artifact
try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
