#!/usr/bin/env node
/**
 * Test suite for src/script-runner.js -- ssh_run action:script engine.
 * Run: node tests/test-script-runner.js
 */
import assert from 'assert';
import {
  buildScriptCommand,
  parseScriptSegments,
} from '../src/script-runner.js';

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

console.log('[test] Testing script-runner\n');

// --- buildScriptCommand --------------------------------------------------
test('buildScriptCommand: returns { command, nonce }', () => {
  const r = buildScriptCommand(['echo a', 'echo b']);
  assert.strictEqual(typeof r.command, 'string');
  assert(/^[0-9a-f]{12}$/.test(r.nonce), 'nonce is 12 hex chars');
  assert(r.command.includes('echo a'), 'first segment present');
  assert(r.command.includes('echo b'), 'second segment present');
});

test('buildScriptCommand: a fresh nonce per invocation', () => {
  const a = buildScriptCommand(['echo x']);
  const b = buildScriptCommand(['echo x']);
  assert.notStrictEqual(a.nonce, b.nonce, 'nonce differs across calls');
});

test('buildScriptCommand: a nonce-bound sentinel follows each segment', () => {
  const { command, nonce } = buildScriptCommand(['true', 'false']);
  // printf '\n##SEG-<nonce> %d %d##\n' 0 $?  -- one per segment
  const sentinels = command.match(new RegExp(`##SEG-${nonce} %d %d##`, 'g')) || [];
  assert.strictEqual(sentinels.length, 2, 'one sentinel per segment');
  assert(
    command.includes(`printf '\\n##SEG-${nonce} %d %d##\\n' 0 $?`),
    'segment 0 sentinel',
  );
  assert(
    command.includes(`printf '\\n##SEG-${nonce} %d %d##\\n' 1 $?`),
    'segment 1 sentinel',
  );
});

test('buildScriptCommand: segments are NOT && chained -- a failure does not abort', () => {
  const { command } = buildScriptCommand(['false', 'echo still-runs']);
  assert(!command.includes('&&'), 'no && between segments');
  // `;` lets the next segment run even after a non-zero exit.
  assert(command.includes(';'), 'segments separated so all run');
});

test('buildScriptCommand: default joins segments in one shell (shared state)', () => {
  const { command } = buildScriptCommand(['cd /tmp', 'pwd']);
  // No `sh -c` wrapper per segment: it is one process, so `cd` carries over.
  assert(!/sh -c .* sh -c /.test(command), 'not one sub-shell per segment');
});

test('buildScriptCommand: isolate:true wraps each segment in its own sh -c', () => {
  const { command } = buildScriptCommand(['cd /tmp', 'pwd'], { isolate: true });
  const subs = command.match(/sh -c /g) || [];
  assert.strictEqual(subs.length, 2, 'one sub-shell per segment when isolated');
});

test('buildScriptCommand: empty / non-array commands is rejected', () => {
  assert.throws(() => buildScriptCommand([]), /at least one command/);
  assert.throws(() => buildScriptCommand(null), /at least one command/);
});

test('buildScriptCommand: a non-string segment is rejected', () => {
  assert.throws(() => buildScriptCommand(['ok', 42]), /must be a string/);
});

// --- parseScriptSegments -------------------------------------------------
test('parseScriptSegments: splits stdout into per-segment results', () => {
  const raw = 'a-out\n##SEG-abc123 0 0##\nb-out\n##SEG-abc123 1 0##\n';
  const segs = parseScriptSegments(raw, 'abc123', ['echo a', 'echo b']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].stdout, 'a-out');
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[0].command, 'echo a');
  assert.strictEqual(segs[1].stdout, 'b-out');
});

test('parseScriptSegments: a non-zero segment exit is reported per segment', () => {
  const raw = 'ok\n##SEG-n1 0 0##\n\n##SEG-n1 1 127##\n';
  const segs = parseScriptSegments(raw, 'n1', ['true', 'nosuchcmd']);
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[1].exitCode, 127, 'failure surfaced for its segment');
});

test('parseScriptSegments: output after the last sentinel = unfinished segment', () => {
  // Script killed mid-segment 1: no closing sentinel for it.
  const raw = 'done\n##SEG-n2 0 0##\nhalf-out';
  const segs = parseScriptSegments(raw, 'n2', ['echo done', 'sleep 99']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[1].stdout, 'half-out');
  assert.strictEqual(segs[1].exitCode, null, 'no exit code for a killed segment');
  assert.strictEqual(segs[1].command, 'sleep 99');
});

test('parseScriptSegments: trailing whitespace after last sentinel is not a segment', () => {
  const raw = 'x\n##SEG-n3 0 0##\n\n  \n';
  const segs = parseScriptSegments(raw, 'n3', ['echo x']);
  assert.strictEqual(segs.length, 1, 'blank tail ignored');
});

test('parseScriptSegments: empty / nullish stdout -> empty array', () => {
  assert.deepStrictEqual(parseScriptSegments('', 'n4', []), []);
  assert.deepStrictEqual(parseScriptSegments(null, 'n4', []), []);
});

test('parseScriptSegments: command label is null when commands array is short', () => {
  const segs = parseScriptSegments('o\n##SEG-n5 0 0##\n', 'n5', []);
  assert.strictEqual(segs[0].command, null);
});

test('parseScriptSegments: a missing nonce is rejected', () => {
  assert.throws(() => parseScriptSegments('o\n##SEG-x 0 0##\n', ''), /nonce is required/);
  assert.throws(() => parseScriptSegments('o', null), /nonce is required/);
});

test('parseScriptSegments: a forged ##SEG line in stdout does NOT corrupt the parse', () => {
  // Segment 0 echoes a fake sentinel with the WRONG nonce -- must be ignored.
  // Only the real ##SEG-<nonce> line ends the segment.
  const { nonce } = buildScriptCommand(['echo hi']);
  const wrong = nonce === 'deadbeef' ? 'cafef00d' : 'deadbeef';
  const raw =
    `real-out\n##SEG-${wrong} 0 0##\nstill-seg-0\n##SEG-${nonce} 0 1##\n`;
  const segs = parseScriptSegments(raw, nonce, ['attacker']);
  assert.strictEqual(segs.length, 1, 'forged sentinel did not split the segment');
  assert.strictEqual(segs[0].exitCode, 1, 'real exit code wins, not the forged 0');
  assert(
    segs[0].stdout.includes(`##SEG-${wrong} 0 0##`),
    'forged line stays as plain stdout',
  );
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
