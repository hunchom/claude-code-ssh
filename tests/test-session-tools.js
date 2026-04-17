#!/usr/bin/env node
/**
 * Tests for src/tools/session-tools.js -- the marker-prompt session family.
 *
 * We mock the shell stream entirely. The FakeShellStream is an EventEmitter
 * that records `.write()` calls, supports `.end()`, and lets the test harness
 * emit data/close/error events on a scripted schedule.
 *
 * The core mock behavior: when a test-driven stream sees a write containing
 * the marker wrapper, it parses out the embedded marker, then emits scripted
 * stdout followed by the canonical sentinel line `<MARKER> <exit>\n`.
 *
 * This exercises the real parseMarkerOutput / buildMarkerRegex code paths.
 */

import assert from 'assert';
import { EventEmitter } from 'events';

import {
  handleSshSessionStart,
  handleSshSessionSend,
  handleSshSessionList,
  handleSshSessionClose,
  handleSshSessionReplay,
  handleSshSessionMemory,
  SSHSessionV2,
  makeMarker,
  wrapCommandWithMarker,
  buildMarkerRegex,
  parseMarkerOutput,
  _sessionsForTest,
} from '../src/tools/session-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --------------------------------------------------------------------------
// FakeShellStream -- scriptable bidirectional shell
// --------------------------------------------------------------------------
class FakeShellStream extends EventEmitter {
  constructor({ scriptFor = null, delayMs = 0 } = {}) {
    super();
    this.stderr = new EventEmitter();
    this.writes = []; // full write log
    this.endCalls = 0;
    this.closed = false;
    this._marker = null;
    // scriptFor(userCmd, marker) -> { stdout, exit, stderr?, skipMarker?, customEcho? }
    this.scriptFor = scriptFor || ((cmd) => ({ stdout: '', exit: 0 }));
    this.delayMs = delayMs;
  }

  write(buf) {
    const s = String(buf);
    this.writes.push(s);
    // Parse the wrapped command: `{ USER_CMD\n} ; __rc=$?; printf '%s %s\n' 'MARKER' "$__rc"\n`
    const match = s.match(/^\{ ([\s\S]*?)\n\} ; __rc=\$\?; printf '%s %s\\n' '(__MCP_EOC_[0-9a-f]{16})' "\$__rc"\n$/);
    if (!match) {
      // Not a wrapped command -- maybe plain `exit\n` on close. Ignore.
      return true;
    }
    const userCmd = match[1];
    const marker = match[2];
    this._marker = marker;

    const script = this.scriptFor(userCmd, marker);
    const fire = () => {
      if (this.closed) return;
      // Emit the command echo first (realistic shell behavior).
      const echo = script.customEcho != null ? script.customEcho : `{ ${userCmd}\n}\n`;
      if (echo) this.emit('data', Buffer.from(echo));
      // Emit any scripted stdout.
      if (script.stdout) this.emit('data', Buffer.from(script.stdout));
      if (script.stderr) this.stderr.emit('data', Buffer.from(script.stderr));
      // Emit the sentinel line last -- unless the script wants to misbehave.
      if (!script.skipMarker) {
        this.emit('data', Buffer.from(`${marker} ${script.exit ?? 0}\n`));
      }
    };
    if (this.delayMs > 0) setTimeout(fire, this.delayMs);
    else setImmediate(fire);
    return true;
  }

  end() { this.endCalls++; this.closed = true; setImmediate(() => this.emit('close', 0)); }
  signal() { /* no-op for fake */ }
  close() { this.closed = true; setImmediate(() => this.emit('close', 0)); }
}

/** Build a synthesizer that returns scripted output per-command. */
function scripted(table) {
  return (cmd) => {
    for (const { match, response } of table) {
      if (typeof match === 'string' ? cmd === match : match.test(cmd)) {
        return typeof response === 'function' ? response(cmd) : response;
      }
    }
    return { stdout: '', exit: 0 };
  };
}

// Build a fake "client" that yields a FakeShellStream when .shell() is called.
function makeFakeClient(stream) {
  return {
    shell(opts, cb) {
      setImmediate(() => cb(null, stream));
    },
  };
}

// Drain any lingering sessions between tests.
async function cleanupAllSessions() {
  for (const id of [..._sessionsForTest().keys()]) {
    try { await handleSshSessionClose({ args: { session_id: id } }); } catch (_) { /* ignore */ }
  }
}

