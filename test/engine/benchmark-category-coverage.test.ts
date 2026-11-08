// The twenty VISION.md benchmark categories mapped (cbm1) to existing workspace dimensions and suites,
// and a coverage report (cbc1) derived purely from case DEFINITIONS.
//
// FIXTURES ONLY. The cases are in-memory declarations (plus the registered catalogue, read and never
// run, for the digest check). No driver runs, no file is written and no provider is contacted. The
// VISION.md list is read from the worktree so the category names cannot drift from the document.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BENCHMARK_CATEGORIES, BENCHMARK_CATEGORY_COVERAGE_SCHEMA, BENCHMARK_CATEGORY_MAPPING, BENCHMARK_CATEGORY_MAPPING_ID,
  BenchmarkCategory, BenchmarkCategoryCaseInput, BenchmarkCategoryCoverageReport, BenchmarkCategoryMapping,
  DECLARED_IS_NOT_MEASURED, deriveBenchmarkCategoryCoverage, describeBenchmarkCategoryCoverage,
} from '../../src/engine/benchmark-category-coverage';
import { ALL_WORKSPACE_DIMENSIONS, WorkspaceDimension, workspaceCaseDigest, workspaceSuiteDigest } from '../../src/engine/workspace-case';
import { allWorkspaceCases, registeredWorkspacePacks, registeredWorkspaceSuites } from '../../src/engine/workspace-catalog';
import { workspacePackDigest } from '../../src/engine/workspace-pack';

const VISION = path.resolve(__dirname, '../../docs/VISION.md');

