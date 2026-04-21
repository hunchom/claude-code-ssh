#!/usr/bin/env node

import SSHManager from '../src/ssh-manager.js';
import { isHostKnown, getCurrentHostKey } from '../src/ssh-key-manager.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Test configuration
const config = {
  host: process.env.SSH_SERVER_EFAJE_STAGING_HOST || '35.198.113.119',
  port: parseInt(process.env.SSH_SERVER_EFAJE_STAGING_PORT) || 14072,
  user: process.env.SSH_SERVER_EFAJE_STAGING_USER || 'efaje',
  password: process.env.SSH_SERVER_EFAJE_STAGING_PASSWORD,
  hostKeyVerification: true,
  autoAcceptHostKey: false
};

console.log('🔍 Testing SSH Host Key Verification');
console.log('=====================================');
console.log(`Server: ${config.host}:${config.port}`);
console.log('');

// Check if host is known
console.log('1️⃣  Checking if host is already known...');
const isKnown = isHostKnown(config.host, config.port);
console.log(`   Host is ${isKnown ? '✅ known' : '❌ unknown'}`);

if (isKnown) {
  console.log('');
  console.log('2️⃣  Getting stored host keys...');
  const keys = getCurrentHostKey(config.host, config.port);
  if (keys && keys.length > 0) {
    keys.forEach(key => {
      console.log(`   Type: ${key.type}`);
      console.log(`   Fingerprint: ${key.fingerprint}`);
    });
  }
}

console.log('');
console.log('3️⃣  Testing connection with host key verification...');

const ssh = new SSHManager(config);

try {
  await ssh.connect();
  console.log('   ✅ Connection successful with host key verification!');

  // Test a command
  const result = await ssh.execCommand('echo "Host key verification works!"');
  console.log(`   Command output: ${result.stdout.trim()}`);

  ssh.dispose();
  console.log('   ✅ Connection closed successfully');
} catch (error) {
  console.error(`   ❌ Connection failed: ${error.message}`);
  process.exit(1);
}

console.log('');
console.log('✅ All tests passed!');
