/**
 * Per-action required-argument validation for v4 fat verb-tools.
 *
 * MCP inputSchema cannot express "arg X required only when action = Y", so
 * every action-scoped arg is declared optional and each dispatcher calls
 * requireArgs() at entry to enforce its per-action required map.
 */

import { fail, toMcp } from '../structured-result.js';

/** Arg counts as present unless undefined/null/empty-string. */
function present(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Validate that args holds every required arg for `action`.
 * @returns null when satisfied, else a structured fail() MCP response.
 */
export function requireArgs(tool, action, args, requiredMap) {
  const required = (requiredMap && requiredMap[action]) || [];
  const missing = required.filter((k) => !present((args || {})[k]));
  if (missing.length === 0) return null;
  return toMcp(fail(
    tool,
    `action "${action}" requires: ${missing.join(', ')}`,
    { server: (args || {}).server ?? null },
  ));
}
