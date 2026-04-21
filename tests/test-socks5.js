#!/usr/bin/env node
/**
 * Tests for the SOCKS5 handler in src/tools/tunnel-tools.js.
 *
 * Covers:
 *   - parseSocksConnectRequest: IPv4, domain, IPv6, malformed, unsupported CMD.
 *   - handleSocks5Connection: full handshake happy path (greeting -> CONNECT ->
 *     reply -> streaming).
 *   - handleSocks5Connection: method negotiation fails when client offers
 *     only authenticated methods (no 0x00 method).
 *   - handleSocks5Connection: forwardOut error surfaces a SOCKS error reply.
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  parseSocksConnectRequest,
  handleSocks5Connection,
} from '../src/tools/tunnel-tools.js';

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

// --- parseSocksConnectRequest --------------------------------------------
test('parseSocksConnectRequest: IPv4 target', () => {
  // VER=5 CMD=1 RSV=0 ATYP=1 ADDR=1.2.3.4 PORT=80 (0x0050)
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]);
  const r = parseSocksConnectRequest(buf);
  assert.strictEqual(r.host, '1.2.3.4');
  assert.strictEqual(r.port, 80);
  assert.strictEqual(r.atyp, 0x01);
  assert.strictEqual(r.consumed, 10);
});

test('parseSocksConnectRequest: domain name target', () => {
  const host = 'example.com';
  const hostBytes = Buffer.from(host, 'ascii');
  // VER=5 CMD=1 RSV=0 ATYP=3 LEN=11 ADDR=example.com PORT=443 (0x01bb)
  const buf = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
    hostBytes,
    Buffer.from([0x01, 0xbb]),
  ]);
  const r = parseSocksConnectRequest(buf);
  assert.strictEqual(r.host, 'example.com');
  assert.strictEqual(r.port, 443);
  assert.strictEqual(r.atyp, 0x03);
});

test('parseSocksConnectRequest: IPv6 target', () => {
  // VER=5 CMD=1 RSV=0 ATYP=4 ADDR=::1 PORT=22
  const addr = Buffer.alloc(16);
  addr[15] = 1; // ::1
  const buf = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x04]),
    addr,
    Buffer.from([0x00, 0x16]),
  ]);
  const r = parseSocksConnectRequest(buf);
  assert.strictEqual(r.host, '0:0:0:0:0:0:0:1');
  assert.strictEqual(r.port, 22);
  assert.strictEqual(r.atyp, 0x04);
});

test('parseSocksConnectRequest: rejects non-CONNECT CMD', () => {
  const buf = Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0, 80]);
  assert.throws(() => parseSocksConnectRequest(buf), /CONNECT/);
});

test('parseSocksConnectRequest: rejects bad VER', () => {
  const buf = Buffer.from([0x04, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0, 80]);
  assert.throws(() => parseSocksConnectRequest(buf), /VER/);
});

test('parseSocksConnectRequest: rejects unknown ATYP', () => {
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x09,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => parseSocksConnectRequest(buf), /ATYP/);
});

// --- handleSocks5Connection ----------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.ended = false;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 51234;
  }
  write(buf) { this.writes.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
  pipe(dst) { return dst; }
}

function makeFakeSsh({ forwardError = null } = {}) {
  const client = {
    calls: [],
    streams: [],
    forwardOut(sa, sp, da, dp, cb) {
      this.calls.push({ sa, sp, da, dp });
      if (forwardError) { return setImmediate(() => cb(forwardError)); }
      const stream = new EventEmitter();
      stream.destroy = () => {};
      stream.write = () => true;
      stream.pipe = (dst) => dst;
      this.streams.push(stream);
      setImmediate(() => cb(null, stream));
    },
  };
  return client;
}

test('handleSocks5Connection: greeting -> CONNECT IPv4 -> success reply', async () => {
  const sock = new FakeSocket();
  const ssh = makeFakeSsh();
  handleSocks5Connection(sock, ssh);
  // Greeting: VER=5 NMETHODS=1 METHODS=[0x00]
  sock.emit('data', Buffer.from([0x05, 0x01, 0x00]));
  await new Promise(r => setImmediate(r));
  // Server replies VER=5 METHOD=0x00
  assert.deepStrictEqual(Array.from(sock.writes[0]), [0x05, 0x00]);
  // CONNECT to 1.2.3.4:80
  sock.emit('data', Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]));
  await new Promise(r => setImmediate(r));
  // ssh.forwardOut invoked with right host:port
  assert.strictEqual(ssh.calls.length, 1);
  assert.strictEqual(ssh.calls[0].da, '1.2.3.4');
  assert.strictEqual(ssh.calls[0].dp, 80);
  // Reply contains SUCCEEDED (0x00 in second byte)
  const last = sock.writes[sock.writes.length - 1];
  assert.strictEqual(last[0], 0x05);
  assert.strictEqual(last[1], 0x00, `expected SUCCEEDED reply, got ${last[1]}`);
});

test('handleSocks5Connection: client offering only auth methods gets 0xFF', async () => {
  const sock = new FakeSocket();
  const ssh = makeFakeSsh();
  handleSocks5Connection(sock, ssh);
  // Greeting: VER=5 NMETHODS=1 METHODS=[0x02]  (GSSAPI/user-pass only, no 0x00)
  sock.emit('data', Buffer.from([0x05, 0x01, 0x02]));
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(Array.from(sock.writes[0]), [0x05, 0xff]);
  assert.strictEqual(sock.ended, true);
  assert.strictEqual(ssh.calls.length, 0, 'no forwardOut should have been made');
});

test('handleSocks5Connection: forwardOut refused surfaces CONNECTION_REFUSED reply', async () => {
  const sock = new FakeSocket();
  const ssh = makeFakeSsh({ forwardError: new Error('connection refused by remote') });
  handleSocks5Connection(sock, ssh);
  sock.emit('data', Buffer.from([0x05, 0x01, 0x00]));
  await new Promise(r => setImmediate(r));
  sock.emit('data', Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]));
  await new Promise(r => setImmediate(r));
  const last = sock.writes[sock.writes.length - 1];
  assert.strictEqual(last[0], 0x05);
  assert.strictEqual(last[1], 0x05, 'expected REP=CONNECTION_REFUSED (0x05)');
});

test('handleSocks5Connection: handles domain-ATYP CONNECT', async () => {
  const sock = new FakeSocket();
  const ssh = makeFakeSsh();
  handleSocks5Connection(sock, ssh);
  sock.emit('data', Buffer.from([0x05, 0x01, 0x00]));
  await new Promise(r => setImmediate(r));
  const host = 'example.com';
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    Buffer.from(host, 'ascii'),
    Buffer.from([0x01, 0xbb]),
  ]);
  sock.emit('data', req);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ssh.calls[0].da, 'example.com');
  assert.strictEqual(ssh.calls[0].dp, 443);
});

await new Promise(r => setTimeout(r, 50)); // flush pending setImmediate callbacks

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
