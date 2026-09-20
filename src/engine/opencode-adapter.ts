// Cernum · executing a candidate through the OpenCode CLI.
//
// WHAT THIS CLOSES. Until v0.2.3 OpenCode was discovery-only: Cernum could see the CLI, read its
// version, list its catalogue and read whether a credential was configured, and could not send it a
// single request. `adaptersFor` bound `claudeCLI`, `codexCLI`, `anthropicAPI` and `openaiAPI` and
// fell through for OpenCode, so `opencode/union-alpha` could be named in a plan and never run.
//
// -- HOW THE SURFACE BELOW WAS ESTABLISHED, WHICH MATTERS MORE THAN USUAL ------------------------
//
// This engine has written a CLI adapter from assumption exactly once. Pass 4B asked `claude` for a
// `models` subcommand it does not have, inferred authentication from prose, and returned `unknown`
// on every run for weeks, because the test used the assumed shape too. So:
//
//   THE INVOCATION was read from `opencode run --help` on opencode-ai@1.18.31, which sends nothing:
//       -m, --model <provider/model>   explicit model selection, in OpenCode's own addressing
//       --format json                  raw JSON events on stdout
//       --dir <path>                   the directory to run in
//       --variant <effort>             provider-specific reasoning effort
//       --pure                         run without external plugins
//
//   THE RESPONSE ENVELOPE was read, until v0.2.5, from the GENERATED TYPES that ship with the tool at
//   `@opencode-ai/sdk/dist/gen/types.gen.d.ts` — `AssistantMessage`, `TextPart`, `RetryPart` and the
//   five error variants. THAT WAS THE WRONG LAYER, and it cost the first live request.
//
//     Those types are real and they describe the SERVER's event stream. `opencode run --format json`
//     does not forward that stream. It subscribes to it and re-writes a chosen subset onto stdout in
//     a flat envelope of its own — `{type, timestamp, sessionID, part|error}`, with underscored event
//     names — so this parser matched nothing at all, found no answer text, and reported a perfectly
//     good reply as `malformedResponse`.
//
//     Pass 4B's lesson was "do not write an adapter from assumption". The narrower lesson this cost
//     buying twice is that READING THE TOOL'S TYPES IS NOT READING THE TOOL'S OUTPUT. The framing is
//     now pinned to 922 bytes captured from a real authorized request — see
//     `test/engine/fixtures/opencode-run-json.ts`, which carries the capture, its command and its
//     sanitization — and the adapter is tested against those bytes first.
//
// -- IDENTITY: OPENCODE REPORTS NONE ON THE PATH CERNUM USES ------------------------------------
//
// `AssistantMessage` carries `providerID` and `modelID`, and it is the only place OpenCode names the
// model that answered. `run` reads that event ONLY inside its `format !== "json"` branch, where it
// prints `> agent · modelID` for a person to read; under `--format json` it is never written to
// stdout. The captured envelope confirms it: three events, no identity field anywhere.
//
// SO AN OPENCODE REQUEST PROVES EXECUTION AND NOTHING ABOUT WHO ANSWERED. `reportedModelID` stays
// empty, the attempt is identity-unverifiable, and — the consequence worth stating plainly —
// SUBSTITUTION IS UNDETECTABLE ON THIS PATH. The `modelMismatch` check below can only fire in the
// server framing; it cannot protect a `--format json` request, because such a request would name no
// substitute to catch. Identity is still never copied from the request to fill the gap.
//
// A LISTING STILL PROVES NOTHING. `opencode models` reads a cached catalogue; see `opencode-cli.ts`.
// Only a request that was authorized, sent, and came back proves anything, and what it proves is
// execution — the identity state is decided separately, by what the reply said, and here it said
// nothing.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FrontierAdapter, FrontierFailureKind, FrontierRequest, FrontierResponse, FrontierUsage,
  assembleRequestText,
} from './frontier-adapter';
import { CLIResult, findExecutable, runCLI } from './cli-process';
import { OPENCODE_EXECUTABLE, OPENCODE_PROVIDER } from './opencode-cli';
import { redactSecrets } from './redaction';
import { ProviderID } from './provider';

