#!/usr/bin/env node
/**
 * Tests for src/tools/db-tools.js. Uses the same FakeClient pattern as the
 * other tool tests — exec is intercepted so we can assert on the exact
 * command that would run without ever touching a real database.
 */

import assert from 'assert';
import { EventEmitter } from 'events';
import {
  handleSshDbQuery,
  handleSshDbList,
  handleSshDbDump,
  handleSshDbImport,
  buildMySqlQueryCommand,
  buildPostgresQueryCommand,
  buildMongoQueryCommand,
} from '../src/tools/db-tools.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}

// ─── Fake ssh2 client ────────────────────────────────────────────────────
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.writes = []; this.endCalls = 0; }
  write(d) { this.writes.push(String(d)); return true; }
  end() { this.endCalls++; }
  signal() {}
  close() { setImmediate(() => this.emit('close', null, 'TERM')); }
}
class FakeClient {
  constructor({ script } = {}) {
    this.script = script || (() => ({ stdout: '', stderr: '', code: 0 }));
    this.streams = [];
    this.commands = [];
  }
  exec(cmd, cb) {
    this.commands.push(cmd);
    const s = new FakeStream();
    this.streams.push(s);
    setImmediate(() => {
      cb(null, s);
      const { stdout = '', stderr = '', code = 0 } = this.script(cmd, this.commands.length);
      setImmediate(() => {
        if (stdout) s.emit('data', Buffer.from(stdout));
        if (stderr) s.stderr.emit('data', Buffer.from(stderr));
        s.emit('close', code);
      });
    });
  }
  get lastCommand() { return this.commands[this.commands.length - 1]; }
}

console.log('🧪 Testing db-tools\n');

// ──────────────────────────────────────────────────────────────────────────
// Command-builder unit tests (no I/O)
// ──────────────────────────────────────────────────────────────────────────
await test('buildMySqlQueryCommand: uses MYSQL_PWD env, NOT -p argv', () => {
  const cmd = buildMySqlQueryCommand({ database: 'app', query: 'SELECT 1', user: 'alice' });
  assert(cmd.startsWith('MYSQL_PWD='), `expected MYSQL_PWD prefix, got: ${cmd}`);
  assert(cmd.includes('mysql'));
  assert(!cmd.includes('-p'), `password flag must NOT appear, got: ${cmd}`);
  assert(cmd.includes("-D 'app'"));
  assert(cmd.includes("'SELECT 1'"));
});

await test('buildPostgresQueryCommand: uses PGPASSWORD env, NOT password in argv', () => {
  const cmd = buildPostgresQueryCommand({ database: 'app', query: 'SELECT 1', user: 'alice' });
  assert(cmd.startsWith('PGPASSWORD='));
  assert(cmd.includes('psql'));
  // psql password arg `-W` would trigger a prompt; `-w` means no-password — neither should appear with a value.
  // But we should not have any flag that carries a literal password.
  assert(!/--password\s*=?\s*\S/.test(cmd), 'psql --password flag must NOT carry a value');
  assert(cmd.includes("-U 'alice'"));
  assert(cmd.includes("-d 'app'"));
});

await test('buildMongoQueryCommand: escapes eval snippet', () => {
  const cmd = buildMongoQueryCommand({
    database: 'app',
    query: "db.users.find({name: \"O'Brien\"}).toArray()",
  });
  assert(cmd.startsWith('mongosh'));
  assert(cmd.includes("'app'"));
  // Single quotes inside the query get POSIX-escaped: '\''
  assert(cmd.includes("'\\''"), 'single-quote inside eval must be POSIX-escaped');
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbQuery — safety
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_query: isSafeSelect rejection → structured fail, NO remote call', async () => {
  let called = false;
  const r = await handleSshDbQuery({
    getConnection: async () => { called = true; throw new Error('must not connect'); },
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'DROP TABLE users',
      format: 'json',
    },
  });
  assert.strictEqual(called, false, 'getConnection must NOT be called for unsafe query');
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('unsafe query') || parsed.error.toLowerCase().includes('must start with'));
  assert.strictEqual(r.isError, true);
});

await test('ssh_db_query: `SELECT deleted_at FROM t` is accepted (old impl would falsely reject)', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'deleted_at\n2024-01-01\n', code: 0 }) });
  const r = await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT deleted_at FROM audit_log',
      password: 'secret',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, JSON.stringify(parsed));
  assert.deepStrictEqual(parsed.data.columns, ['deleted_at']);
  assert.strictEqual(parsed.data.row_count, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbQuery — credential handling
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_query: MySQL password goes via MYSQL_PWD env, never argv', async () => {
  const secret = "pw-with-'quotes-and-$chars";
  const client = new FakeClient({ script: () => ({ stdout: 'id\n1\n', code: 0 }) });
  await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT id FROM t',
      user: 'alice',
      password: secret,
      format: 'json',
    },
  });
  const cmd = client.lastCommand;
  // Secret must be present (as env-var value) but NOT in the mysql arg stream.
  assert(cmd.includes('MYSQL_PWD='), cmd);
  assert(cmd.includes('mysql'), cmd);
  // The mysql binary should not be called with -p<secret> or --password=<secret>.
  assert(!/mysql\s[^|]*-p(?!\s)/.test(cmd), `mysql must not receive -p flag: ${cmd}`);
  assert(!cmd.includes('--password='), cmd);
});

