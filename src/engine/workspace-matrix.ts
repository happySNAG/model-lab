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
import { DiscoveryEvidence } from './discovery-store';
import {
  Quantity, estimatedQuantity, measuredQuantity, sumQuantities, unavailableQuantity,
} from './frontier-metrics';
import { buildWorkspaceDriver } from './host-factory';
import { EffortLevel, ProviderBinding, ProviderBindingError, ProviderID, isMetered } from './provider';
import { WorkspaceAgentDriver } from './workspace-agent';
import {
  PreRunIdentity, WorkspaceBindingError, buildWorkspaceBinding, resolvePreRunIdentity, workspaceTimeoutFor,
} from './workspace-binding';
import { WorkspaceRunRow } from './workspace-aggregate';
import {
  WorkspaceCampaign, WorkspaceDriverDisclosure, discloseWorkspaceDriver, workspaceRecordPaths, workspaceRecordRoot,
} from './workspace-campaign';
import { WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey } from './workspace-case';
import { ALWAYS_ALLOWED_ENVIRONMENT_NAMES } from './workspace-agent';
import {
  WORKSPACE_REPEAT_IS_NOT_RETRY, WorkspaceBenchmarkPack, WorkspaceRepeat, planWorkspaceRepeats,
  resolveWorkspacePack, validateWorkspaceBenchmarkPack, workspacePackDigest, workspaceRepeatGroupID,
} from './workspace-pack';
import { HardwareIdentity } from './manifest';
import { WorkspaceOutcome } from './workspace-host';

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
  /** Injected by the tests, so a matrix can be planned and run without a provider's CLI installed. */
  driverFactory?: (binding: Pick<ProviderBinding, 'provider' | 'requestedModelID' | 'effort'>)
  => WorkspaceAgentDriver | undefined;
  /** Injected by the tests. Defaults to this process's environment. */
  environmentSource?: NodeJS.ProcessEnv;
  now?: () => Date;
}

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
  recordRoot: string;
  fixturePath: string;
  fixtureExpectedTreeDigest?: string;
  /** What the frozen case allows. A retry ceiling, never a repeat count. */
  caseMaximumAttempts: number;
  /** What this run may actually use: the case's own, narrowed by the operator's cap if there is one. */
  effectiveAttemptCeiling: number;
  timeoutMilliseconds: number;
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
  /** Whether the sample count came from the sealed pack or from the operator. */
  repeatsFrom: 'pack' | 'operator';

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
  const repeatsFrom: 'pack' | 'operator' = request.repeatsPerCase === undefined ? 'pack' : 'operator';
  const repeatsPerCase = request.repeatsPerCase ?? request.pack.repeatsPerCase;
  if (!Number.isInteger(repeatsPerCase) || repeatsPerCase < 1) {
    throw new WorkspaceMatrixError('nonPositiveRepeats',
      `${repeatsPerCase} repeats would record a matrix nothing sampled. Ask for at least one.`);
  }

  const environmentSource = request.environmentSource ?? process.env;
  const recordRootPrefix = workspaceRecordRoot(request.campaignRoot);

  const models: WorkspaceMatrixModel[] = request.modelIDs.map((modelID) =>
    planModel(request, modelID, packCases));

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
        cells.push(planCell(request, model, workspaceCase, repeat, recordRootPrefix));
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
  };
}

