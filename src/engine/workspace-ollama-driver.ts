// Benchmark engine · a LOCAL model on a workspace task, through an agent loop Cernum owns.
//
// NOT AN IMITATION OF THE CLI DRIVERS, BECAUSE THERE IS NO CLI. `claude`, `codex` and `opencode` each
// bring an agent loop, a tool set and a shell; Cernum only chooses flags. Ollama brings a model and a
// chat endpoint that can return tool calls. So here CERNUM is the harness: it offers the tools, carries
// out every call itself, bounds the loop, and decides what each tool may touch. That changes what this
// route can prove, in both directions, and both are stated rather than assumed:
//
//   STRONGER  Every file read and every file write is performed BY THIS ENGINE through `resolveInside`,
//             so `fileRead` and `fileWrite` are `engineObserved` here — on the CLI routes they are the
//             tool's account of itself. Identity is also stronger: the runtime names the model in every
//             reply, and the WEIGHTS DIGEST is read before and after the attempt, so a model re-pulled
//             or replaced mid-run is caught rather than scored.
//   NARROWER  There is no shell. Under the V1 execution policy (`execution-sandbox.ts`) Cernum never
//             executes a command a model chose, so the only command tool is `run_check`: the model names
//             one of the case's VISIBLE sealed checks by identifier, and the runner executes the case's
//             own argv on a throwaway copy of the tree, under the OS sandbox. That is category C, and it
//             is a different experiment from a CLI agent with a shell. `commandExecutionScope:
//             'sealedChecksOnly'` carries the difference onto every record, and a comparison that put
//             this route's rows beside a CLI route's without reading that field would be comparing
//             harnesses as much as models.
//
// THE LOCAL TRUST BOUNDARY. The endpoint must be loopback — `validateLoopbackEndpoint`, the same check
// the local prose path uses — so instruction, file contents and tool results never leave this machine.
// A model whose weights originated with an outside vendor needs no remote identity admission: what is
// being established is which WEIGHTS ran on THIS machine, and the runtime's digest answers exactly that.
// Nothing here sends any content to an external provider, and there is no code path that could.
//
// WHAT IS RECORDED, AND WHAT IS NOT INVENTED. The runtime's `prompt_eval_count` and `eval_count` are
// recorded as reported and summed across turns. Where a reply omits one, the figure is ABSENT, never
// zero and never estimated from characters. `prompt_eval_count` counts the tokens the runtime EVALUATED;
// with prefix-cache reuse that can be fewer than the prompt, and it is recorded as the runtime's number.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FetchLike, httpBackstopTimeoutsFor, loopbackHTTPFetch, validateLoopbackEndpoint } from '../core/ollama-http';
import { CanonicalValue, sha256Text } from './canonical';
import { machineKey, readMachineFingerprint } from './machine-availability';
import { resolveInside } from './isolation';
import { ProviderID } from './provider';
import { redactSecrets } from './redaction';
import { verifyProviderIdentity } from './verification';
import { NetworkPolicy, ToolPolicy } from './workspace-case';
import {
  WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, WorkspaceAgentCapabilities, WorkspaceAgentDriver,
  WorkspaceAgentFailureKind, WorkspaceAgentRequest, WorkspaceAgentResult,
} from './workspace-agent';
import { WorkspaceAgentUsage } from './workspace-host';

export const OLLAMA_WORKSPACE_DRIVER_ID = 'driver.ollama.workspace';

/** The version of Cernum's own loop and tool set. A change to either is a different experiment. */
export const OLLAMA_WORKSPACE_HARNESS_VERSION = 'cernum-local-agent-1';

export const OLLAMA_WORKSPACE_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/** Bounds on the loop. A local model costs no money, and still costs the operator's machine and time. */
export const OLLAMA_WORKSPACE_MAXIMUM_TURNS = 48;
export const OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN = 8_192;

/**
 * The largest context window this harness will ASK a local runtime to open, in tokens.
 *
 * The runtime does not size the window to the conversation: it opens the whole window up front and
 * holds the KV cache for it in memory. A model that reports 262_144 tokens would therefore have the
 * harness demand tens of gigabytes before the first turn, on a machine that may not have them — so
 * asking for a model's full reported context is not the safe reading of "use what was measured".
 *
 * What is measured stays measured: `localModelContextLengthTokens` on every record is still the
 * runtime's own number, untouched. This ceiling bounds the REQUEST, is recorded beside it as
 * `localModelContextWindowRequestedTokens`, and is raised by an operator who has the memory for it.
 */
export const OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS = 32_768;

export const OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES = 200_000;
export const OLLAMA_WORKSPACE_MAXIMUM_LISTED_FILES = 500;

/**
 * How long the pre-case runtime probe may take. Short on purpose: it is a READ of the runtime's
 * state, not a wait for it to become free, and a probe that could consume a meaningful slice of a
 * case deadline would be charging the model for the harness's curiosity. Bounded again by whatever
 * is left of the case deadline at the moment it runs.
 */
export const OLLAMA_WORKSPACE_PROBE_TIMEOUT_MILLISECONDS = 5_000;

/**
 * The window to ask for, given what the runtime said the model can do.
 *
 * UNKNOWN STAYS UNKNOWN. A runtime that published no context length gets no `num_ctx` at all: the
 * runtime then applies its own default, which is a fact about the runtime rather than a number this
 * harness made up. Inventing one here would put a fabricated window on the record beside genuinely
 * measured ones.
 */
export function ollamaWorkspaceContextWindow(contextLengthTokens: number | undefined,
                                             ceilingTokens: number = OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS): number | undefined {
  if (contextLengthTokens === undefined || !Number.isFinite(contextLengthTokens) || contextLengthTokens <= 0) return undefined;
  return Math.min(Math.floor(contextLengthTokens), Math.floor(ceilingTokens));
}

export const OLLAMA_WORKSPACE_SYSTEM_PROMPT = [
  'You are working in a software repository through tools. The repository is your whole world: every path is relative',
  'to its root. Use list_files and read_file to understand it, write_file or replace_in_file to change it, and run_check',
  'to run one of the repository\'s named checks. When the task is complete, reply with a short summary and no tool call.',
].join(' ');

export const OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY =
  'this route has no shell. The model may run only the case\'s VISIBLE sealed checks, by identifier, through run_check; '
  + 'Cernum executes the case\'s own argv on a throwaway copy of the tree under the OS sandbox. Hidden checks are never '
  + 'offered. This is a narrower tool surface than a CLI agent\'s, and its rows are a different experiment from theirs.';

export const OLLAMA_IDENTITY_IS_THE_DIGEST =
  'identity on this route is the local runtime\'s weights digest, read before the first turn and again after the last, '
  + 'and compared with the digest frozen when the run was planned. The runtime also names the model tag in every reply. '
  + 'A digest that differs at any of the three readings refuses the attempt: different weights are a different model.';

export const OLLAMA_CHAT_IS_STREAMED =
  '/api/chat is requested with stream: true and consumed incrementally, so the first token, the arrival of every '
  + 'event and a mid-generation failure are observed as they happen rather than inferred from one final write. '
  + 'Cernum\'s deadline and cancellation therefore interrupt an ACTIVE generation. Time to first token is measured '
  + 'on this process\'s clock and is ABSENT, with a stated reason, when no token ever arrived.';

