# Cernum v0.2.4 — the preview and the record describe the same request

**A corrective release. Every defect it closes was found by reading `cernum smoke`'s dry-run output
against the record it would have written — before a single live request was sent.**

No live Claude, Codex or OpenCode request was made while finding, fixing, testing or releasing any
of this. Every execution path below is exercised against fake executables written to temporary
directories.

---

## The audit

A MacBook Pro dry-run audit of the v0.2.3 smoke path found seven things. They are not seven separate
bugs; they are one shape — **a command that described each request twice, and disagreed with itself
about money, identity and what it could measure.**

| # | Found | Closed by |
| --- | --- | --- |
| 1 | `cernum help smoke` ignored the topic and printed the general index, omitting `--models`, `--dry-run` and `--all-ladder` | **D** |
| 2 | `OPENCODE_NO_PROOF_PATH` was stale and false, and was written into `discovered.json` for every OpenCode model on every run | **C** |
| 3 | `smokeBinding()` hardcoded `subscriptionCLI` and `subscriptionIncluded` for every provider | **A** |
| 4 | A live OpenCode smoke would spend metered money and record $0 marginal subscription usage | **A**, **B** |
| 5 | The dry-run reported `meteredAPI` correctly; the live record would have disagreed | **A** |
| 6 | `--otlp-observer` was inert during smoke: adapter options were never passed | **E** |
| 7 | A Codex smoke can establish request acceptance with identity unverifiable, never proof | **E** |

---

## A · One binding, derived from the registry, validated where it is built

`commandSmoke` built each request from a local helper that wrote three provider-determined fields as
**literals** — `executionClass: 'subscriptionCLI'`, `billingBasis: 'subscriptionIncluded'`,
`authorizationMode: 'subscriptionCLISession'` — for every provider it was ever handed. The preview
beside it derived the same fields from the provider registry and printed them correctly. Nothing
caught the contradiction, because the smoke path was **the one binding-building path in this engine
that never ran `validateBinding`.**

- **`src/engine/smoke-binding.ts`** is now the only place a smoke binding is built. Execution class,
  billing basis, pricing and authorization mode all come from `provider.ts`, and the object is
  validated before it is returned.
- **`authorizationModeForProvider()`** joins `executionClassOf` and `billingBasisOf` in the registry,
  so "how is this provider authorised" has one answer rather than one per caller.
- **The preview, the live request, the evidence file and the discovery row all read the same object.**
  There is no second description of a run for any of them to disagree with.
- **OpenCode always records `meteredAPI`.** Never `subscriptionIncluded`, at any effort level.
- **An OpenCode cost Cernum cannot compute is recorded as UNAVAILABLE** — with a reason naming *why*
  it is unavailable — and never as zero. Where you supply prices and the provider reports tokens, the
  charge is computed and labelled `estimated`, because a figure derived from a published rate is not
  the figure on a bill.
- **Invariant tests** walk every executable provider and assert the preview string and the recorded
  result agree on billing basis, execution class and authorization mode.

Two further honesty repairs fell out of the same reading:

- The OpenCode adapter put the **finish reason** in `reportedEffort`, so every OpenCode smoke printed
  `effort applied, as the provider reported it: stop`. A finish reason is not an effort level.
- The adapter's comment said OpenCode's own cost figure was "preserved in the raw usage instead". It
  was read off the message and dropped. It is carried now, as
  `openCodeReportedCostUnitUnverified` — the generated types declare no unit, so it is not promoted
  into a cost column.

## B · A metered smoke is refused unless it was authorized by name

```
cernum smoke opencodeCLI --models opencode/union-alpha
cernum: this run is not authorized.
  THE PROVIDER MAY BILL YOU FOR THIS REQUEST AND CERNUM CANNOT SAY HOW MUCH. …
  The amount is UNAVAILABLE — which is not zero, not free, and not estimated. …
  Nothing was sent.
```

- **With prices** (`--pricing <file>`): `--authorize-metered <dollars>` is required. The **worst case
  for the scope** is computed from the frozen budgets — every input budget filled, every output budget
  filled at the higher of the output and reasoning rates — and the run is refused if it exceeds the
  ceiling. It is a bound that was checked before sending, not a receipt.
- **Without prices**: there is no bound, so a ceiling would be a limit this tool cannot enforce and is
  refused as one. `--authorize-unpriced-metered` acknowledges in writing that the provider may bill an
  amount Cernum cannot state, and it covers **exactly one request**. A scope of two is refused: an
  unbounded charge repeated is an unbounded charge multiplied.
