// Cernum development runner · Pass C — grading, persistence and resume.
//
// Pass B proved an attempt runs in a workspace it cannot leave and that the workspace is read back
// before it is deleted. This file proves what happens to those bytes afterwards: that they are
// graded by the existing graders and by nothing else, that the grade is a statement about what the
// workspace HELD rather than what the model SAID it did, that a row on which no model answered never
// becomes a grade, and that an interrupted campaign resumes onto the same slots without running any
// attempt twice.
//
// Every attempt here is answered by a SYNTHETIC adapter that acts on the workspace it is handed. No
// provider is contacted, no credential is read, and nothing is spent.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_ARTEFACTS_DIRECTORY, DEVELOPMENT_PLAN_FILE, DevelopmentCampaignError, createDevelopmentCampaign,
  developmentResultRow, developmentTerminalStatus, materialsFor, openDevelopmentCampaign, runDevelopmentCampaign,
  unrunnableAttempts,
} from '../../src/engine/development-campaign';
import { DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY } from '../../src/engine/development-edit-evidence';
import { gradeDevelopmentAttempt, readBackAnswer } from '../../src/engine/development-grading';
import { DEVELOPMENT_NEVER_MEASURED_FAILURES, executeDevelopmentAttempt } from '../../src/engine/development-execution';
import { DevelopmentCampaignPlan, DevelopmentPlanRequest, buildDevelopmentPlan } from '../../src/engine/development-plan';
import { FrontierAdapter, FrontierFailureKind, FrontierRequest, FrontierResponse } from '../../src/engine/frontier-adapter';
import { Ledger, SlotResult } from '../../src/engine/ledger';
import { NON_ANSWER_TERMINAL_STATUS } from '../../src/engine/attempt-disposition';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { EMPTY_DEVELOPMENT_PLAN, rankCandidates } from '../../src/engine/ranking';
import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask } from '../../src/core/development-benchmark';
import { developmentSuites, developmentTaskByID } from '../../src/core/development-catalog';
import { gradeRepositoryEdit, gradeRepositoryQuestion } from '../../src/core/development-evaluation';
import { snapshotDigest, snapshotOf } from '../../src/core/development-fixture';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { REPO_UNDERSTANDING_SUITE_ID } from '../../src/core/development-suites/repo-understanding';
import { MULTI_FILE_EDIT_SUITE_ID } from '../../src/core/development-suites/multi-file-edit';
import { CORRECT_ANSWERS, REFERENCE_SOLUTIONS, apply, baseline } from './fixtures/ledgerlite-solutions';

const MACHINE = { machineIdentifier: 'test-machine', platform: 'darwin-arm64' };
const COMMIT = 'c'.repeat(40);
const FIXED_NOW = () => new Date('2026-09-21T12:00:00Z');
const CLOCK = () => '2026-09-21T12:00:00Z';

const ALL_TASKS: DevelopmentTask[] = developmentSuites.flatMap((suite) => suite.tasks);

// MARK: - The synthetic adapter

/** Which registered task a request is for, recovered from the prompt the runner actually sent. */
function taskFor(request: FrontierRequest): DevelopmentTask {
  const matches = ALL_TASKS.filter((task) => request.promptText.includes(task.prompt.user));
  if (matches.length !== 1) throw new Error(`the synthetic adapter could not tell which task it was sent (${matches.length} matched)`);
  return matches[0];
}

/** Make the workspace hold exactly `target`: write what changed, remove what is gone. */
function writeSnapshotInto(root: string, target: ReadonlyMap<string, string>): void {
  for (const relative of baseline.keys()) {
    if (!target.has(relative)) fs.rmSync(path.join(root, relative), { force: true });
  }
  for (const [relative, contents] of target) {
    if (baseline.get(relative) === contents) continue;
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
}

type Behaviour = (request: FrontierRequest, task: DevelopmentTask, call: number) => Partial<FrontierResponse> | void;

/** Answers every question correctly into the answer file and applies every reference solution. */
const SOLVES: Behaviour = (request, task) => {
  const root = request.developmentWorkspace!.root;
  if (task.kind === 'repositoryQuestion') {
    const text = JSON.stringify(CORRECT_ANSWERS[task.id]);
    fs.writeFileSync(path.join(root, DEVELOPMENT_ANSWER_PATH), text);
    return { answerText: text };
  }
  writeSnapshotInto(root, apply(REFERENCE_SOLUTIONS[task.id]));
  return { answerText: 'I made the change.' };
};

function syntheticAdapter(behaviour: Behaviour = SOLVES): FrontierAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: 'claudeCLI',
    calls,
    async complete(request: FrontierRequest): Promise<FrontierResponse> {
      const task = taskFor(request);
      calls.push(task.id);
      const overrides = behaviour(request, task, calls.length) ?? {};
      return {
        answerText: '', reportedModelID: '', usage: { inputTokens: 100, visibleOutputTokens: 20 },
        usageProvenance: 'providerReported', totalElapsedMilliseconds: 7, retryCount: 0, wastedTokens: 0,
        ...overrides,
      };
    },
  };
}

