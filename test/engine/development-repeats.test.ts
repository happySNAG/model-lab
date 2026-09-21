// Cernum development runner · Pass D — every repeat is evidence, and coverage is counted per task.
//
// Before this pass `buildDevelopmentEvidence` counted each graded result as a task, so a campaign at
// two repeats would have reported fourteen repository-understanding tasks out of seven and called the
// dimension measured after half of its repeats. These tests pin the replacement rules:
//
//   · coverage is counted over UNIQUE PLANNED TASKS, never over rows
//   · a task is measured only when every required repeat was GRADED
//   · a repeat no model answered is visible, makes its task incomplete, and never enters a rate
//   · a retry is part of the attempt it retried, and a duplicate row is the row it duplicates
//   · a task's score is the share of its graded repeats at full structural credit, and the
//     dimension's rate is the mean over tasks
//
// Proved twice: directly against the evidence builder, and end to end through a campaign run whose
// rows are read back off disk. Every attempt is answered by a synthetic adapter; nothing is sent.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask, developmentComparabilityKey, developmentTaskDigest } from '../../src/core/development-benchmark';
import { developmentSuites, developmentTaskByID } from '../../src/core/development-catalog';
import { DevelopmentTaskResult, gradeRepositoryEdit, gradeRepositoryQuestion } from '../../src/core/development-evaluation';
import {
  DevelopmentPlan, DevelopmentRepeatRecord, assessDevelopmentEligibility, buildDevelopmentEvidence,
  buildRepeatedDevelopmentEvidence,
} from '../../src/core/development-evidence';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { REPO_UNDERSTANDING_SUITE_ID, repositoryUnderstandingSuite } from '../../src/core/development-suites/repo-understanding';
import { MULTI_FILE_EDIT_SUITE_ID, multiFileEditSuite } from '../../src/core/development-suites/multi-file-edit';
import { createDevelopmentCampaign, openDevelopmentCampaign, runDevelopmentCampaign } from '../../src/engine/development-campaign';
import { DevelopmentPlanRequest, buildDevelopmentPlan } from '../../src/engine/development-plan';
import { buildDevelopmentCampaignReport, readDevelopmentCampaignState } from '../../src/engine/development-report';
import { FrontierAdapter, FrontierRequest, FrontierResponse } from '../../src/engine/frontier-adapter';
import { SlotResult } from '../../src/engine/ledger';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { CORRECT_ANSWERS, REFERENCE_SOLUTIONS, apply, baseline } from './fixtures/ledgerlite-solutions';

const AT = '2026-09-21T12:00:00Z';
const QUESTION = repositoryUnderstandingSuite.tasks[0];
const OTHER_QUESTION = repositoryUnderstandingSuite.tasks[1];
const EDIT = multiFileEditSuite.tasks[0];

function identityOf(task: DevelopmentTask) {
  return { taskDigest: developmentTaskDigest(task), comparabilityKey: developmentComparabilityKey(task) };
}

function correct(task: DevelopmentTask): DevelopmentTaskResult {
  return task.kind === 'repositoryQuestion'
    ? gradeRepositoryQuestion(task, ledgerlite, JSON.stringify(CORRECT_ANSWERS[task.id]), identityOf(task))
    : gradeRepositoryEdit(task, ledgerlite, apply(REFERENCE_SOLUTIONS[task.id]), identityOf(task));
}

function wrong(task: DevelopmentTask): DevelopmentTaskResult {
  return task.kind === 'repositoryQuestion'
    ? gradeRepositoryQuestion(task, ledgerlite, JSON.stringify({ nothing: true }), identityOf(task))
    : gradeRepositoryEdit(task, ledgerlite, apply(), identityOf(task));
}

function graded(task: DevelopmentTask, repeat: number, result = correct(task)): DevelopmentRepeatRecord {
  return { taskID: task.id, dimension: task.dimension, repeat, result };
}

