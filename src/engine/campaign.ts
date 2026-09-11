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
import { CampaignLockError, CampaignLockHandle, LockOptions, LockOwnerState, LockProcessType, acquireCampaignLock, inspectCampaignLock } from './lock';
import { DEFAULT_EXECUTION_POLICY, ExecutionPolicy, NONCANONICAL_REASONS, isCanonical } from './execution';
import { RuntimeLeaseError, acquireRuntimeLease, runtimeLeaseDirectory } from './runtime-lease';
import { ThinkingModeVerification, thinkingModePermitsExecution, verifyThinkingMode } from './verification';

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
  /**
   * The runtime this host will actually send requests to, when it sends any.
   *
   * Absent on a deterministic host, which is how a synthetic campaign takes no runtime lease: it
   * contends for nothing because it reaches nothing.
   */
  runtimeIdentity?(): Promise<{ endpoint: string; modelStoreListingDigest: string; modelStoreCount: number }>;
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
  /**
   * How this campaign is executed. Frozen into the manifest at creation and honoured thereafter;
   * `run` never reads a flag for it, because a mode that can be changed between resumes is not
   * frozen. Defaults to canonical (`managed`) with thinking off.
   */
  execution?: ExecutionPolicy;
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
  /** The process that currently holds the campaign, when one does. Read from disk, not from memory. */
  owner?: { processType: LockProcessType; command: string; pid: number; hostname: string; acquiredAt: string; state: LockOwnerState; message: string };
  /** The frozen execution policy, and whether this campaign's numbers are canonical. */
  execution: ExecutionPolicy;
  canonical: boolean;
}

export interface AttemptTrace {
  slotKey: string;
  status: TerminalSlotStatus | 'blocked';
  identity: ModelIdentityVerification['state'];
  suppliedContext: SuppliedContextVerification['state'];
  thinkingMode: ThinkingModeVerification['state'];
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
  /**
   * Who is asking. Recorded in the campaign lock so a refusal can name the process holding it —
   * "the desktop application is running this" is a useful message; "it is locked" is not.
   */
  owner?: { processType: LockProcessType; command: string };
  /**
   * Pass a handle to run under a lock the caller already holds, or `false` to run without taking
   * one. `false` exists for a single-process test that drives `run` twice in a row; nothing that
   * touches a real runtime should use it.
   */
  lock?: CampaignLockHandle | false;
  lockOptions?: LockOptions;
  /**
   * Where the runtime leases live — the campaign ROOT, the directory holding every campaign, since
   * a lease is shared between campaigns rather than owned by one. Defaults to this campaign's parent.
   */
  campaignRootDirectory?: string;
  /** `false` runs without taking a runtime lease. For tests that drive one process; never for a real run. */
  runtimeLease?: false;
  /**
   * Called once the campaign is genuinely this caller's: ownership taken and the frozen manifest
   * re-verified. A caller that announced "running…" before this point would announce it and then
   * be refused, which is a worse message than no message.
   */
  onStarted?: (status: CampaignStatus) => void;
}

export interface FinalReport {
  campaignID: string;
  label: string;
  manifest: { manifestID: string; seal: string; digest: string };
  /** What kind of run produced these numbers. Present on every report, canonical or not. */
  execution: ExecutionPolicy;
  canonical: boolean;
  /** Empty on a canonical report; the reasons it cannot be compared on an observe-only one. */
  noncanonicalBecause: string[];
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

  /**
   * The execution policy this campaign was frozen with.
   *
   * The MANIFEST is the authority, not the configuration file beside it: the configuration is an
   * ordinary JSON file a person can edit, and the whole point of freezing the policy was that it
   * cannot be changed after the fact. A manifest frozen before format 3 bound no policy, and those
   * runs were all managed-residency with thinking off, so that is what they are read as.
   */
  get execution(): ExecutionPolicy {
    return this.manifest.execution ?? this.configuration.execution ?? DEFAULT_EXECUTION_POLICY;
  }

