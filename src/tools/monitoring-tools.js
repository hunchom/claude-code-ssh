/**
 * Typed monitoring tools -- every handler returns structured JSON data that
 * Claude can reason about programmatically. Markdown renderers per tool
 * present compact, scannable cards.
 *
 * Tools:
 *   - handleSshHealthCheck      aggregate CPU/MEM/DISK/LOAD/UPTIME in ONE remote call
 *   - handleSshMonitor          single-slice view (cpu/memory/disk/network/process/overview)
 *   - handleSshServiceStatus    systemctl show + recent journal lines, typed
 *   - handleSshProcessManager   list / info / kill (preview-safe)
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatBytes, formatDuration, escapeMdCell } from '../output-formatter.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

/** Safe positive integer coerce with fallback. */
function toInt(x, fallback) {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) ? n : fallback;
}

/** Safe float coerce, returns null on NaN. */
function toFloat(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// --------------------------------------------------------------------------
// Parsers -- exported for unit testing.
// --------------------------------------------------------------------------

/**
 * Parse `top -bn1 | head -5` output. Looks for a line matching:
 *   %Cpu(s):  3.1 us,  1.2 sy,  0.0 ni, 95.5 id,  0.2 wa, ...
 * Returns { user_pct, system_pct, idle_pct, iowait_pct } or null if missing.
 */
export function parseTopCpu(text) {
  if (!text) return null;
  const line = text.split('\n').find(l => /%?cpu\(s\)/i.test(l));
  if (!line) return null;
  const pick = (re) => {
    const m = line.match(re);
    return m ? toFloat(m[1]) : null;
  };
  return {
    user_pct: pick(/([\d.]+)\s*us/i),
    system_pct: pick(/([\d.]+)\s*sy/i),
    idle_pct: pick(/([\d.]+)\s*id/i),
    iowait_pct: pick(/([\d.]+)\s*wa/i),
  };
}

/**
 * Parse `free -b` output:
 *                 total        used        free      shared  buff/cache   available
 *   Mem:       16777216     8388608     4194304       12345     4194304     8000000
 *   Swap:       2097152           0     2097152
 */
export function parseFreeMem(text) {
  if (!text) return null;
  const memLine = text.split('\n').find(l => /^\s*mem\s*:/i.test(l));
  if (!memLine) return null;
  const cols = memLine.trim().split(/\s+/);
  // cols: ['Mem:', total, used, free, shared, buff/cache, available]
  const total = toFloat(cols[1]);
  const used = toFloat(cols[2]);
  const free = toFloat(cols[3]);
  const available = toFloat(cols[6]) ?? toFloat(cols[5]);
  if (total == null || total === 0) return null;
  return {
    total_bytes: total,
    used_bytes: used,
    free_bytes: free,
    available_bytes: available,
    used_pct: Math.round((used / total) * 10000) / 100,
  };
}

/**
 * Parse `cat /proc/loadavg`:
 *   0.52 0.47 0.33 2/123 45678
 * Returns { load_1m, load_5m, load_15m, running, total_procs }
 */
export function parseLoadAvg(text) {
  if (!text) return null;
  const line = text.trim().split('\n')[0];
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  if (cols.length < 4) return null;
  const procs = cols[3] ? cols[3].split('/') : [];
  return {
    load_1m: toFloat(cols[0]),
    load_5m: toFloat(cols[1]),
    load_15m: toFloat(cols[2]),
    running: toInt(procs[0], null),
    total_procs: toInt(procs[1], null),
  };
}

/**
 * Parse `cat /proc/uptime`:
 *   12345.67 98765.43
 */
export function parseUptime(text) {
  if (!text) return null;
  const cols = text.trim().split(/\s+/);
  if (cols.length < 1) return null;
  return {
    seconds: toFloat(cols[0]),
    idle_seconds: toFloat(cols[1]),
  };
}

/**
 * Parse `df -B1 --output=source,size,used,avail,pcent,target` output.
 * Filesystem   1B-blocks      Used  Available Use% Mounted on
 * /dev/sda1  50000000000 20000000000 30000000000 40% /
 */
export function parseDf(text) {
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  // Drop header
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 6) continue;
    const size = toFloat(cols[1]);
    const used = toFloat(cols[2]);
    const avail = toFloat(cols[3]);
    const pct = toFloat(String(cols[4]).replace('%', ''));
    out.push({
      device: cols[0],
      size_bytes: size,
      used_bytes: used,
      avail_bytes: avail,
      used_pct: pct,
      mount: cols.slice(5).join(' '),
    });
  }
  return out;
}

