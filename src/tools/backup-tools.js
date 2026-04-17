/**
 * Rewritten backup tools -- content-addressed + hash-verified.
 *
 * Tools:
 *   - handleSshBackupCreate    -- dump/archive then sha256 + write meta sidecar
 *   - handleSshBackupList      -- parse *.meta sidecars into structured backup list
 *   - handleSshBackupRestore   -- verify sha256 matches meta BEFORE restoring
 *   - handleSshBackupSchedule  -- append a cron entry for recurring backups
 *
 * Security invariants:
 *   - Credentials NEVER appear in argv. MySQL uses MYSQL_PWD, Postgres uses
 *     PGPASSWORD, Mongo uses mongodump --uri (URI written to stdin of a
 *     tiny shell read -> mongodump --uri "$u"; we stick with env for simplicity
 *     and consistency with db-tools: MONGO_URI="..." mongodump --uri "$MONGO_URI").
 *   - All interpolated strings run through shQuote().
 *   - Every write is followed by a `sha256sum` verification when verify:true.
 *     The digest + size + UUID backup_id are written to OUTPUT.meta as JSON.
 *   - Restore refuses to proceed on checksum mismatch -- the artifact is treated
 *     as corrupt/tampered and the original target is untouched.
 *
 * Wire shape (returned `data` of a successful create):
 *   {
 *     backup_id, backup_type, server, database?, paths?,
 *     output_path, size_bytes, sha256, compressed, created_at, verified
 *   }
 */

import crypto from 'crypto';
import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatBytes, formatDuration } from '../output-formatter.js';

const DEFAULT_TIMEOUT_MS = 600_000;        // 10 min -- dumps can be large
const DEFAULT_BACKUP_DIR = '/var/backups/mcp-ssh';
const VALID_TYPES = new Set(['mysql', 'postgresql', 'mongodb', 'files']);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

/**
 * Default output path for a backup, under DEFAULT_BACKUP_DIR.
 * Extension depends on type and gzip flag.
 */
function defaultOutputPath(type, name, { gzip, backupDir = DEFAULT_BACKUP_DIR, backupId } = {}) {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safeName = String(name || type).replace(/[^A-Za-z0-9._-]+/g, '_');
  const id = (backupId || '').slice(0, 8);
  const base = `${type}_${safeName}_${stamp}${id ? '_' + id : ''}`;
  const ext = type === 'mongodb'
    ? (gzip ? '.archive.gz' : '.archive')
    : (gzip ? '.gz' : '.sql'); // files uses .tar.gz regardless below
  if (type === 'files') return `${backupDir}/${base}.tar${gzip ? '.gz' : ''}`;
  return `${backupDir}/${base}${ext}`;
}

/**
 * Build the remote dump/archive command. Credentials via env only.
 * `outputPath` must already be shQuoted by caller when fed into the command,
 * but we receive the raw path and shQuote internally.
 *
 * Returns { command, envPrefix } -- envPrefix must be prepended verbatim by caller.
 */
