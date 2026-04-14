/**
 * Rewritten exec tools: ssh_execute, ssh_execute_sudo, ssh_execute_group.
 *
 * All three:
 *   - Route through streamExecCommand (shell-quoted cwd, UTF-8 safe, abortable, timeout-safe)
 *   - Return structured results via the formatter + structured-result helpers
 *   - Support format: 'markdown' | 'json' | 'both'
 *   - Support preview: true (dry run — shows plan, never touches remote)
 *
 * Sudo never echoes the password into argv. The password is written to the
 * exec stream's fd0 via streamExecCommand's stdin option, which means it
 * traverses the SSH channel encrypted and never appears in the remote shell.
 *
 * Group exec uses bounded concurrency (pMap) with per-server results.
 */

import { streamExecCommand } from '../stream-exec.js';
import { formatExecResult, renderMarkdown, makeMcpContent } from '../output-formatter.js';
import { ok, fail, preview, toMcp, defaultRender } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { pMap } from '../concurrency.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LEN = 10_000;
const DEFAULT_DEBOUNCE_MS = 50;
const DEFAULT_GROUP_CONCURRENCY = 5;

// ──────────────────────────────────────────────────────────────────────────
// ssh_execute
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshExecute({ getConnection, args }) {
  const {
    server, command, cwd, timeout = DEFAULT_TIMEOUT_MS,
    maxLen = DEFAULT_MAX_LEN,
    format = 'markdown',
    preview: isPreview = false,
    onChunk,
  } = args;

  if (isPreview) {
    const plan = buildPlan({
      action: 'exec',
      target: `${server}:${cwd || '(default cwd)'}`,
      effects: [`runs \`${command}\` on ${server}`],
      reversibility: 'manual',
      estimated_duration_ms: null,
      risk: 'medium',
    });
    return toMcp(preview('ssh_execute', plan, { server }), { format });
  }

  const startedAt = Date.now();
  let client;
  try {
    client = await getConnection(server);
  } catch (e) {
    return makeExecErrorResponse('ssh_execute', server, command, cwd, e, format, Date.now() - startedAt);
  }

  let result, error;
  try {
    result = await streamExecCommand(client, command, {
      cwd, timeoutMs: timeout, debounceMs: DEFAULT_DEBOUNCE_MS, onChunk,
    });
  } catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return makeExecErrorResponse('ssh_execute', server, command, cwd, error, format, durationMs);
  }

  const exec = formatExecResult({
    server, command, cwd,
    stdout: result.stdout, stderr: result.stderr,
    code: result.code, durationMs,
    maxLen,
  });
  return { content: makeMcpContent(exec, { format }) };
}

