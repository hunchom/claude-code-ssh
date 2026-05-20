#!/usr/bin/env node
/**
 * Tests for src/tool-annotations.js: every registered tool must have a
 * title + at least one of readOnlyHint/destructiveHint/idempotentHint, and
 * the MCP-spec annotation invariants (readOnly != destructive) must hold.
 */

import assert from 'node:assert';
import { TOOL_ANNOTATIONS, withAnnotations } from '../src/tool-annotations.js';
import { TOOL_GROUPS } from '../src/tool-registry.js';

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

const allRegistered = Object.values(TOOL_GROUPS).flat();

await test('every registered tool has an annotations entry', () => {
  const missing = allRegistered.filter(name => !TOOL_ANNOTATIONS[name]);
  assert.strictEqual(missing.length, 0,
    `tools registered but missing annotations: ${missing.join(', ')}`);
});

await test('every annotated tool is actually registered (no dangling entries)', () => {
  const registered = new Set(allRegistered);
  const dangling = Object.keys(TOOL_ANNOTATIONS).filter(name => !registered.has(name));
  assert.strictEqual(dangling.length, 0,
    `annotations defined for unknown tools: ${dangling.join(', ')}`);
});

await test('exactly 13 tools are annotated', () => {
  assert.strictEqual(Object.keys(TOOL_ANNOTATIONS).length, 13,
    `expected 13 annotated tools, got ${Object.keys(TOOL_ANNOTATIONS).length}`);
});

await test('every annotated tool has a human title', () => {
  const missing = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => !v.title || typeof v.title !== 'string')
    .map(([k]) => k);
  assert.strictEqual(missing.length, 0, `tools missing title: ${missing.join(', ')}`);
});

await test('readOnlyHint and destructiveHint are never both true (spec invariant)', () => {
  const conflicts = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => v.annotations?.readOnlyHint && v.annotations?.destructiveHint)
    .map(([k]) => k);
  assert.strictEqual(conflicts.length, 0,
    `readOnly + destructive both set on: ${conflicts.join(', ')}`);
});

await test('mutation-capable fat tools are marked destructiveHint', () => {
  const expected = ['ssh_run', 'ssh_file', 'ssh_service', 'ssh_health',
    'ssh_db', 'ssh_backup', 'ssh_docker', 'ssh_session', 'ssh_net', 'ssh_plan'];
  for (const name of expected) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.destructiveHint, true,
      `${name} should be destructiveHint:true`);
  }
});

await test('purely-inspecting fat tools are marked readOnlyHint', () => {
  for (const name of ['ssh_logs', 'ssh_fleet', 'ssh_find']) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.readOnlyHint, true,
      `${name} should be readOnlyHint:true`);
  }
});

await test('every fat tool declares openWorldHint (acts on remote hosts)', () => {
  const missing = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => v.annotations?.openWorldHint !== true)
    .map(([k]) => k);
  assert.strictEqual(missing.length, 0,
    `tools missing openWorldHint: ${missing.join(', ')}`);
});

await test('withAnnotations() merges title + annotations into schema', () => {
  const out = withAnnotations('ssh_run', { description: 'x', inputSchema: {} });
  assert.strictEqual(typeof out.title, 'string');
  assert(out.title.length > 0);
  assert.strictEqual(out.annotations.destructiveHint, true);
  assert.strictEqual(out.description, 'x');
});

await test('withAnnotations() leaves unknown tools untouched', () => {
  const base = { description: 'x', inputSchema: {} };
  assert.deepStrictEqual(withAnnotations('ssh_nonexistent_tool', base), base);
});

await test('withAnnotations() does not clobber a caller-provided title', () => {
  const out = withAnnotations('ssh_run', { title: 'Custom', description: 'x', inputSchema: {} });
  assert.strictEqual(out.title, 'Custom');
});

await test('withAnnotations() caller-provided annotations override map defaults', () => {
  const out = withAnnotations('ssh_logs', {
    description: 'x', inputSchema: {}, annotations: { readOnlyHint: false },
  });
  assert.strictEqual(out.annotations.readOnlyHint, false, 'caller override must beat map default');
  assert.strictEqual(out.annotations.openWorldHint, true, 'non-overridden defaults still apply');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
