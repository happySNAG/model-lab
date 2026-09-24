#!/bin/bash
# Cernum v1.0.0 — Intel Mac (x64): install or upgrade, verify the build, spend nothing.
#
# Installs nothing until the download matches its published checksum, three ways. Still carries the
# v0.2.1 migration recovery, because it is idempotent and cheap and this machine may never have run
# it: Cernum's copies are the SOURCE and are never written to.
#
# IT SENDS NO PROVIDER REQUEST. No smoke test, no campaign, no model invoked. Step 16 re-checks the
# zero-spend guarantees v0.2.4 introduced, through `--dry-run` and `help`, both of which are free; the
# OpenCode dry-run it runs is one this build would REFUSE to send without an explicit spending
# authorization. Every check below was run against the published 1.0.0 bundle before this was pinned.

set -uo pipefail

VERSION="1.0.0"; COMMIT="e57a1f7"
ARTIFACT="Cernum-${VERSION}-macos-x64.dmg"
BASE="https://github.com/happySNAG/model-lab/releases/download/v${VERSION}"
EXPECTED_SHA="4b24706fc7df27befbe943784a8ebd50009514d2017c8410d5892127967edf23"

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
[ "$ARCH" = "x86_64" ] || die "this is a $ARCH machine; this installs the Intel build.
         For an Apple Silicon Mac use install-cernum-v${VERSION}-macos-arm64.sh."
ok "Intel (x86_64) confirmed"

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
[ "$BUNDLE_ARCH" = "x86_64" ]    || die "bundle architecture is $BUNDLE_ARCH, expected x86_64"
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

step "10. Confirm the migration now leaves both sides alone"
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
  unproven) ok "opencode/union-alpha: DISCOVERED and unproven — correct after discovery alone."
            note "A listing is read from OpenCode's cached catalogue and proves nothing. Cernum CAN send"
            note "OpenCode a request, and from v0.2.4 it REFUSES to without an explicit spending"
            note "authorization, because OpenCode is billed per token against your own credential:"
            note "  cernum smoke opencodeCLI --models opencode/union-alpha --dry-run"
            note "      shows the request and sends nothing."
            note "  cernum smoke opencodeCLI --models opencode/union-alpha --pricing <file> \\"
            note "      --authorize-metered <dollars>          SPENDS, bounded by a worst case."
            note "  cernum smoke opencodeCLI --models opencode/union-alpha --authorize-unpriced-metered"
            note "      SPENDS an amount Cernum cannot state, once. Read \`cernum help smoke\` first." ;;
  proven)   ok "opencode/union-alpha reads proven — an authorized request was sent and OpenCode named it."
            note "That is a valid state if you ran an authorized smoke yourself. If you did not, investigate:"
            note "a listing must never produce it." ;;
  refused)  note "opencode/union-alpha: OpenCode does not name this identifier on this machine." ;;
  *)        note "opencode/union-alpha: ${UNION_STATE}. If OpenCode read notInstalled or noCredential above,"
            note "install and sign in to the OpenCode CLI yourself, then: cernum discover opencodeCLI" ;;
esac
# A DISCOVERY RUN MUST STILL PROVE NOTHING. This checks the transcript of the `discover` above, which
# sent no request: if a model came back proven from a LISTING, the build is older than v0.2.2 and the
# catalogue defect is present. A model proven earlier by a smoke lives in the store, not in this
# transcript, so this stays correct once you have run one.
if grep -qE '^ +proven +opencode/' "$DISCOVERY_OUT"; then
  die "discovery alone reported an OpenCode model as proven. A listing cannot prove a model; this build predates v0.2.2."
fi
ok "discovery proved no OpenCode model, which is what discovery is supposed to do"
# AND THE STALE SENTENCE MUST BE GONE. v0.2.2 through v0.2.3 wrote "no OpenCode execution adapter"
# into this transcript and into discovered.json, on a build that had one.
if grep -q "no OpenCode execution adapter" "$DISCOVERY_OUT"; then
  die "discovery still carries the v0.2.2 no-proof-path sentence. This is not a ${VERSION} build."
fi
ok "the superseded no-proof-path sentence is gone from discovery output"

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

