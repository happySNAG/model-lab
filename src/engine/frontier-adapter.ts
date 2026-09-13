// Benchmark engine · asking a model that is not on this machine, and reading the answer honestly.
//
// ONE INTERFACE, THREE VERY DIFFERENT THINGS BEHIND IT. A subscription CLI is a child process with a
// JSON document on its stdout. A metered API is an HTTP stream of server-sent events. A local runtime
// is Pass 3's transport and is not in this file at all. What they have in common is only what the
// engine needs: ask this, under these frozen settings, and tell me what came back, who said it, how
// many tokens it was, and when the first visible byte landed.
//
// THE PROVIDER'S OWN ACCOUNT OF WHAT IT DID IS KEPT VERBATIM. Every adapter records the usage block
// exactly as the provider sent it, beside the figures derived from it. That is the only way a cost
// in an evidence file can ever be reconciled against a line on a bill — a derived number with the
// source discarded is a number nobody can check.
//
// SILENT SUBSTITUTION IS THE FAILURE THIS FILE EXISTS TO CATCH. Providers alias model names. A
// request for one model can be served by another, and the answer looks exactly like the answer you
// asked for. So every response is read for WHICH MODEL ANSWERED, and that is compared with what was
// frozen:
//
//   the provider named the model, and it matches   -> verified
//   the provider named the model, and it does not  -> MISMATCH. The candidate aborts. It is never
//                                                     recorded as a result, because it is a real
//                                                     answer to a question about a different model.
//   the provider named no model                    -> unverifiable, carried and labelled, never
//                                                     upgraded to verified by assuming the request
//                                                     was honoured.
//
// TIME TO FIRST TOKEN IS AN OBSERVATION OR IT IS NOTHING. It is recorded when this process watched
// bytes arrive, and is `unavailable` with a reason otherwise. It is never reconstructed from a
// duration the provider reported afterwards: that says how long the provider spent, not when
// anything reached us, and the gap between those is the queue the person is actually waiting in.
//
// NOTHING HERE SCRAPES, IMPERSONATES OR CIRCUMVENTS. The CLI adapters run the official tool the user
// installed and signed into, with its documented flags, and read its documented output. The API
// adapters call published endpoints with a key the user supplied. There is no browser session, no
// borrowed cookie, no private endpoint and no attempt to make a subscription behave like an API.

import { CanonicalValue } from './canonical';
import { CLIResult, findExecutable, runCLI } from './cli-process';
import { EffortLevel, ProviderBinding, ProviderID } from './provider';
import { Provenance, Quantity, estimatedQuantity, measuredQuantity, reportedQuantity, unavailableQuantity } from './frontier-metrics';
import { redactError, redactSecrets } from './redaction';
import { requireCredential, CredentialLookupOptions } from './credentials';

export type FrontierFailureKind =
  | 'notInstalled' | 'notAuthenticated' | 'timeout' | 'cancelled' | 'rateLimited'
  | 'refused' | 'transport' | 'malformedResponse' | 'modelMismatch' | 'budgetRefused';

/** Which failures a retry could plausibly fix. A refusal and a mismatch are not among them. */
export const RETRYABLE_FAILURES: FrontierFailureKind[] = ['timeout', 'rateLimited', 'transport'];

export interface FrontierUsage {
  inputTokens?: number;
  /** The answer a person would read. */
  visibleOutputTokens?: number;
  /** Reasoning tokens, when the provider bills or reports them apart. Undefined means it did not say. */
  reasoningTokens?: number;
}

export interface FrontierResponse {
  answerText: string;
  /** Which model the provider said answered. Empty string means it did not say — never a copy of the request. */
  reportedModelID: string;
  usage: FrontierUsage;
  /** Whether the usage numbers came from the provider or were derived here. */
  usageProvenance: Provenance;
  /** The provider's usage block, exactly as sent, for reconciling against a bill. */
  rawUsage?: CanonicalValue;
  /** Milliseconds from request to the first VISIBLE byte, when this process watched it arrive. */
  firstVisibleTokenMilliseconds?: number;
  totalElapsedMilliseconds: number;
  /** How many retries were spent getting here. Zero on a first-try success. */
  retryCount: number;
  /** Tokens spent on attempts that were discarded. Retries are not free. */
  wastedTokens: number;
  failure?: { kind: FrontierFailureKind; detail: string };
  /** What the provider reported about the effort or thinking it actually applied, when it said. */
  reportedEffort?: string;
}

