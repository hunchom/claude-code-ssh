---
name: operating-ssh-fleet
description: "Use when operating a remote server or fleet through the ssh-manager MCP and its ssh_* tools — running or scripting commands, deploying files, tailing/following logs, checking health, managing systemd services, databases, backups, Docker, SSH tunnels, or persistent shell sessions on a configured host. Also use for any raw ssh/scp/rsync (via Bash) operation against a configured server, or when the user says \"deploy to\", \"restart the service\", \"tail the log\", \"check the fleet\", or names a configured server."
---

# Operating the SSH Fleet

## Overview

`ssh-manager` is an MCP server that exposes **13 fat verb-tools** (`ssh_*`) for operating a fleet of configured servers. Each tool covers one domain and multiplexes many operations through an `action` enum.

**Core principle:** For any server in the configuration, the `ssh_*` tools are the intended way to operate it — not raw `ssh`/`scp`/`rsync` through Bash. They are not a read-only convenience layer; they are the operator interface.

## When to use

- Running, scripting, or backgrounding a command on a configured server
- Moving, reading, editing, or deploying files
- Reading or following logs; checking health, services, processes
- Databases, backups, Docker, tunnels, port probes, persistent sessions
- Multi-step changes across one or more servers
- **Any time you would otherwise type `ssh host "..."`, `scp`, or `rsync` in Bash for a configured host**

## When NOT to use

- The host is **not** in the configuration → raw `ssh` in Bash is fine. Run `ssh_fleet` `action: servers` to see what is configured.
- Pure local work with no remote target.

## The discipline: `ssh_*` over raw `ssh`

| Raw Bash | Why the tool wins |
|---|---|
| `ssh host "cmd"` reconnects every call | Tools hold a **pooled** connection — no per-call handshake |
| `ssh host journalctl` dumps everything | Output is **head+tail truncated + compressed** — won't flood context |
| `ssh host` with inline password leaks on argv | Credentials go via **stdin/env**, never `ps`-visible |
| Raw terminal dump | **Structured** results — per-segment exit codes, typed snapshots, sha256-verified transfers |

**Violating the letter (using raw ssh "just this once") is violating the spirit.** If the host is configured, use the tool.

## The 13 tools

Always loaded. Pick the tool, then the `action`.

| Tool | Group | Actions | Replaces |
|---|---|---|---|
| `ssh_run` | core | exec, sudo, script, fleet, detach, job-status, job-kill | `ssh host "cmd"` |
| `ssh_find` | core | grep, locate, ls | `ssh host "grep -rn …"` |
| `ssh_file` | core | upload, download, sync, read, write, edit, diff, deploy, deploy-artifact | `scp`, `cat > f <<EOF` |
| `ssh_logs` | core | tail, follow-start, follow-read, follow-stop, journal | `ssh host journalctl` / `tail -f` |
| `ssh_service` | ops | status, start, stop, restart, enable, disable | `ssh host systemctl …` |
| `ssh_health` | ops | check, watch, procs, alerts | `ssh host top`/`df`/`free` |
| `ssh_db` | ops | query, list, dump, import | `ssh host "mysql -e …"` |
| `ssh_backup` | ops | create, list, restore, schedule | `ssh host "tar/mysqldump …"` |
| `ssh_docker` | ops | ps, logs, exec, restart, inspect | `ssh host "docker …"` |
| `ssh_session` | advanced | start, send, list, close, replay, memory | repeated `ssh host "cmd"` |
| `ssh_net` | advanced | tunnel-open, tunnel-list, tunnel-close, port-test | `ssh -L/-R/-D`, `nc -z` |
| `ssh_fleet` | advanced | servers, groups, aliases, command_alias, profiles, hooks, keys, history, connections | `ssh -G`, `~/.ssh/config` |
| `ssh_plan` | advanced | run, approve | hand-sequenced batch of calls |

Full per-action parameter matrix: see `references/tool-matrix.md`.

## Always start with discovery

If you do not know what is configured, call `ssh_fleet` `action: servers` first. Server names are normalized to lowercase and aliases resolve before direct names. `server` is **required** for most tools; omit it only for `ssh_run` `action: fleet` (uses `group`), `ssh_fleet`, and `ssh_plan` (plan-level default).

## Cross-cutting parameters

- **`format`**: `compact` (default) | `json` | `markdown`. Use `json` when you will parse the result.
- **`raw`**: `true` disables compression/truncation. Use sparingly — the cap exists to protect context. Prefer narrowing the query (`grep`, `head`, `tail`, `lines`) over `raw: true`.
- **`preview`**: `true` shows the plan without executing. **Set it before any destructive/mutating action** — deploy, restore, service stop/restart, process kill, db import, tunnel-open, docker mutations.
- **`approve_token`** (`ssh_plan`): high-risk plans gate behind `action: approve` with any non-empty token.

## Recipes

