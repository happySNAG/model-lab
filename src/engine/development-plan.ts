// Benchmark engine · the development campaign plan: what will be run, against what, and who pays.
//
// THE TEXT BENCHMARK'S PLANNER IS NOT REUSED, AND THE REASON IS THE SAME ONE `development-catalog.ts`
// GIVES FOR NOT REUSING `catalog.ts`. `buildCampaignPlan` plans CASES — a prompt in, text out, graded
// by a sealed scoring policy. A development attempt carries a repository, may WRITE, is graded by
// predicates over files, and is measured on dimensions no text suite reads. Planning one through the
// text planner would mean widening `CampaignPlanRequest` until it described two different
// experiments, and the first thing that would break is the claim `registeredSuites.length === 14`.
//
// WHAT IS REUSED, DELIBERATELY AND WITHOUT A PARALLEL COPY:
//
//   ledger.ts `buildPlan`        the attempt list is produced by the SAME function the text campaign
//                                uses, over a `PlannableCatalog` projected from the development
//                                registry. That is what makes "one terminal result per slot, ever"
//                                and the resume rules identical rather than merely similar — and it
//                                is why `developmentAttempts` cannot drift out of step with what the
//                                ledger will actually plan.
//   provider.ts `validateBinding`  every binding this plan carries is refused on exactly the terms
//                                a text campaign's binding is refused on.
//   cost-eligibility.ts          the zero-marginal-cost policy is ENFORCED here, through
//                                `assertCostEligibilityAuthorized`, not re-decided. A development
//                                campaign may not run a candidate a text campaign may not run.
//
// NOTHING HERE EXECUTES ANYTHING. Building a plan contacts no provider, reads no fixture off disk,
// and creates no workspace. It is the artefact a person reads BEFORE deciding to spend anything, and
// `cernum develop --dry-run` prints exactly this object.

import {
  DevelopmentSuite, DevelopmentTask, developmentComparabilityKey, developmentSuiteDigest,
  developmentTaskDigest, validateDevelopmentSuite,
} from '../core/development-benchmark';
import {
  developmentCatalogDigest, developmentFixtures, developmentSuites, validateDevelopmentCatalog,
} from '../core/development-catalog';
import {
  DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION, DevelopmentDimension,
  developmentContractDigest,
} from '../core/development-scoring';
import { compareCodePoints, fnv1a64Hex } from '../core/digest';
import {
  CostEligibilityVerdict, CostPolicyOverride, ZeroMarginalCostConfirmation,
  assertCostEligibilityAuthorized, costEligibilityAgreesWithBillingBasis,
} from './cost-eligibility';
import { DEVELOPMENT_PROMPT_VERSION } from './development-execution';
import { MachineIdentity, readBenchmarkCommit, readMachineIdentity, readWorkingTreeDirty } from './development-provenance';
import { PlanSlot, PlannableCatalog, buildPlan } from './ledger';
import {
  DEFAULT_RETRY, EffortLevel, PricingSnapshot, ProviderBinding, ProviderID, RetryPolicy, SamplingSettings,
  billingBasisOf, buildOperationalEnvelope, executionClassOf,
} from './provider';
import type { ThinkingMode } from './execution';

export const DEVELOPMENT_CAMPAIGN_FORMAT_VERSION = 1;

/**
 * The output ceiling one development turn is given.
 *
 * Larger than a text case's, and for a stated reason rather than a comfortable one: a text answer is
 * a sentence or a small JSON object, while a repository-understanding answer enumerates paths and an
 * edit turn narrates what it changed. It is a CEILING and not a target, and on a subscription CLI it
 * is recorded as unenforceable exactly as `buildCLIArguments` already records it.
 */
export const DEVELOPMENT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * The input budget recorded on a development slot.
 *
 * IT IS NOT THE PROMPT SIZE, and saying so here is the point. A development attempt is handed a
 * WORKSPACE and reads it itself, so the tokens it spends on input are decided by how much of the
 * repository the candidate chooses to open — which is part of what is being measured and is not
 * knowable in advance. The figure is recorded as the planned ceiling for the turn, and the tokens
 * actually consumed are read back off the provider's own usage block like every other attempt.
 */
export const DEVELOPMENT_INPUT_BUDGET_TOKENS = 200_000;

/** The scoring mode stamped on every development slot, so a ledger row says which contract judged it. */
export const DEVELOPMENT_SCORING_MODE = 'developmentStructural';

