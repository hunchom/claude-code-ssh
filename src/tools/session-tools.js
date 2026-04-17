/**
 * Rewritten SSH session family with a bulletproof marker-prompt protocol.
 *
 * Motivation
 * ----------
 * The previous regex-based prompt detector (/[$#>]\s*$/) fires on any user
 * output that happens to end in `$`, `#` or `>` -- i.e., effectively all real
 * shells with git-branch, color, or jobspec prompts. It also confuses command
 * echo, prompt, and real stdout.
 *
 * The marker protocol eliminates the ambiguity entirely:
 *
 *   1. On session start, generate a unique random marker
 *        __MCP_EOC_<16-hex>   (hex is crypto.randomBytes(8))
 *      The marker is sealed into the session. User input cannot guess it.
 *
 *   2. Every user command is wrapped as
 *        { USER_CMD; } ; __rc=$?; printf "%s %s\n" "MARKER" "$__rc"
 *      so that *exactly one* line of the form
 *        ^__MCP_EOC_<16-hex> <exit-code>$
 *      appears on stdout once the user command has fully drained.
 *
 *   3. The parser reads the shell stream until it sees that sentinel line,
 *      then strips it (and the leading command echo) from the captured
 *      output. It returns stdout, stderr, and the exit code.
 *
 * This is immune to any prompt content, color codes, or user output that
 * happens to contain `$` or `#`. It is also immune to the user typing the
 * literal substring "__MCP_EOC_" in their command, because the suffix is
 * a per-session random hex that the user does not know.
 *
 * Session memory
 * --------------
 * Every session keeps:
 *   - cwd, user, home (seeded from `pwd; whoami; echo $HOME` at start)
 *   - command_history (ring of last 50 entries: ts, cmd, exit, duration, cwd_before)
 *   - files_touched   (set of paths detected from cd/cat/touch/tee/> redirects)
 *   - total commands, last_activity
 *
 * Optional persistence (opt-in via env MCP_SSH_SESSION_PERSIST=1) flushes
 * memory to ~/.ssh-manager/sessions/<session_id>.json on each send. Tests do
 * NOT depend on the filesystem by default.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { stripAnsi, formatDuration } from '../output-formatter.js';
import { ok, fail, toMcp, defaultRender } from '../structured-result.js';

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const HISTORY_CAP = 50;
const FILES_TOUCHED_CAP = 200;
const SESSION_BUFFER_CAP = 4_000_000; // absolute ceiling per-session, catches runaway output

// Module-level session registry -- lives for the MCP server lifetime.
const sessions = new Map();

/** Exposed for tests to inspect internal state. */
export function _sessionsForTest() {
  return sessions;
}

/** Exposed for tests that need to inject a fake shell stream (bypass ssh2). */
export function _registerSessionForTest(session) {
  sessions.set(session.id, session);
}

// --------------------------------------------------------------------------
// Marker protocol
// --------------------------------------------------------------------------

