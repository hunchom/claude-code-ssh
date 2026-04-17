/**
 * Tool Registry
 *
 * Centralized registry of all MCP tools organized into functional groups.
 * Used for conditional tool registration based on user configuration.
 */

/**
 * Tool groups with their associated tools
 * Total: 51 tools across 7 groups
 */
export const TOOL_GROUPS = {
  // Core group (5 tools) - Essential SSH operations
  core: [
    'ssh_list_servers',
    'ssh_execute',
    'ssh_upload',
    'ssh_download',
    'ssh_sync'
  ],

  // Sessions group (6 tools) - Persistent SSH session management
  sessions: [
    'ssh_session_start',
    'ssh_session_send',
    'ssh_session_list',
    'ssh_session_close',
    'ssh_session_replay',
    'ssh_session_memory'
  ],

  // Monitoring group (6 tools) - System health and monitoring
  monitoring: [
    'ssh_health_check',
    'ssh_service_status',
    'ssh_process_manager',
    'ssh_monitor',
    'ssh_tail',
    'ssh_alert_setup'
  ],

  // Backup group (4 tools) - Backup and restore operations
  backup: [
    'ssh_backup_create',
    'ssh_backup_list',
    'ssh_backup_restore',
    'ssh_backup_schedule'
  ],

  // Database group (4 tools) - Database operations
  database: [
    'ssh_db_dump',
    'ssh_db_import',
    'ssh_db_list',
    'ssh_db_query'
  ],

  // Advanced group (14 tools) - Advanced features
  advanced: [
    'ssh_deploy',
    'ssh_execute_sudo',
    'ssh_alias',
    'ssh_command_alias',
    'ssh_hooks',
    'ssh_profile',
    'ssh_connection_status',
    'ssh_tunnel_create',
    'ssh_tunnel_list',
    'ssh_tunnel_close',
    'ssh_key_manage',
    'ssh_execute_group',
    'ssh_group_manage',
    'ssh_history'
  ],

  // Gamechanger group (12 tools) - File/service/log/network/deploy primitives
  gamechanger: [
    'ssh_cat',
    'ssh_edit',
    'ssh_diff',
    'ssh_systemctl',
    'ssh_journalctl',
    'ssh_docker',
    'ssh_port_test',
    'ssh_tail_start',
    'ssh_tail_read',
    'ssh_tail_stop',
    'ssh_deploy_artifact',
    'ssh_plan'
  ]
};

/**
 * Human-readable descriptions for each tool group
 */
export const TOOL_GROUP_DESCRIPTIONS = {
  core: 'Essential SSH operations (list servers, execute commands, upload/download files, sync)',
  sessions: 'Persistent SSH sessions with state, replay, and inferred memory',
  monitoring: 'System health checks, service monitoring, process management, and alerts',
  backup: 'Automated backup and restore for databases and files',
  database: 'Database operations (MySQL, PostgreSQL, MongoDB)',
  advanced: 'Advanced features (deployment, sudo, tunnels, groups, aliases, hooks, profiles)',
  gamechanger: 'File reads/edits/diffs, systemd + journal + docker wrappers, port probe, sessionized log tails, declarative deploy, multi-step plans'
};

/**
 * Tool count per group
 */
export const TOOL_GROUP_COUNTS = {
  core: 5,
  sessions: 6,
  monitoring: 6,
  backup: 4,
  database: 4,
  advanced: 14,
  gamechanger: 12
};

/**
 * Get all tool names across all groups
 * @returns {string[]} Array of all tool names (51 across 7 groups)
 */
export function getAllTools() {
  return Object.values(TOOL_GROUPS).flat();
}

/**
 * Find which group a tool belongs to
 * @param {string} toolName - Name of the tool
 * @returns {string|null} Group name or null if not found
 */
export function findToolGroup(toolName) {
  for (const [groupName, tools] of Object.entries(TOOL_GROUPS)) {
    if (tools.includes(toolName)) {
      return groupName;
    }
  }
  return null;
}

/**
 * Get all tools in a specific group
 * @param {string} groupName - Name of the group
 * @returns {string[]} Array of tool names in the group
 */
export function getGroupTools(groupName) {
  return TOOL_GROUPS[groupName] || [];
}

/**
 * Validate that all expected tools are registered
 * @param {string[]} registeredTools - Array of registered tool names
 * @returns {Object} Validation result with missing and unexpected tools
 */
export function validateToolRegistry(registeredTools) {
  const allExpectedTools = getAllTools();
  const registeredSet = new Set(registeredTools);
  const expectedSet = new Set(allExpectedTools);

  const missing = allExpectedTools.filter(tool => !registeredSet.has(tool));
  const unexpected = registeredTools.filter(tool => !expectedSet.has(tool));

  return {
    valid: missing.length === 0 && unexpected.length === 0,
    total: allExpectedTools.length,
    registered: registeredTools.length,
    missing,
    unexpected
  };
}

/**
 * Get statistics about tool groups
 * @returns {Object} Statistics object
 */
export function getToolStats() {
  const groups = Object.keys(TOOL_GROUPS);
  const totalTools = getAllTools().length;

  return {
    totalGroups: groups.length,
    totalTools,
    groups: groups.map(groupName => ({
      name: groupName,
      count: TOOL_GROUP_COUNTS[groupName],
      description: TOOL_GROUP_DESCRIPTIONS[groupName],
      tools: TOOL_GROUPS[groupName]
    }))
  };
}

/**
 * Verify tool registry integrity (no duplicates, all accounted for)
 * @returns {Object} Integrity check result
 */
export function verifyIntegrity() {
  const allTools = getAllTools();
  const uniqueTools = new Set(allTools);

  const duplicates = allTools.filter((tool, index) =>
    allTools.indexOf(tool) !== index
  );

  const expectedTotal = Object.values(TOOL_GROUP_COUNTS).reduce((a, b) => a + b, 0);

  return {
    valid: duplicates.length === 0 && allTools.length === expectedTotal,
    totalTools: allTools.length,
    uniqueTools: uniqueTools.size,
    expectedTotal,
    duplicates,
    issues: []
      .concat(duplicates.length > 0 ? [`Found ${duplicates.length} duplicate tools`] : [])
      .concat(allTools.length !== expectedTotal ? [`Expected ${expectedTotal} tools but found ${allTools.length}`] : [])
  };
}
