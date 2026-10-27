# Substitution quarantine (csq1)

A route whose served model was recorded as **not the model requested** is held out of every routing
answer until a person releases it, on the record. Code: `src/engine/route-quarantine.ts`. Tests:
`test/engine/route-quarantine.test.ts`.

## What puts a route in quarantine

Two recorded findings, and nothing else:

| Cause | Where it is recorded |
| --- | --- |
| `smokeSubstituted` | `cernum smoke` returned the verdict `substituted`: the provider named a model, and it was a different one (`identity-smoke.ts`). |
| `outcomeSubstituted` | `cernum ingest-outcomes` (cro1) ingested an Ordra outcome carrying a `substitution` finding: the session's reported model is not the requested one, by exact string. |

The route quarantined is the **requested** `provider:model`. A model name is never read for anything,
and two spellings are never decided to be the same model.

`ingest-outcomes` records an entry for every substituted outcome in the store after each ingest —
this file's, any ingested before quarantine existed, and any imported from another machine — and
reports them under `routeQuarantine` in its `--json` output. `smoke` records an entry for every
`substituted` result of the run.

## The record

Each entry is one sealed, content-addressed `routeQuarantine` observation in the observation store
(`<root>/.observations`), with body:

| Field | Meaning |
| --- | --- |
| `rule` | `csq1` |
| `routeKey`, `provider` | The requested route. |
| `cause` | `smokeSubstituted` or `outcomeSubstituted`. |
| `evidence[]` | `kind` (`identitySmoke` or `routeOutcome`), `reference` (`routeOutcome:<recordID>` or `identitySmoke:<sha256 of the smoke's deciding fields>`), `requestedModel`, `actualModel`, `observedAt`, `detail`, and for an outcome its `pass` and `attempt`. |
| `quarantinedAt` | When the evidence was observed; also the record's `observedAt`. |

Because the time is the evidence's own, the same finding always seals to the same record: recording
it again writes nothing. An outcome-derived entry carries the machine that observed the outcome, so
two machines deriving it write one entry. Entries carry **no record-level `routeKey`**, so the
qualification timeline and the availability views, which select on that field, never see them.

A quarantine is **fleet-wide and effort-wide**: a substitution is a fact about what a provider served
for an identifier, so it holds the route on every machine and at every effort key.

## What a quarantine does

While a route has an entry in force it is excluded, beside any other reason, with a reason of the
form every crc2 exclusion takes:

```
quarantined: claudeCLI:claude-haiku-4-5 is in substitution quarantine (rule csq1) since <time> on 1 recorded substitution(s):
outcomeSubstituted routeOutcome:<recordID> (requested claude-haiku-4-5, answered claude-sonnet-5, <time>). It leaves quarantine
only through cernum quarantine release claudeCLI:claude-haiku-4-5 --reason <text>.
```

It appears in `excluded[].reasons` of `cernum candidates` (crc2, and `--by-effort` cek1), the
fallback chain (cfc1, `--fallback`), `recommend` (crr1 `excluded`, crr2 `exclusions`) and the
status export's candidate and fallback views. The contract shapes are unchanged — the reason is one
more string in an existing array, and with no quarantine entries every answer is byte-for-byte what
it was. A quarantine is an **exclusion, never a verdict**: the route's qualification record and its
capabilities are untouched.

## Commands

| Command | Effect |
| --- | --- |
| `cernum quarantine list [--json]` | Every route that has ever had an entry, its state (`quarantined` or `released`), every entry with its evidence and the release that released it, and every release. Writes nothing. |
| `cernum quarantine release <route> --reason <text> [--machine <cmk1:…>] [--json]` | Appends one sealed `routeQuarantineRelease` observation (`routeKey`, `reason`, `releasedAt`, and `releases`: the recordID of every entry in force). Never deletes. |

A release is refused with exit 2, writing nothing, when `--reason` is missing or blank, when the
route is not `provider:model` (an effort suffix `@…` is refused: quarantine is effort-wide), or when
the route has no entry in force.

A release names exactly the entries it releases. Re-recording the same finding does not undo it; a
**later** substitution is a new entry the release did not name, and quarantines the route again.
Nothing in Cernum releases a route on its own.

## What it does not do

No model, provider or network is contacted. Nothing is selected or launched, and Ordra's routing is
not changed: the quarantine reaches Ordra only as an exclusion reason in the contracts it already reads.
