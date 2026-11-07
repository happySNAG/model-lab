# Matrix runner I/O profile — "before" (P-22231, G-22220 P1)

Base: `e35ff5a` plus P1's temp-location change (`defaultWorkspaceSandboxRoot()`, no change to I/O behaviour).
Measured 2026-11-06 on the Ordra host, in the session Ordra started (process priority `os.getPriority() = 10`,
inherited by every child; whether macOS background QoS / `taskpolicy -b` was also applied could not be checked
from inside the session). Node v26.0.0, vitest 3.2.7. P2 appends its "after" measurement below.

## Where temp is

- `os.tmpdir()` = `/var/folders/nd/t4w13yks7lj3zkt0dmqppby00000gn/T`, realpath
  `/private/var/folders/nd/t4w13yks7lj3zkt0dmqppby00000gn/T` — the internal disk, not `/Volumes/…`.
- The worktree and `fixtures/` are on `/Volumes/NemoClaw Data/…` (the external volume).
- The runner's sandbox (attempt trees `cernum-ws-*`, their `baseline/` copy and `tmp/` scratch) is always the
  caller's `sandboxRoot`; the CLI default is now `defaultWorkspaceSandboxRoot()` =
  `os.tmpdir()/cernum-workspace-sandbox` (`src/engine/workspace-execution.ts`), and the tests' sandbox and
  campaign roots come from `temporary()` in `test/engine/workspace-continuation-harness.ts`, also under
  `os.tmpdir()`. `test/engine/matrix-temp-location.test.ts` pins both facts.
- Not changed: the CLI's durable campaign (records) root still defaults to
  `~/Library/Application Support/<product>/…` (internal disk on this host) — it is a record store, not scratch.

## Per-test times (tests 20 and 21 of `workspace-cell-selection.test.ts`)

| run | test 21 (codex, 6 runs) | test 20 (claude, 6 runs) | whole file |
|---|---|---|---|
| `npm test -- matrix-temp-location + workspace-cell-selection` (threads, unprofiled) | 6.98 s | 6.59 s | 22.1 s tests / 24.4 s total (both files) |
| `npm test -- workspace-cell-selection --reporter=verbose` (unprofiled, 2nd run) | 7.62 s | 9.71 s | 25.4 s tests / 26.8 s total |
| same, 1st run | — | — | 24.1 s tests / 25.8 s total |
| `node node_modules/vitest/vitest.mjs run … -t "(20\|21) · " --pool=forks --poolOptions.forks.singleFork=true` with `--cpu-prof --cpu-prof-interval=500` | 7.56 s | 7.75 s | 15.3 s (two tests) |

Other heavy tests in the file (2nd run): 19 (telemetry, fake codex) 3.71 s; "Claude matrix can be selected"
1.99 s; "refuses a selected cell whose record already exists" 1.10 s; 2 (repeat 3 of 3) 0.87 s; everything else
under 0.1 s. Tests 20 and 21 are ~68 % of the file.

Compared with D-19030 (at bbadb36): test 21 was 16.0-22.8 s at Ordra's background priority and 7.6-8.2 s on the
SSD at normal priority; the whole file 53-75 s background, 23-24 s normal. Today's session, with temp on the
internal disk, measures 7.0-7.6 s for test 21 and 24-26 s for the file — i.e. the normal-priority SSD figures.
Either the priority in this session is milder than the one D-19030 measured (nice 10 only, see above), or the
earlier background runs had temp on the external volume; this profile cannot tell which.

## Where the time goes (CPU profile of the fork that ran tests 20 + 21)

