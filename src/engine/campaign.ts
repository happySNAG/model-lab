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
import {
  AttemptDisposition, DISPOSITION_EXPLANATION, NON_ANSWER_TERMINAL_STATUS,
  dispositionForFailure, isAllowanceExhaustion, isScoreableDisposition,
} from './attempt-disposition';
import { EngineCatalogue, buildEngineCatalogue, evaluatorBindings } from './catalogue';
import { FrozenManifest, HardwareIdentity, ManifestCandidate, VerificationReport, deriveRetestManifest, freezeManifest, manifestSeal, verifyManifest } from './manifest';
import { DEFAULT_GUARD_POLICY, GuardPolicy, GuardVerdict, StoreBaseline, SystemReading, describeBreach, evaluateGuards } from './guards';
import { ResidencyController, ResidencyError, ResidencyProof, unloadAndVerify } from './residency';
import { ModelIdentityVerification, ObservedModelIdentity, SuppliedContextVerification, identityPermitsExecution, suppliedContextIsUsable, verifyModelIdentity, verifySuppliedContext } from './verification';
import { AttemptTelemetry, RuntimeReportedTiming, StreamEvent, explainEmptyAnswer, summariseAttempt } from './attempt-telemetry';
import { FinalRankings, RankingView, outcomesFromLedger, rankCandidates } from './ranking';
import { JSONViewAdjudication } from './json-views';
import { RetentionReport, recommendRetention } from './retention';
import { AdjudicableResponse, BlindedPacket, PacketAudit, PacketKey, auditPacket, buildBlindedPacket } from './blinded';
import { CampaignLockError, CampaignLockHandle, LockOptions, LockOwnerState, LockProcessType, acquireCampaignLock, inspectCampaignLock } from './lock';
import { DEFAULT_EXECUTION_POLICY, ExecutionPolicy, NONCANONICAL_REASONS, isCanonical } from './execution';
import { RuntimeLeaseError, acquireRuntimeLease, runtimeLeaseDirectory } from './runtime-lease';
import { ThinkingModeVerification, thinkingModePermitsExecution, verifyThinkingMode } from './verification';
import { ProviderIdentityVerification, providerIdentityPermitsExecution, verifyProviderIdentity } from './verification';
import { OperationalEnvelope, ProviderBinding, bindingFor, isLocal } from './provider';
import { FrontierAttemptRecord, FrontierCandidateMetrics, aggregateFromRows } from './frontier-metrics';
import { MIXED_EXECUTION_REASONS } from './provider';
import { SpendingAuthorization } from './spending';
import { CostPolicyOverride, ZeroMarginalCostConfirmation } from './cost-eligibility';
import {
  ADMISSION_STAMP_LONG, AdmittedCandidateEvidence, IdentityAdmission,
  REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionProvenance, admissionStamp,
} from './identity-admission';

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
  /**
   * Who answered, what it cost, and how well any of that was counted.
   *
   * Present on every attempt of a campaign that froze an operational envelope — including a local
   * one, so a mixed campaign's rows all answer the same questions rather than half of them being
   * silent about cost.
   */
  frontier?: FrontierAttemptRecord;
}

/**
 * Whether an attempt may be made at all, decided BEFORE anything is sent.
 *
 * A refusal is not a result. The campaign records an abort and blocks the remaining slots, exactly
 * as a guard breach does, because a request that never left cannot have an outcome.
 */
export type AttemptAuthorization =
  | { allowed: true }
  | { allowed: false; code: string; reason: string; detail?: CanonicalValue };

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
/**
 * A failure that is the PROVIDER declining, not the model answering badly.
 *
 * Deliberately narrow. A timeout could be a slow model or a slow network and is genuinely
 * ambiguous, so it stays a recorded outcome; a rate limit and an exhausted allowance are neither
 * ambiguous nor anything to do with the candidate's quality. `notAuthenticated` is here because a
 * session that expired mid-campaign is the same class of thing: the remaining slots were never
 * attempted, and recording them as failures would blame a model for a login.
 */
export const PROVIDER_THROTTLE_FAILURES = ['rateLimited', 'notAuthenticated'] as const;

export function isProviderThrottle(failureCode: string): boolean {
  // The code is `${provider}.${kind}`, so the kind is what is matched.
  const kind = failureCode.includes('.') ? failureCode.slice(failureCode.lastIndexOf('.') + 1) : failureCode;
  return (PROVIDER_THROTTLE_FAILURES as readonly string[]).includes(kind);
}

/**
 * The same question, asked of the whole failure rather than only its label.
 *
 * WHY THIS EXISTS AND THE CODE TEST ALONE DOES NOT SUFFICE. Pass 11's sixty-nine usage-limit
 * failures reached here as `codexCLI.transport`, because the provider announced the exhausted
 * allowance in a `turn.failed` envelope with no HTTP status and the adapter had only the status to
 * go on. `isProviderThrottle('codexCLI.transport')` is false, so the campaign did not abort, and it
 * ran the remaining sixty-nine slots into a wall it had already hit and recorded every one of them
 * as a result.
 *
 * The adapter now labels that message `rateLimited` at source, so the code test would catch it
 * today. This is deliberately kept as a SECOND, INDEPENDENT test on the provider's own sentence:
 * the adapter's classifier is the component that has now been wrong twice, and the consequence of
 * it being wrong a third time is spending an allowance that has already run out and publishing the
 * result as a model's quality.
 */
