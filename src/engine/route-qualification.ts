// Benchmark engine · ONE READ MODEL for "what is established about this route", derived from the
// evidence already on disk and written nowhere.
//
// WHAT IT IS. For one route — a provider, a model, an effort — this assembles every fact the separate
// evidence systems hold: discovery and its age, availability on each machine, identity, who pays, the
// prose benchmark, the development benchmark, the workspace benchmark by capability and by structural
// tier, the discriminator packs, the last provider failure, the last throttle, the efficiency figures,
// and whether all of that adds up to a route that may be routed to — and if not, every reason why not.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A WRITER. It takes rows, reports and snapshots as arguments and returns a value. It never opens
//   an evidence file for writing, never merges evidence roots, and never re-derives a sealed row: a
//   historical root read through it is byte-identical afterwards, and a test holds it to that.
//   NOT A SCORE. There is no number for a route. Qualification is per CAPABILITY — a workspace
//   dimension, a structural tier, a development or prose role — and a route qualified for simple edits
//   and refused for preserve-unknown migration says exactly that, in two entries, and nothing overall.
//   NOT A ROUTER. It says whether a route is SAFE to route for a capability and why; choosing among
//   routes is `routing-contract.ts`'s job, and even that returns a candidate set, not a winner.
//   NOT A NEW IDENTITY RULE. A route admitted under the identity exception is measured in full here and
//   is never routable, because `isRoutable` says so and the Pass 6/7 approvals say so in writing.
//
// THE QUALIFICATION POLICY IS EXPLICIT AND VERSIONED. "Qualified" means: at least N scored runs of cases
// exercising the capability, a success rate at or above R, and no case that never passed. The numbers
// are in `V1_QUALIFICATION_POLICY`, carried on every record, and a caller may pass a stricter one. A
// capability with too few runs is `insufficientEvidence` — never `notQualified`, which is a finding.

import { DevelopmentCandidateReport } from './development-report';
import { DiscoveryEvidence, isEvidenceExpired } from './discovery-store';
import { DiscoverySnapshot, QualificationStalenessReason, RouteFreshness, qualificationStaleness, routeFreshness } from './discovery-refresh';
import { Quantity, measuredQuantity, unavailableQuantity } from './frontier-metrics';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, isRoutable } from './identity-admission';
import {
  LOCAL_QUALIFICATION_DOES_NOT_TRANSFER, MachineAvailability, QualificationScope, RouteAvailabilityObservation,
  availabilityOnMachine, qualificationAppliesOn, qualificationScopeFor,
} from './machine-availability';
import { IdentityConfidence, ModelDescription } from './model-description';
import { EffortLevel, ProviderID } from './provider';
import { CandidateRanking } from './ranking';
import { RouteSpendPosture } from './route-spend-posture';
import { WorkspaceCase } from './workspace-case';
import { WorkspaceDifficultyProfile } from './workspace-difficulty';
import { STATUSES_THAT_MEASURED_NO_WORK, WorkspaceRunRow, aggregateWorkspaceRuns } from './workspace-aggregate';
import { workspaceCapabilityEvidence, workspaceTierEvidence } from './workspace-routing-evidence';

export const ROUTE_QUALIFICATION_SCHEMA = 'crq1';

export type RouteBlockerKind = 'discovery' | 'availability' | 'identity' | 'cost' | 'locality' | 'staleness' | 'qualification';

export const NO_UNIVERSAL_ROUTE_SCORE =
  'A route has no overall score. Qualification is per capability — a workspace dimension, a structural tier, a '
  + 'development or prose role — and a route can be qualified for one and refused for another. Nothing here averages '
  + 'across capabilities, and nothing here orders routes.';

/** What "qualified" means, as numbers somebody can read and change. */
export interface QualificationPolicy {
  policyID: string;
  minimumScoredRuns: number;
  minimumSuccessRateMilli: number;
  /** A case every run of which failed disqualifies the capability, whatever the rate. */
  allowCaseNeverPassed: boolean;
  /** How long a qualification stays current before it is re-established. */
  maximumAgeMilliseconds: number;
}

export const V1_QUALIFICATION_POLICY: QualificationPolicy = {
  policyID: 'cqp1',
  minimumScoredRuns: 3,
  minimumSuccessRateMilli: 900,
  allowCaseNeverPassed: false,
  maximumAgeMilliseconds: 30 * 24 * 60 * 60 * 1_000,
};

export type CapabilityVerdict = 'qualified' | 'notQualified' | 'insufficientEvidence' | 'notExercised';

