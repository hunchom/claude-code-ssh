# ssh-mcp v4 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v4 render foundation — a pre-build schema-cost gate plus four pure render primitives (`renderHeader`, `indentBody`, `renderKV`, `renderRows`) that every v4 tool will format output through.

**Architecture:** Additive only. New primitives are added as exports to `src/output-formatter.js`; no existing function is modified, so nothing breaks. A new test suite covers them. A standalone script measures the proposed v4 tool-schema token cost as a go/no-go gate. The render-layer *rewrite* that adopts these primitives (`defaultRender`, `renderMarkdown`, `format: compact`) is deliberately deferred to Plan 2 so this plan ships zero-risk.

**Tech Stack:** Node.js ESM, the existing `node:assert`-based test suites run by `scripts/run-tests.mjs`, zod v4.

This is Plan 1 of 5. Plan 2: output rewrite (adopt primitives, `format: compact`, compressors). Plan 3: 13-tool dispatcher facade. Plan 4: new capabilities (`ssh_find`, detach/job, `;`-chain sentinels). Plan 5: adoption (CLAUDE.md rule, Bash hook). Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md`.

---

## File Structure

- **Create `scripts/measure-schema-tokens.mjs`** — standalone pre-build gate. Builds sample zod schemas for the three fattest proposed v4 tools, serializes them to JSON Schema, prints token cost, exits non-zero if the consolidated surface would not beat the current 51-tool surface.
- **Modify `src/output-formatter.js`** — append four new exported functions. No existing export is touched.
- **Create `tests/test-render-primitives.js`** — new suite for the four primitives. Auto-discovered by `scripts/run-tests.mjs` (matches `test-*.js`).

---

## Task 1: Pre-build schema-cost gate

This is a go/no-go gate, not a TDD task. If it fails, stop and revisit the spec — the fat-tool model is unsound and the rest of v4 should not be built.

**Files:**
- Create: `scripts/measure-schema-tokens.mjs`

- [ ] **Step 1: Create the measurement script**

```javascript
#!/usr/bin/env node
// Pre-build gate for ssh-mcp v4. Measures the JSON-Schema token cost of the
// three fattest proposed v4 tools. Exits non-zero (GATE: FAIL) if any single
// tool exceeds the per-tool ceiling or the extrapolated 13-tool surface would
// not beat the current ~14k-token, 51-tool surface.
import { z } from 'zod';

const PER_TOOL_CEIL = 1500;  // tokens; no single fat tool may exceed this
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
const fatAvg = measuredTotal / 3;
const estTotal = Math.round(measuredTotal + fatAvg * 0.55 * 10);
console.log(`\nestimated 13-tool surface: ~${estTotal} tokens  (51-tool baseline: ${SURFACE_CEIL})`);
if (estTotal >= SURFACE_CEIL) fail = true;

if (fail) {
  console.error('\nGATE: FAIL -- v4 schema surface is not materially smaller. Revisit the design.');
  process.exit(1);
}
console.log('\nGATE: PASS -- proceed with v4 implementation.');
```

- [ ] **Step 2: Run the gate**

Run: `node scripts/measure-schema-tokens.mjs`
Expected: a per-tool token line for `ssh_run`, `ssh_file`, `ssh_fleet`, each marked `[ok]`; an estimated-surface line well under 14000; final line `GATE: PASS`. Exit code 0.

If the output is `GATE: FAIL`, STOP. Do not continue to Task 2. Report the numbers — the fat-tool consolidation does not pay off and the spec must be reworked before any v4 code is written.

- [ ] **Step 3: Commit**

```bash
git add scripts/measure-schema-tokens.mjs
git commit -m "build: add v4 schema-cost pre-build gate"
```

---

## Task 2: `renderHeader` primitive

The single header grammar every v4 tool emits: `<marker> <tool> · <action> · <server> · <status> · <duration>`. Optional slots collapse; order is fixed.

**Files:**
- Modify: `src/output-formatter.js` (append one export)
- Test: `tests/test-render-primitives.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-render-primitives.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for the v4 render primitives in src/output-formatter.js.
 * Run: node tests/test-render-primitives.js
 */
