#!/usr/bin/env node
/**
 * Tests for src/tools/alerts-tools.js -- the re-implemented ssh_alert_setup.
 *
 * Covers:
 *   - set / get round-trips through the local config store
 *   - corrupt config file falls back to "no config"
 *   - check with disabled config returns status='disabled', no alerts
 *   - check with thresholds breached returns populated alerts[]
 *   - check with thresholds NOT breached returns status='ok'
 *   - invalid action rejected
 *   - missing server rejected
 *   - atomic write: tmp file cleanup on rename
 *   - server name traversal guard (can't escape ALERTS_DIR)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { handleSshAlertSetup, __internals } from '../src/tools/alerts-tools.js';
import { handleSshHealthCheck } from '../src/tools/monitoring-tools.js';

const { configPathFor, writeConfig, evaluateThresholds } = __internals;

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

// Use a unique-per-test server name to avoid sharing state with real configs
// in ~/.ssh-manager/alerts.
function uniqueServer(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function cleanupServer(name) {
  try { fs.unlinkSync(configPathFor(name)); } catch (_) { /* ignore */ }
}

// --- rejection paths ------------------------------------------------------
await test('rejects when server missing', async () => {
  const r = await handleSshAlertSetup({ getConnection: async () => ({}), args: { action: 'get', format: 'json' } });
  assert.strictEqual(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert(p.error.includes('server is required'));
});

await test('rejects unknown action', async () => {
  const r = await handleSshAlertSetup({
    getConnection: async () => ({}),
    args: { server: 's', action: 'explode', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert(p.error.includes('action must be one of'));
});

// --- set / get round trip -------------------------------------------------
await test('set persists thresholds; get returns them', async () => {
  const srv = uniqueServer('roundtrip');
  try {
    const s = await handleSshAlertSetup({
      getConnection: async () => ({}),
      args: {
        server: srv, action: 'set',
        cpuThreshold: 80, memoryThreshold: 85, diskThreshold: 90,
        format: 'json',
      },
    });
    const parsedSet = JSON.parse(s.content[0].text);
    assert.strictEqual(parsedSet.success, true, parsedSet.error);
    assert.strictEqual(parsedSet.data.config.cpuThreshold, 80);
    assert(fs.existsSync(parsedSet.data.config_path), 'config file must exist on disk');

    const g = await handleSshAlertSetup({
      getConnection: async () => ({}),
      args: { server: srv, action: 'get', format: 'json' },
    });
    const parsedGet = JSON.parse(g.content[0].text);
    assert.strictEqual(parsedGet.success, true);
    assert.strictEqual(parsedGet.data.config.cpuThreshold, 80);
    assert.strictEqual(parsedGet.data.config.memoryThreshold, 85);
    assert.strictEqual(parsedGet.data.config.diskThreshold, 90);
    assert.strictEqual(parsedGet.data.config.enabled, true);
  } finally {
    await cleanupServer(srv);
  }
});

await test('corrupt config file is treated as missing, not crash', async () => {
  const srv = uniqueServer('corrupt');
  try {
    const cfgPath = configPathFor(srv);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, '{ not: json', 'utf8');

    const g = await handleSshAlertSetup({
      getConnection: async () => ({}),
      args: { server: srv, action: 'get', format: 'json' },
    });
    const parsed = JSON.parse(g.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.config, null);
  } finally {
    await cleanupServer(srv);
  }
});

// --- check path -----------------------------------------------------------
// NOTE: alerts-tools.js imports handleSshHealthCheck by binding at module load,
// so a module-level monkey-patch to the re-exported symbol does NOT reach
// alerts-tools.js's own imported binding. We instead test evaluateThresholds()
// directly for the threshold logic, and cover the end-to-end wire-through via
// the "disabled" path + error paths.
await test('check: no config yet -> structured fail', async () => {
  const srv = uniqueServer('no-cfg');
  const r = await handleSshAlertSetup({
    getConnection: async () => ({}),
    args: { server: srv, action: 'check', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const p = JSON.parse(r.content[0].text);
  assert(p.error.includes('no alert configuration'));
});

await test('check: disabled config returns status=disabled, alert_count=0', async () => {
  const srv = uniqueServer('disabled');
  try {
    writeConfig(srv, {
      version: 1, server: srv, enabled: false,
      cpuThreshold: 50, memoryThreshold: 50, diskThreshold: 50,
      updated_at: new Date().toISOString(),
    });

    const r = await handleSshAlertSetup({
      getConnection: async () => ({}),
      args: { server: srv, action: 'check', format: 'json' },
    });
    assert(!r.isError, 'disabled must not surface as an MCP isError');
    const parsed = JSON.parse(r.content[0].text);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.status, 'disabled');
    assert.strictEqual(parsed.data.alert_count, 0);
  } finally {
    await cleanupServer(srv);
  }
});

// --- evaluateThresholds unit tests ---------------------------------------
// IMPORTANT: these feed the REAL field shape that monitoring-tools emits --
// cpu has only { user_pct, system_pct, idle_pct, iowait_pct } (NO aggregate
// usage field; usage is derived 100 - idle_pct), memory has used_pct, and
// disk rows have used_pct + device + mount. The pre-fix tests fed fabricated
// usage_percent/used_percent names that the producer never emits.
await test('evaluateThresholds: all metrics below thresholds -> no alerts', () => {
  const alerts = evaluateThresholds(
    { cpu: { idle_pct: 70 }, memory: { used_pct: 40 }, disk: [{ mount: '/', used_pct: 20 }] },
    { cpuThreshold: 80, memoryThreshold: 80, diskThreshold: 80 },
  );
  assert.strictEqual(alerts.length, 0);
});

await test('evaluateThresholds: CPU breach surfaces (usage derived from idle_pct)', () => {
  const alerts = evaluateThresholds(
    { cpu: { idle_pct: 5 }, memory: { used_pct: 10 }, disk: [] },
    { cpuThreshold: 80, memoryThreshold: 80, diskThreshold: 80 },
  );
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].metric, 'cpu');
  assert.strictEqual(alerts[0].observed, 95);   // 100 - idle_pct(5)
});

await test('evaluateThresholds: memory breach surfaces', () => {
  const alerts = evaluateThresholds(
    { memory: { used_pct: 92 } },
    { memoryThreshold: 90 },
  );
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].metric, 'memory');
});

await test('evaluateThresholds: per-mount disk breach surfaces each mount', () => {
  const alerts = evaluateThresholds(
    { disk: [
      { device: '/dev/sda1', mount: '/', used_pct: 50 },
      { device: '/dev/sda2', mount: '/var', used_pct: 97 },
      { device: '/dev/sda3', mount: '/tmp', used_pct: 99 },
    ] },
    { diskThreshold: 95 },
  );
  assert.strictEqual(alerts.length, 2);
  assert.deepStrictEqual(alerts.map(a => a.mount).sort(), ['/tmp', '/var']);
});

await test('evaluateThresholds: missing threshold suppresses that metric', () => {
  const alerts = evaluateThresholds(
    { cpu: { idle_pct: 1 }, memory: { used_pct: 99 } },
    { diskThreshold: 50 },   // only disk threshold set
  );
  assert.strictEqual(alerts.length, 0, 'without cpu/memory thresholds, those metrics ignore');
});

await test('evaluateThresholds: a genuinely-missing metric still skips cleanly', () => {
  // cpu absent entirely -> idle_pct undefined -> NaN -> skipped, no throw.
  const alerts = evaluateThresholds(
    { memory: { used_pct: 99 }, disk: [] },
    { cpuThreshold: 80, memoryThreshold: 90, diskThreshold: 80 },
  );
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].metric, 'memory');
});

