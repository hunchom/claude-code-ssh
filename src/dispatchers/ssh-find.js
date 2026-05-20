/**
 * ssh_find -- v4 fat verb-tool dispatcher.
 *
 * Remote search: grep (recursive content), locate (find -name), ls (one dir).
 * No src/tools/*.js handler exists -- the dispatcher owns build -> exec ->
 * parse -> render itself, like handleSshExecute. Commands come from the pure
 * builders in remote-search.js; each is already server-side bounded (timeout,
 * pruned pseudo-fs, match cap), so streamExecCommand runs raw:true with only
 * an in-process timeoutMs guarding a stuck channel.
 *
 * deps (injected): { getConnection }.
 */

import { streamExecCommand } from '../stream-exec.js';
import { ok, fail, toMcp } from '../structured-result.js';
import { renderHeader, renderRows, indentBody } from '../output-formatter.js';
import { requireArgs } from './action-validate.js';
import {
  buildGrepCommand, buildLocateCommand, buildLsCommand,
  parseGrepHits, parseLocateHits, parseLsRows,
} from '../remote-search.js';

// in-process channel guard; Plan-5 commands carry their own server-side timeout
const EXEC_TIMEOUT_MS = 60_000;

const REQUIRED = {
  grep: ['server', 'pattern', 'path'],
  locate: ['server', 'name', 'path'],
  ls: ['server', 'path'],
};

/** grep hits -> file/line/text table. */
function renderGrep(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'grep', server: result.server,
    status: result.success ? `${result.data.count} hits` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.hits.map((h) => [h.file, h.line, h.text]);
  return `${header}\n${indentBody(renderRows(['file', 'line', 'text'], rows))}`;
}

/** locate paths -> single-column path table. */
function renderLocate(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'locate', server: result.server,
    status: result.success ? `${result.data.count} paths` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.paths.map((p) => [p]);
  return `${header}\n${indentBody(renderRows(['path'], rows))}`;
}

/** ls rows -> perms/size/type/name table. */
function renderLs(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_find', action: 'ls', server: result.server,
    status: result.success ? `${result.data.count} entries` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.entries.map((e) => [e.perms, e.size, e.type, e.name]);
  return `${header}\n${indentBody(renderRows(['perms', 'size', 'type', 'name'], rows))}`;
}

export async function handleSshFind({ deps, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_find', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_find', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_find', action, a, REQUIRED);
  if (bad) return bad;

  // builders throw on a bad path (bare "/", empty) -- surface as a clean fail
  let command;
  try {
    if (action === 'grep') {
      command = buildGrepCommand({
        pattern: a.pattern, path: a.path, matchCap: a.match_cap,
        timeoutSecs: a.timeout_secs, contextLines: a.context_lines,
        crossMounts: a.cross_mounts, allowRoot: a.allow_root,
      });
    } else if (action === 'locate') {
      command = buildLocateCommand({
        name: a.name, path: a.path, matchCap: a.match_cap,
        timeoutSecs: a.timeout_secs, crossMounts: a.cross_mounts,
        allowRoot: a.allow_root,
      });
    } else {
      command = buildLsCommand({ path: a.path, timeoutSecs: a.timeout_secs });
    }
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server }));
  }

  const startedAt = Date.now();
  let client;
  try {
    client = await deps.getConnection(a.server);
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server }));
  }

  let raw;
  try {
    // raw:true -- builder already wrapped the command in `timeout`
    const r = await streamExecCommand(client, command, {
      raw: true, timeoutMs: EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
    });
    raw = r.stdout;
  } catch (e) {
    return toMcp(fail('ssh_find', e, { server: a.server, action }));
  }

  const meta = { server: a.server, duration_ms: Date.now() - startedAt };
  const fmt = a.format;

  if (action === 'grep') {
    const hits = parseGrepHits(raw);
    return toMcp(ok('ssh_find', { action, count: hits.length, hits }, meta),
      { format: fmt, renderer: renderGrep });
  }
  if (action === 'locate') {
    const paths = parseLocateHits(raw);
    return toMcp(ok('ssh_find', { action, count: paths.length, paths }, meta),
      { format: fmt, renderer: renderLocate });
  }
  const entries = parseLsRows(raw);
  return toMcp(ok('ssh_find', { action, count: entries.length, entries }, meta),
    { format: fmt, renderer: renderLs });
}
