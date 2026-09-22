# Codex workspace driver — `driver.codex-cli.workspace`

The second provider on Cernum's agentic side. It plugs into the same `WorkspaceAgentDriver` seam as
`driver.claude-cli.workspace` (`src/engine/workspace-agent.ts`), so the benchmark engine is not forked.
The same `runWorkspaceCase` makes the workspace, checks the fixture seal, establishes the baseline,
diffs the tree, runs visible and hidden verification, scores, retries and seals the record. Only the
provider execution adapter differs.

Source: `src/engine/workspace-codex-driver.ts`. Tests: `test/engine/workspace-codex-driver.test.ts`
(63 parity tests, no process leaves the machine) and `test/engine/workspace-codex-loopback.test.ts`
(opt-in, `CERNUM_CODEX_LOOPBACK=1`: the real installed CLI with a loopback provider, at zero cost).

## 1. The installed CLI, as audited (2026-09-21)

| | |
|---|---|
| Executable | `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`, where the `current` **directory** is itself a link to `releases/0.155.0-aarch64-apple-darwin`. A second `/opt/homebrew/bin/codex` (npm wrapper) is broken (`spawn … ENOENT`). `findExecutable` takes the first one on `PATH`. |
| Version | `codex-cli 0.155.0`. The driver **refuses any other version**, because `-c` accepts unknown keys silently (see §4). |
| Non-interactive mode | `codex exec`. When no prompt argument is given it reads the prompt from stdin (`Reading prompt from stdin...`). |
| Output | `--json` (JSONL on stdout). `-o/--output-last-message`, `--output-schema` and `--color` also exist. |
| Model / effort | `-m <model>`; `-c model_reasoning_effort="<effort>"`. Confirmed on the wire against a loopback fake: the request body carried `reasoning: {effort: "medium"}`. |
| Working directory | `-C <dir>`. The model's rendered environment context names exactly that directory as its workspace root. |
| Approval / sandbox | `-s read-only\|workspace-write\|danger-full-access`, `--add-dir`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`; config `approval_policy`; named permission profiles (`default_permissions`, `[permissions.<name>]` extending `:workspace` / `:read-only`). |
| Isolation switches | `--ignore-user-config` ("auth still uses `CODEX_HOME`"), `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, `--disable <feature>` (unknown names are refused). |
| Session persistence | Off with `--ephemeral`. |
| Usage | `turn.completed.usage`: `input_tokens` (the total), `cached_input_tokens` (a subset), `cache_write_input_tokens`, `output_tokens` (**includes reasoning**, see §7), `reasoning_output_tokens`. No cost figure and no allowance figure. |
| Events | `thread.started`, `turn.started`, `item.started`/`item.completed` (`agent_message`, `reasoning`, `command_execution`, `file_change`, `todo_list`, `error`, `web_search`, `mcp_tool_call`, `collab_tool_call`), `turn.completed`, `turn.failed`, and top-level `error` (for example reconnect notices). |
| Exit | 0 on a completed turn. Non-zero on `turn.failed`, which still prints the event that says why. |

Every flag and field above was read from `--help`, `codex features list`, the binary's own generated
schema (`codex app-server generate-json-schema`), `codex sandbox` (validates the configuration and runs
a local command), `codex debug prompt-input` (renders the model-visible prompt locally), and `codex exec`
pointed at a loopback fake of the Responses endpoint. No paid request was used for the audit.

## 2. Identity: what changed, and what did not

The prior finding still holds on 0.155.0: **`codex exec` names no model.** No stream event carries one.
The OTLP `model`/`slug` attributes are what the **client sent**. No `server_model` attribute appears in
any captured payload: not in the 2026-09-20 smoke telemetry, not in the live proof, and not in a
loopback run where the fake server returned a different model in its `openai-model` header.

One new finding: the CLI reads the service's `openai-model` response header, and when it differs from
the request it emits

```
{"type":"item.completed","item":{"type":"error","message":"model rerouted: <requested> -> <served> (HighRiskCyberActivity)"}}
```

Loopback tests showed this item is present when the header differs. It is absent when the header
matches, and also absent when there is no header at all. So the stream can now prove a **substitution**,
but it still cannot prove an **identity**. The driver:

