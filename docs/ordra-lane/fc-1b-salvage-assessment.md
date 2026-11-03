# FC-1b recovery R0: diagnosis and salvage assessment of P-16900 (D-18194)

Goal G-16697@v1 · campaign C-16707@v1 · pass P-18218 · written on `ordra/cernum-integrate-main` at
`d1a755c27cc7265d105f98719030995b464ced1e`.

This document only assesses. It changes no source, test, fixture or existing document. It restores,
checks out, cherry-picks or merges none of the refs it reads. It proposes no provider route and does
not propose running the pack. Everything below comes from `git log`, `git show` and `git diff` over the
three refs, plus the facts stated in the work order.

The three results:

| label | ref | commit | parent | what it is |
|---|---|---|---|---|
| (a) | `ordra/p16900-unverified-20261101` | `0e0d90873d6a728c0120dec9b4b3fbdca2926d63` | `d1a755c` | A-17329's complete FC-1b commit, 40 files |
| (b) | first parent of (c) | `2d4fab0c2ac976b2d5c1e534791ff406a2c800ae` | `d1a755c` | A-18014's fixtures-only commit, 31 files |
| (c) | `ordra/p16900-a18014-uncommitted-20261103` | `0aab72ccaef7388ff931d5f5818015c66102af1e` | `2d4fab0` | A-18014's 11 uncommitted paths, preserved by foreman-ce |

## A note on the criteria this document measures against

The work order gives the text of **G-16697@v1#C2** only: *"npm run typecheck exits 0 with the new
suite, pack, cases and test in place"*, observed by command. It does not give the text of **C1**, and
this session cannot read the Goal Record (TD-5). So the C1 column below measures against the
deliverable the work order and the goal interpretation (WC-3) describe: two more sealed cases in a NEW
offline pack, in domains unrelated to each other and to `ws.d1.asset-container.retitle`, each
declaring `forwardCompatibilityReasoning`. Each case's lossy fix must be shown to pass the visible
suites and be refused by a hidden check, and its preserving fix must be shown to pass. No existing
case, pack, digest, qualification, threshold or routing input may move. That reading is an inference
and is marked as such. Ordra's state should carry C1's text to the next pass (observation, below).

## 1. Why the two attempts ended

- **A-17329 (P-16900 attempt 1, 2026-11-01).** It committed (a) `0e0d908`, but Ordra never verified
  that commit. The owner later decided to return the branch to `d1a755c`, keeping `0e0d908` as
  `ordra/p16900-unverified-20261101`. Outside any pass, foreman-ce observed the following on `0e0d908`:
  - `npm run typecheck` exits 0.
  - The 21 routing/qualification test files (389 tests) pass.
  - `test/engine/workspace-forward-compat.test.ts` and `test/engine/workspace-tier-packs.test.ts`
    (117 tests) pass.

  The full `npm test` was never run on `0e0d908`. Its `docs/ordra-lane/forward-compat-pack.md` shows a
  wrong `--pack` command form (§4).
- **A-18014 (P-16900 attempt 2, 2026-11-02T21:34–22:03Z).** It did not continue from `0e0d908`. It
  rebuilt the work from scratch, with different fixtures for the same two case directories, and
  committed only those fixtures as (b) `2d4fab0`. Its session stopped at 22:03:21Z when the
  subscription's 5-hour usage limit was reached. That left 11 uncommitted paths, which foreman-ce
  preserved as (c) `0aab72c`. Ordra verified the (b)+(c) tree at 2026-11-02T23:08Z:
  - `npm run typecheck` exit 0.
  - `npm test` exit 1, with three recorded failures, all `fixtureDrift` on `workspace/fc-agenda-file`.
    The cause is in §3.

## 2. What each result contains, item by item

Legend: **yes** = present in the ref; **no** = absent; **broken** = present but failing for a stated
cause. "Passes" claims for (a) rest only on foreman-ce's out-of-pass observation (§1). None was run
here (WC-13).

### (a) `0e0d908`: A-17329, complete

