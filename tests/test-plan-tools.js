#!/usr/bin/env node
/**
 * Tests for src/tools/plan-tools.js.
 *
 * Strategy: inject a fake `dispatch` map. Each fake handler is a spy that
 * records invocations and returns a controlled MCP-shaped response. No SSH
 * clients, no filesystem -- plan-tools is pure composition.
 */

import assert from 'assert';
import {
  handleSshPlan,
  handleSshPlanPreview,
  stepRisk,
  normalizePlan,
} from '../src/tools/plan-tools.js';

let passed = 0, failed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

// -- Spy helper -----------------------------------------------------------
function spy(impl) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return impl ? impl(...args) : okResp('(default)');
  };
  fn.calls = calls;
  return fn;
}

function okResp(text = 'ok', extra = {}) {
  return { content: [{ type: 'text', text }], ...extra };
}
function errResp(text = 'boom') {
  return { content: [{ type: 'text', text }], isError: true };
}
function jsonResp(obj, { isError } = {}) {
  const r = { content: [{ type: 'text', text: JSON.stringify(obj) }] };
  if (isError) r.isError = true;
  return r;
}
function previewResp(plan, tool = 'ssh_exec') {
  // Mimic the shape `toMcp(preview(...))` produces at format=json
  const body = {
    success: true,
    tool,
    server: null,
    data: { preview: true, plan },
    meta: {},
  };
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

console.log('[test] Testing plan-tools\n');

// --------------------------------------------------------------------------
// stepRisk + normalizePlan (unit)
// --------------------------------------------------------------------------

await test('stepRisk: exec_sudo -> high', () => {
  assert.strictEqual(stepRisk('exec_sudo'), 'high');
});

await test('stepRisk: health_check -> low', () => {
  assert.strictEqual(stepRisk('health_check'), 'low');
});

await test('stepRisk: explicit override wins over table', () => {
  assert.strictEqual(stepRisk('exec', 'high'), 'high');
  assert.strictEqual(stepRisk('exec_sudo', 'low'), 'low');
});

await test('stepRisk: unknown action -> medium fallback', () => {
  assert.strictEqual(stepRisk('mystery_action'), 'medium');
});

await test('normalizePlan: auto-assigns step_1/step_2 when missing', () => {
  const out = normalizePlan([
    { action: 'exec', command: 'ls' },
    { action: 'exec', command: 'pwd' },
  ]);
  assert.strictEqual(out[0].step_id, 'step_1');
  assert.strictEqual(out[1].step_id, 'step_2');
});

await test('normalizePlan: preserves caller-provided step_id', () => {
  const out = normalizePlan([{ step_id: 'deploy_app', action: 'exec', command: 'x' }]);
  assert.strictEqual(out[0].step_id, 'deploy_app');
});

await test('normalizePlan: inherits plan-level default server', () => {
  const out = normalizePlan(
    [{ action: 'exec', command: 'ls' }, { action: 'exec', command: 'pwd', server: 'prod02' }],
    { defaultServer: 'prod01' }
  );
  assert.strictEqual(out[0].server, 'prod01');
  assert.strictEqual(out[1].server, 'prod02');
});

// --------------------------------------------------------------------------
// preview mode
// --------------------------------------------------------------------------

await test('preview mode: 3-step plan -> structured card, dispatch never called', async () => {
  const execSpy = spy();
  const uploadSpy = spy();
  const dispatch = { exec: execSpy, upload: uploadSpy };
  const r = await handleSshPlan({
    dispatch,
    args: {
      mode: 'preview',
      server: 'prod01',
      format: 'json',
      plan: [
        { action: 'exec', command: 'ls' },
        { action: 'upload', local_path: '/l', remote_path: '/r' },
        { action: 'exec', command: 'whoami' },
      ],
    },
  });
  assert.strictEqual(execSpy.calls.length, 0);
  assert.strictEqual(uploadSpy.calls.length, 0);
  const body = JSON.parse(r.content[0].text);
  const card = body.data.plan;
  assert.strictEqual(card.total_steps, 3);
  assert.strictEqual(card.steps.length, 3);
  assert.strictEqual(card.steps[0].step_id, 'step_1');
  assert.strictEqual(card.steps[1].action, 'upload');
});

await test('preview mode: steps inherit plan-level server and step-level override', async () => {
  const r = await handleSshPlan({
    dispatch: {},
    args: {
      mode: 'preview', server: 'prod01', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },                        // inherits prod01
        { action: 'exec', command: 'b', server: 'prod02' },      // overrides
      ],
    },
  });
  const card = JSON.parse(r.content[0].text).data.plan;
  assert.strictEqual(card.steps[0].server, 'prod01');
  assert.strictEqual(card.steps[1].server, 'prod02');
});

