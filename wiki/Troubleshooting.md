# Troubleshooting

Common failure modes and how to diagnose them.

## Enable debug logging first

Before anything else:

```bash
SSH_LOG_LEVEL=DEBUG npm start
```

Or for one tool invocation in Claude Code, ask:

```
restart the ssh-manager MCP with debug logging
```

Logs write to `~/.ssh-manager.log` and MCP stderr.

---

## "client.exec is not a function"

**Cause:** SSHManager wrapper doesn't have a passthrough for the method ssh2's Client expects. Fixed for `exec`, `sftp`, `forwardOut`, and `shell` in v3.2.2.

**Fix:** upgrade to 3.2.2 or newer:

```bash
cd claude-code-ssh && git pull && npm install
```

If you're on 3.2.2+ and still see it: reproduce with debug logging and [file an issue](https://github.com/hunchom/claude-code-ssh/issues/new/choose).

## "host fingerprint mismatch"

**Cause:** The host key the remote presented doesn't match what's in `known_hosts`. This is either:
- The remote legitimately rotated its key (reinstall, rebuild, etc.)
- Someone is MITMing the connection

**Fix:**

```bash
# Verify the remote's actual fingerprint out-of-band (console access, previous known-good):
ssh-keyscan -t ed25519 10.0.0.10 | ssh-keygen -lf -

# If legitimate rotation, remove the stale entry and reconnect (TOFU will record the new one):
ssh-keygen -R 10.0.0.10
```

> [!CAUTION]
> Never blindly remove the entry and reconnect. If the mismatch is a MITM, you're trusting the attacker's key.

## "permission denied (publickey)"

Checklist:

1. Key path is absolute or tilde-expanded: `~/.ssh/id_ed25519` works, `./keys/id_ed25519` doesn't.
2. Permissions on the key are `600`: `chmod 600 ~/.ssh/id_ed25519`.
3. Passphrase is set if needed: `SSH_SERVER_NAME_PASSPHRASE=...`.
4. Remote user has the public key in `~/.ssh/authorized_keys`.
5. Remote `sshd_config` allows key auth and the user isn't in `DenyUsers`.

Run manually to isolate:

```bash
ssh -v -i ~/.ssh/id_ed25519 deploy@10.0.0.10
```

## "server X not found"

The server name resolution is case-insensitive but must match exactly otherwise.

```bash
./cli/ssh-manager server list
```

If your server isn't there:

1. Check `.env` is in repo root, not `$HOME`.
2. Check the variable prefix: `SSH_SERVER_PROD01_HOST` (all caps, underscores).
3. Check for `SSH_SERVER_PROD01_USER` — host alone isn't enough.
4. Alias? Check `ssh_alias list`.

## Tools missing in Claude Code

Claude sees fewer tools than expected? Check gating:

```bash
./cli/ssh-manager tools list
```

Enable missing groups:

```bash
./cli/ssh-manager tools enable database
```

Then reconnect Claude Code (the MCP handshake is one-shot; changes require a restart).

## "SFTP channel limit exceeded"

**Cause:** Pre-3.2.2 SFTP handles leaked on error paths. Fixed.

**Workaround if stuck on old version:** restart the MCP server. Each restart resets the pool.

## DB tool: "sql rejected"

The SQL parser is strict. If you see `Only SELECT statements are allowed`:

- Remove leading comments (`/* ... */` before `SELECT`).
- Remove trailing semicolons followed by additional statements.
- `WITH ... SELECT` (CTEs) is fine; `WITH ... INSERT` is not.

For writes, use `ssh_execute` against the DB CLI:

```
ssh_execute server=prod01 command="psql -U app -d payments -c \"INSERT INTO ...\""
```

## Tunnels refuse to connect

```
ssh_tunnel_create type=local server=bastion local_port=3000 remote_host=grafana.internal remote_port=3000
```

Then `localhost:3000` refuses connection. Checklist:

1. Bastion can reach `grafana.internal:3000`? Verify with `ssh_execute server=bastion command="nc -zv grafana.internal 3000"`.
2. Local port not already in use? `lsof -i :3000` locally.
3. Tunnel actually started? `ssh_tunnel_list` should show it.
4. MCP process still running? Tunnels die if the server restarts.

## Slow first command per host

Normal. The first command dials the connection (~200-500ms handshake). Subsequent commands on the same host reuse the pooled client — near-zero overhead.

If the first command takes >5 seconds, the handshake itself is slow. Check:

- Network latency to the host (`ping`).
- `sshd` is running `sshd -d` with heavy debug (rare; uncommon).
- Bastion chain has a slow first hop.

## The CI workflow fails on ASCII check

`quality.yml` rejects non-ASCII in `src/` and `tests/`. If your change introduced an em-dash or smart quote:

```bash
LC_ALL=C grep -rnP '[^\x00-\x7F]' src/ tests/ --include='*.js'
```

Replace with ASCII equivalents (`--`, `"`, `'`).

## Reporting an issue

If you've exhausted the above, file a bug:

1. Run with `SSH_LOG_LEVEL=DEBUG` to reproduce.
2. Capture `~/.ssh-manager.log` (redact hostnames/credentials).
3. Use the bug report form: https://github.com/hunchom/claude-code-ssh/issues/new/choose

For suspected vulnerabilities, use the [private security advisory flow](https://github.com/hunchom/claude-code-ssh/security/advisories/new) instead.
