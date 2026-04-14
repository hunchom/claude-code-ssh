---
name: cluster-10
description: "Skill for the Cluster_10 area of mcp-ssh-manager. 4 symbols across 1 files."
---

# Cluster_10

4 symbols | 1 files | Cohesion: 67%

## When to Use

- Working with code in `src/`
- Understanding how getEnabledTools, getDisabledTools, getSummary work
- Modifying cluster_10-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tool-config-manager.js` | getEnabledTools, getDisabledTools, getSummary, exportClaudeCodeConfig |

## Entry Points

Start here when exploring this area:

- **`getEnabledTools`** (Method) — `src/tool-config-manager.js:153`
- **`getDisabledTools`** (Method) — `src/tool-config-manager.js:162`
- **`getSummary`** (Method) — `src/tool-config-manager.js:359`
- **`exportClaudeCodeConfig`** (Method) — `src/tool-config-manager.js:381`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getEnabledTools` | Method | `src/tool-config-manager.js` | 153 |
| `getDisabledTools` | Method | `src/tool-config-manager.js` | 162 |
| `getSummary` | Method | `src/tool-config-manager.js` | 359 |
| `exportClaudeCodeConfig` | Method | `src/tool-config-manager.js` | 381 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `LoadToolConfig → GetAllTools` | cross_community | 4 |
| `ExportClaudeCodeConfig → GetAllTools` | cross_community | 3 |
| `GetSummary → GetAllTools` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_6 | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getEnabledTools"})` — see callers and callees
2. `gitnexus_query({query: "cluster_10"})` — find related execution flows
3. Read key files listed above for implementation details