/** Detect CPU core count from /proc/cpuinfo text or fallback to 1. */
export function parseCpuCores(text) {
  if (!text) return null;
  const matches = text.match(/^processor\s*:/gmi);
  return matches ? matches.length : null;
}

/**
 * Heuristic status computation.
 *   critical: mem.used_pct > 95 OR any disk.used_pct > 95 OR load_1m > cores*2
 *   degraded: mem.used_pct > 85 OR any disk.used_pct > 85 OR load_1m > cores
 *   healthy:  otherwise
 */
export function computeStatus({ memory, disk, load }, cores = null) {
  const memPct = memory && memory.used_pct != null ? memory.used_pct : 0;
  const maxDisk = Array.isArray(disk) && disk.length
    ? disk.reduce((m, d) => Math.max(m, d.used_pct ?? 0), 0)
    : 0;
  const load1 = load && load.load_1m != null ? load.load_1m : 0;
  const c = cores || 1;

  if (memPct > 95 || maxDisk > 95 || load1 > c * 2) return 'critical';
  if (memPct > 85 || maxDisk > 85 || load1 > c) return 'degraded';
  return 'healthy';
}

/**
 * Split combined health-check remote output on `---SECTION---` markers.
 * Returns a map: { CPU, MEM, DISK, LOAD, UPTIME, CORES } of string sections.
 */
export function splitHealthSections(text) {
  const out = {};
  if (!text) return out;
  // Each section header on its own line: ---NAME---
  const re = /^---([A-Z]+)---\s*$/gm;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ name: m[1], start: m.index, headerEnd: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const body = text.slice(cur.headerEnd, next ? next.start : undefined);
    out[cur.name] = body.replace(/^\n+/, '').replace(/\n+$/, '\n');
  }
  return out;
}

/**
 * Parse `ps -eo pid,user,%cpu,%mem,comm,args --sort=-%cpu` output into typed records.
 */
export function parsePsList(text) {
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const out = [];
  // skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // pid user %cpu %mem comm args...
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const pid = toInt(cols[0], null);
    if (pid == null) continue;
    out.push({
      pid,
      user: cols[1],
      cpu_pct: toFloat(cols[2]) ?? 0,
      mem_pct: toFloat(cols[3]) ?? 0,
      comm: cols[4],
      cmd: cols.slice(5).join(' '),
    });
  }
  return out;
}

/**
 * Parse `ps -p PID -o pid,user,stat,%cpu,%mem,comm,args,start,etime` (single record).
 */
export function parsePsInfo(text) {
  if (!text) return null;
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const cols = lines[1].trim().split(/\s+/);
  if (cols.length < 8) return null;
  const pid = toInt(cols[0], null);
  if (pid == null) return null;
  // pid user stat %cpu %mem comm args... start etime
  // The middle args block can contain spaces; start and etime are the last two
  // tokens reliably parseable.
  const etime = cols[cols.length - 1];
  const start = cols[cols.length - 2];
  const comm = cols[5];
  const args = cols.slice(6, cols.length - 2).join(' ');
  return {
    pid,
    user: cols[1],
    stat: cols[2],
    cpu_pct: toFloat(cols[3]) ?? 0,
    mem_pct: toFloat(cols[4]) ?? 0,
    comm,
    cmd: args,
    start,
    etime,
  };
}

/**
 * Parse `cat /proc/net/dev`:
 *   Inter-|   Receive                                               | Transmit
 *    face |bytes    packets errs ...
 *     eth0: 12345 67 0 0 0 0 0 0 54321 89 0 0 0 0 0 0
 */
export function parseNetDev(text) {
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    // Skip headers
    if (/^Inter-\|/.test(line) || /^face\s*\|/.test(line) || /^\|/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const iface = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim().split(/\s+/);
    if (rest.length < 16) continue;
    out.push({
      interface: iface,
      rx_bytes: toFloat(rest[0]),
      rx_packets: toFloat(rest[1]),
      rx_errs: toFloat(rest[2]),
      rx_drop: toFloat(rest[3]),
      tx_bytes: toFloat(rest[8]),
      tx_packets: toFloat(rest[9]),
      tx_errs: toFloat(rest[10]),
      tx_drop: toFloat(rest[11]),
    });
  }
  return out;
}

