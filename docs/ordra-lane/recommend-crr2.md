# Recommendation contract `crr2`

`cernum recommend <task-type> --contract crr2 [--tier <n>] [--context <tokens>] [--allow-metered] --json`
prints one versioned document, contract `crr2` version 1, that validates against
[`recommend-crr2.schema.json`](recommend-crr2.schema.json) (schema id `cernum:recommendation:crr2:1`).
It sits beside [`crr1`](recommendation.md): without `--contract`, or with `--contract crr1`, the command
answers crr1 exactly as before, and `cfc1` is unchanged. The engine is
`src/engine/route-recommendation-crr2.ts`; the tests are `test/engine/recommend-crr2.test.ts`.

**Advisory only.** `selected` names the first-ranked configuration so a consumer need not re-derive it.
Nothing is selected, written or launched: every answer carries `advisory: true`, `isSelection: false`
and `launches: false`. Whether to use any route is Ordra's decision.

## The order

Everywhere in crr2 and cfc2 the order is **reliability, then zero marginal cost, then latency** (owner,
2026-10-26):

1. **Reliability** — the lower bound of the Wilson 95% interval (z = 1.96) on passes over scored runs for
   the task's capability, the higher first; the point rate breaks a tie in the bound; an unknown
   reliability ranks after every known one. The lower bound makes the sample size count: 29/30 (lower
   bound 833‰) ranks above 3/3 (438‰), where crr1's point rate would rank 3/3 first.
2. **Zero marginal cost** before metered.
3. **Latency** — the lower p90 wall clock, then the lower median; unknown after known.
4. The key, so the order is total.

Only routes that are qualified, unexpired, identity-proven and compatible (the crr1 gate, answered by the
crc2 rules) are ranked. Every other route is listed under `exclusions` with every reason.

## Subscription-only by default

Unless `--allow-metered` is given, the query admits only routes of zero marginal cost (local,
subscription-included or confirmed free), whatever the taxonomy row says, and each metered route is
excluded with the reason that crr2 is subscription-only by default. With `--allow-metered` a metered route
is ranked by the same rule, in the metered group, with `resourcePosture.requiresSpendingAuthorization`.
`--allow-metered` is refused beside crr1.

## Fields

| Field | What it holds |
| --- | --- |
| `contract`, `contractVersion`, `jsonSchema` | `crr2`, `1`, the schema path |
| `query` | task type, tier, context, machine key, capability, `allowMetered`, cost policy, and the crc2 `routeQuery` |
| `selected` | key, route key, provider, exact model id, effort (observed, or unobservable), machine key — absent when nothing is ranked |
| `ranking` | every ranked route with its reliability, duration, resource posture, qualification, availability, cfc2/cfc1 positions, reasons and uncertainties |
| `fallback` | `cfc2`: the cfc1 entries re-ordered by the crr2 rule, each keeping cfc1's standing and fall-through reasons, with `cfc1` carried beside it unchanged |
| `expectedReliability` | the selected route's sample size (scored runs), passes, point rate and Wilson 95% interval in thousandths, lower floored and upper ceilinged |
| `expectedDuration` | the selected route's median and p90 wall clock where observed, unknown with the reason otherwise |
| `resourcePosture` | `zeroMarginalCost` or `metered`, its cost eligibility and reasons |
| `qualification` | the default policy (`cqp1`) and, for the selected route, the policy that decided it, its verdicts, `qualifiedAt`, `expiresAt` (`qualifiedAt` plus the 30-day qualification maximum age), the time remaining and whether it is current |
| `confidence` | `high`, `medium`, `low` or `none`, with its basis |
| `uncertainties` | each named by code: `nothingRanked`, `noMetrics`, `reliabilityUnknown`, `smallSample` (fewer than 10 scored runs), `wideInterval` (wider than 200‰), `effortUnobservable`, `durationUnknown`, `fallsThroughNow`, `noFallback` |
| `exclusions` | every route not ranked, by key, with its effort and every reason |

Confidence is `none` when nothing is ranked; `low` when the selected route's reliability is unknown or
rests on a small sample; `medium` when any other uncertainty is named; `high` only with none. These
levels describe the evidence behind an answer: they route nothing and are not qualification thresholds —
cqp1's 90% remains the only routing threshold.

## Tier

With `--tier <n>` a route is ranked only when its record is also qualified at `workspace-tier:tier<n>`
(the crc2 tier gate); otherwise it is excluded with `tier: no evidence at tier<n>`, or with the tier's
verdict. That capability, and the `workspace-tier:` rows of the metrics rollup, come from the sealed runs
of cases that have a tier, and from those runs alone.

A case has a tier one of two ways, both through the bands in `workspace-difficulty.ts`
(`WORKSPACE_TIER_BANDS`: floors, ceilings, and going beyond the tier below on three axes):

- a **declared** difficulty profile, which validation holds to its tier's band; or
- for a case that carries an untiered **structural** profile instead (the empirical discriminator family),
  the tier `deriveWorkspaceStructuralTier` derives from the structural profile's own counts, which is the
  tier whose band holds when exactly one does (`routingDifficultyProfiles`, `workspace-structural-tier.ts`).
  A case that no band holds gets no tier and adds no tier row. No tier is ever assigned by hand or defaulted,
  and the structural profile itself still carries no tier.

The crr2 command reads records, the pooled rollup and every effort-keyed rollup with the same profiles. A
tier row is judged by the record's policy, which is cqp1 (90%) unless another is chosen, exactly like a
capability row: a route at 850‰ on the tier or the capability is never ranked. crr1 and `candidates`
read declared profiles only, so this does not change them.

**The six discriminator-one cases have no derived tier.** `ws.d1.asset-container.retitle`,
`catalog-paging.walk`, `config-migrate.upgrade`, `log-redact.mask`, `query-codec.nest` and
`task-board.reassign` each fall outside every band. tier1 is refused by a ceiling (irrelevant context files,
dependency depth, relevant files or visible checks), tier2 by its floor of four visible checks or of eight
relevant files, or a ceiling, and tier3 by its floors. So runs of `pack.cernum.workspace.discriminator-one@1`
alone still establish no tier, and `recommend implement --tier 1 --contract crr2` over them still excludes
every route with `tier: no evidence at tier1`. Tier evidence for those routes needs runs of cases that have a
tier. `test/engine/recommend-crr2-tier.test.ts` states each case's reading.

## Effort

The command derives each route once per effort key its sealed runs fall under, as
[`candidates --by-effort`](effort-keyed-routes.md) does (cek1). A keyed entry is ranked as
`provider:model@effort` (or `@unobservable:<requested>`), and its reliability and duration are read only
from the rollup of the runs under that key; evidence gathered at another effort is never pooled in. A
route no run measured at any effort is derived pooled, so that its exclusion is still stated; its effort
is `unobservable` with `pooled: true`. No effort is ever read from a model name.
