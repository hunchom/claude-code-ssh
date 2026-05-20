/**
 * ssh_file -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_upload / ssh_download / ssh_sync / ssh_cat / ssh_edit /
 * ssh_diff / ssh_deploy / ssh_deploy_artifact. Routes `action` to an existing
 * handler, mapping v4 snake_case args to each handler's arg names.
 *
 * read  -> handleSshCat (remote_path -> file).
 * write -> handleSshEdit whole-file replace (content -> new_content).
 * edit  -> handleSshEdit find/replace patch (old_text/new_text -> patch[]).
 *
 * handlers (injected): { upload, download, sync, cat, edit, diff, deploy }.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';

const REQUIRED = {
  upload: ['server', 'local_path', 'remote_path'],
  download: ['server', 'local_path', 'remote_path'],
  sync: ['server', 'source', 'destination'],
  read: ['server', 'remote_path'],
  write: ['server', 'remote_path', 'content'],
  edit: ['server', 'remote_path'],
  diff: ['server', 'path_a', 'path_b'],
  deploy: ['server', 'artifact_local_path', 'target_path'],
  'deploy-artifact': ['server', 'artifact_local_path', 'target_path'],
};

export async function handleSshFile({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_file', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_file', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_file', action, a, REQUIRED);
  if (bad) return bad;

  switch (action) {
    case 'upload':
      return handlers.upload(makeCtx('conn', deps, {
        server: a.server,
        local_path: a.local_path,
        remote_path: a.remote_path,
        verify: a.verify,
        preview: a.preview,
        format: a.format,
      }));

    case 'download':
      return handlers.download(makeCtx('conn', deps, {
        server: a.server,
        local_path: a.local_path,
        remote_path: a.remote_path,
        verify: a.verify,
        preview: a.preview,
        format: a.format,
      }));

    case 'sync':
      return handlers.sync(makeCtx('conn-cfg', deps, {
        server: a.server,
        source: a.source,
        destination: a.destination,
        exclude: a.exclude,
        delete: a.delete_extra,
        dry_run: a.dry_run,
        compress: a.compress,
        preview: a.preview,
        format: a.format,
      }));

    case 'read':
      return handlers.cat(makeCtx('conn', deps, {
        server: a.server,
        file: a.remote_path,
        head: a.head,
        tail: a.tail,
        grep: a.grep,
        line_start: a.line_start,
        line_end: a.line_end,
        format: a.format,
      }));

    case 'write':
      return handlers.edit(makeCtx('conn', deps, {
        server: a.server,
        path: a.remote_path,
        new_content: a.content,
        preview: a.preview,
        format: a.format,
      }));

    case 'edit':
      // old_text is literal user text → literal:true so regex metachars (. ( [ * ?)
      // match verbatim, never silently patch the wrong span.
      return handlers.edit(makeCtx('conn', deps, {
        server: a.server,
        path: a.remote_path,
        patch: a.old_text != null
          ? [{ find: a.old_text, replace: a.new_text ?? '', literal: true }]
          : undefined,
        preview: a.preview,
        format: a.format,
      }));

    case 'diff':
      return handlers.diff(makeCtx('conn', deps, {
        server: a.server,
        path_a: a.path_a,
        path_b: a.path_b,
        server_b: a.server_b,
        preview: a.preview,
        format: a.format,
      }));

    // deploy + deploy-artifact share handleSshDeploy; action already validated
    case 'deploy':
    case 'deploy-artifact':
      return handlers.deploy(makeCtx('deploy', deps, {
        server: a.server,
        artifact_local_path: a.artifact_local_path,
        target_path: a.target_path,
        post_hooks: a.post_hooks,
        health_check: a.health_check,
        rollback_on_fail: a.rollback_on_fail,
        rollback_hook: a.rollback_hook,
        preview: a.preview,
        format: a.format,
      }));
  }
}
