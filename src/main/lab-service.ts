// Cernum · the application service over the portable engine. It owns the evidence store, runs
// benchmark sessions (one run per suite, every selected model in each run, evaluation appended
// right after each attempt), reports live progress, and derives every results/history view from
// the immutable records. It never deletes anything.

import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { CandidateDescriptor, Measurement, deterministicFake, measured, unavailable, describeMeasurement } from '../core/candidate';
import { BenchmarkSuite } from '../core/benchmark';
import { AttemptRecord, EnvironmentRecord, RunSummary, planRun } from '../core/run';
import { CancellationToken, EvaluationAdapter } from '../core/adapter';
import { DeterministicFakeAdapter } from '../core/fake-adapter';
import { RunExecutor } from '../core/executor';
import { FileResultStore } from '../core/file-store';
import { EvaluationEngine } from '../core/engine';
import { EvaluationRecord, ALL_DIMENSIONS, CapabilityDimension } from '../core/evaluation';
import { policyCatalog, registeredSuites, suiteByID, caseByID, allGovernedSuites } from '../core/catalog';
import { OllamaLiveAdapter, ThinkingMode, probeCandidate } from '../core/ollama';
import { LiveExecutionAuthorization, OllamaHTTPTransport } from '../core/ollama-http';
import { buildProfile, CapabilityProfile } from '../core/profile';
import { deriveRecommendation, OwnerRecommendationRecord, standardRecommendationPolicy } from '../core/recommendation';
import { runOverviews } from '../core/history';
import { compareEvaluations, ComparabilityReason } from '../core/comparability';
import { isoSeconds, compareCodePoints } from '../core/digest';
import { AttemptDetail, BenchmarkConfiguration, BenchmarkPreflight, CaseResultRow, HistoryEntry, MachineSummary, ModelResult, ModelRow,
         SessionComparison, SessionProgress, SessionRecord, SessionResults, SuiteRow, AttemptProgress,
         displaySuiteTitle, displayModelName } from '../shared/ipc';
import { SessionIndex } from './sessions';
import { captureEnvironment, summarize } from './environment';
import { detectOllama, listInstalledModels, statusTransport } from './ollama-runtime';

export const REFERENCE_MODEL_KEY = 'reference:deterministic';
/** Truthful noun for copy that crosses the bridge ("this Mac" / "this PC"). */
const HERE = process.platform === 'darwin' ? 'this Mac' : 'this PC';

const SUITE_SUMMARIES: Record<string, string> = {
  'suite.model-lab.foundation': 'Four short sanity tasks with tight output budgets: follow one instruction, answer in JSON, recall a supplied fact, and admit a missing memory.',
  'suite.model-lab.foundation-v2': 'The same four sanity tasks with budgets sized for models that reason before answering.',
  'suite.model-lab.conversation': 'Instruction adherence, honesty about having no prior conversation, and warmth (the last is flagged for human review, never auto-scored).',
  'suite.model-lab.memory-honesty': 'Admits missing memories, recalls only from supplied notes, honours deletions, and prefers a newer correction over a stale fact.',
  'suite.model-lab.context-integration': 'Connects relevant facts while ignoring distractors, names contradictions, and keeps observation apart from inference.',
  'suite.model-lab.calendar-reasoning': 'Detects overlapping events, separates tentative from confirmed plans, and refuses to invent travel time.',
  'suite.model-lab.emotional-understanding': 'Supports without diagnosing, hedges emotional inferences, and attunement (human review).',
  'suite.model-lab.privacy-governance': 'Refuses unauthorized data access, honours revoked consent, refuses silent configuration changes, and keeps permissions scoped.',
  'suite.model-lab.hallucination-resistance': 'Admits unknowns instead of fabricating, never claims an action happened, and accepts corrections.',
  'suite.model-lab.tool-use': 'Picks the one correct authorized tool and declines when no authorized tool fits.',
  'suite.model-lab.structured-output': 'Returns valid JSON with exactly the requested keys.',
  'suite.model-lab.planning': 'Orders steps safely, spots impossible requirements, and asks before irreversible actions.',
  'suite.model-lab.long-context-retrieval': 'Finds one fact in a long dossier, reports absent facts honestly, and prefers the newer of two entries.',
  'suite.model-lab.safety-boundaries': 'Refuses to facilitate harm, points to real help in urgent situations, and never claims to have contacted anyone.',
};

export interface LabServiceOptions {
  userData: string;
  evidenceRoot: string;
  getSettings: () => { ollamaEndpoint: string; thinkingMode: ThinkingMode };
}

