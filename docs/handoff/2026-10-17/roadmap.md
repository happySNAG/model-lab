# Cernum capabilities and remaining development roadmap

This file lists what Cernum can do at `c59b7c4` and the remaining roadmap the Mac mini lane proposed.

- **The roadmap is [PROPOSED].** Only the C-01 to C-04 block was ever accepted as a goal (G-0128).
- Every later block needs the owner's own acceptance on the MacBook Pro controller.

## 1. Capabilities at `c59b7c4`

**Exists**
- Discovery across six providers (`ollama`, `claudeCLI`, `codexCLI`, `opencodeCLI`, `anthropicAPI`, `openaiAPI`).
  - Snapshots and change reports (`discovery-refresh`).
  - Model metadata records each value's source and time, or "unknown" with a reason.
- **New in this lane:**
  - `discovery-run`: a locked, headless, one-shot refresh a scheduler can call.
  - The versioned provider allowlist `cpa1`: OpenCode is excluded, and an unlisted provider is refused and recorded.
  - An async CLI test helper.
- **Benchmarks:**
  - prose suites;
  - development suites (multi-file edit, repo understanding);
  - sealed workspace packs at tiers 1–3 covering 18 dimensions;
  - latency, token, retry and cost telemetry.
- **Qualification policy `cqp1`:** at least 3 scored runs, at least 90% success, no case that never passed, and a 30-day evidence window. Promotion guards stop single-run, governance-failure and unverified-identity promotion.
- An append-only ledger and observation store, with fleet export and import.
- **Routing `crc2`/`crp2`:** `cernum candidates … --json` returns the qualified set and each excluded route with reasons. It is a set, never a choice.
- Spend authorization, campaign locks, Ollama endpoint leases and residency checks.

**Missing**
1. A scheduler: C-04 only generates a template.
2. Ranking, recommendation and fallback.
3. Automatic regression detection and re-evaluation of stale evidence.
4. A routing-decision log and production feedback.
5. A machine-wide exclusive benchmark window.
6. Reading allowance and rate limits before a run.
7. **Qualification gaps:**
   - no route is qualified for the recovery families;
   - no Ollama qualification on the Mac mini;
   - `gpt-6-luna` and `gpt-6-sol` are unqualified;
   - OpenCode billing is unconfirmed.
8. A stale README test count, and work branches not merged to `main`.

## 2. Roadmap

**Lane rules for every pass:**
- fixtures and recorded data only;
- no model requests;
- no pushes;
- no merge to `main`;
- the gate artifact is not replaced.

**Verification:** typecheck plus the in-scope vitest files, and the whole suite at each goal's last pass.

| # | Pass | Objective | Gate | Status |
|---|---|---|---|---|
| C-01 | Baseline | typecheck and whole suite, recorded; README count corrected | — | partial (C1 open) |
| C-02 | Discovery runner | `discovery-run` | — | **done** (`2ff48f7`, `1f1ab69`) |
| C-03 | Provider allowlist | versioned allowlist | provider list decision | **done** (`c59b7c4`) |
| C-04 | Schedule template | plist and guard generated, never installed | — | **next** |
| C-05 | Qualification history | `cernum history <route>`, read-only | — | proposed |
| C-06 | Metrics rollup | per route and capability: medians, p90, cost, retry and failure rates | — | proposed |
| C-07 | Promotion policy `cqp2` | runs across at least 2 sessions or days; `cqp1` stays readable | policy decision | proposed |
| C-08 | Capability coverage | debugging and instruction-compliance verdicts; recovery-family fixtures | — | proposed |
| C-09 | Routing decision log | append-only record of each candidates answer | — | proposed |
| C-10 | Task taxonomy | Ordra pass type, tier and context → `crc2` query | — | proposed |
| C-11 | Recommendation | advisory ranking `crr1` by cost, then reliability, then latency; never a selection | ranking decision | proposed |
| C-12 | Fallback chain | ordered fallbacks with exclusion reasons | — | proposed |
| C-13 | Limit evidence | usage- and rate-limit events as availability evidence | — | proposed |
| C-14 | Regression detector | latest scores vs history; flag regressions and stale qualifications | — | proposed |
| C-15 | Re-evaluation planner | costed re-qualification plan; never executes | — | proposed |
| C-16 | Quiet-hours policy | expensive work in low-utilization windows | — | proposed |
| C-17 | Exclusive window design | request/release protocol and ADR draft; Ordra authorizes, Cernum asks | — | proposed |
| C-18 | Exclusive window (Cernum side) | request, heartbeat, release, timeout; stub-tested; never activated | C-17 reviewed | proposed |
| C-19 | Status export | read-only status JSON schema | — | proposed |
| C-20 | Fleet export of Mac mini evidence | package Mac mini observations; import is the MacBook Pro's act | — | proposed |
| C-21 | Release candidate | 1.1.0-rc on a local branch with notes; merging is the owner's | release decision | proposed |

**Outside the Cernum lane** (each needs its own authorization):
- Ordra-side exclusive-window enforcement;
- Ordra consuming `recommend`;
- any Office UI;
- paid or subscription benchmark runs;
- installing the scheduler;
- replacing the gate artifact.

**Estimate:** about 21 lane passes plus 4–6 gated ones.

**Proposed goal blocks:** C-05–10, C-11–16 and C-17–21, each with its own acceptance and a ceiling of at most 6.

## 3. Resources (as measured on the Mac mini)

- **Per pass:**
  - 1–2 CPU cores;
  - a few hundred MB of RAM (vitest uses 2 workers);
  - under 1 GB of new disk;
  - no model requests.
- **Repository:** about 1.9 GB including `node_modules`.
- **Whole suite:** about 120 files. Its duration is unmeasured; budget up to 3 h on slow hardware.
