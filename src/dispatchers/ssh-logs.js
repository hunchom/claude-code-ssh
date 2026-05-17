/**
 * ssh_logs -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_tail / ssh_tail_start / ssh_tail_read / ssh_tail_stop /
 * ssh_journalctl. Routes `action` to an existing handler.
 *
 * handlers (injected): { tail, tailStart, tailRead, tailStop, journal }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  tail: ['server', 'file'],
  'follow-start': ['server', 'file'],
  'follow-read': ['session_id'],
  'follow-stop': ['session_id'],
  journal: ['server'],
};

export async function handleSshLogs({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_logs', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_logs', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_logs', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'tail':
      return handlers.tail(makeCtx('conn', deps, {
        server: a.server, file: a.file, lines: a.lines, grep: a.grep, format: a.format,
      }));

    case 'follow-start':
      return handlers.tailStart(makeCtx('conn', deps, {
        server: a.server, file: a.file, lines: a.lines, grep: a.grep, format: a.format,
      }));

    case 'follow-read':
      return handlers.tailRead(makeCtx('args', deps, {
        session_id: a.session_id, since_offset: a.since_offset, format: a.format,
      }));

    case 'follow-stop':
      return handlers.tailStop(makeCtx('args', deps, {
        session_id: a.session_id, format: a.format,
      }));

    case 'journal':
    default:
      return handlers.journal(makeCtx('conn', deps, {
        server: a.server, unit: a.unit, since: a.since, until: a.until,
        priority: a.priority, lines: a.lines, grep: a.grep, format: a.format,
      }));
  }
}
