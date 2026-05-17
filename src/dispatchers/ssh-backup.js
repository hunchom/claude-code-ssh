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
      return handlers.create(makeCtx('conn', deps, {
        server: a.server, backup_type: a.backup_type, name: a.name,
        database: a.database, paths: a.paths, exclude: a.exclude,
        backup_dir: a.backup_dir, gzip: a.gzip, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'list':
      return handlers.list(makeCtx('conn', deps, {
        server: a.server, backup_type: a.backup_type, backup_dir: a.backup_dir,
        format: a.format,
      }));

    case 'restore':
      return handlers.restore(makeCtx('conn', deps, {
        server: a.server, backup_id: a.backup_id, database: a.database,
        target_path: a.target_path, backup_dir: a.backup_dir, verify: a.verify,
        preview: a.preview, format: a.format,
      }));

    case 'schedule':
    default:
      return handlers.schedule(makeCtx('conn', deps, {
        server: a.server, cron: a.cron, backup_type: a.backup_type,
        name: a.name, database: a.database, paths: a.paths,
        retention: a.retention, preview: a.preview, format: a.format,
      }));
  }
}