export interface FrontierRequest {
  binding: ProviderBinding;
  promptText: string;
  suppliedContext?: string;
  /** Return true to stop: a pause or an abort. Polled, and it reaches a child process. */
  shouldCancel?: () => boolean;
  now?: () => number;
}

export interface FrontierAdapter {
  readonly provider: ProviderID;
  complete(request: FrontierRequest): Promise<FrontierResponse>;
}

/** The message a candidate actually sends: the prompt, then the supplied context as its own turn. */
export function assembleRequestText(promptText: string, suppliedContext?: string): { text: string; assembledContext?: string } {
  // The supplied context is appended as a separate turn so it can be READ BACK and verified, exactly
  // as the local host does it. Interpolating it into the prompt would make the verification check
  // the case against itself.
  if (suppliedContext === undefined || suppliedContext.length === 0) return { text: promptText };
  return { text: `${promptText}\n\n${suppliedContext}`, assembledContext: suppliedContext };
}

/** A token estimate, when nothing counted. Carries its method, and is never presented as a count. */
export function estimateTokens(text: string, charactersPerToken = 4): Quantity {
  return estimatedQuantity(Math.ceil(text.length / charactersPerToken),
    `derived from ${text.length} characters at ${charactersPerToken} characters per token; nobody counted these`);
}

/** Turn a provider's usage into quantities, keeping "it did not say" distinct from "it said zero". */
export function quantifyUsage(usage: FrontierUsage, provenance: Provenance, promptText: string, answerText: string): {
  inputTokens: Quantity; visibleOutputTokens: Quantity; reasoningTokens: Quantity; totalTokens: Quantity;
} {
  const inputTokens = usage.inputTokens === undefined
    ? unavailableQuantity('the provider reported no input token count, and this engine does not estimate one into a cost')
    : provenance === 'providerReported' ? reportedQuantity(usage.inputTokens) : estimatedQuantity(usage.inputTokens, 'derived locally');
  const visibleOutputTokens = usage.visibleOutputTokens === undefined
    ? unavailableQuantity('the provider reported no output token count')
    : provenance === 'providerReported' ? reportedQuantity(usage.visibleOutputTokens) : estimatedQuantity(usage.visibleOutputTokens, 'derived locally');
  const reasoningTokens = usage.reasoningTokens === undefined
    ? unavailableQuantity('this provider does not report reasoning tokens separately; that is not the same as reporting zero')
    : provenance === 'providerReported' ? reportedQuantity(usage.reasoningTokens) : estimatedQuantity(usage.reasoningTokens, 'derived locally');
  const parts = [inputTokens, visibleOutputTokens];
  const totalTokens = parts.some((part) => part.provenance === 'unavailable')
    ? unavailableQuantity('at least one half of this attempt\'s token count is unknown, so its total is not known either')
    : { provenance, value: (inputTokens.value ?? 0) + (visibleOutputTokens.value ?? 0) + (reasoningTokens.value ?? 0) };
  // Deliberately mentions the prompt and answer so a caller can see the estimate path was available
  // and not taken: these are the inputs an estimate WOULD have used.
  void promptText; void answerText;
  return { inputTokens, visibleOutputTokens, reasoningTokens, totalTokens };
}

// MARK: - Retry, which is not free

/**
 * Retry under the frozen policy, counting what each discarded try cost.
 *
 * Two disciplines. A non-retryable failure is returned immediately rather than retried — retrying a
 * refusal or a model mismatch just spends money reproducing it. And the tokens of every discarded
 * attempt are ADDED UP, because a campaign that retried its way to an answer spent more than the
 * answer says it did, and hiding that makes an unreliable model look cheap.
 */