/** One capability, one verdict, and the evidence behind it. */
export interface CapabilityQualification {
  /** `workspace:<dimension>`, `workspace-tier:<tier>`, `development:<role>` or `prose:<role>`. */
  capability: string;
  source: 'workspace' | 'development' | 'prose';
  verdict: CapabilityVerdict;
  scoredRunCount: number;
  successCount: number;
  successRateMilli: Quantity;
  /** The cases (or suites) the verdict rests on. */
  evidenceRefs: string[];
  reason: string;
}

export interface RouteQualificationInputs {
  provider: ProviderID;
  modelID: string;
  /** Absent means every effort's rows are read, and the record says so. */
  effort?: EffortLevel;
  /** THIS machine, as a `cmk1:` key. The machine the question is being asked from. */
  machineKey: string;
  discovery?: DiscoveryEvidence;
  snapshot?: DiscoverySnapshot;
  description?: ModelDescription;
  availability?: RouteAvailabilityObservation[];
  /** Workspace run rows, from any number of roots. Read, never written. */
  workspaceRows?: WorkspaceRunRow[];
  workspaceCases?: WorkspaceCase[];
  difficultyProfiles?: WorkspaceDifficultyProfile[];
  developmentReports?: DevelopmentCandidateReport[];
  /** The prose rankings of THIS route's candidates, bound by the caller from the manifest's bindings. */
  proseRankings?: CandidateRanking[];
  spend?: RouteSpendPosture;
  policy?: QualificationPolicy;
  /** The workspace driver this build would use now, to detect a route whose driver moved. */
  currentDriverID?: string;
  now: Date;
}

export interface RouteQualificationRecord {
  schema: typeof ROUTE_QUALIFICATION_SCHEMA;
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel | 'any';
  policy: QualificationPolicy;
  qualificationScope: QualificationScope;

  discovered: { state: RouteFreshness | 'provenInStore' | 'expiredInStore' | 'unprovenInStore'; reason: string };
  availableOnThisMachine: MachineAvailability;
  identityConfidence: IdentityConfidence;
  /** The strongest binding identity state any of this route's rows ran under. */
  bindingIdentityStates: string[];
  billing: RouteSpendPosture | undefined;

  evidence: {
    prose: { present: boolean; candidates: string[]; overallPassRateMilli?: number };
    development: { present: boolean; candidates: string[]; eligibility?: string };
    workspace: { present: boolean; runCount: number; scoredRunCount: number; packs: string[]; recordRoots: string[] };
  };
  capabilities: CapabilityQualification[];
  /** Discriminator packs, as pass counts — "9/18" — never as a rate on its own. */
  discriminator: { packID: string; passed: number; scored: number; notMeasured: number }[];

  lastSuccessfulQualificationAt?: string;
  lastProviderFailure?: { at: string; detail: string };
  lastThrottle?: { at: string; detail: string };
  efficiency: { medianWallClockMilliseconds: Quantity; medianTotalTokens: Quantity; basis: string };
  /** The newest evidence's machine and digest, for a local route. */
  locus?: { machineKey?: string; runtimeDigest?: string };
  staleness: { valid: boolean; reasons: QualificationStalenessReason[]; detail: string[] } | undefined;

  /** Safe to route for at least one capability. Per-capability eligibility is in `routableCapabilities`. */
  safeToRoute: boolean;
  routableCapabilities: string[];
  /** Every reason this route may not be routed, even where some capability qualified. */
  notRoutableBecause: string[];
  /** The same reasons, by kind, so a consumer can tell "who pays" from "what is proven". */
  blockers: { kind: RouteBlockerKind; reason: string }[];
  disclosure: string;
}

const text = (row: Record<string, unknown>, key: string): string | undefined =>
  (typeof row[key] === 'string' ? row[key] as string : undefined);
const num = (row: Record<string, unknown>, key: string): number | undefined =>
  (typeof row[key] === 'number' ? row[key] as number : undefined);

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function latest(rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return [...rows].sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? ''))).pop();
}

function verdictFor(policy: QualificationPolicy, scored: number, successes: number, casesNeverPassed: number, exercised: boolean):
  { verdict: CapabilityVerdict; reason: string } {
  if (!exercised) return { verdict: 'notExercised', reason: 'the runs behind this capability never exercised it' };
  if (scored < policy.minimumScoredRuns) {
    return { verdict: 'insufficientEvidence', reason: `${scored} scored run(s); ${policy.policyID} asks for at least ${policy.minimumScoredRuns}. `
      + 'This is an absence of evidence, not a failure.' };
  }
  const rate = Math.round((successes * 1000) / scored);
  if (!policy.allowCaseNeverPassed && casesNeverPassed > 0) {
    return { verdict: 'notQualified', reason: `${casesNeverPassed} case(s) never passed in any run` };
  }
  return rate >= policy.minimumSuccessRateMilli
    ? { verdict: 'qualified', reason: `${successes}/${scored} scored runs passed (≥ ${policy.minimumSuccessRateMilli / 10}%)` }
    : { verdict: 'notQualified', reason: `${successes}/${scored} scored runs passed (< ${policy.minimumSuccessRateMilli / 10}%)` };
}

