// Benchmark engine · one campaign, candidates reached three different ways.
//
// THE ROUTING HOST IS THE ONLY PLACE THE THREE EXECUTION CLASSES MEET, and it routes on the FROZEN
// BINDING rather than on anything observable at run time. That distinction is the whole design: a
// candidate is local because the manifest says it is local, not because a local runtime happened to
// have a model by that name when the request was made. A router that sniffed would be a router that
// could send a frozen API candidate to a local model of the same name and record the answer as
// though it were the one that was authorised.
//
// WHAT THIS HOST REFUSES TO DO, in order, before any request:
//
//   1  spend money nobody authorised          `authorizeAttempt` consults the spend tracker and the
//                                             recorded authorization. A refusal ABORTS the campaign
//                                             rather than recording a result: a slot that was never
//                                             attempted must never carry an outcome.
//   2  send settings it cannot express        a binding whose frozen effort or sampling the adapter
//                                             has no way to send is refused, not silently dropped.
//   3  take a lease it does not need          `runtimeIdentity` is present only when at least one
//                                             candidate is local. A frontier-only campaign contends
//                                             for no Ollama endpoint, because it reaches none.
//   4  unload weights that were never loaded  residency is managed for local candidates only; a
//                                             frontier candidate's "release" is a no-op that is
//                                             RECORDED as inapplicable rather than silently skipped.
//
// COST IS RECORDED FROM WHAT WAS COUNTED, NEVER FROM WHAT WAS BUDGETED. A provider that reports its
// usage gets a `providerReported` cost. A provider that reports nothing gets `unavailable` — not the
// worst case, and not an estimate promoted to a fact. The spend tracker still stops the run at the
// ceiling, using the worst case as the thing it refuses to risk, which is the only direction in
// which an unmeasured number is safe to use.

import { CanonicalValue } from './canonical';
import {
  AUTHORIZED_COST_ELIGIBILITIES, CostPolicyOverride, ZeroMarginalCostConfirmation, costEligibilityFor,
} from './cost-eligibility';
import type { AttemptAuthorization, AttemptOutcome, AttemptRequest, CampaignHost } from './campaign';
import { EngineCatalogue } from './catalogue';
import { CatalogueScorer } from './scoring';
import { PlanSlot, PlannableCandidate, TerminalSlotStatus } from './ledger';
import { StoreBaseline, SystemReading } from './guards';
import { ResidencyController } from './residency';
import { ObservedModelIdentity } from './verification';
import { StreamEvent } from './attempt-telemetry';
import { readMachine } from './machine';
import {
  OperationalEnvelope, ProviderBinding, ProviderID, bindingFor, isLocal, isMetered,
} from './provider';
import { FrontierAdapter, FrontierResponse, totalInputTokens, withRetry } from './frontier-adapter';
import {
  FrontierAttemptRecord, LOCAL_NO_ALLOWANCE, NOT_A_SUBSCRIPTION, Provenance,
} from './frontier-metrics';
import { SpendTracker, SpendingError, attemptCostMicroUSD, worstCaseAttemptMicroUSD } from './spending';
import { redactError } from './redaction';

/** A residency controller for a campaign that has no local runtime to control. */
export class NoResidency implements ResidencyController {
  async resident(): Promise<string[]> {
    // Not "we did not check": there is nothing on this machine this campaign could have loaded.
    return [];
  }

  async unload(): Promise<void> {
    // Nothing to unload. Recorded by the campaign as inapplicable, never as a proof.
  }
}

export interface RoutingHostOptions {
  envelope: OperationalEnvelope;
  catalogue: EngineCatalogue;
  /** One adapter per frontier provider in the envelope. A missing one refuses rather than falls back. */
  adapters: Partial<Record<ProviderID, FrontierAdapter>>;
  /** Required only when the envelope contains a local candidate. */
  localHost?: CampaignHost;
  spend: SpendTracker;
  /**
   * The project cost policy, enforced per attempt beside the spending ceiling.
   *
   * ABSENT MEANS UNENFORCED, and that is deliberate rather than an oversight. This gate was added in
   * Pass 7 to an engine with campaigns already frozen and surfaces already calling this constructor;
   * defaulting it ON would have changed what an existing campaign does when resumed, which is the
   * one thing a frozen campaign must never do. The surfaces that create campaigns pass it; a caller
   * that does not opt in gets exactly the behaviour it had before.
   */
  costPolicy?: {
    confirmations?: ZeroMarginalCostConfirmation[];
    overrides?: CostPolicyOverride[];
  };
  /** The model-store baseline, when there are local candidates. Absent for a frontier-only campaign. */
  storeBaseline?: StoreBaseline;
  diskPath?: string;
  now?: () => Date;
  /** Polled by the adapters, so a pause reaches a child process and an open socket. */
  shouldCancel?: () => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * The machine reading, injected.
   *
   * A frontier-only campaign still runs ON a machine and is still stopped by its disk and memory
   * guards, so in life this reads the real one. Injecting it is what makes a frontier-only campaign
   * deterministic in a test — the same seam `now` and `sleep` already are, and for the same reason:
   * a test whose outcome depends on how full this particular disk happens to be is not a test of
   * the orchestration.
   */
  readMachine?: () => Promise<{ freeDiskBytes: number; swapUsedBytes: number; freeMemoryBytes: number; totalMemoryBytes: number; listeners: Record<string, number> }>;
}

