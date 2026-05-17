# ssh-mcp v4 Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude *choose* the 13 v4 `ssh_*` tools over raw `ssh` through the Bash tool. The tool consolidation (Plans 4-5) makes the surface small enough to stay un-deferred; this plan supplies the three behavioural nudges that close the gap — selling tool descriptions that name the bash they replace, a project `CLAUDE.md` rule, and a soft PreToolUse Bash hook — and corrects every stale tool/test count left in the docs.

**Architecture:** Four independent deliverables, no shared runtime state.
1. A new `src/tool-descriptions.js` exports the 13 v4 tool descriptions as a frozen map; `src/index.js` imports it and the v4 registration block uses `V4_TOOL_DESCRIPTIONS.<tool>` for each `description` field. A test asserts every description cues when-to-use and names the raw bash it replaces.
2. A `CLAUDE.md` rule block (prefer-the-MCP-tools, with the why).
3. A Claude Code PreToolUse hook: `.claude/settings.json` registers `.claude/hooks/ssh-bash-nudge.mjs`, a fail-open Node script that inspects a `Bash` tool call, detects a plain `ssh <host>` / `scp` / `rsync` against a configured server, and prints a non-blocking nudge. A test exercises the detector directly.
4. Stale-count corrections in `CLAUDE.md`, `docs/TOOL_MANAGEMENT.md`, and `scripts/finalize.sh`.

This plan adds two source files (`src/tool-descriptions.js`, `.claude/hooks/ssh-bash-nudge.mjs`) and one config file (`.claude/settings.json`); it edits `src/index.js`, `CLAUDE.md`, `docs/TOOL_MANAGEMENT.md`, and `scripts/finalize.sh`. It does not touch any tool handler in `src/tools/`.

**Tech Stack:** Node.js ESM, the `node:assert`-based suites run by `scripts/run-tests.mjs`, Claude Code's settings-and-hooks JSON contract.

This is Plan 6 of 6 — the last. Plans 1-5 are complete: render primitives, output rewrite, compressors, the 13-tool dispatcher facade, new capabilities. The v4 tool surface — `ssh_run`, `ssh_file`, `ssh_find`, `ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan` — exists and is registered in `src/index.js` when this plan executes. Source spec: `docs/superpowers/specs/2026-05-16-ssh-mcp-redesign-design.md` section 5.

---

## File Structure

- **Create `src/tool-descriptions.js`** — `V4_TOOL_DESCRIPTIONS`, a frozen map of the 13 v4 tool names to their selling descriptions. Each description cues when-to-use and names the raw bash it replaces. Single source of truth; imported by `src/index.js` and asserted by a test.
- **Modify `src/index.js`** — import `V4_TOOL_DESCRIPTIONS`; in the v4 registration block, set each tool's `description` field to `V4_TOOL_DESCRIPTIONS.<tool>` instead of an inline string.
- **Create `tests/test-tool-descriptions.js`** — asserts the map has exactly the 13 v4 keys, that every description names raw bash and carries a when-to-use cue, and that `src/index.js` actually imports the map. Auto-discovered by `scripts/run-tests.mjs` (matches `test-*.js`).
- **Modify `CLAUDE.md`** — add the prefer-the-MCP-tools rule block; correct the stale `51 tools` / `37 tools` / `551 tests` references.
- **Create `.claude/hooks/ssh-bash-nudge.mjs`** — the PreToolUse hook script. Reads the hook payload on stdin, detects a simple `ssh`/`scp`/`rsync` invocation against a configured server, prints a soft non-blocking nudge, always exits 0.
- **Create `.claude/settings.json`** — registers the hook on the `Bash` matcher under `hooks.PreToolUse`.
- **Create `tests/test-bash-nudge.js`** — exercises the hook's `detectSshNudge` detector directly: simple invocations matched, complex command lines passed through, fail-open behaviour.
- **Modify `docs/TOOL_MANAGEMENT.md`** — correct every `37 tools` / `~43.5k tokens` / group-count reference to the v4 13-tool surface.
- **Modify `scripts/finalize.sh`** — correct the `51 tools` phrase in the GitHub repo description.

The PreToolUse hook lives under `.claude/` because that directory is already committed (it holds `agent-memory/` and `skills/`) and `.gitignore` excludes only `.claude/` *runtime* artifacts (`scheduled_tasks.lock`, `scheduled_tasks/`, `.last_run`) — a `.claude/settings.json` and `.claude/hooks/` script are tracked normally. The hook is a Claude Code PreToolUse hook, unrelated to the repo's Python `pre-commit` git hooks (`scripts/setup-hooks.sh`).

---

## Task 1: v4 tool-description map

Create the single source of truth for the 13 v4 tool descriptions. Each one does two jobs the spec (section 5) demands: it cues *when to use* the tool and it names the *raw bash it replaces*, so Claude — seeing the loaded schema — reaches for the tool instead of falling back to `ssh` in Bash.