| item (C1 reading / C2) | (a) |
|---|---|
| new suite `suite.cernum.workspace.forward-compat@1` | yes: `src/engine/workspace-catalog-forward-compat.ts:43-44`, registered in `src/engine/workspace-catalog.ts` `registeredWorkspaceSuites` |
| new pack `pack.cernum.workspace.forward-compat-one@1` (2 cases × 3 repeats) | yes: defined in `src/engine/workspace-catalog.ts` (`forwardCompatOnePack`), appended last to `registeredWorkspacePacks` |
| case `ws.fc.agenda-file.reschedule`, sealed | yes: `workspace-catalog-forward-compat.ts:158-172`, `expectedTreeDigest: '8bac8b89191f293fb8bdfbed1ec928df3428699e716284fb124b745dc92eb80e'` |
| case `ws.fc.member-roster.transfer`, sealed | yes: `workspace-catalog-forward-compat.ts:234-248`, `expectedTreeDigest: 'b9b48a54e2cdd4c378859623cb7a965c3502a35fcc3c038dd19d97275cc50381'` |
| fixtures | yes: `fixtures/workspace/fc-agenda-file/` (16 files: `docs/FORMAT.md`, `examples/team.agenda`, `src/{components,decode,edit,encode,errors,index,lines,query,time}.js`, `test/{decode,edit,lines,time}.test.js`, `README.md`) and `fixtures/workspace/fc-member-roster/` (16 files: `docs/FORMAT.md`, `docs/ROLES.md`, `examples/platform.roster`, `src/{decode,edit,encode,errors,index,query,roles,table}.js`, `test/{decode,edit,query,table}.test.js`, `README.md`) |
| `forwardCompatibilityReasoning` and `preservationUnderTransformation` declared on each case | yes (asserted by the test at `workspace-forward-compat.test.ts:198`) |
| two hidden checks per case, grounded in a document the fixture carries | yes: quoting `docs/FORMAT.md` (test at `:359`) |
| untiered structural profiles in their own registry, outside routing | yes: `registeredWorkspaceForwardCompatProfiles` (`workspace-catalog-forward-compat.ts:376`), read only by `validateWorkspaceCatalog` and the `cernum workspace` preview (`src/cli/cernum.ts` hunk at old line 1852) |
| lossy fix refused, preserving fix passes, untouched fixture fails | yes: `workspace-forward-compat.test.ts:448,457,466`; reference fixes only in `test/engine/workspace-forward-compat-fixes.ts` |
| three named wrong answers per case, refused | yes: `workspace-forward-compat.test.ts:548,558` |
| scope failures (forbidden test edit, doc edit) | yes: `:482,488` |
| every existing digest pinned to its pre-pass literal, discriminator-one included | yes: `workspace-forward-compat.test.ts:121,129,143` |
| pack count | yes: `test/engine/workspace-tier-packs.test.ts` expects `toHaveLength(5)` |
| engine export | yes: `src/engine/index.ts` adds `export * from './workspace-catalog-forward-compat'` |
| document | yes, with a defect: `docs/ordra-lane/forward-compat-pack.md` (§4) |
| **C2**: typecheck exits 0 with all of it in place | observed exit 0 by foreman-ce outside a pass; not yet Ordra-verified |
| full `npm test` | never run |

### (b) `2d4fab0`: A-18014's fixtures, committed

| item | (b) |
|---|---|
| suite, pack, cases, profiles, test, document | **no**: the commit has no `src/` and no `test/` path ("not yet registered as cases") |
| fixtures | yes, and they are DIFFERENT from (a)'s: `fixtures/workspace/fc-agenda-file/` (16 files: `docs/AGENDA.md`, `examples/offsite.agenda`, `src/{blocks,decode,edit,encode,errors,index,inspect,lines,when}.js`, `test/{edit,encode,lines,when}.test.js`, `README.md`) and `fixtures/workspace/fc-member-roster/` (15 files: `docs/ROSTER.md`, `examples/platform.roster`, `src/{dates,decode,edit,encode,errors,index,inspect,rows}.js`, `test/{dates,edit,encode,rows}.test.js`, `README.md`) |
| contributes to C1 | fixtures only; no sealed case refers to them in (b) |
| **C2** | not applicable on its own: there is no new suite, pack, case or test to typecheck |

### (c) `0aab72c`: A-18014's 11 uncommitted paths on top of (b)