// MARK: - Campaign scaffolding

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-persistence-test-'));
  roots.push(root);
  return path.join(root, 'campaign');
}

function planRequest(overrides: Partial<DevelopmentPlanRequest> = {}): DevelopmentPlanRequest {
  return {
    label: 'pass-c',
    repeats: 1,
    candidates: [{
      name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', effort: 'high',
      retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    }],
    benchmarkVersion: '0.2.4',
    createdAt: '2026-09-21T00:00:00Z',
    machine: MACHINE,
    benchmarkCommit: COMMIT,
    workingTreeDirty: false,
    ...overrides,
  };
}

function campaign(overrides: Partial<DevelopmentPlanRequest> = {}) {
  const root = freshRoot();
  const plan = buildDevelopmentPlan(planRequest(overrides));
  const ledger = createDevelopmentCampaign(root, plan, CLOCK);
  return { root, plan, ledger };
}

function run(root: string, ledger: Ledger, plan: DevelopmentCampaignPlan, adapter: FrontierAdapter,
             extra: Partial<Parameters<typeof runDevelopmentCampaign>[0]> = {}) {
  return runDevelopmentCampaign({
    root, ledger, plan, adapters: { claudeCLI: adapter }, now: FIXED_NOW, sleep: async () => undefined, ...extra,
  });
}

/** The rows as they are on DISK, not as the in-memory ledger remembers them. */
function rowsOnDisk(root: string): SlotResult[] {
  return fs.readFileSync(path.join(root, 'results.jsonl'), 'utf8').split('\n')
    .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as SlotResult);
}

function rowFor(rows: SlotResult[], taskID: string, repeat = 1): SlotResult {
  const row = rows.find((entry) => entry.taskID === taskID && entry.repeat === repeat);
  if (!row) throw new Error(`no row for ${taskID} repeat ${repeat}`);
  return row;
}

const QUESTION_TASKS = ALL_TASKS.filter((task) => task.kind === 'repositoryQuestion');
const EDIT_TASKS = ALL_TASKS.filter((task) => task.kind === 'repositoryEdit');

// MARK: - Grading

