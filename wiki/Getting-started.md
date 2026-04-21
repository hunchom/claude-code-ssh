# Getting started

Five minutes from zero to Claude running commands on your first host.

## Prerequisites

| | |
|---|---|
| Node.js | 20.19 or newer (use `.nvmrc`) |
| npm | bundled with Node |
| Claude Code (or OpenAI Codex) | installed and authenticated |
| SSH access | to at least one host you want to manage |

## Step 1 — Clone and install

```bash
git clone https://github.com/hunchom/claude-code-ssh
cd claude-code-ssh
npm install
```

## Step 2 — Add your first server

Interactive (recommended for first time):

```bash
./cli/ssh-manager server add
```

You'll be prompted for a name, host, user, and auth method (key or password). The CLI writes to `.env` in the repo root.

Manual (`.env`):

```env
SSH_SERVER_PROD01_HOST=10.0.0.10
SSH_SERVER_PROD01_USER=deploy
SSH_SERVER_PROD01_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_PROD01_DEFAULT_DIR=/var/www/app
```

Manual (TOML, for OpenAI Codex — `~/.codex/ssh-config.toml`):

```toml
[ssh_servers.prod01]
host = "10.0.0.10"
user = "deploy"
key_path = "~/.ssh/id_ed25519"
default_dir = "/var/www/app"
```

## Step 3 — Test the connection

```bash
./cli/ssh-manager server test prod01
```

Expected output:

```
[info  ] connecting to prod01 (10.0.0.10:22)
[info  ] auth: publickey (id_ed25519)
[info  ] connected in 184ms
[info  ] host fingerprint: SHA256:abc123... (recorded)
[ok    ] prod01 reachable
```

> [!WARNING]
> If you see `host fingerprint mismatch`, the remote key has changed since you last connected. Verify out-of-band before overriding.

## Step 4 — Wire into Claude Code

```bash
claude mcp add ssh-manager node "$(pwd)/src/index.js"
```

Confirm registration:

```bash
claude mcp list
```

Should print `ssh-manager` among your MCP servers.

## Step 5 — First success

Open Claude Code and ask:

```
list my ssh servers
```

Claude invokes `ssh_list_servers` and replies with a table of your configured hosts. Then try:

```
what's the uptime and disk usage on prod01
```

Claude invokes `ssh_health_check` and returns CPU, RAM, disk, and uptime — all one pooled connection, head+tail truncated.

```mermaid
sequenceDiagram
  participant You
  participant Claude
  participant MCP as claude-code-ssh
  participant Pool as ssh2 pool
  participant Host as prod01
  You->>Claude: "health check prod01"
  Claude->>MCP: ssh_health_check(server=prod01)
  MCP->>Pool: get connection for prod01
  Pool->>Host: SSH connect (keeps alive)
  Host-->>Pool: ready
  MCP->>Host: uptime; free -m; df -h
  Host-->>MCP: outputs
  MCP-->>Claude: ASCII table, head+tail truncated
  Claude-->>You: "prod01: 2% CPU, 4.2G/8G RAM, 34% disk on /"
```

## Next steps

- **Add more hosts and bastions** — [Configuration](Configuration) covers proxy jumps, passphrase-protected keys, Windows hosts, and per-server `default_dir`.
- **Restrict tool surface** — If you only use a subset, turn others off: `ssh-manager tools disable database`. Fewer tokens per turn. [Tool reference](Tool-reference) has the group list.
- **Understand the safety model** — Before pointing this at production, skim [Security model](Security-model).

> [!TIP]
> The log file `~/.ssh-manager.log` records every connection attempt and command. Run with `SSH_LOG_LEVEL=DEBUG` to capture full tool I/O for troubleshooting.
