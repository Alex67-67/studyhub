#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo ""
echo "  Checking dependencies..."

# Node.js
if ! command -v node &>/dev/null; then
  echo "  ✗  Node.js not found. Install from https://nodejs.org"
  exit 1
fi

# Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "  ✗  Claude Code not found."
  echo "     Install with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

echo "  ✓  Node.js $(node -v)"
echo "  ✓  Claude Code found"

# Kill any existing process on port 3000
EXISTING=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "  ↺  Stopping existing process on port 3000..."
  echo "$EXISTING" | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi

echo ""
node jarvis-server.js
