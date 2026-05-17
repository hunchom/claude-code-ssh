/**
 * Shared test helper: recover the real inner command from a
 * `timeout -k <grace> <wall> sh -c '<shquoted command>'` wrapper.
 *
 * streamExecCommand wraps non-raw timed commands via wrapWithTimeout, which
 * runs the command through `sh -c` (timeout execvp's its arg -- no shell --
 * so cd/&&/pipes/env-prefixes/set-e must be handed to a real shell). Tool
 * test fakes route on command text; they must see the UNWRAPPED command,
 * not the wrapper. Strips the prefix, then shell-unquotes the single sh -c
 * argument (shQuote wraps in '...' and escapes embedded ' as '\'').
 */
export function unwrapTimeout(cmd) {
  const m = /^timeout -k \d+ \d+ sh -c (.+)$/s.exec(cmd);
  if (!m) return cmd;
  const arg = m[1];
  if (arg[0] !== '\'' || arg[arg.length - 1] !== '\'') return arg;
  return arg.slice(1, -1).replace(/'\\''/g, '\'');
}
