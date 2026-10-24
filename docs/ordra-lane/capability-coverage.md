# Capability coverage — debugging and instruction compliance

Ordra asks two questions no workspace case answers by name: *may this route debug?* and *does this
route do what it was told?* The cases declare finer dimensions instead. This feature derives the two
capabilities from those dimensions. It uses one documented, versioned mapping, **`ccm1`**, and one rule
for combining the dimensions' existing verdicts.

**It adds no measurement and no policy.** Each component verdict is the `workspace:<dimension>`
verdict that `deriveRouteQualification` already gave, under the record's qualification policy (`cqp1`
by default). This feature only combines those verdicts. It sums no run counts and averages nothing. A
case that declares two components counts under both, so a total would count its runs twice.

The engine is `deriveCapabilityCoverage` in `src/engine/capability-coverage.ts`. It is pure: it takes a
`RouteQualificationRecord` and returns a `ccc1` record. Each entry is named `derived:debugging` or
`derived:instructionCompliance`. Each entry has a verdict, a coverage extent, every component with its
own state, counts and cases, and the dimensions that were not covered. Tests:
`test/engine/capability-coverage.test.ts`. Fixture cases: `test/engine/fixtures/capability-coverage-cases.ts`.

## The mapping, `ccm1`

| Capability | Dimension | Why it belongs |
| --- | --- | --- |
| debugging | `failureInterpretation` | Reading what a failing build or test is saying, and finding the cause from it. This is the diagnostic half of debugging. |
| debugging | `recoveryFromError` | Getting from a failed attempt to a passing one. This is the repair half. It is a retry dimension, so only a run whose first attempt failed and which tried again exercises it. |
| debugging | `verificationDrivenRecovery` | Repairing a failed attempt from the engine's own verification report. This is debugging from a report, as a developer works from CI output. It is also a retry dimension. |
| instruction compliance | `scopeDiscipline` | Changing only what the task allows. A route that edits outside its scope has not done what it was told, even when the tests pass. |
| instruction compliance | `contractOverVisibleTests` | Meeting what the task and the repository's contract state, when the visible checks would pass without it. Compliance with the instruction, not with the grader. |
| instruction compliance | `preservationUnderTransformation` | Applying the changes asked for and leaving everything else exactly as it was. This is the literal reading of an instruction's limits. |

Dimensions left out on purpose:

- `secondAttemptAdaptation` is about varying strategy, not about finding a fault.
- `testExecution` is tool use. Running a test is not interpreting it.
- `patchCleanliness` and `regressionAvoidance` are code-quality outcomes, not instructions.
- `destructiveFallbackAvoidance` overlaps preservation, but it is judged on the method rather than on what was asked.

No dimension belongs to both capabilities, and the test enforces this.

The table is pinned to `ccm1` by the test. Changing a list changes what a verdict means, so any change
needs a new mapping version.

## The combination rule

A component is **covered** when the record holds its `workspace:<dimension>` entry and that entry's
verdict is anything except `notExercised`. Over the covered components:

| Covered components | Derived verdict |
| --- | --- |
| none | `uncovered` |
| any is `notQualified` | `notQualified` |
| otherwise, any is `insufficientEvidence` | `insufficientEvidence` |
| all are `qualified` | `qualified` |

`coverage` is `none`, `partial` or `full`. A partial qualification lists `uncoveredDimensions`, so
the evidence behind it is visible. For example, "debugging qualified" can rest on failure
interpretation alone, with no recovery opportunity yet.

**A capability with no evidence is `uncovered`, never `qualified`.** This holds in three cases: no
case declares any of its dimensions; its only cases were retry dimensions passed on the first attempt;
or every run was a harness fault that measured no work. `uncovered` is not `notQualified`, which is a
finding against the route. It is not `insufficientEvidence` either, which means evidence exists but is
too thin.

## Not done here

The derived entries are not added to `RouteQualificationRecord.capabilities`, and they do not change
`routableCapabilities` or `safeToRoute`. There is no CLI surface yet. A consumer calls
`deriveCapabilityCoverage` on a record it already has.
