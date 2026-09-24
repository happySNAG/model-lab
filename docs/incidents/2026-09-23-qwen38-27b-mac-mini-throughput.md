# Incident — qwen3.8:27b could not finish discriminator-one work inside the sealed deadlines on this Mac mini

**Date:** 2026-09-23 · **Machine:** Mac mini (`Skippys-Mac-mini.local`) · **Build:** Cernum 1.0.0
**Campaign:** `minid1-qwen38-27b-streamfix` · **Candidate:** `ollama:qwen3.8:27b`
**Classification: MACHINE-SPECIFIC THROUGHPUT RESULT. Not a capability finding.**

---

## Summary

`qwen3.8:27b` was evaluated through Cernum's Ollama workspace driver (`driver.ollama.workspace`) on
the Intel Mac mini, CPU-only, against the sealed `pack.cernum.workspace.discriminator-one@1` pack.
**It did not complete a single case inside the sealed per-case deadline.** Across six cases and
eight attempts it produced no edit, left every workspace tree byte-identical to its baseline, and
ended every attempt either on the deadline or — once — on a transport failure. No case produced
scoreable capability evidence.

**This is a throughput result about one model on one machine in one configuration, and nothing
else.** It must NOT be read as a statement about:

* `qwen3.8:27b` on any other hardware;
* `qwen3.8:27b` under GPU-backed execution;
* `qwen3.8:27b` under any other Ollama version;
* `qwen3.8:27b` under any other context configuration;
* the model's underlying capability, on this machine or anywhere else.

The measurement says the model ran out of clock. It does not say what the model could have done
with more of it.

---

## Environment

Every value below is the value observed and recorded by the campaign itself, not a value looked up
afterwards.

