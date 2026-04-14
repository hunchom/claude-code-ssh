#!/usr/bin/env node
/**
 * Tests for src/tools/tail-tools.js -- mocks getConnection and drives a
 * long-lived fake stream for the follow-session handlers.
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import {
  handleSshTail,
  handleSshTailStart,
  handleSshTailRead,
  handleSshTailStop,
  buildTailCommand,
  _sessionsForTest,
  _stoppedIdsForTest,
} from '../src/tools/tail-tools.js';

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
    this.writes = []; this.endCalls = 0; this.signals = []; this.closeCalls = 0;
  }
  write(d) { this.writes.push(String(d)); return true; }
  end() { this.endCalls++; }
  signal(n) { this.signals.push(n); }
  close() { this.closeCalls++; setImmediate(() => this.emit('close', null, 'TERM')); }
}

// One-shot client: emits data + close once, like the exec-tools FakeClient.
class OneShotClient {
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

// Follow client: returns a stream that we keep a handle to, for feeding
// data after ssh_tail_start has already returned.
class FollowClient {
  constructor() {
    this.streams = [];
    this.lastCommand = null;
  }
  exec(cmd, cb) {
    this.lastCommand = cmd;
    const s = new FakeStream();
    this.streams.push(s);
    setImmediate(() => cb(null, s));
  }
  feed(text, { which = 'stdout' } = {}) {
    const s = this.streams[this.streams.length - 1];
    if (which === 'stderr') s.stderr.emit('data', Buffer.from(text));
    else s.emit('data', Buffer.from(text));
  }
  lastStream() { return this.streams[this.streams.length - 1]; }
}

console.log('[test] Testing tail-tools\n');

// --------------------------------------------------------------------------
// buildTailCommand
// --------------------------------------------------------------------------
await test('buildTailCommand: default (no follow, no grep) quotes path', () => {
  assert.strictEqual(
    buildTailCommand({ file: '/var/log/app.log', lines: 20 }),
    "tail -n 20 '/var/log/app.log'"
  );
});

await test('buildTailCommand: follow mode includes -f', () => {
  assert.strictEqual(
    buildTailCommand({ file: '/f', lines: 5, follow: true }),
    "tail -n 5 -f '/f'"
  );
});

await test('buildTailCommand: grep is shell-quoted and piped', () => {
  assert.strictEqual(
    buildTailCommand({ file: '/f', lines: 10, grep: "it's; rm -rf /" }),
    "tail -n 10 '/f' | grep -E 'it'\\''s; rm -rf /'"
  );
});

await test('buildTailCommand: injection in lines neutralized by Number()', () => {
  assert.strictEqual(
    buildTailCommand({ file: '/f', lines: '10; rm -rf /' }),
    "tail -n 10 '/f'"
  );
});

// --------------------------------------------------------------------------
// handleSshTail (one-shot)
// --------------------------------------------------------------------------
await test('handleSshTail: happy path with quoted path and default lines', async () => {
  const client = new OneShotClient({ script: () => ({ stdout: 'a\nb\nc\n', code: 0 }) });
  const r = await handleSshTail({
    getConnection: async () => client,
    args: { server: 'prod01', file: '/var/log/app.log' },
  });
  assert.strictEqual(r.isError, undefined);
  assert.strictEqual(client.lastCommand, "tail -n 10 '/var/log/app.log'");
  const md = r.content[0].text;
  assert(md.startsWith('[ok] **ssh_execute**'), 'uses exec markdown renderer');
  assert(md.includes('a'));
  assert(md.includes('c'));
});

await test('handleSshTail: grep filter appended to command', async () => {
  const client = new OneShotClient({ script: () => ({ stdout: 'ERROR: boom\n', code: 0 }) });
  await handleSshTail({
    getConnection: async () => client,
    args: { server: 's', file: '/var/log/app.log', lines: 50, grep: 'ERROR' },
  });
  assert.strictEqual(client.lastCommand, "tail -n 50 '/var/log/app.log' | grep -E 'ERROR'");
});

await test('handleSshTail: injection attempt in file path is neutralized by shQuote', async () => {
  const client = new OneShotClient({ script: () => ({ stdout: 'x', code: 0 }) });
  await handleSshTail({
    getConnection: async () => client,
    args: { server: 's', file: '/tmp/log; rm -rf /', lines: 5 },
  });
  assert.strictEqual(client.lastCommand, "tail -n 5 '/tmp/log; rm -rf /'");
});

await test('handleSshTail: connection failure -> isError with stderr diagnostic', async () => {
  const r = await handleSshTail({
    getConnection: async () => { throw new Error('host unreachable'); },
    args: { server: 's', file: '/f' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host unreachable'));
});

await test('handleSshTail: missing file -> structured failure (not crash)', async () => {
  const r = await handleSshTail({
    getConnection: async () => { throw new Error('unused'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('file is required'));
});

await test('handleSshTail: format:json returns wire JSON', async () => {
  const client = new OneShotClient({ script: () => ({ stdout: 'yo\n', code: 0 }) });
  const r = await handleSshTail({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.exit_code, 0);
  assert.strictEqual(parsed.stdout, 'yo\n');
  assert.strictEqual(parsed.success, true);
});

// --------------------------------------------------------------------------
// handleSshTailStart
// --------------------------------------------------------------------------
await test('handleSshTailStart: returns session_id + tail -n N -f command', async () => {
  const client = new FollowClient();
  const r = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 'prod01', file: '/var/log/app.log', lines: 3, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.tool, 'ssh_tail_start');
  assert(/^tail_[0-9a-f]{16}$/.test(parsed.data.session_id), `id shape: ${parsed.data.session_id}`);
  assert.strictEqual(client.lastCommand, "tail -n 3 -f '/var/log/app.log'");
  // Session is tracked in the registry
  assert(_sessionsForTest().has(parsed.data.session_id));
  // Cleanup
  await handleSshTailStop({ args: { session_id: parsed.data.session_id } });
});

await test('handleSshTailStart: file path shell-quoted (injection neutralized)', async () => {
  const client = new FollowClient();
  const r = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/var/log/bad; rm -rf /', lines: 5, format: 'json' },
  });
  assert.strictEqual(client.lastCommand, "tail -n 5 -f '/var/log/bad; rm -rf /'");
  const parsed = JSON.parse(r.content[0].text);
  await handleSshTailStop({ args: { session_id: parsed.data.session_id } });
});

await test('handleSshTailStart: grep filter quoted and appended after tail', async () => {
  const client = new FollowClient();
  const r = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', lines: 10, grep: 'ERR', format: 'json' },
  });
  assert.strictEqual(client.lastCommand, "tail -n 10 -f '/f' | grep -E 'ERR'");
  const parsed = JSON.parse(r.content[0].text);
  await handleSshTailStop({ args: { session_id: parsed.data.session_id } });
});

await test('handleSshTailStart: initial buffer captured after start', async () => {
  const client = new FollowClient();
  const started = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', lines: 10, format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;
  // Feed some initial data, then read
  client.feed('line1\nline2\n');
  await sleep(5);
  const read = await handleSshTailRead({ args: { session_id, format: 'json' } });
  const parsed = JSON.parse(read.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.chunk, 'line1\nline2\n');
  assert.strictEqual(parsed.data.current_offset, 12);
  await handleSshTailStop({ args: { session_id } });
});

await test('handleSshTailStart: markdown render starts with ssh_tail_start header', async () => {
  const client = new FollowClient();
  const r = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f' },
  });
  assert(r.content[0].text.startsWith('[ok] **ssh_tail_start**'),
    `got: ${r.content[0].text.slice(0, 80)}`);
  const parsed = JSON.parse((await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  })).content[0].text);
  await handleSshTailStop({ args: { session_id: parsed.data.session_id } });
  // And clean up the first one too
  const ids = [..._sessionsForTest().keys()];
  for (const id of ids) await handleSshTailStop({ args: { session_id: id } });
});

// --------------------------------------------------------------------------
// handleSshTailRead
// --------------------------------------------------------------------------
await test('handleSshTailRead: since_offset returns only new bytes', async () => {
  const client = new FollowClient();
  const started = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  client.feed('AAAAA');       // 5 bytes
  await sleep(5);
  const r1 = JSON.parse((await handleSshTailRead({ args: { session_id, format: 'json' } })).content[0].text);
  assert.strictEqual(r1.data.chunk, 'AAAAA');
  assert.strictEqual(r1.data.current_offset, 5);

  client.feed('BBB');         // +3 = offset 8
  await sleep(5);
  const r2 = JSON.parse((await handleSshTailRead({
    args: { session_id, since_offset: r1.data.current_offset, format: 'json' },
  })).content[0].text);
  assert.strictEqual(r2.data.chunk, 'BBB');
  assert.strictEqual(r2.data.current_offset, 8);

  await handleSshTailStop({ args: { session_id } });
});

await test('handleSshTailRead: empty when no new data since last offset', async () => {
  const client = new FollowClient();
  const started = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  client.feed('hello');
  await sleep(5);
  const r1 = JSON.parse((await handleSshTailRead({ args: { session_id, format: 'json' } })).content[0].text);
  const r2 = JSON.parse((await handleSshTailRead({
    args: { session_id, since_offset: r1.data.current_offset, format: 'json' },
  })).content[0].text);
  assert.strictEqual(r2.data.chunk, '');
  assert.strictEqual(r2.data.bytes, 0);
  assert.strictEqual(r2.data.current_offset, 5);

  await handleSshTailStop({ args: { session_id } });
});

await test('handleSshTailRead: unknown session_id -> structured fail', async () => {
  const r = await handleSshTailRead({ args: { session_id: 'tail_deadbeefdeadbeef', format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.tool, 'ssh_tail_read');
  assert(parsed.error.includes('unknown session_id'));
  assert.strictEqual(r.isError, true);
});

// --------------------------------------------------------------------------
// handleSshTailStop
// --------------------------------------------------------------------------
await test('handleSshTailStop: signals INT + closes + removes session', async () => {
  const client = new FollowClient();
  const started = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;
  assert(_sessionsForTest().has(session_id));

  const r = await handleSshTailStop({ args: { session_id, format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.stopped, true);

  const stream = client.lastStream();
  assert.deepStrictEqual(stream.signals, ['INT'], 'INT was signaled');
  assert.strictEqual(stream.closeCalls, 1, 'close was called');
  assert.strictEqual(_sessionsForTest().has(session_id), false, 'session removed');
});

await test('handleSshTailStop: second stop on same id is idempotent (success, already_stopped)', async () => {
  const client = new FollowClient();
  const started = await handleSshTailStart({
    getConnection: async () => client,
    args: { server: 's', file: '/f', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  const first = JSON.parse((await handleSshTailStop({ args: { session_id, format: 'json' } })).content[0].text);
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.data.already_stopped, undefined, 'first stop is the real stop');

  const second = await handleSshTailStop({ args: { session_id, format: 'json' } });
  const parsed = JSON.parse(second.content[0].text);
  assert.strictEqual(parsed.success, true, 'second stop is NOT an error');
  assert.strictEqual(parsed.data.already_stopped, true);
  assert(second.isError === false || second.isError === undefined, 'second stop must not be an error');
  assert(_stoppedIdsForTest().has(session_id));
});

await test('handleSshTailStop: unknown id (never seen) -> structured fail', async () => {
  const r = await handleSshTailStop({
    args: { session_id: 'tail_0000000000000000', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.tool, 'ssh_tail_stop');
  assert(parsed.error.includes('unknown session_id'));
  assert.strictEqual(r.isError, true);
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
