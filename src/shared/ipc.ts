// Model Lab · the contract between the renderer and the main process. Every value that crosses the
// bridge is plain JSON. Record types are the portable core's own record types.

import type { AttemptRecord, RunPlan, RunSummary, EnvironmentRecord, DerivedScoreRecord } from '../core/run';
import type { EvaluationRecord, CapabilityDimension } from '../core/evaluation';
import type { CandidateDescriptor, Measurement } from '../core/candidate';
import type { OwnerRecommendationRecord, RecommendationPolicy } from '../core/recommendation';
import type { CapabilityProfile } from '../core/profile';
import type { RunOverview } from '../core/history';
import type { ThinkingMode, OllamaInstalledModel } from '../core/ollama';
import type { StoreIntegrity } from '../core/store';
import type { ComparabilityReason } from '../core/comparability';

export interface Settings {
  ollamaEndpoint: string;
  thinkingMode: ThinkingMode;
  /** Optional override of the evidence store root (absolute path). Empty = default under user data. */
  evidenceRootOverride: string;
}

export interface BuildInfo {
  productName: string;
  version: string;
  commit: string;
  builtAt: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  userDataPath: string;
  evidenceRoot: string;
  logPath: string;
}

export type OllamaState = 'running' | 'installedNotRunning' | 'notInstalled' | 'unreachable';

export interface OllamaStatus {
  state: OllamaState;
  endpoint: string;
  endpointValid: boolean;
  endpointProblem?: string;
  version?: string;
  executablePath?: string;
  detail: string;
  checkedAt: string;
}

export interface MachineSummary {
  environment: EnvironmentRecord;
  hostname: string;
  platformLabel: string;
  cpuLabel: string;
  memoryLabel: string;
  gpuLabel: string;
  capturedAt: string;
}

export interface ModelRow {
  /** The stable key the UI uses; for Ollama models this is the runtime's model name. */
  key: string;
  kind: 'ollama' | 'reference';
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  digest?: string;
  modifiedAt?: string;
  /** Readiness as the lab sees it. */
  readiness: 'ready' | 'needsRuntime' | 'referenceOnly';
  readinessDetail: string;
  runsInHistory: number;
}

export interface SuiteRow {
  id: string;
  version: string;
  title: string;
  /** Plain-language summary for people who did not build the lab. */
  summary: string;
  dimension: string;
  caseCount: number;
  plannedAttemptsPerModel: number;
  cases: { id: string; capability: string; responseFormat: string; repetitions: number; budgetMilliseconds: number; maxOutputTokens?: number; governance: boolean }[];
}

export interface BenchmarkConfiguration {
  label: string;
  suiteIDs: string[];
  modelKeys: string[];
  thinkingMode: ThinkingMode;
}

export interface BenchmarkPreflight {
  ok: boolean;
  problems: string[];
  totalAttempts: number;
  attemptsPerModel: number;
  estimatedMaxMinutes: number;
  models: { key: string; name: string; kind: 'ollama' | 'reference' }[];
  suites: { id: string; title: string; caseCount: number }[];
  endpoint: string;
  statements: string[];
}

export type SessionState = 'running' | 'completed' | 'cancelled' | 'incomplete' | 'failed';

export interface SessionRecord {
  sessionID: string;
  label: string;
  createdAt: string;
  finishedAt?: string;
  state: SessionState;
  suiteIDs: string[];
  runIDs: string[];
  candidates: CandidateDescriptor[];
  modelKeys: string[];
  thinkingMode: ThinkingMode;
  endpoint: string;
  machine: MachineSummary;
  runtimeVersion?: string;
  failureDetail?: string;
}

