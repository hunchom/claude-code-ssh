#!/usr/bin/env node
// Pre-build gate for ssh-mcp v4. Measures the JSON-Schema token cost of the
// three fattest proposed v4 tools. Exits non-zero (GATE: FAIL) if any single
// tool exceeds the per-tool ceiling or the extrapolated 13-tool surface would
// not beat the current ~14k-token, 51-tool surface.
import { z } from 'zod';

// Loose sanity bound: worst measured fat tool ~394 tokens, so 800 is ~2x headroom.
const PER_TOOL_CEIL = 800;   // tokens; no single fat tool may exceed this
const SURFACE_CEIL = 14000;  // tokens; the current 51-tool surface (measured baseline)
const tokens = (o) => Math.ceil(JSON.stringify(o).length / 4);

const sshRun = z.object({
  server: z.string().describe('Server name from configuration'),
  action: z.enum(['exec', 'sudo', 'script', 'fleet', 'detach', 'job-status', 'job-kill'])
    .describe('Operation to perform'),
  command: z.string().optional().describe('Command to run (actions: exec, sudo, detach)'),
  commands: z.array(z.string()).optional().describe('Commands to chain (action: script)'),
  cwd: z.string().optional().describe('Working directory'),
  group: z.string().optional().describe('Server group name (action: fleet)'),
  job_id: z.string().optional().describe('Job id (actions: job-status, job-kill)'),
  sudo_password: z.string().optional().describe('Sudo password (action: sudo)'),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
  isolate: z.boolean().optional().describe('Run script segments in separate shells'),
  raw: z.boolean().optional().describe('Disable output compression and truncation'),
  format: z.enum(['compact', 'json', 'markdown']).optional().describe('Output format'),
});

const sshFile = z.object({
  server: z.string().describe('Server name from configuration'),
  action: z.enum(['upload', 'download', 'sync', 'read', 'write', 'edit', 'diff', 'deploy', 'deploy-artifact'])
    .describe('File operation to perform'),
  local_path: z.string().optional().describe('Local path (actions: upload, download, sync)'),
  remote_path: z.string().optional().describe('Remote path (most actions)'),
  content: z.string().optional().describe('File content to write (action: write)'),
  source: z.string().optional().describe('Sync source (action: sync)'),
  destination: z.string().optional().describe('Sync destination (action: sync)'),
  exclude: z.array(z.string()).optional().describe('Exclude patterns (action: sync)'),
  delete_extra: z.boolean().optional().describe('Delete files absent from source (action: sync)'),
  lines: z.number().optional().describe('Line count to read (action: read)'),
  old_text: z.string().optional().describe('Text to replace (action: edit)'),
  new_text: z.string().optional().describe('Replacement text (action: edit)'),
  permissions: z.string().optional().describe('chmod value such as "644" (action: deploy)'),
  owner: z.string().optional().describe('chown value such as "user:group" (action: deploy)'),
  raw: z.boolean().optional().describe('Disable output compression and truncation'),
  format: z.enum(['compact', 'json', 'markdown']).optional().describe('Output format'),
});

const sshFleet = z.object({
  server: z.string().optional().describe('Server name (actions targeting one server)'),
  action: z.enum(['servers', 'groups', 'aliases', 'profiles', 'hooks', 'keys', 'history', 'connections'])
    .describe('Fleet or config operation to perform'),
  op: z.enum(['list', 'add', 'remove', 'update']).optional().describe('Sub-operation (most actions)'),
  name: z.string().optional().describe('Entity name for group, alias, or profile'),
  members: z.array(z.string()).optional().describe('Member server names (action: groups)'),
  alias: z.string().optional().describe('Alias value (action: aliases)'),
  target: z.string().optional().describe('Alias or hook target'),
  limit: z.number().optional().describe('Row limit (action: history)'),
  format: z.enum(['compact', 'json', 'markdown']).optional().describe('Output format'),
});

const fats = { ssh_run: sshRun, ssh_file: sshFile, ssh_fleet: sshFleet };
let fail = false;
let measuredTotal = 0;

for (const [name, schema] of Object.entries(fats)) {
  const t = tokens(z.toJSONSchema(schema));
  measuredTotal += t;
  const verdict = t <= PER_TOOL_CEIL ? 'ok' : 'OVER';
  console.log(`${name.padEnd(10)} ${String(t).padStart(5)} tokens  [${verdict}]`);
  if (t > PER_TOOL_CEIL) fail = true;
}

// Extrapolate: 3 fattest measured + 10 thinner tools at ~55% of the fat average.
// 0.55 = thinner tools carry fewer optional/action params -> roughly half a fat tool.
const fatAvg = measuredTotal / 3;
const estTotal = Math.round(measuredTotal + fatAvg * 0.55 * 10);
console.log(`\nestimated 13-tool surface: ~${estTotal} tokens  (51-tool baseline: ${SURFACE_CEIL})`);
if (estTotal >= SURFACE_CEIL) fail = true;

if (fail) {
  console.error('\nGATE: FAIL -- v4 schema surface is not materially smaller. Revisit the design.');
  process.exit(1);
}
console.log('\nGATE: PASS -- proceed with v4 implementation.');
