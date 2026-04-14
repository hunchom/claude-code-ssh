/**
 * End-to-end glue for the `ssh_execute_stream` tool handler.
 *
 * Pure function: takes an ssh2-shaped client, runs streamExecCommand, formats
 * with formatExecResult, emits MCP content. Keeps the handler thin and testable.
 */

import { streamExecCommand } from './stream-exec.js';
import {
  formatExecResult,
  makeMcpContent,
} from './output-formatter.js';

/**
 * Run a streaming exec and return an MCP tool response.
 *
 * @param {Object}   args
 * @param {Object}   args.client      ssh2 Client (or shape-compatible)
 * @param {string}   args.server      logical server name for the header
 * @param {string}   args.command     remote command
 * @param {string}   [args.cwd]       working directory (shell-quoted internally)
 * @param {number}   [args.timeoutMs=120000]
 * @param {number}   [args.maxLen=10000]     per-stream render cap
 * @param {number}   [args.debounceMs=50]
 * @param {'markdown'|'json'|'both'} [args.format='markdown']
 * @param {Function} [args.onChunk]   forwarded to streamExecCommand
 * @returns {Promise<{content: Array, isError?: boolean}>}
 */
export async function runStreamedExec({
  client,
  server,
  command,
  cwd,
  timeoutMs = 120_000,
  maxLen = 10_000,
  debounceMs = 50,
  format = 'markdown',
  onChunk,
}) {
  const startedAt = Date.now();
  let result;
  let error;
  try {
    result = await streamExecCommand(client, command, {
      cwd,
      timeoutMs,
      debounceMs,
      onChunk,
    });
  } catch (e) {
    error = e;
  }
  const durationMs = Date.now() - startedAt;

  if (error) {
    const exec = formatExecResult({
      server,
      command,
      cwd,
      stdout: '',
      stderr: String(error.message || error),
      code: -1,
      durationMs,
      maxLen,
    });
    return {
      content: makeMcpContent(exec, { format }),
      isError: true,
    };
  }

  const exec = formatExecResult({
    server,
    command,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    durationMs,
    maxLen,
  });
  return {
    content: makeMcpContent(exec, { format }),
    // Non-zero exit is NOT a tool-level isError — the command ran, just failed.
    // Claude can read exit_code from the JSON or badge from the markdown.
  };
}
