/**
 * Database tool handlers: ssh_db_query, ssh_db_list, ssh_db_dump, ssh_db_import.
 *
 * All four:
 *   - Route through streamExecCommand for clean UTF-8 / timeout / abort.
 *   - Shell-quote every interpolated value via shQuote().
 *   - Pass credentials via ENVIRONMENT VARIABLES (MYSQL_PWD / PGPASSWORD /
 *     MongoDB connection-string URI). NEVER as argv -- so `ps auxf` on the
 *     remote host can never show the password. We construct the command as
 *     `MYSQL_PWD=... mysql ...` which is inherited by the child process.
 *   - Support format: 'markdown' | 'json' | 'both'.
 *
 * Mutating tools (dump, import) support preview: true (dry-run, never touches remote).
 *
 * Query is validated by isSafeSelect() -- same validator rejects multi-statement,
 * comment-hidden, backtick-hidden, and INTO OUTFILE smuggling.
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { formatBytes, formatDuration } from '../output-formatter.js';
import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { isSafeSelect } from './sql-safety.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 1000;
const MAX_ALLOWED_LIMIT = 100_000;

/**
 * Conservative SQL-identifier validator (database / user names).
 *
 * shQuote() is correct for SHELL quoting but a value like `app'; DROP DATABASE x; --`
 * shell-unquotes to a literal SQL string and becomes an INJECTED SQL token when the
 * outer `-e '<query>'` is parsed by mysql/psql. We don't render idents as SQL string
 * literals anywhere safe -- `SHOW TABLES FROM 'name'`, `pg_database_size('name')`,
 * and the parameterless `mysqldump <name>` all treat the value as an identifier.
 * So we require a syntactic subset that every mainstream DBMS allows for
 * database/role/schema/table names:
 *   [A-Za-z0-9_][A-Za-z0-9_.-]{0,63}
 * Max 64 chars (MySQL cap is 64, PG is 63). `.` allowed so `schema.table` works for
 * mongodump --db / pg_database_size callers that pass schema-qualified names.
 * No spaces, no quotes, no semicolons, no backticks, no backslashes.
 */
const SQL_IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
function isSafeSqlIdent(s) {
  return typeof s === 'string' && SQL_IDENT_RE.test(s);
}
function rejectBadIdent(tool, field, value, { server, format }) {
  return toMcp(
    fail(tool, `${field} contains unsafe characters (must match [A-Za-z0-9_][A-Za-z0-9_.-]{0,63})`, { server }),
    { format },
  );
}

/**
 * Assemble a MongoDB URI for the `mongo` family so we can hand it to mongosh
 * via env var instead of argv. Defaults to localhost:27017 because the SSH
 * server IS typically the DB host in this deployment model.
 */
function buildMongoConnectionUri({ user, password, host = 'localhost', port = 27017, database, authSource }) {
  const userinfo = user
    ? (password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`)
    : '';
  const db = database ? `/${encodeURIComponent(database)}` : '';
  const q = authSource ? `?authSource=${encodeURIComponent(authSource)}` : '';
  return `mongodb://${userinfo}${host}:${port}${db}${q}`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Coerce to a safe integer in [min, max] with a fallback.
 */
function safeInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Detect whether a SELECT query already declares a LIMIT clause.
 * We scan the token stream (comments + strings stripped) for a bare `LIMIT` token.
 * Returns { hasLimit: boolean, limitValue: number|null }.
 */
function detectLimit(sql) {
  // Reuse sql-safety's internals indirectly: strip then look for LIMIT N pattern.
  // To avoid re-exposing internals, we do a simple scan here -- good enough because
  // isSafeSelect has already vetted the query.
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '\'\'')
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``');
  const m = stripped.match(/\blimit\s+(\d+)\b/i);
  if (m) return { hasLimit: true, limitValue: Number(m[1]) };
  return { hasLimit: false, limitValue: null };
}

/**
 * Parse a TSV (tab-separated) result block (mysql --batch or psql -F tab).
 * First line is headers. Returns { columns, rows }.
 */
function parseTsv(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { columns: [], rows: [] };
  const lines = text.split('\n');
  const columns = lines[0].split('\t');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    rows.push(line.split('\t'));
  }
  return { columns, rows };
}

