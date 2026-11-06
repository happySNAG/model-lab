# The forward-compatibility pack

`pack.cernum.workspace.forward-compat-one@1` is two sealed workspace cases in a new suite,
`suite.cernum.workspace.forward-compat@1`, defined in `src/engine/workspace-catalog-forward-compat.ts`
and proven offline by `test/engine/workspace-forward-compat.test.ts`. This document says what the pack
is for, what it is not, and what running it would mean.

## Purpose

On the evidence so far, one case separates the strongest candidates from each other:
`ws.d1.asset-container.retitle`, where an editor rewrites a chunked file through a decoded model that
has no field for chunks it does not understand, every visible suite passes for a fix that keeps doing
so, and the format says a rewriting tool copies what it cannot read. It is the only case that
declares `forwardCompatibilityReasoning`, and a difference on one case cannot be told from noise.

This pack asks the same abstract question twice more, in domains unrelated to slabs and to each
other, so that a later run can tell a real gap from a lucky sample:

| case | fixture | the structured file | the decoded model has no place for |
|------|---------|---------------------|------------------------------------|
| `ws.fc.agenda-file.reschedule` | `fixtures/workspace/fc-agenda-file` | a line-based calendar of nested components | properties, parameters and components it does not know |
| `ws.fc.member-roster.transfer` | `fixtures/workspace/fc-member-roster` | a comma-separated roster with a header | columns it does not know, their cells, and comments |

In each, the untouched fixture fails two visible suites; a natural **lossy** fix — repair every visible
defect and keep rebuilding the file through the decoded model — passes every visible suite and fails
a hidden check; a **preserving** fix — the same repairs, with the editor rewritten over the raw
structure — passes every visible suite, every hidden check and every invariant within the case's
change limits. Both reference fixes live only in test code (`test/engine/workspace-forward-compat-fixes.ts`),
never in a fixture. Each case also names three plausible wrong answers, each written by a scripted
agent and refused by a named check. Every hidden check quotes `docs/FORMAT.md` in the fixture it runs in.

## What the pack is not

- **Not tiered.** Each case carries a structural profile of the empirical-discriminator family and no
  tier, exactly as the discriminator cases do. The profiles are kept in their own registry
  (`registeredWorkspaceForwardCompatProfiles`), not in `registeredWorkspaceStructuralProfiles`, so the
  discriminator pack's structural digest, its matrix plans and the routing evidence
  (`routingDifficultyProfiles`) read exactly what they read before.
- **Outside qualification policy cqp1 and every routing input.** No capability, threshold, freshness
  window or recommendation contract (crr1, crr2, crp2, crc2) changes. Until the pack has sealed
  runs, it contributes no evidence; when it does, that evidence is a question for a later goal.
- **Nothing that existed moved.** Every existing case digest (`cwc1:`), comparability key (`cwk1:`),
  pack digest (`cwp1:`), membership and sampling — including `pack.cernum.workspace.discriminator-one@1`,
  which qualification evidence is bound to — is asserted against its literal value in the new test and
  in the untouched `workspace-discriminator.test.ts`. Adding a suite and a pack moved none of them.
- **Not run.** Nothing in this pass sends a request anywhere. Running the pack against any candidate
  is a separate act needing its own approval (the owner's scoped HR-7 words); this pass only defines
  it. `cernum workspace-benchmark pack.cernum.workspace.forward-compat-one --provider <id> --models <a,b> --dry-run` would plan six runs
  per candidate (two cases, three repeats, one attempt each) once that approval exists.

## The authoring rules, kept

The discriminator suite's rules apply unchanged and the test checks each one: ids name the task, never
the answer; no provider, model or outcome appears in the case module or any instruction; fixtures are
deterministic and digest to their seals; no fixture carries a marker, a giveaway file name or any talk
of unseen checks; every hidden check reaches the package through `src/index.js` and quotes a document
the fixture carries.

## Commands

- `npm test -- test/engine/workspace-forward-compat.test.ts test/engine/workspace-discriminator.test.ts`
  — the new proof and the untouched discriminator proof.
- `npm run typecheck`.
- `cernum workspace-benchmark` names the new pack in its pack list; `workspacePackByID` finds it by id
  and by `id@1`.