export const OLLAMA_STAYS_ON_THIS_MACHINE =
  'the endpoint is loopback-only (127.0.0.1, localhost, ::1). The instruction, file contents and tool results are sent '
  + 'to the local runtime and nowhere else; no remote provider is involved.';

/**
 * What this driver can do. Every flag describes CERNUM'S harness, because Cernum is the tool.
 *
 * `expressesNetworkPolicy` is TRUE for the loop: no tool it offers can reach a network, and `run_check`
 * executes under a Seatbelt profile that denies every socket. The runtime itself is loopback-only.
 */
export const OLLAMA_WORKSPACE_CAPABILITIES: WorkspaceAgentCapabilities = {
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  canIterateWithinOneInvocation: true,
  reportsToolCalls: true,
  reportsModelIdentity: true,
  expressesToolPolicy: true,
  expressesNetworkPolicy: true,
  commandExecutionScope: 'sealedChecksOnly',
};

// MARK: - The runtime, over loopback

export interface LocalRuntimeModel {
  name: string;
  digest: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  contextLengthTokens?: number;
  /** What the runtime says the model can do. Undefined means it did not say. */
  capabilities?: string[];
}

export class OllamaRuntimeUnavailable extends Error {
  constructor(readonly kind: 'unreachable' | 'modelNotFound' | 'httpFailure' | 'malformed', message: string) {
    super(message);
    this.name = 'OllamaRuntimeUnavailable';
  }
}

interface JSONObject { [key: string]: unknown }
const isObject = (value: unknown): value is JSONObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * HOW ONE STREAMED TURN ENDED, in a vocabulary that keeps apart the things a single `deadlineExceeded`
 * used to hide.
 *
 * The qualification run that motivated this could not tell a model generating slowly from a runtime
 * that never started, because a NON-streaming `/api/chat` says nothing at all until it says
 * everything: one write at the end, and until then silence that is identical whether the model is
 * working, the runtime is wedged, or the socket is already dead. These names are what the driver can
 * now DISTINGUISH BY OBSERVATION, and each one states what was actually seen:
 *
 *   completed                  the runtime sent its terminal `done` event.
 *   runtimeUnavailable         nothing answered: the request never got response headers.
 *   requestNeverReachedModel   the runtime answered and streamed NO model event — an HTTP error, or
 *                              a 200 whose stream closed empty. Nothing observed shows a model ran.
 *   noFirstTokenBeforeDeadline the stream was open and no token had arrived when the deadline passed.
 *   generationExceededDeadline tokens WERE arriving; the deadline passed before the model finished.
 *   streamTransportFailure     the stream broke, or the runtime sent an error event, mid-generation.
 *   streamPayloadMalformed     a line on the stream was not the JSON object the protocol promises.
 *   cancelledByCernum          the run was paused or aborted; the stream was closed on purpose.
 *
 * These are the DRIVER'S finer reading, recorded beside — never instead of — the closed
 * `WorkspaceAgentFailureKind` every route shares. `OLLAMA_FAILURE_FOR_STREAM_OUTCOME` is the map, and
 * it is the only place the two vocabularies meet.
 */
export const OLLAMA_STREAM_OUTCOMES = ['completed', 'runtimeUnavailable', 'requestNeverReachedModel',
  'noFirstTokenBeforeDeadline', 'generationExceededDeadline', 'streamTransportFailure',
  'streamPayloadMalformed', 'cancelledByCernum'] as const;
export type OllamaStreamOutcome = (typeof OLLAMA_STREAM_OUTCOMES)[number];

/** The one place the driver's reading is translated into the vocabulary every route shares. */
export const OLLAMA_FAILURE_FOR_STREAM_OUTCOME: Record<OllamaStreamOutcome, WorkspaceAgentFailureKind | undefined> = {
  completed: undefined,
  runtimeUnavailable: 'transport',
  requestNeverReachedModel: 'transport',
  noFirstTokenBeforeDeadline: 'timeout',
  generationExceededDeadline: 'timeout',
  streamTransportFailure: 'transport',
  streamPayloadMalformed: 'malformedOutput',
  cancelledByCernum: 'cancelled',
};

/**
 * WHAT `/api/ps` CAN AND CANNOT SAY. It lists the models RESIDENT in the runtime — loaded, holding
 * memory, with an expiry — and it does not say whether one of them is generating. So these names
 * report residency, which is what was read, and nothing is inferred about activity from it.
 *
 * `noModelResident` IS NOT AN ERROR. Loading a model on the first request is how Ollama normally
 * works, and the first turn of an attempt paying a load cost is a fact about this machine, recorded
 * as one. What the probe is for is the other cases: another model already holding the memory this
 * attempt needs, or a runtime that will not answer a ten-millisecond read at all.
 */
export const OLLAMA_RUNTIME_RESIDENCIES = ['noModelResident', 'thisModelResident', 'otherModelsResident',
  'thisAndOtherModelsResident', 'probeUnsupported', 'probeUnavailable'] as const;
export type OllamaRuntimeResidency = (typeof OLLAMA_RUNTIME_RESIDENCIES)[number];

export interface OllamaRuntimeProbe {
  residency: OllamaRuntimeResidency;
  /** Every model the runtime says is resident, sorted. Empty is a real answer, not a missing one. */
  residentModels: string[];
  /** How long the probe itself took. Bounded; there is no loop and nothing waits for a slot. */
  elapsedMilliseconds: number;
  /** Why the probe could not answer, when it could not. Absent when it did. */
  detail?: string;
}

/**
 * ONE STREAMED TURN, as observed rather than as reported.
 *
 * `firstTokenMilliseconds` IS NEVER INVENTED. It is the arrival of the first event carrying model
 * output — content, thinking, or a tool call — measured on this process's clock from the instant the
 * request was written. When no such event ever arrived the field is ABSENT and
 * `firstTokenUnavailableReason` says what happened instead; a zero, or the time the stream opened,
 * would each be a number the run did not measure.
 *
 * The counts and durations are taken from the TERMINAL event only. Ollama repeats nothing across a
 * stream, but taking them from wherever they appear would risk summing a figure twice, and a token
 * count that is sometimes double is worse than one that is sometimes absent.
 */
export interface OllamaChatStreamOutcome {
  outcome: OllamaStreamOutcome;
  detail?: string;
  httpStatus?: number;
  /** The model the runtime named on the stream, when it named one. */
  model?: string;
  content: string;
  thinking: string;
  toolCalls: JSONObject[];
  firstEventMilliseconds?: number;
  firstTokenMilliseconds?: number;
  firstTokenUnavailableReason?: string;
  /** Epoch milliseconds, so a caller can place this turn inside the attempt's own wall clock. */
  streamStartedAt: number;
  streamEndedAt: number;
  eventCount: number;
  malformedEventCount: number;
  /** The runtime sent its terminal event. False with `completed` is impossible by construction. */
  done: boolean;
  doneReason?: string;
  promptEvalCount?: number;
  /**
   * `prompt_eval_cached_count`, which current Ollama reports beside `prompt_eval_count`. RECORDED
   * AND NOT RECONCILED: this build does not claim to know whether the runtime's evaluated count
   * includes or excludes it, and a sum built on a guess would put a fabricated input total on the
   * record. It is kept in the raw per-turn telemetry, where a later reading can settle it.
   */
  promptEvalCachedCount?: number;
  evalCount?: number;
  totalDurationNanoseconds?: number;
  loadDurationNanoseconds?: number;
  promptEvalDurationNanoseconds?: number;
  evalDurationNanoseconds?: number;
}

