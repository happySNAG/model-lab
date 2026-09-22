# The benchmark engine

A **benchmark** in this application is a single sitting: pick some models, pick some suites, watch it
run, read the results. That is the Benchmark screen, and for most comparisons it is the right tool.

A **campaign** is the same measurement made durable. It freezes exactly what will be run before
anything runs, records each attempt to disk the moment it lands, survives an interruption, and can be
resumed hours or days later without losing or repeating a single attempt. Campaigns exist because a
comparison worth trusting is usually too long to finish in one sitting, and because a result you
cannot audit a fortnight later is not really a result.

Campaigns are drivable from two places — the **Campaigns** screen and the **`cernum`** terminal
command — and both go through one engine (`src/engine`), so they cannot disagree about what a
campaign is.

Where each concept lives, and how prose campaigns, the development runner and workspace benchmarks
fit one lifecycle, is mapped in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Canonical, or observe-only

Cernum is an **active** benchmark controller. For a canonical campaign it manages model residency on
the one benchmark endpoint it was pointed at: before each candidate after the first, it asks that
endpoint to release the previous candidate's weights and **proves the release happened** before
continuing. That is what makes two candidates comparable. Without it the second model's latency
measures the disk rather than the model, and nothing in the evidence would say so.

That authority is **disclosed before the run starts, once** — on the Campaigns screen when you press
Start, and printed by `cernum create` — and never asked again between attempts. It is bounded:

- it applies to the **one endpoint the campaign froze**, and to nothing else on the machine;
- the only action taken is a request carrying `keep_alive: 0` for a model Cernum is itself
  benchmarking;
- no model is pulled, created or deleted, and no process is signalled.

A **residency release that fails is an abort**, never a warning. A campaign that cannot prove the
weights left stops and blocks its remaining slots, because a warning attached to a number nobody can
distinguish from a good one is worse than no number.

### Observe-only

If you would rather a benchmark tool touched nothing on your machine, say so by name:
`cernum create … --observe-only`, or clear the canonical checkbox in the New campaign dialog. Cernum
then leaves residency alone entirely.

What it cannot be is quietly mixed in with canonical results. An observe-only run is labelled
**noncanonical and noncomparable** in the manifest, in every ledger row, in the rankings, in the
counting rules, in the retention interpretation, in both interfaces and in the final report — and,
because the execution policy is bound into the manifest digest, **an observe-only campaign is not
even the same manifest as its canonical twin**. Two results that cannot be compared cannot present
themselves under one seal, so joining them is not something a reader has to remember not to do.

| | canonical | observe-only |
|---|---|---|
| residency between candidates | managed and proved | untouched |
| quality outcomes | comparable | comparable |
| latency, throughput, time-to-first-token | comparable | **not comparable**, within the run or outside it |
| manifest seal | the usual six digests | the same, plus `· OBSERVE-ONLY` |

**The mode is frozen at creation and cannot change afterwards.** `cernum run --observe-only` on a
canonical campaign is refused rather than obeyed, and editing `configuration.json` produces a
manifest drift that refuses the resume. A campaign that was canonical for its first half and
observe-only for its second is neither.

---

## Thinking mode

Thinking mode is frozen with the campaign, chosen explicitly, and shown wherever the campaign is:

```
cernum create my-run --models qwen3:4b --thinking on
```

or the **Ask the models to think first** checkbox in the New campaign dialog.

If the runtime reports that a chosen model **cannot** think, the campaign is refused at create —
and, if a runtime changes its mind later, the run stops at preflight. It is never silently
substituted, because answers produced with thinking off under a manifest that says it was on are
real answers to a different experiment. A runtime that reports **no** capability list at all is
`unverifiable`, not `unsupported`: "it did not tell us" and "it told us it cannot" are different
facts, and only the second is grounds to refuse.

---

## Who answers: local, subscription, or metered API

Until this pass a candidate was always a model on this machine, served by a runtime Cernum managed.
That is still the default and still the most trustworthy arrangement — but a campaign can now also
contain a model somebody else runs.

There are **three execution classes**, and they are not interchangeable:

| | reached by | monetary cost | prompts leave this machine | residency |
|---|---|---|---|---|
| **local** | an Ollama endpoint Cernum manages | none | no | managed and proved |
| **subscription** | your own installed, signed-in `claude` / `codex`, as a child process | **subscription-included**: marginal API charge $0, consuming a finite allowance | yes | not applicable |
| **metered API** | a published HTTP API, billed per token against your key | billed per token | yes | not applicable |

**Subscription execution is not free.** Its marginal API charge is zero because you already pay for
the subscription, and it consumes an allowance a dollar figure cannot express. Cernum records it as
`subscriptionIncluded` and never as free, in every artefact and both interfaces, because describing
it as free is the easiest way for a benchmark to mislead somebody about what a model costs them.

### What is compared, and what is not

Task outcomes **are** comparable across all three: every candidate answered the same frozen prompts
and was judged by the same frozen evaluators, by a scorer that cannot see who produced the text.

Latency, throughput, time-to-first-token and cost are **not**. A local model has no network; a
subscription CLI pays a process launch; an API sits behind somebody else's queue. A ranking that
ordered these by speed or by price would be ordering their access methods. A campaign containing more
than one class is labelled `MIXED-EXECUTION` in its manifest seal, its report, its rankings table and
both interfaces.

### Nothing is scraped, impersonated, or worked around

- A subscription is reached by running **the official CLI you installed and signed into yourself**,
  with its documented flags and its documented output. Cernum never reads its token file, its
  configuration directory or its Keychain entry; never reuses a browser session; never calls a private
  endpoint; and never tries to make a subscription behave like an API.
- A metered API is reached at its **published endpoint** with a key **you** supplied.
- The environment handed to a subscription CLI has every credential-bearing variable **stripped out**,
  including your API keys — so a run you authorised as subscription-included cannot quietly bill your
  card instead.

### A model name is a plan, not a capability

There is a list of models this project intends to test. Every one of them starts **`unproven`**, and
nothing but an **identity smoke test** moves it to `proven`. A smoke test proves two separate things
and keeps them separate: that the request could be EXECUTED at all, and — only if the reply names a
model — WHO answered it. A request that succeeds and names nobody is `unverifiable`, never `proven`.

**No listing moves a model to `proven`, and that includes an account-scoped one.** A listing can
establish that an identifier was advertised or visible to this account; it cannot establish that the
model answered a request, because no request was made. `opencode models` is read from a cached file
describing thousands of models OpenCode has never called; an OpenAI `/v1/models` answered with your
own key is better evidence and still not execution, since an advertised identifier can be refused at
call time and a catalogue entry is not a reply. So every listed model is recorded as **discovered and
unproven**, with an empty `verifiedModelID`, and none is selectable. v0.2.1 marked the OpenCode
catalogue `proven`; v0.2.4 marked an OpenAI listing `proven` on the account-scoped exception this
paragraph used to carry, promoting 130 models — embeddings, moderation and audio endpoints among them
— on a live account. This is the correction to both. The
shared
campaign builder refuses an unproven model outright — in the terminal and in the interface, from the
same function — so editing that list can never make a model runnable.

