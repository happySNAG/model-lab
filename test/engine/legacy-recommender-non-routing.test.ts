// Cernum · the legacy prose recommender is non-routing (vision conflict K2, owner decision B4-2).
//
// `src/core/recommendation.ts` and its 80% `recommendation.policy.v1` inform prose campaigns only. No
// routing path imports or calls it, and cqp1's 90% is the only routing threshold.
//
// Register: docs/ordra-lane/vision-conflicts.md K2.

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { candidateID } from '../../src/core/candidate';
import { ALL_DIMENSIONS } from '../../src/core/evaluation';
import { CapabilityProfile } from '../../src/core/profile';
import {
  LEGACY_RECOMMENDER_ROUTING, LEGACY_RECOMMENDER_SCOPE, LegacyRecommenderRouting, RECOMMENDATION_POLICY_VERSION,
  deriveRecommendation, standardRecommendationPolicy,
} from '../../src/core/recommendation';
import type { SessionResults } from '../../src/shared/ipc';
import {
  DEFAULT_QUALIFICATION_POLICY, V1_QUALIFICATION_POLICY, V2_QUALIFICATION_POLICY,
} from '../../src/engine/route-qualification';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const LEGACY_RECOMMENDER = 'src/core/recommendation.ts';
/** `src/core/index.ts` re-exports the legacy recommender, so importing it is importing the recommender. */
const LEGACY_REEXPORTERS = ['src/core/index.ts'];

/** The routing paths: crc2/crc3, cfc1, crr1, status-export, and the CLI holding `candidates` and `recommend`. */
const ROUTING_ROOTS = [
  'src/engine/routing-contract.ts',
  'src/engine/fallback-chain.ts',
  'src/engine/route-recommendation.ts',
  'src/engine/status-export.ts',
  'src/engine/route-qualification.ts',
  'src/engine/task-taxonomy.ts',
  'src/cli/cernum.ts',
];

/** The routing modules themselves: these may not import the legacy recommender at all, not even for a type. */
const ROUTING_MODULES = ROUTING_ROOTS.filter((file) => file.startsWith('src/engine/'));

/**
 * Modules a routing path loads that name the sealed `OwnerRecommendationRecord` shape in a type-only import
 * (erased at runtime, so nothing is loaded or called): the app's IPC contract and the result store's record
 * list. Any other type-only reference fails, so a new one has to be argued for here.
 */
const TYPE_ONLY_ALLOWED = ['src/shared/ipc.ts', 'src/core/store.ts'];

/**
 * A top-level `import … from`, `export … from` or side-effect `import '…'` statement; group 1 is `type`
 * when the whole statement is type-only. Anchored to the start of a line, so source text embedded in
 * string literals (workspace fixtures) is not read as an import.
 */
const SPECIFIER = /^(?:(?:import|export)\s+(type\s+)?[\w$*\s{},]*?\bfrom\s*|import\s*)['"]([^'"]+)['"]/gm;
/** A dynamic `import('…')` or `require('…')`: loaded at runtime, so it is followed like a value import. */
const DYNAMIC = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(fromFile: string, specifier: string, strict = true): string | undefined {
  let base: string;
  if (specifier.startsWith('@core/')) base = path.join('src/core', specifier.slice('@core/'.length));
  else if (specifier.startsWith('@shared/')) base = path.join('src/shared', specifier.slice('@shared/'.length));
  else if (specifier.startsWith('.')) base = path.join(path.dirname(fromFile), specifier);
  else return undefined; // node: builtins and packages
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return path.normalize(candidate).split(path.sep).join('/');
  }
  if (!strict) return undefined;
  throw new Error(`${fromFile}: cannot resolve '${specifier}'`);
}

/** A file's imports: runtime ones (static value imports, dynamic imports, requires) and type-only ones. */
function importsOf(file: string): { runtime: string[]; typeOnly: string[] } {
  const source = read(file);
  const runtime: string[] = [];
  const typeOnly: string[] = [];
  for (const [, type, specifier] of source.matchAll(SPECIFIER)) {
    const target = resolveSpecifier(file, specifier);
    if (target !== undefined) (type ? typeOnly : runtime).push(target);
  }
  // Not anchored, so it also matches source text inside fixture strings: a specifier that resolves to no
  // file is skipped (tsc rejects a real one), and one that does resolve is followed, which only widens the scan.
  for (const [, specifier] of source.matchAll(DYNAMIC)) {
    const target = resolveSpecifier(file, specifier, false);
    if (target !== undefined) runtime.push(target);
  }
  return { runtime, typeOnly };
}

/**
 * Every repository file a routing root loads at runtime, with its importers, and every type-only
 * reference those files make.
 */
function importClosure(roots: string[]): { runtime: Map<string, string[]>; typeOnly: Map<string, string[]> } {
  const runtime = new Map<string, string[]>();
  const typeOnly = new Map<string, string[]>();
  const queue = [...roots];
  for (const file of roots) runtime.set(file, []);
  while (queue.length > 0) {
    const file = queue.shift()!;
    const imports = importsOf(file);
    for (const target of imports.runtime) {
      if (!runtime.has(target)) { runtime.set(target, []); queue.push(target); }
      runtime.get(target)!.push(file);
    }
    for (const target of imports.typeOnly) {
      if (!typeOnly.has(target)) typeOnly.set(target, []);
      typeOnly.get(target)!.push(file);
    }
  }
  return { runtime, typeOnly };
}

