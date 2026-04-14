/**
 * Transfer & edit tools: ssh_upload, ssh_download, ssh_sync, ssh_diff, ssh_edit.
 *
 * All handlers are pure: `async ({getConnection, [getServerConfig,] args}) → {content, isError?}`.
 *
 * Design notes:
 *   - ssh_upload/ssh_download go through ssh2 SFTP (fastPut/fastGet). Optional sha256
 *     verification hashes the remote file post-transfer and the local file and
 *     returns a structured {verified: bool} in addition to the bytes transferred.
 *   - ssh_sync shells out to rsync via child_process.spawn, streaming progress
 *     through onChunk. It does not try to reimplement rsync — just translates
 *     args into a safe argv.
 *   - ssh_diff runs `diff -u A B` remotely when both paths live on the same server.
 *     For the cross-server case, both remote files are fetched to tmp locally and
 *     diffed locally via child_process.spawn('diff').
 *   - ssh_edit performs a fully atomic in-place edit:
 *         tmp write (base64-decoded)  →  optional syntax check  →  cp -p backup  →
 *         mv tmp original  →  diff -u backup original.
 *     If the syntax check fails the tmp file is deleted and nothing else touches
 *     the original. The backup path is always returned so the user can roll back
 *     with a single mv.
 *
 * All shell-interpolated tokens run through shQuote(); numeric args coerce via
 * `Math.floor(Number(x)) || safeDefault`; path strings are never interpolated
 * naked into a shell command.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatBytes, formatDuration } from '../output-formatter.js';

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Promisified ssh2 sftp() — resolves with the sftp subsystem handle.
 */
function getSftpChannel(client) {
  return new Promise((resolve, reject) => {
    if (typeof client.sftp !== 'function') {
      return reject(new Error('ssh client does not expose sftp()'));
    }
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => err ? reject(err) : resolve());
  });
}

/**
 * Compute sha256 of a local file. Streams, so fine on larger files.
 */