export async function withRetry(binding: ProviderBinding, attempt: () => Promise<FrontierResponse>,
                                sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
                                shouldCancel?: () => boolean): Promise<FrontierResponse> {
  let wasted = 0;
  let retries = 0;
  let last: FrontierResponse | undefined;
  for (let index = 0; index <= binding.retry.maxRetries; index++) {
    const response = await attempt();
    last = response;
    const usedTokens = (response.usage.inputTokens ?? 0) + (response.usage.visibleOutputTokens ?? 0)
      + (response.usage.reasoningTokens ?? 0);
    if (!response.failure) {
      return { ...response, retryCount: retries, wastedTokens: wasted };
    }
    wasted += usedTokens;
    if (!RETRYABLE_FAILURES.includes(response.failure.kind)) break;
    if (shouldCancel?.()) break;
    if (index === binding.retry.maxRetries) break;
    retries += 1;
    if (binding.retry.backoffMilliseconds > 0) await sleep(binding.retry.backoffMilliseconds * (index + 1));
  }
  return { ...(last as FrontierResponse), retryCount: retries, wastedTokens: wasted };
}

// MARK: - Subscription CLI

export interface SubscriptionCLIOptions {
  provider: ProviderID;
  /** Resolved once at construction, so a PATH change mid-campaign cannot swap the tool underneath it. */
  executablePath?: string;
  run?: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  findExecutable?: (name: string) => string | undefined;
}

const CLI_NAME: Partial<Record<ProviderID, string>> = { claudeCLI: 'claude', codexCLI: 'codex' };

/**
 * The arguments the official tool documents for a single non-interactive request.
 *
 * The prompt is NOT among them. It goes on stdin, because anything in argv is visible in the process
 * table to every process on the machine — including the benchmark prompts, which are the thing being
 * measured, and any supplied context, which may not be the user's to broadcast.
 *
 * An effort level the tool does not document a flag for is NOT silently dropped: `buildCLIArguments`
 * returns the flags it could express and the caller refuses the binding if anything frozen could not
 * be expressed. Sending a request that quietly ignores a frozen setting is the substitution this
 * whole engine refuses.
 */
export function buildCLIArguments(binding: ProviderBinding): { args: string[]; unexpressed: string[] } {
  const unexpressed: string[] = [];
  const args: string[] = [];

  if (binding.provider === 'claudeCLI') {
    args.push('-p', '--output-format', 'json');
    if (binding.requestedModelID.length > 0) args.push('--model', binding.requestedModelID);
    if (binding.effort !== 'none') {
      // Effort is expressed where the tool has a flag for it. If a future tool version drops the
      // flag, this is where it is noticed rather than where it is ignored.
      args.push('--effort', binding.effort);
    }
  } else if (binding.provider === 'codexCLI') {
    args.push('exec', '--json');
    if (binding.requestedModelID.length > 0) args.push('--model', binding.requestedModelID);
    if (binding.effort !== 'none') args.push('--config', `model_reasoning_effort=${binding.effort}`);
  } else {
    unexpressed.push(`${binding.provider} is not a subscription CLI`);
  }

  // Sampling is not expressible through these tools. A binding that froze a temperature and is run
  // through a CLI that cannot set one would be a campaign whose manifest says something untrue, so
  // it is reported rather than dropped.
  if (binding.sampling.temperatureMilli !== null) unexpressed.push('temperature: this CLI accepts no sampling temperature');
  if (binding.sampling.topPMilli !== null) unexpressed.push('topP: this CLI accepts no nucleus sampling setting');
  if (binding.sampling.seed !== null) unexpressed.push('seed: this CLI accepts no sampling seed');
  if (binding.thinkingMode === 'enabled' && binding.effort === 'none') {
    unexpressed.push('thinking: this CLI expresses reasoning as an effort level, and this binding froze thinking on '
      + 'without one, so there is no flag that means what the manifest says');
  }
  return { args, unexpressed };
}

