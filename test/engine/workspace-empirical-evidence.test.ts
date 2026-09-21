// What a finished campaign SHOWED: recovery counted where it happened, and discrimination read
// relative to the candidates that ran — plus the discriminator pack's plan, before anything runs.
//
// THE ROWS BELOW ARE SYNTHETIC AND SHAPED LIKE THE REAL ONES. They carry the real case ids and the
// real comparability keys, so every dimension a row is counted under comes off the sealed case, and
// their outcomes reproduce the shapes the three completed Claude matrices actually had: Tier 1 with
// one real recovery on a case not tagged for recovery, Tier 2 and Tier 3 with every retry-capable run
// passing first time. The historical records themselves live on the machine that ran them and are
// read back, unmodified, outside this suite; a test that depended on them would pass on one machine.
//
// NO PROVIDER IS CONTACTED. The plan tests use a driver factory that throws if anything runs.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allWorkspaceCases, discriminatorOnePack, foundationFourPack, tierTwoPack,
} from '../../src/engine/workspace-catalog';
import { workspaceComparabilityKey } from '../../src/engine/workspace-case';
import { WorkspaceRunRow, aggregateWorkspaceRuns } from '../../src/engine/workspace-aggregate';
import {
  describeWorkspaceCapabilityEvidence, workspaceCapabilityEvidence,
} from '../../src/engine/workspace-routing-evidence';
import {
  WORKSPACE_DISCRIMINATION_IS_RELATIVE, describeWorkspaceEmpiricalDiscrimination, describeWorkspaceRecoveryEvidence,
  failureSignatureOf, workspaceEmpiricalDiscrimination, workspaceRecoveryEvidence,
} from '../../src/engine/workspace-empirical-evidence';
import * as empirical from '../../src/engine/workspace-empirical-evidence';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { registeredWorkspaceStructuralProfiles } from '../../src/engine/workspace-discriminator-catalog';
import { workspacePackStructuralDigest } from '../../src/engine/workspace-discriminator';
import { WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan } from '../../src/engine/workspace-matrix';
import { ScriptedWorkspaceAgent, WorkspaceAgentDriver } from '../../src/engine/workspace-agent';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { provenModel } from './frontier-harness';

const LINEUP = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5'];
const candidateOf = (model: string) => `claudeCLI:${model}`;
const caseByID = (id: string) => allWorkspaceCases().find((entry) => entry.id === id)!;

interface RunShape {
  model: string;
  caseID: string;
  repeat: number;
  pass: boolean;
  attemptsUsed?: number;
  failingChecks?: string[];
  unsatisfied?: string[];
}

/** One sealed-looking run row, carrying only what the readings use. */
function run(shape: RunShape): WorkspaceRunRow {
  const workspaceCase = caseByID(shape.caseID);
  return {
    recordRoot: `/records/${shape.model}/${shape.caseID}/r${shape.repeat}`,
    row: {
      candidate: candidateOf(shape.model),
      provider: 'claudeCLI',
      requestedModelID: shape.model,
      bindingIdentityState: 'verified',
      caseID: shape.caseID,
      caseVersion: workspaceCase.version,
      comparabilityKey: workspaceComparabilityKey(workspaceCase),
      caseMaximumAttempts: workspaceCase.execution.maximumAttempts,
      repeatIndex: shape.repeat,
      repeatsPlanned: 3,
      status: shape.pass ? 'pass' : 'fail',
      attemptsUsed: shape.attemptsUsed ?? 1,
      scopeClean: true,
      verificationOutcomes: (shape.failingChecks ?? []).map((commandID) => ({ commandID, required: true, passed: false })),
      hiddenOutcomes: [],
      invariantOutcomes: (shape.unsatisfied ?? []).map((invariantPath) => ({ path: invariantPath, satisfied: false })),
    },
  };
}

/** Every model, every case, three repeats, all first-time passes — then `overrides` applied. */
function matrix(caseIDs: string[], overrides: (shape: RunShape) => RunShape = (shape) => shape): WorkspaceRunRow[] {
  return LINEUP.flatMap((model) => caseIDs.flatMap((caseID) => [1, 2, 3].map((repeat) =>
    run(overrides({ model, caseID, repeat, pass: true })))));
}

// MARK: - Recovery is counted where it happened

