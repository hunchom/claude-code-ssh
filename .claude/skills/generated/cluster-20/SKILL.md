---
name: cluster-20
description: "Skill for the Cluster_20 area of mcp-ssh-manager. 6 symbols across 1 files."
---

# Cluster_20

6 symbols | 1 files | Cohesion: 92%

## When to Use

- Working with code in `src/`
- Understanding how createSession work
- Modifying cluster_20-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/session-manager.js` | SSHSession, initialize, waitForPrompt, updateContext, execute (+1) |

## Entry Points

Start here when exploring this area:

- **`createSession`** (Function) — `src/session-manager.js:289`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createSession` | Function | `src/session-manager.js` | 289 |
| `SSHSession` | Class | `src/session-manager.js` | 20 |
| `initialize` | Method | `src/session-manager.js` | 42 |
| `waitForPrompt` | Method | `src/session-manager.js` | 107 |
| `updateContext` | Method | `src/session-manager.js` | 126 |
| `execute` | Method | `src/session-manager.js` | 150 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CreateSession → WaitForPrompt` | intra_community | 5 |
| `CreateSession → Cleanup` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_22 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "createSession"})` — see callers and callees
2. `gitnexus_query({query: "cluster_20"})` — find related execution flows
3. Read key files listed above for implementation details
