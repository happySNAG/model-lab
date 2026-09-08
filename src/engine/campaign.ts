// Benchmark engine · the campaign orchestrator. THIS IS THE BOUNDARY.
//
// The Electron main process and the terminal command both drive a campaign through this class and
// nothing else. Neither of them reaches past it into the ledger, the guards or the manifest. That
// is the whole point of the boundary: there is exactly one implementation of "what a campaign is",
// so a run started in the terminal and a run started in the desktop application are the same run,
// observable from either.
//
// THE ORDER OF OPERATIONS IS THE SAFETY MODEL, and it is fixed:
//
//   create      freeze the manifest, then write the plan. Both before a single request.
//   resume      verify the manifest still holds, THEN clear the standing abort, THEN plan the
//               remaining slots. A resume that skipped verification would silently continue a
//               campaign whose benchmark had changed underneath it.
//   per-attempt guards -> identity -> supplied context -> execute -> telemetry -> score -> append
//               -> checkpoint. Anything that fails before `execute` blocks the slot rather than
//               recording a result for it: a slot that was never attempted must never carry an
//               outcome.
//   transition  unload and PROVE zero residency before the next candidate loads.
//   finalize    reconcile, rank, then interpret. In that order, so an unreconciled ledger cannot
//               produce a confident ranking.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, digestObject } from './canonical';
import { Ledger, LedgerError, PlanSlot, PlannableCandidate, Reconciliation, TerminalSlotStatus, atomicWriteJSON } from './ledger';
import { EngineCatalogue, buildEngineCatalogue, evaluatorBindings } from './catalogue';
import { FrozenManifest, HardwareIdentity, ManifestCandidate, VerificationReport, deriveRetestManifest, freezeManifest, manifestSeal, verifyManifest } from './manifest';
import { DEFAULT_GUARD_POLICY, GuardPolicy, GuardVerdict, StoreBaseline, SystemReading, describeBreach, evaluateGuards } from './guards';
import { ResidencyController, ResidencyError, ResidencyProof, unloadAndVerify } from './residency';
import { ModelIdentityVerification, ObservedModelIdentity, SuppliedContextVerification, identityPermitsExecution, suppliedContextIsUsable, verifyModelIdentity, verifySuppliedContext } from './verification';
import { AttemptTelemetry, RuntimeReportedTiming, StreamEvent, explainEmptyAnswer, summariseAttempt } from './attempt-telemetry';
import { FinalRankings, outcomesFromLedger, rankCandidates } from './ranking';
import { RetentionReport, recommendRetention } from './retention';
import { AdjudicableResponse, BlindedPacket, PacketAudit, PacketKey, auditPacket, buildBlindedPacket } from './blinded';

export const CAMPAIGN_FORMAT_VERSION = 1;

export class CampaignError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CampaignError';
  }
}

// MARK: - What the engine asks of its host

/** One model's answer, as the adapter produced it. The engine never talks to a runtime itself. */
export interface AttemptOutcome {
  answerText: string;
  /** The context the request actually carried, read back out of the assembled request. */
  assembledContext?: string;
  streamEvents: StreamEvent[];
  runtime: RuntimeReportedTiming;
  totalElapsedMilliseconds?: number;
  /** Set when the adapter itself failed, as opposed to the model answering badly. */
  failure?: { code: string; detail: string };
}

export interface AttemptRequest {
  slot: PlanSlot;
  promptText: string;
  suppliedContext?: string;
  maxOutputTokens: number;
}

/**
 * Everything the engine needs from the outside world, in one injectable object. A campaign driven
 * by fakes and a campaign driven by a live runtime differ only in what is passed here — which is
 * why the synthetic campaign is a genuine test of the same code path and not a parallel one.
 */
export interface CampaignHost {
  /** Ask the runtime what it currently has loaded for this model. */
  observeIdentity(candidate: PlannableCandidate): Promise<ObservedModelIdentity>;
  /** Run one attempt. */
  run(request: AttemptRequest): Promise<AttemptOutcome>;
  /** Score one answer. Returns a terminal status and whether it broke a governance rule. */
  score(slot: PlanSlot, answerText: string): Promise<{ status: TerminalSlotStatus; governanceViolated: boolean; detail: string }>;
  /** Read the machine, for the guards. */
  readSystem(): Promise<SystemReading>;
  residency: ResidencyController;
  /** Wall clock, injectable so a synthetic campaign is deterministic. */
  now(): Date;
}