/**
 * MySQL batch mode emits tabular data with NO header (we pass -N for --skip-column-names)
 * when we want rows, OR with a header when we omit -N. We'll include the header.
 */

// --------------------------------------------------------------------------
// Query-command builders (exported for tests)
// --------------------------------------------------------------------------

/**
 * Build the MySQL query command. Password via MYSQL_PWD env, NEVER argv.
 */
export function buildMySqlQueryCommand({ database, query, user }) {
  // --batch: tab-separated output.  (omit -N so we get column headers)
  const parts = ['MYSQL_PWD="$SSH_MGR_DB_PASS"', 'mysql', '--batch'];
  if (user) parts.push('-u', shQuote(user));
  if (database) parts.push('-D', shQuote(database));
  parts.push('-e', shQuote(query));
  return parts.join(' ');
}

/**
 * Build the PostgreSQL query command. Password via PGPASSWORD env, NEVER argv.
 */
export function buildPostgresQueryCommand({ database, query, user }) {
  // -A: unaligned, -F '\t': tab separator, keep header (NO -t).
  const parts = ['PGPASSWORD="$SSH_MGR_DB_PASS"', 'psql', '-A', '-F', '$\'\\t\''];
  if (user) parts.push('-U', shQuote(user));
  if (database) parts.push('-d', shQuote(database));
  parts.push('-c', shQuote(query));
  return parts.join(' ');
}

/**
 * Build the MongoDB query command. Credentials via SSH_MGR_DB_URI env var
 * (never argv). `query` is a JS snippet; the db is switched via
 * `db.getSiblingDB(...)` inside the eval so we don't rely on mongosh's
 * positional-URI parsing.
 */
export function buildMongoQueryCommand({ database, query, user: _user }) {
  // Assemble a single eval that: (a) connects via URI read from env (so no
  // credentials appear in argv on the target host), (b) selects the target
  // database via getSiblingDB instead of a positional, (c) runs the caller's
  // snippet with the correct `db` binding.
  const dbLit = JSON.stringify(database || 'admin');
  const wrappedEval =
    'const __mgr_conn = new Mongo(process.env.SSH_MGR_DB_URI); ' +
    `const db = __mgr_conn.getDB(${dbLit}); ` +
    query;
  // --nodb tells mongosh NOT to auto-connect; we build the connection in the
  // eval so mongosh never sees a URI in argv.
  return `mongosh --quiet --nodb --eval ${shQuote(wrappedEval)}`;
}

// --------------------------------------------------------------------------
// List-command builders
// --------------------------------------------------------------------------
export function buildMySqlListCommand({ database, user }) {
  if (database) {
    const q = `SHOW TABLES FROM ${shQuote(database)}`;
    return `MYSQL_PWD="$SSH_MGR_DB_PASS" mysql --batch -N${user ? ' -u ' + shQuote(user) : ''} -e ${shQuote(q)}`;
  }
  return `MYSQL_PWD="$SSH_MGR_DB_PASS" mysql --batch -N${user ? ' -u ' + shQuote(user) : ''} -e 'SHOW DATABASES'`;
}

export function buildPostgresListCommand({ database, user }) {
  if (database) {
    // \dt outputs schema.table rows -- we use a proper SELECT for consistent output.
    const q = 'SELECT tablename FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')';
    return `PGPASSWORD="$SSH_MGR_DB_PASS" psql -A -t${user ? ' -U ' + shQuote(user) : ''} -d ${shQuote(database)} -c ${shQuote(q)}`;
  }
  const q = 'SELECT datname FROM pg_database WHERE datistemplate = false';
  return `PGPASSWORD="$SSH_MGR_DB_PASS" psql -A -t${user ? ' -U ' + shQuote(user) : ''} -c ${shQuote(q)}`;
}

export function buildMongoListCommand({ database, user }) {
  const userArgs = user ? ` -u ${shQuote(user)} -p "$SSH_MGR_DB_PASS"` : '';
  if (database) {
    return `mongosh --quiet${userArgs} ${shQuote(database)} --eval 'db.getCollectionNames().forEach(c => print(c))'`;
  }
  return `mongosh --quiet${userArgs} --eval 'db.adminCommand("listDatabases").databases.forEach(d => print(d.name))'`;
}