**Files:**
- Create: `src/tool-descriptions.js`
- Test: `tests/test-tool-descriptions.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-tool-descriptions.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for src/tool-descriptions.js.
 * Run: node tests/test-tool-descriptions.js
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { V4_TOOL_DESCRIPTIONS } from '../src/tool-descriptions.js';

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

console.log('[test] Testing tool-descriptions\n');

const V4_TOOLS = [
  'ssh_run', 'ssh_file', 'ssh_find', 'ssh_logs', 'ssh_service',
  'ssh_health', 'ssh_db', 'ssh_backup', 'ssh_session', 'ssh_net',
  'ssh_docker', 'ssh_fleet', 'ssh_plan',
];

test('map has exactly the 13 v4 tool keys', () => {
  assert.deepStrictEqual(Object.keys(V4_TOOL_DESCRIPTIONS).sort(), [...V4_TOOLS].sort());
});

test('map is frozen', () => {
  assert(Object.isFrozen(V4_TOOL_DESCRIPTIONS));
});

test('every description is a non-trivial string', () => {
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t];
    assert.strictEqual(typeof d, 'string', `${t} description is a string`);
    assert(d.length >= 60, `${t} description has substance (>=60 chars)`);
  }
});

test('every description names the raw bash it replaces', () => {
  // The selling point: each description points at the `ssh ...` / scp / rsync
  // command it supersedes. Backtick-quoted so the model sees a concrete command.
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t];
    assert(/`[^`]*(?:ssh |scp|rsync)[^`]*`/.test(d),
      `${t} description names a raw bash command in backticks`);
  }
});

test('every description carries a when-to-use cue', () => {
  // "use instead of" / "use for" / "reach for" -- an explicit selection cue.
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t].toLowerCase();
    assert(/use instead of|use for|use to|reach for/.test(d),
      `${t} description has a when-to-use cue`);
  }
});

test('descriptions sell the win -- capped/pooled/structured output', () => {
  // At least one concrete benefit phrase per description: this is why the tool
  // beats raw ssh (bounded output, pooled connection, structured result).
  for (const t of V4_TOOLS) {
    const d = V4_TOOL_DESCRIPTIONS[t].toLowerCase();
    assert(/cap|bound|truncat|pool|structur|flood|filter|exit code|escape hatch/.test(d),
      `${t} description states a concrete advantage over raw ssh`);
  }
});

test('src/index.js imports the description map', () => {
  // Guards against the map drifting out of use if a future edit re-inlines
  // description strings in the v4 registration block.
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert(/V4_TOOL_DESCRIPTIONS/.test(idx), 'index.js references V4_TOOL_DESCRIPTIONS');
  assert(/from\s+['"]\.\/tool-descriptions\.js['"]/.test(idx),
    'index.js imports from ./tool-descriptions.js');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-tool-descriptions.js`
Expected: FAIL — `Cannot find module '../src/tool-descriptions.js'`.

- [ ] **Step 3: Write the description map**

Create `src/tool-descriptions.js`:

```javascript
/**
 * v4 tool descriptions -- single source of truth.
 *
 * Each entry cues WHEN to use the tool and names the raw bash it replaces, so
 * the loaded schema steers Claude onto these tools instead of `ssh` via Bash.
 * src/index.js imports this; the v4 registration block uses these strings as
 * each tool's `description`. Edit text here, never inline in index.js.
 */
export const V4_TOOL_DESCRIPTIONS = Object.freeze({
  ssh_run:
    'Run commands on a configured server. Use instead of `ssh host "cmd"` '
    + '-- a `script` action chains `cmd1; cmd2; cmd3` in one round trip with '
    + 'per-segment exit codes, the pooled connection skips the per-call SSH '
    + 'handshake, and output is capped so a noisy command will not flood '
    + 'context. Actions: exec, sudo, script, fleet, detach, job-status, job-kill.',
  ssh_file:
    'Move and edit files on a configured server. Use instead of '
    + '`scp local host:remote` or `ssh host "cat > f <<EOF ..."` -- SFTP '
    + 'transfer with sha256 verification, write/edit with no heredoc or '
    + 'shell-quoting hazard, deploy with structured before/after results. '
    + 'Actions: upload, download, sync, read, write, edit, diff, deploy, '
    + 'deploy-artifact.',
  ssh_find:
    'Search files on a configured server. Use instead of a blind '
    + '`ssh host "grep -rn PATTERN /"` -- a server-side timeout and match cap '
    + 'stop the walk early, /proc /sys /dev and .git are pruned, and hits come '
    + 'back as structured file/line/text rows instead of an unbounded dump. '
    + 'Actions: grep, locate, ls.',
  ssh_logs:
    'Read remote logs. Use instead of `ssh host journalctl` or `ssh host tail '
    + '-f file` -- output is capped and grep-filtered so it will not flood '
    + 'context, and follow sessions resume from a cursor instead of '
    + 're-streaming. Actions: tail, follow-start, follow-read, follow-stop, '
    + 'journal.',
  ssh_service:
    'Manage systemd services on a configured server. Use instead of '
    + '`ssh host systemctl status nginx` -- returns a structured snapshot '
    + '(ActiveState, SubState, recent log lines) over the pooled connection '
    + 'rather than a raw terminal page. Actions: status, start, stop, restart, '
    + 'enable, disable.',
  ssh_health:
    'Inspect server health. Use instead of stitching `ssh host top`, '
    + '`ssh host df -h`, and `ssh host free -m` together -- one call returns a '
    + 'structured cpu/memory/disk/process snapshot, with at-capacity rows '
    + 'sorted to the top so the incident is visible first. Actions: check, '
    + 'watch, procs, alerts.',
  ssh_db:
    'Query and manage databases on a configured server. Use instead of '
    + '`ssh host "mysql -e ..."` -- credentials go through env not argv, '
    + 'SELECT queries pass a token-level safety check, and rows render as a '
    + 'bounded aligned table. Actions: query, list, dump, import.',
  ssh_backup:
    'Create, list, and restore backups on a configured server. Use instead of '
    + 'hand-rolled `ssh host "tar czf ..."` or `mysqldump` one-liners -- '
    + 'content-addressed with sha256 verification, a metadata sidecar, and a '
    + 'high-risk preview before any restore. Actions: create, list, restore, '
    + 'schedule.',
  ssh_session:
    'Drive a persistent shell on a configured server. Use instead of repeated '
    + '`ssh host "cmd"` calls when shell state must persist -- one pooled '
    + 'session keeps cwd, env, and exit code across commands, with replay and '
    + 'an inferred-state snapshot. Actions: start, send, list, close, replay, '
    + 'memory.',
  ssh_net:
    'Manage SSH tunnels and probe ports on a configured server. Use instead of '
    + '`ssh -L`, `ssh -R`, or `ssh -D` plus a manual `nc -z` reachability '
    + 'check -- tunnels are tracked with typed state and port-test runs a '
    + 'structured DNS to TCP to TLS chain. Actions: tunnel-open, tunnel-list, '
    + 'tunnel-close, port-test.',
  ssh_docker:
    'Drive Docker on a configured server. Use instead of '
    + '`ssh host "docker ps"` / `docker logs` / `docker exec` -- container and '
    + 'image names are validated, mutations show a preview, and `ps` / `logs` '
    + 'output is capped so a busy host will not flood context. Actions: ps, '
    + 'logs, exec, restart, inspect, compose.',
  ssh_fleet:
    'Inspect fleet and connection metadata. Use instead of `cat ~/.ssh/config` '
    + 'or remembering which `ssh` aliases exist -- lists configured servers, '
    + 'groups, aliases, profiles, hooks, keys, history, and live pooled '
    + 'connections as structured tables. Actions: servers, groups, aliases, '
    + 'profiles, hooks, keys, history, connections.',
  ssh_plan:
    'Run a declarative multi-step plan across configured servers. Use instead '
    + 'of a hand-sequenced batch of `ssh` commands -- steps dispatch to the '
    + 'other v4 tools, high-risk steps gate behind an approve token, and each '
    + 'step returns a structured result. Actions: run, approve.',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-tool-descriptions.js`
Expected: the map tests pass, but `src/index.js imports the description map` still FAILS — `index.js` does not yet import the map. Proceed to Step 5; that step makes it pass.

- [ ] **Step 5: Wire the map into `src/index.js`**

In `src/index.js`, add this import alongside the other `src/` imports near the top of the file (the block that includes `import { withAnnotations } from './tool-annotations.js';`):

```javascript
import { V4_TOOL_DESCRIPTIONS } from './tool-descriptions.js';
```

Then, in the v4 tool registration block (the 13 `registerToolConditional(...)` calls built by Plan 4), replace each tool's inline `description:` string with the map lookup. For every one of the 13 v4 tools, the registration's `description` field becomes `V4_TOOL_DESCRIPTIONS.<toolName>`. Concretely, each call changes from the shape:

```javascript
registerToolConditional(
  'ssh_run',
  {
    description: '<whatever inline string Plan 4 wrote>',
    inputSchema: { /* unchanged */ },
  },
  /* handler unchanged */
);
```

to:

```javascript
registerToolConditional(
  'ssh_run',
  {
    description: V4_TOOL_DESCRIPTIONS.ssh_run,
    inputSchema: { /* unchanged */ },
  },
  /* handler unchanged */
);
```

Apply the identical change to all 13: `ssh_run`, `ssh_file`, `ssh_find`, `ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan`. Only the `description` field changes; `inputSchema` and the handler are untouched.

- [ ] **Step 6: Run test to verify it passes**

Run: `node tests/test-tool-descriptions.js`
Expected: PASS — `7 passed, 0 failed`. The `src/index.js imports the description map` test now passes.

- [ ] **Step 7: Verify the server still starts**

Run: `node --check src/index.js`
Expected: exit 0, no output — `index.js` is still syntactically valid after the import and the 13 description-field edits.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: the new `test-tool-descriptions.js` suite appears in the file count and adds 7 passing tests; `0 failed`. No pre-existing suite regresses — this task only added an import and swapped 13 string literals for map lookups of equal-or-better descriptions.

- [ ] **Step 9: Commit**

```bash
git add src/tool-descriptions.js tests/test-tool-descriptions.js src/index.js
git commit -m "feat: selling v4 tool descriptions that name the bash they replace"
```

---

## Task 2: `CLAUDE.md` prefer-the-MCP-tools rule

Add a rule to the project `CLAUDE.md` instructing Claude to use the `ssh_*` MCP tools rather than raw `ssh` via the Bash tool for any configured server — with the why (connection pooling, output truncation, credential handling) so the instruction is persuasive, not arbitrary.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Insert the rule block**

In `CLAUDE.md`, immediately after the `## Claude Code Integration` section (the block that ends with the line `` Configuration is stored in `~/.config/claude-code/claude_code_config.json` ``) and **before** the `<!-- gitnexus:start -->` line, insert this new section verbatim:

