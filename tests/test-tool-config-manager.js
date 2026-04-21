#!/usr/bin/env node
/**
 * Tests for src/tool-config-manager.js -- the gate that decides whether
 * each registered tool is served to the MCP client. Zero coverage prior
 * to this file; this is the gatekeeper for every one of the 50 tools.
 *
 * Covers:
 *   - default config when no file exists (all enabled)
 *   - corrupt JSON falls back to defaults, doesn't crash
 *   - invalid structure (missing fields / bad mode) falls back to defaults
 *   - mode=all, mode=minimal, mode=custom semantics
 *   - individual tool overrides
 *   - disableGroup('core') is refused (core is load-bearing)
 *   - unknown tool / unknown group rejected by enable/disable helpers
 *   - getEnabledTools / getDisabledTools arithmetic matches registry
 *   - exportClaudeCodeConfig produces sensible auto-approval patterns
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolConfigManager } from '../src/tool-config-manager.js';
import { TOOL_GROUPS, getAllTools } from '../src/tool-registry.js';

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

function makeTmpConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcfg-'));
  return path.join(dir, 'tools-config.json');
}

function makeManagerWithPath(cfgPath) {
  const m = new ToolConfigManager();
  m.configPath = cfgPath;
  return m;
}

// --- load() --------------------------------------------------------------
await test('load(): no file -> default mode=all, all tools enabled', async () => {
  const cfgPath = makeTmpConfigPath();
  // Ensure absent
  if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(m.config.mode, 'all');
  assert.strictEqual(m.getEnabledTools().length, getAllTools().length);
  assert.strictEqual(m.getDisabledTools().length, 0);
});

await test('load(): corrupt JSON falls back to defaults (no crash)', async () => {
  const cfgPath = makeTmpConfigPath();
  fs.writeFileSync(cfgPath, '{ this is not: valid JSON', 'utf8');
  const m = makeManagerWithPath(cfgPath);
  await m.load();                        // must not throw
  assert.strictEqual(m.config.mode, 'all');
  assert.strictEqual(m.getEnabledTools().length, getAllTools().length);
});

await test('load(): invalid structure (missing version) falls back to defaults', async () => {
  const cfgPath = makeTmpConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'custom' }), 'utf8');
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(m.config.mode, 'all');
});

await test('load(): invalid mode falls back to defaults', async () => {
  const cfgPath = makeTmpConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify({ version: '1.0', mode: 'bogus' }), 'utf8');
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(m.config.mode, 'all');
});

await test('load(): valid minimal config is accepted', async () => {
  const cfgPath = makeTmpConfigPath();
  fs.writeFileSync(cfgPath, JSON.stringify({ version: '1.0', mode: 'minimal' }), 'utf8');
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(m.config.mode, 'minimal');
});

// --- isToolEnabled --------------------------------------------------------
await test('mode=all enables every tool', () => {
  const m = new ToolConfigManager();
  m.config = m.getDefaultConfig();               // mode=all
  for (const name of getAllTools()) {
    assert.strictEqual(m.isToolEnabled(name), true, `${name} should be enabled`);
  }
});

await test('mode=minimal enables ONLY core group', () => {
  const m = new ToolConfigManager();
  m.config = { version: '1.0', mode: 'minimal' };
  for (const name of getAllTools()) {
    const expected = TOOL_GROUPS.core.includes(name);
    assert.strictEqual(m.isToolEnabled(name), expected,
      `${name} expected ${expected} in minimal mode`);
  }
});

await test('mode=custom respects per-group enable flags', () => {
  const m = new ToolConfigManager();
  m.config = {
    version: '1.0', mode: 'custom',
    groups: {
      core: { enabled: true }, sessions: { enabled: false },
      monitoring: { enabled: false }, backup: { enabled: false },
      database: { enabled: false }, advanced: { enabled: false },
      gamechanger: { enabled: false },
    },
  };
  for (const name of TOOL_GROUPS.core) assert.strictEqual(m.isToolEnabled(name), true);
  for (const name of TOOL_GROUPS.sessions) assert.strictEqual(m.isToolEnabled(name), false);
  for (const name of TOOL_GROUPS.database) assert.strictEqual(m.isToolEnabled(name), false);
});

await test('individual tool override wins over group disable (in custom mode)', () => {
  const m = new ToolConfigManager();
  m.config = {
    version: '1.0', mode: 'custom',
    groups: { database: { enabled: false } },
    tools: { ssh_db_query: true },
  };
  assert.strictEqual(m.isToolEnabled('ssh_db_query'), true,
    'explicit tool=true must override group=false');
  assert.strictEqual(m.isToolEnabled('ssh_db_dump'), false,
    'sibling in disabled group without override stays off');
});

await test('individual tool override can disable a tool inside an enabled group', () => {
  const m = new ToolConfigManager();
  m.config = {
    version: '1.0', mode: 'custom',
    groups: { core: { enabled: true } },
    tools: { ssh_execute: false },
  };
  assert.strictEqual(m.isToolEnabled('ssh_execute'), false);
  assert.strictEqual(m.isToolEnabled('ssh_list_servers'), true);
});

await test('isToolEnabled defaults to true before load (first-run safety)', () => {
  const m = new ToolConfigManager();
  // Nothing loaded; this.config is null.
  assert.strictEqual(m.isToolEnabled('ssh_execute'), true);
});

// --- group / tool mutators -----------------------------------------------
await test('disableGroup("core") is refused -- core is load-bearing', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  const r = await m.disableGroup('core');
  assert.strictEqual(r, false);
  // core stays enabled (disableGroup should not have mutated anything)
  assert.strictEqual(m.isToolEnabled('ssh_execute'), true);
});

await test('enableGroup / disableGroup on unknown group returns false', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(await m.enableGroup('nonsense'), false);
  assert.strictEqual(await m.disableGroup('nonsense'), false);
});

await test('enableTool / disableTool reject unknown tools', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(await m.enableTool('ssh_not_a_tool'), false);
  assert.strictEqual(await m.disableTool('ssh_not_a_tool'), false);
});

await test('setMode rejects invalid modes', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  assert.strictEqual(await m.setMode('garbage'), false);
  assert.strictEqual(m.config.mode, 'all', 'mode unchanged after bad setMode');
});

// --- summary + export ----------------------------------------------------
await test('getSummary returns counts matching registry', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  const s = m.getSummary();
  assert.strictEqual(s.totalTools, getAllTools().length);
  assert.strictEqual(s.enabledCount + s.disabledCount, s.totalTools);
  assert.strictEqual(s.groups.length, Object.keys(TOOL_GROUPS).length);
});

await test('exportClaudeCodeConfig emits mcp__ssh-manager__ prefixed patterns for every enabled tool', async () => {
  const cfgPath = makeTmpConfigPath();
  const m = makeManagerWithPath(cfgPath);
  await m.load();
  const exp = m.exportClaudeCodeConfig();
  const enabled = m.getEnabledTools();
  assert.strictEqual(exp.patterns.length, enabled.length);
  for (const p of exp.patterns) {
    assert(/^mcp__ssh-manager__ssh_/.test(p),
      `unexpected pattern shape: ${p}`);
  }
  assert(Array.isArray(exp.exampleConfig.autoApprove.tools));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
