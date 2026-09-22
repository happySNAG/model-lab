# Cernum v1.0.0 — what may be routed to, and who says so

**The release that makes routing a decision with a version on it, gives the fleet somewhere to put
what each machine observed, and qualifies a frontier model per capability rather than per score.**

This is the first release to consolidate the two development lines — the Mac mini benchmark line and
the MacBook workspace line — into one canonical V1, and the first to run live frontier qualification
through the sealed workspace engine as part of the release itself.

There is no universal score anywhere in this release, and no winner. There are candidate sets, with
every exclusion and its reason beside it.

---

## Why 1.0.0

`v0.2.4` was already a cut tag, and `package.json` had carried `0.2.4` since 17 September while
`package-lock.json` still said `0.2.3` — the missing half of that bump, six days stale. This release
resolves it deliberately: both files move **0.2.3/0.2.4 → 1.0.0** as an intentional release-version
change, rather than the lockfile quietly catching up to a version somebody else had already
published.

---

## Routing policy is a value with a version, and both versions ship

Pass 6 and Pass 7 approved the identity exception on a written condition: a candidate admitted under
`requestAcceptedIdentityUnverifiable` is measured in full and is **never** a routing target. Pass 8
decided the opposite, under conditions. The naive way to ship that is to edit `isRoutable` — which
would retroactively change what every sealed record and signed approval said was guaranteed.

So the policy became a value instead.

| Version | Rule | Status |
| --- | --- | --- |
| `crp1` | An identity-admitted route is never a routing target, whatever else is established about it | The Pass 6/7 policy, preserved **verbatim** and still evaluable |
| `crp2` | Such a route **may** be an Ordra candidate, and only when all nine conditions hold | Current; supersedes `crp1` **prospectively** |

`crp2`'s nine conditions: the route is currently discovered; available on the requested machine;
that discovery is fresh; its qualification evidence is fresh; it has sufficient capability evidence
for the task asked about; its identity admission is current; the spend posture permits execution; no
provider or session state blocks it; and the task did not ask for verified identity.

`isRoutable` is **unchanged**, because sealed manifests cite it by name as the thing that keeps the
Pass 6/7 promise. `crp1RefusesAdmittedState` proves the old rule still refuses what it always
refused by calling that same function rather than a second copy that could drift.

Supersession is not erasure. `--policy crp1` re-answers today under the rule that was in force then,
which is what reading a historical decision honestly requires. Verified against real evidence:

```
crp2                            5 candidates  (3 Claude verified + 2 Codex admitted)
crp1                            3 candidates  (Codex excluded — the Pass 6/7 rule)
crp2 --require-verified-identity 3 candidates  (Codex excluded per query, with reason)
```

**Identity disclosure remains mandatory.** A route routable under `crp2` still reports its identity
as unverifiable on every candidate, exclusion and surface, and carries a disclosure stating the
permission and its limit in one breath. Being routed does not verify a route and never makes it
citable as "this model did the work".

---

## Zero-cost authorization is not zero-cost evidence

The owner's permission to benchmark free OpenCode routes is recorded verbatim — and it proves
nothing. A permission is not a finding. Refused by name as evidence: the authorization itself, a
published $0 catalogue price however current, a free-tier announcement, a model's own reply about
what it costs, and an inference request sent to prove the route is free (which spends the thing it
is trying to measure).

A confirmation must bind to the exact route and name the account's own billing record that was read,
by whom and when. It expires by calendar at thirty days, and **immediately** by observation when a
discovery delta sees that route's price or free status move — the second is the one that matters,
because the day a free tier starts charging is not the day anybody re-reads a billing page.

---

## The fleet: an append-only, content-addressed observation store

A record is named by the digest of its own content, so the same observation is one file however many
times it arrives. A file whose bytes no longer digest to its own name is reported by path and is not
read. Bundles travel as one sealed JSON value — no daemon, no protocol, no hard-coded host or path.

**An imported observation never becomes a local one.** Every record carries the `cmk1:` key of the
machine that observed it, and that key survives transport unchanged. A machine can know that
*another* machine saw a route available; it cannot, on that basis, report the route available here.
Local qualification stays bound to machine + weights digest + runtime identity and does not transfer.

Two digests, because they answer two different questions:

- **`contentDigest`** — over the records alone, sorted by their own identity. Stable across exports,
  machines and time. This is what comparability means, and it is what two machines compare.
- **`bundleDigest`** — over everything including who exported and when. Integrity has to move when
  anything moves.

`contentDigest` is recomputed from the records on read and never believed from the file, so a bundle
doctored to claim it holds what another machine holds does not need to be caught — the forged value
simply never takes effect.

