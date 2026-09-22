// Benchmark engine · the COMPARATIVE MATRIX: one sealed pack, several models, several independent
// samples of each case, planned in full before anything is sent.
//
// WHY A PLAN OBJECT AND NOT A LOOP. `cernum workspace <case>` runs one case for one model, and its
// preflight renders the SAME binding object the live run executes — which is what makes a dry run
// trustworthy rather than decorative. A matrix has to keep that property across forty-eight runs,
// and the only way to do that is to build every cell up front, refusals included, and then either
// print the plan or execute exactly it. Nothing below composes a binding at execution time.
//
// SO A REFUSAL IS PART OF THE PLAN. A model whose route this machine has never proven, a provider
// with no workspace driver, a driver that cannot do what a case requires — every one of them is
// decided while the plan is built, recorded on the cell, and visible in the dry run. A matrix with
// three runnable models and one unproven one prints as exactly that, rather than discovering the
// fourth's refusal three quarters of the way through.
//
// EXECUTION ORDER IS MODEL → REPEAT → CASE, and the middle term is the deliberate one. Running all
// three repeats of a case back to back would sample the same few minutes of the same provider three
// times, and a variance figure computed from that measures one moment rather than several. Putting
// the repeat outermost within a model spreads a cell's samples across the whole of that model's
// run, which is what makes the spread columns mean anything. The model stays outermost for the
// reason `buildPlan` is candidate-major: one route is finished before the next is touched.
//
// WHAT THIS CAN AND CANNOT SAY ABOUT COST BEFORE IT RUNS. The marginal API charge is a TRUE zero for
// every workspace driver that exists, because every one of them is a subscription CLI. The plan
// ALLOWANCE is the number that is actually spent, and Cernum cannot derive it from the frozen case:
// a workspace request carries no token ceiling — see `WORKSPACE_TOKEN_CEILING_IS_UNEXPRESSED` — so
// there is no bound to compute one from. What it CAN do is read what the same model spent on the
// same sealed case before, from records on this machine, and say so as an `estimated` quantity
// naming that method. A cell with no prior evidence estimates nothing and says why.

import * as path from 'node:path';
import { DiscoveryEvidence, acceptedRequestEvidenceFor } from './discovery-store';
import {
  Quantity, estimatedQuantity, measuredQuantity, sumQuantities, unavailableQuantity,
} from './frontier-metrics';
import { buildWorkspaceDriver } from './host-factory';
import { OTLPTurnSource } from './otlp-observer';
import {
  APPLIED_EFFORT_IS_MEASURED_NOT_REQUESTED, AppliedEffortVerdict, EFFORT_VALIDITY_IS_NOT_QUALITY,
  TELEMETRY_CORRELATION_BOUNDARY, runAppliedEffortEvidence,
} from './workspace-effort-evidence';
import { WorkspaceMatrixTelemetrySource } from './workspace-matrix-telemetry';
import {
  EffortLevel, ProviderBinding, ProviderBindingError, ProviderID, billingBasisOf, executionClassOf, isMetered,
} from './provider';
import {
  ADMISSIBLE_PROVIDERS, IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionProvenance,
} from './identity-admission';
import {
  WorkspaceMatrixAdmissionEntry, WorkspaceMatrixIdentityAdmission, describeWorkspaceMatrixAdmission,
  matrixAdmissionFor, matrixAdmissionSealIsIntact, matrixCandidateName, recordAdmissionFromMatrix,
} from './workspace-matrix-admission';
import { WorkspaceAgentDriver } from './workspace-agent';
import {
  PreRunIdentity, WorkspaceBindingError, buildWorkspaceBinding, resolvePreRunIdentity, workspaceTimeoutFor,
} from './workspace-binding';
import { WorkspaceRunRow } from './workspace-aggregate';
import {
  WorkspaceCampaign, WorkspaceDriverDisclosure, discloseWorkspaceDriver, workspaceRecordPaths, workspaceRecordRoot,
} from './workspace-campaign';
import { WorkspaceCase, WorkspaceDimension, workspaceCaseDigest, workspaceComparabilityKey } from './workspace-case';
import {
  WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK, WorkspaceDifficultyProfile, WorkspaceDifficultyTier,
  describeWorkspaceDifficulty, workspaceDifficultyDigest, workspaceDifficultyProfileFor,
  workspacePackDifficultyDigest, workspacePackTier,
} from './workspace-difficulty';
import { ALWAYS_ALLOWED_ENVIRONMENT_NAMES } from './workspace-agent';
import {
  WORKSPACE_STRUCTURE_IS_NOT_DISCRIMINATION, WorkspaceStructuralProfile, describeWorkspaceStructuralProfile,
  workspacePackStructuralDigest, workspaceStructuralProfileDigest,
} from './workspace-discriminator';
import {
  WORKSPACE_REPEAT_IS_NOT_RETRY, WorkspaceBenchmarkPack, WorkspaceRepeat, planWorkspaceRepeats,
  resolveWorkspacePack, validateWorkspaceBenchmarkPack, workspacePackDigest, workspaceRepeatGroupID,
} from './workspace-pack';
import { HardwareIdentity } from './manifest';
import { WorkspaceOutcome } from './workspace-host';
import {
  ProviderThrottleScopeDecision, ProviderThrottleSignal, THROTTLE_STOPPED_THE_MATRIX_NOT_THE_MODELS,
  describeProviderThrottle, describeThrottleDeferral, detectProviderThrottle, providerThrottleScopeFor, throttleBlocks,
} from './workspace-throttle';

/**
 * Who chose the repeat count, and whether that choice differs from the sealed pack's.
 *
 * `operatorMatchedPack` exists because "the operator named a number" and "the operator changed the
 * experiment" are different facts, and only the second is worth warning about.
 */
export type WorkspaceRepeatProvenance = 'pack' | 'operatorMatchedPack' | 'operatorOverrodePack';

/** The one sentence each provenance is described by, everywhere. */
export function describeRepeatProvenance(from: WorkspaceRepeatProvenance, packRepeats: number): string {
  switch (from) {
    case 'pack':
      return 'the sealed pack\'s own number; the operator named none';
    case 'operatorMatchedPack':
      return `set by the operator, and the same number the pack asks for (${packRepeats}) — this is not an override`;
    case 'operatorOverrodePack':
      return `set by the operator, OVERRIDING the sealed pack, which asks for ${packRepeats}`;
    default:
      return 'unknown provenance';
  }
}

export class WorkspaceMatrixError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceMatrixError';
  }
}

// MARK: - What is asked

