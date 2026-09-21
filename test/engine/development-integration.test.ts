// Cernum development benchmark · Pass 4 — reporting, qualification and routing evidence.
//
// THE PROPERTY THIS FILE EXISTS TO PROVE is a negative one: adding two dimensions to Cernum must not
// give a single previously measured candidate a standing on them. A benchmark extension that
// silently promoted twelve configurations on the strength of questions they were never asked would
// be worse than no extension, because it would be confidently wrong about exactly the models a
// routing decision is most likely to pick.

import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_ROLE_DEFINITIONS, DevelopmentEvidence, DevelopmentPlan,
  assessDevelopmentEligibility, assessDevelopmentRoles, buildDevelopmentEvidence,
  candidatesRequiringDevelopmentBenchmark, describeDevelopmentEvidence, noDevelopmentEvidence,
} from '../../src/core/development-evidence';
import { EXECUTED_TIER_NOT_MEASURED_REASON, metricsForDimension } from '../../src/core/development-scoring';
import {
  DevelopmentTask, developmentComparabilityKey, developmentSuiteDigest, developmentTaskDigest,
  provenanceIsComplete,
} from '../../src/core/development-benchmark';
import { developmentSuites, developmentTaskByID } from '../../src/core/development-catalog';
import { repositoryUnderstandingSuite } from '../../src/core/development-suites/repo-understanding';
import { multiFileEditSuite } from '../../src/core/development-suites/multi-file-edit';
import { gradeRepositoryEdit, gradeRepositoryQuestion } from '../../src/core/development-evaluation';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { fixtureRepoDigest } from '../../src/core/development-fixture';
import { DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION, developmentContractDigest } from '../../src/core/development-scoring';
import {
  RankableOutcome, EMPTY_DEVELOPMENT_PLAN, rankCandidates,
} from '../../src/engine/ranking';
import {
  developmentProvenance, readBenchmarkCommit, readMachineIdentity, readWorkingTreeDirty,
} from '../../src/engine/development-provenance';
import { CORRECT_ANSWERS, REFERENCE_SOLUTIONS, apply } from './fixtures/ledgerlite-solutions';

/** The twelve configurations Cernum has measured on the text suites, and only on those. */
const PREVIOUSLY_MEASURED = [
  'claudeCLI:claude-fable-5-1@high',
  'claudeCLI:claude-haiku-4-5',
  'claudeCLI:claude-opus-4-8',
  'claudeCLI:claude-opus-5',
  'claudeCLI:claude-sonnet-5@high',
  'claudeCLI:claude-sonnet-5@max',
  'codexCLI:gpt-5.6-luna@max',
  'codexCLI:gpt-5.6-sol@max',
  'codexCLI:gpt-5.6-sol@medium',
  'codexCLI:gpt-5.6-terra@medium',
  'codexCLI:gpt-6-astra@max',
  'codexCLI:gpt-6-astra@medium',
];

const PLAN: DevelopmentPlan = {
  plannedTaskCounts: {
    repositoryUnderstanding: repositoryUnderstandingSuite.tasks.length,
    multiFileEditing: multiFileEditSuite.tasks.length,
  },
};

const AT = '2026-09-21T12:00:00Z';

const identityOf = (task: DevelopmentTask) => ({
  taskDigest: developmentTaskDigest(task),
  comparabilityKey: developmentComparabilityKey(task),
});

function provenanceFor(task: DevelopmentTask, suiteDigest: string) {
  return developmentProvenance({
    benchmarkVersion: '0.2.4',
    benchmarkCommit: 'a'.repeat(40),
    machine: { machineIdentifier: 'test-machine', platform: 'darwin-arm64' },
    suiteID: task.suiteID, suiteVersion: task.suiteVersion, suiteDigest,
    taskID: task.id, ...identityOf(task),
    fixtureRepoID: task.fixtureRepoID, fixtureRepoVersion: task.fixtureRepoVersion,
    fixtureRepoDigest: task.fixtureRepoDigest,
    contractID: DEVELOPMENT_SCORING_CONTRACT_ID,
    contractVersion: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    contractDigest: developmentContractDigest(),
    executedAt: AT,
  });
}

