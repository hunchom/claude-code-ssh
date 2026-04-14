<h1 align="center">claude-code-ssh</h1>

<p align="center">
  <strong>Wire it. Type once. Every box answers.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-51-brightgreen?style=flat-square" alt="51 tools" />
  <img src="https://img.shields.io/badge/tests-538%20passing-brightgreen?style=flat-square" alt="538 tests" />
  <img src="https://img.shields.io/badge/mcp-server-orange?style=flat-square" alt="MCP server" />
  <img src="https://img.shields.io/badge/transport-stdio-blue?style=flat-square" alt="stdio" />
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square" alt="node 18+" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

<blockquote align="center">
<em>"Write programs that do one thing and do it well.<br/>
Write programs to work together."</em><br/>
&mdash; Doug McIlroy, <em>Unix Philosophy</em> (1978)
</blockquote>

---

**claude-code-ssh** gives Claude Code fifty-one focused SSH tools across your entire server fleet. One MCP server, stdio transport, connection-pooled &mdash; Claude executes commands, transfers files, queries databases, runs backups, monitors health, and deploys code without leaving the chat. Handlers live in `src/tools/` as small modules, output renders as ASCII tables with head+tail truncation to keep context lean, and every tool is gated by a per-user enablement config so you pay tokens only for what you use.

| Component       | Stack |
|-----------------|---|
| **Server**      | Node 18+, `@modelcontextprotocol/sdk`, stdio transport |
| **SSH**         | `ssh2` &mdash; connection pooling, auto-reconnect, 30m idle timeout |
| **Tools**       | 51 handlers, 17 modular files under `src/tools/` |
| **Config**      | `.env` (Claude Code) or TOML (OpenAI Codex) &mdash; auto-detected |
| **Profiles**    | project-type templates (default, devops, database, security, deployment) |
| **Auth**        | SSH keys, passwords, passphrase keys, `ssh-agent`, ProxyJump/bastion chains |
| **Safety**      | sudo via stdin (never argv), DB passwords via env var, SQL read-only parser, `shQuote` shell escape |
| **Output**      | ASCII markdown tables, `[info]`/`[warn]`/`[err]` tagged stderr logs |
| **Tests**       | 538 across 26 suites &mdash; `npm test` |

> [!NOTE]
> **Tool enablement is per-user.** `ssh-manager tools configure` picks groups. Minimal mode = 5 core tools (~3.5k tokens). All mode = 51 tools (~43k tokens). Custom mode = whatever you want.

## Tool groups

Gated by `src/tool-config-manager.js` against `~/.ssh-manager/tools-config.json`. Disable a group and its tools vanish from the MCP advertisement entirely &mdash; Claude never sees them, the context stays tight.

| Group          | Count | Purpose                                                   |
|----------------|------:|-----------------------------------------------------------|
| **core**       |     5 | execute, upload, download, list servers, default dirs     |
| **sessions**   |     4 | persistent shells via marker-prompt protocol              |
| **monitoring** |     6 | health, services, processes, alerts, tail, system resources |
| **backup**     |     4 | create/list/restore/schedule for MySQL, PostgreSQL, Mongo, files |
| **database**   |     4 | dump, import, list, read-only SELECT (SQL token-parser validated) |
| **advanced**   |    14 | tunnels, keys, sync, deploy, hooks, profiles, groups, aliases |
| **gamechanger**|    14 | cat, diff, edit, docker, journalctl, port-test, deploy-artifact, plan, tail-3, session-v2 |

## Quick start

```bash
npm install
cp .env.example .env          # add your SSH servers
claude mcp add ssh-manager node "$(pwd)/src/index.js"
```

Then, from Claude Code:

```
run uptime on prod01
tail /var/log/nginx/error.log on prod01
deploy ./build to prod01:/var/www/app with atomic rollback
```

## Config

**`.env`** (Claude Code):

```
SSH_SERVER_PROD01_HOST=10.0.0.10
SSH_SERVER_PROD01_USER=deploy
SSH_SERVER_PROD01_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_PROD01_DEFAULT_DIR=/var/www/app
SSH_SERVER_PROD01_PROXYJUMP=bastion      # optional, chains through another server
```

**TOML** (OpenAI Codex, `~/.codex/ssh-config.toml`):

```toml
[ssh_servers.prod01]
host = "10.0.0.10"
user = "deploy"
key_path = "~/.ssh/id_ed25519"
default_dir = "/var/www/app"
proxy_jump = "bastion"
```

## Directory layout

```
claude-code-ssh/
├── src/
│   ├── index.js                ← MCP server, 51 tool registrations
│   ├── tools/                  ← 17 modular handler files
│   ├── tool-registry.js        ← tool metadata + group membership
│   ├── tool-config-manager.js  ← per-user enablement
│   ├── logger.js               ← [info]/[warn]/[err] tagged stderr + file log
│   ├── output-formatter.js     ← ASCII tables, head+tail truncation
│   ├── stream-exec.js          ← streaming SSH exec with backpressure
│   └── profile-loader.js       ← project-type profile resolution
├── cli/ssh-manager             ← bash CLI (config, tools, codex setup)
├── tests/                      ← 538 tests, 26 suites
├── profiles/                   ← default, devops, database, security, deployment
├── tools/                      ← Python setup + connection test utilities
├── scripts/validate.sh         ← pre-commit syntax + startup check
└── docs/                       ← TOOL_MANAGEMENT, QUICKSTART, INSTALLATION
```

## Security

> [!CAUTION]
> **Never commit `.env`.** Already in `.gitignore` &mdash; keep it that way.
> Prefer SSH keys over passwords. Store `SUDO_PASSWORD` separately from `PASSWORD`.
> Sudo passwords pipe via stdin, never argv. DB passwords travel via env var (`MYSQL_PWD`, `PGPASSWORD`, connection URI), never on the command line.

Pre-commit hooks (`./scripts/setup-hooks.sh`) scan for leaked secrets before push. SHA256:base64-nopad fingerprints replace TOFU regex. The SQL query tool uses a token-level parser to reject anything that isn't a read-only SELECT.

## License

MIT.
