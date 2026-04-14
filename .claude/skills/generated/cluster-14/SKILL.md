---
name: cluster-14
description: "Skill for the Cluster_14 area of mcp-ssh-manager. 4 symbols across 3 files."
---

# Cluster_14

4 symbols | 3 files | Cohesion: 60%

## When to Use

- Working with code in `src/`
- Understanding how execCommand, dispose, execCommandWithTimeout work
- Modifying cluster_14-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ssh-manager.js` | execCommand, dispose |
| `src/index.js` | execCommandWithTimeout |
| `src/hooks-system.js` | executeAction |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `execCommandWithTimeout` | Function | `src/index.js` | 264 |
| `executeAction` | Function | `src/hooks-system.js` | 206 |
| `execCommand` | Method | `src/ssh-manager.js` | 127 |
| `dispose` | Method | `src/ssh-manager.js` | 449 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Dispose` | cross_community | 4 |
| `PutFiles → ExecCommand` | cross_community | 4 |
| `GetConnection → ExecCommand` | cross_community | 4 |
| `SetupKeepalive → ExecCommand` | cross_community | 4 |
| `SetupKeepalive → Dispose` | cross_community | 3 |
| `GetFile → ExecCommand` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "execCommand"})` — see callers and callees
2. `gitnexus_query({query: "cluster_14"})` — find related execution flows
3. Read key files listed above for implementation details
