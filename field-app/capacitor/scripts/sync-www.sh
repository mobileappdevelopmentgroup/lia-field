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
cp "$SRC/manifest.json" "$WWW/manifest.json"
cp "$SRC/sw.js" "$WWW/sw.js"
cp "$SRC"/icon-*.png "$WWW/"
cp vendor/zxing/zxing-browser.min.js "$WWW/vendor/zxing/"

# 1. Use the locally vendored ZXing bundle instead of the CDN
sed -i '' \
  's#<script src="https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js"></script>#<script src="./vendor/zxing/zxing-browser.min.js"></script>#' \
  "$WWW/index.html"

# 2. Add a CSP meta tag — the whole app is inline HTML/CSS/JS, bundled offline
sed -i '' \
  's#<meta charset="UTF-8">#<meta charset="UTF-8">\
  <meta http-equiv="Content-Security-Policy" content="default-src '"'"'self'"'"' data: blob:; script-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; img-src '"'"'self'"'"' data: blob:; media-src '"'"'self'"'"' blob:; connect-src '"'"'self'"'"'; font-src '"'"'self'"'"' data:;">#' \
  "$WWW/index.html"

# 3. Service worker no longer needs the CDN URL (it's vendored locally now,
#    and SW registration is skipped entirely on native platforms anyway)
sed -i '' \
  "s#'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js'#'./vendor/zxing/zxing-browser.min.js'#" \
  "$WWW/sw.js"

echo "Synced field-app/ -> field-app/capacitor/www/"
