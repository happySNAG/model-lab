#!/usr/bin/env bash
# MAINTAINER-ONLY. This script requires a checkout of the private Swift reference implementation as
# the PARENT directory of this repository; it cannot run against this repository alone. See
# docs/PARITY.md — in particular, the committed corpus is a frozen snapshot and regenerating it
# against a current Swift checkout WILL break the parity suite. Nothing in a normal build, test or
# release run needs this file.
# Cross-implementation check in the OTHER direction: a store written by the portable (TypeScript)
# engine is validated by the canonical Swift CLI (`validate-store` recomputes every envelope digest).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
store="${1:-$(mktemp -d)/store}"
cd "$here"
node --input-type=module -e "
import { FileResultStore } from './out/core-node/index.js';
" 2>/dev/null || true
npx tsx -e "
import { FileResultStore, planRun, RunExecutor, DeterministicFakeAdapter, CancellationToken, EvaluationEngine, policyCatalog, foundationSuite, deterministicFake, syntheticEnvironmentWithHardware, steppingClock } from './src/core/index.ts';
const store = await FileResultStore.open('$store');
const clock = steppingClock();
const plan = planRun('ts-written-run', foundationSuite, [deterministicFake]);
await new RunExecutor(new DeterministicFakeAdapter('succeed'), store, syntheticEnvironmentWithHardware, clock).execute(plan, foundationSuite, new CancellationToken());
await new EvaluationEngine(policyCatalog, clock).evaluateRun('ts-written-run', store);
console.log('portable store written to $store');
"
cd "$repo"
swift run SkippyModelLabCLI validate-store --store "$store"
swift run SkippyModelLabCLI inspect-run --store "$store" --run ts-written-run | head -20
