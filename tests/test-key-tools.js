#!/usr/bin/env node
/** Tests for src/tools/key-tools.js */
import assert from 'assert';
import crypto from 'crypto';
import {
  sha256Fingerprint, compareFingerprints,
  parseKnownHostLine, parseKnownHostsContent, parseKeyscanOutput,
  fetchLiveKeys,
  handleSshKeyManage, __resetInternalStore,
} from '../src/tools/key-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

console.log('[test] Testing key-tools\n');

// --- sha256Fingerprint --------------------------------------------------
await test('sha256Fingerprint: known vector (empty buffer)', () => {
  const fp = sha256Fingerprint(Buffer.alloc(0));
  // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  // base64 = 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
  // stripped = 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU
  assert.strictEqual(fp, 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
});

await test('sha256Fingerprint: format is SHA256:base64-no-padding', () => {
  const fp = sha256Fingerprint(Buffer.from('hello world'));
  assert(fp.startsWith('SHA256:'));
  assert(!fp.endsWith('='));
  // Matches the crypto computation
  const expected = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from('hello world')).digest('base64').replace(/=+$/, '');
  assert.strictEqual(fp, expected);
});

await test('sha256Fingerprint: throws on null input', () => {
  assert.throws(() => sha256Fingerprint(null));
});

// --- compareFingerprints ------------------------------------------------
await test('compareFingerprints: exact match', () => {
  const r = compareFingerprints('SHA256:abc', 'SHA256:abc');
  assert.strictEqual(r.match, true);
  assert.strictEqual(r.algorithm, 'SHA256');
  assert.strictEqual(r.mismatch_details, undefined);
});

await test('compareFingerprints: fingerprint mismatch', () => {
  const r = compareFingerprints('SHA256:abc', 'SHA256:xyz');
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.mismatch_details.reason, 'fingerprint_mismatch');
});

await test('compareFingerprints: algorithm mismatch', () => {
  const r = compareFingerprints('MD5:abc', 'SHA256:abc');
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.mismatch_details.reason, 'algorithm_mismatch');
  assert.strictEqual(r.algorithm, 'MD5!=SHA256');
});

await test('compareFingerprints: no_stored_key when stored is null', () => {
  const r = compareFingerprints(null, 'SHA256:xyz');
  assert.strictEqual(r.match, false);
  assert.strictEqual(r.mismatch_details.reason, 'no_stored_key');
});

await test('compareFingerprints: both null -> vacuous match', () => {
  const r = compareFingerprints(null, null);
  assert.strictEqual(r.match, true);
});

// --- parseKnownHostLine -------------------------------------------------
await test('parseKnownHostLine: typical line', () => {
  // ssh-rsa fake key is base64 of any bytes; use "AAAA"+something
  const fakeKey = Buffer.from('dummy-pubkey').toString('base64');
  const line = `example.com ssh-rsa ${fakeKey}`;
  const r = parseKnownHostLine(line);
  assert.strictEqual(r.host, 'example.com');
  assert.strictEqual(r.port, 22);
  assert.strictEqual(r.algorithm, 'ssh-rsa');
  assert(r.fingerprint.startsWith('SHA256:'));
});

await test('parseKnownHostLine: comma-separated hosts', () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const r = parseKnownHostLine(`host1,host2,host3 ssh-rsa ${fakeKey}`);
  assert.deepStrictEqual(r.hosts, ['host1', 'host2', 'host3']);
  assert.strictEqual(r.host, 'host1');
});

await test('parseKnownHostLine: [host]:port form', () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const r = parseKnownHostLine(`[bastion.example.com]:2222 ssh-ed25519 ${fakeKey}`);
  assert.strictEqual(r.host, 'bastion.example.com');
  assert.strictEqual(r.port, 2222);
});

await test('parseKnownHostLine: hashed host kept opaque', () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const r = parseKnownHostLine(`|1|abc+def|hash= ssh-rsa ${fakeKey}`);
  assert.strictEqual(r.hashed, true);
  assert.strictEqual(r.host, '(hashed)');
});