console.log('[test] Testing session-tools (marker-prompt protocol)\n');

// --------------------------------------------------------------------------
// Pure-function tests: marker / wrap / parse
// --------------------------------------------------------------------------

await test('makeMarker: produces unique 16-hex marker each call', () => {
  const a = makeMarker();
  const b = makeMarker();
  assert(/^__MCP_EOC_[0-9a-f]{16}$/.test(a), `a shape: ${a}`);
  assert(/^__MCP_EOC_[0-9a-f]{16}$/.test(b), `b shape: ${b}`);
  assert.notStrictEqual(a, b, 'markers must differ');
});

await test('wrapCommandWithMarker: wraps command so sentinel prints on own line', () => {
  const marker = '__MCP_EOC_abcdef0123456789';
  const wrapped = wrapCommandWithMarker('ls -la', marker);
  assert(wrapped.includes('{ ls -la\n}'), 'grouping preserved');
  assert(wrapped.includes(`printf '%s %s\\n' '${marker}' "$__rc"`), 'printf with marker');
  assert(wrapped.endsWith('\n'), 'trailing newline');
});

await test('wrapCommandWithMarker: snapshots $? before printf', () => {
  const marker = '__MCP_EOC_0000000000000000';
  const wrapped = wrapCommandWithMarker('false', marker);
  // Critical ordering: `__rc=$?` MUST come immediately after the user cmd
  // closes, BEFORE printf (whose own exit would clobber $?).
  const order = wrapped.indexOf('__rc=$?');
  const printfIdx = wrapped.indexOf('printf');
  assert(order > 0 && order < printfIdx, '__rc assigned before printf');
});

await test('parseMarkerOutput: extracts exit code from sentinel line', () => {
  const marker = '__MCP_EOC_deadbeefdeadbeef';
  const raw = `hello world\n${marker} 0\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker);
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(output, 'hello world\n');
});

await test('parseMarkerOutput: extracts non-zero exit code (42)', () => {
  const marker = '__MCP_EOC_deadbeefdeadbeef';
  const raw = `oops\n${marker} 42\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker);
  assert.strictEqual(exitCode, 42);
  assert.strictEqual(output, 'oops\n');
});

await test('parseMarkerOutput: strips ANSI color codes around marker line', () => {
  const marker = '__MCP_EOC_1111222233334444';
  const raw = `\x1b[32mOK\x1b[0m\n\x1b[0m${marker} 0\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker);
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(output, 'OK\n');
});

await test('parseMarkerOutput: output containing literal "$" before marker does NOT trigger false match', () => {
  const marker = '__MCP_EOC_feedfacefeedface';
  // Output contains `$` and `#` as regular text -- the old regex prompt
  // detector would have fired here. The marker protocol does not.
  const raw = `here is a $ literal\nroot# fake prompt in stdout\n${marker} 0\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker);
  assert.strictEqual(exitCode, 0);
  assert(output.includes('here is a $ literal'));
  assert(output.includes('root# fake prompt in stdout'));
});

await test('parseMarkerOutput: preserves multi-line output intact (500 lines)', () => {
  const marker = '__MCP_EOC_0123456789abcdef';
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const raw = big + `${marker} 0\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker);
  assert.strictEqual(exitCode, 0);
  const lines = output.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 500);
  assert.strictEqual(lines[0], 'line 0');
  assert.strictEqual(lines[499], 'line 499');
});

await test('parseMarkerOutput: strips wrapper echo `{ CMD` if present', () => {
  const marker = '__MCP_EOC_abababab01010101';
  const raw = `{ echo hi\n}\nhi\n${marker} 0\n`;
  const { output, exitCode } = parseMarkerOutput(raw, marker, { commandEcho: 'echo hi' });
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(output, 'hi\n');
});

await test('buildMarkerRegex: matches only exact marker (random suffix is unguessable)', () => {
  const a = '__MCP_EOC_aaaaaaaaaaaaaaaa';
  const b = '__MCP_EOC_bbbbbbbbbbbbbbbb';
  const regex = buildMarkerRegex(a);
  // B's marker line must not match A's regex.
  const spoof = `user wrote: __MCP_EOC_ stuff\n${b} 0\n`;
  assert(!regex.test(spoof), 'regex must not match different marker');
  // A's own marker line must match.
  assert(regex.test(`output\n${a} 7\n`), 'regex matches own marker');
});

