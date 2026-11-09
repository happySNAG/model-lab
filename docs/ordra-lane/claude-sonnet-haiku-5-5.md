# Claude Sonnet 5.5 and Claude Haiku 5.5 — authorised, born unproven

Pass P-26247 (G-26236, R-01, V1-01) adds two Claude CLI candidates to Cernum's plan. It does not
make either one runnable or routable.

## What changed

- `src/engine/reconciliation.ts` adds a new authorisation list, `CLAUDE_SONNET_HAIKU_5_5_ADDITIONS`:

  | provider    | modelID             | displayName        | effort |
  |-------------|---------------------|--------------------|--------|
  | `claudeCLI` | `claude-sonnet-5-5` | Claude Sonnet 5.5  | `none` |
  | `claudeCLI` | `claude-haiku-5-5`  | Claude Haiku 5.5   | `none` |

  `AUTHORIZED_COHORT` now ends `...CLAUDE_OPUS_5_5_ADDITIONS, ...CLAUDE_SONNET_HAIKU_5_5_ADDITIONS`.
  `REQUESTED_COHORT` is still the frozen Pass 5C request of 12 entries and contains neither id.
- `src/engine/discovery.ts` adds the two matching `DESIRED_CANDIDATE_LADDER` rows, `desiredEfforts:
  ['none']`, directly after the `claude-opus-5-5` row. No other row changed.

## On whose authority

The repository owner's written authorisation of 2026-11-08: a separate Cernum candidate authorisation
list, born unproven, with no routing change. It follows the pattern of `CLAUDE_OPUS_5_5_ADDITIONS`
(commit b3d6e10): its own list, so each authorisation stays legible as what was granted.

## The identifiers are not yet confirmed

Opus 5.5's id was reported by the `claude` CLI's own metadata before it was written down. These two
were supplied by the owner and have not been observed. They are confirmed only by a later identity
smoke test, which is a separate act and was not run here.

## Born unproven

Like every ladder row, both are `unproven` in `desiredCandidates(...)` and in `claudeCLI` discovery
output while no proof exists; `selectableModels` drops them and the campaign builder refuses them. Only
an identity smoke test that comes back naming the model promotes either one.

## What this pass did not do

No model call, identity smoke, discovery run or provider contact; no effort rows other than `none`;
no qualification, routing, pin, policy, case, pack or digest change.

## Tests

- `test/engine/claude-sonnet-haiku-5-5-authorization.test.ts` — the list is exactly the two and both
  are in `AUTHORIZED_COHORT`; `REQUESTED_COHORT` is 12 and contains neither; one `claudeCLI` ladder row
  each; both unproven in the ladder view and in discovery output with no proof (a fake `claude` under
  `os.tmpdir()`), and excluded by `selectableModels`; every other ladder row equals its literal value
  at base 4b705c8.
- Extended, not loosened, as b3d6e10 did for Opus 5.5:
  `frontier-candidate-reconciliation.test.ts` and `opencode-free-pool.test.ts` add the new list's
  length to the `AUTHORIZED_COHORT` sum (the former also checks every entry is `claudeCLI`);
  `openai-api-identity-ladder.test.ts` adds the two ids to the literal `claudeCLI` ladder list in
  ladder order.
