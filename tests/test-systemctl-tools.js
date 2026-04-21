#!/usr/bin/env node
/** Tests for src/tools/systemctl-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  ALLOWED_ACTIONS,
  isValidUnit,
  parseListUnits, parseListUnitFiles, shapeUnitStatus, parseJournalLines,
  handleSshSystemctl,
} from '../src/tools/systemctl-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  write() {} end() {} signal() {} close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) { this.script = script || (() => ({ stdout: '', code: 0 })); this.commands = []; this.streams = []; }
  exec(cmd, cb) {
    this.commands.push(cmd);
    const s = new FakeStream(); this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      const { stdout = '', stderr = '', code = 0 } = this.script(cmd);
      setImmediate(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code);
      });
    });
  }
}

console.log('[test] Testing systemctl-tools\n');

// --- isValidUnit --------------------------------------------------------
await test('isValidUnit: well-formed service', () => assert.strictEqual(isValidUnit('nginx.service'), true));
await test('isValidUnit: timer is allowed', () => assert.strictEqual(isValidUnit('backup.timer'), true));
await test('isValidUnit: missing suffix rejected', () => assert.strictEqual(isValidUnit('nginx'), false));
await test('isValidUnit: path traversal rejected', () => assert.strictEqual(isValidUnit('../etc/passwd'), false));
await test('isValidUnit: shell metachar rejected', () => assert.strictEqual(isValidUnit('nginx.service; rm -rf /'), false));
await test('isValidUnit: space rejected', () => assert.strictEqual(isValidUnit('my unit.service'), false));
await test('isValidUnit: unknown suffix rejected', () => assert.strictEqual(isValidUnit('nginx.bogus'), false));
await test('isValidUnit: null / undefined', () => { assert.strictEqual(isValidUnit(null), false); assert.strictEqual(isValidUnit(undefined), false); });
await test('isValidUnit: @ template', () => assert.strictEqual(isValidUnit('sshd@0.service'), true));

// --- parseListUnits -----------------------------------------------------
await test('parseListUnits: parses typical output', () => {
  const sample = [
    'nginx.service        loaded active running  nginx HTTP server',
    'cron.service         loaded active running  Regular background tasks',
  ].join('\n');
  const r = parseListUnits(sample);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].unit, 'nginx.service');
  assert.strictEqual(r[0].active, 'active');
  assert.strictEqual(r[0].description, 'nginx HTTP server');
});

await test('parseListUnits: ignores footer lines', () => {
  const sample = [
    'nginx.service loaded active running desc',
    '',
    '54 loaded units listed.',
  ].join('\n');
  const r = parseListUnits(sample);
  assert.strictEqual(r.length, 1);
});

// --- parseListUnitFiles -------------------------------------------------
await test('parseListUnitFiles: parses state + vendor preset', () => {
  const sample = [
    'nginx.service  enabled  enabled',
    'cron.service   enabled',
  ].join('\n');
  const r = parseListUnitFiles(sample);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].state, 'enabled');
  assert.strictEqual(r[0].vendor_preset, 'enabled');
  assert.strictEqual(r[1].vendor_preset, null);
});

// --- shapeUnitStatus ----------------------------------------------------
await test('shapeUnitStatus: typed shape with numeric parsing', () => {
  const r = shapeUnitStatus('nginx.service', {
    ActiveState: 'active', SubState: 'running',
    LoadState: 'loaded', UnitFileState: 'enabled',
    Description: 'nginx', MainPID: '1234', MemoryCurrent: '5242880', CPUUsageNSec: '100000000',
  }, ['line1', 'line2']);
  assert.strictEqual(r.unit, 'nginx.service');
  assert.strictEqual(r.active_state, 'active');
  assert.strictEqual(r.main_pid, 1234);
  assert.strictEqual(r.memory_bytes, 5242880);
  assert.deepStrictEqual(r.recent_logs, ['line1', 'line2']);
});

await test('shapeUnitStatus: missing numeric props coerce to null', () => {
  const r = shapeUnitStatus('x.service', { ActiveState: 'inactive', MemoryCurrent: '[not set]' }, []);
  assert.strictEqual(r.memory_bytes, null);
});

// --- parseJournalLines --------------------------------------------------
await test('parseJournalLines: keeps last N, drops boilerplate', () => {
  const txt = [
    '-- Logs begin at Mon 2024-01-01 --',
    'Jan 01 12:00 host nginx[1]: hello',
    'Jan 01 12:01 host nginx[1]: world',
    'Jan 01 12:02 host nginx[1]: again',
  ].join('\n');
  const r = parseJournalLines(txt, 2);
  assert.strictEqual(r.length, 2);
  assert(r[0].includes('world'));
  assert(r[1].includes('again'));
});

// --- handleSshSystemctl -------------------------------------------------
await test('handleSshSystemctl: unknown action -> fail, no remote', async () => {
  let called = false;
  const r = await handleSshSystemctl({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'exfiltrate', unit: 'nginx.service' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshSystemctl: invalid unit rejected before remote', async () => {
  let called = false;
  const r = await handleSshSystemctl({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'restart', unit: 'nginx.service; rm -rf /' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('handleSshSystemctl: restart preview shows reversibility:auto', async () => {
  let called = false;
  const r = await handleSshSystemctl({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'restart', unit: 'nginx.service', preview: true, format: 'json' },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'auto');
});

await test('handleSshSystemctl: stop preview shows reversibility:manual', async () => {
  const r = await handleSshSystemctl({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', action: 'stop', unit: 'nginx.service', preview: true, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.reversibility, 'manual');
});

await test('handleSshSystemctl: status happy path returns typed data', async () => {
  // Handler issues ONE bash -c with both sections; parse by markers.
  const out = [
    '---SHOW---',
    'ActiveState=active',
    'SubState=running',
    'LoadState=loaded',
    'UnitFileState=enabled',
    'Description=nginx',
    'MainPID=1234',
    'MemoryCurrent=1000000',
    'CPUUsageNSec=500000000',
    '---LOGS---',
    'Jan 01 host nginx[1]: hello',
    'Jan 01 host nginx[1]: world',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout: out, code: 0 }) });
  const r = await handleSshSystemctl({
    getConnection: async () => client,
    args: { server: 's', action: 'status', unit: 'nginx.service', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.active_state, 'active');
  assert.strictEqual(parsed.data.main_pid, 1234);
  assert(Array.isArray(parsed.data.recent_logs));
  assert(parsed.data.recent_logs.length >= 2);
});

await test('handleSshSystemctl: list-units parses typed array', async () => {
  const client = new FakeClient({ script: () => ({
    stdout: 'nginx.service loaded active running nginx HTTP',
    code: 0,
  }) });
  const r = await handleSshSystemctl({
    getConnection: async () => client,
    args: { server: 's', action: 'list-units', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert(Array.isArray(parsed.data.units));
  assert.strictEqual(parsed.data.units[0].unit, 'nginx.service');
});

await test('ALLOWED_ACTIONS exports a Set with expected verbs', () => {
  assert(ALLOWED_ACTIONS.has('start'));
  assert(ALLOWED_ACTIONS.has('status'));
  assert(!ALLOWED_ACTIONS.has('eval'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
