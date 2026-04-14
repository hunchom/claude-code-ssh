/**
 * ssh_journalctl -- typed journal reads.
 *
 * Reads systemd journal entries with optional filtering.
 *
 * JSON-mode parses each line (journalctl emits one JSON object per record)
 * into a small, typed shape:
 *   { time, priority, hostname, unit, message, pid?, uid? }
 *
 * Text-mode returns raw journalctl output (human-friendly).
 *
 * All interpolated values are shell-quoted via shQuote(). `since`/`until`
 * are opaque strings from journalctl's perspective -- both absolute
 * ("2024-01-01 10:00") and relative ("5 minutes ago", "1h") work.
 *
 * follow:true is NOT supported in this tool -- it would block indefinitely.
 * Use ssh_tail against /var/log/messages or ssh_tail_start for streaming.
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, toMcp } from '../structured-result.js';
import { formatDuration } from '../output-formatter.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LINES = 100;
const MAX_LINES = 10_000;

/** journalctl -p accepts these priority names or 0..7 numeric levels. */
export const ALLOWED_PRIORITIES = new Set([
  'emerg', 'alert', 'crit', 'err', 'warning', 'warn', 'notice', 'info', 'debug',
]);

/**
 * Priority numeric->name map (from syslog severity). Used when JSON mode
 * returns the numeric PRIORITY field.
 */
export const PRIORITY_NAMES = {
  0: 'emerg',
  1: 'alert',
  2: 'crit',
  3: 'err',
  4: 'warning',
  5: 'notice',
  6: 'info',
  7: 'debug',
};

/**
 * Coerce a priority value to a journalctl-safe token. 'warn' is accepted as
 * an alias for 'warning' (which journalctl also honors). Returns null on bad
 * input -- callers must reject.
 */
export function normalizePriority(p) {
  if (p == null) return 'info';
  const s = String(p).trim().toLowerCase();
  if (s === 'warn') return 'warning';
  if (ALLOWED_PRIORITIES.has(s)) return s;
  if (/^[0-7]$/.test(s)) return s;
  return null;
}

/** Clamp line count to [1, MAX_LINES] with safe default. */
export function safeLines(n, fallback = DEFAULT_LINES) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  if (v < 1) return 1;
  if (v > MAX_LINES) return MAX_LINES;
  return v;
}

// --------------------------------------------------------------------------
// Command builder -- exported for tests
// --------------------------------------------------------------------------

/**
 * Build the journalctl command string. All interpolated values shell-quoted.
 *
 * @param {Object} opts
 * @param {string} [opts.unit]
 * @param {string} [opts.since]
 * @param {string} [opts.until]
 * @param {string} [opts.priority='info']
 * @param {number} [opts.lines=100]
 * @param {string} [opts.grep]        grep -E filter on each line of output
 * @param {boolean} [opts.json=true]  add --output=json when true
 */
export function buildJournalctlCommand({
  unit, since, until, priority = 'info', lines = DEFAULT_LINES, grep, json = true,
}) {
  const parts = ['journalctl'];
  if (unit) parts.push('-u', shQuote(String(unit)));
  if (since) parts.push('--since', shQuote(String(since)));
  if (until) parts.push('--until', shQuote(String(until)));

  const pri = normalizePriority(priority) || 'info';
  parts.push('-p', pri);

  parts.push('-n', String(safeLines(lines)));
  parts.push('--no-pager');
  if (json) parts.push('--output=json');

  let cmd = parts.join(' ');
  if (grep) {
    cmd += ` | grep -E ${shQuote(String(grep))}`;
  }
  return cmd;
}

// --------------------------------------------------------------------------
// Parser -- exported for tests
// --------------------------------------------------------------------------

/**
 * Parse JSONL output from `journalctl --output=json` into typed entries.
 *
 * Each journal record uses ALL-CAPS field names. We map to lowercase
 * typed properties:
 *   __REALTIME_TIMESTAMP (us) -> time (ISO-8601 string)
 *   PRIORITY (0..7 numeric)   -> priority (string name)
 *   _HOSTNAME                 -> hostname
 *   _SYSTEMD_UNIT             -> unit
 *   MESSAGE                   -> message
 *   _PID                      -> pid (number)
 *   _UID                      -> uid (number)
 *
 * Malformed JSON lines are skipped. Returns [] on empty input.
 */