export function isThrottleFailure(failure: { code: string; detail: string }): boolean {
  return isProviderThrottle(failure.code) || isAllowanceExhaustion(failure.detail);
}

export interface CampaignHost {
  /** Ask the runtime what it currently has loaded for this model. */
  observeIdentity(candidate: PlannableCandidate): Promise<ObservedModelIdentity>;
  /** Run one attempt. */
  run(request: AttemptRequest): Promise<AttemptOutcome>;
  /**
   * Score one answer. Returns a terminal status and whether it broke a governance rule.
   *
   * `jsonViews` is the SECOND, separately-labelled reading of a JSON answer — see `json-views.ts`.
   * Optional because a host that scores nothing structured has no second question to answer, and
   * because a host written before Pass 7 must keep compiling rather than silently losing a column.
   */
  score(slot: PlanSlot, answerText: string): Promise<{
    status: TerminalSlotStatus; governanceViolated: boolean; detail: string; jsonViews?: JSONViewAdjudication;
  }>;
  /**
   * Refuse, before the request, anything that would spend money nobody authorised.
   *
   * Optional, because a host that can only reach a local runtime has nothing to authorise. A host
   * that CAN spend money and does not implement this is a host whose spending nothing checks, so the
   * routing host always does.
   */
  authorizeAttempt?(slot: PlanSlot): Promise<AttemptAuthorization>;
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
  /**
   * Who answers each candidate, how they are reached, and on whose bill. Frozen into a format-4
   * manifest at creation, and thereafter as unchangeable as the execution policy.
   *
   * Omitted, the campaign freezes a format-3 manifest exactly as Pass 3 did — which is what keeps
   * every campaign already on disk readable, verifiable, finalizable and resumable under its own
   * stored identity.
   */
  operationalEnvelope?: OperationalEnvelope;
  /**
   * The sealed, per-campaign authorization under which a candidate with an unprovable identity runs.
   *
   * Absent on almost every campaign. Present, it is frozen into the manifest and thereafter as
   * unchangeable as the envelope: editing it in `configuration.json` is a drift that refuses the
   * resume, because a campaign whose second half ran under a different authorization is not the
   * campaign that was authorised.
   */
  identityAdmission?: IdentityAdmission;
  /**
   * The project cost policy this campaign was created under, and the evidence it may consult.
   *
   * PRESENCE IS THE OPT-IN, AND IT IS RECORDED AT CREATE TIME RATHER THAN READ FROM A FLAG. The gate
   * in `RoutingHost.authorizeAttempt` is unenforced when this is absent, which is what keeps every
   * campaign already on disk resuming exactly as it did — a frozen campaign whose second half
   * refused what its first half ran is not the campaign that was authorised. A campaign created
   * after the policy exists carries it here, so its resume is governed by what it was created under
   * and not by whatever the surface believes today.
   *
   * DELIBERATELY NOT IN THE MANIFEST DIGEST. Cost eligibility is a fact about an ACCOUNT at a moment,
   * not about what was measured; freezing it would make a campaign re-verified after a billing change
   * fail its own digest check for a reason that has nothing to do with the benchmark. The structural
   * `billingBasis` stays in the envelope, where it is frozen and where it belongs.
   */
  costPolicy?: {
    confirmations?: ZeroMarginalCostConfirmation[];
    overrides?: CostPolicyOverride[];
  };
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
  /** The frozen provider bindings. Absent on a format-3 campaign, which bound none. */
  operationalEnvelope?: OperationalEnvelope;
  /** True when candidates were reached through more than one execution class. */
  mixedExecution: boolean;
  /** The manifest format this campaign was frozen at: 3 for a Pass 3 campaign, 4 for a bound one. */
  manifestFormatVersion: number;
  /**
   * Candidates running under the Pass 6 identity exception, with the stamp each must be shown with.
   *
   * On the STATUS, not only on the final report, because a campaign is watched while it runs and a
   * live screen that does not say this is a live screen showing verified-looking rows. Empty on
   * almost every campaign.
   */
  admittedWithoutProvenIdentity: { candidate: string; requestedModelID: string; effort: string; stamp: string }[];
}