describe('repository-understanding results are graded by gradeRepositoryQuestion, from the workspace', () => {
  it('grades a correct answer read back out of the answer file, and records where it came from', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] });
    const progress = await run(root, ledger, plan, syntheticAdapter());
    expect(progress.graded).toBe(QUESTION_TASKS.length);
    expect(progress.notMeasured).toBe(0);

    for (const task of QUESTION_TASKS) {
      const row = rowFor(rowsOnDisk(root), task.id);
      // The very grader the suites were proven with, over the very answer the adapter wrote.
      const expected = gradeRepositoryQuestion(task, ledgerlite, JSON.stringify(CORRECT_ANSWERS[task.id]), {
        taskDigest: row.taskDigest as string, comparabilityKey: row.comparabilityKey as string,
      });
      expect(row.measurementState, task.id).toBe('graded');
      expect(row.answerSource, task.id).toBe('workspaceFile');
      expect(row.credit, task.id).toBe(expected.grade.credit);
      expect(row.structuralCredit, task.id).toBe('full');
      expect(row.resultSnapshotDigest, task.id).toBe(expected.resultSnapshotDigest);
      expect(row.status, task.id).toBe(expected.grade.credit === 'full' ? 'pass' : 'partial');
      expect(row.readOnlyViolationPaths, task.id).toEqual([]);
    }
  });

  it('falls back to the printed reply when no answer file was written, and says so', async () => {
    const task = QUESTION_TASKS[0];
    const { root, plan, ledger } = campaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter((request, current) => (
      current.kind === 'repositoryQuestion' ? { answerText: JSON.stringify(CORRECT_ANSWERS[current.id]) } : undefined
    )));
    const row = rowFor(rowsOnDisk(root), task.id);
    expect(row.answerSource).toBe('providerReply');
    expect(row.answerSourceBecause).toMatch(/wrote no cernum-answer\.json/);
    expect(row.structuralCredit).toBe('full');
  });

  it('prefers the workspace file over a reply that says something different', async () => {
    const task = QUESTION_TASKS[0];
    const { root, plan, ledger } = campaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter((request, current) => {
      const correct = JSON.stringify(CORRECT_ANSWERS[current.id]);
      fs.writeFileSync(path.join(request.developmentWorkspace!.root, DEVELOPMENT_ANSWER_PATH), correct);
      return { answerText: '{"file": "nowhere.js"}' };
    }));
    const row = rowFor(rowsOnDisk(root), task.id);
    expect(row.answerSource).toBe('workspaceFile');
    expect(row.structuralCredit).toBe('full');
  });

  it('reports a read-only task that wrote to the repository, without inventing a metric for it', async () => {
    const task = QUESTION_TASKS[0];
    const { root, plan, ledger } = campaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter((request, current) => {
      fs.writeFileSync(path.join(request.developmentWorkspace!.root, 'README.md'), 'overwritten');
      return { answerText: JSON.stringify(CORRECT_ANSWERS[current.id]) };
    }));
    const row = rowFor(rowsOnDisk(root), task.id);
    expect(row.readOnlyViolationPaths).toEqual(['README.md']);
    expect(row.touchedPaths).toEqual(['README.md']);
    // Reported, not scored: the grade is still what the answer earned.
    expect(row.structuralCredit).toBe('full');
  });

  it('grades an answered attempt that produced no answer at all as the empty answer it gave — a fail, not a blank', async () => {
    const outcome = {
      reading: { snapshot: snapshotOf(ledgerlite) }, answerText: '   ',
    } as unknown as Parameters<typeof readBackAnswer>[0];
    expect(readBackAnswer(outcome).source).toBe('none');

    const { root, plan, ledger } = campaign({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter(() => ({ answerText: '' })));
    for (const row of rowsOnDisk(root)) {
      expect(row.measurementState).toBe('graded');
      expect(row.answerSource).toBe('none');
      expect(row.status).toBe('fail');
    }
  });
});

describe('multi-file editing results are graded by gradeRepositoryEdit, from the workspace', () => {
  it('grades each reference solution from the repository the attempt left behind', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    const progress = await run(root, ledger, plan, syntheticAdapter());
    expect(progress.graded).toBe(EDIT_TASKS.length);

    for (const task of EDIT_TASKS) {
      const row = rowFor(rowsOnDisk(root), task.id);
      const solved = apply(REFERENCE_SOLUTIONS[task.id]);
      const expected = gradeRepositoryEdit(task, ledgerlite, solved, {
        taskDigest: row.taskDigest as string, comparabilityKey: row.comparabilityKey as string,
      }, { retryDetail: 'the attempt was made once and was not retried' });
      expect(row.measurementState, task.id).toBe('graded');
      expect(row.resultSnapshotDigest, task.id).toBe(snapshotDigest(solved));
      expect(row.baselineSnapshotDigest, task.id).toBe(snapshotDigest(baseline));
      expect(row.credit, task.id).toBe(expected.grade.credit);
      expect(row.structuralCredit, task.id).toBe('full');
      // Every path the solution changed, and nothing else.
      const changed = [...new Set([...solved.keys(), ...baseline.keys()])]
        .filter((relative) => solved.get(relative) !== baseline.get(relative)).sort();
      expect([...(row.touchedPaths as string[])].sort(), task.id).toEqual(changed);
      expect(row.answerSource, task.id).toBeUndefined();
    }
  });

  it('grades what the workspace HOLDS, not what the model claimed to have changed', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter(() => ({
      answerText: 'I updated rates.json, charge-pipeline.js and the tests. All four files are done.',
    })));
    for (const task of EDIT_TASKS) {
      const row = rowFor(rowsOnDisk(root), task.id);
      expect(row.measurementState, task.id).toBe('graded');
      expect(row.touchedPaths, task.id).toEqual([]);
      expect(row.resultSnapshotDigest, task.id).toBe(snapshotDigest(baseline));
      expect(row.structuralCredit, task.id).not.toBe('full');
      expect(row.status, task.id).not.toBe('pass');
    }
  });

  it('writes every assertion outcome to the row, the held-out ones included', async () => {
    const { root, plan, ledger } = campaign();
    await run(root, ledger, plan, syntheticAdapter());
    const outcomes = rowsOnDisk(root).flatMap((row) => row.assertionOutcomes as { visibility: string; id: string }[]);
    expect(outcomes.some((outcome) => outcome.visibility === 'heldOut')).toBe(true);
    for (const row of rowsOnDisk(root)) {
      const task = developmentTaskByID(row.taskID as string)!;
      expect((row.assertionOutcomes as { id: string }[]).map((outcome) => outcome.id).sort(), task.id)
        .toEqual(task.assertions.map((assertion) => assertion.id).sort());
    }
  });

  it('produces the same grade twice for the same bytes — deterministic, so a verdict can be re-derived', async () => {
    const first = campaign();
    const second = campaign();
    await run(first.root, first.ledger, first.plan, syntheticAdapter());
    await run(second.root, second.ledger, second.plan, syntheticAdapter());
    const strip = (row: SlotResult) => ({
      credit: row.credit, metrics: row.metrics, assertionOutcomes: row.assertionOutcomes,
      resultSnapshotDigest: row.resultSnapshotDigest, runID: row.runID,
    });
    expect(rowsOnDisk(second.root).map(strip)).toEqual(rowsOnDisk(first.root).map(strip));
  });
});

