# Discovery cadence (cds2) — two generated, never installed, discovery jobs

Block 3, B3-3. `generateDiscoveryCadence` in `src/engine/discovery-schedule.ts` extends the
[discovery schedule](discovery-schedule.md) (cds1) with schema **cds2**, which generates two launchd
jobs instead of one:

| Job | Label | Started by launchd | Runs | Quiet hours | Refuses at memory pressure |
| --- | --- | --- | --- | --- | --- |
| light provider listing | `<prefix>.listing` | every 6 hours (`StartInterval` 21600) | `discovery-run` over the listing providers, by default `anthropicAPI claudeCLI codexCLI` (catalogue discovery ccd1's providers) | not checked | 4, critical |
| nightly full reconciliation | `<prefix>.reconciliation` | once a day at the start of the window (`StartCalendarInterval` `Hour`/`Minute`) | `discovery-run` over every provider it refreshes | checked by the guard, as in cds1 | 2, warning |

The default prefix is `com.cernum.discovery`. Each job has its own plist and zsh guard
(`discovery-cadence-<job>-guard.zsh`) and its own log (`discovery-cadence-<job>.log`). Both run
`/bin/zsh <guard>` as a `Background` job with `LowPriorityIO`, `RunAtLoad` false, no `KeepAlive`, and
`PATH` `/usr/bin:/bin:/usr/sbin:/sbin`.

**Nothing is installed, loaded or enabled.** The generator is pure. `writeDiscoveryCadence` writes the
four files into the directory the cadence was generated for, and refuses to write anything when that
directory is or is under one launchd reads jobs from (`~/Library/LaunchAgents`, `/Library/LaunchAgents`,
`/Library/LaunchDaemons`, `/System/Library/LaunchAgents`, `/System/Library/LaunchDaemons`, including
through a symbolic link) or when any of the four files already exists. No file names `launchctl`.
Installing either job is a separate human act by the owner.

cds1 is unchanged. `generateDiscoverySchedule` and `cernum discovery-schedule` produce the same bytes
as before cds2. `fixtures/discovery-schedule/cds1/` holds that output, recorded before cds2 was added,
and the cadence test compares against it byte for byte.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `root`, `cernum`, `directory` | required | As in cds1. Absolute paths. The backoff state lives in `directory`. |
| `window` | `02:00-05:00` | The reconciliation's quiet hours, local, start inclusive, end exclusive, may wrap past midnight. |
| `floorGiB` | `6` | Whole GiB that must be free on `/` for either job. **Never below 6.** A lower value is refused and nothing is generated. |
| `labelPrefix` | `com.cernum.discovery` | Reverse-DNS prefix of both labels. |
| `listingProviders` | `anthropicAPI`, `claudeCLI`, `codexCLI` | The light listing's providers. Must not be empty, because an empty list would make it a full reconciliation every 6 hours. |
| `reconciliationProviders` | none, meaning every provider | The reconciliation's providers. |
| `backoff.baseMinutes` | `30` | The first wait after a rate-limited run. Whole minutes, at least 1, no more than the cap. |
| `backoff.capMinutes` | `1440` (24 hours) | The longest wait. Whole minutes, at most 10080 (a week). |

## The guards

In order, each check either refuses or passes. A refusal logs a timestamped
`REFUSED, discovery-run not started: <reason>` line and exits with its own code.

| Check | Refuses when | Exit |
| --- | --- | --- |
| limits | the floor was hand-edited below 6 GiB, the pressure threshold is not a level from 1 to 4, or the backoff base exceeds its cap | 14 |
| quiet hours (reconciliation only) | the local time is outside the window | 10 |
| rate-limit backoff | the shared backoff state says a wait is still in force, or the state cannot be read | 15 |
| free space | `df -Pk /` reports less available than the floor | 11 |
| memory pressure | `kern.memorystatus_vm_pressure_level` is at or above the job's threshold | 12 |
| another run | a live process holds `<root>/.discovery-run/campaign.lock`, or the lock names no pid | 13 |
| executable | `cernum` is not an executable | 14 |

As in cds1, a check whose input cannot be read refuses (exit 14). It does not pass.

### Memory-pressure guard

macOS reports memory pressure as 1 (normal), 2 (warning) or 4 (critical). The light listing refuses
only at critical, like cds1. The reconciliation probes every provider, including the local runtime, so
it refuses from warning onwards. The threshold is generated into each guard, and the guard refuses a
hand-edited value outside 1 to 4.

### Rate-limit backoff

When every check passes, the guard runs `discovery-run --json`, logs its one-line summary, and reads
only the details of the summary's `providersNotAnswered` entries. If one of them contains a marker from
the engine's list of exhausted-allowance and throttle markers (`ALLOWANCE_EXHAUSTION_MARKERS` in
`attempt-disposition.ts`, for example `rate limit`, `too many requests`, `usage limit`), or `429`, the
run counts as rate-limited. The guard then writes `consecutive=<n> not_before=<epoch seconds>` to
`discovery-cadence.backoff`:

- the wait is `base × 2^(n−1)` minutes, never more than the cap (with the defaults: 30, 60, 120, … up to
  1440 minutes);
- both jobs read this one state file, so a rate limit seen by the listing also holds back the
  reconciliation, and the reverse;
- a run that completes (exit 0) with no rate-limited provider removes the file;
- a run that fails for another reason (for example `discovery-run`'s own lock refusal, exit 4) leaves
  the file as it was, and the guard exits with `discovery-run`'s status;
- a state file the guard cannot parse is replaced with a wait of the full cap and the run is refused.
  Not knowing the backoff is not the same as there being none.

A marker found anywhere else in the summary, such as in a route key or a count, does not start a
backoff.

## What the tests pin

`test/engine/discovery-cadence.test.ts`:

1. cds1's plist and guard, for a default and a fully named option set, are byte-identical to
   `fixtures/discovery-schedule/cds1/`, and cds1's refusal codes are unchanged.
2. There are two jobs. The listing uses `StartInterval` 21600 with no calendar entry and no window
   check. The reconciliation uses one daily calendar entry at the window start and checks the window,
   including a window that wraps past midnight. The tests also check default providers, labels and
   input refusals.
3. The 6 GiB floor is the default and the minimum, is re-checked at run time, and is refused below 6.
   The memory-pressure thresholds are 4 and 2, and every refusal code is distinct.
4. The backoff defaults are 30 and 1440 minutes, with a week as the maximum cap. Invalid bases and caps
   are refused.
5. Nothing is installed. No file names `launchctl` or `LaunchAgents`, and the writer refuses
   `~/Library/LaunchAgents` (directly, beneath it and through a symbolic link) and the system job
   directories. It writes nothing if any file exists, and the module imports nothing that could start
   a process.
6. The generated guards are **executed** under `/bin/zsh`, but only against fakes. A temporary
   directory first on `PATH` holds fake `date`, `df`, `sysctl` and `launchctl`, and a fake `cernum`
   prints a canned summary and records its arguments. The tests cover:
   - each job's providers;
   - the window applying to the reconciliation only;
   - the floor at 6 GiB minus 1 KiB and at exactly 6 GiB;
   - pressure 2, 4 and unreadable;
   - a live lock holder;
   - a backoff sequence of 30, 60, 120, 240, 240, 240 minutes under a 240-minute cap, with both jobs
     refusing one second before each wait ends;
   - the default 24-hour cap;
   - markers outside `providersNotAnswered` being ignored;
   - an unreadable state file;
   - a failed `discovery-run` keeping the backoff.

   No test reaches launchd, a provider, a model or the network, and `launchctl` is asserted never to
   have been invoked.

`cernum discovery-schedule` is not yet wired to cds2. It still prints and writes cds1.
