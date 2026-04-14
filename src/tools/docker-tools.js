/**
 * ssh_docker -- typed Docker CLI wrapper over SSH.
 *
 * Actions:
 *   - ps       list containers (JSONL-parsed)
 *   - logs     fetch container logs (tail N; follow unsupported in one-shot)
 *   - exec     run a command inside a container
 *   - inspect  JSON inspection of a container
 *   - stop/start/restart/rm   mutating; preview-supported
 *   - pull     fetch image; streams progress via onChunk if provided
 *
 * Safety:
 *   - container name validated by regex (Docker's own allowed chars plus
 *     acceptance of 12-64-char hex IDs). Arbitrary strings are rejected.
 *   - image ref validated against a conservative subset (name[:tag][@digest]).
 *   - every interpolated value shell-quoted via shQuote().
 *   - mutating actions support preview:true -- nothing remote runs.
 */

import { streamExecCommand, shQuote } from '../stream-exec.js';
import { ok, fail, preview, toMcp } from '../structured-result.js';
import { buildPlan } from '../preview-mode.js';
import { formatDuration } from '../output-formatter.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TAIL_LINES = 100;
const MAX_TAIL_LINES = 100_000;

// --------------------------------------------------------------------------
// Whitelists
// --------------------------------------------------------------------------

export const ALLOWED_ACTIONS = new Set([
  'ps', 'logs', 'exec', 'inspect',
  'stop', 'start', 'restart', 'rm',
  'pull',
]);

export const MUTATING_ACTIONS = new Set([
  'stop', 'start', 'restart', 'rm', 'pull',
]);

export const REVERSIBILITY = {
  stop: 'auto',       // reversible via start
  start: 'auto',      // reversible via stop
  restart: 'auto',    // self-reversing
  rm: 'irreversible', // gone is gone
  pull: 'auto',       // local image removable; image ref still resolves
};

export const RISK_MAP = {
  stop: 'medium',
  start: 'low',
  restart: 'medium',
  rm: 'high',
  pull: 'low',
};

// --------------------------------------------------------------------------
// Validators
// --------------------------------------------------------------------------

/**
 * Docker container NAME (as enforced by Docker itself):
 *   first char: [a-zA-Z0-9]
 *   rest:       [a-zA-Z0-9_.-]
 *
 * Additionally we accept 12..64 character hex strings as container IDs
 * (docker ps -q short = 12, full = 64).
 *
 * Length cap: 253 for names.
 */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;

export function isValidContainer(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.length > 253) return false;
  if (CONTAINER_ID_RE.test(name)) return true;
  return CONTAINER_NAME_RE.test(name);
}

/**
 * Docker image ref. Conservative subset:
 *   - first char [a-zA-Z0-9]
 *   - body:      [a-zA-Z0-9._/-]    (slashes allowed for registry/namespace)
 *   - optional:  :tag    (tag = [\w.-]+)
 *   - optional:  @sha256:<64-hex>
 *
 * Explicitly rejects metacharacters: ;|&$`<>(){}\s"'!
 */
export const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/;

export function isValidImage(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref.length > 512) return false;
  return IMAGE_REF_RE.test(ref);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function safeTailLines(n, fallback = DEFAULT_TAIL_LINES) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  if (v < 1) return 1;
  if (v > MAX_TAIL_LINES) return MAX_TAIL_LINES;
  return v;
}

/**
 * Parse `docker ps --format '{{json .}}'` output into typed records.
 *
 * Docker emits one JSON object per container per line. Field names:
 *   .ID .Names .Image .Status .Ports .State .CreatedAt
 */
export function parseDockerPs(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    out.push({
      id: rec.ID ?? rec.Id ?? null,
      name: rec.Names ?? rec.Name ?? null,
      image: rec.Image ?? null,
      status: rec.Status ?? null,
      ports: rec.Ports ?? '',
      state: rec.State ?? null,
      created: rec.CreatedAt ?? rec.Created ?? null,
    });
  }
  return out;
}

/** Parse `docker inspect CONTAINER` output (a JSON array of inspect records). */
export function parseDockerInspect(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch (_) {
    return null;
  }
}

// --------------------------------------------------------------------------
// Renderer
// --------------------------------------------------------------------------

