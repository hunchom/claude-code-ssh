#!/bin/bash
# Quick health check: verify the repo is ready to serve as a Claude Code MCP.

set -e

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "claude-code-ssh - Claude Code integration check"
echo "-----------------------------------------------"
echo ""

fail=0

step() { printf "  [%s] %s\n" "$1" "$2"; }

# package.json
if [ -f package.json ]; then
  step ok "package.json present"
else
  step err "package.json missing"; fail=1
fi

# deps
if [ -d node_modules ]; then
  step ok "node_modules installed"
else
  step warn "node_modules missing — run: npm install"
fi

# .env
if [ -f .env ]; then
  count=$(grep -c "^SSH_SERVER_[A-Z0-9_]*_HOST=" .env 2>/dev/null || echo 0)
  step ok ".env present, $count server(s) configured"
else
  step warn ".env missing — copy .env.example to .env and add servers"
fi

# Claude Code registration
cfg="$HOME/.config/claude-code/claude_code_config.json"
if [ -f "$cfg" ]; then
  if grep -q "ssh-manager" "$cfg" 2>/dev/null; then
    step ok "registered in Claude Code config"
  else
    step warn "not yet registered — run: claude mcp add ssh-manager node $ROOT/src/index.js"
  fi
else
  step warn "Claude Code config not found at $cfg"
fi

echo ""
echo "server entry point: $ROOT/src/index.js"
echo ""
echo "try in Claude Code:"
echo "  ssh_list_servers"
echo "  ssh_execute on <server> to run hostname"
echo ""

exit $fail
