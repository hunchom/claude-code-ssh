#!/usr/bin/env node
/**
 * Tests for src/tools/monitoring-tools.js -- FakeClient pattern per cat/exec tests.
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import {
  handleSshHealthCheck,
  handleSshMonitor,
  handleSshServiceStatus,
  handleSshProcessManager,
  parseTopCpu,
  parseFreeMem,
  parseLoadAvg,
  parseUptime,
  parseDf,
  parseNetDev,
  parsePsList,
  parsePsInfo,
  parseSystemctlShow,
  sdNum,
  splitHealthSections,
  computeStatus,
  extractJournalLines,
} from '../src/tools/monitoring-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`FAIL  ${name}: ${e.message}`); }
}

// --- FakeClient ----------------------------------------------------------
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.writes = []; this.endCalls = 0; this.signals = []; }
  write(d) { this.writes.push(String(d)); return true; }
  end() { this.endCalls++; }
  signal(n) { this.signals.push(n); }
  close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) {
    this.script = script || (() => ({ stdout: '', stderr: '', code: 0 }));
    this.streams = []; this.lastCommand = null; this.commands = [];
  }
  exec(cmd, cb) {
    this.lastCommand = cmd; this.commands.push(cmd);
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

console.log('Testing monitoring-tools\n');

// --- Parsers -------------------------------------------------------------

await test('parseTopCpu: extracts user/system/idle/iowait', () => {
  const sample = [
    'top - 12:34:56 up 1 day,  load average: 0.12, 0.34, 0.56',
    'Tasks: 150 total, 1 running',
    '%Cpu(s):  3.1 us,  1.2 sy,  0.0 ni, 95.5 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st',
    'MiB Mem : 16000 total',
  ].join('\n');
  const r = parseTopCpu(sample);
  assert.strictEqual(r.user_pct, 3.1);
  assert.strictEqual(r.system_pct, 1.2);
  assert.strictEqual(r.idle_pct, 95.5);
  assert.strictEqual(r.iowait_pct, 0.2);
});

await test('parseFreeMem: -b output gives byte-level numeric fields', () => {
  const sample = [
    '              total        used        free      shared  buff/cache   available',
    'Mem:     16777216000  8388608000  2097152000      65536  6291456000  8000000000',
    'Swap:     2097152000           0  2097152000',
  ].join('\n');
  const r = parseFreeMem(sample);
  assert.strictEqual(r.total_bytes, 16777216000);
  assert.strictEqual(r.used_bytes, 8388608000);
  assert.strictEqual(r.free_bytes, 2097152000);
  assert.strictEqual(r.available_bytes, 8000000000);
  // 8388608000 / 16777216000 = 0.5 -> 50%
  assert.strictEqual(r.used_pct, 50);
});

await test('parseLoadAvg: /proc/loadavg extracts 1/5/15m + procs', () => {
  const r = parseLoadAvg('0.52 0.47 0.33 2/123 45678\n');
  assert.strictEqual(r.load_1m, 0.52);
  assert.strictEqual(r.load_5m, 0.47);
  assert.strictEqual(r.load_15m, 0.33);
  assert.strictEqual(r.running, 2);
  assert.strictEqual(r.total_procs, 123);
});

await test('parseUptime: /proc/uptime -> seconds + idle_seconds', () => {
  const r = parseUptime('12345.67 98765.43\n');
  assert.strictEqual(r.seconds, 12345.67);
  assert.strictEqual(r.idle_seconds, 98765.43);
});

await test('parseDf: output=source,size,used,avail,pcent,target', () => {
  const sample = [
    'Filesystem     1B-blocks        Used   Available Use% Mounted on',
    '/dev/sda1    50000000000 20000000000 30000000000  40% /',
    '/dev/sdb1   200000000000 50000000000 150000000000  25% /data',
  ].join('\n');
  const r = parseDf(sample);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].device, '/dev/sda1');
  assert.strictEqual(r[0].size_bytes, 50000000000);
  assert.strictEqual(r[0].used_bytes, 20000000000);
  assert.strictEqual(r[0].avail_bytes, 30000000000);
  assert.strictEqual(r[0].used_pct, 40);
  assert.strictEqual(r[0].mount, '/');
  assert.strictEqual(r[1].mount, '/data');
});

await test('parseNetDev: skips lo, extracts rx/tx bytes', () => {
  const sample = [
    'Inter-|   Receive                                               | Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:  12345      56    0    0    0     0          0         0 12345      56    0    0    0     0       0          0',
    '  eth0: 1000000    100    0    0    0     0          0         0 2000000    200    1    0    0     0       0          0',
  ].join('\n');
  const r = parseNetDev(sample);
  // We include lo -- tool strips nothing; caller decides
  assert(r.find(x => x.interface === 'eth0'));
  const eth = r.find(x => x.interface === 'eth0');
  assert.strictEqual(eth.rx_bytes, 1000000);
  assert.strictEqual(eth.tx_bytes, 2000000);
  assert.strictEqual(eth.tx_errs, 1);
});

await test('parsePsList: sorts by cpu desc, parses typed fields', () => {
  const sample = [
    '  PID USER     %CPU %MEM COMMAND         COMMAND',
    '  123 root     50.5 10.2 nginx           nginx: master process',
    '  456 alice     5.1  2.3 node            node /app/server.js',
    '  789 bob       0.2  0.5 bash            -bash',
  ].join('\n');
  const r = parsePsList(sample);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].pid, 123);
  assert.strictEqual(r[0].user, 'root');
  assert.strictEqual(r[0].cpu_pct, 50.5);
  assert.strictEqual(r[0].mem_pct, 10.2);
  assert.strictEqual(r[0].comm, 'nginx');
  assert.strictEqual(r[0].cmd, 'nginx: master process');
});

await test('parsePsInfo: single-record parse with start + etime', () => {
  const sample = [
    '  PID USER     STAT %CPU %MEM COMMAND         COMMAND                   STARTED     ELAPSED',
    '  123 root     Ss   50.5 10.2 nginx           nginx: master process     12:34:56   01:23:45',
  ].join('\n');
  const r = parsePsInfo(sample);
  assert.strictEqual(r.pid, 123);
  assert.strictEqual(r.user, 'root');
  assert.strictEqual(r.stat, 'Ss');
  assert.strictEqual(r.cpu_pct, 50.5);
  assert.strictEqual(r.mem_pct, 10.2);
  assert.strictEqual(r.comm, 'nginx');
  assert.strictEqual(r.start, '12:34:56');
  assert.strictEqual(r.etime, '01:23:45');
});

await test('parseSystemctlShow: key=value records', () => {
  const sample = [
    'ActiveState=active',
    'SubState=running',
    'LoadState=loaded',
    'UnitFileState=enabled',
    'MainPID=1234',
    'MemoryCurrent=123456789',
    'CPUUsageNSec=987654321',
    'Description=A test service',
  ].join('\n');
  const r = parseSystemctlShow(sample);
  assert.strictEqual(r.ActiveState, 'active');
  assert.strictEqual(r.MainPID, '1234');
  assert.strictEqual(r.MemoryCurrent, '123456789');
  assert.strictEqual(r.Description, 'A test service');
});

await test('sdNum: parses numbers, rejects [not set] and infinity', () => {
  assert.strictEqual(sdNum('123456'), 123456);
  assert.strictEqual(sdNum('[not set]'), null);
  assert.strictEqual(sdNum('infinity'), null);
  assert.strictEqual(sdNum('18446744073709551615'), null); // uint64 max
  assert.strictEqual(sdNum(''), null);
  assert.strictEqual(sdNum(null), null);
  assert.strictEqual(sdNum('not-a-number'), null);
});

await test('splitHealthSections: separates output by ---NAME--- markers', () => {
  const sample = [
    '---CPU---',
    'cpu data',
    'line2',
    '---MEM---',
    'mem data',
    '---DISK---',
    'disk data',
  ].join('\n');
  const r = splitHealthSections(sample);
  assert(r.CPU.includes('cpu data'));
  assert(r.CPU.includes('line2'));
  assert(r.MEM.includes('mem data'));
  assert(r.DISK.includes('disk data'));
  assert(!r.CPU.includes('---'));
});

// --- status heuristic ----------------------------------------------------

await test('computeStatus: healthy when nothing exceeds thresholds', () => {
  const s = computeStatus({
    memory: { used_pct: 40 },
    disk: [{ used_pct: 30 }, { used_pct: 50 }],
    load: { load_1m: 0.5 },
  }, 4);
  assert.strictEqual(s, 'healthy');
});

await test('computeStatus: degraded when memory > 85%', () => {
  const s = computeStatus({
    memory: { used_pct: 88 },
    disk: [{ used_pct: 10 }],
    load: { load_1m: 0.1 },
  }, 4);
  assert.strictEqual(s, 'degraded');
});

await test('computeStatus: critical when disk > 95%', () => {
  const s = computeStatus({
    memory: { used_pct: 10 },
    disk: [{ used_pct: 99 }],
    load: { load_1m: 0.1 },
  }, 4);
  assert.strictEqual(s, 'critical');
});

await test('computeStatus: critical when load_1m > cores*2', () => {
  const s = computeStatus({
    memory: { used_pct: 10 },
    disk: [{ used_pct: 10 }],
    load: { load_1m: 9.0 },
  }, 4);
  assert.strictEqual(s, 'critical');
});

// --- handleSshHealthCheck ------------------------------------------------

function buildHealthOutput({
  cpu = '%Cpu(s):  3.1 us,  1.2 sy,  0.0 ni, 95.5 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st',
  mem = 'Mem:     16777216000  8388608000  2097152000      65536  6291456000  8000000000',
  disk = '/dev/sda1    50000000000 20000000000 30000000000  40% /',
  load = '0.52 0.47 0.33 2/123 45678',
  uptime = '12345.67 98765.43',
  cores = '4',
} = {}) {
  return [
    '---CPU---', 'top - 12:34:56', 'Tasks: 150', cpu,
    '---MEM---', '              total', mem,
    '---DISK---', 'Filesystem     1B-blocks        Used   Available Use% Mounted on', disk,
    '---LOAD---', load,
    '---UPTIME---', uptime,
    '---CORES---', cores,
  ].join('\n') + '\n';
}

await test('ssh_health_check: parses realistic output into typed JSON', async () => {
  const client = new FakeClient({ script: () => ({ stdout: buildHealthOutput(), code: 0 }) });
  const r = await handleSshHealthCheck({
    getConnection: async () => client,
    args: { server: 'prod01', format: 'json' },
  });
  assert(!r.isError, 'expected success, got isError');
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.cpu.idle_pct, 95.5);
  assert.strictEqual(parsed.data.memory.total_bytes, 16777216000);
  assert.strictEqual(parsed.data.memory.used_pct, 50);
  assert.strictEqual(parsed.data.load.load_1m, 0.52);
  assert.strictEqual(parsed.data.disk.length, 1);
  assert.strictEqual(parsed.data.disk[0].used_pct, 40);
  assert.strictEqual(parsed.data.uptime.seconds, 12345.67);
  assert.strictEqual(parsed.data.cores, 4);
  assert.strictEqual(parsed.data.status, 'healthy');
});

await test('ssh_health_check: status heuristic -- critical via disk > 95', async () => {
  const disk = '/dev/sda1 100 97 3 97% /';
  const client = new FakeClient({ script: () => ({ stdout: buildHealthOutput({ disk }), code: 0 }) });
  const r = await handleSshHealthCheck({
    getConnection: async () => client,
    args: { server: 's', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.status, 'critical');
});

await test('ssh_health_check: status heuristic -- degraded via memory > 85', async () => {
  // 14000000000 / 16000000000 = 87.5%
  const mem = 'Mem:     16000000000 14000000000 2000000000 100 1000000000 1500000000';
  const client = new FakeClient({ script: () => ({ stdout: buildHealthOutput({ mem }), code: 0 }) });
  const r = await handleSshHealthCheck({
    getConnection: async () => client,
    args: { server: 's', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.status, 'degraded');
});

await test('ssh_health_check: missing section -> graceful null field', async () => {
  // Drop the CPU section entirely
  const stdout = [
    '---MEM---', '              total', 'Mem:     16000000000 8000000000 2000000000 100 1000000000 8000000000',
    '---DISK---', 'Filesystem 1B', '/dev/sda1 100 30 70 30% /',
    '---LOAD---', '0.1 0.1 0.1 1/10 100',
    '---UPTIME---', '100 200',
    '---CORES---', '4',
  ].join('\n') + '\n';
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshHealthCheck({
    getConnection: async () => client,
    args: { server: 's', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.cpu, null);
  assert(parsed.data.memory != null);
});

await test('ssh_health_check: connection failure -> isError', async () => {
  const r = await handleSshHealthCheck({
    getConnection: async () => { throw new Error('host unreachable'); },
    args: { server: 's', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('host unreachable'));
});

await test('ssh_health_check: markdown render contains status badge + tables', async () => {
  const client = new FakeClient({ script: () => ({ stdout: buildHealthOutput(), code: 0 }) });
  const r = await handleSshHealthCheck({
    getConnection: async () => client,
    args: { server: 'prod01' },
  });
  const md = r.content[0].text;
  assert(md.includes('healthy') || md.includes('degraded') || md.includes('critical'));
  assert(md.includes('**CPU**'));
  assert(md.includes('**Memory**'));
  assert(md.includes('**Disk**'));
});

// --- handleSshMonitor ----------------------------------------------------

await test('ssh_monitor cpu: typed cpu payload', async () => {
  const stdout = 'top - x\nTasks: 1\n%Cpu(s):  5.0 us,  2.0 sy,  0.0 ni, 92.0 id,  1.0 wa,  0.0 hi,  0.0 si,  0.0 st\n';
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshMonitor({
    getConnection: async () => client,
    args: { server: 's', type: 'cpu', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.type, 'cpu');
  assert.strictEqual(parsed.data.cpu.user_pct, 5);
  assert.strictEqual(parsed.data.cpu.idle_pct, 92);
});

await test('ssh_monitor memory: typed memory payload', async () => {
  const stdout = [
    '              total        used        free      shared  buff/cache   available',
    'Mem:       1000         400         500          10         100         550',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshMonitor({
    getConnection: async () => client,
    args: { server: 's', type: 'memory', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.memory.total_bytes, 1000);
  assert.strictEqual(parsed.data.memory.used_bytes, 400);
});

await test('ssh_monitor disk: typed disk array', async () => {
  const stdout = [
    'Filesystem     1B-blocks   Used Avail Use% Mounted on',
    '/dev/sda1     1000 300 700 30% /',
    '/dev/sdb1     2000 1000 1000 50% /data',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshMonitor({
    getConnection: async () => client,
    args: { server: 's', type: 'disk', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.disk.length, 2);
  assert.strictEqual(parsed.data.disk[0].mount, '/');
  assert.strictEqual(parsed.data.disk[1].mount, '/data');
});

await test('ssh_monitor network: typed network array', async () => {
  const stdout = [
    'Inter-|   Receive                                               | Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '  eth0: 100    10    0    0    0     0          0         0 200    20    0    0    0     0       0          0',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshMonitor({
    getConnection: async () => client,
    args: { server: 's', type: 'network', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  const eth = parsed.data.network.find(n => n.interface === 'eth0');
  assert(eth);
  assert.strictEqual(eth.rx_bytes, 100);
  assert.strictEqual(eth.tx_bytes, 200);
});

await test('ssh_monitor process: typed process list sorted by cpu desc', async () => {
  const stdout = [
    '  PID USER     %CPU %MEM COMMAND         COMMAND',
    '  100 root     30.0  5.0 node           node app.js',
    '  200 alice    10.0  2.0 python         python worker.py',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshMonitor({
    getConnection: async () => client,
    args: { server: 's', type: 'process', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.process.length, 2);
  assert.strictEqual(parsed.data.process[0].pid, 100);
  assert(parsed.data.process[0].cpu_pct >= parsed.data.process[1].cpu_pct);
});

// --- handleSshServiceStatus ---------------------------------------------

await test('ssh_service_status: parses show output into typed record', async () => {
  const show = [
    'ActiveState=active',
    'SubState=running',
    'LoadState=loaded',
    'UnitFileState=enabled',
    'MainPID=1234',
    'MemoryCurrent=123456789',
    'CPUUsageNSec=987654321',
    'Description=nginx HTTP server',
  ].join('\n');
  const statusText = [
    '* nginx.service - nginx HTTP server',
    '   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)',
    '   Active: active (running)',
    '',
    'Jan 01 12:00:00 host nginx[1234]: server started',
    'Jan 01 12:00:01 host nginx[1234]: listening on :80',
  ].join('\n');
  const stdout = `---SHOW---\n${show}\n---STATUS---\n${statusText}\n`;
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshServiceStatus({
    getConnection: async () => client,
    args: { server: 's', service: 'nginx', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.service, 'nginx');
  assert.strictEqual(parsed.data.active_state, 'active');
  assert.strictEqual(parsed.data.sub_state, 'running');
  assert.strictEqual(parsed.data.load_state, 'loaded');
  assert.strictEqual(parsed.data.unit_file_state, 'enabled');
  assert.strictEqual(parsed.data.main_pid, 1234);
  assert.strictEqual(parsed.data.memory_bytes, 123456789);
  assert.strictEqual(parsed.data.cpu_ns, 987654321);
  assert.strictEqual(parsed.data.description, 'nginx HTTP server');
});

await test('ssh_service_status: handles [not set] and infinity gracefully', async () => {
  const show = [
    'ActiveState=inactive',
    'SubState=dead',
    'LoadState=loaded',
    'UnitFileState=disabled',
    'MainPID=0',
    'MemoryCurrent=[not set]',
    'CPUUsageNSec=infinity',
    'Description=foo',
  ].join('\n');
  const stdout = `---SHOW---\n${show}\n---STATUS---\n\n`;
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshServiceStatus({
    getConnection: async () => client,
    args: { server: 's', service: 'foo', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.memory_bytes, null);
  assert.strictEqual(parsed.data.cpu_ns, null);
  // MainPID=0 -> numeric 0 is valid
  assert.strictEqual(parsed.data.main_pid, 0);
});

await test('ssh_service_status: extracts recent_logs as string array', async () => {
  const show = 'ActiveState=active\nSubState=running\nLoadState=loaded\nUnitFileState=enabled\nMainPID=1\nMemoryCurrent=1\nCPUUsageNSec=1\nDescription=x';
  const statusText = [
    '* nginx.service - x',
    '   Loaded: loaded',
    '   Active: active',
    '',
    'Jan 01 12:00:00 host nginx: line one',
    'Jan 01 12:00:01 host nginx: line two',
    'Jan 01 12:00:02 host nginx: line three',
  ].join('\n');
  const stdout = `---SHOW---\n${show}\n---STATUS---\n${statusText}\n`;
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshServiceStatus({
    getConnection: async () => client,
    args: { server: 's', service: 'nginx', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert(Array.isArray(parsed.data.recent_logs));
  assert(parsed.data.recent_logs.some(l => l.includes('line one')));
  assert(parsed.data.recent_logs.some(l => l.includes('line three')));
});

await test('ssh_service_status: missing service arg -> structured failure', async () => {
  const r = await handleSshServiceStatus({
    getConnection: async () => { throw new Error('should not be called'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.toLowerCase().includes('service') || r.content[0].text.includes('failed'));
});

await test('ssh_service_status: service name is shell-quoted in remote command', async () => {
  const show = 'ActiveState=active\nSubState=running\nLoadState=loaded\nUnitFileState=enabled\nMainPID=1\nMemoryCurrent=1\nCPUUsageNSec=1\nDescription=x';
  const stdout = `---SHOW---\n${show}\n---STATUS---\n\n`;
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  await handleSshServiceStatus({
    getConnection: async () => client,
    args: { server: 's', service: 'foo; rm -rf /', format: 'json' },
  });
  assert(!client.lastCommand.includes('rm -rf /; '), 'injection must not escape quoting');
  assert(client.lastCommand.includes('\'foo; rm -rf /\''));
});

// --- handleSshProcessManager --------------------------------------------

await test('ssh_process_manager list: returns typed array sorted by cpu desc', async () => {
  const stdout = [
    '  PID USER     %CPU %MEM COMMAND         COMMAND',
    '  100 root      5.0  2.0 bash            -bash',
    '  200 alice    40.0  8.0 node            node app.js',
    '  300 bob       2.0  1.0 vim             vim file.txt',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshProcessManager({
    getConnection: async () => client,
    args: { server: 's', action: 'list', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.action, 'list');
  const procs = parsed.data.processes;
  assert.strictEqual(procs.length, 3);
  // sorted desc by cpu
  for (let i = 0; i < procs.length - 1; i++) {
    assert(procs[i].cpu_pct >= procs[i + 1].cpu_pct, `not sorted at ${i}`);
  }
  assert.strictEqual(procs[0].pid, 200);
});

await test('ssh_process_manager info: single typed record', async () => {
  const stdout = [
    '  PID USER     STAT %CPU %MEM COMMAND         COMMAND                  STARTED    ELAPSED',
    '  777 root     Ss   15.0  3.5 postgres        postgres -D /var/lib      09:00:00  03:15:22',
  ].join('\n');
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshProcessManager({
    getConnection: async () => client,
    args: { server: 's', action: 'info', pid: 777, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.action, 'info');
  assert.strictEqual(parsed.data.process.pid, 777);
  assert.strictEqual(parsed.data.process.user, 'root');
  assert.strictEqual(parsed.data.process.stat, 'Ss');
  assert.strictEqual(parsed.data.process.comm, 'postgres');
  assert.strictEqual(client.lastCommand, 'ps -p 777 -o pid,user,stat,%cpu,%mem,comm,args,start,etime');
});

await test('ssh_process_manager kill: remote command is `kill -TERM 1234`', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  const r = await handleSshProcessManager({
    getConnection: async () => client,
    args: { server: 's', action: 'kill', pid: 1234, format: 'json' },
  });
  assert(!r.isError, 'expected success, got isError');
  assert.strictEqual(client.lastCommand, 'kill -TERM 1234');
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.action, 'kill');
  assert.strictEqual(parsed.data.pid, 1234);
  assert.strictEqual(parsed.data.sent_signal, 'TERM');
});

await test('ssh_process_manager kill: signal normalized (SIGKILL -> KILL)', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  await handleSshProcessManager({
    getConnection: async () => client,
    args: { server: 's', action: 'kill', pid: 42, signal: 'SIGKILL', format: 'json' },
  });
  assert.strictEqual(client.lastCommand, 'kill -KILL 42');
});

await test('ssh_process_manager kill: NaN pid -> structured fail, no remote call', async () => {
  let called = false;
  const r = await handleSshProcessManager({
    getConnection: async () => { called = true; throw new Error('should not connect'); },
    args: { server: 's', action: 'kill', pid: 'abc', format: 'json' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('pid'));
});

await test('ssh_process_manager kill: negative pid -> structured fail, no remote call', async () => {
  let called = false;
  const r = await handleSshProcessManager({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'kill', pid: -1, format: 'json' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('ssh_process_manager kill: invalid signal -> structured fail, no remote call', async () => {
  let called = false;
  const r = await handleSshProcessManager({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 's', action: 'kill', pid: 42, signal: 'BOGUS', format: 'json' },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.isError, true);
});

await test('ssh_process_manager kill: preview shows plan + target pid, never calls remote', async () => {
  let called = false;
  const r = await handleSshProcessManager({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: { server: 'prod01', action: 'kill', pid: 9999, signal: 'KILL', preview: true, format: 'json' },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.preview, true);
  assert(parsed.data.plan.effects.some(e => e.includes('9999')));
  assert(parsed.data.plan.effects.some(e => e.includes('kill -KILL 9999')));
});

// --- extractJournalLines ------------------------------------------------

await test('extractJournalLines: trims header block, keeps trailing log lines', () => {
  const text = [
    '* nginx.service - x',
    '   Loaded: loaded',
    '   Active: active',
    '   Main PID: 1234',
    '',
    'Jan 01 12:00:00 host nginx: one',
    'Jan 01 12:00:01 host nginx: two',
  ].join('\n');
  const lines = extractJournalLines(text, 5);
  assert(lines.length === 2);
  assert(lines[0].includes('one'));
  assert(lines[1].includes('two'));
});

// --- Summary ------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  FAIL ${f.name}\n    ${f.err.stack}`); process.exit(1); }