/**
 * Parse key=value records from `systemctl show SERVICE --property=...`.
 */
export function parseSystemctlShow(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw;
    if (!line || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    out[key] = val;
  }
  return out;
}

/**
 * Normalize a numeric systemctl property value like "123456", "[not set]",
 * "infinity", "" -> number or null.
 */
export function sdNum(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^\[not set\]$/i.test(s)) return null;
  if (/^infinity$/i.test(s)) return null;
  // systemctl emits very large unsigned integers for unset memory in cgroup v1
  if (s === '18446744073709551615') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Shape a systemctl show record into our typed service record.
 */
export function shapeServiceRecord(service, props, recentLogs) {
  return {
    service,
    active_state: props.ActiveState || null,
    sub_state: props.SubState || null,
    load_state: props.LoadState || null,
    unit_file_state: props.UnitFileState || null,
    main_pid: sdNum(props.MainPID),
    memory_bytes: sdNum(props.MemoryCurrent),
    cpu_ns: sdNum(props.CPUUsageNSec),
    description: props.Description || null,
    recent_logs: Array.isArray(recentLogs) ? recentLogs : [],
  };
}

// --------------------------------------------------------------------------
// Renderers
// --------------------------------------------------------------------------

function statusBadge(status) {
  if (status === 'healthy') return '[ok] **healthy**';
  if (status === 'degraded') return '[warn] **degraded**';
  if (status === 'critical') return '[err] **critical**';
  return `| ${status || 'unknown'}`;
}

