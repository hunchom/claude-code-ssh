#!/usr/bin/env node
/**
 * Routing suite for the ssh_run v4 dispatcher (src/dispatchers/ssh-run.js).
 * Confirms each action lands on the right handler with the right context
 * object and arg mapping. Handlers are replaced by spies via the deps object.
 * Run: node tests/test-dispatcher-run.js
 */
import assert from 'assert';
import { handleSshRun } from '../src/dispatchers/ssh-run.js';
import { handleSshExecuteGroup } from '../src/tools/exec-tools.js';

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

// A spy that records the single ctx object it was called with.
function spy(ret = { content: [{ type: 'text', text: 'ok' }], isError: false }) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return ret; };
  fn.calls = calls;
  return fn;
}

const DEPS = {
  getConnection: () => 'CONN',
  getServerConfig: () => ({ default_dir: '/srv' }),
  resolveGroup: (g) => ({ name: g, servers: ['a', 'b'] }),
};

console.log('[test] Testing ssh_run dispatcher\n');

// --- routing -------------------------------------------------------------
await test('exec routes to handlers.execute with { getConnection, args }', async () => {
  const execute = spy();
  await handleSshRun({
    deps: DEPS,
    handlers: { execute },
    args: { server: 's', action: 'exec', command: 'ls' },
  });
  assert.strictEqual(execute.calls.length, 1);
  const ctx = execute.calls[0];
  assert.strictEqual(ctx.getConnection, DEPS.getConnection);
  assert.strictEqual(ctx.args.command, 'ls');
  assert.strictEqual(ctx.args.server, 's');
  assert.strictEqual(ctx.resolveGroup, undefined, 'exec ctx carries no resolveGroup');
});

await test('exec forwards timeout to the handler as timeout', async () => {
  const execute = spy();
  await handleSshRun({
    deps: DEPS, handlers: { execute },
    args: { server: 's', action: 'exec', command: 'ls', timeout: 9000 },
  });
  assert.strictEqual(execute.calls[0].args.timeout, 9000);
});

await test('exec expands a command alias before passing to the handler', async () => {
  const execute = spy();
  // deps.expandCommandAlias override seam: "gs" alias -> "git status -sb"
  await handleSshRun({
    deps: { ...DEPS, expandCommandAlias: (c) => (c === 'gs' ? 'git status -sb' : c) },
    handlers: { execute },
    args: { server: 's', action: 'exec', command: 'gs' },
  });
  assert.strictEqual(execute.calls[0].args.command, 'git status -sb');
});

await test('sudo expands a command alias before passing to the handler', async () => {
  const executeSudo = spy();
  await handleSshRun({
    deps: { ...DEPS, expandCommandAlias: (c) => (c === 'rs' ? 'systemctl restart nginx' : c) },
    handlers: { executeSudo },
    args: { server: 's', action: 'sudo', command: 'rs' },
  });
  assert.strictEqual(executeSudo.calls[0].args.command, 'systemctl restart nginx');
});

await test('sudo routes to handlers.executeSudo with getServerConfig in ctx', async () => {
  const executeSudo = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeSudo },
    args: { server: 's', action: 'sudo', command: 'systemctl restart nginx' },
  });
  assert.strictEqual(executeSudo.calls.length, 1);
  assert.strictEqual(executeSudo.calls[0].getServerConfig, DEPS.getServerConfig);
});

await test('sudo maps sudo_password -> password and forwards timeout', async () => {
  const executeSudo = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeSudo },
    args: { server: 's', action: 'sudo', command: 'id', sudo_password: 'pw', timeout: 5000 },
  });
  assert.strictEqual(executeSudo.calls[0].args.password, 'pw');
  assert.strictEqual(executeSudo.calls[0].args.timeout, 5000);
});

await test('fleet routes to handlers.executeGroup with resolveGroup in ctx', async () => {
  const executeGroup = spy();
  await handleSshRun({
    deps: DEPS, handlers: { executeGroup },
    args: { action: 'fleet', group: 'web', command: 'uptime' },
  });
  assert.strictEqual(executeGroup.calls.length, 1);
  assert.strictEqual(executeGroup.calls[0].resolveGroup, DEPS.resolveGroup);
  assert.strictEqual(executeGroup.calls[0].getConnection, DEPS.getConnection);
});

