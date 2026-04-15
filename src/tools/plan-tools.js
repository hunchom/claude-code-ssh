/**
 * ssh_plan -- declarative multi-step operation runner.
 *
 * Modes:
 *   1. preview   -- build a "plan card" describing every step. No dispatch calls.
 *   2. dry_run   -- call each dispatched handler with `preview:true` merged in.
 *                  Each underlying tool reports what it would do. No mutation.
 *   3. run       -- execute each step sequentially. On failure, walk completed
 *                  steps in reverse and invoke their rollback (if present).
 *
 * -- Step contract ----------------------------------------------------------
 * A step is a plain object:
 *   {
 *     step_id?: string,              // auto-assigned `step_<N>` if missing
 *     action:   'exec' | 'exec_sudo' | 'upload' | 'download' | 'edit' |
 *               'systemctl' | 'backup' | 'wait' | 'assert' | 'health_check',
 *     server?:  string,              // inherits plan-level default if absent
 *     ...stepParams,                 // passed through to the dispatched handler
 *     rollback?: {                   // optional, see below
 *       action: <same enum>,
 *       server?: string,
 *       ...rollbackParams,
 *     },
 *   }
 *
 * -- Rollback contract ------------------------------------------------------
 *   - A step's `rollback` is a SINGLE step (not a nested plan). It has the same
 *     shape as a forward step but MUST NOT itself carry a nested `rollback`
 *     (ignored if present -- rollbacks don't cascade).
 *   - When a forward step fails AND rollback_on_fail === true, we walk all
 *     forward steps that COMPLETED SUCCESSFULLY in reverse order and invoke
 *     each one's rollback (if it has one). The failing step's own rollback is
 *     NOT invoked -- it never completed, so there's nothing to undo.
 *   - Rollback dispatches are best-effort. If a rollback itself fails, we
 *     capture the error on its entry in `rollback_steps[]` but continue with
 *     the remaining rollback walk. The primary (forward) failure is preserved.
 *   - Rollbacks inherit the plan-level default server just like forward steps.
 *
 * -- Result parsing contract ------------------------------------------------
 *   Every dispatched handler returns an MCP content object: `{content, isError?}`.
 *   We classify success by:
 *     1. If `isError === true` -> failure.
 *     2. Else if format === 'json'/'both' and content[0].text parses as JSON
 *        with `success === false` -> failure.
 *     3. Otherwise -> success.
 *   The first content[0].text is captured as `result_summary` (truncated to
 *   400 chars for the per-step record).
 *
 * -- Risk classification ----------------------------------------------------
 *   Every step has a risk of 'low' | 'medium' | 'high' derived from its action
 *   via stepRisk(). The action table below is EXPLICIT -- no regex heuristics
 *   at the plan level. If a step has action 'exec' but the command looks risky
 *   (e.g. `rm -rf`), the caller may pass an explicit `risk: 'high'` override on
 *   the step and we'll honor it.
 *
 *   | action         | risk   | reasoning                                    |
 *   |----------------|--------|----------------------------------------------|
 *   | health_check   | low    | read-only                                    |
 *   | wait           | low    | local-only sleep                             |
 *   | assert         | low    | read-only check                              |
 *   | download       | low    | pulls remote -> local, no mutation             |
 *   | exec           | medium | arbitrary command, caller may override up     |
 *   | upload         | medium | writes remote file                           |
 *   | edit           | high   | in-place config edit                         |
 *   | systemctl      | high   | service state change                         |
 *   | backup         | high   | data operation (restore can be destructive)  |
 *   | exec_sudo      | high   | privileged command                           |
 *
 * -- Approve-token gate -----------------------------------------------------
 *   In `run` mode, if ANY step resolves to risk 'high' AND no `approve_token`
 *   arg is present, we refuse: structured `fail()` listing risky step_ids,
 *   dispatch is never called. The token value is not validated -- it's a
 *   two-call pattern: inspect the preview, then re-invoke with any non-empty
 *   approve_token to confirm.
 */

import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { formatDuration } from '../output-formatter.js';

// --------------------------------------------------------------------------
// Step-action metadata
// --------------------------------------------------------------------------