function renderKV(rows) {
  const lines = ['| field | value |', '| --- | --- |'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

export function renderHealthCheck(result) {
  if (!result.success) return `[err] **ssh_health_check** -- ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) return defaultPreviewRender(result);
  const lines = [];
  const dur = result.meta?.duration_ms != null ? ` | \`${formatDuration(result.meta.duration_ms)}\`` : '';
  const srv = result.server ? ` | \`${result.server}\`` : '';
  lines.push(`${statusBadge(d.status)} | **ssh_health_check**${srv}${dur}`);
  lines.push('');
  if (d.cpu) {
    lines.push('**CPU**');
    lines.push(renderKV([
      ['user', fmtPct(d.cpu.user_pct)],
      ['system', fmtPct(d.cpu.system_pct)],
      ['idle', fmtPct(d.cpu.idle_pct)],
      ['iowait', fmtPct(d.cpu.iowait_pct)],
    ]));
    lines.push('');
  }
  if (d.memory) {
    lines.push('**Memory**');
    lines.push(renderKV([
      ['total', formatBytes(d.memory.total_bytes)],
      ['used', `${formatBytes(d.memory.used_bytes)} (${fmtPct(d.memory.used_pct)})`],
      ['free', formatBytes(d.memory.free_bytes)],
      ['available', formatBytes(d.memory.available_bytes)],
    ]));
    lines.push('');
  }
  if (d.load) {
    lines.push('**Load**');
    lines.push(renderKV([
      ['1m', d.load.load_1m ?? '--'],
      ['5m', d.load.load_5m ?? '--'],
      ['15m', d.load.load_15m ?? '--'],
      ['procs', `${d.load.running ?? '--'}/${d.load.total_procs ?? '--'}`],
    ]));
    lines.push('');
  }
  if (Array.isArray(d.disk) && d.disk.length) {
    lines.push('**Disk**');
    lines.push('| mount | device | size | used | avail | used% |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const m of d.disk) {
      lines.push(`| \`${m.mount}\` | \`${m.device}\` | ${formatBytes(m.size_bytes)} | ${formatBytes(m.used_bytes)} | ${formatBytes(m.avail_bytes)} | ${fmtPct(m.used_pct)} |`);
    }
    lines.push('');
  }
  if (d.uptime && d.uptime.seconds != null) {
    lines.push(`**Uptime**: \`${formatDuration(d.uptime.seconds * 1000)}\``);
  }
  return lines.join('\n').trimEnd();
}

export function renderMonitor(result) {
  if (!result.success) return `[err] **ssh_monitor** -- ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) return defaultPreviewRender(result);
  const type = d.type;
  const srv = result.server ? ` | \`${result.server}\`` : '';
  const lines = [`[ok] **ssh_monitor** | \`${type}\`${srv}`];
  lines.push('');
  if (type === 'cpu' && d.cpu) {
    lines.push(renderKV([
      ['user', fmtPct(d.cpu.user_pct)],
      ['system', fmtPct(d.cpu.system_pct)],
      ['idle', fmtPct(d.cpu.idle_pct)],
      ['iowait', fmtPct(d.cpu.iowait_pct)],
    ]));
  } else if (type === 'memory' && d.memory) {
    lines.push(renderKV([
      ['total', formatBytes(d.memory.total_bytes)],
      ['used', `${formatBytes(d.memory.used_bytes)} (${fmtPct(d.memory.used_pct)})`],
      ['free', formatBytes(d.memory.free_bytes)],
      ['available', formatBytes(d.memory.available_bytes)],
    ]));
  } else if (type === 'disk' && Array.isArray(d.disk)) {
    lines.push('| mount | device | size | used | avail | used% |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const m of d.disk) {
      lines.push(`| \`${m.mount}\` | \`${m.device}\` | ${formatBytes(m.size_bytes)} | ${formatBytes(m.used_bytes)} | ${formatBytes(m.avail_bytes)} | ${fmtPct(m.used_pct)} |`);
    }
  } else if (type === 'network' && Array.isArray(d.network)) {
    lines.push('| iface | rx | tx | rx_errs | tx_errs |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const n of d.network) {
      lines.push(`| \`${n.interface}\` | ${formatBytes(n.rx_bytes)} | ${formatBytes(n.tx_bytes)} | ${n.rx_errs ?? 0} | ${n.tx_errs ?? 0} |`);
    }
  } else if (type === 'process' && Array.isArray(d.process)) {
    lines.push(renderProcTable(d.process));
  } else if (type === 'overview' && d.overview) {
    return renderHealthCheck({ ...result, data: d.overview });
  } else {
    lines.push('_no data_');
  }
  return lines.join('\n').trimEnd();
}

export function renderServiceStatus(result) {
  if (!result.success) return `[err] **ssh_service_status** -- ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) return defaultPreviewRender(result);
  const srv = result.server ? ` | \`${result.server}\`` : '';
  const active = d.active_state || 'unknown';
  const badge =
    active === 'active' ? '[ok] **active**' :
      active === 'failed' ? '[err] **failed**' :
        active === 'inactive' ? '[warn] **inactive**' :
          `| \`${active}\``;
  const lines = [];
  lines.push(`${badge} | **ssh_service_status** | \`${d.service}\`${srv}`);
  lines.push('');
  lines.push(renderKV([
    ['active', d.active_state ?? '--'],
    ['sub', d.sub_state ?? '--'],
    ['load', d.load_state ?? '--'],
    ['unit_file', d.unit_file_state ?? '--'],
    ['main_pid', d.main_pid ?? '--'],
    ['memory', d.memory_bytes != null ? formatBytes(d.memory_bytes) : '--'],
    ['cpu_time', d.cpu_ns != null ? formatDuration(d.cpu_ns / 1e6) : '--'],
    ['description', d.description ?? '--'],
  ]));
  if (Array.isArray(d.recent_logs) && d.recent_logs.length) {
    lines.push('');
    lines.push('**recent logs**');
    lines.push('```text');
    for (const l of d.recent_logs) lines.push(l);
    lines.push('```');
  }
  return lines.join('\n').trimEnd();
}

function renderProcTable(rows) {
  const lines = ['| PID | USER | CPU% | MEM% | CMD |', '| --- | --- | --- | --- | --- |'];
  for (const p of rows) {
    const cmd = escapeMdCell((p.cmd || p.comm || '').slice(0, 80));
    lines.push(`| ${p.pid} | ${p.user ?? '--'} | ${fmtPct(p.cpu_pct)} | ${fmtPct(p.mem_pct)} | \`${cmd}\` |`);
  }
  return lines.join('\n');
}

export function renderProcessManager(result) {
  if (!result.success) return `[err] **ssh_process_manager** -- ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) return defaultPreviewRender(result);
  const srv = result.server ? ` | \`${result.server}\`` : '';
  if (d.action === 'list') {
    const lines = [`[ok] **ssh_process_manager** | \`list\`${srv}`];
    lines.push('');
    lines.push(renderProcTable(d.processes || []));
    return lines.join('\n');
  }
  if (d.action === 'info') {
    const p = d.process || {};
    const lines = [`[ok] **ssh_process_manager** | \`info\` | pid \`${p.pid ?? '?'}\`${srv}`];
    lines.push('');
    lines.push(renderKV([
      ['pid', p.pid ?? '--'],
      ['user', p.user ?? '--'],
      ['stat', p.stat ?? '--'],
      ['cpu', fmtPct(p.cpu_pct)],
      ['mem', fmtPct(p.mem_pct)],
      ['comm', p.comm ?? '--'],
      ['cmd', p.cmd ?? '--'],
      ['start', p.start ?? '--'],
      ['etime', p.etime ?? '--'],
    ]));
    return lines.join('\n');
  }
  if (d.action === 'kill') {
    const lines = [`[ok] **ssh_process_manager** | \`kill\`${srv}`];
    lines.push('');
    lines.push(renderKV([
      ['pid', d.pid],
      ['signal', d.sent_signal],
      ['exit', d.exit_code ?? '--'],
    ]));
    if (d.stderr) {
      lines.push('');
      lines.push('**stderr**');
      lines.push('```text');
      lines.push(d.stderr);
      lines.push('```');
    }
    return lines.join('\n');
  }
  return `[ok] **ssh_process_manager**${srv}`;
}

function defaultPreviewRender(result) {
  const d = result.data;
  const lines = [];
  lines.push(`[ok] **${result.tool}** -- dry run`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(d.plan, null, 2));
  lines.push('```');
  return lines.join('\n');
}

function fmtPct(x) {
  if (x == null) return '--';
  const n = Number(x);
  if (!Number.isFinite(n)) return '--';
  return `${n.toFixed(1)}%`;
}

// --------------------------------------------------------------------------
// handleSshHealthCheck -- one aggregated remote call
// --------------------------------------------------------------------------

/**
 * One-shot health aggregator. Runs a single remote bash command that emits
 * every section separated by `---SECTION---` markers, then parses each into
 * typed JSON.
 */
export async function handleSshHealthCheck({ getConnection, args }) {
  const { server, format = 'markdown' } = args || {};
  const command = [
    'echo \'---CPU---\'', 'top -bn1 | head -5',
    'echo \'---MEM---\'', 'free -b',
    'echo \'---DISK---\'',
    'df -B1 -x tmpfs -x devtmpfs --output=source,size,used,avail,pcent,target',
    'echo \'---LOAD---\'', 'cat /proc/loadavg',
    'echo \'---UPTIME---\'', 'cat /proc/uptime',
    'echo \'---CORES---\'', 'nproc || grep -c ^processor /proc/cpuinfo',
  ].join('; ');
  // LANG=C / LC_ALL=C pins output format for parsers: avoids locale-specific
  // number formatting (e.g. `1,234.5` vs `1.234,5`) and translated column
  // headers on non-English hosts.
  const remote = `LANG=C LC_ALL=C bash -c ${shQuote(command)}`;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_health_check', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderHealthCheck,
    });
  }

  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_health_check', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderHealthCheck,
    });
  }

  const sections = splitHealthSections(result.stdout || '');
  const cpu = parseTopCpu(sections.CPU);
  const memory = parseFreeMem(sections.MEM);
  const disk = parseDf(sections.DISK);
  const load = parseLoadAvg(sections.LOAD);
  const uptime = parseUptime(sections.UPTIME);
  const cores = sections.CORES ? toInt(sections.CORES.trim().split('\n')[0], null) : null;
  const status = computeStatus({ memory, disk, load }, cores);

  const data = { cpu, memory, load, disk, uptime, cores, status };
  return toMcp(ok('ssh_health_check', data, {
    server,
    duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderHealthCheck });
}