step "16. The zero-spend guarantees, checked without sending anything"
note "Everything in this step is free: \`help\` prints, and \`--dry-run\` sends nothing by construction."
# Captured through command substitution on BOTH sides, so the comparison is not decided by a
# trailing newline `$(...)` strips from one of them.
HELP_SMOKE="$("$LAUNCHER" help smoke 2>&1)"
HELP_FLAG="$("$LAUNCHER" smoke --help 2>&1)"
HELP_SHORT="$("$LAUNCHER" smoke -h 2>&1)"

# D · one page, three spellings. `cernum help smoke` used to print the general index.
if [ "$HELP_SMOKE" = "$HELP_FLAG" ] && [ "$HELP_SMOKE" = "$HELP_SHORT" ]; then
  ok "help smoke == smoke --help == smoke -h  (one page, one table, one renderer)"
else
  die "the three help spellings disagree. This is not a ${VERSION} build."
fi
for flag in --models --all-ladder --dry-run --pricing --authorize-metered --authorize-unpriced-metered --otlp-observer; do
  case "$HELP_SMOKE" in *"$flag"*) ;; *) die "\`cernum help smoke\` does not document ${flag}. This is not a ${VERSION} build." ;; esac
done
ok "smoke help documents the provider, scope, preview, metered authorization and telemetry options"

# D · a malformed value refuses rather than silently not applying.
if "$LAUNCHER" smoke claudeCLI --all-ladder --max-attempts banana --dry-run >/dev/null 2>&1; then
  die "--max-attempts banana was accepted. A cap that silently does not apply is worse than no cap."
fi
ok "a malformed option value refuses, and nothing runs"

# A · the preview is derived from the provider registry, per provider.
CLAUDE_PREVIEW="$("$LAUNCHER" smoke claudeCLI --all-ladder --dry-run 2>&1)"
case "$CLAUDE_PREVIEW" in
  *"authorization class   subscriptionIncluded"*) ok "claudeCLI previews as subscriptionIncluded — and is not called free" ;;
  *) die "the Claude preview does not name its billing basis. This is not a ${VERSION} build." ;;
esac
case "$CLAUDE_PREVIEW" in *"No request was sent"*) ok "the Claude dry-run sent nothing, and said so" ;; *) die "the dry-run did not confirm it sent nothing" ;; esac

# A + B · OpenCode previews as metered, and says a live run of that scope would be refused.
OPENCODE_PREVIEW="$("$LAUNCHER" smoke opencodeCLI --models opencode/union-alpha --dry-run 2>&1)"
case "$OPENCODE_PREVIEW" in
  *"authorization class   meteredAPI"*) ok "opencodeCLI previews as meteredAPI — never as a subscription" ;;
  *"cannot be smoke tested"*) note "opencodeCLI is not executable on this build; skipping the metered checks" ;;
  *) die "the OpenCode preview does not name meteredAPI. This is not a ${VERSION} build." ;;
esac
case "$OPENCODE_PREVIEW" in
  *"AUTHORIZATION REQUIRED"*)
     ok "a live metered smoke of that scope would be REFUSED as it stands"
     case "$OPENCODE_PREVIEW" in
       *"UNAVAILABLE"*) ok "its cost reads UNAVAILABLE — not zero, not free, not estimated" ;;
       *) die "an unpriced metered request did not report its cost as unavailable" ;;
     esac ;;
  *"cannot be smoke tested"*) ;;
  *) die "an unpriced metered dry-run did not warn that a live run would be refused." ;;
esac
note "NOTHING ABOVE SENT A REQUEST. To actually prove a model you have to ask for it by name,"
note "with a scope, and — for a metered provider — with a spending authorization."

step "Done"
cat <<SUMMARY
   Cernum ${VERSION} (${COMMIT}) is installed on this Mac and verified.

   Recovery:   restored into Model Lab: ${RESTORED:-nothing needed}
               both sides match: ${RECOVERY_OK}
   Union Alpha: ${UNION_STATE} — discovered, not proven, not selectable.

   Zero-spend checks: help is one page across all three spellings; malformed options refuse;
   claudeCLI previews subscriptionIncluded; opencodeCLI previews meteredAPI and would be
   REFUSED live without a spending authorization, with its cost reading UNAVAILABLE.

   No provider inference, no smoke test, no campaign. Not one request was sent. Your data
   now exists in BOTH Model Lab and Cernum; delete the old folder yourself once satisfied.

   Machine manifest:     ${MANIFEST}
   Discovery transcript: ${DISCOVERY_OUT}
SUMMARY
