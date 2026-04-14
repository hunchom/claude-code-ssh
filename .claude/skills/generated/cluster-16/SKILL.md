---
name: cluster-16
description: "Skill for the Cluster_16 area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Cluster_16

5 symbols | 1 files | Cohesion: 92%

## When to Use

- Working with code in `src/`
- Understanding how getSFTP, resolveHomePath, putFile work
- Modifying cluster_16-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ssh-manager.js` | getSFTP, resolveHomePath, putFile, getFile, putFiles |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getSFTP` | Method | `src/ssh-manager.js` | 275 |
| `resolveHomePath` | Method | `src/ssh-manager.js` | 290 |
| `putFile` | Method | `src/ssh-manager.js` | 360 |
| `getFile` | Method | `src/ssh-manager.js` | 397 |
| `putFiles` | Method | `src/ssh-manager.js` | 428 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `PutFiles → ExecCommand` | cross_community | 4 |
| `PutFiles → GetSFTP` | intra_community | 3 |
| `GetFile → ExecCommand` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_14 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "getSFTP"})` — see callers and callees
2. `gitnexus_query({query: "cluster_16"})` — find related execution flows
3. Read key files listed above for implementation details
