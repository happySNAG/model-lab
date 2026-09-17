// The Electron side of the benchmark-engine boundary.
//
// This service owns NOTHING about how a campaign works. It resolves the campaign root, opens
// campaigns through `Campaign`, and turns their status into plain JSON for the renderer. Every rule
// — what a slot is, when a guard aborts, what counts as a pass — lives in `src/engine`, shared with
// the terminal command, so the two cannot drift apart.
//
// A campaign started in the terminal appears here because both write to the same directory, and
// this service re-reads the ledger rather than caching it. That is why "observed in the desktop UI
// without the terminal being the controller" is a property of the layout rather than of a message
// bus that has to stay up.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import {
  Campaign, CampaignBuildError, CampaignConfiguration, CampaignStatus, DEFAULT_EXECUTION_POLICY, DiscoveredFrontierModel,
  EffortLevel, ExecutionPolicy, FrontierCandidateRequest, Ledger, MIXED_EXECUTION_REASONS, NONCANONICAL_REASONS,
  PROVIDER_LABELS, ProviderID, ProviderStatus, SpendingError, allRankableSuiteIDs, anthropicBaseURL, authorizationDisclosure,
  authorizeSpending, buildCampaignPlan, buildEngineCatalogue, buildHostForCampaign, campaignPaths, credentialStatus,
  describeBinding, describeExecutionPolicy, discoverLocalModels, discoverMeteredProvider, discoverSubscriptionCLI,
  discoverOpenCodeCLI,
  estimateSpending, inspectCampaignLock, leasedEndpoints, modelCanThink, modelStoreBaseline, offlineProviderStatuses,
  openaiBaseURL, plannedWorkFor, privacyDisclosure, quantityValue, residencyDisclosure,
  REQUESTED_COHORT, configurationKey, ladderConfigurations,
} from '../engine/index';
import type { FrontierCandidateMetrics } from '../engine/frontier-metrics';
import type { FinalReport } from '../engine/campaign';
import type { VerificationReport } from '../engine/manifest';
import type { CandidateRanking } from '../engine/ranking';
import { RANKING_VIEW_LABELS } from '../engine/ranking';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../shared/product';
import type {
  CampaignRow, CampaignDetail, CampaignCreateRequest, CampaignExecutionRow, CampaignStartDisclosure,
  CohortReconciliationRow, CostPreviewRow, FrontierMetricsRow, ProviderStatusRow, TerminalCommandRow,
} from '../shared/ipc';
import { installTerminalCommand, terminalCommandStatus, uninstallTerminalCommand } from '../shared/terminal-install';

// MARK: - Projections
//
// The renderer sees plain JSON. These three functions are the ONLY place an engine record becomes a
// renderer row, so a figure the engine recorded as unavailable cannot become a zero on its way to a
// screen — the absence and its reason are carried across as an absence and a reason.

function providerRow(status: ProviderStatus): ProviderStatusRow {
  return {
    provider: status.provider,
    label: status.label,
    executionClass: status.executionClass,
    billingBasis: status.billingBasis,
    reachability: status.reachability,
    detail: status.detail,
    probe: status.probe,
    executablePath: status.executablePath,
    version: status.version,
    credential: status.credential
      ? {
        environmentVariable: status.credential.environmentVariable,
        keychainService: status.credential.keychainService,
        // Never the value, at any length. `masked` is "set · N characters", or "not set".
        masked: status.credential.masked,
        present: status.credential.present,
        remedy: status.credential.remedy,
      }
      : undefined,
    models: status.models.map((model) => ({
      provider: model.provider,
      modelID: model.modelID,
      displayName: model.displayName,
      availability: model.availability,
      evidence: model.evidence,
      verifiedModelID: model.verifiedModelID,
      desiredEfforts: model.desiredEfforts,
    })),
    checkedAt: status.checkedAt,
  };
}

function costRow(estimate: ReturnType<typeof estimateSpending>,
                 providers: { label: string; executionClass: 'localRuntime' | 'subscriptionCLI' | 'meteredAPI' }[]): CostPreviewRow {
  return {
    estimable: estimate.estimable,
    notEstimableBecause: estimate.notEstimableBecause,
    perCandidate: estimate.perCandidate.map((entry) => ({
      candidate: entry.candidate,
      billingBasis: entry.billingBasis,
      plannedAttempts: entry.plannedAttempts,
      minimumMicroUSD: entry.minimumMicroUSD,
      maximumMicroUSD: entry.maximumMicroUSD,
      statement: entry.statement,
    })),
    totalMinimumMicroUSD: estimate.totalMinimumMicroUSD,
    totalMaximumMicroUSD: estimate.totalMaximumMicroUSD,
    meteredCandidateCount: estimate.meteredCandidateCount,
    subscriptionCandidateCount: estimate.subscriptionCandidateCount,
    localCandidateCount: estimate.localCandidateCount,
    oldestPricingCapturedAt: estimate.oldestPricingCapturedAt,
    disclosure: authorizationDisclosure(estimate, 0),
    privacyDisclosure: privacyDisclosure(providers),
  };
}