await test('parseKnownHostLine: comment returns null', () => {
  assert.strictEqual(parseKnownHostLine('# this is a comment'), null);
});

await test('parseKnownHostLine: blank returns null', () => {
  assert.strictEqual(parseKnownHostLine(''), null);
});

// --- parseKnownHostsContent ---------------------------------------------
await test('parseKnownHostsContent: multiple entries + skips comments', () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const content = [
    '# header comment',
    `host1 ssh-rsa ${fakeKey}`,
    '',
    `host2 ssh-ed25519 ${fakeKey}`,
    '   ',
  ].join('\n');
  const r = parseKnownHostsContent(content);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].host, 'host1');
  assert.strictEqual(r[1].host, 'host2');
});

// --- parseKeyscanOutput -------------------------------------------------
await test('parseKeyscanOutput: returns same shape as known_hosts parser', () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const r = parseKeyscanOutput(`host1 ssh-rsa ${fakeKey}`);
  assert.strictEqual(r.length, 1);
});

// --- handleSshKeyManage ------------------------------------------------
await test('handleSshKeyManage: missing action -> fail', async () => {
  const r = await handleSshKeyManage({ args: {} });
  assert.strictEqual(r.isError, true);
});

await test('handleSshKeyManage: list reads from injected known_hosts file', async () => {
  __resetInternalStore();
  const fakeKey = Buffer.from('x').toString('base64');
  const content = `host1 ssh-rsa ${fakeKey}`;
  const r = await handleSshKeyManage({
    fsReadKnownHosts: () => content,
    args: { action: 'list', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.known_hosts.length, 1);
  assert.strictEqual(parsed.data.known_hosts[0].host, 'host1');
  assert.strictEqual(parsed.data.known_hosts[0].source, 'openssh');
});

await test('handleSshKeyManage: show matches when stored = live', async () => {
  __resetInternalStore();
  const fakeKey = Buffer.from('abc').toString('base64');
  const hosts = `host1 ssh-rsa ${fakeKey}`;
  const r = await handleSshKeyManage({
    fsReadKnownHosts: () => hosts,
    runKeyscan: async () => `host1 ssh-rsa ${fakeKey}`,
    args: { action: 'show', host: 'host1', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.match, true);
  assert(parsed.data.comparisons.length > 0);
});

await test('handleSshKeyManage: verify mismatch flagged', async () => {
  __resetInternalStore();
  const storedKey = Buffer.from('stored').toString('base64');
  const liveKey = Buffer.from('different').toString('base64');
  const r = await handleSshKeyManage({
    fsReadKnownHosts: () => `host1 ssh-rsa ${storedKey}`,
    runKeyscan: async () => `host1 ssh-rsa ${liveKey}`,
    args: { action: 'verify', host: 'host1', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.match, false);
  assert(parsed.data.mismatch_details);
});

await test('handleSshKeyManage: show with no stored key -> no_stored_key', async () => {
  __resetInternalStore();
  const r = await handleSshKeyManage({
    fsReadKnownHosts: () => '',
    runKeyscan: async () => `host1 ssh-rsa ${Buffer.from('x').toString('base64')}`,
    args: { action: 'show', host: 'host1', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.match, false);
  assert.strictEqual(parsed.data.mismatch_details.reason, 'no_stored_key');
});

await test('handleSshKeyManage: keyscan error -> isError', async () => {
  __resetInternalStore();
  const r = await handleSshKeyManage({
    fsReadKnownHosts: () => '',
    runKeyscan: async () => { throw new Error('dns fail'); },
    args: { action: 'show', host: 'nonexistent', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
});

// --- fetchLiveKeys (with stub) ------------------------------------------
await test('fetchLiveKeys: uses injected runKeyscan', async () => {
  const fakeKey = Buffer.from('x').toString('base64');
  const keys = await fetchLiveKeys('example.com', 22, {
    runKeyscan: async () => `example.com ssh-rsa ${fakeKey}`,
  });
  assert.strictEqual(keys.length, 1);
  assert.strictEqual(keys[0].algorithm, 'ssh-rsa');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
