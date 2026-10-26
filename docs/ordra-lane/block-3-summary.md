# Block 3 summary: release detection, bounded qualification requests and the advisory recommendation

Pass P-7098, goal G-6529@v1, campaign C-6539@v1: block 3's milestone gate.

Block 3 built, on Block 2's verified gate `4d8f67b` on the local branch `ordra/cernum-integrate-main`,
the path from Cernum's qualification data to an advisory per-task recommendation Ordra can consume:
detection of new Claude and Codex releases, bounded qualification requests, qualification policy cqp2
and outcome feedback. cqp2 and crr1 follow the owner's D-C5 and D-C6 answers of 2026-10-25 (crr1
order: reliability, cost, latency). Everything is offline code tested on fixtures, recorded data and
injected fakes: no model, provider or network service is contacted, no LaunchAgent is installed,
nothing is selected or launched, and qualification policy cqp1, with its 90% threshold, stays the
default.

Block range: `4d8f67b` (block 2 gate) to `a5baabc` (outcome feedback). This gate adds no feature; it
adds this document and corrects README.md.

## Commits

| # | Commit | What it delivered | Tests (file: count) | Docs |
| --- | --- | --- | --- | --- |
| 1 | `0aa1495` | Model description schema cmd2 (sourced lifecycle `Known<active\|deprecated\|retired>`, sourced aliases, alias resolution and dedup by canonical id, cmd1 still readable); a pure discovery delta cdd1 (new, changed with each field, disappeared, not refreshed); a release report crl1 that reports each new model once against a sealed, hash-chained, append-only ledger. Shown by `cernum discovery-delta` and `cernum release-report`, both with `--json` | `test/engine/model-lifecycle.test.ts`: 23; `test/engine/release-report.test.ts`: 15 (fixtures `fixtures/model-lifecycle/`) | [model-lifecycle.md](model-lifecycle.md) |
| 2 | `a0ebab1` | Docs only: the README `cernum release-report` row links to model-lifecycle.md like every other row | none | README.md |
| 3 | `b82e6ed` | Catalogue discovery ccd1: codexCLI (`codex debug models` recorded as a source catalogue, listed and unproven), claudeCLI (`cannotList` recorded as a value), anthropicAPI (listing consulted only behind an already-configured credential, otherwise `notConsulted`); discovered, reachable and qualified kept separate on every row; a discovery-refresh probe adapter. Engine only | `test/engine/catalogue-discovery.test.ts`: 15 (fixtures `fixtures/catalogue-discovery/`) | [catalogue-discovery.md](catalogue-discovery.md) |
| 4 | `9919e2a` | Discovery cadence cds2: generate-only launchd listing every 6 hours and a nightly full reconciliation in quiet hours, the 6 GiB floor kept, a memory-pressure guard, a capped exponential rate-limit backoff. cds1 pinned byte-identical by golden fixtures; `cernum discovery-schedule` still prints cds1. Nothing is installed | `test/engine/discovery-cadence.test.ts`: 29 (golden fixtures `fixtures/discovery-schedule/cds1/`) | [discovery-cadence.md](discovery-cadence.md), [discovery-schedule.md](discovery-schedule.md) |
| 5 | `a057ac4` | Qualification request planner cqn1 as `cernum plan-qualification --json`: one bounded request per route, the identity smoke first and the discriminator matrix only after a passing smoke, renewal within 7 days of expiry, metered and unknown-cost routes never planned, current unchanged evidence skipped, each run charged against a sealed hash-chained request-budget ledger that refuses past the budget. Nothing is executed | `test/engine/qualification-planner.test.ts`: 16 | [qualification-planner.md](qualification-planner.md) |
| 6 | `ffc297a` | Qualification policy cqp2 (D-C5): every cqp1 requirement including the 90% threshold, plus scored runs from at least 2 separate sessions or UTC calendar days. cqp1 is still the default; cqp2 is used only when a caller passes it. A route cqp1 qualifies from one session is reported not qualified under cqp2 with that blocker named | `test/engine/qualification-policy-cqp2.test.ts`: 12 | [qualification-policy-cqp2.md](qualification-policy-cqp2.md) |
| 7 | `c0f5167` | Per-task recommendation crr1 (D-C6) as `cernum recommend <task-type> [--tier n] [--context tokens] --json`: the ctt1 task mapped to its crc2 query; only qualified, unexpired, identity-proven and compatible routes ranked by reliability from the metrics rollup (unknown last), then zero marginal cost, then p90 latency; every excluded route with its reasons, the cfc1 fallback order and a reasons array. Advisory only: never selects, writes or launches | `test/engine/recommend-crr1.test.ts`: 17 | [recommendation.md](recommendation.md) |
| 8 | `a5baabc` | Outcome feedback cro1 as `cernum ingest-outcomes <file> --json`: exported Ordra route telemetry appended as sealed `routeOutcome` observations, idempotently; a requested model differing from the reported one recorded as a substitution finding; a malformed or duplicate line quarantined as a sealed `routeOutcomeQuarantine` with its text and reason, never dropped. Outcomes feed the metrics rollup and never a qualification verdict | `test/engine/route-outcome-ingest.test.ts`: 14 (fixture `fixtures/route-outcomes/ordra-route-telemetry.jsonl`) | [route-outcome-ingest.md](route-outcome-ingest.md) |