// MARK: - NOT MEASURED

describe('a row on which no model answered is NOT MEASURED, never a failed task', () => {
  const NON_ANSWERS: { kind: FrontierFailureKind; detail: string; disposition: string }[] = [
    { kind: 'transport', detail: 'the socket closed before a reply', disposition: 'transportFailed' },
    { kind: 'notAuthenticated', detail: 'the CLI is not logged in', disposition: 'providerUnauthenticated' },
    { kind: 'rateLimited', detail: 'usage limit reached; resets at 5pm', disposition: 'providerCapacityExhausted' },
    { kind: 'refused', detail: 'the request was rejected', disposition: 'providerRejectedRequest' },
  ];

  for (const failure of NON_ANSWERS) {
    it(`keeps ${failure.kind} out of every capability column`, async () => {
      const { root, plan, ledger } = campaign();
      const progress = await run(root, ledger, plan, syntheticAdapter(() => ({
        failure: { kind: failure.kind, detail: failure.detail }, answerText: '',
      })));
      expect(progress.graded).toBe(0);
      expect(progress.notMeasured).toBe(plan.attempts.length);
      for (const row of rowsOnDisk(root)) {
        expect(row.status).toBe(NON_ANSWER_TERMINAL_STATUS);
        expect(row.disposition).toBe(failure.disposition);
        expect(row.measurementState).toBe('notMeasured');
        expect(row.evaluable).toBe(false);
        expect(String(row.notMeasuredBecause)).toMatch(/NOT MEASURED/);
        expect(row.detail).toBe(`claudeCLI.${failure.kind}: ${failure.detail}`);
        // Absent — not zero, not fail. The whole point.
        for (const key of ['credit', 'structuralCredit', 'metrics', 'assertionOutcomes', 'heldOutPassRateMilli']) {
          expect(row[key], key).toBeUndefined();
        }
      }
    });
  }

  it('refuses to grade a request never sent, or answered by a different model', async () => {
    for (const kind of DEVELOPMENT_NEVER_MEASURED_FAILURES) {
      const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
      await run(root, ledger, plan, syntheticAdapter(() => ({ failure: { kind, detail: `refused as ${kind}` } })));
      for (const row of rowsOnDisk(root)) {
        expect(row.measurementState, kind).toBe('notMeasured');
        expect(row.credit, kind).toBeUndefined();
      }
    }
  });

  it('grades a timeout against the workspace, and still reports it as the timeout it was', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter(() => ({
      failure: { kind: 'timeout', detail: 'the request exceeded its budget' }, answerText: '',
    })));
    for (const row of rowsOnDisk(root)) {
      expect(row.status).toBe('timeout');
      expect(row.disposition).toBe('modelAnswered');
      expect(row.measurementState).toBe('graded');
      expect(row.credit).toBeDefined();
    }
  });

  it('refuses rather than skips a provider with no adapter, and records nothing', async () => {
    const { root, plan, ledger } = campaign();
    await expect(runDevelopmentCampaign({ root, ledger, plan, adapters: {}, now: FIXED_NOW }))
      .rejects.toThrow(DevelopmentCampaignError);
    expect(rowsOnDisk(root)).toHaveLength(0);
    expect(unrunnableAttempts(plan, {})).toEqual(['claudeCLI:model-a needs an adapter for claudeCLI']);
    expect(unrunnableAttempts(plan, { claudeCLI: syntheticAdapter() })).toEqual([]);
  });

  it('keeps grading and terminal status agreeing through the exported helpers', async () => {
    const task = EDIT_TASKS[0];
    const { plan } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    const attempt = plan.attempts.find((entry) => entry.taskID === task.id)!;
    const { repo } = materialsFor(attempt);
    const outcome = await executeDevelopmentAttempt({
      task, repo, binding: plan.candidates[0].binding, adapter: syntheticAdapter(() => ({
        failure: { kind: 'transport', detail: 'gone' },
      })), runID: attempt.runID, slotKey: attempt.slotKey, sleep: async () => undefined,
    });
    const graded = gradeDevelopmentAttempt({
      task, repo, outcome, provenance: {} as Parameters<typeof gradeDevelopmentAttempt>[0]['provenance'],
    });
    expect(graded.state).toBe('notMeasured');
    expect(graded.result).toBeUndefined();
    expect(developmentTerminalStatus(graded, outcome)).toBe(NON_ANSWER_TERMINAL_STATUS);
  });
});

