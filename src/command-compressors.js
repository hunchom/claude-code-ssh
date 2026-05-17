/**
 * Command-output compressors. Per-command-type shaping that runs after
 * ANSI stripping and before head+tail truncation. raw:true bypasses all of it.
 *
 * Each compressor is pure: (text) -> { text, dropped }. The dispatcher appends
 * a footer naming the raw escape hatch whenever a compressor dropped anything.
 */

/** Escape-hatch suffix appended to every compression footer. */
const RAW_HINT = ' -- re-run with raw: true for full output';

/** Escape-hatch footer appended when output was compressed. */
function footer(dropped) {
  return `\n... ${dropped} line${dropped === 1 ? '' : 's'} compressed` + RAW_HINT;
}

/**
 * Drop a leading `total N` summary line (the `ls -l` block-count header).
 * Sets `note` so the footer says "total-line dropped" -- the dropped line is
 * always that header, never N rows of content, so a line count would mislead.
 */
export function compressLs(text) {
  const s = String(text == null ? '' : text);
  const nl = s.indexOf('\n');
  const first = (nl === -1 ? s : s.slice(0, nl)).trim();
  if (/^total \d+$/.test(first)) {
    return {
      text: nl === -1 ? '' : s.slice(nl + 1),
      dropped: 1,
      note: '\n... ls total-line dropped' + RAW_HINT,
    };
  }
  return { text: s, dropped: 0 };
}

/** Rows to keep from a ps listing (header is kept on top of these). */
const PS_KEEP = 15;

/**
 * Keep the ps header line plus the top PS_KEEP rows; drop the tail.
 * Visible order assumed significance-ordered; tail dropped regardless.
 * Trailing newline (ps always emits one) is preserved, not counted as a row.
 */
export function compressPs(text) {
  const s = String(text == null ? '' : text);
  const hadTrailingNl = s.endsWith('\n');
  const lines = s.split('\n');
  if (hadTrailingNl) lines.pop();
  if (lines.length <= PS_KEEP + 1) return { text: s, dropped: 0 };
  const kept = lines.slice(0, PS_KEEP + 1);
  return {
    text: kept.join('\n') + (hadTrailingNl ? '\n' : ''),
    dropped: lines.length - kept.length,
  };
}

// shared command-prefix: start, after pipe/`;`/`&`, or after `sudo `.
const PREFIX = '(^|[|;&]\\s*|^sudo\\s+)';

// command-prefix -> compressor. First match wins.
const COMPRESSORS = [
  { match: new RegExp(`${PREFIX}ls(\\s|$)`), fn: compressLs },
  { match: new RegExp(`${PREFIX}ps(\\s|$)`), fn: compressPs },
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
      if (out.dropped <= 0) return out.text;
      // A compressor may supply its own footer `note` when a line count
      // would mislead (e.g. ls drops a header, not N content rows).
      return out.text + (out.note || footer(out.dropped));
    }
  }
  return s;
}
