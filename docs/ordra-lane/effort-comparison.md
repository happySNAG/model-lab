# Effort comparison (cec1)

`src/engine/effort-comparison.ts` (R-59, G-25029 C2) answers one question for one model: between the
efforts its runs were **observed** at, does the pass rate differ by more than the sampling noise?

## The function

```ts
compareEfforts(rows: WorkspaceRunRow[], provider: ProviderID, modelID: string, { minimumRuns }): EffortComparisonReport
```

- **rows** — scored workspace run rows (as `collectWorkspaceRunRows` returns them). Rows of any other
  `provider` or `requestedModelID` are ignored.
- **minimumRuns** — the smallest scored sample either side of a pair must have to be compared. It has
  **no default**; a missing, zero or fractional value is refused with an error.

The report (`schema: 'cec1'`) carries:

- `efforts` — each observed effort (in `EFFORT_LEVELS` order) with `runs` (scored), `passes`,
  `unscored`, `passRateMilli` and `interval95`, the 95% Wilson interval from the existing
  `wilsonInterval95Milli` (`route-recommendation-crr2.ts`).
- `comparisons` — every pair of observed efforts (lower, higher) with a verdict:
  - `insufficient` — either side has fewer than `minimumRuns` scored runs;
  - `separated` — the two intervals are disjoint (`higherPassRateEffort` names the side above);
  - `noSeparation` — otherwise (the intervals overlap or touch).
- `unobservable` — every unobservable effort key (`unobservable:<requested>`, `unrecorded` last) with
  its own counts and interval, listed apart.

A run is **scored** unless its status is in `STATUSES_THAT_MEASURED_NO_WORK` (the same denominator rule
as `workspace-aggregate.ts`); such runs are counted as `unscored` and never as failures. A pass is
`status === 'pass'`.

## Effort keys

A row's effort comes only from `rowEffortKey` (`effort-keyed-routes.ts`): observed when the tool's
telemetry measured an applied effort this engine models, otherwise unobservable keyed by what was
requested.

## What it does not do

- It never pools an unobservable run into an observed effort, and never compares an unobservable key.
- It never infers an effort from a model name, a candidate label or a default: a model named `…-high`
  with no measured applied effort has no observed effort.
- It changes no routing, qualification record or policy, and writes nothing — it is a pure function.
- It has no CLI verb and is not wired into any cycle.