// --------------------------------------------------------------------------
// Stream-level: SSHSessionV2 with FakeShellStream
// --------------------------------------------------------------------------

await test('runCommand: writes wrapped command to stream (marker preamble present)', async () => {
  const stream = new FakeShellStream({ scriptFor: () => ({ stdout: 'ok\n', exit: 0 }) });
  const sess = new SSHSessionV2({ id: 'sess_x', server: 's', shell: 'bash', stream });
  const res = await sess.runCommand('pwd', { timeoutMs: 2000 });
  assert.strictEqual(res.exit_code, 0);
  // Verify the stream actually saw the marker wrapper
  const w = stream.writes.join('');
  assert(w.includes('{ pwd'), 'wrapper grouping');
  assert(w.includes(`'${sess.marker}'`), 'marker embedded in printf');
  assert(w.includes('__rc=$?'), '__rc snapshot');
  await sess.close();
});

await test('runCommand: exit code 42 is extracted from sentinel line', async () => {
  const stream = new FakeShellStream({
    scriptFor: () => ({ stdout: 'oops\n', exit: 42 }),
  });
  const sess = new SSHSessionV2({ id: 'sess_y', server: 's', shell: 'bash', stream });
  const res = await sess.runCommand('false', { timeoutMs: 2000 });
  assert.strictEqual(res.exit_code, 42);
  assert(res.stdout.includes('oops'));
  await sess.close();
});

await test('runCommand: PS1 containing $ or # in output does NOT trigger premature resolve', async () => {
  const stream = new FakeShellStream({
    scriptFor: () => ({
      // Output with $ and # characters -- the old regex-based detector would
      // have erroneously matched `> ` at end of line. Marker ignores them.
      stdout: 'user@host$ echo something\n' +
              'root# su succeeded\n' +
              'var=$foo\n' +
              'final line\n',
      exit: 0,
    }),
  });
  const sess = new SSHSessionV2({ id: 'sess_z', server: 's', shell: 'bash', stream });
  const res = await sess.runCommand('emit-fake-prompts', { timeoutMs: 2000 });
  assert.strictEqual(res.exit_code, 0);
  assert(res.stdout.includes('user@host$'), 'fake $ prompt preserved');
  assert(res.stdout.includes('root#'), 'fake # prompt preserved');
  assert(res.stdout.includes('var=$foo'), '$foo preserved');
  assert(res.stdout.includes('final line'), 'full output captured');
  await sess.close();
});

await test('runCommand: multi-line output (500 lines) preserved intact', async () => {
  const big = Array.from({ length: 500 }, (_, i) => `ln${i}`).join('\n') + '\n';
  const stream = new FakeShellStream({ scriptFor: () => ({ stdout: big, exit: 0 }) });
  const sess = new SSHSessionV2({ id: 'sess_big', server: 's', shell: 'bash', stream });
  const res = await sess.runCommand('ls /big', { timeoutMs: 2000 });
  assert.strictEqual(res.exit_code, 0);
  const lines = res.stdout.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 500);
  assert.strictEqual(lines[0], 'ln0');
  assert.strictEqual(lines[499], 'ln499');
  await sess.close();
});

await test('runCommand: ANSI color codes around marker still detected', async () => {
  const stream = new FakeShellStream({
    scriptFor: (_cmd, marker) => ({
      stdout: '\x1b[31mred text\x1b[0m\n',
      exit: 0,
      // Override echo so the marker emission includes a leading color reset.
      // The script table engine emits stdout then marker line automatically,
      // but for this test we need to inject ANSI *around* the marker. We
      // use skipMarker + customEcho to craft the wire precisely.
    }),
  });
  // Pivot: bypass the normal scriptFor for ANSI-around-marker by using a
  // direct scriptFor that emits the marker itself.
  const streamAnsi = new FakeShellStream({
    scriptFor: () => ({
      stdout: '\x1b[31mred text\x1b[0m\n',
      exit: 0,
      skipMarker: true, // we emit marker ourselves below with ANSI padding
    }),
  });
  // Override the data emission for ANSI padding: hook `writes` by patching
  // the emission path via a temporary listener.
  const sess = new SSHSessionV2({ id: 'sess_ansi', server: 's', shell: 'bash', stream: streamAnsi });
  // Emit the ANSI-padded marker line manually *after* we let the script run.
  // We patch scriptFor via a late data emission scheduled on write.
  const origWrite = streamAnsi.write.bind(streamAnsi);
  streamAnsi.write = (buf) => {
    const rv = origWrite(buf);
    // After the script fires, also emit an ANSI-decorated marker line
    setTimeout(() => {
      streamAnsi.emit('data', Buffer.from(`\x1b[32m${sess.marker} 0\x1b[0m\n`));
    }, 5);
    return rv;
  };
  const res = await sess.runCommand('red', { timeoutMs: 2000 });
  assert.strictEqual(res.exit_code, 0);
  assert(res.stdout.includes('red text'), 'stdout preserved');
  assert(!res.stdout.includes('\x1b['), 'ANSI stripped');
  await sess.close();
});