function sha256File(localPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(localPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Run `sha256sum REMOTE | awk '{print $1}'` remotely.
 * Returns the hex digest or throws on non-zero exit.
 */
async function remoteSha256(client, remotePath) {
  const cmd = `sha256sum ${shQuote(remotePath)} | awk '{print $1}'`;
  const r = await streamExecCommand(client, cmd, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    throw new Error(`remote sha256 failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`);
  }
  return (r.stdout || '').trim();
}

/**
 * Stat a remote path — returns a human line or "new file" if stat fails.
 */
async function remoteStatLine(client, remotePath) {
  const cmd = `stat -c '%s %Y' ${shQuote(remotePath)} 2>/dev/null || echo "new file"`;
  const r = await streamExecCommand(client, cmd, { timeoutMs: 15_000 });
  return (r.stdout || '').trim() || 'new file';
}

/**
 * Build base64-encoded content of a Buffer or string. Safe for any bytes.
 */
function encodeBase64(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return buf.toString('base64');
}

/**
 * Pick a syntax-checker command for a file path, or null if none.
 * Uses python3 -c for json/yaml (portable, no toolchain install needed) and
 * `nginx -t -c` for nginx configs (path heuristic).
 */
function pickSyntaxChecker(filePath, override) {
  if (override === 'none' || override === false) return null;
  if (override && typeof override === 'string' && override !== 'auto') {
    // explicit override — return as-is, command must accept the tmp path as $1
    return { kind: override, build: (tmp) => `${override} ${shQuote(tmp)}` };
  }
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.json')) {
    return {
      kind: 'json',
      build: (tmp) =>
        `python3 -c 'import json,sys;json.load(open(sys.argv[1]))' ${shQuote(tmp)}`,
    };
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return {
      kind: 'yaml',
      build: (tmp) =>
        `python3 -c 'import yaml,sys;yaml.safe_load(open(sys.argv[1]))' ${shQuote(tmp)}`,
    };
  }
  if (lower.endsWith('.conf') && lower.includes('nginx')) {
    return { kind: 'nginx', build: (tmp) => `nginx -t -c ${shQuote(tmp)}` };
  }
  return null;
}

/**
 * Apply `patch` regex rules to a string. Each rule: {find, replace, flags?}.
 * find is treated as a regex pattern (user supplies anchors/escapes).
 */
function applyPatches(current, patches) {
  let out = String(current);
  for (const p of patches || []) {
    if (!p || typeof p.find !== 'string') continue;
    const flags = typeof p.flags === 'string' ? p.flags : 'g';
    const re = new RegExp(p.find, flags);
    out = out.replace(re, p.replace != null ? String(p.replace) : '');
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_upload
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshUpload({ getConnection, args }) {
  const {
    server,
    local_path,
    remote_path,
    verify = true,
    preview: isPreview = false,
    format = 'markdown',
  } = args || {};

  if (!server || !local_path || !remote_path) {
    return toMcp(fail('ssh_upload', 'server, local_path, remote_path are required', { server }), { format });
  }

  // Preview: never touch the remote beyond a stat
  if (isPreview) {
    let stat = 'unknown';
    let localSize = null;
    try {
      const st = fs.statSync(local_path);
      localSize = st.size;
    } catch (_) { /* local may not exist — still preview */ }

    try {
      const client = await getConnection(server);
      stat = await remoteStatLine(client, remote_path);
    } catch (e) {
      stat = `unknown (${e.message || e})`;
    }

    const plan = buildPlan({
      action: 'upload',
      target: `${server}:${remote_path}`,
      effects: [
        `uploads \`${local_path}\` → \`${remote_path}\``,
        `remote stat: ${stat}`,
        verify ? 'post-transfer sha256 verification enabled' : 'no verification',
      ],
      reversibility: 'manual',
      risk: 'medium',
      local_bytes: localSize,
      remote_stat: stat,
    });
    return toMcp(preview('ssh_upload', plan, { server }), { format });
  }

  // Validate local file up front
  let localSize;
  try {
    const st = fs.statSync(local_path);
    localSize = st.size;
  } catch (e) {
    return toMcp(fail('ssh_upload', `local file not accessible: ${e.message || e}`, { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_upload', `connection failed: ${e.message || e}`, { server }), { format });
  }

  let sftp;
  try { sftp = await getSftpChannel(client); }
  catch (e) {
    return toMcp(fail('ssh_upload', `sftp init failed: ${e.message || e}`, { server }), { format });
  }

  try {
    await sftpFastPut(sftp, local_path, remote_path);
  } catch (e) {
    return toMcp(fail('ssh_upload', `upload failed: ${e.message || e}`, { server }), { format });
  }

  const data = {
    local_path,
    remote_path,
    uploaded_bytes: localSize,
    verified: false,
    local_sha256: null,
    remote_sha256: null,
  };

  if (verify) {
    try {
      const [localHash, remoteHash] = await Promise.all([
        sha256File(local_path),
        remoteSha256(client, remote_path),
      ]);
      data.local_sha256 = localHash;
      data.remote_sha256 = remoteHash;
      data.verified = localHash === remoteHash;
      if (!data.verified) {
        return toMcp(fail('ssh_upload',
          `checksum mismatch: local=${localHash} remote=${remoteHash}`,
          { server, duration_ms: Date.now() - startedAt }), { format });
      }
    } catch (e) {
      return toMcp(fail('ssh_upload', `verification failed: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format });
    }
  }

  return toMcp(
    ok('ssh_upload', data, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderTransferMarkdown('ssh_upload') }
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_download
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshDownload({ getConnection, args }) {
  const {
    server,
    remote_path,
    local_path,
    verify = true,
    preview: isPreview = false,
    format = 'markdown',
  } = args || {};

  if (!server || !remote_path || !local_path) {
    return toMcp(fail('ssh_download', 'server, remote_path, local_path are required', { server }), { format });
  }

  if (isPreview) {
    let stat = 'unknown';
    try {
      const client = await getConnection(server);
      stat = await remoteStatLine(client, remote_path);
    } catch (e) {
      stat = `unknown (${e.message || e})`;
    }

    const plan = buildPlan({
      action: 'download',
      target: `${server}:${remote_path}`,
      effects: [
        `downloads \`${remote_path}\` → \`${local_path}\``,
        `remote stat: ${stat}`,
        verify ? 'post-transfer sha256 verification enabled' : 'no verification',
      ],
      reversibility: 'manual',
      risk: 'low',
      remote_stat: stat,
    });
    return toMcp(preview('ssh_download', plan, { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_download', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // Grab the remote hash *before* the transfer. If the file changes mid-flight
  // we still compare the local copy to what was present at the moment we
  // started reading, which is the strongest claim we can make.
  let remoteHash = null;
  if (verify) {
    try { remoteHash = await remoteSha256(client, remote_path); }
    catch (e) {
      return toMcp(fail('ssh_download', `remote hash failed: ${e.message || e}`, { server }), { format });
    }
  }

  let sftp;
  try { sftp = await getSftpChannel(client); }
  catch (e) {
    return toMcp(fail('ssh_download', `sftp init failed: ${e.message || e}`, { server }), { format });
  }

  try {
    await sftpFastGet(sftp, remote_path, local_path);
  } catch (e) {
    return toMcp(fail('ssh_download', `download failed: ${e.message || e}`, { server }), { format });
  }

  let downloadedBytes = 0;
  try { downloadedBytes = fs.statSync(local_path).size; } catch (_) { /* ignore */ }

  const data = {
    remote_path,
    local_path,
    uploaded_bytes: downloadedBytes, // keep symmetry field-wise
    downloaded_bytes: downloadedBytes,
    verified: false,
    local_sha256: null,
    remote_sha256: remoteHash,
  };

  if (verify) {
    try {
      const localHash = await sha256File(local_path);
      data.local_sha256 = localHash;
      data.verified = localHash === remoteHash;
      if (!data.verified) {
        return toMcp(fail('ssh_download',
          `checksum mismatch: local=${localHash} remote=${remoteHash}`,
          { server, duration_ms: Date.now() - startedAt }), { format });
      }
    } catch (e) {
      return toMcp(fail('ssh_download', `verification failed: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format });
    }
  }

  return toMcp(
    ok('ssh_download', data, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderTransferMarkdown('ssh_download') }
  );
}

function renderTransferMarkdown(tool) {
  return function render(result) {
    if (!result.success) return defaultRender(result);
    const d = result.data;
    const meta = result.meta || {};
    const lines = [];
    const duration = meta.duration_ms != null ? `  ·  \`${formatDuration(meta.duration_ms)}\`` : '';
    lines.push(`▶ **${tool}**  ·  \`${result.server || '?'}\`${duration}`);
    if (tool === 'ssh_upload') {
      lines.push(`\`${d.local_path}\` → \`${d.remote_path}\``);
      lines.push(`bytes: **${formatBytes(d.uploaded_bytes)}**${d.verified ? '  ·  **verified**' : ''}`);
    } else {
      lines.push(`\`${d.remote_path}\` → \`${d.local_path}\``);
      lines.push(`bytes: **${formatBytes(d.downloaded_bytes)}**${d.verified ? '  ·  **verified**' : ''}`);
    }
    if (d.local_sha256) lines.push(`local sha256: \`${d.local_sha256}\``);
    if (d.remote_sha256) lines.push(`remote sha256: \`${d.remote_sha256}\``);
    return lines.join('\n');
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_sync — rsync via spawn
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build argv for rsync based on args + resolved server config.
 * Exported for unit tests.
 */
export function buildRsyncArgv({ serverConfig, direction, localPath, remotePath, exclude = [], dry_run = false, delete: del = false, compress = true }) {
  const argv = [];
  if (serverConfig && serverConfig.password && !serverConfig.keypath) {
    argv.push('-p', serverConfig.password, 'rsync');
  }
  const opts = compress ? ['-avz'] : ['-av'];
  if (dry_run) opts.push('--dry-run');
  if (del) opts.push('--delete');
  opts.push('--stats');
  for (const pat of exclude) opts.push('--exclude', pat);

  argv.push(...opts);

  const sshOpts = ['-o StrictHostKeyChecking=accept-new', '-o ConnectTimeout=10'];
  if (serverConfig && serverConfig.keypath) {
    sshOpts.unshift('-o BatchMode=yes');
    const keyPath = String(serverConfig.keypath).replace(/^~/, os.homedir());
    sshOpts.push(`-i ${keyPath}`);
  }
  if (serverConfig && serverConfig.port && String(serverConfig.port) !== '22') {
    sshOpts.push(`-p ${serverConfig.port}`);
  }
  argv.push('-e', `ssh ${sshOpts.join(' ')}`);

  const remote = `${serverConfig ? serverConfig.user : 'user'}@${serverConfig ? serverConfig.host : 'host'}:${remotePath}`;
  if (direction === 'push') {
    argv.push(localPath, remote);
  } else {
    argv.push(remote, localPath);
  }
  return argv;
}

export async function handleSshSync({ getConnection, getServerConfig, args }) {
  const {
    server,
    source,
    destination,
    exclude = [],
    dry_run = false,
    delete: del = false,
    compress = true,
    preview: isPreview = false,
    format = 'markdown',
    onChunk,
    timeout = 300_000,
    spawnFn = spawn, // allow injection for tests
  } = args || {};

  if (!server || !source || !destination) {
    return toMcp(fail('ssh_sync', 'server, source, destination are required', { server }), { format });
  }

  const isLocalSource = String(source).startsWith('local:');
  const isRemoteSource = String(source).startsWith('remote:');
  const isLocalDest = String(destination).startsWith('local:');
  const isRemoteDest = String(destination).startsWith('remote:');

  if ((isLocalSource && isLocalDest) || (isRemoteSource && isRemoteDest)) {
    return toMcp(fail('ssh_sync', 'source and destination must be one local + one remote (prefix with local:/remote:)', { server }), { format });
  }

  const cleanSource = String(source).replace(/^(local:|remote:)/, '');
  const cleanDest = String(destination).replace(/^(local:|remote:)/, '');
  const direction = (isLocalSource || (!isLocalSource && !isRemoteSource)) ? 'push' : 'pull';
  const localPath = direction === 'push' ? cleanSource : cleanDest;
  const remotePath = direction === 'push' ? cleanDest : cleanSource;

  if (isPreview) {
    const plan = buildPlan({
      action: 'sync',
      target: `${server}:${remotePath} (${direction})`,
      effects: [
        `rsync ${direction === 'push' ? 'local→remote' : 'remote→local'}`,
        `local: \`${localPath}\``,
        `remote: \`${remotePath}\``,
        exclude.length ? `exclude: ${exclude.join(', ')}` : 'no exclude',
        dry_run ? '--dry-run (rsync will not write)' : 'will write',
        del ? '--delete enabled' : 'no --delete',
      ],
      reversibility: del ? 'irreversible' : 'manual',
      risk: del ? 'high' : 'medium',
    });
    return toMcp(preview('ssh_sync', plan, { server }), { format });
  }

  // Resolve server config (for auth method). Safe default if absent.
  let serverConfig = null;
  if (typeof getServerConfig === 'function') {
    try { serverConfig = await getServerConfig(server); } catch (_) { /* best-effort */ }
  }

  const usePassword = !!(serverConfig && serverConfig.password && !serverConfig.keypath);
  const rsyncCmd = usePassword ? 'sshpass' : 'rsync';
  const rsyncArgs = buildRsyncArgv({ serverConfig, direction, localPath, remotePath, exclude, dry_run, delete: del, compress });

  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let proc;
    try {
      proc = spawnFn(rsyncCmd, rsyncArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(toMcp(fail('ssh_sync', `spawn failed: ${e.message || e}`, { server }), { format }));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }, timeout);

    proc.stdout && proc.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
      if (onChunk) {
        try { onChunk({ kind: 'stdout', text }); } catch (_) { /* swallow */ }
      }
    });
    proc.stderr && proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (stderr.length > 50_000) stderr = stderr.slice(-25_000);
      if (onChunk) {
        try { onChunk({ kind: 'stderr', text }); } catch (_) { /* swallow */ }
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve(toMcp(fail('ssh_sync', `rsync error: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format }));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        return resolve(toMcp(fail('ssh_sync', `rsync timeout after ${timeout}ms`, {
          server, duration_ms: durationMs,
        }), { format }));
      }
      if (code !== 0) {
        return resolve(toMcp(fail('ssh_sync',
          `rsync exited ${code}: ${(stderr || '').trim() || 'unknown error'}`,
          { server, duration_ms: durationMs }), { format }));
      }
      const filesMatch = stdout.match(/Number of (?:regular )?files transferred:\s*([\d,]+)/);
      const sizeMatch = stdout.match(/Total transferred file size:\s*([\d,]+)\s*bytes/);
      const data = {
        direction,
        server,
        local_path: localPath,
        remote_path: remotePath,
        dry_run,
        files_transferred: filesMatch ? parseInt(filesMatch[1].replace(/,/g, ''), 10) : 0,
        bytes_transferred: sizeMatch ? parseInt(sizeMatch[1].replace(/,/g, ''), 10) : 0,
        duration_ms: durationMs,
        rsync_argv: [rsyncCmd, ...rsyncArgs],
      };
      resolve(toMcp(
        ok('ssh_sync', data, { server, duration_ms: durationMs }),
        { format, renderer: renderSyncMarkdown }
      ));
    });
  });
}

function renderSyncMarkdown(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const meta = result.meta || {};
  const lines = [];
  const duration = meta.duration_ms != null ? `  ·  \`${formatDuration(meta.duration_ms)}\`` : '';
  lines.push(`▶ **ssh_sync**  ·  \`${result.server || '?'}\`  ·  \`${d.direction}\`${duration}`);
  lines.push(`\`${d.local_path}\` ${d.direction === 'push' ? '→' : '←'} \`${d.remote_path}\``);
  lines.push(`files: **${d.files_transferred}**  ·  bytes: **${formatBytes(d.bytes_transferred)}**${d.dry_run ? '  ·  **dry run**' : ''}`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_diff
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshDiff({ getConnection, args }) {
  const {
    server,
    path_a,
    path_b,
    server_b,
    format = 'markdown',
    preview: isPreview = false,
  } = args || {};

  if (!server || !path_a || !path_b) {
    return toMcp(fail('ssh_diff', 'server, path_a, path_b are required', { server }), { format });
  }

  if (isPreview) {
    const plan = buildPlan({
      action: 'diff',
      target: server_b
        ? `${server}:${path_a} vs ${server_b}:${path_b}`
        : `${server}:${path_a} vs ${server}:${path_b}`,
      effects: [
        server_b
          ? `downloads both remote files and diffs locally`
          : `runs \`diff -u ${path_a} ${path_b}\` on ${server}`,
      ],
      reversibility: 'auto',
      risk: 'low',
    });
    return toMcp(preview('ssh_diff', plan, { server }), { format });
  }

  const startedAt = Date.now();

  // Cross-server: fetch both files locally, then run `diff` via spawn.
  if (server_b) {
    let clientA, clientB;
    try { clientA = await getConnection(server); }
    catch (e) { return toMcp(fail('ssh_diff', `connect ${server} failed: ${e.message || e}`, { server }), { format }); }
    try { clientB = await getConnection(server_b); }
    catch (e) { return toMcp(fail('ssh_diff', `connect ${server_b} failed: ${e.message || e}`, { server }), { format }); }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdiff-'));
    const tmpA = path.join(tmpDir, 'a');
    const tmpB = path.join(tmpDir, 'b');
    try {
      const sftpA = await getSftpChannel(clientA);
      const sftpB = await getSftpChannel(clientB);
      await sftpFastGet(sftpA, path_a, tmpA);
      await sftpFastGet(sftpB, path_b, tmpB);
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      return toMcp(fail('ssh_diff', `fetch failed: ${e.message || e}`, { server }), { format });
    }

    const diffOut = await spawnDiffLocal(tmpA, tmpB);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    const data = {
      mode: 'cross-server',
      path_a: `${server}:${path_a}`,
      path_b: `${server_b}:${path_b}`,
      stdout: diffOut.stdout,
      stderr: diffOut.stderr,
      exit_code: diffOut.code,
      // exit 0 → identical; exit 1 → differ; exit ≥2 → error
      identical: diffOut.code === 0,
    };
    return toMcp(
      ok('ssh_diff', data, { server, duration_ms: Date.now() - startedAt }),
      { format, renderer: renderDiffMarkdown }
    );
  }

  // Same-server: run diff remotely.
  let client;
  try { client = await getConnection(server); }
  catch (e) { return toMcp(fail('ssh_diff', `connection failed: ${e.message || e}`, { server }), { format }); }

  const cmd = `diff -u ${shQuote(path_a)} ${shQuote(path_b)}`;
  let r;
  try {
    r = await streamExecCommand(client, cmd, { timeoutMs: 60_000 });
  } catch (e) {
    return toMcp(fail('ssh_diff', `diff failed: ${e.message || e}`, { server }), { format });
  }

  const data = {
    mode: 'same-server',
    path_a: `${server}:${path_a}`,
    path_b: `${server}:${path_b}`,
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.code,
    identical: r.code === 0,
  };
  return toMcp(
    ok('ssh_diff', data, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderDiffMarkdown }
  );
}

function spawnDiffLocal(a, b) {
  return new Promise((resolve) => {
    const proc = spawn('diff', ['-u', a, b], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ stdout: '', stderr: String(e.message || e), code: -1 }));
    proc.on('close', (code) => resolve({ stdout, stderr, code: code == null ? -1 : code }));
  });
}

function renderDiffMarkdown(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  const marker = d.identical ? '▶' : '•';
  lines.push(`${marker} **ssh_diff**  ·  \`${d.path_a}\`  vs  \`${d.path_b}\`  ·  ${d.identical ? '**identical**' : '**differ**'}`);
  if (d.stdout) {
    lines.push('');
    lines.push('```diff');
    lines.push(d.stdout);
    lines.push('```');
  }
  if (d.stderr && d.stderr.trim()) {
    lines.push('');
    lines.push('**stderr**');
    lines.push('```text');
    lines.push(d.stderr);
    lines.push('```');
  }
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_edit — atomic remote file edit with optional syntax gate
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshEdit({ getConnection, args }) {
  const {
    server,
    path: filePath,
    new_content,
    patch,
    syntax_check = 'auto',
    preview: isPreview = false,
    format = 'markdown',
  } = args || {};

  if (!server || !filePath) {
    return toMcp(fail('ssh_edit', 'server and path are required', { server }), { format });
  }
  if (new_content == null && !Array.isArray(patch)) {
    return toMcp(fail('ssh_edit', 'either new_content or patch (array) is required', { server }), { format });
  }

  const checker = pickSyntaxChecker(filePath, syntax_check);

  if (isPreview) {
    let stat = 'unknown';
    try {
      const client = await getConnection(server);
      stat = await remoteStatLine(client, filePath);
    } catch (e) {
      stat = `unknown (${e.message || e})`;
    }
    const planSize = new_content != null
      ? Buffer.byteLength(String(new_content), 'utf8')
      : null;
    const plan = buildPlan({
      action: 'edit',
      target: `${server}:${filePath}`,
      effects: [
        new_content != null
          ? `full-replace (${planSize} bytes)`
          : `patch (${(patch || []).length} rules)`,
        `backup: ${filePath}.mcp.bak.TIMESTAMP (preserves mode/owner)`,
        `syntax_check: ${checker ? checker.kind : 'none'}`,
        `remote stat: ${stat}`,
      ],
      reversibility: 'manual',
      risk: 'high',
      remote_stat: stat,
    });
    return toMcp(preview('ssh_edit', plan, { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) { return toMcp(fail('ssh_edit', `connection failed: ${e.message || e}`, { server }), { format }); }

  // 1. Read current content
  let current = '';
  try {
    const r = await streamExecCommand(client, `cat ${shQuote(filePath)}`, { timeoutMs: 30_000 });
    if (r.code !== 0) {
      return toMcp(fail('ssh_edit', `cannot read ${filePath}: ${(r.stderr || '').trim() || `exit ${r.code}`}`, { server }), { format });
    }
    current = r.stdout;
  } catch (e) {
    return toMcp(fail('ssh_edit', `read failed: ${e.message || e}`, { server }), { format });
  }

  // 2. Compute new content
  const nextContent = new_content != null ? String(new_content) : applyPatches(current, patch);
  const encoded = encodeBase64(nextContent);

  // 3. Paths (randomized to avoid TOCTOU collisions)
  const rand = crypto.randomBytes(8).toString('hex');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpPath = `${filePath}.mcp.tmp.${rand}`;
  const backupPath = `${filePath}.mcp.bak.${ts}`;

  // 4. Write tmp via base64 pipe — echoes no raw bytes into the shell.
  //    We stream the base64 blob through `base64 -d` on the remote.
  //    Even for huge files this is safe: argv holds the shell line, stdin
  //    carries the blob. Single fire-and-forget exec keeps things atomic.
  const writeCmd = `set -e; umask 077; base64 -d > ${shQuote(tmpPath)}`;
  try {
    const r = await streamExecCommand(client, writeCmd, {
      timeoutMs: 120_000,
      stdin: encoded,
    });
    if (r.code !== 0) {
      return toMcp(fail('ssh_edit', `write tmp failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`, { server }), { format });
    }
  } catch (e) {
    return toMcp(fail('ssh_edit', `write tmp failed: ${e.message || e}`, { server }), { format });
  }

  // 5. Syntax check (optional). On failure: clean up tmp and abort.
  if (checker) {
    try {
      const r = await streamExecCommand(client, checker.build(tmpPath), { timeoutMs: 30_000 });
      if (r.code !== 0) {
        // rm tmp best-effort
        await streamExecCommand(client, `rm -f ${shQuote(tmpPath)}`, { timeoutMs: 15_000 }).catch(() => {});
        return toMcp(fail('ssh_edit',
          `syntax check (${checker.kind}) failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.code}`}`,
          { server, duration_ms: Date.now() - startedAt, syntax_check: checker.kind }
        ), { format });
      }
    } catch (e) {
      await streamExecCommand(client, `rm -f ${shQuote(tmpPath)}`, { timeoutMs: 15_000 }).catch(() => {});
      return toMcp(fail('ssh_edit', `syntax check error: ${e.message || e}`, { server }), { format });
    }
  }

  // 6. Backup (preserve mode/owner/timestamps via -p) then atomic rename.
  //    Running backup + mv as a single remote command reduces the window
  //    between "old still visible" and "new in place" to a single syscall.
  const swapCmd =
    `set -e; cp -p ${shQuote(filePath)} ${shQuote(backupPath)} && mv ${shQuote(tmpPath)} ${shQuote(filePath)}`;
  try {
    const r = await streamExecCommand(client, swapCmd, { timeoutMs: 30_000 });
    if (r.code !== 0) {
      await streamExecCommand(client, `rm -f ${shQuote(tmpPath)}`, { timeoutMs: 15_000 }).catch(() => {});
      return toMcp(fail('ssh_edit', `swap failed: ${(r.stderr || '').trim() || `exit ${r.code}`}`, { server }), { format });
    }
  } catch (e) {
    await streamExecCommand(client, `rm -f ${shQuote(tmpPath)}`, { timeoutMs: 15_000 }).catch(() => {});
    return toMcp(fail('ssh_edit', `swap error: ${e.message || e}`, { server }), { format });
  }

  // 7. Compute unified diff backup vs new for the response.
  let diffOut = '';
  try {
    const r = await streamExecCommand(client,
      `diff -u ${shQuote(backupPath)} ${shQuote(filePath)} || true`,
      { timeoutMs: 30_000 });
    diffOut = r.stdout;
  } catch (_) { /* diff is best-effort */ }

  const data = {
    path: filePath,
    backup_path: backupPath,
    mode: new_content != null ? 'replace' : 'patch',
    bytes_written: Buffer.byteLength(nextContent, 'utf8'),
    syntax_check: checker ? checker.kind : null,
    diff: diffOut,
  };
  return toMcp(
    ok('ssh_edit', data, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderEditMarkdown }
  );
}

function renderEditMarkdown(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const meta = result.meta || {};
  const duration = meta.duration_ms != null ? `  ·  \`${formatDuration(meta.duration_ms)}\`` : '';
  const lines = [];
  lines.push(`▶ **ssh_edit**  ·  \`${result.server || '?'}\`  ·  \`${d.mode}\`${duration}`);
  lines.push(`\`${d.path}\`  ·  backup: \`${d.backup_path}\`  ·  ${formatBytes(d.bytes_written)}${d.syntax_check ? `  ·  syntax: **${d.syntax_check}** ok` : ''}`);
  if (d.diff) {
    lines.push('');
    lines.push('```diff');
    lines.push(d.diff);
    lines.push('```');
  }
  return lines.join('\n');
}
