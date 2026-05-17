#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import SSHManager from './ssh-manager.js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { configLoader } from './config-loader.js';
import {
  getTempFilename,
  buildDeploymentStrategy,
  detectDeploymentNeeds
} from './deploy-helper.js';
import {
  resolveServerName,
  addAlias,
  removeAlias,
  listAliases
} from './server-aliases.js';
import {
  expandCommandAlias,
  addCommandAlias,
  removeCommandAlias,
  listCommandAliases,
  suggestAliases
} from './command-aliases.js';
import {
  initializeHooks,
  executeHook,
  toggleHook,
  listHooks
} from './hooks-system.js';
import {
  loadProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfileName
} from './profile-loader.js';
import { logger } from './logger.js';
import {
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addServersToGroup,
  removeServersFromGroup,
  listGroups
} from './server-groups.js';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.js';
import { withAnnotations } from './tool-annotations.js';

// Modularized tool handlers (src/tools/*.js) -- 10/10 "gamechanger" versions
import { handleSshExecute, handleSshExecuteSudo, handleSshExecuteGroup } from './tools/exec-tools.js';
import { handleSshUpload, handleSshDownload, handleSshSync, handleSshDiff, handleSshEdit } from './tools/transfer-tools.js';
import { handleSshTail, handleSshTailStart, handleSshTailRead, handleSshTailStop } from './tools/tail-tools.js';
import { handleSshHealthCheck, handleSshMonitor, handleSshServiceStatus, handleSshProcessManager } from './tools/monitoring-tools.js';
import { handleSshAlertSetup } from './tools/alerts-tools.js';
import { handleSshDbQuery, handleSshDbList, handleSshDbDump, handleSshDbImport } from './tools/db-tools.js';
import { handleSshBackupCreate, handleSshBackupList, handleSshBackupRestore, handleSshBackupSchedule } from './tools/backup-tools.js';
import { handleSshDeploy } from './tools/deploy-tools.js';
import {
  handleSshSessionStart as handleSshSessionStartNew,
  handleSshSessionSend as handleSshSessionSendNew,
  handleSshSessionList as handleSshSessionListNew,
  handleSshSessionClose as handleSshSessionCloseNew,
  handleSshSessionReplay,
  handleSshSessionMemory,
} from './tools/session-tools.js';
import { handleSshTunnelCreate, handleSshTunnelList, handleSshTunnelClose } from './tools/tunnel-tools.js';
import { handleSshKeyManage } from './tools/key-tools.js';
import { handleSshCat } from './tools/cat-tools.js';
import { handleSshSystemctl } from './tools/systemctl-tools.js';
import { handleSshJournalctl } from './tools/journalctl-tools.js';
import { handleSshDocker } from './tools/docker-tools.js';
import { handleSshPortTest } from './tools/port-test-tools.js';
import { handleSshPlan } from './tools/plan-tools.js';

