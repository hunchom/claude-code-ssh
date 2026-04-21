/**
 * Operator-tunable runtime limits.
 *
 * Exposed as env vars so a user can trim Claude Code's context load or turn
 * up detail temporarily without editing code:
 *
 *   MCP_SSH_MAX_OUTPUT_LENGTH   default 10_000  -- stdout/stderr truncation cap
 *   MCP_SSH_MAX_TAIL_LINES      default    500  -- ssh_tail_read ring buffer cap
 *   MCP_SSH_MAX_RSYNC_OUTPUT    default  5_000  -- rsync stderr truncation cap
 *   MCP_SSH_COMPACT_JSON        default false   -- if true, emit minified JSON
 *   MCP_SSH_DEBUG               default false   -- if true, logger.debug fires
 *
 * Values are read at import-time. To change at runtime, restart the server.
 */

function intFromEnv(name, defaultValue, { min = 1, max = 10_000_000 } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return defaultValue;
  return n;
}

function boolFromEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export const OUTPUT_LIMITS = Object.freeze({
  MAX_OUTPUT_LENGTH: intFromEnv('MCP_SSH_MAX_OUTPUT_LENGTH', 10_000, { min: 100, max: 10_000_000 }),
  MAX_TAIL_LINES:    intFromEnv('MCP_SSH_MAX_TAIL_LINES',       500, { min: 1,   max: 1_000_000 }),
  MAX_RSYNC_OUTPUT:  intFromEnv('MCP_SSH_MAX_RSYNC_OUTPUT',    5_000, { min: 100, max: 10_000_000 }),
});

export const RESPONSE_FORMAT = Object.freeze({
  COMPACT_JSON: boolFromEnv('MCP_SSH_COMPACT_JSON', false),
  DEBUG:        boolFromEnv('MCP_SSH_DEBUG',        false),
});

/**
 * Convenience truncation used by tool handlers that don't already flow through
 * output-formatter.truncateHeadTail. Keeps head + tail, elides middle. Returns
 * the input unchanged when under the cap.
 */
export function truncateOutput(text, maxLength = OUTPUT_LIMITS.MAX_OUTPUT_LENGTH) {
  if (!text) return '';
  const s = String(text);
  if (s.length <= maxLength) return s;
  const keep = Math.max(1, Math.floor(maxLength / 2));
  const head = s.slice(0, keep);
  const tail = s.slice(-keep);
  const elided = s.length - head.length - tail.length;
  return `${head}\n\n... [${elided} characters elided] ...\n\n${tail}`;
}
