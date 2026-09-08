// Model Lab core · the Ollama runtime contract, prober, wire codec, and live adapter
// (port of `ModelLabOllamaRuntime`, `ModelLabOllamaLiveAdapter`, and the pure parts of
// `ModelLabOllamaHTTPTransport`). No networking here: the transport is an injected seam, and the
// only transport this module ships REFUSES every call. The HTTP transport lives in `ollama-http.ts`.
//
// The read/describe/generate surface is the ONLY surface this module and the HTTP transport can
// spell: neither can pull, create, copy, push, or delete a model. Model downloads are a separate,
// explicit, user-confirmed act in the application's runtime-management module — never part of
// benchmark execution.

import { AttemptRequest, CancellationToken, EvaluationAdapter, requestDigest } from './adapter';
import { CandidateDescriptor, ExecutionClass, Measurement, configurationID, configurationValue, deterministicCandidateID, makeCandidate, runtimeConfiguration } from './candidate';
import { Observation, TerminalStatus } from './run';
import { RuntimeTelemetry, derivedTokensPerSecondMilli } from './telemetry';
import { parseJSONContainer } from './json';

// MARK: - Transport failures

export type OllamaFailureKind = 'notConfigured' | 'connectionFailed' | 'timeout' | 'cancelled' | 'modelNotFound' | 'httpFailure' | 'malformedResponse';

export class OllamaTransportFailure extends Error {
  constructor(public readonly kind: OllamaFailureKind, public readonly detail: string = '', public readonly status?: number, public readonly model?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'OllamaTransportFailure';
  }
}

// MARK: - Runtime reports

export interface OllamaVersionReport { version: string }

export interface OllamaModelReport {
  name: string;
  digest?: string;
  quantizationLevel?: string;
  parameterSize?: string;
  family?: string;
  contextLengthTokens?: number;
}

export interface OllamaRunningModelReport { name: string; sizeBytes?: number; sizeVRAMBytes?: number }

/** One row of the installed-model listing, as the application shows it (beyond what the prober needs). */
export interface OllamaInstalledModel {
  name: string;
  digest?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  quantizationLevel?: string;
  parameterSize?: string;
  family?: string;
}

export interface OllamaChatMessage { role: string; content: string }

export type ThinkingMode = 'disabled' | 'enabled' | 'runtimeDefault';
export const OLLAMA_THINKING_MODE_KEY = 'ollamaThinkingMode';
export function thinkingWireValue(mode: ThinkingMode): boolean | undefined {
  switch (mode) {
    case 'disabled': return false;
    case 'enabled': return true;
    case 'runtimeDefault': return undefined;
  }
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  temperatureMilli?: number;
  topPMilli?: number;
  maxOutputTokens?: number;
  seed?: number;
  stopSequences: string[];
  requireJSONFormat: boolean;
  thinkingMode: ThinkingMode;
  timeoutMilliseconds: number;
  /**
   * Seconds the runtime should keep the weights resident after this request. Omitted entirely when
   * undefined, so an ordinary benchmark request is byte-identical to what it always was. Zero is the
   * runtime's own way of saying "release them now", which is how the benchmark engine asks a model
   * to step aside before the next candidate loads.
   */
  keepAliveSeconds?: number;
}

export interface OllamaChatReport {
  model: string;
  content: string;
  thinkingTrace?: string;
  doneReason?: string;
  totalDurationNanoseconds?: number;
  loadDurationNanoseconds?: number;
  promptEvalCount?: number;
  promptEvalDurationNanoseconds?: number;
  evalCount?: number;
  evalDurationNanoseconds?: number;
}

// MARK: - Transport seam

export interface OllamaTransport {
  version(): Promise<OllamaVersionReport>;
  /** Metadata for one INSTALLED model. Must never pull, download, or create anything. */
  model(name: string): Promise<OllamaModelReport>;
  runningModels(): Promise<OllamaRunningModelReport[]>;
  chat(request: OllamaChatRequest, cancellation: CancellationToken): Promise<OllamaChatReport>;
}

/** The ONLY transport this module provides: always refuses (fail-closed by construction). */
export class UnconfiguredOllamaTransport implements OllamaTransport {
  async version(): Promise<OllamaVersionReport> { throw new OllamaTransportFailure('notConfigured'); }
  async model(): Promise<OllamaModelReport> { throw new OllamaTransportFailure('notConfigured'); }
  async runningModels(): Promise<OllamaRunningModelReport[]> { throw new OllamaTransportFailure('notConfigured'); }
  async chat(): Promise<OllamaChatReport> { throw new OllamaTransportFailure('notConfigured'); }
}

