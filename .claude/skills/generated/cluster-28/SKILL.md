---
name: cluster-28
description: "Skill for the Cluster_28 area of mcp-ssh-manager. 6 symbols across 1 files."
---

# Cluster_28

6 symbols | 1 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how loadAliases, saveAliases, resolveServerName work
- Modifying cluster_28-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/server-aliases.js` | loadAliases, saveAliases, resolveServerName, addAlias, removeAlias (+1) |

## Entry Points

Start here when exploring this area:

- **`loadAliases`** (Function) — `src/server-aliases.js:17`
- **`saveAliases`** (Function) — `src/server-aliases.js:32`
- **`resolveServerName`** (Function) — `src/server-aliases.js:45`
- **`addAlias`** (Function) — `src/server-aliases.js:125`
- **`removeAlias`** (Function) — `src/server-aliases.js:134`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadAliases` | Function | `src/server-aliases.js` | 17 |
| `saveAliases` | Function | `src/server-aliases.js` | 32 |
| `resolveServerName` | Function | `src/server-aliases.js` | 45 |
| `addAlias` | Function | `src/server-aliases.js` | 125 |
| `removeAlias` | Function | `src/server-aliases.js` | 134 |
| `listAliases` | Function | `src/server-aliases.js` | 143 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `GetConnection → LoadAliases` | cross_community | 3 |

## How to Explore

1. `gitnexus_context({name: "loadAliases"})` — see callers and callees
2. `gitnexus_query({query: "cluster_28"})` — find related execution flows
3. Read key files listed above for implementation details
