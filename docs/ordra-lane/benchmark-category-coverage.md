# Benchmark category coverage (R-19)

`docs/VISION.md` section 8 lists twenty benchmark categories, from *Simple code edits* to
*Cross-project integration*. No workspace case names a category. Cases declare finer workspace
dimensions (`ALL_WORKSPACE_DIMENSIONS` in `src/engine/workspace-case.ts`) and belong to a suite. This
feature makes coverage of the twenty categories measurable. It uses one documented, versioned mapping,
**`cbm1`**, from each category to the dimensions and suites that exercise it, and one pure function that
reports each category as `covered`, `partial` or `uncovered`.

The engine is `deriveBenchmarkCategoryCoverage(cases)` in `src/engine/benchmark-category-coverage.ts`.
It returns a `cbc1` report. Tests: `test/engine/benchmark-category-coverage.test.ts`.

## Inputs

- **The cases.** Any list of case definitions. Only each case's `id`, `suiteID` and `dimensions` are
  read. A full `WorkspaceCase` qualifies, so `allWorkspaceCases()` reports on the catalogue this build
  carries.
- **The mapping.** `BENCHMARK_CATEGORY_MAPPING` (`cbm1`) by default. A second argument accepts another
  mapping; it exists for tests.

## The mapping, `cbm1`

| Category | Dimensions | Complete | Why |
| --- | --- | --- | --- |
| Simple code edits | `fileLocation`, `scopeDiscipline` | no | Finding the one place to change and changing only that. No dimension records that the edit was small. |
| Complex code changes | `multiFileEditing`, `interactingInvariantReasoning` | no | Coordinated edits across files and components whose invariants must agree. Size and depth are not declared. |
| Architecture and system design | `interactingInvariantReasoning` | no | Reasoning about how two components must agree is one part of design. Choosing a structure is not declared. |
| Debugging | `failureInterpretation`, `recoveryFromError`, `verificationDrivenRecovery` | yes | Diagnosis from a failing check and repair from it. These are the dimensions `ccm1` derives debugging from. |
| Refactoring | `preservationUnderTransformation`, `regressionAvoidance` | no | Changing what is asked while behaviour elsewhere stays the same. Restructuring code is not declared. |
| Multi-step autonomous development | `autonomousCompletion`, `toolUse` | yes | Finishing a multi-step task without help, using the workspace's tools. |
| Failure recovery | `recoveryFromError`, `verificationDrivenRecovery`, `secondAttemptAdaptation` | yes | The three retry dimensions. |

Every other category maps to nothing, on purpose: New feature implementation, Application UI
implementation, Frontend development, Backend development, API integration, Code review, Test creation,
Test repair, Documentation, Repository maintenance, Merge-sensitive tasks, Long-context work and
Cross-project integration. No dimension honestly exercises them, and a stretched mapping would report
coverage that does not exist. Each has its reason in the module. Some cases carry tags such as `feature`,
but tags are free text and are not part of the mapping.

No suite is mapped: no registered suite is organised by category. The mechanism is there for when one is.

The table is pinned to `cbm1` by the test. Changing an entry changes what a report means, so any change
needs a new mapping id.

## The rule

A mapped dimension is **supported** when at least one case declares it. A mapped suite is supported
when at least one case belongs to it. Per category:

| Condition | State |
| --- | --- |
| nothing mapped, or nothing mapped is supported | `uncovered` |
| mapping complete and every mapped item supported | `covered` |
| otherwise | `partial` |

Each entry lists its supporting case ids (sorted, once each), which mapped items are and are not
supported, and a reason in words. The report adds totals: categories, covered, partial, uncovered and
the number of distinct cases read.

**A category with no mapped case is `uncovered`, never `covered`.** A category with an incomplete
mapping can reach `partial` at best, however many cases declare its dimensions.

## What it does not do

- **It measures nothing.** It reads what case definitions declare, not what any run did. `covered`
  means cases exist that were built to exercise the category. It does not mean any model was tested on
  it or passed. It reads no ledger, evidence or model output, and calls no model.
- **It changes nothing.** It adds no case, category or suite and writes no file. The cases passed in are
  not modified, so every case, suite and pack digest is the same afterwards. The test checks this
  against the registered catalogue.
- **It decides nothing.** It does not touch qualification policy (`cqp1`), routing or
  `RouteQualificationRecord`. There is no CLI verb and no cycle wiring yet. A consumer calls
  `deriveBenchmarkCategoryCoverage` on cases it already has.
- **It is deterministic.** The same cases give the same report, in any order.
