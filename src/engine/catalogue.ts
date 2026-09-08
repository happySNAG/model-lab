// Benchmark engine · the one place the portable core's sealed suites are turned into the shapes the
// campaign machinery needs: a plannable catalogue, a prompt set to freeze, and a scored core.
//
// The suites themselves are NOT re-authored here. They are read exactly as `src/core/catalog.ts`
// defines them, and every digest carried forward (`caseDigest`, `comparabilityKey`) is the core's
// own — so a case that already has evidence on disk keeps the identity that evidence was written
// against. This module only projects; it never edits.

import { BenchmarkCase, BenchmarkSuite, caseDigest, comparabilityKey } from '../core/benchmark';
import { CapabilityDimension } from '../core/evaluation';
import { allEvaluatorProfiles } from '../core/evaluators';
import { policyCatalog, registeredSuites, suiteByID } from '../core/catalog';
import { CanonicalValue, digestObject, sha256Text } from './canonical';
import { PlannableCatalog, PlannableSuite } from './ledger';
import { PromptRecord, ScoredCoreEntry } from './manifest';

/** The suite a case belongs to decides the dimension its outcomes are counted under. */
const SUITE_DIMENSIONS: Record<string, CapabilityDimension> = {
  'suite.model-lab.foundation': 'contextIntegration',
  'suite.model-lab.foundation-v2': 'contextIntegration',
  'suite.model-lab.conversation': 'conversation',
  'suite.model-lab.memory-honesty': 'memoryHonesty',
  'suite.model-lab.context-integration': 'contextIntegration',
  'suite.model-lab.calendar-reasoning': 'calendarReasoning',
  'suite.model-lab.emotional-understanding': 'emotionalUnderstanding',
  'suite.model-lab.privacy-governance': 'privacyAndGovernance',
  'suite.model-lab.hallucination-resistance': 'hallucinationResistance',
  'suite.model-lab.tool-use': 'toolUse',
  'suite.model-lab.planning': 'planning',
  'suite.model-lab.long-context-retrieval': 'longContextRetrieval',
  'suite.model-lab.safety-boundaries': 'safetyBoundaries',
  'suite.model-lab.structured-output': 'structuredOutputReliability',
};
/** The dimension a case counts under, or undefined when the suite is not one this engine ranks. */
export function dimensionForSuite(suiteID: string): CapabilityDimension | undefined {
  return SUITE_DIMENSIONS[suiteID];
}

