# Ordra lane — measured baseline

Branch `ordra/cernum-lane` at `671fc6139468e645779e7593d85f0fcc3ae319a4`, measured 2026-10-16 on the
Mac mini, with the repository on the external NemoClaw Data volume, Node v26.0.0, and the
`node_modules` already installed (no `npm install` was run). No source, test, fixture or script file
was changed for this measurement.

Wall-clock durations are the `total` that zsh's `time` reported around each command.

The `npm run typecheck` section was first recorded in commit `fd4f2d9`, which sits on the branch
`ordra/cernum-lane-p0139-a0401` rather than on `ordra/cernum-lane`; it is reproduced here unchanged.

## `npm run typecheck`

| | |
| --- | --- |
| Command | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) |
| Exit code | 0 |
| Wall-clock | 30.1 s (30.64 s user, 1.87 s system) |
| Failures | none — `tsc` printed no diagnostics |

## `npm test`

**The whole-suite duration and result are not yet measured.** The campaign's final pass will
measure them. Until then, nothing here is the suite's result.

| | |
| --- | --- |
| Command | `npm test` (`vitest run`) |
| Test files | 120 — vitest `include` is `test/unit` (3), `test/parity` (3) and `test/engine` (114) |
| Workers | `maxWorkers: 2`, `minWorkers: 1` (`vitest.config.ts`; the engine tests are fsync-bound by design) |
| Exit code | not yet measured |
| Wall-clock | not yet measured |

### Partial observation from an earlier, stopped attempt

An earlier attempt (Ordra attempt A-0401) ran `npm test` under the vitest default reporter. Ordra
stopped it at that worker's 600 s bound, after about four minutes of test output. Before it was
stopped, vitest reported these three files complete, all passing:

| File | Tests | Duration | Result |
| --- | --- | --- | --- |
| `test/engine/workspace-cell-selection.test.ts` | 25 | 60.4 s | all passed |
| `test/engine/workspace-codex-driver.test.ts` | 63 | 39.3 s | all passed |
| `test/engine/workspace-matrix-effort-telemetry.test.ts` | 44 | 245.4 s | all passed |

That is 3 of 120 files. The other 117 files were not reported as finished, and nothing about them
can be read from this attempt. The 245.4 s for one file shows why a whole run takes many minutes
on this volume.