const ACTION_RISK = Object.freeze({
  health_check: 'low',
  wait:         'low',
  assert:       'low',
  download:     'low',
  exec:         'medium',
  upload:       'medium',
  edit:         'high',
  systemctl:    'high',
  backup:       'high',
  exec_sudo:    'high',
});

const ACTION_REVERSIBILITY = Object.freeze({
  health_check: 'auto',      // nothing to reverse
  wait:         'auto',
  assert:       'auto',
  download:     'auto',      // local file can be re-fetched / deleted
  exec:         'manual',
  upload:       'manual',
  edit:         'manual',    // backup path returned by ssh_edit
  systemctl:    'manual',
  backup:       'manual',
  exec_sudo:    'manual',
});

const ACTION_EST_MS = Object.freeze({
  health_check: 2_000,
  wait:         1_000,
  assert:       1_000,
  download:     5_000,
  exec:         5_000,
  upload:       5_000,
  edit:         3_000,
  systemctl:    3_000,
  backup:       30_000,
  exec_sudo:    5_000,
});

const RISK_RANK = { low: 0, medium: 1, high: 2 };
const RISK_FROM_RANK = ['low', 'medium', 'high'];

/**
 * Classify a step's risk. Honors an explicit `risk:` override on the step.
 * @param {string} action
 * @param {string} [override] -- 'low' | 'medium' | 'high'
 * @returns {'low'|'medium'|'high'}
 */
export function stepRisk(action, override) {
  if (override && RISK_RANK[override] != null) return override;
  return ACTION_RISK[action] || 'medium';
}

// --------------------------------------------------------------------------
// Plan preparation (shared by all modes)
// --------------------------------------------------------------------------

/**
 * Normalize an input plan array into a standardized shape. Non-mutating.
 *   - Assigns step_id `step_1`, `step_2`, ... to steps missing one.
 *   - Inherits plan-level default server onto each step that lacks one.
 *   - Leaves all other params untouched.
 * @param {Array} steps
 * @param {Object} [opts]
 * @param {string} [opts.defaultServer] -- plan-level default
 * @returns {Array<Object>} normalized steps
 */
export function normalizePlan(steps, { defaultServer } = {}) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, idx) => {
    const step_id = s.step_id || `step_${idx + 1}`;
    const server = s.server ?? defaultServer ?? null;
    return { ...s, step_id, server };
  });
}

/**
 * Build the per-step preview entry (plan card row). Pure function -- no dispatch.
 */
function describeStep(step) {
  const { step_id, action, server } = step;
  const risk = stepRisk(action, step.risk);
  const reversibility = step.reversibility || ACTION_REVERSIBILITY[action] || 'manual';
  const est = Number.isFinite(step.estimated_duration_ms)
    ? step.estimated_duration_ms
    : (ACTION_EST_MS[action] ?? 5_000);

  const effects = [];
  switch (action) {
    case 'exec':
      effects.push(`runs \`${truncate(step.command || '', 80)}\` on ${server || '(unknown)'}`);
      break;
    case 'exec_sudo':
      effects.push(`runs \`sudo ${truncate(step.command || '', 80)}\` on ${server || '(unknown)'}`);
      break;
    case 'upload':
      effects.push(`uploads ${step.local_path || '?'} -> ${server || '?'}:${step.remote_path || '?'}`);
      break;
    case 'download':
      effects.push(`downloads ${server || '?'}:${step.remote_path || '?'} -> ${step.local_path || '?'}`);
      break;
    case 'edit':
      effects.push(`edits ${server || '?'}:${step.remote_path || step.file || '?'}`);
      break;
    case 'systemctl':
      effects.push(`${step.op || '?'} service ${step.service || '?'} on ${server || '?'}`);
      break;
    case 'backup':
      effects.push(`${step.op || 'backup'} ${step.kind || ''} on ${server || '?'}`);
      break;
    case 'wait':
      effects.push(`waits ${step.ms ?? step.seconds ?? '?'} ms`);
      break;
    case 'assert':
      effects.push(`asserts ${step.check || step.expect || '(check)'}`);
      break;
    case 'health_check':
      effects.push(`health check on ${server || '?'}`);
      break;
    default:
      effects.push(`(unknown action: ${action})`);
  }

  const target =
    action === 'wait' || action === 'assert'
      ? '(plan-local)'
      : `${server || '?'}${step.remote_path ? `:${step.remote_path}` : ''}`;

  const entry = {
    step_id,
    action,
    target,
    server,
    effects,
    reversibility,
    risk,
    estimated_duration_ms: est,
    has_rollback: Boolean(step.rollback && typeof step.rollback === 'object'),
  };
  return entry;
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '...' : str;
}

