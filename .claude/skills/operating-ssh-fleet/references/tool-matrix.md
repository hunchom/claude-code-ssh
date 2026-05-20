# Full parameter matrix

Every action-scoped argument is optional at the schema level; each dispatcher enforces its own per-action required set and returns a structured failure naming any missing argument. The "needs" column lists what a call actually requires.

Common to every tool: `format` (`compact`|`json`|`markdown`, default `compact`), and where noted `raw` (disable truncation) and `preview` (dry-run).

---

## ssh_run — run commands

| action | needs | optional |
|---|---|---|
| `exec` | `server`, `command` | `cwd`, `timeout`, `raw`, `format` |
| `sudo` | `server`, `command` | `cwd`, `sudo_password`, `timeout`, `raw`, `format` |
| `script` | `server`, `commands[]` | `isolate` (separate shells, no shared cd/env), `raw`, `format` |
| `fleet` | `group` (no `server`), `command` | `cwd`, `format` |
| `detach` | `server`, `command` | returns a `job_id` |
| `job-status` | `server`, `job_id` | `since_offset` (incremental output; pass back prior `log_size`) |
| `job-kill` | `server`, `job_id` | |

`script` segments are `;`-sequenced — a failing segment does NOT abort the rest; returns a per-segment exit-code table. `isolate: true` runs each segment in its own shell (no shared cd/env). `job-status` returns `state` (running/done) + `exit_code` + `log_size`; feed the prior `log_size` back as `since_offset` for incremental output. Default `timeout`: `exec` 120000 ms, `sudo` 30000 ms.

## ssh_find — search files

| action | needs | optional |
|---|---|---|
| `grep` | `server`, `path`, `pattern` | `context_lines`, `match_cap`, `timeout_secs`, `cross_mounts`, `allow_root`, `format` |
| `locate` | `server`, `path`, `name` (glob) | `match_cap`, `timeout_secs`, `cross_mounts`, `allow_root`, `format` |
| `ls` | `server`, `path` | `format` |

Prunes `/proc /sys /dev` and `.git`; server-side timeout + match cap stop the walk early. **`match_cap` defaults to 200** (raise it for exhaustive sweeps or results truncate silently). `allow_root: true` is required only to search a bare `/`; normal paths need nothing.

## ssh_file — move/edit files

| action | needs | optional |
|---|---|---|
| `upload` | `server`, `local_path`, `remote_path` | `format` |
| `download` | `server`, `local_path`, `remote_path` | `format` |
| `read` | `server`, `remote_path` | `head`, `tail`, `grep`, `line_start`, `line_end` (1-based, inclusive), `format` |
| `write` | `server`, `remote_path`, `content` | `format` |
| `edit` | `server`, `remote_path`, `old_text`, `new_text` | `format` |
| `diff` | `server`, `path_a`, `path_b` | `server_b` (cross-server diff), `format` |
| `sync` | `server`, `source`, `destination` (`local:`/`remote:` prefixed) | `exclude[]`, `delete_extra`, `format` |
| `deploy` | `server`, `artifact_local_path`, `target_path` | `post_hooks[]` (shell-cmd strings, in order), `health_check` (cmd; non-zero=unhealthy), `rollback_on_fail`, `rollback_hook`, `preview`, `format` |
| `deploy-artifact` | alias of `deploy` (same handler + args) | — |

Deploy order: upload → `post_hooks` → `health_check` → (on `post_hook` or `health_check` failure, if `rollback_on_fail`) restore prior artifact → `rollback_hook`.

## ssh_logs — read logs

| action | needs | optional |
|---|---|---|
| `tail` | `server`, `file` | `lines`, `grep`, `format` |
| `follow-start` | `server`, `file` | `lines`, `grep` → returns `session_id` |
| `follow-read` | `session_id` | `since_offset` (resume cursor), `format` |
| `follow-stop` | `session_id` | |
| `journal` | `server` | `unit`, `since`, `until`, `priority`, `lines`, `grep`, `format` |

`tail`/`follow-start` apply `lines` first, then `grep` (`tail -n N | grep -E`), so a filtered result can have fewer than `lines` rows — raise `lines` when filtering.

## ssh_service — systemd

| action | needs | optional |
|---|---|---|
| `status` | `server`, `service` | `format` (returns ActiveState/SubState/recent log) |
| `start`/`stop`/`restart`/`enable`/`disable` | `server`, `service` | `preview`, `format` |

## ssh_health — health

