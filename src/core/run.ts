// Model Lab core · immutable run planning and execution records (port of `ModelLabRun`).

import { seal, compareCodePoints, isoSeconds } from './digest';
import { CandidateDescriptor, CandidateID, Measurement, descriptorDigest } from './candidate';
import { BenchmarkCaseID, BenchmarkSuite, BenchmarkSuiteID, SyntheticInputPackage, suiteDigest, validateSuite } from './benchmark';
import { RuntimeTelemetry } from './telemetry';

export type TerminalStatus =
  | 'completed' | 'failed' | 'timedOut' | 'cancelled'
  | 'unsupportedCapability' | 'candidateUnavailable' | 'malformedOutput' | 'identityMismatch';
export const ALL_TERMINAL_STATUSES: TerminalStatus[] = [
  'completed', 'failed', 'timedOut', 'cancelled', 'unsupportedCapability', 'candidateUnavailable', 'malformedOutput', 'identityMismatch',
];

export interface AttemptError { code: string; detail: string }
export interface TokenUsage { promptTokens: number; completionTokens: number }
export interface Timing {
  totalElapsedMilliseconds: Measurement<number>;
  firstTokenMilliseconds: Measurement<number>;
}

export type IdentityVerification =
  | { state: 'verifiedMatch'; reported: string }
  | { state: 'mismatch'; reported: string; declared: string }
  | { state: 'unverifiable'; reason: string };

export interface Observation {
  outputText?: string;
  structuredOutputRaw?: string;
  toolCallObservationsRaw: string[];
  terminalStatus: TerminalStatus;
  providerReportedUsage: Measurement<TokenUsage>;
  timing: Timing;
  warnings: string[];
  errors: AttemptError[];
  identityVerification: IdentityVerification;
  runtimeConfigurationID: string;
  requestDigest: string;
  runtimeTelemetry?: RuntimeTelemetry;
}

// MARK: - Environment

export interface HardwareTruth {
  architecture: Measurement<string>;
  appleSilicon: Measurement<boolean>;
  modelIdentifier: Measurement<string>;
  chipBrand: Measurement<string>;
  totalCoreCount: Measurement<number>;
  performanceCoreCount: Measurement<number>;
  efficiencyCoreCount: Measurement<number>;
  gpu: Measurement<string>;
  unifiedMemoryArchitecture: Measurement<boolean>;
  thermalStateAtCapture: Measurement<string>;
  buildConfiguration: Measurement<string>;
}

export interface EnvironmentRecord {
  machineIdentifier: Measurement<string>;
  hardwareModel: Measurement<string>;
  cpuCoreCount: Measurement<number>;
  physicalMemoryBytes: Measurement<number>;
  osVersion: Measurement<string>;
  inferenceRuntimeVersion: Measurement<string>;
  hardware?: HardwareTruth;
}

export const syntheticHardware: HardwareTruth = {
  architecture: { measured: 'synthetic-arch' },
  appleSilicon: { measured: true },
  modelIdentifier: { measured: 'synthetic-model' },
  chipBrand: { measured: 'Synthetic Chip 1' },
  totalCoreCount: { measured: 8 },
  performanceCoreCount: { measured: 4 },
  efficiencyCoreCount: { measured: 4 },
  gpu: { unavailableReason: 'synthetic profile records no GPU, exactly like a real capture' },
  unifiedMemoryArchitecture: { measured: true },
  thermalStateAtCapture: { measured: 'nominal' },
  buildConfiguration: { measured: 'debug' },
};

export const syntheticEnvironment: EnvironmentRecord = {
  machineIdentifier: { measured: 'synthetic-machine' },
  hardwareModel: { measured: 'synthetic-model' },
  cpuCoreCount: { measured: 8 },
  physicalMemoryBytes: { measured: 17_179_869_184 },
  osVersion: { measured: 'synthetic-os 1.0' },
  inferenceRuntimeVersion: { unavailableReason: 'no inference runtime is attached in Campaign 1' },
};

export const syntheticEnvironmentWithHardware: EnvironmentRecord = {
  ...syntheticEnvironment,
  inferenceRuntimeVersion: { measured: 'synthetic-runtime 1.0' },
  hardware: syntheticHardware,
};

// MARK: - Plan

export interface PlannedAttempt {
  attemptID: string;
  ordinal: number;
  candidateID: CandidateID;
  caseID: BenchmarkCaseID;
  repetitionIndex: number;
}

export interface RunPlan {
  runID: string;
  suiteID: BenchmarkSuiteID;
  suiteVersion: string;
  suiteDigest: string;
  candidates: CandidateDescriptor[];
  plannedAttempts: PlannedAttempt[];
  planDigest: string;
}
export const RUN_PLAN_SCHEMA_VERSION = 1;