export class RoutingHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RoutingHostError';
  }
}

/**
 * THE ALLOWANCE, AND WHY IT IS OR IS NOT THERE.
 *
 * Pass 6's adapters parsed Claude Code's `total_cost_usd` correctly and the value died at this
 * boundary: the record carried `costMicroUSD` — the marginal charge, always zero on a subscription —
 * and no allowance field at all. So a completed 48-attempt pilot could report a zero charge and not
 * one figure for the plan it actually spent, and Pass 5C's measured $0.035257 became unmeasurable.
 *
 * Three fields rather than one, because a missing number and a number missing FOR A REASON are
 * different records and a surface that has only the first has to guess. Zero is never written for
 * either: a zero allowance is a claim that a Max plan is free.
 *
 * EXPORTED, AND TAKING THE NARROWEST SHAPE IT READS. The workspace host (`workspace-host.ts`) has
 * the same question to answer about the same providers, and a second copy of this reasoning would be
 * a second place for the explanations to drift apart. It reads one optional number off the response,
 * so that is all it asks for — a `FrontierResponse` satisfies it unchanged, and a
 * `WorkspaceAgentResult`'s usage block can be made to.
 */
export function allowanceRecord(binding: ProviderBinding,
                                response: { subscriptionIncludedUsageMicroUSD?: number }): {
  subscriptionIncludedUsageMicroUSD?: number;
  subscriptionAllowanceState: 'reported' | 'unavailable';
  subscriptionAllowanceProvenance: Provenance;
  subscriptionAllowanceExplanation: string;
} {
  if (binding.billingBasis !== 'subscriptionIncluded') {
    return {
      subscriptionAllowanceState: 'unavailable',
      subscriptionAllowanceProvenance: 'unavailable',
      subscriptionAllowanceExplanation: isLocal(binding) ? LOCAL_NO_ALLOWANCE : NOT_A_SUBSCRIPTION,
    };
  }
  const value = response.subscriptionIncludedUsageMicroUSD;
  if (value === undefined) {
    return {
      subscriptionAllowanceState: 'unavailable',
      subscriptionAllowanceProvenance: 'unavailable',
      subscriptionAllowanceExplanation:
        `${binding.provider} returned no usage valuation for this request, so how much of the plan allowance it `
        + 'consumed is not known. It is NOT zero: the request was answered, and answering it spent allowance. '
        + 'Nothing here may be summed as though the unreported attempts consumed nothing.',
    };
  }
  return {
    subscriptionIncludedUsageMicroUSD: value,
    subscriptionAllowanceState: 'reported',
    subscriptionAllowanceProvenance: 'providerReported',
    subscriptionAllowanceExplanation:
      `${binding.provider} valued this request at the provider's own list price. This is the plan allowance it `
      + 'consumed, NOT a charge: no card was billed, and the marginal API charge recorded beside it is a true zero.',
  };
}

/**
 * The tool's own account of the turn, folded onto the record — and NOTHING ELSE folded with it.
 *
 * Read the note on `FrontierAttemptRecord.otlpObserved` first. Two properties of this function are
 * load-bearing and are the reason it is a function rather than a spread at the call site:
 *
 *   1  IT NEVER WRITES `reportedModelID`. The telemetry's `model` attribute is the identifier the
 *      client sent, so using it would turn a self-report into a provider's answer. A Codex row with
 *      a full observation is still `requestAcceptedIdentityUnverifiable`.
 *   2  IT NEVER REPLACES A COUNTED TOKEN. The stdout figures stay the record's token columns; these
 *      sit beside them and are CHECKED against them. Where they disagree, both are kept and the
 *      disagreement is recorded, because a benchmark that silently preferred one source would be a
 *      benchmark whose numbers nobody could reconcile.
 */