// --------------------------------------------------------------------------
// handleSshMonitor -- type-scoped slice
// --------------------------------------------------------------------------

export async function handleSshMonitor({ getConnection, args }) {
  const { server, type = 'overview', format = 'markdown' } = args || {};
  const startedAt = Date.now();

  // overview = delegate to health_check
  if (type === 'overview') {
    const hc = await handleSshHealthCheck({ getConnection, args: { server, format: 'json' } });
    if (hc.isError) return hc;
    const parsed = JSON.parse(hc.content[0].text);
    if (!parsed.success) {
      return toMcp(fail('ssh_monitor', parsed.error || 'failed', { server }), { format, renderer: renderMonitor });
    }
    return toMcp(ok('ssh_monitor', { type, overview: parsed.data }, {
      server, duration_ms: Date.now() - startedAt,
    }), { format, renderer: renderMonitor });
  }

  let command;
  switch (type) {
    case 'cpu':
      command = 'top -bn1 | head -5';
      break;
    case 'memory':
      command = 'free -b';
      break;
    case 'disk':
      command = 'df -B1 -x tmpfs -x devtmpfs --output=source,size,used,avail,pcent,target';
      break;
    case 'network':
      command = 'cat /proc/net/dev';
      break;
    case 'process':
      command = 'ps -eo pid,user,%cpu,%mem,comm,args --sort=-%cpu | head -20';
      break;
    default:
      return toMcp(fail('ssh_monitor', `unknown type "${type}"`, { server }), {
        format, renderer: renderMonitor,
      });
  }

  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_monitor', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderMonitor,
    });
  }

  let result;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_monitor', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderMonitor,
    });
  }

  const stdout = result.stdout || '';
  let payload;
  switch (type) {
    case 'cpu':      payload = { type, cpu: parseTopCpu(stdout) }; break;
    case 'memory':   payload = { type, memory: parseFreeMem(stdout) }; break;
    case 'disk':     payload = { type, disk: parseDf(stdout) }; break;
    case 'network':  payload = { type, network: parseNetDev(stdout) }; break;
    case 'process':  payload = { type, process: parsePsList(stdout) }; break;
  }

  return toMcp(ok('ssh_monitor', payload, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderMonitor });
}

