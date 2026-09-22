// Cernum development runner · Pass A — the plan, and what it refuses to plan.
//
// A plan is the artefact a person reads BEFORE deciding to spend anything, so the properties worth
// proving are mostly negative: it contacts nothing, it refuses a candidate the cost policy blocks,
// it will not upgrade an unverifiable identity, and it produces the same identifiers every time so
// an interrupted campaign can be resumed against the same slots rather than beside them.

import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_INPUT_BUDGET_TOKENS, DEVELOPMENT_MAX_OUTPUT_TOKENS, DEVELOPMENT_SCORING_MODE,
  DevelopmentPlanError, buildDevelopmentPlan, describeDevelopmentPlan, developmentRunID,
  plannableDevelopmentCatalog, plannedTaskCountsFor,
} from '../../src/engine/development-plan';
import { developmentSuites, developmentTaskCount } from '../../src/core/development-catalog';
import { DEVELOPMENT_SCORING_CONTRACT_ID, developmentContractDigest } from '../../src/core/development-scoring';
import { REPO_UNDERSTANDING_SUITE_ID } from '../../src/core/development-suites/repo-understanding';
import { MULTI_FILE_EDIT_SUITE_ID } from '../../src/core/development-suites/multi-file-edit';
import { buildPlan } from '../../src/engine/ledger';
import { registeredSuites } from '../../src/core/catalog';

const MACHINE = { machineIdentifier: 'test-machine', platform: 'darwin-arm64' };