export class PlanningFailure extends Error {
  constructor(public readonly code: 'emptyRunID' | 'unsafeRunID' | 'noCandidates' | 'duplicateCandidate', message: string) {
    super(message);
    this.name = 'PlanningFailure';
  }
}

const SAFE_RUN_ID = /^[\p{Lowercase}\p{N}-]+$/u;

/** Deterministic planner: validated suite × explicit candidates × repetition policy → sealed plan. */
export function planRun(runID: string, suite: BenchmarkSuite, candidates: CandidateDescriptor[]): RunPlan {
  if (runID.length === 0) throw new PlanningFailure('emptyRunID', 'run id is empty');
  if (!SAFE_RUN_ID.test(runID)) throw new PlanningFailure('unsafeRunID', `run id '${runID}' is not filesystem-safe (lowercase letters, digits, hyphens)`);
  if (candidates.length === 0) throw new PlanningFailure('noCandidates', 'no candidates selected');
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id.raw)) throw new PlanningFailure('duplicateCandidate', `candidate ${candidate.id.raw} selected twice`);
    seen.add(candidate.id.raw);
  }
  validateSuite(suite);

  const orderedCandidates = [...candidates].sort((a, b) => compareCodePoints(a.id.raw, b.id.raw));
  const attempts: PlannedAttempt[] = [];
  let ordinal = 0;
  for (const candidate of orderedCandidates) {
    for (const benchmarkCase of suite.cases) {
      for (let repetition = 0; repetition < benchmarkCase.repetitionPolicy.plannedRepetitions; repetition++) {
        attempts.push({ attemptID: `attempt:${runID}:${ordinal}`, ordinal, candidateID: candidate.id, caseID: benchmarkCase.id, repetitionIndex: repetition });
        ordinal += 1;
      }
    }
  }
  const digest = suiteDigest(suite);
  const planDigest = seal({
    runID,
    suiteDigest: digest,
    candidateDigests: orderedCandidates.map(descriptorDigest),
    attemptIDs: attempts.map((a) => a.attemptID),
  }, 'mlp1:');
  return { runID, suiteID: suite.id, suiteVersion: suite.version, suiteDigest: digest, candidates: orderedCandidates, plannedAttempts: attempts, planDigest };
}

// MARK: - Attempt record

export interface AttemptRecord {
  attemptID: string;
  runID: string;
  ordinal: number;
  repetitionIndex: number;
  candidate: CandidateDescriptor;
  candidateDigest: string;
  suiteID: BenchmarkSuiteID;
  suiteVersion: string;
  caseID: BenchmarkCaseID;
  caseDigest: string;
  inputPackage: SyntheticInputPackage;
  inputPackageDigest: string;
  scoringPolicyID: string;
  scoringPolicyVersion: string;
  environment: EnvironmentRecord;
  observation: Observation;
  terminalStatus: TerminalStatus;
  comparabilityKey: string;
  /** ISO-8601 whole seconds. */
  startedAt: string;
  finishedAt: string;
}
export const ATTEMPT_SCHEMA_VERSION = 1;

// MARK: - Derived score

export interface DerivedScoreRecord {
  scoreID: string;
  attemptID: string;
  evaluatorID: string;
  evaluatorVersion: string;
  scoringPolicyID: string;
  scoringPolicyVersion: string;
  categoryMetricsMilli: Record<string, Record<string, number>>;
  governanceOutcomes: string[];
  notes: string[];
  evaluatedAt: string;
}
export const DERIVED_SCORE_SCHEMA_VERSION = 1;

export function makeDerivedScore(fields: Omit<DerivedScoreRecord, 'scoreID'>): DerivedScoreRecord {
  return { scoreID: `score:${fields.attemptID}:${fields.evaluatorID}:${fields.evaluatorVersion}`, ...fields };
}

// MARK: - Summary

export type RunState = 'planned' | 'completed' | 'incomplete' | 'cancelled';
export interface RunSummary {
  runID: string;
  planDigest: string;
  state: RunState;
  plannedAttemptCount: number;
  recordedAttemptCount: number;
  statusCounts: Record<string, number>;
  completedAt: string;
}
export const RUN_SUMMARY_SCHEMA_VERSION = 1;

/** Oldest first: startedAt ascending, then attemptID ascending (total order). */
export function attemptOrderAscending(a: AttemptRecord, b: AttemptRecord): number {
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareCodePoints(a.attemptID, b.attemptID);
}

export { isoSeconds };