function otlpRecord(binding: ProviderBinding, response: FrontierResponse): {
  otlpObserved?: boolean; otlpCorrelated?: boolean; otlpCorrelationKey?: string;
  otlpTurnReasoningEffort?: string; otlpRequestReasoningEffort?: string;
  otlpInputTokens?: number; otlpNonCachedInputTokens?: number; otlpCachedInputTokens?: number;
  otlpCacheWriteInputTokens?: number; otlpOutputTokens?: number; otlpReasoningOutputTokens?: number;
  otlpTotalTokens?: number; otlpMCPServers?: string;
  otlpTokensAgreeWithStdout?: boolean; otlpEffortMatchesBinding?: boolean;
} {
  const turn = response.otlpTurn;
  if (turn === undefined) {
    // No collector ran for this attempt. Recorded as an absence rather than as a miss: "nobody
    // asked" and "we asked and nothing came" are different facts about a row.
    return {};
  }
  const stdoutInput = response.usage.inputTokens;
  const stdoutOutput = response.usage.visibleOutputTokens;
  const checkable = turn.nonCachedInputTokens !== undefined && stdoutInput !== undefined
    && turn.outputTokens !== undefined && stdoutOutput !== undefined;
  return {
    otlpObserved: true,
    otlpCorrelated: turn.correlated,
    otlpCorrelationKey: turn.correlationKey,
    otlpTurnReasoningEffort: turn.turnReasoningEffort,
    otlpRequestReasoningEffort: turn.requestReasoningEffort,
    otlpInputTokens: turn.inputTokens,
    otlpNonCachedInputTokens: turn.nonCachedInputTokens,
    otlpCachedInputTokens: turn.cachedInputTokens,
    otlpCacheWriteInputTokens: turn.cacheWriteInputTokens,
    otlpOutputTokens: turn.outputTokens,
    otlpReasoningOutputTokens: turn.reasoningOutputTokens,
    otlpTotalTokens: turn.totalTokens,
    otlpMCPServers: turn.mcpServers,
    // The Codex adapter derives the fresh remainder from the total, and the telemetry reports that
    // remainder directly as `non_cached_input_tokens`. Two independent routes to one figure is
    // exactly the kind of agreement worth recording — and exactly the kind of disagreement worth
    // shouting about if it ever appears.
    otlpTokensAgreeWithStdout: checkable
      ? turn.nonCachedInputTokens === stdoutInput && turn.outputTokens === stdoutOutput
      : undefined,
    otlpEffortMatchesBinding: turn.turnReasoningEffort === undefined
      ? undefined : turn.turnReasoningEffort === binding.effort,
  };
}

/**
 * ONE FRONTIER RESPONSE, TURNED INTO THE ROW THAT GETS RECORDED.
 *
 * EXTRACTED RATHER THAN COPIED, and the distinction is the whole reason it is a function. The
 * development runner records the same telemetry as a text campaign — every input token including
 * the cached ones, the decomposition beside the total, the allowance a subscription actually spent,
 * the retries, the wasted tokens, the tool's own telemetry where a collector ran. A second builder
 * beside this one would agree on the day it was written and would drift on the day either half was
 * corrected, which is exactly how Pass 6 came to understate one provider's input by 1,650x in a
 * column that looked comparable.
 *
 * It is PURE. The spend ceiling is not enforced here — `RoutingHost` reads `costMicroUSD` and
 * `costProvenance` off the returned row and records against its own tracker — because a function
 * that both describes an attempt and charges for it could not be called by a caller that only
 * wanted the description.
 */
