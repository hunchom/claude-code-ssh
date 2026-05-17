# ssh-mcp v4 — Design Specification

**Date:** 2026-05-16
**Status:** Approved for implementation planning. Section-by-section approval gate waived by explicit user direction.
**Supersedes:** the 51-tool surface of the current `claude-code-ssh` build.

---

## 1. Goal

Make the `ssh-manager` MCP server a decisive improvement over Claude running raw
`ssh` through the Bash tool. Four targets, in priority order:

1. **Fewer tokens** — tool-schema footprint and per-call output volume.
2. **Faster** — connection reuse, no per-call SSH handshake, single-round-trip command chains.
3. **Robust** — structured results, correct per-segment exit codes, bounded output, safety rails.
4. **Clean output** — tool results that look far less sloppy than a raw `ssh` dump.

### Honest constraint on goal 4

MCP tool results are delivered as `type: "text"` content and display in the Claude Code
transcript as **plain / preformatted text, not rendered markdown**. `**bold**`, GFM
`| tables |`, and triple-backtick fences appear as literal characters in the tool-result
block. v4 therefore does **not** rely on markdown rendering. Output is engineered as
disciplined, aligned, ASCII plain text that is clean and scannable as-is. Markdown that
also happens to render — when Claude quotes a result into its own reply — is a bonus,
never load-bearing. Fenced code blocks are replaced by 2-space indentation: clean as
plain text, renders as a code block if a client does parse markdown, and not breakable
by payload content (a fenced block breaks when the payload itself contains backticks).

---

## 2. Context and problem

- The repo at `/Users/rogerfrench/claude-code-ssh` is the live MCP build. It already has
  `src/output-formatter.js` (ASCII render, head+tail truncation), `src/structured-result.js`,
  17 modular `src/tools/*.js` handlers, and ~677 passing tests.
- It registers **51 tools across 7 groups**. Claude Code defers a tool surface this large:
  the `mcp__ssh-manager__*` tools are not loaded into context and require `ToolSearch` to
  discover. Claude does not proactively discover them and falls back to the always-loaded
  Bash tool running raw `ssh`.
- Measured schema cost via the actual MCP wire serializer: 51 tools is approximately
  14,000 tokens (not the ~43k previously claimed — that figure was a character count of
  source, not the serialized schema).

v4 fixes this with three coupled changes: consolidate the tool surface, make output
token-efficient, and make the tools un-deferred and instruction-backed so Claude reaches
for them.

---

## 3. Tool surface — 51 collapsed to 13 fat verb-tools

Each tool covers one domain. Signature is `server` + an `action` enum + action-scoped
args. Fat verb-tools were chosen over *minimal core + discovery tool* (a discovery call
recreates the deferral failure this design exists to fix) and over *1-2 mega-tools* (one
giant op enum is an unscannable schema).

| Tool | Actions | Absorbs (from the 51) |
|---|---|---|
| `ssh_run` | exec, sudo, script, fleet, detach, job-status, job-kill | execute, execute_sudo, execute_group |
| `ssh_file` | upload, download, sync, read, write, edit, diff, deploy, deploy-artifact | upload, download, sync, cat, edit, diff, deploy, deploy_artifact |
| `ssh_find` | grep, locate, ls | NEW — remote search |
| `ssh_logs` | tail, follow-start, follow-read, follow-stop, journal | tail, tail_start, tail_read, tail_stop, journalctl |
| `ssh_service` | status, start, stop, restart, enable, disable | service_status, systemctl |
| `ssh_health` | check, watch, procs, alerts | health_check, monitor, process_manager, alert_setup |
| `ssh_db` | query, list, dump, import | db_query, db_list, db_dump, db_import |
| `ssh_backup` | create, list, restore, schedule | backup_create, backup_list, backup_restore, backup_schedule |
| `ssh_session` | start, send, list, close, replay, memory | session_start, session_send, session_list, session_close, session_replay, session_memory |
| `ssh_net` | tunnel-open, tunnel-list, tunnel-close, port-test | tunnel_create, tunnel_list, tunnel_close, port_test |
| `ssh_docker` | ps, logs, exec, restart, inspect, compose | docker (its existing multi-action surface, kept first-class) |
| `ssh_fleet` | servers, groups, aliases, profiles, hooks, keys, history, connections | list_servers, group_manage, alias, command_alias, profile, hooks, key_manage, connection_status, history |
| `ssh_plan` | run, approve | plan |

