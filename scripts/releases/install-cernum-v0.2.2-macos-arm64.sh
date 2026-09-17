#!/bin/bash
# Cernum v0.2.2 — MacBook Pro (Apple Silicon): upgrade, and recover what v0.2.1's migration moved.
#
# Installs nothing until the download matches its published checksum. Copies your evidence back into
# the Model Lab folder without ever writing to Cernum's copies. Sends no provider request, runs no
# smoke test, and starts no campaign.

set -uo pipefail

VERSION="0.2.2"; COMMIT="ef1c6b9"
ARTIFACT="Cernum-${VERSION}-macos-arm64.dmg"
BASE="https://github.com/happySNAG/model-lab/releases/download/v${VERSION}"
EXPECTED_SHA="9eb3b1d991dda7bcadb2cc1b6805701a12f95e4bc575fa40c5f56048d0d09411"

APP="/Applications/Cernum.app"; LAUNCHER="${APP}/Contents/Resources/cernum"
SUPPORT="${HOME}/Library/Application Support"
LEGACY="${SUPPORT}/Model Lab"; CURRENT="${SUPPORT}/Cernum"
WORK="${HOME}/Downloads/cernum-${VERSION}-install"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_SHORT="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
MANIFEST_DIR="${CURRENT}/manifests"
MANIFEST="${MANIFEST_DIR}/machine-${HOSTNAME_SHORT}-${STAMP}.json"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ✓ %s\n' "$*"; }
note() { printf '   · %s\n' "$*"; }
die()  { printf '\n\033[1mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

step "1. Machine"
ARCH="$(uname -m)"
printf '   %-22s %s\n' "architecture" "$ARCH"
printf '   %-22s %s\n' "macOS" "$(sw_vers -productVersion) ($(sw_vers -buildVersion))"
printf '   %-22s %s\n' "host" "$HOSTNAME_SHORT"
[ "$ARCH" = "arm64" ] || die "this is a $ARCH machine; this installs the Apple Silicon build.
         For an Intel Mac use Cernum-${VERSION}-macos-x64.dmg."
ok "Apple Silicon (arm64) confirmed"

step "2. What v0.2.0/v0.2.1 moved — recorded before anything is changed"
if [ -f "${CURRENT}/migrated-from.json" ]; then
  note "the old migration left this record:"
  sed 's/^/     /' "${CURRENT}/migrated-from.json" | head -14
fi
for i in campaigns evidence model-lab.log settings.json; do
  printf '   %-16s Model Lab:%-9s Cernum:%s\n' "$i" \
    "$([ -e "${LEGACY}/${i}" ] && echo present || echo MOVED-OUT)" \
    "$([ -e "${CURRENT}/${i}" ] && echo present || echo absent)"
done

step "3. Download from the public release"
mkdir -p "$WORK" || die "could not create $WORK"
cd "$WORK" || die "could not enter $WORK"
for f in "$ARTIFACT" "Cernum-${VERSION}-SHA256SUMS.txt"; do
  printf '   downloading %s ... ' "$f"
  curl -fsSL --retry 3 -o "$f" "${BASE}/${f}" || die "download of $f failed"
  printf '%s bytes\n' "$(stat -f%z "$f")"
done

step "4. Verify the checksum — nothing is installed until this passes"
ACTUAL_SHA="$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)"
PUBLISHED_SHA="$(awk -v f="$ARTIFACT" '$2 == f {print $1}' "Cernum-${VERSION}-SHA256SUMS.txt")"
printf '   %-22s %s\n' "expected (pinned)" "$EXPECTED_SHA"
printf '   %-22s %s\n' "published sums file" "${PUBLISHED_SHA:-<not listed>}"
printf '   %-22s %s\n' "downloaded file" "$ACTUAL_SHA"
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]    || die "checksum mismatch. Nothing was installed."
[ "$PUBLISHED_SHA" = "$EXPECTED_SHA" ] || die "the published sums file disagrees with the pin. Nothing was installed."
ok "artifact matches the published checksum, three ways"