export class DevelopmentPlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DevelopmentPlanError';
  }
}

/** One configuration under test. A model at two effort levels is two candidates, as everywhere else. */
export interface DevelopmentCandidateRequest {
  /** Distinct per candidate. Conventionally `<provider>:<modelID>[@<effort>]`. */
  name: string;
  provider: ProviderID;
  modelID: string;
  effort?: EffortLevel;
  thinkingMode?: ThinkingMode;
  /**
   * The identifier the provider itself returned, when something established one.
   *
   * ABSENT MEANS UNVERIFIABLE AND STAYS UNVERIFIABLE. It is never filled in from `modelID`: "we
   * asked for this" and "this answered" are different facts, and a development result that confused
   * them would carry the confusion into a routing statement.
   */
  verifiedModelID?: string;
  identityEvidence?: string;
  timeoutMilliseconds?: number;
  retry?: RetryPolicy;
  sampling?: SamplingSettings;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  /** Required for a metered provider, refused for the others. Always supplied by a person. */
  pricing?: PricingSnapshot;
  authorizationMode?: ProviderBinding['authorizationMode'];
}

export interface DevelopmentPlanRequest {
  label: string;
  /** Which registered suites to run. Absent means every one of them. */
  suiteIDs?: string[];
  /** How many times each task is attempted per candidate. */
  repeats: number;
  candidates: DevelopmentCandidateRequest[];
  benchmarkVersion: string;
  createdAt: string;
  costConfirmations?: ZeroMarginalCostConfirmation[];
  costOverrides?: CostPolicyOverride[];
  /** Supplied by the tests and by a caller that already read them; read here otherwise. */
  machine?: MachineIdentity;
  benchmarkCommit?: string;
  workingTreeDirty?: boolean;
  /** Where the commit is read from when it was not supplied. Never a task workspace. */
  repositoryPath?: string;
  /**
   * The prompt contract this plan will send. Supplied only by the tests; a real plan is always the
   * version this build sends, because the runner has no way to send any other.
   */
  promptVersion?: string;
}

/** A candidate as the plan carries it: the binding it will run under and the cost verdict that let it. */
export interface DevelopmentPlannedCandidate {
  name: string;
  binding: ProviderBinding;
  costVerdict: CostEligibilityVerdict;
}

/** One planned attempt: one candidate, one task, one repetition. */
export interface DevelopmentPlannedAttempt {
  /** `mldrun1:` — deterministic in the plan's identity and this slot. Stable across resumes. */
  runID: string;
  /** `candidate|suiteID|repeat|taskID`, the ledger's own slot identity. */
  slotKey: string;
  slotIndex: number;
  candidate: string;
  provider: ProviderID;
  modelID: string;
  suiteID: string;
  suiteVersion: string;
  suiteDigest: string;
  dimension: DevelopmentDimension;
  taskID: string;
  taskDigest: string;
  comparabilityKey: string;
  kind: DevelopmentTask['kind'];
  fixtureRepoID: string;
  fixtureRepoVersion: string;
  fixtureRepoDigest: string;
  /** The repetition, 1-based. Attempt 2 of a task is a repeat, never a retry — see `attemptIndex`. */
  repeat: number;
  executionBudgetMilliseconds: number;
}

export interface DevelopmentCampaignPlan {
  formatVersion: number;
  label: string;
  createdAt: string;
  /** `mldplan1:` — every candidate, every attempt, the registry and the contract, in one value. */
  planDigest: string;
  catalogDigest: string;
  contractID: string;
  contractVersion: string;
  contractDigest: string;
  /**
   * The development prompt contract every attempt in this plan is sent under. In the plan's identity,
   * so a plan that would ask a different question has different run ids, and a resume under a build
   * that sends a different version is refused. See `DEVELOPMENT_PROMPT_VERSION`.
   */
  promptVersion: string;
  benchmarkVersion: string;
  /** Empty when the runner could not read one. Never invented, never a version standing in for it. */
  benchmarkCommit: string;
  /** Undefined when it could not be determined — distinct from a clean tree. */
  workingTreeDirty?: boolean;
  machineIdentifier: string;
  platform: string;
  repeats: number;
  suiteIDs: string[];
  candidates: DevelopmentPlannedCandidate[];
  attempts: DevelopmentPlannedAttempt[];
  /** The projection the ledger is created from, kept so the runner never rebuilds it differently. */
  plannableCatalog: PlannableCatalog;
}

