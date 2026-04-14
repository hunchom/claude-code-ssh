<p align="center">
  <img src="assets/repo-image.png" alt="claude-code-ssh" width="600" />
</p>

<h1 align="center">claude-code-ssh</h1>

<p align="center">
Stop being the middleman between Claude and your servers.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-51-brightgreen?style=flat-square" alt="51 tools" />
  <img src="https://img.shields.io/badge/tests-551%20passing-brightgreen?style=flat-square" alt="551 tests" />
  <img src="https://img.shields.io/badge/mcp-server-orange?style=flat-square" alt="MCP server" />
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square" alt="node 18+" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

## Why

Right now, working with Claude on a production problem looks like this:

1. You describe the bug
2. Claude asks what the logs say
3. You SSH in, tail the log, copy the output
4. Paste it back to Claude
5. Claude asks what the config looks like
6. You `cat` it, paste it back
7. Claude suggests a fix
8. You SSH in again, apply it, restart the service
9. You tell Claude whether it worked

You're the keyboard. You're doing the typing-and-pasting shuttle for an AI that could just do it itself.

**claude-code-ssh gets you out of the loop.** Claude reaches into your servers directly, sees what it needs, changes what it needs, and reports back. You describe the outcome you want. Claude does the work.

## What changes

**Debugging production is a conversation, not a shell race.** "nginx is 502-ing on prod01" — Claude pulls the journal, checks the upstream config, spots the timeout, fixes it. You didn't touch a terminal.

**Fleet operations collapse into one sentence.** "Roll out this config to every web server, one at a time, pause if any fail healthcheck." Done. No Ansible playbook, no tmux panes, no for-loop bash one-liners.

**Claude has context the whole time.** It sees the actual log output, not your summary of it. It reads the real config, not what you remember it looking like. When it proposes a fix, it's grounded in what's actually running.

**You stop context-switching between terminal tabs and chat.** One surface. One conversation. The work gets done in the same thread you're thinking in.

## What it is

An MCP server. Claude Code connects to it, it connects to your SSH hosts. 51 tools under the hood — shell, files, databases, backups, deploys, tunnels, sessions — but you never think about which tool; Claude picks them.

Connections pool so reconnects don't cost seconds. Output gets truncated head+tail so long logs don't blow your context window. Tools are opt-in per group so you only pay for what you use (5-tool minimal mode is ~3.5k tokens, full mode is ~43k).

## Install

```bash
git clone https://github.com/hunchom/claude-code-ssh
cd claude-code-ssh
npm install
cp .env.example .env       # add your servers
claude mcp add ssh-manager node "$(pwd)/src/index.js"
```

## Configure

`.env` for Claude Code:

```
SSH_SERVER_PROD01_HOST=10.0.0.10
SSH_SERVER_PROD01_USER=deploy
SSH_SERVER_PROD01_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_PROD01_DEFAULT_DIR=/var/www/app
SSH_SERVER_PROD01_PROXYJUMP=bastion
```

TOML for Codex (`~/.codex/ssh-config.toml`):

```toml
[ssh_servers.prod01]
host = "10.0.0.10"
user = "deploy"
key_path = "~/.ssh/id_ed25519"
default_dir = "/var/www/app"
proxy_jump = "bastion"
```

## Ask Claude things like

```
why is prod01 returning 502s
show me disk usage on every web server
nginx config on prod02 is rejecting the /api/ route, find and fix it
back up the payments db, download the dump, then restore it to staging
deploy ./build to prod01:/var/www/app, atomic, rollback on healthcheck fail
open a tunnel to the internal grafana through bastion
tail the last 500 lines of journalctl for docker on prod03
```

You're not picking tools. You're describing outcomes.

## Safety

Prod access deserves care. This server doesn't hand Claude a raw shell — every tool is narrow and auditable:

- **Sudo passwords** go in via stdin, never argv — they can't leak into process listings
- **DB passwords** travel through env vars (`MYSQL_PWD`, `PGPASSWORD`, connection URIs), never on the command line
- **The query tool** uses a token-level SQL parser that rejects anything but read-only SELECTs — Claude can't `DROP TABLE` by accident
- **Host fingerprints** use SHA256, no TOFU regex — MITM resistant by default
- **ProxyJump/bastion** chains work transparently, so you don't have to punch holes in your network

Pre-commit hooks scan for leaked secrets before push. Every SSH connection pools and times out after 30min idle. Every tool group can be disabled per-project, so dev environments don't see prod tooling.

## Tool groups

| Group | Count | What it covers |
|---|---:|---|
| core | 5 | execute, upload, download, list, health |
| sessions | 4 | persistent shells that survive between turns |
| monitoring | 6 | services, processes, logs, alerts |
| backup | 4 | dump / list / restore / schedule |
| database | 4 | dump, import, list, read-only query |
| advanced | 14 | tunnels, keys, sync, deploy, hooks |
| gamechanger | 14 | cat, diff, edit, docker, journalctl, port-test |

`ssh-manager tools configure` lets you pick which groups load.

## Testing

```bash
npm test       # 551 tests across 26 suites
```

## Layout

```
src/
  index.js                 MCP server + tool registration
  tools/                   17 modular handler files
  tool-registry.js         group metadata
  tool-config-manager.js   per-user enablement
  logger.js                [info]/[warn]/[err] tagged stderr
  stream-exec.js           streaming exec with backpressure
cli/ssh-manager            bash CLI
tests/                     test suites
profiles/                  project templates
docs/                      tool management docs
```

## License

MIT.
