---
name: cluster-12
description: "Skill for the Cluster_12 area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Cluster_12

5 symbols | 1 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how save, enableGroup, disableGroup work
- Modifying cluster_12-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tool-config-manager.js` | save, enableGroup, disableGroup, enableTool, setMode |

## Entry Points

Start here when exploring this area:

- **`save`** (Method) — `src/tool-config-manager.js:196`
- **`enableGroup`** (Method) — `src/tool-config-manager.js:220`
- **`disableGroup`** (Method) — `src/tool-config-manager.js:248`
- **`enableTool`** (Method) — `src/tool-config-manager.js:281`
- **`setMode`** (Method) — `src/tool-config-manager.js:334`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `save` | Method | `src/tool-config-manager.js` | 196 |
| `enableGroup` | Method | `src/tool-config-manager.js` | 220 |
| `disableGroup` | Method | `src/tool-config-manager.js` | 248 |
| `enableTool` | Method | `src/tool-config-manager.js` | 281 |
| `setMode` | Method | `src/tool-config-manager.js` | 334 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_6 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "save"})` — see callers and callees
2. `gitnexus_query({query: "cluster_12"})` — find related execution flows
3. Read key files listed above for implementation details