export interface CampaignConfiguration {
  label: string;
  suiteIDs: string[];
  repeatsPerCase: number;
  candidates: (PlannableCandidate & ManifestCandidate)[];
  hardware: HardwareIdentity;
  runtimeVersion: string;
  guardPolicy?: GuardPolicy;
  storeBaseline?: StoreBaseline;
  /** Milliseconds to wait between unload rounds. Zero in tests; five seconds in life. */
  residencyDelayMilliseconds?: number;
}

export type CampaignState = 'created' | 'running' | 'paused' | 'aborted' | 'complete';

export interface CampaignStatus {
  campaignID: string;
  label: string;
  state: CampaignState;
  manifestID: string;
  manifestSeal: string;
  slotCount: number;
  terminalCount: number;
  remaining: number;
  blockedCount: number;
  byStatus: Record<string, number>;
  candidatesComplete: string[];
  currentCandidate?: string;
  currentCaseID?: string;
  standingAbort?: { reason: string; stage: string; blockedSlotCount: number };
  reconciliation: Reconciliation;
  root: string;
}

export interface AttemptTrace {
  slotKey: string;
  status: TerminalSlotStatus | 'blocked';
  identity: ModelIdentityVerification['state'];
  suppliedContext: SuppliedContextVerification['state'];
  telemetry?: AttemptTelemetry;
  detail: string;
}

export interface RunOptions {
  /** Called after every attempt so a caller can render progress. */
  onProgress?: (status: CampaignStatus, trace: AttemptTrace) => void;
  /** Return true to stop cleanly at the next slot boundary. This is what "pause" is. */
  shouldPause?: () => boolean;
  /** Stop after this many attempts. Used by the smoke run to keep a live campaign small. */
  maxAttempts?: number;
}

export interface FinalReport {
  campaignID: string;
  label: string;
  manifest: { manifestID: string; seal: string; digest: string };
  reconciliation: Reconciliation;
  rankings: FinalRankings;
  retention: RetentionReport;
  humanReview: { awaiting: number; packetWritten: boolean; packetPath?: string; audit?: PacketAudit };
  guardTrace: { at: string; kind: string }[];
  producedAt: string;
}

// MARK: - Layout

/** Where a campaign lives on disk. One directory, everything in it, nothing outside it. */
export function campaignPaths(root: string) {
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    ledger: path.join(root, 'ledger'),
    report: path.join(root, 'final-report.json'),
    rankings: path.join(root, 'rankings.json'),
    retention: path.join(root, 'retention.json'),
    reviewDirectory: path.join(root, 'review'),
    packet: path.join(root, 'review', 'blinded-packet.json'),
    // The key never sits beside the packet. Blinding that keeps the key in the same folder is a
    // label, not a property.
    keyDirectory: path.join(root, 'review-key'),
    key: path.join(root, 'review-key', 'packet-key.json'),
  };
}

// MARK: - The campaign

export class Campaign {
  private constructor(
    readonly campaignID: string,
    readonly root: string,
    readonly manifest: FrozenManifest,
    readonly ledger: Ledger,
    readonly catalogue: EngineCatalogue,
    readonly configuration: CampaignConfiguration,
    private readonly host: CampaignHost,
  ) {}

  private get guardPolicy(): GuardPolicy {
    return this.configuration.guardPolicy ?? DEFAULT_GUARD_POLICY;
  }

  // -------------------------------------------------------------------- create

