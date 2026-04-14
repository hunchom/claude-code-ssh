#!/usr/bin/env node
/** Tests for src/tools/journalctl-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  normalizePriority, safeLines, buildJournalctlCommand, parseJournalJsonl,
  handleSshJournalctl, ALLOWED_PRIORITIES, PRIORITY_NAMES,
} from '../src/tools/journalctl-tools.js';

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

console.log('🧪 Testing journalctl-tools\n');

// ─── normalizePriority ──────────────────────────────────────────────────
await test('normalizePriority: default info', () => assert.strictEqual(normalizePriority(undefined), 'info'));
await test('normalizePriority: warn → warning alias', () => assert.strictEqual(normalizePriority('warn'), 'warning'));
await test('normalizePriority: numeric 3 accepted', () => assert.strictEqual(normalizePriority(3), '3'));
await test('normalizePriority: numeric 7 accepted', () => assert.strictEqual(normalizePriority('7'), '7'));
await test('normalizePriority: garbage → null', () => assert.strictEqual(normalizePriority('xxx'), null));
await test('normalizePriority: too-high numeric rejected', () => assert.strictEqual(normalizePriority('9'), null));

// ─── safeLines ──────────────────────────────────────────────────────────
await test('safeLines: default when not a number', () => assert.strictEqual(safeLines(undefined), 100));
await test('safeLines: clamp max 10000', () => assert.strictEqual(safeLines(99_999_999), 10_000));
await test('safeLines: clamp min 1', () => assert.strictEqual(safeLines(0), 1));
await test('safeLines: NaN-equivalent falls back', () => assert.strictEqual(safeLines('abc'), 100));

// ─── buildJournalctlCommand ─────────────────────────────────────────────
await test('buildJournalctlCommand: defaults', () => {
  const cmd = buildJournalctlCommand({});
  assert(cmd.includes('journalctl'));
  assert(cmd.includes('-p info'));
  assert(cmd.includes('-n 100'));
  assert(cmd.includes('--no-pager'));
  assert(cmd.includes('--output=json'));
});

await test('buildJournalctlCommand: unit and since/until are shell-quoted', () => {
  const cmd = buildJournalctlCommand({ unit: 'nginx; rm -rf /', since: "2024-01-01'; DROP", until: '1h' });
  assert(cmd.includes("-u 'nginx; rm -rf /'"));
  assert(cmd.includes("--since '2024-01-01'\\''; DROP'"));
  assert(cmd.includes("--until '1h'"));
});

await test('buildJournalctlCommand: json:false omits --output=json', () => {
  assert(!buildJournalctlCommand({ json: false }).includes('--output=json'));
});

await test('buildJournalctlCommand: grep pattern appended safely', () => {
  const cmd = buildJournalctlCommand({ grep: "ERROR'; rm" });
  assert(cmd.includes("| grep -E 'ERROR'\\''; rm'"));
});

// ─── parseJournalJsonl ──────────────────────────────────────────────────
await test('parseJournalJsonl: parses single record', () => {
  const line = JSON.stringify({
    __REALTIME_TIMESTAMP: '1700000000000000',
    PRIORITY: '3',
    _HOSTNAME: 'host1',
    _SYSTEMD_UNIT: 'nginx.service',
    MESSAGE: 'something broke',
    _PID: '1234',
    _UID: '0',
  });
  const r = parseJournalJsonl(line);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].priority, 'err');
  assert.strictEqual(r[0].hostname, 'host1');
  assert.strictEqual(r[0].unit, 'nginx.service');
  assert.strictEqual(r[0].message, 'something broke');
  assert.strictEqual(r[0].pid, 1234);
  assert.strictEqual(r[0].uid, 0);
  assert(r[0].time.startsWith('2023-11-14'));
});

await test('parseJournalJsonl: skips malformed JSON lines', () => {
  const lines = [
    JSON.stringify({ MESSAGE: 'ok', PRIORITY: '6' }),
    'not json',
    '',
    JSON.stringify({ MESSAGE: 'also ok', PRIORITY: '6' }),
  ].join('\n');
  const r = parseJournalJsonl(lines);
  assert.strictEqual(r.length, 2);
});

await test('parseJournalJsonl: empty input → []', () => {
  assert.deepStrictEqual(parseJournalJsonl(''), []);
  assert.deepStrictEqual(parseJournalJsonl(null), []);
});

// ─── handleSshJournalctl ────────────────────────────────────────────────
await test('handleSshJournalctl: happy path json mode', async () => {
  const sample = JSON.stringify({ MESSAGE: 'hello', PRIORITY: '6', _HOSTNAME: 'h' });
  const client = new FakeClient({ script: () => ({ stdout: sample, code: 0 }) });
  const r = await handleSshJournalctl({
    getConnection: async () => client,
    args: { server: 's', unit: 'nginx.service', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.count, 1);
  assert.strictEqual(parsed.data.entries[0].message, 'hello');
});

await test('handleSshJournalctl: text mode returns entries array of raw lines', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'Nov 01 12:00 host nginx[123]: hello\nNov 01 12:01 host nginx[123]: world', code: 0 }) });
  const r = await handleSshJournalctl({
    getConnection: async () => client,
    args: { server: 's', json: false, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert(Array.isArray(parsed.data.entries));
  assert.strictEqual(parsed.data.count, 2);
  assert(parsed.data.entries[0].includes('hello'));
});

await test('handleSshJournalctl: invalid priority → fail, no remote call', async () => {
  let called = false;
  const r = await handleSshJournalctl({
    getConnection: async () => { called = true; throw new Error('should not call'); },
    args: { server: 's', priority: 'invalidzzz', format: 'json' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshJournalctl: connection failure → isError', async () => {
  const r = await handleSshJournalctl({
    getConnection: async () => { throw new Error('ssh down'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('ssh down'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
