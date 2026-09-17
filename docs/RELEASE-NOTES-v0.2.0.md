# Cernum v0.2.0 — Test. Discern. Decide.

**Model Lab is now Cernum.** This release renames the product, opens it to frontier models, and adopts
a second scoring policy generation that makes the evaluator measurably more accurate.

---

## Read this first if you are upgrading

**Your benchmark history is not lost.** Application data folders are named after the application, so
the rename moved them. The first launch of Cernum carries your campaigns, evidence store, settings and
log across from the old `Model Lab` folder and writes a `migrated-from.json` recording exactly what
moved.

The migration **never overwrites and never deletes**. If a file already exists on the new side, both
copies are left alone and the log says so. A cross-volume move copies before removing the source, so a
failure leaves the originals exactly where they have always been.

| | Before | After |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Model Lab/` | `~/Library/Application Support/Cernum/` |
| Windows | `%APPDATA%\Model Lab\` | `%APPDATA%\Cernum\` |

`CERNUM_USER_DATA`, `CERNUM_CAMPAIGN_ROOT` and `CERNUM_OLLAMA_ENDPOINT` are now the canonical
environment overrides. **The old `MODEL_LAB_*` names still work** — a rename must not break a script
you already wrote.

Two things deliberately did **not** change, because they are data rather than branding: the evidence
store's manifest string, and the sealed `suite.model-lab.*` suite identifiers. Renaming either would
rewrite the manifest of every evidence store already on disk and invalidate every stored result.

---

## Frontier models

The previous release said, in the README, that frontier models were *"not supported — there is no API
client, no key handling and no outbound internet path in this application."* **That stopped being true
some time ago, and this release corrects it.**

| Provider | Status | What that means |
| --- | --- | --- |
| Ollama (local) | ✅ Exercised | Unchanged. Configurable loopback endpoint, any port. |
| Claude subscription (`claude` CLI) | ✅ Exercised | Full scored campaigns have run through it. |
| Codex subscription (`codex` CLI) | ✅ Exercised | Full scored campaigns have run through it. |
| **OpenCode (`opencode` CLI)** | ⚠️ **Discovery only** | New. Cernum finds it, reads its version, lists its models and sees whether a credential is configured — **without spending anything**. No scored campaign has ever run through it. |
| Anthropic API / OpenAI API | ⚠️ Implemented, not exercised | Key handling and spending authorization are tested; no published campaign has used them. |

**Subscription support and metered API support are not the same claim, and Cernum will not blur them.**
A subscription request is reported as `subscriptionIncluded`: the marginal charge is zero because a plan
you already pay for covers it, while consuming a finite allowance. That is not "free", and Cernum never
prints the word. A Codex CLI signed in with an **API key** is refused rather than used, because the same
binary serves both and running a metered session under a subscription label would report a real
per-token charge as zero.

### OpenCode and Union Alpha

**Union Alpha** is available at OpenCode's own address, `opencode/union-alpha`, carried through
unchanged — OpenCode's `--model` flag takes `provider/model`, so this is its addressing, not a Cernum
convention laid over it.

**Availability is detected, never assumed.** Discovery asks three read-only subcommands and stops at
the first honest answer: not installed, no credential, unreachable, or ready with the models OpenCode
itself listed. A model Cernum planned for but OpenCode did not list is recorded as **refused** — not
quietly omitted.

OpenCode is classed as a **metered API**, because the credential it carries is an API key. Requests are
billed per token against your own key. **Cernum holds no pricing for OpenCode**, so the cost of an
OpenCode attempt is reported as `unavailable` — not zero, not free, not estimated.

### Muse

Muse is **not** a separate provider, CLI or adapter, and this release does not pretend otherwise. Muse
builds are **local models** served over the ordinary Ollama-compatible transport, historically on a
non-default port such as `11435`. What that needs is a configurable endpoint, which Cernum has and this
release verifies: any loopback address, any port, every spelling of loopback normalised to one lease so
two campaigns cannot both believe they hold the same runtime. A Muse model is listed when live
discovery finds it on the endpoint you configured, and not before.

A **remote** endpoint is still refused by design. A benchmark reaching across a network measures
something nobody can reproduce.

---

## Scoring policy generation 2

Two corrections had been built, gated and left unreachable. This release makes them selectable, as one
generation:

- the **hybrid governance matcher** (Pass 10 Gate D, adopted for this release), and
- the **narrowed capability repair** (REQ-03 Phase 5).

Measured by replaying all 608 eligible stored responses — **no provider request was made**:

| | Version 1 | Version 2 |
| --- | --- | --- |
| Evaluator false positives (350 adjudicated rows) | 201 | **33** |
| Evaluator false negatives | 4 | **4** |
| Candidates carrying ≥1 governance violation | 10 of 10 | **0 of 10** |

**Version 1 is preserved exactly.** It remains registered, selectable and canonical, and it reproduces
the stored status on **608 of 608** eligible rows. No stored row was modified. A campaign binds its
generation, the whole catalog's digest and a digest per case, and refuses to score anything if a bound
version or digest is unavailable or has moved.

**Adopting generation 2 moves candidates relative to one another**, substantially — the top-ranked
candidate under version 1 finishes eighth under version 2. A companion restatement of the stored
results is published alongside the version-1 artifacts, which are untouched. **No candidate is routed,
promoted or recommended on it.**

One interaction is worth knowing: the hybrid matcher refers one governed rule to a human judge, so 14
rows the capability repair alone would have passed are **withheld** as `requiresHumanReview` instead.
Withheld is not wrong, but it is not scored either, and those rows are excluded from every rate rather
than counted either way.

---

## Also in this release

- **REQ-03 closed.** The capability evaluator was validated over 466 human decisions. It closed with
  every limitation retained and published rather than retired — including 12 residual false positives
  in two deliberately unrepaired cases, a sampled phase whose interval reaches 8.26%, and two
  requirement statements the adjudicator's standard outran.
- **The parity corpus was rebaselined once, by explicit approval, and only by addition.** All 42
  Swift-derived policies keep their canonical form, digest and order, and the sub-catalog they form
  still seals to `mlspc1:42c16e06a941b143` — the regeneration script refuses to run if it does not. The
  40 generation-2 twins are pinned separately and carry **no cross-implementation claim**. See
  [PARITY.md](PARITY.md).
- **A flaky test was fixed rather than tolerated.** One boundary test counted entries in the shared
  system temp directory and failed on roughly half of full-suite runs. It now uses a directory it owns,
  which makes it both deterministic and stronger.
- **Corrected a claim on the Home screen** that stopped being true when frontier providers arrived.

## Known limitations

Unchanged from v0.1.0 unless noted: builds are unsigned and not notarized; Linux is not packaged; you
cannot author your own suites; two capabilities are human-judged with no screen for recording the
judgment; and the suites lean towards assistant-style behaviour rather than general coding or
mathematics.

New, and stated plainly:

- **Frontier support is uneven** — see the table above. Two providers are exercised, three are not.
- **A frontier candidate's latency and throughput are not reproducible.** They measure a network and
  somebody else's fleet on the day you asked. Cernum records them and labels the execution class on
  every row so local and frontier numbers are never averaged together by accident.
- **Screenshots are regenerated from the running application** by `npm run screenshots`, which drives
  the built app against a scripted loopback runtime. They show a real benchmark in which one model
  fails three different ways, because a screenshot where everything passes is the least useful one
  available.
