# Block 2 summary: integration of main and the routing-evidence core

Pass P-4804, goal G-3531@v1, campaign C-3541@v1: block 2's milestone gate.

Block 2 integrated GitHub main 179a820 into the local branch `ordra/cernum-integrate-main`, then built,
on that branch, the routing-evidence core that needs no new owner policy decision. Everything is
read-only or append-only, runs on fixtures and recorded evidence, and contacts no model, provider or
network service. Qualification policy cqp1 is unchanged. Gated items (cqp2 D-C5, the recommend ranking
crr1 D-C6, release D-C7) are not in this block.

Block range: `aa1b43f` (lane head before the merge) to `43fe80c` (status export). This gate adds no
feature; it adds this document and corrects README.md.

## Commits

| # | Commit | What it delivered | Tests (file: count) | Docs |
| --- | --- | --- | --- | --- |
| 1 | `593d633` | `--no-ff` merge of GitHub main 179a820 (V1.0.0 release, Cernum naming guard) into the lane, every lane commit preserved, no textual conflicts | `test/engine/naming-guard.test.ts` came in from main: 6 | [integration-main-179a820.md](integration-main-179a820.md) |
| 2 | `5e6e787` | Fix: the old product name dropped from a comment in `test/engine/evidence-root.ts` so the naming guard passes; guard untouched | naming-guard: 6 | [integration-main-179a820.md](integration-main-179a820.md) |
| 3 | `a1daae3` | `cernum history <route> [--json]`: a route's qualification verdict timeline, re-derived at each evidence instant from the observation store and sealed runs; read-only | `test/engine/qualification-history.test.ts`: 10 | [qualification-history.md](qualification-history.md) |
| 4 | `51d5964` | Pure per-route and per-capability metrics rollup (count, nearest-rank median and p90 of wall clock and tokens, recorded cost or unknown, retry and failure rates), shown by `cernum history <route> --metrics [--json]`; one shared percentile helper (`src/engine/percentile.ts`) now also used by route-qualification | `test/engine/metrics-rollup.test.ts`: 17 | [metrics-rollup.md](metrics-rollup.md) |
| 5 | `42260e2` | Capability coverage ccm1: debugging and instruction compliance derived from workspace dimension verdicts by a versioned mapping; a capability with no evidence is reported uncovered, never qualified. Engine only: no command or other module reads it yet | `test/engine/capability-coverage.test.ts`: 19 (cases in `test/engine/fixtures/capability-coverage-cases.ts`) | [capability-coverage.md](capability-coverage.md) |
| 6 | `99a41eb` | Routing decision log crd1: `cernum candidates --log` appends a sealed, digested, chained record of each answer with its query, policy versions, time and the cause of every added, removed or reordered route; read-only `cernum decision-log` verifies digest, name and chain and refuses a tampered record (exit 4) | `test/engine/routing-decision-log.test.ts`: 14 | [routing-decision-log.md](routing-decision-log.md) |
| 7 | `3679528` | Ordra task taxonomy ctt1: `cernum candidates --task <type> --tier <n> --context <tokens>` maps a pass's task type, structural tier and context to a crc2 RouteCandidateQuery; an unknown type or tier is refused with its reason (exit 2) | `test/engine/task-taxonomy.test.ts`: 13 | [task-taxonomy.md](task-taxonomy.md) |
| 8 | `283116c` | Advisory fallback chain cfc1: `cernum candidates --fallback [--json]` orders the qualified set by zero marginal cost, qualification freshness and the metrics rollup, carries every exclusion with its reasons, lets an unavailable or throttled route fall through; never a selection | `test/engine/fallback-chain.test.ts`: 17 | [fallback-chain.md](fallback-chain.md) |
| 9 | `ec4c02d` | Limit evidence cle1: usage-limit and rate-limit events (session throttle state, circuit-breaker throttle signals) written as providerAvailability and routeAvailability observations with source, time and expected return; `cernum availability` and `cernum candidates` read them back so a limited route is unavailable until its evidence expires. Fixture modelled on the 2026-09-21 incident | `test/engine/limit-evidence.test.ts`: 19 (fixture `fixtures/limit-evidence/usage-limit-2026-09-21.json`) | [limit-evidence.md](limit-evidence.md) |
| 10 | `0b12633` | Regression detector crg1: `cernum regressions [<route>] [--json]` compares each route's latest qualification evidence with its history under versioned thresholds crt1 (verdict downgrade, success-rate drop over 100‰, p90 wall-clock or token increase over 50%), beside the existing stale-qualification findings; detection only | `test/engine/regression-detector.test.ts`: 15 | [regression-detector.md](regression-detector.md) |
| 11 | `43fe80c` | Status export cse1 v1: `cernum status-export [--json] [--context <tokens>]` emits one versioned read-only document for Ordra Office (discovered models, qualified routes, per-capability candidates, metrics rollup, regressions, recent qualification results, costs where known, the cfc1 fallback chain per ctt1 task type and tier, active leases), validated against [status-export.schema.json](status-export.schema.json) | `test/engine/status-export.test.ts`: 16 (schema checked by `test/engine/json-schema-subset.ts`) | [status-export.md](status-export.md) |

