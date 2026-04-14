#!/usr/bin/env node
/**
 * Tests for src/tools/sql-safety.js -- the replacement for the buggy
 * `isSafeQuery` in database-manager.js.
 *
 * Goals (per the task spec):
 *   - No false positives on common column names: deleted_at, update_count, drop_box.
 *   - CTEs allowed: WITH cte AS (SELECT ...) SELECT ...
 *   - EXPLAIN SELECT allowed.
 *   - SELECT ... INTO OUTFILE blocked (MySQL file write).
 *   - Stacked queries blocked: `SELECT 1; DROP TABLE x`.
 *   - Comment-hidden mutations blocked: `/* safe *\/ DROP TABLE x` --
 *     after strip the first token is DROP.
 *   - Multi-line SELECTs, case variations, empty string, nullish input.
 */

import assert from 'assert';
import { isSafeSelect, __internals } from '../src/tools/sql-safety.js';

let passed = 0, failed = 0; const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

console.log('[test] Testing sql-safety\n');

// --------------------------------------------------------------------------
// False-positives the old impl had -- MUST now pass
// --------------------------------------------------------------------------
test('accepts column named `deleted_at` (old impl falsely rejected)', () => {
  const r = isSafeSelect('SELECT deleted_at FROM audit_log');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('accepts column named `update_count`', () => {
  const r = isSafeSelect('SELECT id, update_count FROM counters');
  assert.strictEqual(r.ok, true);
});

test('accepts column named `drop_box`', () => {
  const r = isSafeSelect('SELECT drop_box FROM inventory');
  assert.strictEqual(r.ok, true);
});

test('accepts multiple soft-danger-fragment columns in one query', () => {
  const r = isSafeSelect(
    'SELECT deleted_at, created_at, updated_count, drop_zone_id FROM events WHERE deleted_at IS NULL'
  );
  assert.strictEqual(r.ok, true);
});

test('accepts table name `user_creates`', () => {
  const r = isSafeSelect('SELECT * FROM user_creates');
  assert.strictEqual(r.ok, true);
});

// --------------------------------------------------------------------------
// Valid query forms
// --------------------------------------------------------------------------
test('accepts plain SELECT', () => {
  assert.deepStrictEqual(isSafeSelect('SELECT 1'), { ok: true });
});

test('accepts lower-case select', () => {
  assert.deepStrictEqual(isSafeSelect('select 1'), { ok: true });
});

test('accepts mixed-case SeLeCt', () => {
  assert.deepStrictEqual(isSafeSelect('SeLeCt id FROM t'), { ok: true });
});

test('accepts multi-line SELECT', () => {
  const r = isSafeSelect(`
    SELECT
      id,
      name
    FROM users
    WHERE active = 1
  `);
  assert.strictEqual(r.ok, true);
});

test('accepts CTE with WITH', () => {
  const r = isSafeSelect(`
    WITH active_users AS (SELECT id FROM users WHERE active = 1)
    SELECT * FROM active_users
  `);
  assert.strictEqual(r.ok, true);
});

test('accepts recursive CTE', () => {
  const r = isSafeSelect(`
    WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n < 10)
    SELECT * FROM nums
  `);
  assert.strictEqual(r.ok, true);
});

test('accepts EXPLAIN SELECT', () => {
  const r = isSafeSelect('EXPLAIN SELECT * FROM users');
  assert.strictEqual(r.ok, true);
});

test('accepts EXPLAIN ANALYZE SELECT', () => {
  const r = isSafeSelect('EXPLAIN ANALYZE SELECT * FROM users');
  assert.strictEqual(r.ok, true);
});

test('accepts SHOW TABLES (metadata-only)', () => {
  const r = isSafeSelect('SHOW TABLES');
  assert.strictEqual(r.ok, true);
});

test('accepts trailing semicolon (single statement)', () => {
  const r = isSafeSelect('SELECT 1;');
  assert.strictEqual(r.ok, true);
});

test('accepts trailing semicolon with whitespace', () => {
  const r = isSafeSelect('SELECT 1;  \n  \t  ');
  assert.strictEqual(r.ok, true);
});

test('accepts SELECT with line comment after', () => {
  const r = isSafeSelect('SELECT id FROM t -- get all ids');
  assert.strictEqual(r.ok, true);
});

test('accepts SELECT with block comment inside', () => {
  const r = isSafeSelect('SELECT /* TODO optimize */ id FROM t');
  assert.strictEqual(r.ok, true);
});

test('accepts string literal that contains dangerous keywords', () => {
  // The string `'DROP TABLE users'` is data, not code -- must not false-positive.
  const r = isSafeSelect("SELECT 'DROP TABLE users' AS msg");
  assert.strictEqual(r.ok, true);
});

test('accepts backtick-quoted column named `delete`', () => {
  // In MySQL `delete` is a column name, not the statement.
  const r = isSafeSelect('SELECT `delete`, `update`, `drop` FROM reserved_col_table');
  assert.strictEqual(r.ok, true);
});

test('accepts double-quoted identifier `"delete"` (Postgres)', () => {
  const r = isSafeSelect('SELECT "delete" FROM t');
  assert.strictEqual(r.ok, true);
});

// --------------------------------------------------------------------------
// Rejections -- dangerous queries
// --------------------------------------------------------------------------
test('rejects INSERT', () => {
  const r = isSafeSelect('INSERT INTO t VALUES (1)');
  assert.strictEqual(r.ok, false);
  assert(r.reason && r.reason.length > 0);
});

test('rejects UPDATE', () => {
  const r = isSafeSelect('UPDATE t SET x = 1');
  assert.strictEqual(r.ok, false);
});

test('rejects DELETE', () => {
  const r = isSafeSelect('DELETE FROM t WHERE id = 1');
  assert.strictEqual(r.ok, false);
});

test('rejects DROP TABLE', () => {
  const r = isSafeSelect('DROP TABLE users');
  assert.strictEqual(r.ok, false);
});

test('rejects TRUNCATE', () => {
  const r = isSafeSelect('TRUNCATE TABLE users');
  assert.strictEqual(r.ok, false);
});

test('rejects stacked queries `SELECT 1; DROP TABLE x;`', () => {
  const r = isSafeSelect('SELECT 1; DROP TABLE x;');
  assert.strictEqual(r.ok, false);
  assert(r.reason && r.reason.toLowerCase().includes('multi-statement'));
});

test('rejects stacked queries masked by block comment', () => {
  // Block comment between, but still two statements
  const r = isSafeSelect('SELECT 1;/*sep*/DROP TABLE x');
  assert.strictEqual(r.ok, false);
});

test('rejects comment-hidden DROP -- the comment is stripped, DROP is first token', () => {
  // After strip: "  DROP TABLE x" -> first token DROP -> reject.
  const r = isSafeSelect('/* safe */ DROP TABLE x');
  assert.strictEqual(r.ok, false);
  // Should specifically fail at the first-token check.
  assert(r.reason.includes('must start with') || r.reason.includes('DROP'));
});

test('rejects SELECT ... INTO OUTFILE (MySQL file write)', () => {
  const r = isSafeSelect("SELECT * INTO OUTFILE '/tmp/pwn' FROM users");
  assert.strictEqual(r.ok, false);
  assert(r.reason.toUpperCase().includes('INTO'));
});

test('rejects SELECT ... INTO new_table (Postgres table create)', () => {
  const r = isSafeSelect('SELECT id INTO new_table FROM users');
  assert.strictEqual(r.ok, false);
});

test('rejects GRANT', () => {
  const r = isSafeSelect('GRANT ALL ON t TO u');
  assert.strictEqual(r.ok, false);
});

test('rejects line-comment hidden mutation `--\\nDROP TABLE x`', () => {
  // This has a newline separating the comment from DROP, so after strip the
  // first token is DROP.
  const r = isSafeSelect('-- comment\nDROP TABLE users');
  assert.strictEqual(r.ok, false);
});

test('rejects CTE that hides an UPDATE', () => {
  const r = isSafeSelect(`
    WITH x AS (SELECT 1)
    UPDATE t SET v = 1
  `);
  assert.strictEqual(r.ok, false);
});

test('rejects CALL stored_procedure()', () => {
  const r = isSafeSelect('CALL do_bad_things()');
  assert.strictEqual(r.ok, false);
});

test('rejects LOAD DATA INFILE', () => {
  const r = isSafeSelect("LOAD DATA INFILE '/etc/passwd' INTO TABLE t");
  assert.strictEqual(r.ok, false);
});

test('rejects COPY (Postgres server-side file access)', () => {
  const r = isSafeSelect("COPY t FROM '/etc/passwd'");
  assert.strictEqual(r.ok, false);
});

test('rejects ALTER', () => {
  const r = isSafeSelect('ALTER TABLE t ADD COLUMN x INT');
  assert.strictEqual(r.ok, false);
});

test('rejects REPLACE INTO (MySQL upsert)', () => {
  const r = isSafeSelect('REPLACE INTO t VALUES (1)');
  assert.strictEqual(r.ok, false);
});

test('rejects SET (could change session state)', () => {
  const r = isSafeSelect('SET sql_mode = \'\'');
  assert.strictEqual(r.ok, false);
});

test('rejects USE database', () => {
  const r = isSafeSelect('USE other_db');
  assert.strictEqual(r.ok, false);
});

test('rejects PRAGMA (SQLite escape hatch)', () => {
  const r = isSafeSelect('PRAGMA foreign_keys = OFF');
  assert.strictEqual(r.ok, false);
});

// --------------------------------------------------------------------------
// Nullish / empty
// --------------------------------------------------------------------------
test('rejects null input with reason', () => {
  const r = isSafeSelect(null);
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('null') || r.reason.includes('undefined'));
});

test('rejects undefined input with reason', () => {
  const r = isSafeSelect(undefined);
  assert.strictEqual(r.ok, false);
});

test('rejects empty string', () => {
  const r = isSafeSelect('');
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('empty'));
});