function excluded(task: DevelopmentTask, repeat: number, disposition = 'transportFailed'): DevelopmentRepeatRecord {
  return { taskID: task.id, dimension: task.dimension, repeat, disposition, excludedBecause: 'the socket closed before any model answered' };
}

/** A plan of exactly the named tasks at `repeats`. */
function planOf(tasks: DevelopmentTask[], repeats: number): DevelopmentPlan {
  const ids = (dimension: DevelopmentTask['dimension']) => tasks.filter((task) => task.dimension === dimension).map((task) => task.id);
  return {
    plannedTaskCounts: { repositoryUnderstanding: ids('repositoryUnderstanding').length, multiFileEditing: ids('multiFileEditing').length },
    plannedTaskIDs: { repositoryUnderstanding: ids('repositoryUnderstanding'), multiFileEditing: ids('multiFileEditing') },
    requiredRepeats: repeats,
  };
}

function understanding(evidence: ReturnType<typeof buildRepeatedDevelopmentEvidence>) {
  return evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
}

// MARK: - The evidence layer

describe('coverage is counted per task, and a task is measured only when every required repeat is graded', () => {
  it('1 · one graded repeat of two does NOT make the task measured, however well it went', () => {
    expect(correct(QUESTION).grade.structuralCredit).toBe('full');
    const evidence = buildRepeatedDevelopmentEvidence('alpha', [graded(QUESTION, 1)], planOf([QUESTION], 2), AT);
    const reading = understanding(evidence);
    const task = reading.tasks.find((entry) => entry.taskID === QUESTION.id)!;

    expect(task.measured).toBe(false);
    expect(task.gradedRepeats).toEqual([1]);
    expect(task.missingRepeats).toEqual([2]);
    expect(reading.state).toBe('partiallyMeasured');
    expect(reading.gradedTaskCount).toBe(0);
    expect(reading.plannedTaskCount).toBe(1);
    expect(reading.gradedRepeatCount).toBe(1);
    expect(reading.requiredRepeatCount).toBe(2);
    // The one real grade is still reported — what is withheld is the claim the task was finished.
    expect(reading.structuralPassRateMilli).toEqual({ measured: 1_000 });
    expect(reading.because).toMatch(/0 of the 1 registered task\(s\)/);
  });

  it('2 · two valid graded repeats of two make the task measured', () => {
    const evidence = buildRepeatedDevelopmentEvidence('alpha', [graded(QUESTION, 1), graded(QUESTION, 2)], planOf([QUESTION], 2), AT);
    const reading = understanding(evidence);
    expect(reading.tasks[0].measured).toBe(true);
    expect(reading.tasks[0].stability).toBe('consistent');
    expect(reading.state).toBe('measured');
    expect(reading.gradedTaskCount).toBe(1);
    expect(reading.because).toMatch(/on all 2 repeats/);
  });

  it('3 · a duplicated or retried row for a repeat already recorded adds no repeat and no task', () => {
    const records = [graded(QUESTION, 1), graded(QUESTION, 1, wrong(QUESTION)), graded(QUESTION, 1)];
    const evidence = buildRepeatedDevelopmentEvidence('alpha', records, planOf([QUESTION], 2), AT);
    const reading = understanding(evidence);
    expect(reading.gradedRepeatCount).toBe(1);
    expect(reading.tasks[0].gradedRepeats).toEqual([1]);
    expect(reading.tasks[0].measured).toBe(false);
    // First wins, as it does in the ledger: the later, different grade is not averaged in.
    expect(reading.structuralPassRateMilli).toEqual({ measured: 1_000 });

    // A repeat the plan never asked for is not coverage either.
    const beyond = buildRepeatedDevelopmentEvidence('alpha', [graded(QUESTION, 1), graded(QUESTION, 3)], planOf([QUESTION], 2), AT);
    expect(understanding(beyond).tasks[0].gradedRepeats).toEqual([1]);

    // The pre-repeat entry point no longer counts one task twice.
    const legacy = buildDevelopmentEvidence('alpha', [correct(QUESTION), correct(QUESTION)], planOf([QUESTION], 1), AT);
    expect(understanding(legacy).gradedTaskCount).toBe(1);
    expect(understanding(legacy).scoredTaskCount).toBe(1);
  });

  it('4 · a transport failure is visible and incomplete, and is never scored as a model failure', () => {
    const evidence = buildRepeatedDevelopmentEvidence('alpha', [graded(QUESTION, 1), excluded(QUESTION, 2)], planOf([QUESTION], 2), AT);
    const reading = understanding(evidence);
    expect(reading.tasks[0].excludedRepeats).toEqual([2]);
    expect(reading.tasks[0].measured).toBe(false);
    expect(reading.excludedRepeatCount).toBe(1);
    expect(reading.state).toBe('partiallyMeasured');
    // Scored over the graded repeat only. Counting the dead socket as a wrong answer would read 500.
    expect(reading.structuralPassRateMilli).toEqual({ measured: 1_000 });
    expect(reading.tasks[0].creditCounts.none).toBe(0);

    const onlyExcluded = buildRepeatedDevelopmentEvidence('alpha', [excluded(QUESTION, 1), excluded(QUESTION, 2)], planOf([QUESTION], 2), AT);
    expect(understanding(onlyExcluded).state).toBe('notMeasured');
    expect(understanding(onlyExcluded).excludedRepeatCount).toBe(2);
    expect('unavailableReason' in understanding(onlyExcluded).structuralPassRateMilli).toBe(true);
    expect(understanding(onlyExcluded).because).toMatch(/reported as exclusions, never as failures/);
  });

  it('5 · mixed pass and fail across valid repeats score the task at the share it earned', () => {
    expect(wrong(QUESTION).grade.structuralCredit).not.toBe('full');
    const plan = planOf([QUESTION, OTHER_QUESTION], 2);
    const evidence = buildRepeatedDevelopmentEvidence('alpha', [
      graded(QUESTION, 1), graded(QUESTION, 2, wrong(QUESTION)),
      graded(OTHER_QUESTION, 1), graded(OTHER_QUESTION, 2),
    ], plan, AT);
    const reading = understanding(evidence);
    const mixed = reading.tasks.find((entry) => entry.taskID === QUESTION.id)!;
    expect(mixed.stability).toBe('mixed');
    expect(mixed.structuralScoreMilli).toEqual({ measured: 500 });
    expect(mixed.repeatCredits.map((entry) => entry.structuralCredit)).toEqual(['full', wrong(QUESTION).grade.structuralCredit]);
    expect(reading.mixedTaskCount).toBe(1);
    // Mean over TASKS: (500 + 1000) / 2. Both tasks are fully covered, so the dimension is measured.
    expect(reading.structuralPassRateMilli).toEqual({ measured: 750 });
    expect(reading.state).toBe('measured');
    expect(reading.structuralFullCreditCount).toBe(1);

    // And all-wrong is lower still: the mixed task genuinely sits between the two.
    const bad = buildRepeatedDevelopmentEvidence('alpha', [
      graded(QUESTION, 1, wrong(QUESTION)), graded(QUESTION, 2, wrong(QUESTION)),
      graded(OTHER_QUESTION, 1), graded(OTHER_QUESTION, 2),
    ], plan, AT);
    expect(understanding(bad).structuralPassRateMilli).toEqual({ measured: 500 });
  });

  it('6 · candidate-level evidence stays incomplete until every required task repeat is graded', () => {
    const tasks = [QUESTION, EDIT];
    const plan = planOf(tasks, 2);
    const partial = buildRepeatedDevelopmentEvidence('alpha', [
      graded(QUESTION, 1), graded(QUESTION, 2), graded(EDIT, 1),
    ], plan, AT);
    expect(assessDevelopmentEligibility(partial).verdict).toBe('measurementIncomplete');
    expect(assessDevelopmentEligibility(partial).because).toMatch(/multiFileEditing graded on 0 of 1 task/);

    const withExclusion = buildRepeatedDevelopmentEvidence('alpha', [
      graded(QUESTION, 1), graded(QUESTION, 2), graded(EDIT, 1), excluded(EDIT, 2, 'providerCapacityExhausted'),
    ], plan, AT);
    expect(assessDevelopmentEligibility(withExclusion).verdict).toBe('measurementIncomplete');

    const complete = buildRepeatedDevelopmentEvidence('alpha', [
      graded(QUESTION, 1), graded(QUESTION, 2), graded(EDIT, 1), graded(EDIT, 2),
    ], plan, AT);
    expect(complete.dimensions.every((entry) => entry.state === 'measured')).toBe(true);
    expect(assessDevelopmentEligibility(complete).verdict).not.toBe('measurementIncomplete');
  });

  it('keeps every number it had at one repeat, so Pass C evidence reads exactly as before', () => {
    const results = repositoryUnderstandingSuite.tasks.map((task, index) => (index % 2 === 0 ? correct(task) : wrong(task)));
    const plan: DevelopmentPlan = { plannedTaskCounts: { repositoryUnderstanding: 7, multiFileEditing: 3 } };
    const reading = understanding(buildDevelopmentEvidence('alpha', results, plan, AT));
    const full = results.filter((result) => result.grade.structuralCredit === 'full').length;
    expect(reading.structuralPassRateMilli).toEqual({ measured: Math.round((full * 1_000) / 7) });
    expect(reading.gradedTaskCount).toBe(7);
    expect(reading.state).toBe('measured');
  });
});