// MARK: - Resume

describe('an interrupted campaign resumes onto the same slots, and never runs one twice', () => {
  it('runs exactly what was left, and every slot ends with exactly one row', async () => {
    const { root, plan, ledger } = campaign({ repeats: 2 });
    const firstAdapter = syntheticAdapter();
    const stopAfter = 3;
    const first = await run(root, ledger, plan, firstAdapter, {
      shouldCancel: () => firstAdapter.calls.length >= stopAfter,
    });
    expect(first.cancelled).toBe(true);
    expect(first.attempted).toBe(stopAfter);
    expect(rowsOnDisk(root)).toHaveLength(stopAfter);

    // A new process: nothing carried over except what is on disk.
    const reopened = openDevelopmentCampaign(root, CLOCK);
    expect(reopened.plan.planDigest).toBe(plan.planDigest);
    const secondAdapter = syntheticAdapter();
    const second = await run(root, reopened.ledger, reopened.plan, secondAdapter);
    expect(second.alreadyTerminal).toBe(stopAfter);
    expect(second.attempted).toBe(plan.attempts.length - stopAfter);
    expect(firstAdapter.calls.length + secondAdapter.calls.length).toBe(plan.attempts.length);

    const rows = rowsOnDisk(root);
    expect(rows).toHaveLength(plan.attempts.length);
    expect(new Set(rows.map((row) => row.slotKey)).size).toBe(plan.attempts.length);
    // The run ids are the plan's, so a resumed row is indistinguishable in identity from one that
    // ran uninterrupted.
    const byKey = new Map(plan.attempts.map((attempt) => [attempt.slotKey, attempt.runID]));
    for (const row of rows) expect(row.runID).toBe(byKey.get(row.slotKey as string));

    const reconciliation = Ledger.open(root, CLOCK).reconcile();
    expect(reconciliation.complete).toBe(true);
    expect(reconciliation.balances).toBe(true);
    expect(reconciliation.duplicateTerminalResults).toBe(0);
  });

  it('runs nothing when called again on a finished campaign', async () => {
    const { root, plan, ledger } = campaign();
    await run(root, ledger, plan, syntheticAdapter());
    const again = syntheticAdapter();
    const reopened = openDevelopmentCampaign(root, CLOCK);
    const progress = await run(root, reopened.ledger, reopened.plan, again);
    expect(progress.attempted).toBe(0);
    expect(again.calls).toEqual([]);
    expect(rowsOnDisk(root)).toHaveLength(plan.attempts.length);
  });

  it('re-runs an attempt whose row was torn by the interruption, rather than guessing at it', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    const adapter = syntheticAdapter();
    await run(root, ledger, plan, adapter, { shouldCancel: () => adapter.calls.length >= 1 });
    fs.appendFileSync(path.join(root, 'results.jsonl'), '{"slotKey":"half a ro');

    const reopened = openDevelopmentCampaign(root, CLOCK);
    expect(reopened.ledger.anomalies.map((anomaly) => anomaly.kind)).toContain('repairedTornWrite');
    const resumed = syntheticAdapter();
    await run(root, reopened.ledger, reopened.plan, resumed);
    expect(resumed.calls).toHaveLength(plan.attempts.length - 1);
    expect(rowsOnDisk(root)).toHaveLength(plan.attempts.length);
  });

  it('refuses to record a second terminal result for a finished slot, whoever asks', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter());
    const existing = rowsOnDisk(root)[0];
    expect(() => ledger.appendResult({ ...existing, status: 'pass' } as SlotResult)).toThrow(/already has a terminal result/);
    expect(rowsOnDisk(root)).toHaveLength(plan.attempts.length);
  });

  it('refuses to resume under a plan that is not the one the campaign was created with', () => {
    const { root, plan } = campaign();
    const drifted = { ...plan, planDigest: 'mldplan1:0000000000000000' };
    fs.writeFileSync(path.join(root, DEVELOPMENT_PLAN_FILE), JSON.stringify(drifted));
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/planDrift|created under plan/);
  });

  it('refuses to resume where there is no campaign, or no plan file beside the ledger', () => {
    expect(() => openDevelopmentCampaign(freshRoot(), CLOCK)).toThrow(/no campaign here to resume/);
    const { root } = campaign();
    fs.rmSync(path.join(root, DEVELOPMENT_PLAN_FILE));
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/holds no development-plan\.json/);
  });

  it('refuses to open a text campaign as a development one', () => {
    const root = freshRoot();
    const plan = buildDevelopmentPlan(planRequest());
    Ledger.create(root, plan.plannableCatalog, [{ name: 'claudeCLI:model-a', modelID: 'model-a' }], {}, CLOCK);
    fs.writeFileSync(path.join(root, DEVELOPMENT_PLAN_FILE), JSON.stringify(plan));
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/not a development campaign/);
  });

  it('refuses to create a campaign over one that already exists', () => {
    const { root, plan } = campaign();
    expect(() => createDevelopmentCampaign(root, plan, CLOCK)).toThrow(/already exists/);
  });
});

