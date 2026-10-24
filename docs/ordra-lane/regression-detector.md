# Regression detector — thresholds `crt1`, report `crg1`

The regression detector compares each route's latest qualification evidence with that route's own
history. It reports three kinds of regression under documented, versioned thresholds, and lists the
stale-qualification findings that already exist beside them:

- a **verdict downgrade**: the route's latest verdict, or one capability's, is worse than a verdict
  it held earlier;
- a **success-rate drop**: the latest scored runs passed less often than the runs before them, by
  more than the threshold;
- a **p90 latency or token increase**: the latest scored runs' nearest-rank p90 wall clock, or p90
  total tokens, is above the earlier runs' p90 by more than the threshold;
- **stale qualifications**, kept separate: the route's evidence is too old or no longer matches the route.

**It only detects.** It changes no verdict, record or policy. Qualification policy `cqp1` decides
exactly as before. Nothing here is read by `deriveRouteQualification`, `candidates`, the fallback
chain or the decision log, and nothing is written. Every report carries that disclosure
(`REGRESSIONS_ARE_DETECTION_ONLY`).

## Usage

```
cernum regressions [<route>] [--machine <cmk1:…>] [--root <dir>] [--evidence-roots <dir>[,<dir>…]]
                   [--policy crp1|crp2] [--json]
```

With no `<route>`, every route a sealed run measured is compared, in route-key order. That order is
not a ranking. A route that has only been observed and never measured has no qualification to
regress from, so it is not listed. `--root`, `--evidence-roots`, `--machine` and `--policy` mean
what they mean for `history`: a run reached through two roots counts once, and a root that does not
exist is refused. `--json` prints the whole report (schema `crg1`).

Exit codes:

- **0** when the report is printed, whether or not it found anything. A finding is information, not
  a failure of the command.
- **2** when the route is malformed or nothing has recorded it, an evidence root is missing,
  `--policy` is unknown, or an observation file did not verify. In the last case the report is
  printed first and the bad files are listed by path.

The engine is `detectRegressions` in `src/engine/regression-detector.ts`. It is pure: it takes the
store's contents, the run rows, the instant to answer for and optional thresholds, and returns a value.

## The thresholds, `crt1`

`V1_REGRESSION_THRESHOLDS`. Every report carries the thresholds it used. A caller may pass others,
under another id. Thresholds that cannot be applied are refused with `RegressionDetectorError`:
a window below 1 run, a limit that is not a whole number of at least 0, a drop above 1000‰, or a
missing id.

| Field | Value | Meaning |
| --- | --- | --- |
| `latestWindowScoredRuns` | 3 | the latest window is the route's most recent 3 dated scored runs. This is cqp1's minimum, the least a verdict may rest on |
| `minimumBaselineScoredRuns` | 3 | at least 3 scored runs must come before the window, or no metric is compared |
| `successRateDropMilli` | 100 | flagged when baseline rate − latest rate is **more than** 100‰ (ten percentage points) |
| `p90WallClockIncreasePercent` | 50 | flagged when latest p90 × 100 is **more than** baseline p90 × 150 |
| `p90TotalTokensIncreasePercent` | 50 | the same, for total tokens |

"Beyond a threshold" means strictly beyond. A value exactly at the limit is `withinThreshold`.

## How each comparison is made

**Verdict downgrades** read the route's qualification history (`deriveQualificationHistory`,
`qualification-history.md`). The latest entry is compared with every earlier entry:

- **The route.** If the latest verdict is `notRoutable` and some earlier entry was `safeToRoute`,
  that is a downgrade. It names the last instant the route was safe to route and the latest entry's
  blockers. A route that was refused for a while and has since recovered has no downgrade.
- **Each capability.** Verdicts are ranked `qualified` > `insufficientEvidence` = `notExercised` >
  `notQualified`. If a capability's latest verdict ranks below the best it held earlier, that is a
  downgrade. A capability missing from the latest entry counts as `absent`, ranked with
  `insufficientEvidence`. It names the last instant the better verdict was held and the latest pass count.

**Metric comparisons** split the route's dated scored runs by `recordedAt`, breaking ties by record
root. The latest `latestWindowScoredRuns` runs are the latest window. Every scored run before them is
the baseline. Each window goes through `deriveMetricsRollup` (`metrics-rollup.md`), so the populations
and the nearest-rank p90 are exactly the rollup's:

- `successRateMilli`: passes over scored runs, in thousandths, rounded.
- `p90WallClockMilliseconds` and `p90TotalTokens`: the rollup's p90 of each window.

A scored run is one that measured the model's work: its status is not in
`STATUSES_THAT_MEASURED_NO_WORK`. A run with no readable `recordedAt` is in no window. It is listed
under `undatedWorkspaceRuns`.

**Not enough history is not a clean result.** If either window is short, all three comparisons are
`notComparable` and the reason says so. If a window recorded no wall clock or no tokens, that p90
comparison is `notComparable`. Neither case is ever reported as a regression or as within threshold.

**Effort.** Like `history`, the comparison covers every effort unless the engine is asked for one.

## Stale qualifications, beside the regressions

Staleness is a different finding from regression: it means time passed or the route moved, not that
the evidence got worse. The detector does not invent a staleness rule. It reports the existing
findings, each under `staleness` on the route:

- `derived`: `qualificationStaleness` as `deriveRouteQualification` applies it at the instant asked
  about (`derivedAt`).
- `freshQualificationQueryReason`: the reason a crc2 query with `requireFreshQualification` gives for
  excluding this route now. It is taken from `qualifiedRouteCandidates` itself. It is absent when such a
  query would not exclude the route for staleness.
- `recorded`: every `qualificationStaleness` observation the store holds about the route on this
  machine, oldest first.

A route whose `derived` staleness is not valid gets a `staleQualification` finding. Such routes are
counted in `staleRouteCount`. Routes with a downgrade, drop or increase are counted in
`regressedRouteCount`.

## The report, `crg1`

| Field | Meaning |
| --- | --- |
| `thresholds`, `qualificationPolicyID`, `routingPolicyVersion` | the rules the report was made under |
| `machineKey`, `effort`, `derivedAt` | what it was asked about |
| `routes[].latest` | the newest history entry: time, verdict, routable capabilities, blocker kinds |
| `routes[].downgrades` | each downgrade, with `from`, `heldAt`, `to`, `latestAt` and `because` |
| `routes[].windows` | the baseline and latest windows: counts, span and record roots |
| `routes[].comparisons` | each metric with `baseline`, `latest`, `change`, `threshold`, `state` and `reason` |
| `routes[].staleness` | the existing staleness findings, as above |
| `routes[].findings` | one sentence per finding, by `kind` and `scope` |
| `regressedRouteCount`, `staleRouteCount` | the two counts, kept apart |
| `undatedWorkspaceRuns`, `corrupt` | evidence that could not be placed, and store files that did not verify |

## Tests

`test/engine/regression-detector.test.ts` uses fixtures only. Scripted matrices seal three passing runs
and then three runs that changed nothing into a temporary root. This uses the repository's fixtures and
real `node` verification, and no provider. The engine tests make copies of a sealed row in memory,
re-timed an hour apart and given recorded statuses, wall clocks and token counts. They cover:

- a steady route;
- a downgrade with its success-rate drop;
- p90 increases with no verdict moved;
- values exactly at a threshold, and a caller's own thresholds;
- too little history;
- a recovered route;
- staleness by age;
- that the inputs are unchanged and the answer is repeatable.

The command tests check `--json` and the text output against the sealed root, refuse an unknown and a
malformed route, and check that the root's bytes are the same before and after.