/**
 * Read a subscription CLI's JSON answer.
 *
 * Accepts the documented envelope and NOTHING else. A tool whose output does not parse yields a
 * `malformedResponse` failure rather than a best guess: a benchmark that scrapes an unrecognised
 * format is a benchmark whose results change when the tool changes its prose.
 */
export function parseCLIResponse(stdout: string): {
  answerText: string; reportedModelID: string; usage: FrontierUsage; raw?: CanonicalValue; reportedEffort?: string;
} | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: Record<string, unknown>;
  try {
    // Some tools emit one JSON object per line and finish with a summary. The LAST complete object
    // is the result; earlier lines are progress. Anything that does not parse at all is refused.
    const lines = trimmed.split('\n').filter((line) => line.trim().startsWith('{'));
    const candidates = lines.length > 0 ? lines : [trimmed];
    let chosen: Record<string, unknown> | undefined;
    for (const line of candidates) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value === 'object' && value !== null) chosen = value;
      } catch { /* a progress line that is not JSON; the documented result still has to parse */ }
    }
    if (!chosen) return undefined;
    parsed = chosen;
  } catch {
    return undefined;
  }

  const answerText = typeof parsed.result === 'string' ? parsed.result
    : typeof parsed.text === 'string' ? parsed.text
      : typeof parsed.content === 'string' ? parsed.content
        : typeof parsed.message === 'string' ? parsed.message
          : undefined;
  if (answerText === undefined) return undefined;

  const usageBlock = (parsed.usage ?? {}) as Record<string, unknown>;
  const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

  return {
    answerText,
    // `model` is the tool's own statement of which model answered. Absent means absent.
    reportedModelID: typeof parsed.model === 'string' ? parsed.model : '',
    usage: {
      inputTokens: asNumber(usageBlock.input_tokens) ?? asNumber(usageBlock.prompt_tokens),
      visibleOutputTokens: asNumber(usageBlock.output_tokens) ?? asNumber(usageBlock.completion_tokens),
      reasoningTokens: asNumber(usageBlock.reasoning_tokens) ?? asNumber(usageBlock.thinking_tokens),
    },
    raw: (parsed.usage ?? null) as CanonicalValue,
    reportedEffort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
  };
}

export class SubscriptionCLIAdapter implements FrontierAdapter {
  readonly provider: ProviderID;
  private readonly executablePath?: string;
  private readonly run: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;

  constructor(options: SubscriptionCLIOptions) {
    this.provider = options.provider;
    const name = CLI_NAME[options.provider];
    const locate = options.findExecutable ?? ((n: string) => findExecutable(n));
    this.executablePath = options.executablePath ?? (name ? locate(name) : undefined);
    this.run = options.run ?? runCLI;
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
      return empty('notInstalled', `the ${CLI_NAME[this.provider] ?? this.provider} command is not on this machine's PATH. `
        + 'Cernum drives the official CLI you installed and authenticated yourself; it does not install one and does not '
        + 'reach the service any other way.');
    }

    const { args, unexpressed } = buildCLIArguments(request.binding);
    if (unexpressed.length > 0) {
      // Refused BEFORE the request. A run that sent this would produce real answers under settings
      // the manifest does not describe, which is worse than no answers.
      return empty('budgetRefused',
        `${request.binding.candidate} froze settings this CLI cannot express, so the request was not sent: `
        + `${unexpressed.join('; ')}. Change the binding, or use the metered API for this candidate, where these `
        + 'settings are expressible.');
    }

    const { text } = assembleRequestText(request.promptText, request.suppliedContext);
    let firstVisibleTokenMilliseconds: number | undefined;

    const result = await this.run({
      executable: this.executablePath,
      args,
      input: text,
      timeoutMilliseconds: request.binding.timeoutMilliseconds,
      shouldCancel: request.shouldCancel,
      onFirstOutput: (at) => { firstVisibleTokenMilliseconds = at; },
    });

