---
name: cluster-13
description: "Skill for the Cluster_13 area of mcp-ssh-manager. 13 symbols across 4 files."
---

# Cluster_13

13 symbols | 4 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how isHostKnown work
- Modifying cluster_13-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/index.js` | loadServerConfig, isConnectionValid, setupKeepalive, closeConnection, cleanupOldConnections (+2) |
| `src/ssh-manager.js` | SSHManager, connect, forwardOut, ping |
| `src/ssh-key-manager.js` | isHostKnown |
| `src/logger.js` | logConnection |

## Entry Points

Start here when exploring this area:

- **`isHostKnown`** (Function) — `src/ssh-key-manager.js:78`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `isHostKnown` | Function | `src/ssh-key-manager.js` | 78 |
| `SSHManager` | Class | `src/ssh-manager.js` | 9 |
| `loadServerConfig` | Function | `src/index.js` | 257 |
| `isConnectionValid` | Function | `src/index.js` | 314 |
| `setupKeepalive` | Function | `src/index.js` | 324 |
| `closeConnection` | Function | `src/index.js` | 351 |
| `cleanupOldConnections` | Function | `src/index.js` | 377 |
| `getConnection` | Function | `src/index.js` | 388 |
| `main` | Function | `src/index.js` | 4616 |
| `connect` | Method | `src/ssh-manager.js` | 21 |
| `forwardOut` | Method | `src/ssh-manager.js` | 460 |
| `ping` | Method | `src/ssh-manager.js` | 472 |
| `logConnection` | Method | `src/logger.js` | 206 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → ParseKnownHostEntry` | cross_community | 5 |
| `Main → Dispose` | cross_community | 4 |
| `Main → LogConnection` | intra_community | 4 |
| `GetConnection → ExecCommand` | cross_community | 4 |
| `SetupKeepalive → ExecCommand` | cross_community | 4 |
| `Main → IsHostKnown` | intra_community | 3 |
| `GetConnection → LoadHooksConfig` | cross_community | 3 |
| `GetConnection → LoadAliases` | cross_community | 3 |
| `SetupKeepalive → Dispose` | cross_community | 3 |
| `SetupKeepalive → LogConnection` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_14 | 2 calls |
| Cluster_28 | 2 calls |
| Cluster_18 | 1 calls |
| Cluster_43 | 1 calls |
| Cluster_29 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "isHostKnown"})` — see callers and callees
2. `gitnexus_query({query: "cluster_13"})` — find related execution flows
3. Read key files listed above for implementation details
