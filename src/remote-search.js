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

/**
 * Build a bounded `find -name` command. Pseudo-filesystems are pruned with
 * `-path X -prune -o`; -xdev keeps it on one filesystem unless crossMounts.
 */
export function buildLocateCommand({
  name,
  path,
  matchCap = SEARCH_DEFAULTS.matchCap,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
  crossMounts = SEARCH_DEFAULTS.crossMounts,
  prune = SEARCH_DEFAULTS.prune,
  allowRoot = false,
} = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('ssh_find: name is required for action locate');
  }
  const root = assertSearchPath(path, { allowRoot });
  const xdev = crossMounts ? '' : ' -xdev';
  // -path '/proc' -prune -o ... -path '/run' -prune -o <match> -print
  const pruneExpr = prune
    .map((p) => `-path ${shQuote(p)} -prune -o`)
    .join(' ');
  const find = `find ${shQuote(root)}${xdev} ${pruneExpr} `
    + `-name ${shQuote(name)} -print`;
  return `timeout ${timeoutSecs | 0} ${find} | head -n ${matchCap | 0}`;
}

/**
 * Build a bounded `ls -la` of one directory. Listing "/" is cheap, so the
 * bare-root guard does not apply here; only an empty path is rejected.
 */
export function buildLsCommand({
  path,
  timeoutSecs = SEARCH_DEFAULTS.timeoutSecs,
} = {}) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) throw new Error('ssh_find: path is required for action ls');
  const root = /^\/+$/.test(p) ? '/' : p.replace(/\/+$/, '') || '/';
  return `timeout ${timeoutSecs | 0} ls -la ${shQuote(root)}`;
}

/**
 * Parse grep/rg `file:line:text` output to {file, line, text} objects.
 * Splits on the first two colons only -- a colon in the match text survives.
 * grep context separators (`--`) and blank lines are dropped.
 */
export function parseGrepHits(text) {
  const s = text == null ? '' : String(text);
  const hits = [];
  for (const raw of s.split('\n')) {
    const ln = raw;
    if (ln === '' || ln === '--') continue;
    const c1 = ln.indexOf(':');
    if (c1 === -1) continue;
    const c2 = ln.indexOf(':', c1 + 1);
    if (c2 === -1) continue;
    const lineNo = Number(ln.slice(c1 + 1, c2));
    if (!Number.isFinite(lineNo)) continue;
    hits.push({
      file: ln.slice(0, c1),
      line: lineNo,
      text: ln.slice(c2 + 1),
    });
  }
  return hits;
}

/** Parse `find` output (one path per line) to a trimmed string array. */
export function parseLocateHits(text) {
  const s = text == null ? '' : String(text);
  return s.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

/** Map an `ls -l` permission char to a coarse type label. */
function lsType(perms) {
  const c = perms.charAt(0);
  if (c === 'd') return 'dir';
  if (c === 'l') return 'link';
  return 'file';
}

/**
 * Parse `ls -la` long-format output to {perms, size, name, type} rows.
 * The leading `total N` line is skipped; a `name -> target` symlink keeps
 * only the name. Filenames with spaces survive (name = everything from
 * field 9 onward).
 */
export function parseLsRows(text) {
  const s = text == null ? '' : String(text);
  const rows = [];
  for (const raw of s.split('\n')) {
    const ln = raw.trim();
    if (ln === '' || /^total \d+$/.test(ln)) continue;
    // perms links owner group size mon day time name...
    const m = ln.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    let name = m[3];
    const arrow = name.indexOf(' -> ');
    if (arrow !== -1) name = name.slice(0, arrow);
    rows.push({ perms: m[1], size: m[2], name, type: lsType(m[1]) });
  }
  return rows;
}
