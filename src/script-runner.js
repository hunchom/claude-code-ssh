/**
 * ssh_run action:script engine. Joins a commands array into ONE remote exec
 * with exit-capturing sentinels, so a cmd1;cmd2;cmd3 chain runs in a single
 * round-trip with shared shell state. parseScriptSegments splits it back.
 *
 * Sentinels carry a per-invocation nonce so a command's own stdout cannot
 * forge a fake `##SEG ...##` line and corrupt the per-segment parse.
 *
 * Pure: buildScriptCommand returns { command, nonce }, parseScriptSegments
 * turns raw stdout + that nonce into per-segment results. Dispatcher execs.
 */

import crypto from 'crypto';
import { shQuote } from './stream-exec.js';

/** Per-invocation nonce: 6 random bytes -> 12 hex chars. Unforgeable marker. */
function newNonce() {
  return crypto.randomBytes(6).toString('hex');
}

/** Build the sentinel regex for one nonce. Group 1 = index, group 2 = $?. */
function segRe(nonce, flags) {
  return new RegExp(`\\n##SEG-${nonce} (\\d+) (\\d+)##\\n`, flags);
}

/**
 * Build the single-exec script string.
 * Each segment is followed by `printf '\n##SEG-<nonce> %d %d##\n' <idx> $?`
 * so $? is captured BEFORE the next segment runs. Segments are `;`-separated,
 * not `&&`-chained: a non-zero segment never aborts the rest.
 *
 * Returns { command, nonce }. Caller threads `nonce` into parseScriptSegments
 * so only this invocation's sentinels are trusted.
 *
 * isolate:true wraps each segment in its own `sh -c` -- separate shells, no
 * shared cd/env -- for the rare caller that needs state isolation.
 */
export function buildScriptCommand(commands, { isolate = false } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('ssh_run script: at least one command is required');
  }
  const nonce = newNonce();
  const parts = [];
  commands.forEach((c, i) => {
    if (typeof c !== 'string') {
      throw new Error(`ssh_run script: command ${i} must be a string`);
    }
    // isolate => run the segment in a child shell; $? is the child's exit.
    // non-isolate: brace group with the cmd on its own line so a trailing
    // `# comment` cannot eat the close. `}` after a newline is valid; a `;`
    // there is NOT (`bash: syntax error near ';'`), so no `;` before `}`.
    const body = isolate
      ? `sh -c ${shQuote(c)}`
      : `{ ${c}\n}`;
    parts.push(`${body}; printf '\\n##SEG-${nonce} %d %d##\\n' ${i} $?`);
  });
  return { command: parts.join('\n'), nonce };
}

/**
 * Split raw script stdout into per-segment results using nonce-bound
 * sentinels. Returns [{ index, command, stdout, exitCode }]. `nonce` is the
 * value buildScriptCommand returned -- only `##SEG-<nonce> ...##` lines are
 * trusted, so a command echoing a fake `##SEG ...##` line cannot corrupt the
 * parse. `commands` labels each segment; a segment with no sentinel (script
 * killed mid-run) gets exitCode null.
 */
export function parseScriptSegments(stdout, nonce, commands = []) {
  if (typeof nonce !== 'string' || nonce === '') {
    throw new Error('parseScriptSegments: nonce is required');
  }
  const s = stdout == null ? '' : String(stdout);
  const re = segRe(nonce, 'g');
  const segments = [];
  let lastIndex = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    const idx = Number(m[1]);
    segments.push({
      index: idx,
      command: commands[idx] != null ? commands[idx] : null,
      stdout: s.slice(lastIndex, m.index),
      exitCode: Number(m[2]),
    });
    lastIndex = m.index + m[0].length;
  }
  // Trailing output after the last sentinel = an unfinished segment.
  const tail = s.slice(lastIndex);
  if (tail.trim() !== '') {
    const idx = segments.length;
    segments.push({
      index: idx,
      command: commands[idx] != null ? commands[idx] : null,
      stdout: tail,
      exitCode: null,
    });
  }
  return segments;
}