13 tools. Every one of the 51 current tools maps onto these — nothing is dropped.
`ssh_plan` is retained as its own tool because it is a meta-orchestrator: its `steps`
dispatch table is rewritten to the v4 verb+action namespace. `ssh_deploy_artifact` becomes
`ssh_file action: deploy-artifact`.

### Action-arg validation

MCP `inputSchema` cannot express "argument X is required only when `action` = Y". Therefore:

- Every action-scoped argument is declared optional in the schema. Its description names
  the actions it applies to, e.g. `"Remote file path (actions: read, write, edit, diff)"`.
- Each dispatcher checks a per-action required-arg map at entry and returns a structured
  `fail()` naming any missing arguments and the action's expected argument set.
- camelCase argument aliases (`localPath` alongside `local_path`, etc.) are dropped. v4
  is a clean break; arguments are snake_case only. This removes roughly 1k tokens of
  duplicated schema.

### Dispatcher reality

The claim is "re-facade, not rewrite": the 13 tools are dispatchers over the existing,
tested handler bodies in `src/tools/*.js`. The handler bodies are not rewritten. However,
the dispatchers are not trivially thin — existing handlers take divergent context objects
(`{getConnection, args}`, `{getConnection, getServerConfig, args}`,
`{getConnection, resolveGroup, args}`, `{getConnection, getSftp, args}`, the session
handler's `_openShellStream`, the plan handler's `dispatch`). Each dispatcher assembles
the correct per-action context. A `ctx-factory` helper centralizes this so the 13
dispatchers stay readable.

---

## 4. Output model

One render path for all 13 tools, extending `src/output-formatter.js`.

### Format

- `format` argument: `compact` (default) | `json` | `markdown`.
- **`compact`** (default): for a small single-line result, one line —
  `[ok] ssh_run exec · devcentos · exit 0 · 0.4s :: <trimmed stdout>`. For larger output,
  a header line followed by the body indented 2 spaces. No fenced code blocks. No echo of
  the command back (it is already in the tool-call arguments the model holds).
- **`json`**: the full structured result object, always valid parseable JSON, regardless
  of the compact-mode optimizations. Used by machine consumers and by `ssh_plan` when it
  calls sub-tools internally.
- **`markdown`**: same as compact but payloads wrapped in fences — retained only for
  clients that are known to render markdown in tool results.

### Header grammar

Every tool emits a header line built by a single shared `renderHeader()` primitive. Fixed
slot order, one divider (` · `):

```
<marker> <tool> · <action> · <server> · <status-or-exit> · <duration>
```

Markers: `[ok]` / `[err]` / `[warn]`. Omitted slots collapse; slots never reorder. A
single regex test asserts every tool's header conforms.

### Body rules

- Tabular data, 2 or more rows (process lists, db rows, fleet results, disk mounts):
  aligned ASCII table. Reads as a grid in plain text; renders as a table if parsed.
- A single record's fields (service status, one health snapshot): 2-column key/value table.
- Free-form command stdout and logs: 2-space-indented block. Never fenced.
- Multi-row results: failed/abnormal rows sorted to the top, with a summary count as the
  first body line (e.g. `2/7 FAILED`).
- `defaultRender` (fallback when a tool ships without a custom renderer) emits a flat
  key/value table — never a raw `JSON.stringify` blob. Every action of every tool ships
  with a real renderer; the fallback is a safety net, not a plan.

### Output compression

A new `src/command-compressors.js` recognizes command type and compresses noisy output,
rtk-inspired. Rules:

- Compression runs in this fixed order: raw stdout -> ANSI strip -> per-command compressor
  -> head+tail truncation -> render. Compressors must see un-truncated input.
- **Lossless on signal:** a compressor never drops a row that is an error, a warning, a
  non-zero exit, or a resource at/near capacity. It compresses only the boring rows.
