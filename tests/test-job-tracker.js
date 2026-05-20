#!/usr/bin/env node
/**
 * Test suite for src/job-tracker.js -- ssh_run detach/job-status/job-kill.
 * Run: node tests/test-job-tracker.js
 */
import assert from 'assert';
import {
  JOBS_ROOT,
  newJobId,
  buildDetachCommand,
  buildJobStatusCommand,
  parseJobStatus,
  buildJobKillCommand,
} from '../src/job-tracker.js';

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

console.log('[test] Testing job-tracker\n');

// --- JOBS_ROOT -----------------------------------------------------------
test('JOBS_ROOT: jobs live under ~/.ssh-manager/jobs', () => {
  assert.strictEqual(JOBS_ROOT, '$HOME/.ssh-manager/jobs');
});

// --- newJobId ------------------------------------------------------------
test('newJobId: returns a non-empty, shell-safe id', () => {
  const id = newJobId();
  assert(typeof id === 'string' && id.length > 0);
  // Only safe characters -- the id becomes a directory name.
  assert(/^[A-Za-z0-9_-]+$/.test(id), 'id is filesystem/shell safe');
});

test('newJobId: successive ids are unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newJobId());
  assert.strictEqual(seen.size, 200, 'no collisions across 200 ids');
});

test('newJobId: every generated id passes the job-id guard', () => {
  // A generated id must always be a legal job-status/kill target.
  for (let i = 0; i < 200; i++) {
    assert.doesNotThrow(() => buildJobStatusCommand(newJobId()));
  }
});

// --- buildDetachCommand --------------------------------------------------
test('buildDetachCommand: creates the per-job dir and returns {jobId, command, ...}', () => {
  const r = buildDetachCommand('long-build.sh');
  assert(r.jobId, 'job id present');
  assert(r.command.includes('mkdir -p'), 'job dir created');
  assert(r.command.includes(r.jobId), 'job dir path uses the id');
  assert(r.logPath.includes(r.jobId), 'log path under the job dir');
});

test('buildDetachCommand: detaches with setsid and writes rc on completion', () => {
  const r = buildDetachCommand('make all');
  assert(r.command.includes('setsid'), 'detached from the SSH session');
  // `echo $? > .../rc` -- completion marker, written after the command.
  assert(/echo \$\? >/.test(r.command), 'rc file captures the exit code');
  assert(r.command.includes('/rc'), 'rc file inside the job dir');
});

test('buildDetachCommand: records the pid for later job-kill', () => {
  const r = buildDetachCommand('sleep 100');
  // `echo $! > .../pid` -- the backgrounded pid.
  assert(/echo \$! >/.test(r.command), 'pid recorded');
  assert(r.command.includes('/pid'), 'pid file inside the job dir');
});

test('buildDetachCommand: log + stderr both redirected into the job log', () => {
  const r = buildDetachCommand('noisy.sh');
  assert(r.command.includes('2>&1'), 'stderr folded into stdout');
  assert(r.command.includes('/log'), 'job log inside the job dir');
});

test('buildDetachCommand: the user command is shell-quoted (injection-safe)', () => {
  const r = buildDetachCommand("x'; rm -rf /");
  // The injection must only appear inside the sh -c quoted argument, never at
  // the outer shell level before setsid. POSIX single-quoting of the inner
  // script keeps the rm text inside an sh-c argument (causes sh syntax error
  // for the injected script rather than executing arbitrary commands).
  const shIdx = r.command.indexOf('setsid sh -c ');
  const rmIdx = r.command.indexOf('rm -rf /');
  assert(shIdx >= 0, 'inner script passed via setsid sh -c');
  assert(rmIdx > shIdx, 'rm text only appears inside the sh -c argument');
});

test('buildDetachCommand: an explicit job id is honored', () => {
  const r = buildDetachCommand('echo hi', { jobId: 'fixed-id-1' });
  assert.strictEqual(r.jobId, 'fixed-id-1');
  assert(r.command.includes('fixed-id-1'));
});