// --------------------------------------------------------------------------
// handleSshServiceStatus
// --------------------------------------------------------------------------

export async function handleSshServiceStatus({ getConnection, args }) {
  const { server, service, format = 'markdown' } = args || {};
  if (!service) {
    return toMcp(fail('ssh_service_status', 'service is required', { server }), {
      format, renderer: renderServiceStatus,
    });
  }

  const quoted = shQuote(String(service));
  const props = 'ActiveState,SubState,LoadState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,Description';
  const command = [
    'echo \'---SHOW---\'',
    `systemctl show ${quoted} --property=${props}`,
    'echo \'---STATUS---\'',
    `systemctl status ${quoted} --no-pager -n 10 2>/dev/null || true`,
  ].join('; ');
  const remote = `bash -c ${shQuote(command)}`;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_service_status', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderServiceStatus,
    });
  }

  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_service_status', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderServiceStatus,
    });
  }

  const sections = splitHealthSections(result.stdout || '');
  const showText = sections.SHOW || '';
  const statusText = sections.STATUS || '';
  const shownProps = parseSystemctlShow(showText);

  // Extract last-N journal lines from `systemctl status`. The status body
  // ends with a journal block; take lines that start with a month name or
  // fall back to all non-empty trailing lines (up to 10).
  const recentLogs = extractJournalLines(statusText, 10);

  const shaped = shapeServiceRecord(service, shownProps, recentLogs);
  return toMcp(ok('ssh_service_status', shaped, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderServiceStatus });
}

/**
 * Heuristically extract last-N journal lines from `systemctl status` output.
 * Takes trailing non-empty lines that don't look like header keys.
 */
export function extractJournalLines(text, maxLines = 10) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Drop the unit-header block: lines starting with "*" or "Loaded:", "Active:",
  // "Main PID:", "Tasks:", "Memory:", "CGroup:" etc.
  const headerPat = /^(\*|Loaded:|Active:|Main PID:|Tasks:|Memory:|CPU:|CGroup:|Docs?:|Process:|Drop-In:|Status:|TriggeredBy:|Triggers:|Unit:|\*\s)/;
  const journal = [];
  for (const l of lines) {
    if (headerPat.test(l)) { journal.length = 0; continue; }
    journal.push(l);
  }
  return journal.slice(-maxLines);
}

