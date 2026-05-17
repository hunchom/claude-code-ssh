/**
 * Command-output compressors. Per-command-type shaping that runs after
 * ANSI stripping and before head+tail truncation. raw:true bypasses all of it.
 *
 * Each compressor is pure: (text) -> { text, dropped }. The dispatcher appends
 * a footer naming the raw escape hatch whenever a compressor dropped anything.
 */

/** Escape-hatch footer appended when output was compressed. */
function footer(dropped) {
  return `\n... ${dropped} line${dropped === 1 ? '' : 's'} compressed`
    + ' -- re-run with raw: true for full output';
}

/**
 * Drop a leading `total N` summary line (the `ls -l` block-count header).
 */
export function compressLs(text) {
  const s = String(text == null ? '' : text);
  const nl = s.indexOf('\n');
  const first = (nl === -1 ? s : s.slice(0, nl)).trim();
  if (/^total \d+$/.test(first)) {
    return { text: nl === -1 ? '' : s.slice(nl + 1), dropped: 1 };
  }
  return { text: s, dropped: 0 };
}

/** Rows to keep from a ps listing (header is kept on top of these). */
const PS_KEEP = 15;

/**
 * Keep the ps header line plus the top PS_KEEP rows; drop the idle tail.
 * Input is assumed CPU-sorted (the v4 process tools sort with --sort=-%cpu).
 */
export function compressPs(text) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  if (lines.length <= PS_KEEP + 1) return { text: s, dropped: 0 };
  const kept = lines.slice(0, PS_KEEP + 1);
  return { text: kept.join('\n'), dropped: lines.length - kept.length };
}

// command-prefix -> compressor. First match wins.
const COMPRESSORS = [
  { match: /^ls(\s|$)/, fn: compressLs },
  // ps may appear after `sudo ` or a pipe/`;`/`&`.
  { match: /(^|[|;&]\s*|^sudo\s+)ps(\s|$)/, fn: compressPs },
];

/**
 * Compress command output by command type. raw:true returns text unchanged.
 * Unmatched commands return unchanged. A footer is appended only when a
 * compressor actually dropped lines.
 */
export function compress(command, text, { raw = false } = {}) {
  const s = String(text == null ? '' : text);
  if (raw || s === '') return s;
  const cmd = String(command == null ? '' : command).trim();
  for (const { match, fn } of COMPRESSORS) {
    if (match.test(cmd)) {
      const out = fn(s);
      return out.dropped > 0 ? out.text + footer(out.dropped) : out.text;
    }
  }
  return s;
}