export interface OpenCodeAdapterOptions {
  executablePath?: string;
  findExecutable?: (name: string) => string | undefined;
  run?: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  /** Injected so a test can assert the working directory without racing the filesystem. */
  makeWorkingDirectory?: () => string;
}

/** What one OpenCode turn told us, reduced to what Cernum records. */
export interface OpenCodeTurn {
  answerText: string;
  /**
   * `providerID/modelID` as OpenCode reported them. Empty when the reply carried no identity — which
   * under `--format json` is ALWAYS, because that mode emits no assistant message. See the header.
   */
  reportedModelID: string;
  usage: FrontierUsage;
  /** True when a `tokens` block was present, so a zero can be told from a silence. */
  usageReported: boolean;
  /**
   * OpenCode's own cost figure, in whatever units it reports. Summed across `step-finish` parts, which
   * is what OpenCode itself does to the message. Undefined when nothing reported one; `0` is a real
   * zero and is preserved as one.
   */
  reportedCost?: number;
  /**
   * Milliseconds between the assistant message's created and completed timestamps. SERVER FRAMING
   * ONLY, so undefined on every request this engine makes.
   */
  reportedDurationMilliseconds?: number;
  /**
   * Milliseconds OpenCode says the visible text was generated in, from `time.start`/`time.end` on the
   * text parts. NOT the request's duration — the request is longer than its visible text, and Cernum
   * measures wall clock itself in `totalElapsedMilliseconds`.
   */
  reportedTextGenerationMilliseconds?: number;
  /**
   * Extra attempts OpenCode reported. SERVER FRAMING ONLY: `run --format json` forwards no retry
   * part, so a retried request reads as 0 here and that 0 is a silence rather than a count.
   */
  retryCount: number;
  /** Why generation stopped: `reason` on the last `step-finish`. Not an effort level. */
  finishReason?: string;
  error?: { name: string; message: string; statusCode?: number; isRetryable?: boolean };
}

interface JSONObject { [key: string]: unknown }
const isObject = (value: unknown): value is JSONObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Read the event stream `opencode run --format json` writes.
 *
 * TWO FRAMINGS, ONE OF WHICH IS THE ONE THIS ENGINE ACTUALLY RECEIVES.
 *
 *   THE CLI FRAMING, which is what `run --format json` emits and what a captured request proved it
 *   emits. `run` subscribes to the server's event stream and re-writes a CHOSEN SUBSET of it onto
 *   stdout in a flat envelope of its own making:
 *
 *       {"type": <name>, "timestamp": <ms>, "sessionID": <id>, "part": <Part>}
 *       {"type": "error", "timestamp": <ms>, "sessionID": <id>, "error": <error>}
 *
 *   with `<name>` one of `step_start`, `step_finish`, `text`, `reasoning`, `tool_use`, `error`.
 *   Note the underscores: these are the CLI's own names, not the SDK's dotted event names, and the
 *   payload sits at the TOP LEVEL rather than under `properties`.
 *
 *   THE SERVER FRAMING — `message.updated` and `message.part.updated`, the SDK's declared `Event`
 *   union — which `run --format json` does NOT write. It is still read below, because it is declared
 *   by the tool and because it is the only framing in which identity ever appears; nothing in this
 *   engine's own invocation reaches it. Every test naming that framing says so.
 *
 * TOLERANT ABOUT FRAMING, STRICT ABOUT MEANING. A line that is not JSON is skipped, and both a
 * newline-delimited stream and a single JSON array are accepted. What is NOT tolerated is inventing
 * a field: a number is read only where the tool emits one, an identity only from
 * `providerID`/`modelID`, and anything unrecognised is left undefined rather than defaulted to zero.
 */
