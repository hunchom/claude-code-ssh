#!/usr/bin/env node
/** Tests for src/tools/tunnel-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  probeReachability,
  handleSshTunnelCreate, handleSshTunnelList, handleSshTunnelClose,
  __resetTunnelStore,
} from '../src/tools/tunnel-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}

// Fake ssh2 Client — provides forwardOut / forwardIn / unforwardIn.
function makeFakeClient() {
  return {
    forwardOutCalls: [],
    forwardInCalls: [],
    unforwardInCalls: [],
    forwardOut(sa, sp, da, dp, cb) {
      this.forwardOutCalls.push({ sa, sp, da, dp });
      const dummy = new EventEmitter();
      dummy.destroy = () => {};
      dummy.pipe = (dst) => dst;
      setImmediate(() => cb(null, dummy));
    },
    forwardIn(host, port, cb) {
      this.forwardInCalls.push({ host, port });
      setImmediate(() => cb(null));
    },
    unforwardIn(host, port, cb) {
      this.unforwardInCalls.push({ host, port });
      setImmediate(() => cb && cb(null));
    },
  };
}

console.log('🧪 Testing tunnel-tools\n');

// ─── probeReachability (with stubs) ─────────────────────────────────────
await test('probeReachability: dns+tcp success via stubs', async () => {
  const r = await probeReachability('example.com', 443, {
    resolver: async () => '93.184.216.34',
    tcpDialer: async () => {},
  });
  assert.strictEqual(r.dns.ok, true);
  assert.strictEqual(r.dns.address, '93.184.216.34');
  assert.strictEqual(r.tcp.ok, true);
});

await test('probeReachability: dns failure captured', async () => {
  const r = await probeReachability('nowhere.invalid', 443, {
    resolver: async () => { throw new Error('NXDOMAIN'); },
    tcpDialer: async () => {},
  });
  assert.strictEqual(r.dns.ok, false);
  assert(r.dns.error.includes('NXDOMAIN'));
});

await test('probeReachability: tcp failure captured even when dns ok', async () => {
  const r = await probeReachability('host', 1, {
    resolver: async () => '127.0.0.1',
    tcpDialer: async () => { throw new Error('refused'); },
  });
  assert.strictEqual(r.dns.ok, true);
  assert.strictEqual(r.tcp.ok, false);
});

await test('probeReachability: no host/port returns placeholder', async () => {
  const r = await probeReachability(null, null);
  assert.strictEqual(r.dns.ok, false);
});

// ─── handleSshTunnelCreate validation ───────────────────────────────────
await test('create: invalid type → fail', async () => {
  __resetTunnelStore();
  const r = await handleSshTunnelCreate({
    getConnection: async () => { throw new Error('should not call'); },
    args: { server: 's', type: 'warp', local_port: 1080 },
  });
  assert.strictEqual(r.isError, true);
});

await test('create: invalid local_port → fail', async () => {
  __resetTunnelStore();
  const r = await handleSshTunnelCreate({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', type: 'local', local_port: 99999, remote_host: 'x', remote_port: 80 },
  });
  assert.strictEqual(r.isError, true);
});

await test('create: local type requires remote_host/port', async () => {
  __resetTunnelStore();
  const r = await handleSshTunnelCreate({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', type: 'local', local_port: 8080 },
  });
  assert.strictEqual(r.isError, true);
});

// ─── preview mode ───────────────────────────────────────────────────────
await test('create preview: returns plan, never calls getConnection', async () => {
  __resetTunnelStore();
  let called = false;
  const r = await handleSshTunnelCreate({
    getConnection: async () => { called = true; throw new Error('no'); },
    probeImpl: async () => ({ dns: { ok: true }, tcp: { ok: true } }),
    args: {
      server: 'bastion', type: 'local',
      local_port: 8080, remote_host: 'internal.example.com', remote_port: 443,
      preview: true, format: 'json',
    },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.action, 'tunnel-create');
  assert(parsed.data.plan.effects.some(e => e.includes('opens TCP listener')));
});

await test('create preview: remote type → risk:high', async () => {
  __resetTunnelStore();
  const r = await handleSshTunnelCreate({
    getConnection: async () => { throw new Error('no'); },
    probeImpl: async () => ({ dns: { ok: true }, tcp: { ok: true } }),
    args: {
      server: 's', type: 'remote',
      local_port: 8080, remote_host: 'h', remote_port: 80,
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.risk, 'high');
});

// ─── create → list → close round-trip ───────────────────────────────────
await test('create (local) stores tunnel and returns typed data', async () => {
  __resetTunnelStore();
  const client = makeFakeClient();
  const r = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: {
      server: 's', type: 'local',
      local_port: 18080, remote_host: '127.0.0.1', remote_port: 5432,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.type, 'local');
  assert.strictEqual(parsed.data.local_port, 18080);
  assert(parsed.data.tunnel_id.startsWith('tunnel_'));
  // Clean up the listener
  await handleSshTunnelClose({ args: { tunnel_id: parsed.data.tunnel_id } });
});

await test('create (remote) invokes client.forwardIn', async () => {
  __resetTunnelStore();
  const client = makeFakeClient();
  const r = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: {
      server: 's', type: 'remote',
      local_port: 18080, remote_host: '0.0.0.0', remote_port: 9090,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(client.forwardInCalls.length, 1);
  assert.strictEqual(client.forwardInCalls[0].port, 9090);
  await handleSshTunnelClose({ args: { tunnel_id: parsed.data.tunnel_id } });
});

await test('list returns currently-registered tunnels', async () => {
  __resetTunnelStore();
  const client = makeFakeClient();
  const c = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: { server: 's1', type: 'local', local_port: 18100, remote_host: 'h', remote_port: 80, format: 'json' },
  });
  const tid = JSON.parse(c.content[0].text).data.tunnel_id;

  const r = await handleSshTunnelList({ args: { format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.data.total >= 1);
  assert(parsed.data.tunnels.some(t => t.tunnel_id === tid));
  await handleSshTunnelClose({ args: { tunnel_id: tid } });
});

await test('list filters by server', async () => {
  __resetTunnelStore();
  const client = makeFakeClient();
  const a = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: { server: 'a', type: 'local', local_port: 18201, remote_host: 'h', remote_port: 80, format: 'json' },
  });
  const b = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: { server: 'b', type: 'local', local_port: 18202, remote_host: 'h', remote_port: 80, format: 'json' },
  });
  const r = await handleSshTunnelList({ args: { server: 'a', format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.data.tunnels.every(t => t.server === 'a'));
  await handleSshTunnelClose({ args: { tunnel_id: JSON.parse(a.content[0].text).data.tunnel_id } });
  await handleSshTunnelClose({ args: { tunnel_id: JSON.parse(b.content[0].text).data.tunnel_id } });
});

await test('close missing tunnel_id → fail', async () => {
  const r = await handleSshTunnelClose({ args: { format: 'json' } });
  assert.strictEqual(r.isError, true);
});

await test('close unknown tunnel_id → structured fail', async () => {
  const r = await handleSshTunnelClose({ args: { tunnel_id: 'tunnel_nope', format: 'json' } });
  assert.strictEqual(r.isError, true);
});

await test('close is idempotent: second call → already_closed:true', async () => {
  __resetTunnelStore();
  const client = makeFakeClient();
  const c = await handleSshTunnelCreate({
    getConnection: async () => client,
    args: { server: 's', type: 'local', local_port: 18301, remote_host: 'h', remote_port: 80, format: 'json' },
  });
  const tid = JSON.parse(c.content[0].text).data.tunnel_id;
  const first = await handleSshTunnelClose({ args: { tunnel_id: tid, format: 'json' } });
  const firstParsed = JSON.parse(first.content[0].text);
  assert.strictEqual(firstParsed.data.already_closed, false);

  const second = await handleSshTunnelClose({ args: { tunnel_id: tid, format: 'json' } });
  const secondParsed = JSON.parse(second.content[0].text);
  assert.strictEqual(secondParsed.success, true);
  assert.strictEqual(secondParsed.data.already_closed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
