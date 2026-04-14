#!/usr/bin/env node

/**
 * Test suite for src/tool-exec-stream.js — full pipeline with a fake client.
 * Run: node tests/test-tool-exec-stream.js
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import { runStreamedExec } from '../src/tool-exec-stream.js';

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`❌ ${name}: ${e.message}`);
  }
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.signals = [];
  }
  signal(n) { this.signals.push(n); }
  close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ execError } = {}) {
    this.execError = execError;
    this.lastCommand = null;
    this.streams = [];
  }
  exec(cmd, cb) {
    this.lastCommand = cmd;
    setImmediate(() => {
      if (this.execError) return cb(this.execError);
      const s = new FakeStream();
      this.streams.push(s);
      cb(null, s);
    });
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('🧪 Testing tool-exec-stream\n');

// ─── Happy path ──────────────────────────────────────────────────────────
await test('success returns markdown content with ▶ marker and exit 0 badge', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 'prod01', command: 'echo hi', cwd: '/var/app',
    debounceMs: 5,
  });
  await sleep(5);
  const s = client.streams[0];
  s.emit('data', Buffer.from('hi\n'));
  s.emit('close', 0);
  const r = await p;
  assert.strictEqual(r.isError, undefined, 'not a tool-level error');
  assert.strictEqual(r.content.length, 1);
  const md = r.content[0].text;
  assert(md.startsWith('▶ **ssh_execute**'), 'success marker');
  assert(md.includes('`prod01`'));
  assert(md.includes('**exit 0**'));
  assert(md.includes('*(in `/var/app`)*'));
  assert(md.includes('hi'));
});

await test('non-zero exit is NOT isError (command ran, just failed)', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({ client, server: 's', command: 'false', debounceMs: 5 });
  await sleep(5);
  const s = client.streams[0];
  s.emit('close', 1);
  const r = await p;
  assert.strictEqual(r.isError, undefined);
  assert(r.content[0].text.includes('**exit 1**'));
  assert(r.content[0].text.startsWith('✕ **ssh_execute**'));
});

await test('exec error → isError:true with stderr populated', async () => {
  const client = new FakeClient({ execError: new Error('connection refused') });
  const r = await runStreamedExec({ client, server: 's', command: 'anything' });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('connection refused'));
  assert(r.content[0].text.includes('**exit -1**'));
});

await test('timeout bubbles up as isError:true with timeout message', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({ client, server: 's', command: 'sleep 999', timeoutMs: 30, debounceMs: 5 });
  await sleep(5);
  client.streams[0].emit('data', Buffer.from('working'));
  const r = await p;
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('timeout after 30ms'));
  // The fake stream received INT signal
  assert(client.streams[0].signals.includes('INT'));
});

// ─── cwd shell safety at the tool layer ─────────────────────────────────
await test('cwd with injection attempt is neutralized before reaching remote', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 's', command: 'ls',
    cwd: '/tmp; rm -rf /',
    debounceMs: 5,
  });
  await sleep(5);
  assert.strictEqual(client.lastCommand, "cd '/tmp; rm -rf /' && ls");
  client.streams[0].emit('close', 0);
  await p;
});

// ─── onChunk forwarding ──────────────────────────────────────────────────
await test('onChunk receives debounced stdout chunks', async () => {
  const chunks = [];
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 's', command: 'cmd',
    debounceMs: 20,
    onChunk: c => chunks.push(c),
  });
  await sleep(5);
  const s = client.streams[0];
  for (let i = 0; i < 5; i++) s.emit('data', Buffer.from('x'));
  await sleep(30);
  s.emit('close', 0);
  await p;
  assert(chunks.length >= 1);
  assert.strictEqual(chunks.map(c => c.text).join(''), 'xxxxx');
  assert(chunks.every(c => c.kind === 'stdout'));
});

// ─── format variants ─────────────────────────────────────────────────────
await test('format:json returns single JSON block parseable into wire schema', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 'prod01', command: 'uname -a', cwd: null,
    format: 'json', debounceMs: 5,
  });
  await sleep(5);
  const s = client.streams[0];
  s.emit('data', Buffer.from('Linux rocky\n'));
  s.emit('close', 0);
  const r = await p;
  assert.strictEqual(r.content.length, 1);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.server, 'prod01');
  assert.strictEqual(parsed.exit_code, 0);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.stdout, 'Linux rocky\n');
  assert(parsed.duration_ms >= 0);
});

await test('format:both returns markdown + json in content array', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 's', command: 'c', format: 'both', debounceMs: 5,
  });
  await sleep(5);
  client.streams[0].emit('close', 0);
  const r = await p;
  assert.strictEqual(r.content.length, 2);
  assert(r.content[0].text.includes('ssh_execute'), 'md first');
  assert.doesNotThrow(() => JSON.parse(r.content[1].text));
});

// ─── Large output truncation through the pipeline ───────────────────────
await test('oversized stdout is truncated and rendered with elided blockquote', async () => {
  const client = new FakeClient();
  const p = runStreamedExec({
    client, server: 's', command: 'spam',
    maxLen: 500,
    debounceMs: 5,
  });
  await sleep(5);
  const s = client.streams[0];
  s.emit('data', Buffer.from('A'.repeat(5000) + 'TAIL_MARKER'));
  s.emit('close', 0);
  const r = await p;
  const md = r.content[0].text;
  assert(md.includes('TAIL_MARKER'), 'tail preserved in render');
  assert(md.includes('> elided:'), 'truncation blockquote');
});

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
