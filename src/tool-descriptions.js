/**
 * v4 tool descriptions -- single source of truth.
 *
 * Each entry cues WHEN to use the tool and names the raw bash it replaces, so
 * the loaded schema steers Claude onto these tools instead of `ssh` via Bash.
 * src/index.js imports this; the v4 registration block uses these strings as
 * each tool's `description`. Edit text here, never inline in index.js.
 */
export const V4_TOOL_DESCRIPTIONS = Object.freeze({
  ssh_run:
    'Run commands on a configured server. Use instead of `ssh host "cmd"` '
    + '-- a `script` action chains `cmd1; cmd2; cmd3` in one round trip with '
    + 'per-segment exit codes, the pooled connection skips the per-call SSH '
    + 'handshake, and output is capped so a noisy command will not flood '
    + 'context. Actions: exec, sudo, script, fleet, detach, job-status, job-kill.',
  ssh_file:
    'Move and edit files on a configured server. Use instead of '
    + '`scp local host:remote` or `ssh host "cat > f <<EOF ..."` -- SFTP '
    + 'transfer with sha256 verification, write/edit with no heredoc or '
    + 'shell-quoting hazard, deploy with structured before/after results. '
    + 'Actions: upload, download, sync, read, write, edit, diff, deploy, '
    + 'deploy-artifact.',
  ssh_find:
    'Search files on a configured server. Use instead of a blind '
    + '`ssh host "grep -rn PATTERN /"` -- a server-side timeout and match cap '
    + 'stop the walk early, /proc /sys /dev and .git are pruned, and hits come '
    + 'back as structured file/line/text rows instead of an unbounded dump. '
    + 'Actions: grep, locate, ls.',
  ssh_logs:
    'Read remote logs. Use instead of `ssh host journalctl` or `ssh host tail '
    + '-f file` -- output is capped and grep-filtered so it will not flood '
    + 'context, and follow sessions resume from a cursor instead of '
    + 're-streaming. Actions: tail, follow-start, follow-read, follow-stop, '
    + 'journal.',
  ssh_service:
    'Manage systemd services on a configured server. Use instead of '
    + '`ssh host systemctl status nginx` -- returns a structured snapshot '
    + '(ActiveState, SubState, recent log lines) over the pooled connection '
    + 'rather than a raw terminal page. Actions: status, start, stop, restart, '
    + 'enable, disable.',
  ssh_health:
    'Inspect server health. Use instead of stitching `ssh host top`, '
    + '`ssh host df -h`, and `ssh host free -m` together -- one call returns a '
    + 'structured cpu/memory/disk/process snapshot, with at-capacity rows '
    + 'sorted to the top so the incident is visible first. Actions: check, '
    + 'watch, procs, alerts.',
  ssh_db:
    'Query and manage databases on a configured server. Use instead of '
    + '`ssh host "mysql -e ..."` -- credentials go through env not argv, '
    + 'SELECT queries pass a token-level safety check, and rows render as a '
    + 'bounded aligned table. Actions: query, list, dump, import.',
  ssh_backup:
    'Create, list, and restore backups on a configured server. Use instead of '
    + 'hand-rolled `ssh host "tar czf ..."` or `mysqldump` one-liners -- '
    + 'content-addressed with sha256 verification, a metadata sidecar, and a '
    + 'high-risk preview with structured result before any restore. Actions: '
    + 'create, list, restore, schedule.',
  ssh_session:
    'Drive a persistent shell on a configured server. Use instead of repeated '
    + '`ssh host "cmd"` calls when shell state must persist -- one pooled '
    + 'session keeps cwd, env, and exit code across commands, with replay and '
    + 'an inferred-state snapshot. Actions: start, send, list, close, replay, '
    + 'memory.',
  ssh_net:
    'Manage SSH tunnels and probe ports on a configured server. Use instead of '
    + '`ssh -L`, `ssh -R`, or `ssh -D` plus a manual `nc -z` reachability '
    + 'check -- tunnels are tracked with typed state and port-test runs a '
    + 'structured DNS to TCP to TLS chain. Actions: tunnel-open, tunnel-list, '
    + 'tunnel-close, port-test.',
  ssh_docker:
    'Drive Docker on a configured server. Use instead of '
    + '`ssh host "docker ps"` / `docker logs` / `docker exec` -- container and '
    + 'image names are validated, mutations show a preview, and `ps` / `logs` '
    + 'output is capped so a busy host will not flood context. Actions: ps, '
    + 'logs, exec, restart, inspect.',
  ssh_fleet:
    'Inspect fleet and connection metadata. Use instead of `ssh -G hostname` '
    + 'or hand-grepping ~/.ssh/config -- lists configured servers, '
    + 'groups, aliases, profiles, hooks, keys, history, and live pooled '
    + 'connections as structured tables. Actions: servers, groups, aliases, '
    + 'command_alias, profiles, hooks, keys, history, connections.',
  ssh_plan:
    'Run a declarative multi-step plan across configured servers. Use instead '
    + 'of a hand-sequenced batch of `ssh host cmd` calls -- steps dispatch to '
    + 'the other v4 tools, high-risk steps gate behind an approve token, and '
    + 'each step returns a structured result. Actions: run, approve.',
});
