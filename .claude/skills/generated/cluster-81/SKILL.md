---
name: cluster-81
description: "Skill for the Cluster_81 area of mcp-ssh-manager. 7 symbols across 1 files."
---

# Cluster_81

7 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how load, loadTomlConfig, loadEnvConfig work
- Modifying cluster_81-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/config-loader.js` | load, loadTomlConfig, loadEnvConfig, loadEnvironmentVariables, parseEnvVariables (+2) |

## Entry Points

Start here when exploring this area:

- **`load`** (Method) — `src/config-loader.js:19`
- **`loadTomlConfig`** (Method) — `src/config-loader.js:76`
- **`loadEnvConfig`** (Method) — `src/config-loader.js:105`
- **`loadEnvironmentVariables`** (Method) — `src/config-loader.js:113`
- **`parseEnvVariables`** (Method) — `src/config-loader.js:120`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `load` | Method | `src/config-loader.js` | 19 |
| `loadTomlConfig` | Method | `src/config-loader.js` | 76 |
| `loadEnvConfig` | Method | `src/config-loader.js` | 105 |
| `loadEnvironmentVariables` | Method | `src/config-loader.js` | 113 |
| `parseEnvVariables` | Method | `src/config-loader.js` | 120 |
| `exportToToml` | Method | `src/config-loader.js` | 178 |
| `migrateEnvToToml` | Method | `src/config-loader.js` | 269 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `MigrateEnvToToml → ParseEnvVariables` | intra_community | 3 |
| `Load → ParseEnvVariables` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "load"})` — see callers and callees
2. `gitnexus_query({query: "cluster_81"})` — find related execution flows
3. Read key files listed above for implementation details
