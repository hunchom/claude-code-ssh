---
name: cluster-18
description: "Skill for the Cluster_18 area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Cluster_18

5 symbols | 1 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how removeHostKey, addHostKey, updateHostKey work
- Modifying cluster_18-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ssh-key-manager.js` | removeHostKey, addHostKey, updateHostKey, extractHostFromSSHError, handleSSHKeyError |

## Entry Points

Start here when exploring this area:

- **`removeHostKey`** (Function) — `src/ssh-key-manager.js:136`
- **`addHostKey`** (Function) — `src/ssh-key-manager.js:154`
- **`updateHostKey`** (Function) — `src/ssh-key-manager.js:190`
- **`extractHostFromSSHError`** (Function) — `src/ssh-key-manager.js:322`
- **`handleSSHKeyError`** (Function) — `src/ssh-key-manager.js:351`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `removeHostKey` | Function | `src/ssh-key-manager.js` | 136 |
| `addHostKey` | Function | `src/ssh-key-manager.js` | 154 |
| `updateHostKey` | Function | `src/ssh-key-manager.js` | 190 |
| `extractHostFromSSHError` | Function | `src/ssh-key-manager.js` | 322 |
| `handleSSHKeyError` | Function | `src/ssh-key-manager.js` | 351 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleSSHKeyError → ParseKnownHostEntry` | cross_community | 5 |
| `Main → ParseKnownHostEntry` | cross_community | 5 |
| `HandleSSHKeyError → RemoveHostKey` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_17 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "removeHostKey"})` — see callers and callees
2. `gitnexus_query({query: "cluster_18"})` — find related execution flows
3. Read key files listed above for implementation details
