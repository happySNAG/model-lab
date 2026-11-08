# Requalification schedule (R-50)

The qualification planner (`cqn1`, `src/engine/qualification-planner.ts`) decides at one instant which
routes need a renewal now. This feature gives the forward view: for every route whose latest
qualification verdict is safe to route, it says when a renewal falls due. The dates come soonest first,
up to a horizon. The schedule is a `cqs1` document.

The engine is `deriveRequalificationSchedule(inputs)` in `src/engine/requalification-schedule.ts`.
Tests: `test/engine/requalification-schedule.test.ts`.

## Inputs

- **`now`**: the instant the schedule is taken at.
- **`horizonMilliseconds`**: due dates later than `now` plus this are left out. It must be a whole,
  non-negative number of milliseconds. `0` lists only what is already due.
- **`histories`**: the routes' `cqh1` qualification histories, as `QualificationHistory` values. If a
  route key appears twice, the last history wins, as in the planner.
- **`policy`** (optional): the qualification policy whose `maximumAgeMilliseconds` sets the expiry. The
  default is the planner's default, `cqp1`.
- **`renewalWindowMilliseconds`** (optional): the default is the planner's `RENEWAL_WINDOW_MILLISECONDS`
  (7 days).

## The rule (`cqs1`)

For each route history:

| Condition | Result |
| --- | --- |
| no entry | `notScheduled`, `noHistory` |
| the newest entry's evidence window has no readable end | `notScheduled`, `unreadableEvidence` |
| the newest verdict is not `safeToRoute` | `notScheduled`, `latestVerdictNotSafe` |
| otherwise | scheduled, with `expiresAt`, `dueAt`, `state` and `due` |

A scheduled route is listed when `dueAt <= now + horizon`. Otherwise it is counted in `beyondHorizon`
and not listed.

- `expiresAt` is `latestQualificationEvidence(history, policy).expiresAt`: the newest evidence plus the
  policy's maximum age.
- `dueAt` is `expiresAt` minus the renewal window. From this instant the planner plans a renewal.
- `state` is `qualificationExpiryState(expiresAt, now, renewalWindow)`. It is `current` before `dueAt`,
  `expiring` from `dueAt` (inclusive) until `expiresAt`, and `expired` from `expiresAt` on.
- `due` is `state !== 'current'`.

`scheduled` is sorted by `dueAt`, then by route key in code-point order. `notScheduled` is sorted by
route key. Each `notScheduled` entry has a `detail` sentence.

## One rule, not two

The module imports `latestQualificationEvidence`, `qualificationExpiryState` and
`RENEWAL_WINDOW_MILLISECONDS` from `qualification-planner.ts` and does not edit that file. It does not
recompute the expiry. So, at any `now`, the routes the schedule marks `due` are exactly the routes the
planner gives a renewal trigger (in a request or in a skip). The test checks this at many instants,
under both policies and three renewal windows.

## What it does not do

- It writes nothing. It reads no file, installs no timer, cron job or launch agent, and starts no process.
  It is a pure function of its inputs.
- It runs nothing when a date arrives. Acting on a due date belongs to the planner, and an owner approves
  each request.
- It does not change qualification policy, routing, the planner or any existing file.
- It adds no CLI verb and no cycle wiring.
- It contacts no model, provider or network service.
- It does not decide whether a route is worth renewing. Cost eligibility, reachability and budget stay
  with the planner. A metered route can be scheduled here and still be skipped by the planner as metered.
  The planner still records that skip with a renewal trigger.