import assert from 'assert';
import { renderHeader } from '../src/output-formatter.js';

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[ok] ${name}`);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error(`[err] ${name}: ${e.message}`);
  }
}

console.log('[test] Testing render primitives\n');

// --- renderHeader --------------------------------------------------------
test('renderHeader: full slots joined with middot', () => {
  const h = renderHeader({
    marker: '[ok]', tool: 'ssh_run', action: 'exec',
    server: 'devcentos', status: 'exit 0', durationMs: 245,
  });
  assert.strictEqual(h, '[ok] ssh_run · exec · devcentos · exit 0 · 245 ms');
});

test('renderHeader: optional slots collapse, order preserved', () => {
  const h = renderHeader({ marker: '[err]', tool: 'ssh_file', server: 'web1' });
  assert.strictEqual(h, '[err] ssh_file · web1');
});

test('renderHeader: default marker is [ok]', () => {
  assert.strictEqual(renderHeader({ tool: 'ssh_db' }), '[ok] ssh_db');
});

test('renderHeader: status of 0 is kept, empty string dropped', () => {
  assert(renderHeader({ tool: 't', status: 0 }).endsWith('· 0'));
  assert.strictEqual(renderHeader({ tool: 't', status: '' }), '[ok] t');
});

// --- Summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-render-primitives.js`
Expected: FAIL — `SyntaxError: The requested module '../src/output-formatter.js' does not provide an export named 'renderHeader'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/output-formatter.js` (after `makeMcpContent`, end of file). `formatDuration` is already defined in this module:

```javascript
/**
 * Render the single v4 header line. Grammar:
 *   <marker> <tool> · <action> · <server> · <status> · <duration>
 * Absent slots collapse; present slots never reorder. Used by every v4 tool.
 */
export function renderHeader({
  marker = '[ok]', tool, action, server, status, durationMs,
} = {}) {
  const slots = [];
  if (tool) slots.push(String(tool));
  if (action) slots.push(String(action));
  if (server) slots.push(String(server));
  if (status != null && status !== '') slots.push(String(status));
  if (durationMs != null) slots.push(formatDuration(durationMs));
  return `${marker} ${slots.join(' · ')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-render-primitives.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/output-formatter.js tests/test-render-primitives.js
git commit -m "feat: add renderHeader v4 render primitive"
```

---

## Task 3: `indentBody` primitive

Indents a payload block by a fixed prefix (default 2 spaces). This replaces fenced code blocks: indentation reads cleanly as plain text, renders as a code block if a client parses markdown, and cannot be broken by backticks inside the payload.

**Files:**
- Modify: `src/output-formatter.js` (append one export)
- Test: `tests/test-render-primitives.js` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/test-render-primitives.js`, change the import line to add `indentBody`:

```javascript
import { renderHeader, indentBody } from '../src/output-formatter.js';
```

Add these tests immediately before the `// --- Summary` section:

```javascript
// --- indentBody ----------------------------------------------------------
test('indentBody: each line prefixed with 2 spaces', () => {
  assert.strictEqual(indentBody('a\nb'), '  a\n  b');
});

test('indentBody: empty or nullish input -> empty string', () => {
  assert.strictEqual(indentBody(''), '');
  assert.strictEqual(indentBody(null), '');
  assert.strictEqual(indentBody(undefined), '');
});

test('indentBody: custom prefix honored', () => {
  assert.strictEqual(indentBody('x', '| '), '| x');
});

test('indentBody: blank lines are still prefixed', () => {
  assert.strictEqual(indentBody('a\n\nb'), '  a\n  \n  b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-render-primitives.js`
Expected: FAIL — `does not provide an export named 'indentBody'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/output-formatter.js`:

```javascript
/**
 * Indent a payload block by `prefix` (default 2 spaces). Replaces fenced code
 * blocks in v4 output -- clean as plain text, unbreakable by payload content.
 */
export function indentBody(text, prefix = '  ') {
  if (text == null || text === '') return '';
  return String(text).split('\n').map((l) => prefix + l).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-render-primitives.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/output-formatter.js tests/test-render-primitives.js
git commit -m "feat: add indentBody v4 render primitive"
```

---

## Task 4: `renderKV` primitive

Renders an ordered list of `[key, value]` pairs as a column-aligned key/value block. This is the body format for single-record results and the fallback `defaultRender` adopts in Plan 2 — replacing raw `JSON.stringify` blobs.

**Files:**
- Modify: `src/output-formatter.js` (append one export)
- Test: `tests/test-render-primitives.js` (extend)

- [ ] **Step 1: Write the failing test**

Change the import line in `tests/test-render-primitives.js` to add `renderKV`:

```javascript
import { renderHeader, indentBody, renderKV } from '../src/output-formatter.js';
```

Add these tests before the `// --- Summary` section:

```javascript
// --- renderKV ------------------------------------------------------------
test('renderKV: aligns keys to the longest, 2-space gutter', () => {
  const kv = renderKV([['exit', '0'], ['duration', '245 ms']]);
  assert.strictEqual(kv, 'exit      0\nduration  245 ms');
});

test('renderKV: empty or non-array -> empty string', () => {
  assert.strictEqual(renderKV([]), '');
  assert.strictEqual(renderKV(null), '');
});

test('renderKV: coerces non-string values, nullish value -> empty', () => {
  assert.strictEqual(renderKV([['n', 42], ['m', null]]), 'n  42\nm  ');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-render-primitives.js`
Expected: FAIL — `does not provide an export named 'renderKV'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/output-formatter.js`:

```javascript
/**
 * Render [key, value] pairs as a column-aligned key/value block. Keys are
 * left-padded to the longest key; a 2-space gutter separates key and value.
 */
export function renderKV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const width = Math.max(...rows.map(([k]) => String(k).length));
  return rows
    .map(([k, v]) => `${String(k).padEnd(width)}  ${v == null ? '' : String(v)}`)
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-render-primitives.js`
Expected: PASS — `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/output-formatter.js tests/test-render-primitives.js
git commit -m "feat: add renderKV v4 render primitive"
```

---

## Task 5: `renderRows` primitive

Renders tabular data (2+ rows) as a column-aligned ASCII table. When an `isFail` predicate is supplied, failed rows sort to the top and a `N/M failed` summary line is prepended — so the eye lands on problems first in fleet and process results.

**Files:**
- Modify: `src/output-formatter.js` (append one export)
- Test: `tests/test-render-primitives.js` (extend)

- [ ] **Step 1: Write the failing test**

Change the import line in `tests/test-render-primitives.js` to add `renderRows`:

```javascript
import { renderHeader, indentBody, renderKV, renderRows } from '../src/output-formatter.js';
```

Add these tests before the `// --- Summary` section:

```javascript
// --- renderRows ----------------------------------------------------------
test('renderRows: aligns columns, no trailing whitespace', () => {
  const t = renderRows(['name', 'exit'], [['web1', '0'], ['db1', '1']]);
  assert.strictEqual(t, 'name  exit\nweb1  0\ndb1   1');
});

test('renderRows: empty headers -> empty string', () => {
  assert.strictEqual(renderRows([], []), '');
});

test('renderRows: failures sorted to top with summary count', () => {
  const t = renderRows(
    ['name', 'ok'],
    [['a', 'y'], ['b', 'n'], ['c', 'y']],
    { isFail: (r) => r[1] === 'n' },
  );
  const lines = t.split('\n');
  assert.strictEqual(lines[0], '1/3 failed');
  assert.strictEqual(lines[1], 'name  ok');
  assert.strictEqual(lines[2], 'b     n');
});

test('renderRows: isFail with zero failures adds no summary line', () => {
  const t = renderRows(['n'], [['a'], ['b']], { isFail: () => false });
  assert.strictEqual(t.split('\n')[0], 'n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-render-primitives.js`
Expected: FAIL — `does not provide an export named 'renderRows'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/output-formatter.js`:

```javascript
/**
 * Render rows as a column-aligned ASCII table. `headers` is an array of column
 * labels; `rows` is an array of cell arrays. With an `isFail` predicate, failed
 * rows sort first and an `N/M failed` summary line is prepended.
 */
export function renderRows(headers, rows, { isFail } = {}) {
  if (!Array.isArray(headers) || headers.length === 0) return '';
  let ordered = Array.isArray(rows) ? rows.slice() : [];
  let summary = '';
  if (typeof isFail === 'function') {
    const failed = ordered.filter((r) => isFail(r));
    const rest = ordered.filter((r) => !isFail(r));
    ordered = [...failed, ...rest];
    if (failed.length > 0) summary = `${failed.length}/${rows.length} failed`;
  }
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...ordered.map((r) => String(r[i] ?? '').length)));
  const fmt = (cells) =>
    cells
      .map((c, i) => String(c ?? '').padEnd(widths[i]))
      .join('  ')
      .replace(/\s+$/, '');
  const lines = [];
  if (summary) lines.push(summary);
  lines.push(fmt(headers));
  for (const r of ordered) lines.push(fmt(r));
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-render-primitives.js`
Expected: PASS — `15 passed, 0 failed`.

- [ ] **Step 5: Run the full suite to confirm zero regressions**

Run: `npm test`
Expected: the new file appears in the count; total is the previous `653 passed` plus `15`; `0 failed`. Because this plan only *adds* exports, every pre-existing suite must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/output-formatter.js tests/test-render-primitives.js
git commit -m "feat: add renderRows v4 render primitive"
```

---

## Done criteria

- `node scripts/measure-schema-tokens.mjs` prints `GATE: PASS`.
- `src/output-formatter.js` exports `renderHeader`, `indentBody`, `renderKV`, `renderRows`.
- `tests/test-render-primitives.js` has 15 passing tests.
- `npm test` is green with 15 more tests than before and zero regressions.
- No existing export of `src/output-formatter.js` was modified.

Plan 2 (output rewrite) adopts these primitives: `renderMarkdown` and `defaultRender` switch to `renderHeader` + `indentBody`/`renderKV`, fenced blocks become indentation, and `format: compact` becomes the default.