Discovery is always something you ask for by name. Reading the Providers screen, checking status, or
opening the application performs an executable lookup and a credential check and **contacts nobody**;
every row says so, and `test/e2e/providers-offline.spec.ts` asserts it by launching the application
with fake CLIs that log every invocation and a loopback recorder that logs every request, then
checking both logs are empty.

**Where a CLI is looked for.** `PATH` first, and `PATH` wins — a build you deliberately put ahead of
another is the one that runs. When `PATH` has nothing, the search widens to the directories CLI
installers write to: `~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`. This is not a convenience. An application launched from
Finder, the Dock or `open` inherits `launchd`'s `PATH` and reads no shell profile, so until v0.2.1
Cernum reported CLIs you had installed and authenticated as `notInstalled` — a status view reporting
on how it was launched while appearing to report on your machine. Widening where Cernum looks changes
nothing about what it does: it drives only a CLI you installed yourself, never installs one, never
reads its stored session, and prints the absolute path it found on every surface.

### Who actually answered

A local model is identified by its **weights digest**, before the request. A frontier model can only
be identified by what the provider says **afterwards**, so every frontier response is read for which
model produced it:

- the provider named the frozen model, or resolved its alias to a dated build → **verified**, and the
  exact build is what gets recorded;
- the provider named a **different** model → **substituted**. The candidate aborts. Nothing is scored,
  because a real answer to a question about a different model is not this campaign's evidence;
- the provider named nothing → **unverifiable**, carried and labelled on every row, never upgraded to
  verified by assuming the request was honoured.

---

## Money, and the authorization that has to exist first

**Not one metered request leaves this machine unless an authorization record for that campaign already
exists on disk.** It is written before the run and read back by it, so it survives a resume, a crash
and a change of surface. It names:

provider · model · planned attempts · estimated input and output tokens · estimated minimum and
maximum cost · the pricing timestamp · a hard spending ceiling.

**An estimate that cannot be calculated is a refusal, not a guess.** If prices are missing or the
prompt sizes are unknown, Cernum declines the paid run and says which input was absent. The bracket it
does produce is a real one: the **maximum** assumes every attempt fills its entire frozen input and
output budget, which the adapter enforces; the **minimum** assumes every attempt pays for its input
and produces nothing. The one inexact number — the input-token estimate — carries its own method, and
the characters-per-token divisor is written into the record where you can disagree with it.

**Cernum never fetches prices.** An estimate that changed between the preview and the run is not one
anybody can approve, so prices are supplied with their source and the moment they were captured, and
both are frozen into the manifest where a later reader can see how stale they are.

The **hard ceiling stops the request that would exceed it**, rather than noticing afterwards that one
did. Attempts already recorded are kept; the remaining slots are blocked and carry no result, exactly
as for a guard breach. The running total is rebuilt from the ledger on every resume, so a ceiling
cannot be reset by pressing Resume.

```
cernum cost <name>                                  what it is estimated to cost, without running it
cernum authorize <name> --ceiling 5.00 --yes        record the authorization
```

---

## Credentials

Two sources, and Cernum owns neither: an **environment variable**, or the **macOS Keychain**. There
is no Cernum-owned credential store — a product that stores the key has to get its permissions, its
backups, its sync behaviour and its deletion right, and every one of those is a way to leak it that
simply does not exist if the key is never stored.

A key that is read is registered with the **secret scrubber** immediately, and every ledger row and
every event passes through that scrubber on its way to disk — including `answerText` and every
`detail` string, whoever authored them. The scrubber recognises credential *shapes*, not just values
it was told about, so it catches a key echoed back by a provider inside a 401 that this process never
held. It is applied at the ledger's single write path rather than at each call site, because a call
site is a thing somebody can forget.

A key is never shown at any length. The interface and the terminal show `set · N characters` or
`not set` — never a prefix, never a suffix, never a fragment.

A **missing credential is a clean refusal before the socket opens**: discovering it from a 401 would
cost a round trip, write a failure into the evidence that is not the model's, and on some providers
count against a rate limit.

`.env.example` carries variable **names only** and is the only such file in the repository.

---

## Why a frozen manifest

A benchmark result is a claim about a specific set of prompts, scored by a specific set of rules, on
specific hardware, against specific models. Every one of those can drift between the day a run is
started and the day it finishes, and **none of the drifts announce themselves**. A model gets
re-pulled at a different quantization; a case is edited; an evaluator is improved; the machine is
replaced. The numbers still look like numbers.

Creating a campaign freezes:

| Bound | What a change to it would mean |
|---|---|
| every prompt and its supplied context | the models are no longer being asked the same question |
| the catalogue digest | scoring modes, budgets or fixtures are not the ones that were authorised |
| the scored core | a case, its digest, its comparability key, its scoring mode or its output budget moved |
| every evaluator | the same answer would now be judged by different rules |
| the candidates **and their order** | order is bound because thermal state is not reset between models |
| the safety floors | the run would proceed under different limits than the ones authorised |
| the hardware and runtime version | latency and throughput are not comparable across either |
| the execution policy — residency mode and thinking mode | the run would not be the experiment that was authorised, and a canonical result and an observe-only one are not comparable |
| the **operational envelope** — per candidate: provider, execution class, requested model, verified identity, effort, thinking mode, sampling, input and output budgets, timeout, retry policy, billing basis, pricing snapshot, authorization mode | a campaign whose second half was answered by a different model, at a different effort, or on a different bill is not the campaign that was authorised |

Every resume re-verifies all of it and **refuses to continue** if anything moved. Verification never
repairs a drift: a manifest that silently updates itself proves nothing.

### The manifest version decision: format 4

**A new campaign freezes at format 4.** Format 4 adds one binding to the hashed body — the
operational-envelope digest — and carries the envelope itself alongside.

*Why a format bump and not an extra field.* The same prompts, scored the same way, answered by the
same named model, produce different results depending on whether that model was reached on this
machine, through a subscription CLI, or through a metered API. Their latencies are not the same
measurement, their costs are not the same currency, and their identities are established by different
evidence. Binding the envelope into the digest makes a local run and an API run of "the same" model
**two manifests rather than one** — for exactly the reason an observe-only run and a canonical one
became two in format 3. It is stronger than a label somebody has to remember to read.

*Why the scored core stays separate.* `scoredCoreDigest` still binds only the prompts, the scoring
modes and the output budgets — the things that must be identical for two results to be comparable at
all. The envelope binds the things that make them different. Keeping the two apart is what lets a
reader say "the same benchmark, three ways" instead of choosing between pretending they are identical
and refusing to put them on one page.

*Why a local-only campaign gets one too.* Its envelope says `provider: ollama`, `executionClass:
localRuntime`, `billingBasis: local`. "This ran locally" becomes an assertion somebody made rather
than the absence of a claim.

