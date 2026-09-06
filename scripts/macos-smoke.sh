#!/usr/bin/env bash
# Model Lab · macOS packaging smoke test. Run after `npm run dist:mac` (or dist:mac:arm64).
#   bash scripts/macos-smoke.sh ["dist/mac-arm64/Model Lab.app"]
# Static checks on the bundle (structure, Info.plist, architecture, signature, Gatekeeper verdict),
# then the Playwright smoke spec launches the bundle exactly as Finder would.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
app="${1:-dist/mac-arm64/Model Lab.app}"
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -d "$app" ] || fail "no bundle at $app (run npm run dist:mac first)"
plist="$app/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist"; }

step "Bundle: $app"
[ -x "$app/Contents/MacOS/Model Lab" ] || fail "executable missing"
[ -f "$app/Contents/Resources/app.asar" ] || fail "app.asar missing"
[ -f "$app/Contents/Resources/README.md" ] || fail "bundled README missing"
[ -f "$app/Contents/Resources/$(pb CFBundleIconFile | sed 's/\.icns$//').icns" ] || fail "icon missing"

step "Info.plist"
for key in CFBundleName CFBundleDisplayName CFBundleIdentifier CFBundleShortVersionString CFBundleVersion LSMinimumSystemVersion NSHumanReadableCopyright; do
  printf '  %-28s %s\n' "$key" "$(pb "$key")"
done
[ "$(pb CFBundleName)" = "Model Lab" ] || fail "CFBundleName is not Model Lab"
[ "$(pb CFBundleIdentifier)" = "org.modellab.desktop" ] || fail "unexpected bundle identifier"

step "Architecture"
lipo -archs "$app/Contents/MacOS/Model Lab" | sed 's/^/  /'

step "Signature (informational — unsigned builds are ad-hoc signed)"
codesign -dv --verbose=2 "$app" 2>&1 | grep -E 'Identifier|Authority|Signature|TeamIdentifier|flags' | sed 's/^/  /' || true
if codesign --verify --deep --strict "$app" 2>/dev/null; then echo "  codesign --verify: OK"; else echo "  codesign --verify: FAILED (bundle modified after signing?)"; fi

step "Gatekeeper assessment (informational — expected to be rejected without Developer ID + notarization)"
spctl --assess --type exec --verbose=2 "$app" 2>&1 | sed 's/^/  /' || true
xattr -p com.apple.quarantine "$app" >/dev/null 2>&1 && echo "  quarantine attribute PRESENT (downloaded copy)" || echo "  no quarantine attribute (locally built or already cleared)"

step "Launch through Playwright (Finder-equivalent, real data location)"
MODEL_LAB_APP="$app" npx playwright test -c test/e2e/playwright.config.ts test/e2e/packaged-mac.spec.ts

step "Smoke test finished"
