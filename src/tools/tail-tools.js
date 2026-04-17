/**
 * ssh_tail tool family.
 *
 *   ssh_tail        -- one-shot `tail -n N FILE` (optionally grep-filtered).
 *   ssh_tail_start  -- start a long-lived `tail -n N -f FILE | grep ...` session.
 *                     Stores a ring-buffered accumulator (cap 1 MB) keyed by
 *                     session_id. Returns initial chunk + session_id.
 *   ssh_tail_read   -- pull new chunks from a session since a given offset.
 *   ssh_tail_stop   -- INT the stream, close it, drop the session. Idempotent.
 *
 * All shell-interpolated values (file path, grep pattern) pass through
 * shQuote(). Line counts coerce via Number() -> Math.floor -> safe default.
 */

import crypto from 'crypto';
import { streamExecCommand, shQuote, buildRemoteCommand } from '../stream-exec.js';
import { formatExecResult, makeMcpContent, stripAnsi } from '../output-formatter.js';
import { ok, fail, toMcp } from '../structured-result.js';

const DEFAULT_LINES = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LEN = 10_000;
const RING_BUFFER_CAP = 1_000_000;

/** Session registry -- module-level Map so tools across calls share it. */
const sessions = new Map();
/** Bounded set of recently-stopped session IDs, so a repeat stop is a no-op. */
const stoppedIds = new Set();
const STOPPED_IDS_MAX = 256;

function rememberStopped(id) {
  stoppedIds.add(id);
  if (stoppedIds.size > STOPPED_IDS_MAX) {
    // Evict oldest (Set preserves insertion order)
    const first = stoppedIds.values().next().value;
    stoppedIds.delete(first);
  }
}

/** Exposed for tests to introspect internal state. */
export function _sessionsForTest() {
  return sessions;
}
export function _stoppedIdsForTest() {
  return stoppedIds;
}

/** Coerce numeric arg to a positive integer, with safe fallback. */
function safeLines(n, fallback = DEFAULT_LINES) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Build `tail -n N FILE [| grep -E PATTERN]` (optionally with -f). */
export function buildTailCommand({ file, lines, grep, follow = false }) {
  const f = shQuote(String(file));
  const n = safeLines(lines);
  const flags = follow ? `-n ${n} -f` : `-n ${n}`;
  const grepSuffix = grep ? ` | grep -E ${shQuote(String(grep))}` : '';
  return `tail ${flags} ${f}${grepSuffix}`;
}

// --------------------------------------------------------------------------
// ssh_tail (one-shot)
// --------------------------------------------------------------------------
export async function handleSshTail({ getConnection, args }) {
  const {
    server, file, lines = DEFAULT_LINES, grep,
    timeout = DEFAULT_TIMEOUT_MS,
    maxLen = DEFAULT_MAX_LEN,
    format = 'markdown',
    abortSignal,
  } = args || {};

  if (!file) {
    return toMcp(fail('ssh_tail', 'file is required', { server }), { format });
  }

  const command = buildTailCommand({ file, lines, grep, follow: false });

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return makeTailExecError('ssh_tail', server, command, e, format, Date.now() - startedAt);
  }

  let result, error;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: timeout, abortSignal });
  } catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return makeTailExecError('ssh_tail', server, command, error, format, durationMs);
  }

  const exec = formatExecResult({
    server, command,
    stdout: result.stdout, stderr: result.stderr,
    code: result.code, durationMs,
    maxLen,
  });
  return { content: makeMcpContent(exec, { format }) };
}

function makeTailExecError(tool, server, command, error, format, durationMs) {
  const exec = formatExecResult({
    server, command, stdout: '',
    stderr: String(error.message || error),
    code: -1, durationMs, maxLen: DEFAULT_MAX_LEN,
  });
  return { content: makeMcpContent(exec, { format }), isError: true };
}

