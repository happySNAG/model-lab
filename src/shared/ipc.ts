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
  /**
   * The process that holds the campaign's cross-process lock, when one does. This is how the screen
   * can say "a terminal is running this" rather than showing a campaign as idle while it advances.
   */
  owner?: CampaignOwnerRow;
  /** The frozen execution policy. Present so the list can mark an observe-only campaign at a glance. */
  execution?: CampaignExecutionRow;
  /** Who answers this campaign's candidates. Absent on a campaign that bound no providers. */
  providers?: string[];
  /** True when candidates were reached through more than one execution class. */
  mixedExecution?: boolean;
  /** True when at least one candidate is billed per token. */
  hasMeteredBinding?: boolean;
  /** 3 for a Pass 3 campaign; 4 for one that bound its providers. */
  manifestFormatVersion?: number;
}

export interface CampaignOwnerRow {
  processType: 'desktop' | 'terminal';
  command: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  state: 'live' | 'selfHeld' | 'stale' | 'unresponsive' | 'foreignHost';
  message: string;
}

/**
 * The installed terminal command, as the Campaigns screen sees it.
 *
 * Installing is a user-controlled action that writes ONE file into a directory the user already
 * owns. Nothing here edits PATH, a shell profile or a privileged directory, and the uninstall
 * removes exactly the file the install wrote.
 */
export interface TerminalCommandRow {
  command: string;
  supported: boolean;
  launcherPath?: string;
  launcherReason?: string;
  installDirectory: string;
  installPath: string;
  installed: boolean;
  installedIsOurs: boolean;
  installedPointsHere: boolean;
  directoryOnPath: boolean;
  pathHint: string;
  message: string;
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
  execution: CampaignExecutionRow;
  manifest: { manifestID: string; seal: string; frozenAt: string; promptCount: number; candidateCount: number; retestOf?: string };
  recentAttempts: CampaignAttemptRow[];
  events: { kind: string; at: string }[];
  anomalies: { kind: string; why: string }[];
  report?: {
    canonical: boolean;
    noncanonicalBecause: string[];
    provisional: boolean;
    provisionalBecause: string[];
    rankings: CampaignRankingRow[];
    retentionHeading: string;
    retention: { candidate: string; outcome: string; statement: string }[];
    awaitingHumanReview: number;
    packetPath?: string;
    packetClean?: boolean;
  };
  /** One row per candidate: who answers it, at what effort, on whose bill, and how sure we are. */
  bindings: {
    candidate: string; provider: string; providerLabel: string; executionClass: string; billingBasis: string;
    requestedModelID: string; verifiedModelID: string; identityState: string; identityEvidence: string;
    effort: string; thinkingMode: string; maxInputTokens: number; maxOutputTokens: number;
    timeoutMilliseconds: number; maxRetries: number; summary: string;
    pricing?: { source: string; capturedAt: string; inputMicroUSDPerMillionTokens: number; outputMicroUSDPerMillionTokens: number };
  }[];
  /** Empty unless candidates were reached through more than one execution class. */
  mixedExecutionBecause: string[];
  /** Tokens, speed and cost with provenance. Empty until the campaign has been finalized. */
  frontierMetrics: FrontierMetricsRow[];
  spending?: CampaignSpendingRow;
  manifestFormatVersion: number;
  /** The exact terminal command that shows the same campaign. */
  terminalHint: string;
}

// MARK: - Providers
//
// Five providers, three execution classes, and the renderer is never allowed to forget which is
// which: every row carries its execution class and billing basis, because "Claude answered" means
// three different things about cost and latency depending on how it was reached.

export type ProviderReachability = 'unknown' | 'ready' | 'notInstalled' | 'notAuthenticated' | 'noCredential' | 'unreachable';

export interface FrontierModelRow {
  provider: string;
  modelID: string;
  displayName: string;
  /** `proven` is the only value a campaign may select. `unproven` is a plan; `refused` is a no. */
  availability: 'proven' | 'unproven' | 'refused';
  evidence: string;
  /** The identifier the provider itself returned. Empty means it returned none. */
  verifiedModelID: string;
  desiredEfforts: string[];
}