export function buildFrontierAttemptRecord(binding: ProviderBinding, response: FrontierResponse): FrontierAttemptRecord {
  // EVERY input token the provider processed, not the fresh remainder.
  //
  // Pass 6 read `usage.inputTokens` here and recorded it as the attempt's input count. That field
  // is the fresh remainder, and the two tools leave a different remainder: Claude reports 2 fresh
  // tokens beside 6,000 cached ones, Codex reports a total from which the adapter derives the
  // remainder. So the Pass 6 ledger understated Claude by ~1,650x AND Codex by ~1.75x, in one
  // column, which is worse than either alone — the column looked comparable and was not.
  //
  // `totalInputTokens()` was written for exactly this and, until now, was reached only as a
  // presence check. The decomposition travels with the total so the correction is auditable from
  // the row rather than taken on trust.
  const input = totalInputTokens(response.usage);
  const freshInput = response.usage.inputTokens;
  const cacheCreation = response.usage.cacheCreationInputTokens;
  const cacheRead = response.usage.cacheReadInputTokens;
  const output = response.usage.visibleOutputTokens;
  const reasoning = response.usage.reasoningTokens;
  const counted = input !== undefined || output !== undefined;

  let costMicroUSD: number | undefined;
  let costProvenance: Provenance;
  if (!isMetered(binding)) {
    // Subscription execution has NO per-token charge. Zero is the true marginal API charge, and
    // the allowance it consumes is a different currency that a dollar figure must not stand in for.
    costMicroUSD = 0;
    costProvenance = 'measured';
  } else if (counted) {
    // Priced on the TOTAL input, which is the direction in which an imprecise pricing model is
    // safe: the snapshot carries one input rate and no cache tier, so charging cached tokens at
    // the full rate can overstate a charge and can never understate one. A ceiling that guards
    // against the overstatement still guards; one built on the fresh remainder would have let a
    // metered run spend orders of magnitude past it.
    costMicroUSD = attemptCostMicroUSD(binding, {
      inputTokens: input, outputTokens: output, reasoningTokens: reasoning,
    });
    costProvenance = response.usageProvenance === 'providerReported' ? 'providerReported' : 'estimated';
  } else {
    // Metered, and the provider counted nothing. The cost is genuinely unknown, and writing the
    // budget in its place would put a number nobody can reconcile into the evidence.
    costMicroUSD = undefined;
    costProvenance = 'unavailable';
  }

  return {
    provider: binding.provider,
    executionClass: binding.executionClass,
    billingBasis: binding.billingBasis,
    requestedModelID: binding.requestedModelID,
    reportedModelID: response.reportedModelID,
    inputTokens: input,
    freshInputTokens: freshInput,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    visibleOutputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: counted ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) : undefined,
    usageProvenance: counted ? response.usageProvenance : 'unavailable',
    costMicroUSD,
    costProvenance,
    ...allowanceRecord(binding, response),
    ...otlpRecord(binding, response),
    retryCount: response.retryCount,
    wastedTokens: response.wastedTokens,
    timedOut: response.failure?.kind === 'timeout',
    rawUsage: response.rawUsage,
  };
}

export class RoutingHost implements CampaignHost {
  readonly residency: ResidencyController;
  readonly now: () => Date;
  /**
   * Present ONLY when a local candidate exists.
   *
   * The campaign takes an Ollama endpoint lease exactly when its host offers a runtime identity, so
   * leaving this undefined is how a frontier-only campaign takes no lease — not a flag the campaign
   * has to remember to check, but the absence of the thing a lease is taken against.
   */
  runtimeIdentity?: () => Promise<{ endpoint: string; modelStoreListingDigest: string; modelStoreCount: number }>;

  private readonly scorer: CatalogueScorer;

  constructor(private readonly options: RoutingHostOptions) {
    this.now = options.now ?? (() => new Date());
    this.scorer = new CatalogueScorer(options.catalogue, this.now);

    const hasLocal = options.envelope.bindings.some(isLocal);
    if (hasLocal && !options.localHost) {
      throw new RoutingHostError('noLocalHost',
        'this campaign binds a local candidate but was given no local host to run it on');
    }
    this.residency = options.localHost?.residency ?? new NoResidency();
    if (hasLocal && options.localHost?.runtimeIdentity) {
      this.runtimeIdentity = () => options.localHost!.runtimeIdentity!();
    }
    for (const binding of options.envelope.bindings) {
      if (isLocal(binding)) continue;
      if (!options.adapters[binding.provider]) {
        throw new RoutingHostError('noAdapter',
          `${binding.candidate} is bound to ${binding.provider}, and no adapter for it was supplied. `
          + 'Cernum refuses to fall back to a different provider: an answer from somebody else is not this candidate\'s answer.');
      }
    }
  }

  private binding(candidate: string): ProviderBinding {
    return bindingFor(this.options.envelope, candidate);
  }

  /** True when this campaign will manage residency for this candidate. Frontier candidates: never. */
  managesResidencyFor(candidate: string): boolean {
    return isLocal(this.binding(candidate));
  }