  get canonical(): boolean {
    return isCanonical(this.execution);
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
      execution: configuration.execution ?? DEFAULT_EXECUTION_POLICY,
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
      residencyMode: (configuration.execution ?? DEFAULT_EXECUTION_POLICY).residency,
      thinkingMode: (configuration.execution ?? DEFAULT_EXECUTION_POLICY).thinkingMode,
      canonical: isCanonical(configuration.execution ?? DEFAULT_EXECUTION_POLICY),
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
      // Compared against the frozen policy, so editing `configuration.json` to flip residency or
      // thinking mode on a frozen campaign is a drift that refuses the resume rather than a change
      // that quietly takes effect.
      execution: this.configuration.execution ?? DEFAULT_EXECUTION_POLICY,
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
    // Two ownerships, taken in this order and released in the reverse: this CAMPAIGN, so no second
    // process runs the same ledger; then the RUNTIME, so no second campaign competes for the same
    // Ollama. Both are taken before the manifest is even verified, and long before a request is
    // sent, so a contended run is refused while it has cost nothing.
    const ownership = this.takeOwnership(options);
    let lease: CampaignLockHandle | undefined;
    try {
      lease = await this.takeRuntime(options);
      return await this.runOwned(options);
    } finally {
      if (lease) {
        const released = lease.release();
        this.ledger.event('runtimeLeaseReleased', { endpoint: lease.record.endpoint, removed: released });
      }
      if (ownership.ours && ownership.handle) {
        const released = ownership.handle.release();
        this.ledger.event('lockReleased', { pid: ownership.handle.record.pid, removed: released });
      }
    }
  }

  /**
   * Take the benchmark runtime for the duration of the run.
   *
   * A host that reaches no runtime takes no lease — a synthetic campaign contends for nothing
   * because it contends with nothing. Every host that DOES reach one takes a lease, observe-only
   * campaigns included: an observe-only run still loads weights on that endpoint, which is exactly
   * what would invalidate a canonical campaign's residency proof running beside it.
   */
  private async takeRuntime(options: RunOptions): Promise<CampaignLockHandle | undefined> {
    if (options.runtimeLease === false || !this.host.runtimeIdentity) return undefined;
    const identity = await this.host.runtimeIdentity();
    const owner = options.owner ?? { processType: 'terminal' as LockProcessType, command: 'unattributed' };
    const root = options.campaignRootDirectory ?? path.dirname(this.root);
    try {
      const handle = acquireRuntimeLease(root, {
        processType: owner.processType,
        command: owner.command,
        campaignID: this.campaignID,
        campaignName: path.basename(this.root),
        endpoint: identity.endpoint,
        modelStoreListingDigest: identity.modelStoreListingDigest,
        modelStoreCount: identity.modelStoreCount,
      }, options.lockOptions);
      if (handle.recovered) {
        this.ledger.event('runtimeLeaseRecovered', {
          endpoint: handle.record.endpoint,
          crashedPid: handle.recovered.pid,
          crashedCampaign: handle.recovered.campaignName,
          crashedCommand: handle.recovered.command,
          heldSince: handle.recovered.acquiredAt,
          why: 'the campaign that held this endpoint no longer exists; its lease was reclaimed and kept as evidence',
        });
      }
      this.ledger.event('runtimeLeaseAcquired', {
        endpoint: handle.record.endpoint,
        modelStoreCount: identity.modelStoreCount,
        recoveredCrash: handle.recovered !== undefined,
      });
      return handle;
    } catch (error) {
      if (error instanceof RuntimeLeaseError) {
        this.ledger.event('runtimeLeaseRefused', {
          endpoint: error.endpoint,
          code: error.code,
          state: error.inspection.state,
          heldByCampaign: error.inspection.record?.campaignName,
          heldByPID: error.inspection.record?.pid,
          refusedPID: process.pid,
        });
      }
      throw error;
    }
  }

  /** Where this campaign's runtime leases live. Exposed so a status view can read them. */
  leaseDirectory(options: { campaignRootDirectory?: string } = {}): string {
    return runtimeLeaseDirectory(options.campaignRootDirectory ?? path.dirname(this.root));
  }

