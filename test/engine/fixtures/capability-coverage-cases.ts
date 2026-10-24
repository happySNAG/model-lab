// Fixture cases for the derived capabilities in `capability-coverage.ts`, and hand-written ledger rows
// shaped as `workspace-campaign.ts` writes them. Nothing here is run: the cases are DECLARATIONS a row
// points at, which is all `workspaceCapabilityEvidence` reads from a case.

import { WorkspaceCase, makeWorkspaceCase } from '../../../src/engine/workspace-case';
import { WorkspaceRunRow } from '../../../src/engine/workspace-aggregate';

const SUITE = { suiteID: 'suite.test.capability-coverage', suiteVersion: '1' };
const SOURCE = { fixturePath: 'workspace/broken-sum' };

/** Debugging: interpret a failing check and recover from it on a second attempt. */
export const DEBUGGING_CASE: WorkspaceCase = makeWorkspaceCase({
  ...SUITE, id: 'fixture.coverage.debugging', version: '1', source: SOURCE,
  dimensions: ['failureInterpretation', 'recoveryFromError', 'testExecution'],
  task: { instruction: 'The tests fail. Find out why and fix it.' },
  execution: { maximumAttempts: 2 },
});

/** Debugging, recovery only: the retry dimension alone, so first-attempt passes exercise nothing. */
export const RECOVERY_ONLY_CASE: WorkspaceCase = makeWorkspaceCase({
  ...SUITE, id: 'fixture.coverage.recovery-only', version: '1', source: SOURCE,
  dimensions: ['recoveryFromError', 'verificationDrivenRecovery'],
  task: { instruction: 'Fix the failure the verification report names.' },
  execution: { maximumAttempts: 2 },
});

/** Instruction compliance: stay in scope and meet the stated contract, not only the visible tests. */
export const INSTRUCTION_CASE: WorkspaceCase = makeWorkspaceCase({
  ...SUITE, id: 'fixture.coverage.instruction', version: '1', source: SOURCE,
  dimensions: ['scopeDiscipline', 'contractOverVisibleTests', 'multiFileEditing'],
  task: { instruction: 'Change only src/mean.js, so that it meets CONTRACT.md.', scope: { allowed: ['src/mean.js'] } },
});

/** Neither: a case whose dimensions are outside both mappings. */
export const UNRELATED_CASE: WorkspaceCase = makeWorkspaceCase({
  ...SUITE, id: 'fixture.coverage.unrelated', version: '1', source: SOURCE,
  dimensions: ['multiFileEditing', 'toolUse'],
  task: { instruction: 'Rename the helper everywhere it is used.' },
});

export const COVERAGE_FIXTURE_CASES: WorkspaceCase[] = [DEBUGGING_CASE, RECOVERY_ONLY_CASE, INSTRUCTION_CASE, UNRELATED_CASE];

let serial = 0;
/** One recorded run of `modelID` on `fixture`. Defaults: a verified first-attempt pass. */
export function coverageRun(modelID: string, fixture: WorkspaceCase, fields: Record<string, unknown> = {}): WorkspaceRunRow {
  serial += 1;
  return {
    recordRoot: `/virtual/coverage/${String(serial).padStart(3, '0')}`,
    row: {
      provider: 'claudeCLI', requestedModelID: modelID, candidate: `claudeCLI:${modelID}`, effort: 'none',
      caseID: fixture.id, caseVersion: fixture.version, comparabilityKey: `cwk1:${fixture.id}`,
      caseMaximumAttempts: fixture.execution.maximumAttempts, repeatIndex: serial,
      status: 'pass', attemptsUsed: 1, bindingIdentityState: 'verified',
      recordedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + serial * 60_000).toISOString(),
      ...fields,
    },
  };
}

/** `count` runs, each with the same fields. */
export function coverageRuns(count: number, modelID: string, fixture: WorkspaceCase, fields: Record<string, unknown> = {}): WorkspaceRunRow[] {
  return Array.from({ length: count }, () => coverageRun(modelID, fixture, fields));
}