step "5. Install"
MOUNT="/Volumes/Cernum ${VERSION}"
[ -d "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null
hdiutil attach "$ARTIFACT" -nobrowse -quiet || die "could not mount $ARTIFACT"
[ -d "${MOUNT}/Cernum.app" ] || { hdiutil detach "$MOUNT" -quiet 2>/dev/null; die "no Cernum.app inside the image"; }
if [ -d "$APP" ]; then
  BACKUP="${HOME}/Downloads/Cernum.app.backup-${STAMP}"
  mv "$APP" "$BACKUP" || die "could not move the existing Cernum.app aside"
  ok "previous Cernum.app moved to ${BACKUP} (not deleted)"
fi
cp -R "${MOUNT}/Cernum.app" "$APP" || { hdiutil detach "$MOUNT" -quiet 2>/dev/null; die "copy into /Applications failed"; }
hdiutil detach "$MOUNT" -quiet
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
ok "installed at $APP"

step "6. Terminal command"
SHIM="${HOME}/.local/bin/cernum"
if [ -e "$SHIM" ] && ! grep -q "CERNUM-TERMINAL-COMMAND" "$SHIM" 2>/dev/null; then
  mv "$SHIM" "${SHIM}.not-ours-${STAMP}"
  note "a file at $SHIM was not written by Cernum; moved aside rather than replaced"
fi
"$LAUNCHER" install-command || die "the bundled launcher could not install the terminal command"
export PATH="${HOME}/.local/bin:${PATH}"; hash -r 2>/dev/null || true

step "7. Versions and shim target"
GUI_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Contents/Info.plist")"
BUNDLE_ARCH="$(lipo -archs "${APP}/Contents/MacOS/Cernum")"
CLI_VERSION="$("$LAUNCHER" where | head -1)"
SHIM_TARGET="$(awk -F\' '/^LAUNCHER=/ {print $2}' "$SHIM")"
BUILD_STAMP="$(strings "${APP}/Contents/Resources/app.asar" | grep -oE "\b${COMMIT}[0-9a-f]*" | head -1)"
printf '   %-22s %s\n' "GUI version" "$GUI_VERSION"
printf '   %-22s %s\n' "bundle architecture" "$BUNDLE_ARCH"
printf '   %-22s %s\n' "CLI version" "$CLI_VERSION"
printf '   %-22s %s\n' "shim target" "$SHIM_TARGET"
printf '   %-22s %s\n' "build commit" "${BUILD_STAMP:-<not found>}"
[ "$GUI_VERSION" = "$VERSION" ]  || die "GUI version is $GUI_VERSION, expected $VERSION"
[ "$BUNDLE_ARCH" = "arm64" ]     || die "bundle architecture is $BUNDLE_ARCH, expected arm64"
[ "$SHIM_TARGET" = "$LAUNCHER" ] || die "the shim points at $SHIM_TARGET, not $LAUNCHER"
[ "$BUILD_STAMP" = "$COMMIT" ]   || die "the bundle reports '${BUILD_STAMP}', expected $COMMIT"
ok "GUI ${VERSION}, CLI ${VERSION}, shim resolves into this bundle, commit ${COMMIT}"

step "8. RECOVERY — put back what the old migration moved out"
note "Cernum's copies are the SOURCE and are never written to. \`-n\` never overwrites, so anything"
note "already in Model Lab is left exactly as it is."
mkdir -p "$LEGACY" || die "could not create $LEGACY"
RESTORED=""
for i in campaigns evidence model-lab.log settings.json; do
  if [ ! -e "${CURRENT}/${i}" ]; then note "${i}: not in Cernum either — nothing to restore"; continue; fi
  if [ -e "${LEGACY}/${i}" ];  then note "${i}: already in Model Lab — left untouched"; continue; fi
  if cp -Rn "${CURRENT}/${i}" "${LEGACY}/${i}" 2>/dev/null; then
    RESTORED="${RESTORED}${RESTORED:+ }${i}"; ok "${i}: copied back into Model Lab"
  else
    note "${i}: copy back FAILED — Cernum's copy is untouched and still authoritative"
  fi
done
[ -n "$RESTORED" ] || note "nothing needed restoring"

step "9. Prove the recovery by hash, not by eye"
RECOVERY_OK=yes
for i in campaigns evidence; do
  [ -d "${CURRENT}/${i}" ] && [ -d "${LEGACY}/${i}" ] || continue
  if diff -r "${CURRENT}/${i}" "${LEGACY}/${i}" >/dev/null 2>&1; then ok "${i}/ identical on both sides"
  else RECOVERY_OK=no; note "${i}/ DIFFERS between Cernum and Model Lab — both copies are intact; compare before deleting either"; fi
done
for i in model-lab.log settings.json; do
  [ -f "${CURRENT}/${i}" ] && [ -f "${LEGACY}/${i}" ] || continue
  a="$(shasum -a 256 "${CURRENT}/${i}" | cut -d' ' -f1)"; b="$(shasum -a 256 "${LEGACY}/${i}" | cut -d' ' -f1)"
  if [ "$a" = "$b" ]; then ok "${i} identical  (${a})"; else RECOVERY_OK=no; note "${i} DIFFERS: ${a} vs ${b}"; fi
done

step "10. Confirm v0.2.2 now leaves both sides alone"
note "opening Cernum once: its migration should report 'already carried across and still match'"
cp "${CURRENT}/cernum.log" /tmp/cernum-log-before-$$ 2>/dev/null || : > /tmp/cernum-log-before-$$
open -a "$APP"
DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$(wc -c < "${CURRENT}/cernum.log" 2>/dev/null || echo 0)" -gt "$(wc -c < /tmp/cernum-log-before-$$)" ]; then break; fi
  sleep 2
done
MIGRATION_LINE="$(diff /tmp/cernum-log-before-$$ "${CURRENT}/cernum.log" 2>/dev/null | grep '^>' | grep 'data directory:' | tail -1 | sed 's/^> //')"
rm -f /tmp/cernum-log-before-$$
osascript -e 'quit app "Cernum"' 2>/dev/null
if [ -n "$MIGRATION_LINE" ]; then printf '   %s\n' "$MIGRATION_LINE"; else note "no migration line appeared within 90s; check ${CURRENT}/cernum.log yourself"; fi
case "$MIGRATION_LINE" in
  *"already been carried across"*) ok "idempotent: it looked, found both sides matching, and did nothing" ;;
  *copied*) note "it copied something — read the line above; the originals were preserved either way" ;;
