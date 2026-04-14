---
name: cluster-82
description: "Skill for the Cluster_82 area of mcp-ssh-manager. 7 symbols across 1 files."
---

# Cluster_82

7 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how loadCommandAliases, saveCommandAliases, expandCommandAlias work
- Modifying cluster_82-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/command-aliases.js` | loadCommandAliases, saveCommandAliases, expandCommandAlias, addCommandAlias, removeCommandAlias (+2) |

## Entry Points

Start here when exploring this area:

- **`loadCommandAliases`** (Function) — `src/command-aliases.js:27`
- **`saveCommandAliases`** (Function) — `src/command-aliases.js:48`
- **`expandCommandAlias`** (Function) — `src/command-aliases.js:69`
- **`addCommandAlias`** (Function) — `src/command-aliases.js:92`
- **`removeCommandAlias`** (Function) — `src/command-aliases.js:101`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadCommandAliases` | Function | `src/command-aliases.js` | 27 |
| `saveCommandAliases` | Function | `src/command-aliases.js` | 48 |
| `expandCommandAlias` | Function | `src/command-aliases.js` | 69 |
| `addCommandAlias` | Function | `src/command-aliases.js` | 92 |
| `removeCommandAlias` | Function | `src/command-aliases.js` | 101 |
| `listCommandAliases` | Function | `src/command-aliases.js` | 117 |
| `suggestAliases` | Function | `src/command-aliases.js` | 136 |

## How to Explore

1. `gitnexus_context({name: "loadCommandAliases"})` — see callers and callees
2. `gitnexus_query({query: "cluster_82"})` — find related execution flows
3. Read key files listed above for implementation details
