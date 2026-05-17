/**
 * ssh_run action:script engine. Joins a commands array into ONE remote exec
 * with exit-capturing sentinels, so a cmd1;cmd2;cmd3 chain runs in a single
 * round-trip with shared shell state. parseScriptSegments splits it back.
 *
 * Pure: buildScriptCommand returns a POSIX-sh string, parseScriptSegments
 * turns raw stdout into per-segment results. The dispatcher (Plan 4) execs.
 */

/**
 * Matches one emitted sentinel: `\n##SEG <index> <exit-code>##\n`.
 * Group 1 = segment index, group 2 = that segment's $?.
 */
export const SEG_RE = /\n##SEG (\d+) (\d+)##\n/;

/** Global twin of SEG_RE for splitting a whole stdout blob. */
const SEG_RE_G = /\n##SEG (\d+) (\d+)##\n/g;

/**
 * Build the single-exec script string.
 * Each segment is followed by `printf '\n##SEG %d %d##\n' <idx> $?` so $?
 * is captured BEFORE the next segment runs. Segments are `;`-separated, not
 * `&&`-chained: a non-zero segment never aborts the rest.
 *
 * isolate:true wraps each segment in its own `sh -c` -- separate shells, no
 * shared cd/env -- for the rare caller that needs state isolation.
 */
export function buildScriptCommand(commands, { isolate = false } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('ssh_run script: at least one command is required');
  }
  const parts = [];
  commands.forEach((c, i) => {
    if (typeof c !== 'string') {
      throw new Error(`ssh_run script: command ${i} must be a string`);
    }
    // isolate => run the segment in a child shell; $? is the child's exit.
    const body = isolate
      ? `sh -c ${shQuoteLocal(c)}`
      : `{ ${c}\n; }`;
    parts.push(`${body}; printf '\\n##SEG %d %d##\\n' ${i} $?`);
  });
  return parts.join('\n');
}

/**
 * Split raw script stdout into per-segment results using the sentinels.
 * Returns [{ index, command, stdout, exitCode }]. `commands` is the original
 * array, used to label each segment; a segment with no sentinel (the script
 * was killed mid-run) gets exitCode null.
 */
export function parseScriptSegments(stdout, commands = []) {
  const s = stdout == null ? '' : String(stdout);
  const segments = [];
  let lastIndex = 0;
  let m;
  SEG_RE_G.lastIndex = 0;
  while ((m = SEG_RE_G.exec(s)) !== null) {
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

/**
 * Local POSIX shell-quoter. A copy of stream-exec.js's shQuote kept here so
 * script-runner has no cross-module coupling for one tiny helper.
 */
function shQuoteLocal(str) {
  return `'${String(str).replace(/'/g, '\'\\\'\'')}'`;
}
