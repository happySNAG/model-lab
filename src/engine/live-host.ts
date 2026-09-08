// Benchmark engine · the live host. Everything the engine needs from a real machine and a real
// Ollama, behind the same `CampaignHost` interface the synthetic host implements.
//
// The engine itself never talks to a runtime, reads a disk or opens a socket. It asks this object.
// That is why the synthetic campaign is a genuine test of the same orchestration and not a parallel
// implementation of it — swap this for `SyntheticHost` and the campaign code path does not change.
//
// LOCAL DISCOVERY IS READ-ONLY. `discoverLocalModels` lists what is already installed. It never
// pulls, downloads, creates or deletes anything: a benchmark that could install a model could
// change the thing it is measuring.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CancellationToken } from '../core/adapter';
import { OllamaChatReport, OllamaInstalledModel, OllamaTransport, ThinkingMode, supportsStreaming } from '../core/ollama';
import { LiveExecutionAuthorization, OllamaHTTPTransport } from '../core/ollama-http';
import { makeCandidate, measured, unavailable } from '../core/candidate';
import { BenchmarkCase } from '../core/benchmark';
import { EvaluationEngine } from '../core/engine';
import { policyCatalog } from '../core/catalog';
import { isViolation } from '../core/evaluation';
import { AttemptOutcome, AttemptRequest, CampaignHost } from './campaign';
import { EngineCatalogue } from './catalogue';
import { PlanSlot, PlannableCandidate, TerminalSlotStatus } from './ledger';
import { GIB, SystemReading } from './guards';
import { LiveResidency, ResidencyController } from './residency';
import { ObservedModelIdentity } from './verification';
import { StreamEvent } from './attempt-telemetry';
import { digestObject, sha256Text } from './canonical';

const execFileAsync = promisify(execFile);

/**
 * The core refuses to build a live transport without an explicit acknowledgement value, so that
 * reaching a real model is never something a caller does by forgetting a flag. The engine only ever
 * runs a live campaign the operator asked for by name, so it makes that acknowledgement here, in
 * one place, where the reason for it is written down.
 */
function liveAuthorization(): LiveExecutionAuthorization {
  const authorization = LiveExecutionAuthorization.explicit(true, true);
  if (!authorization) throw new Error('the core refused to authorise live execution');
  return authorization;
}

async function run(command: string, args: string[], timeout = 5_000): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Ports with a listener, as the OS reports them. Read-only; nothing is opened or closed. */
export async function readListeners(): Promise<Record<string, number>> {
  const listeners: Record<string, number> = {};
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    for (const line of (out ?? '').split('\n')) {
      const match = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (match) listeners[match[1]] = Number(match[2]);
    }
    return listeners;
  }
  // `lsof -nP -iTCP -sTCP:LISTEN` is the portable-enough answer on macOS and Linux.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], 8_000);
  let pid = 0;
  for (const line of (out ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const match = /:(\d+)$/.exec(line);
      if (match) listeners[match[1]] = pid;
    }
  }
  return listeners;
}

async function freeDiskBytes(path: string): Promise<number> {
  try {
    const stats = fs.statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

async function swapUsedBytes(): Promise<number> {
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-n', 'vm.swapusage']);
    const match = /used\s*=\s*([\d.]+)M/.exec(out ?? '');
    return match ? Math.round(Number(match[1]) * 1024 * 1024) : 0;
  }
  if (process.platform === 'linux') {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = /SwapTotal:\s+(\d+) kB/.exec(meminfo);
      const free = /SwapFree:\s+(\d+) kB/.exec(meminfo);
      if (total && free) return (Number(total[1]) - Number(free[1])) * 1024;
    } catch { /* fall through */ }
  }
  // An unreadable swap figure is reported as zero rather than as a breach: a guard that fails
  // because it could not measure would stop every campaign on a platform it does not know.
  return 0;
}

