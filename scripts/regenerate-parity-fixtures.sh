#!/usr/bin/env bash
# Regenerates fixtures/parity from the canonical Swift implementation, then runs the parity suite.
# Run from anywhere; requires the repository's Swift toolchain (macOS).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$repo"
swift run SkippyModelLabParityFixtures "$here/fixtures/parity"
cd "$here"
npx vitest run test/parity
