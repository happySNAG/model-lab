# Qualification request planner (cqn1, cqr1, cqb1)

Block 3, B3-4. `src/engine/qualification-planner.ts`, exposed as `cernum plan-qualification`. It decides
which routes are due a qualification run and writes each one down as a **bounded request file** for an
owner-approved runner, charged against an **explicit run budget**.

**The planner never executes anything.** It contacts no model, provider or network service, runs no
provider CLI and starts no runner. Its output is a plan and, under `--write`, files: one JSON request per
route and one sealed charge line per request. Discovered is not reachable, and reachable is not
qualified: nothing is read from a model's name.

## What it reads

| Input | Source | What it contributes |
|---|---|---|
| Release report (crl1) | `deriveReleaseReport` over the newest snapshot and the release ledger (read only) | Models a listing named that nobody was told about yet: trigger `new`. |
| Discovery delta (cdd1) | `deriveDiscoveryDelta` over the two newest snapshots | `new` models, and `changed` ones with each field that moved. |
| Qualification history (cqh1) | `deriveQualificationHistory` for every listed route | The latest verdict and the evidence window it rests on: current, expiring or expired. |
| Smoke results | `--smoke-results <file>`, recorded results only | Whether a route's identity smoke passed, failed or was refused, and when. |
| Budget ledger (cqb1) | `<root>/.qualification-requests/budget.jsonl` | The budget, every earlier charge, and which requests are already planned. |

The release ledger is only read: the planner never records a release report.

## The rules

1. **One request per route, smoke first.** A route with a trigger and no smoke since that trigger gets an
   identity smoke request (`cernum.identity-smoke@1`, 1 run). Only a smoke that **passed at or after the
   trigger** moves it to the discriminator matrix (`pack.cernum.workspace.discriminator-one@1`, 6 sealed
   cases x 3 repeats = 18 runs). A smoke older than the trigger does not count.
2. **Not reachable is not planned.** A route whose listing records it `refused`, or whose latest smoke since
   the trigger was refused, is skipped as `notReachable`. A failed smoke is `smokeDidNotPass`: left to the
   owner, never retried at the budget's expense.
3. **Metered is never planned.** Cost eligibility is `costEligibilityFor`'s with **no override consulted**.
   `metered` (anthropicAPI, opencodeCLI, …) and `unknown_cost` routes are skipped with the reason, whatever
   was authorised elsewhere. Only `free_confirmed`, `subscription_included` and `local` routes are planned.
4. **Current and unchanged is not re-planned.** A route whose latest verdict is safe to route, whose
   qualification does not expire within 7 days, and whose evidence postdates any trigger that staled it is
   skipped as `evidenceCurrent`. A `changed` model whose change is not material (a newly listed alias, a
   moved availability: not in `MATERIAL_DELTA_KINDS`) does not stale current evidence.
5. **Renewal within 7 days.** A safe-to-route qualification whose evidence window ends at `to` expires at
   `to + maximumAgeMilliseconds` (cqp1: 30 days). When that is 7 days away or less, or already past, the
   route is planned a renewal, smoke first, with `qualificationExpiresAt` in the request.
6. **A planned smoke carries its trigger.** Once a smoke request is charged, its route stays a candidate
   until a discriminator is charged for it, so a passing smoke still unlocks the matrix after the model has
   stopped being new to the release report (`carriedFromLedger: true`).
7. **Every run is charged; the budget refuses.** Requests are charged renewals first, then changed routes,
   then new models, each group by route key. A request whose `runCount` exceeds what remains is skipped as
   `budgetExhausted`, whole: it is never shrunk to fit. An unexpired charge for the same work (same route,
   stage, trigger and benchmark) is `alreadyPlanned` and not charged again; a request expires 7 days after
   it was planned, after which it is proposed, and charged, again.

When two triggers name one route, `changed` outranks `new`, and both outrank `renewal`.

## The request file (cqr1)

Written under `<root>/.qualification-requests/requests/`, created exclusively (an existing file is refused,
never overwritten). Every request carries:

| Field | Meaning |
|---|---|
| `requestID`, `lineageKey` | The digest of the request; the digest of the work (route, stage, trigger, benchmark). |
| `routeKey`, `provider`, `modelID`, `machineKey` | The route and the machine it is planned for. |
| `stage` | `smoke` or `discriminator`. |
| `trigger` | `{ kind: new \| changed \| renewal, since, invalidatesEvidence, detail, carriedFromLedger }`. |
| `benchmark` | `{ id, version }`: the benchmark version the run must use. |
| `caseIDs`, `repeatsPerCase`, `runCount` | The bound. A runner never spends more than `runCount`. |
| `costEligibility` | Never `metered` or `unknown_cost`. |
| `qualificationPolicyID`, `evidenceMaximumAgeMilliseconds` | cqp1, and how long evidence it earns stays current. |
| `qualificationExpiresAt` | Renewals only: when the qualification being renewed expires. |
| `plannedAt`, `expiresAt` | When it was planned; after `expiresAt` it is not to be run. |
| `requiresOwnerApproval` | Always `true`. |

## The budget ledger (cqb1)

`<root>/.qualification-requests/budget.jsonl`, append-only and hash-chained like the release ledger: each
line is sealed (`recordID` is the digest of its content), numbered, and names the line before it. Two kinds
of line:

- `budget` — `{ budget, statedAt, statedBy, reason }`. The newest one is in force. `--budget <runs>` appends
  one under `--write` when it differs from the ledger's; without `--write` it is used for the plan only.
- `charge` — one per written request: `{ requestID, lineageKey, routeKey, stage, trigger, runCount,
  plannedAt, expiresAt }`.

`used` is the sum of charges, `remaining` is `max(budget − used, 0)`; the plan reports both before
(`ledgerBefore`) and after (`ledger`) its own charges. With no budget stated the planner refuses. A line that
does not verify (parse, digest, sequence or link) is refused with every line after it, and **nothing is
planned or written** against that ledger. `writeQualificationPlan` re-reads the ledger and refuses if it
moved since the plan was derived. Charges are appended before the request files are created, so a failure in
between leaves runs counted and not spent, never spent and not counted.

## The command

```
cernum plan-qualification [--json] [--budget <runs>] [--write] [--smoke-results <file>] [--aliases <file>]
                          [--machine <cmk1:…>] [--policy crp1|crp2] [--evidence-roots <roots>] [--root <dir>]
```

- Without `--write`, it prints the plan and writes nothing.
- With `--write`, it writes each request file and charges it on the ledger. Nothing is run.
- Exit 2: no snapshot on the machine, no budget stated, a malformed option or file, or an observation file
  that did not verify. Exit 4: a budget ledger line that did not verify, or a ledger that moved; nothing is
  written.

`--smoke-results` is a JSON list (or `{ "smokeResults": [...] }`) of `{ routeKey, outcome: passed | failed |
refused, observedAt, source }`.

## Tests

`test/engine/qualification-planner.test.ts`, fixtures only (`fixtures/model-lifecycle`, histories built as
values, temporary roots, the network tripwire preloaded for the command): the plan over the fixture
snapshots (renewal, changed and new; smoke then discriminator), the stored benchmark version and expiry,
evidence-current skips, the 7-day renewal boundary, metered exclusion, unreachable and failed-smoke skips,
budget refusal, the written files and sealed ledger, carried smokes, a moved or tampered ledger, and the
command with and without `--write`.
