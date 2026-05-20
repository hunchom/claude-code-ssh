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
  ssh_run: {
    title: 'Run Remote Command',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_find: {
    title: 'Search and List Files',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_file: {
    title: 'Transfer / Read / Edit Files',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_logs: {
    title: 'Read Remote Logs',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_service: {
    title: 'Service Control',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_health: {
    title: 'Health, Processes, Alerts',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_db: {
    title: 'Database Operations',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_backup: {
    title: 'Backup and Restore',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_docker: {
    title: 'Docker Control',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_session: {
    title: 'Persistent SSH Sessions',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_net: {
    title: 'Tunnels and Port Probes',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  ssh_fleet: {
    title: 'Fleet and Config Metadata',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  ssh_plan: {
    title: 'Multi-Step Plan Executor',
    annotations: { destructiveHint: true, openWorldHint: true },
  },
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
    // Spread table defaults first, then caller-provided annotations so the
    // caller can selectively override defaults (e.g. flip openWorldHint off
    // for a future tool where it doesn't apply).
    ...(ann.annotations ? { annotations: { ...ann.annotations, ...(schema.annotations || {}) } } : {}),
  };
}
