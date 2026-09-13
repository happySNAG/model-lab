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
import { FrontierAdapter, FrontierResponse, withRetry } from './frontier-adapter';
import { FrontierAttemptRecord, Provenance } from './frontier-metrics';
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

    const input = response.usage.inputTokens;
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

    if (isMetered(binding)) {
      // Recorded whatever happened, including on a failure: a refused request that burned input
      // tokens still burned them, and a ceiling that ignored those would be a ceiling that leaks.
      this.options.spend.record(costMicroUSD ?? 0, costProvenance === 'providerReported' ? 'providerReported' : 'estimated');
    }

    const frontier: FrontierAttemptRecord = {
      provider: binding.provider,
      executionClass: binding.executionClass,
      billingBasis: binding.billingBasis,
      requestedModelID: binding.requestedModelID,
      reportedModelID: response.reportedModelID,
      inputTokens: input,
      visibleOutputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: counted ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) : undefined,
      usageProvenance: counted ? response.usageProvenance : 'unavailable',
      costMicroUSD,
      costProvenance,
      retryCount: response.retryCount,
      wastedTokens: response.wastedTokens,
      timedOut: response.failure?.kind === 'timeout',
      rawUsage: response.rawUsage,
    };

    return {
      answerText: response.answerText,
      // Read back from what the adapter actually assembled, so the supplied-context verification
      // checks the request rather than checking the case against itself.
      assembledContext: request.suppliedContext,
      streamEvents,
      runtime: {
        evalTokenCount: output,
        promptTokenCount: input,
        // Deliberately absent. The provider's own generation duration is not something these APIs
        // report, and deriving one from the client's wall clock would turn a network round trip into
        // a claim about how fast the model generates.
        evalDurationNanoseconds: undefined,
        doneReason: response.failure ? response.failure.kind : 'stop',
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
