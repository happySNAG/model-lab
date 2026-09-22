# Cernum architecture — the canonical map

Cernum was developed on two lines at once: the **workspace qualification** line (MacBook) and the
**V1 benchmark / development-runner** line (Mac mini, tagged `cernum-v1-benchmark-freeze`). They were
consolidated into one engine. This page records where each concept lives **once**, which lifecycle
stage it serves, and what is still missing. `ENGINE.md` explains *why* each piece works the way it
does; this page is only the map.

The intended lifecycle is:

```
DISCOVER → DESCRIBE → BENCHMARK → QUALIFY → ROUTE → OBSERVE → REQUALIFY
```

The engine (`src/engine`, `src/core`) is the single source of truth for every stage. The desktop
application (`src/main`, `src/renderer`) and the terminal (`src/cli/cernum.ts`) both read engine
state; neither holds a qualification of its own.

## One implementation per concept

| Concept | Canonical home | Notes |
|---|---|---|
| Provider identities | `engine/provider.ts` (`PROVIDER_IDS`, `executionClassOf`, `billingBasisOf`) | One provider table for campaigns, smokes, development and workspace. |
| Provider → adapter / driver | `engine/host-factory.ts` (`buildAdapter`, `buildWorkspaceDriver`) | Prose/development attempts go through `FrontierAdapter`; workspace attempts through `WorkspaceAgentDriver`: `driver.claude-cli.workspace`, `driver.codex-cli.workspace`, `driver.opencode-cli.workspace` (`workspace-opencode-driver.ts`) and `driver.ollama.workspace` (`workspace-ollama-driver.ts`, Cernum's own loop over the loopback runtime). |
| Discovery | `engine/discovery.ts` (`discoverProvider`, `DESIRED_CANDIDATE_LADDER`); local models in `engine/live-host.ts` (`discoverLocalModels`) | Includes the free OpenCode pool (`FREE_OPENCODE_DEVELOPMENT_POOL`) and the OpenAI API identity rows. |
| Discovery refresh, delta and staleness | `engine/discovery-refresh.ts` (`refreshDiscovery`, `diffDiscoverySnapshots`, `routeFreshness`, `qualificationStaleness`) | Deterministic; no scheduler. A provider whose probe failed contributes `notRefreshed`, never `disappeared`. |
| Structured model description | `engine/model-description.ts` (`ModelDescription`, `Known<T>`) | Every routable property is a value with its source and time, or `unknown` with a reason. Never inferred from a name. |
| Machine identity and availability | `engine/machine-availability.ts` (`machineKey`, `availabilityOnMachine`, `qualificationAppliesOn`) | Machines are identified by fingerprint (`cmk1:`), never by a hard-coded name. Local qualification never transfers between machines. |
| Execution of model-modified code | `engine/execution-sandbox.ts` | The V1 rule: sealed commands only, always under macOS Seatbelt; no sandbox, no run. |
| Unified qualification (read model) | `engine/route-qualification.ts` (`deriveRouteQualification`) | Derived from existing evidence, per capability; writes nothing. |
| Spend posture | `engine/route-spend-posture.ts` (`routeSpendPosture`) | Exists / may benchmark / may auto-spend / may route by default. |
| Ordra-facing query | `engine/routing-contract.ts` (`qualifiedRouteCandidates`) | Returns a grouped candidate set and every exclusion; never a winner. |
| Discovery evidence and staleness | `engine/discovery-store.ts` (`readDiscoveryStore`, `isEvidenceExpired`, `selectableFromStore`, `acceptedRequestEvidenceFor`) | Per machine: the store lives under the campaign root on the machine that ran discovery. |
| Authorised cohort | `engine/reconciliation.ts` (`AUTHORIZED_COHORT`) | Each authorisation is its own list: Pass 5C, V2, OpenAI API identity, free OpenCode pool. |
| Identity exception | `engine/provider.ts` (`IDENTITY_ADMISSIBLE_PROVIDERS`, `IDENTITY_UNNAMEABLE_BECAUSE`), `engine/identity-admission.ts` | One rule: Codex and OpenCode. Workspace matrix admissions (`workspace-matrix-admission.ts`) seal a per-provider limitation (`MATRIX_IDENTITY_LIMITATIONS`): Codex's sentence unchanged, OpenCode's own, never mixed. Admitted routes are never routable. |
| Cost classification | `engine/cost-eligibility.ts` (`costEligibilityFor`) | `free_confirmed | subscription_included | local | metered | unknown_cost`. Enforced in `RoutingHost` for prose campaigns and in the development planner. |
| Published prices | `engine/opencode-pricing.ts` | A list price, never a measured charge. Read by the cost estimate and by the OpenCode workspace binding (as its estimate input); never makes a route free — only a signed `free_confirmed` observation does. |
| Measured spend | `engine/spending.ts`, `engine/frontier-metrics.ts` | Tokens, cost, allowance, retry waste, unproductive tokens. Workspace aggregation reuses `aggregateCandidateMetrics`. |
| Failure → disposition | `engine/attempt-disposition.ts` | The one allowance/throttle marker list. Workspace drivers use it too, and add only `429` / "try again in" (which stay out of the shared list because it re-reads sealed prose rows). |
| Throttle circuit breaker | `engine/workspace-throttle.ts`, `engine/provider-session-status.ts` | Workspace matrices. Prose campaigns abort through `campaign.ts:isThrottleFailure`. |
| Machine readings | `engine/machine.ts` (`readMachine`, `availableMemoryBytes`) | Darwin reads `vm_stat` (free + inactive + speculative). Other platforms are untouched. |

## The three benchmark kinds

These are **distinct measurements**, not competing implementations:

| Kind | Measures | Verdict from | Providers | Feeds |
|---|---|---|---|---|
| Prose campaign (`campaign.ts`, `ledger.ts`) | the twelve prose capability dimensions | deterministic evaluators over the answer | local, subscription CLIs, OpenCode, metered | `ranking.ts` |
| Development (`development-*.ts`) | repository understanding; multi-file editing graded from the bytes the workspace held | static assertions over the answer and final tree; executed tier declared NOT MEASURED | Claude CLI | the ranking row's `development` block (not yet populated by any caller) |
| Workspace (`workspace-*.ts`) | executed coding work: tests, hidden checks, scope, patch cleanliness, recovery | sealed commands run with no provider credentials, under macOS Seatbelt | Claude CLI, Codex CLI, OpenCode CLI, Ollama (Cernum loop) | per-cell qualification evidence (`workspace-aggregate.ts`, `workspace-effort-evidence.ts`) |

The dimension names `multiFileEditing` appear in both `DevelopmentDimension` and
`WorkspaceDimension`. They are separate typed unions, sealed into different digests (`mldrun1:` plans
and `cwc1:` cases), and never mixed: workspace evidence does not enter `ranking.ts`. Renaming either
would orphan sealed evidence, so they are namespaced by type instead.

Both development and workspace keep their own tree-diff code (`core/unified-diff.ts` with
apply/rebuild; `engine/workspace-tree.ts` with content-addressed snapshots). Each one's output bytes
are sealed into its evidence format, so merging them would change digests of evidence already on disk.

## Lifecycle status

| Stage | What exists | What does not exist yet |
|---|---|---|
| DISCOVER | CLI discovery for Claude, Codex, OpenCode; Ollama local discovery; OpenAI API listing; ladder rows with the command and date they were read from; a deterministic refresh with a per-route delta (`discovery-refresh.ts`) | a scheduler that calls the refresh; a store for snapshots and availability observations shared between machines |
| DESCRIBE | billing basis; cost eligibility; OpenCode published prices; the structured `ModelDescription` (context, output limit, tool use, effort levels, digest, runtime, free status — each with a source, or `unknown`) | a surface that renders it; coding/agentic intent from a structured source |
| BENCHMARK | prose campaigns; development runner; workspace tiers 1–3 and discriminator-one through Claude, Codex, OpenCode and Ollama drivers, with continuation and exact cell selection | live OpenCode or Ollama qualification (not run in this pass) |
| QUALIFY | identity proof and expiry; identity admission; effort-qualified workspace cells; ranking with adequacy; the unified per-route, per-capability read model (`route-qualification.ts`) with staleness | a persisted qualification index |
| ROUTE | ranking and recommendation outputs; the Ordra-facing candidate query (`routing-contract.ts`) | an automatic routing policy (by design none yet: the contract returns candidates, never a winner) |
| OBSERVE | attempt telemetry, OTLP observer, applied-effort evidence, throttle status, disposition coverage | continuous post-qualification observation |
| REQUALIFY | discovery evidence expiry; `notListed`; material-change deltas (`qualificationNowStale`) and `qualificationStaleness` reasons | a requalification trigger or schedule |

## Machine awareness

Nothing in routing or configuration names a host or a path. What is machine-aware today:

- hardware identity recorded on each campaign and workspace record (`os.hostname()` observed at run time);
- lock and runtime-lease records name the holding host;
- the discovery store is written on, and describes, the machine that ran discovery;
- history and profiles filter by `machineIdentifier`;
- development provenance records the machine and the git state of the build.

- machine identity is a fingerprint key (`machine-availability.ts`), and route availability is an
  observation per machine; a local route's qualification binds to the machine and the weights digest.

What Ordra will still need: somewhere to PERSIST availability observations and snapshots so another
machine can read them. The representation and the join (`route-qualification.ts`,
`routing-contract.ts`) exist; the shared store does not.

## Execution of model-modified code (V1 policy)

| | What | Allowed? |
|---|---|---|
| A | the model edits files | yes, inside the disposable workspace only |
| B | Cernum inspects the patch statically | always |
| C | Cernum runs a command SEALED in the benchmark definition on the model's tree (setup, baseline, verification, hidden checks, the Ollama loop's `run_check`) | only under macOS Seatbelt (no network, writes confined to the workspace and scratch, HOME unreadable); a machine without it refuses the run |
| D | a command the MODEL chose | never executed by Cernum. Third-party agent CLIs may run them as part of the tool, under the controls each driver records |

The development runner is unchanged: it grants no shell and its executed tier stays not measured.
