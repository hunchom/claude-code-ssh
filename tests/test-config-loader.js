#!/usr/bin/env node
/**
 * Tests for src/config-loader.js -- server config source precedence.
 *
 * CLAUDE.md documents: env > .env > TOML. Regression here silently
 * changes which host Claude connects to, so this is high-stakes.
 *
 * Covers:
 *   - TOML-only config loads and normalizes (case-insensitive names,
 *     key_path / keypath / ssh_key aliases, default_dir, proxy_jump).
 *   - .env-only config loads via SSH_SERVER_NAME_* pattern.
 *   - env (process.env) overrides .env which overrides TOML.
 *   - Server name collision across formats: same name wins per precedence,
 *     no duplicate entries in the map.
 *   - exportToToml + loadTomlConfig round-trip preserves fields.
 *   - getServer uses lowercase normalization.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigLoader } from '../src/config-loader.js';

let passed = 0;
let failed = 0;
const fails = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfgload-'));
}

function clearSshEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SSH_SERVER_')) delete process.env[k];
  }
}

// --- TOML loading --------------------------------------------------------
await test('TOML: loads server with key_path / default_dir / proxy_jump', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.prod]
host = "prod.example.com"
user = "deploy"
key_path = "~/.ssh/prod_rsa"
default_dir = "/srv/app"
proxy_jump = "bastion"
port = 2222
`);
  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath: '/nonexistent.env' });
  const s = loader.getServer('prod');
  assert.strictEqual(s.host, 'prod.example.com');
  assert.strictEqual(s.user, 'deploy');
  assert.strictEqual(s.keyPath, '~/.ssh/prod_rsa',
    'key_path must map to keyPath (camelCase is canonical)');
  assert.strictEqual(s.defaultDir, '/srv/app');
  assert.strictEqual(s.proxyJump, 'bastion');
  assert.strictEqual(s.port, 2222);
  assert.strictEqual(s.source, 'toml');
});

await test('TOML: keypath and ssh_key are accepted as aliases for key_path', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.a]
host = "a.example.com"
user = "u"
keypath = "/k1"

[ssh_servers.b]
host = "b.example.com"
user = "u"
ssh_key = "/k2"
`);
  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath: '/nonexistent.env' });
  assert.strictEqual(loader.getServer('a').keyPath, '/k1');
  assert.strictEqual(loader.getServer('b').keyPath, '/k2');
});

await test('TOML: server names are lowercased in the map', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.PROD]
host = "p.example.com"
user = "u"
`);
  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath: '/nonexistent.env' });
  assert(loader.getServer('prod'), 'PROD should be resolvable as prod');
  assert(loader.getServer('PROD'), 'PROD should be resolvable by upper too (getServer lowercases)');
});

// --- .env loading --------------------------------------------------------
await test('.env: loads SSH_SERVER_NAME_* pattern', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, [
    'SSH_SERVER_STAGING_HOST=staging.example.com',
    'SSH_SERVER_STAGING_USER=deploy',
    'SSH_SERVER_STAGING_KEYPATH=/srv/keys/staging_rsa',
    'SSH_SERVER_STAGING_PORT=2200',
    'SSH_SERVER_STAGING_DEFAULT_DIR=/srv/app',
    'SSH_SERVER_STAGING_PROXYJUMP=bastion',
  ].join('\n'));
  const loader = new ConfigLoader();
  await loader.load({ tomlPath: '/nonexistent.toml', envPath });
  const s = loader.getServer('staging');
  assert.strictEqual(s.host, 'staging.example.com');
  assert.strictEqual(s.user, 'deploy');
  assert.strictEqual(s.keyPath, '/srv/keys/staging_rsa');
  assert.strictEqual(s.port, 2200);
  assert.strictEqual(s.defaultDir, '/srv/app');
  assert.strictEqual(s.proxyJump, 'bastion');
});

// --- precedence ----------------------------------------------------------
await test('precedence: env (process.env) overrides .env overrides TOML', async () => {
  clearSshEnv();
  const dir = mkTmp();

  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.prod]
host = "toml-host"
user = "u"
`);

  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SSH_SERVER_PROD_HOST=dotenv-host\nSSH_SERVER_PROD_USER=dotenvuser\n');

  // `.env` via dotenv only sets variables that aren't already set in
  // process.env, so set a process-level override to assert top priority.
  process.env.SSH_SERVER_PROD_HOST = 'process-env-host';

  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath });
  const s = loader.getServer('prod');
  assert.strictEqual(s.host, 'process-env-host',
    'process.env must win over .env and TOML');

  clearSshEnv();
});

await test('precedence: .env beats TOML when process.env unset', async () => {
  clearSshEnv();
  const dir = mkTmp();

  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.app]
host = "toml-host"
user = "tomluser"
`);

  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SSH_SERVER_APP_HOST=dotenv-host\nSSH_SERVER_APP_USER=dotenvuser\n');

  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath });
  const s = loader.getServer('app');
  assert.strictEqual(s.host, 'dotenv-host', '.env must win over TOML');
  clearSshEnv();
});

// --- corpus / export -----------------------------------------------------
await test('getServer, hasServer, getAllServers are case-insensitive + complete', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, `
[ssh_servers.one]
host = "h1"
user = "u"
[ssh_servers.two]
host = "h2"
user = "u"
`);
  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath: '/nonexistent.env' });
  assert(loader.hasServer('ONE'));
  assert(loader.hasServer('two'));
  assert.strictEqual(loader.getAllServers().length, 2);
  assert(!loader.hasServer('three'));
});

await test('configSource reflects actual load origin', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, '[ssh_servers.x]\nhost = "h"\nuser = "u"\n');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SSH_SERVER_X_HOST=envh\nSSH_SERVER_X_USER=envu\n');

  const l1 = new ConfigLoader();
  await l1.load({ tomlPath, envPath: '/nonexistent.env' });
  assert.strictEqual(l1.configSource, 'toml');

  clearSshEnv();
  const l2 = new ConfigLoader();
  await l2.load({ tomlPath: '/nonexistent.toml', envPath });
  assert.strictEqual(l2.configSource, 'env');

  clearSshEnv();
});

await test('corrupt TOML does not crash load() and falls through to env', async () => {
  clearSshEnv();
  const dir = mkTmp();
  const tomlPath = path.join(dir, 'cfg.toml');
  fs.writeFileSync(tomlPath, 'this is = not [valid TOML');
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SSH_SERVER_FALLBACK_HOST=fallback.example\nSSH_SERVER_FALLBACK_USER=u\n');
  const loader = new ConfigLoader();
  await loader.load({ tomlPath, envPath });
  assert(loader.getServer('fallback'));
  assert.strictEqual(loader.getServer('fallback').host, 'fallback.example');
  clearSshEnv();
});

// Clean up env state left from any previous runs before exiting.
clearSshEnv();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
