#!/usr/bin/env bash
# Cernum · macOS packaging smoke test. Run after `npm run dist:mac` (or dist:mac:arm64).
#   bash scripts/macos-smoke.sh ["dist/mac-arm64/Cernum.app"]
#
# THE NAME IS READ, NOT TYPED. This script asserted "Model Lab" and `org.modellab.desktop` for a
# release after the product was renamed, so it could not be run against the artefact it exists to
# check. Both now come from package.json and electron-builder.yml, which is where they are decided.
# Static checks on the bundle (structure, Info.plist, architecture, signature, Gatekeeper verdict),
# then the Playwright smoke spec launches the bundle exactly as Finder would.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
product="$(node -p "require('./package.json').productName")"
appid="$(node -p "require('fs').readFileSync('electron-builder.yml','utf8').match(/^appId:\\s*(\\S+)/m)[1]")"
# This host's architecture first: a bundle for the other one cannot be executed at all.
default_dist="dist/mac/$product.app"
[ "$(uname -m)" = "arm64" ] && default_dist="dist/mac-arm64/$product.app"
app="${1:-$default_dist}"
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -d "$app" ] || fail "no bundle at $app (run npm run dist:mac first)"
plist="$app/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }

step "Bundle: $app"
[ -x "$app/Contents/MacOS/$product" ] || fail "executable missing"
[ -f "$app/Contents/Resources/app.asar" ] || fail "app.asar missing"
[ -f "$app/Contents/Resources/README.md" ] || fail "bundled README missing"
[ -f "$app/Contents/Resources/$(pb CFBundleIconFile | sed 's/\.icns$//').icns" ] || fail "icon missing"

step "Info.plist"
for key in CFBundleName CFBundleDisplayName CFBundleIdentifier CFBundleShortVersionString CFBundleVersion LSMinimumSystemVersion NSHumanReadableCopyright; do
  printf '  %-28s %s\n' "$key" "$(pb "$key")"
done
[ "$(pb CFBundleName)" = "$product" ] || fail "CFBundleName is '$(pb CFBundleName)', not '$product'"
[ "$(pb CFBundleIdentifier)" = "$appid" ] || fail "bundle identifier is '$(pb CFBundleIdentifier)', not '$appid'"
[ "$(pb CFBundleShortVersionString)" = "$(node -p "require('./package.json').version")" ] \
  || fail "bundle version is '$(pb CFBundleShortVersionString)', not package.json's"

step "Terminal launcher inside the bundle"
launcher="$app/Contents/Resources/$(node -p "require('./package.json').name")"
[ -x "$launcher" ] || fail "no terminal launcher at $launcher"
"$launcher" where | sed 's/^/  /' || fail "the bundled terminal command did not answer"

step "Provider discovery under the PATH launchd gives a Finder launch"
# THE v0.2.0 DEFECT, CHECKED IN THE ARTEFACT. A bundle that reads only PATH reports every CLI you
# installed as notInstalled here, because this is the environment a double-clicked app actually gets.
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$launcher" providers | sed 's/^/  /'

step "Architecture"
lipo -archs "$app/Contents/MacOS/$product" | sed 's/^/  /'

step "Signature (informational — unsigned builds are ad-hoc signed)"
codesign -dv --verbose=2 "$app" 2>&1 | grep -E 'Identifier|Authority|Signature|TeamIdentifier|flags' | sed 's/^/  /' || true
if codesign --verify --deep --strict "$app" 2>/dev/null; then echo "  codesign --verify: OK"; else echo "  codesign --verify: FAILED (bundle modified after signing?)"; fi

step "Gatekeeper assessment (informational — expected to be rejected without Developer ID + notarization)"
spctl --assess --type exec --verbose=2 "$app" 2>&1 | sed 's/^/  /' || true
xattr -p com.apple.quarantine "$app" >/dev/null 2>&1 && echo "  quarantine attribute PRESENT (downloaded copy)" || echo "  no quarantine attribute (locally built or already cleared)"

step "Launch through Playwright (Finder-equivalent, real data location)"
CERNUM_APP="$app" npx playwright test -c test/e2e/playwright.config.ts test/e2e/packaged-mac.spec.ts

step "Smoke test finished"