function profileAt(rateMilli: number): CapabilityProfile {
  return {
    candidateID: candidateID('fixture:legacy-recommender'),
    derivationVersion: 'profile.derivation.v1',
    filterRestrictions: [],
    totalEvaluationsConsidered: ALL_DIMENSIONS.length * 3,
    dimensions: ALL_DIMENSIONS.map((dimension) => ({
      dimension, sampleSize: 3, qualityRateMilli: { measured: rateMilli }, disqualifications: [],
      indeterminateCount: 0, requiresHumanReviewCount: 0, distinctComparabilityCohorts: 1,
      suiteVersions: ['1'], evaluatorVersions: ['1'],
    })),
    missingDimensions: [],
    hardGovernanceFailureTotal: 0,
    derivedAt: '2026-10-26T00:00:00Z',
  } as unknown as CapabilityProfile;
}

describe('the legacy prose recommender is labelled non-routing', () => {
  it("carries the typed label routing: 'none'", () => {
    expect(LEGACY_RECOMMENDER_ROUTING).toBe('none');
    expectTypeOf<LegacyRecommenderRouting>().toEqualTypeOf<'none'>();
    expectTypeOf<SessionResults['recommendation'][number]['routing']>().toEqualTypeOf<'none'>();
    expectTypeOf<SessionResults['recommendationRouting']>().toEqualTypeOf<'none'>();
    expect(LEGACY_RECOMMENDER_SCOPE).toContain('prose campaigns only');
  });

  it('labels every recommendation the app presents, and says so in its doc comment and UI', () => {
    const service = read('src/main/lab-service.ts');
    expect(service).toMatch(/record, recorded, routing: LEGACY_RECOMMENDER_ROUTING/);
    expect(service).toMatch(/recommendationRouting: LEGACY_RECOMMENDER_ROUTING/);
    const source = read(LEGACY_RECOMMENDER);
    expect(source).toContain('NON-ROUTING');
    expect(source).toContain('inform prose campaigns');
    const view = read('src/renderer/views/Results.tsx');
    expect(view).toContain('data-testid="recommendation-non-routing"');
    expect(view).toContain('informs prose campaigns only');
    expect(view).toContain('not a routing threshold');
  });

  it('keeps its 80% behaviour for the prose UI unchanged', () => {
    expect(RECOMMENDATION_POLICY_VERSION).toBe('recommendation.policy.v1');
    expect(standardRecommendationPolicy).toEqual({ minimumSamplesPerDimension: 3, minimumDimensionsWithEvidence: 6, recommendQualityThresholdMilli: 800 });
    const now = new Date('2026-10-26T00:00:00Z');
    expect(deriveRecommendation(profileAt(800), 0, standardRecommendationPolicy, 0, now).outcome).toBe('recommended');
    expect(deriveRecommendation(profileAt(799), 0, standardRecommendationPolicy, 0, now).outcome).toBe('notRecommended');
    // The sealed record's bytes are unchanged: the label sits beside it, not inside it.
    expect(Object.keys(deriveRecommendation(profileAt(800), 0, standardRecommendationPolicy, 0, now))).not.toContain('routing');
  });
});

describe('no routing path imports or calls the legacy recommender', () => {
  const closure = importClosure(ROUTING_ROOTS);

  it('reaches every routing root and resolves real imports, dynamic ones included', () => {
    for (const file of ROUTING_ROOTS) expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    expect(closure.runtime.has('src/engine/routing-contract.ts')).toBe(true);
    expect(closure.runtime.size).toBeGreaterThan(ROUTING_ROOTS.length);
    // discovery.ts loads its credential reader with `await import('./credentials')`; the scan follows it.
    expect(closure.runtime.get('src/engine/credentials.ts')).toContain('src/engine/discovery.ts');
  });

  it('never loads src/core/recommendation.ts at runtime, directly or transitively', () => {
    for (const forbidden of [LEGACY_RECOMMENDER, ...LEGACY_REEXPORTERS]) {
      expect(closure.runtime.has(forbidden), `${forbidden} imported by ${closure.runtime.get(forbidden)?.join(', ')}`).toBe(false);
    }
  });

  it('is not imported by any routing module at all, and named as a type only where the record is stored or shown', () => {
    for (const file of ROUTING_MODULES) {
      const { runtime, typeOnly } = importsOf(file);
      expect([...runtime, ...typeOnly], file).not.toContain(LEGACY_RECOMMENDER);
    }
    for (const forbidden of [LEGACY_RECOMMENDER, ...LEGACY_REEXPORTERS]) {
      const typeImporters = closure.typeOnly.get(forbidden) ?? [];
      for (const importer of typeImporters) expect(TYPE_ONLY_ALLOWED, `${importer} names ${forbidden}`).toContain(importer);
    }
  });

  it('never calls its derivation or reads its policy, version or 80% threshold', () => {
    const names = /\bderiveRecommendation\b|\bstandardRecommendationPolicy\b|\brecommendQualityThresholdMilli\b|\bRECOMMENDATION_POLICY_VERSION\b|recommendation\.policy\.v1/;
    for (const file of closure.runtime.keys()) expect(read(file), file).not.toMatch(names);
  });
});

describe("cqp1's 90% is the only routing threshold", () => {
  it('is 900/1000 under cqp1, the default policy', () => {
    expect(V1_QUALIFICATION_POLICY.policyID).toBe('cqp1');
    expect(V1_QUALIFICATION_POLICY.minimumSuccessRateMilli).toBe(900);
    expect(DEFAULT_QUALIFICATION_POLICY).toBe(V1_QUALIFICATION_POLICY);
  });

  it('is kept by cqp2, which adds independence and no other threshold', () => {
    expect(V2_QUALIFICATION_POLICY.minimumSuccessRateMilli).toBe(900);
  });
});