  /**
   * Take the campaign for the duration of a run.
   *
   * Ownership is taken BEFORE the manifest is verified and before a single request is sent, so a
   * second runner is turned away while it has cost nothing. A crashed owner's lock is reclaimed
   * here and the reclaim is written into the ledger's event trace, because "this campaign was
   * resumed after a crash" is a fact about the evidence, not an implementation detail.
   */
  private takeOwnership(options: RunOptions): { handle?: CampaignLockHandle; ours: boolean } {
    if (options.lock === false) return { ours: false };
    if (options.lock) return { handle: options.lock, ours: false };
    const owner = options.owner ?? { processType: 'terminal' as LockProcessType, command: 'unattributed' };
    try {
      const handle = acquireCampaignLock(this.root, {
        processType: owner.processType,
        command: owner.command,
        campaignID: this.campaignID,
        campaignName: path.basename(this.root),
      }, options.lockOptions);
      if (handle.recovered) {
        this.ledger.event('lockRecovered', {
          crashedPid: handle.recovered.pid,
          crashedProcessType: handle.recovered.processType,
          crashedCommand: handle.recovered.command,
          crashedHostname: handle.recovered.hostname,
          heldSince: handle.recovered.acquiredAt,
          lastHeartbeat: handle.recovered.heartbeatAt,
          why: 'the recorded owner no longer exists, so the campaign was left locked by a crash; the lock was reclaimed and the crashed owner kept as evidence',
        });
      }
      this.ledger.event('lockAcquired', {
        pid: handle.record.pid, processType: handle.record.processType, command: handle.record.command,
        recoveredCrash: handle.recovered !== undefined,
      });
      return { handle, ours: true };
    } catch (error) {
      if (error instanceof CampaignLockError) {
        this.ledger.event('lockRefused', {
          code: error.code,
          state: error.inspection.state,
          heldByPID: error.inspection.record?.pid,
          heldByProcessType: error.inspection.record?.processType,
          heldOnHost: error.inspection.record?.hostname,
          refusedPID: process.pid,
        });
      }
      throw error;
    }
  }

  /** What the campaign currently reports about its own ownership. Reads the lock file; writes nothing. */
  inspectLock(options: LockOptions = {}) {
    return inspectCampaignLock(this.root, options);
  }

  private async runOwned(options: RunOptions): Promise<CampaignStatus> {
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
    options.onStarted?.(this.status('running'));

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
    // An observe-only campaign touches nothing. This is the ONLY place the mode changes behaviour,
    // and it is why the mode has to be frozen and labelled rather than left as a runtime flag: the
    // difference between the two runs is invisible in every artefact except the one that says so.
    if (!this.canonical) {
      this.ledger.event('residencyNotManaged', {
        candidate,
        why: 'this campaign is observe-only: Cernum did not ask the runtime to release these weights, and the next candidate may load on top of them',
      });
      return;
    }
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

    // 2b. The frozen thinking mode. A runtime that reports it cannot do what the manifest froze
    // stops the campaign; it is never silently substituted, because answers produced under a
    // different configuration are answers to a different experiment.
    const thinking = verifyThinkingMode(this.execution.thinkingMode, observed);
    if (!thinkingModePermitsExecution(thinking)) {
      const blocked = this.ledger.pending().filter((pending) => pending.candidate === slot.candidate).map((pending) => pending.slotKey);
      this.ledger.recordAbort(thinking.detail, thinking as unknown as CanonicalValue, 'thinkingModeVerification', blocked);
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
      // On every row, not only in the manifest: a row lifted out of its campaign carries its own
      // comparability with it, so it can never be silently merged into a canonical set.
      canonical: this.canonical,
      residencyMode: this.execution.residency,
      thinkingMode: this.execution.thinkingMode,
      thinkingModeState: thinking.state,
      suppliedContextDigest: suppliedContext.observedDigest,
      latencyMilliseconds: 'measured' in telemetry.totalLatencyMilliseconds ? telemetry.totalLatencyMilliseconds.measured : undefined,
      timeToFirstTokenMilliseconds: 'measured' in telemetry.timeToFirstTokenMilliseconds ? telemetry.timeToFirstTokenMilliseconds.measured : undefined,
      throughputTokensPerSecondMilli: 'measured' in telemetry.throughputTokensPerSecondMilli ? telemetry.throughputTokensPerSecondMilli.measured : undefined,
      visibleTokenCount: 'measured' in telemetry.visibleTokenCount ? telemetry.visibleTokenCount.measured : undefined,
      thinkingTokenCount: 'measured' in telemetry.thinkingTokenCount ? telemetry.thinkingTokenCount.measured : undefined,
      thinkingOnly: telemetry.thinkingOnly,
      streamed: telemetry.streamed,
    });

