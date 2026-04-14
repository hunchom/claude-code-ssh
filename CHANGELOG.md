# Changelog

All notable changes to claude-code-ssh will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- 14 new "gamechanger" tools: `cat`, `diff`, `edit`, `docker`, `journalctl`, `port-test`, `systemctl`, `tail-3`, `session-v2`, `deploy-artifact`, `plan`
- Modular handler architecture — each tool group in its own file under `src/tools/`
- Comprehensive test suite: 551 tests across 26 suites
- Streaming command execution with backpressure (`src/stream-exec.js`)
- ASCII-only output (no emoji/Unicode) — clean tables, `[info]/[warn]/[err]` tagged logs
- Startup banner with profile, servers, tool count, and pool status

### Changed
- Output renders as plain ASCII markdown tables with head+tail truncation
- Logger uses 6-char fixed-width level tags for column alignment
- Tool registration gated by per-user enablement (`~/.ssh-manager/tools-config.json`)

### Security
- Sudo passwords pipe via stdin (never argv)
- DB passwords via env var (`MYSQL_PWD`, `PGPASSWORD`, connection URI)
- SHA256:base64-nopad host fingerprints
- Token-level SQL parser rejects anything but read-only SELECT