export function parseJournalJsonl(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;

    // Timestamp: journald stores us-since-epoch as string
    let time = null;
    const ts = rec.__REALTIME_TIMESTAMP;
    if (ts) {
      const ms = Number(ts) / 1000;
      if (Number.isFinite(ms)) time = new Date(ms).toISOString();
    }

    const prioRaw = rec.PRIORITY;
    let priority = null;
    if (prioRaw != null) {
      const n = Number(prioRaw);
      priority = Number.isFinite(n) && PRIORITY_NAMES[n] ? PRIORITY_NAMES[n] : String(prioRaw);
    }

    const entry = {
      time,
      priority,
      hostname: rec._HOSTNAME ?? null,
      unit: rec._SYSTEMD_UNIT ?? rec.UNIT ?? null,
      message: rec.MESSAGE ?? null,
    };
    if (rec._PID != null) entry.pid = Number(rec._PID);
    if (rec._UID != null) entry.uid = Number(rec._UID);
    out.push(entry);
  }
  return out;
}

// --------------------------------------------------------------------------
// Renderer
// --------------------------------------------------------------------------

export function renderJournalctl(result) {
  if (!result.success) return `[err] **ssh_journalctl** -- ${result.error || 'failed'}`;
  const d = result.data;
  const srv = result.server ? ` | \`${result.server}\`` : '';
  const dur = result.meta?.duration_ms != null ? ` | \`${formatDuration(result.meta.duration_ms)}\`` : '';
  const lines = [];
  lines.push(`[ok] **ssh_journalctl**${srv} | ${d.count} entries${dur}`);

  if (d.entries && d.entries.length) {
    lines.push('');
    // JSON entries -> typed table
    if (typeof d.entries[0] === 'object') {
      lines.push('| time | priority | unit | message |');
      lines.push('| --- | --- | --- | --- |');
      for (const e of d.entries) {
        const t = (e.time ?? '--').toString();
        const msg = (e.message ?? '').toString().slice(0, 120).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${t} | ${e.priority ?? '--'} | ${e.unit ?? '--'} | ${msg} |`);
      }
    } else {
      // Raw text -> code block
      lines.push('```text');
      for (const e of d.entries) lines.push(String(e));
      lines.push('```');
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {Function} params.getConnection
 * @param {Object} params.args
 *   - server
 *   - unit (optional)
 *   - since (optional; absolute or relative string)
 *   - until (optional)
 *   - priority (default 'info')
 *   - lines (default 100)
 *   - grep (optional)
 *   - follow (default false; true -> structured failure)
 *   - json (default true)
 *   - format (markdown | json | both)
 */
export async function handleSshJournalctl({ getConnection, args }) {
  const {
    server,
    unit,
    since,
    until,
    priority = 'info',
    lines = DEFAULT_LINES,
    grep,
    follow = false,
    json = true,
    format = 'markdown',
  } = args || {};

  // -- Validation --------------------------------------------------------
  if (follow) {
    return toMcp(fail('ssh_journalctl',
      'follow:true is not supported -- use ssh_tail on /var/log or ssh_tail_start for streaming', { server }), {
      format, renderer: renderJournalctl,
    });
  }

  if (normalizePriority(priority) == null) {
    return toMcp(fail('ssh_journalctl', `invalid priority "${priority}"`, { server }), {
      format, renderer: renderJournalctl,
    });
  }

  const command = buildJournalctlCommand({
    unit, since, until, priority, lines, grep, json,
  });

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_journalctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderJournalctl,
    });
  }

  let result;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_journalctl', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderJournalctl,
    });
  }

  const stdout = result.stdout || '';
  const durationMs = Date.now() - startedAt;

  let entries;
  if (json) {
    entries = parseJournalJsonl(stdout);
  } else {
    // Raw text: split on newlines, drop blanks. Strip journalctl boilerplate.
    entries = stdout.split('\n')
      .filter(l => l !== '')
      .filter(l => !/^-- (Logs|Boot|Journal|No entries)/i.test(l));
  }

  // Compute earliest / latest from entries when possible
  let earliest = null, latest = null;
  if (json && entries.length) {
    const times = entries.map(e => e.time).filter(Boolean).sort();
    earliest = times[0] || null;
    latest = times[times.length - 1] || null;
  }

  const data = {
    entries,
    count: entries.length,
    earliest,
    latest,
    filtered_by_grep: Boolean(grep),
  };

  return toMcp(ok('ssh_journalctl', data, {
    server, duration_ms: durationMs,
  }), { format, renderer: renderJournalctl });
}
