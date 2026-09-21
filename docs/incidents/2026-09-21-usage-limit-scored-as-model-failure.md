# Incident — an exhausted subscription allowance was scored as sixty-nine model failures

**Date:** 2026-09-21 · **Machine:** Mac mini (`Skippys-Mac-mini.local`) · **Build:** Cernum v0.2.4
**Campaign:** `cernum-pass07-tierb-codex-scored` · **Candidate:** `codexCLI:gpt-6-astra@max`
**Classification: MEASUREMENT-INTEGRITY DEFECT. The affected attempts measured no model.**

---

## What happened

Partway through the Tier B campaign, the Codex service began answering every request for
`gpt-6-astra@max` with:

> You've hit your usage limit. Upgrade to Pro (…), visit …/settings/usage to purchase more credits
> or try again at Sep 21st, 2026 1:55 AM.

Sixty-nine consecutive attempts were answered that way, and every one of them was written into the
ledger as a terminal `runtimeError` and counted by the ranking as a failure of the model.

Two published numbers came out of that, wrong in opposite directions:

* the candidate's **pass rate was 19.5% over a denominator of 87**, when it had actually been asked
  18 scoreable questions and got 17 of them right — a true rate of **94.4%**; and
* the candidate was published at **rank 1**, because the allowance ran out before it reached a
  single governance case, so it was the only member of its cohort never disqualified. It was ranked
  first for the same reason its rate was wrong.

Each of the sixty-nine rows also carries `retryCount: 2`, so **207 requests** were sent against an
allowance that had already run out, to be told the same sentence 207 times.

## Why it happened

Four ordinary decisions, none of them wrong on its own.

1. **The failure arrived with no HTTP status.** Codex reports it inside a `turn.failed` event, not
   as a 429. Every status-based branch in the adapter's classifier fell through to `transport`.
2. **`transport` is not a throttle.** `PROVIDER_THROTTLE_FAILURES` listed `rateLimited` and
   `notAuthenticated`, so the campaign's abort — which exists for exactly this and works correctly —
   never fired, and the run continued into a wall it had already hit.
3. **`transport` is retryable.** Each deterministic refusal was therefore re-sent twice.
4. **`runtimeError` counts as a fail.** The ranking's rule is "everything that is neither a pass, a
   partial, an awaited review nor inapplicable is a fail", and a row with no answer on it is none of
   those four.

This is the second time this engine has shipped this shape. Pass 9 found it with a content filter,
whose message also arrives with no HTTP status, and fixed that message. Pass 11 fixed the rule.

## What changed

* **The classification reads the provider's sentence before the adapter's label.** Both defects were
  a correctly-worded failure that a status-driven classifier called `transport`.
* **A capability rate contains only rows on which a model was asked a question and answered it.**
  Everything else takes a named disposition — `providerCapacityExhausted`, `providerUnauthenticated`,
  `providerRejectedRequest`, `transportFailed`, `measurementFault` — and leaves the numerator and the
  denominator together. A timeout stays scoreable, deliberately: a model that cannot finish inside
  its budget is a capability outcome and a slow network is not, and that row cannot tell you which.
* **Coverage is published beside every rate**, and a campaign whose coverage is short says so above
  its own leaderboard. Rule 6 alone would have turned a wrong 19.5% into a correct-but-unreadable
  94.4% over 18 of 88 attempts — still at rank 1, with nothing on the row saying so.
* **A spent plan is never retried.** A per-minute burst limit still is; only retry turns on that
  difference, and getting it backwards would trade one defect for a smaller opposite one.
* **The campaign metrics publish two success rates, never one.** `successfulTaskRateMilli` is over
  every attempt and is genuinely depressed by a spent subscription, because that is part of what an
  end-to-end figure measures. `scoredTaskRateMilli` is over the attempts a model answered, and is
  the quality figure. They are printed on the same row — 94.4% beside 19.5% e2e for the candidate
  above — because publishing the second alone is exactly the defect.
* **The throttle abort now tests the whole failure, not only its label**, so a third mislabelling
  costs a stopped campaign rather than a published ranking.

## Disposition of the sixty-nine attempts

**They are preserved, not deleted, and they are not model evidence.** The sealed ledger is unchanged
to the byte; the correction is in the reader. `cernum reinterpret` re-derives the campaign from those
rows' own recorded `detail` and writes the corrected table *beside* the published one. No outcome was
upgraded to a pass, and none ever can be by this path: what changes is only which rows are eligible
to be scored at all.

## What was re-derived, and what moved

| Campaign | Rows reclassified | Effect |
|---|---|---|
| `cernum-pass07-tierb-codex-scored` | 69 | `gpt-6-astra@max` 19.5% (n 87) → **94.4% (n 18), coverage 21.6%**, flagged partial evidence. No other rate or rank moves. |
| `cernum-pass07-tier-ac-scored` | 1 | `claude-opus-4-8` 74.6% (n 67) → 75.8% (n 66) — one `notInstalled` row left the denominator — and it **moves from rank 4 to rank 3**. |
| `cernum-pass08-claude-canonical-a2` | 0 | none |
| `cernum-pass08-codex-observational-b2` | 8 | already corrected by Pass 9's offline reinterpretation; the figures are unchanged by Pass 11. |

`gpt-6-astra@max` remains at rank 1 in the re-derived Tier B table, and the table now says why that
means nothing: it reached **none of the thirteen governance cases** that disqualified every candidate
beside it, because the allowance ran out first. It is not a comparable result, and a retest — a fresh
campaign, superseding rather than rewriting — is the only thing that can make it one.

## What is still NOT measured

Unchanged by this pass and stated again so it cannot be inferred away: **repository understanding and
multi-file editing are not measured by any Cernum suite.** No rate, role or recommendation in any
campaign speaks to either, and none of the suites that do exist may be read as a proxy for them.