| item | (c) |
|---|---|
| new suite / pack | yes: both in `src/engine/workspace-catalog-forward-compat.ts` (`:46-47`, `:340-350`, pack `forwardCompatOnePack`), registered in `src/engine/workspace-catalog.ts` |
| case `ws.fc.agenda-file.reschedule` | **broken**: `workspace-catalog-forward-compat.ts:192-207`, sealed `105baa30d57d6e9bde7e8991c434db4a91895c9ef058feb3e67f5ab7ee92528e`, which is not the digest of the agenda tree at (c) (§3) |
| case `ws.fc.member-roster.transfer` | yes: `:269-284`, sealed `10a1cdda57e078fa4f5ed9a0ddf09cd52c7e2c77618fba965f7162205ac45c25`. That seal produced no recorded failure, so on the record it matches the roster tree, which (c) leaves exactly as (b) committed it |
| structural profiles, own registry | yes: `registeredWorkspaceForwardCompatProfiles` (`:432`) |
| test | yes: `test/engine/workspace-forward-compat.test.ts` (715 lines), reference fixes inline at `:370-607` |
| pack count | yes: `workspace-tier-packs.test.ts` `toHaveLength(5)` |
| engine export | **no**: `src/engine/index.ts` unchanged |
| CLI preview reads the new registry | **no**: `src/cli/cernum.ts` unchanged |
| document | **no**: no `docs/ordra-lane/` file |
| fixture edits | 7 agenda fixture files edited after (b): `docs/AGENDA.md`, `examples/offsite.agenda`, `src/decode.js`, `src/encode.js`, `test/edit.test.js`, `test/encode.test.js`, `test/lines.test.js` |
| **C2** | typecheck exit 0 (Ordra, 23:08Z), but the agenda case it type-checks fails at runtime |

## 3. The exact cause of the three recorded failures

The three failures:

1. `test/engine/workspace-forward-compat.test.ts`: `ws.fc.agenda-file.reschedule · the PRESERVING fix …`
2. `test/engine/workspace-pack.test.ts`: `digests each fixture to exactly what its case was sealed against`
3. `test/engine/workspace-tier-packs.test.ts`: the test of the same name

All three report that `workspace/fc-agenda-file` digests to
`0aa021d8c4c26e141a52d8bf2f5f70a191f25d6e3b3d6193746f07c78279d710`, not the sealed `105baa30…92528e`.
(The work order's copy of the sealed digest drops the final `e`. The literal at
`0aab72c:src/engine/workspace-catalog-forward-compat.ts:207` is 64 hex digits.)

**Cause: the agenda fixture was edited after it was sealed, and the seal was not re-taken.**

- `git diff 2d4fab0 0aab72c -- fixtures` shows one coherent edit across the seven agenda files listed
  in §2(c): the item field `END` is renamed `UNTIL` everywhere.
  - `docs/AGENDA.md`: the field table row `` `END` `` → `` `UNTIL` ``, and the `reschedule` and
    `setRoom` contract lines.
  - `examples/offsite.agenda`: three `END:2026-…` → `UNTIL:2026-…`.
  - `src/decode.js`: `ONCE`, the required-field list, and `parseWhen(found.UNTIL)`.
  - `src/encode.js`: writes `UNTIL:`.
  - `test/edit.test.js`, `test/encode.test.js`, `test/lines.test.js`: the expectations follow.

  The likely reason for the rename is in `2d4fab0:fixtures/workspace/fc-agenda-file/src/blocks.js:34`:
  the block reader treats ANY line named `END` as a block close
  (`else if (parsed.name === 'END')`). So an item field written `END:2026-03-04T09:20` would be read as
  closing a block called `2026-03-04T09:20`. Renaming the field removes that collision.
- The hidden checks in (c) were written against the renamed format: `AGENDA_FILE` and
  `AGENDA_EDITS_COPY_OTHER_LINES_CHECK` (`workspace-catalog-forward-compat.ts:64-116`), and `AGENDA_CANCEL_REMOVES_ONE_ITEM_CHECK` (`:118`)
  builds on the same `AGENDA_FILE`; use
  `'UNTIL:2026-03-04T09:45'` and `indexOf('UNTIL:…')`. The seal at `:207` was not updated with them.
  The digest 0aa021d8… that the test observed IS the tree at (c). So the sealed 105baa30… is the digest
  of some earlier agenda tree: either (b)'s, or an intermediate state between (b) and (c) that no ref
  records. This session may run only `git` and `npm run typecheck`, so it cannot compute `snapshotTree`
  over (b) to tell which. That check is the first step of pass F1 (§5). The fix is the same either way.