describe('a recovery-tagged case outcome is not recovery evidence', () => {
  it('reports recovery as UNAVAILABLE when every retry-capable run passed first time — the Tier 2 and Tier 3 shape', () => {
    const cells = aggregateWorkspaceRuns(matrix(tierTwoPack.caseIDs));
    const rows = workspaceCapabilityEvidence(cells, allWorkspaceCases(), registeredWorkspaceDifficultyProfiles())
      .filter((row) => row.dimension === 'recoveryFromError');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // THE CASE OUTCOME IS STILL REPORTED, AND STILL 3/3 — it is what happened.
      expect(row.successCount).toBe(3);
      expect(row.scoredRunCount).toBe(3);
      // BUT IT IS NOT PRESENTED AS RECOVERY. No run failed and retried, so there is no evidence.
      expect(row.exercise.requiresRetry).toBe(true);
      expect(row.exercise.measured).toBe(false);
      expect(row.exercise.exercisedRunCount).toBe(0);
      expect(row.exercise.recovery?.opportunityCount).toBe(0);
      expect(row.exercise.recovery?.firstAttemptSuccessCount).toBe(3);
      expect(row.exercise.recovery?.recoveryRateMilli.provenance).toBe('unavailable');
      expect(row.exercise.recovery?.recoveryRateMilli.value).toBeUndefined();
      const line = describeWorkspaceCapabilityEvidence(row);
      expect(line).toContain('case outcome   3/3');
      expect(line).toContain('recovery UNAVAILABLE — 0 opportunities in 3 retry-capable run(s)');
    }
    for (const evidence of workspaceRecoveryEvidence(cells)) {
      expect(evidence.measured).toBe(false);
      expect(evidence.opportunityCount).toBe(0);
      expect(evidence.recoveryRateMilli.provenance).toBe('unavailable');
      expect(evidence.statement).toContain('NOT MEASURED');
      expect(describeWorkspaceRecoveryEvidence(evidence)).toContain('rate UNAVAILABLE');
    }
  });

  it('measures recovery from a real failed-then-retried run, and a failed recovery as a real zero', () => {
    const rows = matrix(['ws.t2.cache-eviction.recover'], (shape) => {
      if (shape.model === 'claude-haiku-4-5' && shape.repeat === 1) return { ...shape, pass: true, attemptsUsed: 2 };
      if (shape.model === 'claude-sonnet-5' && shape.repeat === 2) return { ...shape, pass: false, attemptsUsed: 2 };
      return shape;
    });
    const evidence = workspaceRecoveryEvidence(aggregateWorkspaceRuns(rows));
    const haiku = evidence.find((entry) => entry.candidate === candidateOf('claude-haiku-4-5'))!;
    expect(haiku.measured).toBe(true);
    expect(haiku.opportunityCount).toBe(1);
    expect(haiku.recoveredCount).toBe(1);
    expect(haiku.failedRecoveryCount).toBe(0);
    expect(haiku.firstAttemptSuccessCount).toBe(2);
    expect(haiku.recoveryRateMilli).toEqual({ provenance: 'measured', value: 1000 });
    expect(haiku.casesWithOpportunities).toEqual(['ws.t2.cache-eviction.recover']);
    const sonnet = evidence.find((entry) => entry.candidate === candidateOf('claude-sonnet-5'))!;
    expect(sonnet.measured).toBe(true);
    expect(sonnet.failedRecoveryCount).toBe(1);
    expect(sonnet.recoveryRateMilli).toEqual({ provenance: 'measured', value: 0 });
    // Two candidates with no opportunity: unavailable, never a zero and never a hundred.
    for (const model of ['claude-fable-5-1', 'claude-opus-5']) {
      expect(evidence.find((entry) => entry.candidate === candidateOf(model))!.recoveryRateMilli.provenance).toBe('unavailable');
    }
  });

  it('keeps the one real Tier 1 recovery as measured, though its case is not tagged for recovery — the Tier 1 shape', () => {
    // Haiku failed ws.broken-sum.mean's first attempt in one repeat and passed its second; every other
    // retry-capable run passed first time; and Haiku failed ws.receipt-refunds.sign three times on
    // a one-attempt case, which is a failure and never a recovery opportunity.
    const rows = matrix(foundationFourPack.caseIDs, (shape) => {
      if (shape.model !== 'claude-haiku-4-5') return shape;
      if (shape.caseID === 'ws.broken-sum.mean' && shape.repeat === 2) return { ...shape, attemptsUsed: 2 };
      if (shape.caseID === 'ws.receipt-refunds.sign') return { ...shape, pass: false, failingChecks: ['sign-check'] };
      return shape;
    });
    const cells = aggregateWorkspaceRuns(rows);
    expect(caseByID('ws.broken-sum.mean').dimensions).not.toContain('recoveryFromError');

    const haiku = workspaceRecoveryEvidence(cells).find((entry) => entry.candidate === candidateOf('claude-haiku-4-5'))!;
    expect(haiku.measured).toBe(true);
    expect(haiku.opportunityCount).toBe(1);
    expect(haiku.recoveredCount).toBe(1);
    expect(haiku.casesWithOpportunities).toEqual(['ws.broken-sum.mean']);
    // The one-attempt failures are NOT opportunities.
    expect(haiku.retryCapableCases).toEqual(['ws.broken-sum.mean', 'ws.registry-isolation.recover']);
    expect(haiku.firstAttemptFailureWithoutRetryCount).toBe(0);

    // The capability ROW for recoveryFromError reads only the case tagged for it, where nothing was
    // retried — so it says unavailable, while the tag-independent reading above keeps the evidence.
    const tagged = workspaceCapabilityEvidence(cells, allWorkspaceCases(), registeredWorkspaceDifficultyProfiles())
      .find((row) => row.dimension === 'recoveryFromError' && row.candidate === candidateOf('claude-haiku-4-5'))!;
    expect(tagged.caseIDs).toEqual(['ws.registry-isolation.recover']);
    expect(tagged.exercise.measured).toBe(false);

    for (const model of LINEUP.slice(1)) {
      expect(workspaceRecoveryEvidence(cells).find((entry) => entry.candidate === candidateOf(model))!.measured).toBe(false);
    }
  });

  it('does not mistake an operator-capped first-attempt failure for an opportunity', () => {
    const rows = matrix(['ws.t2.cache-eviction.recover'], (shape) => (shape.model === 'claude-opus-5' && shape.repeat === 1
      ? { ...shape, pass: false, attemptsUsed: 1, failingChecks: ['basic-tests'] } : shape));
    const opus = workspaceRecoveryEvidence(aggregateWorkspaceRuns(rows)).find((entry) => entry.candidate === candidateOf('claude-opus-5'))!;
    expect(opus.opportunityCount).toBe(0);
    expect(opus.firstAttemptFailureWithoutRetryCount).toBe(1);
    expect(opus.measured).toBe(false);
  });

  it('treats every non-retry dimension as exercised by any scored run, pass or fail', () => {
    const cells = aggregateWorkspaceRuns(matrix(['ws.t2.text-normalize.cluster'], (shape) =>
      (shape.model === 'claude-opus-5' ? shape : { ...shape, pass: false })));
    const rows = workspaceCapabilityEvidence(cells, allWorkspaceCases(), registeredWorkspaceDifficultyProfiles());
    for (const row of rows) {
      expect(row.exercise.requiresRetry).toBe(false);
      expect(row.exercise.measured).toBe(true);
      expect(row.exercise.exercisedRunCount).toBe(3);
      expect(row.exercise.recovery).toBeUndefined();
    }
  });
});

