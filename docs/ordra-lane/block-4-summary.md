# Block 4 summary: the vision in the repository and the Cernum side of V1 routing

Pass P-7751, goal G-7727@v1, campaign C-7737@v1: block 4's milestone gate.

Block 4 built, on Block 3's verified gate `f860d06` on the local branch `ordra/cernum-integrate-main`,
proposal P-B4 toward the owner's Cernum Master Vision v1.0 (2026-10-26). It put the vision in the
repository, resolved conflicts K1 and K2 as the owner chose (reliability, then cost, then speed,
everywhere; the 80% legacy recommender labelled non-routing, cqp1's 90% the only routing threshold),
and built the Cernum side of V1 routing: effort-keyed evidence, the crr2 recommendation contract,
substitution quarantine, classification of real Ordra passes and aggregation of Ordra outcomes.
Everything is offline code tested on fixtures, recorded data and injected fakes: no model, provider
or network service is contacted, no LaunchAgent is installed, nothing is selected or launched,
Ordra's launcher is untouched, and qualification policy cqp1, with its 90% threshold, stays the
default.

Block range: `f860d06` (block 3 gate) to `0430af9` (outcome learning). This gate adds no feature. It
declares the block's three new commands in the existing command register test (`74281ad`, below),
adds this document and corrects README.md.

## Commits

| # | Commit | What it delivered | Tests (file: count) | Docs |
| --- | --- | --- | --- | --- |
| 1 | `6906e5d` | The owner's Cernum Master Vision v1.0 as `docs/VISION.md` (sha256 pinned by the test), pointers from README.md and ARCHITECTURE.md, and the vision conflict register K1–K5 with verified code locations and resolutions. Docs only | `test/engine/vision-doc.test.ts`: 5 | [VISION.md](../VISION.md), [vision-conflicts.md](vision-conflicts.md) |
| 2 | `702b23c` | K2: the legacy prose recommender (recommendation.policy.v1, 80%) labelled non-routing with a typed `routing: 'none'` in its output, its doc comment and the Results view; its 80% behaviour unchanged. The test guards that no routing path loads or calls it and that cqp1's 90% is the only routing threshold | `test/engine/legacy-recommender-non-routing.test.ts`: 9 | [vision-conflicts.md](vision-conflicts.md) (K2) |
| 3 | `21eaa28` | Effort-keyed route evidence cek1: runs whose applied effort telemetry measured are keyed `provider:model@effort`, all others `provider:model@unobservable:<requested>`, never pooled; per-key qualification records and history carrying `evidenceEffort`. Shown by the opt-in `cernum candidates … --by-effort [--json]`; crc2 without it is unchanged | `test/engine/effort-keyed-routes.test.ts`: 11 | [effort-keyed-routes.md](effort-keyed-routes.md) |
| 4 | `f59b727` | Recommendation contract crr2 beside an unchanged crr1, as `cernum recommend <task-type> --contract crr2 [--allow-metered] --json`, validated by `recommend-crr2.schema.json`: the selected route, exact model id, effort or effort-unobservable and machine key; the ranking and the cfc1 chain re-ordered as cfc2 by reliability (Wilson 95% lower bound), then zero marginal cost, then latency; expected reliability with sample size and interval, median and p90 duration, resource posture, qualification policy and expiry, confidence with named uncertainties, every exclusion with its reasons. Subscription-only unless `--allow-metered`. Advisory only | `test/engine/recommend-crr2.test.ts`: 29 | [recommend-crr2.md](recommend-crr2.md), [recommend-crr2.schema.json](recommend-crr2.schema.json) |
| 5 | `131d630` | Substitution quarantine csq1: a smoke `substituted` verdict or an ingested outcome substitution finding seals a `routeQuarantine` entry with its cause and evidence; the route is excluded from `candidates`, `recommend` and the fallback chain with reason `quarantined`. `cernum quarantine list [--json]` reads; `cernum quarantine release <route> --reason <text>` appends a `routeQuarantineRelease` record and never deletes | `test/engine/route-quarantine.test.ts`: 16 | [route-quarantine.md](route-quarantine.md) |
| 6 | `5d8e265` | Ordra pass classifier cpc1 as `cernum classify-pass <file> --json`: an exported pass record mapped by fixed, documented rules over objective verbs and phrases, scope paths, verification commands and writable paths to a ctt1 task type and tier, with evidence for each, a confidence and the `recommend` query; refused with every reason (no matching verb, ruled out by authority, tie, nothing measuring size, malformed), never defaulted | `test/engine/pass-classifier.test.ts`: 37 (18 fixtures in `fixtures/pass-classifier/`) | [pass-classifier.md](pass-classifier.md) |
| 7 | `0430af9` | Outcome learning col1 as `cernum outcomes [--task <type>] [--machine <key>] [--minimum-sample <n>] --json`: ingested Ordra outcomes aggregated per model, cek1 effort key, ctt1 task type and machine key into counts, retries, success rate with a Wilson 95% interval, verification pass rate and median and p90 duration; evidence class `ordra_operational`, kept apart from benchmark evidence; cells below the minimum sample (default 5) `insufficient` and influencing nothing; never changes a qualification verdict. cro1 gained the optional fields `taskType`, `requestedEffort` and `appliedEffort` | `test/engine/outcome-learning.test.ts`: 17 (fixtures `fixtures/outcome-learning/`) | [outcome-learning.md](outcome-learning.md), [route-outcome-ingest.md](route-outcome-ingest.md) |
| 8 | `74281ad` | Gate fix: `test/engine/development-cli.test.ts` fails on any command not declared in its register, and commits 5–7 had not declared theirs. It now declares `outcomes` as `readOnly`, `quarantine` as `writesLocal` (`release` appends to the observation store) and `classify-pass` as `readOnly`, as block 3 did for its commands. The register stays exact: any other undeclared command or change of effect still fails | `test/engine/development-cli.test.ts`: 17 | none |

Existing modules the block changed: `src/engine/observation-store.ts` gained the observation kinds
`routeQuarantine` and `routeQuarantineRelease`; `src/engine/routing-contract.ts` adds the reason
`quarantined` beside every other reason for a route in force in quarantine, and nothing for any other
route, so crc2 and crc3 answers for unquarantined routes are byte-identical;
`src/engine/route-qualification.ts` and `src/engine/qualification-history.ts` carry
`evidenceEffort`; `src/engine/route-outcome-ingest.ts` reads the optional cro1 fields;
`src/core/recommendation.ts`, `src/core/store.ts`, `src/main/lab-service.ts`, `src/shared/ipc.ts`
and `src/renderer/views/Results.tsx` carry the legacy recommender's `routing: 'none'`. No test, the
naming guard or the vitest configuration was removed, skipped or narrowed.

## Commands this block added

| Command | Effect | Added in |
| --- | --- | --- |
| `cernum candidates … --by-effort [--json]` | read-only; refused beside `--fallback` or `--log` | `21eaa28` |
| `cernum recommend <task-type> --contract crr2 [--tier <n>] [--context <tokens>] [--allow-metered] [--json]` | read-only | `f59b727` |
| `cernum quarantine list [--json]` | read-only | `131d630` |
| `cernum quarantine release <route> --reason <text> [--machine <key>] [--json]` | appends a sealed release record to the observation store; never deletes | `131d630` |
| `cernum classify-pass <file> [--json]` | read-only (reads only the file) | `5d8e265` |
| `cernum outcomes [--task <type>] [--machine <key>] [--minimum-sample <n>] [--json]` | read-only | `0430af9` |

`cernum ingest-outcomes` (block 3) now also quarantines the route of each substitution finding (csq1).

## Gate verification run by the worker (a claim; Ordra's own run is the evidence)

One file per command:

- `npm run typecheck`: exit 0
- `npm test -- test/engine/naming-guard.test.ts`: 6/6
- `npm test -- test/engine/vision-doc.test.ts`: 5/5
- `npm test -- test/engine/legacy-recommender-non-routing.test.ts`: 9/9
- `npm test -- test/engine/effort-keyed-routes.test.ts`: 11/11
- `npm test -- test/engine/recommend-crr2.test.ts`: 29/29
- `npm test -- test/engine/route-quarantine.test.ts`: 16/16
- `npm test -- test/engine/pass-classifier.test.ts`: 37/37
- `npm test -- test/engine/outcome-learning.test.ts`: 17/17

Also run, because the block changed the modules or the command table they cover:
`test/engine/development-cli.test.ts` failed 1 of 17 at `0430af9` (`outcomes`, `quarantine` and
`classify-pass` undeclared) and passed 17/17 at `74281ad`; `test/engine/route-qualification-and-routing.test.ts`
15/15, `test/engine/qualification-history.test.ts` 10/10, `test/engine/route-outcome-ingest.test.ts` 14/14,
`test/engine/cli-argument-safety.test.ts` 21/21, `test/engine/v024-cli-help-safety.test.ts` 18/18,
`test/engine/recommend-crr1.test.ts` 17/17, `test/engine/fallback-chain.test.ts` 17/17,
`test/engine/task-taxonomy.test.ts` 13/13, `test/engine/surface-parity.test.ts` 18/18,
`test/engine/observation-store-persistence.test.ts` 27/27, `test/engine/routing-policy-governance.test.ts`
15/15, `test/engine/status-export.test.ts` 16/16, `test/engine/fleet-routing-query.test.ts` 13/13,
`test/unit/app-state.test.ts` 14/14, `test/parity/store.test.ts` 4/4.

The whole suite (`npm test` without file arguments) was not run by the worker; Ordra runs it as this
gate's verification.

## Test file counts after the block

`test/unit/` 3, `test/parity/` 3, `test/engine/` 142: 148 files under `npm test`. Block 4 added the
seven engine files above to the 135 engine files at block 3's gate.
