# Model lifecycle, discovery deltas and release reports (cmd2, cdd1, crl1)

Block 3, B3-1. Three pieces that let Cernum notice a new Claude or Codex release, say what changed about
a model it already knew, and tell a person about each new model exactly once. All three are offline:
they read discovery snapshots already recorded, and none of them contacts a model, a provider or the
network.

**Discovered is not reachable, and reachable is not qualified.** Every model below is a model a listing
named. Whether it answers is an identity smoke's question; whether it can do the work is qualification's
(`route-qualification.ts`, cqp1). Nothing here changes either, and nothing here is a selection.

## Model description schema cmd2

`src/engine/model-description.ts`. cmd2 is every cmd1 field, unchanged in meaning, plus:

| Field | Meaning |
|---|---|
| `lifecycle` | `Known<'active' \| 'deprecated' \| 'retired'>`: a value **with its source** (and when it was observed), or `unknown` **with a reason**. |
| `aliases` | Other identifiers a source stated reach the same model, each `{ alias, source, observedAt? }`. |
| `canonicalModelID`, `canonicalRouteKey` | The one id the model is filed under. Its own id unless an alias statement says otherwise. |

Rules:

- **Lifecycle comes only from a structured statement.** `lifecycleFromField` accepts exactly `active`,
  `deprecated` or `retired`; any other word (`sunsetting`, `legacy`) leaves it unknown and says what was
  seen. A refused smoke is not retirement (it may be tier, region or moderation), a model missing from a
  listing is not retirement (the listing may be partial), and `-preview` or `-latest` in an id is a name.
- **Aliases come only from a sourced statement** (`AliasStatement { provider, alias, canonicalModelID,
  source }`). A statement with no source is refused. Two ids that look alike are never merged.
- **Resolution** (`resolveAlias`) follows statements to the end: `canonical` (no statement names it),
  `alias` (with every step and its source), or `ambiguous` when sources disagree or the statements
  cycle. An ambiguous id is never resolved by picking one; it stays its own model and is reported.
- **Dedup** (`dedupByCanonicalID`) returns one description per canonical route key. The description filed
  under the canonical id is kept; every other id becomes an alias with its source. Members that state
  different lifecycles leave it `unknown`, naming both, and the conflict is listed.
- **cmd1 stays readable.** `readModelDescription` reads a cmd1 document as cmd2 with the lifecycle
  unknown (`a cmd1 description carries no lifecycle, and no source has stated one`), no aliases and its own
  id as canonical. cmd1 producers (`describeDiscoveredRoute`, `describeLocalModel`) are unchanged and still
  write cmd1; `upgradeToCmd2` lifts one explicitly. A document of any other schema, or a cmd2 document
  with a lifecycle outside the vocabulary, is refused with the reason.

## Discovery delta cdd1

`src/engine/discovery-delta.ts`, `deriveDiscoveryDelta(before, after, { aliases })`. Pure. It reuses the
per-route diff `diffDiscoverySnapshots` (cds1) and groups its result by canonical model:

| Section | A model is here when |
|---|---|
| `new` | none of its route keys appeared in the earlier snapshot, and one is listed now |
| `changed` | it was and is listed and a compared field of one of its routes moved, a new alias of it is listed, or it was unlisted and is listed again |
| `disappeared` | one of its routes was listed and none is now, and its provider answered |
| `notRefreshed` | its provider did not answer the later refresh: nothing was re-observed |

Each model carries `changes`: `{ routeKey, field, before, after }` for each of `listed`, `availability`,
`priceFingerprint`, `publishedFree`, `contextWindowTokens`, `runtimeDigest` and `runtimeVersion` that moved
(timestamps are not compared; they move on every refresh), the per-route kinds and sentences, and whether
a qualification of it is now stale. Snapshots from two machines, or named newest first, are refused.
With no earlier snapshot every listed model is new.

**Disappeared is not retired**: it means the listing stopped naming the model.

## Release report crl1

`src/engine/release-report.ts`. A release report lists the models the newest snapshot names that no
earlier report recorded, each once, decided against a ledger rather than a pair of snapshots, so a missed
refresh cannot hide a release and a replayed snapshot cannot repeat one.

- `deriveReleaseReport({ snapshot, ledger, aliases, providers })` is pure. A model counts as already
  reported when its canonical route key or any of its listed route keys is in the ledger, so a model first
  reported under an alias is not reported again under its canonical id.
- `recordReleaseReport(root, report, { reportedAt })` appends the new models as one sealed line and
  re-decides against the ledger as it is at that moment, so a stale report cannot repeat a model. A report
  with nothing new writes nothing.

**The ledger** is one file, `<root>/.release-reports/reported.jsonl`, opened only for append. Each line is
a record whose `recordID` is the digest of every other field under the canonical encoding, with a
`sequence` and the `previousRecordID` of the line before it. On read, the first line that fails by parse,
digest, sequence or link is refused, and so is every line after it. A ledger with any refused line is
**not appended to**. What the chain cannot see is the newest line removed whole; `ledgerDigest` is the
value to keep elsewhere to notice that.

## Commands

| Command | Effect |
|---|---|
| `cernum discovery-delta [--json] [--machine <cmk1:…>] [--aliases <file>]` | The two newest discovery snapshots recorded on the machine, compared. Read-only. |
| `cernum discovery-delta --before <file> --after <file> [--json] [--aliases <file>]` | Two cds1 snapshot files compared (a snapshot, or `discovery-refresh --json` output). Read-only. |
| `cernum release-report [--json] [--machine <cmk1:…>] [--providers claudeCLI,codexCLI] [--aliases <file>]` | The new models in the newest snapshot. Writes nothing. |
| `cernum release-report --record …` | The same, and appends the new models to the ledger. Exit 4, nothing written, on a ledger line that does not verify. |

`release-report` is declared `writesLocal` in the command table because of `--record`, as `candidates` is
because of `--log`; without `--record` it writes nothing. `--aliases` takes a JSON list of alias
statements, or an object with an `aliases` list (`fixtures/model-lifecycle/aliases.json`).

## Tests

- `test/engine/model-lifecycle.test.ts` — cmd2 lifecycle and its sources, cmd1 readability, alias
  resolution and dedup, the discovery delta over `fixtures/model-lifecycle`, and the command (no write, no
  network).
- `test/engine/release-report.test.ts` — each new model reported once, never repeated (including across an
  alias), the sealed ledger's append-only and tamper behaviour, and the command.
