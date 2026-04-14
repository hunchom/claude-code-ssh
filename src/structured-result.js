/**
 * Structured result primitives for every upgraded tool.
 *
 * Every tool returns a wire object of shape:
 *   { success: bool, tool: string, server?: string, data: any, meta: {...}, error?: string }
 *
 * Wrapped into MCP content via toMcp() with markdown / json / both formats.
 * Tools provide a small renderer per-type for the markdown face.
 */

import { formatBytes, formatDuration } from './output-formatter.js';

/**
 * Build a success result.
 * @param {string} tool        canonical tool name (e.g. 'ssh_health_check')
 * @param {Object} data        the tool's structured payload
 * @param {Object} [meta]      duration_ms, server, preview, truncated, etc.
 */
export function ok(tool, data, meta = {}) {
  return {
    success: true,
    tool,
    server: meta.server ?? null,
    data,
    meta: strip(meta, ['server']),
  };
}

/**
 * Build an error result. `error` may be Error, string, or object.
 */
export function fail(tool, error, meta = {}) {
  return {
    success: false,
    tool,
    server: meta.server ?? null,
    data: null,
    meta: strip(meta, ['server']),
    error: String(error && error.message ? error.message : error),
  };
}

/**
 * Build a preview result (dry-run; nothing executed).
 * @param {string} tool
 * @param {Object} plan        what would have happened: {action, target, effects, reversibility, ...}
 * @param {Object} [meta]
 */
export function preview(tool, plan, meta = {}) {
  return {
    success: true,
    tool,
    server: meta.server ?? null,
    data: { preview: true, plan },
    meta: strip(meta, ['server']),
  };
}

function strip(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Package a structured result as MCP content.
 * @param {Object} result       from ok() / fail() / preview()
 * @param {Object} [opts]
 * @param {'markdown'|'json'|'both'} [opts.format='markdown']
 * @param {Function} [opts.renderer]   (result) => string. Defaults to defaultRender.
 */
export function toMcp(result, { format = 'markdown', renderer } = {}) {
  const md = (renderer || defaultRender)(result);
  if (format === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success };
  }
  if (format === 'both') {
    return {
      content: [
        { type: 'text', text: md },
        { type: 'text', text: JSON.stringify(result) },
      ],
      isError: !result.success,
    };
  }
  return { content: [{ type: 'text', text: md }], isError: !result.success };
}

/**
 * Default markdown renderer. Tools override for richer cards.
 * Layout:
 *   [ok] **<tool>**  |  `server`  |  <duration?>
 *   <data-as-compact-json>
 *   > elided: ... (if meta.truncated)
 */
export function defaultRender(result) {
  const { success, tool, server, data, meta, error } = result;
  const marker = success ? '[ok]' : '[err]';
  const badge = success ? '' : '  |  **failed**';
  const duration = meta && meta.duration_ms != null
    ? `  |  \`${formatDuration(meta.duration_ms)}\``
    : '';
  const srv = server ? `  |  \`${server}\`` : '';
  const header = `${marker} **${tool}**${srv}${duration}${badge}`;

  const lines = [header];

  if (!success) {
    lines.push('');
    lines.push('```text');
    lines.push(String(error || 'unknown error'));
    lines.push('```');
    return lines.join('\n');
  }

  if (data && data.preview) {
    lines.push('');
    lines.push('> **dry run** -- nothing executed');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(data.plan, null, 2));
    lines.push('```');
    return lines.join('\n');
  }

  if (data != null) {
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(data, null, 2));
    lines.push('```');
  }

  if (meta && (meta.truncated_bytes || meta.elided_bytes)) {
    const b = meta.truncated_bytes || meta.elided_bytes;
    lines.push('');
    lines.push(`> elided: ${formatBytes(b)}`);
  }

  return lines.join('\n');
}
