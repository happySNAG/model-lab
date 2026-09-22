// Cernum development runner · the prompt contract, and the version that pins a campaign to it.
//
// `development-prompt-1` asked a READ-ONLY repository-understanding attempt to write its answer to
// `cernum-answer.json` and also print it. The workspace gives such an attempt no tool that can write,
// so a candidate that tried was refused, and its natural reply — the object, then a sentence saying
// the file could not be written — is not a JSON document. `dev-cohort-1` ran under that prompt.
//
// This file pins the correction and the rule that keeps the two apart: a read-only prompt never asks
// for a file, the answer is the reply and nothing else, the edit prompts did not move, and a campaign
// created under one prompt version is never continued under another.
//
// Every attempt here is answered by a synthetic adapter. No provider is contacted and nothing is spent.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_PLAN_FILE, DevelopmentCampaignError, createDevelopmentCampaign, openDevelopmentCampaign,
  promptVersionRefusal, recordedPromptVersion, runDevelopmentCampaign,
} from '../../src/engine/development-campaign';
import {
  DEVELOPMENT_PROMPT_VERSION, LEGACY_DEVELOPMENT_PROMPT_VERSION, developmentPromptFor,
} from '../../src/engine/development-execution';
import { DevelopmentCampaignPlan, DevelopmentPlanRequest, buildDevelopmentPlan, describeDevelopmentPlan } from '../../src/engine/development-plan';
import { buildDevelopmentCampaignReport, readDevelopmentCampaignState } from '../../src/engine/development-report';
import { FrontierAdapter, FrontierRequest, FrontierResponse } from '../../src/engine/frontier-adapter';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask, developmentTaskDigest } from '../../src/core/development-benchmark';
import { developmentSuites, developmentTaskByID } from '../../src/core/development-catalog';
import { gradeRepositoryQuestion } from '../../src/core/development-evaluation';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { CORRECT_ANSWERS } from './fixtures/ledgerlite-solutions';

const ALL_TASKS: DevelopmentTask[] = developmentSuites.flatMap((suite) => suite.tasks);
const QUESTION_TASKS = ALL_TASKS.filter((task) => task.kind === 'repositoryQuestion');
const EDIT_TASKS = ALL_TASKS.filter((task) => task.kind === 'repositoryEdit');
const ABSENT_FEATURE = 'task.dev.repo-understanding.absent-feature';

/** Exactly what `development-prompt-1` put in front of an edit task. Edit prompts must not have moved. */
const LEGACY_EDIT_PREAMBLE = 'The repository is the current working directory. Make the change in place, editing the files '
  + 'that genuinely need to change and no others.\n\n';

/** The digests `dev-cohort-1` recorded. The fix changed the wrapper, never the question. */
const DEV_COHORT_1_TASK_DIGESTS: Record<string, string> = {
  'task.dev.multi-file-edit.add-region-surcharge': 'mldt1:8de1945392a2b6fa',
  'task.dev.multi-file-edit.fix-negative-rounding': 'mldt1:7a4f26cf98792f69',
  'task.dev.multi-file-edit.honour-rounding-mode': 'mldt1:26a28ad351f4aa53',
  'task.dev.repo-understanding.absent-feature': 'mldt1:d1391e9e70928191',
  'task.dev.repo-understanding.explain-bug': 'mldt1:bf9bba42885e38ff',
  'task.dev.repo-understanding.impact-set': 'mldt1:a129f4ead3570d91',
  'task.dev.repo-understanding.locate-implementation': 'mldt1:ec3076f92b83d3ca',
  'task.dev.repo-understanding.relevant-tests': 'mldt1:f540f806c798ffa5',
  'task.dev.repo-understanding.source-of-truth': 'mldt1:cda94413a722f0af',
  'task.dev.repo-understanding.trace-flow': 'mldt1:4ab556b86b75f1ae',
};