Proven operationally in this release: export, verify, import, idempotent re-import (0 written, 220
already held, origins preserved), whole-bundle refusal of a tampered file, and machine-scoped
availability.

---

## Live qualification

### Claude Opus 5.5 — discovered, not assumed

The `claude` CLI has no model-listing command, so "which models may this account call" has no
enumerable answer on that provider — which is exactly the gap a person fills by typing a plausible
identifier out of a release announcement. It was asked instead: the CLI resolves the bare alias
`opus` to the latest Opus, and `--output-format json` reports, in its own metadata rather than in any
model's prose, the identifier that served the request. That named **`claude-opus-5-5`**, context
window 1,000,000. An identity smoke test then returned **verified**.

**`pack.cernum.workspace.discriminator-one@1`, 3 repeats, 18 independent runs.**

| Model | Score | `asset-container.retitle` | Median tokens | Median wall | Allowance |
| --- | --- | --- | --- | --- | --- |
| Fable 5.1 | **18/18** | 3/3 | 92,399 | 67.3s | $11.06 |
| Opus 5 | 16/18 | 1/3 `[P F F]` | 58,239 | 34.3s | $3.65 |
| **Opus 5.5** | **15/18** | 0/3 `[F F F]` | 57,478 | 33.8s | **$2.92** |
| Sonnet 5 | 14/18 | 2/3 `[P F P]` | 289,315 | 68.5s | $3.22 |
| Haiku 4.5 | 9/18 | 0/3 | 299,385 | 74.2s | $1.82 |

Opus 5.5 ran with identity verified on all 18, 0 retries, 0 regressions, 0 scope violations and
nothing throttled. It is 3/3 on five of six cases — identical to Opus 5 — and the entire difference
between 16 and 15 is one run on the case that isolates preserve-unknown reasoning, where Opus 5's
own result was one lucky pass away from the same. **On 18 runs that is not a regression**, and it is
not reported as one.

What it buys: the same capability profile as Opus 5 at roughly 20% less plan allowance, the same
wall time, and a slightly better time-to-first-token.

**Qualified capability families** are decided per capability, by the rule that no case may have
never passed — a 15/18 aggregate does not buy qualification in a family where one case failed every
time:

| Capability | Opus 5.5 |
| --- | --- |
| `multiFileEditing` | qualified, 6/6 |
| `repositoryComprehension` | qualified, 6/6 |
| `regressionAvoidance` | qualified, 3/3 |
| `preservationUnderTransformation` | not qualified — 1 case never passed |
| `forwardCompatibilityReasoning` | not qualified — 1 case never passed |
| `destructiveFallbackAvoidance` | not qualified — 1 case never passed |
| `contractOverVisibleTests` | not qualified — 1 case never passed |
| `failureInterpretation` | not qualified — 1 case never passed |
| `scopeDiscipline` | no evidence — not exercised by this pack |

### A genuinely new OpenAI route, and what it is not

Discovery found **`gpt-6-luna`** and **`gpt-6-sol`** advertised to this account, published
2026-09-14 — distinct models, not aliases or renames of `gpt-5.6-luna`/`gpt-5.6-sol` (2026-06-23) or
of `gpt-6-astra` (2026-08-27).

They are advertised on the **metered OpenAI API only** and are absent from the Codex CLI catalogue,
so they are not subscription-included. Qualifying them would mean real per-token spend against a
personal credential, which was not authorized in this pass. **They are recorded as discovered and
unqualified, and they are not routing candidates.**

### Route changes

`opencode/union-alpha` is no longer listed by OpenCode and is recorded as removed. One route moved
nothing that describes it. No billing, context or runtime-digest changes.

---

## Ordra candidate sets, by capability

Cost never overrides capability. Routes are grouped with zero-marginal-cost first (local,
`free_confirmed`, `subscriptionIncluded`); metered routes are available only under explicit spend
authorization. Among routes that satisfy the requirements, **choosing is a scheduling decision this
engine does not make.**

