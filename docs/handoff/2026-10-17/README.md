# Cernum development handoff: Mac mini interim Ordra lane → MacBook Pro Ordra

This directory hands Cernum development from the temporary Mac mini Ordra controller (`mini-local`) to the MacBook Pro's authoritative Ordra controller. It describes the state at 2026-10-18 ~02:00Z.

- **What this is:** documentation only, on the backup branch `handoff/cernum-macbook-20261017`. It records where development stands so the MacBook Pro controller can adopt it.
- **What this is not:** a release, a merge or a registration, and not new development.
  - Nothing here was run or verified by Ordra.
  - The IDs below (`G-…`, `C-…`, `P-…`, `D-…`, `E-…`, `EV-…`) are records in the **Mac mini's** store. They do not exist in the MacBook Pro store.

**Legend:** **[VERIFIED]** means Ordra ran the command itself on the Mac mini and recorded its exit code. **[PLANNED]** means recorded but never executed. **[PROPOSED]** means a suggestion never approved as a goal.

> **Read [`addendum-2026-10-18.md`](addendum-2026-10-18.md) first.** It records the owner's migration decisions, the comparison with GitHub `main` and the integration plan, and it is the preferred source for adoption.

Companion files:
- [`addendum-2026-10-18.md`](addendum-2026-10-18.md): owner decisions of 2026-10-18 and the `main` comparison.
- [`ordra-runtime-defects.md`](ordra-runtime-defects.md): two **Ordra** defects, not Cernum defects.
- [`roadmap.md`](roadmap.md): Cernum capabilities and the proposed roadmap.

---

## 1. Commits on this branch

The branch is `ordra/cernum-lane` as it stood at the pause, plus one documentation commit (this directory). It is based on `671fc61` (`work/cernum-v1-ollama-fix`, already on GitHub).

| Commit | Content | Status |
|---|---|---|
| `3028153` | docs: record the partial `npm test` observation; README stops claiming an unmeasured suite figure (C-01b) | **[VERIFIED]** pass P-0444 completed |
| `2ff48f7` | feat: `discovery-run`, a locked one-shot headless discovery refresh a scheduler can call (C-02) | **[VERIFIED]** through its descendant `1f1ab69` |
| `1f1ab69` | test: `cli-argument-safety.test.ts` spawns the CLI asynchronously so the vitest worker stays responsive (C-02e) | **[VERIFIED]** P-1393, all 5 commands exit 0 |
| `c59b7c4` | feat: discovery consults the versioned provider allowlist `cpa1`; OpenCode excluded (C-03e) | **[VERIFIED]** P-1394, all 3 commands exit 0. **Latest verified commit.** |
| (this commit) | docs: this handoff directory | documentation only, **not verified by Ordra** |

- **Unverified:** no Cernum code exists beyond `c59b7c4`. P-1395 never started.
- **Whole suite:** the whole `npm test` suite has **never** been verified green on this lane.
- **Not on this branch, but in the Mac mini's git bundle:**
  - `fd4f2d9` on `ordra/cernum-lane-p0139-a0401`: a superseded typecheck-baseline note from an early attempt.
  - `dfa8307` on `work/cernum-v1-qualification`: one local commit that predates this lane and that the lane never touched.

**Branch base:** GitHub's `main` and `work/cernum-v1-consolidation` (the V1.0.0 gate commit `e57a1f7`) have moved past `671fc61`. This branch has **not** been reconciled with either. Choosing the base is the first decision on the MacBook Pro side (§8).

## 2. Verification evidence **[VERIFIED]**

| Attempt (pass) | Commit | Command | Exit |
|---|---|---|---|
| A-1485 (P-1393) | `1f1ab69` | `npm run typecheck` | 0 |
| | | `npm test -- test/engine/discovery-run.test.ts` | 0 |
| | | `npm test -- test/engine/provider-discovery.test.ts` | 0 |
| | | `npm test -- test/engine/lock.test.ts` | 0 |
| | | `npm test -- test/engine/cli-argument-safety.test.ts` | 0 (21/21) |
| A-1534 (P-1394) | `c59b7c4` | `npm run typecheck` | 0 |
| | | `npm test -- test/engine/provider-allowlist.test.ts` | 0 |
| | | `npm test -- test/engine/discovery-run.test.ts test/engine/provider-discovery.test.ts test/engine/opencode-discovery-regression.test.ts` | 0 |

