// Benchmark engine · the durable development campaign: run it, survive an interruption, resume it.
//
// THE LEDGER IS THE PROVEN ONE, UNMODIFIED. `ledger.ts` already guarantees exactly one terminal
// result per slot, ever — the plan written once before any inference, every terminal row fsynced
// before the runner moves on, a torn final line truncated rather than guessed at, and a checkpoint
// that is a cache whose disagreement with the log is REPORTED rather than silently corrected. A
// development campaign gets all of that by using it rather than by growing a second copy with the
// same intentions and different bugs.
//
// WHAT RESUME MEANS HERE, AND WHY IT CANNOT DOUBLE-COUNT. `Ledger.pending()` is every planned slot
// with no terminal result, and `appendResult` THROWS on a slot that already has one. So a resumed
// campaign re-runs exactly the attempts that never finished, and an attempt that finished cannot be
// re-recorded even by a caller that tried. The slot key is `candidate|suite|repeat|task`, so repeat
// 2 of a task is a different slot from repeat 1 and neither can absorb the other's result.
//
// A RESUME IS REFUSED IF IT IS NOT THE SAME EXPERIMENT. The plan is written beside the ledger and
// its digest is recorded in the ledger's meta. Resuming with a plan that digests differently is a
// refusal, not a merge: the registry, the scoring contract and the candidate list are all in that
// digest, and joining results graded under two of them would produce a rate nobody can read.
//
// THE WORKSPACE IS GONE BY THE TIME A ROW IS WRITTEN, which is why the row carries the snapshot
// digests, the touched paths and the assertion outcomes rather than a path to look at. An optional
// artefact file keeps the answer text and the reader's warnings for whoever has to debug a verdict.
// A graded multi-file-edit attempt also writes its EDIT EVIDENCE (`development-edit-evidence.ts`):
// the retained bytes of every changed file and a diff of each, proven to rebuild the graded
// snapshot, and the row commits to that document by hash.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DevelopmentTask, DevelopmentProvenance } from '../core/development-benchmark';
import { developmentFixtureByID, developmentTaskByID } from '../core/development-catalog';
import { FixtureRepo } from '../core/development-fixture';
import { DEVELOPMENT_SCORING_CONTRACT_VERSION } from '../core/development-scoring';
import { CanonicalValue } from './canonical';
import { AttemptDisposition, NON_ANSWER_TERMINAL_STATUS } from './attempt-disposition';
import { DevelopmentCampaignPlan, DevelopmentPlannedAttempt, DevelopmentPlanError } from './development-plan';
import {
  DEVELOPMENT_PROMPT_VERSION, DevelopmentExecutionOutcome, LEGACY_DEVELOPMENT_PROMPT_VERSION, executeDevelopmentAttempt,
} from './development-execution';
import { DevelopmentAttemptResult, gradeDevelopmentAttempt } from './development-grading';
import {
  EditEvidenceLimits, EditEvidenceReference, buildEditEvidence, writeEditEvidence,
} from './development-edit-evidence';
import { developmentProvenance } from './development-provenance';
import { FrontierAdapter } from './frontier-adapter';
import { Ledger, PlanSlot, SlotResult, TerminalSlotStatus, atomicWriteJSON } from './ledger';
import { ProviderID } from './provider';
import { redactValue } from './redaction';

export const DEVELOPMENT_PLAN_FILE = 'development-plan.json';
export const DEVELOPMENT_ARTEFACTS_DIRECTORY = 'development-attempts';

export class DevelopmentCampaignError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DevelopmentCampaignError';
  }
}

/**
 * Create the ledger and write the plan beside it. Refuses to overwrite an existing campaign.
 *
 * `extraMeta` is recorded beside the plan's own fields and cannot replace any of them — it is how a
 * caller notes a fact about the campaign the plan does not carry, such as that it is synthetic.
 */