export function renderDocker(result) {
  if (!result.success) return `[err] **ssh_docker** -- ${result.error || 'failed'}`;
  const d = result.data;
  if (d && d.preview) {
    const lines = [];
    lines.push(`[ok] **ssh_docker** -- dry run`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(d.plan, null, 2));
    lines.push('```');
    return lines.join('\n');
  }
  const srv = result.server ? `  |  \`${result.server}\`` : '';
  const dur = result.meta?.duration_ms != null ? `  |  \`${formatDuration(result.meta.duration_ms)}\`` : '';

  if (d.action === 'ps') {
    const lines = [`[ok] **ssh_docker ps**${srv}  |  ${d.containers.length} containers${dur}`];
    if (d.containers.length) {
      lines.push('');
      lines.push('| id | name | image | status | ports |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const c of d.containers) {
        const id = (c.id || '').slice(0, 12);
        const ports = (c.ports || '').slice(0, 40).replace(/\|/g, '\\|');
        lines.push(`| \`${id}\` | ${c.name ?? '--'} | ${c.image ?? '--'} | ${c.status ?? '--'} | ${ports} |`);
      }
    }
    return lines.join('\n');
  }

  if (d.action === 'logs') {
    const lines = [`[ok] **ssh_docker logs**  |  \`${d.container}\`${srv}${dur}`];
    if (d.output) {
      lines.push('');
      lines.push('```text');
      lines.push(d.output);
      lines.push('```');
    }
    return lines.join('\n');
  }

  if (d.action === 'exec') {
    const badge = d.exit_code === 0 ? '[ok]' : '[err]';
    const lines = [`${badge} **ssh_docker exec**  |  \`${d.container}\`${srv}  |  exit ${d.exit_code}${dur}`];
    lines.push(`\`$ ${d.command}\``);
    if (d.stdout) {
      lines.push('');
      lines.push('```text');
      lines.push(d.stdout);
      lines.push('```');
    }
    if (d.stderr) {
      lines.push('');
      lines.push('**stderr**');
      lines.push('```text');
      lines.push(d.stderr);
      lines.push('```');
    }
    return lines.join('\n');
  }

  if (d.action === 'inspect') {
    const lines = [`[ok] **ssh_docker inspect**  |  \`${d.container}\`${srv}${dur}`];
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(d.inspect, null, 2));
    lines.push('```');
    return lines.join('\n');
  }

  // stop/start/restart/rm/pull
  const badge = d.exit_code === 0 ? '[ok]' : '[err]';
  const target = d.container || d.image || '';
  const lines = [`${badge} **ssh_docker ${d.action}**  |  \`${target}\`${srv}  |  exit ${d.exit_code}${dur}`];
  if (d.output) {
    lines.push('');
    lines.push('```text');
    lines.push(d.output);
    lines.push('```');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {Function} params.getConnection
 * @param {Object} params.args
 *   - server
 *   - action (required; whitelisted)
 *   - container (required for logs/exec/inspect/stop/start/restart/rm)
 *   - image (required for pull)
 *   - command (required for exec; arbitrary shell string inside container)
 *   - tail_lines (default 100; logs action)
 *   - follow (default false; logs/pull -- not supported in one-shot)
 *   - preview (default false)
 *   - format (markdown | json | both)
 */
export async function handleSshDocker({ getConnection, args }) {
  const {
    server,
    action,
    container,
    image,
    command,
    tail_lines = DEFAULT_TAIL_LINES,
    follow = false,
    preview: isPreview = false,
    format = 'markdown',
    onChunk,
  } = args || {};

  // -- Whitelist ---------------------------------------------------------
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return toMcp(fail('ssh_docker', `invalid action "${action}"`, { server }), {
      format, renderer: renderDocker,
    });
  }

  // -- ps (no container needed) ------------------------------------------
  if (action === 'ps') {
    return runPs({ getConnection, server, format });
  }

  // -- pull (image needed, no container) --------------------------------
  if (action === 'pull') {
    if (!image) {
      return toMcp(fail('ssh_docker', 'pull requires an image', { server }), {
        format, renderer: renderDocker,
      });
    }
    if (!isValidImage(image)) {
      return toMcp(fail('ssh_docker', `invalid image ref "${image}"`, { server }), {
        format, renderer: renderDocker,
      });
    }
    return runPull({ getConnection, server, image, isPreview, format, onChunk });
  }

  // -- All other actions need container ----------------------------------
  if (!container) {
    return toMcp(fail('ssh_docker', `action "${action}" requires a container`, { server }), {
      format, renderer: renderDocker,
    });
  }
  if (!isValidContainer(container)) {
    return toMcp(fail('ssh_docker', `invalid container "${container}"`, { server }), {
      format, renderer: renderDocker,
    });
  }

  if (action === 'logs') {
    if (follow) {
      return toMcp(fail('ssh_docker',
        'follow:true not supported by this tool -- use ssh_tail for streaming', { server }), {
        format, renderer: renderDocker,
      });
    }
    return runLogs({ getConnection, server, container, tail_lines, format });
  }

  if (action === 'exec') {
    if (!command) {
      return toMcp(fail('ssh_docker', 'exec requires a command', { server }), {
        format, renderer: renderDocker,
      });
    }
    return runExec({ getConnection, server, container, command, isPreview, format });
  }

  if (action === 'inspect') {
    return runInspect({ getConnection, server, container, format });
  }

  // stop / start / restart / rm
  return runMutation({ getConnection, server, action, container, isPreview, format });
}