await test('runCommand: timeout cancels and rejects', async () => {
  const stream = new FakeShellStream({
    scriptFor: () => ({ stdout: 'slow\n', exit: 0, skipMarker: true }), // never emit marker
  });
  const sess = new SSHSessionV2({ id: 'sess_to', server: 's', shell: 'bash', stream });
  let err = null;
  try {
    await sess.runCommand('sleep 1000', { timeoutMs: 80 });
  } catch (e) { err = e; }
  assert(err, 'expected timeout error');
  assert(/timeout/i.test(err.message), `got: ${err.message}`);
  await sess.close();
});

// --------------------------------------------------------------------------
// Handler-level integration
// --------------------------------------------------------------------------

function makeSeedingStream({ pwdOut = '/home/foo\n', userOut = 'foo\n', homeOut = '/home/foo\n' } = {}) {
  return new FakeShellStream({
    scriptFor: (cmd) => {
      if (cmd === 'pwd') return { stdout: pwdOut, exit: 0 };
      if (cmd === 'whoami') return { stdout: userOut, exit: 0 };
      if (cmd === 'echo $HOME') return { stdout: homeOut, exit: 0 };
      return { stdout: '', exit: 0 };
    },
  });
}

await test('session_start: seeds cwd + user + home from initial commands', async () => {
  const stream = makeSeedingStream({ pwdOut: '/var/work\n', userOut: 'alice\n', homeOut: '/home/alice\n' });
  const r = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 'prod01', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.cwd, '/var/work');
  assert.strictEqual(parsed.data.user, 'alice');
  assert.strictEqual(parsed.data.home, '/home/alice');
  assert(/^sess_[0-9a-f]{16}$/.test(parsed.data.session_id));
  await handleSshSessionClose({ args: { session_id: parsed.data.session_id } });
});

await test('session_start: markdown render shows session_id + cwd + user', async () => {
  const stream = makeSeedingStream({ pwdOut: '/opt/app\n', userOut: 'bob\n' });
  const r = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 'dev', format: 'markdown' },
  });
  const md = r.content[0].text;
  assert(md.startsWith('[ok] **ssh_session_start**'), `got: ${md.slice(0, 80)}`);
  assert(md.includes('session_id'));
  assert(md.includes('/opt/app'));
  assert(md.includes('bob'));
  // Cleanup
  for (const id of [..._sessionsForTest().keys()]) {
    await handleSshSessionClose({ args: { session_id: id } });
  }
});