| | |
|---|---|
| Machine | Mac mini, `Skippys-Mac-mini.local` |
| CPU | Intel Core i7-8700B @ 3.20 GHz, 12 logical cores |
| RAM | 34 359 738 368 bytes (32 GiB) |
| OS / platform | macOS 15.7.7, Darwin 24.6.0, `darwin-x64` |
| Execution | **CPU-only.** The runtime's own device inventory reports one compute device: `id=cpu library=cpu`. No GPU offload was available or used. |
| Machine fingerprint | `cmk1:37d83c60b9a852be4c45ce01` |
| Ollama version | `0.34.0`, endpoint `http://127.0.0.1:11434` (loopback only) |
| Model | `qwen3.8:27b` — architecture `qwen35`, 27.3 B parameters, `Q4_K_M` |
| Model weights digest | `22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643` |
| Model size on disk | 17 741 872 154 bytes |
| Discovered/native context | `localModelContextLengthTokens` = **262 144** (the runtime's own number) |
| Context actually opened | `localModelContextWindowRequestedTokens` = **32 768** (`num_ctx`, bounded by `OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS`) |
| Cernum runtime version | `Cernum 1.0.0` (sealed into every manifest) |
| Driver commit | `e1bcae9b4215b1f1419fef2060e41878ba696ee4` on `work/cernum-v1-ollama-fix`, preceded by `5ac36f8e8cd804942d959cf4fb48beece27b4049` |
| Sealed pack | `pack.cernum.workspace.discriminator-one@1` |
| Pack digest | `cwp1:03afd8f384dfe800245beb3e3f7ccf1eef1667c37a04672d0f3c1f91bd388edf` |
| Repeats | **1** per case |
| Per-case deadline | **900 000 ms** (`timeoutMilliseconds`) |
| Maximum attempts | 1 for four cases; 2 for `ws.d1.query-codec.nest` and `ws.d1.task-board.reassign` |
| Campaign window | 2026-09-23T15:32:22Z → 2026-09-23T17:31:58Z |

Binding identity is `verified` on every record, resolved from `localRuntimeDigest`: inference ran on
this machine, so the weights digest — not a remote identity admission — is what identifies the model.

---

## Original failure mode

Before the correction, `/api/chat` was requested with `stream: false`. A non-streaming request
writes nothing until it writes everything, so on a machine where one turn takes minutes the driver
was blind for most of the run. Four different situations produced the same observation — silence,
then one word:

1. a model generating slowly;
2. a runtime that never started the request;
3. another model occupying the runtime;
4. a socket that had died minutes before anyone noticed.

The consequences for measurement were specific:

* **Long silent `/api/chat` periods.** Stretches of 155–350 s with nothing on the record at all.
* **Runtime stall could not be distinguished from active generation.** Nothing in the evidence
  separated "the runtime is wedged" from "the model is thinking".
* **Timing failures collapsed into generic labels.** Every deadline ended as `timeout: the attempt's
  900000 ms deadline passed mid-turn`, and every transport ending as `transport`, whatever had
  actually happened.
* **What the driver called "time to first output" was not a first token.** `observedFirstOutputMilliseconds` could only ever hold the *end* of a turn, because the end of the turn was the first
  moment anything arrived. The figures it produced were times-to-complete-reply, wrong by minutes.
* **An unfinished turn left nothing behind.** Whatever the model had produced was still inside the
  runtime when the clock ran out, so it was lost.
* **One case produced no telemetry at all** — `ws.d1.config-migrate.upgrade` recorded no token
  counts, no messages and no usage block across its entire 900 s.

For those reasons the earlier qwen throughput finding was recorded as **provisional** and was not
treated as trustworthy capability evidence. It was not that the number looked wrong; it was that the
instrument could not say what it had measured.

**No upstream Ollama defect was proven, and none is claimed here.** The standalone reproduction of
the suspected runtime failure was never reliable. What follows is a Cernum-side correction to a
Cernum-side blindness.

---

## Driver correction

Commit `e1bcae9b4215b1f1419fef2060e41878ba696ee4` — *"stream the local runtime, and read what it is
holding before a case"*.

* **Streaming `/api/chat`.** `LocalRuntimeClient.chatStream` requests `stream: true` and consumes
  the NDJSON as it lands. A network chunk is not a JSON event, so the decoder is told its input is a
  stream: a partial line is carried forward rather than parsed, and a terminal line with no closing
  newline is still a line. Counts and durations are read from the **terminal event and nowhere
  else**, so nothing can be summed twice. Output from a turn that did not finish is now kept, marked
  `partialBefore:<outcome>`.
* **First-token timing.** TTFT is the arrival of the first event carrying content, thinking or a
  tool call — not the opening of the stream, which the runtime sends before the model has produced
  anything, and not the end of the turn. Where no token ever arrived the field is **absent** and
  `localFirstTokenUnavailableReason` states what happened instead.
* **Explicit terminal outcome classification.** `OLLAMA_STREAM_OUTCOMES` distinguishes `completed`,
  `runtimeUnavailable`, `requestNeverReachedModel`, `noFirstTokenBeforeDeadline`,
  `generationExceededDeadline`, `streamTransportFailure`, `streamPayloadMalformed` and
  `cancelledByCernum`. This is not a parallel taxonomy: `OLLAMA_FAILURE_FOR_STREAM_OUTCOME` is the
  single place it meets the closed `WorkspaceAgentFailureKind` every route shares, and the shared
  kind is still what records compare on. The outcome is the finer reading recorded beside it.
* **Idle/runtime probing.** The runtime is asked once, before each attempt, through `/api/ps`. It
  reports **residency, not activity**, because that is what `/api/ps` says; `noModelResident` is the
  ordinary case and never a fault. A runtime too old for the endpoint is `probeUnsupported`, not
  broken. The probe is bounded by five seconds and whatever is left of the case deadline, never
  polls, never waits for a slot, and decides nothing — a busy runtime is disclosed and the case
  still runs.
* **Transport hands over at the headers.** `loopbackHTTPFetch` used to resolve only once the whole
  body had arrived — the same blindness one layer down. It now exposes an incremental reader, and
  the caller's deadline covers the body as well as the headers.

Every earlier guarantee was preserved and re-proved:

* `num_ctx` derived from the discovered context and bounded by the **32 768** ceiling, with the
  measured length still recorded beside the opened one and nothing invented where nothing was
  published;
* header and body backstops derived from the sealed case deadline, so the case deadline outranks the
  HTTP client;
* cancellation still winning instantly;
* **loopback-only** at both the client and the transport;
* the **weights digest checked before the first turn and after the last**.

**Validation.** The driver behaviour was exercised against the real Ollama `0.34` runtime on this
machine and by the focused regression tests — 82 tests across the three Ollama files, including
event reassembly across chunks that split both JSON objects and multi-byte characters, no
double-counting of usage however the stream is cut, TTFT timed from the request and absent with a
reason when there is none, a 400 s generation completing inside a 900 s deadline while a shorter
deadline cuts the same one off, a broken stream / an empty one / an HTTP refusal / a malformed
payload as four different findings, honest and bounded probe readings, and nothing leaving loopback.
Typecheck and build are clean.

---

## Streaming rerun

Campaign `minid1-qwen38-27b-streamfix`, one row per attempt. All figures below are read from the
sealed records under `campaigns/workspace/minid1-qwen38-27b-streamfix-*`.

| Case (attempt) | Terminal outcome | Reached model | First token | TTFT | Wall | `prompt_eval_count` | `eval_count` | Edits | Scoreable |
|---|---|---|---|---|---|---|---|---|---|
| `ws.d1.asset-container.retitle` (1/1) | `noFirstTokenBeforeDeadline` | yes, 5 turns | yes, turns 1–4; **no** on turn 5 | 139 395 ms | 901 487 ms | 10 949 | 590 | 0 | **no** |
| `ws.d1.catalog-paging.walk` (1/1) | `generationExceededDeadline` | yes, 6 turns | yes | 99 264 ms | 901 926 ms | 11 362 | 584 | 0 | **no** |
| `ws.d1.config-migrate.upgrade` (1/1) | `generationExceededDeadline` | yes, 5 turns | yes | 92 056 ms | 901 429 ms | 10 638 | 602 | 0 | **no** |
| `ws.d1.log-redact.mask` (1/1) | `generationExceededDeadline` | yes, 5 turns | yes | 93 674 ms | 901 581 ms | 6 666 | 598 | 0 | **no** |
| `ws.d1.query-codec.nest` (1/2) | `generationExceededDeadline` | yes, 5 turns | yes | 97 151 ms | 901 371 ms | 8 053 | 365 | 0 | **no** |
| `ws.d1.query-codec.nest` (2/2) | `generationExceededDeadline` | yes, 4 turns | yes | 156 205 ms | 901 283 ms | 7 201 | 403 | 0 | **no** |
| `ws.d1.task-board.reassign` (1/2) | `generationExceededDeadline` | yes, 4 turns | yes | 94 540 ms | 901 461 ms | 3 752 | 293 | 0 | **no** |
| `ws.d1.task-board.reassign` (2/2) | `streamTransportFailure` | yes, 3 turns | yes | 127 619 ms | 863 804 ms | 3 163 | 266 | 0 | **no** |

Runtime residency before each attempt: `noModelResident` on the first case (probe 0 ms; the 45 s
model load is on its record), `thisModelResident` on all seven subsequent attempts (probe 0–1 ms).
Stream integrity: **3 245 events observed, 0 malformed**, across all eight attempts.

Throughput, per attempt, from the runtime's own durations:

| Case (attempt) | Prompt eval | Fresh prompt tok/s | Generation | Gen tok/s |
|---|---|---|---|---|
| `asset-container.retitle` (1/1) | 570.0 s (5 187 fresh of 10 949) | **9.10** | 233.4 s | **2.53** |
| `catalog-paging.walk` (1/1) | 433.0 s (4 053 fresh of 11 362) | **9.36** | 195.7 s | **2.98** |
| `config-migrate.upgrade` (1/1) | 571.4 s (5 162 fresh of 10 638) | **9.03** | 194.1 s | **3.10** |
| `log-redact.mask` (1/1) | 306.1 s (2 849 fresh of 6 666) | **9.31** | 207.1 s | **2.89** |
| `query-codec.nest` (1/2) | 414.0 s (3 817 fresh of 8 053) | **9.22** | 110.7 s | **3.30** |
| `query-codec.nest` (2/2) | 427.0 s (3 946 fresh of 7 201) | **9.24** | 136.6 s | **2.95** |
| `task-board.reassign` (1/2) | 215.2 s (1 977 fresh of 3 752) | **9.19** | 82.4 s | **3.56** |
| `task-board.reassign` (2/2) | 219.1 s (2 020 fresh of 3 163) | **9.22** | 74.5 s | **3.57** |

Campaign totals: 8 attempts, 37 turns, 99 tool calls, 82 file reads, 9 sealed commands executed,
**0 file writes**. 61 784 prompt-eval tokens (29 011 of them fresh, 32 773 cached) over 3 155.6 s,
and 3 701 eval tokens over 1 234.5 s, plus 45.1 s of model load. Total wall 7 174 706 ms.

**Verifier result.** The sealed verification commands ran on every case, before and after. On all
six, `workspaceFinalTreeDigest` equals `workspaceBaselineTreeDigest` — the workspace was never
modified — `patchByteCount` is 0, `changedFileCount` is 0, `scopeClean` is true and
`regressionCount` is 0. Every check that failed at baseline still failed; not one was fixed. Each
record carries `compositeUnavailableReason: no weighted metric was measurable on this attempt`.

**No case produced scoreable capability evidence.** There is observational, non-scoreable evidence
that the model was doing relevant work — it read 8–14 files per case, ran sealed checks, and in
`log-redact.mask` named the defects before the deadline landed — but Cernum's verdict rests on the
final tree and the verification commands, and neither moved.

**The one transport failure, precisely.** On `ws.d1.task-board.reassign` attempt 2, turn 3, after
the model had drafted implementations in its thinking channel, it emitted a tool call in
`<function>…<parameter>` XML form and the runtime's tool-call parser returned an error event: `XML
syntax error on line 4: element <function> closed by </parameter>`. Events had already arrived, so
the driver classified it `streamTransportFailure` rather than `requestNeverReachedModel`, and the
work up to that point is on the record. This is an observed interaction between this model's
tool-call emission and this runtime's parser. **It is not evidence of an upstream Ollama defect and
none is claimed** — but it reproduces the prior run's HTTP 500 exactly, so it is stable rather than
incidental.

---

## Finding

**Transport/runtime observation.** Cernum can now distinguish runtime availability, first-token
arrival, streaming progress, transport failure, and generation deadline exhaustion. Every turn in
all eight attempts has either an observed first token or a stated reason for having none, and 3 245
stream events arrived with none malformed. The earlier "hang" was the driver being blind, not the
runtime being stuck.

**Throughput.** `qwen3.8:27b` is **not operationally suitable for discriminator-one workloads under
the sealed 900 s deadlines on this specific Intel Mac mini, CPU-only, at `num_ctx` 32 768.** At
9.0–9.4 fresh prompt-eval tokens/second and 2.5–3.6 generation tokens/second, a discriminator-one
case accumulates 10 k+ prompt tokens over its turns and prompt evaluation alone consumes 306–571 s
of each 900 s attempt. The bottleneck is re-evaluating a growing conversation, not generation.

**Capability.** **No capability claim is made.** Every case ended before enough valid work was
produced to score, so the absence of edits is a statement about the clock, not about the model. The
0/N rows on the declared dimensions are timeouts with no edits and must not be read as capability
findings. The only defensible sentence is the narrow one: *`qwen3.8:27b` is disqualified on this
machine for discriminator-one, on throughput grounds.* No individual case produced valid capability
evidence, so there is none to document here.

---

## Comparison to the previous run

The prior campaign `minid1-qwen38-27b-ollamafix-*` ran on the same machine, same pack, same sealed
cases, same 900 s deadlines and the same weights digest, between 2026-09-23T00:07Z and 02:06Z, under
the non-streaming driver.

| | Prior (`ollamafix`) | Streaming (`streamfix`) |
|---|---|---|
| Total wall | 7 149 469 ms | 7 174 706 ms (+0.4 %) |
| Cases with any telemetry | **5 of 6** | **6 of 6** |
| "First token" recorded | 129 486 – 248 961 ms — **time to a complete reply** | 92 056 – 156 205 ms — **an actual first token** |
| Messages / tool calls | 26 / 76 | 38 / 99 |
| Stream events observed | not observable | 3 245, **0 malformed** |
| Prompt-eval tokens | 52 834 (one case unmeasured) | 61 784 |
| Eval tokens | 3 234 | 3 701 |
| File writes | 1 (`task-board`, net patch 0 bytes) | 0 |
| Scoreable cases | 0 of 6 | 0 of 6 |
| Failure vocabulary | `timeout` ×5, `transport` ×1 | `noFirstTokenBeforeDeadline`, `generationExceededDeadline` ×6, `streamTransportFailure` |

**Why the new result supersedes the provisional interpretation.**

* The old driver could not separate silent generation from a stalled runtime or a dead socket, so
  "too slow" and "never reached" were the same observation.
* The new driver exposes TTFT and the terminal mechanism, so each attempt now states which of the
  eight recognised endings it had and when the first token arrived.
* The new evidence demonstrates **genuine deadline pressure** — the model was demonstrably
  generating, at a measured rate, and ran out of clock — rather than ambiguous transport behaviour.
  The sharpest single contrast is `ws.d1.config-migrate.upgrade`: prior run, 1 turn, 0 tool calls, 0
  messages and no usage block at all across 900 s; streaming run, 5 turns, 602 eval tokens, sealed
  checks run, and a stated reason for stopping.

**The measurement was the artifact; the direction was not.** Marking the earlier finding provisional
was correct, and the corrected measurement points the same way.

**The prior campaign evidence is preserved, not rewritten.** `minid1-qwen38-27b-ollamafix-*` and the
earlier `minid1-qwen38-27b-*` records are untouched — not edited, not re-scored, not deleted. They
remain the historical record of what this machine did under the non-streaming driver. The link
between the runs is a pointer in one direction; nothing flows back.

One honest regression to state rather than paper over: the prior run produced **one** file write and
this one produced **zero**. That is run-to-run variance at ~3 tok/s against a fixed wall — in the
streaming run the model spent its turns reading and diagnosing and was cut off while composing the
edit. **The new run is not claimed to be better on edits.**

---

## Release impact

* **The Ollama driver defect is resolved sufficiently for V1 measurement.** Transport, runtime
  state, first-token arrival and each distinct way a turn can end are separately observable and
  separately recorded.
* **qwen being too slow on this machine is an acceptable qualification outcome.** It is a valid
  throughput measurement with a valid negative result.
* **Models do not need to pass qualification for Cernum itself to pass the release gate.** What the
  gate asks is that Cernum *measure them correctly*. It now does, and the measurement it produced is
  a defensible disqualification rather than an ambiguous one.
* **Final Mac mini release verdict: RELEASE GATE CLEARED.**

Also on the record:

* **`gemma4:12b`'s earlier adverse capability evidence remains separate and stands.** Its relevant
  failure was not caused by the non-streaming blindness, so nothing here disturbs it. It was not
  rerun; nothing in this pass gave a reason to.
* **The six sealed-evidence gate suites remained green.** Re-run against the LaCie-backed evidence
  root on 2026-09-23: `req03-phase0-evaluator-soundness`, `pass10-adoption-gate`,
  `req03-phase4-adoption-gate`, `req03-phase5-adoption-gate`, `req03-phase6-generation-routing` and
  `pass10-gate-b-calibration` — **6 files, 231 tests, all passing**. None of them depends on the
  local-runtime driver path.
* **Remote provider qualifications were unaffected.** This is specific to `driver.ollama.workspace`
  over loopback; no metered or subscription route was touched, and no spend was incurred (every
  record carries `billingBasis: local`, `costMicroUSD: 0`, `costProvenance: measured`).

One caveat about the wider suite, stated so it is not discovered later: 58 tests in
`workspace-codex-driver`, `workspace-matrix-effort-telemetry` and `workspace-cell-selection` fail on
this machine. They are **pre-existing and unrelated to Ollama** — this host has `codex-cli 0.154.0`
while `CODEX_CLI_VERSION_VERIFIED_AGAINST` is `0.155.0`, so the Codex driver refuses with
`policyNotExpressible` exactly as designed. The product is behaving correctly; those tests are not
hermetic, because they read the machine's installed CLI. They reproduce identically on `5ac36f8`
with the streaming change stashed.

---

## Future requalification

`qwen3.8:27b` should be reconsidered for this workload **only if a materially relevant condition
changes**, including:

* a **different machine** — particularly one not limited to a 2018-generation x86 CPU;
* **GPU acceleration** becoming available to the runtime for this model;
* a change to the **model or runtime digest** — different weights, different quantization, or an
  Ollama build that reports a different weights digest for the same tag;
* a **substantial Ollama performance change**, especially to prompt evaluation or KV-cache reuse,
  since prompt evaluation and not generation is what exhausted the deadline here;
* a **materially different context configuration** — a different `num_ctx`, a different ceiling, or
  a case shape that does not accumulate 10 k+ prompt tokens over its turns;
* a **benchmark or deadline policy change** — a longer per-case deadline, a different pack, or a
  different sealed case set.

**Do not requalify it merely because time has passed.** Nothing about the passage of time changes
9 fresh prompt-eval tokens per second on this CPU. A requalification run needs a named changed
condition, and the new campaign supersedes rather than rewrites what is recorded here.
