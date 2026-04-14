/**
 * ssh_key_manage — rewritten with real fingerprint comparison.
 *
 * Pure helpers:
 *   - sha256Fingerprint(publicKeyBuffer) → 'SHA256:<base64_no_padding>'
 *   - compareFingerprints(stored, current) → { match, stored, current, algorithm }
 *   - parseKnownHostsContent(text) → array of parsed entries
 *   - parseKeyscanOutput(text) → array of live host keys (with computed fingerprints)
 *
 * Handler:
 *   - handleSshKeyManage({getConnection, args}) — list / show / verify / accept / remove / rotate
 *
 * Design notes:
 *   - The OpenSSH canonical fingerprint format is:
 *         SHA256:<base64(sha256(raw_public_key_bytes))>   (no `=` padding)
 *     This matches `ssh-keygen -l -E sha256`. The input Buffer is the same raw
 *     bytes that ssh2 passes as `hashedKey` to hostVerifier, and the same bytes
 *     obtained by base64-decoding column 3 of a known_hosts entry.
 *   - Hashed hosts (lines starting with `|1|<salt>|<hash>`) cannot be un-hashed
 *     without the plaintext; we preserve them verbatim with source:'openssh'
 *     and host: '(hashed)'.
 *   - We do NOT write to the filesystem in preview mode.
 *   - Injection surface: the host argument is passed to `ssh-keyscan` via
 *     child_process.spawn with an argv array — no shell interpolation. It is
 *     also shQuote'd in rendered previews for display safety.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';

const KNOWN_HOSTS_PATH = path.join(os.homedir(), '.ssh', 'known_hosts');
const KNOWN_HOSTS_BACKUP = path.join(os.homedir(), '.ssh', 'known_hosts.mcp-backup');

// Module-level internal store keyed by `${host}:${port}`. Separate from OpenSSH
// known_hosts: lets the MCP track keys accepted during its own lifetime without
// mutating user files unless explicitly asked (accept action).
const internalStore = new Map();

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute the OpenSSH canonical SHA256 fingerprint of a raw public-key buffer.
 * Output: 'SHA256:<base64>' with trailing '=' padding stripped.
 *
 * @param {Buffer|Uint8Array|string} publicKeyBuffer raw ssh public key bytes
 * @returns {string}
 */
export function sha256Fingerprint(publicKeyBuffer) {
  if (publicKeyBuffer == null) {
    throw new Error('sha256Fingerprint: publicKeyBuffer is required');
  }
  const buf = Buffer.isBuffer(publicKeyBuffer)
    ? publicKeyBuffer
    : Buffer.from(publicKeyBuffer);
  const b64 = crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
  return `SHA256:${b64}`;
}

/**
 * Compare two fingerprints in constant-time-ish (Buffer.compare short-circuits
 * on length mismatch but is not timing-sensitive for the remaining bytes; for
 * cryptographic equality this is sufficient because the fingerprints are public
 * data — we're not gating on secrecy, just equality).
 *
 * Arguments may be full 'SHA256:xxx' strings or nullable; returns structured
 * comparison with the algorithm derived from the 'ALG:' prefix (or 'unknown').
 *
 * @param {string|null} stored
 * @param {string|null} current
 * @returns {{match: boolean, stored: string|null, current: string|null, algorithm: string, mismatch_details?: object}}
 */
