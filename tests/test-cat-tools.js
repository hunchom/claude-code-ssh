#!/usr/bin/env node
/** Tests for src/tools/cat-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import { handleSshCat, buildCatCommand } from '../src/tools/cat-tools.js';

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
  constructor({ script } = {}) { this.script = script || (() => ({ stdout: '', code: 0 })); this.streams = []; this.lastCommand = null; }
  exec(cmd, cb) {
    this.lastCommand = cmd;
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

console.log('🧪 Testing cat-tools\n');

// ─── buildCatCommand ─────────────────────────────────────────────────────
await test('buildCatCommand: default → plain cat with quoted path', () => {
  assert.strictEqual(buildCatCommand({ file: '/var/log/app.log' }), "cat '/var/log/app.log'");
});

await test('buildCatCommand: path with spaces and semicolons is quoted', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/var/log/my app; rm -rf /' }),
    "cat '/var/log/my app; rm -rf /'"
  );
});

await test('buildCatCommand: head mode', () => {
  assert.strictEqual(buildCatCommand({ file: '/f', head: 20 }), "head -n 20 '/f'");
});

await test('buildCatCommand: tail mode', () => {
  assert.strictEqual(buildCatCommand({ file: '/f', tail: 50 }), "tail -n 50 '/f'");
});

await test('buildCatCommand: line-range with sed', () => {
  assert.strictEqual(buildCatCommand({ file: '/f', line_start: 10, line_end: 25 }), "sed -n '10,25p' '/f'");
});

await test('buildCatCommand: line-range with grep filter', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/f', line_start: 1, line_end: 100, grep: 'ERROR' }),
    "sed -n '1,100p' '/f' | grep -E 'ERROR'"
  );
});

await test('buildCatCommand: offset+limit uses dd', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/f', offset: 1024, limit: 2048 }),
    "dd if='/f' bs=1 skip=1024 count=2048 2>/dev/null"
  );
});

await test('buildCatCommand: injection in numbers is neutralized by Number() coercion', () => {
  // Pass an injection attempt through head=...
  const cmd = buildCatCommand({ file: '/f', head: '10; rm -rf /' });
  // Number('10; rm -rf /') → NaN → floor(NaN) || 10 = 10
  assert.strictEqual(cmd, "head -n 10 '/f'");
});

await test('buildCatCommand: grep-only mode', () => {
  assert.strictEqual(buildCatCommand({ file: '/f', grep: 'TODO' }), "grep -E 'TODO' '/f'");
});

await test('buildCatCommand: grep pattern with special shell chars is quoted', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/f', grep: "it's; rm -rf /" }),
    "grep -E 'it'\\''s; rm -rf /' '/f'"
  );
});

await test('buildCatCommand: line_start > line_end clamps end to start', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/f', line_start: 100, line_end: 10 }),
    "sed -n '100,100p' '/f'"
  );
});

await test('buildCatCommand: line_start 0 or negative clamps to 1', () => {
  assert.strictEqual(
    buildCatCommand({ file: '/f', line_start: 0, line_end: 5 }),
    "sed -n '1,5p' '/f'"
  );
  assert.strictEqual(
    buildCatCommand({ file: '/f', line_start: -5, line_end: 5 }),
    "sed -n '1,5p' '/f'"
  );
});

// ─── handleSshCat ────────────────────────────────────────────────────────
await test('handleSshCat: missing file → structured failure', async () => {
  const r = await handleSshCat({
    getConnection: async () => { throw new Error('should not call'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('file is required'));
});

await test('handleSshCat: head mode returns formatted success', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'line1\nline2\nline3\n', code: 0 }) });
  const r = await handleSshCat({
    getConnection: async () => client,
    args: { server: 'prod01', file: '/var/log/app.log', head: 3 },
  });
  assert.strictEqual(r.isError, undefined);
  assert.strictEqual(client.lastCommand, "head -n 3 '/var/log/app.log'");
  assert(r.content[0].text.includes('line1'));
  assert(r.content[0].text.includes('line3'));
});

await test('handleSshCat: JSON format round-trips through wire schema', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'hello\n', code: 0 }) });
  const r = await handleSshCat({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.stdout, 'hello\n');
  assert.strictEqual(parsed.success, true);
});

await test('handleSshCat: connection failure → isError:true with diagnostic', async () => {
  const r = await handleSshCat({
    getConnection: async () => { throw new Error('ssh refused'); },
    args: { server: 's', file: '/f' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('ssh refused'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