/**
 * A candidate's metrics, with every absence kept as an absence.
 *
 * `absences` is the field that makes this honest. A screen that simply omitted an unavailable figure
 * would show a blank cell, and a blank cell reads as zero. Carrying the REASON across means the
 * interface can say "the provider reported no token count" where the number would have been.
 */
function metricsRow(metrics: FrontierCandidateMetrics): FrontierMetricsRow {
  const absences: { field: string; reason: string }[] = [];
  const value = (field: string, quantity: { provenance: string; value?: number; note?: string }): number | undefined => {
    if (quantity.provenance === 'unavailable') {
      absences.push({ field, reason: quantity.note ?? 'not known' });
      return undefined;
    }
    return quantity.value;
  };
  return {
    candidate: metrics.candidate,
    provider: metrics.provider,
    requestedModelID: metrics.requestedModelID,
    reportedModelID: metrics.reportedModelID,
    identityState: metrics.identityState,
    identityDisclosure: metrics.identityDisclosure,
    identityDisclosureRequired: metrics.identityDisclosureRequired,
    executionClass: metrics.executionClass,
    billingBasis: metrics.billingBasis,
    attemptCount: metrics.attemptCount,
    successfulTaskCount: metrics.successfulTaskCount,
    successfulTaskRateMilli: value('successful-task rate', metrics.successfulTaskRateMilli),
    inputTokens: value('input tokens (all, cached and fresh)', metrics.inputTokens),
    freshInputTokens: value('fresh input tokens', metrics.freshInputTokens),
    cacheCreationInputTokens: value('cache-creation input tokens', metrics.cacheCreationInputTokens),
    cacheReadInputTokens: value('cache-read input tokens', metrics.cacheReadInputTokens),
    visibleOutputTokens: value('visible output tokens', metrics.visibleOutputTokens),
    reasoningTokens: value('reasoning tokens', metrics.reasoningTokens),
    totalTokens: value('total tokens', metrics.totalTokens),
    medianProviderReportedGenerationTokensPerSecondMilli:
      value('provider-reported generation speed', metrics.medianProviderReportedGenerationTokensPerSecondMilli),
    medianClientObservedOutputTokensPerSecondMilli:
      value('client-observed output throughput', metrics.medianClientObservedOutputTokensPerSecondMilli),
    medianEndToEndOutputTokensPerSecondMilli:
      value('end-to-end output throughput', metrics.medianEndToEndOutputTokensPerSecondMilli),
    medianTimeToFirstVisibleTokenMilliseconds: value('time to first visible token', metrics.medianTimeToFirstVisibleTokenMilliseconds),
    costPerRunMicroUSD: value('marginal API charge per run', metrics.costPerRunMicroUSD),
    subscriptionIncludedUsageMicroUSD: value('subscription allowance consumed', metrics.subscriptionIncludedUsageMicroUSD),
    effectiveUserCostMicroUSD: value('effective cost to you', metrics.effectiveUserCostMicroUSD),
    costPerSuccessfulTaskMicroUSD: value('cost per successful task', metrics.costPerSuccessfulTaskMicroUSD),
    tokensPerCompletedPass: value('tokens per completed pass', metrics.tokensPerCompletedPass),
    wastedTokens: value('wasted tokens', metrics.wastedTokens),
    retryCount: metrics.retryCount,
    timeoutCount: metrics.timeoutCount,
    providerReportedTotalTokens: quantityValue(metrics.providerReportedTotalTokens),
    estimatedTotalTokens: quantityValue(metrics.estimatedTotalTokens),
    reportedMinusEstimatedTokens: quantityValue(metrics.reportedMinusEstimatedTokens),
    measurementQuality: metrics.measurementQuality,
    absences,
  };
}

/** One ranking row, shaped once. Both tables use it, so neither can drift from the other. */
function rankingRow(ranking: CandidateRanking) {
  return {
    rank: ranking.rank,
    candidate: ranking.candidate,
    disqualified: ranking.disqualified,
    passRateMilli: 'measured' in ranking.overallPassRateMilli ? ranking.overallPassRateMilli.measured : undefined,
    scoredCount: ranking.scoredCount,
    roles: ranking.roles.filter((role) => role.qualified).map((role) => role.role),
    promotable: ranking.promotable,
    notPromotableBecause: ranking.notPromotableBecause,
  };
}

export class CampaignServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignServiceError';
  }
}

export class CampaignService extends EventEmitter {
  private active?: { name: string; pause: () => void };

  constructor(private readonly endpoint: () => string) {
    super();
  }

  /** The same path `cernum` computes, so both see the same campaigns. */
  root(): string {
    return process.env.MODEL_LAB_CAMPAIGN_ROOT ?? path.join(app.getPath('userData'), CAMPAIGN_DIRECTORY_NAME);
  }