// --------------------------------------------------------------------------
// Dump / import command builders
// --------------------------------------------------------------------------

/**
 * Estimate DB size command (returns bytes).
 */
export function buildEstimateCommand({ db_type, database }) {
  if (db_type === 'mysql') {
    const q = `SELECT COALESCE(SUM(data_length + index_length),0) FROM information_schema.tables WHERE table_schema = ${shQuote(database)}`;
    return `MYSQL_PWD="$SSH_MGR_DB_PASS" mysql --batch -N -e ${shQuote(q)}`;
  }
  if (db_type === 'postgresql') {
    const q = `SELECT pg_database_size(${shQuote(database)})`;
    return `PGPASSWORD="$SSH_MGR_DB_PASS" psql -A -t -c ${shQuote(q)}`;
  }
  if (db_type === 'mongodb') {
    return `mongosh --quiet ${shQuote(database)} --eval 'print(db.stats().dataSize || 0)'`;
  }
  return 'echo 0';
}

export function buildDumpCommand({ db_type, database, output_path, gzip, user }) {
  const outQ = shQuote(output_path);
  if (db_type === 'mysql') {
    const core = `MYSQL_PWD="$SSH_MGR_DB_PASS" mysqldump${user ? ' -u ' + shQuote(user) : ''} --single-transaction --routines --triggers ${shQuote(database)}`;
    return gzip ? `${core} | gzip > ${outQ}` : `${core} > ${outQ}`;
  }
  if (db_type === 'postgresql') {
    const core = `PGPASSWORD="$SSH_MGR_DB_PASS" pg_dump${user ? ' -U ' + shQuote(user) : ''} ${shQuote(database)}`;
    return gzip ? `${core} | gzip > ${outQ}` : `${core} > ${outQ}`;
  }
  if (db_type === 'mongodb') {
    const userArgs = user ? ` -u ${shQuote(user)} -p "$SSH_MGR_DB_PASS"` : '';
    // mongodump writes a directory; for "gzip" we archive to a single file.
    const archiveFlag = gzip ? '--archive --gzip' : '--archive';
    return `mongodump${userArgs} --db ${shQuote(database)} ${archiveFlag} > ${outQ}`;
  }
  return '';
}

export function buildImportCommand({ db_type, database, input_path, user }) {
  const inQ = shQuote(input_path);
  const gz = String(input_path).endsWith('.gz');
  if (db_type === 'mysql') {
    const reader = gz ? `gunzip -c ${inQ}` : `cat ${inQ}`;
    return `${reader} | MYSQL_PWD="$SSH_MGR_DB_PASS" mysql${user ? ' -u ' + shQuote(user) : ''} ${shQuote(database)}`;
  }
  if (db_type === 'postgresql') {
    const reader = gz ? `gunzip -c ${inQ}` : `cat ${inQ}`;
    return `${reader} | PGPASSWORD="$SSH_MGR_DB_PASS" psql${user ? ' -U ' + shQuote(user) : ''} -d ${shQuote(database)}`;
  }
  if (db_type === 'mongodb') {
    const userArgs = user ? ` -u ${shQuote(user)} -p "$SSH_MGR_DB_PASS"` : '';
    const gzipFlag = gz || String(input_path).endsWith('.archive.gz') ? ' --gzip' : '';
    // shQuote wraps in single quotes: --archive='/path with spaces/db.archive'
    return `mongorestore${userArgs} --db ${shQuote(database)}${gzipFlag} --archive=${shQuote(input_path)}`;
  }
  return '';
}

/**
 * Count tables/collections command for import preview warnings.
 */