- **Earlier failures, kept in the record:**
  - P-1093: the 3-file command exited 1. All 71 tests passed, but there was an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`.
  - P-1229: `cli-argument-safety.test.ts` alone exited 1 with the same timeout after 137.5 s.
  - Cause: the file's synchronous `spawnSync` helper blocked the vitest worker past vitest's internal RPC timeout. `1f1ab69` fixed it with an async spawn helper and explicit per-test timeouts. No assertion or config was changed.
- Judge by these per-command exit codes. Ordra's status view can call a criterion "evidenced" even when one of its commands failed.

## 3. Goal and campaign

### Goal G-0128@v1 (Cernum's project on the Mac mini controller), accepted 2026-10-16

- **Authority:** `git`, `npm run typecheck`, `npm test`.
- **Writable paths:** `src`, `test`, `fixtures`, `scripts`, `docs`, `README.md`.
- **Restrictions:** no destructive operations, no leaving the machine, no merge to the default branch.

| Criterion | Requirement | State |
|---|---|---|
| C1 | `npm run typecheck` exits 0 **and the whole `npm test` suite exits 0** | **open.** Typecheck passes, but the whole suite was never verified. Only P-1395 decides it. |
| C2 | `discovery-run.test.ts` exits 0 (headless, locked, one-shot discovery runner) | **[VERIFIED]** evidenced |
| C3 | `provider-allowlist.test.ts` exits 0 (allowlist: claudeCLI, anthropicAPI, codexCLI, openaiAPI, ollama; OpenCode excluded) | **[VERIFIED]** evidenced |
| C4 | `discovery-schedule.test.ts` exits 0 (launchd plist and guard **generator**, never installed) | **[PLANNED]** in P-1395 |

### Campaign C-0138@v1

The ceiling is 17 and all 17 slots are committed. Retired passes keep their slots.

| Pass | Label | Status |
|---|---|---|
| P-0139 | C-01 baseline with whole suite | failed (whole suite could not fit the bounds) |
| P-0147 / P-0148 / P-0149 | C-02 / C-03 / C-04 | retired in re-plan |
| **P-0444** | C-01b baseline record | **completed** → `3028153` |
| P-0445 / P-0446 / P-0459 | C-02b / C-03b / C-04b | retired in re-plan (P-0445's work kept as `2ff48f7`) |
| P-1093 | C-02c | failed (vitest RPC timeout) |
| P-1094 / P-1095 | C-03c / C-04c | retired in re-plan |
| P-1229 | C-02d, split verification | failed (same timeout) |
| P-1230 / P-1231 | C-03d / C-04d | retired in re-plan |
| **P-1393** | C-02e, bring back `2ff48f7` and fix the CLI test harness | **completed** → `1f1ab69` |
| **P-1394** | C-03e, provider allowlist | **completed** → `c59b7c4` |
| **P-1395** | C-04e, schedule template and whole-suite verification | **[PLANNED] pending, never started**, held by the pause |

**Totals:** 3 completed, 3 failed, 10 retired in re-plans, 1 pending.

**Dependency chain:** P-0444 → P-1393 → P-1394 → P-1395. P-1395 is the only remaining Cernum pass, and nothing depends on it inside this campaign.

## 4. Decisions and limits (owner-approved, mini-local records)

| Decision | What it says |
|---|---|
| D-0133 | Owner approval to open the Cernum lane on the interim controller: fixtures and recorded data only, workers do the development, no destructive operations, no unapproved spending, no machine-wide exclusive benchmarking |
| D-0225 | Scheduling option B (explicit campaign priorities with starvation protection) to be built through Ordra. Keep the 600 s worker default. Design a per-lane limit, with 1800 s proposed for Cernum only. Long benchmarks become separate governed jobs |
| D-0462 | **10 800 s (3 h) verification bound for the final Cernum whole-suite verification pass only.** The 600 s worker bound stays. Not global. No overlap with other lanes' expensive suites. If it fails or exceeds the limit: keep the evidence and ask, never auto-extend |
| E-1333 answers | The worker may fix the CLI test harness (async helper) and add explicit per-test timeouts. Nothing else in that file may change |
| D-1624 | Handoff pause: new Cernum dispatch on the Mac mini is held |

**Limits in force:**
- Worker launch bound: 600 s.
- Capacity: one worker.
- Internal disk floor: 5 GiB (the cycle wrapper uses 6 GiB).
- No model requests, paid or subscription.
- No pushes or merges to `main` from the lane.
- No scheduler install.
- Do not replace the gate artifact.

**Gap to carry over:**
- D-0462's bound was attached to pass P-0459, which was later retired, and **P-1395 carries no such bound**.
- Under the default verification bound, its whole-suite run would fail for that reason alone.
- Re-record the 10 800 s bound with the owner's words before running the whole-suite verification.

## 5. Model discovery and benchmarking status

- The lane sent **no request to any model**: no live discovery, no smoke run, no benchmark, no spend. Everything was fixture-based.
- **The exclusive benchmark mode was never activated.** It stays gated on Ordra-side integration (roadmap C-17/C-18).
- Cernum's own data from earlier work is local to the Mac mini, untouched by this lane, and **not** copied here because it is machine-local application data:
  - campaigns, evidence and smoke evidence under Cernum's application-support directory, last written 2026-09-23;
  - the V1.0.0 gate artifact (`e57a1f7` build) in an offload archive.
- **Qualification seen at lane start:** `claudeCLI:claude-opus-5-5` was qualified for `workspace:multiFileEditing`, 6/6, on 2026-10-15. Its 30-day evidence window lapses around 2026-11-14.
- No Ollama qualification ran on the Mac mini. It is a CPU-only i7 with 32 GiB, and 27B models time out there.

## 6. Known blockers and recovery history

**Blockers**
- **Cernum blockers:** none.
- **Before the next pass:**
  - the D-0462 bound gap (§4);
  - the base-branch decision (§1).

**Recovery history** (all recorded; no commit lost)
1. **Whole suite vs 600 s:** the work was re-planned into targeted verification per pass, plus one final whole-suite pass with 10 800 s.
2. **Vitest worker RPC timeout:**
   - The verification was split per file; that did not help.
   - The owner then approved a test-harness fix (`1f1ab69`). It worked.
3. **Each rewind:** the work was kept on a backup branch first, then the lane was moved back to its last checkpoint.

**Ordra defects:** see [`ordra-runtime-defects.md`](ordra-runtime-defects.md).

## 7. Exact recommended next pass: C-04e (P-1395 as planned)

**Start from** `c59b7c4`, or from the base the MacBook Pro side chooses.

**Work**
- Add a `discovery-schedule` function and CLI command. It **prints**, or writes to a path the caller names, a launchd plist and a zsh guard script that would run `discovery-run` once a day.
- The guard script:
  - runs inside a quiet window, 02:00–05:00 local by default;
  - refuses, logging why, when internal free space is under a configurable floor whose default and minimum is 6 GiB;
  - refuses when memory pressure is critical;
  - refuses when a lock file shows another run.
- Nothing is installed: no `launchctl`, no write under `~/Library/LaunchAgents`, and the output says installation is a separate human act.
- Add `test/engine/discovery-schedule.test.ts`, using temporary directories and fakes only.
- Add `docs/ordra-lane/discovery-schedule.md`.

**Non-goals**
- running the bare `npm test` inside the worker;
- calling real providers;
- changing `package.json`, the lockfile or `vitest.config.ts`;
- weakening or skipping any test.

**Verification**
1. `npm run typecheck`
2. `npm test -- test/engine/discovery-schedule.test.ts`
3. `npm test` (whole suite, decides C1), **with the 10 800 s verification bound recorded first**, and not overlapping another lane's expensive suite.

## 8. Adopting under MacBook Pro Ordra

1. **Base.** Fetch this branch. Decide whether Cernum continues from `c59b7c4` on `671fc61`, or whether a worker pass reconciles it with GitHub `main` / `work/cernum-v1-consolidation`.
2. **Intake.** Take Cernum in through the MacBook Pro controller's ordinary intake: a new accepted goal, or a reconciliation of G-0128's four criteria. Cite this directory as provenance. Do not import the mini-local store.
3. **Carry the limits** in the owner's own words:
   - the 600 s worker default;
   - D-0462's 10 800 s whole-suite verification;
   - fixtures only;
   - no pushes or merges to `main` without approval;
   - no scheduler install;
   - no paid benchmarks.
4. **Run C-04e (§7) first.** The owner then picks the next goal block from [`roadmap.md`](roadmap.md).
5. **One controller only.** The Mac mini keeps its Cernum pause (D-1624). It must not be lifted while the MacBook Pro controller holds a Cernum goal.

**Related, outside this repository:** the same Mac mini session built Ordra-source changes for scheduling option B and a per-lane worker-bound design. They are local, unpushed commits in Ordra's own repository, **not activated**, and documented in the Mac mini's handoff record. They belong to the MacBook Pro Ordra supervisor.
