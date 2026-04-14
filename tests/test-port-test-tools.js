#!/usr/bin/env node
/** Tests for src/tools/port-test-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  parseDnsOutput, parseTcpOutput, parseTlsOutput, parseHttpOutput,
  buildDnsCommand, buildTcpCommand, buildTlsCommand, buildHttpCommand,
  handleSshPortTest,
} from '../src/tools/port-test-tools.js';

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

console.log('[test] Testing port-test-tools\n');

// --- parseDnsOutput ------------------------------------------------------
await test('parseDnsOutput: getent IPv4 format', () => {
  const r = parseDnsOutput('93.184.216.34   example.com');
  assert.strictEqual(r.resolved_ip, '93.184.216.34');
});

await test('parseDnsOutput: getent IPv6 format', () => {
  const r = parseDnsOutput('2606:2800:220:1:248:1893:25c8:1946 example.com');
  assert.strictEqual(r.resolved_ip, '2606:2800:220:1:248:1893:25c8:1946');
});

await test('parseDnsOutput: nslookup format extracts last Address', () => {
  const r = parseDnsOutput('Server:  8.8.8.8\nAddress: 8.8.8.8#53\n\nName:  example.com\nAddress: 93.184.216.34');
  assert.strictEqual(r.resolved_ip, '93.184.216.34');
});

await test('parseDnsOutput: empty input -> null', () => {
  assert.strictEqual(parseDnsOutput('').resolved_ip, null);
});

// --- parseTcpOutput ------------------------------------------------------
await test('parseTcpOutput: exit 0 + latency marker -> tcp_open:true', () => {
  const r = parseTcpOutput('TCP_LATENCY_MS=42\n', '', 0);
  assert.strictEqual(r.tcp_open, true);
  assert.strictEqual(r.latency_ms, 42);
});

await test('parseTcpOutput: non-zero exit -> tcp_open:false + error', () => {
  const r = parseTcpOutput('', 'nc: connect failed', 1);
  assert.strictEqual(r.tcp_open, false);
  assert(r.error.includes('nc: connect failed'));
});

// --- parseTlsOutput ------------------------------------------------------
await test('parseTlsOutput: extracts subject, dates, fingerprint', () => {
  const input = [
    'subject=CN = example.com',
    'notBefore=Mar  1 00:00:00 2024 GMT',
    'notAfter=Mar  1 23:59:59 2025 GMT',
    'sha256 Fingerprint=AB:CD:EF:12:34',
  ].join('\n');
  const r = parseTlsOutput(input);
  assert.strictEqual(r.subject, 'CN = example.com');
  assert(r.not_before.includes('2024'));
  assert(r.not_after.includes('2025'));
  assert.strictEqual(r.sha256_fp, 'AB:CD:EF:12:34');
});

await test('parseTlsOutput: empty -> null', () => {
  assert.strictEqual(parseTlsOutput(''), null);
});

// --- parseHttpOutput -----------------------------------------------------
await test('parseHttpOutput: "200 0.145" parsed', () => {
  const r = parseHttpOutput('200 0.145');
  assert.strictEqual(r.http_status, 200);
  assert.strictEqual(r.time_seconds, 0.145);
});

await test('parseHttpOutput: malformed returns null', () => {
  assert.strictEqual(parseHttpOutput('garbage'), null);
});

// --- buildXxxCommand: shQuote / injection safety -------------------------
await test('buildDnsCommand: host is shell-quoted', () => {
  const cmd = buildDnsCommand('evil.com; rm -rf /');
  assert(cmd.includes("'evil.com; rm -rf /'"));
  assert(!cmd.match(/^[^']*evil\.com; rm -rf \//), 'no unquoted fragment');
});

await test('buildTlsCommand: defaults to port 443', () => {
  const cmd = buildTlsCommand('example.com', null, 5000);
  assert(cmd.includes(':443'));
});

await test('buildHttpCommand: port 443 -> https scheme', () => {
  assert(buildHttpCommand('example.com', 443, 5000).includes('https://'));
});

await test('buildHttpCommand: other port -> http scheme', () => {
  assert(buildHttpCommand('example.com', 8080, 5000).includes('http://'));
});

// --- handleSshPortTest ---------------------------------------------------
await test('handleSshPortTest: missing target_host -> structured fail', async () => {
  const r = await handleSshPortTest({
    getConnection: async () => { throw new Error('should not call'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('target_host is required'));
});

await test('handleSshPortTest: full chain tcp+dns with scripted results', async () => {
  const client = new FakeClient({ script: (cmd) => {
    if (cmd.startsWith('getent hosts')) return { stdout: '1.2.3.4 host.example.com\n', code: 0 };
    if (cmd.includes('nc -z') || cmd.includes('/dev/tcp/')) return { stdout: 'TCP_LATENCY_MS=5\n', code: 0 };
    return { stdout: '', code: 0 };
  }});
  const r = await handleSshPortTest({
    getConnection: async () => client,
    args: {
      server: 's', target_host: 'host.example.com', target_port: 22,
      probe_chain: ['dns', 'tcp'],
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.overall_ok, true);
  assert.strictEqual(parsed.data.probes.length, 2);
  assert.strictEqual(parsed.data.probes[0].name, 'dns');
  assert.strictEqual(parsed.data.probes[0].data.resolved_ip, '1.2.3.4');
  assert.strictEqual(parsed.data.probes[1].data.tcp_open, true);
});

await test('handleSshPortTest: stop-on-first-fail (default)', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 1 }) });
  const r = await handleSshPortTest({
    getConnection: async () => client,
    args: {
      server: 's', target_host: 'nonexistent', target_port: 1,
      probe_chain: ['dns', 'tcp', 'tls'],
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.overall_ok, false);
  assert.strictEqual(parsed.data.probes.length, 1, 'stops after dns fail');
});

await test('handleSshPortTest: continue_on_fail runs all probes', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 1 }) });
  const r = await handleSshPortTest({
    getConnection: async () => client,
    args: {
      server: 's', target_host: 'x', target_port: 1,
      probe_chain: ['dns', 'tcp'],
      continue_on_fail: true,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.probes.length, 2);
  assert.strictEqual(parsed.data.overall_ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