export interface ProviderStatusRow {
  provider: string;
  label: string;
  executionClass: 'localRuntime' | 'subscriptionCLI' | 'meteredAPI';
  billingBasis: string;
  reachability: ProviderReachability;
  detail: string;
  /**
   * Whether producing this row contacted anything.
   *
   * Rendered, not merely carried: a person looking at a status screen is entitled to know whether
   * opening it cost them a request, and the answer on this screen is always `offline`.
   */
  probe: 'offline' | 'invoked';
  executablePath?: string;
  version?: string;
  credential?: { environmentVariable: string; keychainService: string; masked: string; present: boolean; remedy: string };
  models: FrontierModelRow[];
  checkedAt: string;
}

/** What one campaign is expected to cost, before it is created or run. */
export interface CostPreviewRow {
  estimable: boolean;
  notEstimableBecause: string[];
  perCandidate: { candidate: string; billingBasis: string; plannedAttempts: number; minimumMicroUSD: number; maximumMicroUSD: number; statement: string }[];
  totalMinimumMicroUSD: number;
  totalMaximumMicroUSD: number;
  meteredCandidateCount: number;
  subscriptionCandidateCount: number;
  localCandidateCount: number;
  oldestPricingCapturedAt: string | null;
  /** The sentences a person reads before approving. Authored in the engine; quoted here verbatim. */
  disclosure: string[];
  /** Prompts leave this machine for these providers. Shown before the run, once. */
  privacyDisclosure: string[];
}

/** A frontier candidate as the New-campaign dialog submits it. */
export interface FrontierCandidateSelection {
  provider: string;
  modelID: string;
  effort: 'none' | 'low' | 'medium' | 'high' | 'max';
  thinkingMode?: 'disabled' | 'enabled' | 'runtimeDefault';
  /** Required for a metered provider. Supplied by a person; Cernum never fetches a price. */
  pricing?: {
    source: string; capturedAt: string;
    inputMicroUSDPerMillionTokens: number; outputMicroUSDPerMillionTokens: number;
    reasoningMicroUSDPerMillionTokens?: number | null;
  };
}

/** Tokens, speed and cost for one candidate, each figure carrying how it was obtained. */
export interface FrontierMetricsRow {
  candidate: string;
  provider: string;
  executionClass: string;
  billingBasis: string;
  attemptCount: number;
  successfulTaskCount: number;
  successfulTaskRateMilli?: number;
  inputTokens?: number;
  visibleOutputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** The provider's OWN generation speed. Absent unless the provider reported a generation duration. */
  medianProviderReportedGenerationTokensPerSecondMilli?: number;
  /** What this client watched, first visible output to completion. Includes transport and overhead. */
  medianClientObservedOutputTokensPerSecondMilli?: number;
  /** Visible output over TOTAL wall time. Includes the provider's queue as well. */
  medianEndToEndOutputTokensPerSecondMilli?: number;
  medianTimeToFirstVisibleTokenMilliseconds?: number;
  /** The marginal API charge. Genuinely zero for subscription execution — which is not "free". */
  costPerRunMicroUSD?: number;
  /** Plan allowance consumed, at list value. Absent is not zero. */
  subscriptionIncludedUsageMicroUSD?: number;
  /** What the campaign cost the person at the margin. Absent for subscription, with a stated reason. */
  effectiveUserCostMicroUSD?: number;
  costPerSuccessfulTaskMicroUSD?: number;
  tokensPerCompletedPass?: number;
  wastedTokens?: number;
  retryCount: number;
  timeoutCount: number;
  providerReportedTotalTokens?: number;
  estimatedTotalTokens?: number;
  reportedMinusEstimatedTokens?: number;
  /** measured · providerReported · estimated · unavailable. Rendered, never hidden. */
  measurementQuality: string;
  /** Why a figure is absent, when it is. Shown rather than replaced with a zero. */
  absences: { field: string; reason: string }[];
}

export interface CampaignSpendingRow {
  authorized: boolean;
  hardCeilingMicroUSD?: number;
  recordedMicroUSD: number;
  meteredAttempts: number;
  stoppedAtCeiling: boolean;
}