Existing test changed by the block: `test/engine/development-cli.test.ts` declares the new commands
`recommend` and `discovery-delta` as `readOnly`, and `release-report`, `plan-qualification` and
`ingest-outcomes` as `writesLocal` (each writes only under `--record`, `--write`, or by appending
outcomes to the observation store). That test still fails on any undeclared command or any
undeclared change of effect. `src/engine/observation-store.ts` gained the two observation kinds
`routeOutcome` and `routeOutcomeQuarantine`. No test, the naming guard or the vitest configuration
was removed, skipped or narrowed.

## Commands this block added

| Command | Effect | Added in |
| --- | --- | --- |
| `cernum discovery-delta [--before <file> --after <file>] [--aliases <file>] [--json]` | read-only | `0aa1495` |
| `cernum release-report [--providers <list>] [--aliases <file>] [--record] [--json]` | read-only (appends to `<root>/.release-reports/reported.jsonl` only with `--record`) | `0aa1495` |
| `cernum plan-qualification [--budget <runs>] [--smoke-results <file>] [--write] [--json]` | read-only (writes request files and budget charges under `<root>/.qualification-requests/` only with `--write`); runs nothing | `a057ac4` |
| `cernum recommend <task-type> [--tier <n>] [--context <tokens>] [--json]` | read-only | `c0f5167` |
| `cernum ingest-outcomes <file> [--json]` | appends sealed outcomes and quarantines to the observation store | `a5baabc` |

ccd1, cds2 and cqp2 are engine code with no new command: `cernum discovery-schedule` still prints cds1,
and cqp1 is the policy every command decides under.

## Gate verification run by the worker (a claim; Ordra's own run is the evidence)

At `a5baabc`, one file per command:

- `npm run typecheck`: exit 0
- `npm test -- test/engine/naming-guard.test.ts`: 6/6
- `npm test -- test/engine/model-lifecycle.test.ts`: 23/23
- `npm test -- test/engine/release-report.test.ts`: 15/15
- `npm test -- test/engine/catalogue-discovery.test.ts`: 15/15
- `npm test -- test/engine/discovery-cadence.test.ts`: 29/29
- `npm test -- test/engine/qualification-planner.test.ts`: 16/16
- `npm test -- test/engine/qualification-policy-cqp2.test.ts`: 12/12
- `npm test -- test/engine/recommend-crr1.test.ts`: 17/17
- `npm test -- test/engine/route-outcome-ingest.test.ts`: 14/14

Also run, because the block changed the modules or the test they cover:
`test/engine/development-cli.test.ts` 17/17, `test/engine/route-qualification-and-routing.test.ts` 15/15,
`test/engine/discovery-schedule.test.ts` 28/28, `test/engine/route-metadata-discovery-machines.test.ts`
21/21, `test/engine/routing-policy-governance.test.ts` 15/15, `test/engine/fleet-routing-query.test.ts`
13/13.

None failed, so no source or fixture was changed by this gate. The whole suite (`npm test` without
file arguments) was not run by the worker; Ordra runs it as this gate's verification.

## Test file counts after the block

`test/unit/` 3, `test/parity/` 3, `test/engine/` 135: 141 files under `npm test`. Block 3 added the
eight engine files above to the 127 engine files at block 2's gate.
