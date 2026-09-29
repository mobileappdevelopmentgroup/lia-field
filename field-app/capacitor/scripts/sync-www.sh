#!/bin/bash
# Syncs field-app/ (the canonical PWA source, deployed to GitHub Pages) into
# capacitor/www/, applying the small set of Capacitor-only tweaks:
#   - load the locally vendored ZXing bundle instead of the CDN (offline)
#   - add a CSP meta tag
#   - drop the ZXing CDN URL from the service worker's asset list
set -euo pipefail
cd "$(dirname "$0")/.."  # -> field-app/capacitor/

SRC="../"
WWW="www"

rm -rf "$WWW"
mkdir -p "$WWW/vendor/zxing"

cp "$SRC/index.html" "$WWW/index.html"
# The app is split into classic scripts under js/ — copy the directory, and fail
# loudly rather than shipping a bundle whose scripts are missing.
mkdir -p "$WWW/js"
cp "$SRC"/js/*.js "$WWW/js/"
[ -s "$WWW/js/app.js" ] || { echo "sync-www.sh: js/ did not copy" >&2; exit 1; }
cp "$SRC/manifest.json" "$WWW/manifest.json"
cp "$SRC/sw.js" "$WWW/sw.js"
cp "$SRC"/icon-*.png "$WWW/"
cp vendor/zxing/zxing-browser.min.js "$WWW/vendor/zxing/"
mkdir -p "$WWW/vendor/supabase"
cp vendor/supabase/supabase.min.js "$WWW/vendor/supabase/"

# 1. Use the locally vendored ZXing bundle instead of the CDN
sed -i '' \
  's#<script src="https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js"></script>#<script src="./vendor/zxing/zxing-browser.min.js"></script>#' \
  "$WWW/index.html"

sed -i '' \
  's#<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>#<script src="./vendor/supabase/supabase.min.js"></script>#' \
  "$WWW/index.html"

# 2. Add a CSP meta tag.
#
# connect-src MUST name the Supabase origin. The app used to be entirely offline
# so 'self' alone was right; now that it syncs, 'self' blocks every call — and
# it does so ONLY on device. A browser test passes, the phone silently fails.
#
# LIA_SUPABASE_URL overrides; otherwise read it from config.json, which is
# gitignored and already holds it.
SUPA="${LIA_SUPABASE_URL:-}"
if [ -z "$SUPA" ] && [ -f "../../config.json" ]; then
  SUPA=$(node -e "try{console.log(require('../../config.json').supabase.url||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
fi
if [ -z "$SUPA" ]; then
  echo "sync-www.sh: no Supabase URL found — the bundle will not be able to sync." >&2
  echo "  Set LIA_SUPABASE_URL, or add supabase.url to config.json." >&2
  CONNECT="'self'"
else
  # wss: too — Supabase upgrades to a websocket for realtime.
  CONNECT="'self' ${SUPA} ${SUPA/https:/wss:}"
  echo "sync-www.sh: CSP connect-src allows ${SUPA}"
fi

CSP="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src ${CONNECT}; font-src 'self' data:;"

node -e '
  const fs = require("fs"), f = process.argv[1], csp = process.argv[2];
  let h = fs.readFileSync(f, "utf8");
  h = h.replace(/<meta charset="UTF-8">/,
    `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
  fs.writeFileSync(f, h);
' "$WWW/index.html" "$CSP"

# 3. Service worker no longer needs the CDN URL (it's vendored locally now,
#    and SW registration is skipped entirely on native platforms anyway)
sed -i '' \
  "s#'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js'#'./vendor/zxing/zxing-browser.min.js'#" \
  "$WWW/sw.js"

echo "Synced field-app/ -> field-app/capacitor/www/"
