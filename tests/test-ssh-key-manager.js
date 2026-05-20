#!/usr/bin/env node
/**
 * Tests for src/ssh-key-manager.js host matching.
 *
 * isHostKnown / getCurrentHostKey are wired into the live connect()
 * host-key verifier. They previously used substring `line.includes(host)`,
 * so `example.com` matched a `notexample.com` line, an `example.com.evil`
 * line, or a coincidence inside the base64 key body -- a mismatch silently
 * fell through to TOFU re-acceptance.
 *
 * These tests stub `fs` so the module's hardcoded KNOWN_HOSTS_PATH resolves
 * to controlled content; no real ~/.ssh/known_hosts is read or written.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.ssh', 'known_hosts');

// -- fs stub: intercept ONLY the known_hosts path, pass everything else --
let fakeKnownHosts = null;            // string content, or null = file absent
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
fs.existsSync = (p) => (p === KNOWN_HOSTS_PATH ? fakeKnownHosts !== null : realExistsSync(p));
fs.readFileSync = (p, enc) => (p === KNOWN_HOSTS_PATH ? fakeKnownHosts : realReadFileSync(p, enc));

// Import AFTER the stub is installed.
const { isHostKnown, getCurrentHostKey } = await import('../src/ssh-key-manager.js');

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

// A real-shape ed25519 known_hosts key (any valid base64 works for matching).
const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIByexample0000000000000000000000000000';
const line = (hostspec) => `${hostspec} ssh-ed25519 ${KEY}`;

console.log('[test] Testing ssh-key-manager host matching\n');

// -- the headline bug -----------------------------------------------------
test('isHostKnown: example.com is NOT known when only notexample.com is on file', () => {
  fakeKnownHosts = line('notexample.com') + '\n';
  assert.strictEqual(isHostKnown('example.com', 22), false,
    'substring match would wrongly report example.com as known');
});

test('isHostKnown: example.com is NOT known when only example.com.evil.net is on file', () => {
  fakeKnownHosts = line('example.com.evil.net') + '\n';
  assert.strictEqual(isHostKnown('example.com', 22), false,
    'a longer hostname containing example.com must not match');
});

test('isHostKnown: a coincidental base64 substring in the key body never matches', () => {
  // host token "deadbeef" appears nowhere as a host, but does inside the key.
  fakeKnownHosts = `realhost ssh-ed25519 AAAAdeadbeefBBBBexample0000000000000000\n`;
  assert.strictEqual(isHostKnown('deadbeef', 22), false,
    'matching against the key body is a substring-match artifact');
});

// -- positive matches still work -----------------------------------------
test('isHostKnown: exact host on default port matches', () => {
  fakeKnownHosts = line('example.com') + '\n';
  assert.strictEqual(isHostKnown('example.com', 22), true);
});

test('isHostKnown: [host]:port form matches the right non-22 port', () => {
  fakeKnownHosts = line('[example.com]:2222') + '\n';
  assert.strictEqual(isHostKnown('example.com', 2222), true, 'exact port 2222 matches');
  assert.strictEqual(isHostKnown('example.com', 22), false, 'port 22 must not match a :2222 entry');
});

test('isHostKnown: comma-separated host list matches any listed host exactly', () => {
  fakeKnownHosts = line('alias.example.com,192.0.2.10') + '\n';
  assert.strictEqual(isHostKnown('192.0.2.10', 22), true, 'second host in the list matches');
  assert.strictEqual(isHostKnown('alias.example.com', 22), true, 'first host matches');
  assert.strictEqual(isHostKnown('192.0.2.1', 22), false, 'prefix of a listed IP must not match');
});

test('isHostKnown: hashed |1| entries never match (cannot be un-hashed)', () => {
  fakeKnownHosts = `|1|abcd1234salt=|hash5678value= ssh-ed25519 ${KEY}\n`;
  assert.strictEqual(isHostKnown('example.com', 22), false,
    'hashed known_hosts entries are opaque -> reported not-known');
});

test('isHostKnown: file absent -> not known', () => {
  fakeKnownHosts = null;
  assert.strictEqual(isHostKnown('example.com', 22), false);
});

test('isHostKnown: comments and blank lines are ignored', () => {
  fakeKnownHosts = `# a comment mentioning example.com\n\n${line('other.host')}\n`;
  assert.strictEqual(isHostKnown('example.com', 22), false,
    'example.com inside a comment must not count');
});

// -- getCurrentHostKey uses the same exact matcher ------------------------
test('getCurrentHostKey: returns null for a non-matching longer hostname', () => {
  fakeKnownHosts = line('example.com.evil.net') + '\n';
  assert.strictEqual(getCurrentHostKey('example.com', 22), null);
});

test('getCurrentHostKey: returns the key for an exact host match', () => {
  fakeKnownHosts = line('example.com') + '\n';
  const keys = getCurrentHostKey('example.com', 22);
  assert(Array.isArray(keys) && keys.length === 1, 'one key returned');
  assert(keys[0].fingerprint.startsWith('SHA256:'), 'fingerprint computed');
});

test('getCurrentHostKey: does not pick up a hashed entry', () => {
  fakeKnownHosts = `|1|saltsaltsalt=|hashhashhash= ssh-ed25519 ${KEY}\n`;
  assert.strictEqual(getCurrentHostKey('example.com', 22), null);
});

// -- restore + summary ----------------------------------------------------
fs.existsSync = realExistsSync;
fs.readFileSync = realReadFileSync;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