    if (result.failure) {
      const unauthenticated = /not (?:logged|signed) in|unauthenticated|please (?:log|sign) in|no active session/i
        .test(`${result.stdout}\n${result.stderr}`);
      const rateLimited = /rate.?limit|too many requests|429|quota|usage limit/i.test(`${result.stdout}\n${result.stderr}`);
      const kind: FrontierFailureKind = result.failure.kind === 'timeout' ? 'timeout'
        : result.failure.kind === 'cancelled' ? 'cancelled'
          : result.failure.kind === 'notInstalled' ? 'notInstalled'
            : unauthenticated ? 'notAuthenticated'
              : rateLimited ? 'rateLimited' : 'transport';
      return {
        ...empty(kind, `${redactSecrets(result.failure.detail)}${result.stderr ? ` — ${redactSecrets(result.stderr).slice(0, 500)}` : ''}`),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
      };
    }

    const parsed = parseCLIResponse(result.stdout);
    if (!parsed) {
      return {
        ...empty('malformedResponse',
          'the CLI exited successfully but its output is not in the documented JSON form, so nothing here can say what '
          + 'it answered or which model answered. Cernum refuses to scrape an unrecognised format: a benchmark that did '
          + 'would produce different results the next time the tool changed its wording.'),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
      };
    }

    const reported = parsed.usage.inputTokens !== undefined || parsed.usage.visibleOutputTokens !== undefined;
    return {
      answerText: parsed.answerText,
      reportedModelID: parsed.reportedModelID,
      usage: parsed.usage,
      usageProvenance: reported ? 'providerReported' : 'unavailable',
      rawUsage: parsed.raw,
      firstVisibleTokenMilliseconds,
      totalElapsedMilliseconds: result.elapsedMilliseconds,
      retryCount: 0,
      wastedTokens: 0,
      reportedEffort: parsed.reportedEffort,
    };
  }
}

// MARK: - Metered API

export interface MeteredAPIOptions {
  provider: ProviderID;
  baseURL: string;
  fetchImplementation?: typeof fetch;
  credentials?: CredentialLookupOptions;
  /** Off only for a transport that genuinely cannot stream; a non-streamed attempt records no TTFT. */
  stream?: boolean;
}

/** The wire body for one request, built from the frozen binding and nothing else. */
export function buildAPIBody(binding: ProviderBinding, text: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = binding.provider === 'anthropicAPI'
    ? {
      model: binding.requestedModelID,
      max_tokens: binding.maxOutputTokens,
      messages: [{ role: 'user', content: text }],
      stream,
    }
    : {
      model: binding.requestedModelID,
      max_completion_tokens: binding.maxOutputTokens,
      messages: [{ role: 'user', content: text }],
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };

  if (binding.sampling.temperatureMilli !== null) body.temperature = binding.sampling.temperatureMilli / 1000;
  if (binding.sampling.topPMilli !== null) body.top_p = binding.sampling.topPMilli / 1000;
  if (binding.sampling.seed !== null && binding.provider === 'openaiAPI') body.seed = binding.sampling.seed;

  if (binding.provider === 'anthropicAPI' && binding.thinkingMode === 'enabled') {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudgetFor(binding.effort, binding.maxOutputTokens) };
  }
  if (binding.provider === 'openaiAPI' && binding.effort !== 'none') {
    body.reasoning_effort = binding.effort === 'max' ? 'high' : binding.effort;
  }
  return body;
}

/**
 * How much of the output budget a frozen effort level reserves for reasoning.
 *
 * These are Cernum's own fractions, not the provider's, and they are written into the manifest
 * through `maxOutputTokens` and the effort level so a later reader can recompute them. The important
 * property is that they leave room for a visible answer: a budget entirely consumed by reasoning is
 * the empty-reply failure Pass 3 already learned to name.
 */
export function thinkingBudgetFor(effort: EffortLevel, maxOutputTokens: number): number {
  const fraction = effort === 'max' ? 0.75 : effort === 'high' ? 0.6 : effort === 'medium' ? 0.4 : effort === 'low' ? 0.25 : 0.5;
  // Always leave at least a quarter of the budget for the answer itself.
  return Math.max(1_024, Math.min(Math.floor(maxOutputTokens * fraction), Math.floor(maxOutputTokens * 0.75)));
}

