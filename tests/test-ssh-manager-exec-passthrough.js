// Regression test: the modular tool handlers (exec, db, deploy, monitoring,
// systemctl, journalctl, cat, tail, transfer, etc.) all pass the SSHManager
// instance returned by getConnection() into stream-exec.js's streamExecCommand,
// which then calls `client.exec(...)`. SSHManager wraps an ssh2 Client; if
// .exec isn't exposed as a passthrough, every tool fails at runtime with
// "client.exec is not a function" while every unit test still passes.
//
// This test asserts the passthrough exists and forwards arguments correctly.

import SSHManager from '../src/ssh-manager.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  [ok] ${msg}`); passed++; }
  else { console.log(`  [FAIL] ${msg}`); failed++; }
}

// 1. The method exists
const mgr = new SSHManager({ host: 'x', user: 'x' });
assert(typeof mgr.exec === 'function', 'SSHManager.exec is a function');

// 2. It forwards (cmd, cb) to the underlying ssh2 client
let captured = null;
mgr.client = {
  exec(cmd, optsOrCb, maybeCb) {
    captured = { cmd, optsOrCb, maybeCb };
  },
};
mgr.exec('uname -a', () => {});
assert(captured?.cmd === 'uname -a', 'forwards command string');
assert(typeof captured?.optsOrCb === 'function', 'forwards callback as 2nd arg when no options given');
assert(captured?.maybeCb === undefined, 'no 3rd arg when no options given');

// 3. It forwards (cmd, opts, cb) when options are provided
captured = null;
mgr.exec('echo hi', { pty: true }, () => {});
assert(captured?.cmd === 'echo hi', 'forwards command with options');
assert(captured?.optsOrCb?.pty === true, 'forwards options object');
assert(typeof captured?.maybeCb === 'function', 'forwards callback as 3rd arg when options given');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