function request(overrides: Partial<Parameters<typeof buildDevelopmentPlan>[0]> = {}): Parameters<typeof buildDevelopmentPlan>[0] {
  return {
    label: 'pass-a',
    repeats: 1,
    candidates: [{ name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a' }],
    benchmarkVersion: '0.2.4',
    createdAt: '2026-09-21T00:00:00Z',
    machine: MACHINE,
    benchmarkCommit: 'a'.repeat(40),
    workingTreeDirty: false,
    ...overrides,
  };
}

describe('the development plan', () => {
  it('covers every registered task once per candidate per repeat', () => {
    const plan = buildDevelopmentPlan(request({ repeats: 2 }));
    expect(plan.attempts).toHaveLength(developmentTaskCount() * 2);
    expect(new Set(plan.attempts.map((attempt) => attempt.taskID)).size).toBe(developmentTaskCount());
    expect(plan.attempts.filter((attempt) => attempt.repeat === 1)).toHaveLength(developmentTaskCount());
    expect(plan.attempts.filter((attempt) => attempt.repeat === 2)).toHaveLength(developmentTaskCount());
  });

  it('stamps the benchmark version, the commit, the machine and the contract on the plan', () => {
    const plan = buildDevelopmentPlan(request());
    expect(plan.benchmarkVersion).toBe('0.2.4');
    expect(plan.benchmarkCommit).toBe('a'.repeat(40));
    expect(plan.machineIdentifier).toBe('test-machine');
    expect(plan.platform).toBe('darwin-arm64');
    expect(plan.contractID).toBe(DEVELOPMENT_SCORING_CONTRACT_ID);
    expect(plan.contractDigest).toBe(developmentContractDigest());
    expect(plan.workingTreeDirty).toBe(false);
  });

  it('carries the fixture digest each task was sealed against onto every attempt', () => {
    const plan = buildDevelopmentPlan(request());
    for (const attempt of plan.attempts) {
      expect(attempt.fixtureRepoDigest).toMatch(/^mldr1:/);
      expect(attempt.fixtureRepoID.length).toBeGreaterThan(0);
      expect(attempt.comparabilityKey).toMatch(/^mldk1:/);
      expect(attempt.taskDigest).toMatch(/^mldt1:/);
    }
  });

  it('produces identical run ids and slot keys for an identical request', () => {
    const first = buildDevelopmentPlan(request());
    const second = buildDevelopmentPlan(request());
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.attempts.map((attempt) => attempt.runID)).toEqual(first.attempts.map((attempt) => attempt.runID));
    expect(second.attempts.map((attempt) => attempt.slotKey)).toEqual(first.attempts.map((attempt) => attempt.slotKey));
  });

  it('gives every attempt in a plan a distinct run id', () => {
    const plan = buildDevelopmentPlan(request({ repeats: 3 }));
    expect(new Set(plan.attempts.map((attempt) => attempt.runID)).size).toBe(plan.attempts.length);
    expect(new Set(plan.attempts.map((attempt) => attempt.slotKey)).size).toBe(plan.attempts.length);
  });

  it('changes the run ids when the campaign is a different experiment', () => {
    const base = buildDevelopmentPlan(request());
    const relabelled = buildDevelopmentPlan(request({ label: 'pass-a-again' }));
    expect(relabelled.attempts[0].runID).not.toBe(base.attempts[0].runID);
    expect(developmentRunID('x', base.attempts[0].slotKey, base.attempts[0].comparabilityKey))
      .not.toBe(developmentRunID('y', base.attempts[0].slotKey, base.attempts[0].comparabilityKey));
  });

  it('plans exactly the slots the ledger would plan, from the ledger\'s own planner', () => {
    const plan = buildDevelopmentPlan(request({ repeats: 2 }));
    const slots = buildPlan(plan.plannableCatalog, plan.candidates.map((candidate) => ({
      name: candidate.name, modelID: candidate.binding.requestedModelID,
    })));
    expect(slots.map((slot) => slot.slotKey)).toEqual(plan.attempts.map((attempt) => attempt.slotKey));
    expect(slots.map((slot) => slot.slotIndex)).toEqual(plan.attempts.map((attempt) => attempt.slotIndex));
  });

  it('stamps the development scoring mode and budgets on every plannable case', () => {
    const catalog = plannableDevelopmentCatalog(developmentSuites, 1);
    for (const suite of catalog.suites) {
      for (const entry of suite.cases) {
        expect(entry.scoringMode).toBe(DEVELOPMENT_SCORING_MODE);
        expect(entry.maxOutputTokens).toBe(DEVELOPMENT_MAX_OUTPUT_TOKENS);
        expect(entry.inputBudgetTokens).toBe(DEVELOPMENT_INPUT_BUDGET_TOKENS);
      }
    }
  });

  it('can be narrowed to one suite', () => {
    const plan = buildDevelopmentPlan(request({ suiteIDs: [REPO_UNDERSTANDING_SUITE_ID] }));
    expect(plan.suiteIDs).toEqual([REPO_UNDERSTANDING_SUITE_ID]);
    expect(plan.attempts.every((attempt) => attempt.dimension === 'repositoryUnderstanding')).toBe(true);
    const counts = plannedTaskCountsFor(plan);
    expect(counts.multiFileEditing).toBe(0);
    expect(counts.repositoryUnderstanding).toBeGreaterThan(0);
  });

  it('counts the planned tasks per dimension across the whole registry', () => {
    const counts = plannedTaskCountsFor(buildDevelopmentPlan(request({ repeats: 4 })));
    expect(counts.repositoryUnderstanding + counts.multiFileEditing).toBe(developmentTaskCount());
  });
});

describe('what the plan refuses', () => {
  it('refuses an unregistered suite by name rather than planning an empty campaign', () => {
    expect(() => buildDevelopmentPlan(request({ suiteIDs: ['suite.not.registered'] })))
      .toThrow(/not a registered development suite/);
  });

  it('refuses a text benchmark suite id — the two registries do not join', () => {
    expect(() => buildDevelopmentPlan(request({ suiteIDs: [String(registeredSuites[0].id)] })))
      .toThrow(DevelopmentPlanError);
  });

  it('refuses zero candidates, zero repeats and an unnamed campaign', () => {
    expect(() => buildDevelopmentPlan(request({ candidates: [] }))).toThrow(/zero candidates/);
    expect(() => buildDevelopmentPlan(request({ repeats: 0 }))).toThrow(/at least 1/);
    expect(() => buildDevelopmentPlan(request({ label: '   ' }))).toThrow(/no label/);
  });

  it('refuses two candidates with one name, which would share slots', () => {
    expect(() => buildDevelopmentPlan(request({
      candidates: [
        { name: 'same', provider: 'claudeCLI', modelID: 'a' },
        { name: 'same', provider: 'claudeCLI', modelID: 'b' },
      ],
    }))).toThrow(/appears twice/);
  });
});

describe('the cost policy, enforced at plan time', () => {
  it('refuses a metered candidate that no confirmation names', () => {
    expect(() => buildDevelopmentPlan(request({
      candidates: [{
        name: 'openaiAPI:gpt', provider: 'openaiAPI', modelID: 'gpt',
        pricing: { source: 'published', capturedAt: '2026-09-01', currency: 'USD' as const,
          inputMicroUSDPerMillionTokens: 1, outputMicroUSDPerMillionTokens: 1, reasoningMicroUSDPerMillionTokens: null },
      }],
    }))).toThrow(/authorizes only/);
  });

  it('authorizes a subscription CLI candidate and records why', () => {
    const plan = buildDevelopmentPlan(request());
    expect(plan.candidates[0].costVerdict.eligibility).toBe('subscription_included');
    expect(plan.candidates[0].costVerdict.authorized).toBe(true);
    expect(plan.candidates[0].costVerdict.reason).toMatch(/marginal API charge is \$0/);
  });

  it('admits a metered candidate only on a confirmation naming that exact configuration', () => {
    const confirmation = {
      provider: 'opencodeCLI' as const,
      modelID: 'free-model',
      accountBasis: 'the project account',
      observedBillingRecord: 'the provider dashboard showed $0.00 for these requests',
      observedAt: '2026-09-20',
      confirmedBy: 'the operator',
    };
    // A metered binding still needs a published price, confirmation or not: `free_confirmed` is a
    // fact about an ACCOUNT, and `validateBinding` refuses a metered run nobody can price whatever
    // that account's history says. This plan does not relax that rule.
    const pricing = {
      source: 'the provider\'s published price list', capturedAt: '2026-09-20', currency: 'USD' as const,
      inputMicroUSDPerMillionTokens: 0, outputMicroUSDPerMillionTokens: 0, reasoningMicroUSDPerMillionTokens: null,
    };
    const plan = buildDevelopmentPlan(request({
      candidates: [{ name: 'opencodeCLI:free-model', provider: 'opencodeCLI', modelID: 'free-model', pricing }],
      costConfirmations: [confirmation],
    }));
    expect(plan.candidates[0].costVerdict.eligibility).toBe('free_confirmed');

    expect(() => buildDevelopmentPlan(request({
      candidates: [{ name: 'opencodeCLI:other', provider: 'opencodeCLI', modelID: 'other', pricing }],
      costConfirmations: [confirmation],
    }))).toThrow(/authorizes only/);
  });
});

describe('identity, which the plan never upgrades', () => {
  it('leaves a candidate nothing established as unverifiable, and never copies the request into it', () => {
    const plan = buildDevelopmentPlan(request());
    const binding = plan.candidates[0].binding;
    expect(binding.identityState).toBe('unverifiable');
    expect(binding.verifiedModelID).toBe('');
    expect(binding.identityEvidence).toMatch(/recorded as unverifiable rather than assumed/);
  });

  it('records a verified identity only when the provider named one', () => {
    const plan = buildDevelopmentPlan(request({
      candidates: [{
        name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a',
        verifiedModelID: 'model-a-20260101', identityEvidence: 'identity smoke test',
      }],
    }));
    expect(plan.candidates[0].binding.identityState).toBe('verified');
    expect(plan.candidates[0].binding.verifiedModelID).toBe('model-a-20260101');
  });
});

describe('the dry run', () => {
  it('names every attempt, both suites, the commit and the cost verdict, and says nothing was sent', () => {
    const text = describeDevelopmentPlan(buildDevelopmentPlan(request())).join('\n');
    expect(text).toContain(REPO_UNDERSTANDING_SUITE_ID);
    expect(text).toContain(MULTI_FILE_EDIT_SUITE_ID);
    expect(text).toContain('subscription_included');
    expect(text).toContain('a'.repeat(40));
    expect(text).toContain('NOTHING WAS SENT');
  });

  it('says so when the commit could not be read, rather than printing a blank', () => {
    const text = describeDevelopmentPlan(buildDevelopmentPlan(request({ benchmarkCommit: '' }))).join('\n');
    expect(text).toContain('UNKNOWN commit');
  });

  it('warns when the working tree is dirty, because a commit alone then misdescribes the grade', () => {
    const text = describeDevelopmentPlan(buildDevelopmentPlan(request({ workingTreeDirty: true }))).join('\n');
    expect(text).toContain('WORKING TREE DIRTY');
  });
});