**Run something**
- One command → `ssh_run` `exec` (`command`, optional `cwd`, `timeout`).
- Several in one round trip with shared `cd`/env → `ssh_run` `script` (`commands: [...]`). Add `isolate: true` for independent shells. Segments are **`;`-sequenced, not `&&`** — a failing segment does *not* abort the rest; you get a per-segment exit-code table. For fail-fast (e.g. `npm ci && npm run build`), put the `&&` inside one segment.
- Needs root → `ssh_run` `sudo` (password streams via `sudo_password`/stdin).
- Across a group → `ssh_run` `fleet` (`group`, no `server`).
- Long-running → `ssh_run` `detach` (returns a `job_id`) → poll `job-status` (returns `state` running/done + `exit_code` + `log_size`; feed the prior `log_size` back as `since_offset` for incremental output) → `job-kill` to stop.

**Files**
- Read a slice, not the whole file → `ssh_file` `read` with `head`/`tail`/`grep`/`line_start`/`line_end`. Line ranges are **1-based and inclusive** (`line_start: 50, line_end: 80` = 31 lines).
- Change a file in place → `ssh_file` `edit` (`old_text`/`new_text`) — never heredoc/quoting through `ssh_run`.
- Write a new file → `ssh_file` `write` (`content`).
- Push/pull → `upload`/`download`; mirror a tree → `sync` (`source`/`destination` with `local:`/`remote:` prefixes, `exclude`, `delete_extra`).
- Ship a build safely → `ssh_file` `deploy` (`artifact_local_path`, `target_path`). **Preview first.** Order of operations: upload → `post_hooks` → `health_check` → (on failure) rollback. Shapes:
  - `post_hooks`: array of **shell-command strings**, run in order after upload, e.g. `["systemctl restart nginx"]`.
  - `health_check`: a single **shell command**; **non-zero exit = unhealthy**, e.g. `"systemctl is-active nginx"`.
  - `rollback_on_fail: true`: restores the prior artifact if a `post_hook` *or* the `health_check` fails. `rollback_hook` is an optional command run *after* that restore (e.g. to bounce the service back).
  - `deploy-artifact` is an **alias** of `deploy` (same handler, same args); use `deploy`.

**Incident triage**
1. `ssh_health` `check` — cpu/mem/disk/process snapshot, at-capacity rows on top.
2. `ssh_logs` `journal` (`unit`, `since`, `priority`) or `tail` (`file`, `grep`, `lines`). `tail` applies `lines` **first, then** `grep` (it's `tail -n N | grep`), so a filtered tail can return fewer than `lines` rows — raise `lines` when filtering.
3. `ssh_service` `status` on the suspect unit.
4. Live watch → `ssh_logs` `follow-start` → loop `follow-read` (carry `since_offset`) → `follow-stop`.

**Search the box** → `ssh_find` `grep` (`pattern`, `path`, `context_lines`, `match_cap`). It prunes `/proc /sys /dev .git` and stops early — don't hand-roll `grep -rn /`. **`match_cap` defaults to 200** — for an exhaustive sweep raise it, or results silently truncate at 200. `allow_root: true` is needed *only* to search a bare `/` (any normal path like `/etc` works without it).

**Databases**
- Read → `ssh_db` `query` (**SELECT-only**; mutations are blocked by a safety check — for writes use `ssh_run` with the DB CLI or `ssh_db` `import`).
- Snapshot → `ssh_db` `dump` (`db_type`, `database`, `gzip`; `output_path` optional). If you set `output_path`, `gzip: true` pipes to it *as-is* — **no `.gz` appended**, so name it `….sql.gz` yourself. If you omit `output_path` it auto-names `/tmp/<db>-<ts>.sql[.gz]` (the auto-name *does* add `.gz`). Restore data → `import` (`input_path`; preview first).

**Backups** → `ssh_backup` `create` (content-addressed, sha256). Before any risky change, create one. `restore` shows a high-risk preview — review it before confirming.

**Multi-step / multi-server** → `ssh_plan` `run` with `steps: [...]` that dispatch to the other tools; high-risk plans need `approve`. Better than a hand-sequenced batch because each step returns a structured result and rollback is built in.

**Persistent shell state** (cwd/env must survive across commands) → `ssh_session` `start` → `send` → `replay`/`memory` to inspect → `close`.

## Common mistakes

| Mistake | Fix |
|---|---|
| Reaching for raw `ssh`/`scp`/`rsync` on a configured host | Use the matching `ssh_*` tool |
| `raw: true` to "see everything" | Narrow with `grep`/`head`/`tail`/`lines` instead; the cap protects context |
| Heredoc / shell-quoting to write a file | `ssh_file` `write` or `edit` |
| Destructive action with no `preview` | `preview: true` first (deploy, restore, kill, stop, import) |
| Non-SELECT through `ssh_db` `query` | Blocked by design; use `ssh_run`/DB CLI or `ssh_db` `import` |
| Passing `server` to `ssh_run` `fleet` | Use `group`; `server` is omitted there |
| Polling a detached job from scratch each time | Carry `since_offset` for incremental output |
| Guessing server names | `ssh_fleet` `action: servers` |

## Configuration (context)

Servers come from `~/.ssh-manager/.env` as `SSH_SERVER_<NAME>_HOST/USER/PORT/KEYPATH/...` (or TOML for Codex). You don't edit these to operate — `ssh_fleet` reads them. Add/remove servers via the `ssh-manager` CLI (`ssh-manager server add`).