export interface WorkspaceMatrixRequest {
  pack: WorkspaceBenchmarkPack;
  /** The catalogue the pack's case ids resolve against. A pack naming a case not here is refused. */
  cases: WorkspaceCase[];
  provider: ProviderID;
  /** In the order given. Execution is model-major, so this is the order the matrix runs them in. */
  modelIDs: string[];
  effort: EffortLevel;
  /** The discovery store, read once. Identity for every model is resolved from this and nothing else. */
  discovery: DiscoveryEvidence;
  /** The operator's sample count. Defaults to the pack's, and is never silently below 1. */
  repeatsPerCase?: number;
  /** The operator's attempt ceiling. Narrows what each case allows; never widens it. */
  attemptCeiling?: number;
  /** The operator's per-attempt deadline. Narrows each case's own; never widens it. */
  timeoutMilliseconds?: number;
  campaignRoot: string;
  fixtureRoot: string;
  sandboxRoot: string;
  /**
   * The stem every record directory in this matrix is named from.
   *
   * One stem for the whole matrix is what makes forty-eight directories readable as one experiment
   * — and what lets a second matrix run on the same day not collide with the first.
   */
  runLabel: string;
  /** Prior sealed runs on this machine, used ONLY to estimate allowance. Never to score anything. */
  priorRuns?: WorkspaceRunRow[];
  /**
   * The operator's sealed MATRIX identity admission, when one was given with --admit-identity-unverifiable.
   *
   * ABSENT MEANS REFUSAL for every route whose identity cannot be established — never "admit by
   * default". There is no environment variable and no configuration key that supplies one; the only
   * way in is an explicit flag, read and sealed to this matrix's label and pack by the invocation.
   */
  identityAdmission?: WorkspaceMatrixIdentityAdmission;
  /**
   * The difficulty claims this build makes, so a preview can print the tier it is about to run.
   *
   * OPTIONAL, AND ABSENT MEANS ABSENT. A plan built without them prints no tier rather than a
   * default one: `pack.cernum.workspace.foundation-four@1` was planned and run before difficulty
   * profiles existed, and a plan that invented `tier1` for a pack nobody had judged would be
   * asserting something this build had not checked.
   */
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  /**
   * The untiered structural profiles this build carries, for the empirical discriminator family.
   * Optional and absent-means-absent, exactly like `difficultyProfiles`.
   */
  structuralProfiles?: WorkspaceStructuralProfile[];
  /**
   * THE APPLIED-EFFORT TELEMETRY this matrix plans and runs with. The CLI supplies it for every Codex
   * matrix: in a dry run with a placeholder endpoint and the result of a loopback probe, in a live run
   * with the collector itself. Absent means no collector was arranged — every Codex run is then recorded
   * `appliedEffortUnavailable` and no route can qualify, which the plan says before anything is sent.
   */
  effortTelemetry?: WorkspaceMatrixEffortTelemetry;
  /** Injected by the tests, so a matrix can be planned and run without a provider's CLI installed. */
  driverFactory?: (binding: Pick<ProviderBinding, 'provider' | 'requestedModelID' | 'effort'>,
                   context?: { otlp?: OTLPTurnSource }) => WorkspaceAgentDriver | undefined;
  /** Injected by the tests. Defaults to this process's environment. */
  environmentSource?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** The telemetry a matrix is planned and run with. See `WorkspaceMatrixRequest.effortTelemetry`. */
export interface WorkspaceMatrixEffortTelemetry {
  /** The endpoint the disclosed argv carries: the live collector's, or a placeholder in a dry run. */
  endpoint: string;
  /** Whether a loopback collector can be — or, live, was — started on this machine. */
  observerAvailable: boolean;
  availabilityDetail: string;
  /** The live collector. Absent in a dry run, which binds nothing it keeps. */
  collector?: WorkspaceMatrixTelemetrySource;
}

/**
 * What one route's matrix will measure about the effort the tool APPLIED, stated before it runs.
 *
 * A DRY RUN CANNOT PROVE AN APPLIED EFFORT, and this object is how it avoids appearing to: `appliedEffort`
 * is `toBeMeasuredLive` at best, and every consequence of a missing or contradicting measurement is
 * written out here rather than discovered afterwards.
 */
export interface WorkspaceMatrixModelEffortTelemetry {
  requestedEffort: EffortLevel;
  /** Whether this provider's applied effort can be measured at all in this build (Codex, with an effort). */
  measurable: boolean;
  /** Whether THIS matrix will measure it: measurable, and an available collector is arranged. */
  measured: boolean;
  observerAvailable: boolean;
  appliedEffort: 'toBeMeasuredLive' | 'notMeasured' | 'notApplicable';
  requirement: string;
  onMissing: string;
  onMismatch: string;
  onAmbiguous: string;
}

export const APPLIED_EFFORT_ON_MISSING =
  'the run is sealed with its workspace evidence and score, its applied effort is recorded appliedEffortUnavailable, '
  + 'and the route is NOT qualified at the requested effort. Never recorded as a provider or model failure.';
export const APPLIED_EFFORT_ON_MISMATCH =
  'the run is sealed with its workspace evidence and score, recorded appliedEffortMismatch with the effort the tool '
  + 'reported, listed beside the table, and the route is NOT qualified: that run is not evidence for the requested effort. '
  + 'The matrix continues — the distribution is itself evidence.';
export const APPLIED_EFFORT_ON_AMBIGUOUS =
  'telemetry that cannot be attributed to exactly one attempt is refused, the run is recorded appliedEffortAmbiguous, '
  + 'and the route is NOT qualified. No "nearest" record is ever substituted.';

// MARK: - The plan

/** One model's half of the matrix: what it is, whether it may run, and exactly what would be sent. */
export interface WorkspaceMatrixModel {
  modelID: string;
  candidate: string;
  identity: PreRunIdentity;
  /** Absent exactly when this model was refused. Never composed twice; the run executes this object. */
  binding?: ProviderBinding;
  driver?: WorkspaceDriverDisclosure;
  billingBasis?: string;
  executionClass?: string;
  /** Empty means this model runs. Non-empty means every one of its cells is refused, and why. */
  refusals: string[];
  runnable: boolean;
  /** Whether this route needs an identity admission, whether one was given, and whether it admitted this route. */
  admission: WorkspaceMatrixModelAdmission;
  /** What this matrix will and will not record about the effort the tool actually APPLIED. Never an identity. */
  appliedEffortEvidence: string;
  /** The same, structured: requested, measured or not, and what each failure of measurement means. */
  effortTelemetry: WorkspaceMatrixModelEffortTelemetry;
}

/**
 * One model's identity-admission position, stated in every state rather than only when it applies.
 *
 * `required` is true exactly for a route this exception exists for: an admissible provider (codexCLI)
 * whose identity this machine has not verified. A verified route never requires one — which is why a
 * Claude matrix is planned exactly as it was before this existed.
 */
export interface WorkspaceMatrixModelAdmission {
  required: boolean;
  present: boolean;
  admitted: boolean;
  /** The sealed entry that admitted this route, when one did. */
  entry?: WorkspaceMatrixAdmissionEntry;
  /** Why, in each state. */
  reason: string;
  /** For a route that needs an admission: whether an identity smoke shows the provider accepted this route. */
  acceptedRequestEvidence?: string;
}

/** One planned run: one model, one case, one repeat. The unit the matrix counts in. */
export interface WorkspaceMatrixCell {
  candidate: string;
  modelID: string;
  caseID: string;
  caseVersion: string;
  caseDigest: string;
  comparabilityKey: string;
  repeat: WorkspaceRepeat;
  /** Filesystem-safe, unique within the matrix, and readable: model, case and which sample. */
  recordName: string;
  /** The label this run's record is frozen under. Decided here, so a per-record admission can be sealed to it. */
  recordLabel: string;
  /**
   * The Pass 6 admission THIS record will freeze, derived from the matrix admission and sealed to
   * `recordLabel`. Present exactly on an admitted route's cells; derived once, here, and executed as is.
   */
  identityAdmission?: IdentityAdmission;
  recordRoot: string;
  fixturePath: string;
  fixtureExpectedTreeDigest?: string;
  /** What the frozen case allows. A retry ceiling, never a repeat count. */
  caseMaximumAttempts: number;
  /** What this run may actually use: the case's own, narrowed by the operator's cap if there is one. */
  effectiveAttemptCeiling: number;
  timeoutMilliseconds: number;
  /** What the sealed case claims to measure. Read from the case, never decided by a surface. */
  dimensions: WorkspaceDimension[];
  /** The tier this case was judged at, when this build carries a judgement. Never inferred. */
  difficultyTier?: WorkspaceDifficultyTier;
  /** `cwd1:` of that judgement, so a cell says which difficulty claim it ran under. */
  difficultyDigest?: string;
  /** `cwx1:` of the untiered structural profile, for a discriminator case. Never alongside a tier. */
  structuralDigest?: string;
  /** Empty means this cell runs. Non-empty means it is refused, and every reason is named. */
  refusals: string[];
  runnable: boolean;
}

export interface WorkspaceAllowanceEstimateCell {
  candidate: string;
  caseID: string;
  /** How many prior sealed runs of this exact experiment the estimate rests on. Zero means none. */
  basisRunCount: number;
  perRunMicroUSD: Quantity;
  cellTotalMicroUSD: Quantity;
}

export interface WorkspaceAllowanceEstimate {
  method: string;
  totalMicroUSD: Quantity;
  cells: WorkspaceAllowanceEstimateCell[];
}

export interface WorkspaceMatrixPlan {
  packID: string;
  packVersion: string;
  packTitle: string;
  packDigest: string;
  provider: ProviderID;
  effort: EffortLevel;
  modelIDs: string[];
  caseIDs: string[];
  repeatsPerCase: number;
  /**
   * WHERE THE SAMPLE COUNT CAME FROM, in three states rather than two.
   *
   * The two-state version could not tell "the operator asked for three and the pack asks for three"
   * apart from "the operator overrode the pack", and printed the override sentence for both — so a
   * dry run told an operator who had passed `--repeats 3` against a pack whose own number is 3 that
   * the pack wanted something different. Nothing was wrong with the plan; the sentence describing it
   * was false. An override is a real thing to flag and an agreement is not, so they are named apart.
   */
  repeatsFrom: WorkspaceRepeatProvenance;
  /** The sealed pack's own number, kept beside the effective one so the two are always comparable. */
  packRepeatsPerCase: number;

  models: WorkspaceMatrixModel[];
  cells: WorkspaceMatrixCell[];

  /** Independent RUNS. Not attempts, and not requests. See `WORKSPACE_REPEAT_IS_NOT_RETRY`. */
  taskRunCount: number;
  runnableRunCount: number;
  refusedRunCount: number;
  /**
   * The most times a provider could be handed a workspace by this matrix.
   *
   * The sum over runnable cells of the attempts each one may use — so a case allowing a retry
   * contributes two and a case allowing one contributes one. It is a CEILING: a matrix in which
   * everything passes first time uses the run count, not this.
   */
  maximumProviderAttemptCount: number;

  campaignRoot: string;
  recordRootPrefix: string;
  fixtureRoot: string;
  sandboxRoot: string;

  /**
   * Things this machine cannot supply that the plan asked for — an environment name no case will
   * receive, a driver executable that is not on PATH. Reported, never guessed around.
   */
  environmentShortfalls: string[];

  /** Zero for every subscription route; unavailable, with a reason, when it cannot be bounded. */
  marginalAPIChargeMicroUSD: Quantity;
  allowanceEstimate: WorkspaceAllowanceEstimate;
  repeatDisclosure: string;

