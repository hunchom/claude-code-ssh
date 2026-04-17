#!/usr/bin/env node
/** Tests for src/tools/backup-tools.js */
import assert from 'assert';
import { EventEmitter } from 'events';
import {
  buildBackupCommand,
  handleSshBackupCreate, handleSshBackupList, handleSshBackupRestore, handleSshBackupSchedule,
} from '../src/tools/backup-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`[ok] ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`[err] ${name}: ${e.message}`); }
}

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); }
  write() {} end() {} signal() {} close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) { this.script = script || (() => ({ stdout: '', code: 0 })); this.commands = []; this.streams = []; }
  exec(cmd, cb) {
    this.commands.push(cmd);
    const s = new FakeStream(); this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      const { stdout = '', stderr = '', code = 0 } = this.script(cmd);
      setImmediate(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code);
      });
    });
  }
}

console.log('[test] Testing backup-tools\n');

// --- buildBackupCommand -- password always via env, never argv -----------
await test('buildBackupCommand: mysql uses MYSQL_PWD env, not -p flag', () => {
  const { command, envPrefix } = buildBackupCommand({
    backup_type: 'mysql', database: 'app', user: 'root',
    password: 'sekret', outputPath: '/backups/app.sql.gz', gzip: true,
  });
  assert(envPrefix.includes('MCP_BACKUP_PASS='), 'env prefix contains pass');
  assert(envPrefix.includes("'sekret'"), 'password shQuoted in env');
  assert(!command.includes('sekret'), 'password NOT in command body');
  // No password-flag: mysqldump -p<pass> or -p <pass>. (mkdir's -p is fine -- different tool.)
  assert(!/mysqldump[^|]*\s-p[\s'"]/.test(command), 'no mysqldump -p flag with password');
  assert(command.includes('MYSQL_PWD="$MCP_BACKUP_PASS"'));
  assert(command.includes('mysqldump'));
  assert(command.includes('| gzip > '));
  assert(command.includes("/backups/app.sql.gz"));
});

await test('buildBackupCommand: postgres uses PGPASSWORD env', () => {
  const { command, envPrefix } = buildBackupCommand({
    backup_type: 'postgresql', database: 'app', user: 'postgres',
    password: 'pwd', outputPath: '/b/app.dump', gzip: false,
  });
  assert(envPrefix.includes('MCP_BACKUP_PASS='));
  assert(command.includes('PGPASSWORD="$MCP_BACKUP_PASS"'));
  assert(command.includes('pg_dump'));
  assert(!command.includes('pwd'), 'no password leakage in command');
});

await test('buildBackupCommand: mongo uses URI env, not argv', () => {
  const { command, envPrefix } = buildBackupCommand({
    backup_type: 'mongodb', database: 'app', user: 'admin',
    password: 'pass', host: '10.0.0.1', port: 27017,
    outputPath: '/b/app.archive', gzip: true,
  });
  assert(envPrefix.includes('MCP_BACKUP_URI='));
  assert(envPrefix.includes('mongodb://'));
  assert(command.includes('$MCP_BACKUP_URI'));
  assert(!command.includes('pass'), 'password NOT in argv');
});

await test('buildBackupCommand: files uses tar with shQuote', () => {
  const { command } = buildBackupCommand({
    backup_type: 'files',
    paths: ['/etc/nginx', '/var/log; rm -rf /'],
    outputPath: '/backups/etc.tar.gz',
    gzip: true,
  });
  assert(command.includes('tar -czf'));
  assert(command.includes("'/etc/nginx'"));
  // Injection attempt wrapped in quotes
  assert(command.includes("'/var/log; rm -rf /'"));
  // Ensure the dangerous substring is NOT floating free
  assert(!/\s\/var\/log;\s*rm/.test(command));
});

await test('buildBackupCommand: unsupported type throws', () => {
  assert.throws(() => buildBackupCommand({ backup_type: 'bogus', outputPath: '/tmp/x' }));
});

// --- handleSshBackupCreate -- preview ------------------------------------
await test('backup_create: preview never calls exec', async () => {
  let called = false;
  const r = await handleSshBackupCreate({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: {
      server: 'prod01', backup_type: 'files', paths: ['/etc/nginx'],
      preview: true, format: 'json',
    },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.plan.action, 'backup-create');
  assert.strictEqual(parsed.data.plan.reversibility, 'manual');
});

await test('backup_create: missing server -> fail', async () => {
  const r = await handleSshBackupCreate({
    getConnection: async () => { throw new Error('no'); },
    args: { backup_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(r.isError, true);
});

await test('backup_create: invalid backup_type -> fail', async () => {
  const r = await handleSshBackupCreate({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', backup_type: 'evil' },
  });
  assert.strictEqual(r.isError, true);
});

await test('backup_create: files type needs non-empty paths', async () => {
  const r = await handleSshBackupCreate({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's', backup_type: 'files', paths: [] },
  });
  assert.strictEqual(r.isError, true);
});

await test('backup_create: happy path generates meta + returns typed', async () => {
  // Script: dump succeeds, stat returns size, sha256sum returns a hex digest, meta write succeeds.
  const FAKE_HASH = 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd';
  const client = new FakeClient({ script: (cmd) => {
    if (cmd.includes('sha256sum')) return { stdout: `${FAKE_HASH}\n`, code: 0 };
    if (cmd.includes("stat -c '%s'")) return { stdout: '12345\n', code: 0 };
    return { stdout: '', code: 0 };
  }});
  const r = await handleSshBackupCreate({
    getConnection: async () => client,
    args: {
      server: 'prod01', backup_type: 'files', paths: ['/etc/nginx'],
      verify: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.size_bytes, 12345);
  assert.strictEqual(parsed.data.sha256, FAKE_HASH);
  assert(parsed.data.backup_id);
  assert(parsed.data.output_path);
});

// --- handleSshBackupList ------------------------------------------------
await test('backup_list: empty dir returns empty array, success', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  const r = await handleSshBackupList({
    getConnection: async () => client,
    args: { server: 's', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.count, 0);
});

await test('backup_list: parses --- separator into typed array', async () => {
  const meta1 = JSON.stringify({ backup_id: 'id1', backup_type: 'files', output_path: '/b/1.tgz', size_bytes: 100, sha256: 'h1', compressed: true, created_at: '2024-01-01T00:00:00Z', verified: true });
  const meta2 = JSON.stringify({ backup_id: 'id2', backup_type: 'mysql', output_path: '/b/2.sql', size_bytes: 200, sha256: 'h2', compressed: false, created_at: '2024-01-02T00:00:00Z', verified: false });
  const stdout = `${meta1}\n---META---\n${meta2}\n---META---\n`;
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshBackupList({
    getConnection: async () => client,
    args: { server: 's', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.data.count, 2);
  assert.strictEqual(parsed.data.backups[0].backup_id, 'id2', 'newest first');
  assert.strictEqual(parsed.data.backups[1].backup_id, 'id1');
});

// --- handleSshBackupRestore ---------------------------------------------
await test('backup_restore: missing backup_id -> fail', async () => {
  const r = await handleSshBackupRestore({
    getConnection: async () => { throw new Error('no'); },
    args: { server: 's' },
  });
  assert.strictEqual(r.isError, true);
});

await test('backup_restore: sha256 mismatch -> refuse restore', async () => {
  const meta = { backup_id: 'id1', backup_type: 'files', paths: ['/etc/x'],
    output_path: '/b/1.tgz', sha256: 'expected-hash', compressed: true };
  const metaJson = JSON.stringify(meta);
  const client = new FakeClient({ script: (cmd) => {
    if (cmd.includes('find ')) return { stdout: '/b/1.tgz.meta\n', code: 0 };
    if (cmd.startsWith('cat ')) return { stdout: metaJson, code: 0 };
    if (cmd.includes('sha256sum')) return { stdout: 'DIFFERENT-HASH\n', code: 0 };
    return { stdout: '', code: 0 };
  }});
  const r = await handleSshBackupRestore({
    getConnection: async () => client,
    args: { server: 's', backup_id: 'id1', verify: true, format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('sha256 mismatch'));
});

await test('backup_restore: preview loads meta and shows high-risk plan', async () => {
  const meta = { backup_id: 'id1', backup_type: 'files', paths: ['/etc/x'],
    output_path: '/b/1.tgz', sha256: 'hhh', compressed: true };
  const client = new FakeClient({ script: (cmd) => {
    if (cmd.includes('find ')) return { stdout: '/b/1.tgz.meta\n', code: 0 };
    if (cmd.startsWith('cat ')) return { stdout: JSON.stringify(meta), code: 0 };
    return { stdout: '', code: 0 };
  }});
  const r = await handleSshBackupRestore({
    getConnection: async () => client,
    args: { server: 's', backup_id: 'id1', preview: true, format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.plan.action, 'backup-restore');
  assert.strictEqual(parsed.data.plan.risk, 'high');
  assert.strictEqual(parsed.data.plan.expected_sha256, 'hhh');
});

await test('backup_restore: missing backup_id on server -> fail', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '', code: 0 }) });
  const r = await handleSshBackupRestore({
    getConnection: async () => client,
    args: { server: 's', backup_id: 'nonexistent', format: 'json' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('no backup found'));
});

// --- handleSshBackupSchedule --------------------------------------------
await test('backup_schedule: preview shows cron plan', async () => {
  const r = await handleSshBackupSchedule({
    getConnection: async () => { throw new Error('should not call'); },
    args: {
      server: 's', cron: '0 2 * * *',
      backup_type: 'files', paths: ['/etc'],
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert(parsed.data.plan.action.includes('schedule'));
});

await test('backup_schedule: refuses password arg for DB backups (no plaintext secret in crontab)', async () => {
  for (const dbType of ['mysql', 'postgresql', 'mongodb']) {
    const r = await handleSshBackupSchedule({
      getConnection: async () => { throw new Error('should not reach connection'); },
      args: {
        server: 's', cron: '0 2 * * *',
        backup_type: dbType, database: 'app', user: 'u', password: 'sekret',
        preview: true, format: 'json',
      },
    });
    assert.strictEqual(r.isError, true, `${dbType}: expected fail response when password present`);
    const parsed = JSON.parse(r.content[0].text);
    assert(parsed.error.includes('refusing to embed password'),
      `${dbType}: expected explicit refusal, got: ${parsed.error}`);
    // Secret must not appear anywhere in the response
    assert(!JSON.stringify(parsed).includes('sekret'),
      `${dbType}: password leaked into response`);
  }
});

await test('backup_schedule: preview for DB without password produces cron line with no secret', async () => {
  const r = await handleSshBackupSchedule({
    getConnection: async () => { throw new Error('should not call'); },
    args: {
      server: 's', cron: '30 3 * * *',
      backup_type: 'mysql', database: 'app', user: 'u',
      preview: true, format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, parsed.error);
  assert(parsed.data.plan.cron_line);
  assert(!parsed.data.plan.cron_line.includes('MCP_BACKUP_PASS='),
    'cron line must not embed password env prefix');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`); process.exit(1); }
