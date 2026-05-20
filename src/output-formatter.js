/**
 * Output Formatter
 *
 * Pure-JSON wire schema for command results plus a lightweight markdown
 * renderer. Designed for low overhead: ANSI-stripped, head+tail truncation,
 * no emoji, single-char dividers.
 *
 * Callers build an ExecResult, then choose MCP content via makeMcpContent().
 *
 * Truncation cap defaults to OUTPUT_LIMITS.MAX_OUTPUT_LENGTH (tunable via
 * MCP_SSH_MAX_OUTPUT_LENGTH env var). Tool handlers may still pass an
 * explicit maxLen -- it overrides the env default.
 */

import { OUTPUT_LIMITS } from './config.js';
import { compress } from './command-compressors.js';

// ANSI CSI / OSC stripping. Covers color, cursor, title sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * Strip ANSI escape sequences from a string.
 * Returns '' for nullish input.
 */
export function stripAnsi(s) {
  if (!s) return '';
  return String(s).replace(ANSI_RE, '');
}

/**
 * Escape a cell value for a GitHub-Flavored Markdown table.
 *
 * NOT a security sanitizer -- we escape only what breaks the table layout:
 *   backslash first (so it doesn't double-up our own escape), then pipe
 *   (column delimiter), then newlines (collapsed to spaces so a single
 *   value can't break the row).
 *
 * Callers pass strings that are already untrusted remote content -- the
 * table is rendered into a chat client's markdown view, not executed.
 */
export function escapeMdCell(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * Truncate a string keeping head and tail, middle elided.
 * Returns { text, originalBytes, truncatedBytes }.
 * - If input fits, truncatedBytes = 0 and text is unchanged.
 * - Else keeps max/2 chars from head and from tail.
 */
export function truncateHeadTail(s, max = OUTPUT_LIMITS.MAX_OUTPUT_LENGTH) {
  const input = s == null ? '' : String(s);
  const originalBytes = input.length;
  if (originalBytes <= max) {
    return { text: input, originalBytes, truncatedBytes: 0 };
  }
  const keep = Math.floor(max / 2);
  const head = input.slice(0, keep);
  const tail = input.slice(-keep);
  const dropped = originalBytes - head.length - tail.length;
  const marker = `\n... [${dropped} bytes elided] ...\n`;
  return {
    text: head + marker + tail,
    originalBytes,
    truncatedBytes: dropped,
  };
}

/**
 * Build the structured ExecResult from raw stream output.
 * Input: { server, command, cwd?, stdout, stderr, code, durationMs, maxLen?, raw? }
 * Output: wire-schema JSON object.
 *
 * stdout passes through compress() (per-command shaping) before truncation;
 * raw:true bypasses compression. stderr is never compressed -- errors stay whole.
 */
export function formatExecResult({
  server,
  command,
  cwd,
  stdout,
  stderr,
  code,
  durationMs,
  maxLen = OUTPUT_LIMITS.MAX_OUTPUT_LENGTH,
  raw = false,
}) {
  const shapedStdout = compress(command, stripAnsi(stdout), { raw });
  const out = truncateHeadTail(shapedStdout, maxLen);
  const err = truncateHeadTail(stripAnsi(stderr), maxLen);
  return {
    server,
    command,
    cwd: cwd ?? null,
    exit_code: code ?? -1,
    success: code === 0,
    duration_ms: Math.max(0, durationMs | 0),
    stdout: out.text,
    stderr: err.text,
    truncated: {
      stdout_bytes: out.truncatedBytes,
      stderr_bytes: err.truncatedBytes,
      stdout_total: out.originalBytes,
      stderr_total: err.originalBytes,
    },
  };
}

/**
 * Human-friendly byte count (B / KB / MB).
 * 0 -> "0 B", 1023 -> "1023 B", 1024 -> "1.0 KB", 1500000 -> "1.4 MB"
 */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Human-friendly duration (ms -> "245 ms" / "2.34 s" / "1m 23s").
 */
export function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)} s`;
  const m = Math.floor(n / 60_000);
  const s = Math.floor((n % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Render an ExecResult as compact v4 plain text.
 * Header via renderHeader; command on a plain `$` line; stdout/stderr indented.
 */
export function renderMarkdown(r) {
  const marker = r.success ? '[ok]' : '[err]';
  const lines = [renderHeader({
    marker,
    tool: 'ssh_execute',
    server: r.server,
    status: `exit ${r.exit_code}`,
    durationMs: r.duration_ms,
  })];

  lines.push(`$ ${r.command}${r.cwd ? `  (in ${r.cwd})` : ''}`);

  if (r.stdout) {
    lines.push('');
    lines.push(indentBody(r.stdout));
  }

  if (r.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(indentBody(r.stderr));
  }

  if (r.truncated.stdout_bytes || r.truncated.stderr_bytes) {
    const parts = [];
    if (r.truncated.stdout_bytes) parts.push(`stdout ${formatBytes(r.truncated.stdout_bytes)}`);
    if (r.truncated.stderr_bytes) parts.push(`stderr ${formatBytes(r.truncated.stderr_bytes)}`);
    lines.push('');
    lines.push(`elided: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build the MCP `content` array from an ExecResult.
 * format: "compact" (default) | "markdown" | "json" | "both".
 * compact and markdown both use renderMarkdown -- the renderer is already
 * fence-free and compact; the names are kept distinct for caller intent.
 */