function makeExecErrorResponse(tool, server, command, cwd, error, format, durationMs) {
  const exec = formatExecResult({
    server, command, cwd,
    stdout: '', stderr: String(error.message || error),
    code: -1, durationMs, maxLen: DEFAULT_MAX_LEN,
  });
  return { content: makeMcpContent(exec, { format }), isError: true };
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_execute_sudo — password via stdin, never argv
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshExecuteSudo({ getConnection, getServerConfig, args }) {
  const {
    server, command, password, cwd,
    timeout = 30_000,
    maxLen = DEFAULT_MAX_LEN,
    format = 'markdown',
    preview: isPreview = false,
  } = args;

  // Strip leading "sudo " — we always add it explicitly below.
  const rawCmd = String(command).replace(/^sudo\s+/, '');
  // `-S` reads password from stdin. `-p ""` suppresses the prompt (no "Password:" bleed).
  // `--` ends sudo's option parsing so the user's command can start with a flag.
  const sudoCommand = `sudo -S -p '' -- ${rawCmd}`;

  if (isPreview) {
    const plan = buildPlan({
      action: 'exec-sudo',
      target: `${server}:${cwd || '(default cwd)'}`,
      effects: [`runs \`sudo ${rawCmd}\` on ${server}`, 'password never enters argv (stdin fed)'],
      reversibility: 'manual',
      risk: 'high',
    });
    return toMcp(preview('ssh_execute_sudo', plan, { server }), { format });
  }

  // Resolve password: explicit arg > config fallback > error.
  let pw = password;
  if (!pw && getServerConfig) {
    try {
      const cfg = await getServerConfig(server);
      pw = cfg?.sudoPassword || cfg?.sudo_password;
    } catch (_) { /* cfg lookup is best-effort */ }
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return makeExecErrorResponse('ssh_execute_sudo', server, `sudo ${rawCmd}`, cwd, e, format, Date.now() - startedAt);
  }

  let result, error;
  try {
    result = await streamExecCommand(client, sudoCommand, {
      cwd,
      timeoutMs: timeout,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      // Write password + newline to stream.stdin. `sudo -S` consumes it.
      // When pw is empty/undefined, send an empty line so passwordless sudo still works.
      stdin: (pw || '') + '\n',
    });
  } catch (e) { error = e; }

  const durationMs = Date.now() - startedAt;
  if (error) {
    return makeExecErrorResponse('ssh_execute_sudo', server, `sudo ${rawCmd}`, cwd, error, format, durationMs);
  }

  const exec = formatExecResult({
    server, command: `sudo ${rawCmd}`, cwd,
    stdout: result.stdout, stderr: result.stderr,
    code: result.code, durationMs,
    maxLen,
  });
  return { content: makeMcpContent(exec, { format }) };
}

// ──────────────────────────────────────────────────────────────────────────
// ssh_execute_group — bounded-concurrency fan-out
// ──────────────────────────────────────────────────────────────────────────
export async function handleSshExecuteGroup({ getConnection, resolveGroup, args }) {
  const {
    group, command, cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    maxLen = 4000,                 // smaller default per-server — results are aggregated
    concurrency = DEFAULT_GROUP_CONCURRENCY,
    format = 'markdown',
    stopOnError = false,
    preview: isPreview = false,
  } = args;

  const servers = await resolveGroup(group);
  if (!servers || servers.length === 0) {
    return toMcp(fail('ssh_execute_group', `group "${group}" has no servers`), { format });
  }

  if (isPreview) {
    const plan = buildPlan({
      action: 'exec-group',
      target: `group:${group} (${servers.length} servers)`,
      effects: [
        `runs \`${command}\` on: ${servers.join(', ')}`,
        `concurrency=${concurrency}, stopOnError=${stopOnError}`,
      ],
      reversibility: 'manual',
      risk: 'high',
    });
    return toMcp(preview('ssh_execute_group', plan), { format });
  }

  const startedAt = Date.now();

  const perServer = await pMap(servers, async (srv) => {
    const t0 = Date.now();
    let client;
    try { client = await getConnection(srv); }
    catch (e) {
      return {
        server: srv, success: false, exit_code: -1,
        duration_ms: Date.now() - t0,
        stdout: '', stderr: String(e.message || e),
        error: String(e.message || e),
      };
    }
    try {
      const r = await streamExecCommand(client, command, {
        cwd, timeoutMs: timeout, debounceMs: DEFAULT_DEBOUNCE_MS,
      });
      const formatted = formatExecResult({
        server: srv, command, cwd,
        stdout: r.stdout, stderr: r.stderr, code: r.code,
        durationMs: Date.now() - t0, maxLen,
      });
      return {
        server: srv, success: formatted.success,
        exit_code: formatted.exit_code, duration_ms: formatted.duration_ms,
        stdout: formatted.stdout, stderr: formatted.stderr,
        truncated: formatted.truncated,
      };
    } catch (e) {
      return {
        server: srv, success: false, exit_code: -1,
        duration_ms: Date.now() - t0,
        stdout: '', stderr: String(e.message || e),
        error: String(e.message || e),
      };
    }
  }, { concurrency, stopOnError });

  const aggregate = {
    group,
    command,
    cwd: cwd ?? null,
    total: servers.length,
    succeeded: perServer.filter(p => p.ok && p.value.success).length,
    failed: perServer.filter(p => !p.ok || !p.value.success).length,
    results: perServer.map(p => p.ok ? p.value : { server: p.item, success: false, error: String(p.error) }),
  };
  const durationMs = Date.now() - startedAt;
  const overall = ok('ssh_execute_group', aggregate, { duration_ms: durationMs });

  return toMcp(overall, { format, renderer: renderGroupMarkdown });
}

function renderGroupMarkdown(result) {
  // Custom renderer: header + per-server mini-cards.
  if (!result.success) return defaultRender(result);
  const d = result.data;
  const lines = [];
  const ok = d.failed === 0;
  const marker = ok ? '▶' : '✕';
  lines.push(`${marker} **ssh_execute_group**  ·  \`${d.group}\`  ·  ${d.succeeded}/${d.total} ok`);
  lines.push(`\`$ ${d.command}\`${d.cwd ? `   *(in \`${d.cwd}\`)*` : ''}`);
  lines.push('');
  for (const r of d.results) {
    const m = r.success ? '▶' : '✕';
    const exitBadge = r.success ? '**exit 0**' : `**exit ${r.exit_code ?? -1}**`;
    lines.push(`${m} \`${r.server}\`  ·  ${exitBadge}  ·  \`${(r.duration_ms / 1000).toFixed(2)} s\``);
    if (r.stdout && r.stdout.trim()) {
      lines.push('```text');
      lines.push(r.stdout);
      lines.push('```');
    }
    if (r.stderr && r.stderr.trim()) {
      lines.push('**stderr**');
      lines.push('```text');
      lines.push(r.stderr);
      lines.push('```');
    }
    if (r.error) {
      lines.push(`> error: ${r.error}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
