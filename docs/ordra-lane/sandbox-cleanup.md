# Sandbox cleanup and the stale-sandbox sweep

IO-2 P2 (G-24301 C1, P-24481), on P1's checkpoint e297733.

## What was wrong

Each workspace attempt gets its own directory, `<sandboxRoot>/cernum-ws-<case>-<n>-<random>`,
from `mkdtempSync` in `src/engine/workspace-execution.ts`. Before this pass the only code that
removed it was the `rmSync` at the end of `finalizeWorkspace`. Three paths skipped that call:

- A `WorkspaceExecutionError` thrown during the attempt was rethrown with no cleanup.
- If writing evidence failed inside `finalizeWorkspace`, the catch block turned that into
  `finishWithFault('harnessThrew')`. That called `finalizeWorkspace` again on the same evidence
  root, which usually failed the same way. The second error then escaped, replacing the first,
  and the attempt root was left on disk.
- A process that was killed, or a host that restarted, never reached the cleanup at all. Nothing
  ever removed the directories it left behind.

## What happens now

- **The attempt root is removed in a `finally`.** `runOneAttempt` creates the root and passes it
  to `runAttemptInside`. Its `finally` removes the root on every path: success, failure, a harness
  fault, a thrown `WorkspaceExecutionError` and a failed evidence write. If the removal itself
  fails, that error is dropped so it cannot replace the attempt's own result or error. The
  directory is then left for the sweep below.
- **`--preserve-failed` works as before.** `finalizeWorkspace` decides whether to keep the root
  with the same rule as before (the attempt failed, and `preserveFailedWorkspaces` is on). It sets
  `preservedAt` on the record and tells the `finally` to keep the root. It makes this decision
  before writing any evidence, so a failed, preserved attempt is still kept if the evidence write
  then fails.
- **A failed evidence write is thrown once.** `finalizeWorkspace` throws
  `WorkspaceExecutionError('evidenceWriteFailed')`, and the message includes the original error.
  The catch in `runAttemptInside` rethrows every `WorkspaceExecutionError` unchanged, so
  `finalizeWorkspace` is never called a second time. `WorkspaceCampaign.run` records the throw as
  `workspaceRunFaulted` and rethrows it, as it does for any other execution error, and the matrix
  lists the cell as `harnessFault`.

## The stale-sandbox sweep

`sweepStaleWorkspaceSandboxes(sandboxRoot, { maximumAgeMilliseconds?, onRemoved? })` is exported
from `workspace-execution.ts`. The default age is `STALE_WORKSPACE_SANDBOX_AGE_MILLISECONDS`, which
is 6 hours. An entry is removed only if all of the following are true:

- it is a direct child of the sandbox root's real path. Nothing above or beside the root is read.
- its name starts with `cernum-ws-` (`WORKSPACE_ATTEMPT_ROOT_PREFIX`).
- `lstat` reports a directory. A symlink is never followed and never removed.
- its modification time is more than the stated age before the wall clock.

Removal uses `rmSync(recursive)`, which deletes a symlink inside the directory without following
it. The sweep never creates a sandbox root that does not exist. If one removal fails, the sweep
records it in `failures` and goes on to the next entry. The result also lists `removed`,
`keptYounger` and `ignored`.

`runWorkspaceMatrix` runs the sweep once, before its first cell, on `request.sandboxRoot`.
`assertSandboxRootIsSafe` is checked first. If the root would be refused (it is inside a Git
working tree, or it overlaps the fixtures), the sweep is skipped and the first cell reports the
refusal. The age is compared with the wall clock, not with `request.now`, because a file's
modification time is wall-clock time. Three new `WorkspaceMatrixRunOptions` fields control it:

- `staleSandboxAgeMilliseconds`, which defaults to six hours.
- `onStaleSandboxRemoved(removal)`, called once for each directory removed.
- `onStaleSandboxSweep(sweep)`, called once with the whole result.

`cernum workspace-benchmark` uses these callbacks to report through its usual output. It prints
`removed stale sandbox <path> (<n> min old)` for each removal and
`could not remove stale sandbox <path>: <reason>` for each failure.

**Why six hours.** The default sandbox root (`os.tmpdir()/cernum-workspace-sandbox`) can be shared
by matrices running at the same time. An attempt root another process is using right now must
survive the sweep. Each attempt is bounded by its own timeout, which is far shorter than six hours.
Note that the root's modification time only changes when an entry is added directly under it, so a
single attempt still running after six hours could be swept. Nothing in the current catalogue runs
that long.

## Tests

`test/engine/workspace-sandbox-cleanup.test.ts` uses scripted drivers, an injected `runCommand`
that starts no process, and an injected execution sandbox. It covers the following:

- (a) the sandbox root is empty after a success, a failure, a `harnessThrew`, a thrown
  `WorkspaceExecutionError`, and an evidence root that throws, with and without a harness fault.
  The evidence-root case reports the original `ENOTDIR`.
- (b) `--preserve-failed` keeps failed attempts, removes a passing one, and keeps a failed attempt
  whose evidence write failed.
- (c) stale `cernum-ws-*` directories are removed; fresh ones, other names and a stale
  `cernum-ws-*` regular file are kept. A stated age is honoured, and a missing root is not
  created. The sweep runs at matrix start, before the first cell, and each removal is reported
  through the callback.
- (d) a stale `cernum-ws-*` symlink is neither followed nor removed. A symlink inside a stale
  directory is deleted without touching its target. A root reached through a symlink is swept at
  its real path, and siblings of that path are left alone.