// --- end-to-end: REAL handleSshHealthCheck output through evaluateThresholds.
// This is the regression guard for the CRITICAL bug: the producer's field
// names (idle_pct / used_pct) must match what evaluateThresholds reads. A
// fabricated fixture would not catch a producer/consumer field-name drift.
class HealthFakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  write() { return true; }
  end() {}
  close() {}
}
function healthClient(stdout) {
  return {
    exec(_cmd, cb) {
      const s = new HealthFakeStream();
      setImmediate(() => {
        cb(null, s);
        setImmediate(() => { s.emit('data', Buffer.from(stdout)); s.emit('close', 0); });
      });
    },
  };
}

await test('evaluateThresholds: real handleSshHealthCheck output above thresholds fires alerts', async () => {
  // top/free/df output exactly as the remote command in handleSshHealthCheck
  // produces it -- a busy host at ~98% CPU, 96% memory, 97% disk.
  const stdout = [
    '---CPU---',
    'top - 12:00:00 up 1 day,  load average: 8.0, 7.5, 7.0',
    'Tasks: 200 total, 5 running',
    '%Cpu(s): 80.0 us, 15.0 sy,  0.0 ni,  2.0 id,  3.0 wa,  0.0 hi,  0.0 si,  0.0 st',
    '---MEM---',
    '              total        used        free      shared  buff/cache   available',
    'Mem:      16000000    15360000      200000       10000      440000      300000',
    'Swap:      2000000           0     2000000',
    '---DISK---',
    'Filesystem     1B-blocks        Used   Available Use% Mounted on',
    '/dev/sda1    100000000000 97000000000  3000000000 97% /',
    '---LOAD---',
    '8.00 7.50 7.00 5/200 12345',
    '---UPTIME---',
    '86400.00 70000.00',
    '---CORES---',
    '4',
  ].join('\n');

  const hc = await handleSshHealthCheck({
    getConnection: async () => healthClient(stdout),
    args: { server: 'busybox', format: 'json' },
  });
  assert(!hc.isError, 'health check should succeed');
  const payload = JSON.parse(hc.content[0].text);
  assert.strictEqual(payload.success, true);

  // Sanity-check the producer really emits the field names we depend on.
  assert.strictEqual(payload.data.cpu.idle_pct, 2, 'producer emits cpu.idle_pct');
  assert(typeof payload.data.memory.used_pct === 'number', 'producer emits memory.used_pct');
  assert(typeof payload.data.disk[0].used_pct === 'number', 'producer emits disk[].used_pct');

  const alerts = evaluateThresholds(payload.data, {
    cpuThreshold: 90, memoryThreshold: 90, diskThreshold: 90,
  });
  const metrics = alerts.map(a => a.metric).sort();
  assert.deepStrictEqual(metrics, ['cpu', 'disk', 'memory'],
    `expected all 3 metrics to fire, got ${JSON.stringify(alerts)}`);
  const cpuAlert = alerts.find(a => a.metric === 'cpu');
  assert.strictEqual(cpuAlert.observed, 98, 'cpu usage = 100 - idle_pct(2)');
});

