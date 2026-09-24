// Benchmark engine · the execution seam for a WORKSPACE case, parallel to `RoutingHost` and joined
// to it everywhere the two genuinely agree.
//
// WHY THIS IS NOT `RoutingHost.run`, AND WHY THAT IS NOT A FORK.
//
// `CampaignHost.run` takes an `AttemptRequest` — a slot, a prompt string, a supplied context, an
// output ceiling — and returns an `AttemptOutcome` whose subject is `answerText: string`. Every
// field on it is shaped by that: `streamEvents` time a token stream, `runtime` carries an eval token
// count and a done reason, and the scorer downstream reads one string. A workspace attempt produces
// none of those things. Its result is a TREE, a PATCH, a set of exit statuses, a scope assessment,
// a provenance-split transcript and an attempt boundary — and `WorkspaceScorecard` already exists to
// hold them. Pushing that through `AttemptOutcome` would mean either stringifying a scorecard into
// `answerText`, which makes the most load-bearing evidence in the engine unreadable to the code that
// consumes it, or widening `AttemptOutcome` with a dozen optional workspace fields that every prose
// caller then has to ignore. Both are worse than two functions.
//
// SO THE SEAM IS DRAWN AT EXECUTION AND RESULT, AND NOWHERE ELSE. Concretely:
//
//   DIVERGES                             because
//   ────────────────────────────────────────────────────────────────────────────────────────────
//   the request                          `WorkspaceRunOptions` names a fixture root, a sandbox root
//                                        and a driver. There is no prompt and no output ceiling.
//   the result                           `WorkspaceScorecard` + `WorkspaceRunResult`, never
//                                        `AttemptOutcome`. The verdict comes from the tree and the
//                                        verification commands, which a prose outcome cannot carry.
//   the driver                           `WorkspaceAgentDriver`, not `FrontierAdapter`. Different
//                                        arguments, different output format, different failure set.
//   retries                              the RUNNER owns them, because each one needs a fresh
//                                        workspace. `withRetry` retries a request; it cannot make a
//                                        directory.
//
//   REUNIFIES                            where
//   ────────────────────────────────────────────────────────────────────────────────────────────
//   the plan and the ledger              `workspacePlannableCaseOf` → `PlannableCase` → `PlanSlot`.
//                                        Unchanged; `buildPlan` never learns this is a workspace case.
//   the terminal status                  `WorkspaceScorecard.status` IS a `TerminalSlotStatus`.
//                                        `patchFailure`, `scopeFailure`, `compilationFailure` and
//                                        `behavioralFailure` have been in that vocabulary since the
//                                        port, so a workspace row lands in the same column.
//   the frozen manifest                  `workspacePromptRecordOf` / `workspaceScoredCoreEntryOf`.
//   candidate identity                   the same `ProviderBinding`, the same
//                                        `resolveAnsweringModel` ladder, the same admission states.
//   cost, tokens and allowance           ONE `FrontierAttemptRecord`, built here by the same
//                                        `allowanceRecord` and `attemptCostMicroUSD` the prose host
//                                        uses. There is no second cost model and no second currency.
//   the spend ceiling                    ONE `SpendTracker`, consulted before the attempt and
//                                        recorded after it, exactly as `RoutingHost.authorizeAttempt`
//                                        and `RoutingHost.run` do.
//   the lock, the guards, the evidence   untouched. They sit above and below this function.
//
// THE ATTEMPT CEILING IS AN OPERATOR SETTING, NOT A CASE SETTING, and the distinction is deliberate.
// `execution.maximumAttempts` is the case's own statement about what it measures: `2` says this task
// measures recovery from a failed check. An operator running the first live proof of a driver does
// not want to spend a second allowance on a second attempt, and lowering the case's number to get
// that would change the case digest and quietly redefine the task for everyone afterwards. So the
// ceiling lives on the ENVELOPE, is applied through the runner's existing cancellation seam, and is
// RECORDED on the outcome — `attemptCeilingApplied` says out loud that the run stopped because the
// operator capped it and not because the case did.