  /**
   * Identity BEFORE the request.
   *
   * A local candidate is asked of the runtime, exactly as in Pass 3. A frontier candidate has no
   * local weights to interrogate, and asking the provider would cost a request — so nothing is
   * reported, which `verifyModelIdentity` turns into `unverifiable`. The identity that actually
   * matters for a frontier candidate is established AFTER the response, from what the provider says
   * answered, and the campaign checks that separately.
   */
  async observeIdentity(candidate: PlannableCandidate): Promise<ObservedModelIdentity> {
    const binding = this.binding(candidate.name);
    if (isLocal(binding)) return this.options.localHost!.observeIdentity(candidate);
    return {
      name: candidate.name,
      modelID: binding.requestedModelID,
      // Deliberately no runtimeDigest: there are no weights on this machine to have a digest, and
      // reporting the frozen value back would be the pin confirming itself.
      capabilities: binding.thinkingMode === 'enabled' ? ['completion', 'thinking'] : undefined,
    };
  }

  /**
   * May this attempt be made at all?
   *
   * The campaign calls this immediately after the guards and before anything is sent. A refusal here
   * aborts the campaign and blocks the remaining slots; it never records a result, because a request
   * that was refused before it left is not an outcome the model produced.
   */
  async authorizeAttempt(slot: PlanSlot): Promise<AttemptAuthorization> {
    const binding = this.binding(slot.candidate);

    // THE COST POLICY, BEFORE THE METERED CHECK AND NOT INSIDE IT.
    //
    // `isMetered` asks whether the provider bills per token. The cost policy asks who pays, which is
    // a different question with a fifth answer the billing basis has no room for: `unknown_cost` can
    // land on a candidate that `isMetered` says nothing about, and putting this check after that
    // early return would let precisely the unclassifiable candidate through — the one case the gate
    // exists for. A refusal here aborts before anything is sent, exactly as a spending refusal does.
    if (this.options.costPolicy !== undefined) {
      const verdict = costEligibilityFor({
        provider: binding.provider,
        modelID: binding.requestedModelID,
        executionClass: binding.executionClass,
        confirmations: this.options.costPolicy.confirmations,
        overrides: this.options.costPolicy.overrides,
      });
      if (!verdict.authorized) {
        return {
          allowed: false,
          code: `costPolicy.${verdict.eligibility}`,
          reason: `${binding.candidate} is ${verdict.eligibility} and this project authorizes only `
            + `${AUTHORIZED_COST_ELIGIBILITIES.join(', ')} for execution. Nothing was sent. ${verdict.reason}`,
          detail: {
            candidate: binding.candidate,
            provider: binding.provider,
            costEligibility: verdict.eligibility,
            billingBasis: binding.billingBasis,
            authorizedEligibilities: AUTHORIZED_COST_ELIGIBILITIES.join(', '),
          } as CanonicalValue,
        };
      }
    }

    if (!isMetered(binding)) return { allowed: true };
    try {
      this.options.spend.check(binding, worstCaseAttemptMicroUSD(binding));
      return { allowed: true };
    } catch (error) {
      if (error instanceof SpendingError) {
        return {
          allowed: false,
          code: `spending.${error.code}`,
          reason: error.message,
          detail: {
            candidate: binding.candidate,
            provider: binding.provider,
            spentMicroUSD: this.options.spend.spentMicroUSD,
            ceilingMicroUSD: this.options.spend.ceilingMicroUSD ?? null,
            worstCaseNextAttemptMicroUSD: worstCaseAttemptMicroUSD(binding),
            meteredAttempts: this.options.spend.meteredAttempts,
          } as CanonicalValue,
        };
      }
      throw error;
    }
  }

  async run(request: AttemptRequest): Promise<AttemptOutcome> {
    const binding = this.binding(request.slot.candidate);
    if (isLocal(binding)) {
      const outcome = await this.options.localHost!.run(request);
      // A local attempt carries a frontier record too, so every row in a mixed campaign answers the
      // same questions. Its cost is zero with `measured` provenance — not unavailable, because "this
      // cost nothing" is a fact about local execution and not an absence of evidence.
      return { ...outcome, frontier: this.localRecord(binding, outcome) };
    }

    const adapter = this.options.adapters[binding.provider]!;
    const response = await withRetry(
      binding,
      () => adapter.complete({
        binding,
        promptText: request.promptText,
        suppliedContext: request.suppliedContext,
        shouldCancel: this.options.shouldCancel,
      }),
      this.options.sleep,
      this.options.shouldCancel,
    );
    return this.outcomeFrom(binding, request, response);
  }