/**
 * The registry projected into the shape `ledger.ts` plans from.
 *
 * Deliberately structural: the ledger "plans from data, not from a class", and this is the data. A
 * development suite becomes a plannable suite, a development task becomes a plannable case, and the
 * ledger's own `buildPlan` then produces the slots — which is why a development campaign resumes
 * under exactly the rules a text campaign resumes under.
 */
export function plannableDevelopmentCatalog(suites: DevelopmentSuite[], repeats: number): PlannableCatalog {
  const ordered = [...suites].sort((a, b) => compareCodePoints(a.id, b.id));
  let caseCount = 0;
  const plannable = ordered.map((suite, suiteIndex) => {
    const cases = [...suite.tasks].sort((a, b) => compareCodePoints(a.id, b.id)).map((task, taskIndex) => {
      caseCount += 1;
      return {
        caseID: task.id,
        caseDigest: developmentTaskDigest(task),
        comparabilityKey: developmentComparabilityKey(task),
        scoringMode: DEVELOPMENT_SCORING_MODE,
        maxOutputTokens: DEVELOPMENT_MAX_OUTPUT_TOKENS,
        inputBudgetTokens: DEVELOPMENT_INPUT_BUDGET_TOKENS,
        executionOrdinal: taskIndex,
      };
    });
    return { slug: suite.id, block: suite.dimension, executionOrdinal: suiteIndex, cases };
  });
  return { catalogDigest: developmentCatalogDigest(), caseCount, repeatsPerCase: repeats, suites: plannable };
}

/** `mldrun1:` — one attempt's deterministic identity. The same plan yields the same run ids forever. */
export function developmentRunID(planIdentity: string, slotKey: string, comparabilityKey: string): string {
  return 'mldrun1:' + fnv1a64Hex([planIdentity, slotKey, comparabilityKey].join('|'));
}

