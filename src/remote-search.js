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
