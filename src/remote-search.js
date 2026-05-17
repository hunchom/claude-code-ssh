/**
 * Remote-search engine for the v4 ssh_find tool. Pure: builders return a
 * POSIX-sh command string, parsers turn raw stdout into structured hits.
 *
 * Every emitted command is server-side bounded: timeout wrapper, pruned
 * pseudo-filesystems, -xdev unless opted out, match cap via head (SIGPIPE
 * stops the walk early). A bare "/" root is refused without an override.
 */

import { shQuote } from './stream-exec.js';

/** Bounded defaults baked into every ssh_find command. */
export const SEARCH_DEFAULTS = {
  matchCap: 200,                                // hits before head closes the pipe
  timeoutSecs: 20,                              // hard `timeout` wall
  contextLines: 0,                              // grep -C value
  crossMounts: false,                           // false => -xdev
  prune: ['/proc', '/sys', '/dev', '/run'],     // never descended
};

/**
 * Validate + normalize a search root. Empty path rejected; bare "/" refused
 * unless allowRoot. Returns the trimmed path.
 */
export function assertSearchPath(path, { allowRoot = false } = {}) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) throw new Error('ssh_find: path is required');
  // Collapse a string of only slashes to one "/".
  const normalized = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '');
  if (normalized === '/' && !allowRoot) {
    throw new Error(
      'ssh_find: refusing to search "/" -- pass a narrower path '
      + 'or set allow_root: true',
    );
  }
  return normalized || '/';
}

/** Build the prune/exclude flags shared by the rg and grep branches. */
function excludeFlags(prune, crossMounts) {
  // strip leading slash: grep/rg --exclude-dir matches a basename
  const dirs = [...prune.map((p) => p.replace(/^\//, '')), '.git'];
  const flags = dirs.map((d) => `--exclude-dir=${d}`);
  if (!crossMounts) flags.push('--one-file-system');
  return flags.join(' ');
}

/**
 * Build a bounded recursive-grep command. Prefers rg, falls back to grep.
 * Emitted shape: timeout <s> sh -c 'if rg; then rg ...; else grep ...; fi | head'
 */
export function buildGrepCommand({
  pattern,
  path,
  matchCap = SEARCH_DEFAULTS.matchCap,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
  contextLines = SEARCH_DEFAULTS.contextLines,
  crossMounts = SEARCH_DEFAULTS.crossMounts,
  prune = SEARCH_DEFAULTS.prune,
  allowRoot = false,
} = {}) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('ssh_find: pattern is required for action grep');
  }
  const root = assertSearchPath(path, { allowRoot });
  const ex = excludeFlags(prune, crossMounts);
  const ctx = contextLines > 0 ? ` -C ${contextLines | 0}` : '';
  const qp = shQuote(pattern);
  const qroot = shQuote(root);

  // rg: --line-number for file:line:text, -n; --no-heading keeps it grep-shaped.
  const rg = `rg --line-number --no-heading --color never${ctx} ${ex} -e ${qp} ${qroot}`;
  // grep: -r recursive, -n line numbers, -I skip binaries.
  const grep = `grep -rnI${ctx} ${ex} -e ${qp} ${qroot}`;

  const inner = `if command -v rg >/dev/null 2>&1; then ${rg}; `
    + `else ${grep}; fi | head -n ${matchCap | 0}`;
  return `timeout ${timeoutSecs | 0} sh -c ${shQuote(inner)}`;
}
