#!/usr/bin/env node

/**
 * Test suite for src/stream-exec.js -- uses a fake ssh2 Client, no network.
 * Run: node tests/test-stream-exec.js
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import { streamExecCommand, shQuote, buildRemoteCommand } from '../src/stream-exec.js';

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

// --- Test harness: ssh2-shaped fakes -------------------------------------
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.closed = false;
    this.signals = [];
    this.closeCalls = 0;
    this.writes = [];
    this.endCalls = 0;
  }
  signal(name) { this.signals.push(name); }
  write(data) { this.writes.push(String(data)); return true; }
  end() { this.endCalls++; }
  close() {
    this.closeCalls++;
    if (!this.closed) {
      this.closed = true;
      setImmediate(() => this.emit('close', null, 'TERM'));
    }
  }
  // helpers
  pushStdout(buf) { this.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  pushStderr(buf) { this.stderr.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  finish(code = 0, signal = null) { this.emit('close', code, signal); }
  errorOut(err) { this.emit('error', err); }
}

class FakeClient {
  constructor({ execError = null, execDelay = 0 } = {}) {
    this.execError = execError;
    this.execDelay = execDelay;
    this.lastCommand = null;
    this.streams = [];
    this.execCallCount = 0;
  }
  exec(command, cb) {
    this.execCallCount++;
    this.lastCommand = command;
    const run = () => {
      if (this.execError) return cb(this.execError);
      const s = new FakeStream();
      this.streams.push(s);
      cb(null, s);
    };
    if (this.execDelay) setTimeout(run, this.execDelay);
    else setImmediate(run);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('[test] Testing stream-exec\n');

// --- shQuote / buildRemoteCommand ----------------------------------------
await test('shQuote: simple path', () => {
  assert.strictEqual(shQuote('/var/app'), "'/var/app'");
});

await test('shQuote: path with space', () => {
  assert.strictEqual(shQuote('/home/my user'), "'/home/my user'");
});

await test('shQuote: path with single-quote escapes correctly', () => {
  assert.strictEqual(shQuote("it's"), "'it'\\''s'");
});

await test('shQuote: path with injection attempt stays literal', () => {
  // Classic injection: /tmp; rm -rf /
  const dangerous = '/tmp; rm -rf /';
  const quoted = shQuote(dangerous);
  // The quoted form wraps in single quotes -- bash treats `;` as literal inside.
  assert.strictEqual(quoted, "'/tmp; rm -rf /'");
});

await test('shQuote: close-quote injection attempt is neutralized', () => {
  // Attempt to break out of single quotes: evil'; rm -rf /; echo '
  const dangerous = "evil'; rm -rf /; echo '";
  const quoted = shQuote(dangerous);
  // Must escape the internal quote to close-escape-reopen.
  assert.strictEqual(quoted, "'evil'\\''; rm -rf /; echo '\\'''");
});

await test('buildRemoteCommand: no cwd returns command unchanged', () => {
  assert.strictEqual(buildRemoteCommand('ls', undefined), 'ls');
  assert.strictEqual(buildRemoteCommand('ls', null), 'ls');
  assert.strictEqual(buildRemoteCommand('ls', ''), 'ls');
});

await test('buildRemoteCommand: cwd is quoted', () => {
  assert.strictEqual(buildRemoteCommand('ls', '/var/app'), "cd '/var/app' && ls");
});

await test('buildRemoteCommand: shell-injection in cwd neutralized', () => {
  const cmd = buildRemoteCommand('ls', '/tmp; rm -rf /');
  // After quoting, `;` is inside single quotes -> bash treats as literal dir name.
  assert.strictEqual(cmd, "cd '/tmp; rm -rf /' && ls");
});

// --- Happy path ----------------------------------------------------------
await test('happy path: stdout chunks + close -> resolves with full output', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'echo hi', { debounceMs: 10 });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout('hello ');
  s.pushStdout('world\n');
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'hello world\n');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 0);
});

await test('stderr is collected separately', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', { debounceMs: 10 });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout('out');
  s.pushStderr('err');
  s.finish(1);
  const r = await p;
  assert.strictEqual(r.stdout, 'out');
  assert.strictEqual(r.stderr, 'err');
  assert.strictEqual(r.code, 1);
});

await test('no stdout + non-zero exit -> resolves with empty output and code', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'false', { debounceMs: 10 });
  await sleep(5);
  client.streams[0].finish(1);
  const r = await p;
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.code, 1);
});

// --- UTF-8 split codepoint handling --------------------------------------
await test('UTF-8: multi-byte codepoint split across two chunks is reassembled intact', async () => {
  // U+1F680 (rocket) encodes to 4 bytes: F0 9F 9A 80
  const rocket = Buffer.from([0xF0, 0x9F, 0x9A, 0x80]);
  const part1 = rocket.slice(0, 2);
  const part2 = rocket.slice(2);

  const client = new FakeClient();
  const p = streamExecCommand(client, 'echo x', { debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout(part1);
  s.pushStdout(part2);
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, rocket.toString('utf8'));
});

await test('UTF-8: trailing partial codepoint surfaces on .end() without crash', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'x', { debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  // Push valid prefix + orphan byte (stream closes before completion)
  s.pushStdout('ok');
  s.pushStdout(Buffer.from([0xF0])); // start of 4-byte codepoint, no completion
  s.finish(0);
  const r = await p;
  // First two bytes survive; the orphan becomes a replacement char.
  assert(r.stdout.startsWith('ok'));
  assert(r.stdout.length <= 'ok'.length + 1, 'no runaway output');
});

// --- Debounce behavior ---------------------------------------------------
await test('debounce: many tiny chunks coalesce into fewer onChunk calls', async () => {
  const chunks = [];
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', {
    debounceMs: 40,
    onChunk: c => chunks.push(c),
  });
  await sleep(5);
  const s = client.streams[0];
  // 10 rapid chunks within a single debounce window
  for (let i = 0; i < 10; i++) s.pushStdout('x');
  // Wait past debounce
  await sleep(60);
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'xxxxxxxxxx');
  // Debounced: should be 1-2 emit calls, not 10
  assert(chunks.length >= 1 && chunks.length <= 3, `expected few chunks, got ${chunks.length}`);
  assert.strictEqual(chunks.map(c => c.text).join(''), 'xxxxxxxxxx');
});

await test('debounce: pending chunk flushed on close before resolve', async () => {
  const chunks = [];
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', {
    debounceMs: 10_000,  // effectively never by timer
    onChunk: c => chunks.push(c),
  });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout('late-arriving');
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'late-arriving');
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].text, 'late-arriving');
});

// --- Abort semantics -----------------------------------------------------
await test('abort: already-aborted signal rejects immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  const client = new FakeClient();
  await assert.rejects(
    () => streamExecCommand(client, 'cmd', { abortSignal: ac.signal }),
    /aborted/i,
  );
});

await test('abort: mid-flight -> rejects, stream.signal(INT) + close called', async () => {
  const ac = new AbortController();
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', { abortSignal: ac.signal, debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout('partial');
  ac.abort();
  await assert.rejects(() => p, /aborted/i);
  assert(s.signals.includes('INT'), 'INT signal must be sent');
  assert(s.closeCalls >= 1, 'stream.close() must be called');
});

await test('abort: after command completes is a no-op (no double-resolve)', async () => {
  const ac = new AbortController();
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', { abortSignal: ac.signal, debounceMs: 5 });
  await sleep(5);
  client.streams[0].finish(0);
  const r = await p;
  ac.abort();  // after resolve
  await sleep(10);
  assert.strictEqual(r.code, 0);  // first resolve wins
});

// --- Timeout semantics ---------------------------------------------------
await test('timeout: exceeds deadline -> rejects with timeout error', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'sleep 9999', { timeoutMs: 30, debounceMs: 5 });
  await sleep(5);
  client.streams[0].pushStdout('still running');
  await assert.rejects(() => p, /timeout after 30ms/);
  assert(client.streams[0].signals.includes('INT'));
});

await test('timeout: command finishes before deadline -> resolves normally', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'ok', { timeoutMs: 500, debounceMs: 5 });
  await sleep(5);
  client.streams[0].pushStdout('done');
  client.streams[0].finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'done');
  assert.strictEqual(r.code, 0);
  // Clean up any timer leak
  await sleep(10);
});

// --- Error surfaces ------------------------------------------------------
await test('exec callback error -> rejects with that error', async () => {
  const boom = new Error('connection dropped');
  const client = new FakeClient({ execError: boom });
  await assert.rejects(
    () => streamExecCommand(client, 'cmd'),
    /connection dropped/,
  );
});

await test('stream error event -> rejects', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', { debounceMs: 5 });
  await sleep(5);
  client.streams[0].errorOut(new Error('channel closed'));
  await assert.rejects(() => p, /channel closed/);
});

await test('onChunk throwing does not crash the stream', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', {
    debounceMs: 5,
    onChunk: () => { throw new Error('consumer exploded'); },
  });
  await sleep(5);
  const s = client.streams[0];
  s.pushStdout('still-arrives');
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'still-arrives');
});

// --- Backpressure --------------------------------------------------------
await test('backpressure: stdout > maxBufferedBytes -> keeps tail only', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'yes', {
    debounceMs: 5,
    maxBufferedBytes: 1000,
  });
  await sleep(5);
  const s = client.streams[0];
  // Push 5000 bytes with a distinctive tail
  s.pushStdout('A'.repeat(4000));
  s.pushStdout('B'.repeat(1000));
  s.pushStdout('TAIL_MARKER');
  s.finish(0);
  const r = await p;
  assert(r.stdout.length <= 1000, `buffer must stay <= cap, got ${r.stdout.length}`);
  assert(r.stdout.endsWith('TAIL_MARKER'), 'tail must survive the cap');
});

// --- Wiring of cwd into remote command -----------------------------------
await test('cwd propagates into the remote command with shell-safe quoting', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'ls', {
    cwd: '/srv/my app; rm -rf /',
    debounceMs: 5,
  });
  await sleep(5);
  assert.strictEqual(
    client.lastCommand,
    "cd '/srv/my app; rm -rf /' && ls",
  );
  client.streams[0].finish(0);
  await p;
});

// --- stdin pass-through (for sudo -S) ------------------------------------
await test('stdin: string written to stream and stream.end() called', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'sudo -S -p "" id', {
    stdin: 'secret-password\n',
    debounceMs: 5,
  });
  await sleep(5);
  const s = client.streams[0];
  assert.deepStrictEqual(s.writes, ['secret-password\n'], 'password written verbatim');
  assert.strictEqual(s.endCalls, 1, 'stream.end() called to close fd0');
  s.pushStdout('uid=0(root)');
  s.finish(0);
  const r = await p;
  assert.strictEqual(r.stdout, 'uid=0(root)');
});

await test('stdin not provided: stream.write/end NOT called', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'echo hi', { debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  assert.strictEqual(s.writes.length, 0);
  assert.strictEqual(s.endCalls, 0);
  s.pushStdout('hi'); s.finish(0); await p;
});

await test('stdin with special chars does NOT end up in argv (injection-free)', async () => {
  // The danger of the old `echo "$pw" | sudo -S` approach is that a password
  // containing $ or " or `` breaks out of the echo. With stdin, the password
  // bytes go through the SSH channel fd0, never into the shell command.
  const client = new FakeClient();
  const evil = 'hunter$(whoami)"two`three`';
  const p = streamExecCommand(client, 'sudo -S -p "" whoami', {
    stdin: evil + '\n',
    debounceMs: 5,
  });
  await sleep(5);
  // The command passed to client.exec contains NO copy of the password.
  assert(!client.lastCommand.includes(evil), 'password MUST NOT appear in argv');
  assert(!client.lastCommand.includes('hunter'), 'no password fragment in argv');
  // But stream.write received the exact bytes.
  assert.deepStrictEqual(client.streams[0].writes, [evil + '\n']);
  client.streams[0].pushStdout('root');
  client.streams[0].finish(0);
  await p;
});

// --- Idempotency ---------------------------------------------------------
await test('close fired twice -> resolves once', async () => {
  const client = new FakeClient();
  const p = streamExecCommand(client, 'cmd', { debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  s.finish(0);
  s.finish(1);  // duplicate -- must be ignored
  const r = await p;
  assert.strictEqual(r.code, 0);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