  static create(root: string, configuration: CampaignConfiguration, host: CampaignHost): Campaign {
    const paths = campaignPaths(root);
    if (fs.existsSync(paths.manifest)) {
      throw new CampaignError('campaignExists', `a campaign already exists at ${root}; open it instead of recreating it — recreating would freeze a second manifest over the same evidence`);
    }
    const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
    const frozenAt = host.now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // The manifest is frozen BEFORE the plan is written. A plan that exists without a manifest is a
    // campaign nobody can later prove anything about.
    const manifest = freezeManifest({
      label: configuration.label,
      catalogDigest: catalogue.plannable.catalogDigest,
      caseCount: catalogue.plannable.caseCount,
      repeatsPerCase: configuration.repeatsPerCase,
      prompts: catalogue.prompts,
      scoredCore: catalogue.scoredCore,
      evaluators: evaluatorBindings(),
      candidates: configuration.candidates.map((candidate) => ({
        name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
        parameterSize: candidate.parameterSize, quantization: candidate.quantization,
      })),
      guards: (configuration.guardPolicy ?? DEFAULT_GUARD_POLICY) as unknown as CanonicalValue,
      hardware: configuration.hardware,
      runtimeVersion: configuration.runtimeVersion,
      frozenAt,
    });

    fs.mkdirSync(root, { recursive: true });
    atomicWriteJSON(paths.manifest, manifest as unknown as CanonicalValue);

    const campaignID = `campaign:${digestObject({ label: configuration.label, manifestID: manifest.manifestID, frozenAt }).slice(0, 16)}`;
    const ledger = Ledger.create(paths.ledger, catalogue.plannable, configuration.candidates, {
      campaignFormatVersion: CAMPAIGN_FORMAT_VERSION,
      campaignID,
      label: configuration.label,
      manifestID: manifest.manifestID,
      manifestDigest: manifest.manifestDigest,
      suiteIDs: configuration.suiteIDs,
      repeatsPerCase: configuration.repeatsPerCase,
    });
    ledger.event('campaignCreated', { campaignID, manifestID: manifest.manifestID, slotCount: ledger.plan.length });
    ledger.writeCheckpoint();
    return new Campaign(campaignID, root, manifest, ledger, catalogue, configuration, host);
  }

  static open(root: string, configuration: CampaignConfiguration, host: CampaignHost): Campaign {
    const paths = campaignPaths(root);
    if (!fs.existsSync(paths.manifest)) throw new CampaignError('noCampaign', `no manifest.json at ${root}; there is no campaign here to open`);
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as FrozenManifest;
    const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
    const ledger = Ledger.open(paths.ledger);
    const meta = ledger.meta();
    const campaignID = typeof meta.campaignID === 'string' ? meta.campaignID : `campaign:${manifest.manifestID}`;
    return new Campaign(campaignID, root, manifest, ledger, catalogue, configuration, host);
  }

  static exists(root: string): boolean {
    return fs.existsSync(campaignPaths(root).manifest);
  }

  // -------------------------------------------------------------------- verify

  /** Recompute every manifest binding against the live configuration. Called on every resume. */
  verify(): VerificationReport {
    return verifyManifest(this.manifest, {
      catalogDigest: this.catalogue.plannable.catalogDigest,
      prompts: this.catalogue.prompts,
      scoredCore: this.catalogue.scoredCore,
      evaluators: evaluatorBindings(),
      candidates: this.configuration.candidates.map((candidate) => ({
        name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
        parameterSize: candidate.parameterSize, quantization: candidate.quantization,
      })),
      guards: this.guardPolicy as unknown as CanonicalValue,
      hardware: this.configuration.hardware,
      runtimeVersion: this.configuration.runtimeVersion,
    }, this.host.now().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }

  /** Derive a retest manifest for different hardware, and write it beside the original. */
  deriveRetest(targetRoot: string, hardware: HardwareIdentity, runtimeVersion: string, reason: string): FrozenManifest {
    const derived = deriveRetestManifest(this.manifest, hardware, runtimeVersion,
      this.host.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), reason);
    fs.mkdirSync(targetRoot, { recursive: true });
    atomicWriteJSON(campaignPaths(targetRoot).manifest, derived as unknown as CanonicalValue);
    this.ledger.event('retestManifestDerived', { manifestID: derived.manifestID, targetRoot, reason });
    return derived;
  }

  // -------------------------------------------------------------------- run