- **The authorization is written into the evidence file**, with what it covered and what stayed
  unknown.
- **Subscription execution needs no spending authorization** — no card is billed — and is still never
  called free: it consumes a finite plan allowance, and that is recorded.
- A **dry-run reports the requirement instead of refusing**. The point of a preview is that a person
  reads the requirement before they are standing in front of it.

## C · OpenCode evidence says what is true in this release

`OPENCODE_NO_PROOF_PATH` said Cernum "has no OpenCode execution adapter, so there is no authorized
request it could make and record". True in v0.2.2. False from v0.2.3, when the adapter shipped. The
sentence stayed — and it is a **discovery string**, written into `discovered.json` beside every
OpenCode model on every run, so the store filled with a claim the same build could disprove.

- **`OPENCODE_PROOF_PATH`** replaces it and names the route, its cost, and its limits: discovery means
  **discovered/unproven**; an authorized successful request proves **execution**; it proves
  **identity** only as far as the returned `providerID`/`modelID` support; a reply naming no model
  leaves the candidate unproven.
- **Contaminated rows are superseded, never deleted.** `supersedeStaleOpenCodeEvidence` corrects the
  evidence on read, preserves the original text verbatim in `supersededEvidence`, and stamps
  `evidenceCorrectedBy: v0.2.4`. It **changes no availability** — correcting a sentence proves nothing
  — **backdates no timestamp**, and is idempotent.
- **Seven verdict paths tested against fake executables**: Union Alpha success, missing identity,
  model mismatch, refusal, timeout, malformed JSON, and a secret echoed in an error message.

### And the reason the correction had nowhere to go

Correcting on read is only half of it: the correction reaches disk when the store is next written,
and **the one command that rewrites the store was deleting the rows instead.**

`cernum discover <provider>` dropped every row for each named provider and wrote back only what came
out of that run. So on a machine where OpenCode is not installed — or is installed and signed out, or
simply answered nothing — `cernum discover opencodeCLI` **deleted the entire record for that
provider, including a `proven` row that a metered smoke had paid for.** Nothing warned. The store is
the evidence, so nothing could recover it.

A tool that did not answer is a fact about today, not a retraction of what was established before.
Rows for a provider that returned nothing are now **kept, and said to be kept**, with their
timestamps untouched — a run that learned nothing does not get to refresh anybody's freshness either,
so a stale proof still ages out on its own schedule.

## D · Every spelling of "tell me about this command" is safe and complete

v0.2.3 stopped `cernum smoke --help` from sending six live requests. It did not touch **`cernum help
smoke`**, which parsed the topic into the positional list and called a function that took no
arguments. So the most-typed spelling printed the general index, in which `smoke` had a two-line
entry naming `--evidence` and nothing else — while `--models`, `--dry-run` and `--all-ladder` were
all implemented. *A person looking for the safe way to preview a spending command was shown the least
informative page the program has.*

- `cernum help smoke`, `cernum smoke --help` and `cernum smoke -h` now print **byte-for-byte the same
  page**, from the same table, through the same renderer. A test asserts the three cannot drift.
- That page documents the provider argument, `--models`, `--all-ladder`, `--max-attempts`,
  `--dry-run`, the full metered-authorization contract, `--otlp-observer`, and what a Codex smoke can
  and cannot establish about identity.
- **`help <topic>` refuses an unknown topic** rather than printing the index and hoping.
- **Unknown options refuse even when `--help` is also present.** Printing help would be safe and would
  also answer a question nobody asked: the flag it could not read may be the one carrying the scope or
  the ceiling.
- **Malformed values refuse.** `--models` with no value, a bare flag given one, an empty value, and
  `--max-attempts banana` — which used to become `NaN`, fail `NaN > 0`, and **silently not apply the
  cap**, on the one command whose reason for having a cap is to keep a spending run small.
- 18 side-effect tests spawn the real command with recording fakes first on `PATH` and assert the
  fakes were never invoked.

## E · Smoke telemetry, and what it still cannot establish

`--otlp-observer` was wired into `run` and `resume` and nowhere else. `commandSmoke` built its
adapter with `buildAdapter(provider)` and **no options at all**, so even had the flag been accepted
there it would have started a collector that exported nothing.

