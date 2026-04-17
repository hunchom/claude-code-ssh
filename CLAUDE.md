# CLAUDE.md

This file provides guidance to Claude Code when working on this repository.

## Project Overview

**claude-code-ssh** is an MCP server that gives Claude Code direct SSH access to a configured fleet of servers. The goal: Claude stops being a read-only assistant and becomes a hands-on operator — reading logs, editing configs, running backups, deploying, debugging — without a human typing commands between them.

51 tools, 7 groups, opt-in per user. Connection pooling, streaming exec, head+tail output truncation, ASCII-only rendering.

## Architecture

- **`src/index.js`** — MCP server entry, registers all 51 tools via `registerToolConditional()`
- **`src/tools/*.js`** — 17 modular handler files, one per logical tool area (exec, files, backup, db, etc.)
- **`src/tool-registry.js`** — tool metadata + group membership (core, sessions, monitoring, backup, database, advanced, gamechanger)
- **`src/tool-config-manager.js`** — per-user enablement via `~/.ssh-manager/tools-config.json`
- **`src/stream-exec.js`** — streaming SSH exec with backpressure and UTF-8 boundary-safe chunking
- **`src/output-formatter.js`** — ASCII markdown tables with head+tail truncation
- **`src/logger.js`** — `[info]/[warn]/[err]/[dbg]` tagged stderr + file log
- **`src/profile-loader.js`** — project-type profiles (default, devops, database, security, deployment)
- **`cli/ssh-manager`** — bash CLI for server/tool/codex management

## Commands

### Setup
```bash
npm install
./scripts/setup-hooks.sh         # optional: pre-commit hooks
```

### Server Management (Bash CLI)
```bash
ssh-manager server add                        # Add a new server
ssh-manager server list                       # List configured servers
ssh-manager server test SERVER                # Test connection to specific server
ssh-manager server remove SERVER              # Remove a server
ssh-manager server show SERVER                # Show server details
```

### OpenAI Codex Integration
```bash
ssh-manager codex setup                       # Configure for Codex
ssh-manager codex migrate                     # Convert servers to TOML
ssh-manager codex test                        # Test Codex integration
ssh-manager codex convert to-toml            # Convert .env to TOML
ssh-manager codex convert to-env             # Convert TOML to .env
```

### Tool Management (NEW in v3.1)
```bash
ssh-manager tools list                        # Show all tools and status
ssh-manager tools configure                   # Interactive configuration wizard
ssh-manager tools enable <group>              # Enable a tool group
ssh-manager tools disable <group>             # Disable a tool group
ssh-manager tools reset                       # Reset to defaults (all tools)
ssh-manager tools export-claude               # Export auto-approval config
```

**Tool Groups**: core (5), sessions (4), monitoring (6), backup (4), database (4), advanced (14)

**Modes**: all (37 tools, ~43.5k tokens), minimal (5 tools, ~3.5k tokens), custom (variable)

See [docs/TOOL_MANAGEMENT.md](docs/TOOL_MANAGEMENT.md) for complete guide.

### Development and Testing
```bash
npm start                    # Start MCP server (requires stdin)
npm test                     # Run 551 tests across 26 suites
./scripts/validate.sh        # Syntax + startup check
node --check src/index.js    # JavaScript syntax only
```

### Debug Tools
```bash
./debug/test-claude-code.sh  # Test Claude Code integration
node debug/test-mcp.js       # Test MCP connection
node debug/test-ssh-command.js  # Test SSH command execution
```

## MCP Tools Available

The server exposes these tools to Claude Code and OpenAI Codex:

### Core Tools
- `ssh_list_servers`: List all configured SSH servers
- `ssh_execute`: Execute commands on remote servers (supports default directories)
- `ssh_upload`: Upload files to remote servers
- `ssh_download`: Download files from remote servers

### Backup & Restore (v2.1+)
- `ssh_backup_create`: Create database or file backups (MySQL, PostgreSQL, MongoDB, Files)
- `ssh_backup_list`: List all available backups with metadata
- `ssh_backup_restore`: Restore from previous backups
- `ssh_backup_schedule`: Schedule automatic backups using cron

### Health & Monitoring (v2.2+)
- `ssh_health_check`: Comprehensive server health check (CPU, RAM, Disk, Network)
- `ssh_service_status`: Check status of services (nginx, mysql, docker, etc.)
- `ssh_process_manager`: List, monitor, or kill processes
- `ssh_alert_setup`: Configure CPU/memory/disk thresholds per server; `check` action compares live metrics to thresholds

