# Qualification policy cqp2: cqp1 plus independent runs

cqp2 is a second qualification policy, defined next to cqp1 in `src/engine/route-qualification.ts`
(`V2_QUALIFICATION_POLICY`). The owner decided it on 2026-10-25 (D-C5). **cqp1 is still the default.**
cqp2 applies only when a caller passes it.

## What cqp2 requires

| Requirement | cqp1 | cqp2 |
| --- | --- | --- |
| Minimum scored runs per capability | 3 | 3 |
| Minimum success rate | 90% (`900` milli) | 90% (`900` milli) |
| A case that never passed disqualifies | yes | yes |
| Qualification stays current for | 30 days | 30 days |
| Scored runs from at least 2 separate sessions **or** 2 separate UTC calendar days | — | yes (`minimumSeparateSessionsOrUtcDays: 2`) |

cqp2 is cqp1's object with `policyID: 'cqp2'` and the extra field. cqp1 does not have
`minimumSeparateSessionsOrUtcDays` at all, so a record decided under cqp1 is byte-identical to the
records it produced before cqp2 existed.

## Choosing a policy

```ts
import { V2_QUALIFICATION_POLICY, qualificationPolicy, deriveRouteQualification } from './route-qualification';

deriveRouteQualification({ ...inputs });                                     // cqp1: the default
deriveRouteQualification({ ...inputs, policy: V2_QUALIFICATION_POLICY });    // cqp2, chosen explicitly
deriveRouteQualification({ ...inputs, policy: qualificationPolicy('cqp2') }); // the same, by id
```

- `DEFAULT_QUALIFICATION_POLICY` is `V1_QUALIFICATION_POLICY`.
- `qualificationPolicy(id)` returns the policy for `cqp1` or `cqp2`. Any other id throws. It is never
  mapped to the nearest known policy.
- No existing caller was changed. Every caller that used cqp1 by default before (for example
  `status-export` and the qualification planner) still does. No command selects cqp2 yet.

## How sessions and days are counted

`runIndependence(runs)` looks only at the **scored** workspace runs behind each capability, meaning the
runs of that capability's cases that measured work.

- **Session.** A run's session is the row's `sessionID` if it has one. Otherwise it is the evidence
  root the record was sealed into (the directory that holds the record). Two roots count as two
  sessions. Two matrices written into the same root count as one session, so this can only under-count.
- **UTC day.** A run's day is the UTC calendar date of its `recordedAt`. A row whose `recordedAt` cannot
  be read as a time adds no day.

The requirement is met when there are at least 2 sessions or at least 2 UTC days.

## Verdicts under cqp2

1. cqp1's verdict is worked out first and is left alone unless it is `qualified`. So `notExercised`,
   `insufficientEvidence` (fewer than 3 scored runs) and `notQualified` (below 90%, or a case that
   never passed) are the same under cqp2. A failure is never relabelled as missing evidence.
2. If cqp1 would qualify the capability and its runs come from fewer than 2 sessions and fewer than 2
   UTC days, the capability is `insufficientEvidence` under cqp2. More runs in another session or on
   another day could qualify it, so this is missing evidence, not a finding. The capability's `reason`
   gives the cqp1 result and then the shortfall, for example: `3/3 scored runs passed (≥ 90%), but
   cqp2 asks for scored runs from at least 2 separate sessions or UTC calendar days; these came from
   1 session(s) on 1 UTC day(s)`.
3. If that leaves no capability qualified, the route is not safe to route. Its `qualification` blocker
   names the requirement that stopped it: `no capability reached cqp2: <capabilities> met every cqp1
   requirement, but cqp2 asks for …`.
4. Development and prose capabilities come in already decided, from reports that record no session or
   day for each run. Under cqp2, a qualified role from such a report is `insufficientEvidence` with the
   reason `… does not say which session or day its runs came from`. A role that is not qualified stays
   `notQualified`.

The record's `policy` field always holds the policy that decided it, so anyone reading a verdict can
see whether cqp1 or cqp2 produced it.

## Tests

`test/engine/qualification-policy-cqp2.test.ts` uses real sealed workspace records from a scripted
matrix, with no provider. The rows are then re-dated or moved to another root in memory, so the same
evidence can be placed in one session or two, and on one day or two. The tests cover:

- cqp1 is unchanged and is the default.
- cqp2 can be selected by id, and an unknown id is refused.
- A route cqp1 qualifies from one session on one day is not qualified under cqp2, and the blocker is
  named.
- cqp2 qualifies the route across 2 days, across 2 roots, or across 2 named sessions.
- The 90% threshold and the 3-run minimum still apply.
- A qualified development role is held back under cqp2.