export function makeMcpContent(result, { format = 'compact' } = {}) {
  if (format === 'json') {
    return [{ type: 'text', text: JSON.stringify(result) }];
  }
  if (format === 'both') {
    return [
      { type: 'text', text: renderMarkdown(result) },
      { type: 'text', text: JSON.stringify(result) },
    ];
  }
  return [{ type: 'text', text: renderMarkdown(result) }];
}

/**
 * Render the single v4 header line. Grammar:
 *   <marker> <tool> · <action> · <server> · <status> · <duration>
 * Absent slots collapse; present slots never reorder. Used by every v4 tool.
 */
export function renderHeader({
  marker = '[ok]', tool, action, server, status, durationMs,
} = {}) {
  const slots = [];
  if (tool) slots.push(String(tool));
  if (action) slots.push(String(action));
  if (server) slots.push(String(server));
  if (status != null && status !== '') slots.push(String(status));
  if (durationMs != null) slots.push(formatDuration(durationMs));
  return `${marker} ${slots.join(' · ')}`;
}

/**
 * Indent a payload block by `prefix` (default 2 spaces). Replaces fenced code
 * blocks in v4 output -- clean as plain text, unbreakable by payload content.
 */
export function indentBody(text, prefix = '  ') {
  if (text == null || text === '') return '';
  return String(text).split('\n').map((l) => prefix + l).join('\n');
}

/**
 * Render [key, value] pairs as a column-aligned key/value block. Keys are
 * left-padded to the longest key; a 2-space gutter separates key and value.
 * Cell values must be single-line; multiline payloads belong in indentBody.
 * Malformed (non-array) rows degrade to a blank key/value, never throw.
 */
export function renderKV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const safe = rows.map((r) => (Array.isArray(r) ? r : []));
  const width = Math.max(0, ...safe.map(([k]) => String(k ?? '').length));
  return safe
    .map(([k, v]) => `${String(k ?? '').padEnd(width)}  ${v == null ? '' : String(v)}`)
    .join('\n');
}

/**
 * Render rows as a column-aligned ASCII table. `headers` is an array of column
 * labels; `rows` is an array of cell arrays. With an `isFail` predicate, failed
 * rows sort first and an `N/M failed` summary line is prepended.
 * Cell values must be single-line; multiline payloads belong in indentBody.
 * Malformed (non-array) rows degrade to a blank row, never throw.
 */
export function renderRows(headers, rows, { isFail } = {}) {
  if (!Array.isArray(headers) || headers.length === 0) return '';
  let ordered = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : []));
  let summary = '';
  if (typeof isFail === 'function') {
    const failed = ordered.filter((r) => isFail(r));
    const rest = ordered.filter((r) => !isFail(r));
    ordered = [...failed, ...rest];
    if (failed.length > 0) summary = `${failed.length}/${ordered.length} failed`;
  }
  const widths = headers.map((h, i) =>
    Math.max(0, String(h).length, ...ordered.map((r) => String(r[i] ?? '').length)));
  const fmt = (cells) =>
    cells
      .map((c, i) => String(c ?? '').padEnd(widths[i]))
      .join('  ')
      .replace(/\s+$/, '');
  const lines = [];
  if (summary) lines.push(summary);
  lines.push(fmt(headers));
  for (const r of ordered) lines.push(fmt(r));
  return lines.join('\n');
}