await test('preview mode: highest_risk "high" when any step is sudo', async () => {
  const r = await handleSshPlan({
    dispatch: {},
    args: {
      mode: 'preview', format: 'json',
      plan: [
        { action: 'health_check', server: 's' },
        { action: 'exec', command: 'ls', server: 's' },
        { action: 'exec_sudo', command: 'systemctl restart nginx', server: 's' },
      ],
    },
  });
  const card = JSON.parse(r.content[0].text).data.plan;
  assert.strictEqual(card.highest_risk, 'high');
});

await test('preview mode: highest_risk "low" when all steps are read-only', async () => {
  const r = await handleSshPlan({
    dispatch: {},
    args: {
      mode: 'preview', format: 'json',
      plan: [
        { action: 'health_check', server: 's' },
        { action: 'download', remote_path: '/r', local_path: '/l', server: 's' },
        { action: 'wait', ms: 100 },
      ],
    },
  });
  const card = JSON.parse(r.content[0].text).data.plan;
  assert.strictEqual(card.highest_risk, 'low');
});

await test('preview mode: step with rollback marks has_rollback:true', async () => {
  const r = await handleSshPlan({
    dispatch: {},
    args: {
      mode: 'preview', format: 'json',
      plan: [
        { action: 'exec', command: 'setup', server: 's', rollback: { action: 'exec', command: 'teardown' } },
        { action: 'exec', command: 'next', server: 's' },
      ],
    },
  });
  const card = JSON.parse(r.content[0].text).data.plan;
  assert.strictEqual(card.steps[0].has_rollback, true);
  assert.strictEqual(card.steps[1].has_rollback, false);
});

await test('handleSshPlanPreview: convenience wrapper behaves like mode=preview', async () => {
  const r = await handleSshPlanPreview({
    dispatch: {},
    args: { format: 'json', plan: [{ action: 'exec', command: 'ls', server: 's' }] },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.plan.mode, 'preview');
});

// --------------------------------------------------------------------------
// dry_run mode
// --------------------------------------------------------------------------

await test('dry_run: each handler invoked with preview:true; plans aggregated', async () => {
  const execSpy = spy(async ({ args }) => {
    assert.strictEqual(args.preview, true, 'handler should see preview:true');
    return previewResp({ action: 'exec', target: args.server, effects: ['would run'], reversibility: 'manual', risk: 'medium' }, 'ssh_execute');
  });
  const uploadSpy = spy(async ({ args }) => {
    assert.strictEqual(args.preview, true);
    return previewResp({ action: 'upload', target: `${args.server}:${args.remote_path}`, effects: ['uploads'], reversibility: 'manual', risk: 'medium' }, 'ssh_upload');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy, upload: uploadSpy },
    args: {
      mode: 'dry_run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'ls' },
        { action: 'upload', local_path: '/l', remote_path: '/r' },
      ],
    },
  });
  assert.strictEqual(execSpy.calls.length, 1);
  assert.strictEqual(uploadSpy.calls.length, 1);
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.data.steps.length, 2);
  assert.strictEqual(body.data.steps[0].plan.action, 'exec');
  assert.strictEqual(body.data.steps[1].plan.action, 'upload');
});

