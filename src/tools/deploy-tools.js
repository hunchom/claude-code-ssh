/**
 * ssh_deploy -- declarative, atomic-ish deploy with optional rollback.
 *
 * Single tool: handleSshDeploy({ getConnection, getSftp, args }).
 *
 * Args:
 *   {
 *     server: string,
 *     artifact_local_path: string,        // file on the orchestrator host
 *     target_path: string,                // where it lands on the remote
 *     post_hooks?: string[],              // commands run AFTER upload, in order
 *     health_check?: string,              // command; non-zero exit = unhealthy
 *     rollback_on_fail?: boolean (true),  // move snapshot back if unhealthy
 *     rollback_hook?: string,             // optional: command to run post-rollback
 *     preview?: boolean,
 *     format?: 'markdown' | 'json' | 'both',
 *   }
 *
 * Execution order:
 *   1. stat target_path (record exists/new, size)
 *   2. if exists: cp -p target_path target_path.mcp.deploy.prev    (snapshot)
 *   3. sftp fastPut artifact_local_path -> target_path              (atomic-ish)
 *   4. for each post_hook (in order): execute; abort on first failure
 *   5. if health_check given: execute; non-zero -> unhealthy
 *   6. on any post-upload failure and rollback_on_fail:true:
 *        mv target_path.mcp.deploy.prev -> target_path             (restore)
 *        run rollback_hook if provided
 *
 * Rollback semantics (important design notes):
 *   - We take a LOCAL SNAPSHOT on the remote host (cp -p, preserves mode/mtime).
 *     Path: `${target_path}.mcp.deploy.prev`. The previous snapshot is
 *     overwritten on each deploy -- only the immediately-previous version is
 *     retained. Callers who need history should take their own backup first.
 *   - If target_path didn't exist before the deploy (new file), rollback
 *     deletes target_path instead of restoring a snapshot that doesn't exist.
 *   - post_hook failures AND health_check failures BOTH trigger rollback when
 *     rollback_on_fail is true. This matches operator expectation: "if anything
 *     went wrong after I put the new bytes down, put the old bytes back."
 *   - `rollback_on_fail: false` deliberately leaves the broken deploy in place
 *     for forensics -- the snapshot is still kept at `.mcp.deploy.prev`.
 *   - Returns `rolled_back: true` when we actually moved the snapshot back.
 *
 * The returned wire payload is deterministic so callers can automate:
 *   {
 *     deployed: bool,                   // final target was the new artifact
 *     rolled_back: bool,                // we restored the snapshot
 *     artifact_sha256,
 *     artifact_bytes,
 *     prev_snapshot_path,               // where the snapshot lives now (or "")
 *     target_existed_before: bool,
 *     hook_results: [{command, exit_code, stdout, stderr, duration_ms}],
 *     health_check_exit_code: number | null,
 *     duration_ms,
 *   }
 */

import crypto from 'crypto';
import fs from 'fs';
import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatBytes, formatDuration } from '../output-formatter.js';

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;

const SNAPSHOT_SUFFIX = '.mcp.deploy.prev';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function sha256File(localPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(localPath);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function localSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return null; }
}

function promisifyGetSftp(client, getSftp) {
  // Support either an injected getSftp(client)->Promise<sftp> or the raw
  // ssh2 Client with client.sftp(cb).
  if (typeof getSftp === 'function') return getSftp(client);
  return new Promise((resolve, reject) => {
    if (typeof client.sftp !== 'function') {
      return reject(new Error('client does not expose sftp()'));
    }
    client.sftp((err, sftp) => err ? reject(err) : resolve(sftp));
  });
}

function sftpFastPut(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => err ? reject(err) : resolve());
  });
}

/**
 * stat remote path -> { exists, size, mtime } or { exists: false }.
 */
async function remoteStat(client, path) {
  const cmd = `stat -c '%s %Y' ${shQuote(path)} 2>/dev/null || echo MISSING`;
  const r = await streamExecCommand(client, cmd, { timeoutMs: 15_000 });
  const out = String(r.stdout || '').trim();
  if (!out || out === 'MISSING') return { exists: false, size: null, mtime: null };
  const [s, m] = out.split(/\s+/);
  return { exists: true, size: Number(s), mtime: Number(m) };
}

