#!/bin/bash
# Run this ONCE after restarting Claude Code to finalize the rename + commit.
# Usage:
#   cd /Users/rogerfrench/claude-code-ssh
#   bash scripts/finalize.sh
set -e

cd "$(dirname "$0")/.."
REPO="hunchom/claude-code-ssh"

echo "[1/8] delete stale upstream docs + orphan Python configs"
rm -f glama.json mcp-ssh-manager-setup.md QUICKSTART.md INSTALLATION.md DESCRIPTION
rm -f pyproject.toml .flake8 .pre-commit-config.yaml

echo "[2/8] confirm git identity"
git config user.name "hunchom"
git config user.email "hunchom@users.noreply.github.com"
git config --get user.name
git config --get user.email

echo "[3/8] rewrite all commit authors to hunchom"
git rebase -r --root --exec "git commit --amend --no-edit --reset-author" 2>&1 | tail -3

echo "[4/8] stage and commit doc overhaul"
git add -A
git commit -m "clean: remove upstream docs, modernize CI, add issue templates" \
  || echo "(nothing to commit)"

echo "[5/8] test suite"
node scripts/run-tests.mjs | tail -3

echo "[6/8] force push cleaned history"
git push --force origin main

echo "[7/8] set repo metadata (description + topics)"
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
  echo "gh CLI not installed, skipping repo metadata setup"
fi

echo "[8/8] optional: upload assets/repo-image.png as the social preview"
echo "  -> do this manually in the GitHub UI:"
echo "     Settings > General > Social preview > Upload (assets/repo-image.png)"
echo "     (gh CLI doesn't support social preview upload yet)"

echo
echo "Done. Verify at https://github.com/$REPO"
echo
echo "NOTE: if your avatar doesn't show on commits, grab the numbered format"
echo "from github.com/settings/emails (e.g. 1234567+hunchom@users.noreply.github.com)"
echo "then:  git config user.email NEW  &&  git rebase -r --root --exec 'git commit --amend --no-edit --reset-author'  &&  git push --force"