await test('ssh_db_query: PostgreSQL password goes via PGPASSWORD env, never argv', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'id\n1\n', code: 0 }) });
  await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'postgresql', database: 'app',
      query: 'SELECT id FROM t',
      user: 'alice',
      password: 'super-secret',
      format: 'json',
    },
  });
  const cmd = client.lastCommand;
  assert(cmd.includes('PGPASSWORD='), cmd);
  assert(cmd.includes('psql'), cmd);
  // psql must not receive a literal password in argv
  assert(!/psql[^|]*--password=\S/.test(cmd), `psql must not receive --password=: ${cmd}`);
});

await test('ssh_db_query: MongoDB eval properly escaped for POSIX shell', async () => {
  const client = new FakeClient({ script: () => ({ stdout: '[]\n', code: 0 }) });
  await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mongodb', database: 'app',
      query: "db.users.find({name: 'alice'}).toArray()",
      format: 'json',
    },
  });
  const cmd = client.lastCommand;
  assert(cmd.includes('mongosh'));
  // Single-quotes embedded in the query must be POSIX-escaped so the shell doesn't break.
  assert(cmd.includes("'\\''"), `expected POSIX escape, got: ${cmd}`);
});

await test('ssh_db_query: Mongo eval rejects obvious mutations', async () => {
  let called = false;
  const r = await handleSshDbQuery({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: {
      server: 's', db_type: 'mongodb', database: 'app',
      query: 'db.users.deleteMany({})',
      format: 'json',
    },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('unsafe mongo eval'));
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbQuery — LIMIT behaviour
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_query: auto-appends LIMIT when absent', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'id\n1\n', code: 0 }) });
  await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT id FROM t',
      limit: 500,
      format: 'json',
    },
  });
  assert(client.lastCommand.includes('LIMIT 500'), client.lastCommand);
});

await test('ssh_db_query: does not double-append LIMIT if already present', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'id\n1\n', code: 0 }) });
  await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT id FROM t LIMIT 10',
      limit: 500,
      format: 'json',
    },
  });
  const cmd = client.lastCommand;
  // Only one LIMIT occurrence
  const matches = cmd.match(/LIMIT/g) || [];
  assert.strictEqual(matches.length, 1, `expected one LIMIT, got ${matches.length}: ${cmd}`);
});

await test('ssh_db_query: rejects when declared LIMIT exceeds cap', async () => {
  let called = false;
  const r = await handleSshDbQuery({
    getConnection: async () => { called = true; throw new Error('no'); },
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT id FROM t LIMIT 999999',
      limit: 1000,
      format: 'json',
    },
  });
  assert.strictEqual(called, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, false);
  assert(parsed.error.includes('exceeds cap'));
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbQuery — result parsing
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_query: TSV result parses into {columns, rows}', async () => {
  const tsv = 'id\tname\tactive\n1\talice\t1\n2\tbob\t0\n';
  const client = new FakeClient({ script: () => ({ stdout: tsv, code: 0 }) });
  const r = await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT id, name, active FROM users',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(parsed.data.columns, ['id', 'name', 'active']);
  assert.strictEqual(parsed.data.row_count, 2);
  assert.deepStrictEqual(parsed.data.rows[0], ['1', 'alice', '1']);
  assert.deepStrictEqual(parsed.data.rows[1], ['2', 'bob', '0']);
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbList
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_list: MySQL lists databases (filters system dbs)', async () => {
  const stdout = 'information_schema\nmysql\nperformance_schema\nsys\napp\nanalytics\n';
  const client = new FakeClient({ script: () => ({ stdout, code: 0 }) });
  const r = await handleSshDbList({
    getConnection: async () => client,
    args: { server: 's', db_type: 'mysql', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(parsed.data.databases, ['app', 'analytics']);
});

await test('ssh_db_list: PostgreSQL lists tables when database given', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'users\norders\n', code: 0 }) });
  const r = await handleSshDbList({
    getConnection: async () => client,
    args: { server: 's', db_type: 'postgresql', database: 'app', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(parsed.data.tables, ['users', 'orders']);
});

await test('ssh_db_list: MongoDB lists collections when database given', async () => {
  const client = new FakeClient({ script: () => ({ stdout: 'users\nsessions\nevents\n', code: 0 }) });
  const r = await handleSshDbList({
    getConnection: async () => client,
    args: { server: 's', db_type: 'mongodb', database: 'app', format: 'json' },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(parsed.data.collections, ['users', 'sessions', 'events']);
  assert.strictEqual(parsed.data.db_type, 'mongodb');
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbDump
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_dump: preview shows estimated size + target path', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      // First call is the size estimate
      if (cmd.includes('information_schema.tables')) {
        return { stdout: '524288\n', code: 0 };
      }
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshDbDump({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      output_path: '/tmp/app.sql.gz',
      preview: true,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.data.preview, true);
  const plan = parsed.data.plan;
  assert.strictEqual(plan.action, 'db-dump');
  assert(plan.target.includes('/tmp/app.sql.gz'));
  assert.strictEqual(plan.estimated_bytes, 524288);
  // Effects mention size
  assert(plan.effects.some(e => e.includes('512.0 KB') || e.includes('estimated size')));
});

await test('ssh_db_dump: gzip default wraps with `| gzip`', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.includes('mysqldump')) return { stdout: '', code: 0 };
      if (cmd.includes('stat')) return { stdout: '12345\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshDbDump({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      output_path: '/tmp/app.sql.gz',
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true, JSON.stringify(parsed));
  // The dump command should include `| gzip > /tmp/app.sql.gz`
  const dumpCmd = client.commands.find(c => c.includes('mysqldump'));
  assert(dumpCmd, 'mysqldump command must have run');
  assert(dumpCmd.includes('| gzip >'), `expected gzip pipe, got: ${dumpCmd}`);
  assert.strictEqual(parsed.data.gzipped, true);
  assert.strictEqual(parsed.data.bytes_written, 12345);
});

await test('ssh_db_dump: gzip:false omits compression', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.includes('mysqldump')) return { stdout: '', code: 0 };
      if (cmd.includes('stat')) return { stdout: '9999\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  await handleSshDbDump({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      output_path: '/tmp/app.sql',
      gzip: false,
      format: 'json',
    },
  });
  const dumpCmd = client.commands.find(c => c.includes('mysqldump'));
  assert(!dumpCmd.includes('gzip'), `gzip should be absent: ${dumpCmd}`);
});