// End-to-end through the REAL handleSshExecuteGroup -- DEPS.resolveGroup yields
// the production { name, servers:[...] } object, not a bare array.
await test('fleet end-to-end: real handler accepts the production object shape', async () => {
  const r = await handleSshRun({
    deps: {
      ...DEPS,
      getConnection: async () => fakeClient('uptime-out'),
      // exact shape DEPS.resolveGroup returns in src/index.js
      resolveGroup: (g) => ({ name: g, servers: ['a', 'b'] }),
    },
    handlers: { executeGroup: handleSshExecuteGroup },
    args: { action: 'fleet', group: 'web', command: 'uptime', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true, 'object-shape group runs, no OOM loop');
  assert.strictEqual(res.data.total, 2);
  assert.strictEqual(res.data.succeeded, 2);
});

// A nonexistent group: production resolveGroup catches getGroup's throw and
// returns null -> structured fail, never a raw crash through the dispatcher.
await test('fleet end-to-end: unknown group -> structured isError, no crash', async () => {
  const r = await handleSshRun({
    deps: {
      ...DEPS,
      getConnection: async () => { throw new Error('should not connect'); },
      resolveGroup: () => null, // mirrors getGroup-throws-caught path
    },
    handlers: { executeGroup: handleSshExecuteGroup },
    args: { action: 'fleet', group: 'does-not-exist', command: 'uptime' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('has no servers'));
});

// --- arg validation ------------------------------------------------------
await test('exec without command -> structured fail, handler never called', async () => {
  const execute = spy();
  const r = await handleSshRun({
    deps: DEPS, handlers: { execute },
    args: { server: 's', action: 'exec' },
  });
  assert.strictEqual(execute.calls.length, 0, 'handler not invoked');
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('command'));
});

await test('exec without server -> structured fail', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: { execute: spy() },
    args: { action: 'exec', command: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('server'));
});

await test('fleet without group -> structured fail', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: { executeGroup: spy() },
    args: { action: 'fleet', command: 'ls' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('group'));
});

await test('unknown action -> structured fail naming the action', async () => {
  const r = await handleSshRun({
    deps: DEPS, handlers: {},
    args: { server: 's', action: 'teleport' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('teleport'));
});

await test('missing action -> structured fail', async () => {
  const r = await handleSshRun({ deps: DEPS, handlers: {}, args: { server: 's' } });
  assert.strictEqual(r.isError, true);
});

// --- fake ssh2 client for the exec-direct actions (script/detach/jobs) ---
function fakeClient(stdout) {
  const script = [];
  const client = {
    exec(command, cb) {
      script.push(command);
      const listeners = {};
      const stream = {
        stderr: { on() { return stream.stderr; } },
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return stream; },
        close() {},
        signal() {},
      };
      cb(null, stream);
      setImmediate(() => {
        const out = typeof stdout === 'function' ? stdout(command) : stdout;
        for (const fn of listeners.data || []) fn(Buffer.from(out));
        for (const fn of listeners.close || []) fn(0, null);
      });
      return client;
    },
  };
  client.script = script;
  return client;
}

// --- script action ------------------------------------------------------
await test('script without commands -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'script' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('script runs the joined command and threads the real nonce to the parser', async () => {
  // The fake echoes back a sentinel block built from the SAME nonce the
  // dispatcher generated; only a correctly-threaded nonce parses it.
  const client = fakeClient((command) => {
    const m = command.match(/##SEG-([0-9a-f]{12}) /);
    const nonce = m ? m[1] : 'BADNONCE';
    return `a-out\n##SEG-${nonce} 0 0##\nb-out\n##SEG-${nonce} 1 0##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['echo a', 'echo b'], format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'script');
  assert.strictEqual(res.data.segments.length, 2,
    'nonce threaded correctly -> both segments parsed');
  assert.strictEqual(res.data.segments[0].stdout, 'a-out');
  assert.strictEqual(res.data.segments[0].exitCode, 0);
  assert.strictEqual(res.data.segments[0].command, 'echo a');
  assert.strictEqual(res.data.segments[1].stdout, 'b-out');
});

await test('script surfaces a per-segment non-zero exit code', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `ok\n##SEG-${nonce} 0 0##\n\n##SEG-${nonce} 1 127##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['true', 'nosuchcmd'], format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.segments[1].exitCode, 127);
});

await test('script isolate:true wraps each segment in its own sh -c', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `\n##SEG-${nonce} 0 0##\n\n##SEG-${nonce} 1 0##\n`;
  });
  await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'script', commands: ['cd /tmp', 'pwd'], isolate: true },
  });
  const subs = client.script[0].match(/sh -c /g) || [];
  assert.strictEqual(subs.length, 2, 'one sub-shell per segment when isolated');
});