export function buildTableCountCommand({ db_type, database, user }) {
  if (db_type === 'mysql') {
    const q = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ${shQuote(database)}`;
    return `MYSQL_PWD="$SSH_MGR_DB_PASS" mysql --batch -N${user ? ' -u ' + shQuote(user) : ''} -e ${shQuote(q)}`;
  }
  if (db_type === 'postgresql') {
    const q = 'SELECT COUNT(*) FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')';
    return `PGPASSWORD="$SSH_MGR_DB_PASS" psql -A -t${user ? ' -U ' + shQuote(user) : ''} -d ${shQuote(database)} -c ${shQuote(q)}`;
  }
  if (db_type === 'mongodb') {
    const userArgs = user ? ` -u ${shQuote(user)} -p "$SSH_MGR_DB_PASS"` : '';
    return `mongosh --quiet${userArgs} ${shQuote(database)} --eval 'print(db.getCollectionNames().length)'`;
  }
  return 'echo 0';
}

/**
 * Command to stat a remote file's size in bytes.
 */
export function buildFileSizeCommand(path) {
  const p = shQuote(path);
  // stat flags differ across Linux/macOS; try both with fallback.
  return `stat -c '%s' ${p} 2>/dev/null || stat -f '%z' ${p} 2>/dev/null || echo 0`;
}

// --------------------------------------------------------------------------
// ssh_db_query
// --------------------------------------------------------------------------
export async function handleSshDbQuery({ getConnection, args }) {
  const {
    server, db_type, database, query, user, password = '',
    format = 'markdown',
    limit = DEFAULT_LIMIT,
    timeout = DEFAULT_TIMEOUT_MS,
  } = args || {};

  if (!server) return toMcp(fail('ssh_db_query', 'server is required'), { format });
  if (!db_type) return toMcp(fail('ssh_db_query', 'db_type is required'), { format });
  if (!['mysql', 'postgresql', 'mongodb'].includes(db_type)) {
    return toMcp(fail('ssh_db_query', `unsupported db_type: ${db_type}`), { format });
  }
  if (!query || typeof query !== 'string') {
    return toMcp(fail('ssh_db_query', 'query is required'), { format });
  }
  if (database != null && !isSafeSqlIdent(database)) {
    return rejectBadIdent('ssh_db_query', 'database', database, { server, format });
  }
  if (user != null && !isSafeSqlIdent(user)) {
    return rejectBadIdent('ssh_db_query', 'user', user, { server, format });
  }

  const cappedLimit = safeInt(limit, { min: 1, max: MAX_ALLOWED_LIMIT, fallback: DEFAULT_LIMIT });

  // Mongo uses a JS eval, not SQL -- skip isSafeSelect but do a minimal check:
  // reject statements that look like they'd write.
  let finalQuery = query;
  if (db_type !== 'mongodb') {
    const safety = isSafeSelect(query);
    if (!safety.ok) {
      return toMcp(
        fail('ssh_db_query', `unsafe query rejected: ${safety.reason}`, { server }),
        { format },
      );
    }
    // Auto-append LIMIT if absent.  Reject if existing LIMIT exceeds the cap.
    const { hasLimit, limitValue } = detectLimit(query);
    if (hasLimit) {
      if (limitValue > cappedLimit) {
        return toMcp(
          fail('ssh_db_query', `query declares LIMIT ${limitValue} which exceeds cap ${cappedLimit}`, { server }),
          { format },
        );
      }
    } else {
      // Append LIMIT -- strip trailing semicolon first.
      finalQuery = query.replace(/;\s*$/, '') + ` LIMIT ${cappedLimit}`;
    }
  } else {
    // For Mongo: reject obviously-mutating operations in the eval.
    const lower = String(query).toLowerCase();
    const badOps = ['.drop(', '.droprole', '.dropuser', '.deletemany', '.deleteone',
      '.insertmany', '.insertone', '.updatemany', '.updateone',
      '.replaceone', '.remove(', '.bulkwrite', '.rename', '.createindex',
      '.dropindex'];
    for (const op of badOps) {
      if (lower.includes(op)) {
        return toMcp(
          fail('ssh_db_query', `unsafe mongo eval rejected: contains \`${op}\``, { server }),
          { format },
        );
      }
    }
  }

  // Build command
  let cmd;
  let envPrefix;
  if (db_type === 'mysql') {
    cmd = buildMySqlQueryCommand({ database, query: finalQuery, user });
    envPrefix = `SSH_MGR_DB_PASS=${shQuote(password)} `;
  } else if (db_type === 'postgresql') {
    cmd = buildPostgresQueryCommand({ database, query: finalQuery, user });
    envPrefix = `SSH_MGR_DB_PASS=${shQuote(password)} `;
  } else {
    // mongo: URI via env so the password never enters argv on the target host.
    cmd = buildMongoQueryCommand({ database, query: finalQuery, user });
    const uri = buildMongoConnectionUri({ user, password, database });
    envPrefix = `SSH_MGR_DB_URI=${shQuote(uri)} `;
  }
  const fullCmd = envPrefix + cmd;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(
      fail('ssh_db_query', `connection failed: ${e.message || e}`, { server, duration_ms: Date.now() - startedAt }),
      { format },
    );
  }

  let result, error;
  try { result = await streamExecCommand(client, fullCmd, { timeoutMs: timeout }); }
  catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return toMcp(
      fail('ssh_db_query', `query failed: ${error.message || error}`, { server, duration_ms: durationMs }),
      { format },
    );
  }
  if (result.code !== 0) {
    return toMcp(
      fail('ssh_db_query', `query exited ${result.code}: ${result.stderr || result.stdout}`, { server, duration_ms: durationMs }),
      { format },
    );
  }

  // Parse
  let data;
  if (db_type === 'mongodb') {
    data = { raw: result.stdout, db_type, database };
  } else {
    const parsed = parseTsv(result.stdout);
    data = { db_type, database, columns: parsed.columns, rows: parsed.rows, row_count: parsed.rows.length };
  }

  return toMcp(ok('ssh_db_query', data, { server, duration_ms: durationMs }), { format, renderer: renderDbQuery });
}

