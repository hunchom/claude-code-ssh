/**
 * ssh_fleet action bodies. Lifted out of index.js inline closures so the
 * ssh_fleet dispatcher can wire them as a handlers object. Each adapter takes
 * { args, deps } and returns an MCP { content, isError? } response. deps
 * carries the callables/maps that were closed over in index.js.
 */

function mcp(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/** ssh_list_servers body. */
export async function fleetServers({ deps }) {
  const servers = deps.loadServerConfig();
  const info = Object.entries(servers).map(([name, c]) => ({
    name, host: c.host, user: c.user, port: c.port || '22',
    auth: c.password ? 'password' : 'key',
    defaultDir: c.default_dir || '', description: c.description || '',
  }));
  return mcp(JSON.stringify(info, null, 2));
}

/** ssh_group_manage body. v4 op -> original action enum. */
export async function fleetGroups({ args, deps }) {
  const { op, name, members, description } = args || {};
  try {
    let result;
    let output = '';
    switch (op) {
      case 'add':
        if (!name) throw new Error('group name required');
        result = deps.createGroup(name, members || [], { description });
        output = `[ok] Group '${name}' created\nServers: ${result.servers.join(', ') || 'none'}`;
        break;
      case 'update':
        if (!name) throw new Error('group name required');
        if (members && members.length) {
          result = deps.addServersToGroup(name, members);
          output = `[ok] Group '${name}' members: ${result.servers.join(', ')}`;
        } else {
          result = deps.updateGroup(name, { description });
          output = `[ok] Group '${name}' updated`;
        }
        break;
      case 'remove':
        if (!name) throw new Error('group name required');
        if (members && members.length) {
          result = deps.removeServersFromGroup(name, members);
          output = `[ok] Group '${name}' members: ${result.servers.join(', ') || 'none'}`;
        } else {
          deps.deleteGroup(name);
          output = `[ok] Group '${name}' deleted`;
        }
        break;
      case 'list':
      default: {
        const groups = deps.listGroups();
        output = '[list] Server Groups\n' + groups.map(g =>
          `  ${g.name} (${g.serverCount} servers): ${g.servers.join(', ') || 'none'}`).join('\n');
        break;
      }
    }
    return mcp(output);
  } catch (e) {
    return mcp(`[err] Group operation failed: ${e.message}`, true);
  }
}

/** ssh_alias body. */
export async function fleetAliases({ args, deps }) {
  const { op, name, target } = args || {};
  try {
    switch (op) {
      case 'add': {
        if (!name || !target) throw new Error('alias name and target required');
        const servers = deps.loadServerConfig();
        const resolved = deps.resolveServerName(target, servers);
        if (!resolved) throw new Error(`Server "${target}" not found`);
        deps.addAlias(name, resolved);
        return mcp(`[ok] Alias created: ${name} -> ${resolved}`);
      }
      case 'remove':
        if (!name) throw new Error('alias name required');
        deps.removeAlias(name);
        return mcp(`[ok] Alias removed: ${name}`);
      case 'list':
      default: {
        const aliases = deps.listAliases();
        const servers = deps.loadServerConfig();
        const text = aliases.map(({ alias, target: t }) =>
          `  ${alias} -> ${t} (${servers[t]?.host || 'unknown'})`).join('\n');
        return mcp(aliases.length ? `[log] Server aliases:\n${text}` : '[log] No aliases configured');
      }
    }
  } catch (e) {
    return mcp(`[err] Alias operation failed: ${e.message}`, true);
  }
}

/** ssh_command_alias body. v4 op -> add/remove/list/suggest. */
export async function fleetCommandAlias({ args, deps }) {
  const { op, alias, command } = args || {};
  try {
    switch (op) {
      case 'add': {
        if (!alias || !command) throw new Error('alias and command required for add');
        deps.addCommandAlias(alias, command);
        return mcp(`[ok] Command alias created: ${alias} -> ${command}`);
      }
      case 'remove':
        if (!alias) throw new Error('alias required for remove');
        deps.removeCommandAlias(alias);
        return mcp(`[ok] Command alias removed: ${alias}`);
      case 'suggest': {
        if (!command) throw new Error('command search term required for suggest');
        const suggestions = deps.suggestAliases(command);
        const text = suggestions.map(({ alias: al, command: c }) => `  ${al} -> ${c}`).join('\n');
        return mcp(suggestions.length
          ? `[tip] Suggested aliases for "${command}":\n${text}`
          : `[tip] No aliases found matching "${command}"`);
      }
      case 'list':
      default: {
        const aliases = deps.listCommandAliases();
        const text = aliases.map(({ alias: al, command: c, isFromProfile, isCustom }) =>
          `  ${al} -> ${c}${isFromProfile ? ' (profile)' : ''}${isCustom ? ' (custom)' : ''}`).join('\n');
        return mcp(aliases.length
          ? `[log] Command aliases:\n${text}`
          : '[log] No command aliases configured');
      }
    }
  } catch (e) {
    return mcp(`[err] Command alias operation failed: ${e.message}`, true);
  }
}

/** ssh_profile body. */
export async function fleetProfiles({ args, deps }) {
  const { op, name } = args || {};
  try {
    switch (op) {
      case 'update': {
        if (!name) throw new Error('profile name required');
        if (!deps.setActiveProfile(name)) throw new Error(`Failed to switch to profile: ${name}`);
        return mcp(`[ok] Switched to profile: ${name}\n[warn] Restart Claude Code to apply`);
      }
      case 'list':
      default: {
        const profiles = deps.listProfiles();
        const current = deps.getActiveProfileName();
        const text = profiles.map(p =>
          `  ${p.name}: ${p.description} (${p.aliasCount} aliases, ${p.hookCount} hooks)`).join('\n');
        return mcp(profiles.length
          ? `[docs] Profiles (current: ${current}):\n${text}`
          : '[docs] No profiles found');
      }
    }
  } catch (e) {
    return mcp(`[err] Profile operation failed: ${e.message}`, true);
  }
}

/** ssh_hooks body. */
export async function fleetHooks({ args, deps }) {
  const { op, name } = args || {};
  try {
    switch (op) {
      case 'add':
      case 'update':
        if (!name) throw new Error('hook name required');
        deps.toggleHook(name, true);
        return mcp(`[ok] Hook enabled: ${name}`);
      case 'remove':
        if (!name) throw new Error('hook name required');
        deps.toggleHook(name, false);
        return mcp(`[ok] Hook disabled: ${name}`);
      case 'list':
      default: {
        const hooks = deps.listHooks();
        const text = hooks.map(({ name: n, enabled, description, actionCount }) =>
          `  ${enabled ? '[ok]' : '[err]'} ${n}: ${description} (${actionCount} actions)`).join('\n');
        return mcp(hooks.length ? `[hook] Hooks:\n${text}` : '[hook] No hooks configured');
      }
    }
  } catch (e) {
    return mcp(`[err] Hook operation failed: ${e.message}`, true);
  }
}

/** ssh_history body. */
export async function fleetHistory({ args, deps }) {
  const { limit = 20, server, search } = args || {};
  try {
    let history = deps.logger.getHistory(limit * 2);
    if (server) history = history.filter(h => h.server?.toLowerCase().includes(server.toLowerCase()));
    if (search) history = history.filter(h => h.command?.toLowerCase().includes(search.toLowerCase()));
    history = history.slice(-limit);
    if (history.length === 0) return mcp('[log] No commands found matching the criteria.');
    const text = history.map((e, i) =>
      `${history.length - i}. ${e.success ? '[ok]' : '[err]'} ${e.server || 'unknown'}: `
      + `${(e.command || 'N/A').substring(0, 100)}`).join('\n');
    return mcp(`[log] SSH Command History (last ${history.length})\n${text}`);
  } catch (e) {
    return mcp(`[err] Error retrieving history: ${e.message}`, true);
  }
}

/** ssh_connection_status body. */
export async function fleetConnections({ args, deps }) {
  const { op = 'status', server } = args || {};
  try {
    switch (op) {
      case 'reconnect': {
        if (!server) throw new Error('server required for reconnect');
        const n = server.toLowerCase();
        if (deps.connections.has(n)) deps.closeConnection(n);
        await deps.getConnection(server);
        return mcp(`[recycle] Reconnected to ${server}`);
      }
      case 'disconnect':
        if (!server) throw new Error('server required for disconnect');
        deps.closeConnection(server);
        return mcp(`[conn] Disconnected from ${server}`);
      case 'cleanup': {
        const before = deps.connections.size;
        deps.cleanupOldConnections();
        for (const [n, ssh] of deps.connections.entries()) {
          if (!(await deps.isConnectionValid(ssh))) deps.closeConnection(n);
        }
        return mcp(`[clean] ${before - deps.connections.size} closed, ${deps.connections.size} active`);
      }
      case 'status':
      default: {
        const now = Date.now();
        const rows = [];
        for (const [name, ssh] of deps.connections.entries()) {
          const age = Math.floor((now - deps.connectionTimestamps.get(name)) / 60000);
          const valid = await deps.isConnectionValid(ssh);
          rows.push(`  ${name}: ${valid ? '[ok] Active' : '[err] Dead'} (age ${age}m)`);
        }
        return mcp(`[conn] Connection Pool:\n${rows.join('\n') || '  No active connections'}`);
      }
    }
  } catch (e) {
    return mcp(`[err] Connection management failed: ${e.message}`, true);
  }
}