// MARK: - Wire codec (pure; proven against `fixtures/parity/ollama.json`)

/** The exact JSON body one chat request becomes (sorted keys). Milli-scaled integers become decimals here only. */
export function chatRequestBody(request: OllamaChatRequest): string {
  const options: Record<string, unknown> = {};
  if (request.temperatureMilli !== undefined) options.temperature = request.temperatureMilli / 1_000;
  if (request.topPMilli !== undefined) options.top_p = request.topPMilli / 1_000;
  if (request.maxOutputTokens !== undefined) options.num_predict = request.maxOutputTokens;
  if (request.seed !== undefined) options.seed = request.seed;
  if (request.stopSequences.length > 0) options.stop = request.stopSequences;
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  };
  if (Object.keys(options).length > 0) payload.options = options;
  if (request.requireJSONFormat) payload.format = 'json';
  const think = thinkingWireValue(request.thinkingMode);
  if (think !== undefined) payload.think = think;
  if (request.keepAliveSeconds !== undefined) payload.keep_alive = request.keepAliveSeconds;
  return JSON.stringify(sortKeys(payload));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The report one raw `/api/chat` response becomes. The answer and the reasoning field stay separate. */
export function chatReportFrom(text: string): OllamaChatReport {
  const wire = parseJSONContainer(text);
  if (!wire || Array.isArray(wire)) throw new OllamaTransportFailure('malformedResponse', `chat response did not decode: ${text.length === 0 ? 'empty body' : 'not a JSON object'}`);
  const model = wire.model;
  if (typeof model !== 'string') throw new OllamaTransportFailure('malformedResponse', 'chat response names no model');
  const message = (wire.message && typeof wire.message === 'object' ? wire.message : {}) as Record<string, unknown>;
  const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const thinking = str(message.thinking);
  return {
    model,
    content: str(message.content) ?? '',
    // An empty trace is no trace: the distinction that matters is "reported" vs "not reported".
    thinkingTrace: thinking && thinking.length > 0 ? thinking : undefined,
    doneReason: str(wire.done_reason),
    totalDurationNanoseconds: int(wire.total_duration),
    loadDurationNanoseconds: int(wire.load_duration),
    promptEvalCount: int(wire.prompt_eval_count),
    promptEvalDurationNanoseconds: int(wire.prompt_eval_duration),
    evalCount: int(wire.eval_count),
    evalDurationNanoseconds: int(wire.eval_duration),
  };
}

// MARK: - Candidate prober

/** Builds a truthful candidate descriptor from the runtime's OWN model report. */
export async function probeCandidate(modelName: string, transport: OllamaTransport, thinkingMode: ThinkingMode = 'disabled'): Promise<CandidateDescriptor> {
  const report = await transport.model(modelName);
  return candidateFromModelReport(report, thinkingMode);
}

export function candidateFromModelReport(report: OllamaModelReport, thinkingMode: ThinkingMode = 'disabled'): CandidateDescriptor {
  let version: string;
  if (report.digest && report.digest.length > 0) {
    const parts = report.digest.split(':');
    const hex = parts[parts.length - 1];
    version = 'digest-' + Array.from(hex).slice(0, 12).join('');
  } else {
    version = 'unreported';
  }
  const quantization = report.quantizationLevel && report.quantizationLevel.length > 0 ? report.quantizationLevel : 'unreported';
  const artifactDigest: Measurement<string> = report.digest !== undefined
    ? { measured: report.digest }
    : { unavailableReason: `the runtime reported no content digest for ${report.name}` };
  const contextLimit: Measurement<number> = report.contextLengthTokens !== undefined
    ? { measured: report.contextLengthTokens }
    : { unavailableReason: "the runtime's model metadata declares no context length" };
  const configuration: Record<string, string> = { runtime: 'ollama', transport: 'loopback-http', [OLLAMA_THINKING_MODE_KEY]: thinkingMode };
  if (report.family && report.family.length > 0) configuration.reportedFamily = report.family;
  if (report.parameterSize && report.parameterSize.length > 0) configuration.reportedParameterSize = report.parameterSize;
  return makeCandidate({
    id: deterministicCandidateID('ollama', report.name, version, quantization),
    displayName: `Ollama ${report.name}`,
    provider: 'ollama',
    exactModelIdentity: report.name,
    artifactDigest,
    executionClass: 'localHostProcess',
    quantization,
    declaredContextLimitTokens: contextLimit,
    inputModalities: ['text'],
    outputModalities: ['text'],
    streaming: 'declared',
    structuredOutput: 'declared',
    toolCalls: 'unknown',
    runtimeConfiguration: runtimeConfiguration(configuration),
    reproducibility: 'bestEffort',
    privacyClass: 'onDeviceOnly',
    availability: { state: 'available' },
  });
}