```markdown
## Using the SSH Tools

**For any server configured in this MCP server, use the `ssh_*` MCP tools — not raw `ssh`, `scp`, or `rsync` through the Bash tool.**

The 13 v4 tools (`ssh_run`, `ssh_file`, `ssh_find`, `ssh_logs`, `ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`, `ssh_docker`, `ssh_fleet`, `ssh_plan`) are not a read-only convenience layer — they are the intended way to operate the fleet. Reach for them first.

Why they beat raw `ssh` in Bash:

- **Connection pooling** — the MCP server holds persistent SSH connections, so there is no per-call handshake. Raw `ssh` in Bash reconnects every single time.
- **Bounded output** — results are compressed and head+tail truncated, so a noisy command (`journalctl`, `ps`, a 100k-line log) will not flood the context window. Raw `ssh` dumps everything.
- **Credential handling** — passwords and sudo passwords are passed via stdin or env, never leaked on the argv of a `ps`-visible process. Raw `ssh` with an inline password is exposed.
- **Structured results** — per-segment exit codes for command chains, typed service/health snapshots, SFTP transfers with sha256 verification. Raw `ssh` gives an unstructured terminal dump.

Raw `ssh` through Bash is acceptable only for a host that is **not** in the MCP configuration. Run `ssh_fleet action: servers` to see which servers are configured.
```

- [ ] **Step 2: Verify the insertion**

Run: `grep -n "Using the SSH Tools" CLAUDE.md && grep -c "ssh_run" CLAUDE.md`
Expected: the `grep -n` line prints the heading with its line number; the section sits after `## Claude Code Integration` and before `<!-- gitnexus:start -->`. The `grep -c` count is at least `1` (the rule block mentions `ssh_run`).

- [ ] **Step 3: Verify no GitNexus block was disturbed**

Run: `grep -c "gitnexus:start" CLAUDE.md && grep -c "gitnexus:end" CLAUDE.md`
Expected: each prints `1` — the managed GitNexus block is intact and the new section was inserted strictly above it.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md rule to prefer ssh_* MCP tools over raw ssh"
```

---

## Task 3: PreToolUse Bash hook — the detector

Build the detector that the PreToolUse hook uses: given a Bash command string and the set of configured server names, decide whether the command is a *simple* `ssh`/`scp`/`rsync` invocation against a configured server and, if so, which v4 tool to suggest. Best-effort by design — it handles the simple shapes and passes everything else (pipelines, command substitution, multi-host) through with no nudge. This task builds and tests the pure detector; Task 4 wraps it in the stdin/stdout hook shell.

**Files:**
- Create: `.claude/hooks/ssh-bash-nudge.mjs`
- Test: `tests/test-bash-nudge.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-bash-nudge.js`:

```javascript
#!/usr/bin/env node
/**
 * Test suite for the PreToolUse Bash-nudge detector.
 * Run: node tests/test-bash-nudge.js
 */
import assert from 'assert';
import { detectSshNudge } from '../.claude/hooks/ssh-bash-nudge.mjs';

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

console.log('[test] Testing bash-nudge detector\n');

const SERVERS = ['prod01', 'devcentos', 'db1'];

// --- positive: simple ssh -----------------------------------------------
test('plain "ssh <host> <cmd>" against a configured server is nudged', () => {
  const n = detectSshNudge('ssh prod01 uptime', SERVERS);
  assert(n, 'a nudge is returned');
  assert.strictEqual(n.tool, 'ssh_run');
  assert(n.message.includes('prod01'), 'names the server');
  assert(n.message.includes('ssh_run'), 'names the suggested tool');
});

test('"ssh user@host" form is matched on the host part', () => {
  const n = detectSshNudge('ssh root@devcentos df -h', SERVERS);
  assert(n && n.tool === 'ssh_run');
});

test('ssh with a -p port flag before the host is still matched', () => {
  const n = detectSshNudge('ssh -p 22 prod01 whoami', SERVERS);
  assert(n && n.tool === 'ssh_run');
});

// --- positive: scp / rsync ----------------------------------------------
test('scp to a configured server is nudged toward ssh_file', () => {
  const n = detectSshNudge('scp ./app.tar prod01:/srv/app.tar', SERVERS);
  assert(n && n.tool === 'ssh_file');
});

test('rsync to a configured server is nudged toward ssh_file', () => {
  const n = detectSshNudge('rsync -a ./dist/ devcentos:/var/www/', SERVERS);
  assert(n && n.tool === 'ssh_file');
});

// --- negative: not a configured server ----------------------------------
test('ssh to an unconfigured host is NOT nudged', () => {
  assert.strictEqual(detectSshNudge('ssh some-random-box uptime', SERVERS), null);
});

test('a configured name as a substring of another host is not matched', () => {
  // "db1" must not match "db1.example.com" or "olddb1".
  assert.strictEqual(detectSshNudge('ssh db1.example.com ls', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh olddb1 ls', SERVERS), null);
});

// --- negative: complex command lines pass through -----------------------
test('a piped command line is passed through (no nudge)', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 ps aux | grep node', SERVERS), null);
});

test('command substitution is passed through (no nudge)', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 "$(cat cmd.txt)"', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh prod01 `hostname`', SERVERS), null);
});

test('an && / ; chained command line is passed through', () => {
  assert.strictEqual(detectSshNudge('cd /tmp && ssh prod01 ls', SERVERS), null);
  assert.strictEqual(detectSshNudge('ssh prod01 ls; echo done', SERVERS), null);
});

test('a redirected command line is passed through', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 cat big.log > out.txt', SERVERS), null);
});

test('non-ssh commands are never nudged', () => {
  assert.strictEqual(detectSshNudge('ls -la /tmp', SERVERS), null);
  assert.strictEqual(detectSshNudge('git status', SERVERS), null);
});