esac

step "11. Provider status — contacts nothing"
"$LAUNCHER" providers 2>&1 | sed 's/^/   /' | head -40

step "12. Read-only discovery: Claude CLI, Codex CLI, OpenCode"
note "version / auth / model-listing subcommands only — no model is invoked and no allowance is spent"
DISCOVERY_OUT="${WORK}/discovery-${STAMP}.txt"
"$LAUNCHER" discover claudeCLI codexCLI opencodeCLI 2>&1 | tee "$DISCOVERY_OUT" | sed 's/^/   /'

step "13. Local runtime (Ollama) — read-only listing"
if "$LAUNCHER" models > "${WORK}/ollama-${STAMP}.txt" 2>&1; then
  sed 's/^/   /' "${WORK}/ollama-${STAMP}.txt"; OLLAMA_STATE="reachable"
else
  note "the local runtime did not answer — expected if Ollama is not running here"; OLLAMA_STATE="unreachable"
fi

step "14. opencode/union-alpha — discovered, and NOT proven"
UNION_STATE="$(awk '$2 == "opencode/union-alpha" && ($1 == "proven" || $1 == "refused" || $1 == "unproven") {print $1; exit}' "$DISCOVERY_OUT")"
UNION_STATE="${UNION_STATE:-not recorded}"
case "$UNION_STATE" in
  unproven) ok "opencode/union-alpha: DISCOVERED and unproven — correct for v0.2.2. It is not selectable."
            note "A listing is read from OpenCode's cached catalogue. Only an authorized request that came"
            note "back and was recorded proves a model, and Cernum has no OpenCode execution adapter yet." ;;
  proven)   note "opencode/union-alpha reads 'proven' — that is the v0.2.1 defect. You are not running v0.2.2."
            die "stale evidence or a stale build; re-check the version above" ;;
  refused)  note "opencode/union-alpha: OpenCode does not name this identifier on this machine." ;;
  *)        note "opencode/union-alpha: ${UNION_STATE}. If OpenCode read notInstalled or noCredential above,"
            note "install and sign in to the OpenCode CLI yourself, then: cernum discover opencodeCLI" ;;
esac
if grep -qE '^ +proven +opencode/' "$DISCOVERY_OUT"; then die "an OpenCode model is recorded as proven; this build is not v0.2.2"; fi
ok "no OpenCode model is marked proven"

