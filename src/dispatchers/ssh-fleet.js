/**
 * ssh_fleet -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_list_servers / ssh_group_manage / ssh_alias /
 * ssh_command_alias / ssh_profile / ssh_hooks / ssh_key_manage /
 * ssh_connection_status / ssh_history -- genuine fleet/config metadata only.
 *
 * Most of these tools' bodies live inline in index.js, not src/tools/*.js, so
 * they cannot be re-faceted. The handlers object is supplied at registration
 * time (Part 3) as adapter functions. `keys` is the lone modular handler
 * (handleSshKeyManage, cfg ctx kind); v4 `op` maps to its `action` arg.
 *
 * handlers (injected): { servers, groups, aliases, command_alias, profiles,
 *                        hooks, keys, history, connections }. Each is async
 *                        ({ args } or a full ctx object) -> MCP response.
 */

import { fail, toMcp } from '../structured-result.js';
import { makeCtx } from './ctx-factory.js';

const ACTIONS = new Set([
  'servers', 'groups', 'aliases', 'command_alias', 'profiles',
  'hooks', 'keys', 'history', 'connections',
]);

export async function handleSshFleet({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_fleet', 'action is required', { server: a.server ?? null }));
  }
  if (!ACTIONS.has(action)) {
    return toMcp(fail('ssh_fleet', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  // No requireArgs here: per-action required-arg validation is delegated to
  // each inline fleet adapter (and to handleSshKeyManage for keys). Omission
  // is intentional -- fleet sub-args are op-shaped, not a flat required map.

  if (action === 'keys') {
    // handleSshKeyManage destructures `ctx` with getServerConfig + args;
    // it reads `preview`, not autoAccept.
    return handlers.keys(makeCtx('cfg', deps, {
      action: a.op,
      server: a.server,
      host: a.host,
      port: a.port,
      preview: a.preview,
      format: a.format,
    }));
  }

  // servers / groups / aliases / command_alias / profiles / hooks / history /
  // connections: adapter functions take a plain { args } object.
  return handlers[action]({
    args: {
      op: a.op,
      name: a.name,
      members: a.members,
      description: a.description,
      alias: a.alias,
      command: a.command,
      target: a.target,
      server: a.server,
      limit: a.limit,
      search: a.search,
      format: a.format,
    },
  });
}