// --------------------------------------------------------------------------
// ssh_deploy
// --------------------------------------------------------------------------
export async function handleSshDeploy({ getConnection, getSftp, args }) {
  const {
    server,
    artifact_local_path,
    target_path,
    post_hooks = [],
    health_check = null,
    rollback_on_fail = true,
    rollback_hook = null,
    format = 'markdown',
    preview: isPreview = false,
    hook_timeout = DEFAULT_HOOK_TIMEOUT_MS,
    health_timeout = DEFAULT_HEALTH_TIMEOUT_MS,
    upload_timeout = DEFAULT_UPLOAD_TIMEOUT_MS,
  } = args || {};

  if (!server) return toMcp(fail('ssh_deploy', 'server is required'), { format });
  if (!artifact_local_path) return toMcp(fail('ssh_deploy', 'artifact_local_path is required', { server }), { format });
  if (!target_path) return toMcp(fail('ssh_deploy', 'target_path is required', { server }), { format });
  if (!Array.isArray(post_hooks)) {
    return toMcp(fail('ssh_deploy', 'post_hooks must be an array of strings', { server }), { format });
  }

  const snapshotPath = `${target_path}${SNAPSHOT_SUFFIX}`;

  // Local artifact must exist up front -- fail fast.
  let artifactBytes = null;
  try {
    const st = fs.statSync(artifact_local_path);
    artifactBytes = st.size;
  } catch (e) {
    // In preview we still allow non-existent local file; the plan will call it out.
    if (!isPreview) {
      return toMcp(fail('ssh_deploy', `artifact not accessible: ${e.message || e}`, { server }), { format });
    }
  }

  // --- PREVIEW ---------------------------------------------------------
  if (isPreview) {
    // Best-effort remote stat
    let stat = { exists: false, size: null };
    try {
      const client = await getConnection(server);
      stat = await remoteStat(client, target_path);
    } catch (_) { /* ignore -- preview never fails on connection */ }

    const effects = [
      `uploads \`${artifact_local_path}\` -> \`${target_path}\``,
      `artifact size: ${artifactBytes != null ? formatBytes(artifactBytes) : 'unknown'}`,
      stat.exists
        ? `target exists (${formatBytes(stat.size || 0)}) -- snapshot to \`${snapshotPath}\``
        : 'target does not exist -- new file',
    ];
    if (post_hooks.length) {
      effects.push(`post_hooks (${post_hooks.length}, sequential):`);
      for (const h of post_hooks) effects.push(`  * \`${h}\``);
    } else {
      effects.push('no post_hooks');
    }
    if (health_check) effects.push(`health_check: \`${health_check}\``);
    effects.push(`rollback_on_fail: ${rollback_on_fail ? 'enabled' : 'disabled'}`);
    if (rollback_hook) effects.push(`rollback_hook: \`${rollback_hook}\``);

    const plan = buildPlan({
      action: 'deploy',
      target: `${server}:${target_path}`,
      effects,
      reversibility: rollback_on_fail ? 'auto' : 'manual',
      risk: 'high',
      estimated_duration_ms: null,
      target_stat: stat,
      snapshot_path: snapshotPath,
    });
    return toMcp(preview('ssh_deploy', plan, { server }), { format });
  }

  // --- ACTUAL DEPLOY ---------------------------------------------------
  const startedAt = Date.now();

  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_deploy', `connection failed: ${e.message || e}`, { server }), { format });
  }

  // 1. Stat the target
  let statBefore;
  try { statBefore = await remoteStat(client, target_path); }
  catch (e) {
    return toMcp(fail('ssh_deploy', `stat failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }

  // 2. Snapshot if exists (cp -p preserves mode+times; -f overwrites old snapshot)
  if (statBefore.exists) {
    const snapCmd = `cp -pf ${shQuote(target_path)} ${shQuote(snapshotPath)}`;
    let snapR;
    try { snapR = await streamExecCommand(client, snapCmd, { timeoutMs: 60_000 }); }
    catch (e) {
      return toMcp(fail('ssh_deploy', `snapshot failed: ${e.message || e}`, {
        server, duration_ms: Date.now() - startedAt,
      }), { format });
    }
    if (snapR.code !== 0) {
      return toMcp(fail('ssh_deploy',
        `snapshot exited ${snapR.code}: ${(snapR.stderr || '').trim() || 'unknown error'}`,
        { server, duration_ms: Date.now() - startedAt }), { format });
    }
  }

  // Compute artifact sha256 up front (in parallel with SFTP init).
  const sha256Promise = sha256File(artifact_local_path);

  // 3. Upload
  let sftp;
  try { sftp = await promisifyGetSftp(client, getSftp); }
  catch (e) {
    return toMcp(fail('ssh_deploy', `sftp init failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }

  const uploadTimer = withTimeout(
    sftpFastPut(sftp, artifact_local_path, target_path),
    upload_timeout,
    `upload timeout after ${upload_timeout}ms`,
  );
  try { await uploadTimer; }
  catch (e) {
    try { sftp.end(); } catch (_) { /* already closed */ }
    return toMcp(fail('ssh_deploy', `upload failed: ${e.message || e}`, {
      server, duration_ms: Date.now() - startedAt,
    }), { format });
  }
  // Best-effort SFTP close: ssh2 GCs on connection end, but each open consumes
  // a channel slot (default OpenSSH MaxSessions=10).
  try { sftp.end(); } catch (_) { /* already closed */ }

  const artifactSha256 = await sha256Promise.catch(() => null);

  // 4. Post-hooks -- sequential, abort on first failure.
  const hookResults = [];
  let firstFailure = null; // { phase, reason }
  for (const hook of post_hooks) {
    const t0 = Date.now();
    let hr;
    try { hr = await streamExecCommand(client, hook, { timeoutMs: hook_timeout }); }
    catch (e) {
      hookResults.push({
        command: hook, exit_code: -1,
        stdout: '', stderr: String(e.message || e),
        duration_ms: Date.now() - t0,
      });
      firstFailure = { phase: 'post_hook', reason: `hook errored: ${e.message || e}`, hook };
      break;
    }
    hookResults.push({
      command: hook, exit_code: hr.code,
      stdout: hr.stdout, stderr: hr.stderr,
      duration_ms: Date.now() - t0,
    });
    if (hr.code !== 0) {
      firstFailure = { phase: 'post_hook', reason: `hook exited ${hr.code}`, hook };
      break;
    }
  }

  // 5. Health check -- only if all post-hooks passed.
  let healthCheckExit = null;
  let healthStderr = '';
  if (!firstFailure && health_check) {
    try {
      const hr = await streamExecCommand(client, health_check, { timeoutMs: health_timeout });
      healthCheckExit = hr.code;
      healthStderr = hr.stderr || '';
      if (hr.code !== 0) {
        firstFailure = { phase: 'health_check', reason: `health_check exited ${hr.code}`, hook: health_check };
      }
    } catch (e) {
      healthCheckExit = -1;
      healthStderr = String(e.message || e);
      firstFailure = { phase: 'health_check', reason: `health_check errored: ${e.message || e}`, hook: health_check };
    }
  }

  // 6. Rollback path
  let rolledBack = false;
  let rollbackError = null;
  let rollbackHookResult = null;
  if (firstFailure && rollback_on_fail) {
    // If target existed, move snapshot back. Else delete the new artifact.
    let restoreCmd;
    if (statBefore.exists) {
      restoreCmd = `mv -f ${shQuote(snapshotPath)} ${shQuote(target_path)}`;
    } else {
      restoreCmd = `rm -f ${shQuote(target_path)}`;
    }
    let rb;
    try { rb = await streamExecCommand(client, restoreCmd, { timeoutMs: 60_000 }); }
    catch (e) { rollbackError = e.message || String(e); }
    if (rb && rb.code !== 0) {
      rollbackError = `rollback exited ${rb.code}: ${(rb.stderr || '').trim() || 'unknown error'}`;
    }
    if (!rollbackError) rolledBack = true;

    // Optional rollback hook (runs regardless of rollback success, so operators
    // can alert/notify even if restore failed).
    if (rollback_hook) {
      const t0 = Date.now();
      try {
        const rh = await streamExecCommand(client, rollback_hook, { timeoutMs: hook_timeout });
        rollbackHookResult = {
          command: rollback_hook, exit_code: rh.code,
          stdout: rh.stdout, stderr: rh.stderr,
          duration_ms: Date.now() - t0,
        };
      } catch (e) {
        rollbackHookResult = {
          command: rollback_hook, exit_code: -1,
          stdout: '', stderr: String(e.message || e),
          duration_ms: Date.now() - t0,
        };
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const deployed = !firstFailure;  // success: nothing failed after upload
  const data = {
    deployed,
    rolled_back: rolledBack,
    artifact_local_path,
    target_path,
    artifact_bytes: artifactBytes,
    artifact_sha256: artifactSha256,
    prev_snapshot_path: statBefore.exists ? snapshotPath : '',
    target_existed_before: statBefore.exists,
    hook_results: hookResults,
    health_check_exit_code: healthCheckExit,
    rollback_hook_result: rollbackHookResult,
    rollback_error: rollbackError,
    failure: firstFailure,
    duration_ms: durationMs,
  };

  if (firstFailure) {
    // We keep `data` on the failure payload so callers can inspect hook_results,
    // rolled_back, snapshot path, etc. -- fail() nulls `data`, so we build the
    // result by hand.
    const failureResult = {
      success: false,
      tool: 'ssh_deploy',
      server,
      data,
      meta: { duration_ms: durationMs },
      error: `deploy failed at ${firstFailure.phase}: ${firstFailure.reason}${rolledBack ? ' (rolled back)' : ''}`,
    };
    return toMcp(failureResult, { format, renderer: renderDeploy });
  }

  return toMcp(
    ok('ssh_deploy', data, { server, duration_ms: durationMs }),
    { format, renderer: renderDeploy },
  );
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function renderDeploy(result) {
  const d = result.data || result.meta || {};
  const meta = result.meta || {};
  const dur = meta.duration_ms != null ? ` | \`${formatDuration(meta.duration_ms)}\`` : '';
  const marker = result.success ? '[ok]' : '[err]';
  const lines = [];
  lines.push(`${marker} **ssh_deploy** | \`${result.server || '?'}\`${dur}`);

  if (!result.success) {
    lines.push(`**failed**: ${result.error || 'unknown'}`);
  }

  const targetPath = d.target_path || meta.target_path;
  if (targetPath) lines.push(`target: \`${targetPath}\``);
  if (d.artifact_sha256) {
    lines.push(`artifact: ${formatBytes(d.artifact_bytes || 0)} | sha256 \`${String(d.artifact_sha256).slice(0, 16)}...\``);
  }
  lines.push(`deployed: **${d.deployed ? 'yes' : 'no'}** | rolled_back: **${d.rolled_back ? 'yes' : 'no'}**`);
  if (d.prev_snapshot_path) lines.push(`snapshot: \`${d.prev_snapshot_path}\``);
  if (Array.isArray(d.hook_results) && d.hook_results.length) {
    lines.push('');
    lines.push('**post_hooks:**');
    for (const h of d.hook_results) {
      const m = h.exit_code === 0 ? '[ok]' : '[err]';
      lines.push(`${m} \`${h.command}\` -- exit ${h.exit_code} | \`${formatDuration(h.duration_ms)}\``);
    }
  }
  if (d.health_check_exit_code != null) {
    lines.push('');
    lines.push(`health_check exit: **${d.health_check_exit_code}**`);
  }
  if (d.rollback_hook_result) {
    lines.push(`rollback_hook: \`${d.rollback_hook_result.command}\` -- exit ${d.rollback_hook_result.exit_code}`);
  }
  if (d.rollback_error) {
    lines.push(`> rollback error: ${d.rollback_error}`);
  }
  return lines.join('\n');
}
