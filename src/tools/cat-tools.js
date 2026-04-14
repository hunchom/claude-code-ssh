/**
 * ssh_cat — partial remote read without downloading the whole file.
 *
 * Modes (evaluated in this order, first match wins):
 *   1. line_start + line_end → `sed -n 'S,Ep'`
 *   2. head (N lines)        → `head -n N`
 *   3. tail (N lines)        → `tail -n N`
 *   4. offset + limit (bytes)→ `dd bs=1 skip=OFF count=LIM`
 *   5. grep                  → `grep -E PATTERN`
 *   6. default               → `cat`  (still capped by maxLen via formatter)
 *
 * All numeric args coerce through Number() — injection-safe. File + grep
 * pattern are shell-quoted.
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { formatExecResult, makeMcpContent } from '../output-formatter.js';
import { fail, toMcp } from '../structured-result.js';

/**
 * Build the remote command for the requested partial-read mode.
 * Exported for unit-testing without hitting SSH.
 */
export function buildCatCommand({ file, offset, limit, head, tail, grep, line_start, line_end }) {
  const f = shQuote(String(file));
  const grepSuffix = grep ? ` | grep -E ${shQuote(String(grep))}` : '';

  if (line_start != null && line_end != null) {
    const s = Math.max(1, Math.floor(Number(line_start)) || 1);
    const e = Math.max(s, Math.floor(Number(line_end)) || s);
    return `sed -n '${s},${e}p' ${f}${grepSuffix}`;
  }
  if (head != null) {
    const n = Math.max(1, Math.floor(Number(head)) || 10);
    return `head -n ${n} ${f}${grepSuffix}`;
  }
  if (tail != null) {
    const n = Math.max(1, Math.floor(Number(tail)) || 10);
    return `tail -n ${n} ${f}${grepSuffix}`;
  }
  if (offset != null || limit != null) {
    const off = Math.max(0, Math.floor(Number(offset)) || 0);
    const lim = Math.max(1, Math.floor(Number(limit)) || 10_000);
    // 2>/dev/null suppresses dd's status summary on stderr
    return `dd if=${f} bs=1 skip=${off} count=${lim} 2>/dev/null${grepSuffix}`;
  }
  if (grep) {
    return `grep -E ${shQuote(String(grep))} ${f}`;
  }
  return `cat ${f}`;
}

/**
 * Tool handler for ssh_cat.
 */
export async function handleSshCat({ getConnection, args }) {
  const {
    server, file,
    offset, limit, head, tail, grep, line_start, line_end,
    timeout = 15_000,
    maxLen = 10_000,
    format = 'markdown',
  } = args;

  if (!file) {
    return toMcp(fail('ssh_cat', 'file is required'), { format });
  }

  const command = buildCatCommand({ file, offset, limit, head, tail, grep, line_start, line_end });

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return makeCatErrorResponse(server, command, e, format, Date.now() - startedAt);
  }

  let result, error;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: timeout });
  } catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return makeCatErrorResponse(server, command, error, format, durationMs);
  }

  const exec = formatExecResult({
    server, command,
    stdout: result.stdout, stderr: result.stderr,
    code: result.code, durationMs,
    maxLen,
  });
  return { content: makeMcpContent(exec, { format }) };
}

function makeCatErrorResponse(server, command, error, format, durationMs) {
  const exec = formatExecResult({
    server, command, stdout: '',
    stderr: String(error.message || error),
    code: -1, durationMs, maxLen: 10_000,
  });
  return { content: makeMcpContent(exec, { format }), isError: true };
}