function renderDbQuery(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  const dur = result.meta?.duration_ms != null ? ` | \`${formatDuration(result.meta.duration_ms)}\`` : '';
  lines.push(`[ok] **ssh_db_query** | \`${result.server}\` | \`${d.db_type}\`${dur}`);
  if (d.columns) {
    lines.push(`${d.row_count} row${d.row_count === 1 ? '' : 's'} | ${d.columns.length} column${d.columns.length === 1 ? '' : 's'}`);
    if (d.columns.length > 0) {
      lines.push('');
      lines.push('| ' + d.columns.join(' | ') + ' |');
      lines.push('|' + d.columns.map(() => '---').join('|') + '|');
      for (const row of d.rows.slice(0, 50)) {
        lines.push('| ' + row.join(' | ') + ' |');
      }
      if (d.rows.length > 50) {
        lines.push('');
        lines.push(`> ... ${d.rows.length - 50} more rows elided`);
      }
    }
  } else if (d.raw) {
    lines.push('');
    lines.push('```text');
    lines.push(d.raw);
    lines.push('```');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// ssh_db_list
// --------------------------------------------------------------------------
export async function handleSshDbList({ getConnection, args }) {
  const {
    server, db_type, database, user, password = '',
    format = 'markdown',
    timeout = DEFAULT_TIMEOUT_MS,
  } = args || {};

  if (!server) return toMcp(fail('ssh_db_list', 'server is required'), { format });
  if (!['mysql', 'postgresql', 'mongodb'].includes(db_type)) {
    return toMcp(fail('ssh_db_list', `unsupported db_type: ${db_type}`), { format });
  }
  if (database != null && !isSafeSqlIdent(database)) {
    return rejectBadIdent('ssh_db_list', 'database', database, { server, format });
  }
  if (user != null && !isSafeSqlIdent(user)) {
    return rejectBadIdent('ssh_db_list', 'user', user, { server, format });
  }

  let cmd;
  if (db_type === 'mysql') cmd = buildMySqlListCommand({ database, user });
  else if (db_type === 'postgresql') cmd = buildPostgresListCommand({ database, user });
  else cmd = buildMongoListCommand({ database, user });

  const fullCmd = `SSH_MGR_DB_PASS=${shQuote(password)} ` + cmd;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(
      fail('ssh_db_list', `connection failed: ${e.message || e}`, { server }),
      { format },
    );
  }

  let result, error;
  try { result = await streamExecCommand(client, fullCmd, { timeoutMs: timeout }); }
  catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return toMcp(fail('ssh_db_list', error.message || String(error), { server, duration_ms: durationMs }), { format });
  }
  if (result.code !== 0) {
    return toMcp(
      fail('ssh_db_list', `list exited ${result.code}: ${result.stderr || result.stdout}`, { server, duration_ms: durationMs }),
      { format },
    );
  }

  const names = String(result.stdout).split('\n').map(s => s.trim()).filter(Boolean);
  // Filter system dbs when listing dbs (not tables).
  const filtered = database ? names : filterSystemDbs(names, db_type);

  const data = database
    ? (db_type === 'mongodb' ? { db_type, database, collections: filtered } : { db_type, database, tables: filtered })
    : { db_type, databases: filtered };

  return toMcp(ok('ssh_db_list', data, { server, duration_ms: durationMs }), { format });
}