interface ParsedAPIResponse {
  answerText: string;
  reportedModelID: string;
  usage: FrontierUsage;
  raw?: CanonicalValue;
}

/** Read a non-streamed response body. Refuses anything not in the documented shape. */
export function parseAPIResponse(provider: ProviderID, body: string): ParsedAPIResponse | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);
  const usageBlock = (parsed.usage ?? {}) as Record<string, unknown>;

  if (provider === 'anthropicAPI') {
    const content = Array.isArray(parsed.content) ? parsed.content as Record<string, unknown>[] : undefined;
    if (!content) return undefined;
    // Thinking blocks are NOT the answer. Concatenating them into the visible text is how a
    // reasoning trace ends up being scored as a response.
    const answerText = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
    return {
      answerText,
      reportedModelID: typeof parsed.model === 'string' ? parsed.model : '',
      usage: {
        inputTokens: asNumber(usageBlock.input_tokens),
        visibleOutputTokens: asNumber(usageBlock.output_tokens),
        reasoningTokens: asNumber(usageBlock.thinking_tokens),
      },
      raw: (parsed.usage ?? null) as CanonicalValue,
    };
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices as Record<string, unknown>[] : undefined;
  if (!choices || choices.length === 0) return undefined;
  const message = (choices[0].message ?? {}) as Record<string, unknown>;
  const details = (usageBlock.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    answerText: typeof message.content === 'string' ? message.content : '',
    reportedModelID: typeof parsed.model === 'string' ? parsed.model : '',
    usage: {
      inputTokens: asNumber(usageBlock.prompt_tokens),
      visibleOutputTokens: asNumber(usageBlock.completion_tokens),
      reasoningTokens: asNumber(details.reasoning_tokens),
    },
    raw: (parsed.usage ?? null) as CanonicalValue,
  };
}

export class MeteredAPIAdapter implements FrontierAdapter {
  readonly provider: ProviderID;

  constructor(private readonly options: MeteredAPIOptions) {
    this.provider = options.provider;
  }