export class LabService extends EventEmitter {
  private store!: FileResultStore;
  private sessions: SessionIndex;
  private machine?: MachineSummary;
  private active?: { session: SessionRecord; token: CancellationToken; progress: SessionProgress };

  constructor(private readonly options: LabServiceOptions) {
    super();
    this.sessions = new SessionIndex(path.join(options.userData, 'sessions.json'));
  }

  async open(): Promise<void> {
    this.store = await FileResultStore.open(this.options.evidenceRoot);
  }

  get evidenceRoot(): string {
    return this.options.evidenceRoot;
  }

  get resultStore(): FileResultStore {
    return this.store;
  }

  /** True while a benchmark session is executing. */
  get isRunning(): boolean {
    return this.active !== undefined;
  }

  // MARK: - Machine

  async getMachine(refresh = false): Promise<MachineSummary> {
    if (!this.machine || refresh) this.machine = summarize(await captureEnvironment());
    return this.machine;
  }

  // MARK: - Models and suites

  async listModels(): Promise<ModelRow[]> {
    const settings = this.options.getSettings();
    const status = await detectOllama(settings.ollamaEndpoint);
    const runsByModel = await this.runCountsByModelName();
    const rows: ModelRow[] = [];
    if (status.state === 'running') {
      try {
        for (const model of await listInstalledModels(settings.ollamaEndpoint)) {
          rows.push({
            key: model.name, kind: 'ollama', name: model.name, sizeBytes: model.sizeBytes, parameterSize: model.parameterSize,
            quantization: model.quantizationLevel, family: model.family, digest: model.digest, modifiedAt: model.modifiedAt,
            readiness: 'ready', readinessDetail: `Installed in Ollama on ${HERE}. Ready to benchmark.`,
            runsInHistory: runsByModel.get(model.name) ?? 0,
          });
        }
      } catch (error) {
        rows.push(...[]);
        this.emit('log', `model listing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    rows.sort((a, b) => compareCodePoints(a.name, b.name));
    rows.push({
      key: REFERENCE_MODEL_KEY, kind: 'reference', name: displayModelName(deterministicFake.displayName),
      readiness: 'referenceOnly', readinessDetail: 'Built into Cernum. Produces the same fixed answers every time, so you can try the whole workflow without Ollama. Its answers are not a real model\'s.',
      runsInHistory: runsByModel.get(deterministicFake.exactModelIdentity) ?? 0,
    });
    return rows;
  }

  private async runCountsByModelName(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const session of this.sessions.all()) {
      for (const candidate of session.candidates) counts.set(candidate.exactModelIdentity, (counts.get(candidate.exactModelIdentity) ?? 0) + 1);
    }
    return counts;
  }

  listSuites(): SuiteRow[] {
    return registeredSuites.map((suite) => ({
      id: suite.id.raw,
      version: suite.version,
      title: displaySuiteTitle(suite.title),
      summary: SUITE_SUMMARIES[suite.id.raw] ?? '',
      dimension: suite.cases[0]?.category ?? '',
      caseCount: suite.cases.length,
      plannedAttemptsPerModel: suite.cases.reduce((n, c) => n + c.repetitionPolicy.plannedRepetitions, 0),
      cases: suite.cases.map((c) => ({
        id: c.id.raw, capability: c.capabilityUnderTest, responseFormat: c.responseFormat, repetitions: c.repetitionPolicy.plannedRepetitions,
        budgetMilliseconds: c.executionBudgetMilliseconds, maxOutputTokens: c.generationSettings.maxOutputTokens,
        governance: policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)?.hardGovernance !== undefined
          || (policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)?.criteria.caseDelegations ?? []).some((d) => policyCatalog.policy(d.policyID, d.policyVersion)?.hardGovernance !== undefined && d.caseID === c.id.raw),
      })),
    }));
  }

  // MARK: - Benchmark

  async preflight(configuration: BenchmarkConfiguration): Promise<BenchmarkPreflight> {
    const settings = this.options.getSettings();
    const problems: string[] = [];
    const suites = configuration.suiteIDs.map((id) => suiteByID(id)).filter((s): s is BenchmarkSuite => s !== undefined);
    if (suites.length === 0) problems.push('Choose at least one benchmark suite.');
    if (suites.length !== configuration.suiteIDs.length) problems.push('One of the chosen suites is not registered.');
    const ollamaKeys = configuration.modelKeys.filter((k) => k !== REFERENCE_MODEL_KEY);
    if (configuration.modelKeys.length === 0) problems.push('Choose at least one model.');
    if (this.active) problems.push('A benchmark is already running. Wait for it to finish or cancel it.');
    let status = await detectOllama(settings.ollamaEndpoint);
    if (ollamaKeys.length > 0 && status.state !== 'running') {
      problems.push(status.state === 'notInstalled'
        ? `Ollama is not installed on ${HERE}. Install it from ollama.com, add a model, and try again — or benchmark the built-in reference model.`
        : status.state === 'installedNotRunning' ? 'Ollama is installed but not running. Start it from the Home screen, then try again.' : status.detail);
    }
    if (ollamaKeys.length > 0 && status.state === 'running') {
      try {
        const installed = new Set((await listInstalledModels(settings.ollamaEndpoint)).map((m) => m.name));
        for (const key of ollamaKeys) if (!installed.has(key) && !installed.has(key + ':latest')) problems.push(`Model "${key}" is not installed in Ollama any more.`);
      } catch (error) {
        problems.push(`Could not list installed models: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const attemptsPerModel = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + c.repetitionPolicy.plannedRepetitions, 0), 0);
    const budgetPerModelMs = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + c.repetitionPolicy.plannedRepetitions * c.executionBudgetMilliseconds, 0), 0);
    const models = configuration.modelKeys.map((key) => ({ key, name: key === REFERENCE_MODEL_KEY ? displayModelName(deterministicFake.displayName) : key, kind: key === REFERENCE_MODEL_KEY ? 'reference' as const : 'ollama' as const }));
    return {
      ok: problems.length === 0,
      problems,
      totalAttempts: attemptsPerModel * configuration.modelKeys.length,
      attemptsPerModel,
      estimatedMaxMinutes: Math.ceil((budgetPerModelMs * ollamaKeys.length) / 60_000),
      models,
      suites: suites.map((s) => ({ id: s.id.raw, title: displaySuiteTitle(s.title), caseCount: s.cases.length })),
      endpoint: settings.ollamaEndpoint,
      statements: [
        `Cernum will send ${attemptsPerModel} synthetic prompts to each selected model${ollamaKeys.length > 0 ? ` through Ollama at ${settings.ollamaEndpoint}` : ''}. Nothing leaves ${HERE}.`,
        'Every prompt is an invented fixture. No personal data is read, sent, or stored.',
        `Every attempt — success, failure, or timeout — is recorded permanently in the evidence store on ${HERE} and never overwritten.`,
        `Model "thinking" is ${settings.thinkingMode === 'disabled' ? 'explicitly disabled' : settings.thinkingMode === 'enabled' ? 'explicitly enabled (only final answers are judged; reasoning is never stored)' : "left to Ollama's default (recorded as such)"} on every request.`,
        'Results are evidence for your own decision. Cernum changes nothing about how any model is used anywhere.',
      ],
    };
  }

  async startBenchmark(configuration: BenchmarkConfiguration): Promise<SessionRecord> {
    const preflight = await this.preflight(configuration);
    if (!preflight.ok) throw new Error(preflight.problems.join(' '));
    const settings = this.options.getSettings();
    const machine = await this.getMachine(true);
    const suites = configuration.suiteIDs.map((id) => suiteByID(id)!);
    const ollamaKeys = configuration.modelKeys.filter((k) => k !== REFERENCE_MODEL_KEY);
    const useReference = configuration.modelKeys.includes(REFERENCE_MODEL_KEY);

    // The explicit act: pressing Start on a pre-flight that stated both facts IS the acknowledgement.
    let transport: OllamaHTTPTransport | undefined;
    let runtimeVersion: string | undefined;
    const candidates: CandidateDescriptor[] = [];
    if (ollamaKeys.length > 0) {
      const authorization = LiveExecutionAuthorization.explicit(true, true)!;
      transport = new OllamaHTTPTransport(settings.ollamaEndpoint, authorization);
      runtimeVersion = (await transport.version()).version;
      for (const key of ollamaKeys) candidates.push(await probeCandidate(key, transport, settings.thinkingMode));
    }
    if (useReference) candidates.push(deterministicFake);

    const now = new Date();
    const sessionID = `session-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`;
    const session: SessionRecord = {
      sessionID, label: configuration.label.trim() || defaultLabel(candidates, suites), createdAt: isoSeconds(now), state: 'running',
      suiteIDs: suites.map((s) => s.id.raw), runIDs: [], candidates, modelKeys: configuration.modelKeys, thinkingMode: settings.thinkingMode,
      endpoint: settings.ollamaEndpoint, machine, runtimeVersion,
    };
    this.sessions.upsert(session);

    const totalAttempts = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + c.repetitionPolicy.plannedRepetitions, 0), 0) * candidates.length;
    const progress: SessionProgress = {
      sessionID, state: 'running', startedAt: session.createdAt, totalAttempts, recordedAttempts: 0, currentRunIndex: 0, totalRuns: suites.length,
      statusCounts: {}, recent: [],
      perModel: candidates.map((c) => ({ candidateID: c.id.raw, modelName: c.exactModelIdentity, planned: totalAttempts / candidates.length, recorded: 0, completed: 0, failed: 0, timedOut: 0, governanceFailures: 0 })),
    };
    const token = new CancellationToken();
    this.active = { session, token, progress };
    this.emitProgress();

    void this.runSession(session, suites, candidates, transport, runtimeVersion, machine.environment, token).catch((error) => {
      this.emit('log', `session ${sessionID} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
    return session;
  }

  private async runSession(session: SessionRecord, suites: BenchmarkSuite[], candidates: CandidateDescriptor[], transport: OllamaHTTPTransport | undefined,
                           runtimeVersion: string | undefined, environment: EnvironmentRecord, token: CancellationToken): Promise<void> {
    const progress = this.active!.progress;
    const environmentForRun: EnvironmentRecord = { ...environment,
      inferenceRuntimeVersion: runtimeVersion ? measured(`ollama ${runtimeVersion}`) : unavailable('no inference runtime is attached to this session (reference model only)') };
    const adapter = this.compositeAdapter(transport, runtimeVersion);
    const engine = new EvaluationEngine(policyCatalog, () => new Date());
    let finalState: SessionRecord['state'] = 'completed';
    let failureDetail: string | undefined;
    try {
      for (let index = 0; index < suites.length; index++) {
        if (token.isCancelled) { finalState = 'cancelled'; break; }
        const suite = suites[index];
        progress.currentRunIndex = index;
        progress.currentSuiteTitle = displaySuiteTitle(suite.title);
        const runID = runIDFor(session.sessionID, suite, index);
        session.runIDs.push(runID);
        this.sessions.upsert(session);
        const plan = planRun(runID, suite, candidates);
        const executor = new RunExecutor(adapter, this.store, environmentForRun, () => new Date());
        const summary = await executor.execute(plan, suite, token, {
          onAttemptStarting: (planned) => {
            const candidate = candidates.find((c) => c.id.raw === planned.candidateID.raw);
            progress.currentModelName = candidate?.exactModelIdentity ?? planned.candidateID.raw;
            progress.currentCaseID = planned.caseID.raw;
            progress.currentAttemptStartedAt = isoSeconds(new Date());
            this.emitProgress();
          },
          onAttemptRecorded: async (record) => {
            let evaluation: EvaluationRecord | undefined;
            try {
              evaluation = (await engine.appendEvaluation(record, this.store)).record;
            } catch (error) {
              this.emit('log', `evaluation of ${record.attemptID} failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.noteAttempt(progress, record, evaluation);
            this.emitProgress();
          },
        });
        if (summary.state === 'cancelled') { finalState = 'cancelled'; break; }
        if (summary.state === 'incomplete') finalState = 'incomplete';
      }
    } catch (error) {
      finalState = 'failed';
      failureDetail = error instanceof Error ? error.message : String(error);
    }
    session.state = finalState;
    session.finishedAt = isoSeconds(new Date());
    session.failureDetail = failureDetail;
    this.sessions.upsert(session);
    progress.state = finalState;
    progress.failureDetail = failureDetail;
    progress.currentCaseID = undefined;
    progress.currentModelName = undefined;
    this.emitProgress();
    this.active = undefined;
    this.emit('idle', session.sessionID);
  }

  /** Routes each candidate to the adapter that can drive it; the reference model never touches the network. */
  private compositeAdapter(transport: OllamaHTTPTransport | undefined, runtimeVersion: string | undefined): EvaluationAdapter {
    const settings = this.options.getSettings();
    const live = transport ? new OllamaLiveAdapter(transport, runtimeVersion ? measured(runtimeVersion) : unavailable('the runtime version was not probed'), settings.thinkingMode) : new OllamaLiveAdapter();
    const fake = new DeterministicFakeAdapter('succeed');
    return {
      adapterID: 'adapter:cernum:composite',
      supportedExecutionClasses: ['inProcess', 'localHostProcess'],
      invoke: (request, candidate, cancellation) => candidate.provider === 'model-lab-fake' ? fake.invoke(request, candidate, cancellation) : live.invoke(request, candidate, cancellation),
    };
  }

  private noteAttempt(progress: SessionProgress, record: AttemptRecord, evaluation?: EvaluationRecord): void {
    progress.recordedAttempts += 1;
    progress.statusCounts[record.terminalStatus] = (progress.statusCounts[record.terminalStatus] ?? 0) + 1;
    const row = progress.perModel.find((m) => m.candidateID === record.candidate.id.raw);
    if (row) {
      row.recorded += 1;
      if (record.terminalStatus === 'completed') row.completed += 1;
      else if (record.terminalStatus === 'timedOut') row.timedOut += 1;
      else row.failed += 1;
      if (evaluation?.verdict.governance.state === 'violated') row.governanceFailures += 1;
    }
    const elapsed = 'measured' in record.observation.timing.totalElapsedMilliseconds ? record.observation.timing.totalElapsedMilliseconds.measured
      : Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    const entry: AttemptProgress = {
      attemptID: record.attemptID, runID: record.runID, candidateID: record.candidate.id.raw, modelName: record.candidate.exactModelIdentity,
      caseID: record.caseID.raw, terminalStatus: record.terminalStatus, evaluationStatus: evaluation?.verdict.status,
      governanceViolated: evaluation?.verdict.governance.state === 'violated', elapsedMilliseconds: elapsed, startedAt: record.startedAt, finishedAt: record.finishedAt,
    };
    progress.recent = [entry, ...progress.recent].slice(0, 12);
  }

  private emitProgress(): void {
    if (this.active) this.emit('progress', JSON.parse(JSON.stringify(this.active.progress)));
  }

  cancelBenchmark(): void {
    this.active?.token.cancel();
  }

  activeProgress(): SessionProgress | undefined {
    return this.active ? JSON.parse(JSON.stringify(this.active.progress)) : undefined;
  }

  // MARK: - Results

  listSessions(): SessionRecord[] {
    return this.sessions.all().sort((a, b) => compareCodePoints(b.createdAt, a.createdAt));
  }

  async sessionResults(sessionID: string): Promise<SessionResults> {
    const session = this.sessions.get(sessionID);
    if (!session) throw new Error(`no session ${sessionID}`);
    const attempts: AttemptRecord[] = [];
    const runSummaries: RunSummary[] = [];
    for (const runID of session.runIDs) {
      attempts.push(...(await this.store.attempts(runID)));
      const summary = await this.store.summary(runID);
      if (summary) runSummaries.push(summary);
    }
    const attemptIDs = new Set(attempts.map((a) => a.attemptID));
    const evaluations = (await this.store.allEvaluations()).filter((e) => attemptIDs.has(e.attemptID));
    const evaluationsByAttempt = new Map(evaluations.map((e) => [e.attemptID, e]));
    const recordedRecommendations = await this.store.allRecommendations();
    const now = new Date();

    const models: ModelResult[] = session.candidates.map((candidate) => {
      const mine = attempts.filter((a) => a.candidate.id.raw === candidate.id.raw);
      const myEvaluations = evaluations.filter((e) => e.candidateID.raw === candidate.id.raw);
      const profile = buildProfile(candidate.id, mine, myEvaluations, [], {}, now);
      let pass = 0, partial = 0, fail = 0, human = 0, na = 0, applicable = 0, governance = 0;
      for (const e of myEvaluations) {
        if (e.verdict.governance.state === 'violated') { governance += 1; continue; }
        switch (e.verdict.status) {
          case 'pass': pass += 1; applicable += 1; break;
          case 'partial': partial += 1; applicable += 1; break;
          case 'fail': fail += 1; applicable += 1; break;
          case 'requiresHumanReview': human += 1; break;
          case 'notApplicable': na += 1; break;
          default: break;
        }
      }
      const latencies = mine.map((a) => ('measured' in a.observation.timing.totalElapsedMilliseconds ? a.observation.timing.totalElapsedMilliseconds.measured : undefined))
        .filter((v): v is number => v !== undefined).sort((a, b) => a - b);
      const throughput = mine.map((a) => a.observation.runtimeTelemetry?.tokensPerSecondMilli).map((t) => (t && 'measured' in t ? t.measured : undefined))
        .filter((v): v is number => v !== undefined).sort((a, b) => a - b);
      const planned = attemptsPlannedFor(session, candidate);
      const answered = mine.filter((a) => a.terminalStatus === 'completed' || a.terminalStatus === 'malformedOutput').length;
      const statusCounts: Record<string, number> = {};
      for (const a of mine) statusCounts[a.terminalStatus] = (statusCounts[a.terminalStatus] ?? 0) + 1;
      const strengths: string[] = [];
      const weaknesses: string[] = [];
      for (const d of profile.dimensions) {
        if (!('measured' in d.qualityRateMilli)) continue;
        if (d.disqualifications.length > 0) weaknesses.push(`${dimensionLabel(d.dimension)}: ${d.disqualifications.length} governance failure${d.disqualifications.length > 1 ? 's' : ''}`);
        else if (d.qualityRateMilli.measured >= 900) strengths.push(`${dimensionLabel(d.dimension)}: ${Math.round(d.qualityRateMilli.measured / 10)}%`);
        else if (d.qualityRateMilli.measured <= 500) weaknesses.push(`${dimensionLabel(d.dimension)}: ${Math.round(d.qualityRateMilli.measured / 10)}%`);
      }
      return {
        candidate, modelName: candidate.exactModelIdentity, rank: 0, disqualified: governance > 0, governanceFailures: governance,
        qualityRateMilli: applicable === 0 ? unavailable('no applicable, non-disqualified results — missing evidence is not a zero score') : measured(Math.floor((pass * 1000 + partial * 500) / applicable)),
        passCount: pass, partialCount: partial, failCount: fail, humanReviewCount: human, notApplicableCount: na,
        plannedAttempts: planned, recordedAttempts: mine.length, answeredAttempts: answered,
        reliabilityMilli: planned === 0 ? unavailable('nothing was planned') : measured(Math.floor((answered * 1000) / planned)),
        medianLatencyMilliseconds: latencies.length ? measured(percentile(latencies, 0.5)) : unavailable('no runtime-reported duration'),
        meanLatencyMilliseconds: latencies.length ? measured(Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)) : unavailable('no runtime-reported duration'),
        p95LatencyMilliseconds: latencies.length ? measured(percentile(latencies, 0.95)) : unavailable('no runtime-reported duration'),
        medianTokensPerSecondMilli: throughput.length ? measured(percentile(throughput, 0.5)) : unavailable('the runtime reported no throughput'),
        timeoutCount: statusCounts.timedOut ?? 0,
        errorCount: mine.filter((a) => !['completed', 'malformedOutput', 'timedOut'].includes(a.terminalStatus)).length,
        terminalStatusCounts: statusCounts,
        profile, strengths, weaknesses,
      };
    });

    // Ranking WITHIN this session (same suites, same cohorts for every model): governance first,
    // then quality, then reliability, then latency. Never across sessions.
    models.sort((a, b) => {
      if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
      if (a.governanceFailures !== b.governanceFailures) return a.governanceFailures - b.governanceFailures;
      const qa = 'measured' in a.qualityRateMilli ? a.qualityRateMilli.measured : -1;
      const qb = 'measured' in b.qualityRateMilli ? b.qualityRateMilli.measured : -1;
      if (qa !== qb) return qb - qa;
      const ra = 'measured' in a.reliabilityMilli ? a.reliabilityMilli.measured : -1;
      const rb = 'measured' in b.reliabilityMilli ? b.reliabilityMilli.measured : -1;
      if (ra !== rb) return rb - ra;
      const la = 'measured' in a.medianLatencyMilliseconds ? a.medianLatencyMilliseconds.measured : Number.MAX_SAFE_INTEGER;
      const lb = 'measured' in b.medianLatencyMilliseconds ? b.medianLatencyMilliseconds.measured : Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      return compareCodePoints(a.modelName, b.modelName);
    });
    models.forEach((m, i) => { m.rank = i + 1; });

    const cases: CaseResultRow[] = attempts.map((a) => {
      const e = evaluationsByAttempt.get(a.attemptID);
      return {
        attemptID: a.attemptID, runID: a.runID, candidateID: a.candidate.id.raw, modelName: a.candidate.exactModelIdentity,
        suiteID: a.suiteID.raw, caseID: a.caseID.raw, capability: caseByID(a.caseID.raw)?.capabilityUnderTest ?? '',
        terminalStatus: a.terminalStatus, evaluationStatus: e?.verdict.status, governance: e?.verdict.governance, dimension: e?.verdict.dimension,
        latencyMilliseconds: a.observation.timing.totalElapsedMilliseconds,
        tokensPerSecondMilli: a.observation.runtimeTelemetry?.tokensPerSecondMilli ?? unavailable('the runtime reported no throughput'),
      };
    });

    const dimensions = ALL_DIMENSIONS.filter((d) => evaluations.some((e) => e.verdict.dimension === d));
    const recommendation = models.map((m, index) => {
      const existing = recordedRecommendations.filter((r) => r.candidateID.raw === m.candidate.id.raw);
      const sequence = (existing.map((r) => r.sequence).reduce((a, b) => Math.max(a, b), -1)) + 1;
      const record = deriveRecommendation(m.profile, 0, standardRecommendationPolicy, sequence, now);
      const recorded = existing.some((r) => r.outcome === record.outcome && r.totalEvaluationsConsidered === record.totalEvaluationsConsidered
        && JSON.stringify(r.dimensionEvidence) === JSON.stringify(record.dimensionEvidence));
      return { candidateID: m.candidate.id.raw, modelName: m.modelName, record, recorded, index };
    });

    const suiteTitles = session.suiteIDs.map((id) => displaySuiteTitle(suiteByID(id)?.title ?? id));
    return {
      session, models, dimensions, cases, recommendation: recommendation.map(({ index: _i, ...rest }) => rest), recommendationPolicy: standardRecommendationPolicy,
      workloadSummary: `${suiteTitles.length} suite${suiteTitles.length === 1 ? '' : 's'} (${suiteTitles.join(', ')}) · ${attempts.length} attempts across ${models.length} model${models.length === 1 ? '' : 's'}`,
      runSummaries,
    };
  }

  async recordRecommendation(sessionID: string, candidateID: string): Promise<OwnerRecommendationRecord> {
    const results = await this.sessionResults(sessionID);
    const entry = results.recommendation.find((r) => r.candidateID === candidateID);
    if (!entry) throw new Error('no recommendation derived for that model in this session');
    await this.store.appendRecommendation(entry.record);
    return entry.record;
  }

  async attemptDetail(attemptID: string): Promise<AttemptDetail> {
    const attempt = await this.store.attempt(attemptID);
    if (!attempt) throw new Error(`no attempt ${attemptID}`);
    const evaluations = await this.store.evaluations(attemptID);
    const scores = await this.store.scores(attemptID);
    const benchmarkCase = caseByID(attempt.caseID.raw);
    const policy = policyCatalog.policy(attempt.scoringPolicyID, attempt.scoringPolicyVersion);
    let guidance = policy?.scoringGuidance;
    if (policy?.method === 'caseDelegation') {
      const route = policy.criteria.caseDelegations.find((d) => d.caseID === attempt.caseID.raw);
      if (route) guidance = policyCatalog.policy(route.policyID, route.policyVersion)?.scoringGuidance ?? guidance;
    }
    return { attempt, evaluations, scores, caseCapability: benchmarkCase?.capabilityUnderTest, policyGuidance: guidance };
  }

  // MARK: - History

  async history(): Promise<HistoryEntry[]> {
    const attempts = await this.store.allAttempts();
    const summaries = await this.store.allSummaries();
    const evaluations = await this.store.allEvaluations();
    const overviews = runOverviews(attempts, summaries, evaluations);
    const byRun = new Map(overviews.map((o) => [o.runID, o]));
    const entries: HistoryEntry[] = [];
    const claimed = new Set<string>();
    for (const session of this.listSessions()) {
      const runs = session.runIDs.map((id) => byRun.get(id)).filter((o): o is NonNullable<typeof o> => o !== undefined);
      for (const run of runs) claimed.add(run.runID);
      entries.push({
        session, runs, createdAt: session.createdAt, label: session.label,
        modelNames: session.candidates.map((c) => c.exactModelIdentity),
        suiteTitles: session.suiteIDs.map((id) => displaySuiteTitle(suiteByID(id)?.title ?? id)),
        state: session.state,
        attemptCount: runs.reduce((n, r) => n + r.recordedAttemptCount, 0),
        governanceFailureCount: runs.reduce((n, r) => n + r.governanceFailureCount, 0),
      });
    }
    // Runs the evidence store holds that no session claims (e.g. written by another tool): still history.
    for (const run of overviews) {
      if (claimed.has(run.runID)) continue;
      entries.push({
        runs: [run], createdAt: run.earliestStartedAt ?? '', label: run.runID,
        modelNames: run.candidateIDs.map((c) => c.raw), suiteTitles: [suiteByID(run.suiteID.raw)?.title ?? run.suiteID.raw],
        state: run.state ?? 'no summary (did not finish)', attemptCount: run.recordedAttemptCount, governanceFailureCount: run.governanceFailureCount,
      });
    }
    return entries.sort((a, b) => compareCodePoints(b.createdAt, a.createdAt));
  }

  async compareSessions(sessionA: string, sessionB: string): Promise<SessionComparison> {
    const a = await this.sessionResults(sessionA);
    const b = await this.sessionResults(sessionB);
    const namesA = new Set(a.models.map((m) => m.modelName));
    const shared = b.models.map((m) => m.modelName).filter((n) => namesA.has(n));
    const evaluationsA = await this.sessionEvaluations(a.session);
    const evaluationsB = await this.sessionEvaluations(b.session);
    const reasons = new Set<ComparabilityReason>();
    let anyDirect = false;
    for (const ea of evaluationsA) {
      const eb = evaluationsB.find((e) => e.caseID.raw === ea.caseID.raw && e.evaluatorID === ea.evaluatorID);
      if (!eb) continue;
      const verdict = compareEvaluations(ea, eb);
      if (verdict.directlyComparable) anyDirect = true;
      for (const r of verdict.reasons) reasons.add(r);
    }
    const sameSuites = a.session.suiteIDs.join('|') === b.session.suiteIDs.join('|');
    return {
      a, b, sharedModelNames: shared,
      directlyComparable: sameSuites && anyDirect && reasons.size === 0,
      reasons: [...reasons],
      perModel: shared.map((name) => {
        const ma = a.models.find((m) => m.modelName === name)!;
        const mb = b.models.find((m) => m.modelName === name)!;
        return { modelName: name, qualityA: ma.qualityRateMilli, qualityB: mb.qualityRateMilli, latencyA: ma.medianLatencyMilliseconds, latencyB: mb.medianLatencyMilliseconds, governanceA: ma.governanceFailures, governanceB: mb.governanceFailures };
      }),
    };
  }

  private async sessionEvaluations(session: SessionRecord): Promise<EvaluationRecord[]> {
    const ids = new Set<string>();
    for (const runID of session.runIDs) for (const a of await this.store.attempts(runID)) ids.add(a.attemptID);
    return (await this.store.allEvaluations()).filter((e) => ids.has(e.attemptID));
  }

  async catalogSummary(): Promise<{ suites: number; cases: number; policies: number; catalogDigest: string }> {
    return { suites: allGovernedSuites.length, cases: allGovernedSuites.reduce((n, s) => n + s.cases.length, 0), policies: policyCatalog.policies.length, catalogDigest: policyCatalog.catalogDigest() };
  }

  sessionCount(): number {
    return this.sessions.all().length;
  }
}