test('rejects whitespace-only input', () => {
  const r = isSafeSelect('   \n\t  ');
  assert.strictEqual(r.ok, false);
});

test('rejects non-string input (number)', () => {
  const r = isSafeSelect(42);
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('string'));
});

test('rejects all-comments input (no actual SQL)', () => {
  const r = isSafeSelect('/* nothing */ -- also nothing');
  assert.strictEqual(r.ok, false);
});

// --------------------------------------------------------------------------
// Pipeline internals -- spot-check intermediate stages
// --------------------------------------------------------------------------
test('internal: stripComments removes line and block comments', () => {
  const out = __internals.stripComments('SELECT /* c */ 1 -- trailing\nFROM t');
  assert(!out.includes('/*'));
  assert(!out.includes('--'));
  assert(out.includes('SELECT'));
  assert(out.includes('FROM t'));
});

test('internal: stripComments handles nested block comments', () => {
  const out = __internals.stripComments('SELECT /* outer /* inner */ still-in-outer */ 1');
  // Nested: both levels should be stripped -- the "still-in-outer" text is inside.
  assert(!out.includes('still-in-outer'));
  assert(out.includes('SELECT'));
  assert(out.includes('1'));
});

test('internal: stripStrings removes single-quoted and preserves everything else', () => {
  const out = __internals.stripStrings("SELECT 'DROP' FROM t");
  assert(!out.includes('DROP'), 'DROP was inside a string, should be gone');
  assert(out.includes('SELECT'));
  assert(out.includes('FROM t'));
});

