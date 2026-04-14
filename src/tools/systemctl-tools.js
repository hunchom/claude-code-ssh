/**
 * ssh_systemctl — typed systemd unit control.
 *
 * Actions:
 *   - start / stop / restart / reload / enable / disable  (mutating; sudo by default)
 *   - status                                              (read-only; typed record)
 *   - list-units                                          (read-only; running services)
 *   - list-unit-files                                     (read-only; all unit files)
 *   - daemon-reload                                       (mutating; sudo by default)
 *
 * Safety:
 *   - unit name validated by regex; no shell metacharacters can slip through
 *   - action is whitelisted; invalid values fail before any remote call
 *   - all interpolated values shell-quoted via shQuote()
 *   - mutating actions support preview:true — dry-run card, no remote touch
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatBytes, formatDuration } from '../output-formatter.js';
import {
  parseSystemctlShow,
  sdNum,
  splitHealthSections,
} from './monitoring-tools.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// ──────────────────────────────────────────────────────────────────────────
// Whitelists
// ──────────────────────────────────────────────────────────────────────────

/** All allowed action verbs. */
export const ALLOWED_ACTIONS = new Set([
  'start', 'stop', 'restart', 'reload',
  'enable', 'disable',
  'status',
  'list-units', 'list-unit-files',
  'daemon-reload',
]);

/** Mutating actions — default to sudo; support preview. */
export const MUTATING_ACTIONS = new Set([
  'start', 'stop', 'restart', 'reload',
  'enable', 'disable',
  'daemon-reload',
]);

/** Actions that do not take a unit argument. */
export const NO_UNIT_ACTIONS = new Set([
  'list-units', 'list-unit-files', 'daemon-reload',
]);

/**
 * Reversibility map for mutating actions.
 *   start     → stop   (auto)
 *   stop      → start  (manual — needs human to know correct start)
 *   restart   → restart itself restores state (auto)
 *   reload    → reloads config without restart; auto-safe
 *   enable    → disable (auto)
 *   disable   → enable  (auto)
 *   daemon-reload → no visible mutation (auto-safe)
 */
export const REVERSIBILITY = {
  start: 'auto',
  stop: 'manual',
  restart: 'auto',
  reload: 'auto',
  enable: 'auto',
  disable: 'auto',
  'daemon-reload': 'auto',
};

/**
 * Risk map per action. `stop`/`disable`/`daemon-reload` can drop services.
 */
export const RISK_MAP = {
  start: 'medium',
  stop: 'high',
  restart: 'medium',
  reload: 'low',
  enable: 'low',
  disable: 'medium',
  'daemon-reload': 'medium',
};

// ──────────────────────────────────────────────────────────────────────────
// Validators — exported for tests
// ──────────────────────────────────────────────────────────────────────────

/**
 * Systemd unit name regex.
 *   - Allowed suffixes: .service .socket .timer .target .mount .path .device
 *   - Name body: A-Z, a-z, 0-9, @ . _ : -
 *   - Disallows any shell metacharacters (space, ;, &, |, $, `, <, >, quotes,
 *     path separators, NUL, newline, etc.)
 *
 * We intentionally require the suffix to be present so that bare "nginx" fails
 * fast — caller must be explicit about unit type.
 */
export const UNIT_NAME_RE = /^[A-Za-z0-9@._:-]+\.(service|socket|timer|target|mount|path|device)$/;

export function isValidUnit(unit) {
  if (typeof unit !== 'string' || !unit) return false;
  return UNIT_NAME_RE.test(unit);
}

// ──────────────────────────────────────────────────────────────────────────
// Parsers — exported for tests
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse `systemctl list-units --no-legend --plain` output.
 * Format (6 columns, some may be absent on older systemd):
 *   UNIT                 LOAD   ACTIVE SUB      DESCRIPTION
 *   nginx.service        loaded active running  nginx HTTP server
 */
export function parseListUnits(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // Skip if it looks like a legend/footer
    if (/^[0-9]+\s+(loaded|unit)/i.test(line)) continue;
    if (/^LEGEND/i.test(line)) continue;
    if (/listed\./i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const unit = cols[0];
    // Require unit-looking first column to avoid picking up footer garbage
    if (!/\.[a-z]+$/.test(unit)) continue;
    out.push({
      unit,
      load: cols[1],
      active: cols[2],
      sub: cols[3],
      description: cols.slice(4).join(' ') || '',
    });
  }
  return out;
}

/**
 * Parse `systemctl list-unit-files --no-legend --plain` output.
 * Format: UNIT-FILE   STATE       VENDOR-PRESET?
 */
export function parseListUnitFiles(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/listed\./i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 2) continue;
    const unit = cols[0];
    if (!/\.[a-z]+$/.test(unit)) continue;
    out.push({
      unit,
      state: cols[1],
      vendor_preset: cols[2] || null,
    });
  }
  return out;
}

/**
 * Shape a systemctl show record for an action=status call.
 */