export function createDevelopmentCampaign(root: string, plan: DevelopmentCampaignPlan,
                                          clock?: () => string,
                                          extraMeta: Record<string, CanonicalValue> = {}): Ledger {
  fs.mkdirSync(root, { recursive: true });
  const ledger = Ledger.create(root, plan.plannableCatalog, plan.candidates.map((candidate) => ({
    name: candidate.name, modelID: candidate.binding.requestedModelID,
  })), {
    ...extraMeta,
    campaignKind: 'development',
    developmentFormatVersion: plan.formatVersion,
    developmentPlanDigest: plan.planDigest,
    label: plan.label,
    benchmarkVersion: plan.benchmarkVersion,
    benchmarkCommit: plan.benchmarkCommit,
    contractID: plan.contractID,
    contractVersion: plan.contractVersion,
    contractDigest: plan.contractDigest,
    promptVersion: plan.promptVersion,
    machineIdentifier: plan.machineIdentifier,
    platform: plan.platform,
    suiteIDs: plan.suiteIDs,
    repeats: plan.repeats,
  }, clock);
  atomicWriteJSON(path.join(root, DEVELOPMENT_PLAN_FILE), plan as unknown as CanonicalValue);
  return ledger;
}

export function readDevelopmentPlan(root: string): DevelopmentCampaignPlan {
  const file = path.join(root, DEVELOPMENT_PLAN_FILE);
  if (!fs.existsSync(file)) {
    throw new DevelopmentCampaignError('noPlan',
      `${root} holds no ${DEVELOPMENT_PLAN_FILE}. A development campaign is resumed from the plan it was created `
      + 'with; rebuilding one here would silently substitute today\'s registry for the one that was measured.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DevelopmentCampaignPlan;
}

/**
 * The prompt contract a recorded plan was sent under.
 *
 * A plan written before plans carried one was written by a runner that sent the legacy version, so
 * that is what its absence means. It is read, never written back: the plan file is evidence.
 */
export function recordedPromptVersion(plan: DevelopmentCampaignPlan): string {
  return typeof plan.promptVersion === 'string' && plan.promptVersion.length > 0
    ? plan.promptVersion : LEGACY_DEVELOPMENT_PROMPT_VERSION;
}

/**
 * Why this build may not run any more of a campaign, or undefined when it may.
 *
 * THIS BUILD SENDS EXACTLY ONE PROMPT CONTRACT. A campaign created under another would have its
 * remaining attempts asked a different question from its recorded ones, and the ledger would count
 * both toward one rate. There is no migration: the old campaign keeps its rows, and a new campaign
 * is the way to measure under the new prompt.
 */
export function promptVersionRefusal(plan: DevelopmentCampaignPlan,
                                     current: string = DEVELOPMENT_PROMPT_VERSION): string | undefined {
  const recorded = recordedPromptVersion(plan);
  if (recorded === current) return undefined;
  return `campaign ${plan.label} was created under prompt contract ${recorded}, and this build sends ${current}. `
    + 'Running its remaining attempts would join answers to two different prompts in one campaign. It is left '
    + 'exactly as recorded; start a new campaign to measure under the current prompt.';
}

/**
 * Why this build may not GRADE any more of a campaign, or undefined when it may.
 *
 * THE SAME RULE AS THE PROMPT, FOR THE SAME REASON. A campaign's plan names the scoring contract its
 * rows were graded under, and every row carries it. A build under another contract would grade the
 * remaining attempts differently while stamping them with the recorded version, and one rate would
 * be computed over two rulebooks. An old campaign is re-read under a new contract by
 * `develop-reinterpret`, beside the original and never inside it.
 */
export function contractVersionRefusal(plan: DevelopmentCampaignPlan,
                                       current: string = DEVELOPMENT_SCORING_CONTRACT_VERSION): string | undefined {
  if (plan.contractVersion === current) return undefined;
  return `campaign ${plan.label} was graded under scoring contract ${plan.contractID}@${plan.contractVersion}, and this `
    + `build grades under @${current}. Running its remaining attempts would grade one campaign by two contracts. `
    + 'It is left exactly as recorded; `develop-reinterpret` re-reads its recorded answers under the current '
    + 'contract without touching it, and a new campaign measures under the current contract.';
}

/**
 * Open an existing campaign, refusing a plan that is not the one it was created with.
 *
 * The digest covers the registry, the contract, the candidate list and every run id, so any change
 * to the experiment is a refusal here rather than a silent join two months later.
 */
export function openDevelopmentCampaign(root: string, clock?: () => string,
                                        currentPromptVersion: string = DEVELOPMENT_PROMPT_VERSION):
  { ledger: Ledger; plan: DevelopmentCampaignPlan } {
  if (!Ledger.exists(root)) {
    throw new DevelopmentCampaignError('noCampaign', `${root} holds no plan.json; there is no campaign here to resume`);
  }
  const ledger = Ledger.open(root, clock);
  const plan = readDevelopmentPlan(root);
  const recorded = ledger.meta().developmentPlanDigest;
  if (typeof recorded === 'string' && recorded !== plan.planDigest) {
    throw new DevelopmentCampaignError('planDrift',
      `the campaign at ${root} was created under plan ${recorded} and the plan file now digests to `
      + `${plan.planDigest}. The registry, the scoring contract or the candidate list changed under a campaign `
      + 'that did not. Resuming would join two measurements; start a new campaign instead.');
  }
  if (ledger.meta().campaignKind !== 'development') {
    throw new DevelopmentCampaignError('notDevelopment',
      `the campaign at ${root} is not a development campaign, and the two are graded by different contracts`);
  }
  const refusal = promptVersionRefusal(plan, currentPromptVersion);
  if (refusal !== undefined) throw new DevelopmentCampaignError('promptVersionDrift', refusal);
  const contractRefusal = contractVersionRefusal(plan);
  if (contractRefusal !== undefined) throw new DevelopmentCampaignError('contractVersionDrift', contractRefusal);
  return { ledger, plan };
}

/** The terminal status one graded development attempt takes. */
export function developmentTerminalStatus(
  graded: DevelopmentAttemptResult, outcome: DevelopmentExecutionOutcome,
): TerminalSlotStatus {
  // NOT MEASURED TAKES THE NON-ANSWER STATUS, the same one every text row with no model answer
  // takes. `TERMINAL_STATUSES` is pinned by the parity corpus and is deliberately not widened for
  // this: the precise name lives in `disposition`, which has its own vocabulary and its own rate.
  if (graded.state === 'notMeasured') return NON_ANSWER_TERMINAL_STATUS;
  // A timeout is graded AND is reported as the timeout it was. The grade says what the workspace
  // held; the status says why it stopped, and collapsing the two would lose one of them.
  if (outcome.failure?.kind === 'timeout') return 'timeout';
  const credit = graded.result!.grade.credit;
  return credit === 'full' ? 'pass' : credit === 'partial' ? 'partial' : 'fail';
}

export interface DevelopmentProgressEvent {
  kind: 'started' | 'finished' | 'skipped';
  slotKey: string;
  runID: string;
  candidate: string;
  taskID: string;
  index: number;
  total: number;
  status?: TerminalSlotStatus;
  disposition?: AttemptDisposition;
}

export interface RunDevelopmentCampaignOptions {
  root: string;
  ledger: Ledger;
  plan: DevelopmentCampaignPlan;
  /** One adapter per provider the plan names. A provider with none is refused, never skipped. */
  adapters: Partial<Record<ProviderID, FrontierAdapter>>;
  shouldCancel?: () => boolean;
  onProgress?: (event: DevelopmentProgressEvent) => void;
  /**
   * Keep the per-attempt debugging artefact and, on a graded edit attempt, its edit evidence. On by
   * default: a verdict nobody can check is not evidence.
   */
  preserveArtefacts?: boolean;
  /** Injected by the tests to exercise the bounds. `DEFAULT_EDIT_EVIDENCE_LIMITS` in life. */
  editEvidenceLimits?: EditEvidenceLimits;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected by the tests so a run is deterministic. */
  executeAttempt?: typeof executeDevelopmentAttempt;
  /** The prompt contract this build sends. Injected by the tests; `DEVELOPMENT_PROMPT_VERSION` in life. */
  currentPromptVersion?: string;
}

export interface DevelopmentCampaignProgress {
  planned: number;
  alreadyTerminal: number;
  attempted: number;
  graded: number;
  notMeasured: number;
  cancelled: boolean;
  byStatus: Record<string, number>;
  byDisposition: Record<string, number>;
}

function isoSeconds(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The task and fixture one planned attempt names, resolved from the sealed registry. */
export function materialsFor(attempt: DevelopmentPlannedAttempt): { task: DevelopmentTask; repo: FixtureRepo } {
  const task = developmentTaskByID(attempt.taskID);
  if (!task) {
    throw new DevelopmentCampaignError('unknownTask',
      `${attempt.taskID} is planned but is not in this engine's development registry. The campaign was created `
      + 'against a registry this build does not have.');
  }
  const repo = developmentFixtureByID(attempt.fixtureRepoID, attempt.fixtureRepoVersion);
  if (!repo) {
    throw new DevelopmentCampaignError('unknownFixture',
      `${attempt.taskID} runs against fixture ${attempt.fixtureRepoID}@${attempt.fixtureRepoVersion}, which this `
      + 'build does not register');
  }
  return { task, repo };
}

/**
 * The row one attempt writes. Every column a later reader needs, and no path to a directory that no
 * longer exists.
 */
export function developmentResultRow(options: {
  attempt: DevelopmentPlannedAttempt;
  plan: DevelopmentCampaignPlan;
  outcome: DevelopmentExecutionOutcome;
  graded: DevelopmentAttemptResult;
  status: TerminalSlotStatus;
  /** What was retained of a graded edit attempt's workspace. Absent on every other row. */
  editEvidence?: EditEvidenceReference;
}): Record<string, CanonicalValue | undefined> {
  const { attempt, plan, outcome, graded, status } = options;
  const candidate = plan.candidates.find((entry) => entry.name === attempt.candidate)!;
  const grade = graded.result?.grade;

  return {
    slotKey: attempt.slotKey,
    status,
    runID: attempt.runID,
    campaignKind: 'development',

    candidate: attempt.candidate,
    provider: attempt.provider,
    modelID: attempt.modelID,
    // THE CONFIGURATION THAT WAS ASKED FOR, not just the model. A model at two effort levels is two
    // candidates everywhere else in this engine, so a row that dropped the effort would let the two
    // be joined by anyone reading the rows without the plan.
    executionClass: candidate.binding.executionClass,
    billingBasis: candidate.binding.billingBasis,
    effort: candidate.binding.effort,
    thinkingMode: candidate.binding.thinkingMode,
    timeoutMilliseconds: candidate.binding.timeoutMilliseconds,
    // IDENTITY TRAVELS WITH THE ROW. A result exported on its own still says what was known about
    // who answered, so a reader cannot mistake an unverifiable candidate for a proven one.
    identityState: candidate.binding.identityState,
    verifiedModelID: candidate.binding.verifiedModelID,
    identityEvidence: candidate.binding.identityEvidence,
    // What the provider said answered THIS attempt. Empty when it said nothing — never the request.
    reportedModelID: outcome.record.reportedModelID,

    costEligibility: candidate.costVerdict.eligibility,
    costEligibilityAuthorized: candidate.costVerdict.authorized,
    costEligibilityReason: candidate.costVerdict.reason,

    suiteID: attempt.suiteID,
    suiteVersion: attempt.suiteVersion,
    suiteDigest: attempt.suiteDigest,
    dimension: attempt.dimension,
    taskID: attempt.taskID,
    taskDigest: attempt.taskDigest,
    taskKind: attempt.kind,
    comparabilityKey: attempt.comparabilityKey,
    repeat: attempt.repeat,
    fixtureRepoID: attempt.fixtureRepoID,
    fixtureRepoVersion: attempt.fixtureRepoVersion,
    fixtureRepoDigest: attempt.fixtureRepoDigest,

    benchmarkVersion: graded.provenance.benchmarkVersion,
    benchmarkCommit: graded.provenance.benchmarkCommit,
    machineIdentifier: graded.provenance.machineIdentifier,
    platform: graded.provenance.platform,
    contractID: graded.provenance.contractID,
    contractVersion: graded.provenance.contractVersion,
    contractDigest: graded.provenance.contractDigest,
    promptVersion: plan.promptVersion,
    executedAt: graded.provenance.executedAt,

    // `${provider}.${kind}: sentence`, so the failure kind is recoverable from the evidence file
    // alone and an offline re-derivation reaches the same disposition this run did.
    detail: outcome.failure
      ? `${attempt.provider}.${outcome.failure.kind}: ${outcome.failure.detail}`
      : `${attempt.provider}.answered: the attempt completed and was graded`,
    disposition: outcome.disposition,
    evaluable: outcome.evaluable,
    measurementState: graded.state,
    notMeasuredBecause: graded.notMeasuredBecause,

    baselineSnapshotDigest: graded.result?.baselineSnapshotDigest,
    resultSnapshotDigest: graded.result?.resultSnapshotDigest,
    structuralCredit: grade?.structuralCredit,
    executedCredit: grade?.executedCredit,
    credit: grade?.credit,
    creditReason: grade?.creditReason,
    heldOutPassRateMilli: grade === undefined ? undefined
      : 'measured' in grade.heldOutPassRateMilli ? grade.heldOutPassRateMilli.measured : null,
    shortcutSuspected: grade?.shortcutSuspected,
    shortcutReasons: grade?.shortcutReasons,
    metrics: grade?.metrics.map((metric) => ({
      id: metric.id,
      tier: metric.tier,
      status: metric.status,
      valueMilli: 'measured' in metric.valueMilli ? metric.valueMilli.measured : null,
      assertionIDs: metric.assertionIDs,
      detail: metric.detail,
    })),
    // EVERY ASSERTION OUTCOME, INCLUDING THE HELD-OUT ONES, recorded deterministically. A verdict
    // whose individual checks are not written down is one nobody can re-derive or dispute.
    assertionOutcomes: graded.result?.outcomes.map((outcome_) => ({
      id: outcome_.id,
      metric: outcome_.metric,
      visibility: outcome_.visibility,
      held: outcome_.held,
      shortcutProbe: outcome_.shortcutProbe,
      detail: outcome_.detail,
    })),

    answerSource: graded.answerReadBack?.source,
    answerSourceBecause: graded.answerReadBack?.because,
    answerStrictlyParsed: graded.result?.answer?.strictlyParsed,
    answerSemanticallyParsed: graded.result?.answer?.semanticallyParsed,
    answerFenceRemoved: graded.result?.answer?.fenceRemoved,
    // Contract 2: which reading was graded, and why a reading was refused. `answerStrictlyParsed`
    // above stays the compliance fact; these say how the graded object was reached.
    answerReadingRules: graded.result?.answer?.rules,
    answerReading: graded.result?.answer?.reading,
    answerTerminalObjectExtracted: graded.result?.answer?.terminalObjectExtracted,
    answerTerminalExtractionRefusedBecause: graded.result?.answer?.terminalExtractionRefusedBecause,
    answerShapeValid: graded.result?.answer?.shapeValid,
    answerShapeViolations: graded.result?.answer?.shapeViolations,

    touchedPaths: graded.touchedPaths,
    readOnlyViolationPaths: graded.readOnlyViolationPaths,
    workspaceFileCount: outcome.reading.fileCount,
    workspaceTotalBytes: outcome.reading.totalBytes,
    workspaceBounded: outcome.reading.bounded,
    workspaceWarnings: outcome.reading.warnings,
    // THE ROW COMMITS TO ITS EDIT EVIDENCE BY HASH, so a re-read can tell the document it finds from
    // the one that was written. Its state says whether the retained bytes are the graded bytes.
    editEvidence: options.editEvidence as unknown as CanonicalValue | undefined,

    // Telemetry, exactly as a text row carries it, from the same builder.
    telemetry: outcome.record as unknown as CanonicalValue,
    retryCount: outcome.retryCount,
    retryDetail: outcome.retryDetail,
    totalElapsedMilliseconds: outcome.totalElapsedMilliseconds,
  };
}

/** The file one slot's debugging artefact is written to, inside `DEVELOPMENT_ARTEFACTS_DIRECTORY`. */
export function developmentArtefactFileName(slotKey: string): string {
  return `${slotKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

/** The debugging artefact: what was asked, what came back, and what the reader complained about. */
function writeArtefact(root: string, attempt: DevelopmentPlannedAttempt, outcome: DevelopmentExecutionOutcome,
                       graded: DevelopmentAttemptResult): void {
  const directory = path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  atomicWriteJSON(path.join(directory, developmentArtefactFileName(attempt.slotKey)),
    redactValue({
      runID: attempt.runID,
      slotKey: attempt.slotKey,
      taskID: attempt.taskID,
      // The workspace itself is gone. Its path is recorded so a reader can see it was a temp
      // directory and not a checkout, which is the claim the row is making.
      workspaceRoot: outcome.workspaceRoot,
      answerText: outcome.answerText.slice(0, 200_000),
      answerSource: graded.answerReadBack?.source ?? null,
      touchedPaths: graded.touchedPaths,
      readOnlyViolationPaths: graded.readOnlyViolationPaths,
      workspaceWarnings: outcome.reading.warnings,
      failure: outcome.failure ? { kind: outcome.failure.kind, detail: outcome.failure.detail } : null,
      measurementState: graded.state,
      notMeasuredBecause: graded.notMeasuredBecause ?? null,
    } as CanonicalValue));
}

/**
 * Retain a graded edit attempt's bytes, BEFORE its row is written, so a row never names evidence
 * that is not yet on disk. An interruption between the two leaves the slot pending, and its re-run
 * overwrites the orphaned document.
 */
function editEvidenceFor(root: string, attempt: DevelopmentPlannedAttempt, repo: FixtureRepo,
                         outcome: DevelopmentExecutionOutcome, graded: DevelopmentAttemptResult, preserve: boolean,
                         limits?: EditEvidenceLimits): EditEvidenceReference {
  const evidence = buildEditEvidence({
    slotKey: attempt.slotKey,
    runID: attempt.runID,
    taskID: attempt.taskID,
    repo,
    result: outcome.reading.snapshot,
    gradedResultSnapshotDigest: graded.result!.resultSnapshotDigest,
    gradedBaselineSnapshotDigest: graded.result!.baselineSnapshotDigest,
    gradedFromBoundedReading: outcome.reading.bounded,
    limits,
  });
  if (preserve) return writeEditEvidence(root, evidence, repo);
  return {
    file: '', sha256: '', state: 'notRetained',
    notByteExactBecause: ['the runner was told not to preserve artefacts, so no bytes were retained'],
    changedFileCount: evidence.changedFileCount, retainedBytes: 0, resultSnapshotSha256: evidence.result.snapshotSha256,
  };
}

function provenanceFor(attempt: DevelopmentPlannedAttempt, plan: DevelopmentCampaignPlan,
                       executedAt: string): DevelopmentProvenance {
  return developmentProvenance({
    benchmarkVersion: plan.benchmarkVersion,
    benchmarkCommit: plan.benchmarkCommit,
    machine: { machineIdentifier: plan.machineIdentifier, platform: plan.platform },
    suiteID: attempt.suiteID,
    suiteVersion: attempt.suiteVersion,
    suiteDigest: attempt.suiteDigest,
    taskID: attempt.taskID,
    taskDigest: attempt.taskDigest,
    comparabilityKey: attempt.comparabilityKey,
    fixtureRepoID: attempt.fixtureRepoID,
    fixtureRepoVersion: attempt.fixtureRepoVersion,
    fixtureRepoDigest: attempt.fixtureRepoDigest,
    contractID: plan.contractID,
    contractVersion: plan.contractVersion,
    contractDigest: plan.contractDigest,
    executedAt,
  });
}

/**
 * Run every attempt that has not already finished.
 *
 * SAFE TO CALL AGAIN AT ANY POINT. It reads `pending()` from the ledger, so calling it on a complete
 * campaign runs nothing and calling it after an interruption runs exactly what was left.
 */
export async function runDevelopmentCampaign(
  options: RunDevelopmentCampaignOptions,
): Promise<DevelopmentCampaignProgress> {
  const { ledger, plan } = options;
  const now = options.now ?? (() => new Date());
  const execute = options.executeAttempt ?? executeDevelopmentAttempt;
  const preserve = options.preserveArtefacts ?? true;

  // Checked again here, not only on open: a caller that built the ledger itself must not be able to
  // run a campaign's remaining attempts under a prompt its recorded attempts were never sent.
  const refusal = promptVersionRefusal(plan, options.currentPromptVersion);
  if (refusal !== undefined) throw new DevelopmentCampaignError('promptVersionDrift', refusal);
  const contractRefusal = contractVersionRefusal(plan);
  if (contractRefusal !== undefined) throw new DevelopmentCampaignError('contractVersionDrift', contractRefusal);

  const byKey = new Map(plan.attempts.map((attempt) => [attempt.slotKey, attempt]));
  const pending: PlanSlot[] = ledger.pending();
  const progress: DevelopmentCampaignProgress = {
    planned: ledger.plan.length,
    alreadyTerminal: ledger.plan.length - pending.length,
    attempted: 0,
    graded: 0,
    notMeasured: 0,
    cancelled: false,
    byStatus: {},
    byDisposition: {},
  };

  ledger.event('developmentRunStarted', {
    planDigest: plan.planDigest, pending: pending.length, alreadyTerminal: progress.alreadyTerminal,
  });

  for (const [index, slot] of pending.entries()) {
    if (options.shouldCancel?.()) {
      progress.cancelled = true;
      ledger.event('developmentRunCancelled', { at: slot.slotKey, remaining: pending.length - index });
      break;
    }

    const attempt = byKey.get(slot.slotKey);
    if (!attempt) {
      throw new DevelopmentCampaignError('slotNotPlanned',
        `the ledger holds slot ${slot.slotKey}, which the plan does not describe. The plan file and the ledger `
        + 'disagree about what this campaign is.');
    }

    const candidate = plan.candidates.find((entry) => entry.name === attempt.candidate);
    if (!candidate) {
      throw new DevelopmentCampaignError('unknownCandidate', `${attempt.candidate} is planned but has no binding`);
    }
    const adapter = options.adapters[attempt.provider];
    if (!adapter) {
      // REFUSED, NEVER SKIPPED. A silently skipped provider leaves a campaign that reports a
      // denominator it never ran against.
      throw new DevelopmentCampaignError('noAdapter',
        `${attempt.candidate} runs on ${attempt.provider} and no adapter for it was supplied. The campaign is `
        + 'stopped rather than continued with that candidate silently absent from its own results.');
    }

    const { task, repo } = materialsFor(attempt);
    options.onProgress?.({
      kind: 'started', slotKey: slot.slotKey, runID: attempt.runID, candidate: attempt.candidate,
      taskID: attempt.taskID, index: index + 1, total: pending.length,
    });

    const outcome = await execute({
      task, repo, binding: candidate.binding, adapter,
      runID: attempt.runID, slotKey: attempt.slotKey,
      shouldCancel: options.shouldCancel, sleep: options.sleep,
    });

    // A CANCELLED ATTEMPT IS NOT AN OUTCOME, AND IT IS NOT RECORDED. The operator stopped it; no model
    // finished and no transport failed. Writing it would make the slot terminal forever — a resume
    // could never run it, and the task could never reach its required repeats — so the slot is left
    // pending and the run stops here, which is the slot-boundary pause the text campaign has.
    if (outcome.failure?.kind === 'cancelled') {
      progress.cancelled = true;
      ledger.event('developmentAttemptCancelled', { slotKey: slot.slotKey, runID: attempt.runID });
      break;
    }

    const graded = gradeDevelopmentAttempt({
      task, repo, outcome, provenance: provenanceFor(attempt, plan, isoSeconds(now())),
    });
    const status = developmentTerminalStatus(graded, outcome);

    if (preserve) writeArtefact(options.root, attempt, outcome, graded);
    const editEvidence = task.kind === 'repositoryEdit' && graded.state === 'graded'
      ? editEvidenceFor(options.root, attempt, repo, outcome, graded, preserve, options.editEvidenceLimits)
      : undefined;

    // THE FSYNC THE WHOLE CAMPAIGN RESTS ON. The row is durable before the runner moves on, so an
    // interruption after this line can never re-run this attempt and an interruption before it can
    // never leave a half-recorded one.
    ledger.appendResult(developmentResultRow({ attempt, plan, outcome, graded, status, editEvidence }) as SlotResult);
    ledger.writeCheckpoint({ planDigest: plan.planDigest, campaignKind: 'development' });

    progress.attempted += 1;
    if (graded.state === 'graded') progress.graded += 1; else progress.notMeasured += 1;
    progress.byStatus[status] = (progress.byStatus[status] ?? 0) + 1;
    progress.byDisposition[outcome.disposition] = (progress.byDisposition[outcome.disposition] ?? 0) + 1;

    options.onProgress?.({
      kind: 'finished', slotKey: slot.slotKey, runID: attempt.runID, candidate: attempt.candidate,
      taskID: attempt.taskID, index: index + 1, total: pending.length, status, disposition: outcome.disposition,
    });
  }

  ledger.writeCheckpoint({ planDigest: plan.planDigest, campaignKind: 'development' });
  ledger.event('developmentRunFinished', {
    attempted: progress.attempted, graded: progress.graded, notMeasured: progress.notMeasured,
    cancelled: progress.cancelled,
  });
  return progress;
}

/** A planned attempt this build cannot run, named at preview time rather than discovered mid-run. */
export function unrunnableAttempts(plan: DevelopmentCampaignPlan,
                                   adapters: Partial<Record<ProviderID, FrontierAdapter>>): string[] {
  const missing = new Set<string>();
  for (const attempt of plan.attempts) {
    if (!adapters[attempt.provider]) missing.add(`${attempt.candidate} needs an adapter for ${attempt.provider}`);
    try {
      materialsFor(attempt);
    } catch (error) {
      if (error instanceof DevelopmentCampaignError || error instanceof DevelopmentPlanError) missing.add(error.message);
      else throw error;
    }
  }
  return [...missing].sort();
}