export interface AttemptProgress {
  attemptID: string;
  runID: string;
  candidateID: string;
  modelName: string;
  caseID: string;
  terminalStatus?: AttemptRecord['terminalStatus'];
  evaluationStatus?: EvaluationRecord['verdict']['status'];
  governanceViolated?: boolean;
  elapsedMilliseconds?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface SessionProgress {
  sessionID: string;
  state: SessionState;
  startedAt: string;
  totalAttempts: number;
  recordedAttempts: number;
  currentRunIndex: number;
  totalRuns: number;
  currentSuiteTitle?: string;
  currentModelName?: string;
  currentCaseID?: string;
  currentAttemptStartedAt?: string;
  statusCounts: Record<string, number>;
  perModel: { candidateID: string; modelName: string; planned: number; recorded: number; completed: number; failed: number; timedOut: number; governanceFailures: number }[];
  recent: AttemptProgress[];
  failureDetail?: string;
}

export interface ModelResult {
  candidate: CandidateDescriptor;
  modelName: string;
  rank: number;
  disqualified: boolean;
  governanceFailures: number;
  qualityRateMilli: Measurement<number>;
  passCount: number;
  partialCount: number;
  failCount: number;
  humanReviewCount: number;
  notApplicableCount: number;
  plannedAttempts: number;
  recordedAttempts: number;
  answeredAttempts: number;
  reliabilityMilli: Measurement<number>;
  medianLatencyMilliseconds: Measurement<number>;
  meanLatencyMilliseconds: Measurement<number>;
  p95LatencyMilliseconds: Measurement<number>;
  medianTokensPerSecondMilli: Measurement<number>;
  timeoutCount: number;
  errorCount: number;
  terminalStatusCounts: Record<string, number>;
  profile: CapabilityProfile;
  strengths: string[];
  weaknesses: string[];
}

export interface CaseResultRow {
  attemptID: string;
  runID: string;
  candidateID: string;
  modelName: string;
  suiteID: string;
  caseID: string;
  capability: string;
  terminalStatus: AttemptRecord['terminalStatus'];
  evaluationStatus?: EvaluationRecord['verdict']['status'];
  governance?: EvaluationRecord['verdict']['governance'];
  dimension?: CapabilityDimension;
  latencyMilliseconds: Measurement<number>;
  tokensPerSecondMilli: Measurement<number>;
}

export interface SessionResults {
  session: SessionRecord;
  models: ModelResult[];
  dimensions: CapabilityDimension[];
  cases: CaseResultRow[];
  recommendation: { candidateID: string; modelName: string; record: OwnerRecommendationRecord; recorded: boolean }[];
  recommendationPolicy: RecommendationPolicy;
  workloadSummary: string;
  runSummaries: RunSummary[];
}

export interface AttemptDetail {
  attempt: AttemptRecord;
  evaluations: EvaluationRecord[];
  scores: DerivedScoreRecord[];
  caseCapability?: string;
  policyGuidance?: string;
}

export interface HistoryEntry {
  session?: SessionRecord;
  runs: RunOverview[];
  createdAt: string;
  label: string;
  modelNames: string[];
  suiteTitles: string[];
  state: string;
  attemptCount: number;
  governanceFailureCount: number;
}

export interface SessionComparison {
  a: SessionResults;
  b: SessionResults;
  sharedModelNames: string[];
  directlyComparable: boolean;
  reasons: ComparabilityReason[];
  perModel: { modelName: string; qualityA: Measurement<number>; qualityB: Measurement<number>; latencyA: Measurement<number>; latencyB: Measurement<number>; governanceA: number; governanceB: number }[];
}

export interface Diagnostics {
  build: BuildInfo;
  settings: Settings;
  machine: MachineSummary;
  ollama: OllamaStatus;
  integrity: StoreIntegrity;
  runCount: number;
  sessionCount: number;
  evidenceRoot: string;
  catalog: { suites: number; cases: number; policies: number; catalogDigest: string };
}

export interface PullProgress { model: string; status: string; completedBytes?: number; totalBytes?: number; done: boolean; error?: string }


// MARK: - Benchmark engine (campaigns)
//
// A campaign is the engine's unit of work: a frozen manifest plus a durable ledger, drivable from
// the desktop application or the `cernum` terminal command. These types are the projection the
// renderer sees; the engine's own richer records stay in the main process.

export type CampaignRowState = 'created' | 'running' | 'paused' | 'aborted' | 'complete' | 'unreadable';

export interface CampaignRow {
  name: string;
  label: string;
  state: CampaignRowState;
  slotCount: number;
  terminalCount: number;
  blockedCount: number;
  /** False when the ledger does not account for every slot exactly once. */
  balances: boolean;
  manifestID: string;
  createdAt: string;
  /** True only while THIS process is the runner; a terminal-driven campaign is observed, not owned. */
  running: boolean;
  directory: string;
  problem?: string;
}

export interface CampaignAttemptRow {
  slotKey: string;
  status: string;
  detail: string;
  latencyMilliseconds?: number;
  identityState: string;
  suppliedContextState: string;
}

export interface CampaignRankingRow {
  rank: number;
  candidate: string;
  disqualified: boolean;
  /** Passes per thousand scored outcomes. Absent means no rate at all — never a zero. */
  passRateMilli?: number;
  scoredCount: number;
  roles: string[];
}

export interface CampaignDetail {
  status: {
    campaignID: string; label: string; state: string; manifestID: string; manifestSeal: string;
    slotCount: number; terminalCount: number; remaining: number; blockedCount: number;
    byStatus: Record<string, number>; candidatesComplete: string[];
    currentCandidate?: string; currentCaseID?: string;
    standingAbort?: { reason: string; stage: string; blockedSlotCount: number };
    root: string;
  };
  manifest: { manifestID: string; seal: string; frozenAt: string; promptCount: number; candidateCount: number; retestOf?: string };
  recentAttempts: CampaignAttemptRow[];
  events: { kind: string; at: string }[];
  anomalies: { kind: string; why: string }[];
  report?: {
    provisional: boolean;
    provisionalBecause: string[];
    rankings: CampaignRankingRow[];
    retentionHeading: string;
    retention: { candidate: string; outcome: string; statement: string }[];
    awaitingHumanReview: number;
    packetPath?: string;
    packetClean?: boolean;
  };
  /** The exact terminal command that shows the same campaign. */
  terminalHint: string;
}

export interface CampaignCreateRequest {
  name: string;
  label: string;
  modelNames: string[];
  suiteIDs: string[];
  repeatsPerCase: number;
  runtimeVersion: string;
}

export interface CampaignDrift { field: string; frozen: string; observed: string; meaning: string }
export interface CampaignVerification { manifestID: string; verifiedAt: string; intact: boolean; drifts: CampaignDrift[]; hardwareOnly: boolean }

export interface CampaignProgressEvent {
  status: CampaignDetail['status'];
  trace?: { slotKey: string; status: string; identity: string; suppliedContext: string; detail: string };
}

export interface ModelLabAPI {
  getBuildInfo(): Promise<BuildInfo>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  getMachine(refresh?: boolean): Promise<MachineSummary>;
  getOllamaStatus(): Promise<OllamaStatus>;
  startOllama(): Promise<OllamaStatus>;
  openOllamaDownload(): Promise<void>;
  listModels(): Promise<ModelRow[]>;
  pullModel(model: string): Promise<void>;
  cancelPull(): Promise<void>;
  listSuites(): Promise<SuiteRow[]>;
  preflight(configuration: BenchmarkConfiguration): Promise<BenchmarkPreflight>;
  startBenchmark(configuration: BenchmarkConfiguration): Promise<SessionRecord>;
  cancelBenchmark(): Promise<void>;
  getActiveProgress(): Promise<SessionProgress | undefined>;
  listSessions(): Promise<SessionRecord[]>;
  getSessionResults(sessionID: string): Promise<SessionResults>;
  getAttemptDetail(attemptID: string): Promise<AttemptDetail>;
  recordRecommendation(sessionID: string, candidateID: string): Promise<OwnerRecommendationRecord>;
  getHistory(): Promise<HistoryEntry[]>;
  compareSessions(sessionA: string, sessionB: string): Promise<SessionComparison>;
  getDiagnostics(): Promise<Diagnostics>;
  exportEvidence(): Promise<{ path?: string; digest?: string; cancelled: boolean }>;
  openPath(path: string): Promise<void>;
  /** Reveals a file in Finder / Explorer (selects it) rather than opening it. */
  revealPath(path: string): Promise<void>;
  /** Copies the diagnostics report (the same values the Settings screen shows) to the clipboard as JSON. */
  copyDiagnostics(): Promise<void>;
  onProgress(listener: (progress: SessionProgress) => void): () => void;
  onPullProgress(listener: (progress: PullProgress) => void): () => void;
  onOllamaStatus(listener: (status: OllamaStatus) => void): () => void;
  /** Navigation requests from the application menu (macOS menu bar / Windows accelerators). */
  onNavigate(listener: (screen: ScreenID) => void): () => void;