export function compareFingerprints(stored, current) {
  const sFp = stored == null ? null : String(stored);
  const cFp = current == null ? null : String(current);
  const sAlg = sFp && sFp.includes(':') ? sFp.split(':')[0] : 'unknown';
  const cAlg = cFp && cFp.includes(':') ? cFp.split(':')[0] : 'unknown';
  const algorithm = sAlg === cAlg ? sAlg : `${sAlg}!=${cAlg}`;

  // Both null → vacuous match only if both strictly equal (null).
  if (sFp === null && cFp === null) {
    return { match: true, stored: null, current: null, algorithm: 'unknown' };
  }
  if (sFp === null || cFp === null) {
    return {
      match: false,
      stored: sFp,
      current: cFp,
      algorithm,
      mismatch_details: { reason: sFp === null ? 'no_stored_key' : 'no_current_key' },
    };
  }

  const sBuf = Buffer.from(sFp, 'utf8');
  const cBuf = Buffer.from(cFp, 'utf8');
  // Buffer.compare returns 0 iff equal length AND equal bytes.
  const match = sBuf.length === cBuf.length && Buffer.compare(sBuf, cBuf) === 0;

  const out = { match, stored: sFp, current: cFp, algorithm };
  if (!match) {
    out.mismatch_details = {
      reason: sAlg !== cAlg ? 'algorithm_mismatch' : 'fingerprint_mismatch',
      stored_algorithm: sAlg,
      current_algorithm: cAlg,
    };
  }
  return out;
}

/**
 * Parse a single known_hosts line. Returns null for comments, blanks, malformed.
 *
 * Supported formats:
 *   host[,host2,...]  algorithm  base64key  [comment]
 *   [host]:port       algorithm  base64key
 *   |1|salt|hash      algorithm  base64key            (hashed host — opaque)
 *
 * The returned shape:
 *   { raw, hosts: string[], host: string, port: number, algorithm: string,
 *     base64Key: string, fingerprint: string, hashed: bool }
 */
export function parseKnownHostLine(line) {
  if (line == null) return null;
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Split on whitespace but keep at most 4 fields (hostSpec, alg, key, rest).
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const [hostSpec, algorithm, base64Key] = parts;
  const comment = parts.slice(3).join(' ');

  // Hashed host — can't un-hash, leave opaque.
  const hashed = hostSpec.startsWith('|1|');

  // Multiple hosts can share a line: comma-separated.
  const hostsList = hashed ? [hostSpec] : hostSpec.split(',');
  const primary = hostsList[0];

  // Extract host + port (handles both "[host]:port" and plain "host").
  let host = primary;
  let port = 22;
  const bracketMatch = primary.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = parseInt(bracketMatch[2], 10) || 22;
  }

  // Fingerprint the key (base64 decode → SHA256).
  let fingerprint = null;
  try {
    const keyBytes = Buffer.from(base64Key, 'base64');
    fingerprint = sha256Fingerprint(keyBytes);
  } catch (_) { /* malformed base64 — leave fingerprint null */ }

  return {
    raw: trimmed,
    hosts: hostsList,
    host: hashed ? '(hashed)' : host,
    port,
    algorithm,
    base64Key,
    fingerprint,
    comment,
    hashed,
  };
}

/**
 * Parse a full known_hosts file content into structured entries.
 * Skips comments/blanks and malformed lines.
 */
export function parseKnownHostsContent(text) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map(parseKnownHostLine)
    .filter(Boolean);
}

/**
 * Parse `ssh-keyscan` output. Same per-line format as known_hosts (minus hashes).
 */
export function parseKeyscanOutput(text) {
  return parseKnownHostsContent(text);
}

// ──────────────────────────────────────────────────────────────────────────
// Internal store API
// ──────────────────────────────────────────────────────────────────────────

function storeKey(host, port, algorithm, fingerprint, base64Key) {
  const key = `${host}:${port}`;
  internalStore.set(key, {
    host, port, algorithm, fingerprint, base64Key,
    stored_at: new Date().toISOString(),
  });
}

function readStoredKey(host, port) {
  return internalStore.get(`${host}:${port}`) || null;
}

function deleteStoredKey(host, port) {
  return internalStore.delete(`${host}:${port}`);
}