- Every compressed result ends with the exact escape hatch, e.g.
  `> 1792 lines elided -- re-run with raw: true or grep: PATTERN`.
- `raw: true` is a universal argument that disables all compression and truncation
  shaping for that call.
- Specific compressors: `ls` drops the `total` line and trims; `ps` shows top-N by the
  requested sort but keeps full argv for the top-N and for any process matching a filter,
  clipping only the long tail; `df` never filters by filesystem type (a full tmpfs is a
  real incident) — it sorts by percent-used descending; `git log` becomes oneline only
  when no `--format`/`-p` was requested; test-runner output keeps failures plus the
  summary; unrecognized output falls back to head+tail.

---

## 5. Adoption

The consolidation is necessary but not sufficient — Claude must also choose these tools.

- **Un-deferred surface.** 13 tools with a measured schema small enough that Claude Code
  keeps them loaded (see section 8 gate). Always loaded means always visible.
- **Selling descriptions.** Each tool description names the bash it replaces, e.g.
  `ssh_logs`: "Read remote logs. Use instead of `ssh host journalctl` — output is capped
  and filtered so it will not flood context."
- **CLAUDE.md rule.** A rule in the project `CLAUDE.md` and the user's global rules: for
  configured SSH servers, use `ssh_*` MCP tools, not raw `ssh` via Bash.
- **PreToolUse hook.** A hook on the Bash tool detects simple `ssh <host>` / `scp` / `rsync`
  invocations against a configured host and emits a soft, non-blocking nudge toward the
  MCP tool. Best-effort: it handles simple invocations and passes complex command lines
  through unchanged. Fail-open.

---

## 6. Real bash-ssh patterns covered

Patterns Claude habitually runs via raw `ssh`, and how v4 absorbs each:

- **`cmd1; cmd2; cmd3` chains.** `ssh_run action: script` with a `commands` array. Run in
  a **single exec** over the pooled connection, segments joined server-side with an
  exit-capturing sentinel (after each segment: `printf '\n##SEG %d %d##\n' <idx> $?`). The
  renderer splits on the sentinel and reports a per-segment exit code. One round-trip,
  per-segment exits, and shared shell state (`cd`, env) preserved across segments. An
  optional `isolate: true` runs each segment as a separate exec for the rare case that
  needs shell-state isolation.
- **Blind `grep -rn`.** `ssh_find action: grep`. Structured hits (file, line, text), a
  match cap that stops the walk via `head` (SIGPIPE), N context lines. See section 7 for
  the mandatory server-side bounds.
- **Heredoc to a remote file** (`ssh host 'cat > f <<"EOF" ... EOF'`). `ssh_file
  action: write` with a `content` argument, transferred via SFTP. No shell-quoting or
  heredoc-delimiter hazard.
- **Backgrounded long jobs** (`setsid nohup script & disown`, poll a logfile).
  `ssh_run action: detach` and `action: job-status` / `job-kill`. See section 7.

---

## 7. Build approach

v4 is a re-facade of the existing handlers plus a bounded amount of new code.

### Reused unchanged

The handler bodies in `src/tools/*.js`, `src/stream-exec.js`, connection pooling, the
SFTP path, `src/structured-result.js`.

### New or rewritten

- 13 dispatcher modules (one per tool) plus a `ctx-factory` helper.
- `src/command-compressors.js` — the per-command output compressors.
- `src/output-formatter.js` — extended: `renderHeader()`, compact format, indentation
  instead of fences, the body rules. The incorrect comment claiming fences "render with a
  subtle tint in Claude Code" is removed.
- `ssh_find` handler — new. Shells out to remote `grep`/`find`; parses to structured hits.
- Job tracking for `ssh_run detach` — see below.
- `src/tool-registry.js` and `src/index.js` registration — rewritten for the 13 tools.
- The PreToolUse Bash hook script.

### `ssh_run detach` job model

State lives on the remote server, not in MCP memory, so jobs survive an MCP restart and
pooled-connection eviction.