export interface LiveHostOptions {
  endpoint: string;
  catalogue: EngineCatalogue;
  thinkingMode?: ThinkingMode;
  /** The volume whose free space the disk guard watches. Defaults to the OS temp root's volume. */
  diskPath?: string;
  /** Enable the live residency controller. Off by default; the synthetic campaign never enables it. */
  enableResidency?: boolean;
  /**
   * Observe the answer as it streams, so first-token latency is measured rather than reconstructed.
   * On by default. Turning it off does not restore a derived first-token time — it records the
   * value as unavailable with a reason, which is what not measuring something looks like.
   */
  stream?: boolean;
  transport?: OllamaTransport;
  now?: () => Date;
}

/** What the engine treats as a model that is installed and ready to be benchmarked. */
export interface DiscoveredModel {
  name: string;
  modelID: string;
  runtimeDigest: string;
  parameterSize: string;
  quantization: string;
  family: string;
  sizeBytes?: number;
}

/** Read-only discovery of what is already installed locally. Never pulls, never creates. */
export async function discoverLocalModels(endpoint: string, transport?: OllamaTransport): Promise<DiscoveredModel[]> {
  const live = transport ?? new OllamaHTTPTransport(endpoint, liveAuthorization());
  const rows: OllamaInstalledModel[] = 'installedModels' in live
    ? await (live as OllamaHTTPTransport).installedModels()
    : [];
  return rows.map((row) => ({
    name: row.name,
    modelID: row.name,
    runtimeDigest: row.digest ?? '',
    parameterSize: row.parameterSize ?? '',
    quantization: row.quantizationLevel ?? '',
    family: row.family ?? '',
    sizeBytes: row.sizeBytes,
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The listing digest the model-store guard compares against. Order-independent by construction. */
export function modelStoreBaseline(models: DiscoveredModel[]): { listingDigest: string; count: number } {
  return {
    listingDigest: digestObject([...models].map((model) => [model.name, model.runtimeDigest]).sort() as unknown as string[][]),
    count: models.length,
  };
}

export class LiveHost implements CampaignHost {
  readonly residency: ResidencyController;
  readonly now: () => Date;
  private readonly transport: OllamaTransport;
  private readonly evaluationEngine: EvaluationEngine;

  constructor(private readonly options: LiveHostOptions) {
    this.transport = options.transport ?? new OllamaHTTPTransport(options.endpoint, liveAuthorization());
    this.now = options.now ?? (() => new Date());
    this.evaluationEngine = new EvaluationEngine(policyCatalog, this.now);
    this.residency = new LiveResidency(
      async () => (await this.transport.runningModels()).map((model) => model.name),
      async (model) => { await this.unload(model); },
      options.enableResidency === true,
    );
  }

  /**
   * An unload is a chat carrying `keep_alive: 0` — the runtime's own way of being told to release
   * the weights now. A request without it merely resets the idle timer, which is why the first
   * version of this method appeared to work and left the model resident; the residency guard caught
   * that on the very first live run, which is exactly what it is for.
   */
  private async unload(model: string): Promise<void> {
    try {
      await this.transport.chat({
        model, messages: [{ role: 'user', content: 'stop' }], stopSequences: [], requireJSONFormat: false,
        thinkingMode: 'disabled', timeoutMilliseconds: 30_000, maxOutputTokens: 1, keepAliveSeconds: 0,
      }, new CancellationToken());
    } catch {
      // The unload's own success is not evidence — `unloadAndVerify` reads the resident set back.
    }
  }

  async observeIdentity(candidate: PlannableCandidate): Promise<ObservedModelIdentity> {
    try {
      const report = await this.transport.model(candidate.modelID);
      return {
        name: candidate.name,
        modelID: candidate.modelID,
        runtimeDigest: report.digest,
        parameterSize: report.parameterSize,
        quantization: report.quantizationLevel,
      };
    } catch {
      // The runtime declining to answer is "unreported", never "matched". `verifyModelIdentity`
      // turns that into `unverifiable`, which is carried rather than treated as a pass.
      return {};
    }
  }

  async run(request: AttemptRequest): Promise<AttemptOutcome> {
    const benchmarkCase = this.options.catalogue.cases.get(request.slot.caseID);
    if (!benchmarkCase) return this.failed('engine.unknownCase', `case ${request.slot.caseID} is not in the catalogue`);

    const messages = benchmarkCase.inputs.messages.map((message) => ({ role: message.role as string, content: message.content }));
    // The supplied context is appended as its own message so it can be READ BACK and verified.
    // Interpolating it into a prompt string would make the verification check the case against
    // itself, which is exactly the situation the verification exists to catch.
    const assembledContext = benchmarkCase.inputs.syntheticContext;
    if (assembledContext !== undefined) messages.push({ role: 'user', content: assembledContext });

    const chatRequest = {
      model: request.slot.modelID,
      messages,
      temperatureMilli: benchmarkCase.generationSettings.temperatureMilli,
      topPMilli: benchmarkCase.generationSettings.topPMilli,
      maxOutputTokens: benchmarkCase.generationSettings.maxOutputTokens,
      seed: benchmarkCase.generationSettings.seed,
      stopSequences: benchmarkCase.generationSettings.stopSequences,
      requireJSONFormat: benchmarkCase.responseFormat === 'json',
      thinkingMode: this.options.thinkingMode ?? 'disabled',
      timeoutMilliseconds: benchmarkCase.executionBudgetMilliseconds,
    };

    // Every arrival time this attempt reports is written HERE, from the client's clock, at the
    // moment bytes landed. Nothing in this method computes a timestamp from a duration the runtime
    // reported afterwards — an attempt that was not watched records no first-token time at all.
    const startedAt = Date.now();
    const streamEvents: StreamEvent[] = [];
    const cancellation = new CancellationToken();
    try {
      let report: OllamaChatReport;
      if (this.options.stream !== false && supportsStreaming(this.transport)) {
        report = await this.transport.chatStream(chatRequest, cancellation, (chunk, atMilliseconds) => {
          // No token count rides along: the stream carries text, and the runtime publishes a single
          // combined completion count only in its final chunk. Attaching an estimate here is
          // exactly the invention this pass removed.
          if (chunk.thinkingDelta.length > 0) streamEvents.push({ channel: 'thinking', atMilliseconds });
          if (chunk.contentDelta.length > 0) streamEvents.push({ channel: 'visible', atMilliseconds });
        });
      } else {
        report = await this.transport.chat(chatRequest, cancellation);
      }
      const totalElapsedMilliseconds = Date.now() - startedAt;

      return {
        answerText: report.content,
        assembledContext,
        streamEvents,
        runtime: {
          loadDurationNanoseconds: report.loadDurationNanoseconds,
          promptEvalDurationNanoseconds: report.promptEvalDurationNanoseconds,
          evalDurationNanoseconds: report.evalDurationNanoseconds,
          evalTokenCount: report.evalCount,
          promptTokenCount: report.promptEvalCount,
          doneReason: report.doneReason,
          weightsWereLoaded: report.loadDurationNanoseconds !== undefined ? report.loadDurationNanoseconds > 100_000_000 : undefined,
        },
        totalElapsedMilliseconds,
      };
    } catch (error) {
      // The events already collected are kept. Those bytes genuinely arrived when they say they
      // did, and a stream that broke after a first token is a materially different failure from
      // one that never produced anything.
      return this.failed('ollama.chatFailed', error instanceof Error ? error.message : String(error), Date.now() - startedAt, streamEvents);
    }
  }

  private failed(code: string, detail: string, elapsed?: number, streamEvents: StreamEvent[] = []): AttemptOutcome {
    return { answerText: '', streamEvents, runtime: {}, totalElapsedMilliseconds: elapsed, failure: { code, detail } };
  }

  /**
   * Score through the portable core's own evaluation engine, so a campaign scored here and a run
   * scored by the desktop application reach the same verdict from the same rules.
   */
  async score(slot: PlanSlot, answerText: string): Promise<{ status: TerminalSlotStatus; governanceViolated: boolean; detail: string }> {
    const benchmarkCase = this.options.catalogue.cases.get(slot.caseID);
    if (!benchmarkCase) return { status: 'unsupported', governanceViolated: false, detail: `case ${slot.caseID} is not in the catalogue` };
    const verdict = this.evaluationEngine.evaluate(syntheticAttemptFor(benchmarkCase, slot, answerText));
    const governanceViolated = isViolation(verdict.verdict.governance);
    return {
      status: statusFor(verdict.verdict.status),
      governanceViolated,
      detail: verdict.verdict.disqualificationReason
        ?? (verdict.verdict.metrics.map((metric) => metric.detail).filter(Boolean).join('; ')
          || `${verdict.evaluatorID} returned ${verdict.verdict.status}`),
    };
  }

  async readSystem(): Promise<SystemReading> {
    const models = await discoverLocalModels(this.options.endpoint, this.transport).catch(() => [] as DiscoveredModel[]);
    const baseline = modelStoreBaseline(models);
    return {
      freeDiskBytes: await freeDiskBytes(this.options.diskPath ?? os.tmpdir()),
      swapUsedBytes: await swapUsedBytes(),
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem(),
      listeners: await readListeners(),
      modelStoreListingDigest: baseline.listingDigest,
      modelStoreCount: baseline.count,
    };
  }
}

/** The core's evaluator wants an attempt record; this is the smallest honest one. */
function syntheticAttemptFor(benchmarkCase: BenchmarkCase, slot: PlanSlot, answerText: string) {
  return {
    attemptID: `attempt:${sha256Text(slot.slotKey).slice(0, 16)}`,
    runID: slot.slotKey,
    ordinal: slot.slotIndex,
    repetitionIndex: slot.pass - 1,
    candidate: makeCandidate({
      id: { raw: slot.candidate },
      displayName: slot.candidate,
      provider: 'ollama',
      exactModelIdentity: slot.modelID,
      artifactDigest: slot.caseDigest ? measured(slot.caseDigest) : unavailable('the runtime reported no artifact digest'),
      executionClass: 'localHostProcess',
      quantization: '',
      declaredContextLimitTokens: unavailable('not needed to score an answer from its text'),
      inputModalities: ['text'],
      outputModalities: ['text'],
      streaming: 'unknown',
      structuredOutput: 'declared',
      toolCalls: 'unknown',
      runtimeConfiguration: { settings: [] },
      reproducibility: 'bestEffort',
      privacyClass: 'onDeviceOnly',
      availability: { state: 'available' },
    }),
    candidateDigest: '',
    suiteID: benchmarkCase.suiteID,
    suiteVersion: benchmarkCase.suiteVersion,
    caseID: benchmarkCase.id,
    caseDigest: slot.caseDigest,
    inputPackage: benchmarkCase.inputs,
    inputPackageDigest: '',
    scoringPolicyID: benchmarkCase.scoringPolicyID,
    scoringPolicyVersion: benchmarkCase.scoringPolicyVersion,
    environment: { capturedAt: '', machineIdentifier: { unavailableReason: 'not captured for scoring' }, hardwareModel: { unavailableReason: 'not captured for scoring' },
      cpuCoreCount: { unavailableReason: 'not captured for scoring' }, physicalMemoryBytes: { unavailableReason: 'not captured for scoring' },
      osVersion: { unavailableReason: 'not captured for scoring' }, inferenceRuntimeVersion: { unavailableReason: 'not captured for scoring' } },
    observation: {
      outputText: answerText,
      structuredOutputRaw: benchmarkCase.responseFormat === 'json' ? answerText : undefined,
      toolCallObservationsRaw: [],
      terminalStatus: 'completed' as const,
      providerReportedUsage: { unavailableReason: 'scored from text alone' },
      timing: { totalElapsedMilliseconds: { unavailableReason: 'scored from text alone' }, firstTokenMilliseconds: { unavailableReason: 'scored from text alone' } },
      warnings: [], errors: [],
      identityVerification: { state: 'unverifiable' as const, reason: 'identity is verified by the engine, not the evaluator' },
      runtimeConfigurationID: '', requestDigest: '',
    },
    terminalStatus: 'completed' as const,
    comparabilityKey: slot.comparabilityKey,
    startedAt: '', finishedAt: '',
  };
}

function statusFor(status: string): TerminalSlotStatus {
  switch (status) {
    case 'pass': return 'pass';
    case 'partial': return 'partial';
    case 'fail': return 'fail';
    case 'requiresHumanReview': return 'requiresHumanReview';
    case 'notApplicable': return 'unsupported';
    default: return 'fail';
  }
}