export function parseOpenCodeRun(stdout: string): OpenCodeTurn {
  const events: JSONObject[] = [];
  const trimmed = stdout.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) for (const item of parsed) if (isObject(item)) events.push(item);
    } catch { /* fall through to line-by-line */ }
  }
  if (events.length === 0) {
    for (const line of stdout.split('\n')) {
      const text = line.trim();
      if (text.length === 0 || !text.startsWith('{')) continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) events.push(parsed);
      } catch { /* a partial or decorated line is not an event */ }
    }
  }

  const turn: OpenCodeTurn = { answerText: '', reportedModelID: '', usage: {}, usageReported: false, retryCount: 0 };
  // Parts arrive repeatedly as they stream, so both maps are keyed by part id and the LAST value for
  // an id wins. Accumulating instead would count one streamed answer several times over.
  const textByPartID = new Map<string, string>();
  const textMillisecondsByPartID = new Map<string, number>();

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    const properties = isObject(event.properties) ? event.properties : undefined;

    switch (type) {
      // -- THE CLI FRAMING ------------------------------------------------------------------------
      case 'step_start': case 'step_finish': case 'text': case 'reasoning': case 'tool_use': {
        const part = isObject(event.part) ? event.part : undefined;
        if (part) readPart(part, turn, textByPartID, textMillisecondsByPartID);
        break;
      }
      case 'error': {
        const error = isObject(event.error) ? event.error : undefined;
        if (error) readOpenCodeError(error, turn);
        break;
      }

      // -- THE SERVER FRAMING, which this invocation never receives -------------------------------
      case 'message.updated': {
        const info = properties && isObject(properties.info) ? properties.info : undefined;
        if (info && info.role === 'assistant') readAssistantMessage(info, turn);
        break;
      }
      case 'message.part.updated': {
        const part = properties && isObject(properties.part) ? properties.part : undefined;
        if (part) readPart(part, turn, textByPartID, textMillisecondsByPartID);
        break;
      }

      // A bare AssistantMessage, should the stream carry one without any wrapper.
      default: {
        if (event.role === 'assistant' && typeof event.modelID === 'string') readAssistantMessage(event, turn);
      }
    }
  }

  if (textByPartID.size > 0) turn.answerText = [...textByPartID.values()].join('');
  turn.answerText = turn.answerText.trim();
  if (textMillisecondsByPartID.size > 0) {
    turn.reportedTextGenerationMilliseconds =
      [...textMillisecondsByPartID.values()].reduce((sum, span) => sum + span, 0);
  }
  return turn;
}

/**
 * Read one `Part`, from whichever framing carried it.
 *
 * The part shapes are identical in both: the CLI re-wraps the envelope and forwards the part
 * untouched, so there is one reader rather than two that could drift apart.
 */
function readPart(
  part: JSONObject, turn: OpenCodeTurn,
  textByPartID: Map<string, string>, textMillisecondsByPartID: Map<string, number>,
): void {
  // THE VISIBLE ANSWER, and only that. A `reasoning` part is not the answer and is deliberately not
  // read here: OpenCode emits it only under `--thinking`, which Cernum does not send, and folding
  // thinking into the answer text would have measured the wrong string.
  if (part.type === 'text' && typeof part.text === 'string') {
    // The `synthetic` and `ignored` flags mark text OpenCode itself does not treat as the answer.
    if (part.synthetic === true || part.ignored === true) return;
    if (typeof part.id === 'string') textByPartID.set(part.id, part.text);
    else turn.answerText += part.text;

    // `time.start`/`time.end` on the text part is the window OPENCODE says that text was generated
    // in. It is not the request's duration — the request is longer than its visible text — and it is
    // recorded under a name that says which of the two it is.
    const time = isObject(part.time) ? part.time : undefined;
    const start = time ? asNumber(time.start) : undefined;
    const end = time ? asNumber(time.end) : undefined;
    if (start !== undefined && end !== undefined && end >= start && typeof part.id === 'string') {
      textMillisecondsByPartID.set(part.id, end - start);
    }
    return;
  }

  if (part.type === 'step-finish') { readStepFinish(part, turn); return; }

  if (part.type === 'retry') {
    // `attempt` counts from the tool's own numbering; the retry COUNT is how many extra tries
    // happened, so the highest attempt number seen is what it is worth recording.
    //
    // UNREACHABLE UNDER `--format json`, and left in because it costs nothing and the server framing
    // does carry it. `run` has no branch that forwards a retry part to stdout, so a retried OpenCode
    // request is indistinguishable here from a first-try one: `retryCount` stays 0 and that is a
    // silence, not a zero.
    const attempt = asNumber(part.attempt);
    if (attempt !== undefined) turn.retryCount = Math.max(turn.retryCount, attempt);
    else turn.retryCount += 1;
  }
}

