---
name: examples
description: "Skill for the Examples area of mcp-ssh-manager. 5 symbols across 1 files."
---

# Examples

5 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `examples/`
- Understanding how create_deployment_config, deploy_erpnext_customization, deploy_web_application work
- Modifying examples-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `examples/deploy-workflow.py` | create_deployment_config, deploy_erpnext_customization, deploy_web_application, deploy_configuration_files, main |

## Entry Points

Start here when exploring this area:

- **`create_deployment_config`** (Function) — `examples/deploy-workflow.py:16`
- **`deploy_erpnext_customization`** (Function) — `examples/deploy-workflow.py:27`
- **`deploy_web_application`** (Function) — `examples/deploy-workflow.py:64`
- **`deploy_configuration_files`** (Function) — `examples/deploy-workflow.py:98`
- **`main`** (Function) — `examples/deploy-workflow.py:128`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `create_deployment_config` | Function | `examples/deploy-workflow.py` | 16 |
| `deploy_erpnext_customization` | Function | `examples/deploy-workflow.py` | 27 |
| `deploy_web_application` | Function | `examples/deploy-workflow.py` | 64 |
| `deploy_configuration_files` | Function | `examples/deploy-workflow.py` | 98 |
| `main` | Function | `examples/deploy-workflow.py` | 128 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Create_deployment_config` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "create_deployment_config"})` — see callers and callees
2. `gitnexus_query({query: "examples"})` — find related execution flows
3. Read key files listed above for implementation details
