# Metrics rollup — latency, tokens, cost, retries and failures, per route and per capability

The rollup summarises the sealed workspace runs. It covers each route, and each capability of that
route: how many runs there were, the median and p90 of wall-clock latency and of total tokens, the
cost wherever every run recorded a price, and the retry and failure rates.

**It reads recorded evidence and nothing else.** Every figure comes from a field a sealed run wrote.
Nothing is estimated, nothing is stored, and no provider or model is asked anything.

## Usage

```
cernum history <route> --metrics [--root <dir>] [--evidence-roots <dir>[,<dir>…]] [--json]
```

`--metrics` is an option of the read-only `history` command. `<route>`, `--root` and
`--evidence-roots` mean what they mean for `history`: a run reached through two roots counts once,
and a root that does not exist is refused. `--json` prints the whole rollup (schema `cmr1`).

Exit codes: 0 when the rollup is printed. 2 when the route is malformed, an evidence root is missing,
or **no sealed run of the route** is under the roots read. A rollup over no runs would read the same as
a typo, so it is refused.

The engine is `deriveMetricsRollup` in `src/engine/metrics-rollup.ts`. It is pure. It takes run rows,
plus optionally the workspace cases, the difficulty profiles, a route filter and an effort filter, and
returns a value. With no route filter it rolls up every route the rows measured, sorted by route key.
That order is not a ranking.

## The figures

Each entry, for the route (`capability: "route"`) and for each capability, reports:

| Figure | Population | Rule |
| --- | --- | --- |
| `runCount`, `scoredRunCount`, `passCount`, `failedRunCount`, `retriedRunCount`, `notMeasuredRunCount`, `providerDeclinedRunCount` | all runs | counts |
| `wallClockMilliseconds` | scored runs | `count`, `missing`, nearest-rank `median` and `p90` of `wallClockMilliseconds` |
| `totalTokens` | scored runs | the same, over `totalTokens` read through `attemptMetricsFromRow` (a run whose usage provenance is unavailable recorded no count) |
| `failureRateMilli` | scored runs | runs that did not pass, over scored runs. A `timeout` is scored and counts as a failure. |
| `retryRateMilli` | scored runs | runs with `attemptsUsed > 1`, over scored runs |
| `notMeasuredRateMilli` | all runs | runs whose status is in `STATUSES_THAT_MEASURED_NO_WORK`, over all runs |
| `cost` | all runs | see below |

A **scored** run is one whose status is not `runtimeError`, `safetyAbort` or `envelopeFailure`. A run
that the harness broke, or that a provider declined, timed the harness or the refusal, not the model.
`workspace-aggregate.ts` makes the same split for its model-timing columns. Money spent on such a run
was still spent, so cost counts every run.

**A missing figure is never zero.** A scored run that recorded no wall clock or no tokens is counted
in `missing`, next to the distribution. A distribution or rate with nothing to compute from is
`unavailable` and says why.

## Cost: known only where a price was recorded

Each run's cost is the effective cost `attemptMetricsFromRow` reads from the row:

- **metered**: the `costMicroUSD` priced when the run happened. Its provenance is usually `estimated`.
- **local**: the recorded zero.
- **subscription**: always unknown (`SUBSCRIPTION_NOT_FREE`). The run used part of a flat-fee plan,
  and that share cannot be worked out from one request.

`totalMicroUSD` and `perRunMicroUSD` are given **only when every run in the group has a known cost.**
If any run's cost is unknown, both are `unavailable`. The note says how many runs recorded no cost.
`knownRunCount`, `unknownRunCount` and `unknownBecause` show which runs were unknown and why. The
rollup never adds up only the runs it could read, and never multiplies tokens by a price.

## Capabilities

Capabilities use the names `route-qualification.ts` uses:

- `workspace:<dimension>`, for each dimension the run's sealed case declares
- `workspace-tier:<tier>`, from the case's difficulty profile

A run counts toward every capability its case exercises. Capability entries are therefore different
views of the same runs, and they do not add up to the route entry. A run whose case is not in this
build's catalogue is counted in `unclassifiedRunCount`. It still counts toward the route entry.

## The percentile rule, shared

`src/engine/percentile.ts` holds the one percentile helper: `nearestRankPercentile(values, p)` and
`nearestRankMedian(values)`. For `n` values sorted ascending and `p` in (0, 100], the answer is the value
at 1-based rank `ceil(p / 100 × n)`:

- the median of `[10, 20, 30, 40]` is 20
- the p90 of `[10, 20, 30, 40]` is 40
- the p90 of ten values is the 9th
- any percentile of one value is that value

Each answer is a value some run actually recorded. An even-sized median is the lower of the two middle
values, not their average. No values gives no answer (`undefined`), never 0. A `p` outside (0, 100], or
a value that is not a finite number, raises `PercentileError`.

`route-qualification.ts` now uses this helper instead of its own private median. That median fed
only the record's `efficiency` figures (`medianWallClockMilliseconds`, `medianTotalTokens`). No
verdict, blocker or capability verdict reads them, so no verdict changes. With an even number of
passing runs, the efficiency median is now the lower middle value rather than the rounded midpoint.
The `basis` text now says `nearest-rank`. `frontier-metrics.ts` keeps its own median, which is
unchanged.

## What it is not

- **Not a verdict.** Nothing here feeds `deriveRouteQualification`. Policy `cqp1` is unchanged.
- **Not a ranking.** Routes are listed by key, and no figure orders them.
- **Not a writer.** The tests check that the campaign root's bytes are the same before and after
  the command.

## Tests

`test/engine/metrics-rollup.test.ts` uses fixtures only. The engine is fed hand-written ledger rows
with the fields `workspace-campaign.ts` writes. The command test uses a scripted matrix to seal three
real runs into a temporary root, against the repository's fixtures, with no provider. It then checks
that `--json` prints exactly what the pure function derives from those runs.
