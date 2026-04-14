---
name: cluster-45
description: "Skill for the Cluster_45 area of mcp-ssh-manager. 6 symbols across 1 files."
---

# Cluster_45

6 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how parseCPUUsage, parseMemoryUsage, parseDiskUsage work
- Modifying cluster_45-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/health-monitor.js` | parseCPUUsage, parseMemoryUsage, parseDiskUsage, parseNetworkStats, determineOverallHealth (+1) |

## Entry Points

Start here when exploring this area:

- **`parseCPUUsage`** (Function) — `src/health-monitor.js:79`
- **`parseMemoryUsage`** (Function) — `src/health-monitor.js:91`
- **`parseDiskUsage`** (Function) — `src/health-monitor.js:110`
- **`parseNetworkStats`** (Function) — `src/health-monitor.js:130`
- **`determineOverallHealth`** (Function) — `src/health-monitor.js:152`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `parseCPUUsage` | Function | `src/health-monitor.js` | 79 |
| `parseMemoryUsage` | Function | `src/health-monitor.js` | 91 |
| `parseDiskUsage` | Function | `src/health-monitor.js` | 110 |
| `parseNetworkStats` | Function | `src/health-monitor.js` | 130 |
| `determineOverallHealth` | Function | `src/health-monitor.js` | 152 |
| `parseComprehensiveHealthCheck` | Function | `src/health-monitor.js` | 376 |

## How to Explore

1. `gitnexus_context({name: "parseCPUUsage"})` — see callers and callees
2. `gitnexus_query({query: "cluster_45"})` — find related execution flows
3. Read key files listed above for implementation details
