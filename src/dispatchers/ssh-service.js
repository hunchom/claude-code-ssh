/**
 * ssh_service -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_service_status / ssh_systemctl.
 * status -> handleSshServiceStatus (typed snapshot).
 * start/stop/restart/enable/disable -> handleSshSystemctl (its action enum
 * already has these verbs); v4 `service` arg maps to systemctl's `unit`.
 *
 * handlers (injected): { serviceStatus, systemctl }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  status: ['server', 'service'],
  start: ['server', 'service'],
  stop: ['server', 'service'],
  restart: ['server', 'service'],
  enable: ['server', 'service'],
  disable: ['server', 'service'],
};

export async function handleSshService({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_service', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_service', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_service', action, a, REQUIRED);
  if (bad) return bad;

  if (action === 'status') {
    return handlers.serviceStatus(makeCtx('conn', deps, {
      server: a.server, service: a.service, format: a.format,
    }));
  }

  // start / stop / restart / enable / disable -> systemctl
  return handlers.systemctl(makeCtx('conn', deps, {
    server: a.server,
    action,
    unit: a.service,
    preview: a.preview,
    format: a.format,
  }));
}