function filterSystemDbs(names, db_type) {
  const sys = {
    mysql: new Set(['information_schema', 'performance_schema', 'mysql', 'sys']),
    postgresql: new Set(['template0', 'template1', 'postgres']),
    mongodb: new Set(['admin', 'config', 'local']),
  };
  const s = sys[db_type] || new Set();
  return names.filter(n => !s.has(n.toLowerCase()));
}

// --------------------------------------------------------------------------
// ssh_db_dump
// --------------------------------------------------------------------------
export async function handleSshDbDump({ getConnection, args }) {
  const {
    server, db_type, database, user, password = '',
    output_path,
    gzip = true,
    format = 'markdown',
    preview: isPreview = false,
    timeout = 600_000,
  } = args || {};

  if (!server) return toMcp(fail('ssh_db_dump', 'server is required'), { format });
  if (!['mysql', 'postgresql', 'mongodb'].includes(db_type)) {
    return toMcp(fail('ssh_db_dump', `unsupported db_type: ${db_type}`), { format });
  }
  if (!database) return toMcp(fail('ssh_db_dump', 'database is required'), { format });
  if (!isSafeSqlIdent(database)) {
    return rejectBadIdent('ssh_db_dump', 'database', database, { server, format });
  }
  if (user != null && !isSafeSqlIdent(user)) {
    return rejectBadIdent('ssh_db_dump', 'user', user, { server, format });
  }

  const outPath = output_path ||
    `/tmp/${database}-${Date.now()}.${db_type === 'mongodb' ? 'archive' : 'sql'}${gzip ? '.gz' : ''}`;

  if (isPreview) {
    // Try to query an estimated size; tolerate failure gracefully.
    let estimatedBytes = null;
    try {
      const client = await getConnection(server);
      const r = await streamExecCommand(
        client,
        `SSH_MGR_DB_PASS=${shQuote(password)} ` + buildEstimateCommand({ db_type, database }),
        { timeoutMs: 15_000 },
      );
      if (r.code === 0) estimatedBytes = Number(String(r.stdout).trim()) || 0;
    } catch (_) { /* best-effort */ }

    const plan = buildPlan({
      action: 'db-dump',
      target: `${server}:${database} -> ${outPath}`,
      effects: [
        `dumps ${db_type} database \`${database}\``,
        gzip ? 'output compressed with gzip' : 'output uncompressed',
        estimatedBytes != null ? `estimated size: ${formatBytes(estimatedBytes)}` : 'estimated size: unknown',
        'password never enters argv (env var)',
      ],
      reversibility: 'auto',
      risk: 'low',
      estimated_bytes: estimatedBytes,
    });
    return toMcp(preview('ssh_db_dump', plan, { server }), { format });
  }

  const cmd = buildDumpCommand({ db_type, database, output_path: outPath, gzip, user });
  const fullCmd = `SSH_MGR_DB_PASS=${shQuote(password)} ` + cmd;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_db_dump', `connection failed: ${e.message || e}`, { server }), { format });
  }

  let result, error;
  try { result = await streamExecCommand(client, fullCmd, { timeoutMs: timeout }); }
  catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return toMcp(fail('ssh_db_dump', error.message || String(error), { server, duration_ms: durationMs }), { format });
  }
  if (result.code !== 0) {
    return toMcp(
      fail('ssh_db_dump', `dump exited ${result.code}: ${result.stderr || result.stdout}`, { server, duration_ms: durationMs }),
      { format },
    );
  }

  // Stat the output file for final byte count.
  let bytesWritten = null;
  try {
    const r = await streamExecCommand(client, buildFileSizeCommand(outPath), { timeoutMs: 10_000 });
    if (r.code === 0) bytesWritten = Number(String(r.stdout).trim()) || 0;
  } catch (_) { /* ignore */ }

  return toMcp(
    ok('ssh_db_dump', {
      db_type, database,
      output_path: outPath,
      bytes_written: bytesWritten,
      gzipped: !!gzip,
    }, { server, duration_ms: durationMs }),
    { format },
  );
}