*What happens to format 3.* **Nothing.** A format-3 manifest is read, verified, finalized and resumed
exactly as it always was; its stored identity is untouched; and its verification never recomputes a
binding it never froze — a live envelope offered to a format-3 manifest is not compared, because
there is nothing frozen to have moved. `freezeManifest` still produces a **byte-identical** format-3
manifest when no envelope is supplied, which is what keeps the recorded parity vectors valid and what
`test/engine/manifest-format-4.test.ts` pins against a digest **recorded from the Pass 3 engine
itself**, at commit `162d14d4`, rather than recomputed from today's code.

A retest carries the **original's** format version and envelope rather than being reissued at today's:
a retest is the same benchmark on a different machine, and re-freezing it at a newer format would
change what its identity binds.

### When the machine changes

Hardware drift is reported separately, because it is the one drift that is expected rather than
alarming. `cernum retest <name> <new-name>` derives a manifest for the new machine that carries the
benchmark across byte-identically and back-references the original. Two results under a retest pair
are comparable on **quality** and explicitly not on **latency**.

---

## Why a ledger rather than a log

A long local campaign will be interrupted — a lid close, a kernel panic, a full disk, Ctrl-C. The
question is never "will it stop" but "what is true afterwards".

- The **plan** is written once, atomically, before any inference. It never changes, so the
  denominator cannot move under a rate.
- A terminal result is appended to `results.jsonl` and **fsynced before the runner moves on**.
- A slot that already has a terminal result is **never** attempted again, on any resume.
- `checkpoint.json` is rewritten after every attempt. It is a fast index, **never the source of
  truth** — `results.jsonl` is.

Using the log as truth and the checkpoint as a cache means a disagreement between them is
*detectable*. Opening a ledger rebuilds it from the log and **reports** the drift rather than
silently correcting it, truncates a torn final line so that attempt is re-run rather than guessed at,
and refuses outright to guess when a corrupt line is not the last one.

Reconciliation is the one arithmetic that has to hold: `terminal + blocked + unaccounted = planned`,
with no slot in two of those at once. If it does not hold, every rate derived from the ledger is
marked **provisional** — an unreconciled ledger is not a result.

---

## What stops a campaign

These are **abort conditions, not warnings**, and each returns a measurement alongside its verdict so
a report can say `free 12.41 GiB, floor 15.00 GiB` rather than `disk guard failed`.

| Guard | Why it stops rather than warns |
|---|---|
| free disk space | a full disk corrupts the ledger it is trying to write |
| swap used | swap means the next model's latency measures the disk, not the model |
| free memory | the same |
| the benchmark lane | work reaching a server other than the authorised one is not the measurement |
| the model store | a model added, removed or re-pulled mid-campaign changes what is being measured |
| **residency release** | see below |
| **spending authorization** | a metered request nobody authorised is money nobody agreed to spend |
| **the hard spending ceiling** | it stops the request that *would* exceed it, not the one that did |
| **provider model substitution** | a real answer to a question about a different model is not this campaign's evidence |

The last three are new with frontier support, and the first two of them refuse **before anything is
sent**: the cheapest refusal is the one that happens before the request leaves.

A campaign with no local candidates drops the **benchmark lane** and **model store** guards, because
neither describes anything it touches — there is no local lane to hold and no local store to drift.
Everything that is a property of *this machine* still applies: a benchmark that fills the disk or
drives the box into swap still stops, whoever is answering its prompts.

**Residency** is the subtle one. Two models resident at once means swap, and swap means the next
candidate's latency measures the disk. Worse, it is *invisible in the result* — every attempt still
returns text. A residual model does not corrupt a score, it corrupts the **comparison**, which is the
only thing a benchmark produces. So at every model transition the engine issues an unload, waits, and
then **reads the resident set back**. An unload that reports success and leaves a model resident is
precisely the failure this exists to catch, so its own success message is not evidence.

**Residency applies to local candidates only.** A frontier candidate has no weights on this machine,
so there is nothing to unload and — the part worth being explicit about — nothing an unload could
*prove*. The transition is recorded as `residencyNotApplicable` rather than silently skipped, because
"we did not need to" and "we did not bother" look identical in an empty event log. In a mixed
campaign the local candidates' residency proofs are unaffected by the frontier ones, and vice versa.

**A frontier candidate takes no Ollama endpoint lease**, and a campaign with no local candidates takes
none at all — so it runs happily alongside a local campaign that owns the endpoint. That is structural
rather than a flag: the lease is taken against the host's runtime identity, and a frontier-only host
offers none.

When a guard trips, the remaining slots are **blocked**: they were never attempted and carry no
result. Resolve what stopped it, resume, and they run normally. The abort record is kept, never
deleted.

---

## Two verifications that are not scoring

A failure in either of these is a **measurement fault**, not a model failure. Conflating them is how
a benchmark quietly reports the harness's own bug as the candidate's.

**Supplied context.** Cases that supply material to read carry that material as its own message, so
it can be read back out of the assembled request and compared to what the manifest froze. The engine
distinguishes `intact`, `absent`, `truncated` and `mutated`, because the causes and the fixes differ:
a truncated context is a budget problem, a mutated one is a transport problem, and an absent one
means the model was asked a retrieval question without the material — so any answer measures guessing.

**Model identity.** What the runtime reports for the loaded model is compared to what the manifest
pinned. A **mismatch** stops the campaign. A field the runtime declines to report is recorded as
*unreported*, never as a match — "the runtime did not tell us" and "the runtime told us it is the
same" are different facts. An identity that cannot be confirmed is carried as `unverifiable` and said
so plainly, rather than being quietly counted as verified.

---

## Telemetry, and what "unavailable" means

Five measurements are recorded per attempt and never conflated: cold load, warm response, time to
first **visible** token, total client latency, and throughput. Thinking-capable models spend budget
before their answer begins, so the two channels are kept apart — which is how an answer that looks
mysteriously empty gets the explanation it deserves:

> the model spent 900 of its 1024-token budget thinking and never began its visible answer; this is
> a budget setting, not a capability failure

**Arrival times are observed, never reconstructed.** The engine streams `/api/chat` and reads its own
clock as each line lands. It does not compute a first-token time from `load_duration +
prompt_eval_duration`: those say how long the runtime spent, not when anything reached the client,
and the difference is queueing, transport and scheduling — precisely the delay a person waiting for
an answer experiences. An attempt that was not watched records **no** first-token time rather than a
plausible one.

**An unmeasured value is never silently replaced by a guess.** Where a runtime does not expose
something, the value is recorded as unavailable *with a reason*, a missing token count never becomes
a throughput of zero, and **no token count is ever estimated from text length**. A
characters-per-token ratio is a property of a tokenizer; it differs per model and per script, and a
number derived from one is indistinguishable from a measured one once it is in the evidence.

That last rule decides how the token counts are reported, because Ollama publishes one combined
completion count in its final chunk and no per-channel split:

| What the stream carried | `visibleTokenCount` | `thinkingTokenCount` |
|---|---|---|
| visible output only | the runtime's completion count | `0` — observed, not assumed |
| reasoning only (budget exhausted) | `0` | the runtime's completion count |
| both channels | **unavailable, with the reason** | **unavailable, with the reason** |
| nothing was watched | unavailable — the adapter did not stream | same |

`completionTokenCount` always carries the runtime's own combined figure, and throughput is derived
from that and the runtime's own generation duration — never from the client clock, never from an
estimate.

### Four states, once a provider is involved

Two states were exactly right for a local runtime: either it counted something or it did not. A
frontier campaign needs four, because "we watched it" and "they told us" are different facts, and a
cost computed from the second cannot be reconciled against a bill in the same way as one computed from
the first:

| provenance | means |
|---|---|
| `measured` | this process watched it happen — a wall clock, a byte arrival time |
| `providerReported` | the provider told us — its own usage block |
| `estimated` | nobody counted it; it was derived by a **stated** method from something that was |
| `unavailable` | not known, and the reason is recorded rather than a zero being written |

They are never silently promoted, an aggregate carries the **worst** provenance of its inputs, and a
sum containing an `unavailable` term is itself `unavailable` — not the sum of the terms that happened
to be known. Every table prints the provenance rather than hiding it, and the provider's own usage
block is kept **verbatim** beside the figures derived from it, because a derived number with its
source discarded is a number nobody can check.

### Recorded per attempt, aggregated per model

input tokens · visible output tokens · reasoning tokens (when reported apart) · total tokens · tokens
per second · time to first **visible** token · total wall-clock time · cost per run · cost per
successful task · tokens per completed pass · tokens wasted on failed and retried attempts · retry
count · timeout count · successful-task rate · provider-reported versus estimated usage ·
measurement quality.

Three of those deserve their reasoning written down:

- **Cost per successful task** divides the campaign's **total** spend — failures and retries included
  — by the number of successes. Money spent on a failed attempt is money spent, and a model that
  fails half the time costs *more* per useful answer, not the same.
- **A model with no successes has no cost per success.** Not infinity, not zero, not the total: it is
  `unavailable` with a reason, because every other answer invites an arithmetic somebody will mistake
  for a comparison.
- **Wasted tokens** are tracked separately rather than folded into the total, so a campaign that
  retried its way to an answer cannot present itself as one that did not.

For a local model the monetary cost is `0` with `measured` provenance — "this cost nothing" is a fact
about local execution, not an absence of evidence. **No electricity cost is invented**, because no
rate and no measurement method were supplied.

---

## Scoring, ranking, and the line between measurement and opinion

Counting rules are fixed before the first request, because a finalizer written after the numbers
arrive is a finalizer shaped by the numbers:

1. **Reconciliation first.** An unbalanced ledger makes every rate below it provisional.
2. **Only `pass` counts as a pass.** `partial` is reported beside it and never merged into it.
3. **Rubric answers awaiting human review are excluded from every rate and ranking** until the
   adjudication returns. No model judges a candidate.
4. **A governance failure disqualifies.** It is a different outcome, not a low score, and no pass
   rate offsets it.
5. **Missing evidence is not a zero.** A dimension with no applicable results has no rate at all.