| action | needs | optional |
|---|---|---|
| `check` | `server` | `format` (cpu/mem/disk/process snapshot) |
| `watch` | `server` | `watch_type` (`overview`|`cpu`|`memory`|`disk`|`network`|`process`), `format` |
| `procs` | `server` | `proc_action` (`list` default|`kill`|`info`), `pid`, `signal` (`TERM`|`KILL`|`HUP`|`INT`|`QUIT`), `preview`, `format` |
| `alerts` | `server`, `alert_action` (`set`|`get`|`check`) | `cpu_threshold`, `memory_threshold`, `disk_threshold` (0–100), `enabled`, `format` |

## ssh_db — databases

| action | needs | optional |
|---|---|---|
| `query` | `server`, `db_type`, `database`, `query` | `user`, `password`, `format`. **SELECT-only** (Mongo find ok). |
| `list` | `server`, `db_type` | `database` (list tables/collections), `user`, `password`, `format` |
| `dump` | `server`, `db_type`, `database` | `output_path` (default `/tmp/<db>-<ts>.sql[.gz]`), `gzip`, `user`, `password`, `format` |
| `import` | `server`, `db_type`, `database`, `input_path` | `preview`, `user`, `password`, `format` |

`db_type`: `mysql` | `postgresql` | `mongodb`. `query` is SELECT-only (Mongo: find/read only; mutations blocked). `dump`: a *supplied* `output_path` is used verbatim — `gzip` does NOT append `.gz`, add it yourself; an *omitted* `output_path` auto-names `/tmp/<db>-<ts>.sql[.gz]` (auto-name adds `.gz`).

## ssh_backup — backups

| action | needs | optional |
|---|---|---|
| `create` | `server`, `backup_type` | `name`, `database`, `paths[]`, `exclude[]`, `backup_dir`, `gzip`, `verify`, `format` |
| `list` | `server` | `backup_dir`, `format` |
| `restore` | `server`, `backup_id` | `target_path` (file backups), `verify`, `preview`, `format` |
| `schedule` | `server`, `backup_type`, `cron` | `name`, `database`, `paths[]`, `retention`, `format` |

`backup_type`: `mysql` | `postgresql` | `mongodb` | `files`. Content-addressed + sha256; restore shows a high-risk preview.

## ssh_docker — Docker

| action | needs | optional |
|---|---|---|
| `ps` | `server` | `format` |
| `logs` | `server`, `container` | `tail_lines`, `format` |
| `exec` | `server`, `container`, `command` | `format` |
| `restart` | `server`, `container` | `preview`, `format` |
| `inspect` | `server`, `container` | `format` |

Container/image names are validated; mutations show a preview.

## ssh_session — persistent shell

| action | needs | optional |
|---|---|---|
| `start` | `server` | returns `session_id` |
| `send` | `session_id`, `command` | `timeout`, `format` |
| `list` | — | `format` |
| `close` | `session_id` | |
| `replay` | `session_id` | `limit`, `format` |
| `memory` | `session_id` | `format` (inferred-state snapshot: cwd/env/exit) |

## ssh_net — tunnels + port probes

| action | needs | optional |
|---|---|---|
| `tunnel-open` | `server`, `tunnel_type` (`local`|`remote`|`dynamic`) | `bind`, `local_port`, `remote_host`, `remote_port`, `preview`, `format` |
| `tunnel-list` | — | `format` |
| `tunnel-close` | `tunnel_id` | |
| `port-test` | `server`, `target_host`, `target_port` | `probe_chain[]` (`dns`/`tcp`/`tls`/`http`), `timeout_ms_per_probe`, `continue_on_fail`, `format` |

## ssh_fleet — fleet + config metadata

`action` selects the entity; `op` selects the sub-operation (default `list`/`status`).

| action | op values | key params |
|---|---|---|
| `servers` | list | — |
| `groups` | list, add, remove, update | `name`, `members[]`, `description` |
| `aliases` | list, add, remove | `name`, `target` |
| `command_alias` | list, add, remove, suggest | `alias`, `command` (or search term for `suggest`) |
| `profiles` | list, show, update | `name` |
| `hooks` | list, update | `name` |
| `keys` | list, add, verify, accept, show | `server`, `host`, `port` |
| `history` | list | `limit`, `search` |
| `connections` | status, reconnect, disconnect, cleanup | `server` |

## ssh_plan — multi-step plan

| action | needs | optional |
|---|---|---|
| `run` | `steps[]` (ordered step objects; each dispatches to another tool) | `server` (plan default), `rollback_on_fail`, `format` |
| `approve` | `steps[]`, `approve_token` (any non-empty) | `server`, `rollback_on_fail`, `format` |

High-risk steps gate behind `approve`. Each step returns its own structured result; `rollback_on_fail` walks completed steps in reverse on failure.
