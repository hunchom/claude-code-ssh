<p align="center">
  <img src="assets/repo-image.png" alt="claude-code-ssh" width="600" />
</p>

<h1 align="center">claude-code-ssh</h1>

<p align="center">
MCP server for SSH. Gives Claude Code 51 tools to run commands, move files, manage databases, and deploy across your servers.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-51-brightgreen?style=flat-square" alt="51 tools" />
  <img src="https://img.shields.io/badge/tests-551%20passing-brightgreen?style=flat-square" alt="551 tests" />
  <img src="https://img.shields.io/badge/mcp-server-orange?style=flat-square" alt="MCP server" />
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square" alt="node 18+" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

## What it does

Adds an MCP server to Claude Code (or OpenAI Codex) that connects to your SSH hosts. Claude can then:

- run shell commands, sudo, or grouped commands across servers
- upload, download, and rsync files
- create and restore MySQL / Postgres / Mongo / file backups
- tail logs, check health, inspect services and processes
- dump / import / query databases (read-only SELECT only)
- deploy artifacts with atomic rollback
- open SSH tunnels, manage keys, run persistent sessions

Connections pool automatically, output gets truncated at head+tail, and tools are opt-in per group so you don't pay for what you don't use.

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

## Tool groups

| Group | Count | Purpose |
|---|---:|---|
| core | 5 | execute, upload, download, list, health |
| sessions | 4 | persistent shells |
| monitoring | 6 | services, processes, tail, alerts |
| backup | 4 | create / list / restore / schedule |
| database | 4 | dump, import, list, query |
| advanced | 14 | tunnels, keys, sync, deploy, hooks |
| gamechanger | 14 | cat, diff, edit, docker, journalctl, port-test |

Pick groups with `ssh-manager tools configure`. Minimal mode loads 5 core tools (~3.5k tokens), all mode loads everything (~43k tokens).

## Usage

From Claude Code:

```
run uptime on prod01
tail /var/log/nginx/error.log on prod01
deploy ./build to prod01:/var/www/app with atomic rollback
```

## Auth

SSH keys, passwords, passphrase-protected keys, `ssh-agent`, ProxyJump bastion chains.

- Sudo passwords piped via stdin, never argv
- DB passwords via env var (`MYSQL_PWD`, `PGPASSWORD`, connection URI)
- SHA256 host fingerprints (no TOFU)
- Token-level SQL parser blocks anything but read-only SELECT

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
