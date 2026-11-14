#!/usr/bin/env bash
# Build, sign, notarize and publish Lia Office for macOS (arm64 + Intel) to
# the DRAFT GitHub release v<version>. Offices get it only once that draft is
# published by hand (docs/RELEASE.md, "Automatic updates").
#
# Refuses unless:
#   * a Developer ID Application certificate for team 9V4CNA98BB is in the
#     keychain — the first updater build fixes the identity every later update
#     must match, so an App Store ("Apple Distribution") signature must never
#     be published;
#   * the tag v<version> is on origin and points at HEAD, so the release, the
#     Windows CI build and this one are the same commit.
# After the build it checks each app is Developer ID signed and notarized.
set -euo pipefail
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
TAG="v$VER"
die() { echo "✗ $*" >&2; exit 1; }

security find-identity -v -p codesigning | grep -q 'Developer ID Application: .*(9V4CNA98BB)' \
  || die "No 'Developer ID Application' certificate for 9V4CNA98BB in the keychain (see docs/RELEASE.md)."

git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || die "Tag $TAG is not on origin — push it first."
[ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)" ] || die "Tag $TAG is not HEAD."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Uncommitted changes — the build would not match the tag."

export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_PZ4S957TFC.p8"
export APPLE_API_KEY_ID=PZ4S957TFC
export APPLE_API_ISSUER=bb930b75-3879-4b39-94d1-5352ffad59d8
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --user mobileappdevelopmentgroup)}"

npm run build:all
npx electron-builder --mac --publish always

for app in dist/mac-arm64/Lia.app dist/mac/Lia.app; do
  codesign -dv --verbose=2 "$app" 2>&1 | grep -q 'Authority=Developer ID Application' || die "$app is not Developer ID signed."
  spctl -a -t exec -vv "$app" 2>&1 | grep -q 'source=Notarized Developer ID' || die "$app is not notarized."
  echo "✓ $app — Developer ID, notarized"
done

mkdir -p "lia-deliverables/$VER"
cp "dist/Lia-$VER-arm64.dmg" "dist/Lia-$VER.dmg" "lia-deliverables/$VER/"
echo "✓ Uploaded to the draft release $TAG. Publish it with: gh release edit $TAG --draft=false --latest"
