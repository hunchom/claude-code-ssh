/**
 * ssh_backup -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_backup_create / ssh_backup_list / ssh_backup_restore /
 * ssh_backup_schedule. All conn ctx kind.
 *
 * handlers (injected): { create, list, restore, schedule }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  create: ['server'],
  list: ['server'],
  restore: ['server', 'backup_id'],
  schedule: ['server', 'cron'],
};

export async function handleSshBackup({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_backup', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_backup', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_backup', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'create':
      // handler ignores name/exclude -- dropped
      return handlers.create(makeCtx('conn', deps, {
        server: a.server, backup_type: a.backup_type,
        database: a.database, paths: a.paths,
        backup_dir: a.backup_dir, gzip: a.gzip, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'list':
      // handler ignores backup_type -- dropped
      return handlers.list(makeCtx('conn', deps, {
        server: a.server, backup_dir: a.backup_dir, format: a.format,
      }));

    case 'restore':
      // handler ignores database -- dropped
      return handlers.restore(makeCtx('conn', deps, {
        server: a.server, backup_id: a.backup_id,
        target_path: a.target_path, backup_dir: a.backup_dir, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'schedule':
    default:
      // handler ignores name/retention -- dropped
      return handlers.schedule(makeCtx('conn', deps, {
        server: a.server, cron: a.cron, backup_type: a.backup_type,
        database: a.database, paths: a.paths,
        preview: a.preview, format: a.format,
      }));
  }
}
