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

await test('every annotated tool has a human title', () => {
  const missing = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => !v.title || typeof v.title !== 'string')
    .map(([k]) => k);
  assert.strictEqual(missing.length, 0,
    `tools missing title: ${missing.join(', ')}`);
});

await test('readOnlyHint and destructiveHint are never both true (spec invariant)', () => {
  const conflicts = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, v]) => v.annotations?.readOnlyHint && v.annotations?.destructiveHint)
    .map(([k]) => k);
  assert.strictEqual(conflicts.length, 0,
    `readOnly + destructive both set on: ${conflicts.join(', ')}`);
});

await test('obviously-destructive tools are marked destructiveHint', () => {
  const expected = ['ssh_backup_restore', 'ssh_db_import', 'ssh_deploy', 'ssh_deploy_artifact',
    'ssh_execute_sudo', 'ssh_backup_schedule', 'ssh_edit', 'ssh_plan'];
  for (const name of expected) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.destructiveHint, true,
      `${name} should be destructiveHint:true`);
  }
});

await test('obviously read-only tools are marked readOnlyHint', () => {
  const expected = ['ssh_list_servers', 'ssh_health_check', 'ssh_cat', 'ssh_db_list',
    'ssh_db_query', 'ssh_tail', 'ssh_tail_read', 'ssh_backup_list',
    'ssh_connection_status', 'ssh_history', 'ssh_session_list'];
  for (const name of expected) {
    assert.strictEqual(TOOL_ANNOTATIONS[name]?.annotations?.readOnlyHint, true,
      `${name} should be readOnlyHint:true`);
  }
});

await test('withAnnotations() merges title + annotations into schema', () => {
  const base = { description: 'x', inputSchema: {} };
  const out = withAnnotations('ssh_list_servers', base);
  assert.strictEqual(out.title, 'List Configured Servers');
  assert.strictEqual(out.annotations.readOnlyHint, true);
  assert.strictEqual(out.annotations.idempotentHint, true);
  // Caller-provided fields preserved
  assert.strictEqual(out.description, 'x');
});

await test('withAnnotations() leaves unknown tools untouched', () => {
  const base = { description: 'x', inputSchema: {} };
  const out = withAnnotations('ssh_nonexistent_tool', base);
  assert.deepStrictEqual(out, base);
});

await test('withAnnotations() does not clobber a caller-provided title', () => {
  const base = { title: 'Custom', description: 'x', inputSchema: {} };
  const out = withAnnotations('ssh_execute', base);
  assert.strictEqual(out.title, 'Custom');
});

await test('withAnnotations() caller-provided annotations override map defaults', () => {
  // ssh_list_servers is annotated readOnlyHint:true, idempotentHint:true.
  // If a future caller explicitly flips readOnlyHint off, that must win.
  const base = {
    description: 'x',
    inputSchema: {},
    annotations: { readOnlyHint: false },
  };
  const out = withAnnotations('ssh_list_servers', base);
  assert.strictEqual(out.annotations.readOnlyHint, false,
    'caller override must beat map default');
  assert.strictEqual(out.annotations.idempotentHint, true,
    'non-overridden map defaults still apply');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