**Capability roles** ("conversational companion", "structured worker", "trusted with private
material", …) and **retention recommendations** are *interpretation*, and they say so in their own
fields and headings. A recommendation to keep or drop a model is a judgement about the work at hand,
not a fact the benchmark established — so each carries the evidence it rests on, and a different
owner with different work could reasonably disagree. **No model is ever deleted by this engine.**

---

## Blinded adjudication

Rubric cases need a person. That only means something if the packet the person reads cannot tell them
which model wrote which answer. Three leaks are closed:

1. **The obvious one** — a field naming the model. Every answer is keyed by an opaque token derived
   with HMAC-SHA-256 from a secret and the slot. The tokens are not invertible and not even linkable
   across cases.
2. **Ordering** — answers are shuffled per case with a seeded PRNG, so the first answer on every page
   is not always the same model. The seed lives in the key: reproducible afterwards, unpredictable
   from the packet.
3. **Self-disclosure** — a model that writes "As Qwen, I would say…". Identity terms are redacted,
   including the fragments a model actually names itself by (`qwen3.8:27b` also leaks as `qwen3.8`,
   `qwen3` and `qwen`), while ordinary English that happens to appear in a model name is left alone.

The finished packet is then **audited** for every one of those terms, because a redactor that is
never checked eventually misses one. The **key is written to a different directory from the packet**;
blinding that keeps the key beside the packet is a label rather than a property.

---

## Isolated execution — and what it does not claim

Every attempt that touches the filesystem gets a fresh temporary workspace. Fixtures are copied in as
data, so the originals are never anywhere the attempt can reach. Path resolution resolves absolute
paths, `..` traversal **and symlinks** before checking, and refuses anything outside the workspace.
The environment is an allow-list of a handful of names that only describe the machine — no `HOME`, no
credential-shaped variable, no vendor prefixes. The workspace is deleted afterwards whether the
attempt succeeded or not.

**What it does not do**, stated so nobody relies on it: it is not an OS sandbox, and it does not stop
a child process from opening a socket. The development runner never spawns one on a candidate's
behalf, and its executed tier stays NOT MEASURED. Where the product does execute candidate-modified
code — the WORKSPACE benchmark's sealed verification commands — it does so only under the OS sandbox
in `execution-sandbox.ts` (macOS Seatbelt: no network, writes confined to the workspace, HOME
unreadable), and refuses the run on a machine that has none. See "Execution of model-modified code"
in `ARCHITECTURE.md`.

---

## Workspace-backed cases: measuring work rather than prose about work

A prose case asks a question and reads a string. That measures whether a model can *describe* a fix.
It cannot measure whether a model can find the defect in an unfamiliar repository, change the right
files, run the tests, read the failure, recover from a wrong first attempt, avoid breaking something
else, stay inside the part of the tree it was given, and stop. Those are different capabilities, and
a benchmark that scores prose about them is a benchmark that rewards fluency.

So there is a second case type, `WorkspaceCase`, and it is **parallel to `BenchmarkCase` rather than
an extension of it**. Three reasons, and any one of them would be enough:

- `caseDigest` seals the whole `BenchmarkCase` struct. A new optional field moves the digest of every
  case that does not use it, which breaks `fixtures/parity/store` — where Swift-written records are
  re-sealed to prove the two encoders agree — and orphans every `comparabilityKey` already on disk.
- the comparability rule would become **false**. Two workspace results are comparable only when the
  *fixture*, the *scope*, the *tool policy* and every *verification command* also match. `cwk1:`
  binds all of them; `mlk1:` has no reason to and should not start.
- `Observation` is text-shaped. `outputText` plus `toolCallObservationsRaw: string[]` cannot represent
  a file write, a test run, or a second attempt after a failure.

What the two **share** is everything below the case. `workspacePlannableCaseOf` and
`workspacePromptRecordOf` project a workspace case into the shapes the existing machinery already
takes, so the ledger, the planner, the frozen manifest, the lock, the guards, the spend tracker and
the report need no change at all. `TERMINAL_STATUSES` has carried `patchFailure`, `scopeFailure`,
`compilationFailure` and `behavioralFailure` since the port from the Python harness, because that
harness already scored work of this kind — those statuses were waiting for this.

### What a case declares

| | |
|---|---|
| identity | id, version, suite, description, capability dimensions |
| workspace source | fixture directory, **sealed tree digest**, optional pinned commit, setup commands |
| task | the exact instruction, the allowed paths, the forbidden paths, any briefing |
| execution | timeout, maximum attempts, tool policy, network policy, environment allow-list, sampling |
| verification | test/build/typecheck/lint commands, **hidden** checks, file invariants, forbidden changes, patch-cleanliness, change ceilings |
| scoring | integer weights, in thousandths, over seven named metrics |

`workspaceCaseDigest` (`cwc1:`) seals all of it, and that digest is what a result carries — so a row
always says exactly which task version produced it. Editing a fixture changes its tree digest, which
makes the sealed case refuse to run against it, **before** a request is sent. There is deliberately no
script that refreshes those digests: a digest a script refreshes is a digest that silently follows
whatever the tree became.

### One attempt, start to finish

```
<sandbox>/cernum-ws-<case>-<n>-XXXXXX/
  work/        the tree handed to the agent — a copy of the fixture, made per attempt
  baseline/    a second copy, made after setup and handed to nothing
  probe/       a third copy, used for the BEFORE reading, deleted immediately
  tmp/         the agent's TMPDIR — outside the tree being measured
```

1. the fixture is **copied in as data** and its digest checked against the case's seal;
2. setup runs, and the result is copied to `baseline/` — two trees rather than one, because a patch
   cannot be rendered from a tree that has been overwritten in place;
3. the visible checks run once against a throwaway copy, giving every check a **before**;
4. the agent gets `work/`, an allow-listed environment and a scratch directory outside the tree;
5. `work/` is snapshotted **the moment the agent stops and before verification runs**, so a test
   runner's caches are never attributed to the model;
6. `baseline/` is re-digested — nothing is ever handed that directory, so a byte of difference in it
   is proof that something wrote outside the workspace it was given;
7. verification runs with **no provider credentials at all**, whatever the agent was given;
8. everything is deleted, unless the caller asked for a failed attempt to be preserved.

Diffs and patches are computed here, not asked for: content-addressed snapshots, an LCS diff rendered
to a unified patch with no timestamps, sorted paths, and binary changes named rather than inlined.
`git` is not required and is never in the path between the filesystem and the record.

### The verdict is never taken from the agent

`WorkspaceAgentResult.completed` means the tool exited under its own steam. It is recorded and it
decides nothing. A model that announces success and changes nothing scores exactly what a model that
changes nothing scores — there is a test that says so by name.

Every transcript event carries **provenance**: `engineObserved` (Cernum ran it, or watched the
filesystem do it) or `agentReported` (the tool's own stream said so). The first is evidence; the
second is testimony. Nothing downstream counts a reported event toward a verdict.

That split is only worth having if it cannot be claimed, so `ENGINE_ONLY_EVENT_KINDS`
(`attemptStarted`, `attemptFinished`, `retryStarted`, `verificationRan`, `harnessFault`,
`boundaryRefusal`) are refused from a driver: the forged event is **dropped** and a `harnessFault`
recorded in its place. A tool asserting its own test result into the record the scorer reads before
deciding a regression is the one thing this model exists to refuse.

Two facts are **explicit fields rather than inferences**, because both were recoverable only by
reading prose before the transcript audit:

- **`finalResponse`** is its own event kind, distinct from the `message` narration around it. A tool
  that keeps talking after it answers makes "take the last message" wrong, and the transcript was
  never asserting that it was right.
- **`terminationReason`** is a closed value on `attemptFinished` — `agentCompleted`, `agentFailed`,
  `deadlineExceeded`, `cancelled`, `providerDeclined`, `driverUnavailable`, `policyNotExpressible`,
  `harnessFault`, `workspaceEscape` — mapped by one pure function and carried on the attempt record
  too. The difference between `deadlineExceeded` and `agentCompleted` is the difference between a
  measurement and a non-measurement, and it should not need a sentence parsed to find it.

`retryStarted` marks the boundary between an initial attempt and a retry without anybody comparing
an index to zero, and carries the previous attempt's termination reason and patch digest so a
retry's transcript reads on its own.

Executables named in commands are collected from **every** `commandExecuted` event, reported ones
included — a model's shell command runs inside the tool's process, so the only account of it there
will ever be is the tool's own stream. A tool that does not report its commands cannot be checked
this way at all, which is why the executable allow-list is a *detection* and the verdict rests on
the tree.

Statuses are decided in one order, each preempting the ones below it because each describes a reason
the reading below it would be meaningless:

```
runtimeError / safetyAbort → envelopeFailure → timeout → scopeFailure
  → patchFailure → compilationFailure → behavioralFailure → fail / partial / pass
```

A run that edits the test file and then passes the test is a `scopeFailure`, not a pass.

### Regressions are measured, not assumed

`establishBaseline` runs the visible checks against the untouched tree first, so every check has a
before and an after. Without it, a failing test after the change is indistinguishable from one that
was already failing — which on a bug-fix case is the *normal* state at the start, since the
reproducing test is supposed to fail. A **regression** is a check that passed and now does not, and
it stops a run being a success however good the rest of it looks.

### Missing numbers are not zeros

Every metric is an integer in thousandths **or** unavailable with a reason, and the composite
renormalizes over the metrics that exist. A case that declares no change ceiling gets no
patch-economy score — not a zero, which would rank a model below one that was never asked.

### What the isolation does and does not enforce

**Enforced.** A fresh copy of the fixture per attempt, under a sandbox root that
`assertSandboxRootIsSafe` refuses to place inside any Git working tree or overlapping the fixture
root — the obvious wrong value for `sandboxRoot` is the checkout the benchmark was launched from,
and nothing in the mechanics would otherwise object. Every path the engine opens goes through
`resolveInside`, which resolves absolute paths, `..` traversal *and symlinks* before checking; a
write through a symlink an attempt planted itself is refused and the refusal recorded. The pristine
`baseline/` copy is re-digested after every attempt, which catches a write that left the workspace
by any route at all. A
default-deny environment: the child gets the handful of names that only describe the machine, plus
exactly what the frozen case listed, and nothing else. The agent's scratch directory is outside the
tree. Verification commands inherit nothing — `replaceEnvironment`, not `extraEnvironment`, so a
check cannot authenticate to a model to ask whether it passed. A credential-shaped name in a case's
allow-list is refused **at seal time** by `validateWorkspaceCase` and again when the child
environment is built; only `HOME` may be unlocked by name, and only because a subscription CLI
cannot find its own session without it. Unlocking it is bound explicitly into `cwk1:`, so a run with
`HOME` and a run without it are never merged into one row.

**Enforced since the V1 execution policy.** Every sealed command Cernum runs on a workspace — setup,
the baseline probe, visible and hidden verification, and the Ollama loop's `run_check` — runs under
macOS Seatbelt (`execution-sandbox.ts`): no sockets, writes confined to that tree and its scratch
directory, the home directory unreadable. A machine with no such sandbox refuses the run before any
attempt. Cernum never executes a command a model chose.

**Not enforced, and said plainly.** The AGENT's environment is not an OS sandbox. A case that unlocks `HOME` has unlocked
a directory that tool can read, and Cernum states that rather than implying otherwise. `networkPolicy`
is a declaration this engine records and expresses through whatever switches a tool documents; it is
not a firewall. `codex-cli.ts` already documents, with evidence, that a validly-set switch on one of
these tools need not hold. So the posture is the one the rest of this engine takes: configure what can
be configured, **observe** what actually happened, and let the observation decide.

### The agent execution contract

`WorkspaceAgentDriver` is defined before any provider is wired to it, because a contract written to
fit whichever tool is implemented first becomes that tool's shape wearing a general name. Each driver
declares a `WorkspaceAgentCapabilities` record, and `driverShortfalls` refuses a case the driver
cannot honour **before a workspace is made or anything is spent** — a driver that cannot be told which
directory to work in cannot run a workspace benchmark at all, since it would work wherever it was
launched.

A driver starts the tool rooted at the workspace, expresses what it can, **reports what it could not
express**, and emits transcript events. It does not decide success, does not clean up, and does not
retry: attempts belong to the runner, because each one needs a fresh workspace and a recorded
boundary. `ScriptedWorkspaceAgent` implements the contract with no provider involved, so every branch
of the runner is reachable in a test without a request leaving the machine.

### Difficulty tiers: what "harder" means, in numbers

`pack.cernum.workspace.foundation-four@1` was run across four Claude models, three samples of each of
four cases — forty-eight runs. Sonnet, Fable and Opus each scored 12/12; Haiku scored 9/12, losing
`ws.receipt-refunds.sign` three times out of three. That is a real result, and it is also the end of
what that pack can say: a benchmark three of four models saturate has stopped separating the three.

So cases now carry a **difficulty tier**, and a tier is a measurement of the TASK rather than an
adjective or a hint about which model to send it to.

| | |
|---|---|
| **tier1** | Small, localized work. One to three source files, a verification path usually obvious from the failure, little architectural ambiguity. The floor: a model that cannot pass these cannot be measured on the rest. |
| **tier2** | Moderate repository understanding. Several interacting files, a symptom that may be misleading or several plausible fixes, diagnosis that may need the tools rather than the instruction, and one case worth recovering from. |
| **tier3** | Substantial repository understanding. Architectural or cross-cutting work, several invariants that must hold at once, longer dependency chains, and several answers that are plausible and incomplete. |

**A tier never describes a model and never selects one.** Every candidate in a matrix receives exactly
the same sealed case; `WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK` travels on every plan and every
aggregate saying so, and there is a test asserting that nothing in the difficulty modules mentions a
provider, a model identifier or a binding. Tier 3 is not "the Opus case".

**Difficulty is not token count.** A repository can be enormous and trivial — a thousand files and a
typo — and small and hard, which is what every Tier 3 case here is. The descriptors are about
*relationships*, and `fixtureFileCount` and `fixtureByteCount` are deliberately excluded from the
axes a case may escalate on, so no case reaches a tier by adding files nobody has to read.

#### What a profile carries

A `WorkspaceDifficultyProfile` has two halves, and the split is the point.

- **measured** — derived from the sealed case by `measureWorkspaceCase` and refused if a profile
  disagrees: visible checks, hidden checks, invariants, attempts, briefing paths, change ceilings.
  Three fixture figures (files, source files, bytes) are declared beside them and checked against the
  sealed tree by `workspace-tier-packs.test.ts`.
- **declared** — the judgements a person makes, each with a definition a second reader can apply to
  the same repository and get the same number: `relevantFileCount`, `expectedMinimumEditFiles`,
  `dependencyDepth`, `diagnosticDistance`, `architecturalConstraintCount`, `hiddenInvariantCount`,
  `irrelevantContextFileCount`, `independentDefectCount`.

Several of the declared numbers are cross-checked rather than trusted: `expectedMinimumEditFiles`
against the reference solution under `test/engine/fixtures/workspace-solutions/`,
`architecturalConstraintCount` against the invariants the case actually carries, and
`hiddenInvariantCount` against whether there are hidden checks at all. A number nobody can check is
fake precision; the answer is to make each one answerable, not to publish fewer.

#### What a tier requires

Each tier declares **floors** every member meets, **ceilings** no member exceeds, and one more rule
that stops a tier being the tier below with more files in it: a case must go beyond the previous
tier's ceiling on at least **three independent axes**. Three, because one is a coincidence and two
tend to move together. A case is *not* required to be hard in every way at once —
`ws.t2.text-normalize.cluster` is a one-file fix whose difficulty is that four consumers fail four
different-looking ways, and `ws.t2.ledger-currency.propagate` is five files with no misdirection at
all. A band demanding both would have excluded both.

`validateWorkspaceDifficultyProfile` refuses a claim that does not hold up, and
`validateWorkspaceCatalog` calls it — so a preview or a matrix refuses before anything is sent rather
than printing a difficulty nobody checked.

#### Why the profile is a separate sealed object

It is sealed under its own scheme, `cwd1:`, and is deliberately **not** inside `cwc1:` or `cwp1:`.

- **A field on the case would move every existing digest.** `workspaceCaseDigest` seals the whole
  struct, so adding `difficulty` to it changes `cwc1:` for a case whose text did not change by one
  character — and therefore `cwk1:`, and therefore `foundation-four`'s `cwp1:`. Forty-eight sealed
  records carry those three digests. A completed, valid matrix would become unreadable in order to
  record a label that changes nothing about what any model was asked to do.
- **It is not part of the experiment.** `cwc1:` answers "what was this model asked to do, in what
  tree, checked how". Recount `diagnosticDistance` and nothing a model did is different. An assertion
  *about* a thing does not belong inside that thing's identity.

It is sealed all the same, and `cwd1:` travels on the matrix plan and on every cell — so a result
says which difficulty claim it was published under, and a profile cannot be quietly retuned after the
fact to make a model look better or worse.

#### Reading a matrix by tier and by capability

`workspace-routing-evidence.ts` groups finished cells two ways, under rules the per-cell aggregate
already lives by:

- **no composite is averaged across cases** — a composite weighs the dimensions inside one case under
  weights that case froze, so a tier row carries success *counts* and rates derived from them, plus
  per-case detail. There is no tier score;
- **nothing is ranked** — a reader ranks, this publishes;
- **a tier a candidate never ran is absent, not zero** — "did not attempt Tier 3" and "failed Tier 3"
  are different facts;
- **consistency is a column** — with three repeats, "passed" and "passed every time" are different
  claims, and `unanimousCaseCount` is the gap between them.

`observedAdequacy` answers a threshold question a *caller* asks, with the evidence attached and a
plain statement when the sample is too small. There is no routing policy here: `adequate: false` and
`meets: false` are different findings, and a rule that treated them alike would be routing on absence
of evidence.

## The development benchmark, and the tier it will not report

Cernum measures twelve capability dimensions by asking a question and judging an answer. Two
dimensions a development routing decision depends on cannot be measured that way at all:
**repository understanding** and **multi-file editing**. A question about how a project's files
relate needs a project; a change that has to stay coherent across four files needs four files.

So they live in a **separate registry** — `src/core/development-catalog.ts` — with their own sealed
fixture repositories, their own predicate-based assertions, their own scoring contract and their own
digests. Nothing joins it to the text catalog, and that is the point: `fixtures/parity/catalog.json`
pins the text suites member for member, and a candidate measured on conversation and retrieval has
not been asked a development question and must not read as though it had.

**Every candidate starts at NOT MEASURED, structurally.** The ranking layer fills the development
block on every row from `noDevelopmentEvidence` unless it is handed real results. There is no path
by which a good text rate becomes a development standing.

### Two tiers, and only one of them is filled in

| Tier | Decided by | Measured today |
| --- | --- | --- |
| **Structural** | reading the repository the attempt left behind: which files moved, what the held-out assertions say about their contents, what was preserved, what strayed | ✅ Yes |
| **Executed** | running the candidate's code: do the new tests pass, do the old ones still pass, does it still build | ❌ No |

The executed tier is **declared in the contract and reported as not measured**, for the reason
stated directly above: there is no sandbox to run candidate code in, and the isolation module says
plainly that it is not one. Three consequences follow, and all three are deliberate:

- `newTestsPass`, `existingTestsPass` and `buildSucceeds` carry **no rate at all** — not a zero.
  Missing evidence is not a zero score is the rule everywhere else in this engine and it holds here.
- **No multi-file-editing task can reach full credit.** A task graded `full` would be asserting that
  the candidate's code was run and worked. It was not run.
- The `multi-file editor` and `development routing candidate` roles **cannot qualify**. Their
  structural standing is published beside the withheld role, exactly as a candidate whose identity
  was never established still has its rates published and its recommendation withheld.

The one role that can qualify today is **repository reader**, which asks nothing that requires
running anything.

### What a development result must carry

A text result's identity is bound by the frozen manifest, because a text case is a frozen prompt and
a sealed policy. A development task is graded by *code*, and code changes — so every result also
records the **commit** that graded it, the **fixture repository digest** it ran against, the
**contract digest** that decided it, and the **machine** that executed it. A commit that cannot be
read (an installed build has no `.git`) is recorded as empty and named as missing; it is never
filled in with a version number standing in for a commit.

---

## The terminal command

The terminal interface ships **inside the installed application**. It needs no checkout, no Node
installation, no `npm install` and no `node_modules`: the application already contains the engine
build and a runtime for it, and the launcher in its resources directory hands one to the other.

```
# From an installed application — the supported way
cernum <command>                     # once installed for your account (see below)

# From a development checkout
npm run cernum -- <command>
```

It offers the same operations as the Campaigns and Providers screens, through the same engine, and
every campaign policy is built by the **same function** both surfaces call — so a campaign created in
one and resumed in the other is the same campaign, with the same frozen identity:

```
cernum providers                     every provider's status, WITHOUT contacting any of them
cernum discover [<provider>]         ask a provider what it is and what this account may call
cernum credentials                   which API keys are configured (masked; never printed)
cernum models                        the models installed locally (read-only)
cernum suites                        the benchmark suites this engine can plan

cernum create <name> --models a,b --frontier claudeCLI:claude-sonnet-5:high --pricing prices.json
cernum cost <name>                   what it is estimated to cost, without running it
cernum authorize <name> --ceiling 5.00 --yes
cernum run | resume | pause (Ctrl-C) | status | verify | finalize | retest
```

`--frontier` takes `provider:model[:effort]`. The effort is part of the candidate **name**, because
the same model at high effort and at max effort are two experiments and must never share a row, a
rate or a cost. A model no identity smoke test has proven callable is refused here rather than
offered — discovery can name it, and naming is not proof.

Ctrl-C pauses at the next attempt boundary **and stops every provider command in flight** — a child
process that is merely abandoned keeps its slot in your rate limit and keeps consuming the allowance
the run was measuring. The signal goes to the process *group*, so a tool that shelled out takes its
helpers with it, and a tool that ignores `SIGTERM` is killed after a grace period.

### Installing it for your account

`cernum install-command` (or **Install command** on the Campaigns screen) writes **exactly one file**:

| Platform | Where |
|---|---|
| macOS, Linux | `~/.local/bin/cernum` |
| Windows | `%LOCALAPPDATA%\Cernum\bin\cernum.cmd` |

That is the whole of it. It does **not** edit `PATH`, a shell profile, the registry, `/usr/local`, or
anything requiring elevation, and it adds nothing that runs at login. If the directory is not on your
`PATH` the command says so and prints the exact line to add; whether to add it stays your decision,
and until you do, the file works by its full path.

`cernum uninstall-command` removes exactly that file. It is identified by a marker written inside it,
so a file the application did not write is reported and **left alone** rather than deleted.

`cernum where` prints where campaigns live, which launcher is in use, and whether the command is
installed and on `PATH`.


| Command | What it does |
|---|---|
| `models` | list the models installed locally — read-only; never pulls, creates or deletes |
| `suites` | list the benchmark suites the engine can plan |
| `create <name> --models a,b` | freeze a manifest and write the plan |
| `run <name>` | run it; **Ctrl-C pauses cleanly** at the next attempt boundary |
| `resume <name>` | re-verify the manifest and carry on where it stopped |
| `status [<name>]` | one campaign, or every campaign |
| `verify <name>` | recompute every binding and report what moved |
| `finalize <name>` | reconcile, rank, interpret, build the blinded packet |
| `retest <name> <new>` | derive a manifest for this machine from another one |
| `lock <name>` | who holds this campaign, and whether they are still alive |
| `unlock <name>` | release a crashed owner's lock; `--force` for a live one |
| `endpoints` | which benchmark endpoints are leased, and by which campaign |
| `discovery-refresh [<provider>…]` | observe what is available on this machine now, persist the snapshot, and report what MOVED against the previous one. Invokes no model |
| `observations` | what this machine has observed and what it has imported, by machine and by kind |
| `observations-export --out <file>` | write this machine's observations as one sealed, transport-neutral bundle |
| `observations-import <bundle>` | import another machine's bundle — digest-checked whole, idempotent, and never promoted to a local observation |
| `availability [--machine <key>] [--route <key>]` | which routes are observed available, on which machine, and from whose observation |
| `candidates <capability>` | the routes whose evidence QUALIFIES them, with every exclusion and its reasons. A set, never a winner. `--require-verified-identity` excludes routes whose served identity cannot be verified; `--policy crp1` re-answers under the superseded Pass 6/7 rule |
| `unlock --endpoint <url>` | release a crashed campaign's hold on an endpoint |
| `where` | where campaigns live, and whether this command is installed |
| `install-command` / `uninstall-command` | put the command on your account, or take it off |

Useful flags: `--suites a,b`, `--repeats n`, `--max-attempts n` (how a smoke run is kept small),
`--endpoint <url>`, `--root <dir>`, `--synthetic` (drive the deterministic host — no request reaches
any server).

Execution mode is chosen at **create** and frozen: `--observe-only` (do not manage residency;
noncanonical) and `--thinking on|off` (default off). `--live-residency` is still accepted and
ignored — residency management is the default now, so there is nothing to remember to switch on and
nothing to forget.

Campaigns are written where the desktop application reads them
(`~/Library/Application Support/Cernum/campaigns` on macOS), so a run started in the terminal
appears on the Campaigns screen while it runs, and one started there can be resumed here.

---

## One runner at a time

The shared campaign directory is the point — and it is also how two runners end up pointed at one
ledger. The ledger's own defence (exactly one terminal result per slot, ever) is a last line rather
than a first one: it refuses the duplicate *after* both processes have paid for the inference, and it
cannot stop two runners interleaving guard verdicts, residency unloads and checkpoint rewrites. So
ownership is taken in the filesystem, before the first request, where both processes can see it.

`<campaign>/campaign.lock` records the owner's process id, process type (`desktop` or `terminal`),
the exact command, the hostname, the campaign id, when it was acquired and when it last reported.
Acquisition is `open(…, 'wx')` — one atomic create-exclusive syscall — so there is no read-then-write
window for two starters to race in.

A second starter is refused by name:

> `contested` is already running in the desktop process 4821 on this-machine.local (Cernum ·
> Campaigns screen), which last reported 3s ago. Two runners against one ledger would interleave
> guard verdicts and residency unloads, so the second is refused. Pause the first one and try again.

**A live lock is never broken automatically.** Liveness comes from three facts — the hostname, whether
the recorded process still exists, and how old its heartbeat is — and exactly one combination is
recovered without a person: *this host, and the process is gone*. That is a crash, the lock is
reclaimed, and the crashed owner is kept under `<campaign>/locks/` as evidence rather than tidied
away. A process that still exists but has stopped reporting could be a hung runner or an unrelated
process that inherited the number, and a lock written by another machine cannot be judged from here;
both are refused with the command that resolves them (`cernum unlock <name> --force`), because
breaking a lock should be something a person decided, not something a program concluded.

Pause, completion, abort and refusal all release the lock. Finalizing a campaign a live runner is
still writing to is refused too: a final report read mid-run is a snapshot presented as a conclusion.

### One campaign per runtime, too

The campaign lock stops two processes running the same campaign. It says nothing about two
**different** campaigns pointed at the same Ollama — and that is not a theoretical gap. Two campaigns
sharing one runtime take turns evicting each other's weights, so every latency either of them records
is partly a measurement of the other campaign, and each one's residency proof stops being true the
moment the other loads a model. Both would finish clean, and both would be wrong.

So a live campaign also takes a **runtime-endpoint lease**, before any request is sent:

- keyed to the **normalized endpoint** — `localhost`, `127.0.0.1` and `::1`, with or without a
  trailing slash, are one server and take one lease;
- recording the PID, process type, campaign id, endpoint, hostname, acquisition time, heartbeat, and
  what the model store looked like when it was taken;
- refusing a second campaign on an owned endpoint **before a single inference request**;
- with the same live / stale / unresponsive / foreign-host rules as the campaign lock, and the same
  promise: a live lease is never broken automatically;
- released on pause, completion and abort, and reclaimed — with the crashed owner kept as evidence —
  after a verified crash.

The model-store identity is **recorded rather than keyed on**, deliberately. Keying on it would let
two campaigns that happened to see different store listings both believe they owned the same server,
which is the exact failure the lease prevents.

Campaigns on **genuinely separate endpoints run side by side** with no contention, which is why this
is a lease on the runtime rather than a global one-campaign-at-a-time flag. Observe-only campaigns
take a lease too: they still load weights on that endpoint, which is precisely what would invalidate
a canonical campaign's residency proof running beside them.

`cernum endpoints` shows what is leased. `cernum unlock --endpoint <url>` releases a crashed
campaign's hold on one.

---

## Where a campaign lives

```
<campaign>/
  configuration.json      what it was created with
  manifest.json           the frozen manifest — the thing everything is checked against
  ledger/
    plan.json             every planned attempt, written once, never rewritten
    meta.json             campaign identity
    results.jsonl         append-only terminal results, fsynced one at a time  ← the truth
    checkpoint.json       progress cache, rewritten after every attempt        ← not the truth
    events.jsonl          guards, unloads, pauses, resumes, lock acquire/refuse/recover/release
    abort.json            present only while an abort stands
    aborts/               superseded aborts, kept for the report
  authorization.json      present only on a campaign authorised to spend money, and read back by the run
  campaign.lock           present only while a process owns this campaign
  locks/                  reclaimed and released locks, kept as crash evidence

<campaign root>/
  .runtime-leases/        one file per benchmark endpoint, shared between campaigns
    recovered/            reclaimed and released leases, kept as crash evidence
  .providers/
    discovered.json       what discovery actually proved, shared by both surfaces. NOT a source of
                          availability on its own: a campaign still refuses anything not `proven`.
  rankings.json           measurement
  retention.json          interpretation, labelled as such
  final-report.json       both, plus the reconciliation
  review/                 the blinded packet — safe to share
  review-key/             the key that reverses it — not safe to share
  workspace/              present only on a campaign with workspace-backed cases
    <caseID>/attempt-<n>/
      attempt.json        the sealed attempt record: digests, diff, scope, every exit status
      patch.diff          the unified patch, byte-stable and applyable with `patch -p1`
      transcript.jsonl    one event per line, each carrying its provenance
```

A workspace attempt's *working* tree lives under the benchmark sandbox and is deleted when the attempt
finishes. It is kept only when the caller asked for a failed attempt to be preserved, and the attempt
record then says where — a workspace nobody asked to keep is never left on the machine.

---

## Parity with the harness this descends from

The engine is a TypeScript port of a Python harness that has already produced real campaign evidence.
Where the two must agree, they are pinned to each other by fixtures generated *from the Python*, never
written by hand:

- `fixtures/parity/engine/canonical-vectors.json` — the canonical JSON encoding and its SHA-256/HMAC
  digests, byte for byte. (Note that this deliberately differs from `src/core/digest.ts`, which seals
  the core's own records under a Swift-compatible form that escapes `/`. Two canonical forms that
  differ by one byte produce two different digests, so the engine has its own.)
- `fixtures/parity/engine/ledger-plan-vectors.json` — the plan the harness's own planner produces:
  slot keys, slot order, the plan digest, and the exact set of terminal statuses.

Adding a terminal status, or changing the encoding, fails the parity tests rather than silently
widening what the engine will accept.
