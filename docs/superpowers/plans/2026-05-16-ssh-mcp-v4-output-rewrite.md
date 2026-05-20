# ssh-mcp v4 Output Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the two output renderers (`defaultRender`, `renderMarkdown`) to use the Plan 1 render primitives — single header grammar, 2-space-indented bodies instead of fenced code blocks, no `**markdown**` decoration — and make `compact` the default output format.

**Architecture:** Modifies `src/structured-result.js` (`defaultRender`, `toMcp`) and `src/output-formatter.js` (`renderMarkdown`, `makeMcpContent`). The Plan 1 primitives (`renderHeader`, `indentBody`, `renderKV`) already exist as exports of `src/output-formatter.js`. This is a behavior change to existing functions, so the affected test suites are rewritten in the same task that changes the code.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`.

This is Plan 2 of 6. Plan 1 (render primitives) is complete. Plan 3: command-output compressors. Plan 4: 13-tool dispatcher facade. Plan 5: new capabilities. Plan 6: adoption. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md`.

---

## File Structure

- **Modify `src/structured-result.js`** — rewrite `defaultRender` to use `renderHeader` + `renderKV` + `indentBody`; add a private `kvRows` helper; extend the import from `./output-formatter.js`. Add `compact` to `toMcp`'s format set and make it the default.
- **Modify `src/output-formatter.js`** — rewrite `renderMarkdown` to use `renderHeader` + `indentBody`; add `compact` to `makeMcpContent` and make it the default.
- **Modify `tests/test-structured-result.js`** — replace the `defaultRender` test section and the `maybePreview` response test for the new output.
- **Modify `tests/test-output-formatter.js`** — replace the `renderMarkdown` test section and adjust the `makeMcpContent` and integration tests.

Plan 1's `renderMarkdown` is hardcoded for the `ssh_execute` shape; that stays — Plan 4 introduces per-tool renderers. This plan only changes *how* the existing two renderers format, not *what* they render.

---

## Task 1: Rewrite `defaultRender` onto the primitives

`defaultRender` currently emits a `**bold**` header and dumps `data` as a `JSON.stringify(data, null, 2)` blob inside a ` ```json ` fence. Rewrite it to a `renderHeader` line plus a `renderKV` body, indented, no fences, no bold.

**Files:**
- Modify: `src/structured-result.js`
- Test: `tests/test-structured-result.js`

- [ ] **Step 1: Rewrite the test section (failing tests)**

In `tests/test-structured-result.js`, replace the entire `// --- defaultRender` section (the five `test('defaultRender: ...')` blocks) with:

```javascript
// --- defaultRender -------------------------------------------------------
test('defaultRender: success uses renderHeader, KV body, no fences', () => {
  const md = defaultRender(ok('ssh_execute', { rows: 3, kind: 'mysql' },
    { server: 'prod01', duration_ms: 1234 }));
  assert.strictEqual(md.split('\n')[0], '[ok] ssh_execute · prod01 · 1.23 s');
  assert(!md.includes('```'), 'no fenced block');
  assert(!md.includes('**'), 'no markdown bold');
  assert(md.includes('rows'), 'data key present');
  assert(md.includes('mysql'), 'data value present');
});

test('defaultRender: failure uses [err] marker and indented error', () => {
  const md = defaultRender(fail('ssh_execute', 'boom'));
  assert.strictEqual(md.split('\n')[0], '[err] ssh_execute · failed');
  assert(md.includes('\n  boom'), 'error indented 2 spaces');
});

test('defaultRender: preview renders plain "dry run" line and KV plan', () => {
  const md = defaultRender(preview('ssh_upload', { action: 'upload', target: 'a' }));
  assert(md.includes('dry run -- nothing executed'));
  assert(!md.includes('```'), 'no fenced JSON');
  assert(md.includes('action'));
  assert(md.includes('upload'));
});

test('defaultRender: omits duration when meta has none', () => {
  const md = defaultRender(ok('t', {}));
  assert.strictEqual(md.split('\n')[0], '[ok] t');
});

