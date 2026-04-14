---
name: cluster-6
description: "Skill for the Cluster_6 area of mcp-ssh-manager. 5 symbols across 2 files."
---

# Cluster_6

5 symbols | 2 files | Cohesion: 67%

## When to Use

- Working with code in `src/`
- Understanding how getAllTools, validateToolRegistry, getToolStats work
- Modifying cluster_6-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tool-registry.js` | getAllTools, validateToolRegistry, getToolStats, verifyIntegrity |
| `src/tool-config-manager.js` | disableTool |

## Entry Points

Start here when exploring this area:

- **`getAllTools`** (Function) — `src/tool-registry.js:102`
- **`validateToolRegistry`** (Function) — `src/tool-registry.js:134`
- **`getToolStats`** (Function) — `src/tool-registry.js:155`
- **`verifyIntegrity`** (Function) — `src/tool-registry.js:175`
- **`disableTool`** (Method) — `src/tool-config-manager.js:305`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getAllTools` | Function | `src/tool-registry.js` | 102 |
| `validateToolRegistry` | Function | `src/tool-registry.js` | 134 |
| `getToolStats` | Function | `src/tool-registry.js` | 155 |
| `verifyIntegrity` | Function | `src/tool-registry.js` | 175 |
| `disableTool` | Method | `src/tool-config-manager.js` | 305 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LoadToolConfig → GetAllTools` | cross_community | 4 |
| `ExportClaudeCodeConfig → GetAllTools` | cross_community | 3 |
| `GetSummary → GetAllTools` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_12 | 1 calls |

## How to Explore

1. `gitnexus_context({name: "getAllTools"})` — see callers and callees
2. `gitnexus_query({query: "cluster_6"})` — find related execution flows
3. Read key files listed above for implementation details