| Capability family | Qualified candidates |
| --- | --- |
| `multiFileEditing` | fable-5-1, opus-5, opus-5-5, sonnet-5, gpt-5.6-sol, gpt-6-astra |
| `repositoryComprehension` | opus-5, opus-5-5, gpt-5.6-sol, gpt-6-astra |
| `regressionAvoidance` | opus-5, opus-5-5, gpt-5.6-sol, gpt-6-astra |
| `interactingInvariantReasoning` | fable-5-1, haiku-4-5, opus-5, opus-5-5, sonnet-5, gpt-5.6-sol, gpt-6-astra |
| `preservationUnderTransformation` | fable-5-1, gpt-5.6-sol |
| `forwardCompatibilityReasoning` | fable-5-1, gpt-5.6-sol |
| `destructiveFallbackAvoidance` | fable-5-1, gpt-5.6-sol |
| `contractOverVisibleTests` | fable-5-1, gpt-5.6-sol |
| `failureInterpretation` | opus-5, gpt-5.6-sol, gpt-6-astra |
| `testExecution` | fable-5-1, haiku-4-5, opus-5, sonnet-5, gpt-5.6-sol, gpt-6-astra |
| `scopeDiscipline` | fable-5-1, haiku-4-5, opus-5, sonnet-5, gpt-5.6-sol, gpt-6-astra |
| `patchCleanliness` | fable-5-1, haiku-4-5, opus-5, sonnet-5 |
| `autonomousCompletion` | fable-5-1, haiku-4-5, opus-5, sonnet-5 |
| `toolUse` | opus-5, gpt-5.6-sol, gpt-6-astra |
| `fileLocation` | fable-5-1, opus-5, sonnet-5, gpt-5.6-sol, gpt-6-astra |
| `recoveryFromError` | **none** — needs an observed failure to recover from |
| `verificationDrivenRecovery` | **none** — same |
| `secondAttemptAdaptation` | **none** — same |

The three empty families are an honest absence rather than a finding: every run in this cohort
either passed or failed outright, so no second attempt was ever observed and there is nothing to
qualify on.

Codex routes appear above as **admitted, not verified**, and are excluded by `--policy crp1` or by
`--require-verified-identity`.

---

## Fixed in this release

**An export was never deterministic, and the documentation said it was.** `exportObservations`
promised the same set exported twice produces the same bytes and digest, so two machines could tell
whether they held the same thing. `exportedAt` is a wall clock and it sat inside the only digest
there was, so that was false for every bundle this engine had ever written. It survived its test
because the test exported twice passing the *same fixed* timestamp — holding still the one variable
that always moves. Fixed by separating comparability from integrity; the new test exports at two
instants from two machines and asserts content digests agree while bundle digests do not.

**A candidate query could not see the evidence.** `candidates` read benchmark rows from one campaign
root, and a route's evidence is spread across the matrices that produced it — Sonnet's lives in four
directories. The Ordra-facing query therefore answered "no benchmark evidence exists" for routes
measured over weeks, which reads like a policy decision rather than a reader pointed at the wrong
directory. `--evidence-roots` names the roots to read, where they already are; nothing is copied or
moved. Rows de-duplicate by the sealed row's own content rather than by path, because a
double-counted run would buy a route a qualification it did not earn.

**A caveat was printed where it was not true.** `observations` and `availability` printed "This was
observed on ANOTHER machine and imported here" unconditionally — including after 220 rows marked
"observed here". The sentence's own contract says it belongs beside an imported row. It now is.

---

## Known limitations

- **OpenCode live qualification is pending account confirmation.** No OpenCode subcommand reports
  what the configured credential is billed: `opencode models` is the cached catalogue, and
  `opencode auth list` reports only that a credential is stored. Establishing zero marginal cost
  requires a person reading the account's own billing record. Six free routes are discovered and
  none is authorized. **A route does not become routable by costing $0.**
- **Ollama local qualification did not run.** The external volume holding the model weights was not
  mounted during this pass. Discovery reported the runtime as unanswered and, correctly, carried its
  routes forward rather than reading "the probe failed" as "the models are gone" — so no Ollama
  qualification was staled by the absence.
- **Six sealed-evidence gate suites could not execute** for the same reason, their pinned evidence
  living on that volume. They fail closed, by design, rather than passing quietly.
- **`gpt-6-luna` and `gpt-6-sol` are discovered and unqualified** — metered-only, and no spend was
  authorized.
- **Recovery capability families have no qualified routes** on current evidence.
- **Mac mini routes are not claimed as available.** No current imported observation establishes
  them; the export/import mechanism is proven, the remote machine's observations are not yet here.
- The Claude CLI exposes no remaining-allowance figure, so how much session allowance is left is not
  known before a matrix starts. The live circuit breaker bounds the waste instead.
- Identity on `codexCLI` and `opencodeCLI` remains unverifiable by construction; on OpenCode a
  substitution would be undetectable.

---

## Execution sandbox

Every command run against model-modified code executes under macOS Seatbelt, from a sealed command
list. No sandbox, no run. A workspace attempt runs in a fresh copy of the fixture under an
allow-listed environment: nothing is inherited unless the frozen case named it. What a verdict rests
on is the final tree and the verification commands — both observed by this engine — never the tool's
own account of its behaviour.
