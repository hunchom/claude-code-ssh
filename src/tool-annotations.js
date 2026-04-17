/**
 * Per-tool MCP annotations + human titles.
 *
 * MCP 2025-06-18 lets tool hosts (Claude Code, Codex, etc.) render better UX
 * and make smarter auto-approve decisions when tools self-declare intent:
 *
 *   - readOnlyHint    : tool never mutates remote state (safe to auto-run)
 *   - destructiveHint : tool performs destructive ops (caller should confirm)
 *   - idempotentHint  : running twice has same effect as running once
 *   - openWorldHint   : tool interacts with systems outside the declared server
 *
 * `title` is the human-readable tool name shown in Claude Code's /mcp palette;
 * `description` (already set at registration) is for the LLM.
 *
 * If a tool is absent from this map, it registers with no annotations and no
 * title -- that's the "unknown / not annotated" case that clients should treat
 * conservatively.
 */

export const TOOL_ANNOTATIONS = {
  // Core
  ssh_execute: {
    title: 'Execute Remote Command',
    annotations: { openWorldHint: true },
  },
  ssh_upload: {
    title: 'Upload File to Server',
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_download: {
    title: 'Download File from Server',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ssh_sync: {
    title: 'Rsync Files',
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_list_servers: {
    title: 'List Configured Servers',
    annotations: { readOnlyHint: true, idempotentHint: true },
  },

  // Sessions
  ssh_session_start: { title: 'Start Interactive Session', annotations: { openWorldHint: true } },
  ssh_session_send: { title: 'Send Command to Session', annotations: { openWorldHint: true } },
  ssh_session_list: { title: 'List Sessions', annotations: { readOnlyHint: true, idempotentHint: true } },
  ssh_session_close: { title: 'Close Session', annotations: { idempotentHint: true } },
  ssh_session_replay: { title: 'Replay Session History', annotations: { readOnlyHint: true, idempotentHint: true } },
  ssh_session_memory: { title: 'Session State Snapshot', annotations: { readOnlyHint: true, idempotentHint: true } },

  // Monitoring
  ssh_health_check: { title: 'Server Health Check', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_service_status: { title: 'Check Service Status', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_process_manager: { title: 'Manage Remote Processes', annotations: { openWorldHint: true } },
  ssh_monitor: { title: 'Resource Monitor Snapshot', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_tail: { title: 'Tail Log File', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },

  // Backup
  ssh_backup_create: { title: 'Create Backup', annotations: { openWorldHint: true } },
  ssh_backup_list: { title: 'List Backups', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_backup_restore: { title: 'Restore Backup', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_backup_schedule: { title: 'Schedule Backup (cron)', annotations: { destructiveHint: true, openWorldHint: true } },

  // Database
  ssh_db_dump: { title: 'Dump Database', annotations: { openWorldHint: true } },
  ssh_db_import: { title: 'Import Database Dump', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_db_list: { title: 'List Databases / Tables', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_db_query: { title: 'Run Read-Only Query', annotations: { readOnlyHint: true, openWorldHint: true } },

  // Deploy
  ssh_deploy: { title: 'Deploy Artifact', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_deploy_artifact: { title: 'Deploy Artifact (alias)', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_execute_sudo: { title: 'Execute With Sudo', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_execute_group: { title: 'Execute Across Group', annotations: { openWorldHint: true } },

  // Admin / config
  ssh_alias: { title: 'Manage Server Aliases', annotations: { idempotentHint: true } },
  ssh_command_alias: { title: 'Manage Command Aliases', annotations: { idempotentHint: true } },
  ssh_hooks: { title: 'Manage Automation Hooks', annotations: { idempotentHint: true } },
  ssh_profile: { title: 'Manage Active Profile', annotations: { idempotentHint: true } },
  ssh_group_manage: { title: 'Manage Server Groups', annotations: { idempotentHint: true } },
  ssh_connection_status: { title: 'Connection Pool Status', annotations: { readOnlyHint: true, idempotentHint: true } },
  ssh_history: { title: 'Command History', annotations: { readOnlyHint: true, idempotentHint: true } },

  // Tunnels
  ssh_tunnel_create: { title: 'Create SSH Tunnel', annotations: { openWorldHint: true } },
  ssh_tunnel_list: { title: 'List Tunnels', annotations: { readOnlyHint: true, idempotentHint: true } },
  ssh_tunnel_close: { title: 'Close Tunnel', annotations: { idempotentHint: true } },

  // Host keys / auth
  ssh_key_manage: { title: 'Manage SSH Host Keys', annotations: { idempotentHint: true, openWorldHint: true } },

  // Gamechanger
  ssh_cat: { title: 'View Remote File', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_systemctl: { title: 'Systemd Unit Control', annotations: { openWorldHint: true } },
  ssh_journalctl: { title: 'Systemd Journal Query', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_docker: { title: 'Docker Control', annotations: { openWorldHint: true } },
  ssh_port_test: { title: 'Port / TLS / HTTP Probe', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_diff: { title: 'Diff Two Files', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } },
  ssh_edit: { title: 'Atomic File Edit', annotations: { destructiveHint: true, openWorldHint: true } },
  ssh_tail_start: { title: 'Start Live Tail', annotations: { openWorldHint: true } },
  ssh_tail_read: { title: 'Read Live Tail Buffer', annotations: { readOnlyHint: true, idempotentHint: true } },
  ssh_tail_stop: { title: 'Stop Live Tail', annotations: { idempotentHint: true } },
  ssh_plan: { title: 'Plan + Approve Execution', annotations: { destructiveHint: true, openWorldHint: true } },
};

/**
 * Merge MCP annotations + title into a registerTool schema for the given
 * tool. If we don't know the tool, returns the schema unchanged.
 */
export function withAnnotations(toolName, schema) {
  const ann = TOOL_ANNOTATIONS[toolName];
  if (!ann) return schema;
  return {
    ...schema,
    ...(ann.title && !schema.title ? { title: ann.title } : {}),
    ...(ann.annotations ? { annotations: { ...(schema.annotations || {}), ...ann.annotations } } : {}),
  };
}
