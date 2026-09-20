// Cernum · the bytes `opencode run --format json` ACTUALLY WROTE, captured once, on purpose.
//
// WHY THIS FILE EXISTS. Every OpenCode fixture in this repository before it was shaped from the
// SDK's `Event` union in `@opencode-ai/sdk/dist/gen/types.gen.d.ts` — `message.updated`,
// `message.part.updated`, `AssistantMessage`. Those types are real, and they are the wrong layer.
// `opencode run --format json` does not forward the SDK event stream. It SUBSCRIBES to that stream
// and re-writes a chosen subset of it onto stdout in a flat envelope of its own:
//
//     {"type": <name>, "timestamp": <ms>, "sessionID": <id>, ...payload}
//
// so the adapter, and every test that agreed with it, read a framing the tool never emits. That is
// the Pass 4B failure — an adapter written from assumption, tested against the same assumption —
// arriving one layer below where the header guarding against it was looking.
//
// -- PROVENANCE ---------------------------------------------------------------------------------
//
//   CAPTURED     2026-09-20, opencode-ai@1.18.31, macOS arm64, credential `OpenCode Zen [api]`.
//   COMMAND      echo 'Reply with only: ok' | opencode run --format json \
//                  --model opencode/big-pickle --dir "$EMPTY_TMPDIR" --pure
//                which is byte for byte the invocation `buildOpenCodeArguments` produces, with the
//                prompt on stdin, as `OpenCodeAdapter.complete` sends it.
//   RESULT       exit 0 · 922 bytes on stdout · 3 newline-terminated lines · stderr EMPTY.
//
// -- WHAT WAS CHANGED BEFORE COMMITTING, AND WHAT WAS NOT --------------------------------------
//
//   CHANGED. The five opaque identifiers — one `ses_`, one `msg_`, three `prt_` — are replaced with
//   fixture identifiers of the SAME BYTE LENGTH and the same prefixes. They are handles into the
//   local OpenCode session store, and this engine does not read that store or invite anyone to.
//
//   NOT CHANGED. Everything else is verbatim, key order included: the event names, the envelope
//   keys, the part shapes, the four timestamps, `"ok"`, `reason`, every token count, and `cost: 0`.
//   Those are the measurement and the structure, and a fixture that rounded them off would be a
//   guess again. The captured envelope contains NO credential, NO account identifier, NO filesystem
//   path and NO machine name — there was nothing of that kind to remove.
//
// -- WHAT THE ENVELOPE SAYS, AND THE ONE THING IT DOES NOT ------------------------------------
//
//   text          `{"type":"text", part:{type:"text", text, time:{start,end}}}`
//   tokens        on the step-finish part: input · output · reasoning · cache.read · cache.write,
//                 and a `total` the generated types do not declare but the runtime emits.
//   cost          on the step-finish part. Zero here, which is a real zero and not a silence.
//   finish        `reason` on the step-finish part.
//   timing        `timestamp` on every event (the CLI's own emit clock) and `time.start`/`time.end`
//                 on the text part (the window in which that text was generated).
//
//   IDENTITY: ABSENT, AND NOT BY ACCIDENT. `run` handles `message.updated` — the one event carrying
//   `providerID` and `modelID` — only inside its `format !== "json"` branch, where it prints
//   `> agent · modelID` for a person to read. Under `--format json` the assistant message is never
//   written to stdout at all. So this envelope proves EXECUTION and says nothing whatever about who
//   answered, and no amount of parsing will get identity out of it.