- `detach` launches: `setsid sh -c '<cmd>; echo $? > $JOBDIR/rc' > $JOBDIR/log 2>&1 &
  echo $! > $JOBDIR/pid`, where `JOBDIR` is `~/.ssh-manager/jobs/<job-id>/` on the remote
  host. Returns the job id and log path.
- `job-status` reads `rc` (presence = finished, with exit code), `pid`, and the new tail
  of `log` using offset tracking (the same incremental-read mechanism as
  `ssh_logs follow-read`). Job completion is decided by the `rc` file's presence, not by
  PID liveness, so there is no PID-reuse race.
- `job-kill` reads `pid` and terminates the process group.

### Command timeout

The exec path escalates on timeout: send `INT`, grace period, then `KILL`. Non-raw
commands are additionally wrapped in the OS `timeout` utility so a process ignoring
signals is still bounded server-side.

### `ssh_find` server-side bounds

Baked into the emitted command, not just output truncation:

- A hard `timeout <n>` wrapper on the remote `grep`/`find`.
- Default exclusions: prune `/proc`, `/sys`, `/dev`, `/run`; `-xdev` (do not cross mounts)
  unless the caller opts in; skip `.git` directories.
- A match cap enforced by piping through `head -n <cap>` so the walk stops early on
  SIGPIPE rather than scanning the whole tree.
- A `path` argument is required; a bare `/` root is refused without an explicit override.
- Prefer `rg` if present on the remote host, fall back to `grep`.

### Connection reuse

Pool reuse uses a synchronous liveness check (`connected && !destroyed`), not a network
`ping()` probe on every call. A dead connection is detected on actual command failure and
reconnected then. This removes the per-call extra round-trip the current code pays.

---

## 8. Pre-build gate (go / no-go)

Before implementation begins, a measurement spike:

1. Build the 13 tools' `inputSchema` objects as static samples (full action enums, the
   union of action args, descriptions).
2. Serialize them through the actual MCP wire serializer and measure the token cost.
3. Confirm the total is materially below the current 51-tool cost (~14k) and below the
   threshold at which Claude Code defers a tool surface.

If the consolidated surface does not come in materially smaller, the fat-tool model is
reconsidered (the alternative being fewer arguments per tool rather than fewer tools).
A preliminary measurement of the v4 surface estimated roughly 5k tokens; the gate
confirms this against the real serializer before code is written.

---

## 9. Testing

- The ~640 handler-level tests call handlers directly with injected mocks and are
  decoupled from the tool layer — they re-point to the same handler functions unchanged.
- Four suites are coupled to tool names and registration —
  `test-index-registration.js`, `test-tool-registry.js`, `test-tool-annotations.js`,
  `test-tool-config-manager.js` — and are rewritten for the 13-tool surface.
- New suites: dispatcher routing and per-action arg validation; the compressors
  (including the lossless-on-signal guarantees); `ssh_find` parsing; the detach job model.
- A header-grammar regex test covering all 13 tools.
- A render-snapshot fixture per tool: the literal output string, eyeball-reviewed, as a
  regression guard — since no automated test can confirm "looks good".

---

## 10. Risks and resolved decisions

- **Markdown does not render in tool results.** Accepted. Goal 4 is reframed around clean
  plain text (section 1). Fences replaced by indentation.
- **Token savings.** Honest figure: roughly 14k -> 5k schema tokens (~65%), confirmed by
  the section 8 gate. Per-call output is additionally reduced by compact format and
  compressors. The earlier "43k -> 13k" figure was wrong and is discarded.
- **`;`-chain mechanism.** Resolved: single exec with exit sentinels, not N execs. N execs
  would be slower than raw bash and would lose shared shell state.
- **Un-defer premise.** Treated as unverified until the section 8 gate passes. The gate is
  go/no-go.
- **`ssh_fleet` breadth.** The original 11-action grab-bag is split: `ssh_net` and
  `ssh_docker` are separate tools; `ssh_fleet` keeps only genuine fleet/config-metadata.

## 11. Out of scope

- Backward-compatible tool aliases. v4 renames every tool; there is no compatibility
  shim. Single-user deployment; the Codex integration docs are updated to the new names.
- Re-implementing rsync or any remote tool. v4 shells out and shapes output.