test('internal: stripStrings handles `` inside backticks', () => {
  const out = __internals.stripStrings("SELECT `a``b` FROM t");
  assert(!out.includes('a'));
  assert(out.includes('SELECT'));
  assert(out.includes('FROM t'));
});

test('internal: stripStrings handles `` inside single quotes', () => {
  const out = __internals.stripStrings("SELECT 'it''s' FROM t");
  assert(!out.includes("it"));
  assert(out.includes('SELECT'));
});

test('internal: tokenize splits on punctuation but keeps underscores', () => {
  const toks = __internals.tokenize('SELECT deleted_at, id FROM users_v2');
  assert(toks.includes('SELECT'));
  assert(toks.includes('DELETED_AT'));
  assert(toks.includes('USERS_V2'));
});

test('internal: hasStackedStatements detects simple case', () => {
  assert.strictEqual(__internals.hasStackedStatements('SELECT 1; SELECT 2'), true);
});

test('internal: hasStackedStatements tolerates trailing semicolon', () => {
  assert.strictEqual(__internals.hasStackedStatements('SELECT 1;'), false);
  assert.strictEqual(__internals.hasStackedStatements('SELECT 1;   '), false);
  assert.strictEqual(__internals.hasStackedStatements('SELECT 1;\n'), false);
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