await test('session_send: returns cwd_after reflecting `cd /tmp`', async () => {
  // Stateful stream: after `cd /tmp` runs, pwd returns /tmp.
  let currentCwd = '/home/foo';
  const stream = new FakeShellStream({
    scriptFor: (cmd) => {
      if (cmd === 'pwd') return { stdout: currentCwd + '\n', exit: 0 };
      if (cmd === 'whoami') return { stdout: 'foo\n', exit: 0 };
      if (cmd === 'echo $HOME') return { stdout: '/home/foo\n', exit: 0 };
      if (cmd === 'cd /tmp') { currentCwd = '/tmp'; return { stdout: '', exit: 0 }; }
      return { stdout: '', exit: 0 };
    },
  });
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  const r = await handleSshSessionSend({
    args: { session_id, command: 'cd /tmp', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.cwd_after, '/tmp');
  await handleSshSessionClose({ args: { session_id } });
});

await test('session_send: updates command_history (replay sees it)', async () => {
  const stream = makeSeedingStream();
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  await handleSshSessionSend({ args: { session_id, command: 'echo one', format: 'json' } });
  await handleSshSessionSend({ args: { session_id, command: 'echo two', format: 'json' } });

  const rep = await handleSshSessionReplay({ args: { session_id, limit: 10, format: 'json' } });
  const parsed = JSON.parse(rep.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.commands.length, 2);
  assert.strictEqual(parsed.data.commands[0].cmd, 'echo one');
  assert.strictEqual(parsed.data.commands[1].cmd, 'echo two');
  assert.strictEqual(parsed.data.commands[0].exit_code, 0);

  await handleSshSessionClose({ args: { session_id } });
});

await test('session_send: timeout cancels and returns structured error', async () => {
  // Stream that never emits the marker for user commands -> forces timeout.
  const stream = new FakeShellStream({
    scriptFor: (cmd) => {
      if (cmd === 'pwd') return { stdout: '/home/foo\n', exit: 0 };
      if (cmd === 'whoami') return { stdout: 'foo\n', exit: 0 };
      if (cmd === 'echo $HOME') return { stdout: '/home/foo\n', exit: 0 };
      // For the user's command, never emit marker.
      return { stdout: 'slow...\n', exit: 0, skipMarker: true };
    },
  });
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  const r = await handleSshSessionSend({
    args: { session_id, command: 'sleep forever', timeout: 100, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(/timeout/i.test(parsed.error), `got: ${parsed.error}`);

  await handleSshSessionClose({ args: { session_id } });
});

await test('session_list: all active sessions shown with last_activity', async () => {
  await cleanupAllSessions();
  const s1 = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream()),
    args: { server: 'a', format: 'json' },
  });
  const s2 = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream()),
    args: { server: 'b', format: 'json' },
  });
  const id1 = JSON.parse(s1.content[0].text).data.session_id;
  const id2 = JSON.parse(s2.content[0].text).data.session_id;

  const r = await handleSshSessionList({ args: { format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.total, 2);
  const ids = parsed.data.sessions.map(x => x.session_id);
  assert(ids.includes(id1));
  assert(ids.includes(id2));
  for (const s of parsed.data.sessions) {
    assert(s.last_activity, 'last_activity present');
    assert(s.started_at, 'started_at present');
  }
  await cleanupAllSessions();
});

await test('session_close: idempotent -- second call is success with already_closed', async () => {
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream()),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  const first = await handleSshSessionClose({ args: { session_id, format: 'json' } });
  const firstP = JSON.parse(first.content[0].text);
  assert.strictEqual(firstP.success, true);
  assert.notStrictEqual(firstP.data.already_closed, true, 'first close is the real close');

  const second = await handleSshSessionClose({ args: { session_id, format: 'json' } });
  const secondP = JSON.parse(second.content[0].text);
  assert.strictEqual(secondP.success, true, 'second close is NOT an error');
  assert.strictEqual(secondP.data.already_closed, true);
});

