# Architecture

How the MCP server, connection pool, and tool layer fit together.

## 30-second mental model

```mermaid
flowchart LR
  subgraph client["your machine"]
    C[Claude Code]
  end
  subgraph server["claude-code-ssh (Node.js MCP server)"]
    I[index.js<br/>MCP entry]
    R[tool-registry.js]
    T["17 tool handlers<br/>src/tools/*.js"]
    P["connection pool<br/>Map&lt;name, Client&gt;"]
    S[stream-exec.js]
    O[output-formatter.js]
    I --> R
    R --> T
    T --> P
    T --> S
    T --> O
  end
  subgraph fleet["your SSH fleet"]
    H1[prod01]
    H2[prod02]
    B[bastion]
  end
  C -- JSON-RPC over stdio --> I
  P --> H1
  P --> H2
  P -. ProxyJump .-> B
```

## The MCP handshake

When Claude Code starts the server, these are the messages:

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant S as claude-code-ssh
  CC->>S: initialize(protocolVersion, capabilities)
  S-->>CC: initialize result(serverInfo, capabilities)
  CC->>S: tools/list
  S-->>CC: tools(51 schemas, gated by user config)
  CC->>S: notifications/initialized
  Note over CC,S: handshake complete, tools available
```

The 51-schema payload is ~43k tokens in full mode. Per-user gating (via `~/.ssh-manager/tools-config.json`) trims the payload to only enabled groups.

## Tool registration

`src/index.js` registers tools conditionally via `registerToolConditional()`:

- The registry (`src/tool-registry.js`) defines 7 groups with their tool names.
- At startup, the config manager (`src/tool-config-manager.js`) reads `~/.ssh-manager/tools-config.json`.
- For each tool in an enabled group, the handler is imported from `src/tools/*.js` and registered.
- Disabled groups never load their handlers — saving both startup time and MCP schema payload.

## Connection pool lifecycle

```mermaid
stateDiagram-v2
  [*] --> Requested: tool asks for client(prod01)
  Requested --> Warm: pool has active client
  Requested --> Dial: pool empty or dead
  Dial --> Authenticating: TCP + SSH handshake
  Authenticating --> Authenticated: key/password accepted
  Authenticated --> Warm: cached in pool Map
  Warm --> Used: command issued
  Used --> Warm: command complete, keep alive
  Warm --> Idle: no activity
  Idle --> [*]: 30min timeout (configurable)
  Idle --> Warm: next command re-activates
```

Key properties:

- **One pool entry per server name** — Map keyed by `name` (not IP, so aliases share the pool).
- **Alias resolution** — names are normalized to lowercase; aliases resolve before pool lookup (`src/index.js:54-68`).
- **Dead connection recovery** — if a command fails with `client.exec is not a function` or a closed channel, the pool evicts and redials transparently on the next call.

## Output pipeline

Raw SSH output never reaches Claude directly. It flows through:

```mermaid
flowchart LR
  E[stream-exec.js<br/>UTF-8 safe chunking] --> F[output-formatter.js<br/>ASCII markdown tables]
  F --> T[head+tail truncation<br/>N lines top, N lines bottom]
  T --> M[MCP response]
```

- `stream-exec.js` handles backpressure and UTF-8 boundary safety — a multibyte character split across two chunks won't render as `?`.
- `output-formatter.js` renders tabular outputs (`df`, `free`, `ps`) as plain ASCII markdown. No Unicode box-drawing characters — kept ASCII-only for CI verification.
- Head+tail truncation caps verbose outputs. A 10,000-line `journalctl --no-pager` becomes ~80 lines (first 40, middle `... 9,920 lines elided ...`, last 40) before reaching Claude.

## Tool invocation flow

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant R as registerToolConditional
  participant H as tool handler
  participant P as ssh2 pool
  participant Host
  CC->>R: tools/call(name=ssh_execute, args)
  R->>H: validate against zod schema
  H->>P: getClient(server)
  P-->>H: Client (warm or redial)
  H->>Host: exec command
  Host-->>H: stdout/stderr stream
  H->>H: stream-exec + formatter
  H-->>CC: content blocks (text, ASCII table)
```

Every tool handler is under 100 lines — the heavy lifting is in the shared modules (`stream-exec`, `output-formatter`, `ssh-manager`).

## Profile system

`src/profile-loader.js` resolves a profile name to a set of enabled groups. Profiles compose:

- User-level config (`~/.ssh-manager/tools-config.json`)
- Per-project override (`.ssh-manager.config.json` in cwd)
- Environment variable (`SSH_MANAGER_PROFILE=devops`)

Precedence: env > per-project > user > default.

## Why JavaScript and not TypeScript

The project is intentionally TS-free to minimize tool surface. ~30 source files, no build step. Zod schemas provide runtime validation where TypeScript would provide compile-time checks — which is what matters for an MCP server whose input comes from an LLM at runtime.