/** The captured stdout, sanitized as described above. Three lines, each newline-terminated. */
export const OPENCODE_BIG_PICKLE_CAPTURED_STDOUT = [
  '{"type":"step_start","timestamp":1789929250034,"sessionID":"ses_000000000000FIXTUREfixture","part":{"id":"prt_000000000000FIXTUREstpstrt","messageID":"msg_000000000000FIXTUREmessage","sessionID":"ses_000000000000FIXTUREfixture","type":"step-start"}}',
  '{"type":"text","timestamp":1789929250630,"sessionID":"ses_000000000000FIXTUREfixture","part":{"id":"prt_000000000000FIXTUREtxtpart","messageID":"msg_000000000000FIXTUREmessage","sessionID":"ses_000000000000FIXTUREfixture","type":"text","text":"ok","time":{"start":1789929250562,"end":1789929250612}}}',
  '{"type":"step_finish","timestamp":1789929250630,"sessionID":"ses_000000000000FIXTUREfixture","part":{"id":"prt_000000000000FIXTUREstpfin1","reason":"stop","messageID":"msg_000000000000FIXTUREmessage","sessionID":"ses_000000000000FIXTUREfixture","type":"step-finish","tokens":{"total":7936,"input":6141,"output":3,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}',
  '',
].join('\n');

/** The observed figures, named once, so a test asserts against the capture and not against a retype. */
export const OPENCODE_BIG_PICKLE_OBSERVED = {
  answerText: 'ok',
  sessionID: 'ses_000000000000FIXTUREfixture',
  finishReason: 'stop',
  cost: 0,
  tokens: { total: 7936, input: 6141, output: 3, reasoning: 0, cacheRead: 1792, cacheWrite: 0 },
  /** `time.end - time.start` on the text part: the window OpenCode says that text was generated in. */
  textGenerationMilliseconds: 50,
  /** First to last event `timestamp`. The CLI's emit clock, recorded here but NOT carried as a duration. */
  eventSpanMilliseconds: 596,
} as const;

/** One captured line, by event type, for the tests that need to drop or corrupt exactly one. */
export function capturedLine(type: 'step_start' | 'text' | 'step_finish'): string {
  const line = OPENCODE_BIG_PICKLE_CAPTURED_STDOUT.split('\n')
    .find((candidate) => candidate.startsWith(`{"type":"${type}"`));
  if (!line) throw new Error(`the captured fixture carries no ${type} line`);
  return line;
}

/**
 * An `error` event in the CLI's own framing.
 *
 * SHAPE SOURCE, since none was captured: `run` emits `Z("error", {error: J.error})` where `J` is the
 * `session.error` event's properties, so the payload is the SDK's declared error union —
 * `ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError`,
 * each `{name, data}`. The ENVELOPE around it is the captured one; only the error object is taken
 * from the declared types, because provoking a real auth failure would have meant sending a request
 * with a broken credential and that was not authorized.
 */
export function errorEvent(error: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'error',
    timestamp: 1789929250630,
    sessionID: OPENCODE_BIG_PICKLE_OBSERVED.sessionID,
    error,
  });
}

/** A `reasoning` event, in the captured framing. Emitted only under `--thinking`, which Cernum never sends. */
export function reasoningEvent(text: string): string {
  return JSON.stringify({
    type: 'reasoning',
    timestamp: 1789929250500,
    sessionID: OPENCODE_BIG_PICKLE_OBSERVED.sessionID,
    part: {
      id: 'prt_000000000000FIXTUREreasonp', messageID: 'msg_000000000000FIXTUREmessage',
      sessionID: OPENCODE_BIG_PICKLE_OBSERVED.sessionID, type: 'reasoning', text,
      time: { start: 1789929250400, end: 1789929250500 },
    },
  });
}

/** A second `step_finish`, so the multi-step arithmetic can be pinned on something. */
export function stepFinishEvent(
  reason: string, tokens: Record<string, unknown>, cost: number, id = 'prt_000000000000FIXTUREstpfin2',
): string {
  return JSON.stringify({
    type: 'step_finish',
    timestamp: 1789929250700,
    sessionID: OPENCODE_BIG_PICKLE_OBSERVED.sessionID,
    part: {
      id, reason, messageID: 'msg_000000000000FIXTUREmessage',
      sessionID: OPENCODE_BIG_PICKLE_OBSERVED.sessionID, type: 'step-finish', tokens, cost,
    },
  });
}