// MARK: - Retries and repeats

describe('retries belong to the logical attempt that made them; repeats are separate attempts', () => {
  it('records a retried attempt once, on its own slot, with the retry history on the row', async () => {
    const { root, plan, ledger } = campaign({
      suiteIDs: [MULTI_FILE_EDIT_SUITE_ID],
      candidates: [{
        name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a',
        retry: { ...DEFAULT_RETRY, maxRetries: 2, backoffMilliseconds: 0 },
      }],
    });
    const perTask = new Map<string, number>();
    const adapter = syntheticAdapter((request, task) => {
      const seen = (perTask.get(task.id) ?? 0) + 1;
      perTask.set(task.id, seen);
      if (seen === 1) return { failure: { kind: 'transport', detail: 'the socket closed' }, answerText: '' };
      return SOLVES(request, task, seen);
    });
    await run(root, ledger, plan, adapter);

    const rows = rowsOnDisk(root);
    expect(rows).toHaveLength(plan.attempts.length);
    expect(adapter.calls).toHaveLength(plan.attempts.length * 2);
    for (const row of rows) {
      expect(row.retryCount).toBe(1);
      expect(row.retryDetail).toMatch(/retried 1 time/);
      expect(row.disposition).toBe('modelAnswered');
      expect(row.measurementState).toBe('graded');
      expect(row.structuralCredit).toBe('full');
    }
  });

  it('gives each repeat its own slot, its own run id and its own row', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID], repeats: 3 });
    await run(root, ledger, plan, syntheticAdapter());
    const rows = rowsOnDisk(root);
    for (const task of EDIT_TASKS) {
      const repeats = rows.filter((row) => row.taskID === task.id);
      expect(repeats.map((row) => row.repeat).sort()).toEqual([1, 2, 3]);
      expect(new Set(repeats.map((row) => row.runID)).size).toBe(3);
      expect(new Set(repeats.map((row) => row.slotKey)).size).toBe(3);
      for (const row of repeats) expect(row.slotKey).toBe(`claudeCLI:model-a|${MULTI_FILE_EDIT_SUITE_ID}|${row.repeat}|${task.id}`);
    }
  });
});

// MARK: - What a durable row carries

