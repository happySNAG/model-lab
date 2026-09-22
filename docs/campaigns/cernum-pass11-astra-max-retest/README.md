# `cernum-pass11-astra-max-retest` — retest evidence

**A fresh campaign, not a correction.** It supersedes `codexCLI:gpt-6-astra@max`'s result in
`cernum-pass07-tierb-codex-scored`. It does not edit, re-score, re-open or delete that campaign,
whose ledger remains the record of what happened. See
[`supersedes.json`](supersedes.json) for the pointer and
[the incident](../../incidents/2026-09-21-usage-limit-scored-as-model-failure.md) for why a retest
was the only thing that could make that result comparable.

**Date:** 2026-09-21 · **Machine:** Mac mini (`Skippys-Mac-mini.local`), the same machine as the
campaign it supersedes · **Build:** Cernum v0.2.4 · **Transport-disposition fix:** commit
`87146737ea1e9040a3ba375f830fe855567d2ea3` (`8714673`), which this campaign ran after.

**Candidate:** `codexCLI:gpt-6-astra@max` — requested model `gpt-6-astra`, effort `max`, thinking
disabled, `codex-cli 0.154.0`.
**Campaign:** `campaign:c1f59ceb7f5666a5` · **Manifest:** `manifest:f3a707691bcbbe89`.

## What it measured

| | |
|---|---|
| Planned attempts | 88 (44 cases × 2 repeats, 14 suites) |
| Terminal | 88 — ledger balances, 0 unaccounted, 0 anomalies |
| `pass` / `partial` / `fail` | **49 / 8 / 25** |
| `requiresHumanReview` | **4** — excluded from every rate until the blinded verdicts return |
| `envelopeFailure` | **2** — measured no model; in no rate |
| Scored outcomes | 63 |
| Overall pass rate | **77.8%** over those 63 |
| Coverage | **97.7%** (86 of 88 answered; evidence *not* flagged incomplete) |
| Median latency | 10 727 ms |

## Why it is not a promotion

* **Disqualified.** The candidate broke a governance rule on **11 cases** — listed in
  [`rankings.json`](rankings.json) and [`retention.json`](retention.json). A governance failure is a
  different outcome from a low score, and no pass rate offsets it.
* **Rank 1 is meaningless here.** It is the only candidate in a single-candidate campaign.
* **Identity is unverifiable.** `requestAcceptedIdentityUnverifiable` — the provider accepted the
  identifier and something answered; nothing named what. `promotable: false`, no role qualified, and
  no retention recommendation follows.
* **This is the contrast with the superseded run.** There, the allowance ran out before a single
  governance case was reached, so nothing disqualified it and it was published at rank 1. Measured
  rather than assumed, it reaches all thirteen and fails eleven.

## Allowance and transport did not distort this result

`providerCapacityExhausted`, `providerUnauthenticated`, `providerRejectedRequest`, `transportFailed`
and `measurementFault` are all **0**. The only non-model rows are 2 `providerRefusedContent`
(a content filter on `case:safety-boundaries:refuse-harm`), which leave the numerator and the
denominator together and are reported in the provider-reliability rates instead. No
allowance or transport outcome is counted anywhere as a model-quality failure.

## Cost posture

Subscription-covered Codex usage only — `billingBasis: subscriptionIncluded`, marginal API charge
**$0**, a finite plan allowance consumed and recorded as allowance, never as free. No metered or
pay-per-token binding is present and the cost gate would block one.

## Files

| File | What it is |
|---|---|
| [`manifest.json`](manifest.json) | The frozen benchmark: catalog, prompt, core, evaluator, guard, hardware and execution digests. Every digest defining the *benchmark* is byte-identical to the Tier B manifest. |
| [`configuration.json`](configuration.json) | Machine, candidate binding, retry policy, guard policy, sealed identity admission. |
| [`supersedes.json`](supersedes.json) | The pointer to the superseded campaign, and what this retest explicitly does *not* do. |
| [`final-report.json`](final-report.json) | Reconciliation, both ranking views, retention, identity confidence, guard trace. |
| [`rankings.json`](rankings.json) | Strict JSON transport view — the frozen result, output as it arrived. |
| [`rankings-semantic-json-view.json`](rankings-semantic-json-view.json) | Semantic view, at most one enclosing fence removed. 0 divergences from the strict view. |
| [`retention.json`](retention.json) | Interpretation, not measurement. Reads `disqualified`. |
| [`ledger/meta.json`](ledger/meta.json) | Campaign and manifest identity, suites, execution classes. |
| [`ledger/plan.json`](ledger/plan.json) | The 88 planned slots, frozen before the first request. |
| [`ledger/results.jsonl`](ledger/results.jsonl) | 88 terminal rows, one per slot, each with its disposition. |
| [`ledger/events.jsonl`](ledger/events.jsonl) | Campaign lifecycle: creation, identity admission, lock, refusals, finalization. |
| [`review/blinded-packet.json`](review/blinded-packet.json) | The 4 outcomes awaiting blinded human review. Audited clean: 0 leaks, 0 duplicate tokens, 0 identity fields. |

### Held out of version control on purpose

* **`review-key/packet-key.json`** — the key that reverses the blinding. It stays in the local
  campaign store, apart from the packet, until every verdict is recorded. The 4 reviews are
  **outstanding**; no rate above includes them.
* **`ledger/checkpoint.json`** — transient resume state, fully re-derivable from the ledger.

## What this evidence does not say

**Repository understanding and multi-file editing are not measured by any Cernum suite**, this one
included. No rate, role or recommendation here speaks to either, and none of the suites that do
exist may be read as a proxy for them.
