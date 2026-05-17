#!/usr/bin/env node
/**
 * Tests for src/fleet-adapters.js -- the ssh_fleet action bodies lifted out
 * of index.js inline closures. Each adapter is exercised with injected deps.
 * Run: node tests/test-fleet-adapters.js
 */
import assert from 'assert';
import {
  fleetServers, fleetGroups, fleetAliases, fleetProfiles,
  fleetHooks, fleetHistory, fleetConnections,
} from '../src/fleet-adapters.js';

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

function isMcp(r) {
  return r && Array.isArray(r.content) && r.content[0] && r.content[0].type === 'text';
}

console.log('[test] Testing fleet-adapters\n');

await test('fleetServers lists configured servers from deps.loadServerConfig', async () => {
  const r = await fleetServers({
    args: {},
    deps: { loadServerConfig: () => ({ web1: { host: 'h1', user: 'u', port: '22' } }) },
  });
  assert(isMcp(r), 'returns MCP response');
  assert(r.content[0].text.includes('web1'), 'names the server');
});

await test('fleetGroups op=list returns an MCP response', async () => {
  const r = await fleetGroups({
    args: { op: 'list' },
    deps: { listGroups: () => [], createGroup: () => ({}), updateGroup: () => ({}),
      deleteGroup: () => {}, addServersToGroup: () => ({}), removeServersFromGroup: () => ({}) },
  });
  assert(isMcp(r));
});

await test('fleetGroups op=create without name -> isError', async () => {
  const r = await fleetGroups({
    args: { op: 'create' },
    deps: { listGroups: () => [], createGroup: () => ({}), updateGroup: () => ({}),
      deleteGroup: () => {}, addServersToGroup: () => ({}), removeServersFromGroup: () => ({}) },
  });
  assert.strictEqual(r.isError, true);
});

await test('fleetAliases op=list returns an MCP response', async () => {
  const r = await fleetAliases({
    args: { op: 'list' },
    deps: { listAliases: () => [], addAlias: () => {}, removeAlias: () => {},
      loadServerConfig: () => ({}), resolveServerName: () => 'web1' },
  });
  assert(isMcp(r));
});

await test('fleetProfiles op=list returns an MCP response', async () => {
  const r = await fleetProfiles({
    args: { op: 'list' },
    deps: { listProfiles: () => [], setActiveProfile: () => true,
      getActiveProfileName: () => 'default', loadProfile: () => ({}) },
  });
  assert(isMcp(r));
});

await test('fleetHooks op=list returns an MCP response', async () => {
  const r = await fleetHooks({
    args: { op: 'list' },
    deps: { listHooks: () => [], toggleHook: () => {} },
  });
  assert(isMcp(r));
});

await test('fleetHistory returns an MCP response from deps.logger', async () => {
  const r = await fleetHistory({
    args: { limit: 5 },
    deps: { logger: { getHistory: () => [] } },
  });
  assert(isMcp(r));
});

await test('fleetConnections op=status returns an MCP response', async () => {
  const r = await fleetConnections({
    args: { op: 'status' },
    deps: {
      connections: new Map(), connectionTimestamps: new Map(),
      keepaliveIntervals: new Map(),
      isConnectionValid: async () => true, closeConnection: () => {},
      cleanupOldConnections: () => {}, getConnection: async () => ({}),
      CONNECTION_TIMEOUT: 1800000, KEEPALIVE_INTERVAL: 300000,
    },
  });
  assert(isMcp(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
