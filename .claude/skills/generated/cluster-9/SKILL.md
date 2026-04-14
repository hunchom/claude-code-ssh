---
name: cluster-9
description: "Skill for the Cluster_9 area of mcp-ssh-manager. 6 symbols across 1 files."
---

# Cluster_9

6 symbols | 1 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how loadToolConfig, ToolConfigManager, load work
- Modifying cluster_9-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tool-config-manager.js` | ToolConfigManager, load, getDefaultConfig, validateConfig, reset (+1) |

## Entry Points

Start here when exploring this area:

- **`loadToolConfig`** (Function) — `src/tool-config-manager.js:407`
- **`ToolConfigManager`** (Class) — `src/tool-config-manager.js:23`
- **`load`** (Method) — `src/tool-config-manager.js:33`
- **`getDefaultConfig`** (Method) — `src/tool-config-manager.js:66`
- **`validateConfig`** (Method) — `src/tool-config-manager.js:88`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ToolConfigManager` | Class | `src/tool-config-manager.js` | 23 |
| `loadToolConfig` | Function | `src/tool-config-manager.js` | 407 |
| `load` | Method | `src/tool-config-manager.js` | 33 |
| `getDefaultConfig` | Method | `src/tool-config-manager.js` | 66 |
| `validateConfig` | Method | `src/tool-config-manager.js` | 88 |
| `reset` | Method | `src/tool-config-manager.js` | 349 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LoadToolConfig → GetAllTools` | cross_community | 4 |
| `LoadToolConfig → ValidateConfig` | intra_community | 3 |
| `LoadToolConfig → GetDefaultConfig` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_10 | 1 calls |
| Cluster_12 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "loadToolConfig"})` — see callers and callees
2. `gitnexus_query({query: "cluster_9"})` — find related execution flows
3. Read key files listed above for implementation details