/** The full request text, in the order the model receives it. This is what the manifest freezes. */
export function promptTextOf(benchmarkCase: BenchmarkCase): string {
  return benchmarkCase.inputs.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

export function promptRecordOf(benchmarkCase: BenchmarkCase): PromptRecord {
  return {
    caseID: benchmarkCase.id.raw,
    text: promptTextOf(benchmarkCase),
    suppliedContext: benchmarkCase.inputs.syntheticContext,
  };
}

/** `plainText` / `json` is the shape the scorer must enforce; it is bound into the scored core. */
function scoringModeOf(benchmarkCase: BenchmarkCase): string {
  return `${benchmarkCase.responseFormat}:${benchmarkCase.scoringPolicyID}@${benchmarkCase.scoringPolicyVersion}`;
}

export function scoredCoreEntryOf(benchmarkCase: BenchmarkCase): Omit<ScoredCoreEntry, 'promptSHA256'> {
  return {
    caseID: benchmarkCase.id.raw,
    caseDigest: caseDigest(benchmarkCase),
    comparabilityKey: comparabilityKey(benchmarkCase),
    scoringMode: scoringModeOf(benchmarkCase),
    maxOutputTokens: benchmarkCase.generationSettings.maxOutputTokens ?? 0,
  };
}

export interface EngineCatalogue {
  plannable: PlannableCatalog;
  prompts: PromptRecord[];
  scoredCore: Omit<ScoredCoreEntry, 'promptSHA256'>[];
  /** caseID -> the case itself, so the runner never has to search for one. */
  cases: Map<string, BenchmarkCase>;
  /** caseID -> the dimension it is counted under. */
  dimensions: Map<string, CapabilityDimension>;
  suites: BenchmarkSuite[];
}

/**
 * Project a chosen set of suites into everything the campaign needs.
 *
 * `repeatsPerCase` multiplies every case; the core's own per-case `plannedRepetitions` is a
 * different knob (it repeats a case within one run plan) and is deliberately not conflated with it.
 * The engine's repeats exist so a cohort can be measured for consistency across passes.
 */
export function buildEngineCatalogue(suiteIDs: string[], repeatsPerCase: number): EngineCatalogue {
  if (repeatsPerCase < 1) throw new Error('repeatsPerCase must be at least 1; a campaign that runs no passes measures nothing');
  const suites = suiteIDs.map((id) => {
    const suite = suiteByID(id);
    if (!suite) throw new Error(`no suite ${id} in the catalogue; the engine plans only from sealed suites`);
    return suite;
  });
  if (suites.length === 0) throw new Error('no suites selected; a campaign over zero suites has nothing to measure');

  const cases = new Map<string, BenchmarkCase>();
  const dimensions = new Map<string, CapabilityDimension>();
  const prompts: PromptRecord[] = [];
  const scoredCore: Omit<ScoredCoreEntry, 'promptSHA256'>[] = [];

  const plannableSuites: PlannableSuite[] = suites.map((suite, suiteIndex) => ({
    slug: suite.id.raw,
    block: dimensionForSuite(suite.id.raw) ?? 'unranked',
    executionOrdinal: suiteIndex,
    cases: suite.cases.map((benchmarkCase, caseIndex) => {
      cases.set(benchmarkCase.id.raw, benchmarkCase);
      const dimension = dimensionForSuite(suite.id.raw);
      if (dimension) dimensions.set(benchmarkCase.id.raw, dimension);
      prompts.push(promptRecordOf(benchmarkCase));
      const entry = scoredCoreEntryOf(benchmarkCase);
      scoredCore.push(entry);
      return {
        ...entry,
        inputBudgetTokens: benchmarkCase.inputs.syntheticContext?.length ?? 0,
        executionOrdinal: caseIndex,
      };
    }),
  }));

  const caseCount = plannableSuites.reduce((sum, suite) => sum + suite.cases.length, 0);
  const plannable: PlannableCatalog = {
    // The catalogue digest binds the suites, their versions and every case digest — so a case that
    // changed under a suite that did not is still visible.
    catalogDigest: digestObject(plannableSuites.map((suite) => ({
      slug: suite.slug,
      cases: suite.cases.map((c) => ({ caseID: c.caseID, caseDigest: c.caseDigest, scoringMode: c.scoringMode, maxOutputTokens: c.maxOutputTokens })),
    })) as unknown as CanonicalValue),
    caseCount,
    repeatsPerCase,
    suites: plannableSuites,
  };

  return { plannable, prompts, scoredCore, cases, dimensions, suites };
}

/**
 * The evaluator bindings the manifest freezes.
 *
 * An evaluator's "source" here is its declared profile — id, version, method and the criteria it
 * judges under — not its TypeScript text. Hashing the source file would bind the build rather than
 * the behaviour, and would drift on every unrelated edit; hashing the declared profile binds the
 * thing that actually decides a verdict.
 */
export function evaluatorBindings(): { evaluatorID: string; source: string }[] {
  const profiles = allEvaluatorProfiles.map((profile) => ({
    evaluatorID: profile.evaluatorID,
    source: digestObject(profile as unknown as CanonicalValue),
  }));
  const policies = policyCatalog.policies.map((policy) => ({
    evaluatorID: `policy:${policy.id}@${policy.version}`,
    source: sha256Text(digestObject(policy as unknown as CanonicalValue)),
  }));
  return [...profiles, ...policies].sort((a, b) => (a.evaluatorID < b.evaluatorID ? -1 : 1));
}

export function allRankableSuiteIDs(): string[] {
  return registeredSuites.map((suite) => suite.id.raw).filter((id) => dimensionForSuite(id) !== undefined);
}