describe('every durable row carries what a reader needs without the plan beside it', () => {
  it('names the provider, the configuration, identity, machine, commit, task, repeat, telemetry, grade, disposition, cost and provenance', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter());
    const row = rowFor(rowsOnDisk(root), EDIT_TASKS[0].id);

    expect(row).toMatchObject({
      campaignKind: 'development',
      provider: 'claudeCLI',
      modelID: 'model-a',
      executionClass: 'subscriptionCLI',
      billingBasis: 'subscriptionIncluded',
      effort: 'high',
      thinkingMode: 'runtimeDefault',
      identityState: 'unverifiable',
      verifiedModelID: '',
      machineIdentifier: 'test-machine',
      platform: 'darwin-arm64',
      benchmarkVersion: '0.2.4',
      benchmarkCommit: COMMIT,
      suiteID: MULTI_FILE_EDIT_SUITE_ID,
      taskID: EDIT_TASKS[0].id,
      repeat: 1,
      disposition: 'modelAnswered',
      measurementState: 'graded',
      costEligibility: 'subscription_included',
      costEligibilityAuthorized: true,
      contractID: plan.contractID,
      contractDigest: plan.contractDigest,
      executedAt: '2026-09-21T12:00:00Z',
      fixtureRepoDigest: EDIT_TASKS[0].fixtureRepoDigest,
    });
    expect(row.suiteDigest).toMatch(/\S/);
    expect(row.taskDigest).toMatch(/^mldt1:/);
    expect(row.comparabilityKey).toMatch(/^mldk1:/);
    expect(row.runID).toMatch(/^mldrun1:/);
    const telemetry = row.telemetry as Record<string, unknown>;
    expect(telemetry.requestedModelID).toBe('model-a');
    expect(telemetry.inputTokens).toBe(100);
    expect(telemetry.visibleOutputTokens).toBe(20);
    expect(telemetry.costMicroUSD).toBe(0);
    expect(typeof row.totalElapsedMilliseconds).toBe('number');
    expect(row.credit).toBeDefined();
  });

  it('keeps an unverifiable candidate unverifiable, and never copies the request into what answered', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter());
    for (const row of rowsOnDisk(root)) {
      expect(row.identityState).toBe('unverifiable');
      expect(row.verifiedModelID).toBe('');
      expect(row.reportedModelID).toBe('');
      expect(String(row.identityEvidence)).toMatch(/unverifiable/);
    }
  });

  it('records a verified candidate as verified, and what the provider said answered each attempt', async () => {
    const { root, plan, ledger } = campaign({
      suiteIDs: [MULTI_FILE_EDIT_SUITE_ID],
      candidates: [{
        name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', verifiedModelID: 'model-a-2026',
        retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
      }],
    });
    await run(root, ledger, plan, syntheticAdapter((request, task, call) => ({
      ...(SOLVES(request, task, call) ?? {}), reportedModelID: 'model-a-2026',
    })));
    for (const row of rowsOnDisk(root)) {
      expect(row.identityState).toBe('verified');
      expect(row.verifiedModelID).toBe('model-a-2026');
      expect(row.reportedModelID).toBe('model-a-2026');
    }
  });

  it('scrubs a credential a provider echoed into its failure before it reaches disk', async () => {
    const secret = 'sk-ant-api03-' + 'x'.repeat(40);
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter(() => ({
      failure: { kind: 'notAuthenticated', detail: `bad key ${secret}` }, answerText: '',
    })));
    const onDisk = fs.readFileSync(path.join(root, 'results.jsonl'), 'utf8');
    expect(onDisk).not.toContain(secret);
    for (const file of fs.readdirSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY))) {
      expect(fs.readFileSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY, file), 'utf8')).not.toContain(secret);
    }
  });

  it('keeps one debugging artefact per attempt, naming a temp workspace that no longer exists', async () => {
    const { root, plan, ledger } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    await run(root, ledger, plan, syntheticAdapter());
    const files = fs.readdirSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY));
    expect(files).toHaveLength(plan.attempts.length);
    for (const file of files) {
      const artefact = JSON.parse(fs.readFileSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY, file), 'utf8'));
      expect(fs.realpathSync(path.dirname(artefact.workspaceRoot))).toBe(fs.realpathSync(os.tmpdir()));
      expect(fs.existsSync(artefact.workspaceRoot)).toBe(false);
    }
  });

  it('builds the row the runner writes from the exported helper, with nothing added but ledger stamps', async () => {
    const task = EDIT_TASKS[0];
    const { plan } = campaign({ suiteIDs: [MULTI_FILE_EDIT_SUITE_ID] });
    const attempt = plan.attempts.find((entry) => entry.taskID === task.id)!;
    const { repo } = materialsFor(attempt);
    const outcome = await executeDevelopmentAttempt({
      task, repo, binding: plan.candidates[0].binding, adapter: syntheticAdapter(),
      runID: attempt.runID, slotKey: attempt.slotKey, sleep: async () => undefined,
    });
    const graded = gradeDevelopmentAttempt({
      task, repo, outcome, provenance: {
        benchmarkVersion: plan.benchmarkVersion, benchmarkCommit: plan.benchmarkCommit,
        machineIdentifier: plan.machineIdentifier, platform: plan.platform,
        suiteID: attempt.suiteID, suiteVersion: attempt.suiteVersion, suiteDigest: attempt.suiteDigest,
        taskID: attempt.taskID, taskDigest: attempt.taskDigest, comparabilityKey: attempt.comparabilityKey,
        fixtureRepoID: attempt.fixtureRepoID, fixtureRepoVersion: attempt.fixtureRepoVersion,
        fixtureRepoDigest: attempt.fixtureRepoDigest, contractID: plan.contractID,
        contractVersion: plan.contractVersion, contractDigest: plan.contractDigest, executedAt: CLOCK(),
      },
    });
    const status = developmentTerminalStatus(graded, outcome);
    const row = developmentResultRow({ attempt, plan, outcome, graded, status });

    const root = freshRoot();
    const ledger = createDevelopmentCampaign(root, plan, CLOCK);
    ledger.appendResult(row as SlotResult);
    const [written] = rowsOnDisk(root);
    const { seq, recordedAt, ...rest } = written;
    expect(seq).toBe(0);
    expect(recordedAt).toBe(CLOCK());
    // Only the per-workspace facts differ between two executions of the same bytes.
    expect(rest.credit).toBe(row.credit);
    expect(rest.resultSnapshotDigest).toBe(row.resultSnapshotDigest);
    expect(rest.slotKey).toBe(attempt.slotKey);
  });
});