await test('dry_run: handler that ignores preview still recorded gracefully (plan=null)', async () => {
  const weirdSpy = spy(async () => okResp('I ignored preview'));
  const r = await handleSshPlan({
    dispatch: { exec: weirdSpy },
    args: {
      mode: 'dry_run', server: 's', format: 'json',
      plan: [{ action: 'exec', command: 'x' }],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.steps[0].ok, true);
  assert.strictEqual(body.data.steps[0].plan, null);
});

await test('dry_run: missing handler for action -> step marked failed, others continue', async () => {
  const execSpy = spy(async () => previewResp({ action: 'exec', target: 's', effects: [], reversibility: 'auto', risk: 'low' }));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy }, // no handler for "edit"
    args: {
      mode: 'dry_run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'ls' },
        { action: 'edit', remote_path: '/etc/x' },
        { action: 'exec', command: 'pwd' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.steps[0].ok, true);
  assert.strictEqual(body.data.steps[1].ok, false);
  assert.match(body.data.steps[1].error, /no handler/);
  assert.strictEqual(body.data.steps[2].ok, true);
});

// --------------------------------------------------------------------------
// run mode -- happy path + failure + rollback
// --------------------------------------------------------------------------

await test('run: 3 exec steps all succeed -> 3 executed, 0 failed', async () => {
  const execSpy = spy(async () => okResp('ok'));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },
        { action: 'exec', command: 'b' },
        { action: 'exec', command: 'c' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.data.steps_executed, 3);
  assert.strictEqual(body.data.steps_failed, 0);
  assert.strictEqual(body.data.rolled_back, false);
  assert.strictEqual(execSpy.calls.length, 3);
});

await test('run: step 2 fails -> step 3 skipped', async () => {
  let i = 0;
  const execSpy = spy(async () => {
    i++;
    return i === 2 ? errResp('nope') : okResp('ok');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },
        { action: 'exec', command: 'b' },
        { action: 'exec', command: 'c' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.steps_executed, 2);
  assert.strictEqual(body.data.steps_failed, 1);
  assert.strictEqual(execSpy.calls.length, 2);
  assert.strictEqual(body.data.steps[1].ok, false);
});

await test('run: step 2 fails, no rollbacks configured, rollback_on_fail:false -> no rollback walk', async () => {
  const execSpy = spy(async () => errResp('fail now'));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json', rollback_on_fail: false,
      plan: [
        { action: 'exec', command: 'a', rollback: { action: 'exec', command: 'undo_a' } },
        { action: 'exec', command: 'b' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.rolled_back, false);
  assert.strictEqual(body.data.rollback_steps.length, 0);
});

await test('run: step 2 fails with rollback -> step 1 rollback runs (reverse order)', async () => {
  const invocations = [];
  const execSpy = spy(async ({ args }) => {
    invocations.push(args.command);
    if (args.command === 'step2') return errResp('step2 bombed');
    return okResp('ok');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'step1', rollback: { action: 'exec', command: 'undo_step1' } },
        { action: 'exec', command: 'step2' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.rolled_back, true);
  assert.strictEqual(body.data.rollback_steps.length, 1);
  assert.strictEqual(body.data.rollback_steps[0].ok, true);
  assert.strictEqual(body.data.rollback_steps[0].for_step_id, 'step_1');
  // Full call sequence: step1, step2 (fails), undo_step1
  assert.deepStrictEqual(invocations, ['step1', 'step2', 'undo_step1']);
});

await test('run: rollback walks MULTIPLE completed steps in reverse order', async () => {
  const invocations = [];
  const execSpy = spy(async ({ args }) => {
    invocations.push(args.command);
    if (args.command === 'step3') return errResp('step3 bombed');
    return okResp('ok');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'step1', rollback: { action: 'exec', command: 'undo1' } },
        { action: 'exec', command: 'step2', rollback: { action: 'exec', command: 'undo2' } },
        { action: 'exec', command: 'step3', rollback: { action: 'exec', command: 'undo3' } },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.rollback_steps.length, 2);
  // Reverse order: undo2 first, then undo1. The FAILED step's own rollback (undo3) is NOT run.
  assert.deepStrictEqual(invocations, ['step1', 'step2', 'step3', 'undo2', 'undo1']);
  assert.strictEqual(body.data.rollback_steps[0].for_step_id, 'step_2');
  assert.strictEqual(body.data.rollback_steps[1].for_step_id, 'step_1');
});

await test('run: rollback step that itself fails -> captured, primary failure preserved, walk continues', async () => {
  const invocations = [];
  const execSpy = spy(async ({ args }) => {
    invocations.push(args.command);
    if (args.command === 'step3') return errResp('step3 bombed');
    if (args.command === 'undo2') return errResp('rollback of step2 also failed');
    return okResp('ok');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'step1', rollback: { action: 'exec', command: 'undo1' } },
        { action: 'exec', command: 'step2', rollback: { action: 'exec', command: 'undo2' } },
        { action: 'exec', command: 'step3' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  // Primary failure is preserved (success=false; steps_failed=1).
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.data.steps_failed, 1);
  // Both rollback entries are recorded; undo2 has error, undo1 succeeded.
  assert.strictEqual(body.data.rollback_steps.length, 2);
  const undo2Entry = body.data.rollback_steps.find(r => r.for_step_id === 'step_2');
  const undo1Entry = body.data.rollback_steps.find(r => r.for_step_id === 'step_1');
  assert.strictEqual(undo2Entry.ok, false);
  assert.match(undo2Entry.error, /rollback/i);
  assert.strictEqual(undo1Entry.ok, true);
  // Walk continued past failed rollback.
  assert.deepStrictEqual(invocations, ['step1', 'step2', 'step3', 'undo2', 'undo1']);
});

await test('run: rollback inherits original step server when not specified', async () => {
  let rollbackServer = null;
  const execSpy = spy(async ({ args }) => {
    if (args.command === 'step2') return errResp('fail');
    if (args.command === 'undo1') { rollbackServer = args.server; return okResp('ok'); }
    return okResp('ok');
  });
  await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 'default_server', format: 'json',
      plan: [
        { action: 'exec', command: 'step1', server: 'override_server',
          rollback: { action: 'exec', command: 'undo1' } },  // no server -> should inherit override_server
        { action: 'exec', command: 'step2' },
      ],
    },
  });
  assert.strictEqual(rollbackServer, 'override_server');
});

await test('run: completed step WITHOUT rollback is skipped in rollback walk', async () => {
  const invocations = [];
  const execSpy = spy(async ({ args }) => {
    invocations.push(args.command);
    if (args.command === 'step3') return errResp('fail');
    return okResp('ok');
  });
  await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'step1', rollback: { action: 'exec', command: 'undo1' } },
        { action: 'exec', command: 'step2' }, // no rollback
        { action: 'exec', command: 'step3' },
      ],
    },
  });
  // Only undo1 is invoked; step2 has no rollback.
  assert.deepStrictEqual(invocations, ['step1', 'step2', 'step3', 'undo1']);
});