import { CanonicalValue } from './canonical';
import type { AttemptAuthorization } from './campaign';
import { PlannableCase } from './ledger';
import { ProviderBinding, isMetered } from './provider';
import { FrontierAttemptRecord } from './frontier-metrics';
import { allowanceRecord } from './frontier-host';
import { SpendTracker, SpendingError, attemptCostMicroUSD, worstCaseAttemptMicroUSD } from './spending';
import { WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey, workspacePlannableCaseOf } from './workspace-case';
import { WorkspaceAgentDriver, driverShortfalls } from './workspace-agent';
import {
  WorkspaceAttemptRecord, WorkspaceRunOptions, WorkspaceRunResult, runWorkspaceCase,
} from './workspace-execution';
import { WorkspaceScorecard, scoreWorkspaceRun } from './workspace-scoring';
import { verifyProviderIdentity } from './verification';

export class WorkspaceHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceHostError';
  }
}

// MARK: - The usage block a driver hands back

/**
 * The keys a workspace driver may put in `WorkspaceAgentResult.usage`, and what each one means.
 *
 * DECLARED HERE RATHER THAN IN A DRIVER, for the reason `FrontierUsage` is declared once on the prose
 * side: two drivers naming the same figure two ways produce a column that cannot be summed. The
 * names match `FrontierAttemptRecord`'s so the mapping below is a rename and never a reinterpretation.
 *
 * Every field is optional and an ABSENT field stays absent. A driver whose tool reported no token
 * count writes nothing here, and the record says `unavailable` — never zero, which would be a claim
 * that the request was free.
 */
export interface WorkspaceAgentUsage extends Record<string, CanonicalValue | undefined> {
  /** EVERY input token the provider processed, cached and fresh. Not the fresh remainder. */
  inputTokens?: number;
  freshInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  visibleOutputTokens?: number;
  reasoningTokens?: number;
  /** The tool's own list valuation of the invocation, integer microUSD. A plan spend, never a charge. */
  subscriptionIncludedUsageMicroUSD?: number;
  /** The tool's own time to first token. Its observation, beside — never instead of — the engine's. */
  providerReportedTimeToFirstTokenMilliseconds?: number;
  /** The first stdout byte, on THIS process's clock. The engine's own observation. */
  observedFirstOutputMilliseconds?: number;
  providerReportedDurationMilliseconds?: number;
  providerReportedAPIDurationMilliseconds?: number;
  /** `verified` | `substituted` | `unverifiable`, from the same ladder the prose path uses. */
  identityState?: string;
  /** Every model the tool said took part, sorted. A housekeeping model is a participant too. */
  participantIDs?: string[];
  /** The tool's own word for why the turn ended. Recorded; never a verdict. */
  terminalReason?: string;
  apiErrorStatus?: number;
  numTurns?: number;
  /**
   * How `visibleOutputTokens` and `reasoningTokens` relate, when the driver cannot say they are
   * disjoint. Absent means the tool's own fields are disjoint by construction, as Claude's are.
   * `reasoningIncludedInOutput` is the Codex value: see `CODEX_OUTPUT_TOKEN_SEMANTICS`.
   */
  outputTokenSemantics?: string;
  /**
   * What the tool's OWN telemetry says it applied, when a collector was attached. Its account of
   * itself, recorded beside the frozen request and never in place of it — and never an identity.
   */
  providerReportedEffort?: string;
  providerReportedAuthMode?: string;
  providerReportedSandboxPolicy?: string;
  providerReportedApprovalPolicy?: string;
  /** The redacted placeholder joining this attempt to late-arriving telemetry. Not an identifier. */
  otlpCorrelationKey?: string;
  /** The telemetry's own total, kept to settle how the token fields decompose. */
  otlpTotalTokens?: number;
  /**
   * LOCAL-RUNTIME PROVENANCE, written only by the Ollama driver. Absent on every other driver, and
   * absent means the question does not apply — a hosted model has no weights digest this engine can read.
   * The digest is the identity on that route; the machine is where the latency was measured, and a local
   * result is never assumed to transfer to another machine. See `machine-availability.ts`.
   */
  localModelDigest?: string;
  localRuntimeVersion?: string;
  localRuntimeEndpoint?: string;
  localModelContextLengthTokens?: number;
  /**
   * The window the harness ASKED the runtime to open, which is the model's measured context bounded
   * by the harness ceiling. Absent where the runtime published no context length and none was asked
   * for. Recorded beside the measured number rather than replacing it: one is what the model can do,
   * the other is what this run actually ran in, and a comparison across runs needs both.
   */
  localModelContextWindowRequestedTokens?: number;
  localModelSizeBytes?: number;
  /**
   * HOW THE LAST STREAMED TURN ENDED, and how each one did, in the Ollama driver's own finer
   * vocabulary — `OLLAMA_STREAM_OUTCOMES`. Recorded BESIDE `terminalReason`, which stays the closed
   * kind every route shares, because a single `timeout` cannot say whether the model was generating
   * or the runtime never started. Absent on every route that does not stream a local runtime.
   */
  localStreamOutcome?: string;
  localStreamOutcomes?: string[];
  localStreamEventCount?: number;
  localStreamMalformedEventCount?: number;
  /** Why no time to first token is on this record. Present only when there is no TTFT to record. */
  localFirstTokenUnavailableReason?: string;
  /**
   * What the runtime had RESIDENT before this case ran, from one bounded `/api/ps` read. Residency,
   * never activity: `/api/ps` does not say whether a model is generating. `noModelResident` is the
   * ordinary case and not a fault — Ollama loads a model on request.
   */
  localRuntimeResidencyBefore?: string;
  localRuntimeResidentModelsBefore?: string[];
  localRuntimeProbeMilliseconds?: number;
  localRuntimeProbeDetail?: string;
  /** The `cmk1:` machine key (see `machine-availability.ts`), and the hostname as a label beside it. */
  executionMachine?: string;
  executionMachineLabel?: string;
  executionPlatform?: string;
  /** The provider's usage block verbatim, so a figure here can be reconciled against a bill. */
  rawUsage?: CanonicalValue;
}