test('defaultRender: elided bytes footer rendered plain', () => {
  const md = defaultRender(ok('t', { x: 1 }, { elided_bytes: 5120 }));
  assert(md.includes('elided: 5.0 KB'));
  assert(!md.includes('>'), 'no blockquote marker');
});
```

Also replace the existing `test('maybePreview returns MCP response when preview=true', ...)` block with:

```javascript
test('maybePreview returns MCP response when preview=true', () => {
  const r = maybePreview(true, 'ssh_upload', {
    action: 'upload', target: 'prod01:/etc/foo',
    effects: ['creates /etc/foo', 'overwrites any existing'],
    reversibility: 'auto',
    server: 'prod01',
  }, {}, toMcp, preview);
  assert(r);
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.includes('dry run'));
  assert(r.content[0].text.includes('action'));
  assert(r.content[0].text.includes('upload'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/test-structured-result.js`
Expected: FAIL — the `defaultRender` tests fail because the current renderer emits `[ok] **ssh_execute**` and a ` ```json ` block, not the new header/KV form.

- [ ] **Step 3: Rewrite `defaultRender`**

In `src/structured-result.js`, change the import line at the top from:

```javascript
import { formatBytes, formatDuration } from './output-formatter.js';
```

to:

```javascript
import { formatBytes, renderHeader, renderKV, indentBody } from './output-formatter.js';
```

(`formatDuration` is dropped from the import: after this rewrite it is no longer referenced anywhere in `structured-result.js` — `renderHeader` handles duration internally. `formatBytes` is still used, for the elided footer.)

Replace the entire `defaultRender` function with:

```javascript
/**
 * Default markdown renderer. Tools override for richer cards.
 * Header line via renderHeader; data as an indented KV block; no fences.
 */
export function defaultRender(result) {
  const { success, tool, server, data, meta, error } = result;
  const header = renderHeader({
    marker: success ? '[ok]' : '[err]',
    tool,
    server,
    status: success ? null : 'failed',
    durationMs: meta && meta.duration_ms,
  });
  const lines = [header];

  if (!success) {
    lines.push(indentBody(String(error || 'unknown error')));
    return lines.join('\n');
  }

  if (data && data.preview) {
    lines.push('  dry run -- nothing executed');
    lines.push(indentBody(renderKV(kvRows(data.plan))));
    return lines.join('\n');
  }

  if (data != null) {
    lines.push(indentBody(renderKV(kvRows(data))));
  }

  const elided = meta && (meta.truncated_bytes || meta.elided_bytes);
  if (elided) lines.push(indentBody(`elided: ${formatBytes(elided)}`));

  return lines.join('\n');
}

/**
 * Flatten an object to [key, value] rows for renderKV. Nested objects/arrays
 * collapse to compact JSON; non-objects render as a single `value` row.
 */
function kvRows(obj) {
  if (obj == null || typeof obj !== 'object') return [['value', String(obj)]];
  return Object.entries(obj).map(([k, v]) => [
    k,
    v != null && typeof v === 'object' ? JSON.stringify(v) : String(v),
  ]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/test-structured-result.js`
Expected: PASS — all tests green, including the rewritten `defaultRender` and `maybePreview` tests.

- [ ] **Step 5: Fix cross-suite assertions broken by the defaultRender rewrite**

`defaultRender` is the fallback renderer for tools that ship without a custom one. Two suites assert its old `[ok] **<tool>**` header form and will now fail. Update them:

- `tests/test-session-tools.js`: the assertion string `'[ok] **ssh_session_start**'` becomes `'[ok] ssh_session_start'`.
- `tests/test-tail-tools.js`: the assertion string `'[ok] **ssh_tail_start**'` becomes `'[ok] ssh_tail_start'`.

Both are `startsWith` checks; the new header is `[ok] <tool> · ...`, so dropping the leading and trailing `**` keeps each check valid.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `670 passed, 0 failed`. Changed suites: `test-structured-result.js`, `test-session-tools.js`, `test-tail-tools.js`.

- [ ] **Step 7: Commit**

```bash
git add src/structured-result.js tests/test-structured-result.js tests/test-session-tools.js tests/test-tail-tools.js
git commit -m "refactor: rewrite defaultRender onto v4 render primitives"
```

---

## Task 2: Rewrite `renderMarkdown` onto the primitives

`renderMarkdown` (the `ssh_execute` result renderer) currently emits a `**bold**` header, a `` `$ command` `` line, and ` ```text ` fences. Rewrite it to a `renderHeader` line, a plain `$ command` line, and 2-space-indented bodies.

**Files:**
- Modify: `src/output-formatter.js`
- Test: `tests/test-output-formatter.js`

- [ ] **Step 1: Rewrite the test section (failing tests)**

In `tests/test-output-formatter.js`, replace the entire `// --- renderMarkdown` section (the nine `test('renderMarkdown: ...')` blocks) with:

```javascript
// --- renderMarkdown ------------------------------------------------------
test('renderMarkdown: success header is a renderHeader line, no bold', () => {
  const md = renderMarkdown({
    server: 'prod01', command: 'x', cwd: null, exit_code: 0, success: true,
    duration_ms: 2340, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert.strictEqual(md.split('\n')[0], '[ok] ssh_execute · prod01 · exit 0 · 2.34 s');
  assert(!md.includes('**'), 'no markdown bold');
  assert(md.includes('\n$ x'), 'command on its own line with $ prefix');
});

test('renderMarkdown: failure header uses [err] marker and exit code', () => {
  const md = renderMarkdown({
    server: 's', command: 'false', cwd: null, exit_code: 127, success: false,
    duration_ms: 0, stdout: '', stderr: 'not found',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.split('\n')[0].startsWith('[err] ssh_execute'), 'failure marker');
  assert(md.includes('exit 127'), 'exit 127 in header');
  assert(md.includes('stderr:'), 'stderr label');
  assert(md.includes('  not found'), 'stderr indented');
});

test('renderMarkdown: cwd shown as plain (in PATH) on the command line', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: '/srv/app', exit_code: 0, success: true,
    duration_ms: 100, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('$ c  (in /srv/app)'), 'cwd shown plain');
  assert(!md.includes('*'), 'no markdown italic');
});

test('renderMarkdown: no cwd -> no "(in ...)" fragment', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 10, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(!md.includes('(in '), 'no cwd fragment when null');
});

test('renderMarkdown: stdout indented 2 spaces, no fences', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'hello\nworld', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('\n  hello\n  world'), 'stdout indented');
  assert(!md.includes('```'), 'no fenced block');
});

test('renderMarkdown: empty output sections omitted', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: '', stderr: '',
    truncated: { stdout_bytes: 0, stderr_bytes: 0, stdout_total: 0, stderr_total: 0 },
  });
  assert(!md.includes('stderr:'), 'no stderr label when stderr empty');
});

