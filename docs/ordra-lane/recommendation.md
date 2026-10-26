# Per-task recommendation (crr1)

`cernum recommend <task-type> [--tier <n>] [--context <tokens>] [--json]` answers one question for Ordra:
for this kind of pass, in what order would Cernum's recorded evidence put the routes that qualify for it?
The answer is a versioned, **advisory** ranking, rule `crr1`. It never selects a route, never writes
routing state and never launches anything.

Source: `src/engine/route-recommendation.ts` (`recommendRoutes`). Tests: `test/engine/recommend-crr1.test.ts`.

## From task to query

The task type goes through task taxonomy ctt1 ([task-taxonomy.md](task-taxonomy.md)) to a crc2 query,
exactly as `candidates --task` does. Two differences, both stated in the answer:

- `--tier` and `--context` may be omitted. An omitted tier means no structural tier is required; an
  omitted context means no context requirement. Neither is defaulted, and the first entry of `reasons`
  says which were not asked. A tier or context that **is** given and cannot be read is refused by ctt1.
- The query always sets `requireVerifiedIdentity` and `requireFreshQualification`, so crc2's own
  exclusion reasons apply to unverified-identity and stale routes.

An unknown task type, tier or context is refused with every reason and exit 2, before anything is read.

## What crr1 ranks

Only a route that is all of:

| Condition | Where it is decided | Exclusion reason starts with |
| --- | --- | --- |
| qualified for the task's capability, and for the tier when one is asked | crc2 | `capability:` / `tier:` |
| unexpired: its qualification staleness is established and still valid | crc2 (`requireFreshQualification`), then crr1 when no staleness was ever established | `staleness:` / `expiry:` |
| identity-proven: `verifiedByProvider` or `verifiedByLocalDigest`, never admitted-but-unverifiable or unknown | crc2 (`requireVerifiedIdentity`), then crr1 | `identity:` |
| compatible: its context window holds what the pass needs, and its cost fits the ctt1 row's cost policy | crc2 | `context:` / `cost:` |
| available on the queried machine, unblocked, and (for a local route) qualified on that machine | crc2 | `availability:` / `locality:` / … |

Every other route is listed under `excluded`, sorted by route key, with every reason. None of them can
appear in `ranking`, `order` or the fallback order.

## The order (owner decision D-C6, 2026-10-25)

1. **Reliability.** The task category's success rate in the metrics rollup (cmr1): passes over scored runs
   for the queried capability, higher first. A route whose rate is unknown — no rollup, no run of the route
   for the capability, or no scored run — ranks after every route whose rate is known, carries
   `reliabilityUnknown: true`, and its first reason says `reliability: UNKNOWN …`.
2. **Zero marginal cost** before metered. Under ctt1 every row asks for zero marginal cost only, so a
   metered route is excluded before ranking; the step is still part of the rule.
3. **Latency.** The rollup's nearest-rank p90 wall clock for the capability, lower first, unknown last.
4. **Route key**, so the order is total and the same evidence always gives the same ranking.

No figure is combined with another: each step only breaks the ties the step before it left. Each ranked
entry's `reasons` names its reliability, cost and latency, and which step put it above the next entry.

## The answer

| Field | Meaning |
| --- | --- |
| `schema` | `crr1` |
| `taxonomyVersion`, `contract`, `routingPolicyVersion`, `metricsSchema` | `ctt1`, `crc2`, the routing policy, `cmr1` when a rollup was read |
| `task`, `query` | the ctt1 row and the crc2 query that was answered |
| `ranking[]` | `rank`, `routeKey`, `rankedBy` (the evidence each step compared), `reliabilityUnknown`, `reasons`, `fallback` (this route's cfc1 position and standing), `candidate` (the full crc2 candidate) |
| `order` | the ranked route keys |
| `excluded[]` | every route not ranked, with every reason |
| `fallback` | the cfc1 fallback order ([fallback-chain.md](fallback-chain.md)) over exactly the ranked routes: `chain` and each entry's standing |
| `reasons` | the explanation: the mapping, the counts, what ranks first and why, unknown reliabilities, the fallback order, and that nothing was selected |
| `isSelection`, `launches` | always `false` |
| `disclosure` | the advisory statement |

The crr1 ranking and the cfc1 fallback order are different orders over the same routes: cfc1 puts the
freshest passing qualification first, crr1 puts the most reliable first. Both are carried. A route cfc1
would currently fall through (unavailable, or reached by a recorded throttle) keeps its crr1 rank and
says so in its reasons.

## What it does not do

It reads the observation store and the sealed runs exactly as `candidates` does, and writes nothing — not
the routing decision log, not any file. It contacts no model, provider or network. Which route to use, if
any, is Ordra's decision.