  private directory(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new CampaignServiceError(`campaign name '${name}' is not filesystem-safe`);
    return path.join(this.root(), name);
  }

  private configuration(name: string): CampaignConfiguration {
    const file = path.join(this.directory(name), 'configuration.json');
    if (!fs.existsSync(file)) throw new CampaignServiceError(`no configuration.json for campaign '${name}'`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CampaignConfiguration;
  }

  private executionOf(configuration: CampaignConfiguration): ExecutionPolicy {
    return configuration.execution ?? DEFAULT_EXECUTION_POLICY;
  }

  /**
   * Open a campaign with a host configured the way the campaign was FROZEN.
   *
   * `enableResidency` is the fix for the release-blocking defect: this service used to build its
   * host without it, so `LiveResidency` was disabled and the end-of-candidate release threw
   * `LiveResidencyDisabled` out of `run()` — every desktop-started live campaign ended in an error
   * rather than a result. Cernum is an active benchmark controller: for a canonical campaign it is
   * authorised to manage residency on the selected benchmark endpoint, and that authority is
   * disclosed at Start rather than assumed silently. For an observe-only campaign it stays off, and
   * the campaign is labelled noncanonical everywhere it appears.
   */
  private open(name: string, context: { authorization?: ReturnType<Campaign['readAuthorization']>; priorRows?: Record<string, unknown>[]; shouldCancel?: () => boolean } = {}): Campaign {
    const configuration = this.configuration(name);
    // THE SAME FACTORY THE TERMINAL CALLS. Not an equivalent host built here: the same function, so
    // a campaign started from this screen and the same campaign resumed in a terminal cannot be
    // configured two different ways. That divergence is exactly the defect Pass 3 shipped.
    const built = buildHostForCampaign(configuration, {
      endpoint: this.endpoint(),
      catalogue: buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase),
      authorization: context.authorization,
      priorRows: context.priorRows,
      shouldCancel: context.shouldCancel,
    });
    return Campaign.open(this.directory(name), configuration, built.host);
  }

  private executionRow(execution: ExecutionPolicy): CampaignExecutionRow {
    const canonical = execution.residency === 'managed';
    return {
      residency: execution.residency,
      thinkingMode: execution.thinkingMode,
      canonical,
      summary: describeExecutionPolicy(execution),
      noncanonicalBecause: canonical ? [] : NONCANONICAL_REASONS,
    };
  }

  /**
   * What to tell a person before this campaign starts. Read once, at Start.
   *
   * Authored in the engine and merely relayed here, so the terminal and the interface cannot drift
   * into two different accounts of the same authority.
   */
  disclosure(name: string): CampaignStartDisclosure {
    const configuration = this.configuration(name);
    const execution = this.executionOf(configuration);
    const endpoint = this.endpoint();
    const candidates = configuration.candidates.map((candidate) => candidate.name);
    return {
      name,
      endpoint,
      candidates,
      canonical: execution.residency === 'managed',
      lines: execution.residency === 'managed' ? residencyDisclosure(endpoint, candidates) : NONCANONICAL_REASONS,
    };
  }

  leasedEndpoints(): { endpoint: string; campaignName: string; processType: string; pid: number; state: string; message: string }[] {
    return leasedEndpoints(this.root())
      .filter((lease) => lease.record?.endpoint)
      .map((lease) => ({
        endpoint: lease.record!.endpoint!,
        campaignName: lease.record!.campaignName,
        processType: lease.record!.processType,
        pid: lease.record!.pid,
        state: lease.state ?? 'live',
        message: lease.message,
      }));
  }