  // Benchmark engine. The same campaigns the `cernum` terminal command drives.
  listCampaigns(): Promise<CampaignRow[]>;
  campaignDetail(name: string): Promise<CampaignDetail>;
  campaignSuites(): Promise<{ id: string; title: string; caseCount: number }[]>;
  createCampaign(request: CampaignCreateRequest): Promise<CampaignRow[]>;
  startCampaign(name: string): Promise<CampaignDetail['status']>;
  pauseCampaign(): Promise<void>;
  verifyCampaign(name: string): Promise<CampaignVerification>;
  finalizeCampaign(name: string): Promise<CampaignDetail>;
  campaignRoot(): Promise<string>;
  onCampaignProgress(listener: (event: CampaignProgressEvent) => void): () => void;
  /** The host platform, so copy can say "this Mac" / "this PC" truthfully. Fixed for the process lifetime. */
  readonly platform: 'darwin' | 'win32' | 'linux' | string;
}

export type ScreenID = 'home' | 'models' | 'benchmark' | 'live' | 'results' | 'campaigns' | 'history' | 'settings';
export const SCREEN_ORDER: ScreenID[] = ['home', 'models', 'benchmark', 'live', 'results', 'campaigns', 'history', 'settings'];

export const IPC = {
  buildInfo: 'lab:buildInfo',
  getSettings: 'lab:getSettings',
  saveSettings: 'lab:saveSettings',
  getMachine: 'lab:getMachine',
  ollamaStatus: 'lab:ollamaStatus',
  startOllama: 'lab:startOllama',
  openOllamaDownload: 'lab:openOllamaDownload',
  listModels: 'lab:listModels',
  pullModel: 'lab:pullModel',
  cancelPull: 'lab:cancelPull',
  listSuites: 'lab:listSuites',
  preflight: 'lab:preflight',
  startBenchmark: 'lab:startBenchmark',
  cancelBenchmark: 'lab:cancelBenchmark',
  activeProgress: 'lab:activeProgress',
  listSessions: 'lab:listSessions',
  sessionResults: 'lab:sessionResults',
  attemptDetail: 'lab:attemptDetail',
  recordRecommendation: 'lab:recordRecommendation',
  history: 'lab:history',
  compareSessions: 'lab:compareSessions',
  diagnostics: 'lab:diagnostics',
  exportEvidence: 'lab:exportEvidence',
  openPath: 'lab:openPath',
  revealPath: 'lab:revealPath',
  copyDiagnostics: 'lab:copyDiagnostics',
  eventProgress: 'lab:event:progress',
  eventPull: 'lab:event:pull',
  eventOllama: 'lab:event:ollama',
  eventNavigate: 'lab:event:navigate',
  listCampaigns: 'lab:campaign:list',
  campaignDetail: 'lab:campaign:detail',
  campaignSuites: 'lab:campaign:suites',
  createCampaign: 'lab:campaign:create',
  startCampaign: 'lab:campaign:start',
  pauseCampaign: 'lab:campaign:pause',
  verifyCampaign: 'lab:campaign:verify',
  finalizeCampaign: 'lab:campaign:finalize',
  campaignRoot: 'lab:campaign:root',
  eventCampaign: 'lab:event:campaign',
} as const;

/**
 * The title a suite is shown under in the interface.
 *
 * The benchmark suites are sealed, versioned fixtures: their stored titles are part of the record
 * that every result is judged against and can never be edited without invalidating the evidence
 * already on disk. A few of them still carry the prefix of the project this engine was first built
 * for. This one function is the single place that turns a stored title into a displayed one, so the
 * sealed record stays byte-exact while the interface reads as Model Lab's own.
 */
export function displaySuiteTitle(storedTitle: string): string {
  return storedTitle.replace(/^(Skippy|Model Lab) /, '');
}

/**
 * The name a candidate model is shown under in the interface.
 *
 * Like suite titles, candidate descriptors are sealed records: the built-in reference model's stored
 * name is part of every result already written to disk and cannot be edited. Its stored name uses the
 * word the engine's tests use for a scripted adapter; this presents it in the product's own language.
 * Only the display name is affected — results, history and comparisons key off the model identity
 * (`exactModelIdentity`), never off this string.
 */
export function displayModelName(storedName: string): string {
  return storedName === 'Deterministic Reference Fake' ? 'Deterministic Reference Model' : storedName;
}