export function buildBackupCommand({ backup_type, database, paths, user, password, host, port, outputPath, gzip = true }) {
  const out = shQuote(outputPath);
  const ensureDir = `mkdir -p ${shQuote(dirnameOf(outputPath))} && `;
  switch (backup_type) {
    case 'mysql': {
      const parts = ['mysqldump', '--single-transaction', '--routines', '--triggers'];
      if (user) parts.push('-u', shQuote(user));
      if (host) parts.push('-h', shQuote(host));
      if (port) parts.push('-P', shQuote(port));
      if (database) parts.push(shQuote(database));
      const core = `MYSQL_PWD="$MCP_BACKUP_PASS" ${parts.join(' ')}`;
      const cmd = gzip ? `${core} | gzip > ${out}` : `${core} > ${out}`;
      return { command: ensureDir + cmd, envPrefix: envFor(password) };
    }
    case 'postgresql': {
      const parts = ['pg_dump', '--format=custom', '--clean', '--if-exists'];
      if (user) parts.push('-U', shQuote(user));
      if (host) parts.push('-h', shQuote(host));
      if (port) parts.push('-p', shQuote(port));
      if (database) parts.push(shQuote(database));
      const core = `PGPASSWORD="$MCP_BACKUP_PASS" ${parts.join(' ')}`;
      const cmd = gzip ? `${core} | gzip > ${out}` : `${core} > ${out}`;
      return { command: ensureDir + cmd, envPrefix: envFor(password) };
    }
    case 'mongodb': {
      // mongodump --archive (no value) writes the single-stream archive to
      // stdout; we then pipe / redirect to `out` (shQuoted). URI is carried
      // via MCP_BACKUP_URI so user/pass/host/port/db never appear in argv.
      const uri = buildMongoUri({ user, password, host, port, database });
      const envPrefix = `MCP_BACKUP_URI=${shQuote(uri)} `;
      const parts = ['mongodump', '--uri', '"$MCP_BACKUP_URI"', '--archive'];
      if (gzip) parts.push('--gzip');
      const cmd = `${parts.join(' ')} > ${out}`;
      return { command: ensureDir + cmd, envPrefix };
    }
    case 'files': {
      const pathList = (paths || []).map(p => shQuote(p)).join(' ');
      // Use absolute paths as-is (tar -czf OUTPUT PATHS). We do NOT -C / because
      // the caller may pass absolute or relative paths; tar preserves whatever
      // they gave us. This matches the spec: `tar -czf OUTPUT -C / PATH`.
      const flag = gzip ? '-czf' : '-cf';
      const cmd = `tar ${flag} ${out} -C / ${pathList}`;
      return { command: ensureDir + cmd, envPrefix: '' };
    }
    default:
      throw new Error(`unsupported backup_type: ${backup_type}`);
  }
}

function envFor(password) {
  if (password == null || password === '') return '';
  return `MCP_BACKUP_PASS=${shQuote(password)} `;
}