// --------------------------------------------------------------------------
// ssh_tail_start -- long-lived follow session
// --------------------------------------------------------------------------
export async function handleSshTailStart({ getConnection, args }) {
  const {
    server, file, lines = DEFAULT_LINES, grep,
    format = 'markdown',
  } = args || {};

  if (!file) {
    return toMcp(fail('ssh_tail_start', 'file is required', { server }), { format });
  }

  const command = buildTailCommand({ file, lines, grep, follow: true });
  const fullCommand = buildRemoteCommand(command, null);

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_tail_start', e, { server, command }), { format });
  }

  // Raw client.exec -- we need the long-lived stream; streamExecCommand
  // resolves on close and is therefore unsuitable for follow sessions.
  const session = await new Promise((resolve, reject) => {
    client.exec(fullCommand, (err, stream) => {
      if (err) return reject(err);

      const id = 'tail_' + crypto.randomBytes(8).toString('hex');
      const state = {
        id,
        server,
        file,
        command,
        createdAt: Date.now(),
        buffer: '',
        totalBytes: 0,   // lifetime bytes appended (monotonic, pre-truncation)
        closed: false,
        stream,
      };

      function append(text) {
        if (!text) return;
        state.totalBytes += text.length;
        state.buffer += text;
        if (state.buffer.length > RING_BUFFER_CAP) {
          state.buffer = state.buffer.slice(-RING_BUFFER_CAP);
        }
      }

      stream.on('data', (d) => append(stripAnsi(d.toString('utf8'))));
      stream.stderr && stream.stderr.on('data', (d) => append(stripAnsi(d.toString('utf8'))));
      stream.on('close', () => { state.closed = true; });
      stream.on('error', () => { state.closed = true; });

      sessions.set(id, state);
      resolve(state);
    });
  }).catch((e) => ({ __err: e }));

  if (session && session.__err) {
    return toMcp(fail('ssh_tail_start', session.__err, { server, command }), { format });
  }

  const data = {
    session_id: session.id,
    server,
    file,
    command,
    initial: session.buffer,   // may be empty if no data arrived before we replied
    total_bytes: session.totalBytes,
  };
  return toMcp(
    ok('ssh_tail_start', data, { server, duration_ms: Date.now() - startedAt }),
    { format }
  );
}

// --------------------------------------------------------------------------
// ssh_tail_read -- pull accumulated chunks since `since_offset`
// --------------------------------------------------------------------------
export async function handleSshTailRead({ args }) {
  const { session_id, since_offset, format = 'markdown' } = args || {};

  const state = sessions.get(session_id);
  if (!state) {
    return toMcp(fail('ssh_tail_read', `unknown session_id: ${session_id}`), { format });
  }

  // Compute the "available window" from the ring buffer. Bytes before
  // state.totalBytes - state.buffer.length have been evicted.
  const windowStart = state.totalBytes - state.buffer.length;
  const total = state.totalBytes;

  let fromOffset;
  if (since_offset == null) {
    fromOffset = windowStart;   // first read: return whatever is buffered
  } else {
    const n = Math.floor(Number(since_offset));
    fromOffset = Number.isFinite(n) && n >= 0 ? n : windowStart;
  }

  let chunk = '';
  let elided = 0;
  if (fromOffset >= total) {
    chunk = '';
  } else if (fromOffset < windowStart) {
    // Caller's offset has been evicted by the ring buffer. Return the full
    // current window and report how many bytes were lost.
    elided = windowStart - fromOffset;
    chunk = state.buffer;
  } else {
    chunk = state.buffer.slice(fromOffset - windowStart);
  }

  const data = {
    session_id,
    server: state.server,
    file: state.file,
    chunk,
    bytes: chunk.length,
    from_offset: fromOffset < windowStart ? windowStart : fromOffset,
    current_offset: total,
    closed: state.closed,
    elided_bytes: elided,
  };

  return toMcp(
    ok('ssh_tail_read', data, { server: state.server }),
    { format }
  );
}

// --------------------------------------------------------------------------
// ssh_tail_stop -- idempotent teardown
// --------------------------------------------------------------------------
export async function handleSshTailStop({ args }) {
  const { session_id, format = 'markdown' } = args || {};

  const state = sessions.get(session_id);
  if (!state) {
    // Idempotent: if we previously stopped this session, treat repeat as a no-op.
    if (stoppedIds.has(session_id)) {
      return toMcp(
        ok('ssh_tail_stop', {
          session_id,
          stopped: true,
          already_stopped: true,
        }),
        { format }
      );
    }
    return toMcp(fail('ssh_tail_stop', `unknown session_id: ${session_id}`), { format });
  }

  let signaled = false, closed = false;
  try { state.stream && state.stream.signal && state.stream.signal('INT'); signaled = true; } catch (_) { /* ignore */ }
  try { state.stream && state.stream.close && state.stream.close(); closed = true; } catch (_) { /* ignore */ }

  sessions.delete(session_id);
  rememberStopped(session_id);

  const data = {
    session_id,
    server: state.server,
    file: state.file,
    stopped: true,
    signaled,
    closed,
    total_bytes: state.totalBytes,
  };
  return toMcp(
    ok('ssh_tail_stop', data, { server: state.server }),
    { format }
  );
}
