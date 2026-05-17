/**
 * ssh_health -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_health_check / ssh_monitor / ssh_process_manager /
 * ssh_alert_setup.
 *   check  -> handleSshHealthCheck
 *   watch  -> handleSshMonitor          (watch_type -> type)
 *   procs  -> handleSshProcessManager   (proc_action -> action, default 'list')
 *   alerts -> handleSshAlertSetup       (alert_action -> action)
 *
 * v4 sub-action args are renamed so the single `action` slot stays the
 * verb-tool selector and the inner tool's own action enum is a distinct arg.
 *
 * handlers (injected): { healthCheck, monitor, processManager, alertSetup }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  check: ['server'],
  watch: ['server'],
  procs: ['server'],
  alerts: ['server', 'alert_action'],
};

export async function handleSshHealth({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_health', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_health', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_health', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'check':
      return handlers.healthCheck(makeCtx('conn', deps, {
        server: a.server, format: a.format,
      }));

    case 'watch':
      return handlers.monitor(makeCtx('conn', deps, {
        server: a.server, type: a.watch_type, format: a.format,
      }));

    case 'procs':
      return handlers.processManager(makeCtx('conn', deps, {
        server: a.server,
        action: a.proc_action || 'list',
        pid: a.pid,
        signal: a.signal,
        sort_by: a.sort_by,
        limit: a.limit,
        filter: a.filter,
        preview: a.preview,
        format: a.format,
      }));

    case 'alerts':
    default:
      return handlers.alertSetup(makeCtx('conn', deps, {
        server: a.server,
        action: a.alert_action,
        cpuThreshold: a.cpu_threshold,
        memoryThreshold: a.memory_threshold,
        diskThreshold: a.disk_threshold,
        enabled: a.enabled,
        format: a.format,
      }));
  }
}
