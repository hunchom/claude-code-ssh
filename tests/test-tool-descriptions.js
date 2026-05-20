#!/usr/bin/env node
/**
 * Test suite for src/tool-descriptions.js.
 * Run: node tests/test-tool-descriptions.js
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { V4_TOOL_DESCRIPTIONS } from '../src/tool-descriptions.js';

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

console.log('[test] Testing tool-descriptions\n');

const V4_TOOLS = [
  'ssh_run', 'ssh_file', 'ssh_find', 'ssh_logs', 'ssh_service',
  'ssh_health', 'ssh_db', 'ssh_backup', 'ssh_session', 'ssh_net',
  'ssh_docker', 'ssh_fleet', 'ssh_plan',
];

test('map has exactly the 13 v4 tool keys', () => {
  assert.deepStrictEqual(Object.keys(V4_TOOL_DESCRIPTIONS).sort(), [...V4_TOOLS].sort());
});

test('map is frozen', () => {
  assert(Object.isFrozen(V4_TOOL_DESCRIPTIONS));
});

test('every description is a non-trivial string', () => {
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t];
    assert.strictEqual(typeof d, 'string', `${t} description is a string`);
    assert(d.length >= 60, `${t} description has substance (>=60 chars)`);
  }
});

test('every description names the raw bash it replaces', () => {
  // The selling point: each description points at the `ssh ...` / scp / rsync
  // command it supersedes. Backtick-quoted so the model sees a concrete command.
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t];
    assert(/`[^`]*(?:ssh |scp|rsync)[^`]*`/.test(d),
      `${t} description names a raw bash command in backticks`);
  }
});

test('every description carries a when-to-use cue', () => {
  // "use instead of" / "use for" / "reach for" -- an explicit selection cue.
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t].toLowerCase();
    assert(/use instead of|use for|use to|reach for/.test(d),
      `${t} description has a when-to-use cue`);
  }
});

test('descriptions sell the win -- capped/pooled/structured output', () => {
  // At least one concrete benefit phrase per description: this is why the tool
  // beats raw ssh (bounded output, pooled connection, structured result).
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t].toLowerCase();
    assert(/cap|bound|truncat|pool|structur|flood|filter|exit code|escape hatch/.test(d),
      `${t} description states a concrete advantage over raw ssh`);
  }
});

test('src/index.js imports the description map', () => {
  // Guards against the map drifting out of use if a future edit re-inlines
  // description strings in the v4 registration block.
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert(/V4_TOOL_DESCRIPTIONS/.test(idx), 'index.js references V4_TOOL_DESCRIPTIONS');
  assert(/from\s+['"]\.\/tool-descriptions\.js['"]/.test(idx),
    'index.js imports from ./tool-descriptions.js');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