// MARK: - What the host is asked for, and what it returns

export interface WorkspaceHostRequest {
  /** The FROZEN case. Never modified here; the digest a result carries is taken from this object. */
  case: WorkspaceCase;
  /** The frozen candidate binding. Decides who is asked, how they are billed, and what is verified. */
  binding: ProviderBinding;
  driver: WorkspaceAgentDriver;
  /** Absolute. The case's `fixturePath` resolves INSIDE this. */
  fixtureRoot: string;
  /** Absolute, and outside every Git working tree — `assertSandboxRootIsSafe` enforces it. */
  sandboxRoot: string;
  evidenceRoot?: string;
  preserveFailedWorkspaces?: boolean;
  /**
   * The OPERATOR's ceiling on attempts, when there is one. Never raises the case's own number.
   *
   * Absent means the case decides alone, which is the ordinary arrangement.
   */
  attemptCeiling?: number;
  environmentSource?: NodeJS.ProcessEnv;
  shouldCancel?: () => boolean;
  now?: () => number;
  onAttempt?: (record: WorkspaceAttemptRecord) => void;
  /** Injected by the tests so a verification command need not be a real process. */
  runCommand?: WorkspaceRunOptions['runCommand'];
}

export interface WorkspaceOutcome {
  /** Everything that happened, attempt by attempt. The evidence. */
  run: WorkspaceRunResult;
  /** The verdict, in the SAME status vocabulary a prose row uses. */
  scorecard: WorkspaceScorecard;
  /**
   * Who answered, what it cost, and how well any of that was counted.
   *
   * THE SAME RECORD A PROSE ATTEMPT PRODUCES, built by the same helpers. This is the reunification
   * point that matters most: a campaign summing allowance across a mixed run must not have to know
   * whether a row came from a prompt or from a repository.
   */
  frontier: FrontierAttemptRecord;
  /** The plan slot's view of the case, so a caller can reconcile a row against its slot. */
  plannable: PlannableCase;
  /** Set when the run stopped because the OPERATOR capped attempts rather than because the case did. */
  attemptCeilingApplied?: { ceiling: number; caseAllows: number };
}

// MARK: - The host

export interface WorkspaceRoutingHostOptions {
  /** The campaign's single spend tracker. Shared with the prose host; there is never a second one. */
  spend: SpendTracker;
  now?: () => number;
}

/**
 * Run one workspace case, for one bound candidate, through one driver.
 *
 * A DELIBERATELY SMALL OBJECT. It authorises, it runs, it maps the driver's usage onto the shared
 * record, and it scores. It does not plan, does not lock, does not write a ledger row and does not
 * decide whether the task succeeded — `workspace-execution.ts` and `workspace-scoring.ts` already
 * own the last of those, from evidence this class never sees.
 */