/** A minimal client for the three calls this driver makes. Loopback is checked at construction. */
export class LocalRuntimeClient {
  readonly base: URL;

  constructor(endpoint: string, private readonly fetchImpl: FetchLike = loopbackHTTPFetch()) {
    this.base = validateLoopbackEndpoint(endpoint);
  }

  private async call(method: 'GET' | 'POST', route: string, body: JSONObject | undefined, timeoutMilliseconds: number,
                     shouldCancel?: () => boolean): Promise<JSONObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    const poll = shouldCancel === undefined ? undefined : setInterval(() => { if (shouldCancel()) controller.abort(); }, 200);
    timer.unref?.();
    poll?.unref?.();
    // THE DEADLINE COVERS THE WHOLE CALL, HEADERS AND BODY. The transport hands a response over as
    // soon as its headers land, so a timer cleared at that point would leave the body read bounded
    // by nothing but the backstop — which is the caller's deadline plus a grace, not the deadline.
    try {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.fetchImpl(new URL(route, this.base).toString(), {
          method, headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
          // DERIVED FROM the deadline above, never a replacement for it: the controller aborts at
          // `timeoutMilliseconds`, these land a fixed grace later. Without them the platform client
          // applies its own 300_000 ms header deadline and kills a slow-but-legitimate local
          // generation while the sealed case deadline still has time left on it.
          ...httpBackstopTimeoutsFor(timeoutMilliseconds),
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        throw new OllamaRuntimeUnavailable('unreachable', aborted
          ? `the local runtime did not answer ${route} before the deadline or a cancellation`
          : `the local runtime at ${this.base.origin} did not answer: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        const aborted = controller.signal.aborted;
        throw new OllamaRuntimeUnavailable('unreachable', aborted
          ? `the local runtime did not answer ${route} before the deadline or a cancellation`
          : `the local runtime at ${this.base.origin} did not finish answering ${route}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
      if (response.status === 404) throw new OllamaRuntimeUnavailable('modelNotFound', `${route} answered 404: ${redactSecrets(text).slice(0, 200)}`);
      if (response.status < 200 || response.status >= 300) {
        throw new OllamaRuntimeUnavailable('httpFailure', `${route} answered HTTP ${response.status}: ${redactSecrets(text).slice(0, 300)}`);
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!isObject(parsed)) throw new Error('not an object');
        return parsed;
      } catch {
        throw new OllamaRuntimeUnavailable('malformed', `${route} answered something that is not a JSON object`);
      }
    } finally {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
    }
  }

  async version(): Promise<string | undefined> {
    const reply = await this.call('GET', 'api/version', undefined, 10_000);
    return typeof reply.version === 'string' ? reply.version : undefined;
  }

  /** The installed model, by exact tag. Reads the listing and `/api/show`; never pulls anything. */
  async model(name: string): Promise<LocalRuntimeModel> {
    const tags = await this.call('GET', 'api/tags', undefined, 10_000);
    const rows = Array.isArray(tags.models) ? tags.models.filter(isObject) : [];
    const row = rows.find((entry) => entry.name === name || entry.model === name);
    if (row === undefined) throw new OllamaRuntimeUnavailable('modelNotFound', `the local runtime does not have '${name}' installed`);
    const details = isObject(row.details) ? row.details : {};
    const model: LocalRuntimeModel = {
      name,
      digest: typeof row.digest === 'string' ? row.digest : '',
      sizeBytes: asNumber(row.size),
      parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
      family: typeof details.family === 'string' ? details.family : undefined,
    };
    try {
      const shown = await this.call('POST', 'api/show', { model: name }, 10_000);
      if (Array.isArray(shown.capabilities)) model.capabilities = shown.capabilities.filter((c): c is string => typeof c === 'string');
      const info = isObject(shown.model_info) ? shown.model_info : {};
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith('.context_length') && typeof value === 'number') { model.contextLengthTokens = value; break; }
      }
    } catch (error) {
      // Metadata lost, not truth: the listing proved the model is installed and named its digest.
      if (error instanceof OllamaRuntimeUnavailable && error.kind === 'unreachable') throw error;
    }
    return model;
  }

  /**
   * The RUNTIME'S OWN STATE, read once and briefly, before a case is asked to run in it.
   *
   * BOUNDED AND NEVER A WAIT. A probe that polled until a slot freed would turn a measurement into a
   * queue, and the time spent queueing would land on the model's record as latency. So this asks
   * once, inside `timeoutMilliseconds`, and reports what it got — including "I could not ask".
   */
  async probe(modelName: string, timeoutMilliseconds: number): Promise<OllamaRuntimeProbe> {
    const startedAt = Date.now();
    try {
      const reply = await this.call('GET', 'api/ps', undefined, Math.max(1, Math.floor(timeoutMilliseconds)));
      const rows = Array.isArray(reply.models) ? reply.models.filter(isObject) : [];
      const names = [...new Set(rows
        .map((row) => (typeof row.name === 'string' ? row.name : typeof row.model === 'string' ? row.model : ''))
        .filter((name) => name.length > 0))].sort();
      const mine = names.some((name) => name === modelName || name === `${modelName}:latest`);
      const others = names.some((name) => name !== modelName && name !== `${modelName}:latest`);
      const residency: OllamaRuntimeResidency = mine && others ? 'thisAndOtherModelsResident'
        : mine ? 'thisModelResident' : others ? 'otherModelsResident' : 'noModelResident';
      return { residency, residentModels: names, elapsedMilliseconds: Date.now() - startedAt };
    } catch (error) {
      const unavailable = error instanceof OllamaRuntimeUnavailable ? error : undefined;
      // A runtime too old for `/api/ps` is not a broken runtime, and saying so would be a false
      // adverse finding about the machine. The two are kept apart.
      const residency: OllamaRuntimeResidency = unavailable?.kind === 'modelNotFound' ? 'probeUnsupported' : 'probeUnavailable';
      return {
        residency, residentModels: [], elapsedMilliseconds: Date.now() - startedAt,
        detail: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /**
   * One chat turn, STREAMED, so that what happened can be seen while it happens.
   *
   * WHY THIS REPLACED A NON-STREAMING CALL. `/api/chat` with `stream: false` writes nothing until the
   * generation is complete. Until that write, "the model is thinking", "the runtime never started",
   * "another model holds the slot" and "the socket died ten minutes ago" are the same observation:
   * silence. On a machine where a turn takes minutes, that is most of the run. Streaming makes the
   * first token an OBSERVABLE, lets Cernum's deadline and cancellation interrupt an ACTIVE
   * generation rather than a completed one, and surfaces a runtime failure when it happens instead
   * of at the end.
   *
   * WHAT THIS DOES NOT CLAIM. It is not evidence about any upstream defect. It is a better
   * instrument, and a Cernum-side mitigation for the failure mode qualification ran into.
   *
   * THIS METHOD DOES NOT THROW FOR ANYTHING THE STREAM DID. Every ending is an `outcome`, because
   * collapsing them into one exception is exactly the loss of distinction this exists to undo.
   */
  async chatStream(body: JSONObject, timeoutMilliseconds: number, shouldCancel?: () => boolean): Promise<OllamaChatStreamOutcome> {
    const streamStartedAt = Date.now();
    const state = {
      content: '', thinking: '', toolCalls: [] as JSONObject[], eventCount: 0, malformedEventCount: 0,
      done: false, model: undefined as string | undefined, doneReason: undefined as string | undefined,
      firstEventMilliseconds: undefined as number | undefined, firstTokenMilliseconds: undefined as number | undefined,
      promptEvalCount: undefined as number | undefined, promptEvalCachedCount: undefined as number | undefined,
      evalCount: undefined as number | undefined,
      totalDurationNanoseconds: undefined as number | undefined, loadDurationNanoseconds: undefined as number | undefined,
      promptEvalDurationNanoseconds: undefined as number | undefined, evalDurationNanoseconds: undefined as number | undefined,
    };
    const settle = (outcome: OllamaStreamOutcome, detail?: string, httpStatus?: number): OllamaChatStreamOutcome => ({
      outcome, detail, httpStatus, model: state.model, content: state.content, thinking: state.thinking,
      toolCalls: state.toolCalls, firstEventMilliseconds: state.firstEventMilliseconds,
      firstTokenMilliseconds: state.firstTokenMilliseconds,
      // ABSENT WITH A REASON, never a fabricated zero. Whoever reads the record is told which.
      ...(state.firstTokenMilliseconds === undefined
        ? { firstTokenUnavailableReason: firstTokenUnavailableReasonFor(outcome, state.eventCount) } : {}),
      streamStartedAt, streamEndedAt: Date.now(), eventCount: state.eventCount,
      malformedEventCount: state.malformedEventCount, done: state.done, doneReason: state.doneReason,
      promptEvalCount: state.promptEvalCount, promptEvalCachedCount: state.promptEvalCachedCount, evalCount: state.evalCount,
      totalDurationNanoseconds: state.totalDurationNanoseconds, loadDurationNanoseconds: state.loadDurationNanoseconds,
      promptEvalDurationNanoseconds: state.promptEvalDurationNanoseconds, evalDurationNanoseconds: state.evalDurationNanoseconds,
    });

    const controller = new AbortController();
    let deadlinePassed = false;
    let cancelled = false;
    const timer = setTimeout(() => { deadlinePassed = true; controller.abort(); }, Math.max(0, timeoutMilliseconds));
    const poll = shouldCancel === undefined ? undefined : setInterval(() => {
      if (shouldCancel()) { cancelled = true; controller.abort(); }
    }, 200);
    timer.unref?.();
    poll?.unref?.();

    /** How an interruption is read, given whether anything had been generated when it landed. */
    const interrupted = (): OllamaChatStreamOutcome | undefined => {
      if (cancelled || shouldCancel?.() === true) return settle('cancelledByCernum', 'Cernum paused or aborted the run and the stream was closed');
      if (deadlinePassed) {
        return state.firstTokenMilliseconds === undefined
          ? settle('noFirstTokenBeforeDeadline', `the stream was open for ${Date.now() - streamStartedAt} ms and no token had arrived when the deadline passed`)
          : settle('generationExceededDeadline', `the model was generating — first token at ${state.firstTokenMilliseconds} ms — and the deadline passed before it finished`);
      }
      return undefined;
    };

    try {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.fetchImpl(new URL('api/chat', this.base).toString(), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, stream: true }), signal: controller.signal,
          ...httpBackstopTimeoutsFor(timeoutMilliseconds),
        });
      } catch (error) {
        return interrupted() ?? settle('runtimeUnavailable',
          `the local runtime at ${this.base.origin} never answered api/chat with response headers: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      }
      if (response.status < 200 || response.status >= 300) {
        let text = '';
        try { text = await response.text(); } catch { /* the status is the fact; the body is the courtesy */ }
        return settle('requestNeverReachedModel',
          `api/chat answered HTTP ${response.status} and streamed no model event: ${redactSecrets(text).slice(0, 300)}`, response.status);
      }
      if (!response.body) {
        return settle('streamTransportFailure',
          'the runtime accepted a streaming request and returned no readable stream, so nothing could be observed as it arrived');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffered = '';
      let stopped: OllamaChatStreamOutcome | undefined;

      /** One NDJSON line. Returns a settled outcome when this line ENDS the stream, else undefined. */
      const absorb = (line: string): OllamaChatStreamOutcome | undefined => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          state.malformedEventCount += 1;
          return settle('streamPayloadMalformed',
            `a line on the api/chat stream was not JSON, after ${state.eventCount} well-formed event(s): ${redactSecrets(line).slice(0, 200)}`);
        }
        if (!isObject(event)) {
          state.malformedEventCount += 1;
          return settle('streamPayloadMalformed', `a line on the api/chat stream decoded to something that is not a JSON object`);
        }
        if (typeof event.error === 'string' && event.error.length > 0) {
          // The runtime's own failure, told on the stream. Whether a model ran at all is what
          // separates the two readings, and the event count is what says.
          return settle(state.eventCount === 0 ? 'requestNeverReachedModel' : 'streamTransportFailure',
            `the runtime sent an error event: ${redactSecrets(event.error).slice(0, 300)}`);
        }
        const at = Date.now() - streamStartedAt;
        state.eventCount += 1;
        if (state.firstEventMilliseconds === undefined) state.firstEventMilliseconds = at;
        if (typeof event.model === 'string' && event.model.length > 0) state.model = event.model;

        const message = isObject(event.message) ? event.message : undefined;
        const content = typeof message?.content === 'string' ? message.content : '';
        const thinking = typeof message?.thinking === 'string' ? message.thinking : '';
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.filter(isObject) : [];
        // A TOKEN, not an event. Ollama opens a stream before the model has produced anything, and
        // counting that as the first token would report a time to first token the model never earned.
        if (state.firstTokenMilliseconds === undefined && (content.length > 0 || thinking.length > 0 || calls.length > 0)) {
          state.firstTokenMilliseconds = at;
        }
        state.content += content;
        state.thinking += thinking;
        state.toolCalls.push(...calls);

        if (event.done === true) {
          // THE TERMINAL EVENT IS THE ONLY SOURCE OF THE COUNTS. Reading them wherever they appeared
          // would risk adding one twice, and a token count that is sometimes doubled is worse than
          // one that is sometimes absent.
          state.done = true;
          if (typeof event.done_reason === 'string') state.doneReason = event.done_reason;
          state.promptEvalCount = asNumber(event.prompt_eval_count);
          state.promptEvalCachedCount = asNumber(event.prompt_eval_cached_count);
          state.evalCount = asNumber(event.eval_count);
          state.totalDurationNanoseconds = asNumber(event.total_duration);
          state.loadDurationNanoseconds = asNumber(event.load_duration);
          state.promptEvalDurationNanoseconds = asNumber(event.prompt_eval_duration);
          state.evalDurationNanoseconds = asNumber(event.eval_duration);
          return settle('completed');
        }
        return undefined;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // A NETWORK CHUNK IS NOT A JSON EVENT. One read can carry half an object, three whole
          // ones, or a boundary in the middle of a multi-byte character — so the decoder is told
          // the input is a stream and the remainder is carried forward rather than parsed.
          if (value !== undefined) buffered += decoder.decode(value, { stream: true });
          let newline = buffered.indexOf('\n');
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line.length > 0) {
              stopped = absorb(line);
              if (stopped !== undefined) break;
            }
            newline = buffered.indexOf('\n');
          }
          if (stopped !== undefined) break;
        }
        if (stopped === undefined) {
          buffered += decoder.decode();
          const trailing = buffered.trim();
          // A LAST LINE WITH NO NEWLINE IS STILL A LINE. Ollama ends its stream with one often enough.
          if (trailing.length > 0) stopped = absorb(trailing);
        }
      } catch (error) {
        return interrupted() ?? settle(state.eventCount === 0 ? 'requestNeverReachedModel' : 'streamTransportFailure',
          `the api/chat stream broke after ${state.eventCount} event(s): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
      } finally {
        // Cancelling a reader that already finished is harmless; leaving one open leaks the socket.
        await reader.cancel().catch(() => undefined);
      }

      if (stopped !== undefined) return stopped;
      return interrupted() ?? settle(state.eventCount === 0 ? 'requestNeverReachedModel' : 'streamTransportFailure',
        state.eventCount === 0
          ? 'the runtime answered api/chat with HTTP 200 and closed the stream without a single event'
          : `the api/chat stream ended after ${state.eventCount} event(s) without the runtime's terminal done event`);
    } finally {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
    }
  }
}

