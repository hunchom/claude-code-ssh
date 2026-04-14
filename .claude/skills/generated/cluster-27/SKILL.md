---
name: cluster-27
description: "Skill for the Cluster_27 area of mcp-ssh-manager. 7 symbols across 1 files."
---

# Cluster_27

7 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how getGroup, listGroups, executeOnGroup work
- Modifying cluster_27-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/server-groups.js` | getGroup, getAllServers, listGroups, executeOnGroup, getGroup (+2) |

## Entry Points

Start here when exploring this area:

- **`getGroup`** (Function) — `src/server-groups.js:400`
- **`listGroups`** (Function) — `src/server-groups.js:406`
- **`executeOnGroup`** (Function) — `src/server-groups.js:407`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getGroup` | Function | `src/server-groups.js` | 400 |
| `listGroups` | Function | `src/server-groups.js` | 406 |
| `executeOnGroup` | Function | `src/server-groups.js` | 407 |
| `getGroup` | Method | `src/server-groups.js` | 92 |
| `getAllServers` | Method | `src/server-groups.js` | 113 |
| `listGroups` | Method | `src/server-groups.js` | 288 |
| `executeOnGroup` | Method | `src/server-groups.js` | 310 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExecuteOnGroup → GetAllServers` | intra_community | 4 |
| `ListGroups → GetAllServers` | intra_community | 3 |
| `GetGroup → GetAllServers` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "getGroup"})` — see callers and callees
2. `gitnexus_query({query: "cluster_27"})` — find related execution flows
3. Read key files listed above for implementation details
