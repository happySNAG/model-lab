# `cernum discovery-schedule` — a generated, never installed, recurring discovery schedule

`discovery-schedule` writes the text of a macOS schedule for `discovery-run`, and nothing else. It
produces two files:

- a **launchd property list** that would start a guard script once a day, at the start of a
  quiet-hours window, and
- the **zsh guard script**, which runs `cernum discovery-run --json --root <root>` once, and only
  when every check below passes.

**Nothing is installed, loaded or enabled.** The command starts no process, never calls `launchctl`,
never writes under `~/Library/LaunchAgents` (or `/Library/LaunchAgents`, `/Library/LaunchDaemons`,
`/System/Library/LaunchAgents`, `/System/Library/LaunchDaemons`), and says so in its output and in
both files. Installing the schedule is a separate human act.

## Usage

```
cernum discovery-schedule [<provider>…] [--root <dir>] [--out <dir>] [--cernum <path>]
                          [--window HH:MM-HH:MM] [--floor-gib <n>] [--label <name>]
```

| Option | Default | Meaning |
| --- | --- | --- |
| *(no `--out`)* | | Print the plist and the guard to standard output. Nothing is written. |
| `--out <dir>` | | Write `<label>.plist` and `discovery-schedule-guard.zsh` into `<dir>`. Refuses launchd's job directories, including through a symbolic link, and refuses to overwrite either file. |
| `--root <dir>` | the default campaign root | The root `discovery-run` uses. The guard reads the discovery lock at `<root>/.discovery-run/campaign.lock`. |
| `--cernum <path>` | `~/.local/bin/cernum`, where `install-command` puts it | The executable the guard runs. Absolute, because launchd's PATH does not contain it. |
| `--window HH:MM-HH:MM` | `02:00-05:00` | Local quiet hours: start inclusive, end exclusive. A window may wrap past midnight (`23:30-01:15`). |
| `--floor-gib <n>` | `6` | Whole GiB that must be free on `/`. **Never below 6**: a lower value is refused and nothing is generated. |
| `--label <name>` | `com.cernum.discovery-run` | The launchd label, and the plist's file name. |
| `<provider>…` | every provider `discovery-run` refreshes | Passed through to `discovery-run`. |

Without `--out`, the guard's path in the plist is `<root>/.discovery-run/schedule/discovery-schedule-guard.zsh`;
with it, the guard is in `--out`. The guard's log is `discovery-schedule.log` beside it; launchd sends
the guard's standard output and error there.

Exit codes: 0 when generated; 2 when an option is refused (bad window, floor under 6 GiB, relative
path, a launchd job directory, an existing file). Nothing is written on a refusal.

## The schedule

The plist has one `StartCalendarInterval` entry naming only an `Hour` and a `Minute` — the start of
the window — which launchd reads as every day. `RunAtLoad` is false, there is no `KeepAlive`, the job
is `ProcessType` `Background` with `LowPriorityIO`, and its `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`.

launchd starts a calendar job that a sleeping Mac missed when the Mac wakes, at whatever hour that is.
That is why the window is enforced by the guard and not only by the calendar entry.

## The guard

In order, each check refuses — logging a timestamped `REFUSED, discovery-run not started: <reason>`
line and exiting with its own code — or passes:

| Check | Refuses when | Exit |
| --- | --- | --- |
| floor | the floor in the script was hand-edited below 6 GiB | 14 |
| quiet hours | the local time (`date +%H`, `+%M`) is outside the window | 10 |
| free space | `df -Pk /` reports less available than the floor | 11 |
| memory pressure | `sysctl -n kern.memorystatus_vm_pressure_level` is 4, critical (1 is normal, 2 warning) | 12 |
| another run | `<root>/.discovery-run/campaign.lock` exists and its `pid` is a running process (`ps -p`), or names no pid at all | 13 |
| executable | `--cernum` is not an executable | 14 |

A check whose input cannot be read (no time, no `df` figure, no pressure level) refuses with exit 14:
a guard that cannot see the disk does not know the disk is fine. A lock file left by a process that is
no longer running is logged and left to `discovery-run`, whose own lock decides whether it is stale and
may be recovered; if it is not, `discovery-run` refuses and exits 4.

When every check passes the guard logs what it saw and runs `discovery-run` once, exiting with its
status.

The 6 GiB floor is the minimum because the Mac mini's owner keeps 5 GiB free on the internal disk and
Ordra's own wrapper uses 6 GiB; a generated guard may ask for more, never less.

## What the tests pin

`test/engine/discovery-schedule.test.ts` checks the generated text only, in temporary directories:
the daily interval and the window (including one that wraps), the floor's default and minimum, each
refusal path and its reason, that `discovery-run` comes after every check, quoting of embedded paths,
that neither file nor the generator mentions or calls `launchctl`, and that `--out` refuses
`~/Library/LaunchAgents` (directly, beneath it, and through a symbolic link) and never overwrites.
The CLI is run in a subprocess with a temporary `HOME` and a fake `launchctl` first on `PATH`, which
records any invocation; the tests assert there was none. The guard script itself is never executed by
the tests.