  /**
   * Run until the plan is exhausted, a guard aborts, or the caller asks to pause.
   *
   * Resuming is not a different method: `run` on an existing campaign IS the resume. It verifies
   * the manifest first, supersedes any standing abort, and picks up the pending slots in plan
   * order. Two code paths for "start" and "resume" would eventually disagree about one of them.
   */
  async run(options: RunOptions = {}): Promise<CampaignStatus> {
    const verification = this.verify();
    if (!verification.intact) {
      const reason = `the frozen manifest no longer describes this campaign: ${verification.drifts.map((drift) => `${drift.field} — ${drift.meaning}`).join('; ')}`;
      this.ledger.event('manifestDriftRefused', { drifts: verification.drifts as unknown as CanonicalValue });
      this.ledger.recordAbort(reason, verification as unknown as CanonicalValue, 'manifestVerification', this.ledger.pending().map((slot) => slot.slotKey));
      this.ledger.writeCheckpoint();
      throw new CampaignError('manifestDrift', reason);
    }

    const standing = this.ledger.standingAbort();
    if (standing) {
      this.ledger.clearAbort(`resumed after ${standing.reason}; the manifest was re-verified and still holds`);
      this.ledger.load();
    }
    this.ledger.event('runStarted', { pending: this.ledger.pending().length });

    let attempted = 0;
    let loadedCandidate: string | undefined;
    try {
      for (const slot of this.ledger.pending()) {
        if (options.shouldPause?.()) {
          this.ledger.event('paused', { atSlotKey: slot.slotKey, terminal: this.ledger.results.size });
          this.ledger.writeCheckpoint({ pausedAt: slot.slotKey });
          return this.status('paused');
        }
        if (options.maxAttempts !== undefined && attempted >= options.maxAttempts) {
          this.ledger.event('attemptLimitReached', { limit: options.maxAttempts });
          this.ledger.writeCheckpoint({ stoppedAt: slot.slotKey, because: 'attempt limit reached' });
          return this.status('paused');
        }

        // A candidate transition means the previous model must be gone, and PROVEN gone.
        if (loadedCandidate !== undefined && loadedCandidate !== slot.candidate) {
          await this.releaseResidency(loadedCandidate);
        }
        loadedCandidate = slot.candidate;

        const trace = await this.runOneSlot(slot);
        attempted += 1;
        this.ledger.writeCheckpoint({ lastCandidate: slot.candidate });
        options.onProgress?.(this.status('running'), trace);
      }
      if (loadedCandidate !== undefined) await this.releaseResidency(loadedCandidate);
    } catch (error) {
      if (error instanceof CampaignAbort) {
        this.ledger.writeCheckpoint();
        return this.status('aborted');
      }
      throw error;
    }

    this.ledger.event('runFinished', { terminal: this.ledger.results.size });
    this.ledger.writeCheckpoint();
    return this.status();
  }

  private async releaseResidency(candidate: string): Promise<void> {
    let proof: ResidencyProof;
    try {
      proof = await unloadAndVerify(this.host.residency, candidate, { delayMilliseconds: this.configuration.residencyDelayMilliseconds ?? 5_000 });
    } catch (error) {
      if (!(error instanceof ResidencyError)) throw error;
      const blocked = this.ledger.pending().map((slot) => slot.slotKey);
      this.ledger.recordAbort(`${candidate} would not release its weights`, error.detail, 'candidateTransition', blocked);
      throw new CampaignAbort();
    }
    this.ledger.event('residencyVerified', { candidate, rounds: proof.rounds });
  }

