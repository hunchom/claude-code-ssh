# Changelog

All notable changes to MCP SSH Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.2] - 2026-02-09

### Fixed

- **Windows compatibility**: Replace `process.env.HOME` with `os.homedir()` for cross-platform support ([#8](https://github.com/bvisible/mcp-ssh-manager/issues/8))
  - `process.env.HOME` is undefined on Windows, causing crash at startup
  - Fixed in `src/ssh-key-manager.js`, `src/index.js`, `src/ssh-manager.js`

## [3.1.1] - 2025-11-15

### 🔧 Stability & Performance Release

This release fixes critical issues causing Claude Code to crash or freeze during MCP tool execution, particularly with large command outputs.

### Fixed

- **Claude Code crashes**: Automatic output truncation prevents context overflow
  - All stdout/stderr outputs now limited to 10,000 characters (configurable)
  - Clear truncation indicator showing how many characters were cut
  - Prevents "Interrupted: What should Claude do instead?" errors

- **Timeout issues**: Default timeout increased from 30s to 2 minutes
  - Maximum timeout raised to 5 minutes for long-running operations
  - Prevents premature command termination

- **Standardized error responses**: Consistent JSON error format
  - Better error handling and logging
  - Improved debugging information

### Added

- **Performance configuration** via environment variables:
  - `MCP_SSH_MAX_OUTPUT_LENGTH`: Control output truncation (default: 10000)
  - `MCP_SSH_DEFAULT_TIMEOUT`: Set default command timeout (default: 120000ms)
  - `MCP_SSH_MAX_TIMEOUT`: Set maximum timeout limit (default: 300000ms)
  - `MCP_SSH_COMPACT_JSON`: Enable compact JSON responses (default: false)
  - `MCP_SSH_DEBUG`: Enable debug information (default: false)
  - `MCP_SSH_CONNECTION_TIMEOUT`: Connection idle timeout (default: 1800000ms)
  - `MCP_SSH_KEEPALIVE_INTERVAL`: Keepalive packet interval (default: 60000ms)

- **New configuration module** (`src/config.js`):
  - Centralized configuration management
  - Helper functions: `truncateOutput()`, `formatJSONResponse()`
  - Environment variable parsing with defaults

- **Troubleshooting documentation**:
  - Complete guide in `docs/TROUBLESHOOTING.md`
  - Best practices for handling large outputs
  - Performance optimization tips
  - Debugging steps for common issues

### Changed

- Updated `.env.example` with new performance configuration options
- Enhanced README with troubleshooting section for Claude Code crashes
- Improved error logging with detailed context

### Documentation

- Added comprehensive troubleshooting guide
- Updated README with performance tuning section
- Added examples for handling large command outputs

## [3.0.0] - 2025-10-01

### 🎉 Major Release - Enterprise DevOps Features

This major release transforms MCP SSH Manager into a comprehensive DevOps automation platform with **12 new MCP tools** across three major feature areas.

### Added

#### Phase 1: Backup & Restore System (v2.1)
- **ssh_backup_create**: Create database or file backups with compression
  - Supports MySQL, PostgreSQL, MongoDB, and file system backups
  - Automatic gzip compression and metadata tracking
  - Configurable retention policies
  - Auto-creates backup directory if missing
- **ssh_backup_list**: List all available backups with detailed metadata
- **ssh_backup_restore**: Restore from previous backups with cross-database support
- **ssh_backup_schedule**: Schedule automatic backups using cron

#### Phase 2: Health Checks & Monitoring (v2.2)
- **ssh_health_check**: Comprehensive server health monitoring
  - CPU, Memory (RAM/Swap), Disk usage for all filesystems
  - Network statistics, system uptime, load average
  - Overall health status: healthy/warning/critical
- **ssh_service_status**: Monitor services (nginx, mysql, docker, etc.)
  - Supports systemd and sysv init systems
  - Returns running/stopped status with PID
- **ssh_process_manager**: Process management
  - List top processes sorted by CPU or memory
  - Kill processes with configurable signals
- **ssh_alert_setup**: Configure health monitoring alerts with custom thresholds

#### Phase 3: Database Management (v2.3)
- **ssh_db_dump**: Create database dumps (MySQL, PostgreSQL, MongoDB)
  - Gzip compression and selective table backups
- **ssh_db_import**: Import and restore databases
  - Auto-detection of compressed files
- **ssh_db_list**: List databases or tables/collections
  - Filters system databases automatically
- **ssh_db_query**: Execute read-only SQL queries
  - **Security**: Only SELECT queries allowed
  - Blocks DROP, DELETE, UPDATE, ALTER operations

### Fixed

- **ssh_service_status**: Fixed parsing bug where active services were incorrectly detected as "stopped"
  - Redirected systemctl output to /dev/null for clean status detection

### Improved

- **ssh_backup_create**: Auto-creates backup directory with error handling
  - Previously required manual creation of `/var/backups/ssh-manager`

### Documentation

- Added `docs/BACKUP_GUIDE.md` with comprehensive backup strategies
- Added `examples/backup-workflow.js` with 13 real-world examples
- Updated README.md and CLAUDE.md with all new tools

### Technical Details

- **New Modules**: backup-manager.js (469 lines), health-monitor.js (428 lines), database-manager.js (555 lines)
- **Total Lines Added**: ~4,100 lines of production code
- **Total Tools**: 37 MCP tools (25 existing + 12 new)
- **Supported Databases**: MySQL, PostgreSQL, MongoDB
- **Security**: SQL injection prevention, read-only query enforcement

### Breaking Changes

None. All existing tools remain fully compatible.

---

## [1.3.0] - 2025-09-04

### Added
- OpenAI Codex compatibility with TOML configuration support
- Enhanced documentation visibility for both Claude Code and Codex
- Dual configuration format support (.env and TOML)
- Badge system in README for platform compatibility

---

## [1.2.0] - 2025-08-12

### Added
- **ssh_deploy** tool for automated file deployment with permission handling
- **ssh_execute_sudo** tool for secure sudo command execution
- **ssh_alias** tool for managing server aliases
- Server alias support - use short names like "prod" instead of full server names
- Automatic permission detection for system directories
- Backup creation before file deployment
- Service restart capability after deployment
- Deployment helper functions for complex workflows
- Comprehensive deployment guide documentation
- Example deployment workflows

### Enhanced
- Connection resolution now supports aliases and partial matches
- Better error messages with available servers and aliases
- Secure sudo password handling (masked in logs)
- Support for batch file deployments

### Security
- Sudo passwords are never logged in plain text
- Automatic masking of sensitive information in command output
- Secure temporary file handling during deployments

## [1.1.0] - 2025-08-11

### Added
- Default directory configuration per server
- DEFAULT_DIR field in .env configuration
- Automatic working directory for commands

### Fixed
- Syntax error in index.js (extra parenthesis)

## [1.0.0] - 2025-08-10

### Initial Release
- Core SSH connection management
- ssh_execute tool for remote command execution
- ssh_upload tool for file uploads
- ssh_download tool for file downloads
- ssh_list_servers tool to list configured servers
- Password and SSH key authentication support
- Interactive server configuration tool
- Connection testing utility
- Pre-commit hooks for code quality
- GitHub Actions workflow for CI/CD