// ──────────────────────────────────────────────────────────────────────────
// handleSshDbImport
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_import: preview warns about overwrite when tables exist', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.includes('stat')) return { stdout: '104857600\n', code: 0 }; // 100 MB
      if (cmd.includes('information_schema.tables')) return { stdout: '42\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshDbImport({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      input_path: '/tmp/backup.sql.gz',
      preview: true,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  assert.strictEqual(parsed.success, true);
  const plan = parsed.data.plan;
  assert.strictEqual(plan.risk, 'high');
  assert.strictEqual(plan.input_bytes, 104857600);
  assert.strictEqual(plan.existing_table_count, 42);
  const warning = plan.effects.find(e => e.toLowerCase().includes('overwrite'));
  assert(warning, `expected overwrite warning, got effects: ${JSON.stringify(plan.effects)}`);
  assert(warning.includes('42'));
});

await test('ssh_db_import: preview handles empty database (no overwrite warning)', async () => {
  const client = new FakeClient({
    script: (cmd) => {
      if (cmd.includes('stat')) return { stdout: '1024\n', code: 0 };
      if (cmd.includes('information_schema.tables')) return { stdout: '0\n', code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const r = await handleSshDbImport({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'newdb',
      input_path: '/tmp/backup.sql',
      preview: true,
      format: 'json',
    },
  });
  const parsed = JSON.parse(r.content[0].text);
  const plan = parsed.data.plan;
  const warning = plan.effects.find(e => e.toLowerCase().includes('overwrite'));
  assert(!warning, 'no overwrite warning expected for empty db');
});

// ──────────────────────────────────────────────────────────────────────────
// Error paths
// ──────────────────────────────────────────────────────────────────────────
await test('ssh_db_query: connection failure → isError', async () => {
  const r = await handleSshDbQuery({
    getConnection: async () => { throw new Error('ssh host unreachable'); },
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT 1',
    },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('ssh host unreachable'));
});

await test('ssh_db_list: connection failure → isError', async () => {
  const r = await handleSshDbList({
    getConnection: async () => { throw new Error('ECONNREFUSED'); },
    args: { server: 's', db_type: 'mysql' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('ECONNREFUSED'));
});

await test('ssh_db_dump: connection failure → isError', async () => {
  const r = await handleSshDbDump({
    getConnection: async () => { throw new Error('timeout'); },
    args: { server: 's', db_type: 'mysql', database: 'app' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('timeout'));
});

await test('ssh_db_import: connection failure → isError', async () => {
  const r = await handleSshDbImport({
    getConnection: async () => { throw new Error('no route to host'); },
    args: { server: 's', db_type: 'mysql', database: 'app', input_path: '/tmp/x.sql' },
  });
  assert.strictEqual(r.isError, true);
  assert(r.content[0].text.includes('no route to host'));
});

await test('ssh_db_query: non-zero exit → isError with stderr', async () => {
  const client = new FakeClient({
    script: () => ({ stdout: '', stderr: 'ERROR 1045: Access denied', code: 1 }),
  });
  const r = await handleSshDbQuery({
    getConnection: async () => client,
    args: {
      server: 's', db_type: 'mysql', database: 'app',
      query: 'SELECT 1',
      format: 'json',
    },
  });
  assert.strictEqual(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert(parsed.error.includes('Access denied'));
});

// ──────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
