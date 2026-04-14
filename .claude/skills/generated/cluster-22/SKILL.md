---
name: cluster-22
description: "Skill for the Cluster_22 area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Cluster_22

5 symbols | 1 files | Cohesion: 89%

## When to Use

- Working with code in `src/`
- Understanding how closeSession, closeServerSessions, cleanupSessions work
- Modifying cluster_22-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/session-manager.js` | close, cleanup, closeSession, closeServerSessions, cleanupSessions |

## Entry Points

Start here when exploring this area:

- **`closeSession`** (Function) — `src/session-manager.js:345`
- **`closeServerSessions`** (Function) — `src/session-manager.js:359`
- **`cleanupSessions`** (Function) — `src/session-manager.js:375`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `closeSession` | Function | `src/session-manager.js` | 345 |
| `closeServerSessions` | Function | `src/session-manager.js` | 359 |
| `cleanupSessions` | Function | `src/session-manager.js` | 375 |
| `close` | Method | `src/session-manager.js` | 262 |
| `cleanup` | Method | `src/session-manager.js` | 278 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CreateSession → Cleanup` | cross_community | 3 |
| `CloseServerSessions → Cleanup` | intra_community | 3 |
| `CleanupSessions → Cleanup` | intra_community | 3 |
| `CloseSession → Cleanup` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "closeSession"})` — see callers and callees
2. `gitnexus_query({query: "cluster_22"})` — find related execution flows
3. Read key files listed above for implementation details