function buildMongoUri({ user, password, host = 'localhost', port = 27017, database }) {
  const userinfo = user
    ? (password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`)
    : '';
  const db = database ? `/${encodeURIComponent(database)}` : '';
  return `mongodb://${userinfo}${host}:${port}${db}`;
}

function dirnameOf(p) {
  const i = String(p).lastIndexOf('/');
  if (i <= 0) return '/';
  return String(p).slice(0, i);
}

/**
 * Run `sha256sum PATH | awk '{print $1}'` -> hex digest (throws on non-zero).
 */
async function remoteSha256(client, remotePath, { timeout = 120_000 } = {}) {
  const cmd = `sha256sum ${shQuote(remotePath)} | awk '{print $1}'`;
  const r = await streamExecCommand(client, cmd, { timeoutMs: timeout });
  if (r.code !== 0) {
    throw new Error(`sha256sum failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  }
  return (r.stdout || '').trim();
}

/**
 * Run `stat -c %s PATH` -> bytes (throws on non-zero).
 */
async function remoteSizeBytes(client, remotePath) {
  const r = await streamExecCommand(client, `stat -c '%s' ${shQuote(remotePath)}`, { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`stat failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  const n = Number((r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Write a JSON meta file next to the backup. Single-quoted heredoc keeps shell
 * from interpolating anything inside; we shQuote the path and cat > via
 * `printf '%s' 'json' > meta` with proper escaping.
 */
async function writeMeta(client, metaPath, metaObject, { timeout = 15_000 } = {}) {
  const json = JSON.stringify(metaObject);
  // `printf '%s' -- ...` stops printf from treating a leading `%` in the JSON
  // (e.g. a URL-encoded path like /backups/50%25-used/) as a format directive.
  const cmd = `printf '%s' -- ${shQuote(json)} > ${shQuote(metaPath)}`;
  const r = await streamExecCommand(client, cmd, { timeoutMs: timeout });
  if (r.code !== 0) {
    throw new Error(`meta write failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  }
}

/**
 * Read a JSON meta file -> object. Returns null on non-zero or parse failure.
 */
async function readMeta(client, metaPath, { timeout = 15_000 } = {}) {
  const r = await streamExecCommand(client, `cat ${shQuote(metaPath)}`, { timeoutMs: timeout });
  if (r.code !== 0) return null;
  try { return JSON.parse(String(r.stdout || '').trim()); }
  catch (_) { return null; }
}

// --------------------------------------------------------------------------
// ssh_backup_create
// --------------------------------------------------------------------------
export async function handleSshBackupCreate({ getConnection, args }) {
  const {
    server,
    backup_type,
    database = null,
    paths = null,
    output_path,
    user = null,
    password = '',
    host = null,
    port = null,
    gzip = true,
    verify = true,
    backup_dir = DEFAULT_BACKUP_DIR,
    format = 'markdown',
    preview: isPreview = false,
    timeout = DEFAULT_TIMEOUT_MS,
  } = args || {};

  if (!server) return toMcp(fail('ssh_backup_create', 'server is required'), { format });
  if (!VALID_TYPES.has(backup_type)) {
    return toMcp(fail('ssh_backup_create', `invalid backup_type: ${backup_type}`, { server }), { format });
  }
  if (backup_type === 'files' && (!Array.isArray(paths) || paths.length === 0)) {
    return toMcp(fail('ssh_backup_create', 'paths is required (non-empty array) for files backups', { server }), { format });
  }
  if ((backup_type === 'mysql' || backup_type === 'postgresql') && !database) {
    return toMcp(fail('ssh_backup_create', `database is required for ${backup_type} backups`, { server }), { format });
  }

  const backupId = crypto.randomUUID();
  const targetName = backup_type === 'files'
    ? (paths[0] || 'files').replace(/^\//, '').replace(/\//g, '_') || 'files'
    : database;
  const outPath = output_path || defaultOutputPath(backup_type, targetName, {
    gzip, backupDir: backup_dir, backupId,
  });
  const metaPath = `${outPath}.meta`;

  if (isPreview) {
    const plan = buildPlan({
      action: 'backup-create',
      target: `${server}:${outPath}`,
      effects: [
        `backup_type: \`${backup_type}\``,
        backup_type === 'files'
          ? `paths: ${(paths || []).map(p => `\`${p}\``).join(', ')}`
          : `database: \`${database}\``,
        `output: \`${outPath}\``,
        gzip ? 'gzip compression enabled' : 'no compression',
        verify ? 'sha256 verification enabled -- hash written to .meta sidecar' : 'no verification (NOT recommended)',
        'estimated size: unknown (will be measured post-write)',
        `meta sidecar: \`${metaPath}\``,
      ],
      reversibility: 'manual',
      risk: 'low',
      estimated_size_bytes: 0,
      backup_id: backupId,
    });
    return toMcp(preview('ssh_backup_create', plan, { server }), { format });
  }

  // Build the dump/archive command.
  let cmdBundle;
  try {
    cmdBundle = buildBackupCommand({
      backup_type, database, paths, user, password, host, port,
      outputPath: outPath, gzip,
    });
  } catch (e) {
    return toMcp(fail('ssh_backup_create', e.message || String(e), { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_backup_create', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // Run the backup command.
  const fullCmd = cmdBundle.envPrefix + cmdBundle.command;
  let r;
  try {
    r = await streamExecCommand(client, fullCmd, { timeoutMs: timeout });
  } catch (e) {
    return toMcp(fail('ssh_backup_create', `backup exec failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  if (r.code !== 0) {
    return toMcp(fail('ssh_backup_create',
      `backup exited ${r.code}: ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`,
      { server, duration_ms: Date.now() - startedAt }), { format });
  }

  // Size & hash.
  let size_bytes = null;
  let sha256 = null;
  try { size_bytes = await remoteSizeBytes(client, outPath); }
  catch (e) {
    return toMcp(fail('ssh_backup_create', `post-write stat failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  if (verify) {
    try { sha256 = await remoteSha256(client, outPath, { timeout }); }
    catch (e) {
      return toMcp(fail('ssh_backup_create', `verification failed: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format });
    }
  }

  const meta = {
    backup_id: backupId,
    backup_type,
    server,
    database: database || null,
    paths: backup_type === 'files' ? paths : null,
    output_path: outPath,
    size_bytes,
    sha256,
    compressed: !!gzip,
    created_at: nowIso(),
    verified: !!sha256,
  };

  try { await writeMeta(client, metaPath, meta); }
  catch (e) {
    return toMcp(fail('ssh_backup_create', `meta write failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }

  return toMcp(
    ok('ssh_backup_create', { ...meta, meta_path: metaPath },
      { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderBackupCreate },
  );
}

function renderBackupCreate(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const meta = result.meta || {};
  const dur = meta.duration_ms != null ? ` | \`${formatDuration(meta.duration_ms)}\`` : '';
  const lines = [];
  lines.push(`[ok] **ssh_backup_create** | \`${result.server}\` | \`${d.backup_type}\`${dur}`);
  lines.push(`\`${d.output_path}\``);
  lines.push(`size: **${formatBytes(d.size_bytes || 0)}**${d.verified ? ' | **verified**' : ''}${d.compressed ? ' | gzip' : ''}`);
  if (d.sha256) lines.push(`sha256: \`${d.sha256}\``);
  lines.push(`backup_id: \`${d.backup_id}\``);
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// ssh_backup_list
// --------------------------------------------------------------------------
export async function handleSshBackupList({ getConnection, args }) {
  const {
    server,
    backup_dir = DEFAULT_BACKUP_DIR,
    format = 'markdown',
    timeout = 30_000,
  } = args || {};

  if (!server) return toMcp(fail('ssh_backup_list', 'server is required'), { format });

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_backup_list', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // List meta files, then cat them with "---" separators.
  // Missing dir -> return [] cleanly (find would fail, we handle).
  const cmd = `if [ -d ${shQuote(backup_dir)} ]; then ` +
    `find ${shQuote(backup_dir)} -maxdepth 2 -name '*.meta' -type f -print0 ` +
    '| while IFS= read -r -d \'\' f; do cat "$f"; printf \'\\n---META---\\n\'; done; ' +
    'else :; fi';

  let r;
  try { r = await streamExecCommand(client, cmd, { timeoutMs: timeout }); }
  catch (e) {
    return toMcp(fail('ssh_backup_list', `list failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  if (r.code !== 0) {
    return toMcp(fail('ssh_backup_list',
      `list exited ${r.code}: ${(r.stderr || '').trim() || 'unknown error'}`,
      { server, duration_ms: Date.now() - startedAt }), { format });
  }

  const backups = [];
  const blocks = String(r.stdout || '').split('\n---META---\n').map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    try {
      const m = JSON.parse(block);
      backups.push({
        backup_id: m.backup_id,
        backup_type: m.backup_type,
        output_path: m.output_path,
        size_bytes: m.size_bytes ?? null,
        sha256: m.sha256 ?? null,
        compressed: !!m.compressed,
        created_at: m.created_at || null,
        verified: !!m.verified,
        database: m.database || null,
        paths: m.paths || null,
      });
    } catch (_) { /* skip malformed */ }
  }
  backups.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  return toMcp(
    ok('ssh_backup_list', { backups, count: backups.length, backup_dir },
      { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderBackupList },
  );
}

function renderBackupList(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  lines.push(`[ok] **ssh_backup_list** | \`${result.server}\` | **${d.count}** backup${d.count === 1 ? '' : 's'}`);
  lines.push(`dir: \`${d.backup_dir}\``);
  if (d.count === 0) {
    lines.push('');
    lines.push('> no backups found');
    return lines.join('\n');
  }
  lines.push('');
  for (const b of d.backups.slice(0, 25)) {
    const verified = b.verified ? ' [ok]' : '';
    lines.push(`- \`${b.backup_id}\`${verified} | \`${b.backup_type}\` | ${formatBytes(b.size_bytes || 0)} | ${b.created_at || '?'}`);
    lines.push(`  \`${b.output_path}\``);
  }
  if (d.backups.length > 25) {
    lines.push('');
    lines.push(`> ... ${d.backups.length - 25} more elided`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// ssh_backup_restore
// --------------------------------------------------------------------------
export async function handleSshBackupRestore({ getConnection, args }) {
  const {
    server,
    backup_id,
    backup_dir = DEFAULT_BACKUP_DIR,
    target_path = null,           // optional override for files-type restore
    user = null,
    password = '',
    host = null,
    port = null,
    verify = true,
    format = 'markdown',
    preview: isPreview = false,
    timeout = DEFAULT_TIMEOUT_MS,
  } = args || {};

  if (!server) return toMcp(fail('ssh_backup_restore', 'server is required'), { format });
  if (!backup_id) return toMcp(fail('ssh_backup_restore', 'backup_id is required', { server }), { format });

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_backup_restore', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // Locate the meta sidecar by scanning *.meta for matching backup_id.
  // This is more robust than relying on filenames.
  const findCmd =
    `find ${shQuote(backup_dir)} -maxdepth 2 -name '*.meta' -type f -print0 2>/dev/null ` +
    '| while IFS= read -r -d \'\' f; do ' +
    `if grep -q ${shQuote(`"backup_id":"${backup_id}"`)} "$f" 2>/dev/null; then echo "$f"; break; fi; ` +
    'done';
  let findR;
  try { findR = await streamExecCommand(client, findCmd, { timeoutMs: 30_000 }); }
  catch (e) {
    return toMcp(fail('ssh_backup_restore', `locate failed: ${e.message || e}`, { server }), { format });
  }
  const metaPath = String(findR.stdout || '').trim().split('\n').filter(Boolean)[0];
  if (!metaPath) {
    return toMcp(fail('ssh_backup_restore', `no backup found with backup_id=${backup_id} under ${backup_dir}`, { server }), { format });
  }

  const meta = await readMeta(client, metaPath);
  if (!meta || !meta.output_path) {
    return toMcp(fail('ssh_backup_restore', `meta file unreadable or incomplete: ${metaPath}`, { server }), { format });
  }

  if (isPreview) {
    const plan = buildPlan({
      action: 'backup-restore',
      target: `${server}:${target_path || (meta.paths && meta.paths[0]) || meta.database || meta.output_path}`,
      effects: [
        `backup_id: \`${meta.backup_id}\``,
        `backup_type: \`${meta.backup_type}\``,
        `artifact: \`${meta.output_path}\``,
        `artifact size: ${formatBytes(meta.size_bytes || 0)}`,
        meta.sha256 ? `expected sha256: \`${meta.sha256}\`` : 'no sha256 recorded (unsafe)',
        verify ? 'will verify sha256 before restore' : 'verify disabled (NOT recommended)',
        target_path
          ? `target_path override: \`${target_path}\``
          : (meta.backup_type === 'files'
            ? `target_path: / (original) -- paths: ${(meta.paths || []).map(p => `\`${p}\``).join(', ')}`
            : `database: \`${meta.database}\``),
      ],
      reversibility: meta.backup_type === 'files' ? 'manual' : 'irreversible',
      risk: 'high',
      backup_id: meta.backup_id,
      artifact_path: meta.output_path,
      expected_sha256: meta.sha256,
    });
    return toMcp(preview('ssh_backup_restore', plan, { server }), { format });
  }

  // Verify sha256 BEFORE restoring. Mismatch -> refuse.
  if (verify && meta.sha256) {
    let actual;
    try { actual = await remoteSha256(client, meta.output_path, { timeout }); }
    catch (e) {
      return toMcp(fail('ssh_backup_restore', `hash check failed: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format });
    }
    if (actual !== meta.sha256) {
      return toMcp(fail('ssh_backup_restore',
        `sha256 mismatch -- artifact may be corrupt or tampered. expected=${meta.sha256} actual=${actual}. Restore aborted.`,
        { server, duration_ms: Date.now() - startedAt }), { format });
    }
  }

  // Build restore command per type. Same env-var pattern for passwords.
  let restoreCmd;
  let envPrefix = '';
  switch (meta.backup_type) {
    case 'mysql': {
      const db = shQuote(meta.database || '');
      const reader = meta.compressed ? `gunzip -c ${shQuote(meta.output_path)}` : `cat ${shQuote(meta.output_path)}`;
      const parts = ['mysql'];
      if (user) parts.push('-u', shQuote(user));
      if (host) parts.push('-h', shQuote(host));
      if (port) parts.push('-P', shQuote(port));
      if (meta.database) parts.push(db);
      restoreCmd = `${reader} | MYSQL_PWD="$MCP_BACKUP_PASS" ${parts.join(' ')}`;
      envPrefix = envFor(password);
      break;
    }
    case 'postgresql': {
      const parts = ['pg_restore', '--clean', '--if-exists'];
      if (user) parts.push('-U', shQuote(user));
      if (host) parts.push('-h', shQuote(host));
      if (port) parts.push('-p', shQuote(port));
      if (meta.database) parts.push('-d', shQuote(meta.database));
      const reader = meta.compressed ? `gunzip -c ${shQuote(meta.output_path)}` : `cat ${shQuote(meta.output_path)}`;
      restoreCmd = `${reader} | PGPASSWORD="$MCP_BACKUP_PASS" ${parts.join(' ')}`;
      envPrefix = envFor(password);
      break;
    }
    case 'mongodb': {
      const uri = buildMongoUri({ user, password, host, port, database: meta.database });
      envPrefix = `MCP_BACKUP_URI=${shQuote(uri)} `;
      const parts = ['mongorestore', '--uri', '"$MCP_BACKUP_URI"', '--archive=' + '"$MCP_BACKUP_ARCHIVE"'];
      if (meta.compressed) parts.push('--gzip');
      // Pass archive path via env too to keep argv clean of user-controlled bytes.
      envPrefix += `MCP_BACKUP_ARCHIVE=${shQuote(meta.output_path)} `;
      restoreCmd = parts.join(' ');
      break;
    }
    case 'files': {
      const target = target_path || '/';
      const flag = meta.compressed ? '-xzf' : '-xf';
      restoreCmd = `tar ${flag} ${shQuote(meta.output_path)} -C ${shQuote(target)}`;
      break;
    }
    default:
      return toMcp(fail('ssh_backup_restore', `unsupported backup_type in meta: ${meta.backup_type}`, { server }), { format });
  }

  let r;
  try { r = await streamExecCommand(client, envPrefix + restoreCmd, { timeoutMs: timeout }); }
  catch (e) {
    return toMcp(fail('ssh_backup_restore', `restore exec failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  if (r.code !== 0) {
    return toMcp(fail('ssh_backup_restore',
      `restore exited ${r.code}: ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`,
      { server, duration_ms: Date.now() - startedAt }), { format });
  }

  return toMcp(
    ok('ssh_backup_restore', {
      backup_id: meta.backup_id,
      backup_type: meta.backup_type,
      restored_from: meta.output_path,
      sha256_verified: !!(verify && meta.sha256),
      sha256: meta.sha256 || null,
      target_path: target_path || null,
      database: meta.database || null,
    }, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderBackupRestore },
  );
}

function renderBackupRestore(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const meta = result.meta || {};
  const dur = meta.duration_ms != null ? ` | \`${formatDuration(meta.duration_ms)}\`` : '';
  const lines = [];
  lines.push(`[ok] **ssh_backup_restore** | \`${result.server}\` | \`${d.backup_type}\`${dur}`);
  lines.push(`from: \`${d.restored_from}\``);
  if (d.target_path) lines.push(`target: \`${d.target_path}\``);
  if (d.database) lines.push(`database: \`${d.database}\``);
  lines.push(`sha256 verified: **${d.sha256_verified ? 'yes' : 'no'}**`);
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// ssh_backup_schedule -- append a cron entry that invokes the same backup
// command as handleSshBackupCreate.
// --------------------------------------------------------------------------
export async function handleSshBackupSchedule({ getConnection, args }) {
  const {
    server,
    backup_type,
    cron,
    database = null,
    paths = null,
    user = null,
    password = '',
    host = null,
    port = null,
    gzip = true,
    backup_dir = DEFAULT_BACKUP_DIR,
    format = 'markdown',
    preview: isPreview = false,
    timeout = 30_000,
  } = args || {};

  if (!server) return toMcp(fail('ssh_backup_schedule', 'server is required'), { format });
  if (!VALID_TYPES.has(backup_type)) {
    return toMcp(fail('ssh_backup_schedule', `invalid backup_type: ${backup_type}`, { server }), { format });
  }
  if (!cron || typeof cron !== 'string' || cron.trim().split(/\s+/).length < 5) {
    return toMcp(fail('ssh_backup_schedule', 'cron is required (e.g. "0 2 * * *")', { server }), { format });
  }

  // Refuse to schedule if a password was passed -- writing it into crontab
  // would persist the secret in plaintext (readable to anyone who gains the
  // user's shell) and contradicts the "passwords never in argv/storage"
  // invariant the rest of this server holds. Callers must pre-populate
  // ~/.my.cnf / ~/.pgpass / PGPASSFILE on the target host.
  if (password && (backup_type === 'mysql' || backup_type === 'postgresql' || backup_type === 'mongodb')) {
    return toMcp(fail('ssh_backup_schedule',
      'refusing to embed password in crontab. Pre-configure credentials on the target host ' +
      '(~/.my.cnf for mysql, ~/.pgpass or PGPASSFILE for postgresql, URI without password for ' +
      'mongodb) and omit the password argument.',
      { server }), { format });
  }

  // Build the backup command that cron will run. Output path is templated with
  // $(date) so each run produces a distinct artifact. envPrefix is now empty
  // because we reject password up front -- if that invariant ever changes,
  // this is the place to carefully route the secret to a secured file.
  const targetName = backup_type === 'files'
    ? ((paths && paths[0]) || 'files').replace(/^\//, '').replace(/\//g, '_') || 'files'
    : database || backup_type;
  const scheduledOutTemplate = `${backup_dir}/${backup_type}_${String(targetName).replace(/[^A-Za-z0-9._-]+/g, '_')}_$(date +\\%Y\\%m\\%d_\\%H\\%M\\%S).${backup_type === 'files' ? (gzip ? 'tar.gz' : 'tar') : (gzip ? 'gz' : 'sql')}`;

  let cmdBundle;
  try {
    cmdBundle = buildBackupCommand({
      backup_type, database, paths, user, password: undefined, host, port,
      outputPath: scheduledOutTemplate, gzip,
    });
  } catch (e) {
    return toMcp(fail('ssh_backup_schedule', e.message || String(e), { server }), { format });
  }

  if (cmdBundle.envPrefix) {
    // Defense in depth: buildBackupCommand returned a non-empty envPrefix even
    // though we passed password=undefined. Bail rather than write something
    // surprising to crontab.
    return toMcp(fail('ssh_backup_schedule',
      'internal: build returned secret env prefix; refusing to install cron line',
      { server }), { format });
  }

  const fullCmd = cmdBundle.command;
  const marker = `# claude-code-ssh-backup:${backup_type}:${targetName}`;
  const cronLine = `${cron.trim()} ${fullCmd} ${marker}`;

  if (isPreview) {
    const plan = buildPlan({
      action: 'backup-schedule',
      target: `${server}:crontab`,
      effects: [
        `cron: \`${cron.trim()}\``,
        `backup_type: \`${backup_type}\``,
        backup_type === 'files'
          ? `paths: ${(paths || []).map(p => `\`${p}\``).join(', ')}`
          : `database: \`${database}\``,
        `output template: \`${scheduledOutTemplate}\``,
        'appends to user crontab; other entries preserved',
        'credentials must be pre-configured on host (~/.my.cnf, ~/.pgpass, PGPASSFILE, or URI)',
      ],
      reversibility: 'manual',
      risk: 'medium',
      cron_line: cronLine,
      full_command: fullCmd,
    });
    return toMcp(preview('ssh_backup_schedule', plan, { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_backup_schedule', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // Append the cron line via (crontab -l; echo LINE) | crontab -
  // shQuote the entire cron line to keep it intact.
  const installCmd = `(crontab -l 2>/dev/null; printf '%s\\n' ${shQuote(cronLine)}) | crontab -`;
  let r;
  try { r = await streamExecCommand(client, installCmd, { timeoutMs: timeout }); }
  catch (e) {
    return toMcp(fail('ssh_backup_schedule', `cron install failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  if (r.code !== 0) {
    return toMcp(fail('ssh_backup_schedule',
      `crontab exited ${r.code}: ${(r.stderr || '').trim() || 'unknown error'}`,
      { server, duration_ms: Date.now() - startedAt }), { format });
  }

  return toMcp(
    ok('ssh_backup_schedule', {
      cron: cron.trim(),
      cron_line: cronLine,
      marker,
      backup_type,
      database: database || null,
      paths: paths || null,
      output_template: scheduledOutTemplate,
    }, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderBackupSchedule },
  );
}

function renderBackupSchedule(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const meta = result.meta || {};
  const dur = meta.duration_ms != null ? ` | \`${formatDuration(meta.duration_ms)}\`` : '';
  const lines = [];
  lines.push(`[ok] **ssh_backup_schedule** | \`${result.server}\` | \`${d.backup_type}\`${dur}`);
  lines.push(`cron: \`${d.cron}\``);
  lines.push(`output template: \`${d.output_template}\``);
  lines.push(`marker: \`${d.marker}\``);
  return lines.join('\n');
}
