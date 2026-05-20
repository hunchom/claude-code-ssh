/**
 * ssh_run -- v4 fat verb-tool dispatcher.
 *
 * Collapses ssh_execute / ssh_execute_sudo / ssh_execute_group. Routes the
 * `action` arg to an existing handler in src/tools/exec-tools.js, building the
 * right context object via makeCtx and mapping v4 snake_case args to the
 * handler arg names.
 *
 * actions handled here: exec, sudo, fleet, script, detach, job-status,
 * job-kill. exec/sudo/fleet delegate to src/tools/exec-tools.js handlers;
 * script/detach/job-* have no handler -- the dispatcher execs them directly
 * via streamExecCommand with raw:true (no OS timeout-wrapper), unlike
 * handleSshExecute's non-raw wrapped path.
 *
 * handlers (injected): { execute, executeSudo, executeGroup }.
 */

import { ok, fail, toMcp } from '../structured-result.js';
import { streamExecCommand } from '../stream-exec.js';
import { renderHeader, renderRows, renderKV, indentBody } from '../output-formatter.js';
import { makeCtx } from './ctx-factory.js';
import { requireArgs } from './action-validate.js';
import { expandCommandAlias } from '../command-aliases.js';
import { buildScriptCommand, parseScriptSegments } from '../script-runner.js';
import {
  buildDetachCommand, buildJobStatusCommand, parseJobStatus, buildJobKillCommand,
} from '../job-tracker.js';

// in-process channel guard for the exec-direct actions
const RUN_EXEC_TIMEOUT_MS = 120_000;

const REQUIRED = {
  exec: ['server', 'command'],
  sudo: ['server', 'command'],
  fleet: ['group', 'command'],
  script: ['server', 'commands'],
  detach: ['server', 'command'],
  'job-status': ['server', 'job_id'],
  'job-kill': ['server', 'job_id'],
};

/** script segments -> idx/exit/command/stdout table. */
function renderScript(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'script', server: result.server,
    status: result.success ? `${result.data.segments.length} segments` : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const rows = result.data.segments.map((s) => [
    s.index,
    s.exitCode == null ? '?' : s.exitCode,
    s.command == null ? '' : s.command,
    String(s.stdout || '').replace(/\r?\n/g, ' ').slice(0, 120),
  ]);
  return `${header}\n${indentBody(renderRows(['#', 'exit', 'command', 'stdout'], rows))}`;
}

/** detach result -> job id / log path KV block. */
function renderDetach(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'detach', server: result.server,
    status: result.success ? 'launched' : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  return `${header}\n${indentBody(renderKV([
    ['job_id', result.data.job_id],
    ['log_path', result.data.log_path],
  ]))}`;
}

/** job-status result -> state / exit / log KV block. */
function renderJobStatus(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'job-status', server: result.server,
    status: result.success ? result.data.state : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  const d = result.data;
  const kv = renderKV([
    ['state', d.state],
    ['exit_code', d.exit_code == null ? '' : d.exit_code],
    ['pid', d.pid == null ? '' : d.pid],
    ['log_size', d.log_size],
  ]);
  const body = d.log_chunk ? `${kv}\n--\n${d.log_chunk}` : kv;
  return `${header}\n${indentBody(body)}`;
}

/** job-kill result -> the raw confirmation line. */
function renderJobKill(result) {
  const header = renderHeader({
    marker: result.success ? '[ok]' : '[err]',
    tool: 'ssh_run', action: 'job-kill', server: result.server,
    status: result.success ? 'signalled' : 'failed',
    durationMs: result.meta && result.meta.duration_ms,
  });
  if (!result.success) return `${header}\n${indentBody(String(result.error))}`;
  return `${header}\n${indentBody(String(result.data.result || ''))}`;
}

export async function handleSshRun({ deps, handlers, args } = {}) {
  const a = args || {};
  const { action } = a;

  if (!action) {
    return toMcp(fail('ssh_run', 'action is required', { server: a.server ?? null }));
  }
  if (!Object.prototype.hasOwnProperty.call(REQUIRED, action)) {
    return toMcp(fail('ssh_run', `unknown action "${action}"`, { server: a.server ?? null }));
  }

  const bad = requireArgs('ssh_run', action, a, REQUIRED);
  if (bad) return bad;

  // exec + sudo both resolve server default_dir when no cwd given
  const cfg = (deps && deps.getServerConfig && deps.getServerConfig(a.server)) || {};

  // exec + sudo expand command aliases at exec time -- parity w/ old ssh_execute.
  // deps.expandCommandAlias override = test seam; else module impl.
  const expand = (deps && deps.expandCommandAlias) || expandCommandAlias;

  if (action === 'exec') {
    return handlers.execute(makeCtx('conn', deps, {
      server: a.server,
      command: expand(a.command),
      cwd: a.cwd || cfg.default_dir,
      timeout: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  if (action === 'sudo') {
    return handlers.executeSudo(makeCtx('conn-cfg', deps, {
      server: a.server,
      command: expand(a.command),
      password: a.sudo_password,
      cwd: a.cwd || cfg.default_dir,
      timeout: a.timeout,
      raw: a.raw,
      format: a.format,
    }));
  }

  if (action === 'fleet') {
    return handlers.executeGroup(makeCtx('conn-group', deps, {
      group: a.group,
      command: a.command,
      cwd: a.cwd,
      raw: a.raw,
      format: a.format,
    }));
  }

  if (action === 'script') {
    if (!Array.isArray(a.commands) || a.commands.length === 0) {
      return toMcp(fail('ssh_run', 'script: commands must be a non-empty array',
        { server: a.server }));
    }
    let built;
    try {
      built = buildScriptCommand(a.commands, { isolate: a.isolate });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, built.command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    // thread the builder's nonce -> only this invocation's sentinels parse
    const segments = parseScriptSegments(raw, built.nonce, a.commands);
    return toMcp(
      ok('ssh_run', { action, segments }, { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderScript },
    );
  }

  if (action === 'detach') {
    let built;
    try {
      built = buildDetachCommand(a.command, a.job_id ? { jobId: a.job_id } : {});
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    try {
      await streamExecCommand(client, built.command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    return toMcp(
      ok('ssh_run',
        { action, job_id: built.jobId, log_path: built.logPath },
        { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderDetach },
    );
  }

  if (action === 'job-status') {
    let command;
    try {
      command = buildJobStatusCommand(a.job_id, { offset: a.since_offset });
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    const st = parseJobStatus(raw);
    return toMcp(
      ok('ssh_run', {
        action,
        state: st.state,
        exit_code: st.exitCode,
        pid: st.pid,
        log_size: st.logSize,
        log_chunk: st.logChunk,
      }, { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderJobStatus },
    );
  }

  if (action === 'job-kill') {
    let command;
    try {
      command = buildJobKillCommand(a.job_id);
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server }));
    }
    const startedAt = Date.now();
    let client;
    try { client = await deps.getConnection(a.server); }
    catch (e) { return toMcp(fail('ssh_run', e, { server: a.server })); }

    let raw;
    try {
      const r = await streamExecCommand(client, command, {
        raw: true, timeoutMs: RUN_EXEC_TIMEOUT_MS, abortSignal: a.abortSignal,
      });
      raw = r.stdout;
    } catch (e) {
      return toMcp(fail('ssh_run', e, { server: a.server, action }));
    }
    return toMcp(
      ok('ssh_run', { action, result: String(raw || '').trim() },
        { server: a.server, duration_ms: Date.now() - startedAt }),
      { format: a.format, renderer: renderJobKill },
    );
  }
}