- records a reroute's served model as `reportedModelID`, and fails the attempt as `policyNotExpressible`
  (the host's execution verdict becomes `substituted`);
- otherwise leaves `reportedModelID` empty, so the execution verdict is `unverifiable`;
- never copies the requested `-m` into any "reported" or "verified" field.

A Codex route therefore reaches a workspace run only through the existing Pass 6 **identity admission**
(`--admit-identity-unverifiable <file>`). That admission is a person's written authorization, sealed into
the record's manifest and bound to that record's label. It is recorded as
`requestAcceptedIdentityUnverifiable`, and it is never routable or promotable (`identity-admission.ts`).
A matrix uses a **matrix admission** instead, sealed per route to one matrix and one pack; see §10.
The OpenAI **API** identity proofs (sol, luna, terra, astra) belong to a different route (`openaiAPI`)
and are not borrowed here.

## 3. Invocation and sandbox

```
codex exec --json --color never -C <workspace>
  --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
  -c forced_login_method="chatgpt"
  -c approval_policy="never"
  -c default_permissions="cernum_workspace"
  -c permissions.cernum_workspace.extends=":workspace"
  -c permissions.cernum_workspace.filesystem={ "<HOME>"="none", <CLI install dirs>="read", ":slash_tmp"="read" }
  -c skills.include_instructions=false
  -c tools.web_search=false  -c web_search="disabled"
  --disable browser_use browser_use_external computer_use image_generation apps plugins hooks memories
            multi_agent multi_agent_v2 shell_snapshot sleep_tool unbounded_connection_retries
  [-c otel=…loopback…]  -m <model>  [-c model_reasoning_effort="<effort>"]
```

The instruction goes on stdin, never in argv. `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`,
`--search`, `--approve-for-me`, `-s danger-full-access` and `--profile` are never sent.

**What the macOS Seatbelt sandbox enforces**, proven with `codex sandbox -P` and again through `codex exec`
in the loopback test:

- model commands and patches can write only to the workspace and the runner's disposable `TMPDIR`;
- `/tmp` is read-only;
- `HOME` is unreadable, including `~/.codex/auth.json` (`Operation not permitted`);
- network access from model commands is denied (DNS fails);
- a patch aimed outside the workspace is rejected. That rejection appears **on stderr only**, not in the JSONL.

The CLI's install tree is re-allowed read-only, following symlinks at every path component. This is
needed because the CLI re-executes its own binary through the sandbox helper to load AGENTS.md; without it
the session fails with `sandbox-exec: execvp() … Operation not permitted`. The first resolver version
missed the linked `current` directory, and the real-binary loopback test caught it.

**Shortfalls, recorded on every attempt as `notEnforceable`, never claimed away:**

- The CLI process itself is not sandboxed. It reads its session from `HOME`, which is why the case unlocks `HOME`.
- Paths outside `HOME` stay readable to model commands, as the built-in `:workspace` profile has it.
- There is no output-token budget, and no cost or allowance figure.
- The deadline is Cernum's.
- There is no file-read tool (see §6).
- Hosted web search is off by two documented keys, but Pass 8 showed a switch like this can fail to hold, so it is **detected** and fails the attempt.

**Refusals, made before anything is spent:**

- a case withholding any tool (`expressesToolPolicy: false`: current routes are `code_mode_only`, and no switch has been observed to remove the shell from them);
- an executable allow-list (inexpressible under `approval_policy=never`);
- `networkPolicy: denied` (through `driverShortfalls`) and `unrestricted`;
- sampling settings, and effort `ultra` (an orchestration mode);
- a workspace inside `HOME`;
- any `OPENAI_*`/`CODEX_*` environment name;
- a CLI version other than 0.155.0;
- a session that is not ChatGPT.

All 18 sealed cases declare all three tools, no allow-list and `providerOnly`, so none is refused.

A delegation (`collab_tool_call`) or any withheld tool item fails the attempt as `policyNotExpressible`.

## 4. Why `-c` keys get extra scrutiny

`codex -c skills.cernum_bogus_key=false` raises no error. An unknown `-c` key is silently ignored, so a
key that merely parses proves nothing. Each `-c` key the driver sends has either an observed effect or a
declaration in the binary's own schema:

- `forced_login_method`: schema enum `chatgpt|api`; `login status` under `api` reports `Not logged in`.
- `approval_policy`: shown in the rendered prompt.
- the permission profile: shown in the rendered environment context, and enforced in probes.
- `skills.include_instructions=false`: removes the `<skills_instructions>` block.
- the two web-search keys: validated in Pass 8.

`--disable` names are checked by the CLI itself.

## 5. Authentication and billing

- `codex doctor --json` under the case's allow-listed environment reports: stored auth mode `chatgpt`,
  ChatGPT tokens stored, no API key stored. The driver runs this probe (and `--version`) before its first
  spawn. It refuses an API-key session, or an unreadable auth state, as `notAuthenticated`.
- `forced_login_method="chatgpt"` makes the CLI itself refuse any other login.
- The operator's shell has `OPENAI_API_KEY` set. It never reaches the child: the workspace environment
  is an allow-list (`HOME`, `USER` plus machine names), and the driver refuses any `OPENAI_*`/`CODEX_*`
  name outright.
- The CLI needs `HOME` to find `~/.codex/auth.json` (`File` storage mode). It does not need the Keychain.
- Billing basis: `subscriptionIncluded`. The marginal API charge is a measured $0. Plan allowance is
  consumed but **not reported** by this tool. It is recorded as unavailable, never as zero. No
  API-price "list value" is computed, because pricing tokens at the requested model's API rate would
  assume the requested model answered.
- The live proof's telemetry reported `auth_mode: Chatgpt`.

## 6. Transcript mapping

Every driver event is `agentReported`. Engine-only kinds (`attemptStarted`, `attemptFinished`,
`verificationRan`, `retryStarted`, `harnessFault`, `boundaryRefusal`) are never emitted by the driver.

| Codex item | Transcript events |
|---|---|
| `agent_message` | `message` (visible). The **last** one becomes `finalMessage`, and the runner emits the single `finalResponse`. |
| `reasoning` | `message` (thinking) |
| `command_execution` started | `toolCall` (`command_execution`) |
| `command_execution` completed | `commandExecuted` per executable, parsed from the inner string after removing the CLI's `/bin/zsh -lc '…'` wrapper; plus a `toolResult` with `ok` and the exit code. The exit code goes on a `commandExecuted` only when the string named one executable. |
| started but never completed (deadline) | `commandExecuted` with no exit code |
| `file_change` completed | `fileWrite` per path, when `status: completed` (paths reconcile to workspace-relative); plus `toolResult`. A failed patch claims no write. |
| `web_search`, `mcp_tool_call`, `collab_tool_call`, anything else | `toolCall`, and the attempt fails |
| `error` item | a reroute is detected (§2); other errors are kept as notes for failure detail, not in the transcript |
| `todo_list` | nothing |

**No `fileRead` is ever emitted.** Codex has no read tool; it reads through `cat`/`sed`/`rg`, and
inferring reads from command strings would be guessing. The engine's tree diff and verification remain
the authority. The parity tests prove a narrated-but-absent patch scores `behavioralFailure`, and an
unmentioned real change is still diffed.

## 7. Tokens, timing, cost

| Shared field | Codex source |
|---|---|
| `inputTokens` | `input_tokens` (**the total**, cached included) |
| `cacheReadInputTokens` | `cached_input_tokens` (a subset of the total) |
| `cacheCreationInputTokens` | `cache_write_input_tokens` |
| `freshInputTokens` | total − cached − cache-write |
| `reasoningTokens` | `reasoning_output_tokens` |
| `visibleOutputTokens` | `output_tokens − reasoning_output_tokens` |
| `rawUsage` | the block, verbatim |
| `observedFirstOutputMilliseconds` | arrival of the first **model-produced item**. `thread.started` arrives at CLI start-up and would time the CLI, not the model. |
| `providerReportedTimeToFirstTokenMilliseconds` | OTLP `codex.turn_ttft.duration_ms` (with `--otlp-observer`) |
| `providerReportedEffort` / `AuthMode` / `SandboxPolicy` / `ApprovalPolicy` | OTLP `codex.conversation_starts` |

**Reasoning is included in `output_tokens`. This was established by the live proof.** The turn reported
input 67,791 · output 1,413 · reasoning 117 · telemetry `total_tokens` 69,204, and 67,791 + 1,413 = 69,204.
Every per-request `response.completed` record agrees. Before this proof, every captured Codex turn had
`reasoning_output_tokens: 0`, so the question could not be settled. The live proof record itself was
sealed under the earlier pass-through mapping, so its `totalTokens` reads 69,321 (117 over). Its sealed
`rawUsage` recomputes to the correct figures, and the record is not rewritten.

Retries and waste use the shared host (`wastedTokensOf`, `retryCount`). Marginal charge: `0` (`measured`).

## 8. The live proof (2026-09-21)

One request, under the brief's authorization, after every non-live test passed.

| | |
|---|---|
| Case | `ws.broken-sum.mean@3` · digest `cwc1:e4b98967…` · fixture sealed `e8b6fd5c…` |
| Route | `codexCLI` · `gpt-5.6-sol` · effort `medium` · operator cap 1 attempt |
| Identity before | `requestAcceptedIdentityUnverifiable`, resolved from a sealed admission (`~/cernum-evidence/codex-workspace/2026-09-21-admission-gpt-5.6-sol-medium.json`, resting on the 2026-09-20 smoke evidence `sha256:fa2723c3…`) |
| Identity after | `unverifiable`: the tool named no model, and no reroute was reported |
| Outcome | **pass**, composite 992/1000, 1 file / 9 lines changed, scope clean, 0 regressions, 69.4 s |
| Tokens | in 67,791 (56,832 cached) · output 1,413 incl. reasoning 117 · telemetry total 69,204 |
| Cost | marginal $0 (measured) · allowance not reported |
| Telemetry | effort `medium`, auth `Chatgpt`, sandbox `workspace-write`, approval `never`, TTFT 2,865 ms; leak audit clean |
| Record | `~/Library/Application Support/Cernum/campaigns-codex-workspace-proof-01/workspace/codex-sol-medium-broken-sum-proof-01` |
| Evidence | `~/cernum-evidence/codex-workspace/2026-09-21-codex-sol-medium-broken-sum-proof-01.json`, `…/otlp/` |

No Claude campaign, record or evidence file was touched. The proof used its own campaign root.

**This row means "what answered when `gpt-5.6-sol` was requested on the Codex subscription route". It
does not mean "gpt-5.6-sol answered".** It carries no routing or promotion weight, and it must not be put
in a table beside the Claude results as though identity were equally established.

## 9. Not done in this pass

- **Matrix admission.** Done in the following pass; see §10.
- **Throttle scope.** `codexCLI` has no declared scope in `DECLARED_PROVIDER_THROTTLE_SCOPE`. It falls back
  to the default until a Codex usage limit has been observed.
- **Exact identity.** The only route to server-attested identity on the subscription path would be a
  loopback proxy observing the `openai-model` header. That means intercepting OAuth-bearing traffic,
  which this engine's own OTLP design explicitly rules out. It is not done without an explicit decision.

## 10. Matrix admission (`workspace-benchmark`)

Source: `src/engine/workspace-matrix-admission.ts`. Tests: `test/engine/workspace-matrix-admission.test.ts`.

A single-record admission is sealed to one record's label, so it cannot authorise a matrix. A matrix gets
its own admission, read only from `cernum workspace-benchmark … --admit-identity-unverifiable <file>`.
There is no environment variable and no configuration default for it. The file declares
`"admissionScope": "workspaceMatrix"`; the single-record reader refuses such a file, and the matrix
reader refuses a single-record file.

**What it binds.** The invocation seals the file (`cma1:`) to this matrix's `--label` and to the pack's
id, version and `cwp1:` digest. The operator copies the digest from the dry run. Each admitted route is
its own sealed entry (`cme1:`) naming the provider, requested model, requested effort, driver id, the CLI
version the driver's flags were verified against, the execution class, the billing basis, the
authentication basis, and the smoke evidence it rests on. The file also records who authorised it, the
reason, the intent, and the file's SHA-256. The identity limitation is written by the engine, not by the
operator.

**The gate** is `matrixAdmissionFor`. It refuses in each of these cases, and names the mismatch:

- the seal is broken;
- the admission belongs to another matrix, pack or pack digest;
- no entry names the exact `provider:model@effort`;
- an entry names the route but disagrees on the driver, CLI version, execution class or billing basis.

`claudeCLI` and `openaiAPI` entries cannot be sealed at all. The planner also refuses an admission with an
entry the matrix would not use, such as a `@max` entry in a `medium` matrix. So each matrix needs one
admission naming exactly its routes. An admitted route also needs an **unexpired identity smoke** in the
discovery store showing the provider accepted that model **at that effort**
(`acceptedRequestEvidenceFor`). That row stays `unproven` and never becomes selectable. An admission accepts
an unverifiable identity. It does not stand in for a request nobody sent.

**Per record.** For every cell, the plan derives an ordinary Pass 6 `IdentityAdmission` sealed to that
record's own label, admitting exactly that one route, and carrying a `matrixAdmission` reference. That
reference holds both digests, plus the pack, driver, billing and limitation. The manifest freezes it by the
existing path. `WorkspaceCampaign.create` re-checks two things. First, the admission admits this label and
this binding's route. Second, its matrix reference matches this record's pack, driver, execution class and
billing basis. Each row carries:

- `bindingIdentityState: requestAcceptedIdentityUnverifiable`
- `bindingIdentityResolvedFrom: identityAdmission`
- `executionIdentityVerdict` (`unverifiable`, or `substituted` on a reroute)
- `identityAdmissionDigest` (per record)
- `identityAdmissionScope: workspaceMatrix`
- `matrixAdmissionDigest`, `matrixAdmissionEntryDigest`
- `identityLimitation`

Nothing writes `verified`. A single-record admission gets no `matrixAdmission` key, so its digest does not
change. The sealed proof's admission still seals to `eee8a935…`, and a test holds it there.

**Reroute.** A `model rerouted: A -> B` still fails that attempt as `policyNotExpressible`. The row records
verdict `substituted` and `reportedModelID: B`. The run result lists the run under `identitySubstitutions`.
The matrix carries on, because a reroute is a failed run, not a throttle, and the plan is never edited. A
later cell of the same route is still `requestAcceptedIdentityUnverifiable` and is checked independently.
An admission for A never admits B.

**Aggregate.** Cells with an admitted or substituted run carry `identityProvenance`: admitted counts,
digests, verdict counts and substitutes. The `--aggregate` file carries `identity`, which holds:

- the sealed matrix admission;
- the mapping from each candidate to its admission;
- the admitted-unverifiable run count;
- substitution failures;
- identity-verification failures, meaning runs that started verified and were not confirmed.

Quality figures are computed exactly as before. A test shows that the same rows, with the admission fields
removed, produce identical quality.

**Throttle scope** for `codexCLI` stays **undeclared**, because no Codex usage limit has been observed. The
breaker uses the conservative `provider` fallback, and the dry run labels it UNDECLARED.

**Applied effort** is measured in a matrix; see §11.

## 11. Applied effort in a matrix, and the session preflight

Sources: `src/engine/workspace-effort-evidence.ts`, `src/engine/workspace-matrix-telemetry.ts`.
Tests: `test/engine/workspace-matrix-effort-telemetry.test.ts`.

**Collector.** A live Codex `workspace-benchmark` with an effort starts one loopback OTLP collector
(127.0.0.1, ephemeral port) before the first request, and every `codex exec` gets `-c otel=…` pointing
at it. The override touches neither `forced_login_method` nor the child's environment. Evidence is written
redacted to `<root>/workspace/<label>.otlp/` (or `--otlp-observer <dir>`). If the collector cannot start,
the matrix is refused before anything is sent. If it fails part-way, later Codex cells are recorded as
`measurementUnavailableBeforeExecution`, not as throttles or model failures.

**Where applied effort comes from (0.155.0).** `reasoning_effort` on the `codex.conversation_starts` log
record, and `model_reasoning_effort` on each `codex.sse_event` (`response.completed`). Both carry
`conversation.id`, which equals the `thread_id` the run printed.

**Correlation boundary.** A run's telemetry is only the set of records carrying its own conversation id.
Time is never used to attribute a record. A run with no `thread_id` is `noConversationID`. A conversation
id claimed by two attempts is attributed to neither. A record whose client-sent `model` differs from the
request is refused. Records without an id, such as startup spans, join no run.

**Verdicts.** `appliedEffortVerified`, `appliedEffortMismatch`, `appliedEffortUnavailable`,
`appliedEffortAmbiguous` (and `appliedEffortNotRequested` for effort `none`). Rows carry `requestedEffort`
and `appliedEffort` as separate fields, plus `appliedEffortVerdict`, `appliedEffortEvidenceSource`,
`telemetryCorrelation`, `appliedEffortAttempts` and `telemetryCapture`. Rows from other drivers get none
of these fields.

**Mismatch policy.** The run keeps its workspace evidence, status and score. The row is flagged, the run is
listed, and the candidate is **not qualified** at the requested effort. Unavailable or ambiguous telemetry
also leaves the candidate unqualified. Quality figures are not adjusted. The matrix does not stop for a
mismatch. Telemetry that arrives after a run is sealed is reported, and can only withdraw a qualification.

**Session preflight.** `codex doctor --json` is the non-model probe, run with every `OPENAI_*`/`CODEX_*` name
removed. It reads the credential store and does an HTTP reachability probe (405) and a WebSocket handshake
that carries the bearer and sends no request frame. It refuses a matrix with no stored credentials, or with
an API-key session. It cannot tell whether stored tokens are still valid for inference, so the first run
still discovers that. A dry run does not run it, because a dry run contacts nothing.

