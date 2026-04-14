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
  OUTPUT_LIMITS,
  TIMEOUTS,
  truncateOutput,
  formatJSONResponse
} from './config.js';
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
  createSession,
  getSession,
  listSessions,
  closeSession,
  SESSION_STATES
} from './session-manager.js';
import {
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addServersToGroup,
  removeServersFromGroup,
  listGroups,
  executeOnGroup,
  EXECUTION_STRATEGIES
} from './server-groups.js';
import {
  createTunnel,
  getTunnel,
  listTunnels,
  closeTunnel,
  closeServerTunnels,
  TUNNEL_TYPES
} from './tunnel-manager.js';
import {
  getHostKeyFingerprint,
  isHostKnown,
  getCurrentHostKey,
  removeHostKey,
  addHostKey,
  updateHostKey,
  hasHostKeyChanged,
  listKnownHosts,
  detectSSHKeyError,
  extractHostFromSSHError
} from './ssh-key-manager.js';
import {
  BACKUP_TYPES,
  DEFAULT_BACKUP_DIR,
  generateBackupId,
  getBackupMetadataPath,
  getBackupFilePath,
  buildMySQLDumpCommand,
  buildPostgreSQLDumpCommand,
  buildMongoDBDumpCommand,
  buildFilesBackupCommand,
  buildRestoreCommand,
  createBackupMetadata,
  buildSaveMetadataCommand,
  buildListBackupsCommand,
  parseBackupsList,
  buildCleanupCommand,
  buildCronScheduleCommand,
  parseCronJobs
} from './backup-manager.js';
import {
  HEALTH_STATUS,
  COMMON_SERVICES,
  buildCPUCheckCommand,
  buildMemoryCheckCommand,
  buildDiskCheckCommand,
  buildNetworkCheckCommand,
  buildLoadAverageCommand,
  buildUptimeCommand,
  parseCPUUsage,
  parseMemoryUsage,
  parseDiskUsage,
  parseNetworkStats,
  determineOverallHealth,
  buildServiceStatusCommand,
  parseServiceStatus,
  buildProcessListCommand,
  parseProcessList,
  buildKillProcessCommand,
  buildProcessInfoCommand,
  createAlertConfig,
  buildSaveAlertConfigCommand,
  buildLoadAlertConfigCommand,
  checkAlertThresholds,
  buildComprehensiveHealthCheckCommand,
  parseComprehensiveHealthCheck,
  getCommonServices,
  resolveServiceName
} from './health-monitor.js';
import {
  DB_TYPES,
  DB_PORTS,
  buildMySQLDumpCommand as buildDBMySQLDumpCommand,
  buildPostgreSQLDumpCommand as buildDBPostgreSQLDumpCommand,
  buildMongoDBDumpCommand as buildDBMongoDBDumpCommand,
  buildMySQLImportCommand,
  buildPostgreSQLImportCommand,
  buildMongoDBRestoreCommand,
  buildMySQLListDatabasesCommand,
  buildMySQLListTablesCommand,
  buildPostgreSQLListDatabasesCommand,
  buildPostgreSQLListTablesCommand,
  buildMongoDBListDatabasesCommand,
  buildMongoDBListCollectionsCommand,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand,
  isSafeQuery,
  parseDatabaseList,
  parseTableList,
  buildEstimateSizeCommand,
  parseSize,
  formatBytes,
  getConnectionInfo
} from './database-manager.js';
import { loadToolConfig, isToolEnabled } from './tool-config-manager.js';