await test('session_close: session_id="all" closes every tracked session (C4)', async () => {
  await cleanupAllSessions();
  const streams = [makeSeedingStream(), makeSeedingStream(), makeSeedingStream()];
  const ids = [];
  for (const s of streams) {
    const started = await handleSshSessionStart({
      getConnection: async () => makeFakeClient(s),
      args: { server: 's', format: 'json' },
    });
    ids.push(JSON.parse(started.content[0].text).data.session_id);
  }

  const r = await handleSshSessionClose({ args: { session_id: 'all', format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.closed_count, 3, 'all three sessions should be reported closed');
  const closedIds = parsed.data.sessions.map(s => s.session_id).sort();
  assert.deepStrictEqual(closedIds, [...ids].sort(), 'every started session must appear in the result');

  // Registry must be empty afterwards.
  const list = await handleSshSessionList({ args: { format: 'json' } });
  assert.strictEqual(JSON.parse(list.content[0].text).data.total, 0);

  // Each stream must have received exit\n + end().
  for (const s of streams) {
    assert(s.writes.join('').includes('exit\n'));
    assert.strictEqual(s.endCalls, 1);
  }
});

await test('session_close: gracefully writes `exit` and ends the stream', async () => {
  const stream = makeSeedingStream();
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  await handleSshSessionClose({ args: { session_id, format: 'json' } });
  // The stream should have seen an `exit\n` write and end() called.
  const joined = stream.writes.join('');
  assert(joined.includes('exit\n'), 'sent exit\\n');
  assert.strictEqual(stream.endCalls, 1, 'stream.end() called once');
});

await test('session_replay: returns last-N commands in order, bounded by limit', async () => {
  await cleanupAllSessions();
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream()),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  for (let i = 0; i < 5; i++) {
    await handleSshSessionSend({
      args: { session_id, command: `echo ${i}`, format: 'json' },
    });
  }

  const r = await handleSshSessionReplay({
    args: { session_id, limit: 3, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.commands.length, 3);
  assert.strictEqual(parsed.data.total, 5);
  // Should be the *last* 3 in order: echo 2, 3, 4.
  assert.strictEqual(parsed.data.commands[0].cmd, 'echo 2');
  assert.strictEqual(parsed.data.commands[1].cmd, 'echo 3');
  assert.strictEqual(parsed.data.commands[2].cmd, 'echo 4');

  await handleSshSessionClose({ args: { session_id } });
});

await test('session_memory: returns full memory snapshot', async () => {
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream({ pwdOut: '/srv\n', userOut: 'svc\n', homeOut: '/home/svc\n' })),
    args: { server: 'node1', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;
  await handleSshSessionSend({ args: { session_id, command: 'cat /etc/hosts', format: 'json' } });

  const r = await handleSshSessionMemory({ args: { session_id, format: 'json' } });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.cwd, '/srv');
  assert.strictEqual(parsed.data.user, 'svc');
  assert.strictEqual(parsed.data.home, '/home/svc');
  assert.strictEqual(parsed.data.command_count, 1);
  assert.strictEqual(parsed.data.command_history.length, 1);
  assert(parsed.data.files_touched.includes('/etc/hosts'),
    `files_touched: ${JSON.stringify(parsed.data.files_touched)}`);

  await handleSshSessionClose({ args: { session_id } });
});

await test('command_history ring: after 60 commands, only last 50 remembered', async () => {
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(makeSeedingStream()),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  for (let i = 0; i < 60; i++) {
    await handleSshSessionSend({
      args: { session_id, command: `echo cmd-${i}`, format: 'json' },
    });
  }

  const r = await handleSshSessionReplay({
    args: { session_id, limit: 100, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.commands.length, 50, 'ring-bounded to 50');
  // First retained command is cmd-10 (oldest kept).
  assert.strictEqual(parsed.data.commands[0].cmd, 'echo cmd-10');
  assert.strictEqual(parsed.data.commands[49].cmd, 'echo cmd-59');

  await handleSshSessionClose({ args: { session_id } });
});

await test('session_send: unknown session_id returns structured failure', async () => {
  const r = await handleSshSessionSend({
    args: { session_id: 'sess_0000000000000000', command: 'ls', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('unknown session_id'));
});

await test('output containing coincidental "__MCP_EOC_" prefix does NOT trigger premature resolve', async () => {
  // Per-session random suffix makes this safe. A user can print the literal
  // string "__MCP_EOC_deadbeef" (short) and it won't match because the live
  // session's marker has a different, unpredictable suffix.
  const stream = new FakeShellStream({
    scriptFor: (cmd, marker) => {
      if (cmd === 'pwd' || cmd === 'whoami' || cmd === 'echo $HOME') {
        return { stdout: 'x\n', exit: 0 };
      }
      // Print a LITERAL "__MCP_EOC_" prefix followed by garbage, then the
      // real marker. The garbage must NOT be parsed as a marker line.
      const garbage = '__MCP_EOC_deadbeef 999\n'; // too-short hex, wrong suffix
      const alsoGarbage = '__MCP_EOC_1234567890abcdef 13\n'; // correct shape but wrong suffix
      return {
        stdout: garbage + alsoGarbage + 'real output\n',
        exit: 0,
      };
    },
  });
  const started = await handleSshSessionStart({
    getConnection: async () => makeFakeClient(stream),
    args: { server: 's', format: 'json' },
  });
  const { session_id } = JSON.parse(started.content[0].text).data;

  const r = await handleSshSessionSend({
    args: { session_id, command: 'try-to-spoof', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.exit_code, 0);
  // The spoofed "__MCP_EOC_..." lines must have been preserved in output,
  // not consumed as markers, and the real exit (0) came from the real marker.
  assert(parsed.data.stdout.includes('real output'),
    `stdout: ${JSON.stringify(parsed.data.stdout)}`);

  await handleSshSessionClose({ args: { session_id } });
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
await cleanupAllSessions();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
