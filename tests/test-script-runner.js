#!/usr/bin/env node
/**
 * Test suite for src/script-runner.js -- ssh_run action:script engine.
 * Run: node tests/test-script-runner.js
 */
import assert from 'assert';
import {
  SEG_RE,
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
test('buildScriptCommand: joins commands into a single exec string', () => {
  const cmd = buildScriptCommand(['echo a', 'echo b']);
  assert.strictEqual(typeof cmd, 'string');
  assert(cmd.includes('echo a'), 'first segment present');
  assert(cmd.includes('echo b'), 'second segment present');
});

test('buildScriptCommand: a sentinel with index + $? follows each segment', () => {
  const cmd = buildScriptCommand(['true', 'false']);
  // printf '\n##SEG %d %d##\n' 0 $?  -- one per segment
  const sentinels = cmd.match(/##SEG %d %d##/g) || [];
  assert.strictEqual(sentinels.length, 2, 'one sentinel per segment');
  assert(cmd.includes("printf '\\n##SEG %d %d##\\n' 0 $?"), 'segment 0 sentinel');
  assert(cmd.includes("printf '\\n##SEG %d %d##\\n' 1 $?"), 'segment 1 sentinel');
});

test('buildScriptCommand: segments are NOT && chained -- a failure does not abort', () => {
  const cmd = buildScriptCommand(['false', 'echo still-runs']);
  assert(!cmd.includes('&&'), 'no && between segments');
  // `;` lets the next segment run even after a non-zero exit.
  assert(cmd.includes(';'), 'segments separated so all run');
});

test('buildScriptCommand: default joins segments in one shell (shared state)', () => {
  const cmd = buildScriptCommand(['cd /tmp', 'pwd']);
  // No `sh -c` wrapper per segment: it is one process, so `cd` carries over.
  assert(!/sh -c .* sh -c /.test(cmd), 'not one sub-shell per segment');
});

test('buildScriptCommand: isolate:true wraps each segment in its own sh -c', () => {
  const cmd = buildScriptCommand(['cd /tmp', 'pwd'], { isolate: true });
  const subs = cmd.match(/sh -c /g) || [];
  assert.strictEqual(subs.length, 2, 'one sub-shell per segment when isolated');
});

test('buildScriptCommand: empty / non-array commands is rejected', () => {
  assert.throws(() => buildScriptCommand([]), /at least one command/);
  assert.throws(() => buildScriptCommand(null), /at least one command/);
});

test('buildScriptCommand: a non-string segment is rejected', () => {
  assert.throws(() => buildScriptCommand(['ok', 42]), /must be a string/);
});

test('SEG_RE: matches the emitted sentinel and captures index + code', () => {
  const m = '\n##SEG 3 127##\n'.match(SEG_RE);
  assert(m, 'sentinel matched');
  assert.strictEqual(m[1], '3', 'segment index captured');
  assert.strictEqual(m[2], '127', 'exit code captured');
});

// --- parseScriptSegments -------------------------------------------------
test('parseScriptSegments: splits stdout into per-segment results', () => {
  const raw = 'a-out\n##SEG 0 0##\nb-out\n##SEG 1 0##\n';
  const segs = parseScriptSegments(raw, ['echo a', 'echo b']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].stdout, 'a-out');
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[0].command, 'echo a');
  assert.strictEqual(segs[1].stdout, 'b-out');
});

test('parseScriptSegments: a non-zero segment exit is reported per segment', () => {
  const raw = 'ok\n##SEG 0 0##\n\n##SEG 1 127##\n';
  const segs = parseScriptSegments(raw, ['true', 'nosuchcmd']);
  assert.strictEqual(segs[0].exitCode, 0);
  assert.strictEqual(segs[1].exitCode, 127, 'failure surfaced for its segment');
});

test('parseScriptSegments: output after the last sentinel = unfinished segment', () => {
  // Script killed mid-segment 1: no closing sentinel for it.
  const raw = 'done\n##SEG 0 0##\nhalf-out';
  const segs = parseScriptSegments(raw, ['echo done', 'sleep 99']);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[1].stdout, 'half-out');
  assert.strictEqual(segs[1].exitCode, null, 'no exit code for a killed segment');
  assert.strictEqual(segs[1].command, 'sleep 99');
});

test('parseScriptSegments: trailing whitespace after last sentinel is not a segment', () => {
  const raw = 'x\n##SEG 0 0##\n\n  \n';
  const segs = parseScriptSegments(raw, ['echo x']);
  assert.strictEqual(segs.length, 1, 'blank tail ignored');
});

test('parseScriptSegments: empty / nullish stdout -> empty array', () => {
  assert.deepStrictEqual(parseScriptSegments('', []), []);
  assert.deepStrictEqual(parseScriptSegments(null, []), []);
});

test('parseScriptSegments: command label is null when commands array is short', () => {
  const segs = parseScriptSegments('o\n##SEG 0 0##\n', []);
  assert.strictEqual(segs[0].command, null);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
