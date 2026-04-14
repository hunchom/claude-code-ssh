---
name: cluster-26
description: "Skill for the Cluster_26 area of mcp-ssh-manager. 11 symbols across 1 files."
---

# Cluster_26

11 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how createGroup, updateGroup, deleteGroup work
- Modifying cluster_26-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/server-groups.js` | saveGroups, createGroup, updateGroup, deleteGroup, addServers (+6) |

## Entry Points

Start here when exploring this area:

- **`createGroup`** (Function) — `src/server-groups.js:401`
- **`updateGroup`** (Function) — `src/server-groups.js:402`
- **`deleteGroup`** (Function) — `src/server-groups.js:403`
- **`addServersToGroup`** (Function) — `src/server-groups.js:404`
- **`removeServersFromGroup`** (Function) — `src/server-groups.js:405`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createGroup` | Function | `src/server-groups.js` | 401 |
| `updateGroup` | Function | `src/server-groups.js` | 402 |
| `deleteGroup` | Function | `src/server-groups.js` | 403 |
| `addServersToGroup` | Function | `src/server-groups.js` | 404 |
| `removeServersFromGroup` | Function | `src/server-groups.js` | 405 |
| `saveGroups` | Method | `src/server-groups.js` | 70 |
| `createGroup` | Method | `src/server-groups.js` | 130 |
| `updateGroup` | Method | `src/server-groups.js` | 160 |
| `deleteGroup` | Method | `src/server-groups.js` | 204 |
| `addServers` | Method | `src/server-groups.js` | 227 |
| `removeServers` | Method | `src/server-groups.js` | 258 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CreateGroup → SaveGroups` | intra_community | 3 |
| `UpdateGroup → SaveGroups` | intra_community | 3 |
| `DeleteGroup → SaveGroups` | intra_community | 3 |
| `AddServersToGroup → SaveGroups` | intra_community | 3 |
| `RemoveServersFromGroup → SaveGroups` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "createGroup"})` — see callers and callees
2. `gitnexus_query({query: "cluster_26"})` — find related execution flows
3. Read key files listed above for implementation details
