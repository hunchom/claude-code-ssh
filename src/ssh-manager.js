import { Client } from 'ssh2';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import crypto from 'crypto';
import { isHostKnown, getCurrentHostKey, addHostKey, updateHostKey } from './ssh-key-manager.js';
import { configLoader } from './config-loader.js';
import { logger } from './logger.js';

class SSHManager {
  constructor(config) {
    this.config = config;
    this.client = new Client();
    this.connected = false;
    this._sftpHandle = null; // cached SFTP subsystem; do not collide with sftp() passthrough
    this.cachedHomeDir = null;
    this.autoAcceptHostKey = config.autoAcceptHostKey || false;
    this.hostKeyVerification = config.hostKeyVerification !== false; // Default true
    this.jumpConnection = null;
  }

  async connect(options = {}) {
    return new Promise((resolve, reject) => {
      this.client.on('ready', () => {
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err) => {
        this.connected = false;
        reject(err);
      });

      this.client.on('end', () => {
        this.connected = false;
      });

      // Build connection config
      const connConfig = {
        host: this.config.host,
        port: this.config.port || 22,
        username: this.config.user,
        readyTimeout: 60000, // Increased from 20000 to 60000 for slow connections
        keepaliveInterval: 10000,
        // Add compatibility options for problematic servers
        algorithms: {
          kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm', 'aes256-gcm', 'aes128-cbc', 'aes192-cbc', 'aes256-cbc'],
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519'],
          hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1']
        },
        debug: (info) => {
          if (info.includes('Handshake') || info.includes('error')) {
            logger.debug('SSH2 Debug', { info });
          }
        }
      };

      // Host key verification. ssh2 passes the raw SSH-wire-format public key
      // as a Buffer. We SHA256 it and compare against known_hosts entries,
      // which getCurrentHostKey also stores as base64-encoded SHA256 of the
      // same bytes. Behavior:
      //   - host is known and fingerprint matches one on file -> accept.
      //   - host is known but fingerprint does NOT match       -> REJECT
      //     (possible MITM or legitimate key rotation; user must manually
      //     remove the stale entry via ssh-keygen -R to re-pin).
      //   - host is not known                                  -> accept +
      //     record (TOFU). If SSH_STRICT_HOSTS=1 is set in the environment,
      //     unknown hosts are rejected instead.
      if (this.hostKeyVerification) {
        connConfig.hostVerifier = (key) => {
          const port = this.config.port || 22;
          const host = this.config.host;

          const presented = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

          if (isHostKnown(host, port)) {
            const stored = getCurrentHostKey(host, port) || [];
            const match = stored.some(s => {
              const norm = (s.fingerprint || '').replace(/=+$/, '');
              return norm === presented;
            });
            if (match) {
              logger.info('Host key verified', { host, port, fingerprint: presented });
              return true;
            }
            logger.error('HOST KEY MISMATCH -- possible MITM or key rotation', {
              host, port,
              presented,
              stored: stored.map(s => s.fingerprint)
            });
            return false;
          }

          // Unknown host. Strict mode rejects; default is TOFU.
          if (process.env.SSH_STRICT_HOSTS === '1') {
            logger.error('Unknown host rejected (SSH_STRICT_HOSTS=1)', { host, port, presented });
            return false;
          }

          logger.warn('TOFU: recording host key on first connect', { host, port, presented });
          setImmediate(async () => {
            try { await addHostKey(host, port); logger.info('Host key recorded', { host, port }); }
            catch (err) { logger.warn('Failed to record host key', { host, port, error: err.message }); }
          });
          return true;
        };
      }

      // Use ssh-agent if available (handles passphrase-protected keys transparently)
      if (process.env.SSH_AUTH_SOCK) {
        connConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      // Add authentication (support both keyPath and keypath for compatibility)
      const keyPath = this.config.keyPath || this.config.keypath;
      if (keyPath) {
        const resolvedKeyPath = keyPath.replace('~', os.homedir());
        connConfig.privateKey = fs.readFileSync(resolvedKeyPath);
        if (this.config.passphrase) {
          connConfig.passphrase = this.config.passphrase;
        }
      } else if (this.config.password) {
        connConfig.password = this.config.password;
      }

      // Use provided stream for proxy jump connections
      if (options.sock) {
        connConfig.sock = options.sock;
      }

      this.client.connect(connConfig);
    });
  }

  // Pass-throughs to the underlying ssh2 Client. Modular tool handlers
  // (transfer-tools, deploy-tools, stream-exec, tail-tools) expect the
  // node-ssh2 Client surface (.exec, .sftp, .forwardOut), but
  // getConnection() returns this SSHManager wrapper. Without these
  // shims every exec/sftp call fails with "client.{exec,sftp} is not a function".
  exec(command, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    return opts !== undefined
      ? this.client.exec(command, opts, cb)
      : this.client.exec(command, cb);
  }

  sftp(cb) {
    return this.client.sftp(cb);
  }

  async execCommand(command, options = {}) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    const { timeout = 30000, cwd, rawCommand = false } = options;
    const fullCommand = (cwd && !rawCommand) ? `cd ${cwd} && ${command}` : command;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let completed = false;
      let stream = null;
      let timeoutId = null;

      // Setup timeout first
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          if (!completed) {
            completed = true;

            // Try multiple ways to kill the stream
            if (stream) {
              try {
                stream.write('\x03'); // Send Ctrl+C
                stream.end();
                stream.destroy();
              } catch (e) {
                // Ignore errors
              }
            }

            // Kill the entire client connection as last resort
            try {
              this.client.end();
              this.connected = false;
            } catch (e) {
              // Ignore errors
            }

            reject(new Error(`Command timeout after ${timeout}ms: ${command.substring(0, 100)}...`));
          }
        }, timeout);
      }

      this.client.exec(fullCommand, (err, streamObj) => {
        if (err) {
          completed = true;
          if (timeoutId) clearTimeout(timeoutId);
          reject(err);
          return;
        }

        stream = streamObj;

        stream.on('close', (code, signal) => {
          if (!completed) {
            completed = true;
            if (timeoutId) clearTimeout(timeoutId);
            resolve({
              stdout,
              stderr,
              code: code || 0,
              signal
            });
          }
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('error', (err) => {
          if (!completed) {
            completed = true;
            if (timeoutId) clearTimeout(timeoutId);
            reject(err);
          }
        });
      });
    });
  }

  async execCommandStream(command, options = {}) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    const { cwd, onStdout, onStderr } = options;
    const fullCommand = cwd ? `cd ${cwd} && ${command}` : command;

    return new Promise((resolve, reject) => {
      this.client.exec(fullCommand, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({
            stdout,
            stderr,
            code: code || 0,
            signal,
            stream
          });
        });

        stream.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          if (onStdout) onStdout(chunk);
        });

        stream.stderr.on('data', (data) => {
          const chunk = data.toString();
          stderr += chunk;
          if (onStderr) onStderr(chunk);
        });

        stream.on('error', reject);
      });
    });
  }

  async requestShell(options = {}) {
    if (!this.connected) {
      throw new Error('Not connected to SSH server');
    }

    return new Promise((resolve, reject) => {
      this.client.shell(options, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stream);
      });
    });
  }

  async getSFTP() {
    if (this._sftpHandle) return this._sftpHandle;

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        this._sftpHandle = sftp;
        resolve(sftp);
      });
    });
  }

  async resolveHomePath() {
    if (this.cachedHomeDir) {
      return this.cachedHomeDir;
    }

    let homeDir = null;

    // Method 1: Try getent (most reliable)
    try {
      const result = await this.execCommand('getent passwd $USER | cut -d: -f6', {
        timeout: 5000,
        rawCommand: true
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // getent might not be available, try next method
    }

    // Method 2: Try env -i to get clean HOME
    try {
      const result = await this.execCommand('env -i HOME=$HOME bash -c "echo $HOME"', {
        timeout: 5000,
        rawCommand: true
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // env method failed, try next
    }

    // Method 3: Parse /etc/passwd directly
    try {
      const result = await this.execCommand('grep "^$USER:" /etc/passwd | cut -d: -f6', {
        timeout: 5000,
        rawCommand: true
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // /etc/passwd parsing failed, try last resort
    }

    // Method 4: Last resort - try cd ~ && pwd
    try {
      const result = await this.execCommand('cd ~ && pwd', {
        timeout: 5000,
        rawCommand: true
      });
      homeDir = result.stdout.trim();
      if (homeDir && homeDir.startsWith('/')) {
        this.cachedHomeDir = homeDir;
        return homeDir;
      }
    } catch (err) {
      // All methods failed
    }

    throw new Error('Unable to determine home directory on remote server');
  }

  async putFile(localPath, remotePath) {
    // SFTP doesn't resolve ~ automatically, we need to get the real path
    let resolvedRemotePath = remotePath;
    if (remotePath.includes('~')) {
      try {
        const homeDir = await this.resolveHomePath();
        // Replace ~ with the actual home directory
        // Handle both ~/path and ~ alone
        if (remotePath === '~') {
          resolvedRemotePath = homeDir;
        } else if (remotePath.startsWith('~/')) {
          resolvedRemotePath = homeDir + remotePath.substring(1);
        } else {
          // If ~ is not at the beginning, don't replace it
          resolvedRemotePath = remotePath;
        }
      } catch (err) {
        // If we can't resolve home, throw a more descriptive error
        throw new Error(`Failed to resolve home directory for path: ${remotePath}. ${err.message}`);
      }
    }

    const sftp = await this.getSFTP();
    return new Promise((resolve, reject) => {
      // Check if local file exists and is readable
      if (!fs.existsSync(localPath)) {
        reject(new Error(`Local file does not exist: ${localPath}`));
        return;
      }

      sftp.fastPut(localPath, resolvedRemotePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getFile(localPath, remotePath) {
    // SFTP doesn't resolve ~ automatically, we need to get the real path
    let resolvedRemotePath = remotePath;
    if (remotePath.includes('~')) {
      try {
        const homeDir = await this.resolveHomePath();
        // Replace ~ with the actual home directory
        // Handle both ~/path and ~ alone
        if (remotePath === '~') {
          resolvedRemotePath = homeDir;
        } else if (remotePath.startsWith('~/')) {
          resolvedRemotePath = homeDir + remotePath.substring(1);
        } else {
          // If ~ is not at the beginning, don't replace it
          resolvedRemotePath = remotePath;
        }
      } catch (err) {
        // If we can't resolve home, throw a more descriptive error
        throw new Error(`Failed to resolve home directory for path: ${remotePath}. ${err.message}`);
      }
    }

    const sftp = await this.getSFTP();
    return new Promise((resolve, reject) => {
      sftp.fastGet(resolvedRemotePath, localPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async putFiles(files, options = {}) {
    const sftp = await this.getSFTP();
    const results = [];

    for (const file of files) {
      try {
        await this.putFile(file.local, file.remote);
        results.push({ ...file, success: true });
      } catch (error) {
        results.push({ ...file, success: false, error: error.message });
        if (options.stopOnError) break;
      }
    }

    return results;
  }

  isConnected() {
    return this.connected && this.client && !this.client.destroyed;
  }

  dispose() {
    if (this._sftpHandle) {
      this._sftpHandle.end();
      this._sftpHandle = null;
    }
    if (this.client) {
      this.client.end();
      this.connected = false;
    }
  }

  // Dual-mode: callback-style (matches ssh2 Client surface used by
  // tunnel-tools.js) AND Promise-style (used by index.js for proxy jumps).
  // Detect by presence of a 5th function arg.
  forwardOut(srcAddr, srcPort, dstAddr, dstPort, cb) {
    if (typeof cb === 'function') {
      if (!this.connected) {
        return cb(new Error('Not connected to SSH server'));
      }
      return this.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, cb);
    }
    if (!this.connected) {
      return Promise.reject(new Error('Not connected to SSH server'));
    }
    return new Promise((resolve, reject) => {
      this.client.forwardOut(srcAddr, srcPort, dstAddr, dstPort, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
  }

  async ping() {
    try {
      const result = await this.execCommand('echo "ping"', { timeout: 5000 });
      return result.stdout.trim() === 'ping';
    } catch (error) {
      return false;
    }
  }
}

export default SSHManager;