// MARK: - Live adapter (pure mapping over the injected transport)

export class OllamaLiveAdapter implements EvaluationAdapter {
  readonly adapterID = 'adapter:ollama:live';
  readonly supportedExecutionClasses: ExecutionClass[] = ['localHostProcess'];

  constructor(
    private readonly transport: OllamaTransport = new UnconfiguredOllamaTransport(),
    private readonly probedRuntimeVersion: Measurement<string> = { unavailableReason: 'the runtime version was not probed for this execution' },
    private readonly thinkingMode: ThinkingMode = 'disabled',
  ) {}

  async invoke(request: AttemptRequest, candidate: CandidateDescriptor, cancellation: CancellationToken): Promise<Observation> {
    const digest = requestDigest(request);
    const runtimeConfigurationID = configurationID(candidate.runtimeConfiguration);
    const failure = (status: TerminalStatus, code: string, detail: string, identityReason: string): Observation => ({
      toolCallObservationsRaw: [],
      terminalStatus: status,
      providerReportedUsage: { unavailableReason: 'no successful response arrived' },
      timing: {
        totalElapsedMilliseconds: { unavailableReason: 'no runtime-reported duration arrived' },
        firstTokenMilliseconds: { unavailableReason: 'the adapter does not stream' },
      },
      warnings: [],
      errors: [{ code, detail }],
      identityVerification: { state: 'unverifiable', reason: identityReason },
      runtimeConfigurationID,
      requestDigest: digest,
    });

    if (cancellation.isCancelled) return failure('cancelled', 'adapter.cancelled', 'cancellation observed before sending', 'cancelled before sending');

    const messages: OllamaChatMessage[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
    const warnings: string[] = [];
    if (request.syntheticContext !== undefined) {
      warnings.push('ollama boundary has no context field; synthetic context carried as a labeled system message');
      messages.push({ role: 'system', content: `Context for this evaluation (synthetic fixture): ${request.syntheticContext}` });
    }
    const declared = configurationValue(candidate.runtimeConfiguration, OLLAMA_THINKING_MODE_KEY);
    if (declared !== undefined && declared !== this.thinkingMode && ['disabled', 'enabled', 'runtimeDefault'].includes(declared)) {
      warnings.push(`the candidate's runtime configuration declares thinking mode '${declared}' but this execution sent '${this.thinkingMode}'`);
    }

    const chatRequest: OllamaChatRequest = {
      model: candidate.exactModelIdentity,
      messages,
      temperatureMilli: request.generationSettings.temperatureMilli,
      topPMilli: request.generationSettings.topPMilli,
      maxOutputTokens: request.generationSettings.maxOutputTokens,
      seed: request.generationSettings.seed,
      stopSequences: request.generationSettings.stopSequences,
      requireJSONFormat: request.responseFormat === 'json',
      timeoutMilliseconds: request.executionBudgetMilliseconds,
      thinkingMode: this.thinkingMode,
    };

    let report: OllamaChatReport;
    try {
      report = await this.transport.chat(chatRequest, cancellation);
    } catch (error) {
      if (error instanceof OllamaTransportFailure) {
        switch (error.kind) {
          case 'notConfigured':
            return failure('candidateUnavailable', 'adapter.notConfigured', 'no live Ollama transport is configured; the core lab constructs none', 'no transport was configured');
          case 'connectionFailed':
            return failure('candidateUnavailable', 'ollama.connectionFailed', error.detail, 'the runtime was unreachable');
          case 'timeout':
            return failure('timedOut', 'ollama.timeout', `execution budget of ${request.executionBudgetMilliseconds}ms elapsed`, 'no response arrived before the budget elapsed');
          case 'cancelled':
            return failure('cancelled', 'adapter.cancelled', 'cancellation observed mid-flight; the request was abandoned', 'cancelled mid-flight');
          case 'modelNotFound':
            return failure('candidateUnavailable', 'ollama.modelNotFound', `the runtime has no installed model '${error.model ?? 'unreported'}'; the lab never downloads`, 'the runtime has no such model');
          case 'httpFailure':
            return failure('failed', 'ollama.httpFailure', `status ${error.status ?? 0}: ${error.detail}`, 'the runtime reported a failure');
          case 'malformedResponse':
            return failure('failed', 'ollama.malformedResponse', error.detail, "the runtime's response did not decode");
        }
      }
      return failure('failed', 'ollama.unknownFailure', error instanceof Error ? error.message : String(error), 'the transport failed before reporting identity');
    }

    const identity: Observation['identityVerification'] = report.model === candidate.exactModelIdentity
      ? { state: 'verifiedMatch', reported: report.model }
      : { state: 'mismatch', reported: report.model, declared: candidate.exactModelIdentity };

    const usage: Measurement<{ promptTokens: number; completionTokens: number }> =
      report.promptEvalCount !== undefined && report.evalCount !== undefined
        ? { measured: { promptTokens: report.promptEvalCount, completionTokens: report.evalCount } }
        : { unavailableReason: 'the runtime did not report both token counts' };
    const ms = (value: number | undefined): Measurement<number> =>
      value === undefined ? { unavailableReason: 'the runtime did not report this duration' } : { measured: Math.trunc(value / 1_000_000) };

    let modelMemory: Measurement<number> = { unavailableReason: "the runtime's process listing did not include this model" };
    try {
      const running = await this.transport.runningModels();
      const row = running.find((r) => r.name === report.model);
      if (row) {
        if (row.sizeVRAMBytes !== undefined) modelMemory = { measured: row.sizeVRAMBytes };
        else if (row.sizeBytes !== undefined) modelMemory = { measured: row.sizeBytes };
      }
    } catch (error) {
      modelMemory = { unavailableReason: `the runtime's process listing could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }

    const telemetry: RuntimeTelemetry = {
      runtimeName: 'ollama',
      runtimeVersion: this.probedRuntimeVersion,
      loadDurationMilliseconds: ms(report.loadDurationNanoseconds),
      promptEvalDurationMilliseconds: ms(report.promptEvalDurationNanoseconds),
      evalDurationMilliseconds: ms(report.evalDurationNanoseconds),
      tokensPerSecondMilli: derivedTokensPerSecondMilli(
        report.evalCount !== undefined ? { measured: report.evalCount } : { unavailableReason: 'the runtime reported no completion token count' },
        report.evalDurationNanoseconds !== undefined ? { measured: report.evalDurationNanoseconds } : { unavailableReason: 'the runtime reported no evaluation duration' }),
      runtimeReportedContextLimitTokens: candidate.declaredContextLimitTokens,
      modelMemoryBytes: modelMemory,
      doneReason: report.doneReason !== undefined ? { measured: report.doneReason } : { unavailableReason: 'the runtime reported no done reason' },
      thinkingMode: { measured: this.thinkingMode },
      thinkingTraceCharacterCount: report.thinkingTrace !== undefined
        ? { measured: Array.from(report.thinkingTrace).length }
        : { unavailableReason: 'the runtime reported no reasoning separate from the answer' },
    };

    if (report.thinkingTrace !== undefined) {
      warnings.push(`the runtime reported ${Array.from(report.thinkingTrace).length} characters of reasoning separately from the `
        + `answer under thinking mode '${this.thinkingMode}'; only the final answer is evaluated, and the lab preserves no reasoning as evidence`);
      if (report.doneReason === 'length') {
        warnings.push("the runtime stopped at the output token limit (done reason 'length') after producing that reasoning; the case's output budget was consumed before the answer — this attempt measures a truncated generation, not the model's answer");
      }
    }

    let terminalStatus: TerminalStatus = 'completed';
    const errors: { code: string; detail: string }[] = [];
    let outputText: string | undefined = report.content;
    let structuredRaw: string | undefined;
    if (request.responseFormat === 'json') {
      if (parseJSONContainer(report.content) !== undefined) structuredRaw = report.content;
      else {
        terminalStatus = 'malformedOutput';
        errors.push({ code: 'output.notJSON', detail: 'requested JSON; reply is not parseable JSON' });
      }
    }
    if (report.content.length === 0) {
      outputText = undefined;
      if (terminalStatus === 'completed') {
        terminalStatus = 'failed';
        errors.push({ code: 'ollama.emptyReply', detail: report.thinkingTrace === undefined
          ? 'the runtime returned an empty reply'
          : 'the runtime returned an empty reply: it reported reasoning but no final answer' });
      }
    }

    return {
      outputText,
      structuredOutputRaw: structuredRaw,
      toolCallObservationsRaw: [],
      terminalStatus,
      providerReportedUsage: usage,
      timing: {
        totalElapsedMilliseconds: ms(report.totalDurationNanoseconds),
        firstTokenMilliseconds: { unavailableReason: 'the adapter does not stream; no first-token instant is reported' },
      },
      warnings,
      errors,
      identityVerification: identity,
      runtimeConfigurationID,
      requestDigest: digest,
      runtimeTelemetry: telemetry,
    };
  }
}