export function shapeUnitStatus(unit, props, recentLogs) {
  return {
    unit,
    active_state: props.ActiveState || null,
    sub_state: props.SubState || null,
    load_state: props.LoadState || null,
    unit_file_state: props.UnitFileState || null,
    description: props.Description || null,
    main_pid: sdNum(props.MainPID),
    memory_bytes: sdNum(props.MemoryCurrent),
    cpu_ns: sdNum(props.CPUUsageNSec),
    recent_logs: Array.isArray(recentLogs) ? recentLogs : [],
  };
}

/**
 * Extract journal lines from `journalctl -u UNIT -n N --no-pager`. Each
 * non-empty line becomes an entry; blank separators are dropped.
 */
export function parseJournalLines(text, maxLines = 10) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // journalctl may emit a leading "-- Logs begin at ... --" boilerplate. Drop it.
  const clean = lines.filter(l => !/^-- (Logs|Boot|Journal|No entries)/i.test(l));
  return clean.slice(-maxLines);
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer
// ──────────────────────────────────────────────────────────────────────────

function fmtBadge(active) {
  if (active === 'active') return '▶ **active**';
  if (active === 'failed') return '✕ **failed**';
  if (active === 'inactive') return '⚠ **inactive**';
  return `· \`${active || 'unknown'}\``;
}