// v4 dispatcher facade -- 12 fat verb-tools over the handlers above.
import { handleSshRun } from './dispatchers/ssh-run.js';
import { handleSshFile } from './dispatchers/ssh-file.js';
import { handleSshLogs } from './dispatchers/ssh-logs.js';
import { handleSshService } from './dispatchers/ssh-service.js';
import { handleSshHealth } from './dispatchers/ssh-health.js';
import { handleSshDb } from './dispatchers/ssh-db.js';
import { handleSshBackup } from './dispatchers/ssh-backup.js';
import { handleSshSession } from './dispatchers/ssh-session.js';
import { handleSshNet } from './dispatchers/ssh-net.js';
import { handleSshDockerTool } from './dispatchers/ssh-docker.js';
import { handleSshFleet } from './dispatchers/ssh-fleet.js';
import { handleSshPlanTool } from './dispatchers/ssh-plan.js';
import {
  fleetServers, fleetGroups, fleetAliases, fleetProfiles,
  fleetHooks, fleetHistory, fleetConnections,
} from './fleet-adapters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve .env file path with fallback chain:
// 1. SSH_ENV_PATH env var (explicit override)
// 2. ~/.ssh-manager/.env (user config dir -- where ssh-manager CLI writes)
// 3. process.cwd()/.env (standard working directory)
// 4. ~/.env (home directory)
// 5. __dirname/../.env (backward compat for local installs)
function resolveEnvFilePath() {
  if (process.env.SSH_ENV_PATH) {
    return process.env.SSH_ENV_PATH;
  }
  const sshManagerHome = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager');
  const candidates = [
    path.join(sshManagerHome, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(process.cwd(), '.env');
}

const envFilePath = resolveEnvFilePath();
dotenv.config({ path: envFilePath });

// Initialize logger
logger.info('claude-code-ssh starting', {
  logLevel: process.env.SSH_LOG_LEVEL || 'INFO',
  verbose: process.env.SSH_VERBOSE === 'true',
  envFilePath
});

// Load SSH server configuration
let servers = {};
try {
  const loadedServers = await configLoader.load({
    envPath: envFilePath,
    tomlPath: process.env.SSH_CONFIG_PATH,
    preferToml: process.env.PREFER_TOML_CONFIG === 'true'
  });
  for (const [name, config] of loadedServers) {
    servers[name] = config;
  }
  logger.info(`Loaded ${loadedServers.size} SSH server configurations from ${configLoader.configSource}`);
} catch (error) {
  logger.error('Failed to load server configuration', { error: error.message });
}

// Initialize hooks system
try {
  await initializeHooks();
} catch (error) {
  logger.error('Failed to initialize hooks', { error: error.message });
}

// Load tool configuration
let toolConfig = null;
try {
  toolConfig = await loadToolConfig();
  const summary = toolConfig.getSummary();
  logger.info(`tools: ${summary.enabledCount}/${summary.totalTools} enabled (${summary.mode})`);
} catch (error) {
  logger.error('Failed to load tool configuration', { error: error.message });
  logger.info('Using default configuration (all tools enabled)');
}

// Map to store active connections
const connections = new Map();

// Map to store connection timestamps for timeout management
const connectionTimestamps = new Map();

// Connection timeout in milliseconds (30 minutes)
const CONNECTION_TIMEOUT = 30 * 60 * 1000;

// Keepalive interval in milliseconds (5 minutes)
const KEEPALIVE_INTERVAL = 5 * 60 * 1000;

// Map to store keepalive intervals
const keepaliveIntervals = new Map();

// Map to track proxy jump dependencies (target -> jump server)
const jumpDependencies = new Map();

// Load server configuration (backward compatibility wrapper)
function loadServerConfig() {
  // This function is kept for backward compatibility
  // The actual loading is done by configLoader during initialization
  return servers;
}

// Execute command with timeout - using child_process timeout for real kill
async function execCommandWithTimeout(ssh, command, options = {}, timeoutMs = 30000) {
  // Pass through rawCommand and platform if specified
  const { rawCommand, platform, ...otherOptions } = options;
  const isWindows = platform === 'windows';

  // For commands that might hang, use the system's timeout command if available
  // Skip for Windows hosts where the Linux timeout/sh commands don't exist
  const useSystemTimeout = timeoutMs > 0 && timeoutMs < 300000 && !rawCommand && !isWindows; // Max 5 minutes, not for raw/Windows commands

  if (useSystemTimeout) {
    // Wrap command with timeout command (works on Linux/Mac)
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    const wrappedCommand = `timeout ${timeoutSeconds} sh -c '${command.replace(/'/g, '\'\\\'\'')}'`;

    try {
      const result = await ssh.execCommand(wrappedCommand, otherOptions);

      // Check if timeout occurred (exit code 124 on Linux, 124 or 143 on Mac)
      if (result.code === 124 || result.code === 143) {
        throw new Error(`Command timeout after ${timeoutMs}ms: ${command.substring(0, 100)}...`);
      }

      return result;
    } catch (error) {
      // If timeout occurred, remove connection from pool
      if (error.message.includes('timeout')) {
        for (const [name, conn] of connections.entries()) {
          if (conn === ssh) {
            logger.warn(`Removing timed-out connection for ${name}`);
            connections.delete(name);
            connectionTimestamps.delete(name);
            if (keepaliveIntervals.has(name)) {
              clearInterval(keepaliveIntervals.get(name));
              keepaliveIntervals.delete(name);
            }
            // Force close the connection
            ssh.dispose();
            break;
          }
        }
      }
      throw error;
    }
  } else {
    // No timeout or very long timeout, execute normally
    return ssh.execCommand(command, { ...options, timeout: timeoutMs });
  }
}

// Check if a connection is still valid
async function isConnectionValid(ssh) {
  try {
    return await ssh.ping();
  } catch (error) {
    logger.debug('Connection validation failed', { error: error.message });
    return false;
  }
}

// Setup keepalive for a connection
function setupKeepalive(serverName, ssh) {
  // Clear existing keepalive if any
  if (keepaliveIntervals.has(serverName)) {
    clearInterval(keepaliveIntervals.get(serverName));
  }

  // Set up new keepalive interval
  const interval = setInterval(async () => {
    try {
      const isValid = await isConnectionValid(ssh);
      if (!isValid) {
        logger.warn(`Connection to ${serverName} lost, will reconnect on next use`);
        closeConnection(serverName);
      } else {
        // Update timestamp on successful keepalive
        connectionTimestamps.set(serverName, Date.now());
        logger.debug('Keepalive successful', { server: serverName });
      }
    } catch (error) {
      logger.error(`Keepalive failed for ${serverName}`, { error: error.message });
    }
  }, KEEPALIVE_INTERVAL);

  keepaliveIntervals.set(serverName, interval);
}

// Close a connection and clean up
function closeConnection(serverName) {
  const normalizedName = serverName.toLowerCase();

  // Clear keepalive interval
  if (keepaliveIntervals.has(normalizedName)) {
    clearInterval(keepaliveIntervals.get(normalizedName));
    keepaliveIntervals.delete(normalizedName);
  }

  // Close SSH connection
  const ssh = connections.get(normalizedName);
  if (ssh) {
    ssh.dispose();
    connections.delete(normalizedName);
  }

  // Remove timestamp
  connectionTimestamps.delete(normalizedName);

  // Clean up jump dependency tracking
  jumpDependencies.delete(normalizedName);

  logger.logConnection(serverName, 'closed');
}

// Clean up old connections
function cleanupOldConnections() {
  const now = Date.now();
  for (const [serverName, timestamp] of connectionTimestamps.entries()) {
    if (now - timestamp > CONNECTION_TIMEOUT) {
      logger.info(`Connection to ${serverName} timed out, closing`, { timeout: CONNECTION_TIMEOUT });
      closeConnection(serverName);
    }
  }
}

// Get or create SSH connection with reconnection support
async function getConnection(serverName) {
  const servers = loadServerConfig();

  // Execute pre-connect hook
  await executeHook('pre-connect', { server: serverName });

  // Try to resolve through aliases first
  const resolvedName = resolveServerName(serverName, servers);

  if (!resolvedName) {
    const availableServers = Object.keys(servers);
    const aliases = listAliases();
    const aliasInfo = aliases.length > 0 ?
      ` Aliases: ${aliases.map(a => `${a.alias}->${a.target}`).join(', ')}` : '';
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${availableServers.join(', ') || 'none'}.${aliasInfo}`
    );
  }

  const normalizedName = resolvedName;

  // Check if we have an existing connection
  if (connections.has(normalizedName)) {
    const existingSSH = connections.get(normalizedName);

    // Verify the connection is still valid
    const isValid = await isConnectionValid(existingSSH);

    if (isValid) {
      // Update timestamp and return existing connection
      connectionTimestamps.set(normalizedName, Date.now());
      return existingSSH;
    } else {
      // Connection is dead, remove it
      logger.info(`Connection to ${serverName} lost, reconnecting`);
      closeConnection(normalizedName);
    }
  }

  // Create new connection
  const serverConfig = servers[normalizedName];
  const ssh = new SSHManager(serverConfig);

  try {
    if (serverConfig.proxyJump) {
      const jumpServerName = serverConfig.proxyJump.toLowerCase();

      // Validate jump server exists
      if (!servers[jumpServerName]) {
        throw new Error(
          `Proxy jump server "${serverConfig.proxyJump}" not found. ` +
          `Available servers: ${Object.keys(servers).join(', ')}`
        );
      }

      // Detect circular proxy jumps
      const visited = new Set([normalizedName]);
      let current = jumpServerName;
      while (current) {
        if (visited.has(current)) {
          throw new Error(`Circular proxy jump detected: ${[...visited, current].join(' -> ')}`);
        }
        visited.add(current);
        current = servers[current]?.proxyJump?.toLowerCase() || null;
      }

      // Connect to jump server (recursive -- handles chained jumps)
      const jumpSSH = await getConnection(serverConfig.proxyJump);

      // Create forwarded stream through the jump server
      const stream = await jumpSSH.forwardOut(
        '127.0.0.1', 0,
        serverConfig.host, serverConfig.port || 22
      );

      // Connect target through the forwarded stream
      await ssh.connect({ sock: stream });
      jumpDependencies.set(normalizedName, jumpServerName);
      ssh.jumpConnection = jumpSSH;
    } else {
      await ssh.connect();
    }

    connections.set(normalizedName, ssh);
    connectionTimestamps.set(normalizedName, Date.now());

    // Setup keepalive
    setupKeepalive(normalizedName, ssh);

    logger.logConnection(serverName, 'established', {
      host: serverConfig.host,
      port: serverConfig.port,
      method: serverConfig.password ? 'password' : 'key',
      proxyJump: serverConfig.proxyJump || null
    });

    // Execute post-connect hook
    await executeHook('post-connect', { server: serverName });
  } catch (error) {
    logger.logConnection(serverName, 'failed', { error: error.message });
    // Execute error hook
    await executeHook('on-error', { server: serverName, error: error.message });
    throw new Error(`Failed to connect to ${serverName}: ${error.message}`);
  }

  return connections.get(normalizedName);
}

// Create MCP server. Version pulled from package.json so the wire version
// never drifts from the released build.
const __pkgDir = path.dirname(fileURLToPath(import.meta.url));
const __pkgJson = JSON.parse(fs.readFileSync(path.join(__pkgDir, '..', 'package.json'), 'utf8'));
const SERVER_VERSION = __pkgJson.version;
const server = new McpServer({
  name: 'claude-code-ssh',
  version: SERVER_VERSION,
});

logger.info('MCP Server initialized', { version: SERVER_VERSION });

/**
 * Helper function to conditionally register tools based on configuration
 * @param {string} toolName - Name of the tool
 * @param {Object} schema - Tool schema
 * @param {Function} handler - Tool handler function
 */
function registerToolConditional(toolName, schema, handler) {
  if (!isToolEnabled(toolName)) {
    logger.debug(`Skipped disabled tool: ${toolName}`);
    return;
  }
  // Thread MCP cancellation through to the tool handler. The SDK delivers an
  // AbortSignal at `extra.signal`; tools surface it as `args.abortSignal`
  // (which streamExecCommand already accepts) so long-running remote commands
  // stop when the client hits Esc instead of running to completion on the
  // target host.
  const wrapped = async (args, extra) => {
    const mergedArgs = extra && extra.signal
      ? { ...args, abortSignal: extra.signal }
      : args;
    return handler(mergedArgs, extra);
  };
  server.registerTool(toolName, withAnnotations(toolName, schema), wrapped);
  logger.debug(`Registered tool: ${toolName}`);
}

// Register available tools
function getServerConfigByName(serverName) {
  const resolved = resolveServerName(serverName, servers) || (serverName || '').toLowerCase();
  return servers[resolved];
}

// --- v4 fat verb-tool registration ----------------------------------------
// Shared schema fragments. Every action-scoped arg is optional; each
// dispatcher enforces its per-action required-arg map and returns a
// structured fail() naming any missing args.
const FORMAT = z.enum(['compact', 'json', 'markdown']).optional()
  .describe('Output format (default compact)');
const RAW = z.boolean().optional()
  .describe('Disable output compression and truncation');

// deps bundle handed to every dispatcher.
const DEPS = {
  getConnection,
  getServerConfig: getServerConfigByName,
  resolveGroup: (groupName) => {
    const g = getGroup(groupName);
    return g ? { name: g.name, servers: g.servers } : null;
  },
};

registerToolConditional('ssh_run', {
  description: 'Run a command on a configured SSH server. Use instead of '
    + '`ssh host <cmd>` via Bash -- the connection is pooled (no per-call '
    + 'handshake) and output is bounded and compressed.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['exec', 'sudo', 'fleet']).describe('exec a command, sudo a command, or fleet-exec across a group'),
    command: z.string().optional().describe('Command to run (actions: exec, sudo)'),
    cwd: z.string().optional().describe('Working directory (actions: exec, sudo, fleet)'),
    group: z.string().optional().describe('Server group name (action: fleet)'),
    sudo_password: z.string().optional().describe('Sudo password, streamed via stdin (action: sudo)'),
    timeout: z.number().optional().describe('Command timeout in ms (actions: exec, sudo)'),
    raw: RAW,
    format: FORMAT,
  },
}, async (args) => handleSshRun({
  deps: DEPS,
  handlers: {
    execute: handleSshExecute,
    executeSudo: handleSshExecuteSudo,
    executeGroup: handleSshExecuteGroup,
  },
  args,
}));

registerToolConditional('ssh_file', {
  description: 'Transfer, read, edit, diff, or deploy files on a configured '
    + 'SSH server. Use instead of `scp` / `ssh host cat` / heredocs via Bash '
    + '-- transfers are sha256-verified and writes avoid shell-quoting hazards.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['upload', 'download', 'sync', 'read', 'write', 'edit', 'diff', 'deploy', 'deploy-artifact'])
      .describe('File operation to perform'),
    local_path: z.string().optional().describe('Local path (actions: upload, download)'),
    remote_path: z.string().optional().describe('Remote path (actions: upload, download, read, write, edit)'),
    content: z.string().optional().describe('File content to write (action: write)'),
    old_text: z.string().optional().describe('Text to replace (action: edit)'),
    new_text: z.string().optional().describe('Replacement text (action: edit)'),
    source: z.string().optional().describe('Sync source, "local:"/"remote:" prefixed (action: sync)'),
    destination: z.string().optional().describe('Sync destination, "local:"/"remote:" prefixed (action: sync)'),
    exclude: z.array(z.string()).optional().describe('Exclude patterns (action: sync)'),
    delete_extra: z.boolean().optional().describe('Delete files absent from source (action: sync)'),
    head: z.number().optional().describe('Read first N lines (action: read)'),
    tail: z.number().optional().describe('Read last N lines (action: read)'),
    grep: z.string().optional().describe('Extended-regex filter (action: read)'),
    line_start: z.number().optional().describe('Start line, 1-indexed (action: read)'),
    line_end: z.number().optional().describe('End line, 1-indexed (action: read)'),
    path_a: z.string().optional().describe('First file (action: diff)'),
    path_b: z.string().optional().describe('Second file (action: diff)'),
    server_b: z.string().optional().describe('Other server hosting path_b for a cross-server diff (action: diff)'),
    artifact_local_path: z.string().optional().describe('Local artifact (actions: deploy, deploy-artifact)'),
    target_path: z.string().optional().describe('Remote target path (actions: deploy, deploy-artifact)'),
    post_hooks: z.array(z.string()).optional().describe('Post-deploy commands (actions: deploy, deploy-artifact)'),
    health_check: z.string().optional().describe('Health check command (actions: deploy, deploy-artifact)'),
    rollback_on_fail: z.boolean().optional().describe('Auto-rollback on failure (actions: deploy, deploy-artifact)'),
    preview: z.boolean().optional().describe('Show the plan without executing'),
    format: FORMAT,
  },
}, async (args) => handleSshFile({
  deps: DEPS,
  handlers: {
    upload: handleSshUpload,
    download: handleSshDownload,
    sync: handleSshSync,
    cat: handleSshCat,
    edit: handleSshEdit,
    diff: handleSshDiff,
    deploy: handleSshDeploy,
  },
  args,
}));

registerToolConditional('ssh_logs', {
  description: 'Read remote logs. Use instead of `ssh host journalctl` / '
    + '`ssh host tail` via Bash -- output is capped and filtered so it will '
    + 'not flood context.',
  inputSchema: {
    server: z.string().optional().describe('Server name (actions: tail, follow-start, journal)'),
    action: z.enum(['tail', 'follow-start', 'follow-read', 'follow-stop', 'journal'])
      .describe('Log operation to perform'),
    file: z.string().optional().describe('Log file path (actions: tail, follow-start)'),
    lines: z.number().optional().describe('Trailing line count (actions: tail, follow-start, journal)'),
    grep: z.string().optional().describe('Extended-regex filter (actions: tail, follow-start, journal)'),
    session_id: z.string().optional().describe('Tail session id (actions: follow-read, follow-stop)'),
    since_offset: z.number().optional().describe('Resume byte offset (action: follow-read)'),
    unit: z.string().optional().describe('systemd unit to filter (action: journal)'),
    since: z.string().optional().describe('Time lower bound (action: journal)'),
    until: z.string().optional().describe('Time upper bound (action: journal)'),
    priority: z.string().optional().describe('Priority filter (action: journal)'),
    format: FORMAT,
  },
}, async (args) => handleSshLogs({
  deps: DEPS,
  handlers: {
    tail: handleSshTail,
    tailStart: handleSshTailStart,
    tailRead: handleSshTailRead,
    tailStop: handleSshTailStop,
    journal: handleSshJournalctl,
  },
  args,
}));

registerToolConditional('ssh_service', {
  description: 'Inspect or control a systemd service on a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['status', 'start', 'stop', 'restart', 'enable', 'disable'])
      .describe('Service operation to perform'),
    service: z.string().describe('Service unit name, e.g. "nginx" or "nginx.service"'),
    preview: z.boolean().optional().describe('Preview a mutating action without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshService({
  deps: DEPS,
  handlers: { serviceStatus: handleSshServiceStatus, systemctl: handleSshSystemctl },
  args,
}));

registerToolConditional('ssh_health', {
  description: 'Server health snapshot, resource watch, process management, '
    + 'and threshold alerts for a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['check', 'watch', 'procs', 'alerts']).describe('Health operation to perform'),
    watch_type: z.enum(['overview', 'cpu', 'memory', 'disk', 'network', 'process'])
      .optional().describe('Subsystem to snapshot (action: watch)'),
    proc_action: z.enum(['list', 'kill', 'info']).optional().describe('Process operation (action: procs, default list)'),
    pid: z.number().optional().describe('Process id (action: procs, proc_action kill/info)'),
    signal: z.enum(['TERM', 'KILL', 'HUP', 'INT', 'QUIT']).optional().describe('Kill signal (action: procs)'),
    sort_by: z.enum(['cpu', 'memory']).optional().describe('Process sort key (action: procs)'),
    limit: z.number().optional().describe('Process row cap (action: procs)'),
    filter: z.string().optional().describe('Process name/command filter (action: procs)'),
    alert_action: z.enum(['set', 'get', 'check']).optional().describe('Alert operation (action: alerts)'),
    cpu_threshold: z.number().min(0).max(100).optional().describe('CPU alert threshold percent (action: alerts)'),
    memory_threshold: z.number().min(0).max(100).optional().describe('Memory alert threshold percent (action: alerts)'),
    disk_threshold: z.number().min(0).max(100).optional().describe('Disk alert threshold percent (action: alerts)'),
    enabled: z.boolean().optional().describe('Enable/disable alert evaluation (action: alerts)'),
    preview: z.boolean().optional().describe('Preview a process kill without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshHealth({
  deps: DEPS,
  handlers: {
    healthCheck: handleSshHealthCheck,
    monitor: handleSshMonitor,
    processManager: handleSshProcessManager,
    alertSetup: handleSshAlertSetup,
  },
  args,
}));

registerToolConditional('ssh_db', {
  description: 'Database operations (MySQL, PostgreSQL, MongoDB) on a '
    + 'configured SSH server. Queries are SELECT-only and token-validated.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['query', 'list', 'dump', 'import']).describe('Database operation to perform'),
    db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Database engine'),
    database: z.string().optional().describe('Database name (actions: query, dump, import)'),
    query: z.string().optional().describe('SELECT-only SQL or Mongo find (action: query)'),
    collection: z.string().optional().describe('MongoDB collection (action: query)'),
    output_file: z.string().optional().describe('Dump output path (action: dump)'),
    tables: z.array(z.string()).optional().describe('Specific tables (action: dump)'),
    input_file: z.string().optional().describe('Import input path (action: import)'),
    gzip: z.boolean().optional().describe('Gzip the dump (action: dump)'),
    drop: z.boolean().optional().describe('Drop existing before import, Mongo (action: import)'),
    user: z.string().optional().describe('Database user'),
    password: z.string().optional().describe('Database password'),
    host: z.string().optional().describe('Database host'),
    port: z.number().optional().describe('Database port'),
    preview: z.boolean().optional().describe('Show the plan without importing (action: import)'),
    format: FORMAT,
  },
}, async (args) => handleSshDb({
  deps: DEPS,
  handlers: {
    query: handleSshDbQuery,
    list: handleSshDbList,
    dump: handleSshDbDump,
    import: handleSshDbImport,
  },
  args,
}));

registerToolConditional('ssh_backup', {
  description: 'Create, list, restore, or schedule content-addressed backups '
    + 'on a configured SSH server.',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['create', 'list', 'restore', 'schedule']).describe('Backup operation to perform'),
    backup_type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Backup type'),
    name: z.string().optional().describe('Backup name (actions: create, schedule)'),
    database: z.string().optional().describe('Database name (actions: create, restore, schedule)'),
    paths: z.array(z.string()).optional().describe('Paths to back up (actions: create, schedule)'),
    exclude: z.array(z.string()).optional().describe('Exclude patterns (action: create)'),
    backup_dir: z.string().optional().describe('Backup directory'),
    backup_id: z.string().optional().describe('Backup id (action: restore)'),
    target_path: z.string().optional().describe('Restore target path for file backups (action: restore)'),
    cron: z.string().optional().describe('Cron schedule (action: schedule)'),
    retention: z.number().optional().describe('Retention days (action: schedule)'),
    gzip: z.boolean().optional().describe('Gzip the backup (action: create)'),
    verify: z.boolean().optional().describe('Compute/verify sha256 (actions: create, restore)'),
    preview: z.boolean().optional().describe('Show the plan without executing'),
    format: FORMAT,
  },
}, async (args) => handleSshBackup({
  deps: DEPS,
  handlers: {
    create: handleSshBackupCreate,
    list: handleSshBackupList,
    restore: handleSshBackupRestore,
    schedule: handleSshBackupSchedule,
  },
  args,
}));

registerToolConditional('ssh_docker', {
  description: 'Docker control on a configured SSH server (ps, logs, exec, '
    + 'restart, inspect).',
  inputSchema: {
    server: z.string().describe('Server name from configuration'),
    action: z.enum(['ps', 'logs', 'exec', 'restart', 'inspect']).describe('Docker operation to perform'),
    container: z.string().optional().describe('Container name/id (actions: logs, exec, restart, inspect)'),
    image: z.string().optional().describe('Image reference'),
    command: z.string().optional().describe('Command for docker exec (action: exec)'),
    tail_lines: z.number().optional().describe('Log tail line count (action: logs)'),
    preview: z.boolean().optional().describe('Preview a mutating action without running it'),
    format: FORMAT,
  },
}, async (args) => handleSshDockerTool({
  deps: DEPS,
  handlers: { docker: handleSshDocker },
  args,
}));

registerToolConditional('ssh_session', {
  description: 'Persistent SSH sessions with preserved shell state, history '
    + 'replay, and inferred memory.',
  inputSchema: {
    server: z.string().optional().describe('Server name (action: start)'),
    action: z.enum(['start', 'send', 'list', 'close', 'replay', 'memory'])
      .describe('Session operation to perform'),
    session_id: z.string().optional().describe('Session id (actions: send, close, replay, memory)'),
    command: z.string().optional().describe('Command to send (action: send)'),
    timeout: z.number().optional().describe('Command timeout in ms (action: send)'),
    limit: z.number().optional().describe('Max commands to replay (action: replay)'),
    format: FORMAT,
  },
}, async (args) => handleSshSession({
  deps: DEPS,
  handlers: {
    start: handleSshSessionStartNew,
    send: handleSshSessionSendNew,
    list: handleSshSessionListNew,
    close: handleSshSessionCloseNew,
    replay: handleSshSessionReplay,
    memory: handleSshSessionMemory,
  },
  args,
}));

registerToolConditional('ssh_net', {
  description: 'SSH tunnels (local/remote/SOCKS) and outbound port/TLS/HTTP '
    + 'reachability probes from a configured server.',
  inputSchema: {
    server: z.string().optional().describe('Server name (actions: tunnel-open, port-test)'),
    action: z.enum(['tunnel-open', 'tunnel-list', 'tunnel-close', 'port-test'])
      .describe('Network operation to perform'),
    tunnel_type: z.enum(['local', 'remote', 'dynamic']).optional().describe('Tunnel kind (action: tunnel-open)'),
    local_host: z.string().optional().describe('Local host (action: tunnel-open)'),
    local_port: z.number().optional().describe('Local port (action: tunnel-open)'),
    remote_host: z.string().optional().describe('Remote host (action: tunnel-open)'),
    remote_port: z.number().optional().describe('Remote port (action: tunnel-open)'),
    tunnel_id: z.string().optional().describe('Tunnel id (action: tunnel-close)'),
    target_host: z.string().optional().describe('Probe target host (action: port-test)'),
    target_port: z.number().optional().describe('Probe target port (action: port-test)'),
    probe_chain: z.array(z.enum(['dns', 'tcp', 'tls', 'http'])).optional().describe('Probe ordering (action: port-test)'),
    timeout_ms_per_probe: z.number().optional().describe('Per-probe timeout in ms (action: port-test)'),
    continue_on_fail: z.boolean().optional().describe('Keep probing after a failure (action: port-test)'),
    preview: z.boolean().optional().describe('Probe reachability without opening the tunnel (action: tunnel-open)'),
    format: FORMAT,
  },
}, async (args) => handleSshNet({
  deps: DEPS,
  handlers: {
    tunnelCreate: handleSshTunnelCreate,
    tunnelList: handleSshTunnelList,
    tunnelClose: handleSshTunnelClose,
    portTest: handleSshPortTest,
  },
  args,
}));

registerToolConditional('ssh_fleet', {
  description: 'Fleet and configuration metadata: configured servers, server '
    + 'groups, aliases, profiles, hooks, host keys, command history, '
    + 'connection pool.',
  inputSchema: {
    action: z.enum(['servers', 'groups', 'aliases', 'profiles', 'hooks', 'keys', 'history', 'connections'])
      .describe('Fleet/config entity to operate on'),
    op: z.enum(['list', 'add', 'remove', 'update', 'status', 'reconnect', 'disconnect', 'cleanup', 'verify', 'accept', 'check', 'show'])
      .optional().describe('Sub-operation (default list/status)'),
    name: z.string().optional().describe('Entity name (group, alias, profile, hook)'),
    members: z.array(z.string()).optional().describe('Member server names (action: groups)'),
    target: z.string().optional().describe('Alias target server (action: aliases)'),
    server: z.string().optional().describe('Server name (actions: keys, connections, history)'),
    host: z.string().optional().describe('Raw host (action: keys)'),
    port: z.number().optional().describe('Port (action: keys)'),
    auto_accept: z.boolean().optional().describe('Auto-accept new host keys (action: keys)'),
    limit: z.number().optional().describe('Row limit (action: history)'),
    format: FORMAT,
  },
}, async (args) => handleSshFleet({
  deps: DEPS,
  handlers: {
    servers: ({ args: a }) => fleetServers({ args: a, deps: { loadServerConfig } }),
    groups: ({ args: a }) => fleetGroups({
      args: a,
      deps: { listGroups, createGroup, updateGroup, deleteGroup, addServersToGroup, removeServersFromGroup },
    }),
    aliases: ({ args: a }) => fleetAliases({
      args: a, deps: { listAliases, addAlias, removeAlias, loadServerConfig, resolveServerName },
    }),
    profiles: ({ args: a }) => fleetProfiles({
      args: a, deps: { listProfiles, setActiveProfile, getActiveProfileName, loadProfile },
    }),
    hooks: ({ args: a }) => fleetHooks({ args: a, deps: { listHooks, toggleHook } }),
    history: ({ args: a }) => fleetHistory({ args: a, deps: { logger } }),
    connections: ({ args: a }) => fleetConnections({
      args: a,
      deps: {
        connections, connectionTimestamps, keepaliveIntervals,
        isConnectionValid, closeConnection, cleanupOldConnections, getConnection,
      },
    }),
    keys: handleSshKeyManage,
  },
  args,
}));

registerToolConditional('ssh_plan', {
  description: 'Declarative multi-step plan executor. Runs an ordered list of '
    + 'steps with rollback; high-risk steps need a re-run with approve_token.',
  inputSchema: {
    action: z.enum(['run', 'approve']).describe('run a plan, or approve and re-run a high-risk plan'),
    steps: z.array(z.any()).describe('Ordered list of step objects'),
    server: z.string().optional().describe('Plan-level default server for steps that omit one'),
    approve_token: z.string().optional().describe('Any non-empty token; required for high-risk plans (action: approve)'),
    rollback_on_fail: z.boolean().optional().describe('Walk completed steps in reverse and roll back on failure'),
    format: FORMAT,
  },
}, async (args) => handleSshPlanTool({
  deps: DEPS,
  handlers: {
    execute: handleSshExecute,
    executeSudo: handleSshExecuteSudo,
    upload: handleSshUpload,
    download: handleSshDownload,
    edit: handleSshEdit,
    systemctl: handleSshSystemctl,
    backupCreate: handleSshBackupCreate,
    healthCheck: handleSshHealthCheck,
  },
  planFn: handleSshPlan,
  args,
}));

// Clean up connections on shutdown
process.on('SIGINT', async () => {
  console.error('\n[conn] Closing SSH connections...');
  for (const [name, ssh] of connections) {
    ssh.dispose();
    console.error(`  Closed connection to ${name}`);
  }
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const servers = loadServerConfig();
  const serverList = Object.keys(servers);
  const activeProfile = getActiveProfileName();

  const servers_str = serverList.length > 0 ? serverList.join(', ') : 'none configured';
  const tools_summary = toolConfig ? (() => {
    const s = toolConfig.getSummary();
    return `${s.enabledCount} of ${s.totalTools} enabled (${s.mode})`;
  })() : '37 of 37 enabled';

  console.error('');
  console.error('  claude-code-ssh 3.2.2');
  console.error('  -----------------------------------------------');
  console.error(`  profile   ${activeProfile}`);
  console.error(`  servers   ${servers_str}`);
  console.error(`  tools     ${tools_summary}`);
  console.error('  pooling   auto-reconnect, 30m idle timeout');
  console.error('  -----------------------------------------------');
  console.error('');

  // Set up periodic cleanup of old connections (every 10 minutes)
  setInterval(() => {
    cleanupOldConnections();
  }, 10 * 60 * 1000);
}

main().catch(console.error);