// MARK: - Discrimination is relative to the candidates that ran

describe('a campaign reads per case, relative to its candidate set, and ranks nobody', () => {
  it('recognises a case every candidate passed every time as saturated for THIS candidate set', () => {
    const discrimination = workspaceEmpiricalDiscrimination(aggregateWorkspaceRuns(matrix(['ws.t3.event-replay.pair'])));
    const [entry] = discrimination.cases;
    expect(entry.reading).toBe('saturatedForThisCandidateSet');
    expect(entry.passedEveryRun).toHaveLength(4);
    expect(entry.empiricalSeparationCount).toBe(0);
    expect(entry.repeatStableCandidateCount).toBe(4);
    expect(entry.statement).toContain('says nothing about others');
    expect(entry.disclosure).toBe(WORKSPACE_DISCRIMINATION_IS_RELATIVE);
    expect(discrimination.summary.saturatedForThisCandidateSet).toBe(1);
  });

  it('recognises one candidate 3/3 against three at 0/3 as separating this set, with the shared failure shape', () => {
    // The Tier 2 text-normalize shape: three candidates fail every repeat the same way.
    const rows = matrix(['ws.t2.text-normalize.cluster'], (shape) => (shape.model === 'claude-opus-5' ? shape
      : { ...shape, pass: false, unsatisfied: ['src/unicode.js'] }));
    const discrimination = workspaceEmpiricalDiscrimination(aggregateWorkspaceRuns(rows), rows);
    const [entry] = discrimination.cases;
    expect(entry.reading).toBe('separatesThisCandidateSet');
    expect(entry.passedEveryRun).toEqual([candidateOf('claude-opus-5')]);
    expect(entry.failedEveryRun).toHaveLength(3);
    expect(entry.empiricalSeparationCount).toBe(3);
    expect(entry.failureClusters).toEqual([{
      signature: 'invariant:src/unicode.js',
      candidates: [candidateOf('claude-fable-5-1'), candidateOf('claude-haiku-4-5'), candidateOf('claude-sonnet-5')],
      runCount: 9,
      candidateSpecific: false,
    }]);
    expect(describeWorkspaceEmpiricalDiscrimination(discrimination).join('\n')).toContain('separatesThisCandidateSet');
  });

  it('recognises a candidate whose repeats disagree as a split, and a lone failure shape as candidate-specific', () => {
    const rows = matrix(['ws.t2.cache-eviction.recover'], (shape) => (shape.model === 'claude-sonnet-5' && shape.repeat === 3
      ? { ...shape, pass: false, attemptsUsed: 2, failingChecks: ['peek-is-not-a-use'] } : shape));
    const [entry] = workspaceEmpiricalDiscrimination(aggregateWorkspaceRuns(rows), rows).cases;
    expect(entry.reading).toBe('splitWithinCandidates');
    expect(entry.split).toEqual([candidateOf('claude-sonnet-5')]);
    expect(entry.candidates.find((candidate) => candidate.candidate === candidateOf('claude-sonnet-5'))?.repeatConsensus).toBe('split');
    expect(entry.failureClusters).toEqual([{
      signature: 'check:peek-is-not-a-use', candidates: [candidateOf('claude-sonnet-5')], runCount: 1, candidateSpecific: true,
    }]);
  });

  it('says a case with one measured candidate cannot be read yet', () => {
    const rows = matrix(['ws.broken-sum.mean']).filter((entry) => entry.row.requestedModelID === 'claude-opus-5');
    expect(workspaceEmpiricalDiscrimination(aggregateWorkspaceRuns(rows)).cases[0].reading).toBe('insufficientEvidence');
  });

  it('introduces no universal score, no ranking and no winner', () => {
    const rows = matrix([...tierTwoPack.caseIDs], (shape) => (shape.model === 'claude-opus-5' || shape.caseID !== 'ws.t2.text-normalize.cluster'
      ? shape : { ...shape, pass: false }));
    const discrimination = workspaceEmpiricalDiscrimination(aggregateWorkspaceRuns(rows), rows);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) { keys.add(key); walk(entry); }
      }
    };
    walk(discrimination);
    walk(workspaceRecoveryEvidence(aggregateWorkspaceRuns(rows)));
    // `scoredRunCount` is a count of runs that were scored, not a score; everything else that names one is refused.
    for (const key of keys) expect(/score(?!d)|winner|rank|overall|best|leader|composite/i.test(key), `a reading carries "${key}"`).toBe(false);
    for (const name of Object.keys(empirical)) expect(/score|winner|rank|best|leader/i.test(name), `the module exports ${name}`).toBe(false);
    // Candidates are listed in name order within every case, whatever they scored.
    for (const entry of discrimination.cases) {
      const names = entry.candidates.map((candidate) => candidate.candidate);
      expect(names).toEqual([...names].sort());
    }
  });

  it('computes failure signatures from checks and invariants, never from a candidate', () => {
    expect(failureSignatureOf(run({ model: 'm', caseID: 'ws.broken-sum.mean', repeat: 1, pass: true }).row)).toBeUndefined();
    expect(failureSignatureOf(run({
      model: 'm', caseID: 'ws.broken-sum.mean', repeat: 1, pass: false, failingChecks: ['b', 'a'], unsatisfied: ['src/x.js'],
    }).row)).toBe('check:a + check:b + invariant:src/x.js');
  });
});