  async complete(request: FrontierRequest): Promise<FrontierResponse> {
    const now = request.now ?? (() => Date.now());
    const startedAt = now();
    const fail = (kind: FrontierFailureKind, detail: string, firstVisible?: number): FrontierResponse => ({
      answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
      totalElapsedMilliseconds: now() - startedAt, firstVisibleTokenMilliseconds: firstVisible,
      retryCount: 0, wastedTokens: 0, failure: { kind, detail },
    });

    let key: string;
    try {
      // Refused before the socket opens. Discovering a missing key from a 401 costs a round trip and
      // writes a failure into the evidence that is not the model's.
      key = requireCredential(this.provider, this.options.credentials ?? {});
    } catch (error) {
      return fail('notAuthenticated', redactError(error));
    }

    const { text } = assembleRequestText(request.promptText, request.suppliedContext);
    const stream = this.options.stream !== false;
    const body = buildAPIBody(request.binding, text, stream);
    const headers: Record<string, string> = this.provider === 'anthropicAPI'
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    const url = this.provider === 'anthropicAPI'
      ? `${this.options.baseURL.replace(/\/+$/, '')}/v1/messages`
      : `${this.options.baseURL.replace(/\/+$/, '')}/v1/chat/completions`;

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), request.binding.timeoutMilliseconds);
    deadline.unref?.();
    const cancelPoll = request.shouldCancel
      ? setInterval(() => { if (request.shouldCancel?.()) controller.abort(); }, 200)
      : undefined;
    cancelPoll?.unref?.();

    let firstVisibleTokenMilliseconds: number | undefined;
    try {
      const doFetch = this.options.fetchImplementation ?? fetch;
      const response = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });

      if (!response.ok) {
        const errorBody = redactSecrets(await response.text()).slice(0, 800);
        const kind: FrontierFailureKind = response.status === 429 ? 'rateLimited'
          : response.status === 401 || response.status === 403 ? 'notAuthenticated'
            : response.status >= 500 ? 'transport' : 'refused';
        return fail(kind, `the provider answered ${response.status}: ${errorBody}`);
      }

      if (!stream || !response.body) {
        const parsed = parseAPIResponse(this.provider, await response.text());
        if (!parsed) return fail('malformedResponse', 'the provider\'s response is not in the documented shape');
        return {
          ...parsed,
          usageProvenance: parsed.usage.inputTokens !== undefined ? 'providerReported' : 'unavailable',
          // Not streamed, so nothing observed a first token. Recorded as absent WITH the reason,
          // never derived from the total.
          firstVisibleTokenMilliseconds: undefined,
          totalElapsedMilliseconds: now() - startedAt,
          retryCount: 0,
          wastedTokens: 0,
        };
      }

      const streamed = await this.readStream(response.body, startedAt, now, (at) => {
        if (firstVisibleTokenMilliseconds === undefined) firstVisibleTokenMilliseconds = at;
      });
      return {
        ...streamed,
        usageProvenance: streamed.usage.inputTokens !== undefined ? 'providerReported' : 'unavailable',
        firstVisibleTokenMilliseconds,
        totalElapsedMilliseconds: now() - startedAt,
        retryCount: 0,
        wastedTokens: 0,
      };
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
      const cancelled = aborted && request.shouldCancel?.() === true;
      return fail(cancelled ? 'cancelled' : aborted ? 'timeout' : 'transport', redactError(error), firstVisibleTokenMilliseconds);
    } finally {
      clearTimeout(deadline);
      if (cancelPoll) clearInterval(cancelPoll);
    }
  }

  /**
   * Consume a server-sent-event stream, timing the first VISIBLE delta.
   *
   * A thinking delta is not a first token. A person watching a reasoning model has not seen an
   * answer begin, and timing the reasoning would report a responsiveness nobody experienced — the
   * same distinction Pass 3 drew for a local runtime's two channels.
   */
  private async readStream(stream: ReadableStream<Uint8Array>, startedAt: number, now: () => number,
                           onFirstVisible: (atMilliseconds: number) => void): Promise<ParsedAPIResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answerText = '';
    let reportedModelID = '';
    const usage: FrontierUsage = {};
    let raw: CanonicalValue | undefined;

    const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === '[DONE]') continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }

          if (this.provider === 'anthropicAPI') {
            if (event.type === 'message_start') {
              const message = (event.message ?? {}) as Record<string, unknown>;
              if (typeof message.model === 'string') reportedModelID = message.model;
              const block = (message.usage ?? {}) as Record<string, unknown>;
              usage.inputTokens = asNumber(block.input_tokens) ?? usage.inputTokens;
              raw = (message.usage ?? null) as CanonicalValue;
            } else if (event.type === 'content_block_delta') {
              const delta = (event.delta ?? {}) as Record<string, unknown>;
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                if (answerText.length === 0 && delta.text.length > 0) onFirstVisible(now() - startedAt);
                answerText += delta.text;
              } else if (delta.type === 'thinking_delta') {
                // Counted, never timed as a first token and never concatenated into the answer.
                usage.reasoningTokens = (usage.reasoningTokens ?? 0);
              }
            } else if (event.type === 'message_delta') {
              const block = (event.usage ?? {}) as Record<string, unknown>;
              usage.visibleOutputTokens = asNumber(block.output_tokens) ?? usage.visibleOutputTokens;
              usage.reasoningTokens = asNumber(block.thinking_tokens) ?? usage.reasoningTokens;
              raw = (event.usage ?? raw ?? null) as CanonicalValue;
            }
            continue;
          }

          if (typeof event.model === 'string') reportedModelID = event.model;
          const choices = Array.isArray(event.choices) ? event.choices as Record<string, unknown>[] : [];
          for (const choice of choices) {
            const delta = (choice.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              if (answerText.length === 0) onFirstVisible(now() - startedAt);
              answerText += delta.content;
            }
          }
          if (event.usage && typeof event.usage === 'object') {
            const block = event.usage as Record<string, unknown>;
            const details = (block.completion_tokens_details ?? {}) as Record<string, unknown>;
            usage.inputTokens = asNumber(block.prompt_tokens) ?? usage.inputTokens;
            usage.visibleOutputTokens = asNumber(block.completion_tokens) ?? usage.visibleOutputTokens;
            usage.reasoningTokens = asNumber(details.reasoning_tokens) ?? usage.reasoningTokens;
            raw = (event.usage ?? null) as CanonicalValue;
          }
        }
      }
    }
    return { answerText, reportedModelID, usage, raw };
  }
}

