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

import * as os from 'node:os';
import { CancellationToken } from '../core/adapter';
import { OllamaChatReport, OllamaInstalledModel, OllamaTransport, ThinkingMode, supportsStreaming } from '../core/ollama';
import { LiveExecutionAuthorization, OllamaHTTPTransport } from '../core/ollama-http';
import { AttemptOutcome, AttemptRequest, CampaignHost } from './campaign';
import { EngineCatalogue } from './catalogue';
import { CatalogueScorer } from './scoring';
import { PlanSlot, PlannableCandidate, TerminalSlotStatus } from './ledger';
import { GIB, SystemReading } from './guards';
import { LiveResidency, ResidencyController } from './residency';
import { ObservedModelIdentity } from './verification';
import { StreamEvent } from './attempt-telemetry';
import { digestObject } from './canonical';
import { availableMemoryBytes, freeDiskBytes, readListeners, swapUsedBytes } from './machine';

export { readListeners };

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
  /** What the runtime says this model can do. Undefined means it did not say — not "nothing". */
  capabilities?: string[];
}

/** True only when the runtime SAID this model can think. Unreported capabilities answer `undefined`. */
export function modelCanThink(model: { capabilities?: string[] }): boolean | undefined {
  return model.capabilities === undefined ? undefined : model.capabilities.includes('thinking');
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
    capabilities: row.capabilities,
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
  private readonly scorer: CatalogueScorer;

  constructor(private readonly options: LiveHostOptions) {
    this.transport = options.transport ?? new OllamaHTTPTransport(options.endpoint, liveAuthorization());
    this.now = options.now ?? (() => new Date());
    // The SHARED scorer, not a private one. A frontier-only campaign is scored by this same object,
    // so a local answer and an API answer cannot be judged by two implementations that agree today.
    this.scorer = new CatalogueScorer(options.catalogue, this.now);
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
        capabilities: report.capabilities,
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
    return this.scorer.score(slot, answerText);
  }

  /**
   * Which runtime this host talks to, and what it currently holds.
   *
   * This is what the runtime lease is taken against. The endpoint is reported exactly as configured
   * and normalized by the lease itself, so two callers who spelled the same server differently still
   * contend for it.
   */
  async runtimeIdentity(): Promise<{ endpoint: string; modelStoreListingDigest: string; modelStoreCount: number }> {
    const models = await discoverLocalModels(this.options.endpoint, this.transport).catch(() => [] as DiscoveredModel[]);
    const baseline = modelStoreBaseline(models);
    return { endpoint: this.options.endpoint, modelStoreListingDigest: baseline.listingDigest, modelStoreCount: baseline.count };
  }

  async readSystem(): Promise<SystemReading> {
    const models = await discoverLocalModels(this.options.endpoint, this.transport).catch(() => [] as DiscoveredModel[]);
    const baseline = modelStoreBaseline(models);
    return {
      freeDiskBytes: await freeDiskBytes(this.options.diskPath ?? os.tmpdir()),
      swapUsedBytes: await swapUsedBytes(),
      freeMemoryBytes: await availableMemoryBytes(),
      totalMemoryBytes: os.totalmem(),
      listeners: await readListeners(),
      modelStoreListingDigest: baseline.listingDigest,
      modelStoreCount: baseline.count,
    };
  }
}