function gradeUnderstanding(taskIDs: string[] = repositoryUnderstandingSuite.tasks.map((task) => task.id),
                            answers: Record<string, unknown> = CORRECT_ANSWERS) {
  const suiteDigest = developmentSuiteDigest(repositoryUnderstandingSuite);
  return taskIDs.map((taskID) => {
    const task = developmentTaskByID(taskID)!;
    const result = gradeRepositoryQuestion(task, ledgerlite, JSON.stringify(answers[taskID]), identityOf(task));
    return { ...result, provenance: provenanceFor(task, suiteDigest) };
  });
}

function gradeEditing(taskIDs: string[] = multiFileEditSuite.tasks.map((task) => task.id), solve = true) {
  const suiteDigest = developmentSuiteDigest(multiFileEditSuite);
  return taskIDs.map((taskID) => {
    const task = developmentTaskByID(taskID)!;
    const snapshot = solve ? apply(REFERENCE_SOLUTIONS[taskID]) : apply();
    const result = gradeRepositoryEdit(task, ledgerlite, snapshot, identityOf(task));
    return { ...result, provenance: provenanceFor(task, suiteDigest) };
  });
}

describe('a candidate that has not run the development suites', () => {
  const evidence = noDevelopmentEvidence('codexCLI:gpt-6-astra@max', PLAN, AT);

  it('reads NOT MEASURED on both dimensions, with no rate rather than a zero', () => {
    expect(evidence.dimensions.map((entry) => entry.dimension)).toEqual(['repositoryUnderstanding', 'multiFileEditing']);
    for (const entry of evidence.dimensions) {
      expect(entry.state, entry.dimension).toBe('notMeasured');
      expect(entry.gradedTaskCount).toBe(0);
      expect('measured' in entry.structuralPassRateMilli, entry.dimension).toBe(false);
      expect('measured' in entry.heldOutPassRateMilli).toBe(false);
      expect(entry.because).toMatch(/not a zero score/);
    }
  });

  it('knows how many tasks it still owes on each dimension', () => {
    expect(evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!.plannedTaskCount).toBe(7);
    expect(evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!.plannedTaskCount).toBe(3);
  });

  it('qualifies for no development role, and says why in each one', () => {
    const roles = assessDevelopmentRoles(evidence);
    expect(roles.map((role) => role.role)).toEqual(DEVELOPMENT_ROLE_DEFINITIONS.map((definition) => definition.role));
    for (const role of roles) {
      expect(role.qualified, role.role).toBe(false);
      expect(role.structuralStanding).toBe('notMeasured');
      expect(role.reason).toMatch(/^NOT MEASURED/);
      expect(role.interpretation).toMatch(/not a measurement/);
    }
  });

  it('is reported as notMeasured rather than as failing', () => {
    const eligibility = assessDevelopmentEligibility(evidence);
    expect(eligibility.verdict).toBe('notMeasured');
    expect(eligibility.outstandingDimensions).toEqual(['repositoryUnderstanding', 'multiFileEditing']);
    expect(describeDevelopmentEvidence(evidence).join('\n')).toContain('NOT MEASURED');
  });

  it('records that there is no provenance to be complete, rather than claiming complete provenance', () => {
    expect(evidence.provenanceComplete).toBe(false);
    expect(evidence.provenanceGaps.join(' ')).toMatch(/no development task was run/);
  });
});

