/**
 * Structured result primitives for every upgraded tool.
 *
 * Every tool returns a wire object of shape:
 *   { success: bool, tool: string, server?: string, data: any, meta: {...}, error?: string }
 *
 * Wrapped into MCP content via toMcp() with markdown / json / both formats.
 * Tools provide a small renderer per-type for the markdown face.
 */

import { formatBytes, renderHeader, renderKV, indentBody } from './output-formatter.js';

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
 * Normalizes shapes so the rendered error text is always useful:
 *   - Error:  -> e.message (keeps stack in `stack` field for debugging)
 *   - string  -> passthrough
 *   - object  -> JSON.stringify (falls back to String() if cyclic)
 *   - null    -> 'unknown error'
 */
export function fail(tool, error, meta = {}) {
  let message;
  let stack;
  if (error == null) {
    message = 'unknown error';
  } else if (error instanceof Error) {
    message = error.message || error.name || 'Error';
    stack = error.stack;
  } else if (typeof error === 'string') {
    message = error;
  } else if (typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) {
      message = error.message;
    } else {
      try { message = JSON.stringify(error); }
      catch (_) { message = String(error); }
    }
  } else {
    message = String(error);
  }
  const out = {
    success: false,
    tool,
    server: meta.server ?? null,
    data: null,
    meta: strip(meta, ['server']),
    error: message,
  };
  if (stack && process.env.MCP_SSH_INCLUDE_STACK === '1') {
    out.error_stack = stack;
  }
  return out;
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
 * format: "compact" (default) | "markdown" | "json" | "both".
 */
export function toMcp(result, { format = 'compact', renderer } = {}) {
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
 * Header line via renderHeader; data as an indented KV block; no fences.
 */
export function defaultRender(result) {
  const { success, tool, server, data, meta, error } = result;
  const header = renderHeader({
    marker: success ? '[ok]' : '[err]',
    tool,
    server,
    status: success ? null : 'failed',
    durationMs: meta && meta.duration_ms,
  });
  const lines = [header];

  if (!success) {
    lines.push(indentBody(String(error || 'unknown error')));
    return lines.join('\n');
  }

  if (data && data.preview) {
    lines.push('  dry run -- nothing executed');
    lines.push(indentBody(renderKV(kvRows(data.plan))));
    return lines.join('\n');
  }

  if (data != null) {
    lines.push(indentBody(renderKV(kvRows(data))));
  }

  const elided = meta && (meta.truncated_bytes || meta.elided_bytes);
  if (elided) lines.push(indentBody(`elided: ${formatBytes(elided)}`));

  return lines.join('\n');
}

/**
 * Flatten an object to [key, value] rows for renderKV. Nested objects/arrays
 * collapse to compact JSON; non-objects render as a single `value` row.
 */
function kvRows(obj) {
  if (obj == null || typeof obj !== 'object') return [['value', String(obj)]];
  return Object.entries(obj).map(([k, v]) => [
    k,
    v != null && typeof v === 'object' ? JSON.stringify(v) : String(v),
  ]);
}