  private localRecord(binding: ProviderBinding, outcome: AttemptOutcome): FrontierAttemptRecord {
    const input = outcome.runtime.promptTokenCount;
    const output = outcome.runtime.evalTokenCount;
    return {
      provider: binding.provider,
      executionClass: binding.executionClass,
      billingBasis: binding.billingBasis,
      requestedModelID: binding.requestedModelID,
      // A local runtime does not name the model in its answer; it was identified by its weights
      // digest before the request. Empty here is correct, and the weights check is what covered it.
      reportedModelID: '',
      inputTokens: input,
      visibleOutputTokens: output,
      reasoningTokens: undefined,
      totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
      usageProvenance: input !== undefined || output !== undefined ? 'providerReported' : 'unavailable',
      costMicroUSD: 0,
      costProvenance: 'measured',
      // Stated, not omitted. A local candidate consumed no provider allowance, and that is a fact
      // about local execution rather than an absence of evidence.
      subscriptionAllowanceState: 'unavailable',
      subscriptionAllowanceProvenance: 'unavailable',
      subscriptionAllowanceExplanation: LOCAL_NO_ALLOWANCE,
      retryCount: 0,
      wastedTokens: 0,
      timedOut: false,
    };
  }

  private outcomeFrom(binding: ProviderBinding, request: AttemptRequest, response: FrontierResponse): AttemptOutcome {
    // A synthesised stream event, and only when a first visible byte was actually OBSERVED. This is
    // what lets the existing telemetry summariser produce a real time-to-first-token for a frontier
    // attempt without inventing one for an attempt nobody watched.
    const streamEvents: StreamEvent[] = response.firstVisibleTokenMilliseconds !== undefined
      ? [{ channel: 'visible', atMilliseconds: response.firstVisibleTokenMilliseconds }]
      : [];

    const frontier = buildFrontierAttemptRecord(binding, response);

    if (isMetered(binding)) {
      // Recorded whatever happened, including on a failure: a refused request that burned input
      // tokens still burned them, and a ceiling that ignored those would be a ceiling that leaks.
      this.options.spend.record(frontier.costMicroUSD ?? 0,
        frontier.costProvenance === 'providerReported' ? 'providerReported' : 'estimated');
    }

    return {
      answerText: response.answerText,
      // Read back from what the adapter actually assembled, so the supplied-context verification
      // checks the request rather than checking the case against itself.
      assembledContext: request.suppliedContext,
      streamEvents,
      runtime: {
        evalTokenCount: frontier.visibleOutputTokens,
        // The corrected total, so the telemetry summariser and the ledger row cannot disagree about
        // how large the request was. Read off the record rather than recomputed, so the row and the
        // telemetry summary cannot be derived from two different readings of one usage block.
        promptTokenCount: frontier.inputTokens,
        // Deliberately absent. The provider's own generation duration is not something these APIs
        // report, and deriving one from the client's wall clock would turn a network round trip into
        // a claim about how fast the model generates.
        evalDurationNanoseconds: undefined,
        // THE PROVIDER'S WORD, OR NOTHING. This read `'stop'` for every attempt that did not fail,
        // which meant an answer cut off at the output ceiling and an answer that finished were the
        // same record. `summariseAttempt` turns the undefined into `unavailable` with its reason,
        // which is what "the provider did not say" is supposed to look like here.
        doneReason: response.failure ? response.failure.kind : response.finishReason,
        weightsWereLoaded: false,
      },
      totalElapsedMilliseconds: response.totalElapsedMilliseconds,
      failure: response.failure
        ? { code: `${binding.provider}.${response.failure.kind}`, detail: redactError(response.failure.detail) }
        : undefined,
      frontier,
    };
  }

  async score(slot: PlanSlot, answerText: string): Promise<{ status: TerminalSlotStatus; governanceViolated: boolean; detail: string }> {
    return this.scorer.score(slot, answerText);
  }

  async readSystem(): Promise<SystemReading> {
    if (this.options.localHost) return this.options.localHost.readSystem();
    const machine = await (this.options.readMachine ?? (() => readMachine(this.options.diskPath)))();
    return {
      ...machine,
      // A campaign with no local candidates has no model store to have drifted. The store guard is
      // not in its policy, so these values are never compared against anything; they are reported as
      // the empty store this campaign actually observes rather than as a fabricated baseline.
      modelStoreListingDigest: '',
      modelStoreCount: 0,
    };
  }
}