function renderKV(rows) {
  const lines = ['| field | value |', '| --- | --- |'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

export function renderSystemctl(result) {
  if (!result.success) return `✕ **ssh_systemctl** — ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) {
    const lines = [];
    lines.push(`▶ **ssh_systemctl** — dry run`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(d.plan, null, 2));
    lines.push('```');
    return lines.join('\n');
  }
  const srv = result.server ? `  ·  \`${result.server}\`` : '';

  if (d.action === 'status' && d.unit) {
    const lines = [];
    lines.push(`${fmtBadge(d.active_state)}  ·  **ssh_systemctl status**  ·  \`${d.unit}\`${srv}`);
    lines.push('');
    lines.push(renderKV([
      ['active', d.active_state ?? '—'],
      ['sub', d.sub_state ?? '—'],
      ['load', d.load_state ?? '—'],
      ['unit_file', d.unit_file_state ?? '—'],
      ['main_pid', d.main_pid ?? '—'],
      ['memory', d.memory_bytes != null ? formatBytes(d.memory_bytes) : '—'],
      ['cpu_time', d.cpu_ns != null ? formatDuration(d.cpu_ns / 1e6) : '—'],
      ['description', d.description ?? '—'],
    ]));
    if (Array.isArray(d.recent_logs) && d.recent_logs.length) {
      lines.push('');
      lines.push('**recent logs**');
      lines.push('```text');
      for (const l of d.recent_logs) lines.push(l);
      lines.push('```');
    }
    return lines.join('\n');
  }

  if (d.action === 'list-units') {
    const lines = [`▶ **ssh_systemctl list-units**${srv}  ·  ${d.units.length} units`];
    if (d.units.length) {
      lines.push('');
      lines.push('| unit | load | active | sub | description |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const u of d.units) {
        const desc = (u.description || '').slice(0, 60).replace(/\|/g, '\\|');
        lines.push(`| \`${u.unit}\` | ${u.load} | ${u.active} | ${u.sub} | ${desc} |`);
      }
    }
    return lines.join('\n');
  }

  if (d.action === 'list-unit-files') {
    const lines = [`▶ **ssh_systemctl list-unit-files**${srv}  ·  ${d.units.length} files`];
    if (d.units.length) {
      lines.push('');
      lines.push('| unit | state | vendor_preset |');
      lines.push('| --- | --- | --- |');
      for (const u of d.units) {
        lines.push(`| \`${u.unit}\` | ${u.state} | ${u.vendor_preset ?? '—'} |`);
      }
    }
    return lines.join('\n');
  }

  // Mutation result
  const badge = d.exit_code === 0 ? '▶' : '✕';
  const lines = [];
  const target = d.unit ? `  ·  \`${d.unit}\`` : '';
  lines.push(`${badge} **ssh_systemctl ${d.action}**${target}${srv}  ·  exit ${d.exit_code}`);
  if (d.result) {
    lines.push('');
    lines.push('```text');
    lines.push(d.result);
    lines.push('```');
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// handleSshSystemctl
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} params
 * @param {Function} params.getConnection
 * @param {Object} params.args
 *   - server
 *   - action (required; whitelisted)
 *   - unit (required for all actions except list-units/list-unit-files/daemon-reload)
 *   - pattern (optional filter for list-units/list-unit-files)
 *   - use_sudo (default true for mutating)
 *   - preview (default false)
 *   - format (markdown | json | both)
 */
export async function handleSshSystemctl({ getConnection, args }) {
  const {
    server,
    action,
    unit,
    pattern,
    use_sudo,
    preview: isPreview = false,
    format = 'markdown',
  } = args || {};

  // ── Validation ────────────────────────────────────────────────────────
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return toMcp(fail('ssh_systemctl', `invalid action "${action}"`, { server }), {
      format, renderer: renderSystemctl,
    });
  }

  const needsUnit = !NO_UNIT_ACTIONS.has(action);
  if (needsUnit) {
    if (!unit) {
      return toMcp(fail('ssh_systemctl', `action "${action}" requires a unit`, { server }), {
        format, renderer: renderSystemctl,
      });
    }
    if (!isValidUnit(unit)) {
      return toMcp(fail('ssh_systemctl', `invalid unit name "${unit}"`, { server }), {
        format, renderer: renderSystemctl,
      });
    }
  }

  const useSudo = use_sudo === undefined
    ? MUTATING_ACTIONS.has(action)
    : Boolean(use_sudo);

  // ── status action — read-only, typed record ───────────────────────────
  if (action === 'status') {
    return runStatus({ getConnection, server, unit, format });
  }

  // ── list-units / list-unit-files ──────────────────────────────────────
  if (action === 'list-units' || action === 'list-unit-files') {
    return runList({ getConnection, server, action, pattern, format });
  }

  // ── Mutating actions ──────────────────────────────────────────────────
  return runMutation({
    getConnection, server, action, unit, useSudo,
    isPreview, format,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Internal runners
// ──────────────────────────────────────────────────────────────────────────

async function runStatus({ getConnection, server, unit, format }) {
  const quoted = shQuote(String(unit));
  const props = 'ActiveState,SubState,LoadState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,Description';
  const command = [
    "echo '---SHOW---'",
    `systemctl show ${quoted} --property=${props}`,
    "echo '---LOGS---'",
    `journalctl -u ${quoted} -n 10 --no-pager 2>/dev/null || true`,
  ].join('; ');
  const remote = `bash -c ${shQuote(command)}`;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }

  const sections = splitHealthSections(result.stdout || '');
  const props2 = parseSystemctlShow(sections.SHOW || '');
  const logs = parseJournalLines(sections.LOGS || '', 10);
  const shaped = { action: 'status', ...shapeUnitStatus(unit, props2, logs) };
  return toMcp(ok('ssh_systemctl', shaped, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderSystemctl });
}

async function runList({ getConnection, server, action, pattern, format }) {
  let command;
  if (action === 'list-units') {
    // Running services; --all lets caller see failed ones too.
    command = 'systemctl list-units --no-legend --plain --type=service --state=running --all';
  } else {
    command = 'systemctl list-unit-files --no-legend --plain --type=service';
  }
  if (pattern) {
    command += ` | grep -E ${shQuote(String(pattern))}`;
  }
  const remote = `bash -c ${shQuote(command)}`;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }

  const units = action === 'list-units'
    ? parseListUnits(result.stdout || '')
    : parseListUnitFiles(result.stdout || '');

  return toMcp(ok('ssh_systemctl', { action, units }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderSystemctl });
}

async function runMutation({ getConnection, server, action, unit, useSudo, isPreview, format }) {
  // daemon-reload has no unit argument
  const quotedUnit = unit ? shQuote(String(unit)) : '';
  const sudoPrefix = useSudo ? 'sudo -n ' : '';
  // `-n` makes sudo non-interactive; caller should have configured NOPASSWD
  // or this will fail cleanly rather than hang. For prompted-password sudo,
  // callers should use ssh_execute_sudo.
  const remote = action === 'daemon-reload'
    ? `${sudoPrefix}systemctl daemon-reload`
    : `${sudoPrefix}systemctl ${action} ${quotedUnit}`;

  if (isPreview) {
    const effects = [
      `runs \`${remote}\` on ${server}`,
    ];
    if (unit) {
      // Reachability probe — we document it but don't fire it in preview;
      // claude can call status beforehand if it wants confirmation.
      effects.push(`reachability probe: \`systemctl cat ${unit} 2>&1 | head -1\``);
    }
    const plan = buildPlan({
      action: `systemctl-${action}`,
      target: unit ? `${server}:${unit}` : `${server}:daemon`,
      effects,
      reversibility: REVERSIBILITY[action] || 'manual',
      risk: RISK_MAP[action] || 'medium',
      reverse_command: buildReverseCommand(action, unit),
    });
    return toMcp(preview('ssh_systemctl', plan, { server }), {
      format, renderer: renderSystemctl,
    });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_systemctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderSystemctl,
    });
  }

  const durationMs = Date.now() - startedAt;
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const data = {
    action,
    unit: unit || null,
    result: combined,
    exit_code: result.code ?? 0,
    duration_ms: durationMs,
  };
  return toMcp(ok('ssh_systemctl', data, {
    server, duration_ms: durationMs,
  }), { format, renderer: renderSystemctl });
}

function buildReverseCommand(action, unit) {
  switch (action) {
    case 'start':       return `systemctl stop ${unit}`;
    case 'stop':        return `systemctl start ${unit}`;
    case 'restart':     return `systemctl restart ${unit}`;
    case 'reload':      return null;
    case 'enable':      return `systemctl disable ${unit}`;
    case 'disable':     return `systemctl enable ${unit}`;
    case 'daemon-reload': return null;
    default:            return null;
  }
}
