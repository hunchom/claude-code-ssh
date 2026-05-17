/**
 * ssh_run -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_execute / ssh_execute_sudo / ssh_execute_group. Routes the
 * `action` arg to an existing handler in src/tools/exec-tools.js, building the
 * right context object via makeCtx and mapping v4 snake_case args to the
 * handler arg names.
 *
 * actions handled here: exec, sudo, fleet.
 * (script, detach, job-status, job-kill are added by Plan 5.)
 *
 * handlers (injected): { execute, executeSudo, executeGroup }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';
import { expandCommandAlias } from '../command-aliases.js';

const REQUIRED = {
  exec: ['server', 'command'],
  sudo: ['server', 'command'],
  fleet: ['group', 'command'],
};

export async function handleSshRun({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_run', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_run', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_run', action, a, REQUIRED);
  if (bad) return bad;

  // exec + sudo both resolve server default_dir when no cwd given
  const cfg = (deps && deps.getServerConfig && deps.getServerConfig(a.server)) || {};

  // exec + sudo expand command aliases at exec time -- parity w/ old ssh_execute.
  // deps.expandCommandAlias override = test seam; else module impl.
  const expand = (deps && deps.expandCommandAlias) || expandCommandAlias;

  if (action === 'exec') {
    return handlers.execute(makeCtx('conn', deps, {
      server: a.server,
      command: expand(a.command),
      cwd: a.cwd || cfg.default_dir,
      timeout: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  if (action === 'sudo') {
    return handlers.executeSudo(makeCtx('conn-cfg', deps, {
      server: a.server,
      command: expand(a.command),
      password: a.sudo_password,
      cwd: a.cwd || cfg.default_dir,
      timeout: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  // action === 'fleet'
  return handlers.executeGroup(makeCtx('conn-group', deps, {
    group: a.group,
    command: a.command,
    cwd: a.cwd,
    raw: a.raw,
    format: a.format,
  }));
}
