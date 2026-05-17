#!/usr/bin/env node
/**
 * Test suite for the PreToolUse Bash-nudge detector.
 * Run: node tests/test-bash-nudge.js
 */
import assert from 'assert';
import { detectSshNudge } from '../.claude/hooks/ssh-bash-nudge.mjs';

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

console.log('[test] Testing bash-nudge detector\n');

const SERVERS = ['prod01', 'devcentos', 'db1'];

// --- positive: simple ssh -----------------------------------------------
test('plain "ssh <host> <cmd>" against a configured server is nudged', () => {
  const n = detectSshNudge('ssh prod01 uptime', SERVERS);
  assert(n, 'a nudge is returned');
  assert.strictEqual(n.tool, 'ssh_run');
  assert(n.message.includes('prod01'), 'names the server');
  assert(n.message.includes('ssh_run'), 'names the suggested tool');
});

test('"ssh user@host" form is matched on the host part', () => {
  const n = detectSshNudge('ssh root@devcentos df -h', SERVERS);
  assert(n && n.tool === 'ssh_run');
});

test('ssh with a -p port flag before the host is still matched', () => {
  const n = detectSshNudge('ssh -p 22 prod01 whoami', SERVERS);
  assert(n && n.tool === 'ssh_run');
});

// --- positive: scp / rsync ----------------------------------------------
test('scp to a configured server is nudged toward ssh_file', () => {
  const n = detectSshNudge('scp ./app.tar prod01:/srv/app.tar', SERVERS);
  assert(n && n.tool === 'ssh_file');
});

test('rsync to a configured server is nudged toward ssh_file', () => {
  const n = detectSshNudge('rsync -a ./dist/ devcentos:/var/www/', SERVERS);
  assert(n && n.tool === 'ssh_file');
});

// --- negative: not a configured server ----------------------------------
test('ssh to an unconfigured host is NOT nudged', () => {
  assert.strictEqual(detectSshNudge('ssh some-random-box uptime', SERVERS), null);
});

test('a configured name as a substring of another host is not matched', () => {
  // "db1" must not match "db1.example.com" or "olddb1".
  assert.strictEqual(detectSshNudge('ssh db1.example.com ls', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh olddb1 ls', SERVERS), null);
});

// --- negative: complex command lines pass through -----------------------
test('a piped command line is passed through (no nudge)', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 ps aux | grep node', SERVERS), null);
});

test('command substitution is passed through (no nudge)', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 "$(cat cmd.txt)"', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh prod01 `hostname`', SERVERS), null);
});

test('an && / ; chained command line is passed through', () => {
  assert.strictEqual(detectSshNudge('cd /tmp && ssh prod01 ls', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh prod01 ls; echo done', SERVERS), null);
});

test('a redirected command line is passed through', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 cat big.log > out.txt', SERVERS), null);
});

test('non-ssh commands are never nudged', () => {
  assert.strictEqual(detectSshNudge('ls -la /tmp', SERVERS), null);
  assert.strictEqual(detectSshNudge('git status', SERVERS), null);
});

// --- fail-open ----------------------------------------------------------
test('empty / nullish command is safe and returns null', () => {
  assert.strictEqual(detectSshNudge('', SERVERS), null);
  assert.strictEqual(detectSshNudge(null, SERVERS), null);
  assert.strictEqual(detectSshNudge(undefined, SERVERS), null);
});

test('empty / nullish server list is safe and returns null', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 uptime', []), null);
  assert.strictEqual(detectSshNudge('ssh prod01 uptime', null), null);
});

test('an "ssh" substring inside another word does not trigger', () => {
  // "sshpass" / "myssh" must not be read as the ssh client.
  assert.strictEqual(detectSshNudge('sshpass -p x ssh prod01 ls', SERVERS), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