/** The bullet list under "Benchmark categories should include:" in section 8, read from the file. */
function visionSectionEightCategories(): string[] {
  const lines = fs.readFileSync(VISION, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 8\. /.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const intro = section.findIndex((line) => /benchmark categories/i.test(line));
  expect(intro).toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  for (const line of section.slice(intro + 1)) {
    if (line.startsWith('- ')) names.push(line.slice(2).trim());
    else if (line.trim() !== '' && names.length > 0) break;
  }
  return names;
}

const fixtureCase = (id: string, dimensions: WorkspaceDimension[], suiteID = 'suite.fixture.coverage'): BenchmarkCategoryCaseInput =>
  ({ id, suiteID, dimensions });

const entryOf = (report: BenchmarkCategoryCoverageReport, category: BenchmarkCategory) =>
  report.categories.find((candidate) => candidate.category === category)!;

const nothingMapped = (): Record<BenchmarkCategory, { dimensions: WorkspaceDimension[]; suites: string[]; complete: boolean; rationale: string }> =>
  Object.fromEntries(BENCHMARK_CATEGORIES.map((category) => [category, { dimensions: [], suites: [], complete: false, rationale: 'fixture' }])) as never;

// ------------------------------------------------------------------ (a) the twenty categories

describe('(a) the categories are exactly the twenty VISION.md section 8 lists', () => {
  it('reads twenty names from the document and matches them in order', () => {
    const fromVision = visionSectionEightCategories();
    expect(fromVision).toHaveLength(20);
    expect([...BENCHMARK_CATEGORIES]).toEqual(fromVision);
  });

  it('maps every category, and nothing else, and the report lists them in the same order', () => {
    expect(Object.keys(BENCHMARK_CATEGORY_MAPPING).sort()).toEqual([...BENCHMARK_CATEGORIES].sort());
    const report = deriveBenchmarkCategoryCoverage([]);
    expect(report.categories.map((entry) => entry.category)).toEqual([...BENCHMARK_CATEGORIES]);
    expect(report.totals.categories).toBe(20);
  });
});

// ------------------------------------------------------------------ (b) the mapping id

describe('(b) the mapping is versioned cbm1', () => {
  it('carries cbm1 and the cbc1 schema on the report', () => {
    expect(BENCHMARK_CATEGORY_MAPPING_ID).toBe('cbm1');
    expect(BENCHMARK_CATEGORY_COVERAGE_SCHEMA).toBe('cbc1');
    const report = deriveBenchmarkCategoryCoverage([]);
    expect(report.mappingID).toBe('cbm1');
    expect(report.schema).toBe('cbc1');
    expect(report.disclosure).toContain('cbm1');
    expect(report.disclosure).toContain(DECLARED_IS_NOT_MEASURED);
  });

  it('cbm1 is exactly this table — changing it means a new id', () => {
    const table = Object.fromEntries(Object.entries(BENCHMARK_CATEGORY_MAPPING)
      .filter(([, entry]) => entry.dimensions.length > 0 || entry.suites.length > 0)
      .map(([category, entry]) => [category, { dimensions: entry.dimensions, suites: entry.suites, complete: entry.complete }]));
    expect(table).toEqual({
      'Simple code edits': { dimensions: ['fileLocation', 'scopeDiscipline'], suites: [], complete: false },
      'Complex code changes': { dimensions: ['multiFileEditing', 'interactingInvariantReasoning'], suites: [], complete: false },
      'Architecture and system design': { dimensions: ['interactingInvariantReasoning'], suites: [], complete: false },
      Debugging: { dimensions: ['failureInterpretation', 'recoveryFromError', 'verificationDrivenRecovery'], suites: [], complete: true },
      Refactoring: { dimensions: ['preservationUnderTransformation', 'regressionAvoidance'], suites: [], complete: false },
      'Multi-step autonomous development': { dimensions: ['autonomousCompletion', 'toolUse'], suites: [], complete: true },
      'Failure recovery': {
        dimensions: ['recoveryFromError', 'verificationDrivenRecovery', 'secondAttemptAdaptation'], suites: [], complete: true,
      },
    });
  });

  it('an empty mapping is never marked complete, and every entry has a rationale', () => {
    for (const entry of Object.values(BENCHMARK_CATEGORY_MAPPING)) {
      expect(entry.rationale.length).toBeGreaterThan(0);
      if (entry.dimensions.length === 0 && entry.suites.length === 0) expect(entry.complete).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ (c) no mapped case is uncovered

describe('(c) a category with no mapped case is uncovered, never covered', () => {
  it('with no cases at all, every category is uncovered', () => {
    const report = deriveBenchmarkCategoryCoverage([]);
    for (const entry of report.categories) {
      expect(entry.state).toBe('uncovered');
      expect(entry.caseIDs).toEqual([]);
    }
    expect(report.totals).toEqual({ categories: 20, covered: 0, partial: 0, uncovered: 20, casesConsidered: 0 });
  });

  it('a category whose mapping is empty stays uncovered whatever the cases declare', () => {
    const everything = [fixtureCase('ws.fixture.all', [...ALL_WORKSPACE_DIMENSIONS])];
    const report = deriveBenchmarkCategoryCoverage(everything);
    for (const category of BENCHMARK_CATEGORIES) {
      const mapped = BENCHMARK_CATEGORY_MAPPING[category];
      if (mapped.dimensions.length === 0 && mapped.suites.length === 0) {
        expect(entryOf(report, category).state).toBe('uncovered');
        expect(entryOf(report, category).caseIDs).toEqual([]);
      }
    }
    expect(entryOf(report, 'Code review').reason).toContain('nothing maps to this category');
  });

  it('cases that declare only unrelated dimensions leave a mapped category uncovered', () => {
    const report = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.unrelated', ['fileLocation', 'patchCleanliness'])]);
    const debugging = entryOf(report, 'Debugging');
    expect(debugging.state).toBe('uncovered');
    expect(debugging.caseIDs).toEqual([]);
    expect(debugging.unsupportedDimensions).toEqual(['failureInterpretation', 'recoveryFromError', 'verificationDrivenRecovery']);
  });

  it('even a complete mapping marked complete with an empty list is uncovered, not covered', () => {
    const mapping = { ...nothingMapped(), Documentation: { dimensions: [], suites: [], complete: true, rationale: 'fixture' } };
    const report = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.all', [...ALL_WORKSPACE_DIMENSIONS])], mapping as BenchmarkCategoryMapping);
    expect(entryOf(report, 'Documentation').state).toBe('uncovered');
  });

  it('covered needs a complete mapping and every mapped item supported; otherwise partial', () => {
    const someDebugging = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.diagnose', ['failureInterpretation'])]);
    expect(entryOf(someDebugging, 'Debugging').state).toBe('partial');
    expect(entryOf(someDebugging, 'Debugging').caseIDs).toEqual(['ws.fixture.diagnose']);
    expect(entryOf(someDebugging, 'Debugging').unsupportedDimensions).toEqual(['recoveryFromError', 'verificationDrivenRecovery']);

    const allDebugging = deriveBenchmarkCategoryCoverage([
      fixtureCase('ws.fixture.diagnose', ['failureInterpretation']),
      fixtureCase('ws.fixture.recover', ['recoveryFromError', 'verificationDrivenRecovery']),
    ]);
    expect(entryOf(allDebugging, 'Debugging').state).toBe('covered');
    expect(entryOf(allDebugging, 'Debugging').caseIDs).toEqual(['ws.fixture.diagnose', 'ws.fixture.recover']);

    // Every mapped dimension declared, but the mapping is incomplete: partial, never covered.
    const refactor = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.refactor', ['preservationUnderTransformation', 'regressionAvoidance'])]);
    expect(entryOf(refactor, 'Refactoring').state).toBe('partial');
    expect(entryOf(refactor, 'Refactoring').reason).toContain('incomplete');
  });

  it('a mapped suite is supported by any case that belongs to it', () => {
    const mapping = { ...nothingMapped(), 'Test repair': { dimensions: [], suites: ['suite.fixture.tests'], complete: true, rationale: 'fixture' } };
    const empty = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.other', ['toolUse'])], mapping as BenchmarkCategoryMapping);
    expect(entryOf(empty, 'Test repair').state).toBe('uncovered');
    const report = deriveBenchmarkCategoryCoverage([fixtureCase('ws.fixture.tests', [], 'suite.fixture.tests')], mapping as BenchmarkCategoryMapping);
    expect(entryOf(report, 'Test repair').state).toBe('covered');
    expect(entryOf(report, 'Test repair').caseIDs).toEqual(['ws.fixture.tests']);
  });

  it('totals count each state once per category', () => {
    const report = deriveBenchmarkCategoryCoverage(allWorkspaceCases());
    const { covered, partial, uncovered, categories } = report.totals;
    expect(covered + partial + uncovered).toBe(categories);
    expect(report.totals.casesConsidered).toBe(new Set(allWorkspaceCases().map((c) => c.id)).size);
    for (const entry of report.categories) {
      if (entry.state === 'uncovered') expect(entry.caseIDs).toEqual([]);
      else expect(entry.caseIDs.length).toBeGreaterThan(0);
      expect(describeBenchmarkCategoryCoverage(entry)).toContain(entry.category);
    }
  });
});

// ------------------------------------------------------------------ (d) only existing dimensions

describe('(d) every mapped dimension is one of ALL_WORKSPACE_DIMENSIONS', () => {
  it('maps no dimension that does not exist', () => {
    const mapped = Object.values(BENCHMARK_CATEGORY_MAPPING).flatMap((entry) => [...entry.dimensions]);
    expect(mapped.length).toBeGreaterThan(0);
    for (const dimension of mapped) expect(ALL_WORKSPACE_DIMENSIONS).toContain(dimension);
  });

  it('maps only suites the catalogue registers', () => {
    const registered = registeredWorkspaceSuites.map((suite) => suite.id);
    for (const entry of Object.values(BENCHMARK_CATEGORY_MAPPING)) for (const suite of entry.suites) expect(registered).toContain(suite);
  });
});

// ------------------------------------------------------------------ (e) deterministic and read-only

describe('(e) the report is deterministic and changes no case or pack digest', () => {
  it('the same input gives the same report, in any case order', () => {
    const cases = [
      fixtureCase('ws.fixture.b', ['failureInterpretation', 'toolUse']),
      fixtureCase('ws.fixture.a', ['recoveryFromError', 'autonomousCompletion']),
      fixtureCase('ws.fixture.c', ['multiFileEditing']),
    ];
    const first = deriveBenchmarkCategoryCoverage(cases);
    expect(deriveBenchmarkCategoryCoverage(cases)).toEqual(first);
    expect(JSON.stringify(deriveBenchmarkCategoryCoverage([...cases].reverse()))).toBe(JSON.stringify(first));
    expect(JSON.stringify(deriveBenchmarkCategoryCoverage(allWorkspaceCases())))
      .toBe(JSON.stringify(deriveBenchmarkCategoryCoverage(allWorkspaceCases())));
  });

  it('leaves the input cases unchanged', () => {
    const cases = [fixtureCase('ws.fixture.a', ['recoveryFromError', 'failureInterpretation'])];
    const before = structuredClone(cases);
    deriveBenchmarkCategoryCoverage(cases);
    expect(cases).toEqual(before);
  });

  it('computing it over the registered catalogue changes no case, suite or pack digest', () => {
    const cases = allWorkspaceCases();
    const digests = () => ({
      cases: cases.map(workspaceCaseDigest),
      suites: registeredWorkspaceSuites.map(workspaceSuiteDigest),
      packs: registeredWorkspacePacks.map((pack) => workspacePackDigest(pack, cases)),
      caseCount: cases.length,
    });
    const before = digests();
    const snapshot = structuredClone(cases);
    deriveBenchmarkCategoryCoverage(cases);
    expect(digests()).toEqual(before);
    expect(cases).toEqual(snapshot);
  });
});