await test('script renders a per-segment table in the markdown face', async () => {
  const client = fakeClient((command) => {
    const nonce = command.match(/##SEG-([0-9a-f]{12}) /)[1];
    return `hello\n##SEG-${nonce} 0 0##\n`;
  });
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'script', commands: ['echo hello'] },
  });
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('echo hello'), 'segment command rendered');
});

await test('script connection failure -> structured fail', async () => {
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => { throw new Error('host down'); } },
    handlers: {}, args: { server: 's', action: 'script', commands: ['echo x'] },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('host down'));
});

// --- detach action ------------------------------------------------------
await test('detach without command -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'detach' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('detach launches a setsid job and returns its job id', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'long-build.sh', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'detach');
  assert(typeof res.data.job_id === 'string' && res.data.job_id.length > 0,
    'job id returned for later job-status / job-kill');
  assert(client.script[0].includes('setsid'), 'job detached from the SSH session');
  assert(client.script[0].includes(res.data.job_id), 'launch command uses the job id');
});

await test('detach returns the log path for incremental reads', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'make all', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert(res.data.log_path.includes(res.data.job_id), 'log path under the job dir');
});

await test('detach honors an explicit job_id', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: {
      server: 's', action: 'detach', command: 'echo hi',
      job_id: 'my-build-1', format: 'json',
    },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.job_id, 'my-build-1');
});

await test('detach with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'detach', command: 'echo hi', job_id: '../x' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0, 'builder threw before exec');
});

// --- job-status action --------------------------------------------------
await test('job-status without job_id -> structured fail, never connects', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'job-status' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('job-status reports a finished job with its exit code', async () => {
  const client = fakeClient(
    'STATE=present\nRC=0\nPID=1234\nLOGSIZE=512\n##LOG##\nbuild complete');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'job-7', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'job-status');
  assert.strictEqual(res.data.state, 'done');
  assert.strictEqual(res.data.exit_code, 0);
  assert.strictEqual(res.data.log_size, 512);
  assert.strictEqual(res.data.log_chunk, 'build complete');
});

await test('job-status reports a still-running job (rc absent)', async () => {
  const client = fakeClient(
    'STATE=present\nRC=\nPID=4567\nLOGSIZE=88\n##LOG##\npartial');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'job-8', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.state, 'running');
  assert.strictEqual(res.data.exit_code, null);
});

await test('job-status threads since_offset into the status command', async () => {
  const client = fakeClient('STATE=present\nRC=\nPID=1\nLOGSIZE=9000\n##LOG##\ntail');
  await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'j', since_offset: 4096 },
  });
  // tail -c is 1-indexed: offset 4096 -> +4097
  assert(client.script[0].includes('4097'), 'since_offset + 1 threaded into tail -c');
});

await test('job-status of a missing job -> unknown state', async () => {
  const client = fakeClient('STATE=missing');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'gone', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.data.state, 'unknown');
});

await test('job-status with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-status', job_id: 'a;b' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0);
});

// --- job-kill action ----------------------------------------------------
await test('job-kill without job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {}, args: { server: 's', action: 'job-kill' },
  });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(client.script.length, 0);
});

await test('job-kill signals the job process group and reports back', async () => {
  const client = fakeClient('killed 4567');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-kill', job_id: 'job-9', format: 'json' },
  });
  const res = JSON.parse(r.content[0].text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.data.action, 'job-kill');
  assert(client.script[0].includes('TERM'), 'graceful TERM in the kill command');
  assert(client.script[0].includes('KILL'), 'KILL escalation in the kill command');
  assert(String(res.data.result).includes('killed'), 'kill confirmation surfaced');
});

await test('job-kill with a hostile job_id -> structured fail', async () => {
  const client = fakeClient('');
  const r = await handleSshRun({
    deps: { ...DEPS, getConnection: async () => client },
    handlers: {},
    args: { server: 's', action: 'job-kill', job_id: '$(x)' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('invalid job id'));
  assert.strictEqual(client.script.length, 0);
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
