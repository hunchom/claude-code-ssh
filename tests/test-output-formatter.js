#!/usr/bin/env node

/**
 * Test suite for src/output-formatter.js
 * Run: node tests/test-output-formatter.js
 */

import assert from 'assert';
import {
  stripAnsi,
  truncateHeadTail,
  formatExecResult,
  renderMarkdown,
  makeMcpContent,
  formatBytes,
  formatDuration,
} from '../src/output-formatter.js';

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

console.log('[test] Testing output-formatter\n');

// --- stripAnsi -----------------------------------------------------------
test('stripAnsi: null -> empty string', () => {
  assert.strictEqual(stripAnsi(null), '');
  assert.strictEqual(stripAnsi(undefined), '');
  assert.strictEqual(stripAnsi(''), '');
});

test('stripAnsi: removes color codes', () => {
  const input = '\x1b[31mred\x1b[0m \x1b[1;32mbold-green\x1b[0m';
  assert.strictEqual(stripAnsi(input), 'red bold-green');
});

test('stripAnsi: removes cursor movement sequences', () => {
  const input = 'line1\x1b[2Jline2\x1b[3Aline3';
  assert.strictEqual(stripAnsi(input), 'line1line2line3');
});

test('stripAnsi: removes OSC title-set sequences', () => {
  const input = '\x1b]0;window-title\x07hello';
  assert.strictEqual(stripAnsi(input), 'hello');
});

test('stripAnsi: preserves plain text and newlines', () => {
  const input = 'line1\nline2\tindented';
  assert.strictEqual(stripAnsi(input), 'line1\nline2\tindented');
});

test('stripAnsi: coerces non-string input', () => {
  assert.strictEqual(stripAnsi(42), '42');
});

// --- truncateHeadTail ----------------------------------------------------
test('truncateHeadTail: under-limit returns unchanged, 0 truncated', () => {
  const r = truncateHeadTail('abc', 100);
  assert.strictEqual(r.text, 'abc');
  assert.strictEqual(r.originalBytes, 3);
  assert.strictEqual(r.truncatedBytes, 0);
});

test('truncateHeadTail: exact-limit unchanged', () => {
  const s = 'x'.repeat(100);
  const r = truncateHeadTail(s, 100);
  assert.strictEqual(r.text, s);
  assert.strictEqual(r.truncatedBytes, 0);
});

test('truncateHeadTail: over-limit keeps head + tail, drops middle', () => {
  const head = 'A'.repeat(50);
  const mid = 'M'.repeat(200);
  const tail = 'Z'.repeat(50);
  const input = head + mid + tail;
  const r = truncateHeadTail(input, 100);
  assert(r.text.startsWith(head), 'head preserved');
  assert(r.text.endsWith(tail), 'tail preserved');
  assert(r.text.includes('bytes elided'), 'marker present');
  assert.strictEqual(r.originalBytes, 300);
  assert.strictEqual(r.truncatedBytes, 200);
});

test('truncateHeadTail: null/empty input is safe', () => {
  const r = truncateHeadTail(null, 100);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.originalBytes, 0);
  assert.strictEqual(r.truncatedBytes, 0);
});

test('truncateHeadTail: error context (tail) is preserved when output is long', () => {
  // Simulate 50KB log ending with an error message.
  const logSpam = 'x'.repeat(50_000);
  const finalErr = '\nERROR: connection refused at line 42';
  const r = truncateHeadTail(logSpam + finalErr, 10_000);
  assert(r.text.endsWith(finalErr), 'the real error at the tail must survive');
});

// --- formatExecResult ----------------------------------------------------
test('formatExecResult: success shape', () => {
  const r = formatExecResult({
    server: 'prod01',
    command: 'echo hi',
    cwd: '/var/app',
    stdout: 'hi\n',
    stderr: '',
    code: 0,
    durationMs: 42,
  });
  assert.strictEqual(r.server, 'prod01');
  assert.strictEqual(r.command, 'echo hi');
  assert.strictEqual(r.cwd, '/var/app');
  assert.strictEqual(r.exit_code, 0);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.duration_ms, 42);
  assert.strictEqual(r.stdout, 'hi\n');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.truncated.stdout_bytes, 0);
  assert.strictEqual(r.truncated.stderr_bytes, 0);
});

