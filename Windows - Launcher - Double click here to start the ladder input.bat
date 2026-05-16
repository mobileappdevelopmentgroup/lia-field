@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  Batavia Ladder Automation — Windows Launcher
REM  Double-click this file in Windows Explorer to start.
REM ─────────────────────────────────────────────────────────────────────────────

cd /d "%~dp0"

REM First run: install dependencies automatically (one time only)
if not exist "node_modules\" (
    echo =====================================================
    echo   First-time setup -- please wait (about 60 sec)
    echo =====================================================
    call npm install
    call npx playwright install chromium
    echo.
    echo Setup complete!
    echo.
)

echo.
echo =====================================================
echo   BATAVIA LADDER AUTOMATION -- WINDOWS
echo =====================================================
echo.
echo Opening Chrome with remote debugging enabled...
echo.

REM Open Chrome with remote debugging so the script can attach to it
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

echo NEXT STEPS:
echo   1. In the Chrome window that just opened:
echo      - Log in to bsiwebapp.com
echo      - Navigate to your work order
echo      - Click "View" to open the work order popup
echo.
echo   2. Make sure your CSV is in:
echo      "Ladders - Add your csv file here\ladders.csv"
echo.
pause

call npx tsx src/main.ts %*