test('renderMarkdown: truncation rendered as plain elided footer', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'partial', stderr: '',
    truncated: { stdout_bytes: 12345, stderr_bytes: 0, stdout_total: 22345, stderr_total: 0 },
  });
  assert(md.includes('elided: stdout 12.1 KB'), `expected plain elided footer, got: ${md}`);
  assert(!md.includes('>'), 'no blockquote marker');
});

test('renderMarkdown: truncation shows both streams when both elided', () => {
  const md = renderMarkdown({
    server: 's', command: 'c', cwd: null, exit_code: 0, success: true,
    duration_ms: 1, stdout: 'a', stderr: 'b',
    truncated: { stdout_bytes: 5_000_000, stderr_bytes: 2048, stdout_total: 0, stderr_total: 0 },
  });
  assert(md.includes('stdout 4.8 MB'));
  assert(md.includes('stderr 2.0 KB'));
});
```

In the same file, in the integration test `test('integration: 100KB log ...')`, replace the three `renderMarkdown` assertions:

```javascript
  assert(md.includes('exit 139'), 'failure exit badge');
  assert(md.includes('elided'), 'truncation marker present');
  assert(md.startsWith('[err]'), 'failure marker leads the header');
```

with:

```javascript
  assert(md.includes('exit 139'), 'failure exit in header');
  assert(md.includes('elided'), 'truncation marker present');
  assert(md.startsWith('[err] ssh_execute'), 'failure marker leads the header');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/test-output-formatter.js`
Expected: FAIL — current `renderMarkdown` emits `[ok] **ssh_execute** | ...` and ` ```text ` fences, not the new header/indent form.

