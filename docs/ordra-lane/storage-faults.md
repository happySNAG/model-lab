# Storage faults and torn writes (IO-2 P3, G-24301 C2)

A disconnected or full drive must end a workspace matrix with a controlled failure, never a corrupt
run, and an incomplete write must never be read as a result. This pass adds three things.

## 1. The root check before any cell

`runWorkspaceMatrix` calls `assertWorkspaceStorageRoots` before the stale-sandbox sweep and before any
cell. The campaign (record) root and the sandbox root must each:

- exist (a `stat`; a missing root gives its own `ENOENT`),
- be a directory, and
- accept a write-and-remove probe (`.cernum-write-probe-<pid>-<random>`, written with `wx`, fsynced,
  closed and unlinked).

If either check fails the matrix throws `WorkspaceMatrixError('storageRootUnavailable')`. The message
names the root and the errno. No driver is built or called, and no directory is made.

Neither root is ever created here, because a missing root is usually a drive that is not mounted. If
the matrix created it, the campaign's records would land on whatever volume now sits at that path.
`cernum workspace-benchmark` creates only its own defaults, the per-user campaign directory and the
sandbox under the OS temp directory, and only when the operator did not name them with `--root`,
`--sandbox` or the campaign-root environment override. The CLI reports a refusal as
`storageRootUnavailable: …` and exits 6.

An unsafe sandbox root (one inside a Git working tree, or one that overlaps the fixtures) is not
probed. Nothing is written into somebody's checkout to test it. The first cell reports that refusal as
it did before.

The campaign root is probed again before every runnable cell, before that cell's driver exists. A drive
unplugged between cells is therefore caught with its own errno. Without this probe,
`WorkspaceCampaign.create` would silently re-create the root.

## 2. `storageUnavailable`: a storage fault stops the matrix

`WorkspaceCellDisposition` gains `storageUnavailable`. An error from a cell counts as a storage fault
on the record root when its code is `ENOENT`, `EIO`, `ENOSPC` or `EROFS`, and either its path is inside
the campaign root (in either spelling, as given or as its real path) or it names no path at all (this
is how `write(2)` reports a full disk). The error can come from the cell's `WorkspaceCampaign.create`,
its `run`, its seal, or the per-cell probe. `storageFaultOf` checks the error itself, its `cause` chain
(`evidenceWriteFailed` now carries the original errno as `cause`) and the `recordWriteFailure` described
below. When the error is a storage fault:

- **That cell** is recorded as `harnessFault`, and its single reason is the original error's message,
  unchanged.
- **Every later cell** is recorded as `storageUnavailable` and is never started. No driver is built or
  called, and no directory is made. Its reason names the record root, the errno and the cell that met
  it.
- `WorkspaceMatrixRunResult.storageFault` holds the cell, the code, the path when there is one, and the
  original message. `onStorageFault` is called once. `describeWorkspaceMatrixRunResult` prints a
  `storage` line. The CLI prints the fault as it happens and lists each later cell as `NOT EXECUTED`.

A `storageUnavailable` cell is a storage fact about this machine. It is not a provider decline or a
model failure, and it is counted in `notExecutedForOtherReasonCount`. If nothing goes wrong,
`storageFault` is absent from the result (the key is not written), so the result is the same as before.

**Every other cell fault keeps today's behaviour.** The cell is recorded as `harnessFault` and the
matrix moves on to the next cell. Examples: an `ENOENT` on a fixture, an `EACCES` or `ENOTDIR` on the
record root, a refused admission, a missing fixture.

### The faulted-event write is guarded

`WorkspaceCampaign.run` writes `workspaceRunFaulted` to the ledger when the host throws. On a failing
disk that write fails too. Previously its throw escaped and replaced the error that explained the cell.
Now the write is wrapped:

- The original error is always the one rethrown.
- The second failure is attached to it as a non-enumerable `recordWriteFailure`.

So the cell keeps its own reason, and the matrix can still see that the record root broke. If the
second failure is a storage fault, the matrix stops as described above.

## 3. The ledger: torn tails, unique temporaries, an fs seam

All changes are in `src/engine/ledger.ts`:

- **The torn-tail repair runs before every append.** `appendResult` and `event` now go through
  `appendLine`, which first calls `repairTornTail`. Every row is newline-terminated and written in one
  call, so a file that does not end in a newline ends in a row that was never completely written.
  `repairTornTail` truncates that file back to its last newline (to empty if there is none) and fsyncs
  it, then the new row is appended. The repair is recorded as a `repairedTornWrite` anomaly.
  Previously, a half row followed by another append became a corrupt *non-final* line, which `load()`
  refuses to guess about, so the ledger could not be opened. `load()` itself is unchanged: it still
  repairs a torn final row and still refuses a corrupt non-final one.
- **`events()` skips a torn final event.** It does not return a final line that has no newline yet.
- **`atomicWriteJSON` uses a unique temporary name.** The name is `<file>.<pid>-<random>.tmp`, in the
  target's own directory, opened with `wx`. If anything fails between creating it and renaming it
  (open, write, fsync, close, rename), the temporary is unlinked and the original error is rethrown.
  A failed write leaves no `.tmp` file and leaves the previous file intact.
- **There is a file-system seam.** `LedgerFileSystem` is the subset of `node:fs` the ledger uses. It is
  an optional last parameter of `new Ledger`, `Ledger.create`, `Ledger.open`, `atomicWriteJSON` and
  `repairTornTail`, and it defaults to `node:fs`, so production behaviour is unchanged.
  `WorkspaceCampaignInputs.recordFileSystem` and `WorkspaceMatrixRunOptions.recordFileSystem` pass the
  seam through to each record's manifest, case, ledger and derived record. Tests use it to simulate
  `ENOSPC` after a partial write without filling a disk.

## Evidence

`test/engine/workspace-storage-faults.test.ts` runs with fake drivers, an injected `runCommand`, the fs
seam, and temporary roots under `os.tmpdir()` that are removed in `afterEach`. It covers:

- **(a)** A removed campaign root, a removed sandbox root, and a root that is a file are each refused
  with `storageRootUnavailable` naming the root. No driver is called and nothing is created. Writable
  roots pass, and the probe leaves nothing behind.
- **(b)** A root removed during a run: that cell keeps the original `ENOENT`, the five later cells are
  `storageUnavailable`, and there is exactly one driver call. A root removed between runs: the next
  cell meets the `ENOENT` before its driver exists, and the root is not re-created. A faulted-event
  write that fails with `EIO`: the cell keeps its `fixtureMissing` reason and the matrix stops on the
  `EIO`. The `storageFaultOf` classification is also tested.
- **(c)** An `ENOSPC` that writes half a row then throws: the next append and a fresh `Ledger.open`
  succeed, the half row is not a result, and the slot can still be recorded once. The same holds for
  `events.jsonl`. `repairTornTail` edge cases are also tested.
- **(d)** `ENOSPC` mid-write, `EIO` on fsync and `EIO` on rename each leave no `.tmp` file and the
  previous file intact. A failed checkpoint rewrite leaves no `.tmp` file. Temporary names are unique
  and in the target's directory.
- **(e)** An `EACCES` on the record root and an `ENOENT` outside it each fault one cell, and the five
  later cells all run.
