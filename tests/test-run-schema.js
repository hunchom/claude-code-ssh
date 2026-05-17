#!/usr/bin/env node
/**
 * Pins the ssh_run inputSchema in src/index.js: the four Plan-5 actions
 * (script, detach, job-status, job-kill) and their args must be advertised,
 * else a client cannot invoke what the dispatcher now handles.
 * Run: node tests/test-run-schema.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

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

// Isolate the registerToolConditional('ssh_run', { ... }) block.
function runBlock(src) {
  const start = src.indexOf("registerToolConditional('ssh_run'");
  assert(start !== -1, 'ssh_run registration found');
  // up to the handler arrow that closes the schema object
  const end = src.indexOf('}, async (args) => handleSshRun', start);
  assert(end !== -1, 'ssh_run handler boundary found');
  return src.slice(start, end);
}

console.log('[test] Testing ssh_run inputSchema\n');

await test('action enum advertises all seven actions', () => {
  const block = runBlock(indexSrc);
  for (const act of ['exec', 'sudo', 'fleet', 'script', 'detach', 'job-status', 'job-kill']) {
    assert(block.includes(`'${act}'`), `action enum missing '${act}'`);
  }
});

await test('commands arg is declared for the script action', () => {
  const block = runBlock(indexSrc);
  assert(/commands:\s*z\.array\(z\.string\(\)\)/.test(block),
    'commands should be an optional string array');
});

await test('isolate arg is declared', () => {
  assert(/isolate:\s*z\.boolean\(\)/.test(runBlock(indexSrc)),
    'isolate should be an optional boolean');
});

await test('job_id arg is declared for detach / job-status / job-kill', () => {
  assert(/job_id:\s*z\.string\(\)/.test(runBlock(indexSrc)),
    'job_id should be an optional string');
});

await test('since_offset arg is declared for job-status', () => {
  assert(/since_offset:\s*z\.number\(\)/.test(runBlock(indexSrc)),
    'since_offset should be an optional number');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
