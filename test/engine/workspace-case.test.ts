// A workspace case is an identity before it is an instruction. These pin what that identity binds,
// and what the validator refuses to let anybody seal.

import { describe, expect, it } from 'vitest';
import {
  WorkspaceCaseError, fileInvariant, makeWorkspaceCase, validateWorkspaceCase, workspaceCaseDigest,
  workspaceComparabilityKey, workspaceCommand, workspaceInstructionText, workspacePlannableCaseOf,
  workspaceScoredCoreEntryOf, workspaceScoringMode,
} from '../../src/engine/workspace-case';
import { BROKEN_SUM_MEAN, validateWorkspaceCatalog, workspaceFoundationSuite } from '../../src/engine/workspace-catalog';
import { buildPlan } from '../../src/engine/ledger';
import { freezeManifest } from '../../src/engine/manifest';
import { workspacePromptRecordOf } from '../../src/engine/workspace-case';

function minimalCase(overrides: Parameters<typeof makeWorkspaceCase>[0] extends never ? never : Partial<Parameters<typeof makeWorkspaceCase>[0]> = {}) {
  return makeWorkspaceCase({
    id: 'ws.example',
    version: '1',
    suiteID: 'suite.example',
    suiteVersion: '1',
    source: { fixturePath: 'workspace/example' },
    task: { instruction: 'Fix the failing test.', scope: { allowed: ['src/**'], forbidden: ['test/**'] } },
    verification: {
      commands: [workspaceCommand({ id: 'tests', kind: 'test', executable: 'node', args: ['test/run.js'] })],
      forbiddenChanges: ['test/**'],
    },
    ...overrides,
  });
}