/** Build a unique per-session marker: __MCP_EOC_<16-hex>. */
export function makeMarker() {
  return '__MCP_EOC_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Wrap a user command so that a sentinel line `<MARKER> <exit-code>` is
 * emitted on stdout exactly once, after the command fully drains.
 *
 * The `{ ...; }` grouping preserves the exit code of the user's last
 * pipeline even if they embedded newlines or `set -e`. We snapshot it into
 * __rc immediately so subsequent `printf` doesn't clobber it.
 */
export function wrapCommandWithMarker(cmd, marker) {
  // Trim trailing newlines to avoid emitting two separate commands.
  const trimmed = String(cmd).replace(/\n+$/, '');
  // Critical: the sentinel printf goes on its OWN line so the marker is
  // always at line-start. stdin carriage-return doesn't matter here because
  // we consume lines, not bytes.
  return `{ ${trimmed}\n} ; __rc=$?; printf '%s %s\\n' '${marker}' "$__rc"\n`;
}

/**
 * Build a regex that matches a sentinel line for a given marker.
 * Marker is sealed into the pattern -- the user cannot forge it because the
 * hex suffix is cryptographic randomness unknown to them.
 *
 * Group 1: the exit code.
 *
 * Note: we deliberately allow optional ANSI/CR noise before the marker on
 * the line (some shells pad with CR at column 0). We still anchor the
 * marker token itself so partial collisions are impossible.
 */
export function buildMarkerRegex(marker) {
  // Escape regex metacharacters in the marker (the hex portion is a-f0-9,
  // but the `_` prefix is safe; underscore is not a regex metachar).
  // Allow CR or ANSI prefix, then the marker, a space, then digits (exit).
  // eslint-disable-next-line no-control-regex
  return new RegExp(`(?:^|\\n)[\\r\\x1b\\[0-9;?]*${marker} (\\d+)\\r?$`, 'm');
}

/**
 * Strip the command echo + marker line from captured output.
 *
 *   Shell echo format (when TTY): `<prompt>cmd\n<output>...\nMARKER 0\n`
 *   We cannot rely on a prompt being present (our spawn is pty=false for
 *   tests, and real shells may disable echo). So we conservatively:
 *
 *     1. Drop every line that contains the marker token itself.
 *     2. Drop the first line iff it equals a verbatim echo of the wrapped
 *        command's first line (i.e., `{ USER_CMD`).
 *
 * Returns { output, exitCode } where exitCode is extracted from the marker.
 */
export function parseMarkerOutput(raw, marker, { commandEcho } = {}) {
  const clean = stripAnsi(String(raw || ''));
  const lines = clean.split('\n');

  // Extract exit code from the marker line. Marker line format:
  //    MARKER <digits>
  // (possibly with leading CR). We scan last-to-first for robustness -- a
  // user's output could never legitimately contain the random marker.
  let exitCode = -1;
  const keep = [];
  for (const line of lines) {
    // Match marker line: allow CR prefix.
    const m = line.match(new RegExp(`^\\r?${marker} (\\d+)\\r?$`));
    if (m) {
      exitCode = parseInt(m[1], 10);
      // Do not push the marker line into output.
      continue;
    }
    // Also catch the wrapper's internal lines (the `}` on a line by itself,
    // or the printf invocation if the shell echoed it with echo-on).
    if (line.trim() === '}') continue;
    keep.push(line);
  }

  // Drop the command echo if present. We receive the echoed wrapper start,
  // which may be e.g. `{ pwd` or `{ echo hello`. When commandEcho is passed
  // we check the first non-empty line.
  if (commandEcho) {
    while (keep.length && keep[0].trim() === '') keep.shift();
    if (keep.length) {
      const first = keep[0].replace(/\r$/, '');
      const wrapperEcho = `{ ${String(commandEcho).replace(/\n+$/, '')}`;
      if (first === wrapperEcho || first === commandEcho || first.endsWith(commandEcho)) {
        keep.shift();
      }
    }
  }

  // Drop trailing empty lines (keep one trailing newline if original had content).
  while (keep.length && keep[keep.length - 1] === '') keep.pop();

  return {
    output: keep.join('\n') + (keep.length ? '\n' : ''),
    exitCode,
  };
}

// --------------------------------------------------------------------------
// SSHSessionV2
// --------------------------------------------------------------------------

export class SSHSessionV2 {
  constructor({ id, server, shell, stream, cols = 120, rows = 40 }) {
    this.id = id;
    this.server = server;
    this.shellName = shell;
    this.stream = stream;
    this.cols = cols;
    this.rows = rows;

    // Marker is sealed at construction and never changes for this session.
    this.marker = makeMarker();
    this.markerRegex = buildMarkerRegex(this.marker);

    // Stream state
    this._decoder = new StringDecoder('utf8');
    this._buffer = '';
    this._closed = false;
    this._waiters = []; // { onMatch, onClose, onTimeout, timer }

    // Session memory
    this.cwd = null;
    this.user = null;
    this.home = null;
    this.envSnapshot = {};
    this.commandHistory = []; // ring of { ts, cmd, exit_code, duration_ms, cwd_before }
    this.filesTouched = []; // ordered, dedup'd
    this.commandCount = 0;
    this.startedAt = new Date();
    this.lastActivity = new Date();

    this._wireStream();
  }

  _wireStream() {
    // We strip ANSI at ingress so the marker regex doesn't need to tolerate
    // escape sequences interleaved with the marker token. (stripAnsi is
    // CSI/OSC-aware; it preserves content, including \r.)
    const onData = (data) => {
      if (this._closed) return;
      const text = this._decoder.write(data);
      if (text) this._appendBuffer(stripAnsi(text));
      this._drainWaiters();
    };
    const onStderr = (data) => {
      if (this._closed) return;
      const text = this._decoder.write(data);
      if (text) this._appendBuffer(stripAnsi(text));
      this._drainWaiters();
    };
    const onClose = () => {
      this._closed = true;
      // Flush any partial utf8
      const tail = this._decoder.end();
      if (tail) this._appendBuffer(tail);
      // Fail any pending waiters
      const waiters = this._waiters.splice(0);
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.onClose();
      }
    };
    const onError = (e) => {
      this._closed = true;
      const waiters = this._waiters.splice(0);
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.onError(e);
      }
    };

    this.stream.on('data', onData);
    if (this.stream.stderr && typeof this.stream.stderr.on === 'function') {
      this.stream.stderr.on('data', onStderr);
    }
    this.stream.on('close', onClose);
    this.stream.on('error', onError);
  }

  _appendBuffer(text) {
    this._buffer += text;
    if (this._buffer.length > SESSION_BUFFER_CAP) {
      this._buffer = this._buffer.slice(-SESSION_BUFFER_CAP);
    }
  }

  _drainWaiters() {
    if (this._waiters.length === 0) return;
    // Only the head waiter is active -- commands are serialized.
    const head = this._waiters[0];
    const m = this._buffer.match(head.regex);
    if (m) {
      const matchEnd = m.index + m[0].length;
      // Everything up through the sentinel line belongs to this command.
      const captured = this._buffer.slice(0, matchEnd);
      // Consume it (plus any trailing \n immediately after) from the buffer
      // so the next command starts fresh.
      let consumeTo = matchEnd;
      if (this._buffer[consumeTo] === '\n') consumeTo++;
      this._buffer = this._buffer.slice(consumeTo);
      this._waiters.shift();
      if (head.timer) clearTimeout(head.timer);
      head.onMatch(captured, m[1]);
    }
  }

  /**
   * Wait for the marker line. Returns { raw, exitCodeStr }.
   *
   * Important: the marker regex is sealed with per-session random, so user
   * output cannot produce a false match even if it contains `$` or `#` or
   * even the literal substring "__MCP_EOC_". The random suffix keeps it safe.
   */
  _waitForMarker({ timeoutMs }) {
    return new Promise((resolve, reject) => {
      const waiter = {
        regex: this.markerRegex,
        onMatch: (raw, exitCodeStr) => resolve({ raw, exitCodeStr }),
        onTimeout: () => reject(new Error(`Command timeout after ${timeoutMs}ms`)),
        onClose: () => reject(new Error('Session closed before command completed')),
        onError: (e) => reject(e),
        timer: null,
      };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          // Remove from queue
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          waiter.onTimeout();
        }, timeoutMs);
      }
      this._waiters.push(waiter);
      // Attempt immediate drain in case the marker already arrived.
      this._drainWaiters();
    });
  }

  /**
   * Execute a command and return structured result.
   */
  async runCommand(command, { timeoutMs = DEFAULT_TIMEOUT_MS, silent = false } = {}) {
    if (this._closed) {
      throw new Error('Session is closed');
    }

    const cwdBefore = this.cwd;
    const startedAt = Date.now();
    const wrapped = wrapCommandWithMarker(command, this.marker);

    // Write the wrapped command. Errors from write go to the stream error handler.
    try {
      this.stream.write(wrapped);
    } catch (e) {
      throw new Error(`Failed to write to session stream: ${e.message}`);
    }

    const { raw, exitCodeStr } = await this._waitForMarker({ timeoutMs });
    const durationMs = Date.now() - startedAt;

    const { output } = parseMarkerOutput(raw, this.marker, { commandEcho: command });
    const exitCode = parseInt(exitCodeStr, 10);

    // Update activity & history (unless silent).
    this.lastActivity = new Date();
    if (!silent) {
      this.commandCount++;
      this._pushHistory({
        ts: new Date().toISOString(),
        cmd: command,
        exit_code: exitCode,
        duration_ms: durationMs,
        cwd_before: cwdBefore,
      });
      this._detectFilesTouched(command);
    }

    return {
      command,
      stdout: output,
      stderr: '', // marker protocol merges stderr into the pty stream; separate stderr not meaningful here
      exit_code: exitCode,
      duration_ms: durationMs,
    };
  }

  _pushHistory(entry) {
    this.commandHistory.push(entry);
    if (this.commandHistory.length > HISTORY_CAP) {
      this.commandHistory.splice(0, this.commandHistory.length - HISTORY_CAP);
    }
  }

  /**
   * Very small heuristic to detect files the user referenced. We're happy
   * to be approximate -- this is a memory aid, not a security mechanism.
   */
  _detectFilesTouched(command) {
    const s = String(command);
    const add = (p) => {
      if (!p) return;
      if (!this.filesTouched.includes(p)) {
        this.filesTouched.push(p);
        if (this.filesTouched.length > FILES_TOUCHED_CAP) {
          this.filesTouched.splice(0, this.filesTouched.length - FILES_TOUCHED_CAP);
        }
      }
    };
    // cat FILE, touch FILE, less FILE, tail FILE, head FILE, vi FILE, rm FILE
    const verb = /\b(?:cat|touch|less|more|tail|head|vi|vim|nano|rm|mv|cp|tee)\s+([^\s;|&<>]+)/g;
    let m;
    while ((m = verb.exec(s)) !== null) add(m[1]);
    // Redirections: `> FILE`, `>> FILE`, `< FILE`
    const redir = /[<>]{1,2}\s*([^\s;|&<>]+)/g;
    while ((m = redir.exec(s)) !== null) add(m[1]);
  }

  /**
   * Persist the session memory if opted in via env. Best-effort; never throws.
   */
  _maybePersist() {
    if (process.env.MCP_SSH_SESSION_PERSIST !== '1') return;
    try {
      const dir = path.join(os.homedir(), '.ssh-manager', 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${this.id}.json`);
      fs.writeFileSync(file, JSON.stringify(this.memorySnapshot(), null, 2), 'utf8');
    } catch (_) { /* ignore */ }
  }

  memorySnapshot() {
    return {
      session_id: this.id,
      server: this.server,
      shell: this.shellName,
      started_at: this.startedAt.toISOString(),
      last_activity: this.lastActivity.toISOString(),
      cwd: this.cwd,
      user: this.user,
      home: this.home,
      env_snapshot: this.envSnapshot,
      command_count: this.commandCount,
      command_history: this.commandHistory.slice(),
      files_touched: this.filesTouched.slice(),
    };
  }

  /** Gracefully close: send `exit`, end the stream. Idempotent. */
  async close() {
    if (this._closed) return;
    try {
      if (this.stream && typeof this.stream.write === 'function') {
        this.stream.write('exit\n');
      }
    } catch (_) { /* ignore */ }
    try {
      if (this.stream && typeof this.stream.end === 'function') {
        this.stream.end();
      }
    } catch (_) { /* ignore */ }
    this._closed = true;
    // Fail any pending waiters so promises don't dangle.
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.onClose();
    }
  }
}

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------

/**
 * Open a shell stream on the given ssh2 client. Returns the stream.
 * Exposed so tests can override the shell opener.
 */
async function openShellStream(client, { cols, rows }) {
  return new Promise((resolve, reject) => {
    // ssh2 client.shell(opts, cb). opts.term drives ANSI support.
    const opts = { term: 'xterm-256color', cols, rows };
    client.shell(opts, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

/**
 * ssh_session_start -- open a new persistent session.
 *
 * args: { server, shell='bash', cols=120, rows=40, format }
 * side: seeds cwd/user/home from pwd/whoami/$HOME.
 */
export async function handleSshSessionStart({ getConnection, args, _openShellStream }) {
  const {
    server,
    shell = 'bash',
    cols = 120,
    rows = 40,
    format = 'markdown',
  } = args || {};

  const startedAt = Date.now();

  let client;
  try {
    client = await getConnection(server);
  } catch (e) {
    return toMcp(fail('ssh_session_start', e, { server }), { format });
  }

  let stream;
  try {
    const opener = _openShellStream || openShellStream;
    stream = await opener(client, { cols, rows });
  } catch (e) {
    return toMcp(fail('ssh_session_start', e, { server }), { format });
  }

  const id = 'sess_' + crypto.randomBytes(8).toString('hex');
  const session = new SSHSessionV2({ id, server, shell, stream, cols, rows });
  sessions.set(id, session);

  // Seed session memory -- pwd, whoami, echo $HOME -- silently (no history).
  try {
    const pwd = await session.runCommand('pwd', { timeoutMs: 10_000, silent: true });
    if (pwd.exit_code === 0) session.cwd = pwd.stdout.trim();
  } catch (_) { /* best-effort */ }
  try {
    const who = await session.runCommand('whoami', { timeoutMs: 10_000, silent: true });
    if (who.exit_code === 0) session.user = who.stdout.trim();
  } catch (_) { /* best-effort */ }
  try {
    const home = await session.runCommand('echo $HOME', { timeoutMs: 10_000, silent: true });
    if (home.exit_code === 0) session.home = home.stdout.trim();
  } catch (_) { /* best-effort */ }

  session._maybePersist();

  const data = {
    session_id: id,
    server,
    shell,
    cwd: session.cwd,
    user: session.user,
    home: session.home,
    started_at: session.startedAt.toISOString(),
  };

  return toMcp(
    ok('ssh_session_start', data, { server, duration_ms: Date.now() - startedAt }),
    { format, renderer: renderSessionStart }
  );
}

function renderSessionStart(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  lines.push(`[ok] **ssh_session_start** | \`${d.server}\` | \`${result.meta?.duration_ms != null ? formatDuration(result.meta.duration_ms) : ''}\``);
  lines.push('');
  lines.push(`- **session_id**: \`${d.session_id}\``);
  lines.push(`- **shell**: \`${d.shell}\``);
  lines.push(`- **cwd**: \`${d.cwd ?? '(unknown)'}\``);
  lines.push(`- **user**: \`${d.user ?? '(unknown)'}\``);
  if (d.home) lines.push(`- **home**: \`${d.home}\``);
  return lines.join('\n');
}

/**
 * ssh_session_send -- run a command in an existing session.
 *
 * args: { session_id, command, timeout=30000, format }
 * returns { command, stdout, stderr, exit_code, duration_ms, cwd_after }
 */
export async function handleSshSessionSend({ args }) {
  const {
    session_id,
    command,
    timeout = DEFAULT_TIMEOUT_MS,
    format = 'markdown',
  } = args || {};

  const session = sessions.get(session_id);
  if (!session) {
    return toMcp(fail('ssh_session_send', `unknown session_id: ${session_id}`), { format });
  }
  if (!command) {
    return toMcp(fail('ssh_session_send', 'command is required', { server: session.server }), { format });
  }

  let result;
  try {
    result = await session.runCommand(command, { timeoutMs: timeout });
  } catch (e) {
    return toMcp(fail('ssh_session_send', e, { server: session.server }), { format });
  }

  // Update cwd_after: cheap by running silent pwd. This keeps memory accurate
  // even when the user ran `cd` inside a subshell (which wouldn't stick --
  // but `cd` in the interactive shell *does*).
  let cwdAfter = session.cwd;
  try {
    const pwd = await session.runCommand('pwd', { timeoutMs: 5_000, silent: true });
    if (pwd.exit_code === 0) {
      cwdAfter = pwd.stdout.trim();
      session.cwd = cwdAfter;
    }
  } catch (_) { /* best-effort */ }

  session._maybePersist();

  const data = {
    session_id,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    cwd_after: cwdAfter,
  };

  return toMcp(
    ok('ssh_session_send', data, { server: session.server, duration_ms: result.duration_ms }),
    { format, renderer: renderSessionSend }
  );
}

function renderSessionSend(result) {
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const good = d.exit_code === 0;
  const marker = good ? '[ok]' : '[err]';
  const badge = good ? '**exit 0**' : `**exit ${d.exit_code}**`;
  const lines = [];
  lines.push(`${marker} **ssh_session_send** | \`${result.server}\` | ${badge} | \`${formatDuration(d.duration_ms)}\``);
  lines.push(`\`$ ${d.command}\`   *(in \`${d.cwd_after}\`)*`);
  if (d.stdout && d.stdout.trim()) {
    lines.push('');
    lines.push('```text');
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

/**
 * ssh_session_list -- enumerate active sessions.
 */
export async function handleSshSessionList({ args }) {
  const { format = 'markdown' } = args || {};
  const list = [];
  for (const s of sessions.values()) {
    list.push({
      session_id: s.id,
      server: s.server,
      started_at: s.startedAt.toISOString(),
      last_activity: s.lastActivity.toISOString(),
      command_count: s.commandCount,
      cwd: s.cwd,
      user: s.user,
    });
  }
  return toMcp(ok('ssh_session_list', { sessions: list, total: list.length }), { format });
}

/**
 * ssh_session_close -- idempotent close. Special value "all" closes every
 * session currently tracked (advertised in the tool schema).
 */
export async function handleSshSessionClose({ args }) {
  const { session_id, format = 'markdown' } = args || {};

  if (session_id === 'all') {
    const ids = Array.from(sessions.keys());
    const closed = [];
    const errors = [];
    for (const id of ids) {
      const s = sessions.get(id);
      if (!s) continue;
      try { await s.close(); }
      catch (e) { errors.push({ session_id: id, error: e.message || String(e) }); }
      sessions.delete(id);
      closed.push({ session_id: id, server: s.server, command_count: s.commandCount });
    }
    return toMcp(
      ok('ssh_session_close', {
        session_id: 'all',
        closed: true,
        closed_count: closed.length,
        sessions: closed,
        errors,
      }),
      { format }
    );
  }

  const session = sessions.get(session_id);
  if (!session) {
    // Idempotent: repeated close on a dead/unknown id is not an error.
    return toMcp(
      ok('ssh_session_close', {
        session_id,
        closed: true,
        already_closed: true,
      }),
      { format }
    );
  }

  try { await session.close(); } catch (_) { /* ignore */ }
  sessions.delete(session_id);

  return toMcp(
    ok('ssh_session_close', {
      session_id,
      server: session.server,
      closed: true,
      command_count: session.commandCount,
    }, { server: session.server }),
    { format }
  );
}

/**
 * ssh_session_replay -- recent command history for a session.
 */
export async function handleSshSessionReplay({ args }) {
  const { session_id, limit = 20, format = 'markdown' } = args || {};

  const session = sessions.get(session_id);
  if (!session) {
    return toMcp(fail('ssh_session_replay', `unknown session_id: ${session_id}`), { format });
  }

  const n = Math.max(1, Math.floor(Number(limit)) || 20);
  const commands = session.commandHistory.slice(-n);

  return toMcp(
    ok('ssh_session_replay', {
      session_id,
      server: session.server,
      total: session.commandHistory.length,
      returned: commands.length,
      commands,
    }, { server: session.server }),
    { format }
  );
}

/**
 * ssh_session_memory -- full memory snapshot.
 */
export async function handleSshSessionMemory({ args }) {
  const { session_id, format = 'markdown' } = args || {};

  const session = sessions.get(session_id);
  if (!session) {
    return toMcp(fail('ssh_session_memory', `unknown session_id: ${session_id}`), { format });
  }

  return toMcp(
    ok('ssh_session_memory', session.memorySnapshot(), { server: session.server }),
    { format }
  );
}