test('formatExecResult: failure shape (non-zero exit)', () => {
  const r = formatExecResult({
    server: 's',
    command: 'false',
    stdout: '',
    stderr: 'oops',
    code: 1,
    durationMs: 5,
  });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.exit_code, 1);
  assert.strictEqual(r.stderr, 'oops');
});

test('formatExecResult: null cwd is emitted as null', () => {
  const r = formatExecResult({
    server: 's', command: 'x', stdout: '', stderr: '', code: 0, durationMs: 1,
  });
  assert.strictEqual(r.cwd, null);
});

test('formatExecResult: ANSI stripped before truncation', () => {
  const r = formatExecResult({
    server: 's',
    command: 'ls --color',
    stdout: '\x1b[34mdir1\x1b[0m\n\x1b[34mdir2\x1b[0m',
    stderr: '',
    code: 0,
    durationMs: 1,
  });
  assert.strictEqual(r.stdout, 'dir1\ndir2');
});

test('formatExecResult: truncation reported in truncated block', () => {
  const big = 'x'.repeat(30_000);
  const r = formatExecResult({
    server: 's', command: 'c', stdout: big, stderr: '', code: 0, durationMs: 1,
    maxLen: 1000,
  });
  assert(r.truncated.stdout_bytes > 0, 'should report truncated bytes');
  assert.strictEqual(r.truncated.stdout_total, 30_000);
});

test('formatExecResult: undefined code -> exit_code -1, success false', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: '', stderr: '', code: undefined, durationMs: 0,
  });
  assert.strictEqual(r.exit_code, -1);
  assert.strictEqual(r.success, false);
});

test('formatExecResult: negative durationMs clamps to 0', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: '', stderr: '', code: 0, durationMs: -50,
  });
  assert.strictEqual(r.duration_ms, 0);
});

// --- formatBytes ---------------------------------------------------------
test('formatBytes: 0 -> "0 B"', () => assert.strictEqual(formatBytes(0), '0 B'));
test('formatBytes: sub-KB stays in bytes', () => assert.strictEqual(formatBytes(512), '512 B'));
test('formatBytes: exactly 1024 -> KB with decimal', () => assert.strictEqual(formatBytes(1024), '1.0 KB'));
test('formatBytes: MB threshold', () => assert.strictEqual(formatBytes(1_500_000), '1.4 MB'));
test('formatBytes: garbage -> 0 B', () => assert.strictEqual(formatBytes(null), '0 B'));

// --- formatDuration ------------------------------------------------------
test('formatDuration: sub-second -> "N ms"', () => assert.strictEqual(formatDuration(245), '245 ms'));
test('formatDuration: seconds with 2 decimals', () => assert.strictEqual(formatDuration(2340), '2.34 s'));
test('formatDuration: minutes', () => assert.strictEqual(formatDuration(83_000), '1m 23s'));
test('formatDuration: negative clamps to 0 ms', () => assert.strictEqual(formatDuration(-100), '0 ms'));

// --- renderMarkdown ------------------------------------------------------
test('renderMarkdown: success header is a renderHeader line, no bold', () => {
  const md = renderMarkdown({
    server: 'prod01', command: 'x', cwd: null, exit_code: 0, success: true,
    duration_ms: 2340, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert.strictEqual(md.split('\n')[0], '[ok] ssh_execute · prod01 · exit 0 · 2.34 s');
  assert(!md.includes('**'), 'no markdown bold');
  assert(md.includes('\n$ x'), 'command on its own line with $ prefix');
});

test('renderMarkdown: failure header uses [err] marker and exit code', () => {
  const md = renderMarkdown({
    server: 's', command: 'false', cwd: null, exit_code: 127, success: false,
    duration_ms: 0, stdout: '', stderr: 'not found',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.split('\n')[0].startsWith('[err] ssh_execute'), 'failure marker');
  assert(md.includes('exit 127'), 'exit 127 in header');
  assert(md.includes('stderr:'), 'stderr label');
  assert(md.includes('  not found'), 'stderr indented');
});

test('renderMarkdown: cwd shown as plain (in PATH) on the command line', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: '/srv/app', exit_code: 0, success: true,
    duration_ms: 100, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('$ c  (in /srv/app)'), 'cwd shown plain');
  assert(!md.includes('*'), 'no markdown italic');
});

test('renderMarkdown: no cwd -> no "(in ...)" fragment', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 10, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(!md.includes('(in '), 'no cwd fragment when null');
});

