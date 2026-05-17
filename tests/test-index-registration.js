#!/usr/bin/env node
/**
 * Registration invariants for src/index.js.
 *
 * Without this test, adding a tool to TOOL_GROUPS but forgetting to wire
 * a registerToolConditional(...) call in index.js is a silent drift: the
 * tool appears in the registry, ship-readiness tests pass, but users get
 * "unknown tool" at runtime. This test reads index.js as text and pins:
 *
 *   1. Every TOOL_GROUPS entry has a registerToolConditional('<name>', ...) call.
 *   2. Every registerToolConditional('<name>', ...) in index.js corresponds
 *      to a TOOL_GROUPS entry (no orphans).
 *   3. Every registered tool has a TOOL_ANNOTATIONS entry (mirrors
 *      test-tool-annotations, kept here for independent coverage).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { TOOL_GROUPS, getAllTools } from '../src/tool-registry.js';
import { TOOL_ANNOTATIONS } from '../src/tool-annotations.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

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

function registeredNames(src) {
  // Matches  registerToolConditional(   NEWLINE   'tool_name',
  const re = /registerToolConditional\(\s*['"]([A-Za-z_][\w-]*)['"]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

await test('every TOOL_GROUPS entry is registered in index.js', () => {
  const registered = registeredNames(indexSrc);
  const missing = getAllTools().filter(name => !registered.has(name));
  assert.strictEqual(missing.length, 0,
    `tools in TOOL_GROUPS but never registered: ${missing.join(', ')}`);
});

await test('every registerToolConditional() corresponds to a TOOL_GROUPS entry', () => {
  const registered = registeredNames(indexSrc);
  const known = new Set(getAllTools());
  const orphans = [...registered].filter(name => !known.has(name));
  assert.strictEqual(orphans.length, 0,
    `tools registered in index.js but missing from TOOL_GROUPS: ${orphans.join(', ')}`);
});

await test('exactly 12 tools are registered', () => {
  const registered = registeredNames(indexSrc);
  assert.strictEqual(registered.size, 12,
    `expected 12 registered tools, got ${registered.size}: ${[...registered].join(', ')}`);
});

await test('count of registered tools matches registry exactly', () => {
  const registered = registeredNames(indexSrc);
  assert.strictEqual(registered.size, getAllTools().length,
    `registered=${registered.size} vs registry=${getAllTools().length}`);
});

await test('every registered tool has an annotations entry (drift check)', () => {
  const registered = registeredNames(indexSrc);
  const missing = [...registered].filter(name => !TOOL_ANNOTATIONS[name]);
  assert.strictEqual(missing.length, 0,
    `tools registered without annotations: ${missing.join(', ')}`);
});

await test('no legacy 51-surface tool name survives in a registration', () => {
  const registered = registeredNames(indexSrc);
  const legacy = ['ssh_execute', 'ssh_upload', 'ssh_cat', 'ssh_tail',
    'ssh_systemctl', 'ssh_tunnel_create', 'ssh_deploy_artifact'];
  const survivors = legacy.filter(name => registered.has(name));
  assert.strictEqual(survivors.length, 0,
    `legacy tool names still registered: ${survivors.join(', ')}`);
});

await test('TOOL_GROUPS has no duplicate names across groups', () => {
  const all = getAllTools();
  assert.strictEqual(all.length, new Set(all).size,
    `duplicates detected in TOOL_GROUPS`);
});

await test('every group declared in TOOL_GROUPS is non-empty', () => {
  for (const [name, tools] of Object.entries(TOOL_GROUPS)) {
    assert(Array.isArray(tools) && tools.length > 0, `group ${name} is empty`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