// Modularized tool handlers (src/tools/*.js) — 10/10 "gamechanger" versions
import { handleSshExecute, handleSshExecuteSudo, handleSshExecuteGroup } from './tools/exec-tools.js';
import { handleSshUpload, handleSshDownload, handleSshSync, handleSshDiff, handleSshEdit } from './tools/transfer-tools.js';
import { handleSshTail, handleSshTailStart, handleSshTailRead, handleSshTailStop } from './tools/tail-tools.js';
import { handleSshHealthCheck, handleSshMonitor, handleSshServiceStatus, handleSshProcessManager } from './tools/monitoring-tools.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve .env file path with fallback chain:
// 1. SSH_ENV_PATH env var (explicit override)
// 2. ~/.ssh-manager/.env (user config dir — where ssh-manager CLI writes)
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
logger.info('MCP SSH Manager starting', {
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
  logger.info(`Tool configuration loaded: ${summary.mode} mode, ${summary.enabledCount}/${summary.totalTools} tools enabled`);
  if (summary.mode === 'all') {
    logger.info('💡 Tip: Run "ssh-manager tools configure" to reduce context usage in Claude Code');
  }
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

      // Connect to jump server (recursive — handles chained jumps)
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

// Create MCP server
const server = new McpServer({
  name: 'mcp-ssh-manager',
  version: '1.2.0',
});

logger.info('MCP Server initialized', { version: '1.2.0' });

/**
 * Helper function to conditionally register tools based on configuration
 * @param {string} toolName - Name of the tool
 * @param {Object} schema - Tool schema
 * @param {Function} handler - Tool handler function
 */
function registerToolConditional(toolName, schema, handler) {
  if (isToolEnabled(toolName)) {
    server.registerTool(toolName, schema, handler);
    logger.debug(`Registered tool: ${toolName}`);
  } else {
    logger.debug(`Skipped disabled tool: ${toolName}`);
  }
}

// Register available tools
function getServerConfigByName(serverName) {
  const resolved = resolveServerName(serverName, servers) || (serverName || '').toLowerCase();
  return servers[resolved];
}

registerToolConditional(
  'ssh_execute',
  {
    description: 'Execute command on remote SSH server (streaming, UTF-8 safe, ANSI-clean markdown)',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      command: z.string().describe('Command to execute'),
      cwd: z.string().optional().describe('Working directory (uses default_dir if configured)'),
      timeout: z.number().optional().describe('Command timeout in ms (default 120000, max 300000)'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => {
    const cfg = getServerConfigByName(args.server) || {};
    return handleSshExecute({
      getConnection,
      args: {
        ...args,
        command: expandCommandAlias(args.command),
        cwd: args.cwd || cfg.default_dir,
        timeoutMs: args.timeout,
      },
    });
  }
);

registerToolConditional(
  'ssh_upload',
  {
    description: 'Upload file to remote SSH server (sha256-verified, preview-capable)',
    inputSchema: {
      server: z.string().describe('Server name'),
      localPath: z.string().optional().describe('Local file path (alias for local_path)'),
      remotePath: z.string().optional().describe('Remote destination path (alias for remote_path)'),
      local_path: z.string().optional().describe('Local file path'),
      remote_path: z.string().optional().describe('Remote destination path'),
      preview: z.boolean().optional().describe('Show plan without uploading'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshUpload({
    getConnection,
    args: {
      ...args,
      local_path: args.local_path || args.localPath,
      remote_path: args.remote_path || args.remotePath,
    }
  })
);

registerToolConditional(
  'ssh_download',
  {
    description: 'Download file from remote SSH server (sha256-verified)',
    inputSchema: {
      server: z.string().describe('Server name'),
      remotePath: z.string().optional().describe('Remote file path (alias for remote_path)'),
      localPath: z.string().optional().describe('Local destination path (alias for local_path)'),
      remote_path: z.string().optional().describe('Remote file path'),
      local_path: z.string().optional().describe('Local destination path'),
      preview: z.boolean().optional().describe('Show plan without downloading'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshDownload({
    getConnection,
    args: {
      ...args,
      local_path: args.local_path || args.localPath,
      remote_path: args.remote_path || args.remotePath,
    }
  })
);

registerToolConditional(
  'ssh_sync',
  {
    description: 'Synchronize files/folders between local and remote via rsync (preview-capable)',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      source: z.string().describe('Source path (use "local:" or "remote:" prefix)'),
      destination: z.string().describe('Destination path (use "local:" or "remote:" prefix)'),
      exclude: z.array(z.string()).optional().describe('Patterns to exclude from sync'),
      dryRun: z.boolean().optional().describe('Perform dry run without actual changes'),
      delete: z.boolean().optional().describe('Delete files in destination not in source'),
      compress: z.boolean().optional().describe('Compress during transfer'),
      verbose: z.boolean().optional().describe('Show detailed progress'),
      checksum: z.boolean().optional().describe('Use checksum instead of timestamp'),
      timeout: z.number().optional().describe('Timeout in milliseconds'),
      preview: z.boolean().optional().describe('Show plan without syncing'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshSync({
    getConnection,
    getServerConfig: getServerConfigByName,
    args: { ...args, dry_run: args.dry_run ?? args.dryRun }
  })
);

registerToolConditional(
  'ssh_tail',
  {
    description: 'Tail remote log files (sessionized follow mode, grep filter, format-aware)',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      file: z.string().describe('Path to the log file to tail'),
      lines: z.number().optional().describe('Number of lines to show initially (default: 100)'),
      follow: z.boolean().optional().describe('Follow file for new content (default: false)'),
      grep: z.string().optional().describe('Filter lines with grep pattern'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshTail({ getConnection, args })
);

registerToolConditional(
  'ssh_monitor',
  {
    description: 'Monitor system resources (CPU, RAM, disk, network) — typed output',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      type: z.enum(['overview', 'cpu', 'memory', 'disk', 'network', 'process']).optional().describe('Monitor type'),
      interval: z.number().optional().describe('Update interval in seconds'),
      duration: z.number().optional().describe('Duration in seconds'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshMonitor({ getConnection, args })
);

registerToolConditional(
  'ssh_history',
  {
    description: 'View SSH command history',
    inputSchema: {
      limit: z.number().optional().describe('Number of commands to show (default: 20)'),
      server: z.string().optional().describe('Filter by server name'),
      success: z.boolean().optional().describe('Filter by success/failure'),
      search: z.string().optional().describe('Search in commands')
    }
  },
  async ({ limit = 20, server, success, search }) => {
    try {
      // Get history from logger
      let history = logger.getHistory(limit * 2); // Get more to account for filtering

      // Apply filters
      if (server) {
        history = history.filter(h => h.server?.toLowerCase().includes(server.toLowerCase()));
      }

      if (success !== undefined) {
        history = history.filter(h => h.success === success);
      }

      if (search) {
        history = history.filter(h => h.command?.toLowerCase().includes(search.toLowerCase()));
      }

      // Limit results
      history = history.slice(-limit);

      // Format output
      let output = '📜 SSH Command History\n';
      output += `Showing last ${history.length} commands`;

      const filters = [];
      if (server) filters.push(`server: ${server}`);
      if (success !== undefined) filters.push(success ? 'successful only' : 'failed only');
      if (search) filters.push(`search: ${search}`);

      if (filters.length > 0) {
        output += ` (filtered: ${filters.join(', ')})`;
      }

      output += '\n' + '━'.repeat(60) + '\n\n';

      if (history.length === 0) {
        output += 'No commands found matching the criteria.\n';
      } else {
        history.forEach((entry, index) => {
          const time = new Date(entry.timestamp).toLocaleString();
          const status = entry.success ? '✅' : '❌';
          const duration = entry.duration || 'N/A';

          output += `${history.length - index}. ${status} [${time}]\n`;
          output += `   Server: ${entry.server || 'unknown'}\n`;
          output += `   Command: ${entry.command?.substring(0, 100) || 'N/A'}`;
          if (entry.command && entry.command.length > 100) {
            output += '...';
          }
          output += '\n';
          output += `   Duration: ${duration}`;

          if (!entry.success && entry.error) {
            output += `\n   Error: ${entry.error}`;
          }

          output += '\n\n';
        });
      }

      output += '━'.repeat(60) + '\n';
      output += `Total commands in history: ${logger.getHistory(1000).length}\n`;

      logger.info('Command history retrieved', {
        limit,
        filters: filters.length,
        results: history.length
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error retrieving history: ${error.message}`
          }
        ]
      };
    }
  }
);

// SSH Session Management Tools

registerToolConditional(
  'ssh_session_start',
  {
    description: 'Start a persistent SSH session (marker-prompt protocol, typed state)',
    inputSchema: {
      server: z.string().describe('Server name from configuration'),
      name: z.string().optional().describe('Optional session name'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshSessionStartNew({ getConnection, args })
);

registerToolConditional(
  'ssh_session_send',
  {
    description: 'Send a command to an existing SSH session (marker-aware, UTF-8 safe)',
    inputSchema: {
      session: z.string().optional().describe('Session ID (alias for session_id)'),
      session_id: z.string().optional().describe('Session ID'),
      command: z.string().describe('Command to execute'),
      timeout: z.number().optional().describe('Command timeout in ms'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshSessionSendNew({
    args: { ...args, session_id: args.session_id || args.session, timeoutMs: args.timeout }
  })
);

registerToolConditional(
  'ssh_session_list',
  {
    description: 'List all active SSH sessions (typed state info)',
    inputSchema: {
      server: z.string().optional().describe('Filter by server name'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshSessionListNew({ args })
);

registerToolConditional(
  'ssh_session_close',
  {
    description: 'Close an SSH session (idempotent)',
    inputSchema: {
      session: z.string().optional().describe('Session ID or "all" (alias for session_id)'),
      session_id: z.string().optional().describe('Session ID or "all"'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshSessionCloseNew({
    args: { ...args, session_id: args.session_id || args.session }
  })
);

// Helper function to format duration
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  } else {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
}

// Server Group Management Tools

registerToolConditional(
  'ssh_execute_group',
  {
    description: 'Execute command on a group of servers (bounded concurrency, typed per-server results)',
    inputSchema: {
      group: z.string().describe('Group name'),
      command: z.string().describe('Command to execute'),
      strategy: z.enum(['parallel', 'sequential', 'rolling']).optional().describe('Execution strategy'),
      concurrency: z.number().optional().describe('Max parallel connections'),
      delay: z.number().optional().describe('Delay between servers in ms'),
      stopOnError: z.boolean().optional().describe('Stop on first error'),
      cwd: z.string().optional().describe('Working directory'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshExecuteGroup({
    getConnection,
    resolveGroup: (groupName) => {
      const g = getGroup(groupName);
      if (!g) return null;
      return { name: g.name, servers: g.servers };
    },
    args: { ...args, stop_on_error: args.stop_on_error ?? args.stopOnError },
  })
);

registerToolConditional(
  'ssh_group_manage',
  {
    description: 'Manage server groups (create, update, delete, list)',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete', 'list', 'add-servers', 'remove-servers']).describe('Action to perform'),
      name: z.string().optional().describe('Group name'),
      servers: z.array(z.string()).optional().describe('Server names'),
      description: z.string().optional().describe('Group description'),
      strategy: z.enum(['parallel', 'sequential', 'rolling']).optional().describe('Execution strategy'),
      delay: z.number().optional().describe('Delay between servers in ms'),
      stopOnError: z.boolean().optional().describe('Stop on error flag')
    }
  },
  async ({ action, name, servers, description, strategy, delay, stopOnError }) => {
    try {
      let result;
      let output = '';

      switch (action) {
      case 'create':
        if (!name) throw new Error('Group name required for create');
        result = createGroup(name, servers || [], {
          description,
          strategy,
          delay,
          stopOnError
        });
        output = `✅ Group '${name}' created\n`;
        output += `Servers: ${result.servers.join(', ') || 'none'}\n`;
        output += `Strategy: ${result.strategy}\n`;
        break;

      case 'update':
        if (!name) throw new Error('Group name required for update');
        result = updateGroup(name, {
          servers,
          description,
          strategy,
          delay,
          stopOnError
        });
        output = `✅ Group '${name}' updated\n`;
        output += `Servers: ${result.servers.join(', ')}\n`;
        break;

      case 'delete':
        if (!name) throw new Error('Group name required for delete');
        deleteGroup(name);
        output = `✅ Group '${name}' deleted`;
        break;

      case 'add-servers':
        if (!name) throw new Error('Group name required');
        if (!servers || servers.length === 0) throw new Error('Servers required');
        result = addServersToGroup(name, servers);
        output = `✅ Added ${servers.length} servers to '${name}'\n`;
        output += `Total servers: ${result.servers.length}\n`;
        output += `Members: ${result.servers.join(', ')}`;
        break;

      case 'remove-servers':
        if (!name) throw new Error('Group name required');
        if (!servers || servers.length === 0) throw new Error('Servers required');
        result = removeServersFromGroup(name, servers);
        output = `✅ Removed ${servers.length} servers from '${name}'\n`;
        output += `Remaining: ${result.servers.length}\n`;
        output += `Members: ${result.servers.join(', ') || 'none'}`;
        break;

      case 'list': {
        const groups = listGroups();
        output = '📋 Server Groups\n';
        output += '━'.repeat(60) + '\n\n';

        groups.forEach(group => {
          output += `📁 ${group.name}`;
          if (group.dynamic) output += ' (dynamic)';
          output += '\n';
          output += `   Description: ${group.description}\n`;
          output += `   Servers: ${group.serverCount} servers\n`;
          if (group.servers.length > 0) {
            output += `   Members: ${group.servers.slice(0, 5).join(', ')}`;
            if (group.servers.length > 5) output += ` ... +${group.servers.length - 5} more`;
            output += '\n';
          }
          output += `   Strategy: ${group.strategy || 'parallel'}\n`;
          if (group.delay) output += `   Delay: ${group.delay}ms\n`;
          if (group.stopOnError) output += '   Stop on error: yes\n';
          output += '\n';
        });

        output += '━'.repeat(60) + '\n';
        output += `Total groups: ${groups.length}`;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }

      logger.info('Group management action completed', {
        action,
        name,
        servers: servers?.length
      });

      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logger.error('Group management failed', {
        action,
        name,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Group management error: ${error.message}`
          }
        ]
      };
    }
  }
);

registerToolConditional(
  'ssh_list_servers',
  {
    description: 'List all configured SSH servers',
    inputSchema: {}
  },
  async () => {
    const servers = loadServerConfig();
    const serverInfo = Object.entries(servers).map(([name, config]) => ({
      name,
      host: config.host,
      user: config.user,
      port: config.port || '22',
      auth: config.password ? 'password' : 'key',
      defaultDir: config.default_dir || '',
      description: config.description || ''
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverInfo, null, 2),
        },
      ],
    };
  }
);

// New deploy tool for automated deployment
registerToolConditional(
  'ssh_deploy',
  {
    description: 'Deploy files to remote server with automatic permission handling',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      files: z.array(z.object({
        local: z.string().describe('Local file path'),
        remote: z.string().describe('Remote file path')
      })).describe('Array of files to deploy'),
      options: z.object({
        owner: z.string().optional().describe('Set file owner (e.g., "user:group")'),
        permissions: z.string().optional().describe('Set file permissions (e.g., "644")'),
        backup: z.boolean().optional().default(true).describe('Backup existing files'),
        restart: z.string().optional().describe('Service to restart after deployment'),
        sudoPassword: z.string().optional().describe('Sudo password if needed (use with caution)')
      }).optional().describe('Deployment options')
    }
  },
  async ({ server, files, options = {} }) => {
    try {
      const ssh = await getConnection(server);

      // Execute pre-deploy hook
      await executeHook('pre-deploy', {
        server: server,
        files: files.map(f => f.local).join(', ')
      });

      const deployments = [];
      const results = [];

      // Prepare deployment for each file
      for (const file of files) {
        const tempFile = getTempFilename(path.basename(file.local));
        const needs = detectDeploymentNeeds(file.remote);

        // Merge detected needs with user options
        const deployOptions = {
          ...options,
          owner: options.owner || needs.suggestedOwner,
          permissions: options.permissions || needs.suggestedPerms
        };

        const strategy = buildDeploymentStrategy(file.remote, deployOptions);

        // Upload file to temp location first
        await ssh.putFile(file.local, tempFile);
        results.push(`✅ Uploaded ${path.basename(file.local)} to temp location`);

        // Execute deployment strategy
        const deployServers = loadServerConfig();
        const deployServerConfig = deployServers[server.toLowerCase()];
        for (const step of strategy.steps) {
          const command = step.command.replace('{{tempFile}}', tempFile);

          const result = await execCommandWithTimeout(ssh, command, { platform: deployServerConfig?.platform }, 15000);

          if (result.code !== 0 && step.type !== 'backup') {
            throw new Error(`${step.type} failed: ${result.stderr}`);
          }

          if (step.type !== 'cleanup') {
            results.push(`✅ ${step.type}: ${file.remote}`);
          }
        }

        deployments.push({
          local: file.local,
          remote: file.remote,
          tempFile,
          strategy
        });
      }

      // Execute post-deploy hook
      await executeHook('post-deploy', {
        server: server,
        files: files.map(f => f.remote).join(', ')
      });

      return {
        content: [
          {
            type: 'text',
            text: `🚀 Deployment successful!\n\n${results.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Deployment failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Execute command with sudo support (password via stdin, never argv)
registerToolConditional(
  'ssh_execute_sudo',
  {
    description: 'Execute command with sudo (password via stdin, never argv-leaked)',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      command: z.string().describe('Command to execute with sudo'),
      password: z.string().optional().describe('Sudo password (streamed via stdin)'),
      cwd: z.string().optional().describe('Working directory'),
      timeout: z.number().optional().describe('Command timeout in ms'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshExecuteSudo({
    getConnection,
    getServerConfig: getServerConfigByName,
    args: { ...args, timeoutMs: args.timeout }
  })
);

// Manage command aliases
registerToolConditional(
  'ssh_command_alias',
  {
    description: 'Manage command aliases for frequently used commands',
    inputSchema: {
      action: z.enum(['add', 'remove', 'list', 'suggest']).describe('Action to perform'),
      alias: z.string().optional().describe('Alias name (for add/remove)'),
      command: z.string().optional().describe('Command to alias (for add) or search term (for suggest)')
    }
  },
  async ({ action, alias, command }) => {
    try {
      switch (action) {
      case 'add': {
        if (!alias || !command) {
          throw new Error('Both alias and command are required for add action');
        }

        addCommandAlias(alias, command);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Command alias created: ${alias} -> ${command}`,
            },
          ],
        };
      }

      case 'remove': {
        if (!alias) {
          throw new Error('Alias is required for remove action');
        }

        removeCommandAlias(alias);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Command alias removed: ${alias}`,
            },
          ],
        };
      }

      case 'list': {
        const aliases = listCommandAliases();

        const aliasInfo = aliases.map(({ alias, command, isFromProfile, isCustom }) =>
          `  ${alias} -> ${command}${isFromProfile ? ' (profile)' : ''}${isCustom ? ' (custom)' : ''}`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: aliases.length > 0 ?
                `📝 Command aliases:\n${aliasInfo}` :
                '📝 No command aliases configured',
            },
          ],
        };
      }

      case 'suggest': {
        if (!command) {
          throw new Error('Command search term is required for suggest action');
        }

        const suggestions = suggestAliases(command);

        const suggestionInfo = suggestions.map(({ alias, command }) =>
          `  ${alias} -> ${command}`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: suggestions.length > 0 ?
                `💡 Suggested aliases for "${command}":\n${suggestionInfo}` :
                `💡 No aliases found matching "${command}"`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Command alias operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Manage hooks
registerToolConditional(
  'ssh_hooks',
  {
    description: 'Manage automation hooks for SSH operations',
    inputSchema: {
      action: z.enum(['list', 'enable', 'disable', 'status']).describe('Action to perform'),
      hook: z.string().optional().describe('Hook name (for enable/disable)')
    }
  },
  async ({ action, hook }) => {
    try {
      switch (action) {
      case 'list': {
        const hooks = listHooks();

        const hooksInfo = hooks.map(({ name, enabled, description, actionCount }) =>
          `  ${enabled ? '✅' : '⭕'} ${name}: ${description} (${actionCount} actions)`
        ).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: hooks.length > 0 ?
                `🎣 Available hooks:\n${hooksInfo}` :
                '🎣 No hooks configured',
            },
          ],
        };
      }

      case 'enable': {
        if (!hook) {
          throw new Error('Hook name is required for enable action');
        }

        toggleHook(hook, true);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Hook enabled: ${hook}`,
            },
          ],
        };
      }

      case 'disable': {
        if (!hook) {
          throw new Error('Hook name is required for disable action');
        }

        toggleHook(hook, false);
        return {
          content: [
            {
              type: 'text',
              text: `⭕ Hook disabled: ${hook}`,
            },
          ],
        };
      }

      case 'status': {
        const hooks = listHooks();
        const enabledHooks = hooks.filter(h => h.enabled);
        const disabledHooks = hooks.filter(h => !h.enabled);

        return {
          content: [
            {
              type: 'text',
              text: `🎣 Hook status:\n  Enabled: ${enabledHooks.map(h => h.name).join(', ') || 'none'}\n  Disabled: ${disabledHooks.map(h => h.name).join(', ') || 'none'}`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Hook operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Manage profiles
registerToolConditional(
  'ssh_profile',
  {
    description: 'Manage SSH Manager profiles for different project types',
    inputSchema: {
      action: z.enum(['list', 'switch', 'current']).describe('Action to perform'),
      profile: z.string().optional().describe('Profile name (for switch)')
    }
  },
  async ({ action, profile }) => {
    try {
      switch (action) {
      case 'list': {
        const profiles = listProfiles();

        const profileInfo = profiles.map(p =>
          `  ${p.name}: ${p.description} (${p.aliasCount} aliases, ${p.hookCount} hooks)`
        ).join('\n');

        const current = getActiveProfileName();

        return {
          content: [
            {
              type: 'text',
              text: profiles.length > 0 ?
                `📚 Available profiles (current: ${current}):\n${profileInfo}` :
                '📚 No profiles found',
            },
          ],
        };
      }

      case 'switch': {
        if (!profile) {
          throw new Error('Profile name is required for switch action');
        }

        if (setActiveProfile(profile)) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Switched to profile: ${profile}\n⚠️  Restart Claude Code to apply profile changes`,
              },
            ],
          };
        } else {
          throw new Error(`Failed to switch to profile: ${profile}`);
        }
      }

      case 'current': {
        const current = getActiveProfileName();
        const profile = loadProfile();

        return {
          content: [
            {
              type: 'text',
              text: `📦 Current profile: ${current}\n📝 Description: ${profile.description || 'No description'}\n🔧 Aliases: ${Object.keys(profile.commandAliases || {}).length}\n🎣 Hooks: ${Object.keys(profile.hooks || {}).length}`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Profile operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// Connection management tool
registerToolConditional(
  'ssh_connection_status',
  {
    description: 'Check status of SSH connections and manage connection pool',
    inputSchema: {
      action: z.enum(['status', 'reconnect', 'disconnect', 'cleanup']).describe('Action to perform'),
      server: z.string().optional().describe('Server name (for reconnect/disconnect)')
    }
  },
  async ({ action, server }) => {
    try {
      switch (action) {
      case 'status': {
        const activeConnections = [];
        const now = Date.now();

        for (const [serverName, ssh] of connections.entries()) {
          const timestamp = connectionTimestamps.get(serverName);
          const ageMinutes = Math.floor((now - timestamp) / 1000 / 60);
          const isValid = await isConnectionValid(ssh);

          activeConnections.push({
            server: serverName,
            status: isValid ? '✅ Active' : '❌ Dead',
            age: `${ageMinutes} minutes`,
            keepalive: keepaliveIntervals.has(serverName) ? '✅' : '❌'
          });
        }

        const statusInfo = activeConnections.length > 0 ?
          activeConnections.map(c => `  ${c.server}: ${c.status} (age: ${c.age}, keepalive: ${c.keepalive})`).join('\n') :
          '  No active connections';

        return {
          content: [
            {
              type: 'text',
              text: `🔌 Connection Pool Status:\n${statusInfo}\n\nSettings:\n  Timeout: ${CONNECTION_TIMEOUT / 1000 / 60} minutes\n  Keepalive: Every ${KEEPALIVE_INTERVAL / 1000 / 60} minutes`,
            },
          ],
        };
      }

      case 'reconnect': {
        if (!server) {
          throw new Error('Server name is required for reconnect action');
        }

        const normalizedName = server.toLowerCase();
        if (connections.has(normalizedName)) {
          closeConnection(normalizedName);
        }

        await getConnection(server);
        return {
          content: [
            {
              type: 'text',
              text: `♻️  Reconnected to ${server}`,
            },
          ],
        };
      }

      case 'disconnect': {
        if (!server) {
          throw new Error('Server name is required for disconnect action');
        }

        closeConnection(server);
        return {
          content: [
            {
              type: 'text',
              text: `🔌 Disconnected from ${server}`,
            },
          ],
        };
      }

      case 'cleanup': {
        const oldCount = connections.size;
        cleanupOldConnections();

        // Also check and remove dead connections
        for (const [serverName, ssh] of connections.entries()) {
          const isValid = await isConnectionValid(ssh);
          if (!isValid) {
            closeConnection(serverName);
          }
        }

        const cleaned = oldCount - connections.size;
        return {
          content: [
            {
              type: 'text',
              text: `🧹 Cleanup complete: ${cleaned} connections closed, ${connections.size} active`,
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Connection management failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// SSH Tunnel Management - Create tunnel
registerToolConditional(
  'ssh_tunnel_create',
  {
    description: 'Create SSH tunnel (DNS+TCP reachability preview, typed state)',
    inputSchema: {
      server: z.string().describe('Server name or alias'),
      type: z.enum(['local', 'remote', 'dynamic']).describe('Tunnel type'),
      localHost: z.string().optional().describe('Local host (alias for local_host)'),
      local_host: z.string().optional().describe('Local host'),
      localPort: z.number().optional().describe('Local port (alias for local_port)'),
      local_port: z.number().optional().describe('Local port'),
      remoteHost: z.string().optional().describe('Remote host (alias for remote_host)'),
      remote_host: z.string().optional().describe('Remote host'),
      remotePort: z.number().optional().describe('Remote port (alias for remote_port)'),
      remote_port: z.number().optional().describe('Remote port'),
      preview: z.boolean().optional().describe('Probe reachability without opening tunnel'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshTunnelCreate({
    getConnection,
    args: {
      ...args,
      local_host: args.local_host ?? args.localHost,
      local_port: args.local_port ?? args.localPort,
      remote_host: args.remote_host ?? args.remoteHost,
      remote_port: args.remote_port ?? args.remotePort,
    }
  })
);

registerToolConditional(
  'ssh_tunnel_list',
  {
    description: 'List active SSH tunnels (typed state)',
    inputSchema: {
      server: z.string().optional().describe('Filter by server name'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshTunnelList({ args })
);

registerToolConditional(
  'ssh_tunnel_close',
  {
    description: 'Close an SSH tunnel (idempotent)',
    inputSchema: {
      tunnelId: z.string().optional().describe('Tunnel ID (alias for tunnel_id)'),
      tunnel_id: z.string().optional().describe('Tunnel ID'),
      server: z.string().optional().describe('Close all tunnels for this server'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshTunnelClose({
    args: { ...args, tunnel_id: args.tunnel_id || args.tunnelId }
  })
);

// Manage SSH host keys — real SHA256 fingerprint comparison, no regex guessing
registerToolConditional(
  'ssh_key_manage',
  {
    description: 'Manage SSH host keys (real SHA256:base64-nopad fingerprints, no TOFU)',
    inputSchema: {
      action: z.enum(['verify', 'accept', 'remove', 'list', 'check', 'show']).describe('Action to perform'),
      server: z.string().optional().describe('Server name (or raw host for show/verify)'),
      host: z.string().optional().describe('Hostname (alternative to server)'),
      port: z.number().optional().describe('Port (default: 22)'),
      autoAccept: z.boolean().optional().describe('Automatically accept new keys'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => {
    const cfg = args.server ? getServerConfigByName(args.server) : null;
    const host = args.host || (cfg && cfg.host);
    const port = args.port || (cfg && parseInt(cfg.port || '22'));
    return handleSshKeyManage({ args: { ...args, host, port } });
  }
);

// Manage server aliases
registerToolConditional(
  'ssh_alias',
  {
    description: 'Manage server aliases for easier access',
    inputSchema: {
      action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
      alias: z.string().optional().describe('Alias name (for add/remove)'),
      server: z.string().optional().describe('Server name (for add)')
    }
  },
  async ({ action, alias, server }) => {
    try {
      switch (action) {
      case 'add': {
        if (!alias || !server) {
          throw new Error('Both alias and server are required for add action');
        }

        const servers = loadServerConfig();
        const resolvedName = resolveServerName(server, servers);

        if (!resolvedName) {
          throw new Error(`Server "${server}" not found`);
        }

        addAlias(alias, resolvedName);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Alias created: ${alias} -> ${resolvedName}`,
            },
          ],
        };
      }

      case 'remove': {
        if (!alias) {
          throw new Error('Alias is required for remove action');
        }

        removeAlias(alias);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Alias removed: ${alias}`,
            },
          ],
        };
      }

      case 'list': {
        const aliases = listAliases();
        const servers = loadServerConfig();

        const aliasInfo = aliases.map(({ alias, target }) => {
          const server = servers[target];
          return `  ${alias} -> ${target} (${server?.host || 'unknown'})`;
        }).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: aliases.length > 0 ?
                `📝 Server aliases:\n${aliasInfo}` :
                '📝 No aliases configured',
            },
          ],
        };
      }
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Alias operation failed: ${error.message}`,
          },
        ],
      };
    }
  }
);

// ============================================================================
// BACKUP & RESTORE TOOLS
// ============================================================================

registerToolConditional(
  'ssh_backup_create',
  {
    description: 'Create content-addressed backup with sha256 verification + preview',
    inputSchema: {
      server: z.string().describe('Server name'),
      backup_type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Backup type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Alias for backup_type'),
      name: z.string().optional().describe('Backup name'),
      database: z.string().optional().describe('Database name'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      paths: z.array(z.string()).optional().describe('Paths to backup'),
      exclude: z.array(z.string()).optional().describe('Exclude patterns'),
      backup_dir: z.string().optional().describe('Backup directory'),
      backupDir: z.string().optional().describe('Backup directory (alias)'),
      gzip: z.boolean().optional().describe('Gzip the backup'),
      compress: z.boolean().optional().describe('Alias for gzip'),
      verify: z.boolean().optional().describe('Compute sha256 after backup'),
      preview: z.boolean().optional().describe('Show plan without backing up'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshBackupCreate({
    getConnection,
    args: {
      ...args,
      backup_type: args.backup_type || args.type,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
      backup_dir: args.backup_dir || args.backupDir,
      gzip: args.gzip ?? args.compress,
    },
  })
);

registerToolConditional(
  'ssh_backup_list',
  {
    description: 'List backups (typed list with sha256, newest-first, meta sidecar parsing)',
    inputSchema: {
      server: z.string().describe('Server name'),
      backup_type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Filter'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Alias'),
      backup_dir: z.string().optional().describe('Backup directory'),
      backupDir: z.string().optional().describe('Backup directory (alias)'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshBackupList({
    getConnection,
    args: {
      ...args,
      backup_type: args.backup_type || args.type,
      backup_dir: args.backup_dir || args.backupDir,
    }
  })
);

registerToolConditional(
  'ssh_backup_restore',
  {
    description: 'Restore backup (sha256-verified, high-risk preview)',
    inputSchema: {
      server: z.string().describe('Server name'),
      backup_id: z.string().optional().describe('Backup ID'),
      backupId: z.string().optional().describe('Backup ID (alias)'),
      database: z.string().optional().describe('Target database'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      target_path: z.string().optional().describe('Target path for files'),
      targetPath: z.string().optional().describe('Target path (alias)'),
      backup_dir: z.string().optional().describe('Backup directory'),
      backupDir: z.string().optional().describe('Backup directory (alias)'),
      verify: z.boolean().optional().describe('Verify sha256 before restore'),
      preview: z.boolean().optional().describe('Show plan without restoring'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshBackupRestore({
    getConnection,
    args: {
      ...args,
      backup_id: args.backup_id || args.backupId,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
      target_path: args.target_path || args.targetPath,
      backup_dir: args.backup_dir || args.backupDir,
    }
  })
);

registerToolConditional(
  'ssh_backup_schedule',
  {
    description: 'Schedule automatic backups via cron (preview-capable)',
    inputSchema: {
      server: z.string().describe('Server name'),
      cron: z.string().optional().describe('Cron schedule'),
      schedule: z.string().optional().describe('Cron schedule (alias)'),
      backup_type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Backup type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'files']).optional().describe('Alias'),
      name: z.string().optional().describe('Backup name'),
      database: z.string().optional().describe('Database name'),
      paths: z.array(z.string()).optional().describe('Paths to backup'),
      retention: z.number().optional().describe('Retention days'),
      preview: z.boolean().optional().describe('Show cron plan without installing'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshBackupSchedule({
    getConnection,
    args: {
      ...args,
      cron: args.cron || args.schedule,
      backup_type: args.backup_type || args.type,
    }
  })
);

// ============================================================================
// HEALTH CHECKS & MONITORING TOOLS
// ============================================================================

registerToolConditional(
  'ssh_health_check',
  {
    description: 'Comprehensive health check (single-shot bash -c with marker-delimited sections)',
    inputSchema: {
      server: z.string().describe('Server name'),
      detailed: z.boolean().optional().describe('Include network, load average'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshHealthCheck({ getConnection, args })
);

registerToolConditional(
  'ssh_service_status',
  {
    description: 'Check service status (batch-safe parsing, typed health rollup)',
    inputSchema: {
      server: z.string().describe('Server name'),
      services: z.array(z.string()).describe('Service names'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshServiceStatus({ getConnection, args })
);

registerToolConditional(
  'ssh_process_manager',
  {
    description: 'List/kill/info processes (typed, preview-capable for kills)',
    inputSchema: {
      server: z.string().describe('Server name'),
      action: z.enum(['list', 'kill', 'info']).describe('Action'),
      pid: z.number().optional().describe('Process ID'),
      signal: z.enum(['TERM', 'KILL', 'HUP', 'INT', 'QUIT']).optional().describe('Signal'),
      sortBy: z.enum(['cpu', 'memory']).optional().describe('Sort key'),
      sort_by: z.enum(['cpu', 'memory']).optional().describe('Sort key (alias)'),
      limit: z.number().optional().describe('Row cap'),
      filter: z.string().optional().describe('Name/command filter'),
      preview: z.boolean().optional().describe('Preview the kill'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshProcessManager({
    getConnection,
    args: { ...args, sort_by: args.sort_by || args.sortBy }
  })
);

registerToolConditional(
  'ssh_alert_setup',
  {
    description: 'Configure health monitoring alerts and thresholds',
    inputSchema: {
      server: z.string().describe('Server name'),
      action: z.enum(['set', 'get', 'check'])
        .describe('Action: set thresholds, get config, or check current metrics against thresholds'),
      cpuThreshold: z.number().optional()
        .describe('CPU usage threshold percentage (e.g., 80)'),
      memoryThreshold: z.number().optional()
        .describe('Memory usage threshold percentage (e.g., 90)'),
      diskThreshold: z.number().optional()
        .describe('Disk usage threshold percentage (e.g., 85)'),
      enabled: z.boolean().optional()
        .describe('Enable or disable alerts (default: true)')
    }
  },
  async ({ server: serverName, action, cpuThreshold, memoryThreshold, diskThreshold, enabled = true }) => {
    try {
      const ssh = await getConnection(serverName);
      const configPath = '/etc/ssh-manager-alerts.json';

      logger.info(`Alert setup action: ${action}`, {
        server: serverName
      });

      let response;

      switch (action) {
      case 'set': {
        // Create alert configuration
        const config = createAlertConfig({
          cpu: cpuThreshold,
          memory: memoryThreshold,
          disk: diskThreshold,
          enabled
        });

        // Save to server
        const saveCommand = buildSaveAlertConfigCommand(config, configPath);
        const saveResult = await ssh.execCommand(saveCommand);

        if (saveResult.code !== 0) {
          throw new Error(`Failed to save alert config: ${saveResult.stderr}`);
        }

        response = {
          server: serverName,
          action: 'set',
          config,
          config_path: configPath,
          success: true
        };

        logger.info('Alert thresholds configured', {
          server: serverName,
          thresholds: config
        });
        break;
      }

      case 'get': {
        // Load configuration
        const loadCommand = buildLoadAlertConfigCommand(configPath);
        const result = await ssh.execCommand(loadCommand);

        let config = {};
        if (result.stdout && result.stdout.trim()) {
          try {
            config = JSON.parse(result.stdout);
          } catch (e) {
            config = { error: 'Failed to parse config' };
          }
        }

        response = {
          server: serverName,
          action: 'get',
          config,
          config_path: configPath
        };
        break;
      }

      case 'check': {
        // Load thresholds
        const loadCommand = buildLoadAlertConfigCommand(configPath);
        const loadResult = await ssh.execCommand(loadCommand);

        let thresholds = {};
        if (loadResult.stdout && loadResult.stdout.trim()) {
          try {
            thresholds = JSON.parse(loadResult.stdout);
          } catch (e) {
            throw new Error('No alert configuration found. Use action=set to configure.');
          }
        } else {
          throw new Error('No alert configuration found. Use action=set to configure.');
        }

        if (!thresholds.enabled) {
          response = {
            server: serverName,
            action: 'check',
            message: 'Alerts are disabled',
            thresholds
          };
          break;
        }

        // Get current metrics
        const healthCommand = buildComprehensiveHealthCheckCommand();
        const healthResult = await ssh.execCommand(healthCommand);

        if (healthResult.code !== 0) {
          throw new Error('Failed to get current metrics');
        }

        const metrics = parseComprehensiveHealthCheck(healthResult.stdout);

        // Check thresholds
        const alerts = checkAlertThresholds(metrics, thresholds);

        response = {
          server: serverName,
          action: 'check',
          thresholds,
          current_metrics: {
            cpu: metrics.cpu,
            memory: metrics.memory,
            disks: metrics.disks
          },
          alerts,
          alert_count: alerts.length,
          status: alerts.length === 0 ? 'ok' : 'alerts_triggered'
        };

        if (alerts.length > 0) {
          logger.warn('Health alerts triggered', {
            server: serverName,
            alert_count: alerts.length,
            alerts
          });
        }
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };

    } catch (error) {
      logger.error('Alert setup failed', {
        server: serverName,
        action,
        error: error.message
      });

      return {
        content: [
          {
            type: 'text',
            text: `❌ Alert setup failed: ${error.message}`
          }
        ]
      };
    }
  }
);

// ============================================================================
// DATABASE MANAGEMENT TOOLS
// ============================================================================

registerToolConditional(
  'ssh_db_dump',
  {
    description: 'Dump database (password via env, never argv)',
    inputSchema: {
      server: z.string().describe('Server name'),
      db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('DB type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Alias'),
      database: z.string().describe('Database name'),
      output_file: z.string().optional().describe('Output path'),
      outputFile: z.string().optional().describe('Output path (alias)'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      gzip: z.boolean().optional().describe('Gzip output'),
      compress: z.boolean().optional().describe('Alias for gzip'),
      tables: z.array(z.string()).optional().describe('Specific tables'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshDbDump({
    getConnection,
    args: {
      ...args,
      db_type: args.db_type || args.type,
      output_file: args.output_file || args.outputFile,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
      gzip: args.gzip ?? args.compress,
    }
  })
);

registerToolConditional(
  'ssh_db_import',
  {
    description: 'Import DB (preview-capable, high-risk guardrails)',
    inputSchema: {
      server: z.string().describe('Server name'),
      db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('DB type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Alias'),
      database: z.string().describe('Target database'),
      input_file: z.string().optional().describe('Input path'),
      inputFile: z.string().optional().describe('Input path (alias)'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      drop: z.boolean().optional().describe('Drop existing before import (Mongo)'),
      preview: z.boolean().optional().describe('Show plan without importing'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshDbImport({
    getConnection,
    args: {
      ...args,
      db_type: args.db_type || args.type,
      input_file: args.input_file || args.inputFile,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
    }
  })
);

registerToolConditional(
  'ssh_db_list',
  {
    description: 'List databases or tables/collections (typed)',
    inputSchema: {
      server: z.string().describe('Server name'),
      db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('DB type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Alias'),
      database: z.string().optional().describe('DB (lists tables) or omit for databases'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshDbList({
    getConnection,
    args: {
      ...args,
      db_type: args.db_type || args.type,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
    }
  })
);

registerToolConditional(
  'ssh_db_query',
  {
    description: 'Execute SELECT query (token-level SQL safety, no substring matching)',
    inputSchema: {
      server: z.string().describe('Server name'),
      db_type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('DB type'),
      type: z.enum(['mysql', 'postgresql', 'mongodb']).optional().describe('Alias'),
      database: z.string().describe('Database name'),
      query: z.string().describe('SELECT-only SQL or Mongo find'),
      collection: z.string().optional().describe('Collection (MongoDB)'),
      user: z.string().optional().describe('DB user'),
      dbUser: z.string().optional().describe('DB user (alias)'),
      password: z.string().optional().describe('DB password'),
      dbPassword: z.string().optional().describe('DB password (alias)'),
      host: z.string().optional().describe('DB host'),
      dbHost: z.string().optional().describe('DB host (alias)'),
      port: z.number().optional().describe('DB port'),
      dbPort: z.number().optional().describe('DB port (alias)'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format')
    }
  },
  async (args) => handleSshDbQuery({
    getConnection,
    args: {
      ...args,
      db_type: args.db_type || args.type,
      user: args.user || args.dbUser,
      password: args.password || args.dbPassword,
      host: args.host || args.dbHost,
      port: args.port || args.dbPort,
    }
  })
);

// Clean up connections on shutdown
process.on('SIGINT', async () => {
  console.error('\n🔌 Closing SSH connections...');
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

  console.error('🚀 MCP SSH Manager Server started');
  console.error(`📦 Profile: ${activeProfile}`);
  console.error(`🖥️  Available servers: ${serverList.length > 0 ? serverList.join(', ') : 'none configured'}`);
  console.error('💡 Use server-manager.py to configure servers');
  console.error('🔄 Connection management: Auto-reconnect enabled, 30min timeout');

  // Set up periodic cleanup of old connections (every 10 minutes)
  setInterval(() => {
    cleanupOldConnections();
  }, 10 * 60 * 1000);
}

main().catch(console.error);
