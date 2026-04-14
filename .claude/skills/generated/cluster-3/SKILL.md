---
name: cluster-3
description: "Skill for the Cluster_3 area of mcp-ssh-manager. 8 symbols across 1 files."
---

# Cluster_3

8 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how createTunnel, monitorTunnels work
- Modifying cluster_3-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tunnel-manager.js` | SSHTunnel, start, startLocalForwarding, startRemoteForwarding, startDynamicForwarding (+3) |

## Entry Points

Start here when exploring this area:

- **`createTunnel`** (Function) — `src/tunnel-manager.js:440`
- **`monitorTunnels`** (Function) — `src/tunnel-manager.js:543`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `createTunnel` | Function | `src/tunnel-manager.js` | 440 |
| `monitorTunnels` | Function | `src/tunnel-manager.js` | 543 |
| `SSHTunnel` | Class | `src/tunnel-manager.js` | 28 |
| `start` | Method | `src/tunnel-manager.js` | 53 |
| `startLocalForwarding` | Method | `src/tunnel-manager.js` | 95 |
| `startRemoteForwarding` | Method | `src/tunnel-manager.js` | 172 |
| `startDynamicForwarding` | Method | `src/tunnel-manager.js` | 239 |
| `reconnect` | Method | `src/tunnel-manager.js` | 405 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `MonitorTunnels → StartLocalForwarding` | intra_community | 4 |
| `MonitorTunnels → StartRemoteForwarding` | intra_community | 4 |
| `MonitorTunnels → StartDynamicForwarding` | intra_community | 4 |
| `CreateTunnel → StartLocalForwarding` | intra_community | 3 |
| `CreateTunnel → StartRemoteForwarding` | intra_community | 3 |
| `CreateTunnel → StartDynamicForwarding` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "createTunnel"})` — see callers and callees
2. `gitnexus_query({query: "cluster_3"})` — find related execution flows
3. Read key files listed above for implementation details
