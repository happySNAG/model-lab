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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CanonicalValue } from './canonical';
import { CLIResult, findExecutable, runCLI } from './cli-process';
import {
  CODEX_SERVICE_EFFORT_LEVELS, CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT, buildCodexExecArguments, describeCodexContamination,
  parseCodexExecJSONL,
} from './codex-cli';
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
  /** FRESH input tokens only. Cached input is counted apart, below, and is not included here. */
  inputTokens?: number;
  /**
   * Input tokens written into the provider's prompt cache by this request, and input tokens served
   * from it. Counted apart because they are priced apart — and because leaving them out, as Pass 4B
   * did, understates a Claude Code request's input by two orders of magnitude: a nine-token prompt
   * arrives with a six-thousand-token system prompt behind it.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** The answer a person would read. */
  visibleOutputTokens?: number;
  /** Reasoning tokens, when the provider bills or reports them apart. Undefined means it did not say. */
  reasoningTokens?: number;
}

/** Every input token the provider processed, cached and fresh. Unknown when nothing was reported. */
export function totalInputTokens(usage: FrontierUsage): number | undefined {
  const parts = [usage.inputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens];
  if (parts.every((part) => part === undefined)) return undefined;
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
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
  /**
   * The provider's own list valuation of what this request consumed, in integer microUSD, when it
   * reports one. On a subscription this is NOT a charge: it is the plan allowance spent. Recorded
   * so subscription execution is never reported as free.
   */
  subscriptionIncludedUsageMicroUSD?: number;
  /** Every model identifier the tool said took part in the request, for substitution detection. */
  participatingModelIDs?: string[];
  /**
   * Frozen settings the tool could not ENFORCE, though it was still honest about what it was asked.
   * Distinct from the settings that would have been silently ignored, which refuse the request.
   */
  notEnforceable?: string[];
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
 * The effort levels the installed `claude` CLI documents, read from its own `--help`.
 *
 * Verified against 2.1.251. Anything outside this set is NOT rejected by the tool — it warns and
 * uses the default — so the refusal has to happen here, before the request is sent.
 */
export const CLAUDE_CLI_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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
export function buildCLIArguments(binding: ProviderBinding): { args: string[]; unexpressed: string[]; notEnforceable: string[] } {
  const unexpressed: string[] = [];
  const notEnforceable: string[] = [];
  const args: string[] = [];

  if (binding.provider === 'claudeCLI') {
    args.push('-p', '--output-format', 'json');
    // A benchmark request must not be shaped by whatever happens to be configured on this machine.
    // Settings files, skills, MCP servers and tools all change what the model is asked and what it
    // may do, and none of them are in the manifest — so they are all switched off, explicitly.
    args.push('--tools', '', '--disable-slash-commands', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence');
    if (binding.requestedModelID.length > 0) args.push('--model', binding.requestedModelID);
    if (binding.effort !== 'none') {
      if (!CLAUDE_CLI_EFFORT_LEVELS.includes(binding.effort)) {
        // Refused here rather than sent, because the tool does NOT refuse it: it warns on stderr and
        // answers at its default effort with exit 0. See `detectEffortSubstitution`.
        unexpressed.push(`effort '${binding.effort}': this CLI documents only `
          + `${CLAUDE_CLI_EFFORT_LEVELS.join(', ')}, and silently falls back to its default for anything else`);
      } else {
        args.push('--effort', binding.effort);
      }
    }
    // CORRECTION TO PASS 4B: there is no output-budget flag. `--max-budget-usd` caps DOLLARS and
    // applies to API-key users, not to a subscription session, so a frozen `maxOutputTokens` cannot
    // be applied to the request at all.
    //
    // This is NOT in `unexpressed`, and the difference is deliberate. An unexpressed sampling
    // setting or effort level SILENTLY CHANGES WHAT WAS MEASURED while the manifest claims
    // otherwise, so the request must not be sent. An unenforceable output ceiling changes nothing
    // about what the model was asked; it removes a limit on how much allowance the answer may
    // spend. That is a real risk and it is recorded on every attempt — but refusing on it would
    // make subscription execution impossible rather than honest.
    notEnforceable.push(`maxOutputTokens (${binding.maxOutputTokens}): this CLI has no output-token budget flag, so `
      + 'nothing caps this answer\'s length. The allowance an over-long answer consumes is real and is recorded, but '
      + 'it was not bounded. Use the metered API for this candidate if the ceiling has to hold.');
  } else if (binding.provider === 'codexCLI') {
    // PASS 4B'S CODEX ARGUMENTS WERE NEVER RUN AGAINST A CODEX BINARY, and Pass 5 said so rather
    // than pretending otherwise. They are replaced wholesale by `buildCodexExecArguments`, which is
    // built from `codex exec --help` on the installed 0.154.0 and carries the isolation this tool
    // needs and `claude` does not: Codex is an AGENTIC CLI that will otherwise load the user's
    // plugins, MCP servers and skills into a request the manifest describes as a bare model call.
    //
    // It is not called here, because it needs a freshly created empty working directory that only
    // the adapter can make and clean up. `SubscriptionCLIAdapter.complete` calls it directly, and
    // this branch exists to refuse the settings that must be refused before any of that happens.
    if (binding.effort !== 'none' && !CODEX_SERVICE_EFFORT_LEVELS.includes(binding.effort)) {
      unexpressed.push(`effort '${binding.effort}': the Codex service accepts only `
        + `${CODEX_SERVICE_EFFORT_LEVELS.filter((level) => level !== 'none').join(', ')}`
        + (binding.effort as string === 'ultra' ? `. ${CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT}` : ''));
    }
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
  return { args, unexpressed, notEnforceable };
}

/**
 * What one subscription CLI invocation reported, read out of its documented JSON envelope.
 *
 * PASS 4B GUESSED THIS SHAPE AND GOT IT WRONG IN FIVE PLACES. The corrections, each verified
 * against `claude --output-format json` 2.1.251 rather than assumed:
 *
 *   `model`                   DOES NOT EXIST. Identity is in `modelUsage`, an OBJECT KEYED BY MODEL
 *                             IDENTIFIER, each entry carrying its own `canonicalModel`. Reading
 *                             `parsed.model` yields undefined, which Pass 4B recorded as "the
 *                             provider named no model" — turning a verifiable identity into a
 *                             permanent `unverifiable`.
 *   thinking tokens           are at `usage.output_tokens_details.thinking_tokens`, NOT at
 *                             `usage.reasoning_tokens` or `usage.thinking_tokens`.
 *   cached input              `cache_creation_input_tokens` and `cache_read_input_tokens` exist and
 *                             dominate: a nine-token prompt carried 6,551 cache-creation tokens.
 *                             Pass 4B read neither.
 *   `total_cost_usd`          EXISTS ON SUBSCRIPTION RUNS. Pass 4B assumed subscription execution
 *                             reports no cost at all. It reports a list valuation of the allowance
 *                             consumed, which is not a charge and is not zero.
 *   `subtype`                 is `"success"` EVEN ON A REFUSAL. A 404 for an unknown model returns
 *                             `subtype: "success"`, `is_error: true`, `api_error_status: 404`,
 *                             `terminal_reason: "api_error"`, an EMPTY `modelUsage` — and a `result`
 *                             string containing the error prose. Pass 4B would have scored that
 *                             prose as the model's answer.
 */
export interface ParsedSubscriptionCLIResponse {
  answerText: string;
  /** Every model the tool said took part, in the order the envelope listed them. */
  participants: { modelID: string; canonicalModel: string; outputTokens?: number }[];
  usage: FrontierUsage;
  raw?: CanonicalValue;
  reportedEffort?: string;
  /** The tool's own list valuation of the whole invocation, in integer microUSD, when it gave one. */
  subscriptionIncludedUsageMicroUSD?: number;
  /** The tool's own time to first token, in milliseconds. Its observation, not this process's. */
  providerReportedTimeToFirstTokenMilliseconds?: number;
  /** The tool's own wall clock for the turn. Not a generation duration — see the note below. */
  providerReportedDurationMilliseconds?: number;
  /**
   * `duration_api_ms`. NOT a generation duration and NEVER a divisor for tokens per second: it is a
   * SUM ACROSS CONCURRENT API CALLS and was observed at 1,790 ms inside a 926 ms turn. A throughput
   * computed from it would exceed the speed of the thing it claimed to measure.
   */
  providerReportedAPIDurationMilliseconds?: number;
  /** True when the envelope's own error flags say this invocation did not produce a model answer. */
  isError: boolean;
  apiErrorStatus?: number;
  terminalReason?: string;
}

/**
 * Read a subscription CLI's JSON answer.
 *
 * Accepts the documented envelope and NOTHING else. A tool whose output does not parse yields
 * `undefined` and the caller raises `malformedResponse` rather than a best guess: a benchmark that
 * scrapes an unrecognised format is a benchmark whose results change when the tool changes its prose.
 */
export function parseCLIResponse(stdout: string): ParsedSubscriptionCLIResponse | undefined {
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
  const outputDetails = (usageBlock.output_tokens_details ?? {}) as Record<string, unknown>;
  const asNumber = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

  // `modelUsage` is an object keyed by model identifier. Every key is recorded, because the tool
  // routes some of its own housekeeping to a second model and a reader must be able to see that the
  // model under test was one of several rather than the only one.
  const participants: { modelID: string; canonicalModel: string; outputTokens?: number }[] = [];
  const modelUsage = parsed.modelUsage;
  if (typeof modelUsage === 'object' && modelUsage !== null && !Array.isArray(modelUsage)) {
    for (const [modelID, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
      const row = (entry ?? {}) as Record<string, unknown>;
      participants.push({
        modelID,
        canonicalModel: typeof row.canonicalModel === 'string' ? row.canonicalModel : modelID,
        outputTokens: asNumber(row.outputTokens),
      });
    }
  }

  const costUSD = asNumber2(parsed.total_cost_usd);

  return {
    answerText,
    participants,
    usage: {
      inputTokens: asNumber(usageBlock.input_tokens) ?? asNumber(usageBlock.prompt_tokens),
      cacheCreationInputTokens: asNumber(usageBlock.cache_creation_input_tokens),
      cacheReadInputTokens: asNumber(usageBlock.cache_read_input_tokens),
      visibleOutputTokens: asNumber(usageBlock.output_tokens) ?? asNumber(usageBlock.completion_tokens),
      // The nested path is the real one. The two flat paths are kept only because another tool may
      // use them; neither exists in Claude Code's envelope.
      reasoningTokens: asNumber(outputDetails.thinking_tokens) ?? asNumber(outputDetails.reasoning_tokens)
        ?? asNumber(usageBlock.reasoning_tokens) ?? asNumber(usageBlock.thinking_tokens),
    },
    raw: (parsed.usage ?? null) as CanonicalValue,
    reportedEffort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
    subscriptionIncludedUsageMicroUSD: costUSD === undefined ? undefined : Math.round(costUSD * 1_000_000),
    providerReportedTimeToFirstTokenMilliseconds: asNumber(parsed.ttft_ms) ?? asNumber(parsed.ttft_stream_ms),
    providerReportedDurationMilliseconds: asNumber(parsed.duration_ms),
    providerReportedAPIDurationMilliseconds: asNumber(parsed.duration_api_ms),
    // `is_error` is the flag that matters. `subtype` says "success" on a 404 and cannot be trusted.
    isError: parsed.is_error === true,
    apiErrorStatus: asNumber(parsed.api_error_status),
    terminalReason: typeof parsed.terminal_reason === 'string' ? parsed.terminal_reason : undefined,
  };
}

/** A dollar figure, kept as a float only long enough to be scaled to an integer. */
function asNumber2(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Which model actually answered, decided against what was asked for.
 *
 * The tool names every model that took part, including one it uses for its own housekeeping. A
 * request is honoured when the requested identifier appears among them, by key OR by the
 * `canonicalModel` an entry declares — `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are the
 * same model named two ways, and refusing that would report a substitution that did not happen.
 */
export function resolveAnsweringModel(requestedModelID: string,
                                      participants: { modelID: string; canonicalModel: string; outputTokens?: number }[]):
  { state: 'verified' | 'substituted' | 'unverifiable'; reportedModelID: string; participantIDs: string[] } {
  const participantIDs = participants.map((entry) => entry.modelID);
  if (participants.length === 0) {
    return { state: 'unverifiable', reportedModelID: '', participantIDs };
  }
  // An exact identifier wins over a canonical alias, so `claude-haiku-4-5` is reported back as
  // itself rather than as the dated build that happens to canonicalise to it.
  const match = participants.find((entry) => entry.modelID === requestedModelID)
    ?? participants.find((entry) => entry.canonicalModel === requestedModelID);
  if (match) return { state: 'verified', reportedModelID: match.modelID, participantIDs };
  // Something answered, and it was not what was asked for. The one that produced the most output is
  // named as the answering model; the full list travels with it so nothing is hidden by the choice.
  const loudest = [...participants].sort((a, b) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0];
  return { state: 'substituted', reportedModelID: loudest.modelID, participantIDs };
}

/**
 * The effort level the tool actually applied, read from what it said on stderr.
 *
 * THIS IS A CORRECTION TO A SILENT SUBSTITUTION. `claude --effort <unsupported>` does not fail. It
 * writes `Warning: Unknown --effort value '<x>' — ignoring it and using the default effort.` to
 * stderr, exits 0, and answers at an effort the manifest does not describe. An engine that froze an
 * effort level and did not check for this would record real results under a setting that was never
 * applied — the exact substitution the identity checks exist to catch, arriving through a different
 * door.
 */
export function detectEffortSubstitution(stderr: string): string | undefined {
  const match = /Unknown\s+--effort\s+value\s+'([^']*)'/i.exec(stderr);
  if (!match) return undefined;
  return `the CLI rejected the frozen effort level '${match[1]}' and answered at its DEFAULT effort instead, `
    + 'without failing. The answer is real but it is not an answer at the effort this binding froze, so it is not '
    + 'recorded as one.';
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

    const { args, unexpressed, notEnforceable } = buildCLIArguments(request.binding);
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

    // CODEX IS A DIFFERENT TOOL AND IS READ AS ONE. Different arguments, a different output format,
    // different usage field names, a different meaning for the input-token count, and a different
    // way of signalling a refusal. It also needs a freshly created empty working directory, which is
    // made and removed around the request rather than left on the machine.
    if (this.provider === 'codexCLI') {
      return this.completeCodex(request, text, startedAt, now, notEnforceable);
    }

    // THE CLAUDE PATH GETS AN EMPTY WORKING DIRECTORY TOO, for the reason `completeCodex` already
    // documents: a CLI run inside a real directory can read what is in it, and nothing found that way
    // is in the manifest. `--setting-sources ''` and `--tools ''` already shut off settings, skills and
    // MCP, so this closes the remaining door rather than being the only lock on it — but "the request
    // ran somewhere with nothing in it" should be a fact about the ENGINE, not a fact about wherever
    // the operator happened to be standing when they typed the command.
    //
    // Created empty, removed afterwards, and never the repository.
    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-claude-'));
    let result;
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

    // A REFUSED MODEL EXITS NON-ZERO AND STILL PRINTS ITS DOCUMENTED ENVELOPE. Reading the exit code
    // first would classify a clean, machine-readable 404 as an opaque transport failure and lose the
    // one field that says what actually happened. So the envelope is consulted before the shell's
    // verdict — but only when the process actually got far enough to write one, which a timeout and
    // a cancellation do not.
    if (result.failure && result.failure.kind !== 'timeout' && result.failure.kind !== 'cancelled') {
      const errored = parseCLIResponse(result.stdout);
      if (errored?.isError) {
        const status = errored.apiErrorStatus;
        const kind: FrontierFailureKind = status === 404 || status === 403 ? 'refused'
          : status === 401 ? 'notAuthenticated'
            : status === 429 ? 'rateLimited'
              : 'transport';
        return {
          ...empty(kind, `the CLI reported a failed turn (${errored.terminalReason ?? 'no terminal reason'}`
            + `${status === undefined ? '' : `, HTTP ${status}`}): ${redactSecrets(errored.answerText).slice(0, 400)}`),
          totalElapsedMilliseconds: result.elapsedMilliseconds,
          firstVisibleTokenMilliseconds,
          // A refusal still reports what it consumed — usually nothing. Carrying the reported zero
          // is different from reporting nothing at all, and only one of them is what happened.
          subscriptionIncludedUsageMicroUSD: errored.subscriptionIncludedUsageMicroUSD,
        };
      }
    }

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

    // THE ENVELOPE'S OWN ERROR FLAGS COME FIRST, before the answer text is looked at. A refused
    // model returns exit 1, `is_error: true`, an empty `modelUsage`, and a `result` string that
    // reads like prose; scoring that prose as the model's answer is the failure this ordering
    // prevents. `subtype` is deliberately not consulted: it says "success" on a 404.
    if (parsed.isError) {
      const status = parsed.apiErrorStatus;
      const kind: FrontierFailureKind = status === 404 || status === 403 ? 'refused'
        : status === 401 ? 'notAuthenticated'
          : status === 429 ? 'rateLimited'
            : 'transport';
      return {
        ...empty(kind, `the CLI reported a failed turn (${parsed.terminalReason ?? 'no terminal reason'}`
          + `${status === undefined ? '' : `, HTTP ${status}`}): ${redactSecrets(parsed.answerText).slice(0, 400)}`),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
        subscriptionIncludedUsageMicroUSD: parsed.subscriptionIncludedUsageMicroUSD,
      };
    }

    // An effort level the tool warned it was ignoring makes the answer real and the BINDING false.
    const effortSubstituted = detectEffortSubstitution(result.stderr);
    if (effortSubstituted) {
      return {
        ...empty('budgetRefused', `${request.binding.candidate}: ${effortSubstituted}`),
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        firstVisibleTokenMilliseconds,
      };
    }

    const identity = resolveAnsweringModel(request.binding.requestedModelID, parsed.participants);
    const reported = totalInputTokens(parsed.usage) !== undefined || parsed.usage.visibleOutputTokens !== undefined;
    return {
      answerText: parsed.answerText,
      // Empty when the tool named nothing, which is `unverifiable` — never a copy of the request.
      reportedModelID: identity.state === 'unverifiable' ? '' : identity.reportedModelID,
      usage: parsed.usage,
      usageProvenance: reported ? 'providerReported' : 'unavailable',
      rawUsage: parsed.raw,
      firstVisibleTokenMilliseconds,
      totalElapsedMilliseconds: result.elapsedMilliseconds,
      retryCount: 0,
      wastedTokens: 0,
      reportedEffort: parsed.reportedEffort,
      subscriptionIncludedUsageMicroUSD: parsed.subscriptionIncludedUsageMicroUSD,
      participatingModelIDs: identity.participantIDs,
      notEnforceable,
    };
  }

  /**
   * One isolated Codex request.
   *
   * THE WORKING DIRECTORY IS CREATED EMPTY AND REMOVED AFTERWARDS. An agentic CLI pointed at a real
   * directory reads what is in it: `AGENTS.md`, project instructions, source files. None of those
   * are in the manifest, and a model that read one answered a different question from the model that
   * did not. The directory is also the contamination check — anything found in it afterwards was
   * written by the run, which `-s read-only` is supposed to prevent.
   */
  private async completeCodex(request: FrontierRequest, text: string, startedAt: number,
                              now: () => number, notEnforceable: string[]): Promise<FrontierResponse> {
    const empty = (kind: FrontierFailureKind, detail: string): FrontierResponse => ({
      answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
      totalElapsedMilliseconds: now() - startedAt, retryCount: 0, wastedTokens: 0,
      failure: { kind, detail },
    });

    const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-codex-'));
    let firstVisibleTokenMilliseconds: number | undefined;
    try {
      const built = buildCodexExecArguments(request.binding, { workingDirectory });
      if (built.unexpressed.length > 0) {
        return empty('budgetRefused',
          `${request.binding.candidate} froze settings this CLI cannot express, so the request was not sent: `
          + `${built.unexpressed.join('; ')}.`);
      }

      const result = await this.run({
        executable: this.executablePath as string,
        args: built.args,
        input: text,
        workingDirectory,
        timeoutMilliseconds: request.binding.timeoutMilliseconds,
        shouldCancel: request.shouldCancel,
        onFirstOutput: (at) => { firstVisibleTokenMilliseconds = at; },
      });

      const parsed = parseCodexExecJSONL(result.stdout);

      // The envelope is consulted before the shell's verdict, for the same reason as the Claude
      // path: `codex exec` exits 1 on a refused turn AND still prints the documented `turn.failed`
      // event that says why. Reading the exit code first throws that away.
      if (parsed?.isError) {
        const status = parsed.apiErrorStatus;
        // A Codex refusal for an unknown model or an unavailable one is HTTP 400, not 404 — the
        // service answers "not supported when using Codex with a ChatGPT account". Mapping 400 to
        // `transport` would have recorded an account-level refusal as a network problem.
        const kind: FrontierFailureKind = status === 400 || status === 403 || status === 404 ? 'refused'
          : status === 401 ? 'notAuthenticated'
            : status === 429 ? 'rateLimited'
              : 'transport';
        return {
          ...empty(kind, `the CLI reported a failed turn (${parsed.terminalReason ?? 'no terminal reason'}`
            + `${status === undefined ? '' : `, HTTP ${status}`}): `
            + `${redactSecrets(parsed.errorMessage ?? '').slice(0, 400)}`),
          totalElapsedMilliseconds: result.elapsedMilliseconds,
          firstVisibleTokenMilliseconds,
        };
      }

      if (result.failure) {
        const kind: FrontierFailureKind = result.failure.kind === 'timeout' ? 'timeout'
          : result.failure.kind === 'cancelled' ? 'cancelled'
            : result.failure.kind === 'notInstalled' ? 'notInstalled' : 'transport';
        return {
          ...empty(kind, `${redactSecrets(result.failure.detail)}`
            + `${result.stderr ? ` — ${redactSecrets(result.stderr).slice(0, 500)}` : ''}`),
          totalElapsedMilliseconds: result.elapsedMilliseconds,
          firstVisibleTokenMilliseconds,
        };
      }

      if (!parsed) {
        return {
          ...empty('malformedResponse',
            'the CLI exited successfully but produced no JSONL event this engine recognises, so nothing here can say '
            + 'what it answered. Cernum refuses to scrape an unrecognised format.'),
          totalElapsedMilliseconds: result.elapsedMilliseconds,
          firstVisibleTokenMilliseconds,
        };
      }

      // A TURN THAT RAN A TOOL IS NOT A MEASUREMENT OF A MODEL. It is refused rather than recorded,
      // because its numbers would sit in the same column as turns that did not and nothing in the
      // column would show the difference.
      const contamination = describeCodexContamination(parsed.toolInvocations);
      if (contamination) {
        return {
          ...empty('malformedResponse', `${request.binding.candidate}: ${contamination}`),
          totalElapsedMilliseconds: result.elapsedMilliseconds,
          firstVisibleTokenMilliseconds,
        };
      }

      const reported = totalInputTokens(parsed.usage) !== undefined || parsed.usage.visibleOutputTokens !== undefined;
      return {
        answerText: parsed.answerText,
        // ALWAYS EMPTY, AND THAT IS THE FINDING. `codex exec --json` names no model in any event, so
        // the identity of whatever answered is unverifiable. It is never filled in with the
        // requested identifier: "we asked for Luna" and "Luna answered" are different facts, and the
        // whole point of this field is to keep them apart.
        reportedModelID: '',
        usage: parsed.usage,
        usageProvenance: reported ? 'providerReported' : 'unavailable',
        rawUsage: parsed.raw,
        firstVisibleTokenMilliseconds,
        totalElapsedMilliseconds: result.elapsedMilliseconds,
        retryCount: 0,
        wastedTokens: 0,
        // Undefined, not the requested level: the tool echoes no effort back. An accepted effort is
        // not an applied one.
        reportedEffort: undefined,
        // Undefined, not zero. Codex reports NO cost and NO allowance figure, and recording zero
        // would say the request was free when it spent a real share of a finite plan.
        subscriptionIncludedUsageMicroUSD: undefined,
        participatingModelIDs: [],
        notEnforceable: [...notEnforceable, ...built.notEnforceable],
      };
    } finally {
      // Removed whether the request succeeded, failed, timed out or threw. A preflight that left a
      // directory per attempt behind would be a preflight that filled a disk it also guards.
      try { fs.rmSync(workingDirectory, { recursive: true, force: true }); } catch { /* already gone */ }
    }
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
  const fraction = effort === 'max' ? 0.75 : effort === 'xhigh' ? 0.7 : effort === 'high' ? 0.6
    : effort === 'medium' ? 0.4 : effort === 'low' ? 0.25 : 0.5;
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
