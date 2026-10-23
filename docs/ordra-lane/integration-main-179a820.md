# Integration of GitHub main 179a820 into ordra/cernum-integrate-main

Pass P-4794, goal G-3531@v1, block 2 item I-1.

## The merge

- Lane head before the merge: `aa1b43f0295331db417b2697a04d281b73cae88c`
- GitHub main merged: `179a820dbdbb6d37a671bd9bb71781a968177afd` (the local copy; nothing was fetched)
- Command: `git merge --no-ff 179a820dbdbb6d37a671bd9bb71781a968177afd`
- Merge commit: `593d6332f2d2621d7c0e7ffc7cf01b09b54047c6`, parents `aa1b43f` (lane) and `179a820` (main)
- Main's commits brought in: 65874df, e57a1f7, 4378192, 640c2d2, 7ac4ae7, 179a820
- Result: 94 files changed, 1461 insertions, 141 deletions relative to the lane head

## Conflicts

**There were no textual conflicts.** Git's ort strategy auto-merged the three files that both sides
had touched:

| File | Lane side | Main side | Result |
| --- | --- | --- | --- |
| `README.md` | discovery-run / discovery-schedule documentation | the clone line now targets a `cernum` directory and is followed by `cd cernum`, with a note about the repository slug | both kept; main's naming wins at the clone/`cd` lines, which is where the lane would otherwise have needed a fix |
| `src/cli/cernum.ts` | `discovery-run`, `discovery-schedule`, provider allowlist cpa1 output | imports `displaySuiteTitle` and uses it in `cernum suites`, so a sealed suite title prints without the old name | both kept |
| `test/engine/installed-command.test.ts` | lane's async CLI changes | Cernum launcher names, `CERNUM_CAMPAIGN_ROOT` with the legacy alias still tested | both kept |

Main's cli-process executable-lookup seam (`DEFAULT_SYSTEM_EXECUTABLE_DIRECTORIES`,
`overrideSystemExecutableDirectories`) went in without conflict. The V1.0.0 release files
(`docs/RELEASE-NOTES-v1.0.0.md`, `scripts/releases/install-cernum-v1.0.0-*.sh`), `docs/NAMING.md`,
the naming audit and `test/engine/naming-guard.test.ts` came in as new files.

## What the merge broke, and the fix

After the merge, the naming guard (`test/engine/naming-guard.test.ts`) failed one test, *finds the
old name only in allowlisted files*. It flagged `test/engine/evidence-root.ts`, a lane-only file
added in 563c52c, because its first comment line called the evidence by the old product name. The
real directory name in that file is the sealed `...-results` identifier that the guard already
allows, so only the comment counted.

Fix (a follow-up commit, not part of the merge): the comment now reads "Where the sealed evaluation
evidence lives on this machine." No code or path changed. The guard, its regex, `SEALED_PATHS`,
`SEALED_IDENTIFIERS` and `ALLOWED` are as main left them.

This document avoids the old name on purpose, because `docs/ordra-lane/` is not a sealed path.

## Verification run by the worker (a claim; Ordra's own run is the evidence)

- `npm run typecheck`: exit 0
- `npm test -- test/engine/naming-guard.test.ts`: 6/6 passed (after the fix; 1 failed before it)
- `npm test -- test/engine/discovery-run.test.ts`: 9/9
- `npm test -- test/engine/provider-discovery.test.ts`: 23/23
- `npm test -- test/engine/lock.test.ts`: 27/27
- `npm test -- test/engine/cli-argument-safety.test.ts`: 21/21
- `npm test -- test/engine/provider-allowlist.test.ts`: 12/12
- `npm test -- test/engine/opencode-discovery-regression.test.ts`: 18/18
- `npm test -- test/engine/discovery-schedule.test.ts`: 28/28

The whole suite was not run; it runs at the block's gate.
