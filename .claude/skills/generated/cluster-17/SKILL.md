---
name: cluster-17
description: "Skill for the Cluster_17 area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Cluster_17

5 symbols | 1 files | Cohesion: 91%

## When to Use

- Working with code in `src/`
- Understanding how getHostKeyFingerprint, getCurrentHostKey, hasHostKeyChanged work
- Modifying cluster_17-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ssh-key-manager.js` | parseKnownHostEntry, getHostKeyFingerprint, getCurrentHostKey, hasHostKeyChanged, listKnownHosts |

## Entry Points

Start here when exploring this area:

- **`getHostKeyFingerprint`** (Function) — `src/ssh-key-manager.js:31`
- **`getCurrentHostKey`** (Function) — `src/ssh-key-manager.js:101`
- **`hasHostKeyChanged`** (Function) — `src/ssh-key-manager.js:209`
- **`listKnownHosts`** (Function) — `src/ssh-key-manager.js:247`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getHostKeyFingerprint` | Function | `src/ssh-key-manager.js` | 31 |
| `getCurrentHostKey` | Function | `src/ssh-key-manager.js` | 101 |
| `hasHostKeyChanged` | Function | `src/ssh-key-manager.js` | 209 |
| `listKnownHosts` | Function | `src/ssh-key-manager.js` | 247 |
| `parseKnownHostEntry` | Function | `src/ssh-key-manager.js` | 14 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleSSHKeyError → ParseKnownHostEntry` | cross_community | 5 |
| `Main → ParseKnownHostEntry` | cross_community | 5 |
| `HasHostKeyChanged → ParseKnownHostEntry` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "getHostKeyFingerprint"})` — see callers and callees
2. `gitnexus_query({query: "cluster_17"})` — find related execution flows
3. Read key files listed above for implementation details