- [ ] **Step 3: Rewrite `renderMarkdown`**

In `src/output-formatter.js`, replace the entire `renderMarkdown` function with:

```javascript
/**
 * Render an ExecResult as compact v4 plain text.
 * Header via renderHeader; command on a plain `$` line; stdout/stderr indented.
 */
export function renderMarkdown(r) {
  const marker = r.success ? '[ok]' : '[err]';
  const lines = [renderHeader({
    marker,
    tool: 'ssh_execute',
    server: r.server,
    status: `exit ${r.exit_code}`,
    durationMs: r.duration_ms,
  })];

  lines.push(`$ ${r.command}${r.cwd ? `  (in ${r.cwd})` : ''}`);

  if (r.stdout) {
    lines.push('');
    lines.push(indentBody(r.stdout));
  }

  if (r.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(indentBody(r.stderr));
  }

  if (r.truncated.stdout_bytes || r.truncated.stderr_bytes) {
    const parts = [];
    if (r.truncated.stdout_bytes) parts.push(`stdout ${formatBytes(r.truncated.stdout_bytes)}`);
    if (r.truncated.stderr_bytes) parts.push(`stderr ${formatBytes(r.truncated.stderr_bytes)}`);
    lines.push('');
    lines.push(`elided: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}
```

`renderHeader`, `indentBody`, and `formatBytes` are all defined earlier in this same file — no import needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/test-output-formatter.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Fix cross-suite assertions broken by the renderMarkdown rewrite**

`renderMarkdown` (the `ssh_execute` renderer) is reused by `ssh_tail`. Three assertions across two suites check its old `**ssh_execute**` header form. Update them:

- `tests/test-exec-tools.js`: `'[ok] **ssh_execute**'` becomes `'[ok] ssh_execute'`; `'[err] **ssh_execute**'` becomes `'[err] ssh_execute'`.
- `tests/test-tail-tools.js`: `'[ok] **ssh_execute**'` becomes `'[ok] ssh_execute'`.

Leave `'[ok] **ssh_execute_group**'` in `test-exec-tools.js` unchanged — that is `renderGroupMarkdown`, a separate renderer this plan does not touch (it is rewritten in Plan 4).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `670 passed, 0 failed`. Changed suites: `test-output-formatter.js`, `test-exec-tools.js`, `test-tail-tools.js`.

- [ ] **Step 7: Commit**

```bash
git add src/output-formatter.js tests/test-output-formatter.js tests/test-exec-tools.js tests/test-tail-tools.js
git commit -m "refactor: rewrite renderMarkdown onto v4 render primitives"
```

---

## Task 3: Make `compact` the default output format

Add `compact` to the recognized formats of `makeMcpContent` and `toMcp`, and make it the default. After Tasks 1-2 the renderers already produce compact, fence-free text, so `compact` simply means "use the renderer" — the same path the old `markdown` default took. `markdown`, `json`, and `both` remain valid explicit values for back-compat.

**Files:**
- Modify: `src/output-formatter.js` (`makeMcpContent`)
- Modify: `src/structured-result.js` (`toMcp`)
- Test: `tests/test-output-formatter.js`, `tests/test-structured-result.js`

- [ ] **Step 1: Write the failing tests**

In `tests/test-output-formatter.js`, replace the `test('makeMcpContent: markdown (default)', ...)` block with:

```javascript
test('makeMcpContent: compact is the default format', () => {
  const r = formatExecResult({
    server: 's', command: 'c', stdout: 'out', stderr: '', code: 0, durationMs: 10,
  });
  const c = makeMcpContent(r);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].type, 'text');
  assert(c[0].text.startsWith('[ok] ssh_execute'), 'compact render is the default');
  assert(!c[0].text.includes('```'), 'no fences in default output');
});
```

In `tests/test-structured-result.js`, replace the `test('toMcp markdown: ...')` block with:

```javascript
test('toMcp compact (default): single rendered text block', () => {
  const r = toMcp(ok('t', { x: 1 }));
  assert.strictEqual(r.content.length, 1);
  assert.strictEqual(r.content[0].type, 'text');
  assert.strictEqual(r.isError, false);
  assert(r.content[0].text.startsWith('[ok] t'), 'rendered, not raw JSON');
  assert(!r.content[0].text.includes('```'), 'no fences');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/test-output-formatter.js` then `node tests/test-structured-result.js`
Expected: the two new tests FAIL only if `compact` is unrecognized and falls through incorrectly. If the existing default path already produces this output they may pass early — in that case proceed; the goal of this task is to make `compact` an explicit, named, default format.

- [ ] **Step 3: Add `compact` to `makeMcpContent`**

In `src/output-formatter.js`, replace the entire `makeMcpContent` function with:

```javascript
/**
 * Build the MCP `content` array from an ExecResult.
 * format: "compact" (default) | "markdown" | "json" | "both".
 * compact and markdown both use renderMarkdown -- the renderer is already
 * fence-free and compact; the names are kept distinct for caller intent.
 */
export function makeMcpContent(result, { format = 'compact' } = {}) {
  if (format === 'json') {
    return [{ type: 'text', text: JSON.stringify(result) }];
  }
  if (format === 'both') {
    return [
      { type: 'text', text: renderMarkdown(result) },
      { type: 'text', text: JSON.stringify(result) },
    ];
  }
  return [{ type: 'text', text: renderMarkdown(result) }];
}
```

- [ ] **Step 4: Add `compact` to `toMcp`**

In `src/structured-result.js`, replace the entire `toMcp` function with:

```javascript
/**
 * Package a structured result as MCP content.
 * format: "compact" (default) | "markdown" | "json" | "both".
 */
export function toMcp(result, { format = 'compact', renderer } = {}) {
  const md = (renderer || defaultRender)(result);
  if (format === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success };
  }
  if (format === 'both') {
    return {
      content: [
        { type: 'text', text: md },
        { type: 'text', text: JSON.stringify(result) },
      ],
      isError: !result.success,
    };
  }
  return { content: [{ type: 'text', text: md }], isError: !result.success };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/test-output-formatter.js` then `node tests/test-structured-result.js`
Expected: PASS — both new default-format tests green.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `35 files, 670 passed, 0 failed`. The test count is unchanged from Plan 1 — this plan rewrites tests rather than adding them. Zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/output-formatter.js src/structured-result.js tests/test-output-formatter.js tests/test-structured-result.js
git commit -m "feat: make compact the default v4 output format"
```

---

## Done criteria

- `defaultRender` and `renderMarkdown` emit `renderHeader` headers and 2-space-indented bodies — no ` ``` ` fences, no `**bold**`, no `*italic*`, no `>` blockquotes.
- `compact` is the default format for both `makeMcpContent` and `toMcp`; `markdown`, `json`, `both` still accepted.
- `npm test` is green: `670 passed, 0 failed`.
- No tool handler in `src/tools/` was modified — this plan is confined to the two renderers and the two MCP-content packagers.

Plan 3 (compressors) adds `src/command-compressors.js` and wires per-command output compression into the formatter pipeline ahead of truncation.