test('buildDetachCommand: a hostile explicit job id is rejected', () => {
  assert.throws(() => buildDetachCommand('echo hi', { jobId: '../x' }), /invalid job id/);
  assert.throws(() => buildDetachCommand('echo hi', { jobId: 'a;b' }), /invalid job id/);
  assert.throws(() => buildDetachCommand('echo hi', { jobId: '$(x)' }), /invalid job id/);
});

test('buildDetachCommand: empty command is rejected', () => {
  assert.throws(() => buildDetachCommand(''), /command is required/);
  assert.throws(() => buildDetachCommand(null), /command is required/);
});

// --- buildJobStatusCommand -----------------------------------------------
test('buildJobStatusCommand: reads rc, pid, and the log size', () => {
  const cmd = buildJobStatusCommand('job-7');
  assert(cmd.includes('job-7'), 'targets the job dir');
  assert(cmd.includes('/rc'), 'reads the rc file');
  assert(cmd.includes('/pid'), 'reads the pid file');
  assert(cmd.includes('/log'), 'inspects the log');
});

test('buildJobStatusCommand: emits parseable key markers', () => {
  const cmd = buildJobStatusCommand('j');
  // The command prints lines the parser keys on.
  assert(cmd.includes('RC='), 'rc marker emitted');
  assert(cmd.includes('PID='), 'pid marker emitted');
  assert(cmd.includes('LOGSIZE='), 'log size marker emitted');
});

test('buildJobStatusCommand: reads the log tail from a byte offset', () => {
  const cmd = buildJobStatusCommand('j', { offset: 4096 });
  // tail -c +N is 1-indexed: +1 = whole file, so offset 4096 -> +4097 to skip
  // exactly 4096 bytes. The literal 4097 appears in the command (off + 1).
  assert(cmd.includes('4097'), 'offset + 1 threaded into tail -c (1-indexed)');
  assert(/tail -c|dd .*bs=1.*skip=/.test(cmd), 'reads from the offset');
});

test('buildJobStatusCommand: a negative offset clamps to a positive tail -c', () => {
  // A wrapped/negative offset must never produce `tail -c +-N`.
  const cmd = buildJobStatusCommand('j', { offset: -500 });
  assert(/tail -c \+1 /.test(cmd), 'negative offset clamps to +1 (whole file)');
  assert(!cmd.includes('+-'), 'no negative argument to tail -c');
});

test('buildJobStatusCommand: a huge (>2^31) offset stays a positive tail -c', () => {
  // 3 GiB log: 32-bit `| 0` would wrap negative; Math.floor keeps it positive.
  const huge = 3 * 1024 * 1024 * 1024; // 3221225472, > 2^31
  const cmd = buildJobStatusCommand('j', { offset: huge });
  assert(cmd.includes(String(huge + 1)), 'huge offset + 1 threaded verbatim');
  assert(!cmd.includes('+-'), 'no negative argument to tail -c');
});

test('buildJobStatusCommand: a missing job dir is reported, not a hard error', () => {
  const cmd = buildJobStatusCommand('gone');
  // The command tolerates absence so the parser can say "unknown".
  assert(/MISSING|2>\/dev\/null|test -d/.test(cmd), 'absence handled in-band');
});

test('buildJobStatusCommand: empty job id is rejected', () => {
  assert.throws(() => buildJobStatusCommand(''), /invalid job id/);
});

test('buildJobStatusCommand: a hostile job id is rejected', () => {
  assert.throws(() => buildJobStatusCommand('../x'), /invalid job id/);
  assert.throws(() => buildJobStatusCommand('a;b'), /invalid job id/);
  assert.throws(() => buildJobStatusCommand('$(x)'), /invalid job id/);
});