export class WorkspaceRoutingHost {
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceRoutingHostOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * May this attempt be made at all?
   *
   * THE SAME QUESTION, THE SAME TRACKER, THE SAME REFUSAL as `RoutingHost.authorizeAttempt`. A
   * subscription or local binding spends no money and is allowed; a metered one is checked against
   * the ceiling with the worst case it could cost, because the only direction an unmeasured number
   * is safe to use is the one that refuses too often.
   *
   * A refusal here is the cheapest one available: no workspace is made and no process is started.
   */
  async authorizeAttempt(request: { case: WorkspaceCase; binding: ProviderBinding }): Promise<AttemptAuthorization> {
    if (!isMetered(request.binding)) return { allowed: true };
    // A METERED ROUTE WITH A SIGNED ZERO-MARGINAL-COST BASIS needs no dollar ceiling: the binding cannot
    // have been built without a current, validated observation that this account is charged nothing for
    // this exact route (`buildWorkspaceBinding`), and a ceiling enforced against $0 per attempt would stop
    // nothing. Its tokens are still recorded against the tracker after the run, at the published rate,
    // so a free tier that silently started billing is visible in the evidence and post-run reconciliation.
    if (request.binding.zeroMarginalCostBasis !== undefined) return { allowed: true };
    try {
      this.options.spend.check(request.binding, worstCaseAttemptMicroUSD(request.binding));
      return { allowed: true };
    } catch (error) {
      if (error instanceof SpendingError) {
        return {
          allowed: false,
          code: `spending.${error.code}`,
          reason: error.message,
          detail: {
            candidate: request.binding.candidate,
            provider: request.binding.provider,
            caseID: request.case.id,
            spentMicroUSD: this.options.spend.spentMicroUSD,
            ceilingMicroUSD: this.options.spend.ceilingMicroUSD ?? null,
            worstCaseNextAttemptMicroUSD: worstCaseAttemptMicroUSD(request.binding),
            meteredAttempts: this.options.spend.meteredAttempts,
          } as CanonicalValue,
        };
      }
      throw error;
    }
  }

  /**
   * Refuse, before anything is spent, a driver that cannot do what this case requires.
   *
   * A thin pass-through to `driverShortfalls`, present so a caller that wants to REPORT the refusal
   * before running — a preflight, a dry run — does not have to reach past the host for it. `run`
   * checks it again through the runner; both refusals produce the same `envelopeFailure`.
   */
  shortfallsFor(request: { case: WorkspaceCase; driver: WorkspaceAgentDriver }): string[] {
    return driverShortfalls(request.driver, request.case.execution.tools, request.case.execution.networkPolicy);
  }

  async run(request: WorkspaceHostRequest): Promise<WorkspaceOutcome> {
    const caseAllows = request.case.execution.maximumAttempts;
    const ceiling = request.attemptCeiling;
    if (ceiling !== undefined && ceiling < 1) {
      throw new WorkspaceHostError('nonPositiveAttemptCeiling',
        `an attempt ceiling of ${ceiling} would run nothing while recording a row for ${request.case.id}. `
        + 'Do not run the case at all rather than running it zero times.');
    }
    const effectiveCeiling = ceiling === undefined ? caseAllows : Math.min(ceiling, caseAllows);

    // THE CEILING IS APPLIED THROUGH THE RUNNER'S OWN CANCELLATION SEAM, not by editing the case and
    // not by a new knob inside the runner. `runWorkspaceCase` polls `shouldCancel` at the top of each
    // attempt, so raising it after the ceiling's last attempt has been RECORDED stops the loop
    // exactly where an operator asked and leaves every attempt that did happen complete.
    let recorded = 0;
    const capped = () => recorded >= effectiveCeiling;
    const shouldCancel = () => (request.shouldCancel?.() ?? false) || capped();

    const run = await runWorkspaceCase({
      case: request.case,
      driver: request.driver,
      fixtureRoot: request.fixtureRoot,
      sandboxRoot: request.sandboxRoot,
      evidenceRoot: request.evidenceRoot,
      preserveFailedWorkspaces: request.preserveFailedWorkspaces,
      environmentSource: request.environmentSource,
      // Deliberately NOT `shouldCancel`: a mid-attempt cancellation must reach the child process, and
      // the ceiling must not. `capped()` only becomes true between attempts, so the two compose, but
      // the reader should not have to work that out from the closure alone.
      shouldCancel,
      now: request.now,
      runCommand: request.runCommand,
      onAttempt: (record) => { recorded += 1; request.onAttempt?.(record); },
    });

    const scorecard = scoreWorkspaceRun(request.case, run);
    const frontier = this.frontierRecordFor(request.binding, run, scorecard);

    return {
      run,
      scorecard,
      frontier,
      plannable: workspacePlannableCaseOf(request.case, 0),
      attemptCeilingApplied: effectiveCeiling < caseAllows ? { ceiling: effectiveCeiling, caseAllows } : undefined,
    };
  }