  /**
   * Every campaign on disk, read fresh.
   *
   * Read from the LEDGER rather than from an in-memory index: a campaign the terminal is running
   * right now has no object in this process, and an index would show it as it was when the
   * application started.
   */
  list(): CampaignRow[] {
    const root = this.root();
    if (!fs.existsSync(root)) return [];
    const rows: CampaignRow[] = [];
    for (const name of fs.readdirSync(root).sort()) {
      const directory = path.join(root, name);
      if (!Campaign.exists(directory)) continue;
      try {
        const ledger = Ledger.open(campaignPaths(directory).ledger);
        const reconciliation = ledger.reconcile();
        const meta = ledger.meta();
        const abort = ledger.standingAbort();
        // Read from the lock file, not from this process's memory: a campaign the terminal is
        // running has no object here, and showing it as idle while it advances is the exact
        // confusion the lock exists to remove.
        const lock = inspectCampaignLock(directory);
        rows.push({
          name,
          label: typeof meta.label === 'string' ? meta.label : name,
          state: reconciliation.complete ? 'complete'
            : lock.held && (lock.state === 'live' || lock.state === 'selfHeld') ? 'running'
              : abort ? 'aborted' : reconciliation.terminal === 0 ? 'created' : 'paused',
          slotCount: reconciliation.slotCount,
          terminalCount: reconciliation.terminal,
          blockedCount: reconciliation.blocked,
          balances: reconciliation.balances,
          manifestID: typeof meta.manifestID === 'string' ? meta.manifestID : '',
          createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
          running: this.active?.name === name,
          directory,
          execution: this.executionRow(this.executionOf(
            JSON.parse(fs.readFileSync(path.join(directory, 'configuration.json'), 'utf8')) as CampaignConfiguration)),
          // Read from the LEDGER's own meta, written at creation, so a campaign can be labelled
          // without opening and parsing its manifest on every three-second refresh.
          providers: Array.isArray(meta.providers) ? (meta.providers as string[]) : undefined,
          mixedExecution: meta.mixedExecution === true,
          hasMeteredBinding: meta.hasMeteredBinding === true,
          manifestFormatVersion: typeof meta.manifestFormatVersion === 'number' ? meta.manifestFormatVersion : 3,
          owner: lock.held && lock.record ? {
            processType: lock.record.processType, command: lock.record.command, pid: lock.record.pid,
            hostname: lock.record.hostname, acquiredAt: lock.record.acquiredAt,
            state: lock.state ?? 'live', message: lock.message,
          } : undefined,
        });
      } catch (error) {
        // A campaign directory that cannot be read is reported, never skipped silently: a
        // disappeared campaign is exactly the thing a person needs to be told about.
        rows.push({
          name, label: name, state: 'unreadable', slotCount: 0, terminalCount: 0, blockedCount: 0, balances: false,
          manifestID: '', createdAt: '', running: false, directory,
          problem: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  }

  detail(name: string): CampaignDetail {
    const campaign = this.open(name);
    const status = campaign.status(this.active?.name === name ? 'running' : undefined);
    const paths = campaignPaths(this.directory(name));
    const report = fs.existsSync(paths.report) ? JSON.parse(fs.readFileSync(paths.report, 'utf8')) as FinalReport : undefined;
    return {
      status: status as CampaignStatus,
      execution: this.executionRow(campaign.execution),
      manifest: {
        manifestID: campaign.manifest.manifestID,
        seal: status.manifestSeal,
        frozenAt: campaign.manifest.frozenAt,
        promptCount: campaign.manifest.promptDigests.length,
        candidateCount: campaign.manifest.candidates.length,
        retestOf: campaign.manifest.retestOf?.manifestID,
      },
      recentAttempts: [...campaign.ledger.results.values()]
        .sort((a, b) => b.seq - a.seq).slice(0, 25)
        .map((result) => ({
          slotKey: result.slotKey,
          status: result.status,
          detail: typeof result.detail === 'string' ? result.detail : '',
          latencyMilliseconds: typeof result.latencyMilliseconds === 'number' ? result.latencyMilliseconds : undefined,
          identityState: typeof result.identityState === 'string' ? result.identityState : 'unverifiable',
          suppliedContextState: typeof result.suppliedContextState === 'string' ? result.suppliedContextState : 'notSupplied',
          bindingIdentityState: typeof result.bindingIdentityState === 'string' ? result.bindingIdentityState : undefined,
          identityAdmissionStamp: typeof result.identityAdmissionStamp === 'string' ? result.identityAdmissionStamp : undefined,
          jsonSemanticSchemaStatus: typeof result.jsonSemanticSchemaStatus === 'string' ? result.jsonSemanticSchemaStatus : undefined,
          jsonViewsDivergent: result.jsonViewsDivergent === true,
          jsonViewsDivergenceExplanation: typeof result.jsonViewsDivergenceExplanation === 'string'
            ? result.jsonViewsDivergenceExplanation : undefined,
          jsonFenceRemoved: result.jsonFenceRemoved === true,
        })),
      events: campaign.ledger.events().slice(-40).map((event) => ({ kind: String(event.kind), at: String(event.at) })),
      anomalies: campaign.ledger.anomalies.map((anomaly) => ({ kind: anomaly.kind, why: anomaly.why ?? '' })),
      report: report ? {
        canonical: report.canonical ?? true,
        noncanonicalBecause: report.noncanonicalBecause ?? [],
        provisional: report.rankings.provisional,
        provisionalBecause: report.rankings.provisionalBecause,
        rankings: (report.rankings.rankings ?? []).map(rankingRow),
        rankingsViewLabel: report.rankings.viewLabel ?? RANKING_VIEW_LABELS.strictTransport,
        // Always sent, even when the two agree. A renderer that received it only on a divergence
        // could not tell "they agreed" from "this report predates the second reading".
        rankingsSemanticJSONView: (report.rankingsSemanticJSONView?.rankings ?? []).map(rankingRow),
        rankingsSemanticViewLabel: report.rankingsSemanticJSONView?.viewLabel ?? RANKING_VIEW_LABELS.semanticSchema,
        jsonViewDivergences: report.rankings.divergences ?? [],
        retentionHeading: report.retention.heading,
        retention: report.retention.recommendations.map((recommendation) => ({ candidate: recommendation.candidate, outcome: recommendation.outcome, statement: recommendation.statement })),
        awaitingHumanReview: report.humanReview.awaiting,
        packetPath: report.humanReview.packetPath,
        packetClean: report.humanReview.audit?.clean,
      } : undefined,
      bindings: (campaign.operationalEnvelope?.bindings ?? []).map((binding) => ({
        candidate: binding.candidate,
        provider: binding.provider,
        providerLabel: PROVIDER_LABELS[binding.provider],
        executionClass: binding.executionClass,
        billingBasis: binding.billingBasis,
        requestedModelID: binding.requestedModelID,
        verifiedModelID: binding.verifiedModelID,
        identityState: binding.identityState,
        identityEvidence: binding.identityEvidence,
        effort: binding.effort,
        thinkingMode: binding.thinkingMode,
        maxInputTokens: binding.maxInputTokens,
        maxOutputTokens: binding.maxOutputTokens,
        timeoutMilliseconds: binding.timeoutMilliseconds,
        maxRetries: binding.retry.maxRetries,
        summary: describeBinding(binding),
        pricing: binding.pricing
          ? {
            source: binding.pricing.source,
            capturedAt: binding.pricing.capturedAt,
            inputMicroUSDPerMillionTokens: binding.pricing.inputMicroUSDPerMillionTokens,
            outputMicroUSDPerMillionTokens: binding.pricing.outputMicroUSDPerMillionTokens,
          }
          : undefined,
      })),
      mixedExecutionBecause: campaign.operationalEnvelope?.mixed === true ? MIXED_EXECUTION_REASONS : [],
      // From the campaign's own status, so it is present the moment the campaign exists rather than
      // only once a report has been written.
      admittedWithoutProvenIdentity: status.admittedWithoutProvenIdentity,
      frontierMetrics: (report?.frontierMetrics ?? []).map(metricsRow),
      // Read LIVE, not only from a finalized report. Whether a campaign is authorised to spend money
      // matters most BEFORE it runs — which is precisely when no report exists yet. Showing it only
      // afterwards would hide the one fact a person needs while they can still act on it.
      spending: this.spendingRow(name, campaign),
      manifestFormatVersion: campaign.manifest.manifestFormatVersion,
      terminalHint: `${TERMINAL_COMMAND} status ${name} --root ${this.root()}`,
    };
  }

  /**
   * What this campaign is authorised to spend and what it has spent, read off disk.
   *
   * Absent entirely when nothing in the campaign is billed per token: a local or subscription
   * campaign has no dollar figure to show, and inventing a zero-cost spending panel for one would
   * imply a ceiling that does not govern anything.
   */
  private spendingRow(name: string, campaign: Campaign) {
    const configuration = this.configuration(name);
    if (configuration.operationalEnvelope?.hasMeteredBinding !== true) return undefined;
    const authorization = campaign.readAuthorization();
    const rows = campaign.ledgerRows().filter((row) => row.billingBasis === 'meteredAPI');
    return {
      authorized: authorization !== undefined,
      hardCeilingMicroUSD: authorization?.hardCeilingMicroUSD,
      recordedMicroUSD: rows.reduce((sum, row) => sum + (typeof row.costMicroUSD === 'number' ? row.costMicroUSD : 0), 0),
      meteredAttempts: rows.length,
      stoppedAtCeiling: campaign.ledger.standingAbort()?.stage === 'spendingAuthorization',
    };
  }

  // ------------------------------------------------------------------ providers

  /**
   * Every provider's status WITHOUT contacting any of them.
   *
   * This is what the Providers screen calls on open and on every refresh. It performs a PATH lookup
   * and a credential check and NOTHING else — no request, no CLI invocation, no rate-limit slot.
   * Opening the application therefore sends zero provider requests, which is asserted in the tests
   * rather than merely intended.
   */
  providerStatuses(): ProviderStatusRow[] {
    const cached = this.readDiscovered();
    return offlineProviderStatuses().map((status) => providerRow({
      ...status,
      models: cached.filter((model) => model.provider === status.provider),
    }));
  }

  /**
   * The 12 configurations this project asked for, each next to what is currently known about it.
   *
   * READS THE REQUEST, NOT THE RESULTS. Every other provider view on this screen starts from what
   * discovery found and renders that; this one starts from what was ASKED FOR and reports anything
   * that is no longer there. Pass 5B shipped a cohort missing two explicitly required models and
   * nothing anywhere went red, because a screen showing found-models cannot show a missing question.
   *
   * Contacts nothing: the request is a constant and the availability comes from the same cached
   * discovery file the rest of the screen reads.
   */
  requestedCohort(): CohortReconciliationRow {
    const cached = this.readDiscovered();
    const ladder = new Set(ladderConfigurations().map(configurationKey));
    const requested = REQUESTED_COHORT.map((entry) => {
      const found = cached.find((model) => model.provider === entry.provider && model.modelID === entry.modelID);
      return {
        provider: entry.provider,
        modelID: entry.modelID,
        displayName: entry.displayName,
        effort: entry.effort,
        inLadder: ladder.has(configurationKey(entry)),
        availability: found?.availability ?? ('unknown' as const),
        verifiedModelID: found?.verifiedModelID ?? '',
      };
    });
    return {
      requested,
      complete: requested.every((row) => row.inLadder),
      missingCount: requested.filter((row) => !row.inLadder).length,
      provenCount: requested.filter((row) => row.availability === 'proven').length,
      requestedCount: requested.length,
    };
  }

  /** Where discovery's findings are kept. Beside the campaigns, so the terminal reads the same file. */
  private discoveryPath(): string {
    return path.join(this.root(), '.providers', 'discovered.json');
  }

  private readDiscovered(): DiscoveredFrontierModel[] {
    const file = this.discoveryPath();
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: DiscoveredFrontierModel[] };
      return Array.isArray(parsed.models) ? parsed.models : [];
    } catch {
      return [];
    }
  }

  private writeDiscovered(models: DiscoveredFrontierModel[]): void {
    const file = this.discoveryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ writtenAt: new Date().toISOString(), models }, null, 2) + '\n', 'utf8');
  }

  /** Ask one provider what it is and what this account may call. THIS INVOKES SOMETHING. */
  async discoverProvider(provider: string): Promise<ProviderStatusRow> {
    let status: ProviderStatus;
    if (provider === 'claudeCLI' || provider === 'codexCLI') {
      status = await discoverSubscriptionCLI(provider);
    } else if (provider === 'opencodeCLI') {
      // OPENCODE IS A CLI, AND METERED. It belongs to neither branch beside it: the subscription
      // path would read an auth surface it does not have, and the metered path refuses it outright
      // because it carries no API-key environment variable to read. It gets its own.
      status = await discoverOpenCodeCLI();
    } else if (provider === 'anthropicAPI' || provider === 'openaiAPI') {
      status = await discoverMeteredProvider(provider, {
        baseURL: provider === 'anthropicAPI' ? anthropicBaseURL() : openaiBaseURL(),
      });
    } else {
      throw new CampaignServiceError(`'${provider}' is not a provider Cernum can discover`);
    }
    const kept = this.readDiscovered().filter((model) => model.provider !== provider);
    this.writeDiscovered([...kept, ...status.models]);
    return providerRow(status);
  }

  // ------------------------------------------------------------------ money

  /** Turn a create request into the frontier candidates the shared builder wants. */
  private frontierRequests(request: CampaignCreateRequest): FrontierCandidateRequest[] {
    return (request.frontier ?? []).map((selection) => {
      const provider = selection.provider as ProviderID;
      // `credentialStatus` reads an API-key environment variable, which only these two have.
      // OpenCode is metered too, but authenticates itself and would THROW here.
      const readsAnAPIKey = provider === 'anthropicAPI' || provider === 'openaiAPI';
      const credential = readsAnAPIKey ? credentialStatus(provider) : undefined;
      return {
        // The effort is in the NAME, because a model at high effort and the same model at max effort
        // are two experiments and must never share a row, a rate or a cost.
        name: selection.effort === 'none' ? `${provider}:${selection.modelID}` : `${provider}:${selection.modelID}@${selection.effort}`,
        provider,
        modelID: selection.modelID,
        effort: selection.effort as EffortLevel,
        thinkingMode: selection.thinkingMode ?? request.thinkingMode ?? 'disabled',
        pricing: selection.pricing
          ? {
            source: selection.pricing.source,
            capturedAt: selection.pricing.capturedAt,
            currency: 'USD' as const,
            inputMicroUSDPerMillionTokens: selection.pricing.inputMicroUSDPerMillionTokens,
            outputMicroUSDPerMillionTokens: selection.pricing.outputMicroUSDPerMillionTokens,
            reasoningMicroUSDPerMillionTokens: selection.pricing.reasoningMicroUSDPerMillionTokens ?? null,
          }
          : undefined,
        authorizationMode: credential === undefined ? undefined
          : credential.source === 'keychain' ? 'apiKeyKeychain' as const : 'apiKeyEnvironment' as const,
      };
    });
  }

  /**
   * What this selection WOULD cost, without creating anything.
   *
   * Built by the same builder that would freeze it, so the preview prices the campaign that would
   * actually be created rather than an approximation of it.
   */
  async previewCost(request: CampaignCreateRequest): Promise<CostPreviewRow> {
    const endpoint = this.endpoint();
    const installed = request.modelNames.length > 0 ? await discoverLocalModels(endpoint) : [];
    try {
      const built = buildCampaignPlan({
        label: request.label || request.name,
        suiteIDs: request.suiteIDs.length > 0 ? request.suiteIDs : allRankableSuiteIDs(),
        repeatsPerCase: Math.max(1, request.repeatsPerCase),
        local: request.modelNames.map((wanted) => {
          const found = installed.find((model) => model.name === wanted || model.name === `${wanted}:latest`);
          if (!found) throw new CampaignServiceError(`model '${wanted}' is not installed at ${endpoint}`);
          return { name: found.name, modelID: found.name, runtimeDigest: found.runtimeDigest, parameterSize: found.parameterSize, quantization: found.quantization };
        }),
        frontier: this.frontierRequests(request),
        observeOnly: request.observeOnly === true,
        thinkingMode: request.thinkingMode ?? 'disabled',
        endpoint,
        hardware: this.hardware(),
        runtimeVersion: request.runtimeVersion || 'ollama-unreported',
        storeBaseline: request.modelNames.length > 0 ? modelStoreBaseline(installed) : undefined,
        provenModels: this.readDiscovered(),
      });
      return costRow(estimateSpending(built.envelope, built.plannedWork), built.envelope.bindings.map((binding) => ({
        label: PROVIDER_LABELS[binding.provider], executionClass: binding.executionClass,
      })));
    } catch (error) {
      if (error instanceof CampaignBuildError) throw new CampaignServiceError(error.message);
      throw error;
    }
  }

  /** What a created campaign is estimated to cost, and whether it has been authorised. */
  campaignCost(name: string): CostPreviewRow & { authorized: boolean; hardCeilingMicroUSD?: number } {
    const configuration = this.configuration(name);
    const envelope = configuration.operationalEnvelope;
    const authorization = this.open(name).readAuthorization();
    if (!envelope) {
      return {
        ...costRow(estimateSpending({ bindings: [], executionClasses: [], providers: [], mixed: false, hasMeteredBinding: false }, []), []),
        estimable: true,
        notEstimableBecause: [],
        disclosure: ['This campaign binds no providers: it runs on the local runtime, which has no monetary cost. '
          + 'Wall-clock time is still recorded, and no electricity cost is invented.'],
        authorized: false,
      };
    }
    const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
    const work = plannedWorkFor(catalogue, configuration.candidates.map((candidate) => candidate.name), configuration.repeatsPerCase);
    return {
      ...costRow(estimateSpending(envelope, work), envelope.bindings.map((binding) => ({
        label: PROVIDER_LABELS[binding.provider], executionClass: binding.executionClass,
      }))),
      authorized: authorization !== undefined,
      hardCeilingMicroUSD: authorization?.hardCeilingMicroUSD,
    };
  }

  /**
   * Record explicit authorization for paid execution, with a hard ceiling, before any run.
   *
   * Written to the campaign directory and read back by the run, so it survives a resume, a crash and
   * a change of surface: a campaign authorised here is authorised for the terminal too, at the same
   * ceiling, because both read the same file.
   */
  authorize(name: string, ceilingMicroUSD: number): CampaignDetail {
    const configuration = this.configuration(name);
    const envelope = configuration.operationalEnvelope;
    if (!envelope || !envelope.hasMeteredBinding) {
      throw new CampaignServiceError(`${name} has no metered candidate, so there is nothing to authorise. `
        + 'Subscription and local execution are not billed per token and are not governed by a dollar ceiling.');
    }
    const campaign = this.open(name);
    const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
    const work = plannedWorkFor(catalogue, configuration.candidates.map((candidate) => candidate.name), configuration.repeatsPerCase);
    try {
      campaign.writeAuthorization(authorizeSpending(estimateSpending(envelope, work), {
        campaignID: campaign.campaignID,
        authorizedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        authorizedBy: `${PRODUCT.name} ${PRODUCT.version} · Campaigns screen`,
        hardCeilingMicroUSD: ceilingMicroUSD,
        operationalEnvelopeDigest: campaign.manifest.operationalEnvelopeDigest ?? '',
      }));
    } catch (error) {
      if (error instanceof SpendingError) throw new CampaignServiceError(error.message);
      throw error;
    }
    return this.detail(name);
  }

  private hardware() {
    return {
      platform: process.platform, architecture: process.arch, model: os.hostname(),
      cpuCoreCount: os.cpus().length, physicalMemoryBytes: os.totalmem(), osVersion: `${os.type()} ${os.release()}`,
    };
  }

  verify(name: string): VerificationReport {
    return this.open(name).verify();
  }

  async availableSuites(): Promise<{ id: string; title: string; caseCount: number }[]> {
    const catalogue = buildEngineCatalogue(allRankableSuiteIDs(), 1);
    return catalogue.suites.map((suite) => ({ id: suite.id.raw, title: suite.title, caseCount: suite.cases.length }));
  }

  async create(request: CampaignCreateRequest): Promise<CampaignRow[]> {
    const directory = this.directory(request.name);
    if (Campaign.exists(directory)) throw new CampaignServiceError(`a campaign already exists at ${directory}`);
    const endpoint = this.endpoint();
    const installed = request.modelNames.length > 0 ? await discoverLocalModels(endpoint) : [];
    const thinkingMode = request.thinkingMode ?? 'disabled';

    const local = request.modelNames.map((wanted) => {
      const found = installed.find((model) => model.name === wanted || model.name === `${wanted}:latest`);
      if (!found) throw new CampaignServiceError(`model '${wanted}' is not installed at ${endpoint}`);
      // Refused at create, before anything is frozen. Substituting thinking-off would record
      // answers to a different experiment under a manifest that says otherwise.
      if (thinkingMode === 'enabled' && modelCanThink(found) === false) {
        throw new CampaignServiceError(
          `Thinking was requested, but ${endpoint} reports that ${found.name} cannot think `
          + `(it reports: ${(found.capabilities ?? []).join(', ') || 'nothing'}). Nothing was created. `
          + 'Choose a thinking-capable model, or turn thinking off for this campaign.');
      }
      return { name: found.name, modelID: found.name, runtimeDigest: found.runtimeDigest, parameterSize: found.parameterSize, quantization: found.quantization };
    });

    // THE SAME BUILDER THE TERMINAL CALLS, with the same inputs. Two surfaces building a frozen
    // configuration separately would not merely behave differently — they would produce different
    // manifest IDENTITIES for the same request, which is the one thing a frozen manifest exists to
    // make impossible.
    let built;
    try {
      built = buildCampaignPlan({
        label: request.label || request.name,
        suiteIDs: request.suiteIDs.length > 0 ? request.suiteIDs : allRankableSuiteIDs(),
        repeatsPerCase: Math.max(1, request.repeatsPerCase),
        local,
        frontier: this.frontierRequests(request),
        observeOnly: request.observeOnly === true,
        thinkingMode,
        endpoint,
        hardware: this.hardware(),
        runtimeVersion: request.runtimeVersion || 'ollama-unreported',
        storeBaseline: request.modelNames.length > 0 ? modelStoreBaseline(installed) : undefined,
        provenModels: this.readDiscovered(),
      });
    } catch (error) {
      if (error instanceof CampaignBuildError) throw new CampaignServiceError(error.message);
      throw error;
    }

    const configuration = built.configuration;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');
    Campaign.create(directory, configuration, buildHostForCampaign(configuration, {
      endpoint, catalogue: built.catalogue,
    }).host);
    return this.list();
  }

  /** Start (or resume) a campaign in this process. One at a time: two runners would race the ledger. */
  async start(name: string): Promise<CampaignStatus> {
    if (this.active) throw new CampaignServiceError(`${this.active.name} is already running; only one campaign runs at a time so two runners cannot race the same ledger`);
    let pausing = false;

    // Read the ledger and the authorization off disk BEFORE building the host with them, so a
    // spending ceiling is enforced against everything this campaign has already spent rather than
    // restarting at zero every time somebody presses Resume.
    const reading = this.open(name);
    const authorization = reading.readAuthorization();
    const priorRows = reading.ledgerRows();
    const configuration = this.configuration(name);
    if (configuration.operationalEnvelope?.hasMeteredBinding && !authorization) {
      throw new CampaignServiceError(`${name} has metered candidates and no recorded spending authorization, so `
        + 'nothing was run and nothing was sent. Authorize it explicitly, with a hard ceiling, first.');
    }

    const campaign = this.open(name, { authorization, priorRows, shouldCancel: () => pausing });
    this.active = { name, pause: () => { pausing = true; } };
    try {
      return await campaign.run({
        shouldPause: () => pausing,
        // The in-process guard above stops two windows of THIS application; the campaign lock is
        // what stops this application and a terminal, which no amount of in-process state can see.
        owner: { processType: 'desktop', command: `${PRODUCT.name} ${PRODUCT.version} · Campaigns screen` },
        // The runtime lease lives beside the campaigns, so a campaign the terminal is running
        // against this endpoint refuses this one before a single request is sent.
        campaignRootDirectory: this.root(),
        onProgress: (status, trace) => this.emit('campaignProgress', { status, trace }),
      });
    } finally {
      this.active = undefined;
      this.emit('campaignProgress', { status: campaign.status(), trace: undefined });
    }
  }

  /** Ask the running campaign to stop at the next attempt boundary. The attempt in flight completes. */
  pause(): void {
    this.active?.pause();
  }

  finalize(name: string, blindingSecret: string): FinalReport {
    const campaign = this.open(name);
    return campaign.finalize({ blindingSecret, authorization: campaign.readAuthorization() });
  }

  activeName(): string | undefined {
    return this.active?.name;
  }

  productName(): string {
    return PRODUCT.name;
  }

  // ------------------------------------------------------------------ the installed terminal command

  terminalCommand(): TerminalCommandRow {
    return terminalCommandStatus();
  }

  /** Writes one file into a directory the user owns. Never PATH, never a profile, never elevated. */
  installTerminalCommand(): TerminalCommandRow {
    return installTerminalCommand();
  }

  /** Removes exactly the file `installTerminalCommand` wrote, identified by its marker. */
  uninstallTerminalCommand(): TerminalCommandRow {
    return uninstallTerminalCommand();
  }
}