export interface AttemptTrace {
  slotKey: string;
  status: TerminalSlotStatus | 'blocked';
  identity: ModelIdentityVerification['state'];
  suppliedContext: SuppliedContextVerification['state'];
  thinkingMode: ThinkingModeVerification['state'];
  /** Absent on a local candidate, whose identity is established by its weights rather than its answer. */
  providerIdentity?: ProviderIdentityVerification['state'];
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
  /** Who answered each candidate and on whose bill. Absent on a format-3 report. */
  operationalEnvelope?: OperationalEnvelope;
  /** Empty unless candidates were reached through more than one execution class. */
  mixedExecutionBecause: string[];
  /** Tokens, speed, cost and their provenance, per candidate. Empty on a format-3 campaign. */
  frontierMetrics: FrontierCandidateMetrics[];
  /** What was authorised and what was actually spent. Absent when nothing metered was planned. */
  spending?: {
    authorized: boolean;
    hardCeilingMicroUSD?: number;
    /** The sum of every metered attempt's recorded cost, whatever its provenance. */
    recordedMicroUSD: number;
    meteredAttempts: number;
    /** True when the run stopped because the ceiling would have been exceeded. */
    stoppedAtCeiling: boolean;
  };
  reconciliation: Reconciliation;
  /**
   * THE FROZEN RANKING: strict JSON transport compliance. The campaign result, unchanged by Pass 7.
   */
  rankings: FinalRankings;
  /**
   * THE SECOND READING: semantic JSON/schema correctness, over the same rows.
   *
   * Present on every report from Pass 7 onward, and present even when it is identical to the table
   * above — a reader who looks for it and does not find it cannot tell a campaign whose two
   * readings agreed from a report written by something that did not know to produce one.
   */
  rankingsSemanticJSONView: FinalRankings;
  /**
   * Computed on the STRICT ranking only, and deliberately.
   *
   * Retention decides whether a model earns a role, and a role is a recommendation to send real work
   * to something. The output that work would receive is the output as it arrives, fence and all, so
   * the frozen transport result is the one a promotion may rest on. The semantic table explains a
   * shortfall; it does not license a promotion.
   */
  retention: RetentionReport;
  humanReview: { awaiting: number; packetWritten: boolean; packetPath?: string; audit?: PacketAudit };
  guardTrace: { at: string; kind: string }[];
  /**
   * The identity-confidence disclosure. Present on EVERY report, empty when nothing was admitted.
   *
   * Present-and-empty rather than absent-when-empty on purpose: a reader who looks for this block
   * and does not find it cannot tell a campaign that admitted nothing from a report written by
   * something that did not know to disclose. An empty `admitted` list is an assertion.
   */
  identityConfidence: {
    /** Empty on almost every campaign. One entry per candidate run without a proven identity. */
    admitted: AdmittedCandidateEvidence[];
    /** The one-line stamp for each, in the same order. Rendered here so no surface composes its own. */
    stamps: string[];
    /** The full provenance block per admitted candidate, for a surface with room for it. */
    provenance: string[][];
    /** What the state means, verbatim. Empty string when nothing was admitted. */
    disclosure: string;
    /** The sealed authorization itself, when there was one. */
    admission?: IdentityAdmission;
  };
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
    // Beside the campaign it authorises, not in a settings file somewhere: an authorization that is
    // not part of the campaign's own evidence is an authorization nobody can audit afterwards.
    authorization: path.join(root, 'authorization.json'),
    rankings: path.join(root, 'rankings.json'),
    // The SECOND reading, in its own file with its own name. Deliberately not merged into
    // `rankings.json`: a file called `rankings` that silently contained two tables is a file whose
    // readers would each pick one, and the one they picked would be whichever came first.
    rankingsSemantic: path.join(root, 'rankings-semantic-json-view.json'),
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

  /**
   * The frozen operational envelope, or undefined on a format-3 campaign.
   *
   * The MANIFEST is the authority, exactly as it is for the execution policy: `configuration.json`
   * is an ordinary file a person can edit, and the point of freezing the bindings was that editing
   * them afterwards changes nothing except the verification result.
   */
  get operationalEnvelope(): OperationalEnvelope | undefined {
    return this.manifest.operationalEnvelope;
  }

  /** One candidate's frozen binding, or undefined when this campaign froze none. */
  bindingFor(candidate: string): ProviderBinding | undefined {
    const envelope = this.operationalEnvelope;
    if (!envelope) return undefined;
    try { return bindingFor(envelope, candidate); } catch { return undefined; }
  }