    return { slotKey: slot.slotKey, status, identity: identity.state, suppliedContext: suppliedContext.state, thinkingMode: thinking.state, telemetry, detail };
  }

  private recordGuardVerdict(verdict: GuardVerdict): void {
    // Only breaches are traced per attempt. Tracing every passing guard on every attempt would bury
    // the one line that matters under thousands that do not.
    if (verdict.allPassed) return;
    this.ledger.event('guardBreach', { breaches: verdict.breaches as unknown as CanonicalValue });
  }

  // -------------------------------------------------------------------- status

  status(override?: CampaignState, lockOptions: LockOptions = {}): CampaignStatus {
    const reconciliation = this.ledger.reconcile();
    const checkpoint = this.ledger.readCheckpoint();
    const standing = this.ledger.standingAbort();
    const lock = inspectCampaignLock(this.root, lockOptions);
    // A campaign someone is running right now reads as `running` from EVERY surface, not only from
    // the process that started it. Before the lock there was no way to know, so a campaign a
    // terminal was actively advancing showed as `paused` on the Campaigns screen — which is the
    // single most misleading thing that screen could say about it.
    const ownedLive = lock.held && (lock.state === 'live' || lock.state === 'selfHeld');
    let state: CampaignState;
    if (override) state = override;
    else if (reconciliation.complete) state = 'complete';
    else if (ownedLive) state = 'running';
    else if (standing) state = 'aborted';
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
      owner: lock.held && lock.record ? {
        processType: lock.record.processType, command: lock.record.command, pid: lock.record.pid,
        hostname: lock.record.hostname, acquiredAt: lock.record.acquiredAt,
        state: lock.state ?? 'live', message: lock.message,
      } : undefined,
      execution: this.execution,
      canonical: this.canonical,
    };
  }

  // -------------------------------------------------------------------- finalize

  /**
   * Reconcile, rank, then interpret — in that order.
   *
   * A blinded packet is written whenever anything is awaiting human review, and is written BEFORE
   * the rankings are read by a person, so nobody adjudicates while holding the leaderboard.
   */
  finalize(options: { blindingSecret?: string; lockOptions?: LockOptions } = {}): FinalReport {
    // Finalizing reads a ledger that a live runner is still appending to. The numbers would be a
    // snapshot presented as a conclusion, which is the one thing a final report must not be.
    const lock = inspectCampaignLock(this.root, options.lockOptions);
    if (lock.held && lock.state === 'live') {
      throw new CampaignError('campaignInUse',
        `${lock.message} Nothing was finalized: a final report read while attempts are still landing would be a snapshot presented as a conclusion.`);
    }
    const paths = campaignPaths(this.root);
    const reconciliation = this.ledger.reconcile();
    const producedAt = this.host.now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const rankings = rankCandidates({
      outcomes: outcomesFromLedger(this.ledger.results.values(), (caseID) => this.catalogue.dimensions.get(caseID)),
      reconciliation,
      derivedAt: producedAt,
      canonical: this.canonical,
      noncanonicalBecause: this.canonical ? [] : NONCANONICAL_REASONS,
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
      execution: this.execution,
      canonical: this.canonical,
      noncanonicalBecause: this.canonical ? [] : NONCANONICAL_REASONS,
      reconciliation,
      rankings,
      retention,
      humanReview: { awaiting: awaiting.length, packetWritten, packetPath: packetWritten ? paths.packet : undefined, audit },
      guardTrace: this.ledger.events().filter((event) => event.kind === 'guardBreach' || event.kind === 'residencyVerified'
        || event.kind === 'residencyNotManaged' || event.kind === 'abort')
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