function planModel(request: WorkspaceMatrixRequest, modelID: string, packCases: WorkspaceCase[]): WorkspaceMatrixModel {
  const candidate = `${request.provider}:${modelID}${request.effort === 'none' ? '' : `@${request.effort}`}`;
  const identity = resolvePreRunIdentity(request.discovery, request.provider, modelID, request.now?.() ?? new Date());
  const refusals: string[] = [];

  const factory = request.driverFactory ?? buildWorkspaceDriver;
  const driver = factory({ provider: request.provider, requestedModelID: modelID, effort: request.effort });
  if (driver === undefined) {
    refusals.push(`workspace driver unavailable: ${request.provider} has no workspace driver in this build, so a `
      + 'repository cannot be handed to it. Cernum does not fall back to prose execution for a workspace case.');
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

  // The disclosure is per (driver, case) because a capability shortfall is a statement about a case;
  // the union over the pack is what decides whether this MODEL can run the pack at all.
  let disclosure: WorkspaceDriverDisclosure | undefined;
  if (driver !== undefined) {
    disclosure = discloseWorkspaceDriver(driver, packCases[0]);
    const shortfalls = new Set<string>();
    for (const entry of packCases) for (const s of discloseWorkspaceDriver(driver, entry).capabilityShortfalls) shortfalls.add(s);
    disclosure = { ...disclosure, capabilityShortfalls: [...shortfalls].sort() };
    refusals.push(...disclosure.capabilityShortfalls);
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
  };
}

function planCell(request: WorkspaceMatrixRequest, model: WorkspaceMatrixModel, workspaceCase: WorkspaceCase,
                  repeat: WorkspaceRepeat, recordRootPrefix: string): WorkspaceMatrixCell {
  const caseAllows = workspaceCase.execution.maximumAttempts;
  const effectiveAttemptCeiling = request.attemptCeiling === undefined
    ? caseAllows : Math.max(1, Math.min(request.attemptCeiling, caseAllows));
  const recordName = [
    slug(request.runLabel), slug(model.modelID), slug(workspaceCase.id), `r${repeat.repeatIndex}`,
  ].filter((part) => part.length > 0).join('-');

  return {
    candidate: model.candidate,
    modelID: model.modelID,
    caseID: workspaceCase.id,
    caseVersion: workspaceCase.version,
    caseDigest: workspaceCaseDigest(workspaceCase),
    comparabilityKey: workspaceComparabilityKey(workspaceCase),
    repeat,
    recordName,
    recordRoot: path.join(recordRootPrefix, recordName),
    fixturePath: workspaceCase.source.fixturePath,
    fixtureExpectedTreeDigest: workspaceCase.source.expectedTreeDigest,
    caseMaximumAttempts: caseAllows,
    effectiveAttemptCeiling,
    timeoutMilliseconds: workspaceTimeoutFor(workspaceCase, request.timeoutMilliseconds),
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
  lines.push(`provider        ${plan.provider}${plan.effort === 'none' ? '' : ` · effort ${plan.effort}`}`);
  lines.push(`models          ${plan.modelIDs.length}: ${plan.modelIDs.join(', ')}`);
  lines.push(`cases           ${plan.caseIDs.length}: ${plan.caseIDs.join(', ')}`);
  lines.push(`repeats         ${plan.repeatsPerCase} per case (${plan.repeatsFrom === 'pack'
    ? 'the sealed pack\'s own number' : 'set by the operator; the pack asks for a different number'})`);
  lines.push('');
  lines.push(`base task runs  ${plan.modelIDs.length} models x ${plan.caseIDs.length} cases x `
    + `${plan.repeatsPerCase} repeats = ${plan.taskRunCount} independent runs`);
  lines.push(`  runnable      ${plan.runnableRunCount}`);
  lines.push(`  refused       ${plan.refusedRunCount}`);
  lines.push(`max attempts    ${plan.maximumProviderAttemptCount} — the CEILING on times a provider could be handed a `
    + 'workspace.');
  lines.push('                A retry happens only where a case allows one and its verification failed;');
  lines.push('                a matrix that passes everything first time uses the run count above.');
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
  }
  lines.push('');

  lines.push('models, as bound:');
  for (const model of plan.models) {
    lines.push(`  ${model.candidate}`);
    lines.push(`    identity      ${model.identity.state}`
      + `${model.identity.verifiedModelID.length > 0 ? ` as ${model.identity.verifiedModelID}` : ''}`
      + ` · resolved from ${model.identity.resolvedFrom}`
      + `${model.identity.provenAt === undefined ? '' : `, proven ${model.identity.provenAt}`}`);
    lines.push(`    billing       ${model.billingBasis ?? 'not bound'}`
      + `${model.executionClass === undefined ? '' : ` (${model.executionClass})`}`);
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
  lines.push(plan.repeatDisclosure);
  return lines;
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
  /** Injected by the tests so a verification command need not be a real process. */
  runCommand?: Parameters<typeof WorkspaceCampaign.create>[0]['runCommand'];
}

export interface WorkspaceMatrixRunResult {
  plan: WorkspaceMatrixPlan;
  /** One entry per cell that ran, in execution order. A refused cell has none. */
  completed: { cell: WorkspaceMatrixCell; recordRoot: string; status: string }[];
  /** Cells that were not attempted, and why. Refusals from the plan, plus anything that faulted. */
  skipped: { cell: WorkspaceMatrixCell; reasons: string[] }[];
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
 */
export async function runWorkspaceMatrix(plan: WorkspaceMatrixPlan, request: WorkspaceMatrixRequest,
                                         options: WorkspaceMatrixRunOptions): Promise<WorkspaceMatrixRunResult> {
  const completed: WorkspaceMatrixRunResult['completed'] = [];
  const skipped: WorkspaceMatrixRunResult['skipped'] = [];
  const factory = request.driverFactory ?? buildWorkspaceDriver;
  const packCases = resolveWorkspacePack(request.pack, request.cases);

  for (const cell of plan.cells) {
    if (options.shouldCancel?.()) {
      skipped.push({ cell, reasons: ['the matrix was cancelled before this run started'] });
      continue;
    }
    const model = plan.models.find((entry) => entry.candidate === cell.candidate);
    if (!cell.runnable || model?.binding === undefined) {
      skipped.push({ cell, reasons: cell.refusals.length > 0 ? cell.refusals : ['this cell was refused when the matrix was planned'] });
      continue;
    }
    const driver = factory({ provider: request.provider, requestedModelID: cell.modelID, effort: request.effort });
    const workspaceCase = packCases.find((entry) => entry.id === cell.caseID);
    if (driver === undefined || workspaceCase === undefined) {
      skipped.push({ cell, reasons: ['the driver or the case could not be resolved at execution time'] });
      continue;
    }

    options.onCellStarted?.(cell);
    try {
      const campaign = WorkspaceCampaign.create({
        root: cell.recordRoot,
        label: `${plan.packID}@${plan.packVersion} · ${cell.caseID}@${cell.caseVersion} · ${cell.candidate} · `
          + `repeat ${cell.repeat.repeatIndex}/${cell.repeat.repeatsPlanned}`,
        case: workspaceCase,
        binding: model.binding,
        identity: model.identity,
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
      });
      const { outcome } = await campaign.run();
      completed.push({ cell, recordRoot: cell.recordRoot, status: outcome.scorecard.status });
      options.onCellFinished?.(cell, outcome);
    } catch (error) {
      skipped.push({ cell, reasons: [error instanceof Error ? error.message : String(error)] });
    }
  }

  return { plan, completed, skipped };
}
