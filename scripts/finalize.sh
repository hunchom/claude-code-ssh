#!/bin/bash
# Apply repository metadata + run final checks.
# Idempotent — safe to run on every release.
#
# Usage:
#   bash scripts/finalize.sh
set -e

cd "$(dirname "$0")/.."
REPO="hunchom/claude-code-ssh"

echo "[1/3] run test suite"
node scripts/run-tests.mjs | tail -3

echo "[2/3] validate"
./scripts/validate.sh | tail -5

echo "[3/3] apply repo metadata via gh"
if command -v gh >/dev/null 2>&1; then
  gh repo edit "$REPO" \
    --description "MCP server that gives Claude Code direct SSH access to your server fleet. 51 tools, connection pooled, per-user gated, ASCII output." \
    --homepage "https://github.com/$REPO" \
    --add-topic mcp \
    --add-topic claude-code \
    --add-topic claude \
    --add-topic anthropic \
    --add-topic ssh \
    --add-topic devops \
    --add-topic model-context-protocol \
    --add-topic mcp-server \
    --add-topic automation \
    --add-topic sre
else
  echo "  gh CLI not installed, skipping repo metadata"
fi

echo
echo "Done. Social preview image: upload assets/repo-image.png manually"
echo "at Settings > General > Social preview (gh CLI can't do this yet)."
echo "Verify at https://github.com/$REPO"
