/**
 * ssh_plan -- v4 verb-tool dispatcher.
 *
 * ssh_plan stays its own tool (a meta-orchestrator). Two v4 actions:
 *   run     -> handleSshPlan, mode 'run'
 *   approve -> handleSshPlan, mode 'run', with approve_token forwarded
 *
 * buildPlanDispatch produces the `dispatch` map handleSshPlan threads to
 * invokeStep. invokeStep reads dispatch[step.action] where step.action is the
 * PLAN-STEP action enum (exec, exec_sudo, upload, ...). The pre-v4 index.js
 * keyed this table by tool names, which never matched -- v4 keys it by the
 * step enum so steps actually dispatch.
 *
 * Each dispatch entry is a closure taking { args } (invokeStep's call shape)
 * and wrapping a src/tools/*.js handler with the right context object.
 *
 * handlers (injected): subset of { execute, executeSudo, upload, download,
 *   edit, systemctl, backupCreate, healthCheck }.
 */

import { fail, toMcp } from '../structured-result.js';

/**
 * Build the plan-step-keyed dispatch table. Keys are the action strings
 * plan-tools.js reads from each step; values take { args } and return an
 * MCP response.
 */
export function buildPlanDispatch(deps, handlers) {
  const h = handlers || {};
  const d = {};
  if (h.execute) {
    d.exec = ({ args }) => h.execute({ getConnection: deps.getConnection, args });
  }
  if (h.executeSudo) {
    d.exec_sudo = ({ args }) => h.executeSudo({
      getConnection: deps.getConnection, getServerConfig: deps.getServerConfig, args,
    });
  }
  if (h.upload) {
    d.upload = ({ args }) => h.upload({ getConnection: deps.getConnection, args });
  }
  if (h.download) {
    d.download = ({ args }) => h.download({ getConnection: deps.getConnection, args });
  }
  if (h.edit) {
    d.edit = ({ args }) => h.edit({ getConnection: deps.getConnection, args });
  }
  if (h.systemctl) {
    d.systemctl = ({ args }) => h.systemctl({ getConnection: deps.getConnection, args });
  }
  if (h.backupCreate) {
    d.backup = ({ args }) => h.backupCreate({ getConnection: deps.getConnection, args });
  }
  if (h.healthCheck) {
    d.health_check = ({ args }) => h.healthCheck({ getConnection: deps.getConnection, args });
  }
  return d;
}

export async function handleSshPlanTool({ deps, handlers, planFn, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_plan', 'action is required', { server: null }));
  }
  if (action !== 'run' && action !== 'approve') {
    return toMcp(fail('ssh_plan', `unknown action "${action}"`, { server: null }));
  }
  if (a.steps === undefined || a.steps === null) {
    return toMcp(fail('ssh_plan', 'action requires: steps', { server: null }));
  }
  if (action === 'approve' && !a.approve_token) {
    return toMcp(fail('ssh_plan', 'action "approve" requires: approve_token', { server: null }));
  }

  const dispatch = buildPlanDispatch(deps, handlers);
  return planFn({
    dispatch,
    args: {
      plan: a.steps,
      mode: 'run',
      server: a.server,
      approve_token: a.approve_token,
      rollback_on_fail: a.rollback_on_fail,
      format: a.format,
    },
  });
}