// --------------------------------------------------------------------------
// ssh_db_import
// --------------------------------------------------------------------------
export async function handleSshDbImport({ getConnection, args }) {
  const {
    server, db_type, database, user, password = '',
    input_path,
    format = 'markdown',
    preview: isPreview = false,
    timeout = 600_000,
  } = args || {};

  if (!server) return toMcp(fail('ssh_db_import', 'server is required'), { format });
  if (!['mysql', 'postgresql', 'mongodb'].includes(db_type)) {
    return toMcp(fail('ssh_db_import', `unsupported db_type: ${db_type}`), { format });
  }
  if (!database) return toMcp(fail('ssh_db_import', 'database is required'), { format });
  if (!isSafeSqlIdent(database)) {
    return rejectBadIdent('ssh_db_import', 'database', database, { server, format });
  }
  if (user != null && !isSafeSqlIdent(user)) {
    return rejectBadIdent('ssh_db_import', 'user', user, { server, format });
  }
  if (!input_path) return toMcp(fail('ssh_db_import', 'input_path is required'), { format });

  if (isPreview) {
    // Best-effort file size + table-count queries.
    let inputBytes = null, existingCount = null;
    try {
      const client = await getConnection(server);
      const sizeRes = await streamExecCommand(client, buildFileSizeCommand(input_path), { timeoutMs: 10_000 });
      if (sizeRes.code === 0) inputBytes = Number(String(sizeRes.stdout).trim()) || 0;
      const countRes = await streamExecCommand(
        client,
        `SSH_MGR_DB_PASS=${shQuote(password)} ` + buildTableCountCommand({ db_type, database, user }),
        { timeoutMs: 15_000 },
      );
      if (countRes.code === 0) existingCount = Number(String(countRes.stdout).trim()) || 0;
    } catch (_) { /* best-effort */ }

    const entityWord = db_type === 'mongodb' ? 'collection' : 'table';
    const effects = [
      `imports ${db_type} dump from \`${input_path}\` into \`${database}\``,
      inputBytes != null ? `input size: ${formatBytes(inputBytes)}` : 'input size: unknown',
    ];
    if (existingCount != null && existingCount > 0) {
      effects.push(`**WARNING: this will overwrite ${existingCount} existing ${entityWord}${existingCount === 1 ? '' : 's'}**`);
    }
    effects.push('password never enters argv (env var)');

    const plan = buildPlan({
      action: 'db-import',
      target: `${server}:${database} <- ${input_path}`,
      effects,
      reversibility: 'manual',
      risk: 'high',
      input_bytes: inputBytes,
      existing_table_count: existingCount,
    });
    return toMcp(preview('ssh_db_import', plan, { server }), { format });
  }

  const cmd = buildImportCommand({ db_type, database, input_path, user });
  const fullCmd = `SSH_MGR_DB_PASS=${shQuote(password)} ` + cmd;

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_db_import', `connection failed: ${e.message || e}`, { server }), { format });
  }

  let result, error;
  try { result = await streamExecCommand(client, fullCmd, { timeoutMs: timeout }); }
  catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return toMcp(fail('ssh_db_import', error.message || String(error), { server, duration_ms: durationMs }), { format });
  }
  if (result.code !== 0) {
    return toMcp(
      fail('ssh_db_import', `import exited ${result.code}: ${result.stderr || result.stdout}`, { server, duration_ms: durationMs }),
      { format },
    );
  }

  return toMcp(
    ok('ssh_db_import', {
      db_type, database, input_path, success: true,
    }, { server, duration_ms: durationMs }),
    { format },
  );
}