// MARK: - End to end, through the rows on disk

const ALL_TASKS: DevelopmentTask[] = developmentSuites.flatMap((suite) => suite.tasks);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function taskFor(request: FrontierRequest): DevelopmentTask {
  return ALL_TASKS.find((task) => request.promptText.includes(task.prompt.user))!;
}

function solve(request: FrontierRequest, task: DevelopmentTask): Partial<FrontierResponse> {
  const root = request.developmentWorkspace!.root;
  if (task.kind === 'repositoryQuestion') {
    const text = JSON.stringify(CORRECT_ANSWERS[task.id]);
    fs.writeFileSync(path.join(root, DEVELOPMENT_ANSWER_PATH), text);
    return { answerText: text };
  }
  for (const [relative, contents] of apply(REFERENCE_SOLUTIONS[task.id])) {
    if (baseline.get(relative) === contents) continue;
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  return { answerText: 'done' };
}

/** `behaviour` sees the task and how many times THAT task has been asked, counting retries. */
function adapter(behaviour: (request: FrontierRequest, task: DevelopmentTask, nth: number) => Partial<FrontierResponse>): FrontierAdapter {
  const seen = new Map<string, number>();
  return {
    provider: 'claudeCLI',
    async complete(request) {
      const task = taskFor(request);
      const nth = (seen.get(task.id) ?? 0) + 1;
      seen.set(task.id, nth);
      return {
        answerText: '', reportedModelID: 'model-a', usage: { inputTokens: 10, visibleOutputTokens: 5 },
        usageProvenance: 'providerReported', totalElapsedMilliseconds: 3, retryCount: 0, wastedTokens: 0,
        ...behaviour(request, task, nth),
      };
    },
  };
}

function campaignRequest(overrides: Partial<DevelopmentPlanRequest>): DevelopmentPlanRequest {
  return {
    label: 'pass-d-repeats', repeats: 2,
    candidates: [{
      name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', verifiedModelID: 'model-a',
      retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    }],
    benchmarkVersion: '0.2.4', createdAt: AT,
    machine: { machineIdentifier: 'test-machine', platform: 'darwin-arm64' },
    benchmarkCommit: 'd'.repeat(40), workingTreeDirty: false,
    ...overrides,
  };
}

async function runCampaign(overrides: Partial<DevelopmentPlanRequest>, answer: FrontierAdapter, maxAttempts = Infinity) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-repeats-'));
  roots.push(base);
  const root = path.join(base, 'campaign');
  const plan = buildDevelopmentPlan(campaignRequest(overrides));
  const ledger = createDevelopmentCampaign(root, plan, () => AT);
  let finished = 0;
  await runDevelopmentCampaign({
    root, ledger, plan, adapters: { claudeCLI: answer }, now: () => new Date(AT), sleep: async () => undefined,
    shouldCancel: () => finished >= maxAttempts,
    onProgress: (event) => { if (event.kind === 'finished') finished += 1; },
  });
  return { root, plan };
}

