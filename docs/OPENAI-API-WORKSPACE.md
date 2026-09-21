# OpenAI API workspace path — architecture and decision (not implemented)

**Status:** specified, deliberately not built in the Codex workspace pass (2026-09-21). `buildWorkspaceDriver`
returns `undefined` for `openaiAPI`, and `cernum workspace --provider openaiAPI` refuses with "workspace
driver unavailable". It never falls back to prose execution.

This route is separate from the Codex subscription CLI, and the two must not be conflated:

| | `codexCLI` (built) | `openaiAPI` (this document) |
|---|---|---|
| Billing | subscription-included, allowance unreported | metered per token against a key |
| Identity | unverifiable; admission only | **provable**: the API returns `model` on every response (sol, luna, terra and astra were all proven 2026-09-20) |
| Agent loop | the CLI's | **Cernum's**, which does not exist yet |
| Tools / sandbox | the CLI's (`apply_patch`, `exec_command`, Seatbelt profile) | **Cernum's**, which does not exist yet |

## Can the current architecture support it?

| Requirement | Today | Gap |
|---|---|---|
| Tool use | `MeteredAPIAdapter` speaks `/v1/chat/completions` with no `tools` | The adapter would need to send tool definitions and read tool calls, preferably on `/v1/responses`. |
| File edits | none | A patch tool implemented by Cernum, with every path confined through `resolveInside`. |
| Command execution | none for agents; `workspace-execution.ts` runs *verification* commands only | An executor for **model-chosen** commands. That is the risky part: it must not be weaker than the Codex Seatbelt profile. |
| Multi-turn loop | none | A bounded loop with a turn cap and a wall-clock deadline, emitting the same transcript events. |
| Bounded spend | `SpendTracker` with a per-attempt worst case from `maxInputTokens`/`maxOutputTokens` | A workspace binding has no token ceiling (`notExpressibleByContract`), so no worst case exists. The loop has to *create* the bound: per-request `max_output_tokens`, a turn cap, and a cumulative-token stop, so that worst case = turns × per-request ceiling. The ceiling must be checked before every request, not once per attempt. |
| Exact identity | proven per response via `verifyProviderIdentity` | none: check every response in the loop, and fail the attempt on the first substitution |
| Provider token use | parsed today (`completion_tokens_details.reasoning_tokens`) | Sum across turns. Settle whether `completion_tokens` includes reasoning (on Codex it does; see `CODEX-WORKSPACE-DRIVER.md` §7). |

## Proposed shape

`driver.openai-api.workspace` implements `WorkspaceAgentDriver` like the other two. The engine stays the same.

1. **Transport.** Responses API, streaming, with `store: false`. `model` comes from the frozen binding.
   `reasoning.effort` goes only where the API's enum contains the level (`max` is refused, as in
   `OPENAI_API_EFFORT_LEVELS`). The key comes from `credentials.ts`, never from the workspace environment.
2. **Tools.** Three, with the case's `ToolPolicy` deciding which are offered, so this driver *can* set
   `expressesToolPolicy: true`:
   - `read_file(path)`: through `resolveInside`, which makes `fileRead` genuinely **engineObserved**. This is stronger than either CLI.
   - `apply_patch(patch)`: the same grammar Codex uses, applied by Cernum, and confined. Writes are **engineObserved**.
   - `run_command(argv[])`: an argv, not a shell string, so `allowedExecutables` becomes enforceable. It runs under `sandbox-exec` with a Cernum-owned profile: workspace-only writes, no network, `HOME` unreadable. The profile must be tested at least as hard as the Codex one before this ships.
3. **Loop.** Stop on a final message, the turn cap, the cumulative-token cap, the attempt deadline or cancellation. Every response's `model` goes through `verifyProviderIdentity`, and a substitution fails the attempt.
4. **Spend.** The binding carries the loop bound as its ceiling, so `worstCaseAttemptMicroUSD` is finite.
   `--authorize-metered` plus a dollar ceiling are required, exactly as for prose campaigns.
5. **Evidence.** `reportedModelID` is set from the API, so `executionIdentityVerdict` can be `verified`.
   Rows are metered, with `costProvenance: providerReported` from the pricing snapshot
   (`~/cernum-evidence/openai-api-pricing-2026-09-20.json`).

## Why it was not built in this pass

This is not an adapter. Cernum would become the agent harness: the tool implementations, a sandbox for
model-chosen commands, a loop, and a new spend-bounding contract. The command sandbox alone needs the
kind of adversarial testing the Codex profile received. Shipping it inside a pass whose subject was the
Codex CLI would have expanded scope materially. It would also have created a second, weaker sandbox
beside a proven one. The next pass should build it as its own unit, with its own loopback tests: a fake
Responses server playing a scripted model, as `workspace-codex-loopback.test.ts` does.

## One caution for comparisons

An API-harness result and a Codex-CLI result for the same model are **different experiments**: different
system prompt, tools, tool grammar and loop. Neither is "the model's score". Keep them as separate
candidates with separate comparability, and never merge them.
