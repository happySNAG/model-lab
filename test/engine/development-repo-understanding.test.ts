// Cernum development benchmark · Pass 2 — the repository-understanding suite.
//
// No model runs here. What is proven is that the suite is well-formed, that a correct answer scores
// as correct, and — the part that matters more — that each specific wrong answer the fixture was
// built to provoke fails the RIGHT metric. A benchmark where every mistake lands in the same bucket
// tells a reader that something went wrong and nothing about what.

import { describe, expect, it } from 'vitest';

import {
  developmentCatalogDigest, developmentSuiteByID, developmentSuites, developmentTaskByID,
  developmentTaskCount, validateDevelopmentCatalog,
} from '../../src/core/development-catalog';
import {
  DEVELOPMENT_ANSWER_PATH, DevelopmentTask, developmentComparabilityKey, developmentSuiteDigest,
  developmentTaskDigest,
} from '../../src/core/development-benchmark';
import {
  REPO_UNDERSTANDING_SUITE_ID, repositoryUnderstandingSuite,
} from '../../src/core/development-suites/repo-understanding';
import { gradeRepositoryQuestion, readAnswer } from '../../src/core/development-evaluation';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { diffSnapshots, snapshotOf } from '../../src/core/development-fixture';
import { metricsForDimension } from '../../src/core/development-scoring';

const SUITE_DIGEST = 'mldsu1:bd905f792764dfd8';
const CATALOG_DIGEST = 'mldcat1:8aad3049612b14b5';

/** The fixture's own ground truth, written out once so every test grades against the same answers. */
const CORRECT_ANSWERS: Record<string, unknown> = {
  'task.dev.repo-understanding.locate-implementation': {
    file: 'src/core/charge-pipeline.js',
    symbol: 'runChargePipeline',
  },
  'task.dev.repo-understanding.trace-flow': {
    files: [
      'src/index.js',
      'src/api/charges.js',
      'src/core/charge-pipeline.js',
      'src/core/stages/validate.js',
      'src/core/stages/tax.js',
      'src/core/stages/round.js',
      'src/util/money.js',
    ],
  },
  'task.dev.repo-understanding.impact-set': {
    mustChange: ['src/core/charge-pipeline.js', 'src/config/rates.json'],
    mustNotEditByHand: ['src/schema/generated/charge-fields.js'],
  },
  'task.dev.repo-understanding.source-of-truth': {
    sourceOfTruth: 'src/schema/charge.schema.json',
    derived: 'src/schema/generated/charge-fields.js',
    generator: 'tools/generate-charge-fields.js',
  },
  'task.dev.repo-understanding.relevant-tests': {
    caseFile: 'test/cases/rounding.cases.json',
    testModule: 'test/money.test.js',
    otherTestsAffected: [],
  },
  'task.dev.repo-understanding.explain-bug': {
    file: 'src/util/money.js',
    symbol: 'roundHalfUp',
    cause: 'roundHalfUp delegates to Math.round, which rounds a half away from zero for positive amounts but toward zero for negative ones, so a negative half lands one minor unit high.',
    evidence: ['src/util/money.js', 'src/core/stages/round.js', 'test/cases/rounding.cases.json'],
  },
  'task.dev.repo-understanding.absent-feature': {
    present: false,
    files: [],
  },
};

const identityOf = (task: DevelopmentTask) => ({
  taskDigest: developmentTaskDigest(task),
  comparabilityKey: developmentComparabilityKey(task),
});

function grade(taskID: string, answer: unknown) {
  const task = developmentTaskByID(taskID)!;
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  return gradeRepositoryQuestion(task, ledgerlite, text, identityOf(task));
}

const failedMetrics = (result: ReturnType<typeof grade>): string[] =>
  result.grade.metrics.filter((metric) => metric.status === 'fail').map((metric) => metric.id).sort();

const failedAssertions = (result: ReturnType<typeof grade>): string[] =>
  result.outcomes.filter((outcome) => !outcome.held).map((outcome) => outcome.id).sort();

