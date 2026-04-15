// Regression test: the modular tool handlers (exec, db, deploy, monitoring,
// systemctl, journalctl, cat, tail, transfer, tunnels, etc.) all expect the
// node-ssh2 Client surface (.exec, .sftp, .forwardOut), but getConnection()
// returns an SSHManager wrapper. Without passthroughs every call fails at
// runtime with "client.{exec,sftp,forwardOut} is not a function" or hangs
// silently — while every existing unit test passes (they mock SSH).

import SSHManager from '../src/ssh-manager.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  [ok] ${msg}`); passed++; }
  else { console.log(`  [FAIL] ${msg}`); failed++; }
}

const mgr = new SSHManager({ host: 'x', user: 'x' });
mgr.connected = true;

// --- exec passthrough ---
assert(typeof mgr.exec === 'function', 'SSHManager.exec is a function');

let captured = null;
mgr.client = {
  exec(cmd, optsOrCb, maybeCb) { captured = { cmd, optsOrCb, maybeCb }; },
  sftp(cb) { captured = { sftpCb: cb }; },
  forwardOut(srcA, srcP, dstA, dstP, cb) { captured = { srcA, srcP, dstA, dstP, cb }; },
};

mgr.exec('uname -a', () => {});
assert(captured?.cmd === 'uname -a', 'exec forwards command string');
assert(typeof captured?.optsOrCb === 'function', 'exec forwards callback as 2nd arg without options');
assert(captured?.maybeCb === undefined, 'exec no 3rd arg without options');

captured = null;
mgr.exec('echo hi', { pty: true }, () => {});
assert(captured?.cmd === 'echo hi', 'exec forwards command with options');
assert(captured?.optsOrCb?.pty === true, 'exec forwards options object');
assert(typeof captured?.maybeCb === 'function', 'exec forwards callback as 3rd arg with options');

// --- sftp passthrough ---
assert(typeof mgr.sftp === 'function', 'SSHManager.sftp is a function');
captured = null;
const sftpCb = (err, sftp) => {};
mgr.sftp(sftpCb);
assert(captured?.sftpCb === sftpCb, 'sftp forwards callback to underlying client');

// --- forwardOut callback-style (used by tunnel-tools.js) ---
captured = null;
const fwdCb = () => {};
mgr.forwardOut('127.0.0.1', 1234, 'remote.host', 22, fwdCb);
assert(captured?.cb === fwdCb, 'forwardOut callback-style passes cb to underlying client');
assert(captured?.srcA === '127.0.0.1' && captured?.dstP === 22, 'forwardOut callback-style passes src/dst args');

// --- forwardOut Promise-style (used by index.js for proxy jumps) ---
let resolvedStream = null;
mgr.client.forwardOut = (srcA, srcP, dstA, dstP, cb) => cb(null, { tag: 'mockStream' });
const promise = mgr.forwardOut('127.0.0.1', 0, 'jump.host', 22);
assert(promise && typeof promise.then === 'function', 'forwardOut Promise-style returns a Promise');
await promise.then(s => { resolvedStream = s; });
assert(resolvedStream?.tag === 'mockStream', 'forwardOut Promise-style resolves with the stream');

// --- error paths ---
mgr.connected = false;
const fwdRejection = mgr.forwardOut('127.0.0.1', 0, 'jump.host', 22);
let rejected = false;
await fwdRejection.catch(() => { rejected = true; });
assert(rejected, 'forwardOut Promise-style rejects when not connected');

let cbErr = null;
mgr.forwardOut('127.0.0.1', 0, 'h', 22, e => { cbErr = e; });
assert(cbErr instanceof Error, 'forwardOut callback-style invokes cb with error when not connected');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
