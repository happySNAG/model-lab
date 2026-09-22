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
| Provider → adapter / driver | `engine/host-factory.ts` (`buildAdapter`, `buildWorkspaceDriver`) | Prose/development attempts go through `FrontierAdapter`; workspace attempts through `WorkspaceAgentDriver`. |
| Discovery | `engine/discovery.ts` (`discoverProvider`, `discoverLocalModels`, `DESIRED_CANDIDATE_LADDER`) | Includes the free OpenCode pool (`FREE_OPENCODE_DEVELOPMENT_POOL`) and the OpenAI API identity rows. |
| Discovery evidence and staleness | `engine/discovery-store.ts` (`readDiscoveryStore`, `isEvidenceExpired`, `selectableFromStore`, `acceptedRequestEvidenceFor`) | Per machine: the store lives under the campaign root on the machine that ran discovery. |
| Authorised cohort | `engine/reconciliation.ts` (`AUTHORIZED_COHORT`) | Each authorisation is its own list: Pass 5C, V2, OpenAI API identity, free OpenCode pool. |
| Identity exception | `engine/provider.ts` (`IDENTITY_ADMISSIBLE_PROVIDERS`, `IDENTITY_UNNAMEABLE_BECAUSE`), `engine/identity-admission.ts` | One rule: Codex and OpenCode. Workspace matrix admissions (`workspace-matrix-admission.ts`) additionally require a provider their sealed limitation describes (Codex only). |
| Cost classification | `engine/cost-eligibility.ts` (`costEligibilityFor`) | `free_confirmed | subscription_included | local | metered | unknown_cost`. Enforced in `RoutingHost` for prose campaigns and in the development planner. |
| Published prices | `engine/opencode-pricing.ts` | A list price, never a measured charge. Only the cost-estimate script consumes it today. |
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
| Workspace (`workspace-*.ts`) | executed coding work: tests, hidden checks, scope, patch cleanliness, recovery | commands run with no provider credentials | Claude CLI, Codex CLI | per-cell qualification evidence (`workspace-aggregate.ts`, `workspace-effort-evidence.ts`) |

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
| DISCOVER | CLI discovery for Claude, Codex, OpenCode; Ollama local discovery; OpenAI API listing; ladder rows with the command and date they were read from | a scheduled or automatic refresh; a cross-machine discovery view |
| DESCRIBE | billing basis; cost eligibility; catalogued cost (`free/paid/unknown`); OpenCode published prices; Ollama `context_length` | structured context-window, tool-use or coding-capability metadata (today it is prose in `LadderProvenance.detail`) |
| BENCHMARK | prose campaigns; development runner; workspace tiers 1–3 and discriminator-one, with continuation and exact cell selection | an OpenCode or Ollama workspace driver |
| QUALIFY | identity proof and expiry; identity admission; effort-qualified workspace cells; ranking with adequacy | one unified qualification record combining prose, development and workspace evidence per route |
| ROUTE | ranking and recommendation outputs for a person to act on | an automatic routing policy (by design, none yet); "which qualified route is available on THIS machine now" |
| OBSERVE | attempt telemetry, OTLP observer, applied-effort evidence, throttle status, disposition coverage | continuous post-qualification observation |
| REQUALIFY | discovery evidence expiry makes a proof stale; `notListed` records disappearance from a catalogue | a requalification trigger or schedule |

## Machine awareness

Nothing in routing or configuration names a host or a path. What is machine-aware today:

- hardware identity recorded on each campaign and workspace record (`os.hostname()` observed at run time);
- lock and runtime-lease records name the holding host;
- the discovery store is written on, and describes, the machine that ran discovery;
- history and profiles filter by `machineIdentifier`;
- development provenance records the machine and the git state of the build.

What Ordra will need and does not have yet: a per-machine availability record that can be read
from another machine, and a query that joins it with qualification state.