  /**
   * Fold the driver's usage onto the record every attempt in this engine carries.
   *
   * SUMMED ACROSS ATTEMPTS, and that is the one place this differs from the prose mapping — because a
   * prose attempt IS one request and a workspace run may be several. Tokens, allowance and cost are
   * added up over every attempt that reported them; the identity and the termination reason are taken
   * from the DECIDING attempt, which is the one the scorecard scored. Summing identity would be
   * meaningless and taking the first attempt's tokens would understate the run.
   */
  private frontierRecordFor(binding: ProviderBinding, run: WorkspaceRunResult,
                            scorecard: WorkspaceScorecard): FrontierAttemptRecord {
    const usages = run.attempts
      .map((attempt) => attempt.agent.usage as WorkspaceAgentUsage | undefined)
      .filter((usage): usage is WorkspaceAgentUsage => usage !== undefined);
    const deciding = run.attempts[run.attempts.length - 1];
    const decidingUsage = deciding?.agent.usage as WorkspaceAgentUsage | undefined;

    // A SUM OVER THE ATTEMPTS THAT REPORTED, or nothing. `undefined` when no attempt reported the
    // figure at all, so a run whose tool counted nothing records an absence rather than a zero.
    const sum = (field: keyof WorkspaceAgentUsage): number | undefined => {
      const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === 'number');
      return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
    };

    const input = sum('inputTokens');
    const output = sum('visibleOutputTokens');
    const reasoning = sum('reasoningTokens');
    const counted = input !== undefined || output !== undefined;

    let costMicroUSD: number | undefined;
    let costProvenance: FrontierAttemptRecord['costProvenance'];
    if (!isMetered(binding)) {
      // Subscription and local execution have NO per-token charge. Zero is the true marginal charge;
      // the allowance beside it is a different currency and is never folded into this number.
      costMicroUSD = 0;
      costProvenance = 'measured';
    } else if (counted) {
      costMicroUSD = attemptCostMicroUSD(binding, { inputTokens: input, outputTokens: output, reasoningTokens: reasoning });
      costProvenance = 'providerReported';
    } else {
      costMicroUSD = undefined;
      costProvenance = 'unavailable';
    }

    if (isMetered(binding)) {
      // Recorded whatever happened, including on a failed run: a refused request that burned input
      // tokens still burned them, and a ceiling that ignored those is a ceiling that leaks.
      this.options.spend.record(costMicroUSD ?? 0, costProvenance === 'providerReported' ? 'providerReported' : 'estimated');
    }

    const allowance = allowanceRecord(binding, { subscriptionIncludedUsageMicroUSD: sum('subscriptionIncludedUsageMicroUSD') });