/**
 * Compute the highest risk across a list of described steps.
 */
function highestRisk(described) {
  let rank = 0;
  for (const s of described) {
    const r = RISK_RANK[s.risk] ?? 1;
    if (r > rank) rank = r;
  }
  return RISK_FROM_RANK[rank];
}

// --------------------------------------------------------------------------
// Dispatch -> preview / run
// --------------------------------------------------------------------------

/**
 * Build the arg object passed to a dispatched handler from a step.
 * Drops control fields (step_id, action, rollback, risk, reversibility,
 * estimated_duration_ms). Everything else is forwarded verbatim.
 */
function stepToHandlerArgs(step, extra = {}) {
  const {
    step_id: _id,
    action: _a,
    rollback: _r,
    risk: _risk,
    reversibility: _rev,
    estimated_duration_ms: _est,
    ...rest
  } = step;
  return { ...rest, ...extra };
}

/**
 * Inspect a handler's MCP response and classify success/failure.
 * Also extract a short `result_summary` string.
 */
function parseHandlerResponse(resp) {
  if (!resp || typeof resp !== 'object') {
    return { ok: false, error: 'handler returned no response', summary: '' };
  }
  const isErr = resp.isError === true;
  const content = Array.isArray(resp.content) ? resp.content : [];
  const firstText = content[0] && typeof content[0].text === 'string' ? content[0].text : '';

  // If the text looks like JSON from our `toMcp(..., {format:'json'})`, try to parse.
  let parsed = null;
  if (firstText && (firstText.startsWith('{') || firstText.startsWith('['))) {
    try { parsed = JSON.parse(firstText); } catch (_) { /* not JSON */ }
  }

  let success = !isErr;
  let error = null;
  if (isErr) {
    error = (parsed && parsed.error) || firstText || 'handler reported error';
  } else if (parsed && parsed.success === false) {
    success = false;
    error = parsed.error || 'tool returned success=false';
  }

  return {
    ok: success,
    error,
    summary: truncate(firstText, 400),
    parsed,
  };
}

/**
 * Invoke one step via the dispatch table. Returns { ok, durationMs, summary, error }.
 * Never throws -- wraps exceptions into a structured failure record.
 */
async function invokeStep(dispatch, step, extraArgs = {}) {
  const handler = dispatch && dispatch[step.action];
  const t0 = Date.now();
  if (typeof handler !== 'function') {
    return {
      ok: false,
      duration_ms: Date.now() - t0,
      summary: '',
      error: `no handler registered for action "${step.action}"`,
      parsed: null,
    };
  }
  let resp;
  try {
    resp = await handler({ args: stepToHandlerArgs(step, extraArgs) });
  } catch (e) {
    return {
      ok: false,
      duration_ms: Date.now() - t0,
      summary: '',
      error: String(e && e.message ? e.message : e),
      parsed: null,
    };
  }
  const parsed = parseHandlerResponse(resp);
  return {
    ok: parsed.ok,
    duration_ms: Date.now() - t0,
    summary: parsed.summary,
    error: parsed.error,
    parsed: parsed.parsed,
  };
}

// --------------------------------------------------------------------------
// handleSshPlan -- main entry point
// --------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {Object} opts.dispatch -- map of action -> handler({args}) -> MCP response
 * @param {Object} opts.args
 * @param {Array}  opts.args.plan
 * @param {'preview'|'dry_run'|'run'} [opts.args.mode='preview']
 * @param {boolean} [opts.args.rollback_on_fail=true]
 * @param {string}  [opts.args.server] -- plan-level default server
 * @param {string}  [opts.args.format='markdown']
 * @param {string}  [opts.args.approve_token]
 */
