#!/usr/bin/env node
/**
 * PreToolUse hook for the Bash tool. Detects a simple ssh/scp/rsync invocation
 * against a configured server and prints a soft, non-blocking nudge toward the
 * matching ssh_* MCP tool. Best-effort: simple shapes nudged, complex command
 * lines passed through. Fail-open -- any error exits 0 with no nudge.
 *
 * Wired in .claude/settings.json under hooks.PreToolUse, matcher "Bash".
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Shell metacharacters => the command line is not a simple invocation. Bail.
const COMPLEX = /[|&;<>`]|\$\(/;

/** Configured server names from the project .env (best-effort, never throws). */
export function configuredServers(envPath) {
  try {
    const text = readFileSync(envPath, 'utf8');
    const names = new Set();
    for (const line of text.split('\n')) {
      // SSH_SERVER_<NAME>_HOST=... -- <NAME> is the server identifier.
      const m = /^\s*SSH_SERVER_([A-Za-z0-9]+)_HOST\s*=/.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
    return [...names];
  } catch {
    return [];
  }
}

/** Strip a leading user@ and return the bare host token, lowercased. */
function bareHost(token) {
  const at = token.lastIndexOf('@');
  return (at === -1 ? token : token.slice(at + 1)).toLowerCase();
}

/**
 * Inspect a Bash command string. Returns { tool, message } when it is a simple
 * ssh/scp/rsync call against a configured server, else null. Never throws.
 */
export function detectSshNudge(command, servers) {
  try {
    if (!command || typeof command !== 'string') return null;
    if (!Array.isArray(servers) || servers.length === 0) return null;
    if (COMPLEX.test(command)) return null;

    const set = new Set(servers.map((s) => String(s).toLowerCase()));
    const tokens = command.trim().split(/\s+/);
    const head = tokens[0];

    if (head === 'ssh') {
      // First token after the flags that is not a flag or a flag-value is the host.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-p' || t === '-i' || t === '-l' || t === '-o' || t === '-F') {
          i++; // skip this flag's value
          continue;
        }
        if (t.startsWith('-')) continue;
        return set.has(bareHost(t))
          ? { tool: 'ssh_run', message: nudgeText(bareHost(t), 'ssh_run', 'ssh') }
          : null;
      }
      return null;
    }

    if (head === 'scp' || head === 'rsync') {
      // Any non-flag token of the form host:path against a configured server.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) continue;
        const colon = t.indexOf(':');
        if (colon > 0 && set.has(bareHost(t.slice(0, colon)))) {
          const host = bareHost(t.slice(0, colon));
          return { tool: 'ssh_file', message: nudgeText(host, 'ssh_file', head) };
        }
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/** The soft nudge text shown in the PreToolUse hook output. */
function nudgeText(host, tool, rawCmd) {
  return `[ssh-manager] '${host}' is a configured server. Consider the `
    + `${tool} MCP tool instead of raw \`${rawCmd}\` -- pooled connection, `
    + `bounded output, structured result. (This is a hint, not a block.)`;
}

// --- CLI shell: invoked by Claude Code as a PreToolUse hook --------------
// Reads the hook JSON payload on stdin; prints a nudge on stdout if one
// applies; always exits 0 so the Bash call is never blocked.
function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // no stdin -> nothing to inspect
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable payload -> fail open
  }

  const command = payload && payload.tool_input && payload.tool_input.command;
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  const nudge = detectSshNudge(command, configuredServers(envPath));
  if (nudge) console.log(nudge.message);
  process.exit(0);
}

// Run main() only when executed directly, never when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
