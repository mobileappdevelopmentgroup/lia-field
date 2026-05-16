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
echo "Opening Chrome with remote debugging enabled..."
echo ""

# Open Chrome with remote debugging so the script can attach to it
open -a "Google Chrome" --args --remote-debugging-port=9222

echo "NEXT STEPS:"
echo "  1. In the Chrome window that just opened:"
echo "     - Log in to bsiwebapp.com"
echo "     - Navigate to your work order"
echo "     - Click 'View' to open the work order popup"
echo ""
echo "  2. Make sure your CSV is in:"
echo "     'Ladders - Add your csv file here/ladders.csv'"
echo ""
read -r -p "Press ENTER when the work order popup is open and you are ready..."
echo ""

npx tsx src/main.ts "$@"