  /**
   * One slot, in the fixed order. Everything before `execute` can BLOCK the slot; nothing before
   * `execute` may record a result for it, because a slot that was never attempted must never carry
   * an outcome.
   */
  private async runOneSlot(slot: PlanSlot): Promise<AttemptTrace> {
    // 1. Guards, read fresh for every attempt.
    const reading = await this.host.readSystem();
    const verdict = evaluateGuards(this.guardPolicy, reading, this.configuration.storeBaseline,
      this.host.now().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    this.recordGuardVerdict(verdict);
    if (!verdict.allPassed) {
      const blocked = this.ledger.pending().map((pending) => pending.slotKey);
      this.ledger.recordAbort(describeBreach(verdict), verdict as unknown as CanonicalValue, 'preAttempt', blocked);
      throw new CampaignAbort();
    }

    const benchmarkCase = this.catalogue.cases.get(slot.caseID);
    if (!benchmarkCase) throw new CampaignError('unknownCase', `slot ${slot.slotKey} names case ${slot.caseID}, which this catalogue does not contain`);
    const pinned = this.manifest.candidates.find((candidate) => candidate.name === slot.candidate);
    if (!pinned) throw new CampaignError('unknownCandidate', `slot ${slot.slotKey} names candidate ${slot.candidate}, which the manifest does not pin`);

    // 2. Model identity. A mismatch poisons the attempt; an unverifiable identity is carried.
    const observed = await this.host.observeIdentity({ name: slot.candidate, modelID: slot.modelID });
    const identity = verifyModelIdentity(pinned, observed);
    if (!identityPermitsExecution(identity)) {
      const blocked = this.ledger.pending().filter((pending) => pending.candidate === slot.candidate).map((pending) => pending.slotKey);
      this.ledger.recordAbort(identity.detail, identity as unknown as CanonicalValue, 'identityVerification', blocked);
      throw new CampaignAbort();
    }

    // 3. Execute.
    const promptRecord = this.catalogue.prompts.find((prompt) => prompt.caseID === slot.caseID)!;
    const outcome = await this.host.run({
      slot,
      promptText: promptRecord.text,
      suppliedContext: promptRecord.suppliedContext,
      maxOutputTokens: slot.maxOutputTokens,
    });

    // 4. Supplied context, checked against what the request ACTUALLY carried.
    const suppliedContext = verifySuppliedContext(promptRecord.suppliedContext, outcome.assembledContext);

    // 5. Telemetry.
    const telemetry = summariseAttempt(outcome.streamEvents, outcome.runtime, outcome.totalElapsedMilliseconds);

    // 6. Score — but only if the attempt measured the model rather than the harness.
    let status: TerminalSlotStatus;
    let governanceViolated = false;
    let detail: string;
    if (outcome.failure) {
      status = 'runtimeError';
      detail = `${outcome.failure.code}: ${outcome.failure.detail}`;
    } else if (!suppliedContextIsUsable(suppliedContext)) {
      // A measurement fault is recorded as one. Scoring it would report the harness's bug as the
      // model's failure, which is the single most misleading thing a benchmark can do.
      status = 'runtimeError';
      detail = `supplied context ${suppliedContext.state}: ${suppliedContext.detail}`;
    } else {
      const scored = await this.host.score(slot, outcome.answerText);
      status = scored.status;
      governanceViolated = scored.governanceViolated;
      detail = scored.detail;
      const emptyExplanation = explainEmptyAnswer(telemetry, slot.maxOutputTokens);
      if (emptyExplanation) detail = `${detail} — ${emptyExplanation}`;
    }

    // 7. Append, fsynced, before anything else happens.
    this.ledger.appendResult({
      slotKey: slot.slotKey,
      status,
      caseID: slot.caseID,
      candidate: slot.candidate,
      suite: slot.suite,
      pass: slot.pass,
      governanceViolated,
      detail,
      answerText: outcome.answerText,
      identityState: identity.state,
      suppliedContextState: suppliedContext.state,
      suppliedContextDigest: suppliedContext.observedDigest,
      latencyMilliseconds: 'measured' in telemetry.totalLatencyMilliseconds ? telemetry.totalLatencyMilliseconds.measured : undefined,
      timeToFirstTokenMilliseconds: 'measured' in telemetry.timeToFirstTokenMilliseconds ? telemetry.timeToFirstTokenMilliseconds.measured : undefined,
      throughputTokensPerSecondMilli: 'measured' in telemetry.throughputTokensPerSecondMilli ? telemetry.throughputTokensPerSecondMilli.measured : undefined,
      visibleTokenCount: 'measured' in telemetry.visibleTokenCount ? telemetry.visibleTokenCount.measured : undefined,
      thinkingTokenCount: 'measured' in telemetry.thinkingTokenCount ? telemetry.thinkingTokenCount.measured : undefined,
      thinkingOnly: telemetry.thinkingOnly,
      streamed: telemetry.streamed,
    });

    return { slotKey: slot.slotKey, status, identity: identity.state, suppliedContext: suppliedContext.state, telemetry, detail };
  }

  private recordGuardVerdict(verdict: GuardVerdict): void {
    // Only breaches are traced per attempt. Tracing every passing guard on every attempt would bury
    // the one line that matters under thousands that do not.
    if (verdict.allPassed) return;
    this.ledger.event('guardBreach', { breaches: verdict.breaches as unknown as CanonicalValue });
  }

  // -------------------------------------------------------------------- status

  status(override?: CampaignState): CampaignStatus {
    const reconciliation = this.ledger.reconcile();
    const checkpoint = this.ledger.readCheckpoint();
    const standing = this.ledger.standingAbort();
    let state: CampaignState;
    if (override) state = override;
    else if (standing) state = 'aborted';
    else if (reconciliation.complete) state = 'complete';
    else if (reconciliation.terminal === 0) state = 'created';
    else state = 'paused';

    const next = this.ledger.pending()[0];
    return {
      campaignID: this.campaignID,
      label: this.configuration.label,
      state,
      manifestID: this.manifest.manifestID,
      manifestSeal: manifestSeal(this.manifest),
      slotCount: this.ledger.plan.length,
      terminalCount: reconciliation.terminal,
      remaining: this.ledger.plan.length - reconciliation.terminal,
      blockedCount: reconciliation.blocked,
      byStatus: reconciliation.byStatus,
      candidatesComplete: checkpoint?.candidatesComplete ?? [...this.ledger.completedCandidates()].sort(),
      currentCandidate: next?.candidate,
      currentCaseID: next?.caseID,
      standingAbort: standing ? { reason: standing.reason, stage: standing.stage, blockedSlotCount: standing.blockedSlotCount } : undefined,
      reconciliation,
      root: this.root,
    };
  }

  // -------------------------------------------------------------------- finalize

  /**
   * Reconcile, rank, then interpret — in that order.
   *
   * A blinded packet is written whenever anything is awaiting human review, and is written BEFORE
   * the rankings are read by a person, so nobody adjudicates while holding the leaderboard.
   */
  finalize(options: { blindingSecret?: string } = {}): FinalReport {
    const paths = campaignPaths(this.root);
    const reconciliation = this.ledger.reconcile();
    const producedAt = this.host.now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const rankings = rankCandidates({
      outcomes: outcomesFromLedger(this.ledger.results.values(), (caseID) => this.catalogue.dimensions.get(caseID)),
      reconciliation,
      derivedAt: producedAt,
    });
    const retention = recommendRetention(rankings);

    const awaiting = [...this.ledger.results.values()].filter((result) => result.status === 'requiresHumanReview');
    let packetWritten = false;
    let audit: PacketAudit | undefined;
    if (awaiting.length > 0 && options.blindingSecret) {
      const responses: AdjudicableResponse[] = awaiting.map((result) => ({
        slotKey: result.slotKey,
        caseID: typeof result.caseID === 'string' ? result.caseID : String(result.slotKey).split('|')[3],
        candidate: typeof result.candidate === 'string' ? result.candidate : String(result.slotKey).split('|')[0],
        answerText: typeof result.answerText === 'string' ? result.answerText : '',
        status: result.status,
      }));
      const prompts: Record<string, string> = {};
      for (const prompt of this.catalogue.prompts) prompts[prompt.caseID] = prompt.text;
      const { packet, key } = buildBlindedPacket(responses, prompts, this.configuration.candidates, options.blindingSecret, producedAt);
      audit = auditPacket(packet, this.configuration.candidates);
      fs.mkdirSync(paths.reviewDirectory, { recursive: true });
      fs.mkdirSync(paths.keyDirectory, { recursive: true });
      atomicWriteJSON(paths.packet, packet as unknown as CanonicalValue);
      atomicWriteJSON(paths.key, key as unknown as CanonicalValue);
      packetWritten = true;
      this.ledger.event('blindedPacketWritten', { responses: responses.length, clean: audit.clean, leaks: audit.leaks.length });
    }

    const report: FinalReport = {
      campaignID: this.campaignID,
      label: this.configuration.label,
      manifest: { manifestID: this.manifest.manifestID, seal: manifestSeal(this.manifest), digest: this.manifest.manifestDigest },
      reconciliation,
      rankings,
      retention,
      humanReview: { awaiting: awaiting.length, packetWritten, packetPath: packetWritten ? paths.packet : undefined, audit },
      guardTrace: this.ledger.events().filter((event) => event.kind === 'guardBreach' || event.kind === 'residencyVerified' || event.kind === 'abort')
        .map((event) => ({ at: String(event.at), kind: String(event.kind) })),
      producedAt,
    };
    atomicWriteJSON(paths.rankings, rankings as unknown as CanonicalValue);
    atomicWriteJSON(paths.retention, retention as unknown as CanonicalValue);
    atomicWriteJSON(paths.report, report as unknown as CanonicalValue);
    this.ledger.event('finalized', { complete: reconciliation.complete, provisional: rankings.provisional });
    return report;
  }

  /** Read back a packet key, for applying verdicts after adjudication. */
  readPacketKey(): PacketKey | undefined {
    const paths = campaignPaths(this.root);
    if (!fs.existsSync(paths.key)) return undefined;
    return JSON.parse(fs.readFileSync(paths.key, 'utf8')) as PacketKey;
  }

  readPacket(): BlindedPacket | undefined {
    const paths = campaignPaths(this.root);
    if (!fs.existsSync(paths.packet)) return undefined;
    return JSON.parse(fs.readFileSync(paths.packet, 'utf8')) as BlindedPacket;
  }
}

/** Thrown internally to unwind to `run`'s abort handling. Never escapes the engine. */
class CampaignAbort extends Error {
  constructor() {
    super('campaign aborted');
    this.name = 'CampaignAbort';
  }
}

export { LedgerError };
