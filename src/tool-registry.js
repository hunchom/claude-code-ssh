/**
 * Tool Registry
 *
 * Centralized registry of all MCP tools organized into functional groups.
 * Used for conditional tool registration based on user configuration.
 */

/**
 * Tool groups with their associated tools.
 * Total: 12 v4 fat verb-tools across 3 groups.
 */
export const TOOL_GROUPS = {
  // Core (3) -- run commands, move files, read logs
  core: [
    'ssh_run',
    'ssh_file',
    'ssh_logs',
  ],

  // Ops (5) -- services, health, databases, backups, containers
  ops: [
    'ssh_service',
    'ssh_health',
    'ssh_db',
    'ssh_backup',
    'ssh_docker',
  ],

  // Advanced (4) -- sessions, networking, fleet/config, multi-step plans
  advanced: [
    'ssh_session',
    'ssh_net',
    'ssh_fleet',
    'ssh_plan',
  ],
};

/**
 * Human-readable descriptions for each tool group.
 */
export const TOOL_GROUP_DESCRIPTIONS = {
  core: 'Run remote commands, transfer/read/edit files, read logs',
  ops: 'Service control, health checks, database ops, backups, Docker',
  advanced: 'Persistent sessions, tunnels/port probes, fleet+config metadata, multi-step plans',
};

/**
 * Tool count per group.
 */
export const TOOL_GROUP_COUNTS = {
  core: 3,
  ops: 5,
  advanced: 4,
};

/**
 * Get all tool names across all groups
 * @returns {string[]} Array of all tool names (12 across 3 groups)
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