function bindingFor(candidate: DevelopmentCandidateRequest): ProviderBinding {
  const executionClass = executionClassOf(candidate.provider);
  const verified = candidate.verifiedModelID ?? '';
  return {
    candidate: candidate.name,
    provider: candidate.provider,
    executionClass,
    requestedModelID: candidate.modelID,
    // UNVERIFIABLE UNLESS SOMETHING NAMED THE MODEL. There is no third state reachable from here:
    // the accepted-request exception belongs to a sealed, campaign-bound authorization, and a
    // development campaign that could mint one by omission would be a way around it.
    identityState: verified.length > 0 ? 'verified' : 'unverifiable',
    verifiedModelID: verified,
    identityEvidence: candidate.identityEvidence
      ?? (verified.length > 0
        ? `the provider returned ${verified}`
        : 'nothing established which model answers for this binding; it is recorded as unverifiable rather than assumed'),
    effort: candidate.effort ?? 'none',
    thinkingMode: candidate.thinkingMode ?? 'runtimeDefault',
    sampling: candidate.sampling ?? { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: candidate.maxInputTokens ?? DEVELOPMENT_INPUT_BUDGET_TOKENS,
    maxOutputTokens: candidate.maxOutputTokens ?? DEVELOPMENT_MAX_OUTPUT_TOKENS,
    timeoutMilliseconds: candidate.timeoutMilliseconds ?? 600_000,
    retry: candidate.retry ?? DEFAULT_RETRY,
    billingBasis: billingBasisOf(executionClass),
    pricing: candidate.pricing ?? null,
    authorizationMode: executionClass === 'subscriptionCLI' ? 'subscriptionCLISession'
      : candidate.provider === 'opencodeCLI' ? 'toolManagedCredential'
        : candidate.authorizationMode ?? 'apiKeyEnvironment',
  };
}

/**
 * Build the campaign plan. Contacts nothing; spends nothing; refuses rather than guesses.
 *
 * THE COST GATE IS APPLIED HERE AND IS NOT A WARNING. A candidate the project's cost policy does not
 * authorize is refused at plan time, so no ledger is created, no workspace is made and no request is
 * ever assembled for it. That is the same fail-closed direction `assertCostEligibilityAuthorized`
 * points in everywhere else, and it is applied through that function rather than re-implemented.
 */
export function buildDevelopmentPlan(request: DevelopmentPlanRequest): DevelopmentCampaignPlan {
  if (request.label.trim().length === 0) {
    throw new DevelopmentPlanError('noLabel', 'a development campaign with no label cannot be named in an evidence file');
  }
  if (request.repeats < 1) {
    throw new DevelopmentPlanError('nonPositiveRepeats',
      `repeats must be at least 1; ${request.repeats} would plan a campaign that runs nothing and reports a denominator`);
  }
  if (request.candidates.length === 0) {
    throw new DevelopmentPlanError('noCandidates', 'a development campaign over zero candidates measures nothing');
  }

  // Fail-closed on the registry BEFORE anything else: a campaign planned against an invalid suite
  // would produce grades nobody can read, and finding that out after the first request is worse.
  validateDevelopmentCatalog();

  const wanted = request.suiteIDs === undefined
    ? developmentSuites
    : request.suiteIDs.map((id) => {
      const suite = developmentSuites.find((entry) => entry.id === id);
      if (!suite) {
        throw new DevelopmentPlanError('unknownSuite',
          `${id} is not a registered development suite. This engine registers `
          + `${developmentSuites.map((entry) => entry.id).join(', ')}.`);
      }
      return suite;
    });
  if (wanted.length === 0) {
    throw new DevelopmentPlanError('noSuites', 'a development campaign over zero suites asks nothing');
  }
  for (const suite of wanted) validateDevelopmentSuite(suite, developmentFixtures);

  const seenNames = new Set<string>();
  const candidates: DevelopmentPlannedCandidate[] = request.candidates.map((candidate) => {
    if (seenNames.has(candidate.name)) {
      throw new DevelopmentPlanError('duplicateCandidate',
        `${candidate.name} appears twice; two candidates with one name would write into one another's slots`);
    }
    seenNames.add(candidate.name);
    const binding = bindingFor(candidate);
    const costVerdict = assertCostEligibilityAuthorized({
      candidate: candidate.name,
      provider: candidate.provider,
      modelID: candidate.modelID,
      executionClass: binding.executionClass,
      confirmations: request.costConfirmations,
      overrides: request.costOverrides,
    });
    if (!costEligibilityAgreesWithBillingBasis(costVerdict.eligibility, binding.billingBasis)) {
      throw new DevelopmentPlanError('costEligibilityMismatch',
        `${candidate.name}: cost eligibility ${costVerdict.eligibility} cannot be true of a `
        + `${binding.billingBasis} binding. The two describe the same candidate and one of them is wrong.`);
    }
    return { name: candidate.name, binding, costVerdict };
  });

  // Refuses duplicates and validates every binding, through the same function a text campaign uses.
  buildOperationalEnvelope(candidates.map((entry) => entry.binding));

  const plannableCatalog = plannableDevelopmentCatalog(wanted, request.repeats);
  const slots = buildPlan(plannableCatalog, candidates.map((entry) => ({
    name: entry.name, modelID: entry.binding.requestedModelID,
  })));

  const machine = request.machine ?? readMachineIdentity();
  const benchmarkCommit = request.benchmarkCommit ?? readBenchmarkCommit(request.repositoryPath);
  const workingTreeDirty = request.workingTreeDirty ?? readWorkingTreeDirty(request.repositoryPath);

  const promptVersion = request.promptVersion ?? DEVELOPMENT_PROMPT_VERSION;

  const suiteByID = new Map(wanted.map((suite) => [suite.id, suite]));
  const suiteDigests = new Map(wanted.map((suite) => [suite.id, developmentSuiteDigest(suite)]));
  const taskByID = new Map<string, DevelopmentTask>();
  for (const suite of wanted) for (const task of suite.tasks) taskByID.set(task.id, task);

  // The plan's identity, which every run id is derived from. It deliberately includes the contract,
  // the registry and the prompt contract: a plan rebuilt after any of them changed is a different
  // experiment and must not reuse the old run ids, because a resume keyed on them would join two
  // measurements.
  const planIdentity = fnv1a64Hex([
    request.label,
    String(request.repeats),
    plannableCatalog.catalogDigest,
    developmentContractDigest(),
    promptVersion,
    candidates.map((entry) => `${entry.name}=${entry.binding.provider}:${entry.binding.requestedModelID}@${entry.binding.effort}`).join(','),
    wanted.map((suite) => `${suite.id}@${suite.version}=${suiteDigests.get(suite.id)}`).join(','),
  ].join('||'));

  const attempts: DevelopmentPlannedAttempt[] = slots.map((slot: PlanSlot) => {
    const suite = suiteByID.get(slot.suite)!;
    const task = taskByID.get(slot.caseID)!;
    return {
      runID: developmentRunID(planIdentity, slot.slotKey, slot.comparabilityKey),
      slotKey: slot.slotKey,
      slotIndex: slot.slotIndex,
      candidate: slot.candidate,
      provider: candidates.find((entry) => entry.name === slot.candidate)!.binding.provider,
      modelID: slot.modelID,
      suiteID: suite.id,
      suiteVersion: suite.version,
      suiteDigest: suiteDigests.get(suite.id)!,
      dimension: task.dimension,
      taskID: task.id,
      taskDigest: slot.caseDigest,
      comparabilityKey: slot.comparabilityKey,
      kind: task.kind,
      fixtureRepoID: task.fixtureRepoID,
      fixtureRepoVersion: task.fixtureRepoVersion,
      fixtureRepoDigest: task.fixtureRepoDigest,
      repeat: slot.pass,
      executionBudgetMilliseconds: task.executionBudgetMilliseconds,
    };
  });

  return {
    formatVersion: DEVELOPMENT_CAMPAIGN_FORMAT_VERSION,
    label: request.label,
    createdAt: request.createdAt,
    planDigest: 'mldplan1:' + fnv1a64Hex([planIdentity, attempts.map((attempt) => attempt.runID).join('|')].join('||')),
    catalogDigest: plannableCatalog.catalogDigest,
    contractID: DEVELOPMENT_SCORING_CONTRACT_ID,
    contractVersion: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    contractDigest: developmentContractDigest(),
    promptVersion,
    benchmarkVersion: request.benchmarkVersion,
    benchmarkCommit,
    workingTreeDirty,
    machineIdentifier: machine.machineIdentifier,
    platform: machine.platform,
    repeats: request.repeats,
    suiteIDs: wanted.map((suite) => suite.id),
    candidates,
    attempts,
    plannableCatalog,
  };
}

/** How many tasks this plan covers on each dimension, for the evidence layer's denominator. */
export function plannedTaskCountsFor(plan: DevelopmentCampaignPlan): Record<DevelopmentDimension, number> {
  const counts: Record<DevelopmentDimension, number> = { repositoryUnderstanding: 0, multiFileEditing: 0 };
  const seen = new Set<string>();
  for (const attempt of plan.attempts) {
    if (seen.has(attempt.taskID)) continue;
    seen.add(attempt.taskID);
    counts[attempt.dimension] += 1;
  }
  return counts;
}

/** What a person reads before spending anything. The dry run prints exactly this. */
export function describeDevelopmentPlan(plan: DevelopmentCampaignPlan): string[] {
  const lines = [
    `DEVELOPMENT CAMPAIGN · ${plan.label}`,
    '',
    `  plan digest       ${plan.planDigest}`,
    `  registry digest   ${plan.catalogDigest}`,
    `  contract          ${plan.contractID}@${plan.contractVersion} (${plan.contractDigest})`,
    `  prompt            ${plan.promptVersion}`,
    `  benchmark         ${plan.benchmarkVersion} at ${plan.benchmarkCommit.length > 0 ? plan.benchmarkCommit : 'an UNKNOWN commit — no git and no build stamp'}`
      + (plan.workingTreeDirty === true ? ' · WORKING TREE DIRTY, so the commit alone misdescribes this grade' : ''),
    `  machine           ${plan.machineIdentifier} (${plan.platform})`,
    `  suites            ${plan.suiteIDs.join(', ')}`,
    `  repeats           ${plan.repeats}`,
    `  attempts          ${plan.attempts.length}`,
    '',
    'CANDIDATES — who pays, and what is known about who answers.',
  ];
  for (const candidate of plan.candidates) {
    lines.push(`  ${candidate.name}`);
    lines.push(`      cost      ${candidate.costVerdict.eligibility} — ${candidate.costVerdict.reason}`);
    lines.push(`      identity  ${candidate.binding.identityState} — ${candidate.binding.identityEvidence}`);
  }
  lines.push('', 'ATTEMPTS — every one of them, in the order they will run.');
  for (const attempt of plan.attempts) {
    lines.push(`  ${String(attempt.slotIndex).padStart(4, ' ')}  ${attempt.slotKey}`);
    lines.push(`        ${attempt.dimension} · ${attempt.kind} · fixture ${attempt.fixtureRepoID}@${attempt.fixtureRepoVersion} · run ${attempt.runID}`);
  }
  lines.push('', 'NOTHING WAS SENT. This is the plan, not a run.');
  return lines;
}