describe('the development catalog', () => {
  it('validates, and registers the repository-understanding suite and nothing else yet', () => {
    expect(() => validateDevelopmentCatalog()).not.toThrow();
    expect(developmentSuites.map((suite) => suite.id)).toEqual([REPO_UNDERSTANDING_SUITE_ID]);
    expect(developmentSuiteByID(REPO_UNDERSTANDING_SUITE_ID)).toBe(repositoryUnderstandingSuite);
    expect(developmentSuiteByID('suite.nope')).toBeUndefined();
    expect(developmentTaskCount()).toBe(7);
  });

  it('seals the suite and the registry to pinned digests', () => {
    expect(developmentSuiteDigest(repositoryUnderstandingSuite)).toBe(SUITE_DIGEST);
    expect(developmentCatalogDigest()).toBe(CATALOG_DIGEST);
  });

  it('gives every task a distinct comparability key', () => {
    const keys = repositoryUnderstandingSuite.tasks.map(developmentComparabilityKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('every repository-understanding task', () => {
  const tasks = repositoryUnderstandingSuite.tasks;

  it('is read-only, and reads and writes nothing but the reserved answer path', () => {
    for (const task of tasks) {
      expect(task.kind, task.id).toBe('repositoryQuestion');
      expect(task.dimension).toBe('repositoryUnderstanding');
      expect(task.requiredPaths).toEqual([DEVELOPMENT_ANSWER_PATH]);
      expect(task.permittedPaths).toEqual([]);
      for (const assertion of task.assertions) {
        const predicate = assertion.predicate;
        expect('path' in predicate ? predicate.path : '', `${task.id}/${assertion.id}`).toBe(DEVELOPMENT_ANSWER_PATH);
      }
    }
  });

  it('holds out at least one assertion, and states the answer shape in its prompt', () => {
    for (const task of tasks) {
      expect(task.assertions.some((assertion) => assertion.visibility === 'heldOut'), task.id).toBe(true);
      expect(task.prompt.user, task.id).toContain('Answer with exactly this shape:');
      expect(task.prompt.system).toContain('single JSON object');
      expect(task.capabilityUnderTest.length).toBeGreaterThan(0);
    }
  });

  it('spreads its assertions across more than one metric, so a failure says what went wrong', () => {
    for (const task of tasks) {
      const metrics = new Set(task.assertions.map((assertion) => assertion.metric));
      expect(metrics.size, task.id).toBeGreaterThan(1);
      for (const metric of metrics) {
        expect(metricsForDimension('repositoryUnderstanding').map((spec) => spec.id)).toContain(metric);
      }
    }
  });

  it('covers every capability the brief named', () => {
    expect(tasks.map((task) => task.id.split('.').pop())).toEqual([
      'absent-feature', 'explain-bug', 'impact-set', 'locate-implementation',
      'relevant-tests', 'source-of-truth', 'trace-flow',
    ]);
  });
});

describe('a correct answer', () => {
  it('holds every assertion on every task', () => {
    for (const task of repositoryUnderstandingSuite.tasks) {
      const result = grade(task.id, CORRECT_ANSWERS[task.id]);
      expect(failedAssertions(result), task.id).toEqual([]);
      expect(result.grade.structuralCredit, task.id).toBe('full');
      expect(result.grade.heldOutPassRateMilli, task.id).toEqual({ measured: 1_000 });
      expect(result.grade.shortcutSuspected).toBe(false);
    }
  });

  it('still does not earn full credit, because the executed tier is not measured on this dimension either', () => {
    // repositoryUnderstanding declares no executed metric, so unlike an edit task it CAN reach full.
    const result = grade('task.dev.repo-understanding.source-of-truth', CORRECT_ANSWERS['task.dev.repo-understanding.source-of-truth']);
    expect(result.grade.executedCredit).toBe('full');
    expect(result.grade.credit).toBe('full');
    expect(result.grade.creditReason).toContain('both tiers');
  });

  it('leaves the repository exactly as it found it', () => {
    const task = developmentTaskByID('task.dev.repo-understanding.trace-flow')!;
    const result = grade(task.id, CORRECT_ANSWERS[task.id]);
    const baseline = snapshotOf(ledgerlite);
    expect(result.baselineSnapshotDigest).toBe('mldsnap1:aa43e94dc603411');
    expect(result.resultSnapshotDigest).not.toBe(result.baselineSnapshotDigest);

    const answered = new Map(baseline);
    answered.set(DEVELOPMENT_ANSWER_PATH, JSON.stringify(CORRECT_ANSWERS[task.id]));
    const difference = diffSnapshots(baseline, answered);
    expect(difference.added).toEqual([DEVELOPMENT_ANSWER_PATH]);
    expect(difference.modified).toEqual([]);
    expect(difference.removed).toEqual([]);
  });
});

describe('each wrong answer fails the metric it should', () => {
  it('names the forwarding facade instead of the implementation', () => {
    const result = grade('task.dev.repo-understanding.locate-implementation', { file: 'src/api/charges.js', symbol: 'createCharge' });
    expect(failedMetrics(result)).toEqual(['answerAccuracy']);
    expect(failedAssertions(result)).toEqual(['locate.file', 'locate.symbol']);
    // The shape was right, so the omission metric holds: the answer was complete and wrong.
    expect(result.grade.metrics.find((metric) => metric.id === 'omissionAvoidance')!.status).toBe('pass');
  });

  it('drops the stage that transforms nothing out of the trace', () => {
    const answer = CORRECT_ANSWERS['task.dev.repo-understanding.trace-flow'] as { files: string[] };
    const result = grade('task.dev.repo-understanding.trace-flow', { files: answer.files.filter((path) => !path.endsWith('validate.js')) });
    expect(failedMetrics(result)).toEqual(['answerAccuracy', 'omissionAvoidance']);
    expect(failedAssertions(result)).toEqual(['trace.includes-validate', 'trace.order']);
  });

  it('gets the trace right but in the wrong order', () => {
    const answer = CORRECT_ANSWERS['task.dev.repo-understanding.trace-flow'] as { files: string[] };
    const result = grade('task.dev.repo-understanding.trace-flow', { files: [...answer.files].reverse() });
    expect(failedAssertions(result)).toEqual(['trace.order']);
    expect(failedMetrics(result)).toEqual(['answerAccuracy']);
  });

  it('adds the generated module to the trace it was told to exclude', () => {
    const answer = CORRECT_ANSWERS['task.dev.repo-understanding.trace-flow'] as { files: string[] };
    const result = grade('task.dev.repo-understanding.trace-flow', {
      files: [...answer.files, 'src/schema/generated/charge-fields.js'],
    });
    expect(failedMetrics(result)).toEqual(['answerAccuracy', 'irrelevantFileRestraint']);
  });

  it('proposes hand-editing the generated module', () => {
    const result = grade('task.dev.repo-understanding.impact-set', {
      mustChange: ['src/core/charge-pipeline.js', 'src/config/rates.json', 'src/schema/generated/charge-fields.js'],
      mustNotEditByHand: ['src/schema/generated/charge-fields.js'],
    });
    // The right files ARE named, so accuracy holds; what fails is restraint. A benchmark that
    // collapsed these two would report this answer identically to one that named nothing right.
    expect(failedMetrics(result)).toEqual(['irrelevantFileRestraint']);
    expect(failedAssertions(result)).toEqual(['impact.not-generated']);
    expect(result.grade.metrics.find((metric) => metric.id === 'answerAccuracy')!.status).toBe('pass');
  });

  it('sweeps in documentation and an unrelated case table', () => {
    const result = grade('task.dev.repo-understanding.impact-set', {
      mustChange: ['src/core/charge-pipeline.js', 'src/config/rates.json', 'README.md', 'test/cases/rounding.cases.json'],
      mustNotEditByHand: ['src/schema/generated/charge-fields.js'],
    });
    expect(failedAssertions(result)).toEqual(['impact.not-readme', 'impact.not-rounding-cases']);
    expect(result.grade.metrics.find((metric) => metric.id === 'irrelevantFileRestraint')!.valueMilli).toEqual({ measured: 333 });
  });

  it('mistakes the generated module for the source of truth', () => {
    const result = grade('task.dev.repo-understanding.source-of-truth', {
      sourceOfTruth: 'src/schema/generated/charge-fields.js',
      derived: 'src/schema/charge.schema.json',
      generator: 'src/schema/charge.schema.json',
    });
    expect(failedAssertions(result)).toEqual(['sot.derived', 'sot.generator', 'sot.source']);
    expect(result.grade.metrics.find((metric) => metric.id === 'answerAccuracy')!.valueMilli).toEqual({ measured: 0 });
  });

  it('writes a new assertion into the test module instead of adding a case to the table', () => {
    const result = grade('task.dev.repo-understanding.relevant-tests', {
      caseFile: 'test/money.test.js',
      testModule: 'test/money.test.js',
      otherTestsAffected: [],
    });
    expect(failedAssertions(result)).toEqual(['tests.case-file']);
    expect(failedMetrics(result)).toEqual(['answerAccuracy']);
  });

  it('claims an unrelated test is affected', () => {
    const result = grade('task.dev.repo-understanding.relevant-tests', {
      ...(CORRECT_ANSWERS['task.dev.repo-understanding.relevant-tests'] as object),
      otherTestsAffected: ['test/charges.test.js'],
    });
    expect(failedMetrics(result)).toEqual(['irrelevantFileRestraint']);
  });

  it('blames the rate table for a sign-dependent rounding defect', () => {
    const result = grade('task.dev.repo-understanding.explain-bug', {
      file: 'src/config/rates.json',
      symbol: 'applyTax',
      cause: 'The configured tax rate for the region is wrong, so the total comes out a unit off.',
      evidence: ['src/config/rates.json', 'src/core/stages/tax.js'],
    });
    expect(failedMetrics(result).sort()).toEqual(['answerAccuracy', 'evidenceGrounding', 'irrelevantFileRestraint']);
    expect(failedAssertions(result)).toContain('bug.names-the-operation');
    expect(failedAssertions(result)).toContain('bug.evidence-not-rates');
  });

  it('finds the right function but explains it as vague floating-point trouble', () => {
    const result = grade('task.dev.repo-understanding.explain-bug', {
      file: 'src/util/money.js',
      symbol: 'roundHalfUp',
      cause: 'Floating point arithmetic is imprecise, so the result is sometimes off by one.',
      evidence: ['src/util/money.js'],
    });
    // The location is right and the diagnosis is not: exactly the distinction evidenceGrounding is for.
    expect(failedMetrics(result)).toEqual(['answerAccuracy', 'evidenceGrounding']);
    expect(failedAssertions(result)).toEqual(['bug.names-the-operation', 'bug.names-the-sign']);
  });

  it('invents a currency converter', () => {
    const result = grade('task.dev.repo-understanding.absent-feature', {
      present: true,
      files: ['src/util/money.js', 'src/config/rates.json'],
    });
    expect(failedMetrics(result)).toEqual(['answerAccuracy', 'irrelevantFileRestraint']);
  });

  it('says the feature is absent and then names files anyway', () => {
    const result = grade('task.dev.repo-understanding.absent-feature', { present: false, files: ['src/util/money.js'] });
    expect(failedMetrics(result)).toEqual(['irrelevantFileRestraint']);
    expect(result.grade.metrics.find((metric) => metric.id === 'answerAccuracy')!.status).toBe('pass');
  });
});

describe('how an answer is read', () => {
  const correct = CORRECT_ANSWERS['task.dev.repo-understanding.source-of-truth'];
  const taskID = 'task.dev.repo-understanding.source-of-truth';

  it('records bare JSON as strictly and semantically parsed', () => {
    const result = grade(taskID, correct);
    expect(result.answer).toMatchObject({ strictlyParsed: true, semanticallyParsed: true, fenceRemoved: false });
    expect(failedAssertions(result)).toEqual([]);
  });

  it('judges a fenced answer on its content, and still records that the transport was not clean', () => {
    const fenced = '```json\n' + JSON.stringify(correct, null, 2) + '\n```';
    const result = grade(taskID, fenced);
    expect(result.answer).toMatchObject({ strictlyParsed: false, semanticallyParsed: true, fenceRemoved: true });
    // Punctuation is not the thing under test on this dimension: the answer is correct and scores so.
    expect(failedAssertions(result)).toEqual([]);
  });

  it('refuses to unwrap prose wrapped around a fence, and grades what it actually got', () => {
    const chatty = 'Here is what I found:\n\n```json\n' + JSON.stringify(correct) + '\n```\n\nHope that helps!';
    const result = grade(taskID, chatty);
    expect(result.answer!.semanticallyParsed).toBe(false);
    expect(result.answer!.fenceRefusedBecause).toBeDefined();
    expect(failedAssertions(result)).toEqual([
      'sot.derived', 'sot.generator', 'sot.shape.derived', 'sot.shape.generator', 'sot.shape.source', 'sot.source',
    ]);
    expect(result.outcomes[0].detail).toMatch(/does not parse as JSON/);
  });

  it('records an answer that is not JSON at all without throwing, and fails every reading of it', () => {
    const result = grade(taskID, 'The schema file is obviously the source of truth.');
    expect(result.answer).toMatchObject({ strictlyParsed: false, semanticallyParsed: false });
    expect(result.answer!.recorded).toBe('The schema file is obviously the source of truth.');
    expect(result.grade.structuralCredit).toBe('none');
    expect(result.grade.credit).toBe('none');
  });

  it('records an empty answer as an empty answer rather than as a passing one', () => {
    const result = grade(taskID, '');
    expect(result.answer).toMatchObject({ strictlyParsed: false, semanticallyParsed: false, recorded: '' });
    expect(failedAssertions(result)).toHaveLength(6);
  });

  it('reads a top-level array as not an object, because the prompt asked for an object', () => {
    expect(readAnswer('[1,2,3]').semanticallyParsed).toBe(false);
    expect(readAnswer('{"a":1}').semanticallyParsed).toBe(true);
    expect(readAnswer('  {"a":1}  ').strictlyParsed).toBe(true);
  });
});
