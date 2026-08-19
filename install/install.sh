#!/bin/sh
# Installs ReClaude. Usage: curl -fsSL https://raw.githubusercontent.com/natpalmer-e4o4/ReClaude/main/install/install.sh | sh
set -e
PKG='@natpalmer-e4o4/reclaude'
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required."; exit 1; }
MAJOR=$(node --version | sed 's/^v//' | cut -d. -f1)
[ "$MAJOR" -ge 18 ] || { echo "Node $MAJOR found; ReClaude needs 18 or newer."; exit 1; }
echo "==> Installing $PKG"
npm install -g "$PKG"
echo "==> Installing the /snapshot skill"
reclaude install-skill
echo
echo "ReClaude installed."
echo "  start it:  reclaude"
echo "  capture:   run /snapshot inside a Claude Code session"
