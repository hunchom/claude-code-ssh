/**
 * ssh_docker -- v4 fat verb-tool dispatcher.
 *
 * Thin pass-through over handleSshDocker, which already owns its own action
 * enum. v4 advertises ps/logs/exec/restart/inspect/compose. compose has no
 * handler path and is rejected here; the other five forward straight through.
 *
 * handlers (injected): { docker }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  ps: ['server'],
  logs: ['server', 'container'],
  exec: ['server', 'container', 'command'],
  restart: ['server', 'container'],
  inspect: ['server', 'container'],
};

export async function handleSshDockerTool({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_docker', 'action is required', { server: a.server ?? null }));
  }
  if (action === 'compose') {
    return toMcp(fail('ssh_docker',
      'action "compose" is not supported -- use ssh_run to invoke docker compose directly',
      { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_docker', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_docker', action, a, REQUIRED);
  if (bad) return bad;

  return handlers.docker(makeCtx('conn', deps, {
    server: a.server,
    action,
    container: a.container,
    image: a.image,
    command: a.command,
    tail_lines: a.tail_lines,
    preview: a.preview,
    format: a.format,
  }));
}