// --------------------------------------------------------------------------
// handleSshProcessManager
// --------------------------------------------------------------------------

const ALLOWED_SIGNALS = new Set([
  'TERM', 'KILL', 'HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'STOP', 'CONT',
  // Numeric forms also accepted
]);

function normalizeSignal(sig) {
  if (sig == null) return 'TERM';
  let s = String(sig).trim().toUpperCase();
  // Strip leading SIG / dash
  s = s.replace(/^-/, '').replace(/^SIG/, '');
  if (/^\d+$/.test(s)) return s; // numeric signal OK
  if (ALLOWED_SIGNALS.has(s)) return s;
  return null;
}

export async function handleSshProcessManager({ getConnection, args }) {
  const {
    server,
    action = 'list',
    pid,
    signal = 'TERM',
    preview: isPreview = false,
    format = 'markdown',
  } = args || {};

  const startedAt = Date.now();

  if (action === 'list') {
    let client;
    try { client = await getConnection(server); }
    catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    let result;
    try {
      result = await streamExecCommand(
        client,
        'ps -eo pid,user,%cpu,%mem,comm,args --sort=-%cpu | head -20',
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
    } catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    const list = parsePsList(result.stdout || '');
    // Ensure sorted desc by cpu_pct (ps already does, but double-check).
    list.sort((a, b) => (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0));
    return toMcp(ok('ssh_process_manager', { action: 'list', processes: list }, {
      server, duration_ms: Date.now() - startedAt,
    }), { format, renderer: renderProcessManager });
  }

  if (action === 'info') {
    const p = toInt(pid, null);
    if (p == null || p <= 0) {
      return toMcp(fail('ssh_process_manager', 'info requires a positive integer pid', { server }), {
        format, renderer: renderProcessManager,
      });
    }
    let client;
    try { client = await getConnection(server); }
    catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    let result;
    try {
      result = await streamExecCommand(
        client,
        `ps -p ${p} -o pid,user,stat,%cpu,%mem,comm,args,start,etime`,
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
    } catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    const info = parsePsInfo(result.stdout || '');
    if (!info) {
      return toMcp(fail('ssh_process_manager', `no such pid ${p}`, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    return toMcp(ok('ssh_process_manager', { action: 'info', process: info }, {
      server, duration_ms: Date.now() - startedAt,
    }), { format, renderer: renderProcessManager });
  }

  if (action === 'kill') {
    const p = toInt(pid, null);
    const sig = normalizeSignal(signal);
    if (p == null || p <= 0) {
      return toMcp(fail('ssh_process_manager', 'kill requires a positive integer pid', { server }), {
        format, renderer: renderProcessManager,
      });
    }
    if (sig == null) {
      return toMcp(fail('ssh_process_manager', `invalid signal "${signal}"`, { server }), {
        format, renderer: renderProcessManager,
      });
    }

    const remote = `kill -${sig} ${p}`;

    if (isPreview) {
      const plan = buildPlan({
        action: 'kill',
        target: `${server}:pid=${p}`,
        effects: [`sends SIG${sig} to pid ${p} on ${server}`, `remote command: \`${remote}\``],
        reversibility: 'irreversible',
        risk: sig === 'KILL' ? 'high' : 'medium',
      });
      return toMcp(preview('ssh_process_manager', plan, { server }), {
        format, renderer: renderProcessManager,
      });
    }

    let client;
    try { client = await getConnection(server); }
    catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    let result;
    try {
      result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
    } catch (e) {
      return toMcp(fail('ssh_process_manager', e, { server, duration_ms: Date.now() - startedAt }), {
        format, renderer: renderProcessManager,
      });
    }
    return toMcp(ok('ssh_process_manager', {
      action: 'kill',
      pid: p,
      sent_signal: sig,
      exit_code: result.code ?? 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    }, {
      server, duration_ms: Date.now() - startedAt,
    }), { format, renderer: renderProcessManager });
  }

  return toMcp(fail('ssh_process_manager', `unknown action "${action}"`, { server }), {
    format, renderer: renderProcessManager,
  });
}