  /**
   * Does this campaign manage residency for this candidate?
   *
   * A format-3 campaign has no bindings and is all-local, which is what it always was. A format-4
   * campaign manages residency for its local candidates only: a frontier candidate has no weights on
   * this machine, so there is nothing to unload and nothing an unload could prove.
   */
  private managesResidencyFor(candidate: string): boolean {
    if (!this.canonical) return false;
    const binding = this.bindingFor(candidate);
    return binding === undefined ? true : isLocal(binding);
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
      operationalEnvelope: configuration.operationalEnvelope,
      identityAdmission: configuration.identityAdmission,
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
      manifestFormatVersion: manifest.manifestFormatVersion,
      // On the ledger's own meta, so a campaign row can be labelled without opening the manifest.
      providers: (configuration.operationalEnvelope?.providers ?? []) as unknown as CanonicalValue,
      executionClasses: (configuration.operationalEnvelope?.executionClasses ?? []) as unknown as CanonicalValue,
      mixedExecution: configuration.operationalEnvelope?.mixed ?? false,
      hasMeteredBinding: configuration.operationalEnvelope?.hasMeteredBinding ?? false,
    });
    ledger.event('campaignCreated', { campaignID, manifestID: manifest.manifestID, slotCount: ledger.plan.length });
    // The exception is recorded in the campaign's own event stream at the moment it takes effect,
    // not only in the manifest. The manifest says what was authorised; this says that a campaign
    // was actually created under it, which is the thing a later reader is trying to establish.
    if (configuration.identityAdmission !== undefined) {
      ledger.event('identityAdmitted', {
        admissionDigest: configuration.identityAdmission.admissionDigest,
        authorizedBy: configuration.identityAdmission.authorizedBy,
        authorizedAt: configuration.identityAdmission.authorizedAt,
        admitted: configuration.identityAdmission.admitted.map((entry) =>
          `${entry.provider}:${entry.requestedModelID}@${entry.requestedEffort}`).join(', '),
        disclosure: ADMISSION_STAMP_LONG,
      });
    }
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
      // Compared against the frozen envelope, so editing `configuration.json` to point a candidate at
      // a cheaper model, a lower effort or a different provider is a drift that refuses the resume
      // rather than a change that quietly takes effect halfway through a campaign.
      operationalEnvelope: this.configuration.operationalEnvelope,
      // Same reason again, and with more at stake: an admission is the one field in this
      // configuration that grants permission rather than describing a setting.
      identityAdmission: this.configuration.identityAdmission,
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
    // A frontier candidate has no weights on this machine. There is nothing to unload, and — this is
    // the part worth being explicit about — nothing an unload could PROVE. Recording it as
    // inapplicable rather than silently skipping it keeps the distinction visible in the trace:
    // "we did not need to" and "we did not bother" look identical in an empty event log.
    const binding = this.bindingFor(candidate);
    if (binding !== undefined && !isLocal(binding)) {
      this.ledger.event('residencyNotApplicable', {
        candidate,
        provider: binding.provider,
        executionClass: binding.executionClass,
        why: 'this candidate runs on the provider\'s hardware, so no weights were loaded on this machine and there is '
          + 'nothing here to release. Its latency is not affected by what is resident locally, and the local '
          + 'candidates\' residency proofs are unaffected by it.',
      });
      return;
    }
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

    // 1b. Money. Asked BEFORE the model is even identified, because the cheapest refusal is the one
    // that happens before anything is sent. A refusal aborts and blocks the remaining slots rather
    // than recording a result: a request that never left is not an outcome a model produced.
    if (this.host.authorizeAttempt) {
      const authorization = await this.host.authorizeAttempt(slot);
      if (!authorization.allowed) {
        const blocked = this.ledger.pending().map((pending) => pending.slotKey);
        this.ledger.event('spendingRefused', { code: authorization.code, candidate: slot.candidate, detail: authorization.detail });
        this.ledger.recordAbort(authorization.reason, authorization.detail ?? { code: authorization.code }, 'spendingAuthorization', blocked);
        throw new CampaignAbort();
      }
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

    const binding = this.bindingFor(slot.candidate);

    // 3a. PROVIDER THROTTLING IS NOT A MODEL-QUALITY FAILURE, and it must never be written as one.
    //
    // A subscription that has hit its rate limit or exhausted its allowance produced no answer. If
    // the slot were recorded terminal, the ranking's own counting rule would turn it into a `fail`
    // — "everything that is neither a pass, a partial, an awaited review nor inapplicable" — and a
    // candidate would carry a quality score for an answer a provider declined to let it give. On a
    // long campaign that hits a limit halfway through, that single mistake is enough to invert the
    // leaderboard.
    //
    // So a throttle ABORTS instead. The slot is left runnable, every remaining slot is blocked, and
    // the record says the campaign stopped rather than that a model failed. `cernum resume` picks it
    // up after the allowance resets and re-verifies the manifest first, and the abort is superseded
    // rather than deleted. No other model is substituted: this candidate's remaining work is
    // this candidate's, and answering it with a different one would silently change the experiment.
    if (outcome.failure && isThrottleFailure(outcome.failure)) {
      const blocked = this.ledger.pending().map((pending) => pending.slotKey);
      this.ledger.event('providerThrottled', {
        candidate: slot.candidate,
        provider: binding?.provider ?? 'unknown',
        code: outcome.failure.code,
        detail: outcome.failure.detail,
        slotKey: slot.slotKey,
      });
      this.ledger.recordAbort(
        `${outcome.failure.code}: the provider is throttling this subscription, so this attempt produced no answer. `
        + 'It is NOT recorded as a result and NOT counted as a failure of the model. '
        + `${blocked.length} slot(s) remain runnable; resume after the allowance resets.`,
        { code: outcome.failure.code, detail: outcome.failure.detail, candidate: slot.candidate,
          throttledSlotKey: slot.slotKey } as CanonicalValue,
        'providerThrottling', blocked);
      throw new CampaignAbort();
    }

    // 3b. WHO ACTUALLY ANSWERED. A local candidate was identified by its weights before the request;
    // a frontier candidate can only be identified by what the provider says afterwards. A provider
    // that names a different model has answered a question about a different model, and recording
    // that under this manifest would put one model's answers under another model's name.
    let providerIdentity: ProviderIdentityVerification | undefined;
    if (binding !== undefined && !isLocal(binding) && outcome.failure === undefined) {
      providerIdentity = verifyProviderIdentity(binding.requestedModelID, outcome.frontier?.reportedModelID ?? '');
      if (!providerIdentityPermitsExecution(providerIdentity)) {
        const blocked = this.ledger.pending().filter((pending) => pending.candidate === slot.candidate).map((pending) => pending.slotKey);
        this.ledger.event('providerModelSubstituted', {
          candidate: slot.candidate,
          requested: providerIdentity.requestedModelID,
          reported: providerIdentity.reportedModelID,
        });
        this.ledger.recordAbort(providerIdentity.detail, providerIdentity as unknown as CanonicalValue,
          'providerIdentityVerification', blocked);
        throw new CampaignAbort();
      }
    }

    // 4. Supplied context, checked against what the request ACTUALLY carried.
    const suppliedContext = verifySuppliedContext(promptRecord.suppliedContext, outcome.assembledContext);

    // 5. Telemetry.
    const telemetry = summariseAttempt(outcome.streamEvents, outcome.runtime, outcome.totalElapsedMilliseconds);

    // 6. Score — but only if the attempt measured the model rather than the harness.
    let status: TerminalSlotStatus;
    let governanceViolated = false;
    let detail: string;
    // The second reading of a JSON answer. Left undefined on a non-JSON case and on an attempt that
    // was never scored at all — a runtime error has no JSON verdict of either kind, and inventing
    // one would put a "semantic fail" on a row where nothing was measured.
    let jsonViews: JSONViewAdjudication | undefined;
    // WHAT THIS ATTEMPT MEASURED, on its own axis. `modelAnswered` unless something other than a
    // model determined the outcome — see `attempt-disposition.ts` for why this is not a status.
    let disposition: AttemptDisposition = 'modelAnswered';
    if (outcome.failure) {
      // 6a. A PROVIDER'S CONTENT FILTER AND A LEAKED TOOL ARE NOT `runtimeError`, and neither is a
      // model-quality failure. Both are recorded terminally — NOT aborted like a throttle — because
      // both are deterministic: the filter will refuse the same prompt every time, and `cernum
      // resume` re-running them forever would be a loop, not a recovery. The slot is finished, the
      // row is unscoreable, and the loss is counted in the provider-reliability rates instead.
      //
      // PASS 11 WIDENED THIS FROM TWO NAMED KINDS TO THE WHOLE FAILURE. It used to test for
      // `contentFiltered` and `toolContaminated` by name and call everything else `runtimeError`,
      // which is how a transport fault, a missing CLI and an exhausted allowance all became
      // model-quality failures. The decision now lives in `attempt-disposition.ts` and is made from
      // the kind AND the provider's own sentence, so one rule governs a row being written here and
      // the same row being re-read out of a sealed ledger later.
      const kind = outcome.failure.code.includes('.')
        ? outcome.failure.code.slice(outcome.failure.code.lastIndexOf('.') + 1)
        : outcome.failure.code;
      disposition = dispositionForFailure(kind, `${outcome.failure.code}: ${outcome.failure.detail}`);
      status = isScoreableDisposition(disposition) ? 'runtimeError' : NON_ANSWER_TERMINAL_STATUS;
      detail = `${outcome.failure.code}: ${outcome.failure.detail}`;
      if (disposition !== 'modelAnswered') {
        detail = `${detail} — recorded as ${disposition}: ${DISPOSITION_EXPLANATION[disposition]}`;
        this.ledger.event(disposition, {
          candidate: slot.candidate,
          provider: binding?.provider ?? 'unknown',
          caseID: slot.caseID,
          slotKey: slot.slotKey,
          code: outcome.failure.code,
          retryCount: outcome.frontier?.retryCount,
        });
      }
    } else if (!suppliedContextIsUsable(suppliedContext)) {
      // A measurement fault is recorded as one. Scoring it would report the harness's bug as the
      // model's failure, which is the single most misleading thing a benchmark can do — which is
      // precisely what happened until Pass 11, because `runtimeError` alone was counted as a fail.
      // The sentence was right and the arithmetic underneath it was not; now the row carries a
      // disposition that keeps it out of the rate the sentence says it does not belong in.
      disposition = 'measurementFault';
      status = NON_ANSWER_TERMINAL_STATUS;
      detail = `supplied context ${suppliedContext.state}: ${suppliedContext.detail}`
        + ` — recorded as ${disposition}: ${DISPOSITION_EXPLANATION[disposition]}`;
      this.ledger.event(disposition, {
        candidate: slot.candidate,
        provider: binding?.provider ?? 'unknown',
        caseID: slot.caseID,
        slotKey: slot.slotKey,
        suppliedContextState: suppliedContext.state,
      });
    } else {
      const scored = await this.host.score(slot, outcome.answerText);
      status = scored.status;
      governanceViolated = scored.governanceViolated;
      detail = scored.detail;
      jsonViews = scored.jsonViews;
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
      // ON EVERY ROW, including the ordinary ones. A field that appears only on the exceptions is a
      // field a reader has to know to look for, and its absence then means two different things.
      disposition,
      dispositionExplanation: DISPOSITION_EXPLANATION[disposition],
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
      // On every row, exactly as `canonical` is: a row lifted out of its campaign carries who
      // answered and what it cost with it, so it can never be silently merged into a set whose
      // numbers mean something else.
      provider: outcome.frontier?.provider,
      executionClass: outcome.frontier?.executionClass,
      billingBasis: outcome.frontier?.billingBasis,
      requestedModelID: outcome.frontier?.requestedModelID,
      reportedModelID: outcome.frontier?.reportedModelID,
      providerIdentityState: providerIdentity?.state,
      // WHAT WAS KNOWN ABOUT THIS CANDIDATE'S IDENTITY BEFORE THE REQUEST, on every row.
      //
      // `providerIdentityState` above says what THIS reply established, which for a Codex candidate
      // is always `unverifiable` — the tool names no model. That is not the same fact as "this
      // campaign carried a written authorization to run an unprovable candidate", and a reader with
      // only the first cannot tell an admitted row from an ordinary unverifiable one. So the binding
      // state travels on the row too, with its stamp already rendered, because a row read months
      // later will not have the manifest beside it.
      // BOTH READINGS OF A JSON ANSWER, on the row, always together.
      //
      // `status` above is and stays the strict transport-compliance verdict — the frozen result.
      // These columns are the second reading. `jsonViewsDivergent` is the one a reader should look
      // at first: it is true exactly when the object was right and the transport was not, which is
      // the fact the Pass 6 ranking could not show. Absent on a non-JSON case, and absent on an
      // attempt that was never scored.
      jsonStrictTransportStatus: jsonViews?.strictTransportStatus,
      jsonSemanticSchemaStatus: jsonViews?.semanticSchemaStatus,
      jsonSemanticDetail: jsonViews?.semanticDetail,
      jsonFenceRemoved: jsonViews?.fenceRemoved,
      jsonFenceInfoString: jsonViews?.fenceInfoString,
      jsonFenceRefusedBecause: jsonViews?.fenceRefusedBecause,
      jsonViewsDivergent: jsonViews?.divergent,
      jsonViewsDivergenceExplanation: jsonViews?.divergenceExplanation,
      jsonSemanticEvaluatorID: jsonViews?.semanticEvaluatorID,
      jsonSemanticEvaluatorVersion: jsonViews?.semanticEvaluatorVersion,
      bindingIdentityState: binding?.identityState,
      identityAdmissionStamp: binding?.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
        ? `[${REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE}] ${binding.requestedModelID} (requested, effort `
          + `${binding.effort}) — the provider accepted this identifier and something answered; it named no `
          + 'model, so this row is not a claim that this model answered. Returned model: none.'
        : undefined,
      // EVERY input token the provider processed, with the decomposition beside it.
      //
      // Pass 6 wrote the fresh remainder into this field. The two subscription CLIs leave different
      // remainders — Claude's is the 2 tokens in front of a 6,000-token cached system prompt, Codex's
      // is a total with the cached portion taken out — so one column understated Claude by ~1,650x
      // and Codex by ~1.75x while looking like a like-for-like comparison. The three fields under it
      // are what make the correction checkable from the row itself.
      inputTokens: outcome.frontier?.inputTokens,
      freshInputTokens: outcome.frontier?.freshInputTokens,
      cacheCreationInputTokens: outcome.frontier?.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.frontier?.cacheReadInputTokens,
      visibleOutputTokens: outcome.frontier?.visibleOutputTokens,
      reasoningTokens: outcome.frontier?.reasoningTokens,
      totalTokens: outcome.frontier?.totalTokens,
      usageProvenance: outcome.frontier?.usageProvenance,
      costMicroUSD: outcome.frontier?.costMicroUSD,
      costProvenance: outcome.frontier?.costProvenance,
      // THE PLAN ALLOWANCE, which Pass 6 computed and then dropped exactly here. `costMicroUSD` is
      // the marginal charge and is a true zero on a subscription; writing only that is how a report
      // tells somebody a Max plan is free. The state and the explanation travel with the figure so
      // an unreported allowance stays unreported instead of arriving somewhere as a zero.
      subscriptionIncludedUsageMicroUSD: outcome.frontier?.subscriptionIncludedUsageMicroUSD,
      subscriptionAllowanceState: outcome.frontier?.subscriptionAllowanceState,
      subscriptionAllowanceProvenance: outcome.frontier?.subscriptionAllowanceProvenance,
      subscriptionAllowanceExplanation: outcome.frontier?.subscriptionAllowanceExplanation,
      retryCount: outcome.frontier?.retryCount,
      wastedTokens: outcome.frontier?.wastedTokens,
      timedOut: outcome.frontier?.timedOut,
      providerReportedUsage: outcome.frontier?.rawUsage,
      // WHAT THE TOOL'S OWN TELEMETRY SAID, when a campaign ran a collector. Codex only, opt-in.
      //
      // `otlpTurnReasoningEffort` is the first effort figure this engine can record for a Codex
      // candidate at all. The token columns are here to be CHECKED against the stdout figures above
      // them, never to stand in for them — `otlpTokensAgreeWithStdout` is that check, and a row
      // where it is false is a row to investigate rather than to average.
      //
      // None of this touches `reportedModelID`, which stays empty on every Codex row. A row
      // carrying all of these is still `requestAcceptedIdentityUnverifiable`.
      otlpObserved: outcome.frontier?.otlpObserved,
      otlpCorrelated: outcome.frontier?.otlpCorrelated,
      otlpCorrelationKey: outcome.frontier?.otlpCorrelationKey,
      otlpTurnReasoningEffort: outcome.frontier?.otlpTurnReasoningEffort,
      otlpRequestReasoningEffort: outcome.frontier?.otlpRequestReasoningEffort,
      otlpInputTokens: outcome.frontier?.otlpInputTokens,
      otlpNonCachedInputTokens: outcome.frontier?.otlpNonCachedInputTokens,
      otlpCachedInputTokens: outcome.frontier?.otlpCachedInputTokens,
      otlpCacheWriteInputTokens: outcome.frontier?.otlpCacheWriteInputTokens,
      otlpOutputTokens: outcome.frontier?.otlpOutputTokens,
      otlpReasoningOutputTokens: outcome.frontier?.otlpReasoningOutputTokens,
      otlpTotalTokens: outcome.frontier?.otlpTotalTokens,
      otlpMCPServers: outcome.frontier?.otlpMCPServers,
      otlpTokensAgreeWithStdout: outcome.frontier?.otlpTokensAgreeWithStdout,
      otlpEffortMatchesBinding: outcome.frontier?.otlpEffortMatchesBinding,
    });

    return {
      slotKey: slot.slotKey, status, identity: identity.state, suppliedContext: suppliedContext.state,
      thinkingMode: thinking.state, providerIdentity: providerIdentity?.state, telemetry, detail,
    };
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
      operationalEnvelope: this.operationalEnvelope,
      mixedExecution: this.operationalEnvelope?.mixed ?? false,
      manifestFormatVersion: this.manifest.manifestFormatVersion,
      admittedWithoutProvenIdentity: (this.operationalEnvelope?.bindings ?? [])
        .filter((binding) => binding.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)
        .map((binding) => ({
          candidate: binding.candidate,
          requestedModelID: binding.requestedModelID,
          effort: binding.effort,
          stamp: `${binding.requestedModelID} (requested, effort ${binding.effort}) — the provider accepted this `
            + 'identifier and something answered; it named no model. Returned model: none.',
        })),
    };
  }

  // -------------------------------------------------------------------- finalize

  /**
   * Reconcile, rank, then interpret — in that order.
   *
   * A blinded packet is written whenever anything is awaiting human review, and is written BEFORE
   * the rankings are read by a person, so nobody adjudicates while holding the leaderboard.
   */
  finalize(options: { blindingSecret?: string; lockOptions?: LockOptions; authorization?: SpendingAuthorization } = {}): FinalReport {
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

    // ONE SET OF OUTCOMES, TWO TABLES. Read once and ranked twice, so the two views can never be
    // computed from different evidence or from two reads of a ledger that changed in between.
    const outcomes = outcomesFromLedger(this.ledger.results.values(), (caseID) => this.catalogue.dimensions.get(caseID));
    const rankingInputs = {
      outcomes,
      reconciliation,
      derivedAt: producedAt,
      canonical: this.canonical,
      noncanonicalBecause: this.canonical ? [] : NONCANONICAL_REASONS,
    };
    const rankings = rankCandidates({ ...rankingInputs, view: 'strictTransport' as RankingView });
    const rankingsSemanticJSONView = rankCandidates({ ...rankingInputs, view: 'semanticSchema' as RankingView });
    // On the strict table only. See the note on `FinalReport.retention`.
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

    // The metrics come out of the LEDGER, not out of an in-memory tally kept beside it. A campaign
    // half-run in a terminal and finalized in the application reaches the same totals as one done in
    // a single process, because both read the same rows.
    const rows = [...this.ledger.results.values()] as unknown as Record<string, unknown>[];
    // The same rule the ranking uses, and deliberately only `pass`: `partial` is reported beside a
    // pass and never merged into one, so a cost-per-success cannot be made to look better by
    // counting the near-misses.
    const frontierMetrics = aggregateFromRows(rows, (row) => row.status === 'pass');

    const meteredRows = rows.filter((row) => row.billingBasis === 'meteredAPI');
    const recordedMicroUSD = meteredRows.reduce((sum, row) => sum + (typeof row.costMicroUSD === 'number' ? row.costMicroUSD : 0), 0);
    const stoppedAtCeiling = this.ledger.standingAbort()?.stage === 'spendingAuthorization';
    const spending = meteredRows.length > 0 || options.authorization !== undefined
      ? {
        authorized: options.authorization !== undefined,
        hardCeilingMicroUSD: options.authorization?.hardCeilingMicroUSD,
        recordedMicroUSD,
        meteredAttempts: meteredRows.length,
        stoppedAtCeiling,
      }
      : undefined;

    // Read off the FROZEN envelope, not off the configuration's admission record. The envelope is
    // what the campaign actually ran under; a record naming a candidate the campaign never built
    // would otherwise be disclosed as though it had governed one.
    const admittedNames = new Set((this.operationalEnvelope?.bindings ?? [])
      .filter((binding) => binding.identityState === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)
      .map((binding) => `${binding.provider}:${binding.requestedModelID}:${binding.effort}`));
    const admittedCandidates = (this.configuration.identityAdmission?.admitted ?? [])
      .filter((entry) => admittedNames.has(`${entry.provider}:${entry.requestedModelID}:${entry.requestedEffort}`));

    const report: FinalReport = {
      campaignID: this.campaignID,
      label: this.configuration.label,
      manifest: { manifestID: this.manifest.manifestID, seal: manifestSeal(this.manifest), digest: this.manifest.manifestDigest },
      execution: this.execution,
      canonical: this.canonical,
      noncanonicalBecause: this.canonical ? [] : NONCANONICAL_REASONS,
      operationalEnvelope: this.operationalEnvelope,
      mixedExecutionBecause: this.operationalEnvelope?.mixed === true ? MIXED_EXECUTION_REASONS : [],
      frontierMetrics,
      spending,
      reconciliation,
      rankings,
      rankingsSemanticJSONView,
      retention,
      humanReview: { awaiting: awaiting.length, packetWritten, packetPath: packetWritten ? paths.packet : undefined, audit },
      guardTrace: this.ledger.events().filter((event) => event.kind === 'guardBreach' || event.kind === 'residencyVerified'
        || event.kind === 'residencyNotManaged' || event.kind === 'residencyNotApplicable' || event.kind === 'abort'
        || event.kind === 'spendingRefused' || event.kind === 'providerModelSubstituted'
        || event.kind === 'identityAdmitted')
        .map((event) => ({ at: String(event.at), kind: String(event.kind) })),
      identityConfidence: {
        admitted: admittedCandidates,
        stamps: admittedCandidates.map(admissionStamp),
        provenance: admittedCandidates.map(admissionProvenance),
        disclosure: admittedCandidates.length > 0 ? ADMISSION_STAMP_LONG : '',
        admission: admittedCandidates.length > 0 ? this.configuration.identityAdmission : undefined,
      },
      producedAt,
    };
    atomicWriteJSON(paths.rankings, rankings as unknown as CanonicalValue);
    atomicWriteJSON(paths.rankingsSemantic, rankingsSemanticJSONView as unknown as CanonicalValue);
    atomicWriteJSON(paths.retention, retention as unknown as CanonicalValue);
    atomicWriteJSON(paths.report, report as unknown as CanonicalValue);
    this.ledger.event('finalized', {
      complete: reconciliation.complete,
      provisional: rankings.provisional,
      // Traced on the ledger, so the existence of a divergence is part of the campaign's own record
      // and not only of a report somebody has to open.
      jsonViewDivergences: rankings.divergences.length,
    });
    return report;
  }

  // ------------------------------------------------------------------ spending authorization

  /**
   * Record the authorization that makes this campaign's paid attempts permissible.
   *
   * Written atomically, and written BEFORE the run reads it. It is never overwritten silently: a
   * second authorization for the same campaign replaces the first only because the caller asked for
   * one, and the ledger records that it happened.
   */
  writeAuthorization(authorization: SpendingAuthorization): void {
    atomicWriteJSON(campaignPaths(this.root).authorization, authorization as unknown as CanonicalValue);
    this.ledger.event('spendingAuthorized', {
      hardCeilingMicroUSD: authorization.hardCeilingMicroUSD,
      estimatedMinimumMicroUSD: authorization.estimate.totalMinimumMicroUSD,
      estimatedMaximumMicroUSD: authorization.estimate.totalMaximumMicroUSD,
      meteredCandidates: authorization.estimate.meteredCandidateCount,
      authorizedBy: authorization.authorizedBy,
      authorizationDigest: authorization.authorizationDigest,
    });
  }

  /** The authorization on disk, or undefined. Undefined is what refuses a metered run. */
  readAuthorization(): SpendingAuthorization | undefined {
    const file = campaignPaths(this.root).authorization;
    if (!fs.existsSync(file)) return undefined;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as SpendingAuthorization; } catch { return undefined; }
  }

  /** Every terminal row, as the spend tracker and the metrics need to read them. */
  ledgerRows(): Record<string, unknown>[] {
    return [...this.ledger.results.values()] as unknown as Record<string, unknown>[];
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