  /**
   * The ONE tier every case in this pack was judged at, or `undefined` when this build carries no
   * judgement for them.
   *
   * `workspacePackTier` refuses a pack whose members do not share a tier, so a plan either states
   * one difficulty for the whole table or states none. It never averages.
   */
  difficultyTier?: WorkspaceDifficultyTier;
  /** `cwd1:` over every member's profile. Separate from `packDigest`; see `workspace-difficulty.ts`. */
  packDifficultyDigest?: string;
  /** Each member's profile, in the pack's own order. Empty when none were supplied. */
  difficultyProfiles: WorkspaceDifficultyProfile[];
  /** Said on the plan rather than left to a reader: a tier describes the task, never a model. */
  difficultyDisclosure: string;
  /** Each member's untiered structural profile, in the pack's order. Empty for a tiered or unprofiled pack. */
  structuralProfiles: WorkspaceStructuralProfile[];
  /** `cwx1:` over every member's structural profile. Separate from `packDigest`, like `packDifficultyDigest`. */
  packStructuralDigest?: string;
  /**
   * Where this matrix COULD observe recovery, computed from the sealed cases and the operator's cap.
   *
   * A design figure, not a prediction: a retry happens only where attempt 1 actually fails. A pack
   * whose `retryCapableRunCount` is zero can never produce recovery evidence however it goes, and a
   * reader deserves to know that before spending an evening on it.
   */
  designedRecovery: WorkspaceDesignedRecovery;
  /** Structure and discrimination are different questions; said on the plan so neither is mistaken for the other. */
  structureDisclosure: string;
  /**
   * Whether the run loop will stop this matrix on a provider session throttle.
   *
   * ALWAYS TRUE IN THIS BUILD, and printed anyway. An operator about to spend an evening on
   * forty-eight runs wants to see in the preview that a throttle three runs in will not silently
   * produce forty-five runs recorded as failures of the models.
   */
  throttleProtectionArmed: boolean;
  /**
   * How far a throttle from this provider would reach, and whether that was ESTABLISHED or is the
   * conservative fallback. `codexCLI` has no observed usage limit yet, so its scope is undeclared.
   */
  throttleScope: ProviderThrottleScopeDecision;
  /** The sealed matrix identity admission this plan was built under, verbatim. Absent when none was given. */
  identityAdmission?: WorkspaceMatrixIdentityAdmission;
  /** Runnable runs whose identity is admitted rather than established. Counted, never folded into quality. */
  admittedUnverifiableRunCount: number;
  /** Whether and how this matrix will measure applied effort. Stated in every plan, measured only live. */
  appliedEffortTelemetry: {
    /** Runnable runs whose applied effort will be measured from telemetry. */
    measuredRunCount: number;
    observerAvailable?: boolean;
    endpoint?: string;
    detail: string;
    correlationBoundary: string;
    disclosure: string;
  };
}

export interface WorkspaceDesignedRecovery {
  /** Cases whose effective attempt ceiling in this plan is above one. */
  retryCapableCaseIDs: string[];
  /** Runnable runs of those cases: the most runs that could ever produce a recovery opportunity. */
  retryCapableRunCount: number;
  /** Attempts beyond the first those runs may use — the part of `maximumProviderAttemptCount` that is retries. */
  additionalAttemptCeiling: number;
}

const slug = (value: string): string => value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

/**
 * Plan the whole matrix. Sends nothing, writes nothing, and makes no directory.
 *
 * Every refusal this function can reach is reached HERE, before the first request: an unproven
 * route, a provider with no workspace driver, a driver that cannot do what a case requires. The
 * dry run prints this object and the live run executes it.
 */
export function buildWorkspaceMatrixPlan(request: WorkspaceMatrixRequest): WorkspaceMatrixPlan {
  validateWorkspaceBenchmarkPack(request.pack, request.cases);
  if (request.modelIDs.length === 0) {
    throw new WorkspaceMatrixError('noModels',
      'a comparative matrix with no models compares nothing. Name at least one.');
  }
  const duplicates = request.modelIDs.filter((id, index) => request.modelIDs.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new WorkspaceMatrixError('duplicateModel',
      `${[...new Set(duplicates)].join(', ')} is named twice. Two runs of one model are REPEATS of one candidate, `
      + 'which is what --repeats is for; naming it twice would put one model on two rows of the comparison.');
  }

  const packCases = resolveWorkspacePack(request.pack, request.cases);
  const packDigest = workspacePackDigest(request.pack, request.cases);
  const packRepeatsPerCase = request.pack.repeatsPerCase;
  const repeatsPerCase = request.repeatsPerCase ?? packRepeatsPerCase;
  const repeatsFrom: WorkspaceRepeatProvenance = request.repeatsPerCase === undefined ? 'pack'
    : request.repeatsPerCase === packRepeatsPerCase ? 'operatorMatchedPack' : 'operatorOverrodePack';
  if (!Number.isInteger(repeatsPerCase) || repeatsPerCase < 1) {
    throw new WorkspaceMatrixError('nonPositiveRepeats',
      `${repeatsPerCase} repeats would record a matrix nothing sampled. Ask for at least one.`);
  }

  const environmentSource = request.environmentSource ?? process.env;
  const recordRootPrefix = workspaceRecordRoot(request.campaignRoot);
  assertAdmissionScope(request, packDigest);

  const models: WorkspaceMatrixModel[] = request.modelIDs.map((modelID) =>
    planModel(request, modelID, packCases, packDigest));
  assertEveryAdmissionEntryIsUsed(request, models);

  const cells: WorkspaceMatrixCell[] = [];
  // MODEL → REPEAT → CASE. The middle term is why a spread column means anything; see the header.
  for (const model of models) {
    for (let repeatIndex = 1; repeatIndex <= repeatsPerCase; repeatIndex++) {
      for (const workspaceCase of packCases) {
        const groupID = workspaceRepeatGroupID({
          packID: request.pack.id,
          packVersion: request.pack.version,
          candidate: model.candidate,
          comparabilityKey: workspaceComparabilityKey(workspaceCase),
        });
        const repeat = planWorkspaceRepeats(repeatsPerCase, groupID)[repeatIndex - 1];
        cells.push(planCell(request, model, workspaceCase, repeat, recordRootPrefix, packDigest));
      }
    }
  }

  const runnable = cells.filter((cell) => cell.runnable);
  const environmentShortfalls = shortfallsOfEnvironment(packCases, models, environmentSource);
  const metered = models.some((model) => model.binding !== undefined && isMetered(model.binding));

  return {
    packID: request.pack.id,
    packVersion: request.pack.version,
    packTitle: request.pack.title,
    packDigest,
    provider: request.provider,
    effort: request.effort,
    modelIDs: [...request.modelIDs],
    caseIDs: packCases.map((entry) => entry.id),
    repeatsPerCase,
    repeatsFrom,
    packRepeatsPerCase,
    models,
    cells,
    taskRunCount: cells.length,
    runnableRunCount: runnable.length,
    refusedRunCount: cells.length - runnable.length,
    maximumProviderAttemptCount: runnable.reduce((sum, cell) => sum + cell.effectiveAttemptCeiling, 0),
    campaignRoot: request.campaignRoot,
    recordRootPrefix,
    fixtureRoot: request.fixtureRoot,
    sandboxRoot: request.sandboxRoot,
    environmentShortfalls,
    // A TRUE ZERO, and the only kind of zero this engine writes. Every workspace driver that exists
    // is a subscription CLI: no card is billed for any of these runs. The allowance beside it is a
    // different currency and is never folded into this number.
    marginalAPIChargeMicroUSD: metered
      ? unavailableQuantity('at least one model in this matrix is billed per token, and a workspace request carries '
        + 'no token ceiling, so the worst case for one attempt cannot be computed. A spending ceiling enforced '
        + 'against an uncomputable bound is not a ceiling.')
      : measuredQuantity(0),
    allowanceEstimate: estimateAllowance(runnable, request.priorRuns ?? []),
    repeatDisclosure: WORKSPACE_REPEAT_IS_NOT_RETRY,
    difficultyTier: workspacePackTier(request.difficultyProfiles ?? [], packCases.map((entry) => entry.id)),
    packDifficultyDigest: workspacePackDifficultyDigest(request.difficultyProfiles ?? [], packCases.map((entry) => entry.id)),
    difficultyProfiles: packCases
      .map((entry) => workspaceDifficultyProfileFor(request.difficultyProfiles ?? [], entry.id))
      .filter((profile): profile is WorkspaceDifficultyProfile => profile !== undefined),
    difficultyDisclosure: WORKSPACE_TIER_IS_A_PROPERTY_OF_THE_TASK,
    structuralProfiles: packCases
      .map((entry) => (request.structuralProfiles ?? []).find((profile) => profile.caseID === entry.id))
      .filter((profile): profile is WorkspaceStructuralProfile => profile !== undefined),
    packStructuralDigest: workspacePackStructuralDigest(request.structuralProfiles ?? [], packCases.map((entry) => entry.id)),
    designedRecovery: {
      retryCapableCaseIDs: [...new Set(runnable.filter((cell) => cell.effectiveAttemptCeiling > 1)
        .map((cell) => cell.caseID))],
      retryCapableRunCount: runnable.filter((cell) => cell.effectiveAttemptCeiling > 1).length,
      additionalAttemptCeiling: runnable.reduce((sum, cell) => sum + cell.effectiveAttemptCeiling - 1, 0),
    },
    structureDisclosure: WORKSPACE_STRUCTURE_IS_NOT_DISCRIMINATION,
    throttleProtectionArmed: true,
    throttleScope: providerThrottleScopeFor(request.provider),
    identityAdmission: request.identityAdmission,
    admittedUnverifiableRunCount: runnable.filter((cell) => cell.identityAdmission !== undefined).length,
    appliedEffortTelemetry: {
      measuredRunCount: runnable.filter((cell) =>
        models.find((model) => model.candidate === cell.candidate)?.effortTelemetry.measured === true).length,
      observerAvailable: request.effortTelemetry?.observerAvailable,
      endpoint: request.effortTelemetry?.endpoint,
      detail: request.effortTelemetry === undefined
        ? 'no telemetry collector was arranged for this matrix'
        : request.effortTelemetry.availabilityDetail,
      correlationBoundary: TELEMETRY_CORRELATION_BOUNDARY,
      disclosure: `${APPLIED_EFFORT_IS_MEASURED_NOT_REQUESTED} ${EFFORT_VALIDITY_IS_NOT_QUALITY}`,
    },
  };
}

/**
 * Refuse a matrix admission sealed to another matrix or another pack, before any route is looked at.
 *
 * `matrixAdmissionFor` checks the same things per route; this says it once, as the whole-admission
 * error it is, rather than as the same refusal printed under every model.
 */
function assertAdmissionScope(request: WorkspaceMatrixRequest, packDigest: string): void {
  const admission = request.identityAdmission;
  if (admission === undefined) return;
  if (!matrixAdmissionSealIsIntact(admission)) {
    throw new WorkspaceMatrixError('matrixAdmissionSealBroken',
      'the matrix identity admission\'s seal does not match its contents, so what was authorised is not what is being '
      + 'asked for. Nothing was planned.');
  }
  if (admission.matrixLabel !== request.runLabel) {
    throw new WorkspaceMatrixError('matrixAdmissionScopeMismatch',
      `the matrix identity admission was sealed to matrix '${admission.matrixLabel}', not '${request.runLabel}'. An `
      + 'admission is granted to one matrix and is never carried forward.');
  }
  if (admission.packID !== request.pack.id || admission.packVersion !== request.pack.version
    || admission.packDigest !== packDigest) {
    throw new WorkspaceMatrixError('matrixAdmissionScopeMismatch',
      `the matrix identity admission names pack ${admission.packID}@${admission.packVersion} (${admission.packDigest}), `
      + `and this matrix runs ${request.pack.id}@${request.pack.version} (${packDigest}). An admission for one sealed `
      + 'pack authorises no other; write the digest this dry run prints into the admission file.');
  }
}

/**
 * Refuse an admission entry this matrix would not use.
 *
 * An entry for a model this matrix does not run, or for an effort it does not request, is an
 * authorization for something other than what is about to happen. Sealing it into this matrix would
 * make the record claim a wider exception than was exercised — so the operator writes one admission
 * per matrix, naming exactly its routes.
 */
function assertEveryAdmissionEntryIsUsed(request: WorkspaceMatrixRequest, models: WorkspaceMatrixModel[]): void {
  const admission = request.identityAdmission;
  if (admission === undefined) return;
  const unused = admission.entries.filter((entry) => !models.some((model) => model.admission.entry?.entryDigest === entry.entryDigest
    || (entry.provider === request.provider && entry.requestedModelID === model.modelID
      && entry.requestedEffort === request.effort)));
  if (unused.length > 0) {
    throw new WorkspaceMatrixError('matrixAdmissionEntryUnused',
      `the matrix identity admission names ${unused.map((entry) => entry.candidate).join(', ')}, which this matrix does not `
      + `run (it runs ${models.map((model) => model.candidate).join(', ')}). An admission names exactly the routes of the `
      + 'matrix it is sealed to; a route at another effort or on another model needs its own matrix and its own admission.');
  }
}

/** What this matrix will record about the effort the tool actually applied. Stated per route, never inferred. */
function appliedEffortEvidenceOf(request: WorkspaceMatrixRequest, disclosure: WorkspaceDriverDisclosure | undefined): string {
  if (request.effort === 'none') return 'no effort requested';
  if (request.provider === 'codexCLI') {
    const collecting = (disclosure?.invocation ?? []).some((argument) => argument.startsWith('otel'));
    return collecting && request.effortTelemetry?.observerAvailable === true
      ? `requested ${request.effort}; APPLIED effort TO BE MEASURED LIVE on every run from the CLI's own OTLP telemetry, `
        + 'joined by conversation id — a dry run proves nothing about it'
      : `requested ${request.effort} (sent as -c model_reasoning_effort); APPLIED effort is NOT MEASURED by this matrix — `
        + 'no available OTLP collector is attached, so what the tool applied is unobserved rather than assumed';
  }
  return `requested ${request.effort}; this matrix records no separate applied-effort evidence for ${request.provider}`;
}

/** The structured applied-effort position of one route. */
function effortTelemetryOf(request: WorkspaceMatrixRequest): WorkspaceMatrixModelEffortTelemetry {
  const measurable = request.provider === 'codexCLI' && request.effort !== 'none';
  const observerAvailable = request.effortTelemetry?.observerAvailable === true;
  const measured = measurable && observerAvailable;
  return {
    requestedEffort: request.effort,
    measurable,
    measured,
    observerAvailable,
    appliedEffort: !measurable ? 'notApplicable' : measured ? 'toBeMeasuredLive' : 'notMeasured',
    requirement: !measurable
      ? (request.effort === 'none' ? 'no effort requested, so there is nothing to verify'
        : `${request.provider} exposes no applied-effort telemetry this engine reads; not measured and not required`)
      : `REQUIRED for qualification: every run must verify ${request.effort} from the CLI's own telemetry`,
    onMissing: measurable ? APPLIED_EFFORT_ON_MISSING : 'not applicable',
    onMismatch: measurable ? APPLIED_EFFORT_ON_MISMATCH : 'not applicable',
    onAmbiguous: measurable ? APPLIED_EFFORT_ON_AMBIGUOUS : 'not applicable',
  };
}

function planModel(request: WorkspaceMatrixRequest, modelID: string, packCases: WorkspaceCase[],
                   packDigest: string): WorkspaceMatrixModel {
  const candidate = matrixCandidateName(request.provider, modelID, request.effort);
  const known = resolvePreRunIdentity(request.discovery, request.provider, modelID, request.now?.() ?? new Date());
  const refusals: string[] = [];

  const factory = request.driverFactory ?? buildWorkspaceDriver;
  const effortTelemetry = effortTelemetryOf(request);
  // THE DISCLOSED ARGV CARRIES THE COLLECTOR ARGUMENT whenever telemetry is arranged, so the dry run
  // prints the `-c otel=…` the live run will send — with a placeholder port, because none is bound yet.
  const planningSource: OTLPTurnSource | undefined = effortTelemetry.measurable && request.effortTelemetry !== undefined
    ? { endpoint: request.effortTelemetry.endpoint, observe: async () => undefined } : undefined;
  const driver = factory({ provider: request.provider, requestedModelID: modelID, effort: request.effort },
    planningSource === undefined ? undefined : { otlp: planningSource });
  if (driver === undefined) {
    refusals.push(`workspace driver unavailable: ${request.provider} has no workspace driver in this build, so a `
      + 'repository cannot be handed to it. Cernum does not fall back to prose execution for a workspace case.');
  }

  // The disclosure is per (driver, case) because a capability shortfall is a statement about a case;
  // the union over the pack is what decides whether this MODEL can run the pack at all.
  let disclosure: WorkspaceDriverDisclosure | undefined;
  if (driver !== undefined) {
    disclosure = discloseWorkspaceDriver(driver, packCases[0]);
    const shortfalls = new Set<string>();
    for (const entry of packCases) for (const s of discloseWorkspaceDriver(driver, entry).capabilityShortfalls) shortfalls.add(s);
    disclosure = { ...disclosure, capabilityShortfalls: [...shortfalls].sort() };
  }

  // IDENTITY ADMISSION, decided before the binding, because the binding refuses an unproven route and an
  // admitted one is exactly the route it would otherwise refuse. Admission never touches a verified route.
  const { identity, admission } = admitRoute(request, {
    modelID, candidate, known, packDigest,
    driverID: driver?.driverID ?? '',
    cliVersion: disclosure?.cliVersionVerifiedAgainst ?? '',
  });
  if (admission.required && !admission.admitted) {
    refusals.push(`identityAdmissionRequired: ${admission.reason}`);
  }

  let binding: ProviderBinding | undefined;
  try {
    // ONE BINDING PER MODEL, BUILT ONCE. The per-attempt deadline on it is the SHORTEST any case in
    // the pack will use, because the envelope has one timeout and a binding claiming the longest
    // would describe a bound no run of the shortest case was held to.
    const timeout = Math.min(...packCases.map((entry) => workspaceTimeoutFor(entry, request.timeoutMilliseconds)));
    binding = buildWorkspaceBinding({
      candidate, provider: request.provider, modelID, effort: request.effort,
      timeoutMilliseconds: timeout, identity,
    });
  } catch (error) {
    if (error instanceof WorkspaceBindingError || error instanceof ProviderBindingError) {
      refusals.push(`${error.code}: ${error.message}`);
    } else {
      throw error;
    }
  }
  // BELT AND BRACES: the admission was checked against the billing basis the provider implies; the
  // binding that was actually built must agree with it, or the admission covered some other route.
  if (binding !== undefined && admission.entry !== undefined && binding.billingBasis !== admission.entry.billingBasis) {
    refusals.push(`identityAdmissionMismatch: the binding bills as ${binding.billingBasis} and the admission covers `
      + `${admission.entry.billingBasis}.`);
  }
  if (disclosure !== undefined) refusals.push(...disclosure.capabilityShortfalls);
  // A MEASUREMENT THIS MATRIX WAS SUPPOSED TO MAKE AND CANNOT. Refused here — before anything is sent —
  // because a route whose applied effort cannot be measured cannot qualify, and spending allowance on it
  // would buy evidence nobody could use. A harness fact, never a provider or model one.
  if (effortTelemetry.measurable && request.effortTelemetry !== undefined && !request.effortTelemetry.observerAvailable) {
    refusals.push(`measurementUnavailable: the applied effort of this route is required for qualification and no loopback `
      + `telemetry collector is available on this machine (${request.effortTelemetry.availabilityDetail}). Nothing is sent.`);
  }

  return {
    modelID,
    candidate,
    identity,
    binding,
    driver: disclosure,
    billingBasis: binding?.billingBasis,
    executionClass: binding?.executionClass,
    refusals,
    runnable: refusals.length === 0 && binding !== undefined && driver !== undefined,
    admission,
    appliedEffortEvidence: appliedEffortEvidenceOf(request, disclosure),
    effortTelemetry,
  };
}

/**
 * Decide one route's admission position, and the pre-run identity it runs under.
 *
 * STRONGER EVIDENCE WINS: a verified route is returned untouched and needs nothing. Otherwise, for the
 * one admissible provider, the route runs only if the sealed matrix admission names it EXACTLY and this
 * machine holds unexpired evidence that the provider accepted the request (the identity smoke's row in
 * the discovery store). An admission never makes a route nobody has ever sent a request on runnable.
 */
function admitRoute(request: WorkspaceMatrixRequest, route: {
  modelID: string; candidate: string; known: PreRunIdentity; packDigest: string; driverID: string; cliVersion: string;
}): { identity: PreRunIdentity; admission: WorkspaceMatrixModelAdmission } {
  const present = request.identityAdmission !== undefined;
  if (route.known.state === 'verified') {
    return { identity: route.known, admission: { required: false, present, admitted: false,
      reason: 'not required — this route\'s identity is verified by the discovery store' } };
  }
  if (!ADMISSIBLE_PROVIDERS.includes(request.provider)) {
    return { identity: route.known, admission: { required: false, present, admitted: false,
      reason: `not applicable — ${request.provider} is not a provider this exception can admit; an unproven route on it `
        + 'is refused as unproven' } };
  }
  const executionClass = executionClassOf(request.provider);
  const decision = matrixAdmissionFor(request.identityAdmission, {
    matrixLabel: request.runLabel,
    provider: request.provider,
    modelID: route.modelID,
    effort: request.effort,
    candidate: route.candidate,
    packID: request.pack.id,
    packVersion: request.pack.version,
    packDigest: route.packDigest,
    driverID: route.driverID,
    cliVersion: route.cliVersion,
    executionClass,
    billingBasis: billingBasisOf(executionClass),
  });
  if (!decision.admitted || decision.entry === undefined) {
    return { identity: route.known, admission: { required: true, present, admitted: false, reason: decision.reason,
      acceptedRequestEvidence: acceptedRequestEvidenceFor(request.discovery, request.provider, route.modelID,
        request.effort, request.now?.() ?? new Date()).reason } };
  }
  const accepted = acceptedRequestEvidenceFor(request.discovery, request.provider, route.modelID, request.effort,
    request.now?.() ?? new Date());
  if (!accepted.accepted) {
    return { identity: route.known, admission: { required: true, present, admitted: false, entry: decision.entry,
      acceptedRequestEvidence: accepted.reason,
      reason: `the admission names ${route.candidate}, and this machine holds no unexpired evidence that the provider has `
        + `ever accepted a request for it at this effort: ${accepted.reason} An admission accepts an unverifiable identity; `
        + 'it does not stand in for a request nobody has sent. Run an identity smoke for this route first.' } };
  }
  const entry = decision.entry;
  return {
    identity: {
      state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      // EMPTY, and it stays empty. The requested identifier is never copied into a verified field.
      verifiedModelID: '',
      evidence: [
        `admitted for this matrix by ${request.identityAdmission?.matrixAdmissionDigest} entry ${entry.entryDigest}`,
        ...admissionProvenance({
          provider: entry.provider, requestedModelID: entry.requestedModelID, requestedEffort: entry.requestedEffort,
          cliVersion: entry.cliVersion, authenticationBasis: entry.authenticationBasis, evidenceDigest: entry.evidenceDigest,
          evidenceCapturedAt: entry.evidenceCapturedAt, returnedModelID: '', state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
        }).slice(0, 8),
        `accepted-request evidence on this machine: ${accepted.reason}`,
      ].join(' · '),
      resolvedFrom: 'identityAdmission',
    },
    admission: { required: true, present, admitted: true, entry, acceptedRequestEvidence: accepted.reason,
      reason: 'admitted by the sealed matrix admission — identity REMAINS requestAcceptedIdentityUnverifiable' },
  };
}

function planCell(request: WorkspaceMatrixRequest, model: WorkspaceMatrixModel, workspaceCase: WorkspaceCase,
                  repeat: WorkspaceRepeat, recordRootPrefix: string, packDigest: string): WorkspaceMatrixCell {
  const profile = workspaceDifficultyProfileFor(request.difficultyProfiles ?? [], workspaceCase.id);
  const structural = (request.structuralProfiles ?? []).find((entry) => entry.caseID === workspaceCase.id);
  const caseAllows = workspaceCase.execution.maximumAttempts;
  const effectiveAttemptCeiling = request.attemptCeiling === undefined
    ? caseAllows : Math.max(1, Math.min(request.attemptCeiling, caseAllows));
  const recordName = [
    slug(request.runLabel), slug(model.modelID), slug(workspaceCase.id), `r${repeat.repeatIndex}`,
  ].filter((part) => part.length > 0).join('-');
  // THE SAME LABEL THE RECORD IS FROZEN UNDER, decided here so the per-record admission can be sealed
  // to it in the plan — and so the dry run shows the seal the live record will carry.
  const recordLabel = `${request.pack.id}@${request.pack.version} · ${workspaceCase.id}@${workspaceCase.version} · `
    + `${model.candidate} · repeat ${repeat.repeatIndex}/${repeat.repeatsPlanned}`;
  const identityAdmission = model.runnable && model.admission.admitted && model.admission.entry !== undefined
    && request.identityAdmission !== undefined && request.identityAdmission.packDigest === packDigest
    ? recordAdmissionFromMatrix(request.identityAdmission, model.admission.entry, recordLabel)
    : undefined;

  return {
    candidate: model.candidate,
    modelID: model.modelID,
    caseID: workspaceCase.id,
    caseVersion: workspaceCase.version,
    caseDigest: workspaceCaseDigest(workspaceCase),
    comparabilityKey: workspaceComparabilityKey(workspaceCase),
    repeat,
    recordName,
    recordLabel,
    identityAdmission,
    recordRoot: path.join(recordRootPrefix, recordName),
    fixturePath: workspaceCase.source.fixturePath,
    fixtureExpectedTreeDigest: workspaceCase.source.expectedTreeDigest,
    caseMaximumAttempts: caseAllows,
    effectiveAttemptCeiling,
    timeoutMilliseconds: workspaceTimeoutFor(workspaceCase, request.timeoutMilliseconds),
    dimensions: [...workspaceCase.dimensions],
    difficultyTier: profile?.tier,
    difficultyDigest: profile === undefined ? undefined : workspaceDifficultyDigest(profile),
    structuralDigest: structural === undefined ? undefined : workspaceStructuralProfileDigest(structural),
    refusals: model.refusals,
    runnable: model.runnable,
  };
}

/**
 * What this machine cannot supply.
 *
 * An environment name a case asked for and this process does not have is a real shortfall: the
 * child will not receive it, and for `USER` on a subscription CLI that means the tool cannot find
 * its session. A driver executable that is not on PATH is the other one. Both are REPORTED rather
 * than refused, because a dry run on a machine that will not be the one running the matrix is a
 * legitimate thing to do.
 */
function shortfallsOfEnvironment(packCases: WorkspaceCase[], models: WorkspaceMatrixModel[],
                                 environmentSource: NodeJS.ProcessEnv): string[] {
  const shortfalls: string[] = [];
  const asked = new Set<string>();
  for (const entry of packCases) for (const name of entry.execution.environmentAllowlist) asked.add(name);
  for (const name of [...asked].sort()) {
    if (environmentSource[name] === undefined) {
      shortfalls.push(`${name} is named by a case's environment allow-list and is NOT set on this machine, so the `
        + 'agent process will not receive it. A subscription CLI that cannot find its session fails to authenticate.');
    }
  }
  for (const name of ALWAYS_ALLOWED_ENVIRONMENT_NAMES) {
    if (name === 'PATH' && environmentSource[name] === undefined) {
      shortfalls.push('PATH is not set on this machine, so no verification command could be found.');
    }
  }
  for (const model of models) {
    if (model.driver !== undefined && model.driver.invocationUndisclosed === false
      && model.driver.executablePath === undefined) {
      shortfalls.push(`${model.driver.driverID} is not on PATH, so nothing could be started for ${model.modelID}.`);
    }
  }
  return shortfalls;
}

/**
 * The only cost figure Cernum can put a number on before a workspace matrix runs.
 *
 * FROM EVIDENCE OR NOT AT ALL. A workspace binding carries no token ceiling, so there is nothing to
 * compute a worst case from; the honest alternative is to look at what the SAME model spent on the
 * SAME sealed experiment before, on this machine, and say that is the basis. `comparabilityKey`
 * decides sameness, so a fixture edit or a scope change invalidates the basis automatically.
 *
 * NEVER ACROSS MODELS. What Haiku spent on a case says nothing about what Opus will, and an
 * estimate built by borrowing one candidate's evidence for another would be a guess wearing a
 * number. A cell with no prior run of its own estimates nothing, and `sumQuantities` makes the
 * matrix total unavailable the moment one cell is — which is the correct answer for a total that
 * would otherwise be an undercount presented as a total.
 */
export function estimateAllowance(cells: WorkspaceMatrixCell[], priorRuns: WorkspaceRunRow[]): WorkspaceAllowanceEstimate {
  const method = 'the median plan allowance the SAME candidate consumed on prior sealed runs of the SAME experiment '
    + '(matched on cwk1: comparability key) on this machine, multiplied by the runs planned. Not derived from any '
    + 'token ceiling: a workspace request carries none. No evidence for a cell means no estimate for it.';

  const byCell = new Map<string, WorkspaceAllowanceEstimateCell>();
  for (const cell of cells) {
    const key = `${cell.candidate}\u0000${cell.comparabilityKey}`;
    const existing = byCell.get(key);
    if (existing !== undefined) continue;
    const basis = priorRuns
      .map((run) => run.row)
      .filter((row) => row.candidate === cell.candidate && row.comparabilityKey === cell.comparabilityKey)
      .map((row) => (typeof row.subscriptionIncludedUsageMicroUSD === 'number'
        ? row.subscriptionIncludedUsageMicroUSD : undefined))
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    const plannedRuns = cells.filter((entry) =>
      entry.candidate === cell.candidate && entry.comparabilityKey === cell.comparabilityKey).length;

    if (basis.length === 0) {
      const nothing = unavailableQuantity(
        `no sealed run of ${cell.caseID} by ${cell.candidate} exists on this machine, so there is no basis to `
        + 'estimate this cell\'s plan allowance from. It is not zero: these runs will consume allowance.');
      byCell.set(key, { candidate: cell.candidate, caseID: cell.caseID, basisRunCount: 0, perRunMicroUSD: nothing, cellTotalMicroUSD: nothing });
      continue;
    }
    const middle = Math.floor(basis.length / 2);
    const perRun = basis.length % 2 === 1 ? basis[middle] : Math.round((basis[middle - 1] + basis[middle]) / 2);
    byCell.set(key, {
      candidate: cell.candidate,
      caseID: cell.caseID,
      basisRunCount: basis.length,
      perRunMicroUSD: estimatedQuantity(perRun, method),
      cellTotalMicroUSD: estimatedQuantity(perRun * plannedRuns, method),
    });
  }

  const entries = [...byCell.values()];
  return {
    method,
    totalMicroUSD: entries.length === 0
      ? unavailableQuantity('this matrix plans no runnable cell, so there is no allowance to estimate')
      : sumQuantities(entries.map((entry) => entry.cellTotalMicroUSD),
        'at least one cell of this matrix has no prior sealed run to estimate from, so a matrix total would be an '
        + 'undercount presented as a total. The cells that CAN be estimated are listed individually.'),
    cells: entries,
  };
}

// MARK: - The preview

const dollars = (microUSD: number): string => `$${(microUSD / 1_000_000).toFixed(6)}`;

/**
 * The plan, as a person reads it. ONE renderer, so a dry run and the disclosure before a live run
 * cannot describe different matrices.
 */
export function describeWorkspaceMatrixPlan(plan: WorkspaceMatrixPlan): string[] {
  const lines: string[] = [];
  lines.push(`pack            ${plan.packID}@${plan.packVersion}  ${plan.packTitle}`);
  lines.push(`pack digest     ${plan.packDigest}`);
  lines.push(`difficulty      ${plan.difficultyTier !== undefined
    ? `${plan.difficultyTier} for every case in this pack`
    : plan.structuralProfiles.length > 0
      ? 'NO TIER — empirical discriminator family: each case carries an untiered structural profile, below'
      : 'NOT JUDGED — this build carries no difficulty profile for these cases, so no tier is claimed'}`);
  if (plan.packDifficultyDigest !== undefined) {
    lines.push(`difficulty dig. ${plan.packDifficultyDigest}  (separate from the pack digest, by design)`);
  }
  if (plan.packStructuralDigest !== undefined) {
    lines.push(`structure dig.  ${plan.packStructuralDigest}  (separate from the pack digest, by design)`);
  }
  lines.push(`provider        ${plan.provider}${plan.effort === 'none' ? '' : ` · effort ${plan.effort}`}`);
  const admissionRequired = plan.models.filter((model) => model.admission.required);
  if (plan.identityAdmission !== undefined) {
    lines.push(`identity adm.   PRESENT ${plan.identityAdmission.matrixAdmissionDigest} — `
      + `${plan.models.filter((model) => model.admission.admitted).length} route(s) admitted, `
      + `${plan.admittedUnverifiableRunCount} runnable run(s) will be identity-UNVERIFIABLE (details below)`);
  } else if (admissionRequired.length > 0) {
    lines.push(`identity adm.   ABSENT — ${admissionRequired.length} route(s) need one and are REFUSED: `
      + `${admissionRequired.map((model) => model.candidate).join(', ')}`);
  }
  lines.push(`models          ${plan.modelIDs.length}: ${plan.modelIDs.join(', ')}`);
  lines.push(`cases           ${plan.caseIDs.length}: ${plan.caseIDs.join(', ')}`);
  lines.push(`repeats         ${plan.repeatsPerCase} per case `
    + `(${describeRepeatProvenance(plan.repeatsFrom, plan.packRepeatsPerCase)})`);
  lines.push('');
  lines.push(`base task runs  ${plan.modelIDs.length} models x ${plan.caseIDs.length} cases x `
    + `${plan.repeatsPerCase} repeats = ${plan.taskRunCount} independent runs`);
  lines.push(`  runnable      ${plan.runnableRunCount}`);
  lines.push(`  refused       ${plan.refusedRunCount}`);
  lines.push(`max attempts    ${plan.maximumProviderAttemptCount} — the CEILING on times a provider could be handed a `
    + 'workspace.');
  lines.push('                A retry happens only where a case allows one and its verification failed;');
  lines.push('                a matrix that passes everything first time uses the run count above.');
  lines.push(`recovery design ${plan.designedRecovery.retryCapableRunCount === 0
    ? 'NONE — no runnable case allows a second attempt, so this matrix cannot produce recovery evidence'
    : `${plan.designedRecovery.retryCapableCaseIDs.length} case(s) allow a retry: `
      + `${plan.designedRecovery.retryCapableRunCount} runnable run(s) could each make a second attempt, `
      + `at most ${plan.designedRecovery.additionalAttemptCeiling} beyond the first.`}`);
  if (plan.designedRecovery.retryCapableRunCount > 0) {
    lines.push(`                ${plan.designedRecovery.retryCapableCaseIDs.join(', ')}`);
    lines.push('                These are OPPORTUNITIES BY DESIGN. Recovery is measured only where an attempt 1');
    lines.push('                actually fails; a run that passes first time is not recovery evidence.');
  }
  lines.push('');

  lines.push('cases, as sealed:');
  for (const caseID of plan.caseIDs) {
    const cell = plan.cells.find((entry) => entry.caseID === caseID);
    if (cell === undefined) continue;
    lines.push(`  ${`${cell.caseID}@${cell.caseVersion}`.padEnd(32)} ${cell.caseDigest}`);
    lines.push(`  ${''.padEnd(32)} ${cell.comparabilityKey}`);
    lines.push(`  ${''.padEnd(32)} fixture ${cell.fixturePath} · `
      + `${cell.fixtureExpectedTreeDigest ?? 'UNSEALED'}`);
    lines.push(`  ${''.padEnd(32)} attempts ${cell.effectiveAttemptCeiling}`
      + `${cell.effectiveAttemptCeiling < cell.caseMaximumAttempts
        ? ` (operator cap; the case allows ${cell.caseMaximumAttempts})` : ' (the case\'s own ceiling)'}`
      + ` · timeout ${cell.timeoutMilliseconds} ms`);
    const profile = plan.difficultyProfiles.find((entry) => entry.caseID === cell.caseID);
    const structural = plan.structuralProfiles.find((entry) => entry.caseID === cell.caseID);
    if (profile !== undefined) {
      for (const line of describeWorkspaceDifficulty(profile, cell.dimensions)) {
        lines.push(`  ${''.padEnd(32)} ${line}`);
      }
    } else if (structural !== undefined) {
      for (const line of describeWorkspaceStructuralProfile(structural, cell.dimensions)) {
        lines.push(`  ${''.padEnd(32)} ${line}`);
      }
    } else {
      lines.push(`  ${''.padEnd(32)} dimensions    ${cell.dimensions.join(', ')}`);
      lines.push(`  ${''.padEnd(32)} tier          not judged by this build`);
    }
  }
  lines.push('');

  lines.push('models, as bound:');
  for (const model of plan.models) {
    lines.push(`  ${model.candidate}`);
    lines.push(`    identity      ${model.identity.state}`
      + `${model.identity.verifiedModelID.length > 0 ? ` as ${model.identity.verifiedModelID}` : ''}`
      + ` · resolved from ${model.identity.resolvedFrom}`
      + `${model.identity.provenAt === undefined ? '' : `, proven ${model.identity.provenAt}`}`);
    lines.push(`    requested     ${model.modelID}${plan.effort === 'none' ? '' : ` · effort ${plan.effort}`}`);
    lines.push(`    effort        ${model.appliedEffortEvidence}`);
    if (model.effortTelemetry.measurable) {
      const telemetry = model.effortTelemetry;
      lines.push(`    applied       ${telemetry.appliedEffort === 'toBeMeasuredLive'
        ? 'TO BE MEASURED LIVE — this dry run has verified no applied effort'
        : 'NOT MEASURED — no available collector is arranged, so no run of this route can qualify'}`);
      lines.push(`    observer      ${telemetry.observerAvailable ? 'AVAILABLE' : 'UNAVAILABLE'} · ${telemetry.requirement}`);
      lines.push(`    if missing    ${telemetry.onMissing}`);
      lines.push(`    if mismatched ${telemetry.onMismatch}`);
      lines.push(`    if ambiguous  ${telemetry.onAmbiguous}`);
    }
    lines.push(`    billing       ${model.billingBasis ?? 'not bound'}`
      + `${model.executionClass === undefined ? '' : ` (${model.executionClass})`}`);
    lines.push(`    admission     ${describeModelAdmission(model)}`);
    if (model.admission.acceptedRequestEvidence !== undefined) {
      lines.push(`    smoke         ${model.admission.acceptedRequestEvidence}`);
    }
    lines.push(`    driver        ${model.driver?.driverID ?? 'NONE'}`
      + ` · ${model.driver?.executablePath ?? 'NOT FOUND ON PATH'}`);
    if (model.driver?.invocation !== undefined) {
      lines.push(`    argv          ${model.driver.invocation.map((argument) => (argument === '' ? "''" : argument)).join(' ')}`);
      lines.push('    stdin         the case instruction (never argv)');
    }
    for (const note of model.driver?.notEnforceable ?? []) lines.push(`    NOT ENFORCED  ${note}`);
    for (const refusal of model.refusals) lines.push(`    REFUSED       ${refusal}`);
    if (model.runnable) lines.push(`    validation    PASS — bound and validated by the same validateBinding every binding passes`);
  }
  lines.push('');

  lines.push(`environment     ${plan.environmentShortfalls.length === 0
    ? 'no shortfall — every name a case asked for is set on this machine'
    : `${plan.environmentShortfalls.length} SHORTFALL(S):`}`);
  for (const shortfall of plan.environmentShortfalls) lines.push(`  ! ${shortfall}`);
  lines.push('');

  lines.push(`marginal charge ${plan.marginalAPIChargeMicroUSD.provenance === 'unavailable'
    ? `UNAVAILABLE — ${plan.marginalAPIChargeMicroUSD.note}`
    : `${dollars(plan.marginalAPIChargeMicroUSD.value ?? 0)} — a TRUE zero: no card is billed by this execution class`}`);
  lines.push(`plan allowance  ${plan.allowanceEstimate.totalMicroUSD.provenance === 'unavailable'
    ? 'NOT ESTIMABLE — and not zero. ' : `about ${dollars(plan.allowanceEstimate.totalMicroUSD.value ?? 0)} (estimated). `}`);
  lines.push(`                ${plan.allowanceEstimate.method}`);
  if (plan.allowanceEstimate.totalMicroUSD.provenance === 'unavailable') {
    lines.push(`                ${plan.allowanceEstimate.totalMicroUSD.note}`);
  }
  for (const cell of plan.allowanceEstimate.cells) {
    lines.push(`  ${`${cell.candidate} · ${cell.caseID}`.padEnd(52)} `
      + `${cell.basisRunCount === 0 ? 'no prior run — no estimate'
        : `${dollars(cell.perRunMicroUSD.value ?? 0)}/run from ${cell.basisRunCount} prior run(s)`}`);
  }
  lines.push('');

  lines.push(`fixtures        ${plan.fixtureRoot}`);
  lines.push(`sandbox         ${plan.sandboxRoot}`);
  lines.push(`records         ${plan.recordRootPrefix}`);
  for (const cell of plan.cells.slice(0, 3)) lines.push(`  ${workspaceRecordPaths(cell.recordRoot).manifest}`);
  if (plan.cells.length > 3) lines.push(`  … and ${plan.cells.length - 3} more, one directory per run`);
  lines.push('');
  lines.push(`throttle guard  ${plan.throttleProtectionArmed
    ? 'ARMED — a provider session throttle stops the matrix at the run that established it, and every cell after '
      + 'it is recorded as deferred rather than as a failure of the model'
    : 'NOT ARMED'}`);
  lines.push(`throttle scope  ${plan.throttleScope.scope}${plan.throttleScope.declared
    ? ' (declared)' : ' — UNDECLARED: no throttle has been observed for this provider, so the conservative fallback applies'}`);
  lines.push(`                ${plan.throttleScope.note}`);
  if (plan.models.some((model) => model.effortTelemetry.measurable)) {
    const telemetry = plan.appliedEffortTelemetry;
    lines.push(`effort telem.   ${telemetry.observerAvailable === true
      ? `REQUIRED and ARMED — ${telemetry.measuredRunCount} runnable run(s) will have their applied effort measured live`
      : telemetry.observerAvailable === false
        ? 'REQUIRED and UNAVAILABLE — no loopback collector can be started, so the measured routes are refused'
        : 'NOT ARRANGED — no collector was supplied, so no applied effort will be measured and no route can qualify'}`);
    lines.push(`                ${telemetry.detail}`);
    if (telemetry.endpoint !== undefined) lines.push(`                endpoint ${telemetry.endpoint}`);
    lines.push(`                ${telemetry.correlationBoundary}`);
    lines.push(`                ${telemetry.disclosure}`);
  }
  if (plan.identityAdmission !== undefined) {
    lines.push('');
    for (const line of describeWorkspaceMatrixAdmission(plan.identityAdmission)) lines.push(line);
  }
  lines.push('');
  lines.push(plan.repeatDisclosure);
  lines.push('');
  lines.push(plan.difficultyDisclosure);
  if (plan.structuralProfiles.length > 0) {
    lines.push('');
    lines.push(plan.structureDisclosure);
  }
  return lines;
}

/** One model's admission position, in one line. Every state is named; none is left blank. */
export function describeModelAdmission(model: WorkspaceMatrixModel): string {
  const { admission } = model;
  if (!admission.required) return admission.reason;
  if (admission.admitted && admission.entry !== undefined) {
    return `REQUIRED — PRESENT, admitted by entry ${admission.entry.entryDigest}; identity state `
      + `${model.identity.state} (NOT verified; returned model: none)`;
  }
  return `REQUIRED — ${admission.present ? 'PRESENT BUT DOES NOT ADMIT THIS ROUTE' : 'ABSENT'}; live execution refused. `
    + admission.reason;
}

// MARK: - Execution

export interface WorkspaceMatrixRunOptions {
  hardware: HardwareIdentity;
  runtimeVersion: string;
  preserveFailedWorkspaces?: boolean;
  environmentSource?: NodeJS.ProcessEnv;
  shouldCancel?: () => boolean;
  onCellStarted?: (cell: WorkspaceMatrixCell) => void;
  onCellFinished?: (cell: WorkspaceMatrixCell, outcome: WorkspaceOutcome) => void;
  /** Called once, the moment a sealed run establishes a throttle condition. */
  onProviderThrottled?: (signal: ProviderThrottleSignal) => void;
  /** Called for each cell the breaker declines to start. Not a failure; nothing was asked. */
  onCellDeferred?: (cell: WorkspaceMatrixCell, signal: ProviderThrottleSignal) => void;
  /** Injected by the tests so a verification command need not be a real process. */
  runCommand?: Parameters<typeof WorkspaceCampaign.create>[0]['runCommand'];
}

/**
 * Why a planned cell produced no record. Four different things, and they are not interchangeable.
 *
 * The one this pass adds is `providerThrottledBeforeExecution`, and its whole point is that it is
 * NOT `harnessFault` and NOT any kind of outcome: nothing was asked of the model, so there is
 * nothing about the model to record. It must never be folded into a failure count.
 */
export type WorkspaceCellDisposition =
  /** Refused while the plan was built: an unproven route, no driver, a capability shortfall. */
  | 'refusedInPlan'
  /** The operator or the surface cancelled the matrix before this cell started. */
  | 'cancelled'
  /** A provider throttle had already been established, and it reaches this cell. */
  | 'providerThrottledBeforeExecution'
  /** The cell was attempted and the HARNESS broke — a missing fixture, an unusable sandbox. */
  | 'harnessFault'
  /**
   * The applied-effort collector this route REQUIRES had failed before this cell started, so the cell
   * was not launched: a run whose effort cannot be measured cannot qualify its route. A measurement
   * fact about this machine — never a provider decline and never a model failure.
   */
  | 'measurementUnavailableBeforeExecution';

export interface WorkspaceMatrixSkippedCell {
  cell: WorkspaceMatrixCell;
  reasons: string[];
  disposition: WorkspaceCellDisposition;
}

export interface WorkspaceMatrixRunResult {
  plan: WorkspaceMatrixPlan;
  /** One entry per cell that ran, in execution order. A refused cell has none. */
  completed: { cell: WorkspaceMatrixCell; recordRoot: string; status: string }[];
  /** Cells that were not attempted, and why. Refusals from the plan, plus anything that faulted. */
  skipped: WorkspaceMatrixSkippedCell[];

