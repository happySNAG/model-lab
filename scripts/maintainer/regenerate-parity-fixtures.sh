#!/usr/bin/env bash
# MAINTAINER-ONLY. This script requires a checkout of the private Swift reference implementation as
# the PARENT directory of this repository; it cannot run against this repository alone. See
# docs/PARITY.md — in particular, the committed corpus is a frozen snapshot and regenerating it
# against a current Swift checkout WILL break the parity suite. Nothing in a normal build, test or
# release run needs this file.
# Regenerates fixtures/parity from the canonical Swift implementation, then runs the parity suite.
# Run from anywhere; requires the repository's Swift toolchain (macOS).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$repo"
swift run SkippyModelLabParityFixtures "$here/fixtures/parity"
cd "$here"
npx vitest run test/parity