test('renderMarkdown: stdout indented 2 spaces, no fences', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'hello\nworld', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('\n  hello\n  world'), 'stdout indented');
  assert(!md.includes('```'), 'no fenced block');
});

test('renderMarkdown: empty output sections omitted', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(!md.includes('stderr:'), 'no stderr label when stderr empty');
});

test('renderMarkdown: truncation rendered as plain elided footer', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'partial', stderr: '',
    truncated: { stdout_bytes: 12345, stderr_bytes: 0, stdout_total: 22345, stderr_total: 0 },
  });
  assert(md.includes('elided: stdout 12.1 KB'), `expected plain elided footer, got: ${md}`);
  assert(!md.includes('>'), 'no blockquote marker');
});

test('renderMarkdown: truncation shows both streams when both elided', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'a', stderr: 'b',
    truncated: { stdout_bytes: 5_000_000, stderr_bytes: 2048, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('stdout 4.8 MB'));
  assert(md.includes('stderr 2.0 KB'));
});

// --- makeMcpContent ------------------------------------------------------
test('makeMcpContent: markdown (default)', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: 'out', stderr: '', code: 0, durationMs: 10,
  });
  const c = makeMcpContent(r);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].type, 'text');
  assert(c[0].text.includes('ssh_execute'), 'is markdown');
});

test('makeMcpContent: json is parseable and round-trips the wire shape', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: 'out', stderr: 'err', code: 3, durationMs: 7,
  });
  const c = makeMcpContent(r, { format: 'json' });
  assert.strictEqual(c.length, 1);
  const parsed = JSON.parse(c[0].text);
  assert.strictEqual(parsed.server, 's');
  assert.strictEqual(parsed.exit_code, 3);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.stdout, 'out');
  assert.strictEqual(parsed.stderr, 'err');
  assert.strictEqual(parsed.duration_ms, 7);
});

test('makeMcpContent: both returns markdown and json blocks in order', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: '', stderr: '', code: 0, durationMs: 1,
  });
  const c = makeMcpContent(r, { format: 'both' });
  assert.strictEqual(c.length, 2);
  assert(c[0].text.includes('ssh_execute'), 'first block is markdown');
  assert.doesNotThrow(() => JSON.parse(c[1].text), 'second block is JSON');
});

// --- Integration: real-world-ish shape -----------------------------------
test('integration: 100KB log with ANSI + error at tail round-trips through all helpers', () => {
  const noise = ('\x1b[32mline of noise\x1b[0m\n').repeat(5000); // ~100KB with ANSI
  const err = 'FATAL: segmentation fault at 0xdeadbeef\n';
  const r = formatExecResult({
    server: 'vm1', command: './run', cwd: '/opt', stdout: noise + err,
    stderr: '\x1b[31mfailed\x1b[0m', code: 139, durationMs: 1234,
    maxLen: 8000,
  });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.exit_code, 139);
  assert(!r.stdout.includes('\x1b['), 'no ANSI in stdout');
  assert(!r.stderr.includes('\x1b['), 'no ANSI in stderr');
  assert(r.stdout.endsWith(err), 'tail error preserved');
  assert(r.truncated.stdout_bytes > 0);

  const md = renderMarkdown(r);
  assert(md.includes('exit 139'), 'failure exit in header');
  assert(md.includes('elided'), 'truncation marker present');
  assert(md.startsWith('[err] ssh_execute'), 'failure marker leads the header');

  const c = makeMcpContent(r, { format: 'both' });
  assert.strictEqual(c.length, 2);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