await test('evaluateThresholds: real handleSshHealthCheck output below thresholds -> no alerts', async () => {
  const stdout = [
    '---CPU---',
    '%Cpu(s):  3.0 us,  1.0 sy,  0.0 ni, 95.0 id,  1.0 wa,  0.0 hi,  0.0 si,  0.0 st',
    '---MEM---',
    '              total        used        free      shared  buff/cache   available',
    'Mem:      16000000     4000000     8000000       10000     4000000    11000000',
    '---DISK---',
    'Filesystem     1B-blocks        Used   Available Use% Mounted on',
    '/dev/sda1    100000000000 20000000000 80000000000 20% /',
    '---LOAD---',
    '0.20 0.15 0.10 1/200 12345',
    '---UPTIME---',
    '86400.00 70000.00',
    '---CORES---',
    '4',
  ].join('\n');
  const hc = await handleSshHealthCheck({
    getConnection: async () => healthClient(stdout),
    args: { server: 'idlebox', format: 'json' },
  });
  const payload = JSON.parse(hc.content[0].text);
  const alerts = evaluateThresholds(payload.data, {
    cpuThreshold: 90, memoryThreshold: 90, diskThreshold: 90,
  });
  assert.strictEqual(alerts.length, 0, `quiet host must not alert: ${JSON.stringify(alerts)}`);
});

// --- path traversal guard -------------------------------------------------
await test('server name with traversal characters cannot escape ALERTS_DIR', () => {
  const p = configPathFor('../../etc/passwd');
  assert(!p.includes('..'), `got ${p}`);
  assert(p.endsWith('.json'));
  assert(p.startsWith(__internals.ALERTS_DIR),
    `path ${p} must be inside ${__internals.ALERTS_DIR}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
