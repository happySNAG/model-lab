// Debugging and instruction compliance as capabilities derived from existing workspace dimensions by
// ONE documented, versioned mapping (ccm1), and a capability with no evidence reported UNCOVERED — never
// qualified.
//
// FIXTURES ONLY. The cases are declarations in `fixtures/capability-coverage-cases.ts` and the rows are
// hand-written ledger rows; no driver runs and no provider is contacted. The component verdicts come
// from `deriveRouteQualification` itself, so this file tests the mapping and the combination, not a
// second copy of cqp1.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALL_DERIVED_CAPABILITIES, CAPABILITY_COVERAGE_SCHEMA, CAPABILITY_MAPPING_VERSION, CapabilityCoverageComponent,
  DERIVED_CAPABILITY_MAPPING, DerivedCapability, DerivedCapabilityCoverage, UNCOVERED_IS_NOT_QUALIFIED,
  combineComponentVerdicts, deriveCapabilityCoverage, describeCapabilityCoverage,
} from '../../src/engine/capability-coverage';
import { QualificationPolicy, V1_QUALIFICATION_POLICY, deriveRouteQualification } from '../../src/engine/route-qualification';
import { ALL_WORKSPACE_DIMENSIONS, WorkspaceDimension } from '../../src/engine/workspace-case';
import { BROKEN_SUM_MEAN, allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { WorkspaceRunRow } from '../../src/engine/workspace-aggregate';
import {
  COVERAGE_FIXTURE_CASES, DEBUGGING_CASE, INSTRUCTION_CASE, RECOVERY_ONLY_CASE, UNRELATED_CASE, coverageRun, coverageRuns,
} from './fixtures/capability-coverage-cases';

const REPOSITORY = path.resolve(__dirname, '../..');
const MODEL = 'claude-fixture-1';

function coverageFor(rows: WorkspaceRunRow[], policy?: QualificationPolicy, cases = COVERAGE_FIXTURE_CASES) {
  const record = deriveRouteQualification({ provider: 'claudeCLI', modelID: MODEL, machineKey: 'cmk1:coverage',
    workspaceRows: rows, workspaceCases: cases, now: new Date('2026-10-02T00:00:00Z'), ...(policy ? { policy } : {}) });
  return { record, coverage: deriveCapabilityCoverage(record) };
}
const entry = (coverage: { capabilities: DerivedCapabilityCoverage[] }, capability: DerivedCapability): DerivedCapabilityCoverage =>
  coverage.capabilities.find((candidate) => candidate.derivedCapability === capability) as DerivedCapabilityCoverage;
const states = (found: DerivedCapabilityCoverage) =>
  Object.fromEntries(found.components.map((component) => [component.dimension, component.state]));

// ------------------------------------------------------------------ the mapping

describe('the mapping is one versioned table over existing workspace dimensions', () => {
  it('ccm1 is exactly this table — changing it means a new version', () => {
    expect(CAPABILITY_MAPPING_VERSION).toBe('ccm1');
    expect(CAPABILITY_COVERAGE_SCHEMA).toBe('ccc1');
    expect(DERIVED_CAPABILITY_MAPPING).toEqual({
      debugging: ['failureInterpretation', 'recoveryFromError', 'verificationDrivenRecovery'],
      instructionCompliance: ['scopeDiscipline', 'contractOverVisibleTests', 'preservationUnderTransformation'],
    });
    expect(ALL_DERIVED_CAPABILITIES).toEqual(['debugging', 'instructionCompliance']);
  });

  it('maps only dimensions that exist, each to at most one capability', () => {
    const mapped = Object.values(DERIVED_CAPABILITY_MAPPING).flat();
    for (const dimension of mapped) expect(ALL_WORKSPACE_DIMENSIONS).toContain(dimension);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('is documented, with a justification for every mapped dimension', () => {
    const doc = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/capability-coverage.md'), 'utf8');
    expect(doc).toContain(CAPABILITY_MAPPING_VERSION);
    for (const dimension of Object.values(DERIVED_CAPABILITY_MAPPING).flat()) expect(doc).toContain(`\`${dimension}\``);
  });

  it('the fixture cases declare each capability\'s dimensions, and one declares neither', () => {
    expect(DEBUGGING_CASE.dimensions).toEqual(expect.arrayContaining(['failureInterpretation', 'recoveryFromError']));
    expect(RECOVERY_ONLY_CASE.dimensions).toEqual(expect.arrayContaining(['recoveryFromError', 'verificationDrivenRecovery']));
    expect(INSTRUCTION_CASE.dimensions).toEqual(expect.arrayContaining(['scopeDiscipline', 'contractOverVisibleTests']));
    const mapped = Object.values(DERIVED_CAPABILITY_MAPPING).flat();
    expect(UNRELATED_CASE.dimensions.some((dimension) => mapped.includes(dimension))).toBe(false);
  });
});

// ------------------------------------------------------------------ no evidence is uncovered

describe('a capability with no evidence reports uncovered, never qualified', () => {
  it('a route with no runs at all: both capabilities uncovered', () => {
    const { coverage } = coverageFor([]);
    for (const capability of ALL_DERIVED_CAPABILITIES) {
      const found = entry(coverage, capability);
      expect(found.verdict).toBe('uncovered');
      expect(found.coverage).toBe('none');
      expect(found.evidenceRefs).toEqual([]);
      expect(found.reason).toContain(UNCOVERED_IS_NOT_QUALIFIED);
    }
  });

  it('a route that passed only cases outside both mappings: still uncovered, though it qualified elsewhere', () => {
    const { record, coverage } = coverageFor(coverageRuns(5, MODEL, UNRELATED_CASE));
    expect(record.capabilities.some((capability) => capability.verdict === 'qualified')).toBe(true);
    expect(coverage.capabilities.map((found) => found.verdict)).toEqual(['uncovered', 'uncovered']);
  });

  it('a retry dimension over first-attempt passes exercised nothing, so it covers nothing', () => {
    const { record, coverage } = coverageFor(coverageRuns(5, MODEL, RECOVERY_ONLY_CASE));
    expect(record.capabilities.find((capability) => capability.capability === 'workspace:recoveryFromError')?.verdict).toBe('notExercised');
    const debugging = entry(coverage, 'debugging');
    expect(debugging.verdict).toBe('uncovered');
    expect(states(debugging)).toEqual({ failureInterpretation: 'uncovered', recoveryFromError: 'uncovered', verificationDrivenRecovery: 'uncovered' });
    expect(debugging.components.find((component) => component.dimension === 'recoveryFromError')?.reason).toContain('no run exercised it');
  });

  it('no combination with nothing covered is qualified (every subset of uncovered components)', () => {
    const component = (state: CapabilityCoverageComponent['state']): CapabilityCoverageComponent => ({
      dimension: 'failureInterpretation', capability: 'workspace:failureInterpretation', state, covered: state !== 'uncovered',
      scoredRunCount: 0, successCount: 0, evidenceRefs: [], reason: '' });
    for (let size = 1; size <= 3; size += 1) {
      expect(combineComponentVerdicts(Array.from({ length: size }, () => component('uncovered'))))
        .toEqual({ verdict: 'uncovered', coverage: 'none' });
    }
    expect(combineComponentVerdicts([component('qualified'), component('uncovered')])).toEqual({ verdict: 'qualified', coverage: 'partial' });
    expect(combineComponentVerdicts([component('qualified'), component('qualified')])).toEqual({ verdict: 'qualified', coverage: 'full' });
    expect(combineComponentVerdicts([component('qualified'), component('insufficientEvidence')]).verdict).toBe('insufficientEvidence');
    expect(combineComponentVerdicts([component('insufficientEvidence'), component('notQualified')]).verdict).toBe('notQualified');
  });
});

// ------------------------------------------------------------------ debugging, from fixture cases

describe('debugging derives from failureInterpretation, recoveryFromError and verificationDrivenRecovery', () => {
  it('qualified, fully covered, when both debugging cases failed first and recovered every time', () => {
    const rows = [
      ...coverageRuns(3, MODEL, DEBUGGING_CASE, { attemptsUsed: 2 }),
      ...coverageRuns(3, MODEL, RECOVERY_ONLY_CASE, { attemptsUsed: 2 }),
    ];
    const debugging = entry(coverageFor(rows).coverage, 'debugging');
    expect(states(debugging)).toEqual({
      failureInterpretation: 'qualified', recoveryFromError: 'qualified', verificationDrivenRecovery: 'qualified',
    });
    expect(debugging).toMatchObject({ capability: 'derived:debugging', verdict: 'qualified', coverage: 'full', uncoveredDimensions: [] });
    expect(debugging.evidenceRefs).toEqual([DEBUGGING_CASE.id, RECOVERY_ONLY_CASE.id].sort());
  });

  it('qualified with partial coverage on first-attempt passes, naming recovery as not covered', () => {
    const debugging = entry(coverageFor(coverageRuns(3, MODEL, DEBUGGING_CASE)).coverage, 'debugging');
    expect(debugging.verdict).toBe('qualified');
    expect(debugging.coverage).toBe('partial');
    expect(debugging.uncoveredDimensions).toEqual(['recoveryFromError', 'verificationDrivenRecovery']);
    expect(debugging.reason).toContain('not covered: recoveryFromError, verificationDrivenRecovery');
  });

  it('notQualified when a failed first attempt was never recovered', () => {
    const rows = [
      ...coverageRuns(3, MODEL, DEBUGGING_CASE, { attemptsUsed: 2 }),
      ...coverageRuns(3, MODEL, RECOVERY_ONLY_CASE, { attemptsUsed: 2, status: 'fail' }),
    ];
    const debugging = entry(coverageFor(rows).coverage, 'debugging');
    expect(debugging.verdict).toBe('notQualified');
    expect(states(debugging).verificationDrivenRecovery).toBe('notQualified');
  });

  it('insufficientEvidence, not notQualified, on two runs', () => {
    const debugging = entry(coverageFor(coverageRuns(2, MODEL, DEBUGGING_CASE)).coverage, 'debugging');
    expect(debugging.verdict).toBe('insufficientEvidence');
  });

  it('a catalog case counts too: broken-sum-mean declares failureInterpretation and scopeDiscipline', () => {
    const rows = coverageRuns(3, MODEL, BROKEN_SUM_MEAN);
    const { coverage } = coverageFor(rows, undefined, allWorkspaceCases());
    expect(entry(coverage, 'debugging')).toMatchObject({ verdict: 'qualified', coverage: 'partial', evidenceRefs: [BROKEN_SUM_MEAN.id] });
    expect(entry(coverage, 'instructionCompliance')).toMatchObject({ verdict: 'qualified', coverage: 'partial', evidenceRefs: [BROKEN_SUM_MEAN.id] });
  });
});

// ------------------------------------------------------------------ instruction compliance, from fixture cases

describe('instruction compliance derives from scopeDiscipline, contractOverVisibleTests and preservationUnderTransformation', () => {
  it('qualified when the instruction case passed every time; preservation is named as not covered', () => {
    const compliance = entry(coverageFor(coverageRuns(3, MODEL, INSTRUCTION_CASE)).coverage, 'instructionCompliance');
    expect(compliance).toMatchObject({ capability: 'derived:instructionCompliance', verdict: 'qualified', coverage: 'partial',
      uncoveredDimensions: ['preservationUnderTransformation'], evidenceRefs: [INSTRUCTION_CASE.id] });
    expect(states(compliance)).toEqual({ scopeDiscipline: 'qualified', contractOverVisibleTests: 'qualified', preservationUnderTransformation: 'uncovered' });
  });

  it('notQualified below the rate, and the debugging capability stays uncovered beside it', () => {
    const rows = [...coverageRuns(2, MODEL, INSTRUCTION_CASE), ...coverageRuns(2, MODEL, INSTRUCTION_CASE, { status: 'fail' })];
    const { coverage } = coverageFor(rows);
    expect(entry(coverage, 'instructionCompliance').verdict).toBe('notQualified');
    expect(entry(coverage, 'debugging').verdict).toBe('uncovered');
  });

  it('a run the harness broke is not evidence: three harness faults leave it uncovered', () => {
    const { coverage } = coverageFor(coverageRuns(3, MODEL, INSTRUCTION_CASE, { status: 'runtimeError' }));
    expect(entry(coverage, 'instructionCompliance').verdict).toBe('uncovered');
  });
});

// ------------------------------------------------------------------ derived, never re-decided

describe('the component verdicts are the record\'s, under the record\'s policy', () => {
  it('a stricter policy moves the derived verdict with it, and the policy is carried', () => {
    const strict: QualificationPolicy = { ...V1_QUALIFICATION_POLICY, policyID: 'cqp-test-strict', minimumScoredRuns: 5 };
    const rows = coverageRuns(3, MODEL, INSTRUCTION_CASE);
    expect(coverageFor(rows).coverage.policyID).toBe('cqp1');
    const strictCoverage = coverageFor(rows, strict).coverage;
    expect(strictCoverage.policyID).toBe('cqp-test-strict');
    expect(entry(strictCoverage, 'instructionCompliance').verdict).toBe('insufficientEvidence');
  });

  it('each component mirrors its workspace entry, and the record is not changed', () => {
    const rows = [...coverageRuns(3, MODEL, DEBUGGING_CASE, { attemptsUsed: 2 }), ...coverageRuns(3, MODEL, INSTRUCTION_CASE)];
    const { record, coverage } = coverageFor(rows);
    const before = JSON.stringify(record);
    const again = deriveCapabilityCoverage(record);
    expect(JSON.stringify(record)).toBe(before);
    expect(again).toEqual(coverage);
    for (const found of coverage.capabilities) {
      for (const component of found.components.filter((candidate) => candidate.covered)) {
        const source = record.capabilities.find((capability) => capability.capability === `workspace:${component.dimension}`);
        expect(component).toMatchObject({ state: source?.verdict, scoredRunCount: source?.scoredRunCount, successCount: source?.successCount });
      }
    }
    expect(JSON.stringify(coverage)).not.toMatch(/"(score|overallScore|total\w*)"/);
    expect(coverage.disclosure).toContain('ccm1');
  });

  it('prints one line per capability with every component\'s state', () => {
    const { coverage } = coverageFor([coverageRun(MODEL, DEBUGGING_CASE)]);
    const line = describeCapabilityCoverage(entry(coverage, 'debugging'));
    expect(line).toContain('derived:debugging');
    expect(line).toContain('insufficientEvidence');
    for (const dimension of DERIVED_CAPABILITY_MAPPING.debugging as readonly WorkspaceDimension[]) expect(line).toContain(dimension);
  });
});
