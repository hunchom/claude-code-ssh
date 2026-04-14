#!/usr/bin/env node
/** Tests for src/tools/docker-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  ALLOWED_ACTIONS, MUTATING_ACTIONS, REVERSIBILITY, RISK_MAP,
  CONTAINER_NAME_RE, CONTAINER_ID_RE, IMAGE_REF_RE,
  isValidContainer, isValidImage,
  parseDockerPs, parseDockerInspect,
  handleSshDocker,
} from '../src/tools/docker-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  write() {} end() {} signal() {} close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) { this.script = script || (() => ({ stdout: '', code: 0 })); this.commands = []; this.streams = []; }
  exec(cmd, cb) {
    this.commands.push(cmd);
    const s = new FakeStream(); this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      const { stdout = '', stderr = '', code = 0 } = this.script(cmd);
      setImmediate(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code);
      });
    });
  }
}

console.log('🧪 Testing docker-tools\n');

// ─── Validators ─────────────────────────────────────────────────────────
await test('isValidContainer: normal name', () => assert.strictEqual(isValidContainer('my-app'), true));
await test('isValidContainer: underscore + dot', () => assert.strictEqual(isValidContainer('svc_1.0'), true));
await test('isValidContainer: 12-hex id', () => assert.strictEqual(isValidContainer('0123456789ab'), true));
await test('isValidContainer: 64-hex id', () => assert.strictEqual(isValidContainer('a'.repeat(64)), true));
await test('isValidContainer: leading dash rejected', () => assert.strictEqual(isValidContainer('-x'), false));
await test('isValidContainer: shell metachar rejected', () => assert.strictEqual(isValidContainer('x; rm'), false));
await test('isValidContainer: $(echo x) rejected', () => assert.strictEqual(isValidContainer('$(echo x)'), false));
await test('isValidContainer: path traversal rejected', () => assert.strictEqual(isValidContainer('../etc'), false));
await test('isValidContainer: empty / non-string', () => { assert.strictEqual(isValidContainer(''), false); assert.strictEqual(isValidContainer(null), false); });

await test('isValidImage: alpine', () => assert.strictEqual(isValidImage('alpine'), true));
await test('isValidImage: tag', () => assert.strictEqual(isValidImage('alpine:3.19'), true));
await test('isValidImage: registry/namespace/name:tag', () => assert.strictEqual(isValidImage('ghcr.io/owner/repo:v1'), true));
await test('isValidImage: digest', () => assert.strictEqual(isValidImage(`alpine@sha256:${'a'.repeat(64)}`), true));
await test('isValidImage: injection rejected', () => assert.strictEqual(isValidImage('alpine; rm'), false));
await test('isValidImage: command substitution rejected', () => assert.strictEqual(isValidImage('$(curl evil)'), false));

// ─── parseDockerPs ──────────────────────────────────────────────────────
await test('parseDockerPs: JSONL with typical shape', () => {
  const lines = [
    JSON.stringify({ ID: 'abc123def456', Names: 'nginx', Image: 'nginx:latest', Status: 'Up 3 days', Ports: '80/tcp', State: 'running', CreatedAt: '2024-01-01' }),
    JSON.stringify({ ID: 'fed654cba321', Names: 'redis', Image: 'redis:7', Status: 'Exited', Ports: '', State: 'exited', CreatedAt: '2024-01-02' }),
  ].join('\n');
  const r = parseDockerPs(lines);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, 'nginx');
  assert.strictEqual(r[0].status, 'Up 3 days');
  assert.strictEqual(r[1].state, 'exited');
});

await test('parseDockerPs: skips malformed lines', () => {
  const lines = [JSON.stringify({ ID: 'x', Names: 'ok' }), 'not json', ''].join('\n');
  const r = parseDockerPs(lines);
  assert.strictEqual(r.length, 1);
});

// ─── parseDockerInspect ─────────────────────────────────────────────────
await test('parseDockerInspect: array form', () => {
  const r = parseDockerInspect(JSON.stringify([{ Id: 'x', Name: '/nginx' }]));
  assert(Array.isArray(r));
  assert.strictEqual(r[0].Name, '/nginx');
});

await test('parseDockerInspect: object form coerced to array', () => {
  const r = parseDockerInspect(JSON.stringify({ Id: 'x' }));
  assert(Array.isArray(r));
  assert.strictEqual(r[0].Id, 'x');
});

await test('parseDockerInspect: malformed returns null', () => {
  assert.strictEqual(parseDockerInspect('junk'), null);
});

// ─── Reversibility + Risk maps ──────────────────────────────────────────
await test('REVERSIBILITY: rm is irreversible, start/stop auto', () => {
  assert.strictEqual(REVERSIBILITY.rm, 'irreversible');
  assert.strictEqual(REVERSIBILITY.start, 'auto');
  assert.strictEqual(REVERSIBILITY.stop, 'auto');
});

await test('RISK_MAP: rm is high risk', () => {
  assert.strictEqual(RISK_MAP.rm, 'high');
});

// ─── handleSshDocker ────────────────────────────────────────────────────
await test('handleSshDocker: unknown action → fail, no remote', async () => {
  let called = false;
  const r = await handleSshDocker({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'exfiltrate', container: 'x' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshDocker: invalid container rejected before remote', async () => {
  let called = false;
  const r = await handleSshDocker({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'stop', container: 'x; rm -rf /' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshDocker: invalid image rejected', async () => {
  let called = false;
  const r = await handleSshDocker({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'pull', image: 'alpine; rm' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshDocker: ps parses JSONL into typed list', async () => {
  const sample = JSON.stringify({ ID: 'abc123def456', Names: 'nginx', Image: 'nginx:latest', Status: 'Up', Ports: '80/tcp', State: 'running', CreatedAt: 'x' });
  const client = new FakeClient({ script: () => ({ stdout: sample, code: 0 }) });
  const r = await handleSshDocker({
    getConnection: async () => client,
    args: { server: 's', action: 'ps', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.containers.length, 1);
  assert.strictEqual(parsed.data.containers[0].name, 'nginx');
});

await test('handleSshDocker: rm preview shows irreversible reversibility', async () => {
  let called = false;
  const r = await handleSshDocker({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'rm', container: 'myapp', preview: true, format: 'json' },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'irreversible');
});

await test('handleSshDocker: stop preview reversibility:auto', async () => {
  const r = await handleSshDocker({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', action: 'stop', container: 'myapp', preview: true, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'auto');
});

await test('handleSshDocker: exec is command-shQuoted', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'hi', code: 0 }) });
  await handleSshDocker({
    getConnection: async () => client,
    args: { server: 's', action: 'exec', container: 'myapp', command: "echo 'hi'; rm -rf /" },
  });
  const lastCmd = client.commands[client.commands.length - 1];
  assert(lastCmd.includes('docker exec'));
  // The injection attempt should be inside quotes
  assert(lastCmd.includes("'echo '\\''hi'\\''; rm -rf /'") || lastCmd.includes("'echo 'hi'; rm -rf /'") || /docker exec.*myapp.*sh -c/.test(lastCmd));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
