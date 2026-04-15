# Security policy

claude-code-ssh hands an AI assistant credentialed access to production infrastructure. The blast radius of a vulnerability in this project is not theoretical. Please report findings responsibly.

## Supported versions

| Version | Status |
|---|---|
| 3.2.x | Active — security fixes land here |
| 3.1.x | End of life — upgrade to 3.2.x |
| < 3.1 | Unsupported |

## Reporting a vulnerability

Use GitHub's private advisory flow:

**https://github.com/hunchom/claude-code-ssh/security/advisories/new**

Do not open a public issue, do not post to social media, do not publish a PoC before a fix ships.

Include:
- Affected version (check `package.json` or `ssh-manager --version`)
- Preconditions required to reach the vulnerable path
- PoC — minimal, reproducible, ideally against `rocky_8_10_vm`-style throwaway infra
- Your disclosure timeline expectations

## Response timeline

| Phase | Target |
|---|---|
| Acknowledgement | 72 hours |
| Triage + severity classification | 7 days |
| Fix or mitigation plan | 30 days for high/critical, 90 days for medium/low |
| Coordinated disclosure | 90 days from report, or on fix ship — whichever is sooner |

## Scope

In scope:
- Command injection, path traversal, SQL injection in any tool
- Credential leakage through argv, env, logs, error messages, or stdout
- Auth bypass (host key verification, SQL parser allowlist, permission gates)
- SSRF or bastion pivot abuse via `proxy_jump` chains
- Prototype pollution, deserialization flaws
- Any path that lets an untrusted LLM output reach a privileged shell

Out of scope:
- Social engineering of operators
- DoS against the MCP process itself (the server is single-tenant)
- Physical attacks on the host
- Attacks requiring compromised SSH private keys on disk (that is the operator's responsibility)

## Hardening recommendations for operators

- Set `SSH_STRICT_HOSTS=1` to reject unknown hosts instead of TOFU
- Restrict tool groups per project via `ssh-manager tools disable`
- Use dedicated deploy keys with `command=` and `from=` restrictions in `authorized_keys`
- Review `~/.ssh-manager.log` and MCP stderr periodically for anomalous tool invocations
- Keep the `.env` / TOML config in a user-owned directory with `chmod 600`