/** The sentences of a prompt, so an instruction can be told apart from a prohibition. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?:])\s+|\n+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** A sentence that asks for a file to be written, saved or created — and is not forbidding it. */
function asksToWriteAFile(sentence: string): boolean {
  const mentionsWriting = /\b(write|writes|writing|save|saving|create|creating|output)\b/i.test(sentence)
    && /\bfile\b/i.test(sentence);
  const forbids = /\b(do not|don't|never|no)\b/i.test(sentence);
  return mentionsWriting && !forbids;
}

// MARK: - The prompt

describe('a read-only repository-understanding prompt', () => {
  it('REGRESSION: never asks the model to write a file — the instruction that made dev-cohort-1 unparseable', () => {
    expect(QUESTION_TASKS.length).toBeGreaterThan(0);
    for (const task of QUESTION_TASKS) {
      const prompt = developmentPromptFor(task);
      const whole = `${prompt.system}\n${prompt.user}`;
      expect(whole, task.id).not.toContain(DEVELOPMENT_ANSWER_PATH);
      for (const sentence of sentences(whole)) {
        expect(asksToWriteAFile(sentence), `${task.id}: "${sentence}"`).toBe(false);
      }
    }
  });

  it('the regression check would have caught development-prompt-1', () => {
    const legacy = `Write your answer as a single JSON object to the file ${DEVELOPMENT_ANSWER_PATH} in the `
      + 'working directory root, and also print it as your reply.';
    expect(sentences(legacy).some(asksToWriteAFile)).toBe(true);
  });

  it('asks for ONLY the JSON object, on stdout, with no prose before or after it', () => {
    for (const task of QUESTION_TASKS) {
      const user = developmentPromptFor(task).user;
      expect(user, task.id).toContain('ONLY the required JSON object, printed to stdout');
      expect(user, task.id).toMatch(/No prose, explanation, heading or code fence before it or after it/);
      expect(user, task.id).toContain('Do not modify it, and do not create or write any file');
    }
  });

  it('leaves the question, the required shape and the system prompt exactly as the task states them', () => {
    for (const task of QUESTION_TASKS) {
      const prompt = developmentPromptFor(task);
      expect(prompt.system, task.id).toBe(task.prompt.system);
      expect(prompt.user.endsWith(task.prompt.user), task.id).toBe(true);
    }
  });

  it('did not change any task: every task digest is the one dev-cohort-1 recorded', () => {
    expect(Object.keys(DEV_COHORT_1_TASK_DIGESTS).sort()).toEqual(ALL_TASKS.map((task) => task.id).sort());
    for (const task of ALL_TASKS) expect(developmentTaskDigest(task), task.id).toBe(DEV_COHORT_1_TASK_DIGESTS[task.id]);
  });
});

describe('a multi-file-edit prompt', () => {
  it('is byte-for-byte what it was under development-prompt-1, file writes still intended', () => {
    expect(EDIT_TASKS.length).toBeGreaterThan(0);
    for (const task of EDIT_TASKS) {
      expect(developmentPromptFor(task)).toEqual({ system: task.prompt.system, user: LEGACY_EDIT_PREAMBLE + task.prompt.user });
    }
  });
});

// MARK: - Grading what the reply held

describe('grading a JSON-only reply', () => {
  const identity = { taskDigest: 'mldt1:test', comparabilityKey: 'test' };

  it('parses a reply that is exactly the object, strictly, and gives it full credit', () => {
    for (const task of QUESTION_TASKS) {
      const result = gradeRepositoryQuestion(task, ledgerlite, JSON.stringify(CORRECT_ANSWERS[task.id]), identity);
      expect(result.answer!.strictlyParsed, task.id).toBe(true);
      expect(result.grade.credit, task.id).toBe('full');
    }
  });

  it('rejects the correct object followed by explanatory prose as non-conforming output', () => {
    // The exact reply dev-cohort-1 recorded for this task under the defective prompt.
    const recorded = '{"present": false, "files": []}\n\nI couldn\'t write `cernum-answer.json` because I only have '
      + 'read-only tools here, so that file doesn\'t exist. The repository doesn\'t convert money between currencies.';
    const result = gradeRepositoryQuestion(developmentTaskByID(ABSENT_FEATURE)!, ledgerlite, recorded, identity);
    expect(result.answer!.strictlyParsed).toBe(false);
    expect(result.answer!.semanticallyParsed).toBe(false);
    expect(result.grade.credit).not.toBe('full');
  });

  it('grades the absent-feature answer {"present": false, "files": []} correctly when it is returned alone', () => {
    const result = gradeRepositoryQuestion(developmentTaskByID(ABSENT_FEATURE)!, ledgerlite,
      '{"present": false, "files": []}', identity);
    expect(result.answer!.strictlyParsed).toBe(true);
    expect(result.grade.credit).toBe('full');
    expect(result.outcomes.every((outcome) => outcome.held)).toBe(true);
  });
});

// MARK: - The version, the plan and resume

const MACHINE = { machineIdentifier: 'test-machine', platform: 'darwin-arm64' };
const FIXED_NOW = () => new Date('2026-09-21T12:00:00Z');
const CLOCK = () => '2026-09-21T12:00:00Z';

function planRequest(overrides: Partial<DevelopmentPlanRequest> = {}): DevelopmentPlanRequest {
  return {
    label: 'prompt-version',
    repeats: 1,
    candidates: [{
      name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', effort: 'high',
      retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    }],
    benchmarkVersion: '0.2.4',
    createdAt: '2026-09-21T00:00:00Z',
    machine: MACHINE,
    benchmarkCommit: 'c'.repeat(40),
    workingTreeDirty: false,
    suiteIDs: ['suite.cernum.development.repo-understanding'],
    ...overrides,
  };
}

/** Answers a question with the correct object as its reply, and writes nothing. */
function jsonOnlyAdapter(): FrontierAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    provider: 'claudeCLI',
    calls,
    async complete(request: FrontierRequest): Promise<FrontierResponse> {
      const task = QUESTION_TASKS.find((entry) => request.promptText.includes(entry.prompt.user))!;
      calls.push(task.id);
      return {
        answerText: JSON.stringify(CORRECT_ANSWERS[task.id]), reportedModelID: '',
        usage: { inputTokens: 100, visibleOutputTokens: 20 }, usageProvenance: 'providerReported',
        totalElapsedMilliseconds: 7, retryCount: 0, wastedTokens: 0,
      };
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-prompt-version-test-'));
  roots.push(root);
  return path.join(root, 'campaign');
}

function run(root: string, plan: DevelopmentCampaignPlan, adapter: FrontierAdapter, stopAfter = Infinity,
             currentPromptVersion?: string) {
  const { ledger } = openDevelopmentCampaign(root, CLOCK, currentPromptVersion ?? plan.promptVersion);
  let finished = 0;
  return runDevelopmentCampaign({
    root, ledger, plan, adapters: { claudeCLI: adapter }, now: FIXED_NOW, sleep: async () => undefined,
    shouldCancel: () => finished >= stopAfter,
    onProgress: (event) => { if (event.kind === 'finished') finished += 1; },
    currentPromptVersion,
  });
}

/** The bytes of every file a campaign holds, so "untouched" is a comparison rather than a claim. */
function contentsOf(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else out.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

describe('the prompt version on a development plan', () => {
  it('is stamped on every plan, as the version this build sends, and printed by the dry run', () => {
    const plan = buildDevelopmentPlan(planRequest());
    expect(plan.promptVersion).toBe(DEVELOPMENT_PROMPT_VERSION);
    expect(DEVELOPMENT_PROMPT_VERSION).not.toBe(LEGACY_DEVELOPMENT_PROMPT_VERSION);
    expect(describeDevelopmentPlan(plan)).toContain(`  prompt            ${DEVELOPMENT_PROMPT_VERSION}`);
  });

  it('changes the plan digest and every run id when the prompt version changes, and nothing else does', () => {
    const current = buildDevelopmentPlan(planRequest());
    const legacy = buildDevelopmentPlan(planRequest({ promptVersion: LEGACY_DEVELOPMENT_PROMPT_VERSION }));
    expect(legacy.planDigest).not.toBe(current.planDigest);
    expect(legacy.attempts.map((attempt) => attempt.slotKey)).toEqual(current.attempts.map((attempt) => attempt.slotKey));
    for (const [index, attempt] of legacy.attempts.entries()) {
      expect(attempt.runID).not.toBe(current.attempts[index].runID);
      expect(attempt.taskDigest).toBe(current.attempts[index].taskDigest);
    }
    // Deterministic: the same version is the same identity.
    expect(buildDevelopmentPlan(planRequest()).planDigest).toBe(current.planDigest);
  });

  it('records the version in the ledger meta and on every result row', async () => {
    const root = freshRoot();
    const plan = buildDevelopmentPlan(planRequest());
    createDevelopmentCampaign(root, plan, CLOCK);
    await run(root, plan, jsonOnlyAdapter(), 1);
    const state = readDevelopmentCampaignState(root);
    expect(state.meta.promptVersion).toBe(DEVELOPMENT_PROMPT_VERSION);
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].promptVersion).toBe(DEVELOPMENT_PROMPT_VERSION);
    const report = buildDevelopmentCampaignReport({ plan: state.plan, rows: state.rows, derivedAt: CLOCK(), synthetic: false });
    expect(report.promptVersion).toBe(DEVELOPMENT_PROMPT_VERSION);
  });
});

