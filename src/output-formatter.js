/**
 * Output Formatter
 *
 * Pure-JSON wire schema for command results plus a lightweight markdown
 * renderer. Designed for low overhead: ANSI-stripped, head+tail truncation,
 * no emoji, single-char dividers.
 *
 * Callers build an ExecResult, then choose MCP content via makeMcpContent().
 */

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
 * Truncate a string keeping head and tail, middle elided.
 * Returns { text, originalBytes, truncatedBytes }.
 * - If input fits, truncatedBytes = 0 and text is unchanged.
 * - Else keeps max/2 chars from head and from tail.
 */
export function truncateHeadTail(s, max = 10_000) {
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
 * Input: { server, command, cwd?, stdout, stderr, code, durationMs, maxLen? }
 * Output: wire-schema JSON object.
 */
export function formatExecResult({
  server,
  command,
  cwd,
  stdout,
  stderr,
  code,
  durationMs,
  maxLen = 10_000,
}) {
  const out = truncateHeadTail(stripAnsi(stdout), maxLen);
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
 * Render an ExecResult as cool, scannable Claude Code markdown.
 *
 * Layout:
 *   [ok] **ssh_execute** | `server` | **exit 0** | `2.34 s`
 *   `$ <command>`   *(in /some/cwd)*
 *
 *   ```
 *   <stdout>
 *   ```
 *
 *   **stderr**
 *   ```
 *   <stderr>
 *   ```
 *
 *   > elided: stdout 12.0 KB, stderr 0 B
 *
 * - Success uses [ok] marker and bold "exit 0"; failure uses [err] and bold "exit N".
 * - Empty sections are omitted. cwd suppressed when null.
 * - Language-tagged fenced blocks (`text`) render with a subtle tint in Claude Code.
 */
export function renderMarkdown(r) {
  const ok = r.success;
  const marker = ok ? '[ok]' : '[err]';
  const exitText = ok ? 'exit 0' : `exit ${r.exit_code}`;
  const duration = formatDuration(r.duration_ms);

  const lines = [];
  lines.push(`${marker} **ssh_execute** | \`${r.server}\` | ${exitText} | ${duration}`);

  const cwdFragment = r.cwd ? `  *(in \`${r.cwd}\`)*` : '';
  lines.push(`\`$ ${r.command}\`${cwdFragment}`);

  if (r.stdout) {
    lines.push('');
    lines.push('```text');
    lines.push(r.stdout);
    lines.push('```');
  }

  if (r.stderr) {
    lines.push('');
    lines.push('**stderr**');
    lines.push('```text');
    lines.push(r.stderr);
    lines.push('```');
  }

  if (r.truncated.stdout_bytes || r.truncated.stderr_bytes) {
    const parts = [];
    if (r.truncated.stdout_bytes) parts.push(`stdout ${formatBytes(r.truncated.stdout_bytes)}`);
    if (r.truncated.stderr_bytes) parts.push(`stderr ${formatBytes(r.truncated.stderr_bytes)}`);
    lines.push('');
    lines.push(`> elided: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build the MCP `content` array from an ExecResult.
 * format: "markdown" (default, human-friendly) | "json" (raw wire schema) | "both".
 */
export function makeMcpContent(result, { format = 'markdown' } = {}) {
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