// MARK: - Evidence, not promotion

describe('development evidence does not promote or route anything by itself', () => {
  it('writes only inside the campaign directory', async () => {
    const { root, plan, ledger } = campaign();
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    await run(root, ledger, plan, syntheticAdapter());
    expect(fs.readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
    expect(fs.readdirSync(root).sort()).toEqual([
      'aborts', 'checkpoint.json', DEVELOPMENT_ARTEFACTS_DIRECTORY, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY, DEVELOPMENT_PLAN_FILE,
      'events.jsonl', 'meta.json', 'plan.json', 'results.jsonl',
    ].sort());
  });

  it('puts no approval, route or promotion on a row, however well the attempt did', async () => {
    const { root, plan, ledger } = campaign();
    await run(root, ledger, plan, syntheticAdapter());
    for (const row of rowsOnDisk(root)) {
      for (const key of Object.keys(row)) expect(key).not.toMatch(/approv|promot|route|routing|qualif|eligibleFor/i);
    }
  });

  it('leaves every candidate NOT MEASURED in the ranking until evidence is derived and handed to it', async () => {
    const { root, plan, ledger } = campaign();
    await run(root, ledger, plan, syntheticAdapter());
    const ranked = rankCandidates({
      outcomes: [{ candidate: 'claudeCLI:model-a', caseID: 'case:x', dimension: 'conversation', status: 'pass', governanceViolated: false }],
      derivedAt: '2026-09-21T12:00:00Z',
      developmentPlan: EMPTY_DEVELOPMENT_PLAN,
    });
    const row = ranked.rankings[0];
    expect(row.development.evidence.dimensions.every((entry) => entry.state === 'notMeasured')).toBe(true);
    expect(row.development.roles.every((role) => !role.qualified)).toBe(true);
    expect(row.development.eligibility.verdict).toBe('notMeasured');
  });

  it('leaves a candidate whose every attempt went unanswered with no graded result at all', async () => {
    const { root, plan, ledger } = campaign();
    await run(root, ledger, plan, syntheticAdapter(() => ({
      failure: { kind: 'rateLimited', detail: 'usage limit reached' }, answerText: '',
    })));
    const rows = rowsOnDisk(root);
    expect(rows).toHaveLength(plan.attempts.length);
    expect(rows.filter((row) => row.measurementState === 'graded')).toEqual([]);
  });
});