### Database Management (v2.3+)
- `ssh_db_dump`: Create database dumps (MySQL, PostgreSQL, MongoDB)
- `ssh_db_import`: Import SQL dumps or restore databases
- `ssh_db_list`: List databases or tables/collections
- `ssh_db_query`: Execute read-only SELECT queries (security validated)

### Deployment & Management
- `ssh_deploy`: Deploy files with automatic permission/backup handling
- `ssh_execute_sudo`: Execute commands with sudo privileges
- `ssh_alias`: Manage server aliases (add/remove/list)
- `ssh_sync`: Bidirectional file synchronization with rsync
- `ssh_monitor`: System resource monitoring
- `ssh_tail`: Real-time log monitoring

### Advanced Features
- `ssh_session_*`: Persistent SSH sessions
- `ssh_tunnel_*`: SSH tunnel management (local/remote/SOCKS)
- `ssh_group_*`: Server group operations
- `ssh_command_alias`: Command alias management
- `ssh_hooks`: Automation hooks
- `ssh_profile`: Profile management

## Server Configuration

### Configuration Formats

claude-code-ssh supports two configuration formats:

1. **Environment Variables (.env)** - Traditional format for Claude Code
2. **TOML** - Modern format for OpenAI Codex

### Configuration Loading Priority

The system loads configurations in this order (highest to lowest priority):
1. Environment variables (process.env)
2. `.env` file in project root
3. TOML file (specified by SSH_CONFIG_PATH or ~/.codex/ssh-config.toml)

### .env Format
```
SSH_SERVER_[NAME]_HOST=hostname
SSH_SERVER_[NAME]_USER=username
SSH_SERVER_[NAME]_PASSWORD=password         # For password auth
SSH_SERVER_[NAME]_KEYPATH=~/.ssh/key       # For SSH key auth
SSH_SERVER_[NAME]_PASSPHRASE=passphrase    # Optional, for passphrase-protected keys
SSH_SERVER_[NAME]_PORT=22                  # Optional
SSH_SERVER_[NAME]_DEFAULT_DIR=/path        # Optional default working directory
SSH_SERVER_[NAME]_SUDO_PASSWORD=pass       # Optional for automated sudo
SSH_SERVER_[NAME]_PLATFORM=windows         # Optional: "linux" (default) or "windows"
SSH_SERVER_[NAME]_PROXYJUMP=bastion        # Optional: name of another server to use as jump host
```

### TOML Format
```toml
[ssh_servers.name]
host = "hostname"
user = "username"
password = "password"                      # For password auth
key_path = "~/.ssh/key"                    # For SSH key auth
passphrase = "key_passphrase"              # Optional, for passphrase-protected keys
port = 22                                  # Optional
default_dir = "/path"                      # Optional default working directory
sudo_password = "pass"                     # Optional for automated sudo
platform = "windows"                       # Optional: "linux" (default) or "windows"
proxy_jump = "bastion"                     # Optional: name of another server to use as jump host
```

## Key Implementation Details

1. **Connection Pooling**: The server maintains persistent SSH connections in a Map to avoid reconnection overhead (src/index.js:31)

2. **Server Resolution**: Server names are resolved through aliases first, then direct lookup. Names are normalized to lowercase (src/index.js:54-68)

3. **Default Directories**: If a server has a DEFAULT_DIR configured and no cwd is provided to ssh_execute, commands run in that directory

4. **Deployment Strategy**: The deploy helper detects permission issues and automatically creates scripts for sudo execution when needed

5. **Environment Loading**: Uses dotenv to load configuration from `.env` file in project root

## Security Considerations

- Never commit `.env` files (included in .gitignore)
- SSH keys preferred over passwords
- Sudo passwords stored separately from regular passwords
- Connection errors logged to stderr for debugging
- Pre-commit hooks check for sensitive data leaks

## Validation and Quality

Run `./scripts/validate.sh` before commits to check:
- JavaScript syntax validity
- Python syntax validity
- No `.env` file in git
- MCP server startup
- Dependencies installed

## Claude Code Integration

To install in Claude Code:
```bash
claude mcp add ssh-manager node /absolute/path/to/claude-code-ssh/src/index.js
```

Configuration is stored in `~/.config/claude-code/claude_code_config.json`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claude-code-ssh** (1326 symbols, 3627 relationships, 110 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/claude-code-ssh/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/claude-code-ssh/context` | Codebase overview, check index freshness |
| `gitnexus://repo/claude-code-ssh/clusters` | All functional areas |
| `gitnexus://repo/claude-code-ssh/processes` | All execution flows |
| `gitnexus://repo/claude-code-ssh/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