// MARK: - The discriminator pack's plan

const proven = (modelIDs: string[]): DiscoveryEvidence => ({
  writtenAt: new Date().toISOString(),
  models: modelIDs.map((modelID) => ({ ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString() })),
});

/** A driver that exists, so every cell plans — and that fails the test if anything asks it to run. */
let requestsSent = 0;
const refusesToRun: NonNullable<WorkspaceMatrixRequest['driverFactory']> = () => {
  const driver: WorkspaceAgentDriver = {
    driverID: 'driver.scripted',
    provider: 'claudeCLI',
    capabilities: new ScriptedWorkspaceAgent([]).capabilities,
    async run() {
      requestsSent += 1;
      throw new Error('a plan must never run anything');
    },
  };
  return driver;
};

function planRequest(overrides: Partial<WorkspaceMatrixRequest> = {}): WorkspaceMatrixRequest {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-disc-plan-'));
  return {
    pack: discriminatorOnePack,
    cases: allWorkspaceCases(),
    provider: 'claudeCLI',
    modelIDs: LINEUP,
    effort: 'none',
    discovery: proven(LINEUP),
    campaignRoot: path.join(scratch, 'campaigns'),
    fixtureRoot: path.resolve(__dirname, '../../fixtures'),
    sandboxRoot: path.join(scratch, 'sandbox'),
    runLabel: 'discriminator',
    difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    structuralProfiles: registeredWorkspaceStructuralProfiles(),
    driverFactory: refusesToRun,
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    ...overrides,
  };
}

