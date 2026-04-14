/**
 * Preview / dry-run helpers shared by mutating tools.
 *
 * Pattern: every mutating tool accepts `preview: boolean`. When true:
 *   1. Compute a `plan` object describing what would happen.
 *   2. Return preview(tool, plan, meta) from structured-result.
 *   3. Never touch the remote.
 *
 * Plan schema (minimum):
 *   {
 *     action: 'upload' | 'exec' | 'deploy' | 'restart' | 'edit' | ...,
 *     target: string,                 // e.g. 'prod01:/etc/nginx/nginx.conf'
 *     effects: string[],              // human-readable bullets
 *     reversibility: 'auto' | 'manual' | 'irreversible',
 *     estimated_duration_ms?: number,
 *     risk?: 'low' | 'medium' | 'high',
 *   }
 *
 * The renderer in structured-result.defaultRender produces a "dry run" card.
 */

/**
 * Build a well-formed plan object. Missing fields default to safe values.
 */
export function buildPlan({
  action,
  target,
  effects = [],
  reversibility = 'manual',
  estimated_duration_ms,
  risk = 'medium',
  ...rest
}) {
  return {
    action,
    target,
    effects: Array.isArray(effects) ? effects : [String(effects)],
    reversibility,
    estimated_duration_ms: estimated_duration_ms ?? null,
    risk,
    ...rest,
  };
}

/**
 * Short-circuit helper: if args.preview is true, build plan and return an
 * MCP-ready response; else return null so the caller continues to real execution.
 *
 * @param {boolean} isPreview         args.preview
 * @param {string}  toolName
 * @param {Object}  planArgs          passed to buildPlan()
 * @param {Object}  [mcpOpts]         { format } for toMcp
 * @param {Function} [toMcp]          allow injection for testability
 */
export function maybePreview(isPreview, toolName, planArgs, { format = 'markdown' } = {}, toMcp, preview) {
  if (!isPreview) return null;
  const plan = buildPlan(planArgs);
  return toMcp(preview(toolName, plan, { server: planArgs.server }), { format });
}

/**
 * Render a standalone plan as markdown (outside the structured-result pipeline).
 * Useful for displaying a multi-step plan before executing.
 */
export function renderPlan(plan, { title = 'preview' } = {}) {
  const lines = [];
  lines.push(`▶ **${title}**  ·  \`${plan.action}\`  ·  \`${plan.target}\``);
  if (plan.risk) lines.push(`  ·  risk: **${plan.risk}**`);
  lines.push('');
  lines.push('> **dry run** — nothing executed');
  if (plan.effects && plan.effects.length) {
    lines.push('');
    lines.push('**effects:**');
    for (const eff of plan.effects) lines.push(`- ${eff}`);
  }
  if (plan.reversibility) {
    lines.push('');
    lines.push(`**reversibility:** \`${plan.reversibility}\``);
  }
  if (plan.estimated_duration_ms) {
    const secs = (plan.estimated_duration_ms / 1000).toFixed(2);
    lines.push('');
    lines.push(`**estimated duration:** \`${secs} s\``);
  }
  return lines.join('\n');
}