- The roster fixture was not touched after (b), and its seal produced no failure.
- Why each test reports it:
  - `workspace-execution.ts:433-437` refuses a sealed case whose copied fixture tree does not digest
    to `expectedTreeDigest`, with `finishWithFault('fixtureDrift', …)`. That is failure 1: the
    PRESERVING run expects `status` `pass` and gets a harness fault.
  - `workspace-pack.test.ts:71-83` (unchanged, but it iterates `allWorkspaceCases()`, which now
    includes the new case) and `workspace-tier-packs.test.ts:214` compare `snapshotTree(…).treeDigest`
    with the seal directly. Those are failures 2 and 3.
- The same cause should also fail other tests in (c)'s `workspace-forward-compat.test.ts` that rely on
  the agenda seal: the seal test (`:298-305`), the untouched-fixture, LOSSY and scope runs
  (`:658-698`), and the `afterAll` seal check (`:709-715`). The record names one failure per file.
  That matches "three failing test files" better than "three failing tests". If the record really
  means three tests, then this reading of the file and the record disagree, and the full report of
  EV-18099 would settle it.

## 4. The sound base, and what a fix-forward must correct

**Base: (a) `0e0d908`.** Reasons:

1. It is the only complete result. It has the suite, the pack, both sealed cases with fixtures, the
   profile registry, the engine export, the CLI preview, the separate reference-fix module, the
   wrong-answer table and the document. (c) has no export, no CLI preview, no document, and no
   wrong-answer table beyond the lossy fix. (b) has no code at all.
2. It is the only result with recorded evidence that its seals hold. foreman-ce observed both of its
   seal-reading test files pass (117 tests), as well as typecheck exit 0 and the 389
   routing/qualification tests. (c) has a recorded seal failure.
3. Its fixtures do not overlap with (b)/(c)'s. They are different files in the same directories (for
   example `src/time.js`/`docs/FORMAT.md` against `src/when.js`/`docs/AGENDA.md`). Mixing the two is
   not a salvage. It would be a third design, with its own seals to take and prove.

(c) is not discarded. It stays preserved as a ref, and nothing below reads code from it.

**Defects in (a) that a fix-forward must correct:**

| # | file | defect | required correction |
|---|---|---|---|
| D1 | `docs/ordra-lane/forward-compat-pack.md:48` | gives `cernum workspace-benchmark --pack pack.cernum.workspace.forward-compat-one`. The CLI takes the pack as a positional argument (`d1a755c:src/cli/cernum.ts:2222` and `:4812`: `workspace-benchmark <pack-id> --provider p --models a,b`) | write `cernum workspace-benchmark pack.cernum.workspace.forward-compat-one --provider <id> --models <a,b> --dry-run` as the shape of a later, separately approved plan. Name no provider or model |
| D2 | the whole commit | the full `npm test` was never run, so the effect of the 40 files on the rest of the suite is unmeasured (WC-13) | run it as F1's verification. Nothing about it may be claimed until it has run |
| D3 | `0e0d908` itself | not on the branch. The branch is at `d1a755c` by owner decision | re-apply (a)'s 40 paths file for file onto the current head, as a new commit. Do not cherry-pick, merge or check out the ref: write the files from `git show 0e0d908:<path>`, which is the method 1cf851b's "re-apply of 0942745, file for file" used. Doing this needs a pass whose authority grants writes to `src`, `test` and `fixtures` (GR-5) |
| D4 | `test/engine/workspace-forward-compat.test.ts` (in (a)) | any assertion that full `npm test` shows depending on pack or case counts outside the two files foreman-ce ran. `git grep` at `d1a755c` finds no other `registeredWorkspacePacks`/`registeredWorkspaceSuites` length assertion (`workspace-discriminator.test.ts:165` uses `toContain`), and `workspace-pack.test.ts:71` iterates every case, so the new seals must hold there too | none is known. F1 must report each failing assertion it finds, by file and name, before changing anything. Correct it only in the new files, never by editing an existing assertion or literal |

No defect found in (a) calls for weakening a test, a seal, a digest, a criterion or an authoring rule.
None calls for changing an existing case, suite, pack, fixture or digest.

## 5. Proposed recovery: at most three passes

Common to every pass:
- Launch bound at most 3600 s.
- First commit within 15 minutes.
- Writes only to the paths named.
- No benchmark, smoke, discovery or model call.
- Nothing pushed, merged or re-pinned.
- No existing case, suite, pack, fixture or digest changes, and neither does cqp1, crp2, crc2, crr2,
  the discriminator-one pack or any freshness window.