// --------------------------------------------------------------------------
// approve_token gate
// --------------------------------------------------------------------------

await test('approve_token: high-risk run without token -> fail, dispatch never called', async () => {
  const sudoSpy = spy(async () => okResp('ok'));
  const r = await handleSshPlan({
    dispatch: { exec_sudo: sudoSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [{ action: 'exec_sudo', command: 'systemctl restart nginx' }],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, false);
  assert.match(body.error, /approval required/i);
  assert.strictEqual(sudoSpy.calls.length, 0);
  // Risky steps list surfaced in meta for caller convenience
  assert(Array.isArray(body.meta.risky_steps));
  assert.strictEqual(body.meta.risky_steps[0].action, 'exec_sudo');
});

await test('approve_token: high-risk run WITH token -> dispatch proceeds', async () => {
  const sudoSpy = spy(async () => okResp('restarted'));
  const r = await handleSshPlan({
    dispatch: { exec_sudo: sudoSpy },
    args: {
      mode: 'run', server: 's', format: 'json', approve_token: 'yes-do-it',
      plan: [{ action: 'exec_sudo', command: 'systemctl restart nginx' }],
    },
  });
  assert.strictEqual(sudoSpy.calls.length, 1);
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.data.steps_executed, 1);
});

await test('approve_token: low-risk-only plan runs without token', async () => {
  const execSpy = spy(async () => okResp('ok'));
  const healthSpy = spy(async () => okResp('ok'));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy, health_check: healthSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      // exec is "medium" -- still below the high threshold, so no token required.
      plan: [
        { action: 'health_check' },
        { action: 'exec', command: 'uptime' },
      ],
    },
  });
  assert.strictEqual(healthSpy.calls.length, 1);
  assert.strictEqual(execSpy.calls.length, 1);
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, true);
});