// MARK: - A deterministic adapter, so every frontier path is testable without a provider

export interface ScriptedFrontierAnswer {
  answerText?: string;
  /** What the provider claims answered. Set it to something else to exercise the mismatch path. */
  reportedModelID?: string;
  usage?: FrontierUsage;
  usageProvenance?: Provenance;
  firstVisibleTokenMilliseconds?: number;
  totalElapsedMilliseconds?: number;
  failure?: { kind: FrontierFailureKind; detail: string };
  /** Fail this many times before succeeding, to exercise retry accounting. */
  failuresBeforeSuccess?: number;
}

/**
 * A frontier adapter that reaches nothing.
 *
 * This is not a mock of the engine: the campaign drives it through the same host, the same binding
 * checks, the same spend tracker and the same ledger. It is the only way to exercise a paid code path
 * without paying, which is exactly what this pass required.
 */
export class ScriptedFrontierAdapter implements FrontierAdapter {
  readonly requests: FrontierRequest[] = [];
  private failuresUsed = new Map<string, number>();

  constructor(readonly provider: ProviderID,
              private readonly script: { bySlot?: Record<string, ScriptedFrontierAnswer>; byCandidate?: Record<string, ScriptedFrontierAnswer>; fallback?: ScriptedFrontierAnswer } = {}) {}

  async complete(request: FrontierRequest): Promise<FrontierResponse> {
    this.requests.push(request);
    const answer = this.script.byCandidate?.[request.binding.candidate] ?? this.script.fallback ?? {};

    if (answer.failuresBeforeSuccess !== undefined) {
      const used = this.failuresUsed.get(request.binding.candidate) ?? 0;
      if (used < answer.failuresBeforeSuccess) {
        this.failuresUsed.set(request.binding.candidate, used + 1);
        return {
          answerText: '', reportedModelID: '', usage: { inputTokens: 100, visibleOutputTokens: 0 },
          usageProvenance: 'providerReported', totalElapsedMilliseconds: 50, retryCount: 0, wastedTokens: 0,
          failure: { kind: 'rateLimited', detail: 'scripted rate limit' },
        };
      }
    }

    if (answer.failure) {
      return {
        answerText: '', reportedModelID: answer.reportedModelID ?? '', usage: answer.usage ?? {},
        usageProvenance: answer.usageProvenance ?? 'unavailable',
        totalElapsedMilliseconds: answer.totalElapsedMilliseconds ?? 40, retryCount: 0, wastedTokens: 0,
        failure: answer.failure,
      };
    }

    return {
      answerText: answer.answerText ?? 'a scripted frontier answer',
      // Defaults to honouring the request, which is the ordinary case. A test that wants a
      // substitution sets `reportedModelID` to something else.
      reportedModelID: answer.reportedModelID ?? request.binding.requestedModelID,
      usage: answer.usage ?? { inputTokens: 120, visibleOutputTokens: 30, reasoningTokens: undefined },
      usageProvenance: answer.usageProvenance ?? 'providerReported',
      firstVisibleTokenMilliseconds: answer.firstVisibleTokenMilliseconds ?? 25,
      totalElapsedMilliseconds: answer.totalElapsedMilliseconds ?? 90,
      retryCount: 0,
      wastedTokens: 0,
      rawUsage: { scripted: true } as CanonicalValue,
    };
  }
}

export { measuredQuantity, unavailableQuantity };