export async function handleSshPlan({ dispatch = {}, args = {} } = {}) {
  const {
    plan: rawPlan,
    mode = 'preview',
    rollback_on_fail = true,
    server: defaultServer,
    format = 'markdown',
    approve_token,
  } = args || {};

  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    return toMcp(
      fail('ssh_plan', 'plan must be a non-empty array of steps'),
      { format }
    );
  }

  const steps = normalizePlan(rawPlan, { defaultServer });
  const described = steps.map(describeStep);
  const total_steps = steps.length;
  const est_duration_ms = described.reduce((a, s) => a + (s.estimated_duration_ms || 0), 0);
  const highest_risk = highestRisk(described);

  // -- preview mode --------------------------------------------------------
  if (mode === 'preview') {
    const card = {
      mode: 'preview',
      total_steps,
      est_duration_ms,
      highest_risk,
      steps: described,
    };
    return toMcp(
      preview('ssh_plan', card, {}),
      { format, renderer: renderPlanCardPreview }
    );
  }

  // -- dry_run mode --------------------------------------------------------
  if (mode === 'dry_run') {
    const t0 = Date.now();
    const dryResults = [];
    for (const step of steps) {
      const dT0 = Date.now();
      const handler = dispatch[step.action];
      if (typeof handler !== 'function') {
        dryResults.push({
          step_id: step.step_id,
          action: step.action,
          ok: false,
          duration_ms: Date.now() - dT0,
          result_summary: '',
          error: `no handler registered for action "${step.action}"`,
          plan: null,
        });
        continue;
      }
      let resp;
      try {
        resp = await handler({ args: stepToHandlerArgs(step, { preview: true }) });
      } catch (e) {
        dryResults.push({
          step_id: step.step_id,
          action: step.action,
          ok: false,
          duration_ms: Date.now() - dT0,
          result_summary: '',
          error: String(e && e.message ? e.message : e),
          plan: null,
        });
        continue;
      }
      const parsed = parseHandlerResponse(resp);
      // If handler honored preview:true, it returned a `preview()` result
      // carrying data.plan. If it did NOT, we just record whatever it gave us.
      let innerPlan = null;
      if (parsed.parsed && parsed.parsed.data && parsed.parsed.data.preview) {
        innerPlan = parsed.parsed.data.plan;
      }
      dryResults.push({
        step_id: step.step_id,
        action: step.action,
        ok: parsed.ok,
        duration_ms: Date.now() - dT0,
        result_summary: parsed.summary,
        error: parsed.error,
        plan: innerPlan,
      });
    }
    const out = {
      mode: 'dry_run',
      total_steps,
      est_duration_ms,
      highest_risk,
      duration_ms: Date.now() - t0,
      steps: dryResults,
    };
    return toMcp(ok('ssh_plan', out, { duration_ms: out.duration_ms }), { format });
  }

  // -- run mode ------------------------------------------------------------
  if (mode !== 'run') {
    return toMcp(fail('ssh_plan', `unknown mode: ${mode}`), { format });
  }

  // Approve-token gate: high-risk steps require an approve_token.
  if (!approve_token) {
    const risky = described.filter(s => s.risk === 'high');
    if (risky.length > 0) {
      return toMcp(
        fail(
          'ssh_plan',
          'approval required for high-risk steps; re-invoke with approve_token',
          {
            plan_card: {
              total_steps,
              est_duration_ms,
              highest_risk,
              steps: described,
            },
            risky_steps: risky.map(s => ({ step_id: s.step_id, action: s.action, risk: s.risk })),
          }
        ),
        { format }
      );
    }
  }

  // Execute forward steps sequentially.
  const t0 = Date.now();
  const results = [];
  let failedIdx = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const r = await invokeStep(dispatch, step);
    results.push({
      step_id: step.step_id,
      action: step.action,
      server: step.server,
      ok: r.ok,
      duration_ms: r.duration_ms,
      result_summary: r.summary,
      error: r.ok ? undefined : (r.error || 'step failed'),
    });
    if (!r.ok) {
      failedIdx = i;
      break;
    }
  }

  const steps_executed = results.length;
  const steps_failed = results.filter(r => !r.ok).length;

  // Rollback walk.
  const rollback_steps = [];
  let rolled_back = false;
  if (failedIdx >= 0 && rollback_on_fail) {
    // Walk completed (ok) steps in reverse. The failing step itself did not
    // complete, so we do NOT run its own rollback.
    for (let i = failedIdx - 1; i >= 0; i--) {
      const step = steps[i];
      if (!step.rollback || typeof step.rollback !== 'object') continue;
      // Build a rollback "step": inherit the original step's server if absent.
      const rb = {
        step_id: `${step.step_id}:rollback`,
        server: step.rollback.server ?? step.server ?? defaultServer ?? null,
        ...step.rollback,
      };
      // Strip any accidental nested rollback -- they don't cascade.
      delete rb.rollback;
      const r = await invokeStep(dispatch, rb);
      rolled_back = true;
      rollback_steps.push({
        for_step_id: step.step_id,
        step_id: rb.step_id,
        action: rb.action,
        server: rb.server,
        ok: r.ok,
        duration_ms: r.duration_ms,
        result_summary: r.summary,
        error: r.ok ? undefined : (r.error || 'rollback failed'),
      });
    }
  }

  const payload = {
    mode: 'run',
    total_steps,
    steps_executed,
    steps_failed,
    rolled_back,
    duration_ms: Date.now() - t0,
    highest_risk,
    steps: results,
    rollback_steps,
  };

  // success if nothing failed. If any step failed, the tool-level result is
  // still "ok" from a plumbing perspective -- the payload says what happened.
  // Surface an isError only when EVERY step failed hard (keeps the caller in
  // control of semantics). We choose: failed iff steps_failed > 0.
  const wrapper = steps_failed > 0
    ? fail('ssh_plan', `plan failed at step ${steps[failedIdx]?.step_id}: ${results[failedIdx]?.error || 'unknown'}`, {
      duration_ms: payload.duration_ms,
    })
    : ok('ssh_plan', payload, { duration_ms: payload.duration_ms });

  // Always attach the full payload so callers can introspect:
  if (!wrapper.success) {
    wrapper.data = payload;
  }
  return toMcp(wrapper, { format, renderer: renderPlanRun });
}