// --- fail-open ----------------------------------------------------------
test('empty / nullish command is safe and returns null', () => {
  assert.strictEqual(detectSshNudge('', SERVERS), null);
  assert.strictEqual(detectSshNudge(null, SERVERS), null);
  assert.strictEqual(detectSshNudge(undefined, SERVERS), null);
});

test('empty / nullish server list is safe and returns null', () => {
  assert.strictEqual(detectSshNudge('ssh prod01 uptime', []), null);
  assert.strictEqual(detectSshNudge('ssh prod01 uptime', null), null);
});

test('an "ssh" substring inside another word does not trigger', () => {
  // "sshpass" / "myssh" must not be read as the ssh client.
  assert.strictEqual(detectSshNudge('sshpass -p x ssh prod01 ls', SERVERS), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.error(`  [err] ${f.name}\n    ${f.err.stack}`);
  process.exit(1);
}
```

Note `sshpass -p x ssh prod01 ls` is expected to return `null`: it contains a pipe-free `ssh prod01` but the leading token is `sshpass`, not `ssh`/`scp`/`rsync`, so the detector — which only inspects the first token — declines it. Passing an `sshpass` line through unchanged is the correct fail-open behaviour.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-bash-nudge.js`
Expected: FAIL — `Cannot find module '../.claude/hooks/ssh-bash-nudge.mjs'`.

- [ ] **Step 3: Write the hook script (detector portion)**

Create `.claude/hooks/ssh-bash-nudge.mjs` with the content below. This step writes the **whole file** — the detector plus the CLI shell — because the file must be syntactically complete to import. Task 4 verifies the CLI shell; this task's tests cover only the exported `detectSshNudge`.

```javascript
#!/usr/bin/env node
/**
 * PreToolUse hook for the Bash tool. Detects a simple ssh/scp/rsync invocation
 * against a configured server and prints a soft, non-blocking nudge toward the
 * matching ssh_* MCP tool. Best-effort: simple shapes nudged, complex command
 * lines passed through. Fail-open -- any error exits 0 with no nudge.
 *
 * Wired in .claude/settings.json under hooks.PreToolUse, matcher "Bash".
 */
import { readFileSync } from 'fs';

// Shell metacharacters => the command line is not a simple invocation. Bail.
const COMPLEX = /[|&;<>`]|\$\(/;

/** Configured server names from the project .env (best-effort, never throws). */
export function configuredServers(envPath) {
  try {
    const text = readFileSync(envPath, 'utf8');
    const names = new Set();
    for (const line of text.split('\n')) {
      // SSH_SERVER_<NAME>_HOST=... -- <NAME> is the server identifier.
      const m = /^\s*SSH_SERVER_([A-Za-z0-9]+)_HOST\s*=/.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
    return [...names];
  } catch {
    return [];
  }
}

/** Strip a leading user@ and return the bare host token, lowercased. */
function bareHost(token) {
  const at = token.lastIndexOf('@');
  return (at === -1 ? token : token.slice(at + 1)).toLowerCase();
}

/**
 * Inspect a Bash command string. Returns { tool, message } when it is a simple
 * ssh/scp/rsync call against a configured server, else null. Never throws.
 */
export function detectSshNudge(command, servers) {
  try {
    if (!command || typeof command !== 'string') return null;
    if (!Array.isArray(servers) || servers.length === 0) return null;
    if (COMPLEX.test(command)) return null;

    const set = new Set(servers.map((s) => String(s).toLowerCase()));
    const tokens = command.trim().split(/\s+/);
    const head = tokens[0];

    if (head === 'ssh') {
      // First token after the flags that is not a flag or a flag-value is the host.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-p' || t === '-i' || t === '-l' || t === '-o' || t === '-F') {
          i++; // skip this flag's value
          continue;
        }
        if (t.startsWith('-')) continue;
        return set.has(bareHost(t))
          ? { tool: 'ssh_run', message: nudgeText(bareHost(t), 'ssh_run', 'ssh') }
          : null;
      }
      return null;
    }

    if (head === 'scp' || head === 'rsync') {
      // Any non-flag token of the form host:path against a configured server.
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) continue;
        const colon = t.indexOf(':');
        if (colon > 0 && set.has(bareHost(t.slice(0, colon)))) {
          const host = bareHost(t.slice(0, colon));
          return { tool: 'ssh_file', message: nudgeText(host, 'ssh_file', head) };
        }
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/** The soft nudge text shown in the PreToolUse hook output. */
function nudgeText(host, tool, rawCmd) {
  return `[ssh-manager] '${host}' is a configured server. Consider the `
    + `${tool} MCP tool instead of raw \`${rawCmd}\` -- pooled connection, `
    + `bounded output, structured result. (This is a hint, not a block.)`;
}

// --- CLI shell: invoked by Claude Code as a PreToolUse hook --------------
// Reads the hook JSON payload on stdin; prints a nudge on stdout if one
// applies; always exits 0 so the Bash call is never blocked.
function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // no stdin -> nothing to inspect
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable payload -> fail open
  }

  const command = payload && payload.tool_input && payload.tool_input.command;
  const envPath = new URL('../../.env', import.meta.url).pathname;
  const nudge = detectSshNudge(command, configuredServers(envPath));
  if (nudge) console.log(nudge.message);
  process.exit(0);
}

// Run main() only when executed directly, never when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-bash-nudge.js`
Expected: PASS — `16 passed, 0 failed`.

- [ ] **Step 5: Make the hook executable**

Run: `chmod +x .claude/hooks/ssh-bash-nudge.mjs`
Expected: exit 0. The hook is launched via `node`, so the bit is belt-and-braces, but it keeps the file consistent with other executable scripts in the repo.

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/ssh-bash-nudge.mjs tests/test-bash-nudge.js
git commit -m "feat: add PreToolUse Bash-nudge detector for raw ssh invocations"
```

---

## Task 4: Register the hook and verify the CLI shell

The detector is built and tested. Now register it as a Claude Code PreToolUse hook via `.claude/settings.json`, and verify the CLI shell end-to-end: pipe a hook payload to the script and confirm it nudges on a simple invocation, stays silent on a complex one, and always exits 0.

**Files:**
- Create: `.claude/settings.json`
- Test: `tests/test-bash-nudge.js` (extend)

- [ ] **Step 1: Write the failing CLI-shell tests**

In `tests/test-bash-nudge.js`, add this import alongside the existing imports at the top:

```javascript
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
```

Add these tests immediately before the final `console.log(`\n${passed} passed, ${failed} failed`);` line:

```javascript
// --- CLI shell (end-to-end through stdin/stdout) ------------------------
const HOOK = fileURLToPath(new URL('../.claude/hooks/ssh-bash-nudge.mjs', import.meta.url));

// Run the hook with a JSON payload on stdin; capture { stdout, status }.
function runHook(payloadObj) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: JSON.stringify(payloadObj), encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', status: e.status };
  }
}

