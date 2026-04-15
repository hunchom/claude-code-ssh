/**
 * SELECT-only SQL safety validator.
 *
 * Strategy (token-level, not substring-level):
 *   1. Strip all SQL comments: line `-- ...` and block `/ *  ... * /` (nested-aware).
 *   2. Strip all string literals: '...' (with '' escape), "..." (with "" escape), `...`
 *      (MySQL backtick identifier -- also stripped so backtick-wrapped reserved names
 *      don't trip the check). Also strips E'...' / $$...$$ / $tag$...$tag$ (Postgres).
 *   3. Tokenize the residue on whitespace and SQL punctuation.
 *   4. First token (case-insensitive) must be one of: SELECT, WITH, EXPLAIN, VALUES, TABLE, SHOW, DESC, DESCRIBE.
 *      (SHOW/DESC/DESCRIBE are metadata-only and read-only.)
 *   5. No token may be a dangerous keyword:
 *      INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE,
 *      EXEC, EXECUTE, REPLACE, MERGE, CALL, INTO, HANDLER, LOAD, COPY, RENAME,
 *      ATTACH, DETACH, PRAGMA, VACUUM, REINDEX, LOCK, UNLOCK, SET, USE, DO,
 *      DECLARE, PREPARE, DEALLOCATE.
 *   6. Multi-statement check: after strip, no semicolon may be followed by
 *      another non-whitespace character (allowing a single trailing `;`).
 *
 * Trade-offs (documented):
 *   - `REPLACE` is blocked both as a statement (MySQL REPLACE INTO) and a
 *     function (string REPLACE). A query like `SELECT REPLACE(name, 'a', 'b')`
 *     is therefore rejected. This is a conscious false-positive: the statement
 *     form is dangerous and the function form is cheap to rewrite. Documented
 *     here so future contributors don't "fix" it.
 *   - Backtick-quoted identifiers (MySQL) like `` `delete` `` as a column name
 *     are stripped (backticks are tokenized as string-like), so they no longer
 *     false-positive.
 *   - `INTO` blocks both `SELECT ... INTO OUTFILE` (MySQL file write) and
 *     `SELECT ... INTO new_table` (Postgres table create). Both are writes.
 */

const DANGEROUS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'REPLACE', 'MERGE', 'CALL',
  'INTO', 'HANDLER', 'LOAD', 'COPY', 'RENAME',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX',
  'LOCK', 'UNLOCK', 'SET', 'USE', 'DO',
  'DECLARE', 'PREPARE', 'DEALLOCATE',
]);

const ALLOWED_FIRST = new Set([
  'SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'TABLE', 'SHOW', 'DESC', 'DESCRIBE',
]);

/**
 * Strip SQL comments (line and block, block nesting is tolerated).
 */
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // Line comment
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      // Preserve newline boundary so token splitter still sees separation
      if (i < n) { out += ' '; i++; }
      continue;
    }
    // Block comment, nesting-aware
    if (c === '/' && c2 === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strip string literals and backtick identifiers. Replaces each with a single
 * space so nothing inside them can ever become a token.
 *
 * Handles:
 *   '...'     (SQL single-quote; '' escape inside)
 *   "..."     (SQL double-quote; "" escape inside -- also Postgres identifier quote)
 *   `...`     (MySQL backtick identifier; `` escape inside)
 *   E'...'    (Postgres escape string; \' escape inside)
 *   $$...$$     (Postgres dollar-quoted, optionally tagged $tag$...$tag$)
 */
function stripStrings(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];

    // Postgres E'...' escape string
    if ((c === 'E' || c === 'e') && sql[i + 1] === '\'') {
      i += 2;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (sql[i] === '\'') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    // Postgres dollar-quoted string ($tag$...$tag$ or $$...$$)
    if (c === '$') {
      // Extract tag: $tag$ where tag is [a-zA-Z_][a-zA-Z0-9_]*  (possibly empty)
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.slice(i, j + 1); // includes both $
        const closeIdx = sql.indexOf(tag, j + 1);
        if (closeIdx !== -1) {
          i = closeIdx + tag.length;
          out += ' ';
          continue;
        }
      }
      out += c;
      i++;
      continue;
    }

    if (c === '\'') {
      i++;
      while (i < n) {
        // SQL standard: '' is an escaped single quote inside a string
        if (sql[i] === '\'' && sql[i + 1] === '\'') { i += 2; continue; }
        // Also tolerate backslash-quote (MySQL default, Postgres with standard_conforming_strings=off)
        if (sql[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (sql[i] === '\'') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`' && sql[i + 1] === '`') { i += 2; continue; }
        if (sql[i] === '`') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Tokenize on whitespace + SQL punctuation. Returns uppercased tokens so callers
 * can do case-insensitive set membership checks.
 *
 * Punctuation treated as delimiters: , ; ( ) [ ] { } = < > + - * / % ! | & ^ ~
 * Dots inside qualified names (schema.table.col) are kept attached; we split on
 * whitespace/punct instead. Underscore is word-char so `deleted_at`,
 * `update_count`, `drop_box` stay as one token.
 */
function tokenize(stripped) {
  // Replace all delimiters with a single space, then split.
  const normalized = stripped.replace(/[\s,;()[\]{}=<>+\-*/%!|&^~]+/g, ' ');
  const raw = normalized.split(' ').filter(Boolean);
  return raw.map(t => t.toUpperCase());
}

/**
 * Check the stripped SQL for stacked statements. Returns true if a semicolon
 * is followed by any non-whitespace character (i.e. a second statement).
 */
function hasStackedStatements(stripped) {
  const n = stripped.length;
  for (let i = 0; i < n; i++) {
    if (stripped[i] !== ';') continue;
    // scan forward past whitespace
    for (let j = i + 1; j < n; j++) {
      const c = stripped[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return true;
    }
  }
  return false;
}

/**
 * Validate a SQL string for SELECT-only execution.
 *
 * @param {string} sql
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function isSafeSelect(sql) {
  if (sql == null) return { ok: false, reason: 'query is null or undefined' };
  if (typeof sql !== 'string') return { ok: false, reason: 'query must be a string' };
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, reason: 'query is empty' };

  // 1. Strip comments.
  const noComments = stripComments(trimmed);
  // 2. Strip string literals and identifier quotes.
  const noStrings = stripStrings(noComments);
  // 3. Check for stacked statements before tokenizing.
  if (hasStackedStatements(noStrings)) {
    return { ok: false, reason: 'multi-statement queries are not allowed (found `;` followed by more SQL)' };
  }
  // 4. Tokenize.
  const tokens = tokenize(noStrings);
  if (tokens.length === 0) {
    return { ok: false, reason: 'query contains no SQL tokens after stripping comments and strings' };
  }
  // 5. First token check.
  const first = tokens[0];
  if (!ALLOWED_FIRST.has(first)) {
    return { ok: false, reason: `query must start with one of ${[...ALLOWED_FIRST].join(', ')} (got \`${first}\`)` };
  }
  // 6. Dangerous-keyword scan.
  for (const tok of tokens) {
    if (DANGEROUS.has(tok)) {
      return { ok: false, reason: `disallowed keyword \`${tok}\` found in query` };
    }
  }
  return { ok: true };
}

// Exported for unit testing the pipeline stages independently.
export const __internals = { stripComments, stripStrings, tokenize, hasStackedStatements };