// Convenience wrapper for mode='preview'.
export async function handleSshPlanPreview({ dispatch = {}, args = {} } = {}) {
  return handleSshPlan({ dispatch, args: { ...args, mode: 'preview' } });
}

// --------------------------------------------------------------------------
// Markdown renderers
// --------------------------------------------------------------------------

function renderPlanCardPreview(result) {
  if (!result.success) return defaultRender(result);
  const card = result.data && result.data.plan;
  if (!card) return defaultRender(result);
  const lines = [];
  lines.push(`[ok] **ssh_plan** | preview | ${card.total_steps} steps | risk **${card.highest_risk}**`);
  lines.push('');
  lines.push(`> **dry run** -- nothing executed | est \`${formatDuration(card.est_duration_ms)}\``);
  lines.push('');
  for (const s of card.steps) {
    const rb = s.has_rollback ? ' <-' : '';
    lines.push(`- \`${s.step_id}\` | **${s.action}** | ${s.target} | risk \`${s.risk}\`${rb}`);
    for (const eff of s.effects) lines.push(`    - ${eff}`);
  }
  return lines.join('\n');
}

function renderPlanRun(result) {
  const d = result.data;
  if (!d) return defaultRender(result);
  const marker = result.success ? '[ok]' : '[err]';
  const lines = [];
  lines.push(
    `${marker} **ssh_plan** | run | ${d.steps_executed}/${d.total_steps} executed | ${d.steps_failed} failed` +
    (d.rolled_back ? ' | **rolled back**' : '')
  );
  lines.push('');
  for (const s of d.steps) {
    const m = s.ok ? '[ok]' : '[err]';
    lines.push(`${m} \`${s.step_id}\` | **${s.action}** | \`${formatDuration(s.duration_ms)}\``);
    if (!s.ok) lines.push(`    - error: ${s.error}`);
  }
  if (d.rollback_steps && d.rollback_steps.length) {
    lines.push('');
    lines.push('**rollback:**');
    for (const r of d.rollback_steps) {
      const m = r.ok ? '[ok]' : '[err]';
      lines.push(`${m} \`${r.step_id}\` | **${r.action}** | \`${formatDuration(r.duration_ms)}\``);
      if (!r.ok) lines.push(`    - error: ${r.error}`);
    }
  }
  return lines.join('\n');
}
