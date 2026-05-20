/**
 * ssh_session -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_session_start / _send / _list / _close / _replay / _memory.
 * start uses the conn ctx kind; the other five take { args } only.
 *
 * handlers (injected): { start, send, list, close, replay, memory }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  start: ['server'],
  send: ['session_id', 'command'],
  list: [],
  close: ['session_id'],
  replay: ['session_id'],
  memory: ['session_id'],
};

export async function handleSshSession({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_session', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_session', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_session', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'start':
      return handlers.start(makeCtx('conn', deps, {
        server: a.server, format: a.format,
      }));

    case 'send':
      return handlers.send(makeCtx('args', deps, {
        session_id: a.session_id, command: a.command,
        timeout: a.timeout, format: a.format,
      }));

    case 'list':
      return handlers.list(makeCtx('args', deps, { format: a.format }));

    case 'close':
      return handlers.close(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));

    case 'replay':
      return handlers.replay(makeCtx('args', deps, {
        session_id: a.session_id, limit: a.limit, format: a.format,
      }));

    case 'memory':
    default:
      return handlers.memory(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));
  }
}