/** Test-only: flush the internal store between tests. */
export function __resetInternalStore() {
  internalStore.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Live key fetching via ssh-keyscan
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch live host keys via ssh-keyscan. Uses spawn with argv — no shell.
 *
 * @param {string} host
 * @param {number} port
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @param {Function} [opts.runKeyscan] injection point for tests
 *        signature: ({host, port, timeoutMs}) => Promise<string stdout>
 */
export async function fetchLiveKeys(host, port, opts = {}) {
  const { timeoutMs = 10_000, runKeyscan } = opts;

  if (runKeyscan) {
    const stdout = await runKeyscan({ host, port, timeoutMs });
    return parseKeyscanOutput(stdout);
  }

  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn('ssh-keyscan', [
      '-T', String(Math.max(1, Math.floor(timeoutMs / 1000))),
      '-t', 'rsa,ecdsa,ed25519',
      '-p', String(port || 22),
      String(host),
    ]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGINT'); } catch (_) { /* ignore */ }
      reject(new Error(`ssh-keyscan timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`ssh-keyscan exited ${code}: ${err.trim()}`));
      } else {
        resolve(out);
      }
    });
  });
  return parseKeyscanOutput(stdout);
}

// ──────────────────────────────────────────────────────────────────────────
// known_hosts I/O (injectable for tests)
// ──────────────────────────────────────────────────────────────────────────

function defaultFsReadKnownHosts(p) {
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}
function defaultFsWriteKnownHosts(p, content) {
  // Ensure .ssh dir exists with safe perms.
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  fs.writeFileSync(p, content, { mode: 0o600 });
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} ctx
 * @param {Function} [ctx.getServerConfig] (server) => {host, port, ...}
 * @param {Object} [ctx.fsReadKnownHosts]  injected for tests
 * @param {Object} [ctx.fsWriteKnownHosts] injected for tests
 * @param {Function} [ctx.runKeyscan]      injected for tests
 * @param {string}   [ctx.knownHostsPath]  override path (tests)
 * @param {Object}   ctx.args
 */
export async function handleSshKeyManage(ctx = {}) {
  const {
    getServerConfig,
    fsReadKnownHosts = defaultFsReadKnownHosts,
    fsWriteKnownHosts = defaultFsWriteKnownHosts,
    runKeyscan,
    knownHostsPath = KNOWN_HOSTS_PATH,
    args = {},
  } = ctx;

  const {
    action,
    server,
    host: hostArg,
    port: portArg,
    format = 'markdown',
    preview: isPreview = false,
  } = args;

  if (!action) {
    return toMcp(fail('ssh_key_manage', 'action is required'), { format });
  }

  // Resolve target host/port from either direct args or server config lookup.
  async function resolveTarget() {
    if (hostArg) {
      return { host: String(hostArg), port: parseInt(portArg || 22, 10) || 22 };
    }
    if (server && getServerConfig) {
      const cfg = await getServerConfig(server);
      if (!cfg || !cfg.host) throw new Error(`server "${server}" not found or missing host`);
      return { host: String(cfg.host), port: parseInt(cfg.port || 22, 10) || 22 };
    }
    throw new Error('must provide either server or host');
  }

  // ── list ────────────────────────────────────────────────────────────
  if (action === 'list') {
    const text = fsReadKnownHosts(knownHostsPath) || '';
    const openssh = parseKnownHostsContent(text).map(e => ({
      host: e.host,
      port: e.port,
      algorithm: e.algorithm,
      fingerprint: e.fingerprint,
      hashed: e.hashed,
      source: 'openssh',
    }));
    const internal = [];
    for (const entry of internalStore.values()) {
      internal.push({
        host: entry.host,
        port: entry.port,
        algorithm: entry.algorithm,
        fingerprint: entry.fingerprint,
        hashed: false,
        source: 'mcp',
      });
    }
    const data = { known_hosts: [...openssh, ...internal] };
    return toMcp(ok('ssh_key_manage', data), { format });
  }

  // Every other action needs a target.
  let target;
  try { target = await resolveTarget(); }
  catch (e) { return toMcp(fail('ssh_key_manage', e), { format }); }
  const { host, port } = target;

  // Gather stored fingerprints: prefer internal store, fall back to known_hosts.
  function readStoredAll() {
    const out = [];
    const internal = readStoredKey(host, port);
    if (internal) {
      out.push({
        algorithm: internal.algorithm,
        fingerprint: internal.fingerprint,
        base64Key: internal.base64Key,
        source: 'mcp',
      });
    }
    const text = fsReadKnownHosts(knownHostsPath) || '';
    for (const e of parseKnownHostsContent(text)) {
      if (e.hashed) continue; // can't match hashed hosts
      if (e.host === host && e.port === port) {
        out.push({
          algorithm: e.algorithm,
          fingerprint: e.fingerprint,
          base64Key: e.base64Key,
          source: 'openssh',
        });
      }
    }
    return out;
  }

  // ── show / verify (both need live fetch) ────────────────────────────
  if (action === 'show' || action === 'verify') {
    let liveKeys;
    try { liveKeys = await fetchLiveKeys(host, port, { runKeyscan }); }
    catch (e) {
      return toMcp(fail('ssh_key_manage', e, { server: server ?? null }), { format });
    }
    const stored = readStoredAll();

    // For each algorithm present in either side, compare.
    const algos = new Set([
      ...liveKeys.map(k => k.algorithm),
      ...stored.map(s => s.algorithm),
    ]);
    const comparisons = [];
    let allMatch = algos.size > 0;
    for (const alg of algos) {
      const live = liveKeys.find(k => k.algorithm === alg) || null;
      const storedEntry = stored.find(s => s.algorithm === alg) || null;
      const cmp = compareFingerprints(
        storedEntry ? storedEntry.fingerprint : null,
        live ? live.fingerprint : null
      );
      comparisons.push({
        algorithm: alg,
        live_fingerprint: live ? live.fingerprint : null,
        stored_fingerprint: storedEntry ? storedEntry.fingerprint : null,
        stored_source: storedEntry ? storedEntry.source : null,
        match: cmp.match,
        mismatch_details: cmp.mismatch_details,
      });
      if (!cmp.match) allMatch = false;
    }

    const data = {
      host,
      port,
      // Back-compat friendly primary fingerprint (first algorithm).
      live_fingerprint: liveKeys[0] ? liveKeys[0].fingerprint : null,
      stored_fingerprint: stored[0] ? stored[0].fingerprint : null,
      match: allMatch,
      comparisons,
    };
    if (!allMatch) {
      data.mismatch_details = {
        reason: stored.length === 0 ? 'no_stored_key' :
          (liveKeys.length === 0 ? 'no_current_key' : 'fingerprint_mismatch'),
        algorithms_compared: [...algos],
      };
    }

    const verdict = action === 'verify'
      ? (allMatch ? 'ssh_key_manage: VERIFIED' : 'ssh_key_manage: MISMATCH')
      : 'ssh_key_manage: show';
    return toMcp(ok('ssh_key_manage', { ...data, verdict }, { server: server ?? null }), { format });
  }

  // ── accept: write live into store (+ known_hosts) ───────────────────
  if (action === 'accept') {
    if (isPreview) {
      let liveKeys = [];
      try { liveKeys = await fetchLiveKeys(host, port, { runKeyscan }); } catch (_) { /* preview ok */ }
      const plan = buildPlan({
        action: 'key-accept',
        target: `${host}:${port}`,
        effects: [
          `would write ${liveKeys.length} key entr${liveKeys.length === 1 ? 'y' : 'ies'} for ${shQuote(host)}:${port} to internal store`,
          `would append same entries to ${knownHostsPath}`,
          ...liveKeys.map(k => `  ${k.algorithm}  ${k.fingerprint || '(no fp)'}`),
        ],
        reversibility: 'manual',
        risk: 'medium',
      });
      return toMcp(preview('ssh_key_manage', plan, { server: server ?? null }), { format });
    }

    let liveKeys;
    try { liveKeys = await fetchLiveKeys(host, port, { runKeyscan }); }
    catch (e) { return toMcp(fail('ssh_key_manage', e, { server: server ?? null }), { format }); }

    if (liveKeys.length === 0) {
      return toMcp(fail('ssh_key_manage', 'no live keys returned from ssh-keyscan', { server: server ?? null }), { format });
    }

    // Store each live key into the internal map (one per algorithm, last wins).
    for (const k of liveKeys) {
      storeKey(host, port, k.algorithm, k.fingerprint, k.base64Key);
    }
    // Append to known_hosts for persistence.
    const existing = fsReadKnownHosts(knownHostsPath) || '';
    const appended = existing.endsWith('\n') || existing === '' ? existing : existing + '\n';
    const additions = liveKeys.map(k => k.raw).join('\n') + '\n';
    fsWriteKnownHosts(knownHostsPath, appended + additions);

    return toMcp(ok('ssh_key_manage', {
      accepted: liveKeys.map(k => ({
        algorithm: k.algorithm,
        fingerprint: k.fingerprint,
      })),
      written_to: knownHostsPath,
    }, { server: server ?? null }), { format });
  }

  // ── remove ──────────────────────────────────────────────────────────
  if (action === 'remove') {
    const stored = readStoredAll();
    if (isPreview) {
      const plan = buildPlan({
        action: 'key-remove',
        target: `${host}:${port}`,
        effects: [
          `would remove ${stored.length} key entr${stored.length === 1 ? 'y' : 'ies'} for ${shQuote(host)}:${port}`,
          ...stored.map(s => `  ${s.algorithm}  ${s.fingerprint || '(no fp)'}  (${s.source})`),
        ],
        reversibility: 'manual',
        risk: 'low',
      });
      return toMcp(preview('ssh_key_manage', plan, { server: server ?? null }), { format });
    }

    // Remove from internal store.
    const hadInternal = deleteStoredKey(host, port);

    // Rewrite known_hosts minus matching lines.
    const text = fsReadKnownHosts(knownHostsPath) || '';
    const kept = [];
    let removedCount = 0;
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseKnownHostLine(line);
      if (parsed && !parsed.hashed && parsed.host === host && parsed.port === port) {
        removedCount++;
        continue;
      }
      kept.push(line);
    }
    fsWriteKnownHosts(knownHostsPath, kept.join('\n'));

    return toMcp(ok('ssh_key_manage', {
      removed: {
        from_internal_store: hadInternal,
        from_known_hosts: removedCount,
      },
    }, { server: server ?? null }), { format });
  }

  // ── rotate: remove-then-accept ──────────────────────────────────────
  if (action === 'rotate') {
    if (isPreview) {
      const stored = readStoredAll();
      let liveKeys = [];
      try { liveKeys = await fetchLiveKeys(host, port, { runKeyscan }); } catch (_) { /* preview ok */ }
      const plan = buildPlan({
        action: 'key-rotate',
        target: `${host}:${port}`,
        effects: [
          `would REMOVE ${stored.length} existing entr${stored.length === 1 ? 'y' : 'ies'}`,
          ...stored.map(s => `  - ${s.algorithm}  ${s.fingerprint || '(no fp)'}  (${s.source})`),
          `would ACCEPT ${liveKeys.length} new entr${liveKeys.length === 1 ? 'y' : 'ies'}`,
          ...liveKeys.map(k => `  + ${k.algorithm}  ${k.fingerprint || '(no fp)'}`),
        ],
        reversibility: 'manual',
        risk: 'high',
      });
      return toMcp(preview('ssh_key_manage', plan, { server: server ?? null }), { format });
    }

    // Execute: remove then accept in sequence. Errors on accept leave the
    // removed state in place — caller can re-run accept to retry.
    const removeResult = await handleSshKeyManage({
      ...ctx,
      args: { action: 'remove', host, port, format: 'json' },
    });
    const acceptResult = await handleSshKeyManage({
      ...ctx,
      args: { action: 'accept', host, port, format: 'json' },
    });

    const parsedRemove = JSON.parse(removeResult.content[0].text);
    const parsedAccept = JSON.parse(acceptResult.content[0].text);

    return toMcp(ok('ssh_key_manage', {
      rotated: true,
      removed: parsedRemove.data ? parsedRemove.data.removed : null,
      accepted: parsedAccept.data ? parsedAccept.data.accepted : null,
      accept_error: parsedAccept.success ? null : parsedAccept.error,
    }, { server: server ?? null }), { format });
  }

  return toMcp(fail('ssh_key_manage', `unknown action: ${action}`), { format });
}