function reportOf(root: string) {
  const state = readDevelopmentCampaignState(root);
  return { state, report: buildDevelopmentCampaignReport({ plan: state.plan, rows: state.rows, derivedAt: AT }) };
}

describe('the same rules, applied to a campaign read back from its ledger', () => {
  it('reports 1 of 2 repeats as incomplete coverage, then 2 of 2 as measured, after a resume', async () => {
    const { root } = await runCampaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] }, adapter(solve), 7);
    const first = reportOf(root).report;
    const candidate = first.candidates[0];
    expect(first.complete).toBe(false);
    expect(candidate.coverageComplete).toBe(false);
    expect(candidate.terminalAttempts).toBe(7);
    // Seven rows, all correct, and still NOT ONE task is measured: each has only its first repeat.
    const reading = candidate.evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.gradedTaskCount).toBe(0);
    expect(reading.plannedTaskCount).toBe(7);
    expect(reading.state).toBe('partiallyMeasured');
    expect(candidate.eligibility.verdict).toBe('measurementIncomplete');
    expect(candidate.warnings.join(' ')).toMatch(/COVERAGE INCOMPLETE/);

    const { ledger, plan } = openDevelopmentCampaign(root, () => AT);
    await runDevelopmentCampaign({ root, ledger, plan, adapters: { claudeCLI: adapter(solve) }, now: () => new Date(AT), sleep: async () => undefined });
    const second = reportOf(root);
    expect(second.state.rows).toHaveLength(14);
    expect(new Set(second.state.rows.map((row) => row.slotKey)).size).toBe(14);
    const after = second.report.candidates[0].evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(after.gradedTaskCount).toBe(7);
    expect(after.state).toBe('measured');
    expect(second.report.candidates[0].coverageComplete).toBe(true);
  });

  it('counts a retried attempt as ONE repeat, and reports the retry beside it', async () => {
    const retrying = adapter((request, task, nth) => (
      task.id === QUESTION.id && nth === 1
        ? { failure: { kind: 'transport', detail: 'connection reset by peer' }, usage: {} }
        : solve(request, task)));
    const { root } = await runCampaign({
      suiteIDs: [REPO_UNDERSTANDING_SUITE_ID], repeats: 1,
      candidates: [{ ...campaignRequest({}).candidates[0], retry: { ...DEFAULT_RETRY, maxRetries: 1, backoffMilliseconds: 0 } }],
    }, retrying);
    const { state, report } = reportOf(root);
    const row = state.rows.find((entry) => entry.taskID === QUESTION.id)!;
    expect(row.retryCount).toBe(1);
    expect(row.measurementState).toBe('graded');
    expect(state.rows.filter((entry) => entry.taskID === QUESTION.id)).toHaveLength(1);
    const candidate = report.candidates[0];
    expect(candidate.retries).toMatchObject({ attemptsRetried: 1, totalRetries: 1 });
    const reading = candidate.evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.gradedRepeatCount).toBe(7);
    expect(reading.requiredRepeatCount).toBe(7);
    expect(reading.tasks.find((entry) => entry.taskID === QUESTION.id)!.gradedRepeats).toEqual([1]);
  });

  it('ignores a duplicated row on disk, so a copied line cannot inflate coverage', async () => {
    const { root } = await runCampaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] }, adapter(solve), 7);
    const results = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(results, 'utf8').split('\n').filter((line) => line.length > 0);
    // Seven more copies of the first-repeat rows: fourteen lines, and still seven distinct repeats.
    fs.appendFileSync(results, lines.map((line) => `${line}\n`).join(''));
    const { report } = reportOf(root);
    expect(report.duplicateRows).toBe(7);
    expect(report.terminalAttempts).toBe(7);
    const reading = report.candidates[0].evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    expect(reading.gradedRepeatCount).toBe(7);
    expect(reading.gradedTaskCount).toBe(0);
    expect(report.complete).toBe(false);
  });

  it('shows a transport failure as an exclusion, not a failure, and leaves its task incomplete', async () => {
    const flaky = adapter((request, task, nth) => (
      task.id === EDIT.id && nth === 2
        ? { failure: { kind: 'transport', detail: 'connection reset by peer' }, usage: {} }
        : solve(request, task)));
    const { root } = await runCampaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] }, flaky);
    const { state, report } = reportOf(root);
    const failed = state.rows.find((row) => row.taskID === EDIT.id && row.repeat === 2) as SlotResult;
    expect(failed.measurementState).toBe('notMeasured');
    expect(failed.disposition).toBe('transportFailed');

    const candidate = report.candidates[0];
    expect(candidate.exclusions).toEqual({ transportFailed: 1 });
    expect(candidate.statusCounts.unevaluable).toBe(1);
    expect(candidate.statusCounts.fail).toBe(0);
    const reading = candidate.evidence.dimensions.find((entry) => entry.dimension === 'multiFileEditing')!;
    const task = reading.tasks.find((entry) => entry.taskID === EDIT.id)!;
    expect(task.excludedRepeats).toEqual([2]);
    expect(task.measured).toBe(false);
    expect(task.structuralScoreMilli).toEqual({ measured: 1_000 });
    expect(reading.state).toBe('partiallyMeasured');
    expect(candidate.eligibility.verdict).toBe('measurementIncomplete');
  });

  it('leaves a cancelled attempt unrecorded, so resume runs that exact repeat rather than losing it', async () => {
    let cancelled = false;
    const stopping = adapter((request, task) => {
      if (!cancelled && task.id === QUESTION.id) {
        cancelled = true;
        return { failure: { kind: 'cancelled', detail: 'the operator interrupted the run' }, usage: {} };
      }
      return solve(request, task);
    });
    const { root, plan } = await runCampaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID], repeats: 1 }, stopping);
    const before = readDevelopmentCampaignState(root).rows;
    expect(before.some((row) => row.taskID === QUESTION.id)).toBe(false);
    expect(before.length).toBeLessThan(plan.attempts.length);

    const { ledger } = openDevelopmentCampaign(root, () => AT);
    expect(ledger.pending().map((slot) => slot.caseID)).toContain(QUESTION.id);
    await runDevelopmentCampaign({ root, ledger, plan, adapters: { claudeCLI: stopping }, now: () => new Date(AT), sleep: async () => undefined });
    const after = readDevelopmentCampaignState(root).rows;
    expect(after).toHaveLength(plan.attempts.length);
    expect(after.filter((row) => row.taskID === QUESTION.id).map((row) => row.measurementState)).toEqual(['graded']);
  });

  it('scores mixed outcomes across repeats as mixed, from the rows alone', async () => {
    const alternating = adapter((request, task, nth) => (
      task.id === QUESTION.id && nth === 2
        ? (() => { fs.writeFileSync(path.join(request.developmentWorkspace!.root, DEVELOPMENT_ANSWER_PATH), '{"nothing":true}'); return { answerText: '' }; })()
        : solve(request, task)));
    const { root } = await runCampaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] }, alternating);
    const { report } = reportOf(root);
    const reading = report.candidates[0].evidence.dimensions.find((entry) => entry.dimension === 'repositoryUnderstanding')!;
    const task = reading.tasks.find((entry) => entry.taskID === QUESTION.id)!;
    expect(task.stability).toBe('mixed');
    expect(task.structuralScoreMilli).toEqual({ measured: 500 });
    expect(reading.state).toBe('measured');
    expect(reading.structuralPassRateMilli).toEqual({ measured: Math.round((6 * 1_000 + 500) / 7) });
    expect(developmentTaskByID(QUESTION.id)).toBeDefined();
  });
});