/**
 * Read a `step-finish` part: the only place `--format json` reports tokens, cost or a finish reason.
 *
 * THE ARITHMETIC IS OPENCODE'S OWN, NOT ONE INVENTED HERE. In the tool's session loop the assistant
 * message is updated as `assistantMessage.cost += step.cost` and `assistantMessage.tokens =
 * step.tokens` — cost ACCUMULATES across steps, the token block is REPLACED by the last step's, and
 * `assistantMessage.finish = step.reason`. `--format json` never emits that message, so the same
 * three rules are applied here to the step parts it does emit, and a multi-step run therefore
 * reports what OpenCode would itself have reported for it.
 */
function readStepFinish(part: JSONObject, turn: OpenCodeTurn): void {
  const tokens = isObject(part.tokens) ? part.tokens : undefined;
  if (tokens) {
    turn.usageReported = true;
    turn.usage = usageFromTokens(tokens);
  }
  const cost = asNumber(part.cost);
  if (cost !== undefined) turn.reportedCost = (turn.reportedCost ?? 0) + cost;
  if (typeof part.reason === 'string') turn.finishReason = part.reason;
}

/**
 * The token block, which OpenCode emits in the same shape on a step part and on a message.
 *
 * `input` is FRESH input only: the captured envelope's `total` is exactly
 * `input + output + reasoning + cache.read`, so cached input is counted apart rather than folded in —
 * which is the contract `FrontierUsage` states. `total` is therefore derivable and is not stored: a
 * field that can only ever disagree with its own parts is not worth keeping.
 */
function usageFromTokens(tokens: JSONObject): FrontierUsage {
  const usage: FrontierUsage = {};
  const input = asNumber(tokens.input);
  const output = asNumber(tokens.output);
  const reasoning = asNumber(tokens.reasoning);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.visibleOutputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  const cache = isObject(tokens.cache) ? tokens.cache : undefined;
  if (cache) {
    const read = asNumber(cache.read);
    const write = asNumber(cache.write);
    if (read !== undefined) usage.cacheReadInputTokens = read;
    if (write !== undefined) usage.cacheCreationInputTokens = write;
  }
  return usage;
}

/** The error object both framings carry: `{name, data}`, as the SDK's five variants declare it. */
function readOpenCodeError(error: JSONObject, turn: OpenCodeTurn): void {
  const data = isObject(error.data) ? error.data : {};
  turn.error = {
    name: typeof error.name === 'string' ? error.name : 'UnknownError',
    message: typeof data.message === 'string' ? data.message : '',
    statusCode: asNumber(data.statusCode),
    isRetryable: typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined,
  };
}

/**
 * Read an `AssistantMessage`, which arrives ONLY in the server framing.
 *
 * `run --format json` never writes one — it consumes `message.updated` inside its `format !== "json"`
 * branch, to print `> agent · modelID` for a person to read, and forwards nothing. So every field
 * below is unreachable on this engine's own invocation, identity included. It is read anyway because
 * the event is declared, and because if identity ever does reach stdout this is where it is taken
 * from. It is never a reason to claim identity that did not arrive.
 */
function readAssistantMessage(info: JSONObject, turn: OpenCodeTurn): void {
  // IDENTITY IS READ, NEVER COPIED FROM THE REQUEST. OpenCode addresses models as provider/model,
  // so the two fields are rejoined in the tool's own addressing rather than in one invented here.
  const providerID = typeof info.providerID === 'string' ? info.providerID : '';
  const modelID = typeof info.modelID === 'string' ? info.modelID : '';
  if (modelID.length > 0) {
    turn.reportedModelID = providerID.length > 0 ? `${providerID}/${modelID}` : modelID;
  }

  const tokens = isObject(info.tokens) ? info.tokens : undefined;
  if (tokens) {
    turn.usageReported = true;
    turn.usage = usageFromTokens(tokens);
  }

  const cost = asNumber(info.cost);
  if (cost !== undefined) turn.reportedCost = cost;

  const time = isObject(info.time) ? info.time : undefined;
  const created = time ? asNumber(time.created) : undefined;
  const completed = time ? asNumber(time.completed) : undefined;
  if (created !== undefined && completed !== undefined && completed >= created) {
    turn.reportedDurationMilliseconds = completed - created;
  }

  if (typeof info.finish === 'string') turn.finishReason = info.finish;

  const error = isObject(info.error) ? info.error : undefined;
  if (error) readOpenCodeError(error, turn);
}