function runIDFor(sessionID: string, suite: BenchmarkSuite, index: number): string {
  const slug = suite.id.raw.replace('suite.model-lab.', '').replace(/[^a-z0-9-]/g, '-');
  return `${sessionID}-${String(index).padStart(2, '0')}-${slug}`.toLowerCase();
}

function defaultLabel(candidates: CandidateDescriptor[], suites: BenchmarkSuite[]): string {
  const models = candidates.map((c) => c.exactModelIdentity).join(', ');
  const scope = suites.length === registeredSuites.length ? 'Full lab' : suites.length === 1 ? displaySuiteTitle(suites[0].title) : `${suites.length} suites`;
  return `${scope} · ${models}`;
}

function attemptsPlannedFor(session: SessionRecord, _candidate: CandidateDescriptor): number {
  return session.suiteIDs.map((id) => suiteByID(id)).filter((s): s is BenchmarkSuite => s !== undefined)
    .reduce((n, s) => n + s.cases.reduce((m, c) => m + c.repetitionPolicy.plannedRepetitions, 0), 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function dimensionLabel(dimension: CapabilityDimension): string {
  const labels: Record<CapabilityDimension, string> = {
    conversation: 'Conversation', memoryHonesty: 'Memory honesty', contextIntegration: 'Context integration', calendarReasoning: 'Calendar reasoning',
    emotionalUnderstanding: 'Emotional understanding', privacyAndGovernance: 'Privacy & governance', hallucinationResistance: 'Hallucination resistance',
    toolUse: 'Tool use', planning: 'Planning', longContextRetrieval: 'Long-context retrieval', safetyBoundaries: 'Safety boundaries', structuredOutputReliability: 'Structured output',
  };
  return labels[dimension];
}

export { describeMeasurement, statusTransport };
export type { CapabilityProfile, Measurement };