describe('resuming across a prompt version', () => {
  it('resumes a campaign under the same prompt version, running each remaining attempt exactly once', async () => {
    const root = freshRoot();
    const plan = buildDevelopmentPlan(planRequest());
    createDevelopmentCampaign(root, plan, CLOCK);
    const first = jsonOnlyAdapter();
    const interrupted = await run(root, plan, first, 3);
    expect(interrupted.attempted).toBe(3);
    expect(interrupted.cancelled).toBe(true);

    const second = jsonOnlyAdapter();
    const resumed = await run(root, readDevelopmentCampaignState(root).plan, second);
    expect(resumed.alreadyTerminal).toBe(3);
    expect(resumed.attempted).toBe(plan.attempts.length - 3);
    expect(new Set([...first.calls, ...second.calls]).size).toBe(plan.attempts.length);

    const rows = readDevelopmentCampaignState(root).rows;
    expect(rows.map((row) => row.slotKey).sort()).toEqual(plan.attempts.map((attempt) => attempt.slotKey).sort());
    // JSON-only replies, graded from the reply, all correct.
    for (const row of rows) {
      expect(row.answerSource).toBe('providerReply');
      expect(row.answerStrictlyParsed).toBe(true);
      expect(row.status).toBe('pass');
    }
  });

  it('refuses to resume a campaign created under a different prompt version, on open and on run', async () => {
    const root = freshRoot();
    const plan = buildDevelopmentPlan(planRequest({ promptVersion: LEGACY_DEVELOPMENT_PROMPT_VERSION }));
    const ledger = createDevelopmentCampaign(root, plan, CLOCK);

    expect(promptVersionRefusal(plan)).toMatch(/created under prompt contract development-prompt-1.*sends development-prompt-2/);
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(DevelopmentCampaignError);
    try {
      openDevelopmentCampaign(root, CLOCK);
    } catch (error) {
      expect((error as DevelopmentCampaignError).code).toBe('promptVersionDrift');
    }
    const adapter = jsonOnlyAdapter();
    await expect(runDevelopmentCampaign({
      root, ledger, plan, adapters: { claudeCLI: adapter }, now: FIXED_NOW, sleep: async () => undefined,
    })).rejects.toThrow(/prompt contract/);
    expect(adapter.calls).toEqual([]);
  });

  it('treats a plan recorded before the field existed as development-prompt-1, and refuses it', () => {
    const root = freshRoot();
    const plan = buildDevelopmentPlan(planRequest({ promptVersion: LEGACY_DEVELOPMENT_PROMPT_VERSION }));
    createDevelopmentCampaign(root, plan, CLOCK);
    // Rewrite the plan file as a pre-version runner wrote it: no promptVersion key at all.
    const { promptVersion: _dropped, ...withoutVersion } = plan;
    fs.writeFileSync(path.join(root, DEVELOPMENT_PLAN_FILE), JSON.stringify(withoutVersion));

    const recorded = readDevelopmentCampaignState(root).plan;
    expect('promptVersion' in recorded).toBe(false);
    expect(recordedPromptVersion(recorded)).toBe(LEGACY_DEVELOPMENT_PROMPT_VERSION);
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/development-prompt-1/);
  });

  it('leaves every completed historical row, the plan and the meta byte-for-byte untouched', async () => {
    const root = freshRoot();
    // An older campaign, run partway under the old prompt by the build that sent it.
    const plan = buildDevelopmentPlan(planRequest({ promptVersion: LEGACY_DEVELOPMENT_PROMPT_VERSION }));
    createDevelopmentCampaign(root, plan, CLOCK);
    await run(root, plan, jsonOnlyAdapter(), 2, LEGACY_DEVELOPMENT_PROMPT_VERSION);
    const before = contentsOf(root);
    expect(readDevelopmentCampaignState(root).rows.length).toBe(2);

    // This build refuses it, every way it can be reached.
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/prompt contract/);
    const ledger = openDevelopmentCampaign(root, CLOCK, LEGACY_DEVELOPMENT_PROMPT_VERSION).ledger;
    const reopenedBytes = contentsOf(root);
    await expect(runDevelopmentCampaign({
      root, ledger, plan, adapters: { claudeCLI: jsonOnlyAdapter() }, now: FIXED_NOW, sleep: async () => undefined,
    })).rejects.toThrow(/prompt contract/);

    const after = contentsOf(root);
    // Opening a ledger only reads it; the refused run wrote nothing at all.
    expect(reopenedBytes).toEqual(before);
    expect(after).toEqual(before);
    const rows = readDevelopmentCampaignState(root).rows;
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.promptVersion).toBe(LEGACY_DEVELOPMENT_PROMPT_VERSION);
    expect(readDevelopmentCampaignState(root).plan.promptVersion).toBe(LEGACY_DEVELOPMENT_PROMPT_VERSION);
  });
});