// --- parseJobStatus ------------------------------------------------------
test('parseJobStatus: rc file present -> done with that exit code', () => {
  const st = parseJobStatus(
    'STATE=present\nRC=0\nPID=1234\nLOGSIZE=512\n##LOG##\nbuild complete',
  );
  assert.strictEqual(st.state, 'done');
  assert.strictEqual(st.exitCode, 0);
  assert.strictEqual(st.logChunk, 'build complete');
  assert.strictEqual(st.logSize, 512);
});

test('parseJobStatus: rc present and non-zero -> done, failure exit surfaced', () => {
  const st = parseJobStatus('STATE=present\nRC=2\nPID=99\nLOGSIZE=10\n##LOG##\nerr');
  assert.strictEqual(st.state, 'done');
  assert.strictEqual(st.exitCode, 2);
});

test('parseJobStatus: no rc file -> running, exit code is null', () => {
  // rc absent: the status command prints RC= empty. Job not finished.
  const st = parseJobStatus('STATE=present\nRC=\nPID=4567\nLOGSIZE=88\n##LOG##\npartial');
  assert.strictEqual(st.state, 'running', 'rc absent => running, NOT pid-checked');
  assert.strictEqual(st.exitCode, null);
  assert.strictEqual(st.pid, 4567);
});

test('parseJobStatus: completion ignores PID liveness entirely', () => {
  // rc present even though PID would look dead -- still done. No PID-reuse race.
  const st = parseJobStatus('STATE=present\nRC=0\nPID=\nLOGSIZE=4\n##LOG##\nout');
  assert.strictEqual(st.state, 'done', 'rc presence wins; empty PID irrelevant');
});

test('parseJobStatus: missing job dir -> unknown state', () => {
  const st = parseJobStatus('STATE=missing');
  assert.strictEqual(st.state, 'unknown');
});

test('parseJobStatus: logSize feeds the next incremental read', () => {
  const st = parseJobStatus('STATE=present\nRC=\nPID=1\nLOGSIZE=2048\n##LOG##\n');
  assert.strictEqual(st.logSize, 2048, 'caller passes this back as next offset');
});

// --- buildJobKillCommand -------------------------------------------------
test('buildJobKillCommand: reads the recorded pid for the job', () => {
  const cmd = buildJobKillCommand('job-9');
  assert(cmd.includes('job-9'), 'targets the job dir');
  assert(cmd.includes('/pid'), 'reads the pid file');
  assert(cmd.includes('cat '), 'cat the pid file');
});

test('buildJobKillCommand: kills the process GROUP, not just the pid', () => {
  const cmd = buildJobKillCommand('j');
  // setsid makes the job a group leader; kill -<SIG> -<pgid> hits the group.
  assert(/kill -[A-Z]+ -/.test(cmd) || cmd.includes('-- -'), 'negative pid => process group');
});

test('buildJobKillCommand: escalates TERM then KILL', () => {
  const cmd = buildJobKillCommand('j');
  assert(cmd.includes('TERM'), 'graceful TERM first');
  assert(cmd.includes('KILL'), 'KILL escalation');
  // KILL must come after TERM in the command text.
  assert(cmd.indexOf('TERM') < cmd.indexOf('KILL'), 'TERM precedes KILL');
});

test('buildJobKillCommand: tolerates a missing or already-dead job', () => {
  const cmd = buildJobKillCommand('gone');
  assert(/2>\/dev\/null|test -|MISSING/.test(cmd), 'absence handled in-band');
});

test('buildJobKillCommand: empty job id is rejected', () => {
  assert.throws(() => buildJobKillCommand(''), /invalid job id/);
  assert.throws(() => buildJobKillCommand(null), /invalid job id/);
});

test('buildJobKillCommand: a hostile job id is rejected', () => {
  assert.throws(() => buildJobKillCommand('../x'), /invalid job id/);
  assert.throws(() => buildJobKillCommand('a;b'), /invalid job id/);
  assert.throws(() => buildJobKillCommand('$(x)'), /invalid job id/);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