    return {
      provider: binding.provider,
      executionClass: binding.executionClass,
      billingBasis: binding.billingBasis,
      requestedModelID: binding.requestedModelID,
      // THE PROVIDER'S WORD OR NOTHING, exactly as on the prose side. Empty means the tool named
      // nobody — never a copy of what was asked for.
      reportedModelID: deciding?.agent.reportedModelID ?? '',
      // THE TWO HALVES OF IDENTITY, KEPT APART AND BOTH RECORDED.
      //
      // `bindingIdentityState` is what was known BEFORE the request — copied off the frozen binding
      // and never touched by what came back. `executionIdentityVerdict` is what THIS execution
      // established, from the same `verifyProviderIdentity` ladder the prose path uses. The first
      // live workspace run recorded `unverifiable` beside a reply that named `claude-haiku-4-5`, and
      // both were true; a reader could not tell which fact was which. Now they are two fields with
      // two names, and nothing writes the second over the first.
      bindingIdentityState: binding.identityState,
      ...executionIdentity(binding, deciding?.agent.reportedModelID ?? ''),
      inputTokens: input,
      freshInputTokens: sum('freshInputTokens'),
      cacheCreationInputTokens: sum('cacheCreationInputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      visibleOutputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: counted ? (input ?? 0) + (output ?? 0) + (reasoning ?? 0) : undefined,
      usageProvenance: counted ? 'providerReported' : 'unavailable',
      costMicroUSD,
      costProvenance,
      ...allowance,
      providerReportedGenerationMilliseconds: decidingUsage?.providerReportedDurationMilliseconds,
      // THE DECIDING ATTEMPT'S, NOT A SUM. Time to first output is a latency, and latencies do not
      // add up across attempts: two attempts that each answered in 900 ms did not take 1,800 ms to
      // answer. This engine's OWN observation is preferred over the tool's account of itself, and
      // the tool's is used only when nothing here watched a byte arrive.
      timeToFirstTokenMilliseconds: decidingUsage?.observedFirstOutputMilliseconds
        ?? decidingUsage?.providerReportedTimeToFirstTokenMilliseconds,
      // The run's retries, from the runner's own count. `WorkspaceScorecard.retriesRequired` is the
      // same number read off the same place; they cannot disagree.
      retryCount: scorecard.retriesRequired,
      // A WORKSPACE RUN'S WASTE IS MEASURED IN TOKENS HERE AND IN MILLISECONDS ON THE SCORECARD, and
      // both are real. This column is the tokens spent on attempts that did not decide the outcome.
      wastedTokens: wastedTokensOf(usages, run.attempts.length),
      timedOut: scorecard.status === 'timeout',
      rawUsage: decidingUsage?.rawUsage,
    };
  }
}

/**
 * What THIS execution established about who answered, beside what was known before it.
 *
 * Returns nothing when there was no reply to read, so a refused or unattempted run records no
 * post-run verdict at all rather than an `unverifiable` that would read as a finding. Absent and
 * "nothing confirmed it" are different records, and only one of them is true here.
 */
export function executionIdentity(binding: ProviderBinding, reportedModelID: string):
  Pick<FrontierAttemptRecord, 'executionIdentityVerdict' | 'executionIdentityDetail'> {
  if (reportedModelID.length === 0) {
    return {
      executionIdentityVerdict: 'unverifiable',
      executionIdentityDetail: `the tool named no model in its reply, so this execution confirmed nothing about `
        + `whether ${binding.requestedModelID} answered. This is a statement about THIS request, made after it; `
        + 'what was known beforehand is on `bindingIdentityState` and is unchanged by it.',
    };
  }
  const verification = verifyProviderIdentity(binding.requestedModelID, reportedModelID);
  return { executionIdentityVerdict: verification.state, executionIdentityDetail: verification.detail };
}

/**
 * Tokens spent on attempts that did not decide the outcome.
 *
 * Zero when there was one attempt, which is a true zero rather than a missing number: there was no
 * earlier attempt to have wasted anything.
 */
export function wastedTokensOf(usages: WorkspaceAgentUsage[], attemptCount: number): number {
  if (attemptCount <= 1) return 0;
  return usages.slice(0, -1).reduce((total, usage) => {
    const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const output = typeof usage.visibleOutputTokens === 'number' ? usage.visibleOutputTokens : 0;
    const reasoning = typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0;
    return total + input + output + reasoning;
  }, 0);
}

/** The identity a preflight prints: what this run is, before any of it happens. */
export function describeWorkspaceRequest(request: { case: WorkspaceCase; binding: ProviderBinding; attemptCeiling?: number }): string[] {
  const c = request.case;
  const ceiling = request.attemptCeiling === undefined
    ? `${c.execution.maximumAttempts} (the case's own ceiling)`
    : `${Math.min(request.attemptCeiling, c.execution.maximumAttempts)} (operator cap; the case allows ${c.execution.maximumAttempts})`;
  return [
    `case            ${c.id}@${c.version}  ${c.title}`,
    `digest          ${workspaceCaseDigest(c)}`,
    `comparability   ${workspaceComparabilityKey(c)}`,
    `candidate       ${request.binding.candidate} → ${request.binding.provider} · ${request.binding.requestedModelID}`,
    `billing         ${request.binding.billingBasis} (${request.binding.executionClass})`,
    `attempts        ${ceiling}`,
    `timeout         ${c.execution.timeoutMilliseconds} ms per attempt`,
    `environment     allow-list ${c.execution.environmentAllowlist.length === 0 ? '(machine names only)' : c.execution.environmentAllowlist.join(', ')}`,
    `network         ${c.execution.networkPolicy} (declared; see the driver's own enforcement report)`,
  ];
}