describe('the ranking layer', () => {
  const outcome = (candidate: string, caseID: string, status: string): RankableOutcome => ({
    candidate, caseID, dimension: 'conversation', status, governanceViolated: false,
  });

  it('gives every row a development standing, and it is NOT MEASURED when nothing ran the suites', () => {
    const ranked = rankCandidates({
      outcomes: PREVIOUSLY_MEASURED.flatMap((candidate) => [
        outcome(candidate, 'case:conversation:instruction-adherence', 'pass'),
        outcome(candidate, 'case:conversation:no-invented-continuity', 'pass'),
      ]),
      derivedAt: AT,
      developmentPlan: PLAN,
    });

    expect(ranked.rankings).toHaveLength(PREVIOUSLY_MEASURED.length);
    for (const row of ranked.rankings) {
      // A perfect text score. This is the row a careless extension would have promoted.
      expect(row.overallPassRateMilli, row.candidate).toEqual({ measured: 1_000 });
      expect(row.development.evidence.dimensions.every((entry) => entry.state === 'notMeasured'), row.candidate).toBe(true);
      expect(row.development.roles.every((role) => !role.qualified), row.candidate).toBe(true);
      expect(row.development.eligibility.verdict).toBe('notMeasured');
    }
  });

  it('lists every candidate that still owes the development suites, and what each owes', () => {
    const ranked = rankCandidates({
      outcomes: PREVIOUSLY_MEASURED.map((candidate) => outcome(candidate, 'case:x', 'pass')),
      derivedAt: AT, developmentPlan: PLAN,
    });
    expect(ranked.developmentUnmeasured.map((row) => row.candidate).sort()).toEqual([...PREVIOUSLY_MEASURED].sort());
    for (const row of ranked.developmentUnmeasured) {
      expect(row.outstandingDimensions).toEqual(['repositoryUnderstanding', 'multiFileEditing']);
    }
  });

  it('says on the table what the development block means, and what it may not be read as', () => {
    const ranked = rankCandidates({ outcomes: [outcome('alpha', 'case:x', 'pass')], derivedAt: AT });
    expect(ranked.developmentMeans).toMatch(/SEPARATE registry/);
    expect(ranked.developmentMeans).toMatch(/NOT MEASURED on both/);
    expect(ranked.countingRules.join(' ')).toMatch(/no candidate acquires a development standing/);
  });

  it('defaults to an empty plan rather than borrowing a registry it was never told about', () => {
    const ranked = rankCandidates({ outcomes: [outcome('alpha', 'case:x', 'pass')], derivedAt: AT });
    expect(EMPTY_DEVELOPMENT_PLAN.plannedTaskCounts).toEqual({ repositoryUnderstanding: 0, multiFileEditing: 0 });
    expect(ranked.rankings[0].development.evidence.dimensions.every((entry) => entry.plannedTaskCount === 0)).toBe(true);
    expect(ranked.rankings[0].development.evidence.dimensions.every((entry) => entry.state === 'notMeasured')).toBe(true);
  });

  it('leaves the text roles and rates exactly as they were', () => {
    const ranked = rankCandidates({
      outcomes: [outcome('alpha', 'case:conversation:a', 'pass')], derivedAt: AT, developmentPlan: PLAN,
    });
    const row = ranked.rankings[0];
    expect(row.roles).toHaveLength(5);
    expect(row.roles.every((role) => role.interpretation.startsWith('This is an interpretation'))).toBe(true);
    expect(row.dimensions.map((rate) => rate.dimension)).toEqual(['conversation']);
  });

  it('carries a candidate that HAS run the suites through onto its row', () => {
    const evidence = buildDevelopmentEvidence('alpha', gradeUnderstanding(), PLAN, AT);
    const ranked = rankCandidates({
      outcomes: [outcome('alpha', 'case:x', 'pass'), outcome('beta', 'case:x', 'pass')],
      derivedAt: AT, developmentPlan: PLAN,
      developmentEvidence: new Map([['alpha', evidence]]),
    });
    const alpha = ranked.rankings.find((row) => row.candidate === 'alpha')!;
    const beta = ranked.rankings.find((row) => row.candidate === 'beta')!;

    expect(alpha.development.evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!.state).toBe('measured');
    expect(alpha.development.roles.find((role) => role.role === 'repository reader')!.qualified).toBe(true);
    // Measuring one candidate says nothing about the one beside it.
    expect(beta.development.evidence.dimensions.every((entry) => entry.state === 'notMeasured')).toBe(true);
    expect(ranked.developmentUnmeasured.map((row) => row.candidate)).toContain('beta');
  });
});