/**
 * Classify an OpenCode error into the kinds this engine already reasons about.
 *
 * `ProviderAuthError` is the one that must not become `transport`: an unauthenticated tool would
 * otherwise be retried three times over, exactly the waste `contentFiltered` was introduced to stop.
 */
export function classifyOpenCodeError(error: NonNullable<OpenCodeTurn['error']>): FrontierFailureKind {
  switch (error.name) {
    case 'ProviderAuthError': return 'notAuthenticated';
    case 'MessageAbortedError': return 'cancelled';
    case 'MessageOutputLengthError': return 'malformedResponse';
    case 'APIError': {
      const status = error.statusCode;
      if (status === 401 || status === 403) return 'notAuthenticated';
      if (status === 404) return 'refused';
      if (status === 429) return 'rateLimited';
      return 'transport';
    }
    default: return 'transport';
  }
}

/** The arguments one request carries. Explicit model, JSON events, isolated directory, no plugins. */
export function buildOpenCodeArguments(modelID: string, effort: string, workingDirectory: string): string[] {
  const args = ['run', '--format', 'json', '--model', modelID, '--dir', workingDirectory, '--pure'];
  // `--variant` is OpenCode's name for an effort level. It is sent ONLY when the binding froze one:
  // asking for a variant a model does not accept is a different request from not asking.
  if (effort && effort !== 'none') args.push('--variant', effort);
  return args;
}

export class OpenCodeAdapter implements FrontierAdapter {
  readonly provider: ProviderID = OPENCODE_PROVIDER;
  private readonly executablePath?: string;
  private readonly run: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  private readonly makeWorkingDirectory: () => string;

  constructor(options: OpenCodeAdapterOptions = {}) {
    const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
    this.executablePath = options.executablePath ?? locate(OPENCODE_EXECUTABLE);
    this.run = options.run ?? runCLI;
    this.makeWorkingDirectory = options.makeWorkingDirectory
      ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-opencode-')));
  }

