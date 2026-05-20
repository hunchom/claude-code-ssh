#!/usr/bin/env node
/**
 * Test suite for SSHManager.isAlive() -- the synchronous pool liveness check.
 * Run: node tests/test-ssh-manager-isalive.js
 */
import assert from 'assert';
import SSHManager from '../src/ssh-manager.js';

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

console.log('[test] Testing SSHManager.isAlive\n');

// --- isAlive -------------------------------------------------------------
test('isAlive: fresh manager (not yet connected) is not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: connected and client not destroyed -> alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: false };
  assert.strictEqual(m.isAlive(), true);
});

test('isAlive: connected but client destroyed -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: true };
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: client absent -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = null;
  assert.strictEqual(m.isAlive(), false);
});

test('isAlive: returns a real boolean, never a Promise', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = true;
  m.client = { destroyed: false };
  const v = m.isAlive();
  assert.strictEqual(typeof v, 'boolean', 'synchronous -- no thenable');
});

test('isAlive: not connected, even with a live client -> not alive', () => {
  const m = new SSHManager({ host: 'h', user: 'u' });
  m.connected = false;
  m.client = { destroyed: false };
  assert.strictEqual(m.isAlive(), false);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
