# Changelog

All notable changes to claude-code-ssh will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.2] - 2026-04-14

### Security
- Host key verifier now SHA256-hashes the presented key and compares against known_hosts entries with padding normalization. Previously, known hosts were accepted without fingerprint comparison (MITM vulnerability). Unknown hosts still default to TOFU; `SSH_STRICT_HOSTS=1` rejects unknown hosts.
- `cwd` argument in the legacy `execCommand` path is now shell-quoted, closing a shell-injection vector.
- SFTP channels are now closed in a `finally` block — prior leak could exhaust the SFTP subsystem after repeated uploads/downloads.
- Bad-regex crash in tail filtering is now caught and surfaced as a user-facing error instead of crashing the server.

### Fixed
- `SSHManager.exec` passthrough — `ssh_execute`, `ssh_health_check`, `ssh_db_*`, `ssh_deploy`, `ssh_journalctl`, `ssh_systemctl`, `ssh_tail`, `ssh_cat` were failing at runtime with "client.exec is not a function" despite unit tests passing against a mock.
- `SSHManager.sftp` + dual-mode `forwardOut` passthroughs — fixes `ssh_upload`, `ssh_download`, `ssh_deploy`, `ssh_tunnel_create`, and proxy-jump chains.
- `SSHManager.shell` passthrough — `ssh_session_start` was crashing with "client.shell is not a function".
- 13 tool schemas aligned with handler parameters: `ssh_cat`, `ssh_port_test`, `ssh_diff`, `ssh_edit`, `ssh_tail`, `ssh_monitor`, `ssh_health_check`, `ssh_service_status`, `ssh_journalctl`, `ssh_docker`, `ssh_tail_start`, `ssh_tail_read`, `ssh_session_memory`. Ghost fields removed, snake_case normalized.
- `ssh_systemctl` schema pruned: `is-active` / `is-enabled` removed (handler rejected them); `list-unit-files`, `pattern`, `use_sudo` added.
- Tool registry corrected — now reports the full 51 tools across 7 groups (previously listed 37 across 6). Enables per-group disable for the `gamechanger` tools.

### Changed
- CI workflow bumped to `actions/checkout@v5` and `actions/setup-node@v5` (silences Node 20 deprecation warnings).
- ESLint `max-warnings` raised to 150; 660 formatting issues auto-fixed in one pass.
- Internal: SFTP cache handle renamed `_sftpHandle` to avoid shadowing the new `sftp()` method.

## [3.2.1] - 2026-04-13

### Added
- 14 "gamechanger" tools: `cat`, `diff`, `edit`, `docker`, `journalctl`, `port-test`, `systemctl`, `tail-3`, `session-v2`, `deploy-artifact`, `plan`
- Modular handler architecture — each tool group in its own file under `src/tools/`
- Streaming command execution with backpressure (`src/stream-exec.js`)
- ASCII-only output — plain markdown tables with head+tail truncation, `[info]/[warn]/[err]` tagged logs
- Startup banner with profile, servers, tool count, and pool status

### Changed
- Logger uses 6-char fixed-width level tags for column alignment
- Tool registration gated by per-user enablement (`~/.ssh-manager/tools-config.json`)

### Security
- Sudo passwords pipe via stdin (never argv)
- DB passwords via env var (`MYSQL_PWD`, `PGPASSWORD`, connection URI)
- Token-level SQL parser rejects anything but read-only SELECT

[Unreleased]: https://github.com/hunchom/claude-code-ssh/compare/v3.2.2...HEAD
[3.2.2]: https://github.com/hunchom/claude-code-ssh/compare/v3.2.1...v3.2.2
[3.2.1]: https://github.com/hunchom/claude-code-ssh/releases/tag/v3.2.1