- Adapter options are passed through smoke execution. `--otlp-observer <dir>` works for Codex smoke:
  loopback only, ephemeral port, per-invocation override, identifiers redacted at ingest, evidence
  audited on shutdown. Given for any other provider it **refuses** rather than starting a collector
  nothing would export to.
- Recorded per request: token counts, the **reasoning effort the tool says it applied** (which
  `codex exec --json` never echoes), latency, retries and plan allowance — each marked `unavailable`
  **with a reason** where the provider does not report it.
- A pending observation is told from an absent one: `correlated: false` plus a correlation key means
  *collect this later*, not *nothing was observed*.
- **Telemetry establishes no identity, however complete.** A Codex smoke that is accepted and answered
  is recorded as **`requestAcceptedIdentityUnverifiable`** — the provider accepted the identifier and
  something answered; which model did is not known and cannot be established this way. It is not
  proof, it makes nothing selectable, and it never reaches `verifiedModelID`.

---

## Tests

**1461 unit and parity tests** (up from 1397), **24 E2E passing** (up from 22), typecheck clean, both
macOS architectures built.

64 tests added across four new files:

| File | Covers |
| --- | --- |
| `v024-smoke-binding-invariants.test.ts` | A, B — the preview and the record cannot disagree; every metered refusal |
| `v024-opencode-smoke-evidence.test.ts` | C — seven verdict paths against fake executables; superseding; the non-destructive discovery merge |
| `v024-cli-help-safety.test.ts` | D — every help path, every malformed-option refusal, zero invocations |
| `v024-smoke-telemetry.test.ts` | E — the collector endpoint reaching the tool, and identity holding |

**No provider request was made during development or testing.** The OpenCode and Codex execution
tests drive shell scripts written to temporary directories; the Codex telemetry test's fake reads the
OTLP endpoint out of its own arguments and POSTs the fixture payload to it, which is the seam the
flag exists to drive.

**Six E2E remain blocked, and not by this release.** Every campaign-execution test aborts at
`disk.freeSpace: free 13.23 GiB, floor 15.00 GiB`. That is the machine, not the code: reproduced by
hand outside Playwright. About 1.8 GiB of free space on the boot volume would unblock them. One of
the six — `frontier-across-surfaces` — was additionally failing on a **stale argument list**: it
called `cernum smoke claudeCLI` with no candidate scope, which v0.2.3 made a refusal and this spec was
never updated for. That is fixed here; it now reaches the same disk guard as the other five.

## Checksums

```
1c113773aa7947fd55e837d5dd3b0d06e10d0b875b88be5aa7f2d486e1e19d73  Cernum-0.2.4-macos-arm64.dmg
0c634fd0a0dd15039246c62eaf172ea140ba5ed01c081bb69cc9691fad0ec340  Cernum-0.2.4-macos-arm64.zip
20b2728cb9e4f5f48506a1076f9a5c4a3e4c6be08d98568e533ea979f8ff9917  Cernum-0.2.4-macos-x64.dmg
132140331707ed5e7d40202a10869e9ad50509eb0b2b688fe239f3558d0f7f18  Cernum-0.2.4-macos-x64.zip
```

Verify before installing:

```
shasum -a 256 -c Cernum-0.2.4-SHA256SUMS.txt --ignore-missing
```

Built from commit `79992bb`, which the bundle carries and the install script asserts.

## Upgrading a second Mac without trusting the one that built this

An Apple Silicon install script is pinned to that arm64 DMG checksum and to the build commit, and
verifies both before it mounts anything:

```
cd ~/Downloads
curl -fLO https://raw.githubusercontent.com/happySNAG/model-lab/49ca9478b4eacb61347cf99ae08a09e5d7bfc683/scripts/releases/install-cernum-v0.2.4-macos-arm64.sh
shasum -a 256 install-cernum-v0.2.4-macos-arm64.sh
#  02ba83fa959a1f7602e936037c27ca2e76b6c49e9b441ae6a3511430cbd4ae93
less install-cernum-v0.2.4-macos-arm64.sh
bash install-cernum-v0.2.4-macos-arm64.sh
```

It sends no provider request and could not: the only verbs it issues are `where`, `providers`,
`discover`, `models`, `install-command`, `help` and `smoke --dry-run`, and a metered provider would
refuse a live smoke without an authorization the script never supplies.

## Opening an unsigned build

Not signed with a Developer ID and not notarized:

```
xattr -dr com.apple.quarantine /Applications/Cernum.app
```
