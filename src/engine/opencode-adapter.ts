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
//   THE RESPONSE ENVELOPE was read from the GENERATED TYPES that ship with the tool, at
//   `@opencode-ai/sdk/dist/gen/types.gen.d.ts` — `AssistantMessage`, `TextPart`, `RetryPart` and the
//   five error variants. That is the tool's own declaration of what it emits, not a guess and not a
//   transcript someone remembered.
//
//   WHAT WAS NOT DONE: no request was sent to any model while writing or testing this. Every test
//   drives a fake executable replaying fixtures shaped by those generated types. A live OpenCode
//   request has therefore still never been made by this engine, and the support is labelled
//   accordingly until one has been.
//
// -- IDENTITY, WHICH OPENCODE ACTUALLY REPORTS --------------------------------------------------
//
// `AssistantMessage` carries `providerID` and `modelID`: the model OpenCode says answered. That is
// evidence returned by the provider, so an OpenCode attempt CAN reach a verified identity — unlike
// Codex, whose `exec` names no model at all. It is read from the reply and never copied from the
// request: if the message does not carry one, `reportedModelID` stays empty and the attempt is
// identity-unverifiable. A reply naming a different model than was asked for is reported as a
// mismatch rather than accepted quietly.
//
// A LISTING STILL PROVES NOTHING. `opencode models` reads a cached catalogue; see `opencode-cli.ts`.
// Only a request that was authorized, sent, and came back proves anything, and what it proves is
// execution — the identity state is decided separately, by what the reply said.

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

/** What one `AssistantMessage` told us, reduced to what Cernum records. */
export interface OpenCodeTurn {
  answerText: string;
  /** `providerID/modelID` as OpenCode reported them. Empty when the reply carried no identity. */
  reportedModelID: string;
  usage: FrontierUsage;
  /** True when a `tokens` block was present, so a zero can be told from a silence. */
  usageReported: boolean;
  /** OpenCode's own cost figure for the turn, in whatever units it reports. Undefined when absent. */
  reportedCost?: number;
  /** Milliseconds between the message's created and completed timestamps, when it carried both. */
  reportedDurationMilliseconds?: number;
  retryCount: number;
  finishReason?: string;
  error?: { name: string; message: string; statusCode?: number; isRetryable?: boolean };
}

interface JSONObject { [key: string]: unknown }
const isObject = (value: unknown): value is JSONObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Read the JSON event stream `opencode run --format json` writes.
 *
 * TOLERANT ABOUT FRAMING, STRICT ABOUT MEANING. The framing is not something this engine should be
 * brittle about — a line that is not JSON is skipped, and both a newline-delimited stream and a
 * single JSON array are accepted, because either would be a reasonable thing for the tool to emit
 * and neither changes what the events say. What is NOT tolerated is inventing a field: a number is
 * read only where the generated types declare one, an identity only from `providerID`/`modelID` on
 * an assistant message, and anything unrecognised is left undefined rather than defaulted to zero.
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
  const textByPartID = new Map<string, string>();

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : '';
    const properties = isObject(event.properties) ? event.properties : undefined;

    // `message.updated` carries the AssistantMessage: identity, tokens, cost, timing, finish, error.
    if (type === 'message.updated' && properties) {
      const info = isObject(properties.info) ? properties.info : undefined;
      if (!info || info.role !== 'assistant') continue;
      readAssistantMessage(info, turn);
      continue;
    }

    // `message.part.updated` carries the visible text, and the retry parts.
    if (type === 'message.part.updated' && properties) {
      const part = isObject(properties.part) ? properties.part : undefined;
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        // Parts arrive repeatedly as they stream; the last value for an id is the whole part. The
        // `synthetic` and `ignored` flags mark text OpenCode itself does not treat as the answer.
        if (part.synthetic === true || part.ignored === true) continue;
        if (typeof part.id === 'string') textByPartID.set(part.id, part.text);
        else turn.answerText += part.text;
      }
      if (part.type === 'retry') {
        const attempt = asNumber(part.attempt);
        // `attempt` counts from the tool's own numbering; the retry COUNT is how many extra tries
        // happened, so the highest attempt number seen is what it is worth recording.
        if (attempt !== undefined) turn.retryCount = Math.max(turn.retryCount, attempt);
        else turn.retryCount += 1;
      }
      continue;
    }

    // A bare AssistantMessage, should the stream carry one without the event wrapper.
    if (event.role === 'assistant' && typeof event.modelID === 'string') readAssistantMessage(event, turn);
  }

  if (textByPartID.size > 0) turn.answerText = [...textByPartID.values()].join('');
  turn.answerText = turn.answerText.trim();
  return turn;
}

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
    const cache = isObject(tokens.cache) ? tokens.cache : undefined;
    const usage: FrontierUsage = {};
    const input = asNumber(tokens.input);
    const output = asNumber(tokens.output);
    const reasoning = asNumber(tokens.reasoning);
    if (input !== undefined) usage.inputTokens = input;
    if (output !== undefined) usage.visibleOutputTokens = output;
    if (reasoning !== undefined) usage.reasoningTokens = reasoning;
    if (cache) {
      const read = asNumber(cache.read);
      const write = asNumber(cache.write);
      if (read !== undefined) usage.cacheReadInputTokens = read;
      if (write !== undefined) usage.cacheCreationInputTokens = write;
    }
    turn.usage = usage;
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
  if (error) {
    const data = isObject(error.data) ? error.data : {};
    turn.error = {
      name: typeof error.name === 'string' ? error.name : 'UnknownError',
      message: typeof data.message === 'string' ? data.message : '',
      statusCode: asNumber(data.statusCode),
      isRetryable: typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined,
    };
  }
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