/** Derive the record. PURE: every input is a value, nothing is read from or written to disk here. */
export function deriveRouteQualification(inputs: RouteQualificationInputs): RouteQualificationRecord {
  const policy = inputs.policy ?? V1_QUALIFICATION_POLICY;
  const routeKey = `${inputs.provider}:${inputs.modelID}`;
  const blockers: { kind: RouteBlockerKind; reason: string }[] = [];
  const block = (kind: RouteBlockerKind, reason: string): void => { blockers.push({ kind, reason }); };

  // ---- the rows for THIS route -------------------------------------------------------------------
  const runs = (inputs.workspaceRows ?? []).filter(({ row }) => row.provider === inputs.provider
    && row.requestedModelID === inputs.modelID && (inputs.effort === undefined || row.effort === inputs.effort));
  const rows = runs.map((run) => run.row);
  const scoredRows = rows.filter((row) => !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status)));

  // ---- discovery -----------------------------------------------------------------------------------
  let discovered: RouteQualificationRecord['discovered'];
  if (inputs.snapshot !== undefined) {
    discovered = routeFreshness(inputs.snapshot, routeKey, inputs.now);
  } else {
    const row = inputs.discovery?.models.find((entry) => entry.provider === inputs.provider && entry.modelID === inputs.modelID);
    discovered = row === undefined ? { state: 'neverDiscovered', reason: 'the discovery store holds no row for this route' }
      : row.availability !== 'proven' ? { state: 'unprovenInStore', reason: `the discovery store records ${row.availability}` }
        : isEvidenceExpired(row, inputs.now) ? { state: 'expiredInStore', reason: `proven ${row.discoveredAt} and expired` }
          : { state: 'provenInStore', reason: `proven ${row.discoveredAt}` };
  }
  const discoveryCurrent = ['currentlyDiscovered', 'provenInStore'].includes(discovered.state);
  if (!discoveryCurrent) block('discovery', `${discovered.state} — ${discovered.reason}`);

  // ---- availability on this machine ----------------------------------------------------------------
  const availableOnThisMachine = availabilityOnMachine(inputs.availability ?? [], routeKey, inputs.machineKey, inputs.now);
  if (availableOnThisMachine.state !== 'available') block('availability', `${availableOnThisMachine.reason}`);

  // ---- identity ------------------------------------------------------------------------------------
  const bindingIdentityStates = [...new Set(rows.map((row) => text(row, 'bindingIdentityState')).filter((s): s is string => !!s))].sort();
  const identityConfidence: IdentityConfidence = inputs.description?.identityConfidence
    ?? (bindingIdentityStates.includes('verified') ? (inputs.provider === 'ollama' ? 'verifiedByLocalDigest' : 'verifiedByProvider')
      : inputs.provider === 'codexCLI' ? 'unverifiableSubstitutionDetectable'
        : inputs.provider === 'opencodeCLI' ? 'unverifiableSubstitutionUndetectable' : 'unknown');
  const admitted = bindingIdentityStates.includes(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
  const verified = bindingIdentityStates.length > 0 && bindingIdentityStates.every((state) => isRoutable(state as 'verified'));
  if (admitted) {
    block('identity', 'this route ran under the accepted-request identity exception. Its measurements are '
      + 'complete and published; the exception was approved in writing on the condition that such a route is never a routing '
      + 'target without stronger identity proof (NEVER_AFFECTS: production routing, Ordra).');
  } else if (!verified && rows.length > 0) {
    block('identity', `no run of this route ran under a verified identity (${bindingIdentityStates.join(', ') || 'none'})`);
  }

  // ---- money ---------------------------------------------------------------------------------------
  if (inputs.spend !== undefined && !inputs.spend.mayRouteByDefault) {
    block('cost', `${inputs.spend.eligibility} — not routable by default (${inputs.spend.reasons[inputs.spend.reasons.length - 1]})`);
  }

  // ---- capabilities --------------------------------------------------------------------------------
  const capabilities: CapabilityQualification[] = [];
  if (runs.length > 0 && inputs.workspaceCases !== undefined) {
    const cells = aggregateWorkspaceRuns(runs);
    for (const entry of workspaceCapabilityEvidence(cells, inputs.workspaceCases, inputs.difficultyProfiles ?? [])) {
      const decided = verdictFor(policy, entry.exercise.requiresRetry ? entry.exercise.exercisedRunCount : entry.scoredRunCount,
        entry.exercise.requiresRetry ? (entry.exercise.recovery?.recoveredCount ?? 0) : entry.successCount,
        entry.casesNeverPassed, entry.exercise.measured);
      capabilities.push({
        capability: `workspace:${entry.dimension}`, source: 'workspace', verdict: decided.verdict,
        scoredRunCount: entry.scoredRunCount, successCount: entry.successCount, successRateMilli: entry.successRateMilli,
        evidenceRefs: entry.caseIDs, reason: decided.reason,
      });
    }
    for (const tier of workspaceTierEvidence(cells, inputs.difficultyProfiles ?? [])) {
      const decided = verdictFor(policy, tier.scoredRunCount, tier.successCount, tier.casesNeverPassed, tier.scoredRunCount > 0);
      capabilities.push({
        capability: `workspace-tier:${tier.tier}`, source: 'workspace', verdict: decided.verdict,
        scoredRunCount: tier.scoredRunCount, successCount: tier.successCount, successRateMilli: tier.successRateMilli,
        evidenceRefs: tier.perCase.map((entry) => entry.caseID), reason: decided.reason,
      });
    }
  }
  const developmentReports = (inputs.developmentReports ?? []).filter((report) => report.provider === inputs.provider
    && report.modelID === inputs.modelID && (inputs.effort === undefined || report.effort === inputs.effort));
  for (const report of developmentReports) {
    for (const role of report.roles) {
      capabilities.push({
        capability: `development:${role.role}`, source: 'development', verdict: role.qualified ? 'qualified' : 'notQualified',
        scoredRunCount: report.terminalAttempts, successCount: report.statusCounts.pass,
        successRateMilli: report.terminalAttempts === 0 ? unavailableQuantity('no terminal attempts')
          : measuredQuantity(Math.round((report.statusCounts.pass * 1000) / report.terminalAttempts)),
        evidenceRefs: [report.candidate], reason: role.reason,
      });
    }
  }
  // PASSED IN ALREADY BOUND TO THIS ROUTE. A prose candidate's name is an operator's label, and matching it
  // to a route by substring would be matching on a name — the one thing this view refuses to do.
  const proseRankings = inputs.proseRankings ?? [];
  for (const ranking of proseRankings) {
    for (const role of ranking.roles) {
      capabilities.push({
        capability: `prose:${role.role}`, source: 'prose', verdict: role.qualified ? 'qualified' : 'notQualified',
        scoredRunCount: ranking.scoredCount, successCount: 0,
        successRateMilli: 'measured' in ranking.overallPassRateMilli ? measuredQuantity(ranking.overallPassRateMilli.measured)
          : unavailableQuantity(ranking.overallPassRateMilli.unavailableReason), evidenceRefs: [ranking.candidate], reason: role.reason,
      });
    }
  }
  capabilities.sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0));

  // ---- discriminator ------------------------------------------------------------------------------
  const discriminatorPacks = [...new Set(rows.map((row) => text(row, 'packID')).filter((id): id is string => !!id && id.includes('discriminator')))].sort();
  const discriminator = discriminatorPacks.map((packID) => {
    const packRows = rows.filter((row) => row.packID === packID);
    const scored = packRows.filter((row) => !STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status)));
    return { packID, passed: scored.filter((row) => row.status === 'pass').length, scored: scored.length,
      notMeasured: packRows.length - scored.length };
  });

  // ---- failures, throttles, efficiency ------------------------------------------------------------
  const passes = scoredRows.filter((row) => row.status === 'pass');
  const lastPass = latest(passes);
  const throttled = latest(rows.filter((row) => row.providerThrottled === true || row.terminationReason === 'providerDeclined'));
  const failed = latest(rows.filter((row) => STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status))
    && row.providerThrottled !== true && row.terminationReason !== 'providerDeclined'));
  const wallClock = median(passes.map((row) => num(row, 'wallClockMilliseconds')).filter((v): v is number => v !== undefined));
  const tokens = median(passes.map((row) => num(row, 'totalTokens')).filter((v): v is number => v !== undefined));

  // ---- the locus, and whether the evidence applies HERE -------------------------------------------
  const newest = latest(rows);
  const scope = qualificationScopeFor(inputs.provider);
  const locus = newest === undefined ? undefined
    : { machineKey: text(newest, 'executionMachine'), runtimeDigest: text(newest, 'localModelDigest') };
  if (scope === 'machine' && locus !== undefined) {
    const currentDigest = inputs.snapshot?.routes.find((route) => route.routeKey === routeKey)?.runtimeDigest
      ?? (inputs.description?.modelDigest.state === 'known' ? inputs.description.modelDigest.value : undefined);
    const applies = qualificationAppliesOn({ provider: inputs.provider, ...locus },
      { machineKey: inputs.machineKey, runtimeDigest: currentDigest });
    if (!applies.applies) block('locality', `${applies.reason}`);
  }

  // ---- staleness -----------------------------------------------------------------------------------
  const staleness = newest === undefined ? undefined : qualificationStaleness({
    routeKey,
    qualifiedAt: String(lastPass?.recordedAt ?? newest.recordedAt ?? ''),
    driverID: text(newest, 'driverID') ?? '',
    runtimeDigest: text(newest, 'localModelDigest'),
    runtimeVersion: text(newest, 'localRuntimeVersion'),
  }, inputs.snapshot?.routes.find((route) => route.routeKey === routeKey)
    ?? (inputs.snapshot === undefined ? { routeKey, provider: inputs.provider, modelID: inputs.modelID, listed: true,
      runtimeDigest: text(newest, 'localModelDigest'), runtimeVersion: text(newest, 'localRuntimeVersion'), observedAt: '' } : undefined), {
    driverID: inputs.currentDriverID ?? text(newest, 'driverID') ?? '', now: inputs.now, maxAge: policy.maximumAgeMilliseconds,
  });
  if (staleness !== undefined && !staleness.valid) block('staleness', `${staleness.detail.join('; ')}`);

  const qualifiedCapabilities = capabilities.filter((entry) => entry.verdict === 'qualified').map((entry) => entry.capability);
  if (qualifiedCapabilities.length === 0) {
    block('qualification', rows.length === 0 && developmentReports.length === 0 && proseRankings.length === 0
      ? 'no benchmark evidence exists for this route — it EXISTS and is not QUALIFIED'
      : 'no capability reached the policy on the evidence that exists');
  }
  const notRoutableBecause = blockers.map((entry) => `${entry.kind}: ${entry.reason}`);
  const safeToRoute = blockers.length === 0 && qualifiedCapabilities.length > 0;

  return {
    schema: ROUTE_QUALIFICATION_SCHEMA,
    routeKey,
    provider: inputs.provider,
    modelID: inputs.modelID,
    effort: inputs.effort ?? 'any',
    policy,
    qualificationScope: scope,
    discovered,
    availableOnThisMachine,
    identityConfidence,
    bindingIdentityStates,
    billing: inputs.spend,
    evidence: {
      prose: { present: proseRankings.length > 0, candidates: proseRankings.map((ranking) => ranking.candidate),
        overallPassRateMilli: proseRankings[0] !== undefined && 'measured' in proseRankings[0].overallPassRateMilli
          ? proseRankings[0].overallPassRateMilli.measured : undefined },
      development: { present: developmentReports.length > 0, candidates: developmentReports.map((report) => report.candidate),
        eligibility: developmentReports[0]?.eligibility.verdict },
      workspace: { present: runs.length > 0, runCount: runs.length, scoredRunCount: scoredRows.length,
        packs: [...new Set(rows.map((row) => text(row, 'packID')).filter((id): id is string => !!id))].sort(),
        recordRoots: runs.map((run) => run.recordRoot) },
    },
    capabilities,
    discriminator,
    lastSuccessfulQualificationAt: lastPass === undefined ? undefined : String(lastPass.recordedAt ?? ''),
    lastProviderFailure: failed === undefined ? undefined : { at: String(failed.recordedAt ?? ''), detail: String(failed.detail ?? failed.status) },
    lastThrottle: throttled === undefined ? undefined : { at: String(throttled.recordedAt ?? ''), detail: String(throttled.detail ?? '') },
    efficiency: {
      medianWallClockMilliseconds: wallClock === undefined ? unavailableQuantity('no passing run recorded a wall clock') : measuredQuantity(wallClock),
      medianTotalTokens: tokens === undefined ? unavailableQuantity('no passing run reported tokens') : measuredQuantity(tokens),
      basis: 'medians over PASSING workspace runs of this route only; never compared across execution classes',
    },
    locus,
    staleness,
    safeToRoute,
    routableCapabilities: safeToRoute ? qualifiedCapabilities : [],
    notRoutableBecause,
    blockers,
    disclosure: `${NO_UNIVERSAL_ROUTE_SCORE}${scope === 'machine' ? ` ${LOCAL_QUALIFICATION_DOES_NOT_TRANSFER}` : ''}`,
  };
}
