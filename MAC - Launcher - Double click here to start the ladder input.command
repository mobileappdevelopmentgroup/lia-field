#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Batavia Ladder Automation — Mac Launcher
# Double-click this file in Finder to start.
# ──────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")"

# First run: install dependencies automatically (one time only)
if [ ! -d "node_modules" ]; then
  echo "╔══════════════════════════════════════════╗"
  echo "║  First-time setup — please wait (~60s)  ║"
  echo "╚══════════════════════════════════════════╝"
  npm install
  npx playwright install chromium
  echo ""
  echo "Setup complete!"
  echo ""
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║       BATAVIA LADDER AUTOMATION — MAC            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "BEFORE STARTING — make sure:"
echo "  1. Your CSV file is inside the folder:"
echo "     'Ladders - Add your csv file here'"
echo "     (any filename ending in .csv works)"
echo ""
echo "The script will open its own browser window."
echo "Log in, navigate to the correct work order popup,"
echo "then press ENTER in this window to begin."
echo ""

npx tsx src/main.ts "$@"
