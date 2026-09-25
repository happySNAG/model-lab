// Cernum core · versioned, immutable benchmark-case specification (port of `ModelLabBenchmark`).

import { fnv1a64Hex, seal, compareCodePoints } from './digest';
import { graphemeCount } from './text';
import { ConfigurationEntry, RequiredCapability, sortedStrings } from './candidate';

export interface BenchmarkCaseID { raw: string }
export interface BenchmarkSuiteID { raw: string }

export type MessageRole = 'system' | 'user';
export interface BenchmarkMessage { role: MessageRole; content: string }
export type InputPrivacyClassification = 'synthetic' | 'suppliedFixture';

export interface SyntheticInputPackage {
  origin: string;
  messages: BenchmarkMessage[];
  syntheticContext?: string;
}
export const SYNTHETIC_CONTEXT_MAX_CHARACTERS = 4_000;

export function packageDigest(inputs: SyntheticInputPackage): string {
  return seal(inputs, 'mlip1:');
}

export interface GenerationSettings {
  temperatureMilli?: number;
  topPMilli?: number;
  maxOutputTokens?: number;
  seed?: number;
  stopSequences: string[];
}
export function generationSettings(fields: Partial<GenerationSettings> = {}): GenerationSettings {
  return {
    temperatureMilli: fields.temperatureMilli,
    topPMilli: fields.topPMilli,
    maxOutputTokens: fields.maxOutputTokens,
    seed: fields.seed,
    stopSequences: fields.stopSequences ?? [],
  };
}

export type ResponseFormat = 'plainText' | 'json';
export type ExpectedReferenceKind = 'containsText' | 'jsonWithKeys' | 'evaluatorReference';
export interface ExpectedReference { kind: ExpectedReferenceKind; value: string }
export interface RepetitionPolicy { plannedRepetitions: number }

export interface BenchmarkCase {
  id: BenchmarkCaseID;
  suiteID: BenchmarkSuiteID;
  suiteVersion: string;
  category: string;
  capabilityUnderTest: string;
  inputs: SyntheticInputPackage;
  requiredCapabilities: RequiredCapability[];
  setupMetadata: ConfigurationEntry[];
  generationSettings: GenerationSettings;
  responseFormat: ResponseFormat;
  executionBudgetMilliseconds: number;
  expectedReference?: ExpectedReference;
  privacyClassification: InputPrivacyClassification;
  repetitionPolicy: RepetitionPolicy;
  scoringPolicyID: string;
  scoringPolicyVersion: string;
  resourceBudgetID: string;
  tags: string[];
  provenance: string;
}

export interface BenchmarkCaseInput extends Omit<BenchmarkCase, 'setupMetadata'> {
  setupMetadata: Record<string, string>;
}

/** The Swift initializer's normalization: sorted capabilities, sorted metadata, sorted tags. */
export function makeCase(input: BenchmarkCaseInput): BenchmarkCase {
  return {
    ...input,
    requiredCapabilities: sortedStrings(input.requiredCapabilities),
    setupMetadata: Object.keys(input.setupMetadata)
      .map((key) => ({ key, value: input.setupMetadata[key] }))
      .sort((a, b) => compareCodePoints(a.key, b.key)),
    tags: sortedStrings(input.tags),
  };
}

export function caseDigest(c: BenchmarkCase): string {
  return seal(c, 'mlb1:');
}

/** `mlk1:` — results are directly comparable only when every component matches. */
export function comparabilityKey(c: BenchmarkCase): string {
  const basis = [c.suiteID.raw, c.suiteVersion, c.id.raw, caseDigest(c), c.scoringPolicyID, c.scoringPolicyVersion, c.responseFormat].join('|');
  return 'mlk1:' + fnv1a64Hex(basis);
}

export interface BenchmarkSuite {
  id: BenchmarkSuiteID;
  version: string;
  title: string;
  cases: BenchmarkCase[];
}

export function makeSuite(id: string, version: string, title: string, cases: BenchmarkCase[]): BenchmarkSuite {
  return { id: { raw: id }, version, title, cases: [...cases].sort((a, b) => compareCodePoints(a.id.raw, b.id.raw)) };
}

export function suiteDigest(suite: BenchmarkSuite): string {
  const basis = suite.cases.map(caseDigest).join('|');
  return 'mls1:' + fnv1a64Hex([suite.id.raw, suite.version, basis].join('||'));
}

// MARK: - Validation (fail-closed; the whole suite is refused on the first problem)

export class BenchmarkValidationFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BenchmarkValidationFailure';
  }
}

export function validateSuite(suite: BenchmarkSuite): void {
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (seen.has(c.id.raw)) throw new BenchmarkValidationFailure('duplicateCaseID', `duplicate case id ${c.id.raw}`);
    seen.add(c.id.raw);
    if (c.suiteID.raw !== suite.id.raw) {
      throw new BenchmarkValidationFailure('caseOutsideSuite', `case ${c.id.raw} declares suite ${c.suiteID.raw} inside suite ${suite.id.raw}`);
    }
    if (c.suiteVersion !== suite.version) {
      throw new BenchmarkValidationFailure('suiteVersionMismatch', `case ${c.id.raw} declares version ${c.suiteVersion}, suite is ${suite.version}`);
    }
    const origin = c.inputs.origin;
    if (!(origin.startsWith('synthetic:') || origin.startsWith('fixture:'))) {
      throw new BenchmarkValidationFailure('forbiddenInputOrigin', `case ${c.id.raw} input origin '${origin}' is not synthetic: or fixture: — refused (no live data)`);
    }
    if (c.inputs.messages.length === 0) throw new BenchmarkValidationFailure('emptyMessages', `case ${c.id.raw} has no messages`);
    if (c.inputs.syntheticContext !== undefined && graphemeCount(c.inputs.syntheticContext) > SYNTHETIC_CONTEXT_MAX_CHARACTERS) {
      throw new BenchmarkValidationFailure('syntheticContextOverBound',
        `case ${c.id.raw} synthetic context ${graphemeCount(c.inputs.syntheticContext)} chars exceeds bound ${SYNTHETIC_CONTEXT_MAX_CHARACTERS}`);
    }
    if (c.repetitionPolicy.plannedRepetitions < 1) throw new BenchmarkValidationFailure('nonPositiveRepetitions', `case ${c.id.raw} plans zero repetitions`);
    if (c.executionBudgetMilliseconds < 1) throw new BenchmarkValidationFailure('nonPositiveBudget', `case ${c.id.raw} has no positive execution budget`);
    if (c.scoringPolicyID.length === 0 || c.scoringPolicyVersion.length === 0) {
      throw new BenchmarkValidationFailure('emptyScoringPolicy', `case ${c.id.raw} names no scoring policy`);
    }
  }
}