await test('approve_token: step-level risk override to high triggers gate', async () => {
  const execSpy = spy(async () => okResp('ok'));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [{ action: 'exec', command: 'rm -rf /', risk: 'high' }],
    },
  });
  assert.strictEqual(execSpy.calls.length, 0);
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, false);
  assert.match(body.error, /approval required/i);
});

// --------------------------------------------------------------------------
// duration_ms + step IDs
// --------------------------------------------------------------------------

await test('run: duration_ms reflects sum of step durations (>= total)', async () => {
  const delay = (ms) => new Promise(res => setTimeout(res, ms));
  const execSpy = spy(async () => { await delay(15); return okResp('ok'); });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },
        { action: 'exec', command: 'b' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  const sum = body.data.steps.reduce((a, s) => a + s.duration_ms, 0);
  assert(body.data.duration_ms >= sum - 5, `plan duration ${body.data.duration_ms} should cover sum ${sum}`);
});

await test('step IDs: missing IDs auto-assigned step_1..step_N, existing preserved', async () => {
  const execSpy = spy(async () => okResp('ok'));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },                    // step_1
        { step_id: 'custom', action: 'exec', command: 'b' }, // custom
        { action: 'exec', command: 'c' },                    // step_3
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.steps[0].step_id, 'step_1');
  assert.strictEqual(body.data.steps[1].step_id, 'custom');
  assert.strictEqual(body.data.steps[2].step_id, 'step_3');
});

// --------------------------------------------------------------------------
// Edge cases
// --------------------------------------------------------------------------

await test('empty / invalid plan -> structured fail', async () => {
  const r = await handleSshPlan({ dispatch: {}, args: { mode: 'preview', plan: [], format: 'json' } });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, false);
  assert.match(body.error, /plan/i);
});

await test('unknown mode -> structured fail', async () => {
  const r = await handleSshPlan({
    dispatch: {},
    args: { mode: 'bogus', plan: [{ action: 'exec', command: 'x', server: 's' }], format: 'json' },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, false);
  assert.match(body.error, /unknown mode/i);
});

await test('run: handler throws -> captured as step error, walk short-circuits', async () => {
  const execSpy = spy(async ({ args }) => {
    if (args.command === 'b') throw new Error('handler explosion');
    return okResp('ok');
  });
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [
        { action: 'exec', command: 'a' },
        { action: 'exec', command: 'b' },
        { action: 'exec', command: 'c' },
      ],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.data.steps_executed, 2);
  assert.strictEqual(body.data.steps_failed, 1);
  assert.match(body.data.steps[1].error, /handler explosion/);
  assert.strictEqual(execSpy.calls.length, 2); // c never reached
});

await test('run: handler returns JSON format result with success:false -> classified as failure', async () => {
  const execSpy = spy(async () => jsonResp({ success: false, tool: 'ssh_execute', data: null, meta: {}, error: 'remote error' }));
  const r = await handleSshPlan({
    dispatch: { exec: execSpy },
    args: {
      mode: 'run', server: 's', format: 'json',
      plan: [{ action: 'exec', command: 'a' }],
    },
  });
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.data.steps_failed, 1);
  assert.match(body.data.steps[0].error, /remote error/);
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of fails) console.error(`  - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