describe('the sealed catalogue', () => {
  it('validates', () => {
    expect(() => validateWorkspaceCatalog()).not.toThrow();
  });

  it('seals the fixture it was authored against', () => {
    expect(BROKEN_SUM_MEAN.source.sealed).toBe(true);
    expect(BROKEN_SUM_MEAN.source.expectedTreeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names the same forbidden paths in the scope and in the verification', () => {
    expect(BROKEN_SUM_MEAN.verification.forbiddenChanges).toEqual(['test/**']);
    expect(BROKEN_SUM_MEAN.task.scope.forbidden).toEqual(['test/**']);
  });
});

describe('identity', () => {
  it('moves the case digest when the instruction changes', () => {
    const before = workspaceCaseDigest(minimalCase());
    const after = workspaceCaseDigest(minimalCase({ task: { instruction: 'Fix the failing test, carefully.', scope: { allowed: ['src/**'], forbidden: ['test/**'] } } }));
    expect(after).not.toBe(before);
    expect(before.startsWith('cwc1:')).toBe(true);
  });

  it('is stable across two constructions of the same case', () => {
    expect(workspaceCaseDigest(minimalCase())).toBe(workspaceCaseDigest(minimalCase()));
  });

  it('normalizes so that declaration order cannot change the identity', () => {
    const one = minimalCase({ tags: ['b', 'a'], task: { instruction: 'Fix the failing test.', scope: { allowed: ['src/**'], forbidden: ['test/**'] } } });
    const two = minimalCase({ tags: ['a', 'b'], task: { instruction: 'Fix the failing test.', scope: { forbidden: ['test/**'], allowed: ['src/**'] } } });
    expect(workspaceCaseDigest(one)).toBe(workspaceCaseDigest(two));
  });

  it('binds the FIXTURE into comparability, which the prose key has no reason to', () => {
    const sealedOne = minimalCase({ source: { fixturePath: 'workspace/example', expectedTreeDigest: 'a'.repeat(64) } });
    const sealedTwo = minimalCase({ source: { fixturePath: 'workspace/example', expectedTreeDigest: 'b'.repeat(64) } });
    expect(workspaceComparabilityKey(sealedOne)).not.toBe(workspaceComparabilityKey(sealedTwo));
  });

  it('binds the tool policy: a pass with a shell is not a pass without one', () => {
    const withShell = minimalCase({ execution: { tools: { commandExecution: true } } });
    const withoutShell = minimalCase({ execution: { tools: { commandExecution: false } } });
    expect(workspaceComparabilityKey(withShell)).not.toBe(workspaceComparabilityKey(withoutShell));
  });

  it('binds the verification commands', () => {
    const strict = minimalCase({
      verification: {
        commands: [workspaceCommand({ id: 'tests', kind: 'test', executable: 'node', args: ['test/run.js'] }),
          workspaceCommand({ id: 'types', kind: 'typecheck', executable: 'tsc', args: ['--noEmit'] })],
        forbiddenChanges: ['test/**'],
      },
    });
    expect(workspaceComparabilityKey(strict)).not.toBe(workspaceComparabilityKey(minimalCase()));
  });
});

describe('the instruction the model actually receives', () => {
  it('is composed once, here, and carries the scope it will be judged against', () => {
    const text = workspaceInstructionText(BROKEN_SUM_MEAN);
    expect(text).toContain('You may change only these paths: src/**.');
    expect(text).toContain('You must not change these paths: test/**.');
    expect(text).toContain('node test/stats.test.js');
  });

  it('is what the manifest freezes as the prompt', () => {
    expect(workspacePromptRecordOf(BROKEN_SUM_MEAN).text).toBe(workspaceInstructionText(BROKEN_SUM_MEAN));
  });
});

describe('validation refuses, rather than warns', () => {
  const refuses = (code: string, build: () => unknown) => {
    it(`refuses ${code}`, () => {
      try {
        const built = build() as Parameters<typeof validateWorkspaceCase>[0];
        validateWorkspaceCase(built);
        throw new Error(`expected ${code} to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCaseError);
        expect((error as WorkspaceCaseError).code).toBe(code);
      }
    });
  };

  refuses('emptyInstruction', () => minimalCase({ task: { instruction: '   ' } }));
  refuses('nonPositiveAttempts', () => minimalCase({ execution: { maximumAttempts: 0 } }));
  refuses('nothingVerified', () => minimalCase({ verification: {} }));
  refuses('sealedWithoutDigest', () => minimalCase({ source: { fixturePath: 'workspace/example', sealed: true } }));
  refuses('unsafeCaseID', () => minimalCase({ id: 'WS Example' }));
  refuses('duplicateCommandID', () => minimalCase({
    verification: {
      commands: [workspaceCommand({ id: 'tests', kind: 'test', executable: 'node' }),
        workspaceCommand({ id: 'tests', kind: 'build', executable: 'make' })],
      forbiddenChanges: ['test/**'],
    },
  }));
  refuses('hiddenCommandMislabelled', () => minimalCase({
    verification: {
      commands: [workspaceCommand({ id: 'tests', kind: 'test', executable: 'node' })],
      hiddenCommands: [workspaceCommand({ id: 'extra', kind: 'test', executable: 'node' })],
      forbiddenChanges: ['test/**'],
    },
  }));

  it('refuses a verification forbid-list the task scope does not also name', () => {
    const drifted = makeWorkspaceCase({
      id: 'ws.drift', version: '1', suiteID: 'suite.example', suiteVersion: '1',
      source: { fixturePath: 'workspace/example' },
      task: { instruction: 'Fix it.', scope: { allowed: ['src/**'] } },
      verification: {
        commands: [workspaceCommand({ id: 'tests', kind: 'test', executable: 'node' })],
        forbiddenChanges: ['test/**'],
      },
    });
    expect(() => validateWorkspaceCase(drifted)).toThrow(/forbids changes to 'test\/\*\*'/);
  });

  it('refuses a scope pattern that names something outside the workspace', () => {
    expect(() => minimalCase({ task: { instruction: 'Fix it.', scope: { allowed: ['../elsewhere/**'] } } })).toThrow();
  });
});

describe('projection into the existing campaign machinery', () => {
  it('produces a plan slot the unchanged planner accepts', () => {
    const plannable = {
      catalogDigest: 'digest',
      caseCount: 1,
      repeatsPerCase: 2,
      suites: [{
        slug: workspaceFoundationSuite.id,
        block: 'workspace',
        executionOrdinal: 0,
        cases: [workspacePlannableCaseOf(BROKEN_SUM_MEAN, 0)],
      }],
    };
    const slots = buildPlan(plannable, [{ name: 'opus', modelID: 'claude-opus-5' }]);
    expect(slots).toHaveLength(2);
    expect(slots[0].caseID).toBe('ws.broken-sum.mean');
    expect(slots[0].caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(slots[0].scoringMode).toBe(workspaceScoringMode(BROKEN_SUM_MEAN));
  });

  it('freezes into a manifest, binding the task version into the scored core', () => {
    const manifest = freezeManifest({
      label: 'workspace pilot',
      catalogDigest: 'catalog',
      caseCount: 1,
      repeatsPerCase: 1,
      prompts: [workspacePromptRecordOf(BROKEN_SUM_MEAN)],
      scoredCore: [workspaceScoredCoreEntryOf(BROKEN_SUM_MEAN)],
      evaluators: [{ evaluatorID: 'workspace', source: 'v1' }],
      candidates: [{ name: 'opus', modelID: 'claude-opus-5', runtimeDigest: '', parameterSize: '', quantization: '' }],
      guards: { minimumFreeDiskBytes: 1 },
      hardware: { platform: 'darwin', architecture: 'arm64', model: 'Mac', cpuCoreCount: 8, physicalMemoryBytes: 1, osVersion: '27' },
      runtimeVersion: 'n/a',
      execution: { residency: 'observeOnly', thinkingMode: 'disabled' },
      frozenAt: '2026-09-20T00:00:00Z',
    });
    expect(manifest.scoredCore[0].caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(manifest.scoredCore[0].comparabilityKey).toBe(workspaceComparabilityKey(BROKEN_SUM_MEAN));
    expect(manifest.scoredCore[0].promptSHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('declares no output ceiling, because the work is the patch rather than the prose', () => {
    expect(workspaceScoredCoreEntryOf(BROKEN_SUM_MEAN).maxOutputTokens).toBe(0);
    expect(fileInvariant({ path: './src/stats.js' }).path).toBe('src/stats.js');
  });
});