  /** The throttle that tripped the breaker, when one did. Absent means the matrix ran to the end. */
  throttle?: ProviderThrottleSignal;

  /** Every run the plan contained. Unchanged by anything that happened; `plan.cells.length`. */
  plannedRunCount: number;
  /** Runs that produced a sealed record, whatever their status. */
  executedRunCount: number;
  /** Runs never attempted because the provider had already declined. NOT failures. */
  notExecutedBecauseThrottledCount: number;
  /** Runs never attempted for any other reason — refused in the plan, cancelled, or faulted. */
  notExecutedForOtherReasonCount: number;
  /**
   * Runs whose own execution reported a DIFFERENT model than the one requested — for Codex, a
   * `model rerouted: A -> B` report. Each is a sealed, failed record. The matrix does not stop for
   * one, and nothing about it changes the pre-run identity of any later run: a reroute proves a
   * substitution happened once, never which model answers next time.
   */
  identitySubstitutions: WorkspaceIdentitySubstitution[];
  /** Why the applied-effort collector stopped working, when it did. Stops the Codex cells after it. */
  measurementFailure?: string;
  /** Runs never attempted because the collector their route requires had failed. NOT failures. */
  notExecutedBecauseMeasurementUnavailableCount: number;
  /** Every executed run's applied-effort verdict, in execution order. Empty when no run measured one. */
  appliedEffortVerdicts: WorkspaceRunAppliedEffort[];
}

/** One executed run's requested and applied effort, as sealed. */
export interface WorkspaceRunAppliedEffort {
  candidate: string;
  caseID: string;
  repeatIndex: number;
  recordRoot: string;
  requestedEffort: string;
  appliedEffort?: string;
  verdict: AppliedEffortVerdict;
  detail: string;
}

export interface WorkspaceIdentitySubstitution {
  candidate: string;
  caseID: string;
  repeatIndex: number;
  recordRoot: string;
  requestedModelID: string;
  reportedModelID: string;
  detail: string;
}

/**
 * Execute the plan, cell by cell, sealing one durable record per run.
 *
 * NOTHING IS PLANNED HERE. Every binding, every refusal and every record path came out of
 * `buildWorkspaceMatrixPlan`, so the runs that happen are exactly the ones a dry run printed.
 *
 * A CELL THAT FAULTS DOES NOT STOP THE MATRIX. A missing fixture or an unusable sandbox throws out
 * of `WorkspaceCampaign.run`, and the honest response is to record the cell as not attempted and
 * carry on: forty-seven results and one named gap is worth more than a matrix abandoned at run
 * twelve. A model's own failure is not a fault at all — it is a terminal row, and it is sealed.
 *
 * A PROVIDER THROTTLE IS THE ONE THING THAT DOES STOP IT, and only for the cells it reaches. The
 * first sealed matrix proved why: the subscription hit its session limit on run two and this loop
 * went on to hand the same exhausted session forty-six more workspaces, producing forty-six
 * further records of a 429 in about ninety seconds. Every one of those records was honest and not
 * one of them measured a model. So a run that seals with `providerThrottled` set — and ONLY that;
 * see `workspace-throttle.ts` for how narrow the condition is — establishes a signal, the signal's
 * declared scope says which later cells are futile, and those cells are recorded as NOT EXECUTED.
 *
 * NOT EXECUTED IS NOT A FAILURE, and the distinction is the whole point. A deferred cell seals no
 * record, carries no status, contributes to no rate and is not counted as anything the model did.
 * The plan it came from is returned untouched, so "forty-eight planned, two executed" is readable
 * from the result rather than inferred from a short directory listing.
 */
export async function runWorkspaceMatrix(plan: WorkspaceMatrixPlan, request: WorkspaceMatrixRequest,
                                         options: WorkspaceMatrixRunOptions): Promise<WorkspaceMatrixRunResult> {
  const completed: WorkspaceMatrixRunResult['completed'] = [];
  const skipped: WorkspaceMatrixRunResult['skipped'] = [];
  const factory = request.driverFactory ?? buildWorkspaceDriver;
  const packCases = resolveWorkspacePack(request.pack, request.cases);
  // THE BREAKER'S WHOLE STATE. One signal, set by the first run that establishes one and never
  // replaced: the first decline is the one with the evidence closest to the cause, and a later
  // identical decline would only restate it.
  let throttle: ProviderThrottleSignal | undefined;
  const substitutions: WorkspaceIdentitySubstitution[] = [];
  const appliedEffortVerdicts: WorkspaceRunAppliedEffort[] = [];
  // THE COLLECTOR IS SHARED; ATTRIBUTION IS NOT. Every run below is handed a source scoped to itself,
  // which claims each conversation id that run reports. See `workspace-matrix-telemetry.ts`.
  const collector = request.effortTelemetry?.collector;
  let measurementFailure: string | undefined;

  for (const cell of plan.cells) {
    // FIRST, because a cell the breaker has already excluded must not even be looked up: no driver
    // is built for it, no case is resolved, and nothing is sent.
    if (throttle !== undefined
      && throttleBlocks(throttle, { provider: request.provider, candidate: cell.candidate })) {
      skipped.push({
        cell,
        disposition: 'providerThrottledBeforeExecution',
        reasons: [describeThrottleDeferral(throttle)],
      });
      options.onCellDeferred?.(cell, throttle);
      continue;
    }
    if (options.shouldCancel?.()) {
      skipped.push({ cell, disposition: 'cancelled', reasons: ['the matrix was cancelled before this run started'] });
      continue;
    }
    const model = plan.models.find((entry) => entry.candidate === cell.candidate);
    if (!cell.runnable || model?.binding === undefined) {
      skipped.push({
        cell,
        disposition: 'refusedInPlan',
        reasons: cell.refusals.length > 0 ? cell.refusals : ['this cell was refused when the matrix was planned'],
      });
      continue;
    }
    // A ROUTE THAT REQUIRES MEASUREMENT IS NOT LAUNCHED WITHOUT IT. Checked before the driver exists,
    // so a collector that died stops the spend at once and every later cell says why.
    const measured = model.effortTelemetry.measured;
    const collectorFailure = !measured ? undefined
      : collector === undefined ? 'this live run was given no collector, although its plan requires one'
        : collector.failure();
    if (collectorFailure !== undefined) {
      measurementFailure ??= collectorFailure;
      skipped.push({
        cell,
        disposition: 'measurementUnavailableBeforeExecution',
        reasons: [`the applied-effort telemetry collector is unavailable (${measurementFailure}), so this run was not `
          + 'launched: its route cannot qualify without the measurement. A harness fact, not a provider or model failure.'],
      });
      continue;
    }
    const otlp = measured && collector !== undefined ? collector.sourceFor({
      runKey: cell.recordRoot, candidate: cell.candidate, caseID: cell.caseID, repeatIndex: cell.repeat.repeatIndex,
      requestedModelID: cell.modelID, requestedEffort: request.effort,
    }) : undefined;
    const driver = factory({ provider: request.provider, requestedModelID: cell.modelID, effort: request.effort },
      otlp === undefined ? undefined : { otlp });
    const workspaceCase = packCases.find((entry) => entry.id === cell.caseID);
    if (driver === undefined || workspaceCase === undefined) {
      skipped.push({
        cell,
        disposition: 'harnessFault',
        reasons: ['the driver or the case could not be resolved at execution time'],
      });
      continue;
    }

    options.onCellStarted?.(cell);
    try {
      const campaign = WorkspaceCampaign.create({
        root: cell.recordRoot,
        label: cell.recordLabel,
        case: workspaceCase,
        binding: model.binding,
        identity: model.identity,
        // THE PER-RECORD ADMISSION THE PLAN DERIVED, verbatim. `WorkspaceCampaign.create` re-checks that
        // it admits this label and this route, and that its matrix scope matches this pack and driver.
        identityAdmission: cell.identityAdmission,
        driver,
        hardware: options.hardware,
        runtimeVersion: options.runtimeVersion,
        fixtureRoot: request.fixtureRoot,
        sandboxRoot: request.sandboxRoot,
        repeat: cell.repeat,
        pack: { id: plan.packID, version: plan.packVersion, digest: plan.packDigest },
        attemptCeiling: cell.effectiveAttemptCeiling < cell.caseMaximumAttempts ? cell.effectiveAttemptCeiling : undefined,
        preserveFailedWorkspaces: options.preserveFailedWorkspaces,
        environmentSource: options.environmentSource,
        shouldCancel: options.shouldCancel,
        runCommand: options.runCommand,
        telemetryCapture: otlp === undefined ? undefined : collector?.capture,
      });
      const { outcome } = await campaign.run();
      // 1. SEAL FIRST, ALWAYS. The run that observed the decline is a complete, durable record with
      //    its own provider-decline evidence, exactly as it was before this breaker existed. The
      //    breaker changes what happens NEXT, never what this record says.
      completed.push({ cell, recordRoot: cell.recordRoot, status: outcome.scorecard.status });
      if (outcome.frontier.executionIdentityVerdict === 'substituted') {
        // RECORDED, NOT ACTED ON. The record is already sealed as failed with the served model named;
        // this list is how the result says so. It is not a reason to stop, and not evidence about any
        // other run's identity.
        substitutions.push({
          candidate: cell.candidate,
          caseID: cell.caseID,
          repeatIndex: cell.repeat.repeatIndex,
          recordRoot: cell.recordRoot,
          requestedModelID: cell.modelID,
          reportedModelID: outcome.frontier.reportedModelID ?? '',
          detail: outcome.frontier.executionIdentityDetail ?? '',
        });
      }
      // THE EFFORT VERDICT, AS SEALED. Recorded, never acted on beyond this list: a mismatch does not
      // stop the matrix, because the distribution of what the tool applied is itself the evidence.
      const effort = runAppliedEffortEvidence(outcome.run.attempts.map((attempt) => attempt.agent.appliedEffortEvidence));
      if (effort !== undefined) {
        appliedEffortVerdicts.push({
          candidate: cell.candidate, caseID: cell.caseID, repeatIndex: cell.repeat.repeatIndex,
          recordRoot: cell.recordRoot, requestedEffort: effort.requestedEffort, appliedEffort: effort.appliedEffort,
          verdict: effort.verdict, detail: effort.detail,
        });
      }
      options.onCellFinished?.(cell, outcome);

      // 2. THEN ASK WHETHER CONTINUING IS FUTILE. `providerThrottled` is set by the scorecard for
      //    `rateLimited` and `notAuthenticated` alone; every model failure, every timeout and every
      //    one-off transport fault leaves it false and the matrix carries on.
      if (throttle === undefined) {
        const deciding = outcome.run.attempts[outcome.run.attempts.length - 1];
        throttle = detectProviderThrottle({
          provider: request.provider,
          candidate: cell.candidate,
          caseID: cell.caseID,
          repeatIndex: cell.repeat.repeatIndex,
          recordRoot: cell.recordRoot,
          providerThrottled: outcome.scorecard.providerThrottled,
          detail: outcome.scorecard.detail,
          failureKind: deciding?.agent.failure?.kind,
          observedAt: (request.now?.() ?? new Date()).toISOString(),
        });
        if (throttle !== undefined) options.onProviderThrottled?.(throttle);
      }
    } catch (error) {
      skipped.push({
        cell,
        disposition: 'harnessFault',
        reasons: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const throttled = skipped.filter((entry) => entry.disposition === 'providerThrottledBeforeExecution');
  const unmeasurable = skipped.filter((entry) => entry.disposition === 'measurementUnavailableBeforeExecution');
  return {
    plan,
    completed,
    skipped,
    throttle,
    // The PLAN is the authority for what was asked for, and it is never edited by what happened.
    plannedRunCount: plan.cells.length,
    executedRunCount: completed.length,
    notExecutedBecauseThrottledCount: throttled.length,
    notExecutedForOtherReasonCount: skipped.length - throttled.length - unmeasurable.length,
    identitySubstitutions: substitutions,
    measurementFailure,
    notExecutedBecauseMeasurementUnavailableCount: unmeasurable.length,
    appliedEffortVerdicts,
  };
}

/**
 * What a matrix actually did, as a person reads it. Planned, executed, and every gap named.
 *
 * Deliberately prints the planned count FIRST and the executed count beside it, because the single
 * most misleading way to report a matrix the provider stopped is to report only what it produced.
 */
export function describeWorkspaceMatrixRunResult(result: WorkspaceMatrixRunResult): string[] {
  const lines: string[] = [];
  lines.push(`planned runs    ${result.plannedRunCount}`);
  lines.push(`executed runs   ${result.executedRunCount} (sealed, whatever their status)`);
  lines.push(`not executed    ${result.notExecutedBecauseThrottledCount} because the PROVIDER throttled`
    + ` · ${result.notExecutedForOtherReasonCount} for other reasons`);
  if (result.plan.admittedUnverifiableRunCount > 0) {
    lines.push(`identity        ${result.completed.filter((entry) => entry.cell.identityAdmission !== undefined).length} executed `
      + `run(s) ran under the matrix admission ${result.plan.identityAdmission?.matrixAdmissionDigest ?? ''} — identity `
      + 'UNVERIFIABLE, not verified');
  }
  if (result.identitySubstitutions.length > 0) {
    lines.push(`substitutions   ${result.identitySubstitutions.length} run(s) reported a DIFFERENT model than requested, and `
      + 'each failed:');
    for (const entry of result.identitySubstitutions) {
      lines.push(`  ${entry.candidate} · ${entry.caseID} · repeat ${entry.repeatIndex}: requested ${entry.requestedModelID}, `
        + `reported ${entry.reportedModelID || '(unnamed)'}`);
    }
  }
  if (result.appliedEffortVerdicts.length > 0) {
    const tally = (verdict: AppliedEffortVerdict) =>
      result.appliedEffortVerdicts.filter((entry) => entry.verdict === verdict).length;
    lines.push(`applied effort  ${tally('appliedEffortVerified')} verified · ${tally('appliedEffortMismatch')} MISMATCH · `
      + `${tally('appliedEffortAmbiguous')} ambiguous · ${tally('appliedEffortUnavailable')} unavailable `
      + `(of ${result.appliedEffortVerdicts.length} measured run(s); per candidate below)`);
    for (const entry of result.appliedEffortVerdicts.filter((run) => run.verdict === 'appliedEffortMismatch')) {
      lines.push(`  ${entry.candidate} · ${entry.caseID} · repeat ${entry.repeatIndex}: requested ${entry.requestedEffort}, `
        + `applied ${entry.appliedEffort ?? 'mixed'} — kept as evidence, NOT evidence for @${entry.requestedEffort}`);
    }
  }
  if (result.measurementFailure !== undefined) {
    lines.push(`measurement     the effort telemetry collector FAILED (${result.measurementFailure}); `
      + `${result.notExecutedBecauseMeasurementUnavailableCount} run(s) were not launched. A harness fact, not a finding `
      + 'about the provider or the models.');
  }
  if (result.throttle !== undefined) {
    lines.push('');
    for (const line of describeProviderThrottle(result.throttle)) lines.push(line);
    lines.push('');
    lines.push(THROTTLE_STOPPED_THE_MATRIX_NOT_THE_MODELS);
  }
  return lines;
}

/**
 * The identity provenance of one matrix, for its aggregate file.
 *
 * KEPT APART FROM QUALITY ON PURPOSE. Nothing here changes a score, a pass count or a rate: an admitted
 * run is scored exactly like any other, and how confidently its answer can be ATTRIBUTED is a separate
 * column a reader weighs for themselves. `rows` should be this matrix's own runs.
 */
export interface WorkspaceMatrixIdentityProvenance {
  matrixAdmission?: WorkspaceMatrixIdentityAdmission;
  candidates: {
    candidate: string;
    provider: ProviderID;
    requestedModelID: string;
    effort: EffortLevel;
    identityState: string;
    identityResolvedFrom: string;
    admissionRequired: boolean;
    admissionPresent: boolean;
    admitted: boolean;
    admissionEntryDigest?: string;
  }[];
  admittedUnverifiableRunCount: number;
  /** Runs whose own execution reported another model — a Codex reroute, or a substitution on any provider. */
  substitutionFailures: {
    candidate: string; caseID: string; repeatIndex?: number; recordRoot: string;
    requestedModelID: string; reportedModelID: string; detail: string;
  }[];
  /** Runs that began VERIFIED and whose own execution did not confirm it. Admitted runs are never counted here. */
  identityVerificationFailures: {
    candidate: string; caseID: string; repeatIndex?: number; recordRoot: string; executionIdentityVerdict: string;
  }[];
  disclosure: string;
}

export const IDENTITY_CONFIDENCE_IS_NOT_QUALITY =
  'Identity confidence and task quality are separate. A run admitted as requestAcceptedIdentityUnverifiable is '
  + 'scored exactly like a verified one, with no penalty and no bonus; what differs is how confidently the result can '
  + 'be attributed to the requested model, and that is stated beside the score rather than subtracted from it.';

export function workspaceMatrixIdentityProvenance(plan: WorkspaceMatrixPlan,
                                                  rows: WorkspaceRunRow[]): WorkspaceMatrixIdentityProvenance {
  const text = (row: Record<string, unknown>, key: string): string =>
    (typeof row[key] === 'string' ? row[key] as string : '');
  const repeatOf = (row: Record<string, unknown>): number | undefined =>
    (typeof row.repeatIndex === 'number' ? row.repeatIndex : undefined);
  return {
    matrixAdmission: plan.identityAdmission,
    candidates: plan.models.map((model) => ({
      candidate: model.candidate,
      provider: plan.provider,
      requestedModelID: model.modelID,
      effort: plan.effort,
      identityState: model.identity.state,
      identityResolvedFrom: model.identity.resolvedFrom,
      admissionRequired: model.admission.required,
      admissionPresent: model.admission.present,
      admitted: model.admission.admitted,
      admissionEntryDigest: model.admission.entry?.entryDigest,
    })),
    admittedUnverifiableRunCount: rows.filter(({ row }) =>
      text(row, 'bindingIdentityState') === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
      && plan.identityAdmission !== undefined
      && text(row, 'matrixAdmissionDigest') === plan.identityAdmission.matrixAdmissionDigest).length,
    substitutionFailures: rows
      .filter(({ row }) => text(row, 'executionIdentityVerdict') === 'substituted')
      .map(({ row, recordRoot }) => ({
        candidate: text(row, 'candidate'),
        caseID: text(row, 'caseID'),
        repeatIndex: repeatOf(row),
        recordRoot,
        requestedModelID: text(row, 'requestedModelID'),
        reportedModelID: text(row, 'reportedModelID'),
        detail: text(row, 'executionIdentityDetail'),
      })),
    identityVerificationFailures: rows
      .filter(({ row }) => text(row, 'bindingIdentityState') === 'verified'
        && text(row, 'executionIdentityVerdict') !== 'verified' && text(row, 'executionIdentityVerdict') !== '')
      .map(({ row, recordRoot }) => ({
        candidate: text(row, 'candidate'),
        caseID: text(row, 'caseID'),
        repeatIndex: repeatOf(row),
        recordRoot,
        executionIdentityVerdict: text(row, 'executionIdentityVerdict'),
      })),
    disclosure: IDENTITY_CONFIDENCE_IS_NOT_QUALITY,
  };
}
