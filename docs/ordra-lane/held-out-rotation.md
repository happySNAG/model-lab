# Held-out rotation (cho1)

`src/engine/held-out-rotation.ts` (R-22, G-25029 C3) makes fixture leakage measurable: it splits a
pack's cases into a rotating **held-out** set and an **exposed** set, and reports which held-out cases
already appear in run rows.

## The functions

```ts
deriveHeldOutPartition(cases: HeldOutCaseInput[], { epoch, heldOutCount }): HeldOutPartition
caseExposure(rows: { row: Record<string, unknown> }[], partition: HeldOutPartition): CaseExposureReport
heldOutCaseInput(workspaceCase: WorkspaceCase): HeldOutCaseInput   // { id, caseDigest: workspaceCaseDigest(case) }
```

### Inputs

- **cases** — `{ id, caseDigest }` per case. For a registered pack, resolve it
  (`resolveWorkspacePack(workspacePackByID(id), allWorkspaceCases())`) and map with `heldOutCaseInput`.
  Ids and digests must be non-empty and unique.
- **epoch** — a non-empty string or a non-negative integer (`7` and `'7'` are the same epoch). No default.
- **heldOutCount** — an integer, at least 1 and fewer than the number of cases. No default. Anything
  else, including a count at or above the case count, is refused with a thrown error.
- **rows** — workspace run rows (as `collectWorkspaceRunRows` returns them); only `row.caseDigest` is read.

### The partition

Each case is ranked by `sha256(`${caseDigest}:${epoch}`)` (lowercase hex; ties broken by id). The
`heldOutCount` lowest-ranked cases are `heldOut`; every other case is `exposed`. Both lists are case ids
sorted by code point; `cases` lists every case in rank order with its `rankKey` and `part`. The result
carries `schema: 'cho1'` and the epoch as text.

The same cases and epoch always give the same partition, in any input order. A new epoch re-ranks
every case, so the held-out set rotates without being chosen by hand; a case whose digest changes is
re-ranked with it.

### The exposure report

`caseExposure` counts run rows per `caseDigest` (`runsByCaseDigest`, every digested row whatever its
status — over-reporting exposure is the safe direction) and lists each partition case with `runs` and
`heldOutExposed` (true only for a held-out case with at least one run). `exposedHeldOut` names the
leaked held-out cases; `unmatchedRows` counts rows whose digest names no case in the partition, and
`undigestedRows` rows with no `caseDigest`.

## What it does not do

- **It is not enforced.** Qualification (cqp1) does not consult a partition. An exposed held-out case is
  reported, never refused, excluded from evidence or used to change a verdict.
- **It changes no case, pack, digest or qualification input.** Both functions are pure; they write,
  install and route nothing. The test pins the discriminator-one and forward-compat-one pack digests
  (`cwp1:`) to literal values before and after partitioning.
- **It adds no case or category**, no CLI verb and no cycle wiring, and makes no model call.