// --------------------------------------------------------------------------
// Runners
// --------------------------------------------------------------------------

async function runPs({ getConnection, server, format }) {
  const command = `docker ps --format ${shQuote('{{json .}}')}`;
  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  const containers = parseDockerPs(result.stdout || '');
  return toMcp(ok('ssh_docker', { action: 'ps', containers }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

async function runLogs({ getConnection, server, container, tail_lines, format }) {
  const n = safeTailLines(tail_lines);
  const command = `docker logs --tail ${n} ${shQuote(container)}`;
  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, command, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return toMcp(ok('ssh_docker', {
    action: 'logs',
    container,
    output: combined,
    exit_code: result.code ?? 0,
    tail_lines: n,
  }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

async function runExec({ getConnection, server, container, command, isPreview, format }) {
  // Always wrap user command in `sh -c '<cmd>'` so pipes/redirects work
  // inside the container. shQuote() neutralizes embedded quotes.
  const remote = `docker exec ${shQuote(container)} sh -c ${shQuote(command)}`;

  if (isPreview) {
    const plan = buildPlan({
      action: 'docker-exec',
      target: `${server}:${container}`,
      effects: [`runs \`${command}\` inside container ${container}`, `remote: \`${remote}\``],
      reversibility: 'manual',
      risk: 'medium',
    });
    return toMcp(preview('ssh_docker', plan, { server }), {
      format, renderer: renderDocker,
    });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  return toMcp(ok('ssh_docker', {
    action: 'exec',
    container,
    command,
    exit_code: result.code ?? 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

async function runInspect({ getConnection, server, container, format }) {
  const remote = `docker inspect ${shQuote(container)}`;
  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  const inspect = parseDockerInspect(result.stdout || '');
  if (inspect == null) {
    return toMcp(fail('ssh_docker', 'docker inspect returned invalid JSON', {
      server, duration_ms: Date.now() - startedAt,
    }), { format, renderer: renderDocker });
  }
  return toMcp(ok('ssh_docker', {
    action: 'inspect',
    container,
    inspect,
  }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

async function runMutation({ getConnection, server, action, container, isPreview, format }) {
  const remote = `docker ${action} ${shQuote(container)}`;

  if (isPreview) {
    const plan = buildPlan({
      action: `docker-${action}`,
      target: `${server}:${container}`,
      effects: [`runs \`${remote}\` on ${server}`],
      reversibility: REVERSIBILITY[action] || 'manual',
      risk: RISK_MAP[action] || 'medium',
      reverse_command: buildReverseCommand(action, container),
    });
    return toMcp(preview('ssh_docker', plan, { server }), {
      format, renderer: renderDocker,
    });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return toMcp(ok('ssh_docker', {
    action,
    container,
    output: combined,
    exit_code: result.code ?? 0,
  }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

async function runPull({ getConnection, server, image, isPreview, format, onChunk }) {
  const remote = `docker pull ${shQuote(image)}`;

  if (isPreview) {
    const plan = buildPlan({
      action: 'docker-pull',
      target: `${server}:${image}`,
      effects: [`runs \`${remote}\` on ${server}`, 'downloads image layers from registry'],
      reversibility: 'auto',
      risk: 'low',
      reverse_command: `docker rmi ${image}`,
    });
    return toMcp(preview('ssh_docker', plan, { server }), {
      format, renderer: renderDocker,
    });
  }

  const startedAt = Date.now();
  let client;
  try { client = await getConnection(server); }
  catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  let result;
  try {
    result = await streamExecCommand(client, remote, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onChunk,
    });
  } catch (e) {
    return toMcp(fail('ssh_docker', e, { server, duration_ms: Date.now() - startedAt }), {
      format, renderer: renderDocker,
    });
  }
  const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return toMcp(ok('ssh_docker', {
    action: 'pull',
    image,
    output: combined,
    exit_code: result.code ?? 0,
  }, {
    server, duration_ms: Date.now() - startedAt,
  }), { format, renderer: renderDocker });
}

function buildReverseCommand(action, container) {
  switch (action) {
    case 'stop':    return `docker start ${container}`;
    case 'start':   return `docker stop ${container}`;
    case 'restart': return `docker restart ${container}`;
    case 'rm':      return null; // irreversible
    default:        return null;
  }
}