export interface CampaignCreateRequest {
  name: string;
  label: string;
  modelNames: string[];
  suiteIDs: string[];
  repeatsPerCase: number;
  runtimeVersion: string;
  /**
   * True to run WITHOUT managing residency. The result is labelled noncanonical and is not
   * comparable with a canonical run. Defaults to false: a campaign is canonical unless asked otherwise.
   */
  observeOnly?: boolean;
  /** Frozen into the manifest. A model the runtime says cannot think is refused, never substituted. */
  thinkingMode?: 'disabled' | 'enabled' | 'runtimeDefault';
  /**
   * Models somebody else runs. Each one is frozen with its provider, effort and billing basis.
   *
   * A selection whose model discovery has not PROVEN this account can call is refused by the shared
   * campaign builder — the same refusal the terminal gets, from the same function.
   */
  frontier?: FrontierCandidateSelection[];
}

/** The frozen execution policy of a campaign, as the renderer sees it. */
export interface CampaignExecutionRow {
  residency: 'managed' | 'observeOnly';
  thinkingMode: 'disabled' | 'enabled' | 'runtimeDefault';
  canonical: boolean;
  /** One line, already written: "canonical · residency managed on the benchmark endpoint · thinking off". */
  summary: string;
  /** Empty when canonical; the reasons it cannot be compared otherwise. */
  noncanonicalBecause: string[];
}

/**
 * What a person is told before a canonical campaign starts.
 *
 * Shown once, at Start — never per attempt. An authority you must re-grant between attempts is one
 * nobody reads by the third time.
 */
export interface CampaignStartDisclosure {
  name: string;
  endpoint: string;
  candidates: string[];
  canonical: boolean;
  /** The sentences to show. Authored in the engine so both surfaces say the same thing. */
  lines: string[];
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
  /** What to tell a person before starting this campaign. Read before Start, shown once. */
  campaignDisclosure(name: string): Promise<CampaignStartDisclosure>;
  /** Which benchmark endpoints are currently leased, and by which campaign. */
  leasedEndpoints(): Promise<{ endpoint: string; campaignName: string; processType: string; pid: number; state: string; message: string }[]>;
  /**
   * Every provider's status WITHOUT contacting any of them.
   *
   * Safe to call on every render, and called on opening the Providers screen. It reaches nothing —
   * which is the property the `probe: 'offline'` field on every row exists to state.
   */
  providerStatuses(): Promise<ProviderStatusRow[]>;
  /** Ask one provider what it is and what this account may call. THIS INVOKES SOMETHING. */
  discoverProvider(provider: string): Promise<ProviderStatusRow>;
  /** What this selection would cost, before anything is created. */
  previewCampaignCost(request: CampaignCreateRequest): Promise<CostPreviewRow>;
  /** What a created campaign is estimated to cost, and whether it has been authorised. */
  campaignCost(name: string): Promise<CostPreviewRow & { authorized: boolean; hardCeilingMicroUSD?: number }>;
  /** Record explicit authorization for paid execution, with a hard ceiling, before any run. */
  authorizeCampaign(name: string, ceilingMicroUSD: number): Promise<CampaignDetail>;
  /** The installed terminal command: what it is, and the two actions that put it there or take it away. */
  terminalCommand(): Promise<TerminalCommandRow>;
  installTerminalCommand(): Promise<TerminalCommandRow>;
  uninstallTerminalCommand(): Promise<TerminalCommandRow>;
  /** The host platform, so copy can say "this Mac" / "this PC" truthfully. Fixed for the process lifetime. */
  readonly platform: 'darwin' | 'win32' | 'linux' | string;
}

export type ScreenID = 'home' | 'models' | 'providers' | 'benchmark' | 'live' | 'results' | 'campaigns' | 'history' | 'settings';
export const SCREEN_ORDER: ScreenID[] = ['home', 'models', 'providers', 'benchmark', 'live', 'results', 'campaigns', 'history', 'settings'];

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
  campaignDisclosure: 'lab:campaign:disclosure',
  leasedEndpoints: 'lab:campaign:endpoints',
  providerStatuses: 'lab:provider:statuses',
  discoverProvider: 'lab:provider:discover',
  previewCampaignCost: 'lab:campaign:costPreview',
  campaignCost: 'lab:campaign:cost',
  authorizeCampaign: 'lab:campaign:authorize',
  eventCampaign: 'lab:event:campaign',
  terminalCommand: 'lab:terminal:status',
  installTerminalCommand: 'lab:terminal:install',
  uninstallTerminalCommand: 'lab:terminal:uninstall',
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
