#!/usr/bin/env node
/**
 * Tests for src/structured-result.js and src/preview-mode.js
 */
import assert from 'assert';
import { ok, fail, preview, toMcp, defaultRender } from '../src/structured-result.js';
import { buildPlan, maybePreview, renderPlan } from '../src/preview-mode.js';

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}

console.log('🧪 Testing structured-result + preview-mode\n');

// ─── ok / fail / preview shape ───────────────────────────────────────────
test('ok: wire shape', () => {
  const r = ok('ssh_execute', { stdout: 'hi' }, { server: 'prod01', duration_ms: 42 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.tool, 'ssh_execute');
  assert.strictEqual(r.server, 'prod01');
  assert.deepStrictEqual(r.data, { stdout: 'hi' });
  assert.strictEqual(r.meta.duration_ms, 42);
  assert.strictEqual(r.meta.server, undefined, 'server stripped from meta');
});

test('fail: error from Error instance uses .message', () => {
  const r = fail('ssh_execute', new Error('boom'));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'boom');
  assert.strictEqual(r.data, null);
});

test('fail: error from string preserved verbatim', () => {
  const r = fail('ssh_db_query', 'unsafe query');
  assert.strictEqual(r.error, 'unsafe query');
});

test('preview: data carries preview:true + plan', () => {
  const r = preview('ssh_upload', { action: 'upload', target: 'prod01:/x' }, { server: 'prod01' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.preview, true);
  assert.strictEqual(r.data.plan.action, 'upload');
  assert.strictEqual(r.server, 'prod01');
});

// ─── toMcp format variants ───────────────────────────────────────────────
test('toMcp markdown: wraps in content[0].text, isError reflects success', () => {
  const r = toMcp(ok('t', { x: 1 }));
  assert.strictEqual(r.content.length, 1);
  assert.strictEqual(r.content[0].type, 'text');
  assert.strictEqual(r.isError, false);
});

test('toMcp json: single JSON block, isError:true on fail', () => {
  const r = toMcp(fail('t', 'nope'), { format: 'json' });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.error, 'nope');
});

test('toMcp both: md + json in content array', () => {
  const r = toMcp(ok('t', { n: 5 }), { format: 'both' });
  assert.strictEqual(r.content.length, 2);
  assert.doesNotThrow(() => JSON.parse(r.content[1].text));
});

test('toMcp custom renderer is honored', () => {
  const r = toMcp(ok('t', {}), { renderer: () => 'CUSTOM' });
  assert.strictEqual(r.content[0].text, 'CUSTOM');
});

// ─── defaultRender ───────────────────────────────────────────────────────
test('defaultRender: success card has ▶ marker, tool name, server, duration', () => {
  const md = defaultRender(ok('ssh_execute', { x: 1 }, { server: 'prod01', duration_ms: 1234 }));
  assert(md.startsWith('▶ **ssh_execute**'));
  assert(md.includes('`prod01`'));
  assert(md.includes('`1.23 s`'));
  assert(md.includes('```json'));
});

test('defaultRender: failure uses ✕ marker and "failed" badge', () => {
  const md = defaultRender(fail('ssh_execute', 'boom'));
  assert(md.startsWith('✕ **ssh_execute**'));
  assert(md.includes('**failed**'));
  assert(md.includes('boom'));
});

test('defaultRender: preview renders "dry run" blockquote and plan JSON', () => {
  const md = defaultRender(preview('ssh_upload', { action: 'upload', target: 'a' }));
  assert(md.includes('> **dry run**'));
  assert(md.includes('"action": "upload"'));
});

test('defaultRender: omits duration when not set', () => {
  const md = defaultRender(ok('t', {}));
  assert(!md.includes(' s`'), 'no seconds segment');
  assert(!md.includes(' ms`'), 'no ms segment');
});

test('defaultRender: elided bytes footer rendered', () => {
  const md = defaultRender(ok('t', { x: 1 }, { elided_bytes: 5120 }));
  assert(md.includes('> elided: 5.0 KB'));
});

// ─── buildPlan ───────────────────────────────────────────────────────────
test('buildPlan: defaults fill in safely', () => {
  const p = buildPlan({ action: 'exec', target: 'prod01' });
  assert.deepStrictEqual(p.effects, []);
  assert.strictEqual(p.reversibility, 'manual');
  assert.strictEqual(p.risk, 'medium');
  assert.strictEqual(p.estimated_duration_ms, null);
});

test('buildPlan: coerces scalar effects to array', () => {
  const p = buildPlan({ action: 'exec', target: 't', effects: 'single effect' });
  assert.deepStrictEqual(p.effects, ['single effect']);
});

test('buildPlan: passes through extra fields', () => {
  const p = buildPlan({ action: 'exec', target: 't', custom: 42 });
  assert.strictEqual(p.custom, 42);
});

// ─── maybePreview ────────────────────────────────────────────────────────
test('maybePreview returns null when preview=false', () => {
  const r = maybePreview(false, 'ssh_upload', { action: 'upload', target: 'x' }, {}, toMcp, preview);
  assert.strictEqual(r, null);
});

test('maybePreview returns MCP response when preview=true', () => {
  const r = maybePreview(true, 'ssh_upload', {
    action: 'upload', target: 'prod01:/etc/foo',
    effects: ['creates /etc/foo', 'overwrites any existing'],
    reversibility: 'auto',
    server: 'prod01',
  }, {}, toMcp, preview);
  assert(r);
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('dry run'));
  assert(r.content[0].text.includes('"action": "upload"'));
});

// ─── renderPlan ──────────────────────────────────────────────────────────
test('renderPlan: shows action, target, risk, effects', () => {
  const md = renderPlan(buildPlan({
    action: 'restart', target: 'nginx',
    effects: ['nginx stops', 'nginx starts'],
    reversibility: 'auto', risk: 'low',
    estimated_duration_ms: 3000,
  }), { title: 'ssh_systemctl' });
  assert(md.includes('**ssh_systemctl**'));
  assert(md.includes('`restart`'));
  assert(md.includes('`nginx`'));
  assert(md.includes('risk: **low**'));
  assert(md.includes('- nginx stops'));
  assert(md.includes('`auto`'));
  assert(md.includes('`3.00 s`'));
});

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