  async complete(request: FrontierRequest): Promise<FrontierResponse> {
    const now = request.now ?? (() => Date.now());
    const startedAt = now();
    const empty = (kind: FrontierFailureKind, detail: string): FrontierResponse => ({
      answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
      totalElapsedMilliseconds: now() - startedAt, retryCount: 0, wastedTokens: 0,
      failure: { kind, detail },
    });

    if (!this.executablePath) {
      return empty('notInstalled',
        `the ${OPENCODE_EXECUTABLE} command was not found on PATH, nor in the directories CLI installers write to. `
        + 'Cernum drives the OpenCode CLI you installed and authenticated yourself; it does not install one.');
    }

    // AN EMPTY WORKING DIRECTORY, CREATED AND REMOVED AROUND THE REQUEST. OpenCode is a coding agent:
    // run in a real directory it can read what is in it, and nothing found that way is in the
    // manifest. `--dir` points it somewhere with nothing in it, and `--pure` keeps external plugins
    // out of a measured run.
    const workingDirectory = this.makeWorkingDirectory();
    const { text } = assembleRequestText(request.promptText, request.suppliedContext);
    const args = buildOpenCodeArguments(request.binding.requestedModelID, request.binding.effort, workingDirectory);
    let firstVisibleTokenMilliseconds: number | undefined;
    let result: CLIResult;
    try {
      result = await this.run({
        executable: this.executablePath,
        args,
        input: text,
        timeoutMilliseconds: request.binding.timeoutMilliseconds,
        shouldCancel: request.shouldCancel,
        workingDirectory,
        onFirstOutput: (at) => { firstVisibleTokenMilliseconds = at; },
      });
    } finally {
      try { fs.rmSync(workingDirectory, { recursive: true, force: true }); } catch { /* already gone */ }
    }

    const turn = parseOpenCodeRun(result.stdout);

    // THE ENVELOPE IS CONSULTED BEFORE THE EXIT CODE, for the reason the Claude path documents: a
    // refusal exits non-zero and still prints a structured error, and reading the shell's verdict
    // first would turn a machine-readable refusal into an opaque transport fault.
    if (turn.error) {
      return {
        ...empty(classifyOpenCodeError(turn.error), `OpenCode reported ${turn.error.name}`
          + `${turn.error.statusCode === undefined ? '' : ` (HTTP ${turn.error.statusCode})`}: `
          + redactSecrets(turn.error.message).slice(0, 400)),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
        retryCount: turn.retryCount,
        reportedModelID: turn.reportedModelID,
      };
    }

    if (result.failure) {
      return {
        ...empty(result.failure.kind === 'timeout' ? 'timeout'
          : result.failure.kind === 'cancelled' ? 'cancelled' : 'transport',
          redactSecrets(result.failure.detail)),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
        retryCount: turn.retryCount,
      };
    }

    if (turn.answerText.length === 0) {
      return {
        ...empty('malformedResponse',
          'OpenCode exited cleanly and this parser found no answer text in its JSON events. An empty answer is '
          + 'reported as an unreadable reply rather than as a model that said nothing.'),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
        retryCount: turn.retryCount,
        reportedModelID: turn.reportedModelID,
      };
    }

    // A REPLY THAT NAMES A DIFFERENT MODEL IS A MISMATCH, not a result. Substitution is the failure
    // this whole engine exists to catch, and it is checked in OpenCode's own addressing.
    if (turn.reportedModelID.length > 0 && turn.reportedModelID !== request.binding.requestedModelID) {
      return {
        ...empty('modelMismatch',
          `asked OpenCode for ${request.binding.requestedModelID} and the reply says ${turn.reportedModelID} answered.`),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
        retryCount: turn.retryCount,
        reportedModelID: turn.reportedModelID,
      };
    }

    return {
      answerText: turn.answerText,
      // Empty when OpenCode's reply carried no identity. NEVER the requested id: a request is not
      // evidence about who answered it.
      reportedModelID: turn.reportedModelID,
      usage: turn.usage,
      // `reported` only when a tokens block was actually present, so a genuine zero is not
      // indistinguishable from a silence.
      usageProvenance: turn.usageReported ? 'providerReported' : 'unavailable',
      // OPENCODE'S OWN COST FIGURE IS PRESERVED HERE AND NOWHERE ELSE. The comment below claimed it
      // was "preserved in the raw usage instead" and it was not — it was read off the message and
      // dropped. It is carried now, under a name that says whose number it is, and it is NOT turned
      // into a charge: `AssistantMessage.cost` is a bare number in the generated types with no unit
      // declared, and a figure whose currency and scale nobody established is not a cost this engine
      // may put in a cost column.
      rawUsage: turn.usageReported || turn.reportedCost !== undefined ? {
        ...(turn.usageReported ? (turn.usage as unknown as Record<string, number>) : {}),
        ...(turn.reportedCost === undefined ? {} : { openCodeReportedCostUnitUnverified: turn.reportedCost }),
      } : undefined,
      firstVisibleTokenMilliseconds,
      totalElapsedMilliseconds: result.elapsedMilliseconds,
      retryCount: turn.retryCount,
      wastedTokens: 0,
      // A FINISH REASON IS NOT AN EFFORT LEVEL. `reportedEffort` is where a provider says what
      // reasoning effort it APPLIED; `finish` says why generation stopped, and putting `stop` there
      // made every OpenCode smoke print "effort applied, as the provider reported it: stop".
      // OpenCode reports no applied effort, so the honest answer is that it reported none.
      reportedEffort: undefined,
      // OPENCODE'S COST FIGURE IS NOT CARRIED INTO A SUBSCRIPTION FIELD. OpenCode is metered, so what
      // it reports is a charge and not plan allowance; `subscriptionIncludedUsageMicroUSD` would say
      // the opposite of the truth. The number is preserved in the raw usage above.
      participatingModelIDs: turn.reportedModelID.length > 0 ? [turn.reportedModelID] : [],
    };
  }
}