describe('pack.cernum.workspace.discriminator-one@1 plans 72 runs and computes its own attempt ceiling', () => {
  it('four models x six cases x three repeats = 72 runs; the ceiling is summed from the sealed cases', () => {
    const plan = buildWorkspaceMatrixPlan(planRequest());
    expect(plan.taskRunCount).toBe(72);
    expect(plan.runnableRunCount).toBe(72);
    expect(plan.refusedRunCount).toBe(0);
    const perRepeat = plan.caseIDs.reduce((sum, caseID) => sum + caseByID(caseID).execution.maximumAttempts, 0);
    expect(perRepeat).toBe(8);
    expect(plan.maximumProviderAttemptCount).toBe(4 * 3 * perRepeat);
    expect(plan.maximumProviderAttemptCount).toBe(96);
    expect(plan.designedRecovery).toEqual({
      retryCapableCaseIDs: ['ws.d1.query-codec.nest', 'ws.d1.task-board.reassign'],
      retryCapableRunCount: 24,
      additionalAttemptCeiling: 24,
    });
    expect(plan.throttleProtectionArmed).toBe(true);
    expect(plan.marginalAPIChargeMicroUSD).toEqual({ provenance: 'measured', value: 0 });
    expect(plan.allowanceEstimate.totalMicroUSD.provenance).toBe('unavailable');
    expect(requestsSent).toBe(0);
  });

  it('claims no tier, carries every structural profile and its digest, and says why in the preview', () => {
    const plan = buildWorkspaceMatrixPlan(planRequest());
    expect(plan.difficultyTier).toBeUndefined();
    expect(plan.difficultyProfiles).toEqual([]);
    expect(plan.structuralProfiles).toHaveLength(6);
    expect(plan.packStructuralDigest).toBe(workspacePackStructuralDigest(registeredWorkspaceStructuralProfiles(), plan.caseIDs));
    for (const cell of plan.cells) {
      expect(cell.difficultyTier).toBeUndefined();
      expect(cell.structuralDigest?.startsWith('cwx1:')).toBe(true);
    }
    const printed = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(printed).toContain('NO TIER — empirical discriminator family');
    expect(printed).toContain('structure dig.  cwx1:');
    expect(printed).toContain('4 models x 6 cases x 3 repeats = 72 independent runs');
    expect(printed).toMatch(/max attempts\s+96/);
    expect(printed).toContain('recovery design 2 case(s) allow a retry: 24 runnable run(s) could each make a second attempt');
    expect(printed).toContain('OPPORTUNITIES BY DESIGN');
    expect(printed).toContain('declared intent, not evidence');
    expect(printed).toContain('Neither predicts the other');
    for (const profile of registeredWorkspaceStructuralProfiles()) expect(printed).toContain(profile.rationale);
    expect(requestsSent).toBe(0);
  });

  it('says plainly when an operator cap leaves the matrix unable to observe any recovery', () => {
    const plan = buildWorkspaceMatrixPlan(planRequest({ attemptCeiling: 1 }));
    expect(plan.maximumProviderAttemptCount).toBe(72);
    expect(plan.designedRecovery.retryCapableRunCount).toBe(0);
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).toContain('recovery design NONE');
  });

  it('leaves the tier packs\' plans exactly as they were', () => {
    const plan = buildWorkspaceMatrixPlan(planRequest({ pack: tierTwoPack }));
    expect(plan.taskRunCount).toBe(48);
    expect(plan.maximumProviderAttemptCount).toBe(60);
    expect(plan.difficultyTier).toBe('tier2');
    expect(plan.structuralProfiles).toEqual([]);
    expect(plan.packStructuralDigest).toBeUndefined();
  });
});