step "15. This machine's own manifest"
note "MACHINE-SPECIFIC. The Mac mini's PRIOR-LIVE-CAMPAIGNS-BASELINE.sha256 records THAT machine's"
note "campaigns and will not verify here unless those exact campaigns exist on this disk."
mkdir -p "$MANIFEST_DIR"
CAMPAIGN_ROOT="${CURRENT}/campaigns"
CAMPAIGN_SUMS="${MANIFEST_DIR}/campaigns-${HOSTNAME_SHORT}-${STAMP}.sha256"
if [ -d "$CAMPAIGN_ROOT" ]; then
  ( cd "$CAMPAIGN_ROOT" && find . -type f -not -path "./.providers/*" -exec shasum -a 256 {} \; 2>/dev/null | sort -k2 ) > "$CAMPAIGN_SUMS"
else : > "$CAMPAIGN_SUMS"; fi
CAMPAIGN_COUNT="$(wc -l < "$CAMPAIGN_SUMS" | tr -d ' ')"
CAMPAIGN_JSON=""
if [ -d "$CAMPAIGN_ROOT" ]; then
  for n in "$CAMPAIGN_ROOT"/*; do
    [ -d "$n" ] || continue; b="$(basename "$n")"; case "$b" in .*) continue ;; esac
    CAMPAIGN_JSON="${CAMPAIGN_JSON}${CAMPAIGN_JSON:+, }\"${b}\""
  done
fi
cat > "$MANIFEST" <<JSONEOF
{
  "manifestKind": "cernum.machine",
  "manifestVersion": 1,
  "note": "Describes ONE machine at ONE moment. Not the Mac mini campaign baseline and not interchangeable with it: campaign checksums are rooted at this machine's own campaign directory. No provider inference, smoke test or campaign produced it.",
  "createdAt": "${STAMP}",
  "machine": {
    "hostname": "${HOSTNAME_SHORT}",
    "model": "$(sysctl -n hw.model 2>/dev/null || echo unknown)",
    "architecture": "${ARCH}",
    "macOS": "$(sw_vers -productVersion)",
    "build": "$(sw_vers -buildVersion)"
  },
  "install": {
    "application": "${APP}",
    "guiVersion": "${GUI_VERSION}",
    "cliVersion": "${CLI_VERSION}",
    "bundleArchitecture": "${BUNDLE_ARCH}",
    "buildCommit": "${BUILD_STAMP}",
    "artifact": "${ARTIFACT}",
    "artifactSHA256": "${ACTUAL_SHA}",
    "artifactChecksumVerified": true,
    "signing": "ad-hoc (unsigned, not notarized)",
    "terminalShimTarget": "${SHIM_TARGET}"
  },
  "providers": {
    "discoveryTranscript": "${DISCOVERY_OUT}",
    "unionAlpha": "${UNION_STATE}",
    "unionAlphaMeaning": "discovered from OpenCode's cached catalogue; NOT proven and NOT selectable",
    "localRuntime": "${OLLAMA_STATE}",
    "spentNothing": "version, credential and model-listing subcommands only; no model was invoked"
  },
  "campaigns": {
    "root": "${CAMPAIGN_ROOT}",
    "checksums": "${CAMPAIGN_SUMS}",
    "fileCount": ${CAMPAIGN_COUNT},
    "names": [${CAMPAIGN_JSON}]
  },
  "legacyModelLab": {
    "directory": "${LEGACY}",
    "restoredByThisRun": "${RESTORED}",
    "matchesCernum": "${RECOVERY_OK}",
    "migrationLine": "${MIGRATION_LINE}"
  }
}
JSONEOF
[ -s "$MANIFEST" ] || die "the machine manifest was not written"
shasum -a 256 "$MANIFEST" | sed 's/^/   manifest sha256: /'
ok "machine manifest: ${MANIFEST}"
ok "campaign checksums (${CAMPAIGN_COUNT} file(s)): ${CAMPAIGN_SUMS}"

step "Done"
cat <<SUMMARY
   Cernum ${VERSION} (${COMMIT}) is installed on this MacBook Pro and verified.

   Recovery:   restored into Model Lab: ${RESTORED:-nothing needed}
               both sides match: ${RECOVERY_OK}
   Union Alpha: ${UNION_STATE} — discovered, not proven, not selectable.

   No provider inference, no smoke test, no campaign. Your data now exists in BOTH
   Model Lab and Cernum; delete the old folder yourself once you are satisfied.

   Machine manifest:     ${MANIFEST}
   Discovery transcript: ${DISCOVERY_OUT}
SUMMARY
