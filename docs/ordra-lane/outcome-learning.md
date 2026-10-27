# Outcome learning (col1)

`cernum outcomes [--task <type>] [--machine <cmk1:…>] [--minimum-sample <n>] [--json]` aggregates the outcomes
`cernum ingest-outcomes` sealed (cro1) into what Ordra's real passes did, per model, effort, task type and machine
key. Rule version: `col1`. Engine: `src/engine/outcome-learning.ts`. Test: `test/engine/outcome-learning.test.ts`.

It reads the local observation store, writes nothing and contacts nothing: no model, provider or network.

## Evidence class

Every cell, and the answer itself, is labelled evidence class **`ordra_operational`**. This is what Ordra reported
about real passes. It is kept apart from **benchmark** evidence, the sealed runs that route qualification
reads. The two are reported separately and never summed or pooled. Outcome learning reads no sealed benchmark run.
No qualification verdict, timeline, routing contract (crc2, crc3), fallback chain or recommendation (crr1, crr2)
reads outcome learning.

## Cells

A cell is one **(route, effort key, ctt1 task type, machine key)**:

| part | from |
| --- | --- |
| route | `provider:requestedModel` of the outcome |
| effort key | cek1 ([effort-keyed-routes.md](effort-keyed-routes.md)): `provider:model@<applied>` when the line's `appliedEffort` names the effort the session's own telemetry reported it applied; otherwise `provider:model@unobservable:<requestedEffort>`, or `@unobservable:unrecorded` when no effort was sent. An observed and an unobservable key are never pooled, and no effort is read from a model name |
| task type | the line's `taskType`, a ctt1 type ([task-taxonomy.md](task-taxonomy.md)). Never guessed |
| machine key | the `cmk1:` key the outcome was ingested under |

`taskType`, `requestedEffort` and `appliedEffort` are optional cro1 fields
([route-outcome-ingest.md](route-outcome-ingest.md)). A line without them seals to exactly the record it always
did.

Each cell reports:

- **counts**: outcomes, passed, failed, notRun, and **retries** (outcomes whose attempt is 2 or later).
- **success rate** (`successRateMilli`): passed over *every* outcome in the cell, in thousandths. An attempt
  nobody verified is not counted as a success. It comes with its **Wilson 95% interval** (`interval95`: z = 1.96,
  lower bound floored, upper ceilinged), using the same function as crr2.
- **verification pass rate** (`verificationPassRateMilli`): passed over the outcomes verification ran on
  (passed + failed).
- **duration**: the nearest-rank median and p90 of `durationMilliseconds`. Outcomes that recorded no duration are
  counted as `missing`, never filled in.
- the evidence window and the record ids of every outcome in the cell.

Cells are listed in this order: route, effort key, task type (ctt1 order), then machine. The order is not a
ranking.

## The minimum sample

A cell with fewer outcomes than the **minimum sample size (default 5)** is **`insufficient`**. Every answer
states the minimum it used (`minimumSampleSize`). An insufficient cell shows its counts only. Its rates,
interval and durations are `unavailable`, with the reason. Its `influence` is `none`. A sufficient cell's
`influence` is `shownBesideQualification`, and that is the most it can do. `--minimum-sample <n>` changes what
is displayed, never what is decided.

## What is excluded

Every outcome the query reads either lands in exactly one cell or is listed under `excluded` with its reason:

| `reasonCode` | why |
| --- | --- |
| `substituted` | the reported model is not the requested one, so it measured another model. The route is in substitution quarantine (csq1) |
| `unreported` | the session reported no model usage, so which model did the work is unknown |
| `noTaskType` | the line named no ctt1 task type, and none is guessed |

`outcomesRead` equals the cells' total sample size plus the number of exclusions.

## Filters

- `--task <type>` reads only outcomes whose line named that ctt1 type. An unknown type is refused (exit 2).
- `--machine <key>` reads only outcomes recorded under that key. Without it, every machine is read, each in its
  own cells.

## Beside crr2, never inside it

`operationalEvidenceFor(learning, { routeKey, effortRouteKey?, taskType, machineKey })` returns a route's
**sufficient** cells and the number of insufficient ones it held back. A reader such as a crr2 view may show this
*beside* the qualification evidence. The crr2 contract is unchanged. Its ranking, exclusions and verdicts are
derived exactly as before, and no outcome qualifies, disqualifies, ranks or excludes a route. cqp1 and its 90%
threshold are unaffected. The test holds a qualification verdict and its timeline byte-equal across ingesting
and learning from outcomes.
