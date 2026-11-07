# Process-group termination and matrix signal handling

IO-2 P1 (G-24301 C0, P-24312), on base 64750c0.

## What was wrong

`runCLI` (src/engine/cli-process.ts) starts every command `detached`, so it leads its own
process group. Before this pass, `OwnedProcess.terminate()` did nothing if the leader had already
exited, and sent the SIGKILL only if the leader was still alive. `runCLI` settled on `close`, and
`close` waits for every process holding stdout or stderr. So a tool that exited 0 and left behind a
helper that ignored SIGTERM and kept the pipe open was never stopped, and the run never settled.
`cernum workspace-benchmark` also installed no SIGINT/SIGTERM handler, so Ctrl-C ended Cernum and
left every detached agent and verification command still running.

## What happens now

- **The group is signalled, not the leader.** `terminate()` sends SIGTERM to `-pid`, then SIGKILL
  to `-pid` once the grace period has passed. It does not check whether the leader is alive. A
  process group lasts as long as any member is alive, and its id cannot be reused while it lasts,
  so this reaches the survivors and nothing else. The fallback to the bare pid is used only while
  the leader has not been reaped.
- **When signalling happens:** at the deadline (`timeout`), on cancel (`shouldCancel`, polled), and
  when the leader exits while any group member is still alive (checked with `kill(-pid, 0)`). A
  well-behaved tool leaves an empty group behind, and nothing is sent to it.
- **Settling has a bound.** After the group has been told to stop, or after the leader has exited,
  `runCLI` resolves within the grace period plus `PIPE_DRAIN_MILLISECONDS` (500 ms). It resolves
  even if some holder outside the group (for example one that called `setsid`) still has the
  pipes open. In that case the streams are destroyed and the leader's own exit code and signal are
  reported.
- **A SIGKILL that is still owed is not cancelled.** If members remain when the run settles, they
  are sent SIGTERM and their SIGKILL timer is left running. That timer is `unref`'d.
- **Nothing changes for well-behaved children.** Exit code, stdout, stderr, first-output timing
  and failure kinds are the same as before, and the run still settles on `close`.

## Signals during `workspace-benchmark`

`installMatrixSignalHandlers()` (cli-process.ts) adds handlers for SIGINT and SIGTERM. On the
first signal it sets the flag that is passed to `runWorkspaceMatrix` as `shouldCancel` and calls
`terminateAllCLIProcesses()`. The run in flight is stopped and sealed, and every later cell is
recorded with disposition `cancelled`. The command removes both handlers when the matrix promise
settles, whether it succeeded or failed (`.finally(dispose)`).

## Evidence

`test/engine/cli-process-group.test.ts` uses fixture `sh -c` children only. Each one runs
`trap '' TERM; sleep 60 &`, which leaves a grandchild that ignores SIGTERM and holds stdout, and
prints its pids. The test checks those pids with `process.kill(pid, 0)` and expects ESRCH. It
covers (a) a leader that exits 0, (b) a deadline while the leader is alive, (c) cancel, (d) a
cancelled matrix run with a fake driver plus the signal-handler install and removal, and (e)
well-behaved children. Every pid it sees is SIGKILLed in `afterEach`.