/** Why no time to first token is being recorded. Never a number; always a stated reason. */
function firstTokenUnavailableReasonFor(outcome: OllamaStreamOutcome, eventCount: number): string {
  switch (outcome) {
    case 'runtimeUnavailable': return 'the runtime never answered with response headers, so no stream was ever open';
    case 'requestNeverReachedModel': return 'the runtime answered and streamed no model event, so nothing this driver saw shows a model running';
    case 'noFirstTokenBeforeDeadline': return 'the stream was open and no token had arrived when the deadline passed';
    case 'streamTransportFailure': return `the stream broke or the runtime failed after ${eventCount} event(s) and before any token`;
    case 'streamPayloadMalformed': return 'the stream carried a payload that is not the protocol\'s, and no token was read from it';
    case 'cancelledByCernum': return 'Cernum paused or aborted the run before any token arrived';
    case 'generationExceededDeadline': return 'the deadline passed mid-generation (unreachable: a token had already been timed)';
    case 'completed': return 'the turn completed without the runtime ever emitting content, thinking or a tool call';
    default: return 'no token was observed on this turn';
  }
}

// MARK: - The tools Cernum offers, and carries out

export interface OllamaToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: JSONObject };
}

/** The tool set, derived from the case's policy. Deterministic, so two attempts see the same tools. */
export function ollamaWorkspaceTools(tools: ToolPolicy, checks: { id: string; kind: string }[]): OllamaToolDefinition[] {
  const definitions: OllamaToolDefinition[] = [];
  const fn = (name: string, description: string, properties: JSONObject, required: string[]): OllamaToolDefinition =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  if (tools.fileRead) {
    definitions.push(fn('list_files', 'List files under a directory of the repository (default: the root).',
      { path: { type: 'string', description: 'directory relative to the repository root' } }, []));
    definitions.push(fn('read_file', 'Read one file of the repository.',
      { path: { type: 'string', description: 'file path relative to the repository root' } }, ['path']));
  }
  if (tools.fileWrite) {
    definitions.push(fn('write_file', 'Create or overwrite one file of the repository with the given content.',
      { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']));
    definitions.push(fn('replace_in_file', 'Replace one exact occurrence of old_text with new_text in a file.',
      { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']));
  }
  if (tools.commandExecution && checks.length > 0) {
    definitions.push(fn('run_check', `Run one of the repository's named checks and see its output. Available: ${checks
      .map((check) => `${check.id} (${check.kind})`).join(', ')}.`,
    { check_id: { type: 'string', enum: checks.map((check) => check.id) } }, ['check_id']));
  }
  return definitions;
}

function listFiles(root: string, relative: string): string[] {
  const start = resolveInside(root, relative.length === 0 ? '.' : relative);
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= OLLAMA_WORKSPACE_MAXIMUM_LISTED_FILES) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(start);
  return out;
}

// MARK: - The driver

export interface OllamaWorkspaceDriverOptions {
  /** The installed tag, exactly as discovery reported it. */
  requestedModelID: string;
  /** The weights digest frozen at planning time. Empty means none was known — refused. */
  expectedDigest: string;
  endpoint?: string;
  /** Injected by the tests: a fake runtime on the other end of `fetch`, never a real one. */
  fetch?: FetchLike;
  maximumTurns?: number;
  outputTokensPerTurn?: number;
  /** The ceiling on the window this harness asks the runtime to open. Defaults to the constant above. */
  contextCeilingTokens?: number;
  /** The machine, as a fingerprint key and a label. Injected by the tests; read from the OS in life. */
  machine?: { machineKey: string; label: string; platform: string };
}

interface ChatMessage extends JSONObject {
  role: string;
  content: string;
}

export class OllamaWorkspaceDriver implements WorkspaceAgentDriver {
  readonly driverID = OLLAMA_WORKSPACE_DRIVER_ID;

  readonly provider: ProviderID = 'ollama';

  readonly capabilities = OLLAMA_WORKSPACE_CAPABILITIES;

  /** No executable: the "tool" is Cernum. Kept for the disclosure shape the other drivers share. */
  readonly executablePath = undefined;

  readonly commandName = 'ollama';

  readonly cliVersionVerifiedAgainst = OLLAMA_WORKSPACE_HARNESS_VERSION;

  readonly endpoint: string;

  constructor(private readonly options: OllamaWorkspaceDriverOptions) {
    this.endpoint = options.endpoint ?? OLLAMA_WORKSPACE_DEFAULT_ENDPOINT;
  }

  /** What would be refused before anything is sent. PURE; for a preflight and for `run`. */
  unexpressedFor(tools: ToolPolicy, networkPolicy: NetworkPolicy, hasChecks: boolean): string[] {
    const refusals: string[] = [];
    try { validateLoopbackEndpoint(this.endpoint); } catch (error) {
      refusals.push(`endpoint ${this.endpoint}: ${error instanceof Error ? error.message : String(error)}. A local model must stay local.`);
    }
    if (this.options.expectedDigest.length === 0) {
      refusals.push('no weights digest was frozen for this model, so nothing could establish which weights answer. Discover '
        + 'the local runtime first; the digest is the identity on this route.');
    }
    if (tools.commandExecution && !hasChecks) {
      refusals.push('this case allows command execution and declares no visible check, and this route runs no command a '
        + 'model chose. There is nothing the model could run.');
    }
    if (tools.allowedExecutables.length > 0) {
      // Nothing to express: the model names no executable at all. Recorded as a policy that holds trivially.
    }
    if (networkPolicy === 'unrestricted') {
      refusals.push('networkPolicy unrestricted: no tool on this route reaches a network, so a task that needs one cannot be done.');
    }
    return refusals;
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const events = () => request.transcript.build().events.slice(before);
    const checks = request.sealedChecks?.checks ?? [];
    const unexpressed = this.unexpressedFor(request.tools, request.networkPolicy, checks.length > 0);
    const machine = this.options.machine ?? (() => {
      const fingerprint = readMachineFingerprint();
      return { machineKey: machineKey(fingerprint), label: fingerprint.hostname, platform: `${fingerprint.platform}-${fingerprint.architecture}` };
    })();
    const notEnforceable = [OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY, OLLAMA_IDENTITY_IS_THE_DIGEST,
      'the runtime\'s token counts are recorded as reported; a figure a reply omits is absent, never zero or estimated',
      'the pre-case runtime probe reads /api/ps, which reports which models are RESIDENT and not whether one is '
      + 'generating. No model resident is the ordinary case — Ollama loads on request — and is never recorded as a fault.'];
    const baseIsolation = [
      `harness ${OLLAMA_WORKSPACE_HARNESS_VERSION}: Cernum's own loop, at most ${this.options.maximumTurns ?? OLLAMA_WORKSPACE_MAXIMUM_TURNS} `
        + `turns of at most ${this.options.outputTokensPerTurn ?? OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN} output tokens each`,
      'every file read and write performed by Cernum through resolveInside, confined to the workspace',
      OLLAMA_CHAT_IS_STREAMED,
      OLLAMA_STAYS_ON_THIS_MACHINE,
      `endpoint ${this.endpoint} on ${machine.label} (${machine.machineKey}, ${machine.platform})`,
    ];

    const result = (kind: WorkspaceAgentFailureKind | undefined, detail: string,
                    extra: Partial<WorkspaceAgentResult> = {}): WorkspaceAgentResult => ({
      completed: kind === undefined,
      failure: kind === undefined ? undefined : { kind, detail },
      reportedModelID: '',
      unexpressed, notEnforceable,
      activeIsolation: [...baseIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      events: events(),
      ...extra,
    });

    if (unexpressed.length > 0) {
      return result('policyNotExpressible', `this case froze settings the local route cannot express, so nothing was sent: ${unexpressed.join('; ')}`);
    }

    const client = new LocalRuntimeClient(this.endpoint, this.options.fetch);
    let runtimeVersion: string | undefined;
    let model: LocalRuntimeModel;
    try {
      runtimeVersion = await client.version();
      model = await client.model(this.options.requestedModelID);
    } catch (error) {
      const unavailable = error instanceof OllamaRuntimeUnavailable ? error : undefined;
      return result(unavailable?.kind === 'modelNotFound' || unavailable?.kind === 'unreachable' ? 'notInstalled' : 'transport',
        `LOCAL RUNTIME UNAVAILABLE — ${redactSecrets(error instanceof Error ? error.message : String(error))}. This is a fact about `
        + 'this machine\'s runtime, not about the model, and it measured nothing.');
    }
    if (model.digest !== this.options.expectedDigest) {
      return result('policyNotExpressible', `the installed '${model.name}' has weights digest ${model.digest || '(none)'}, and `
        + `${this.options.expectedDigest} was frozen when this run was planned. Different weights are a different model; `
        + 'nothing was sent. Re-plan against what is installed now.');
    }
    if (model.capabilities !== undefined && !model.capabilities.includes('tools')) {
      return result('policyNotExpressible', `the runtime reports '${model.name}' can do ${model.capabilities.join(', ') || 'nothing'}, `
        + 'and not tools. A workspace task through this route needs tool calls; nothing was sent.');
    }

    const tools = ollamaWorkspaceTools(request.tools, checks);
    const messages: ChatMessage[] = [
      { role: 'system', content: OLLAMA_WORKSPACE_SYSTEM_PROMPT },
      { role: 'user', content: request.instruction },
    ];
    const maximumTurns = this.options.maximumTurns ?? OLLAMA_WORKSPACE_MAXIMUM_TURNS;
    const contextWindowTokens = ollamaWorkspaceContextWindow(model.contextLengthTokens, this.options.contextCeilingTokens);
    const deadline = startedAt + request.timeoutMilliseconds;

    // THE RUNTIME'S STATE, BEFORE THIS CASE IS ASKED TO RUN IN IT. One bounded read, never a wait:
    // see `LocalRuntimeClient.probe`. What it finds is recorded and disclosed, and it decides
    // nothing — a runtime with no model resident is the ordinary case, because Ollama loads on
    // request, and a first turn that pays a load cost is a fact about this machine.
    const probe = await client.probe(this.options.requestedModelID,
      Math.max(1, Math.min(OLLAMA_WORKSPACE_PROBE_TIMEOUT_MILLISECONDS, deadline - Date.now())));

    const reported: string[] = [];
    const counts = { prompt: [] as number[], evaluated: [] as number[], total: [] as number[], load: [] as number[] };
    const streams: OllamaChatStreamOutcome[] = [];
    let thinkingSeen = false;
    let finalMessage: string | undefined;
    let failure: { kind: WorkspaceAgentFailureKind; detail: string } | undefined;
    /** The first token of the attempt, on this process's clock, from the attempt's own start. */
    let firstTokenMilliseconds: number | undefined;
    let turns = 0;

    const usage = (): WorkspaceAgentUsage => {
      const sum = (values: number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0));
      const reportedModelID = reported[reported.length - 1] ?? '';
      const last = streams[streams.length - 1];
      const tokenless = streams.find((stream) => stream.firstTokenMilliseconds === undefined);
      return {
        inputTokens: sum(counts.prompt),
        freshInputTokens: sum(counts.prompt),
        visibleOutputTokens: sum(counts.evaluated),
        ...(thinkingSeen ? { outputTokenSemantics: 'evalCountIncludesThinking' } : {}),
        // THE FIRST TOKEN, not the first completed reply. Under the non-streaming driver this field
        // could only ever hold the moment a whole turn came back, which on a machine where a turn
        // takes minutes was a time-to-first-token wrong by minutes. Absent when no token ever
        // arrived, with `localFirstTokenUnavailableReason` saying why.
        observedFirstOutputMilliseconds: firstTokenMilliseconds,
        ...(firstTokenMilliseconds === undefined && tokenless !== undefined
          ? { localFirstTokenUnavailableReason: tokenless.firstTokenUnavailableReason } : {}),
        providerReportedDurationMilliseconds: counts.total.length === 0 ? undefined : Math.round(sum(counts.total)! / 1e6),
        numTurns: turns,
        identityState: reportedModelID.length === 0 ? 'unverifiable' : verifyProviderIdentity(this.options.requestedModelID, reportedModelID).state,
        participantIDs: [...new Set(reported)].sort(),
        terminalReason: failure?.kind ?? (finalMessage === undefined ? undefined : 'stop'),
        // THE DRIVER'S FINER READING, beside the shared vocabulary above rather than in place of it.
        // `terminalReason` stays the closed kind every route uses; this says which of the several
        // things that kind can mean actually happened. See `OLLAMA_STREAM_OUTCOMES`.
        localStreamOutcome: last?.outcome,
        localStreamOutcomes: streams.map((stream) => stream.outcome),
        localStreamEventCount: streams.length === 0 ? undefined : streams.reduce((total, stream) => total + stream.eventCount, 0),
        localStreamMalformedEventCount: streams.length === 0 ? undefined : streams.reduce((total, stream) => total + stream.malformedEventCount, 0),
        localRuntimeResidencyBefore: probe.residency,
        localRuntimeResidentModelsBefore: probe.residentModels,
        localRuntimeProbeMilliseconds: probe.elapsedMilliseconds,
        ...(probe.detail === undefined ? {} : { localRuntimeProbeDetail: probe.detail }),
        localModelDigest: model.digest,
        localRuntimeVersion: runtimeVersion,
        localRuntimeEndpoint: this.endpoint,
        localModelContextLengthTokens: model.contextLengthTokens,
        localModelContextWindowRequestedTokens: contextWindowTokens,
        localModelSizeBytes: model.sizeBytes,
        executionMachine: machine.machineKey,
        executionMachineLabel: machine.label,
        executionPlatform: machine.platform,
        rawUsage: {
          promptEvalCounts: counts.prompt, evalCounts: counts.evaluated,
          loadDurationNanoseconds: counts.load, totalDurationNanoseconds: counts.total,
          // ONE ROW PER STREAMED TURN. This is what makes a wall clock decomposable after the fact:
          // when the stream opened, when the first token landed, how many events carried it, how
          // long the runtime says it spent, and how the turn ended.
          streamedTurns: streams.map((stream, index) => ({
            turn: index + 1,
            outcome: stream.outcome,
            detail: stream.detail ?? null,
            streamOpenedAtMillisecondsIntoAttempt: stream.streamStartedAt - startedAt,
            streamClosedAtMillisecondsIntoAttempt: stream.streamEndedAt - startedAt,
            firstEventMilliseconds: stream.firstEventMilliseconds ?? null,
            firstTokenMilliseconds: stream.firstTokenMilliseconds ?? null,
            firstTokenUnavailableReason: stream.firstTokenUnavailableReason ?? null,
            eventCount: stream.eventCount,
            malformedEventCount: stream.malformedEventCount,
            done: stream.done,
            doneReason: stream.doneReason ?? null,
            promptEvalCount: stream.promptEvalCount ?? null,
            promptEvalCachedCount: stream.promptEvalCachedCount ?? null,
            evalCount: stream.evalCount ?? null,
            totalDurationNanoseconds: stream.totalDurationNanoseconds ?? null,
            loadDurationNanoseconds: stream.loadDurationNanoseconds ?? null,
            promptEvalDurationNanoseconds: stream.promptEvalDurationNanoseconds ?? null,
            evalDurationNanoseconds: stream.evalDurationNanoseconds ?? null,
          })),
          runtimeProbe: {
            residency: probe.residency, residentModels: probe.residentModels,
            elapsedMilliseconds: probe.elapsedMilliseconds, detail: probe.detail ?? null,
          },
        } as unknown as CanonicalValue,
      };
    };

    for (;;) {
      if (request.shouldCancel?.()) { failure = { kind: 'cancelled', detail: 'the run was paused or aborted before this attempt finished' }; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { failure = { kind: 'timeout', detail: `the attempt's ${request.timeoutMilliseconds} ms deadline passed` }; break; }
      if (turns >= maximumTurns) {
        failure = { kind: 'exitFailure', detail: `the model used all ${maximumTurns} turns this harness allows without finishing` };
        break;
      }
      turns += 1;
      const stream = await client.chatStream({
        model: this.options.requestedModelID, messages, tools,
        options: {
          num_predict: this.options.outputTokensPerTurn ?? OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN,
          // THE WINDOW CERNUM ALREADY MEASURED. Without this the runtime opens its own default
          // window — 4_096 on current Ollama — whatever the model can actually do, and a workspace
          // conversation that outgrows it is TRUNCATED: the user turn falls off the front and the
          // request is rejected for having no user query in it. Absent when the runtime published
          // no context length, so an unknown stays unknown rather than becoming a number.
          ...(contextWindowTokens === undefined ? {} : { num_ctx: contextWindowTokens }),
          ...(request.temperatureMilli === undefined ? {} : { temperature: request.temperatureMilli / 1000 }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
        },
      }, remaining, request.shouldCancel);
      streams.push(stream);
      if (stream.model !== undefined && stream.model.length > 0) reported.push(stream.model);
      // THE ATTEMPT'S FIRST TOKEN, placed on the attempt's clock: where in the attempt the turn's
      // stream opened, plus how far into that stream the token landed.
      if (firstTokenMilliseconds === undefined && stream.firstTokenMilliseconds !== undefined) {
        firstTokenMilliseconds = (stream.streamStartedAt - startedAt) + stream.firstTokenMilliseconds;
      }
      // THE COUNTS COME FROM THE TERMINAL EVENT AND NOWHERE ELSE, so a turn that ended without one
      // contributes nothing rather than a partial figure dressed as a total.
      if (stream.promptEvalCount !== undefined) counts.prompt.push(stream.promptEvalCount);
      if (stream.evalCount !== undefined) counts.evaluated.push(stream.evalCount);
      if (stream.totalDurationNanoseconds !== undefined) counts.total.push(stream.totalDurationNanoseconds);
      if (stream.loadDurationNanoseconds !== undefined) counts.load.push(stream.loadDurationNanoseconds);

      if (stream.outcome !== 'completed') {
        // WHAT HAD ARRIVED IS KEPT. Under the non-streaming driver a turn that did not finish left
        // NOTHING on the record — the whole reply was still in the runtime. What the model had
        // actually produced before the stream ended is evidence, and it is recorded as the partial
        // thing it is rather than as a complete turn.
        if (stream.thinking.length > 0) {
          thinkingSeen = true;
          request.transcript.emit('message', 'agentReported', request.attemptIndex, stream.thinking,
            { channel: 'thinking', reason: `partialBefore:${stream.outcome}`, textDigest: sha256Text(stream.thinking),
              textByteCount: Buffer.byteLength(stream.thinking, 'utf8') });
        }
        if (stream.content.length > 0) {
          request.transcript.emit('message', 'agentReported', request.attemptIndex, stream.content,
            { channel: 'visible', reason: `partialBefore:${stream.outcome}`, textDigest: sha256Text(stream.content),
              textByteCount: Buffer.byteLength(stream.content, 'utf8') });
        }
        // ONE TRANSLATION, IN ONE PLACE. The shared kind is what every route's records compare on;
        // the outcome is what this route observed, and it is carried onto the record intact.
        const kind = stream.httpStatus === 404 ? 'notInstalled' : OLLAMA_FAILURE_FOR_STREAM_OUTCOME[stream.outcome] ?? 'transport';
        failure = { kind, detail: `${stream.outcome}: ${stream.detail ?? 'the streamed turn did not complete'}` };
        break;
      }

      const content = stream.content;
      const thinking = stream.thinking;
      if (thinking.length > 0) {
        thinkingSeen = true;
        request.transcript.emit('message', 'agentReported', request.attemptIndex, thinking,
          { channel: 'thinking', textDigest: sha256Text(thinking), textByteCount: Buffer.byteLength(thinking, 'utf8') });
      }
      if (content.length > 0) {
        request.transcript.emit('message', 'agentReported', request.attemptIndex, content,
          { channel: 'visible', textDigest: sha256Text(content), textByteCount: Buffer.byteLength(content, 'utf8') });
      }
      const calls = stream.toolCalls;
      messages.push({ role: 'assistant', content, ...(calls.length > 0 ? { tool_calls: calls } : {}) } as ChatMessage);
      if (calls.length === 0) { finalMessage = content.trim().length > 0 ? content.trim() : undefined; break; }

      for (const [index, call] of calls.entries()) {
        const fn = isObject(call.function) ? call.function : {};
        const name = typeof fn.name === 'string' ? fn.name : 'unknown';
        let args: JSONObject = {};
        if (isObject(fn.arguments)) args = fn.arguments;
        else if (typeof fn.arguments === 'string') { try { const parsed = JSON.parse(fn.arguments); if (isObject(parsed)) args = parsed; } catch { /* reported below */ } }
        const callID = `turn${turns}-call${index}`;
        request.transcript.emit('toolCall', 'agentReported', request.attemptIndex, `${name} ${typeof args.path === 'string' ? args.path : typeof args.check_id === 'string' ? args.check_id : ''}`.trim(),
          { toolName: name, callID, argumentsDigest: sha256Text(JSON.stringify(args)) });
        const output = await this.carryOut(name, args, request, callID, tools);
        request.transcript.emit('toolResult', 'engineObserved', request.attemptIndex, output.text.length === 0 ? '(no output)' : output.text,
          { callID, ok: output.ok, byteCount: Buffer.byteLength(output.text, 'utf8') });
        messages.push({ role: 'tool', content: output.text, tool_name: name } as ChatMessage);
      }
    }

    // THE DIGEST AGAIN, after the last turn. A model re-pulled mid-run would otherwise be scored as the first one.
    let digestAfter: string | undefined;
    try { digestAfter = (await client.model(this.options.requestedModelID)).digest; } catch { digestAfter = undefined; }
    const reportedModelID = reported[reported.length - 1] ?? '';
    const substituted = reported.find((name) => verifyProviderIdentity(this.options.requestedModelID, name).state === 'substituted');
    if (failure === undefined && substituted !== undefined) {
      failure = { kind: 'policyNotExpressible', detail: `the runtime named ${substituted} as the answering model and `
        + `${this.options.requestedModelID} was requested; the attempt is refused and the served model kept` };
    }
    if (failure === undefined && digestAfter !== undefined && digestAfter !== model.digest) {
      failure = { kind: 'policyNotExpressible', detail: `the weights digest changed during the attempt (${model.digest} → ${digestAfter}); `
        + 'the work was done by weights this binding does not describe' };
    }

    return {
      completed: failure === undefined,
      finalMessage,
      failure,
      reportedModelID,
      unexpressed, notEnforceable,
      activeIsolation: [...baseIsolation, `runtime ${runtimeVersion ?? '(version unreported)'} · weights digest ${model.digest} `
        + `verified before the first turn${digestAfter === undefined ? '' : ' and after the last'}`,
      `runtime state before this case: ${probe.residency}`
        + `${probe.residentModels.length === 0 ? '' : ` (resident: ${probe.residentModels.join(', ')})`}`
        + `${probe.detail === undefined ? '' : ` — ${probe.detail}`}, read in ${probe.elapsedMilliseconds} ms`,
      WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      usage: usage(),
      events: events(),
    };
  }

  /** Carry out one tool call. Every path is confined; every effect is Cernum's own. */
  private async carryOut(name: string, args: JSONObject, request: WorkspaceAgentRequest, callID: string,
                         offered: OllamaToolDefinition[]): Promise<{ ok: boolean; text: string }> {
    const root = request.workspaceRoot;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (!offered.some((tool) => tool.function.name === name)) {
      return { ok: false, text: `'${name}' is not a tool offered here. Offered: ${offered.map((tool) => tool.function.name).join(', ')}` };
    }
    try {
      switch (name) {
        case 'list_files': {
          const files = listFiles(root, text(args.path));
          return { ok: true, text: files.join('\n') };
        }
        case 'read_file': {
          const relative = text(args.path);
          const target = resolveInside(root, relative);
          const bytes = fs.readFileSync(target);
          request.transcript.emit('fileRead', 'engineObserved', request.attemptIndex, `read ${relative}`,
            { path: relative, toolName: name, callID, afterSHA256: sha256Text(bytes.toString('utf8')) });
          const body = bytes.subarray(0, OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES).toString('utf8');
          return { ok: true, text: bytes.length > OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES ? `${body}\n…[truncated]` : body };
        }
        case 'write_file': case 'replace_in_file': {
          const relative = text(args.path);
          const target = resolveInside(root, relative);
          const beforeContents = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
          let contents: string;
          if (name === 'write_file') {
            contents = text(args.content);
          } else {
            const oldText = text(args.old_text);
            if (beforeContents === undefined) return { ok: false, text: `${relative} does not exist` };
            const at = oldText.length === 0 ? -1 : beforeContents.indexOf(oldText);
            if (at < 0) return { ok: false, text: `old_text was not found in ${relative}` };
            if (beforeContents.indexOf(oldText, at + 1) >= 0) return { ok: false, text: `old_text occurs more than once in ${relative}` };
            contents = beforeContents.slice(0, at) + text(args.new_text) + beforeContents.slice(at + oldText.length);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, contents);
          request.transcript.emit('fileWrite', 'engineObserved', request.attemptIndex, `wrote ${relative}`, {
            path: relative, toolName: name, callID,
            beforeSHA256: beforeContents === undefined ? undefined : sha256Text(beforeContents),
            afterSHA256: sha256Text(contents), byteCount: Buffer.byteLength(contents, 'utf8'),
          });
          return { ok: true, text: `wrote ${relative} (${Buffer.byteLength(contents, 'utf8')} bytes)` };
        }
        case 'run_check': {
          const runner = request.sealedChecks;
          if (runner === undefined) return { ok: false, text: 'this case has no checks to run' };
          const outcome = await runner.run(text(args.check_id));
          if (!outcome.known) return { ok: false, text: outcome.detail };
          return { ok: outcome.passed, text: `${outcome.checkID}: ${outcome.passed ? 'PASSED' : outcome.timedOut ? 'TIMED OUT' : `FAILED (exit ${outcome.exitCode ?? 'none'})`}\n${outcome.output}` };
        }
        default:
          return { ok: false, text: `'${name}' is not a tool this harness implements` };
      }
    } catch (error) {
      // A refused path is the ENGINE saying no, recorded as a boundary refusal as well as told to the model.
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      if (/outside|escape|symlink|resolve/i.test(detail)) {
        request.transcript.emit('boundaryRefusal', 'engineObserved', request.attemptIndex, detail, { path: text(args.path) });
      }
      return { ok: false, text: detail };
    }
  }
}

/** The lines a preflight prints about what this driver will do. */
export function describeOllamaInvocation(driver: OllamaWorkspaceDriver, tools: ToolPolicy,
                                         checks: { id: string; kind: string }[]): string[] {
  return [
    `endpoint        ${driver.endpoint} (loopback only)`,
    `harness         ${OLLAMA_WORKSPACE_HARNESS_VERSION}`,
    `tools           ${ollamaWorkspaceTools(tools, checks).map((tool) => tool.function.name).join(', ') || '(none)'}`,
    `commands        ${OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY}`,
    `identity        ${OLLAMA_IDENTITY_IS_THE_DIGEST}`,
    `privacy         ${OLLAMA_STAYS_ON_THIS_MACHINE}`,
  ];
}
