// crr2 with --tier, from the sealed runs: a `workspace-tier:<tier>` capability exists only where the existing
// workspace-difficulty bands DERIVE a tier from a case's structure, and only from the runs of those cases.
//
// WHAT IS PINNED. (a) A case whose structural counts one band holds yields, from its own runs, a
// workspace-tier row in the metrics rollup and a workspace-tier capability on the route's record, and
// `recommend implement --tier <n> --contract crr2` ranks the routes cqp1 qualifies there, in the crr2 order.
// (b) A case no band holds yields no tier row, and its route is excluded with 'tier: no evidence at <tier>'.
// (c) A route at 850 per mille is never ranked by crr2 — cqp1's 900 is the only threshold — and crr1 is
// unchanged. (d) The six discriminator-one cases' tiers, as the bands derive them, stated case by case.
//
// FIXTURES ONLY. Run rows are hand-written in the shape `workspace-campaign.ts` writes; cases are the
// catalogue's own, one of them re-identified under a test id. No driver runs and no provider is contacted.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Crr2Recommendation, recommendRoutesCrr2 } from '../../src/engine/route-recommendation-crr2';
import { RouteRecommendation, recommendRoutes } from '../../src/engine/route-recommendation';
import { RouteAvailabilitySource, RouteForQuery } from '../../src/engine/routing-contract';
import {
  CapabilityQualification, RouteQualificationRecord, V1_QUALIFICATION_POLICY, deriveRouteQualification,
} from '../../src/engine/route-qualification';
import { MetricsRollup, deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { ProviderID } from '../../src/engine/provider';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { WorkspaceRunRow } from '../../src/engine/workspace-aggregate';
import {
  WorkspaceDifficultyProfile, deriveWorkspaceStructuralTier, validateWorkspaceDifficultyProfile,
} from '../../src/engine/workspace-difficulty';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { WorkspaceStructuralProfile, makeWorkspaceStructuralProfile } from '../../src/engine/workspace-discriminator';
import { registeredWorkspaceStructuralProfiles } from '../../src/engine/workspace-discriminator-catalog';
import {
  difficultyProfileFromStructure, routingDifficultyProfiles, workspaceStructuralTierReading,
} from '../../src/engine/workspace-structural-tier';

const REPOSITORY = path.resolve(__dirname, '../..');
const NOW = new Date('2026-10-28T12:00:00Z');
const HERE = 'cmk1:recommend-crr2-tier-machine';
// ctt1: implement → workspace:multiFileEditing.
const CAPABILITY = 'workspace:multiFileEditing';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const OPUS = 'claudeCLI:claude-opus-5-5';
const FABLE = 'claudeCLI:claude-fable-5-1';
const SONNET = 'claudeCLI:claude-sonnet-5';

// ------------------------------------------------------------------ the cases

const catalogue = (id: string): WorkspaceCase => {
  const found = allWorkspaceCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no catalogue case ${id}`);
  return found;
};
const declaredProfile = (id: string): WorkspaceDifficultyProfile =>
  registeredWorkspaceDifficultyProfiles().find((profile) => profile.caseID === id)!;

/**
 * A catalogue case with a declared tier, RE-IDENTIFIED under a test id and given an untiered structural
 * profile carrying the same counts. Nothing about its structure is invented: whatever tier the bands derive
 * for it is the one they derive for the catalogue case it copies.
 */
function structuralTwinOf(tier: WorkspaceDifficultyProfile['tier'], id: string): { c: WorkspaceCase; profile: WorkspaceStructuralProfile } {
  const declared = registeredWorkspaceDifficultyProfiles().find((profile) => profile.tier === tier)!;
  const c = { ...catalogue(declared.caseID), id, dimensions: ['multiFileEditing'] } as WorkspaceCase;
  const profile = makeWorkspaceStructuralProfile(c, {
    rationale: `the counts of ${declared.caseID}, under a test id`,
    fixtureFileCount: declared.measured.fixtureFileCount,
    fixtureSourceFileCount: declared.measured.fixtureSourceFileCount,
    fixtureByteCount: declared.measured.fixtureByteCount,
    declared: { ...declared.declared },
    design: { reasoningPattern: 'interactingInvariants', recoveryDesigned: c.execution.maximumAttempts > 1, refusedWrongAnswers: ['fixture'] },
  });
  return { c, profile };
}

const TIER1 = structuralTwinOf('tier1', 'ws.test.structural-tier-one');
const TIER2 = structuralTwinOf('tier2', 'ws.test.structural-tier-two');
// An untiered case of the real catalogue that no band holds (see (d)): task-board.reassign, with its sealed
// structure as it is. Only its dimensions are widened here, so its runs count toward the capability `implement`
// asks for and the one thing left to test is the tier.
const UNTIERED_ID = 'ws.d1.task-board.reassign';
const UNTIERED_PROFILE = registeredWorkspaceStructuralProfiles().find((profile) => profile.caseID === UNTIERED_ID)!;
const UNTIERED_CASE = { ...catalogue(UNTIERED_ID), dimensions: ['multiFileEditing'] } as WorkspaceCase;

const CASES: WorkspaceCase[] = [TIER1.c, TIER2.c, UNTIERED_CASE];
const PROFILES = routingDifficultyProfiles(registeredWorkspaceDifficultyProfiles(),
  [TIER1.profile, TIER2.profile, UNTIERED_PROFILE]);

// ------------------------------------------------------------------ the sealed runs

let serial = 0;
function runs(routeKey: string, caseID: string, passes: number, total: number, wallClock: number): WorkspaceRunRow[] {
  const at = routeKey.indexOf(':');
  return Array.from({ length: total }, (_, index) => {
    serial += 1;
    return {
      recordRoot: `/virtual/crr2-tier/${String(serial).padStart(3, '0')}`,
      row: {
        provider: routeKey.slice(0, at), requestedModelID: routeKey.slice(at + 1), candidate: routeKey,
        caseID, caseVersion: CASES.find((entry) => entry.id === caseID)!.version, comparabilityKey: `cwk1:fixture-${caseID}`,
        repeatIndex: index, effort: 'none',
        status: index < passes ? 'pass' : 'fail', attemptsUsed: 1, billingBasis: 'subscription',
        bindingIdentityState: 'verified', wallClockMilliseconds: wallClock,
        recordedAt: hoursAgo(48 - index / 10),
      },
    };
  });
}

// OPUS 12/12 and FABLE 6/6 on the tier-one case; SONNET 17/20 (850 per mille) there. Every route also ran
// the untiered case, which must count toward the capability and toward no tier.
const ROWS: WorkspaceRunRow[] = [
  ...runs(OPUS, TIER1.c.id, 12, 12, 60_000),
  ...runs(FABLE, TIER1.c.id, 6, 6, 40_000),
  ...runs(SONNET, TIER1.c.id, 17, 20, 20_000),
  ...runs(OPUS, UNTIERED_ID, 3, 3, 60_000),
  ...runs(FABLE, UNTIERED_ID, 3, 3, 40_000),
  ...runs(SONNET, UNTIERED_ID, 3, 3, 20_000),
];

function derivedRecord(routeKey: string, rows: WorkspaceRunRow[], profiles: WorkspaceDifficultyProfile[] = PROFILES): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  return deriveRouteQualification({ provider: routeKey.slice(0, at) as ProviderID, modelID: routeKey.slice(at + 1),
    machineKey: HERE, workspaceRows: rows, workspaceCases: CASES, difficultyProfiles: profiles, now: NOW });
}

/**
 * A routable record carrying EXACTLY the capability verdicts `deriveRouteQualification` reached from the
 * sealed rows. Everything that is not evidence about the work — discovery, availability, identity proof,
 * freshness, spend — is the fixture's, so the only thing that can rank or exclude a route here is its runs.
 */
function routable(routeKey: string, capabilities: CapabilityQualification[]): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  const provider = routeKey.slice(0, at) as ProviderID;
  const modelID = routeKey.slice(at + 1);
  return {
    schema: 'crq1', routeKey, provider, modelID, effort: 'any', policy: V1_QUALIFICATION_POLICY, qualificationScope: 'route',
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: 'verifiedByProvider', bindingIdentityStates: ['verified'], identityAdmitted: false, routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider, modelID, now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 0, scoredRunCount: 0, packs: [], recordRoots: [] },
    },
    capabilities, discriminator: [], lastSuccessfulQualificationAt: hoursAgo(24),
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: capabilities.filter((entry) => entry.verdict === 'qualified').map((entry) => entry.capability),
    notRoutableBecause: [], blockers: [], disclosure: 'no universal score',
  };
}

const available = (): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: 'fixture-host', origin: 'observedHere',
  observedAt: hoursAgo(1), reason: 'installed and signed in',
});

function fleet(rows: WorkspaceRunRow[] = ROWS, profiles: WorkspaceDifficultyProfile[] = PROFILES): RouteForQuery[] {
  return [OPUS, FABLE, SONNET].map((routeKey) => ({
    record: routable(routeKey, derivedRecord(routeKey, rows, profiles).capabilities), availability: available(),
  }));
}
const rollup = (rows: WorkspaceRunRow[] = ROWS, profiles: WorkspaceDifficultyProfile[] = PROFILES): MetricsRollup =>
  deriveMetricsRollup({ workspaceRows: rows, workspaceCases: CASES, difficultyProfiles: profiles });

function crr2(tier: number | undefined, rows: WorkspaceRunRow[] = ROWS, profiles: WorkspaceDifficultyProfile[] = PROFILES): Crr2Recommendation {
  const answer = recommendRoutesCrr2({ machineKey: HERE, taskType: 'implement', ...(tier === undefined ? {} : { tier }) },
    { now: NOW, routes: fleet(rows, profiles), metrics: rollup(rows, profiles) });
  if (!answer.ok) throw new Error(`refused: ${answer.refusals.join('; ')}`);
  return answer;
}
const reasonsFor = (answer: Crr2Recommendation, key: string): string =>
  answer.exclusions.find((entry) => entry.key === key)?.reasons.join(' | ') ?? '';
const capabilityRow = (result: MetricsRollup, routeKey: string, capability: string) =>
  result.routes.find((route) => route.routeKey === routeKey)?.capabilities.find((entry) => entry.capability === capability);

// ------------------------------------------------------------------ the derivation is the existing bands

describe('a tier is derived only by the existing workspace-difficulty bands, never assigned', () => {
  it('derives, for every declared tier profile in the catalogue, exactly the tier that profile declares', () => {
    const declared = registeredWorkspaceDifficultyProfiles();
    expect(declared.length).toBeGreaterThan(0);
    for (const profile of declared) {
      expect({ caseID: profile.caseID, tier: deriveWorkspaceStructuralTier(profile.measured, profile.declared).tier })
        .toEqual({ caseID: profile.caseID, tier: profile.tier });
    }
  });

  it('gives a structurally profiled case the tier its counts fall in, as a profile validation accepts', () => {
    const one = difficultyProfileFromStructure(TIER1.profile)!;
    const two = difficultyProfileFromStructure(TIER2.profile)!;
    expect(one.tier).toBe('tier1');
    expect(two.tier).toBe('tier2');
    expect(one.rationale).toMatch(/^derived, not declared: the tier1 band holds/);
    expect(two.rationale).toContain('goes beyond every tier1 case on');
    // The derived profile passes the very validation a declared one must.
    expect(() => validateWorkspaceDifficultyProfile(one, TIER1.c)).not.toThrow();
    expect(() => validateWorkspaceDifficultyProfile(two, TIER2.c)).not.toThrow();
    // The structural profile itself still carries no tier.
    expect((TIER1.profile as Record<string, unknown>).tier).toBeUndefined();
  });

  it('gives a case no band holds no profile at all, with every band\'s refusal as the reason', () => {
    expect(difficultyProfileFromStructure(UNTIERED_PROFILE)).toBeUndefined();
    const reading = workspaceStructuralTierReading(UNTIERED_PROFILE);
    expect(reading.tier).toBeUndefined();
    for (const tier of ['tier1', 'tier2', 'tier3']) expect(reading.reasons.some((reason) => reason.startsWith(`${tier}: `))).toBe(true);
    expect(PROFILES.some((profile) => profile.caseID === UNTIERED_ID)).toBe(false);
  });

  it('never replaces a declared tier, and adds nothing for a structural profile the bands do not decide', () => {
    const declared = registeredWorkspaceDifficultyProfiles();
    expect(routingDifficultyProfiles(declared, [])).toEqual(declared);
    expect(routingDifficultyProfiles(declared, registeredWorkspaceStructuralProfiles())).toEqual(declared);
    const shadow = { ...TIER1.profile, caseID: declared[0].caseID } as WorkspaceStructuralProfile;
    expect(routingDifficultyProfiles(declared, [shadow])).toEqual(declared);
  });
});

// ------------------------------------------------------------------ (a) tier rows from the same runs, ranked by crr2

describe('(a) runs of a case whose tier the bands derive yield tier rows, and crr2 --tier ranks the routes qualified there', () => {
  it('the metrics rollup yields workspace-tier:tier1 rows from exactly the runs of the tier-one case', () => {
    const result = rollup();
    expect(capabilityRow(result, OPUS, 'workspace-tier:tier1')).toMatchObject({ runCount: 12, scoredRunCount: 12, passCount: 12 });
    expect(capabilityRow(result, FABLE, 'workspace-tier:tier1')).toMatchObject({ runCount: 6, scoredRunCount: 6, passCount: 6 });
    expect(capabilityRow(result, SONNET, 'workspace-tier:tier1')).toMatchObject({ runCount: 20, scoredRunCount: 20, passCount: 17 });
    // The capability row holds the untiered case's runs too; the tier row never does.
    expect(capabilityRow(result, OPUS, CAPABILITY)).toMatchObject({ runCount: 15, passCount: 15 });
    expect(capabilityRow(result, OPUS, 'workspace-tier:tier1')!.recordRoots)
      .toEqual(ROWS.filter((run) => run.row.candidate === OPUS && run.row.caseID === TIER1.c.id).map((run) => run.recordRoot).sort());
    // Without the derived profiles, there is no tier row at all: the tier comes from the derivation alone.
    expect(capabilityRow(rollup(ROWS, registeredWorkspaceDifficultyProfiles()), OPUS, 'workspace-tier:tier1')).toBeUndefined();
  });

  it('the route records carry workspace-tier:tier1 decided by cqp1 from the same runs', () => {
    const tier = (routeKey: string) => derivedRecord(routeKey, ROWS).capabilities.find((entry) => entry.capability === 'workspace-tier:tier1');
    expect(tier(OPUS)).toMatchObject({ verdict: 'qualified', scoredRunCount: 12, successCount: 12 });
    expect(tier(FABLE)).toMatchObject({ verdict: 'qualified', scoredRunCount: 6, successCount: 6 });
    expect(tier(SONNET)).toMatchObject({ verdict: 'notQualified', scoredRunCount: 20, successCount: 17 });
    expect(derivedRecord(OPUS, ROWS).policy.policyID).toBe('cqp1');
  });

  it('recommend implement --tier 1 --contract crr2 ranks the qualified routes in the crr2 order', () => {
    const answer = crr2(1);
    expect(answer.query.tier).toBe('tier1');
    expect(answer.query.routeQuery.structuralTier).toBe('tier1');
    // Wilson lower bound on the capability: OPUS 15/15 above FABLE 9/9.
    expect(answer.order).toEqual([OPUS, FABLE]);
    expect(answer.selected?.routeKey).toBe(OPUS);
    expect(answer.ranking.map((entry) => entry.qualification.tierVerdict)).toEqual(['qualified', 'qualified']);
    expect(answer.ranking[0].reasons[3]).toMatch(/^ranked above claudeCLI:claude-fable-5-1 on reliability/);
  });

  it('a tier-two query finds no tier-two runs, and ranks nothing rather than borrowing tier one\'s', () => {
    const answer = crr2(2);
    expect(answer.ranking).toEqual([]);
    for (const routeKey of [OPUS, FABLE]) expect(reasonsFor(answer, routeKey)).toContain('tier: no evidence at tier2');
  });

  it('runs of a derived tier-two case rank at tier two by the same rules', () => {
    const rows = [...runs(OPUS, TIER2.c.id, 4, 4, 70_000), ...runs(FABLE, TIER2.c.id, 3, 4, 30_000)];
    const answer = crr2(2, rows);
    expect(capabilityRow(rollup(rows), OPUS, 'workspace-tier:tier2')).toMatchObject({ runCount: 4, passCount: 4 });
    expect(answer.order).toEqual([OPUS]);
    expect(reasonsFor(answer, FABLE)).toContain('tier: tier2 is notQualified');
  });
});

// ------------------------------------------------------------------ (b) an underivable tier is never assumed

describe('(b) a case whose tier the bands cannot derive yields no tier row, and its route is excluded', () => {
  const rows = [...runs(OPUS, UNTIERED_ID, 12, 12, 60_000), ...runs(FABLE, UNTIERED_ID, 6, 6, 40_000)];

  it('the rollup and the records carry the capability from those runs and no workspace-tier row', () => {
    const result = rollup(rows);
    expect(capabilityRow(result, OPUS, CAPABILITY)).toMatchObject({ runCount: 12, passCount: 12 });
    for (const route of result.routes) expect(route.capabilities.map((entry) => entry.capability).filter((name) => name.startsWith('workspace-tier:'))).toEqual([]);
    for (const routeKey of [OPUS, FABLE]) {
      expect(derivedRecord(routeKey, rows).capabilities.map((entry) => entry.capability).filter((name) => name.startsWith('workspace-tier:'))).toEqual([]);
    }
  });

  it('excludes every route with \'tier: no evidence at tier1\' at every tier, and ranks them without --tier', () => {
    for (const tier of [1, 2, 3]) {
      const answer = crr2(tier, rows);
      expect(answer.ranking).toEqual([]);
      for (const routeKey of [OPUS, FABLE]) expect(reasonsFor(answer, routeKey)).toContain(`tier: no evidence at tier${tier}`);
    }
    expect(crr2(undefined, rows).order).toEqual([OPUS, FABLE]);
  });
});

// ------------------------------------------------------------------ (c) cqp1's 900 is the only threshold; crr1 unchanged

describe('(c) a route at 850 per mille is never ranked by crr2, and crr1 is unchanged', () => {
  it('excludes SONNET at 850 per mille on the tier, with the cqp1 verdict, however fast it is', () => {
    const answer = crr2(1);
    expect(answer.order).not.toContain(SONNET);
    expect(reasonsFor(answer, SONNET)).toContain('tier: tier1 is notQualified — 17/20 scored runs passed (< 90%)');
  });

  it('excludes a route at 850 per mille on the capability itself, with or without --tier', () => {
    const rows = runs(SONNET, TIER1.c.id, 17, 20, 1_000);
    for (const tier of [undefined, 1]) {
      const answer = crr2(tier, rows);
      expect(answer.ranking).toEqual([]);
      expect(reasonsFor(answer, SONNET)).toContain(`capability: ${CAPABILITY} is notQualified — 17/20 scored runs passed (< 90%)`);
    }
    expect(V1_QUALIFICATION_POLICY).toMatchObject({ policyID: 'cqp1', minimumSuccessRateMilli: 900 });
  });

  it('gives crr1 the same answer with or without the derived tier rows', () => {
    const crr1 = (profiles: WorkspaceDifficultyProfile[]): RouteRecommendation => {
      const answer = recommendRoutes({ machineKey: HERE, taskType: 'implement' },
        { now: NOW, routes: fleet(ROWS, profiles), metrics: rollup(ROWS, profiles) });
      if (!answer.ok) throw new Error('refused');
      return answer;
    };
    const withDerived = crr1(PROFILES);
    const declaredOnly = crr1(registeredWorkspaceDifficultyProfiles());
    expect(withDerived.order).toEqual(declaredOnly.order);
    expect(withDerived.order.length).toBeGreaterThan(0);
    const summary = (answer: RouteRecommendation) => answer.ranking.map((entry) => [entry.routeKey, entry.rankedBy, entry.reasons]);
    expect(summary(withDerived)).toEqual(summary(declaredOnly));
    expect(withDerived.excluded).toEqual(declaredOnly.excluded);
    expect(withDerived.fallback).toEqual(declaredOnly.fallback);
  });

  it('uses the derived tier rows only in the crr2 command, never in crr1\'s', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src/cli/cernum.ts'), 'utf8');
    const calls = [...source.matchAll(/routingDifficultyProfiles\(/g)].map((match) => match.index!);
    expect(calls).toHaveLength(1);
    const crr2Command = source.indexOf('async function commandRecommendCrr2(');
    const after = source.indexOf('\nasync function ', crr2Command + 1);
    expect(calls[0]).toBeGreaterThan(crr2Command);
    expect(after === -1 || calls[0] < after).toBe(true);
  });
});

// ------------------------------------------------------------------ (d) the six discriminator-one cases

describe('(d) the tier the bands derive for each discriminator-one case', () => {
  // NONE. Every one of the six fails every band, so their sealed runs can establish no tier, and a
  // `--tier` query over them alone excludes every route with 'tier: no evidence at <tier>'. The decisive
  // refusals per case are pinned below; the full list is in each reading.
  const EXPECTED: Record<string, { tier: undefined; refusedBy: string[] }> = {
    'ws.d1.asset-container.retitle': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with irrelevantContextFileCount of 4',
      'tier2: belowTierFloor — declares tier2 with verificationCommandCount of 3',
      'tier3: belowTierFloor — declares tier3 with relevantFileCount of 8'] },
    'ws.d1.catalog-paging.walk': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with verificationCommandCount of 4',
      'tier2: aboveTierCeiling — declares tier2 with dependencyDepth of 4',
      'tier3: belowTierFloor — declares tier3 with hiddenInvariantCount of 2'] },
    'ws.d1.config-migrate.upgrade': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with relevantFileCount of 10',
      'tier2: belowTierFloor — declares tier2 with verificationCommandCount of 3',
      'tier3: belowTierFloor — declares tier3 with relevantFileCount of 10'] },
    'ws.d1.log-redact.mask': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with irrelevantContextFileCount of 3',
      'tier2: belowTierFloor — declares tier2 with verificationCommandCount of 3',
      'tier3: belowTierFloor — declares tier3 with hiddenInvariantCount of 2'] },
    'ws.d1.query-codec.nest': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with dependencyDepth of 3',
      'tier2: belowTierFloor — declares tier2 with relevantFileCount of 7',
      'tier3: belowTierFloor — declares tier3 with hiddenInvariantCount of 1'] },
    'ws.d1.task-board.reassign': { tier: undefined, refusedBy: [
      'tier1: aboveTierCeiling — declares tier1 with irrelevantContextFileCount of 1',
      'tier2: belowTierFloor — declares tier2 with verificationCommandCount of 3',
      'tier3: belowTierFloor — declares tier3 with verificationCommandCount of 3'] },
  };

  it('states each of the six cases\' derived tier, and the refusals that decide it', () => {
    const readings = registeredWorkspaceStructuralProfiles().map(workspaceStructuralTierReading);
    expect(readings.map((reading) => reading.caseID).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const reading of readings) {
      const expected = EXPECTED[reading.caseID];
      expect({ caseID: reading.caseID, tier: reading.tier }).toEqual({ caseID: reading.caseID, tier: expected.tier });
      for (const refusal of expected.refusedBy) expect(reading.reasons.some((reason) => reason.startsWith(refusal))).toBe(true);
    }
  });

  it('so their runs add no tier profile, and a tier-one crr2 query over them alone ranks nothing', () => {
    const declared = registeredWorkspaceDifficultyProfiles();
    const profiles = routingDifficultyProfiles(declared, registeredWorkspaceStructuralProfiles());
    expect(profiles).toEqual(declared);
    const d1 = Object.keys(EXPECTED).map(catalogue);
    const rows = d1.flatMap((c) => {
      const at = OPUS.indexOf(':');
      return [0, 1].map((index) => ({ recordRoot: `/virtual/d1/${c.id}/${index}`, row: {
        provider: OPUS.slice(0, at), requestedModelID: OPUS.slice(at + 1), candidate: OPUS, caseID: c.id, caseVersion: c.version,
        comparabilityKey: `cwk1:fixture-${c.id}`, repeatIndex: index, effort: 'none', status: 'pass', attemptsUsed: 1, billingBasis: 'subscription', bindingIdentityState: 'verified',
        wallClockMilliseconds: 60_000, recordedAt: hoursAgo(30 - index) } }));
    });
    const result = deriveMetricsRollup({ workspaceRows: rows, workspaceCases: d1, difficultyProfiles: profiles });
    expect(result.routes[0].capabilities.map((entry) => entry.capability).filter((name) => name.startsWith('workspace-tier:'))).toEqual([]);
    const record = deriveRouteQualification({ provider: 'claudeCLI', modelID: 'claude-opus-5-5', machineKey: HERE,
      workspaceRows: rows, workspaceCases: d1, difficultyProfiles: profiles, now: NOW });
    const answer = recommendRoutesCrr2({ machineKey: HERE, taskType: 'implement', tier: 1 },
      { now: NOW, routes: [{ record: routable(OPUS, record.capabilities), availability: available() }], metrics: result });
    if (!answer.ok) throw new Error('refused');
    expect(answer.ranking).toEqual([]);
    expect(reasonsFor(answer, OPUS)).toContain('tier: no evidence at tier1');
  });
});