Existing test changed by the block: `test/engine/development-cli.test.ts` declares the new commands
`history`, `decision-log`, `regressions` and `status-export` as additions, and declares `candidates`
as `writesLocal` because `--log` writes the decision log. That test still fails on any undeclared
command or any undeclared change of effect. No test, the naming guard or the vitest configuration
was removed, skipped or narrowed.

## Commands this block added

| Command | Effect | Added in |
| --- | --- | --- |
| `cernum history <route> [--json]` | read-only | `a1daae3` |
| `cernum history <route> --metrics [--json]` | read-only | `51d5964` |
| `cernum candidates <capability> --log` | appends to `<root>/.routing-decisions` | `99a41eb` |
| `cernum decision-log [--capability <c>] [--query <digest>] [--json]` | read-only | `99a41eb` |
| `cernum candidates --task <type> --tier <n> --context <tokens>` | read-only (writes only with `--log`) | `3679528` |
| `cernum candidates … --fallback [--json]` | read-only (writes only with `--log`) | `283116c` |
| `cernum availability`, `cernum candidates` reading limit evidence | read-only | `ec4c02d` |
| `cernum regressions [<route>] [--json]` | read-only | `0b12633` |
| `cernum status-export [--json] [--context <tokens>]` | read-only | `43fe80c` |

## Gate verification run by the worker (a claim; Ordra's own run is the evidence)

At `43fe80c`, one file per command:

- `npm run typecheck`: exit 0
- `npm test -- test/engine/naming-guard.test.ts`: 6/6
- `npm test -- test/engine/qualification-history.test.ts`: 10/10
- `npm test -- test/engine/metrics-rollup.test.ts`: 17/17
- `npm test -- test/engine/capability-coverage.test.ts`: 19/19
- `npm test -- test/engine/routing-decision-log.test.ts`: 14/14
- `npm test -- test/engine/task-taxonomy.test.ts`: 13/13
- `npm test -- test/engine/fallback-chain.test.ts`: 17/17
- `npm test -- test/engine/limit-evidence.test.ts`: 19/19
- `npm test -- test/engine/regression-detector.test.ts`: 15/15
- `npm test -- test/engine/status-export.test.ts`: 16/16

None failed, so no source or fixture was changed by this gate. The whole suite (`npm test` without
file arguments) was not run by the worker; Ordra runs it as this gate's verification.

## Test file counts after the block

`test/unit/` 3, `test/parity/` 3, `test/engine/` 127: 133 files under `npm test`. Block 2 added the
nine engine files above to the 118 engine files at the merge.