- The pack stays offline, untiered and outside qualification and routing.
- Git: status, diff, log, show, add by name, commit.

### F1: re-apply (a) file for file, and measure it

- **Scope (writes):**
  - the 32 fixture files under `fixtures/workspace/fc-agenda-file/` and
    `fixtures/workspace/fc-member-roster/`
  - `src/engine/workspace-catalog-forward-compat.ts`, `src/engine/workspace-catalog.ts`,
    `src/engine/index.ts`, `src/cli/cernum.ts`
  - `test/engine/workspace-forward-compat.test.ts`, `test/engine/workspace-forward-compat-fixes.ts`,
    `test/engine/workspace-tier-packs.test.ts`
  - `docs/ordra-lane/forward-compat-pack.md`

  Each file is written byte for byte from `git show 0e0d908:<path>`. The only exception is the D1
  line in the document, which is corrected.
- **Before writing:** confirm `git diff d1a755c 0e0d908 -- src/engine/workspace-catalog.ts
  src/cli/cernum.ts src/engine/index.ts test/engine/workspace-tier-packs.test.ts` still applies to the
  current head (`git diff d1a755c HEAD --` on those paths is empty). If it does not, stop and escalate.
- **First commit (≤ 15 min):** the 40 paths, as one commit.
- **Verification:**
  1. `npm run typecheck`
  2. `npm test -- test/engine/workspace-forward-compat.test.ts test/engine/workspace-tier-packs.test.ts test/engine/workspace-pack.test.ts test/engine/workspace-discriminator.test.ts`
  3. `npm test`, run to its result, after the commit
- **Optional diagnostic for the record (§3):** `git diff 2d4fab0 0aab72c --stat -- fixtures` only.
  Computing 105baa30's origin needs a node snapshot of (b)'s tree, which cannot be done without
  checking it out. So it stays an open note, and F1 does not need it.
- **Evidence:** C2 (typecheck exits 0 with the new suite, pack, cases and test in place) as an Ordra
  verification of a commit on the branch. C1 (on the reading in the opening note): the seal,
  lossy/preserving and wrong-answer tests pass, and every existing digest is pinned unchanged.
  Then the full `npm test` result, recorded either way.

### F2: only if F1's `npm test` fails: correct, in the new files only

- **Scope (writes):** only the F1 paths that the failing assertions name, and only the new files
  among them (`src/engine/workspace-catalog-forward-compat.ts`,
  `test/engine/workspace-forward-compat*.ts`, the two new fixture directories). Changing a fixture
  means re-sealing its case at `workspace-catalog-forward-compat.ts:172` or `:248`. The new value
  must be the digest the seal tests observe, recorded in the commit message, and the change must be
  justified by a failing assertion. An existing file's assertion may not be edited. If the cause lies
  in an existing case, suite, pack or digest, stop and escalate.
- **First commit (≤ 15 min):** the first correction, with its failing assertion named in the message.
- **Verification:** the F1 commands 1–3.
- **Evidence:** the same C1/C2 evidence as F1, now with `npm test` exit 0.

### F3: close the record

- **Scope (writes):** `docs/ordra-lane/forward-compat-pack.md`, plus a pointer line in
  `docs/ordra-lane/fc-1b-salvage-assessment.md` naming the F1/F2 commits. README.md is outside the
  campaign's scope and is not touched, even though the engine test-file count it states moves by one.
- **First commit (≤ 15 min):** the document correction.
- **Verification:** `npm run typecheck`, and
  `npm test -- test/engine/workspace-forward-compat.test.ts`.
- **Evidence:** C1's documentary half: the pack, its cases, its offline/untiered status and the
  correct (unexecuted) command form. C2 re-observed.

If F1 passes with `npm test` exit 0, F2 is skipped, and F3 may be folded into F1. That is within the
goal's budget of one pass and one spare.

## Observations

- **O-a.** C1's text is not in the work order, and §2 measures against an inferred reading. The
  compiled context should carry each criterion the pass is asked to assess against.
- **O-b.** The recorded "three failures" fit three failing files better than three failing tests (§3).
- **O-c.** A-18014's fixtures (b)/(c) are a coherent alternative design (the `blocks.js` collision fix
  is a real improvement for its own format). They are not needed, because (a)'s fixtures were sealed
  and observed passing.