test('CLI: malformed stdin exits 0 with no output', () => {
  let status;
  try {
    execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    status = 0;
  } catch (e) {
    status = e.status;
  }
  assert.strictEqual(status, 0, 'fail-open on unparseable payload');
});

test('CLI: a non-ssh Bash payload exits 0 with no nudge', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'no nudge for a plain ls');
});

test('CLI: a complex ssh payload exits 0 with no nudge', () => {
  const r = runHook({
    tool_name: 'Bash',
    tool_input: { command: 'ssh prod01 ps aux | grep node' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '', 'piped command passed through');
});

test('CLI: empty payload object exits 0', () => {
  assert.strictEqual(runHook({}).status, 0);
});
```

These four CLI tests pass without any configured server: with no `.env` (or one with no `SSH_SERVER_*` entries), `configuredServers` returns `[]`, so `detectSshNudge` returns `null` and the hook prints nothing — which is exactly what `non-ssh`, `complex`, and `empty` assert. The malformed-stdin test exercises the fail-open path directly. No test depends on a server being configured, so the suite is environment-independent.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-bash-nudge.js`
Expected: FAIL — the new `CLI:` tests reference `runHook` / `HOOK` and `execFileSync`; before the imports and helper land they fail with a `ReferenceError`. (If the import line was added but a test body is missing, the count is wrong — re-check Step 1.)

- [ ] **Step 3: There is no implementation step**

The CLI shell (`main()` and the `import.meta.url === ...` guard) was already written in Task 3 Step 3 as part of the complete file. Step 1's tests exercise that existing code. Move straight to Step 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-bash-nudge.js`
Expected: PASS — `20 passed, 0 failed` (16 detector tests from Task 3 plus 4 CLI tests).

- [ ] **Step 5: Create the settings file that registers the hook**

Create `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/ssh-bash-nudge.mjs\""
          }
        ]
      }
    ]
  }
}
```

The `$CLAUDE_PROJECT_DIR` variable is expanded by Claude Code to the project root, so the hook resolves regardless of the working directory. The hook prints to stdout and exits 0, so it is a pure non-blocking nudge — it never sets a `deny`/`block` decision and never stops a `Bash` call.

- [ ] **Step 6: Validate the settings JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('settings.json valid')"`
Expected: prints `settings.json valid`. Confirms the file parses as JSON.

- [ ] **Step 7: Smoke-test the registered hook path manually**

Run: `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ssh nonexistent-host uptime"}}' | node .claude/hooks/ssh-bash-nudge.mjs; echo "exit=$?"`
Expected: no nudge line (the host is not configured), then `exit=0`. This confirms the exact stdin-to-exit-code path Claude Code drives, end to end.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: `test-bash-nudge.js` contributes 20 passing tests; `0 failed`; no pre-existing suite regresses.

- [ ] **Step 9: Commit**

```bash
git add .claude/settings.json tests/test-bash-nudge.js
git commit -m "feat: register PreToolUse Bash-nudge hook in .claude/settings.json"
```

---

## Task 5: Correct stale tool and test counts

The repo still advertises the pre-v4 surface — `51 tools`, `37 tools`, `7`/`6` groups, `551 tests`, `~43.5k tokens`. Correct every occurrence to the v4 reality: **13 tools**, no tool *groups* (v4 is a flat un-deferred surface), and the live test count. This task is documentation-only — no code, no test logic — so each step gives the exact final text and a concrete verification.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/TOOL_MANAGEMENT.md`
- Modify: `scripts/finalize.sh`

- [ ] **Step 1: Capture the live test count**

Run: `npm test`
Expected: a final line of the form `N files, M passed, 0 failed`. **Record the exact `M`** — this is the post-Plans-4-5 test total, including this plan's `test-tool-descriptions.js` (7) and `test-bash-nudge.js` (20). Use that recorded `M` everywhere Step 2 writes `<TEST_COUNT>`. Do not guess the number; read it from this run.

- [ ] **Step 2: Fix `CLAUDE.md`**

In `CLAUDE.md`, make these three exact replacements.

Replace the Project Overview line:

```
51 tools, 7 groups, opt-in per user. Connection pooling, streaming exec, head+tail output truncation, ASCII-only rendering.
```

with:

```
13 fat verb-tools, each covering one domain via an `action` enum. Always loaded (un-deferred). Connection pooling, streaming exec, head+tail output truncation, command-output compression, ASCII-only rendering.
```

Replace the Architecture bullet:

```
- **`src/index.js`** — MCP server entry, registers all 51 tools via `registerToolConditional()`
```

with:

```
- **`src/index.js`** — MCP server entry, registers the 13 v4 tools via `registerToolConditional()`; descriptions sourced from `src/tool-descriptions.js`
```

Replace the Development and Testing comment (inside the ` ```bash ` block):

```
npm test                     # Run 551 tests across 26 suites
```

with (substituting the `M` recorded in Step 1 for `<TEST_COUNT>`):

```
npm test                     # Run <TEST_COUNT> tests
```

- [ ] **Step 3: Verify `CLAUDE.md` has no stale counts**

Run: `grep -nE "51 tool|37 tool|7 group|551 test|26 suite" CLAUDE.md`
Expected: no output (exit 1) — every stale count is gone. (`13` and the GitNexus block's own symbol counts are unrelated and stay.)

- [ ] **Step 4: Fix `docs/TOOL_MANAGEMENT.md`**

`docs/TOOL_MANAGEMENT.md` documents the v3 per-group enable/disable model, which v4 replaces with a flat always-loaded surface. Rather than rewrite the whole guide, replace its `## Overview` section so it states the v4 reality and points forward. Replace everything from the line `# Tool Management Guide` down to (and including) the line that ends `...maximum efficiency` — i.e. the title, the `## Overview` heading, the intro paragraph, and the `### Why Manage Tools?` list — with:

```markdown
# Tool Management Guide

## Overview

> **v4 update:** the v4 surface is **13 fat verb-tools**, always loaded. The
> per-group enable/disable model described below belonged to the v3 51-tool
> surface and no longer applies — there are no tool *groups* in v4. The 13
> tools serialize to roughly 5k schema tokens, small enough that Claude Code
> keeps them loaded without `ToolSearch`. This guide is retained for historical
> reference; the `ssh-manager tools` CLI subcommands are deprecated.

claude-code-ssh provides **13 tools**, each a verb-tool covering one domain
through an `action` enum (`ssh_run`, `ssh_file`, `ssh_find`, `ssh_logs`,
`ssh_service`, `ssh_health`, `ssh_db`, `ssh_backup`, `ssh_session`, `ssh_net`,
`ssh_docker`, `ssh_fleet`, `ssh_plan`). All 13 are registered unconditionally —
there is nothing to enable or disable.
```

- [ ] **Step 5: Verify `docs/TOOL_MANAGEMENT.md` overview is corrected**

Run: `head -16 docs/TOOL_MANAGEMENT.md`
Expected: the output is the new v4 overview block — it leads with `# Tool Management Guide`, contains the `v4 update:` blockquote, and states `13 tools`. The remaining sections of the file (the per-group reference) are untouched on purpose; the blockquote flags them as deprecated.

- [ ] **Step 6: Fix `scripts/finalize.sh`**

In `scripts/finalize.sh`, the `gh repo edit` call sets a GitHub repository description containing `51 tools`. Replace the description string:

```
    --description "MCP server that gives Claude Code direct SSH access to your server fleet. 51 tools, connection pooled, per-user gated, ASCII output." \
```

with:

```
    --description "MCP server that gives Claude Code direct SSH access to your server fleet. 13 verb-tools, connection pooled, bounded output, ASCII rendering." \
```

(`per-user gated` is also dropped: the v3 per-user tool gating is gone — the v4 surface is always loaded.)

- [ ] **Step 7: Verify `scripts/finalize.sh`**

Run: `grep -n "51 tool\|per-user gated" scripts/finalize.sh; bash -n scripts/finalize.sh && echo "finalize.sh syntax ok"`
Expected: the `grep` prints nothing (the stale phrases are gone); `bash -n` reports `finalize.sh syntax ok` — the script is still valid.

- [ ] **Step 8: Repo-wide stale-count sweep**

Run: `grep -rnE "51 tool|37 tool|~43\.5k|653 test|551 test" CLAUDE.md docs/ scripts/`
Expected: no output (exit 1). Every stale tool-count and test-count reference outside the `docs/superpowers/` plan and spec archive is corrected. The `docs/superpowers/specs/` and `docs/superpowers/plans/` files are a dated historical record and are intentionally left as written — they describe the *journey*, not the current state.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md docs/TOOL_MANAGEMENT.md scripts/finalize.sh
git commit -m "docs: correct stale tool and test counts to the v4 surface"
```

---

## Done criteria

- `src/tool-descriptions.js` exports a frozen `V4_TOOL_DESCRIPTIONS` map with all 13 v4 keys; every description names the raw bash it replaces and carries a when-to-use cue.
- `src/index.js` imports the map and the 13 v4 registrations use `V4_TOOL_DESCRIPTIONS.<tool>` for their `description` field; `node --check src/index.js` passes.
- `CLAUDE.md` has a `## Using the SSH Tools` rule directing Claude to the `ssh_*` MCP tools over raw `ssh`/`scp`/`rsync`, with the pooling / bounded-output / credential-handling rationale.
- `.claude/hooks/ssh-bash-nudge.mjs` exists, is executable, exports `detectSshNudge`, and is registered as a PreToolUse `Bash` hook in `.claude/settings.json`; the hook is fail-open and never blocks a `Bash` call.
- `tests/test-tool-descriptions.js` (7 tests) and `tests/test-bash-nudge.js` (20 tests) are green.
- No stale `51 tools` / `37 tools` / `551 tests` / `~43.5k tokens` reference remains in `CLAUDE.md`, `docs/TOOL_MANAGEMENT.md`, or `scripts/finalize.sh`.
- `npm test` is green — the two new suites add 27 tests; `0 failed`; no pre-existing suite regresses.
- No tool handler in `src/tools/` was modified.

This is the final plan of the v4 redesign. With Plans 1-6 complete, the v4 surface is consolidated (13 tools), token-efficient (compact output, compressors), un-deferred (small schema), and instruction-backed (descriptions, CLAUDE.md rule, PreToolUse hook).

---

## Self-review

Performed after drafting; issues found and fixed inline.

1. **Test-count hardcoding.** First draft of Task 5 hardcoded a test total. This plan is authored in parallel with Plans 4-5, whose final test count is unknowable here — a hardcoded number would be wrong on execution. *Fixed:* Task 5 Step 1 records the live `npm test` count and Step 2 substitutes it for a `<TEST_COUNT>` placeholder. This is the one place a literal number cannot be pre-written; the plan makes the derivation explicit rather than guessing. The standard's "no placeholders" rule is about not leaving stub *content* — here the surrounding instruction is complete and concrete, and the single token is filled from a command run in the same task.

2. **Description map vs. Plan 4 ownership.** Plan 4 builds the v4 registration block and writes *some* `description` for each tool. If Plan 6 only "rewrote" descriptions in place, it would conflict with Plan 4's parallel authoring and the two plans could disagree on wording. *Fixed:* Plan 6 owns descriptions outright via a new `src/tool-descriptions.js` module — Task 1 Step 5 instructs replacing whatever string Plan 4 wrote with `V4_TOOL_DESCRIPTIONS.<tool>`. This is robust to any wording Plan 4 chose and gives a single source of truth. The `src/index.js imports the description map` test guards against a future re-inline.

3. **Hook testability.** A PreToolUse hook is normally an opaque stdin/stdout script — hard to unit-test. *Fixed:* the script exports a pure `detectSshNudge(command, servers)` and guards `main()` behind `import.meta.url === ...` so importing it in a test runs no I/O. Task 3 tests the detector directly (16 cases); Task 4 tests the CLI shell via `execFileSync` (4 cases). Both Task-3 and Task-4 suites are environment-independent — no test needs a real configured server, so they pass in CI with no `.env`.

4. **Substring host-matching false positive.** An early detector matched a configured name as a substring, so `ssh db1.example.com` would wrongly nudge for server `db1`. *Fixed:* `detectSshNudge` compares against an exact `Set` of lowercased names after stripping `user@`, and a test asserts `db1.example.com` and `olddb1` are *not* matched.

5. **`sshpass` edge case.** `sshpass -p x ssh host ...` contains a real `ssh host` substring. A naive `includes('ssh ')` check would mis-fire. *Fixed:* the detector inspects only the first token (`tokens[0]`); `sshpass` is not `ssh`/`scp`/`rsync`, so the line is passed through. A test pins this, and the test note explains why pass-through is the correct fail-open outcome.

6. **Complex-command pass-through completeness.** The spec requires complex command lines pass through unchanged. *Fixed:* the `COMPLEX` regex covers pipes, `&`, `;`, redirects, backticks, and `$(` ; Task 3 tests cover a pipe, `&&`, `;`, redirect, backtick substitution, and `$(...)`. The `ssh`-flag skip loop handles `-p`/`-i`/`-l`/`-o`/`-F` value flags so `ssh -p 22 host cmd` still resolves the host.

7. **`.claude/` commit safety.** Verified `.gitignore` excludes only `.claude/` *runtime* artifacts (`scheduled_tasks.lock`, `scheduled_tasks/`, `.last_run`), and `.claude/` already holds committed `agent-memory/` and `skills/` directories — so `.claude/settings.json` and `.claude/hooks/ssh-bash-nudge.mjs` are tracked normally. No `.gitignore` change is needed and the plan adds none.

8. **Attribution.** No file created or edited by this plan, and no commit message in it, references Claude, Anthropic, or AI. Confirmed across all five `git commit` lines and the inserted `CLAUDE.md` / `docs` / settings content.

9. **GitNexus block preservation.** Task 2 inserts the new `CLAUDE.md` section strictly above the `<!-- gitnexus:start -->` marker, and Step 3 verifies the managed block's start/end markers are still intact — the GitNexus-managed region is never edited. Task 5's `CLAUDE.md` edits target only lines above that block.

10. **Test-runner discovery.** Both new suites are named `test-tool-descriptions.js` and `test-bash-nudge.js`, matching `scripts/run-tests.mjs`'s `/^test-.*\.js$/` filter, and both emit the `N passed, M failed` line that runner Pattern A parses and `process.exit(1)` on failure — consistent with every existing suite and the stated test conventions.