describe('evidence from a candidate that did run the suites', () => {
  it('reports repositoryUnderstanding as measured, and qualifies the one role that needs no execution', () => {
    const evidence = buildDevelopmentEvidence('alpha', gradeUnderstanding(), PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.state).toBe('measured');
    expect(reading.gradedTaskCount).toBe(7);
    expect(reading.structuralFullCreditCount).toBe(7);
    expect(reading.fullCreditCount).toBe(7);
    expect(reading.structuralPassRateMilli).toEqual({ measured: 1_000 });
    expect(reading.heldOutPassRateMilli).toEqual({ measured: 1_000 });
    expect(reading.shortcutSuspectedCount).toBe(0);

    const reader = assessDevelopmentRoles(evidence).find((role) => role.role === 'repository reader')!;
    expect(reader.qualified).toBe(true);
    expect(reader.structuralStanding).toBe('met');
    expect(reader.reason).toMatch(/asks for nothing that requires running/);
  });

  it('reports multiFileEditing structurally in full, and still withholds the role', () => {
    const evidence = buildDevelopmentEvidence('alpha', gradeEditing(), PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!;
    expect(reading.state).toBe('measured');
    expect(reading.structuralPassRateMilli).toEqual({ measured: 1_000 });
    // Not one task reaches full credit, because no test was run.
    expect(reading.fullCreditCount).toBe(0);
    expect(reading.executedTierMeasured).toBe(false);
    expect(reading.executedTierBecause).toBe(EXECUTED_TIER_NOT_MEASURED_REASON);

    const editor = assessDevelopmentRoles(evidence).find((role) => role.role === 'multi-file editor')!;
    expect(editor.qualified).toBe(false);
    expect(editor.structuralStanding).toBe('met');
    expect(editor.reason).toMatch(/would assert that this candidate's code was run and worked/);
    expect(editor.reason).toMatch(/no OS sandbox/);
  });

  it('reports the executed metrics as notMeasured with no rate, never as failures', () => {
    const evidence = buildDevelopmentEvidence('alpha', gradeEditing(), PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!;
    for (const id of ['newTestsPass', 'existingTestsPass', 'buildSucceeds'] as const) {
      const rate = reading.metrics.find((metric) => metric.metric === id)!;
      expect(rate.tier).toBe('executed');
      expect(rate.failCount).toBe(0);
      expect(rate.passCount).toBe(0);
      expect(rate.notMeasuredCount).toBe(3);
      expect('measured' in rate.passRateMilli).toBe(false);
    }
    // Every structural metric that any task decided has a real rate beside them.
    const structural = reading.metrics.filter((metric) => metric.tier === 'structural' && metric.passCount > 0);
    expect(structural.length).toBeGreaterThan(0);
    expect(structural.every((metric) => 'measured' in metric.passRateMilli)).toBe(true);
  });

  it('publishes a rate for every metric the contract declares, and nothing it does not', () => {
    const evidence = buildDevelopmentEvidence('alpha', gradeEditing(), PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!;
    expect(reading.metrics.map((metric) => metric.metric))
      .toEqual(metricsForDimension('multiFileEditing').map((spec) => spec.id));
  });

  it('calls partial coverage partial, and refuses to rank on it', () => {
    const partial = gradeUnderstanding(repositoryUnderstandingSuite.tasks.slice(0, 4).map((task) => task.id));
    const evidence = buildDevelopmentEvidence('alpha', partial, PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.state).toBe('partiallyMeasured');
    expect(reading.because).toMatch(/4 of the 7 registered task\(s\)/);

    const reader = assessDevelopmentRoles(evidence).find((role) => role.role === 'repository reader')!;
    expect(reader.qualified).toBe(false);
    expect(reader.structuralStanding).toBe('partial');
    expect(assessDevelopmentEligibility(evidence).verdict).toBe('measurementIncomplete');
  });

  it('calls a candidate below the bar below the bar, not unmeasured', () => {
    const wrong = Object.fromEntries(Object.keys(CORRECT_ANSWERS).map((id) => [id, { nothing: true }]));
    // Both dimensions are fully GRADED and both are bad. That is a different statement from
    // "unmeasured", and the verdict has to say which one it is.
    const evidence = buildDevelopmentEvidence(
      'alpha', [...gradeUnderstanding(undefined, wrong), ...gradeEditing(undefined, false)], PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.state).toBe('measured');
    expect(reading.structuralPassRateMilli).toEqual({ measured: 0 });
    expect(evidence.dimensions.every((entry) => entry.state === 'measured')).toBe(true);
    expect(assessDevelopmentEligibility(evidence).verdict).toBe('structurallyBelowBar');
    expect(assessDevelopmentRoles(evidence).find((role) => role.role === 'repository reader')!.structuralStanding).toBe('notMet');
  });

  it('reaches only structurallyEvidencedPendingExecution when both dimensions are perfect', () => {
    const evidence = buildDevelopmentEvidence('alpha', [...gradeUnderstanding(), ...gradeEditing()], PLAN, AT);
    expect(evidence.dimensions.every((entry) => entry.state === 'measured')).toBe(true);
    const eligibility = assessDevelopmentEligibility(evidence);
    expect(eligibility.verdict).toBe('structurallyEvidencedPendingExecution');
    expect(eligibility.because).toMatch(/no OS sandbox/);
    // The one verdict nobody can reach: there is no approval value in the type.
    expect(eligibility.verdict).not.toBe('eligibleForFurtherReview');
  });

  it('counts a suspected shortcut without netting it against the rate', () => {
    const suiteDigest = developmentSuiteDigest(multiFileEditSuite);
    const taskID = 'task.dev.multi-file-edit.fix-negative-rounding';
    const task = developmentTaskByID(taskID)!;
    const snapshot = apply(REFERENCE_SOLUTIONS[taskID], (files) => {
      files.set('src/util/money.js', files.get('src/util/money.js')! + '\n// amount 10.125\n');
    });
    const graded = { ...gradeRepositoryEdit(task, ledgerlite, snapshot, identityOf(task)), provenance: provenanceFor(task, suiteDigest) };
    const evidence = buildDevelopmentEvidence('alpha', [graded], PLAN, AT);
    const reading = evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!;
    expect(reading.shortcutSuspectedCount).toBe(1);
    expect(describeDevelopmentEvidence(evidence).join('\n')).toMatch(/shortcut probe.*never netted/);
  });
});

describe('provenance', () => {
  it('records the commit, the machine, the fixture and the contract on every graded task', () => {
    const results = gradeUnderstanding();
    for (const result of results) {
      const provenance = result.provenance!;
      expect(provenanceIsComplete(provenance)).toEqual({ complete: true, missing: [] });
      expect(provenance.benchmarkCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.machineIdentifier).toBe('test-machine');
      expect(provenance.fixtureRepoDigest).toBe(fixtureRepoDigest(ledgerlite));
      expect(provenance.contractDigest).toBe(developmentContractDigest());
      expect(provenance.taskDigest.startsWith('mldt1:')).toBe(true);
      expect(provenance.comparabilityKey.startsWith('mldk1:')).toBe(true);
    }
    expect(buildDevelopmentEvidence('alpha', results, PLAN, AT).provenanceComplete).toBe(true);
  });

  it('names a missing commit rather than filling one in', () => {
    const task = developmentTaskByID('task.dev.repo-understanding.locate-implementation')!;
    const provenance = { ...provenanceFor(task, 'mldsu1:x'), benchmarkCommit: '' };
    expect(provenanceIsComplete(provenance)).toEqual({ complete: false, missing: ['benchmarkCommit'] });

    const result = { ...gradeRepositoryQuestion(task, ledgerlite, '{}', identityOf(task)), provenance };
    const evidence = buildDevelopmentEvidence('alpha', [result], PLAN, AT);
    expect(evidence.provenanceComplete).toBe(false);
    expect(evidence.provenanceGaps[0]).toContain('benchmarkCommit');
    expect(describeDevelopmentEvidence(evidence).join('\n')).toContain('provenance incomplete');
  });

  it('reads this checkout: a real commit, a real machine, and whether the tree is dirty', () => {
    const commit = readBenchmarkCommit();
    // In a checkout this is a commit; in an environment with no git it is empty. Both are honest,
    // and the one thing it may never be is a value that looks like a commit and is not one.
    expect(commit === '' || /^[0-9a-f]{40}$/.test(commit)).toBe(true);
    const machine = readMachineIdentity();
    expect(machine.machineIdentifier.length).toBeGreaterThan(0);
    expect(machine.platform).toBe(`${process.platform}-${process.arch}`);
    const dirty = readWorkingTreeDirty();
    expect(dirty === undefined || typeof dirty === 'boolean').toBe(true);
  });

  it('refuses a stamped commit that is not shaped like one', () => {
    const before = process.env.CERNUM_BENCHMARK_COMMIT;
    try {
      process.env.CERNUM_BENCHMARK_COMMIT = 'not-a-commit';
      const commit = readBenchmarkCommit();
      expect(commit === '' || /^[0-9a-f]{40}$/.test(commit)).toBe(true);
      expect(commit).not.toBe('not-a-commit');

      process.env.CERNUM_BENCHMARK_COMMIT = 'ABCDEF1234567890abcdef1234567890ABCDEF12';
      expect(readBenchmarkCommit()).toBe('abcdef1234567890abcdef1234567890abcdef12');
    } finally {
      if (before === undefined) delete process.env.CERNUM_BENCHMARK_COMMIT;
      else process.env.CERNUM_BENCHMARK_COMMIT = before;
    }
  });
});

describe('who has to be re-benchmarked', () => {
  it('names every previously measured configuration, computed rather than typed out', () => {
    const outstanding = candidatesRequiringDevelopmentBenchmark(PREVIOUSLY_MEASURED, new Map());
    expect(outstanding.map((row) => row.candidate)).toEqual([...PREVIOUSLY_MEASURED].sort());
    for (const row of outstanding) {
      expect(row.outstandingDimensions).toEqual(['repositoryUnderstanding', 'multiFileEditing']);
    }
  });

  it('drops a candidate from the list only once every dimension is fully measured', () => {
    const both = buildDevelopmentEvidence('claudeCLI:claude-opus-5', [...gradeUnderstanding(), ...gradeEditing()], PLAN, AT);
    const onlyReading = buildDevelopmentEvidence('claudeCLI:claude-haiku-4-5', gradeUnderstanding(), PLAN, AT);
    const evidence = new Map<string, DevelopmentEvidence>([
      ['claudeCLI:claude-opus-5', both],
      ['claudeCLI:claude-haiku-4-5', onlyReading],
    ]);
    const outstanding = candidatesRequiringDevelopmentBenchmark(PREVIOUSLY_MEASURED, evidence);
    expect(outstanding.map((row) => row.candidate)).not.toContain('claudeCLI:claude-opus-5');
    expect(outstanding.find((row) => row.candidate === 'claudeCLI:claude-haiku-4-5')!.outstandingDimensions)
      .toEqual(['multiFileEditing']);
    expect(outstanding).toHaveLength(PREVIOUSLY_MEASURED.length - 1);
  });
});

describe('the registry the evidence is measured against', () => {
  it('registers both dimensions, ten tasks, and one fixture repository', () => {
    expect(developmentSuites.map((suite) => suite.dimension).sort())
      .toEqual(['multiFileEditing', 'repositoryUnderstanding']);
    expect(developmentSuites.reduce((total, suite) => total + suite.tasks.length, 0)).toBe(10);
    expect(new Set(developmentSuites.flatMap((suite) => suite.tasks.map((task) => task.fixtureRepoID))).size).toBe(1);
  });
});
