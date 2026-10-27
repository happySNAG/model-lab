# Vision conflict register

Where the owner's Cernum Master Vision v1.0 ([../VISION.md](../VISION.md), 2026-10-26) disagrees with
behaviour already in this repository, the disagreement is recorded here: what the vision asks, what the
code does today (with the locations checked against head `f860d06`), and how it is resolved. Recording a
conflict changes no behaviour; each resolution names the pass that carries it out or the owner decision
that settles it.

Existing contracts Ordra reads (crc2, crc3) stay byte-compatible: a resolution that changes an order
adds a new version beside the old one, it does not edit the old one.

## K1 — ordering: cost first versus reliability first

- **Vision.** Section 3: qualification priorities are 1. correctness and reliability, 2. total resource
  and subscription efficiency, 3. end-to-end completion time. The owner's decision D-C6 (2026-10-25)
  says the same for recommendations.
- **Existing behaviour.**
  - `src/engine/routing-contract.ts:9-14` — crc2 candidates are returned in two groups, zero marginal
    cost first, metered second, alphabetically inside each; `src/engine/routing-contract.ts:64` says
    "in V1 zero-marginal-cost routes are always grouped first regardless".
  - `src/engine/fallback-chain.ts:8` — cfc1's first precedence is "zero marginal cost before metered",
    before freshness and before the rollup's failure rate.
  - `src/engine/route-recommendation.ts:5-14` — crr1 already follows D-C6: reliability, then zero
    marginal cost, then p90 latency, then route key.
- **Conflict.** crc2 and cfc1 order by cost before reliability; the vision and D-C6 put reliability first.
- **Resolution.** B4-4. Owner decision 2026-10-26: reliability, cost, speed everywhere. Delivered as new
  versions beside crc2/cfc1; crc2 and crc3 stay byte-compatible for Ordra.

## K2 — threshold: 80% legacy recommender versus 90% cqp1

- **Vision.** Section 7: preserve the current 90% qualification threshold and cqp1 as the active policy.
- **Existing behaviour.**
  - `src/core/recommendation.ts:25` — the legacy prose recommender's `standardRecommendationPolicy`
    uses `recommendQualityThresholdMilli: 800` (80%).
  - `src/engine/route-qualification.ts:90` — cqp1 (`V1_QUALIFICATION_POLICY`) uses
    `minimumSuccessRateMilli: 900` (90%).
- **Conflict.** Two thresholds could both be read as "the" bar a model must clear.
- **Resolution.** B4-2. Owner decision: the legacy recommender is labelled non-routing; cqp1's 90% stays
  the only routing threshold. cqp1 and its 90% are not changed.
- **Change (B4-2, done).**
  - `src/core/recommendation.ts:29` — `LEGACY_RECOMMENDER_ROUTING` is the typed label `routing: 'none'`
    (`LegacyRecommenderRouting`); the module's doc comment says it informs prose campaigns only.
  - `src/main/lab-service.ts:455` — every legacy recommendation the app presents carries
    `routing: 'none'`, and `SessionResults.recommendationRouting` is `'none'` (`src/shared/ipc.ts`).
  - The Results view's recommendation tab says, beside the 80% policy, that it informs prose campaigns
    only, is not a routing threshold, and that routing uses cqp1 at 90%.
  - The 80% policy, its four outcomes and the sealed `OwnerRecommendationRecord` bytes are unchanged
    (the parity corpus digests them), so the label sits beside the record, not inside it.
  - `src/engine/route-qualification.ts:103` — `DEFAULT_QUALIFICATION_POLICY` stays cqp1 at 900/1000.
  - `src/core/store.ts:11` — the result store's import of the `OwnerRecommendationRecord` shape is now
    explicitly `import type` (it was already erased at runtime; behaviour unchanged).
  - Guard: `test/engine/legacy-recommender-non-routing.test.ts` asserts the label, statically checks that
    no routing path (routing-contract, fallback-chain, route-recommendation, status-export, the
    `candidates` and `recommend` commands in `src/cli/cernum.ts`, and everything they load at runtime,
    dynamic imports included) imports or calls the legacy recommender, that no routing module names it
    even as a type, that the only type-only references reached are the record shape in
    `src/shared/ipc.ts` and `src/core/store.ts`, and that cqp1's 90% is the only routing threshold.

## K3 — launcher integration ownership

- **Vision.** Section 11 asks for recommendations to control actual Ordra worker launches; section 15
  consolidates Ordra core, scheduler and controller-wide policy work in the MacBook Pro's Ordra lane.
- **Existing behaviour.** Cernum is advisory only: `src/engine/routing-contract.ts:9-14` returns a
  candidate set and no winner, and `src/engine/route-recommendation.ts` (crr1) ranks but never selects,
  writes or launches. Nothing in this repository launches an Ordra worker.
- **Resolution.** Owner consolidation 2026-10-26: launcher integration is owned by the MacBook Ordra lane.
  Cernum supplies contracts and evidence (crc2/crc3, crr1 and its successors, route outcomes); it does
  not change Ordra's routing, pin or launcher.

## K4 — subscription-only versus supported metered providers

- **Vision.** Section 4: use existing Claude Code and Codex subscriptions plus local execution; no paid
  API usage without separate explicit owner approval.
- **Existing behaviour.** Metered providers are supported: `src/engine/routing-contract.ts:9-10` keeps a
  metered group, `src/engine/route-spend-posture.ts:14-26` allows a metered or unknown-cost route to be
  benchmarked only under authorization and auto-spent only at zero marginal cost, and
  `src/engine/task-taxonomy.ts:16` asks every task row for zero marginal cost only, the V1 default.
- **Resolution.** No behaviour change. Metered providers stay supported behind authorization; routing
  defaults to zero-marginal-cost routes.

## K5 — reasoning effort pooled into one route

- **Vision.** Section 9: treat a model at low effort and the same model at high effort as separate
  execution configurations when the difference is material; section 15 learns by model, task, effort,
  route and machine.
- **Existing behaviour.**
  - `src/engine/route-qualification.ts:287` — the route key is `${provider}:${modelID}`, with no effort.
  - `src/engine/route-qualification.ts:171-172,293,482` — `effort` is optional; absent, every effort's
    rows are read together and the record says `effort: 'any'`.
  - `src/engine/metrics-rollup.ts:55-56,227,254` — the rollup pools every effort the same way unless one
    is asked for.
- **Conflict.** Qualification and metrics evidence is pooled across effort levels, so a route qualified
  at one effort is indistinguishable from the same model at another.
- **Resolution.** B4-3: effort-keyed evidence added beside the pooled records, without inferring effort
  from a model name and recording effort as unknown where it is not observable.
