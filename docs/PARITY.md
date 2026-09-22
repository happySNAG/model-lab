# The parity corpus

`fixtures/parity/` is a **frozen reference corpus**: 3.4 MB of JSON produced by a separate,
independently written Swift implementation of the same benchmarking engine. `test/parity/`
re-computes each of those values with the TypeScript engine in `src/core/` and asserts byte-for-byte
equality — 157 assertions across 9 fixture files and a complete on-disk evidence store.

This page explains what that does and does not prove, because it is the one part of the repository
whose provenance is not reproducible from this repository alone.

## Why a second implementation exists

The engine was written twice, in two languages, from the same specification. Determinism is the
whole product here: a benchmark result is only meaningful if the same inputs always produce the same
digests, the same plans, the same judgments and the same bytes on disk. Two independent
implementations agreeing to the byte is much stronger evidence of that than either one's own tests.

The Swift implementation is the older of the two and belongs to a private project. It is **not** part
of this repository and is not required to build, run, test or package Cernum.

## What the corpus pins

| Fixture | What the TypeScript engine must reproduce exactly |
| --- | --- |
| `digest.json` | FNV-1a 64 vectors, canonical-JSON encoding, seal format |
| `normalization.json` | Text normalization used by every evaluator |
| `catalog.json` | Every suite and scoring policy identity, and the catalog digest |
| `plans.json` | Run plans: attempt order, identities, budgets |
| `executed.json` | Whole executed bundles under a fixed clock and synthetic environment |
| `evaluations.json` | Deterministic judgments, including missing-evidence and hard-boundary outcomes |
| `views.json` | Capability profiles, side-by-side grids, recommendations, comparability verdicts |
| `ollama.json` | Ollama request bodies and response decoding, including every failure shape |
| `store/`, `store-summary.json` | A complete evidence store: envelope digests, file names, manifest |

## What it does not prove — read this before trusting the script

The corpus is a **snapshot**, captured at one point in the Swift implementation's life. Since then
the Swift side has moved on: it has gained benchmark cohorts and execution-envelope facets that were
never ported here. Running the regeneration script against a current Swift checkout therefore
produces a *different, larger* corpus that this port does not implement, and the parity suite would
fail — not because the port is wrong, but because the two implementations are no longer the same
vintage.

So, concretely:

- The corpus proves the TypeScript engine is byte-equivalent to the Swift engine **as it stood when
  the corpus was captured**. That is a real and complete proof for every behaviour Cernum ships.
- It is **not** a live conformance check against whatever the Swift implementation does today.
- The fixtures are therefore **never regenerated and never hand-edited**. They are treated as sealed
  test data. A change to `src/core/` that moves any of these bytes is a change to the engine's
  observable behaviour and must be deliberate.

### The one approved rebaseline — Cernum REQ-03 Phase 6, 2026-09-16

`catalog.json` has been **extended once**, by explicit human approval, and the rule above still holds
for every byte it already contained.

Cernum adopted a second scoring policy generation: the Pass 10 Gate D hybrid governance matcher and
the REQ-03 Phase 5 narrowed capability repair, frozen together as version 2. Registering that
generation makes the shipped policy registry larger than the Swift vintage, which the registry-size
assertion had pinned at 42. The two requirements genuinely conflicted, and a person chose.

What the rebaseline did, precisely:

- **Nothing Swift-derived moved.** All 42 captured policies keep their canonical JSON, their digests
  and their order. The sub-catalog they form still seals to `mlspc1:42c16e06a941b143`, and the
  regeneration script *refuses to run* if it does not.
- **The 40 generation-2 twins were added** in a separate `postVintagePolicies` section, with
  `registryCatalogDigest` pinning the whole 82-policy registry.
- **The assertion got stronger, not weaker.** The vintage is still compared byte for byte, and the
  additions — previously just the reason a test failed — are now pinned too.

`postVintagePolicies` carries **no cross-implementation claim**. Those rows exist only in TypeScript;
they are pinned against regression, not against a second engine. The fixture's `rebaseline` block
records that in the corpus itself. Regenerate it only under the same kind of explicit approval, with
`scripts/req03-phase6-rebaseline-parity.ts`.

The same sealing applies to the benchmark suites themselves: their titles, system prompts and
provenance strings are part of the pinned bytes. A few of them still carry the name of the private
project the engine was first written for — see *Known limitations* in the [README](../README.md).
Editing them to read better would silently invalidate every result already recorded on every user's
disk, so they are left exactly as they are and the interface presents neutral titles over them
(`displaySuiteTitle` in `src/shared/ipc.ts`).

## Maintainer scripts

`scripts/maintainer/` holds the two scripts that talk to the Swift implementation. **They cannot run
against this repository alone** — they expect a checkout of the private Swift project as the parent
directory — and they are kept for the maintainer's reference, not as part of anyone's workflow:

- `regenerate-parity-fixtures.sh` — regenerates the corpus from a Swift checkout. Given the vintage
  drift described above, running it today against current Swift **will** break the parity suite.
  Nothing in the public release depends on it.
- `verify-store-with-swift.sh` — the reverse direction: writes an evidence store with this engine and
  has the Swift CLI validate every envelope digest.

Everything a contributor needs — `npm test` included — runs entirely from this repository.