Sampled wall time 16.59 s (6 827 samples at 500 µs). Attribution is by the first `node:fs` /
`node:child_process` frame on the stack, then by the nearest `src/` caller (function names are reliable; line
numbers in the raw profile are vite-node's transformed lines, so they are not quoted).

| bucket | time | share |
|---|---|---|
| idle — event loop waiting on child processes (see below) | 10.91 s | 65.7 % |
| `fs.fsyncSync` (ledger durability) | 4.66 s | 28.1 % |
| JavaScript (canonical JSON, planning, digests, module load) | 0.53 s | 3.2 % |
| `rmSync` (attempt-tree cleanup) | 0.06 s | 0.3 % |
| `realpathSync` | 0.05 s | 0.3 % |
| `copyFileSync` (fixture copies) | 0.04 s | 0.3 % |
| `mkdirSync` / `writeFileSync` / `readFileSync` / `openSync` / `readdirSync` / `statSync` | ~0.10 s | 0.6 % |
| child-process spawn bookkeeping (`spawn`, `emit`, `spawnSync`) | ~0.08 s | 0.5 % |

A second, 0.26 s profile was written by a forked process that only loaded modules; it holds no test work.

### The remaining file-system hot spots

1. **Record writes — fsync, 4.66 s for 12 records (~390 ms per record).** By caller:
   `fsyncDirectory` 1.96 s (the directory fsync after every rename), `atomicWriteJSON` 1.82 s (its own file
   fsync), `Ledger.event` 0.66 s (one fsync per appended event), `Ledger.appendResult` 0.24 s. Every
   `atomicWriteJSON` pays two fsyncs (temp file, then directory) — `plan.json`, `meta.json`, the manifest, the
   case snapshot, each checkpoint, the sealed record — plus `Ledger.create`'s extra root-directory fsync and one
   fsync per events/results line. This is deliberate durability (`src/engine/ledger.ts`), not latency of a slow
   disk: the records are under `os.tmpdir()` on the internal SSD here.
2. **The ledger `meta.json`.** Written once per record by `Ledger.create` through `atomicWriteJSON` (2 fsyncs,
   inside the figure above). Test 21 re-reads it 36 times (6 rows × 6 keys, inside its inner loop); all
   `readFileSync` in the profile totals 18 ms, so the reads are not a hot spot — the write's fsyncs are.
3. **Fixture copies — negligible.** `copyTree`/`walk` in `workspace-tree.ts` plus `copyFileSync` total ~0.13 s.
   The two fixtures are tiny (`receipt-refunds`: 4 files, 4.4 KB; `task-priority`: 8 files, 8.9 KB), read from
   the external volume and written under `os.tmpdir()`.
4. **git — none.** The workspace runner spawns no `git`: baseline and final trees are digested and diffed
   in-process by `workspace-tree.ts`. No git frame or git child appears in the profile.
5. **Child processes — the idle 10.9 s.** Not file-system work in the profiled process: each run executes its
   case's own commands as `node` children (sandboxed through `/usr/bin/sandbox-exec` where the probe admits it)
   — the baseline run of the visible suite, the visible verification, and the hidden check (e.g.
   `node test/report.test.js`, `node -e <check>` for `receipt-refunds-sign`). Both tests' cases have
   `maximumAttempts: 1`, so 12 runs × ≥3 children ≈ 36+ node start-ups, ~0.3 s each. The CPU profile cannot see
   inside them; their cost is process start-up at the session's priority.
6. **Attempt-tree cleanup — 0.06 s** (`rmSync`).

### Reading for P2 (not an escalation)

The remaining cost is not unavoidable file-system latency. About two-thirds is waiting on the cases' own
verification children and about a quarter is per-write fsync of records that, in tests, live in disposable temp
directories. Fixture copies, git and `meta.json` reads are not where the time goes. Whether either of the two
large items may be reduced — and how, without changing a test, fixture, case, record digest or the ledger's
durability contract for real campaigns — is P2's question and the owner's, not this pass's.

## Peak temp usage

Sampled every 200 ms (sum of file sizes under every `os.tmpdir()/cernum-*` entry, excluding this pass's own
profile directory) across the profiled run and both unprofiled whole-file runs, 586 samples over 119 s:

- peak **392 528 bytes** in 77 files across 8 top-level `cernum-*` directories, of which 35 222 bytes were
  pre-existing leftovers not made by this session (`cernum-store-fAhhr9`; four empty `cernum-disc-plan-*`; an
  empty `cernum-workspace-sandbox`). The suite's own peak is therefore **~357 KB (< 1 MiB)**.
- A 200 ms sampler can miss a transient peak; since each attempt tree is under ~50 KB and the tests remove
  their directories in `afterEach`, the true peak is bounded at a few MiB.
- The CPU profiles themselves were 353 KB + 87 KB, written with `--cpu-prof-dir` under `os.tmpdir()` and deleted
  after this summary.

Against the 6 GiB disk floor and ~11 GiB free on the internal disk, the suite's temp footprint is immaterial.

## How it was measured (for P2 to repeat)

- `node node_modules/vitest/vitest.mjs run test/engine/workspace-cell-selection.test.ts -t "(20|21) · "
  --pool=forks --poolOptions.forks.singleFork=true --poolOptions.forks.execArgv=--cpu-prof
  --poolOptions.forks.execArgv=--cpu-prof-dir=<os.tmpdir()>/cernum-ioprof-XXXX/p1
  --poolOptions.forks.execArgv=--cpu-prof-interval=500`
- `npm test -- test/engine/workspace-cell-selection.test.ts --reporter=verbose` (twice), and
  `npm test -- test/engine/matrix-temp-location.test.ts test/engine/workspace-cell-selection.test.ts`.
- The profile was bucketed by walking each sample's stack to the first `node:fs`/`node:child_process` frame and
  the nearest `src/` frame; the temp sampler and the analysis were inline `node` programs, not committed.

## After (P2) (P-22512, G-22220 P2)

Base: `c778500` (P1's checkpoint), no change under `src/`. Measured 2026-11-06 ~23:01 CST on the Ordra host in
the session Ordra started (`os.getPriority() = 10`, as in P1). Node v26.0.0, vitest 3.2.7. Command, run twice:
`npm test -- test/engine/workspace-cell-selection.test.ts --testTimeout=15000 --reporter=verbose`. Both runs:
25 of 25 tests passed, exit 0.

| run | test 21 (codex, 6 runs) | test 20 (claude, 6 runs) | whole file |
|---|---|---|---|
| 1st | 6.49 s | 6.49 s | 19.2 s tests / 21.4 s total |
| 2nd | 6.48 s | 8.77 s | 22.1 s tests / 23.5 s total |

Other heavy tests (1st / 2nd run): 19 (telemetry) 2.84 / 2.71 s; "Claude matrix can be selected" 1.37 / 2.18 s;
2 (repeat 3 of 3) 0.91 / 0.87 s; "refuses a selected cell whose record already exists" 0.81 / 0.83 s.

Against the stop threshold: the slowest of tests 20 and 21 is 8.77 s, under the 12 s at which P2 would have
stopped, and every test is under the 15 s `--testTimeout` (half of the 30 s budget).

Compared with P1's before figures: test 21 6.5 s vs 7.0-7.6 s, test 20 6.5-8.8 s vs 6.6-9.7 s, the file
21-24 s vs 24-27 s total. Compared with D-19030 (at `bbadb36`): test 21 6.5 s vs 16.0-22.8 s at Ordra's
background priority and 7.6-8.2 s on the SSD at normal priority; the file 21-24 s vs 53-75 s background and
23-24 s normal. The after figures sit at or slightly below D-19030's normal-priority SSD figures. The gain over
D-19030's background runs comes from the temp location (P1's `defaultWorkspaceSandboxRoot()` and the tests'
`os.tmpdir()` roots on the internal disk) and the session's priority, not from any change to the runner's I/O;
the spread between runs (test 20: 6.5 vs 8.8 s) is run-to-run noise of the same order as P1's.

C2's five regression files (`workspace-discriminator`, `workspace-pack`, `workspace-tier-packs`,
`route-outcome-ingest`, `workspace-forward-compat`) were also run once in this session: 157 of 157 tests passed,
151 s. That is this session's observation only; Ordra's own runs are the evidence for C1 and C2.

The remaining cost is left as it is, on purpose. About two-thirds of tests 20 and 21 is the cases' own child
processes — the baseline, visible-verification and hidden-check `node` children each run spawns, which are part of
what the cases measure and cannot be removed without changing a case or a test. About a quarter is the ledger's
fsync durability — the file and directory fsyncs behind every `atomicWriteJSON` and every appended event or
result line in `src/engine/ledger.ts` — which is the record store's durability contract for real campaigns and
which this goal's bounds forbid weakening. Fixture copies, `meta.json` reads, git and cleanup were already
negligible in P1. With the suite now comfortably inside half its timeout at Ordra's priority, neither is worth
trading away.
