/**
 * Streaming exec over an ssh2 Client.
 *
 * Low-latency: chunks emitted with debounced coalescing (default 50ms).
 * Safe:
 *   - UTF-8 decoder preserves codepoints split across TCP boundaries
 *   - cwd is shell-quoted to eliminate the `cd ${cwd}` injection surface
 *   - AbortSignal + timeout both teardown stream cleanly and resolve exactly once
 *   - Backpressure: per-stream ring buffer capped at maxBufferedBytes
 */

import { StringDecoder } from 'string_decoder';

/**
 * Shell-quote a single token for POSIX sh. Safe for arbitrary input.
 * Encloses in single quotes and escapes embedded single quotes.
 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the remote command with a safely-quoted cwd prefix.
 * If cwd is falsy, returns command unchanged.
 */
export function buildRemoteCommand(command, cwd) {
  if (!cwd) return command;
  return `cd ${shQuote(cwd)} && ${command}`;
}

/**
 * Stream a command through an ssh2 Client.
 *
 * @param {Object} client    ssh2 Client (must support client.exec(cmd, cb))
 * @param {string} command   remote command
 * @param {Object} [options]
 * @param {string} [options.cwd]                working directory (shell-quoted)
 * @param {AbortSignal} [options.abortSignal]   cancel the command mid-flight
 * @param {number} [options.debounceMs=50]      coalesce chunks within this window
 * @param {number} [options.maxBufferedBytes=1_000_000]  per-stream ring-buffer cap
 * @param {number} [options.timeoutMs]          overall deadline; sends INT then close
 * @param {Function} [options.onChunk]          ({kind:'stdout'|'stderr', text}) => void
 * @param {string|Buffer} [options.stdin]       written to stream.stdin + end() (e.g. sudo password)
 * @returns {Promise<{stdout, stderr, code, signal}>}
 */
export function streamExecCommand(client, command, options = {}) {
  const {
    cwd,
    abortSignal,
    debounceMs = 50,
    maxBufferedBytes = 1_000_000,
    timeoutMs,
    onChunk,
    stdin,
  } = options;

  const fullCommand = buildRemoteCommand(command, cwd);

  return new Promise((resolve, reject) => {
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    let stdout = '';
    let stderr = '';
    let pendingOut = '';
    let pendingErr = '';
    let flushTimer = null;
    let stream = null;
    let resolved = false;
    let timeoutId = null;

    function emit(kind, text) {
      if (!onChunk || !text) return;
      try { onChunk({ kind, text }); } catch (_) { /* swallow consumer errors */ }
    }

    function flush() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingOut) { emit('stdout', pendingOut); pendingOut = ''; }
      if (pendingErr) { emit('stderr', pendingErr); pendingErr = ''; }
    }

    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, debounceMs);
    }

    function appendCapped(current, chunk) {
      const next = current + chunk;
      if (next.length <= maxBufferedBytes) return next;
      return next.slice(-maxBufferedBytes);
    }

    function teardownStream() {
      if (!stream) return;
      try { stream.signal && stream.signal('INT'); } catch (_) { /* ignore */ }
      try { stream.close && stream.close(); } catch (_) { /* ignore */ }
    }

    function finish(result, err) {
      if (resolved) return;
      resolved = true;

      // Final decoder flush (recovers any trailing partial codepoints)
      const tailOut = outDecoder.end();
      const tailErr = errDecoder.end();
      if (tailOut) { stdout = appendCapped(stdout, tailOut); pendingOut += tailOut; }
      if (tailErr) { stderr = appendCapped(stderr, tailErr); pendingErr += tailErr; }
      flush();

      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

      if (err) reject(err);
      else resolve(result);
    }

    function onAbort() {
      teardownStream();
      finish(null, new Error('Command aborted'));
    }

    // Abort hookup (guard against already-aborted signal)
    if (abortSignal) {
      if (abortSignal.aborted) {
        finish(null, new Error('Command aborted'));
        return;
      }
      abortSignal.addEventListener('abort', onAbort);
    }

    // Overall deadline
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        teardownStream();
        finish(null, new Error(`Command timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    client.exec(fullCommand, (err, streamObj) => {
      if (err) return finish(null, err);
      stream = streamObj;

      // Optional stdin feed (e.g. sudo password). Written before data handlers
      // to ensure the remote process sees it as soon as its fd0 is open.
      if (stdin != null) {
        try {
          // ssh2's exec stream is Writable directly; no .stdin member.
          if (typeof stream.write === 'function') {
            stream.write(stdin);
            if (typeof stream.end === 'function') {
              // end() closes the write side (EOF on remote fd0) without
              // tearing down the read side.
              stream.end();
            }
          }
        } catch (_) { /* ignore; remote may have already closed fd0 */ }
      }

      stream.on('data', (data) => {
        if (resolved) return;
        const text = outDecoder.write(data);
        if (!text) return;
        stdout = appendCapped(stdout, text);
        pendingOut += text;
        scheduleFlush();
      });

      stream.stderr.on('data', (data) => {
        if (resolved) return;
        const text = errDecoder.write(data);
        if (!text) return;
        stderr = appendCapped(stderr, text);
        pendingErr += text;
        scheduleFlush();
      });

      stream.on('close', (code, signal) => {
        finish({ stdout, stderr, code: code || 0, signal: signal || null }, null);
      });

      stream.on('error', (e) => finish(null, e));
    });
  });
}
