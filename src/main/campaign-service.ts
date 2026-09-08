// The Electron side of the benchmark-engine boundary.
//
// This service owns NOTHING about how a campaign works. It resolves the campaign root, opens
// campaigns through `Campaign`, and turns their status into plain JSON for the renderer. Every rule
// — what a slot is, when a guard aborts, what counts as a pass — lives in `src/engine`, shared with
// the terminal command, so the two cannot drift apart.
//
// A campaign started in the terminal appears here because both write to the same directory, and
// this service re-reads the ledger rather than caching it. That is why "observed in the desktop UI
// without the terminal being the controller" is a property of the layout rather than of a message
// bus that has to stay up.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import {
  Campaign, CampaignConfiguration, CampaignStatus, Ledger, LiveHost, allRankableSuiteIDs, buildEngineCatalogue,
  campaignPaths, discoverLocalModels, guardPolicyForEndpoint, modelStoreBaseline,
} from '../engine/index';
import type { FinalReport } from '../engine/campaign';
import type { VerificationReport } from '../engine/manifest';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../shared/product';
import type { CampaignRow, CampaignDetail, CampaignCreateRequest } from '../shared/ipc';

export class CampaignServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignServiceError';
  }
}

export class CampaignService extends EventEmitter {
  private active?: { name: string; pause: () => void };

  constructor(private readonly endpoint: () => string) {
    super();
  }

  /** The same path `cernum` computes, so both see the same campaigns. */
  root(): string {
    return process.env.MODEL_LAB_CAMPAIGN_ROOT ?? path.join(app.getPath('userData'), CAMPAIGN_DIRECTORY_NAME);
  }

  private directory(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new CampaignServiceError(`campaign name '${name}' is not filesystem-safe`);
    return path.join(this.root(), name);
  }

  private configuration(name: string): CampaignConfiguration {
    const file = path.join(this.directory(name), 'configuration.json');
    if (!fs.existsSync(file)) throw new CampaignServiceError(`no configuration.json for campaign '${name}'`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CampaignConfiguration;
  }

  private open(name: string): Campaign {
    const configuration = this.configuration(name);
    return Campaign.open(this.directory(name), configuration, new LiveHost({
      endpoint: this.endpoint(),
      catalogue: buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase),
    }));
  }

  /**
   * Every campaign on disk, read fresh.
   *
   * Read from the LEDGER rather than from an in-memory index: a campaign the terminal is running
   * right now has no object in this process, and an index would show it as it was when the
   * application started.
   */
  list(): CampaignRow[] {
    const root = this.root();
    if (!fs.existsSync(root)) return [];
    const rows: CampaignRow[] = [];
    for (const name of fs.readdirSync(root).sort()) {
      const directory = path.join(root, name);
      if (!Campaign.exists(directory)) continue;
      try {
        const ledger = Ledger.open(campaignPaths(directory).ledger);
        const reconciliation = ledger.reconcile();
        const meta = ledger.meta();
        const abort = ledger.standingAbort();
        rows.push({
          name,
          label: typeof meta.label === 'string' ? meta.label : name,
          state: reconciliation.complete ? 'complete' : abort ? 'aborted' : reconciliation.terminal === 0 ? 'created' : 'paused',
          slotCount: reconciliation.slotCount,
          terminalCount: reconciliation.terminal,
          blockedCount: reconciliation.blocked,
          balances: reconciliation.balances,
          manifestID: typeof meta.manifestID === 'string' ? meta.manifestID : '',
          createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
          running: this.active?.name === name,
          directory,
        });
      } catch (error) {
        // A campaign directory that cannot be read is reported, never skipped silently: a
        // disappeared campaign is exactly the thing a person needs to be told about.
        rows.push({
          name, label: name, state: 'unreadable', slotCount: 0, terminalCount: 0, blockedCount: 0, balances: false,
          manifestID: '', createdAt: '', running: false, directory,
          problem: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  }

  detail(name: string): CampaignDetail {
    const campaign = this.open(name);
    const status = campaign.status(this.active?.name === name ? 'running' : undefined);
    const paths = campaignPaths(this.directory(name));
    const report = fs.existsSync(paths.report) ? JSON.parse(fs.readFileSync(paths.report, 'utf8')) as FinalReport : undefined;
    return {
      status: status as CampaignStatus,
      manifest: {
        manifestID: campaign.manifest.manifestID,
        seal: status.manifestSeal,
        frozenAt: campaign.manifest.frozenAt,
        promptCount: campaign.manifest.promptDigests.length,
        candidateCount: campaign.manifest.candidates.length,
        retestOf: campaign.manifest.retestOf?.manifestID,
      },
      recentAttempts: [...campaign.ledger.results.values()]
        .sort((a, b) => b.seq - a.seq).slice(0, 25)
        .map((result) => ({
          slotKey: result.slotKey,
          status: result.status,
          detail: typeof result.detail === 'string' ? result.detail : '',
          latencyMilliseconds: typeof result.latencyMilliseconds === 'number' ? result.latencyMilliseconds : undefined,
          identityState: typeof result.identityState === 'string' ? result.identityState : 'unverifiable',
          suppliedContextState: typeof result.suppliedContextState === 'string' ? result.suppliedContextState : 'notSupplied',
        })),
      events: campaign.ledger.events().slice(-40).map((event) => ({ kind: String(event.kind), at: String(event.at) })),
      anomalies: campaign.ledger.anomalies.map((anomaly) => ({ kind: anomaly.kind, why: anomaly.why ?? '' })),
      report: report ? {
        provisional: report.rankings.provisional,
        provisionalBecause: report.rankings.provisionalBecause,
        rankings: report.rankings.rankings.map((ranking) => ({
          rank: ranking.rank, candidate: ranking.candidate, disqualified: ranking.disqualified,
          passRateMilli: 'measured' in ranking.overallPassRateMilli ? ranking.overallPassRateMilli.measured : undefined,
          scoredCount: ranking.scoredCount,
          roles: ranking.roles.filter((role) => role.qualified).map((role) => role.role),
        })),
        retentionHeading: report.retention.heading,
        retention: report.retention.recommendations.map((recommendation) => ({ candidate: recommendation.candidate, outcome: recommendation.outcome, statement: recommendation.statement })),
        awaitingHumanReview: report.humanReview.awaiting,
        packetPath: report.humanReview.packetPath,
        packetClean: report.humanReview.audit?.clean,
      } : undefined,
      terminalHint: `${TERMINAL_COMMAND} status ${name} --root ${this.root()}`,
    };
  }

  verify(name: string): VerificationReport {
    return this.open(name).verify();
  }

  async availableSuites(): Promise<{ id: string; title: string; caseCount: number }[]> {
    const catalogue = buildEngineCatalogue(allRankableSuiteIDs(), 1);
    return catalogue.suites.map((suite) => ({ id: suite.id.raw, title: suite.title, caseCount: suite.cases.length }));
  }

  async create(request: CampaignCreateRequest): Promise<CampaignRow[]> {
    const directory = this.directory(request.name);
    if (Campaign.exists(directory)) throw new CampaignServiceError(`a campaign already exists at ${directory}`);
    const endpoint = this.endpoint();
    const installed = await discoverLocalModels(endpoint);
    const candidates = request.modelNames.map((wanted) => {
      const found = installed.find((model) => model.name === wanted || model.name === `${wanted}:latest`);
      if (!found) throw new CampaignServiceError(`model '${wanted}' is not installed at ${endpoint}`);
      return { name: found.name, modelID: found.name, runtimeDigest: found.runtimeDigest, parameterSize: found.parameterSize, quantization: found.quantization };
    });
    const configuration: CampaignConfiguration = {
      label: request.label || request.name,
      suiteIDs: request.suiteIDs.length > 0 ? request.suiteIDs : allRankableSuiteIDs(),
      repeatsPerCase: Math.max(1, request.repeatsPerCase),
      candidates,
      hardware: {
        platform: process.platform, architecture: process.arch, model: os.hostname(),
        cpuCoreCount: os.cpus().length, physicalMemoryBytes: os.totalmem(), osVersion: `${os.type()} ${os.release()}`,
      },
      runtimeVersion: request.runtimeVersion || 'ollama-unreported',
      storeBaseline: modelStoreBaseline(installed),
      guardPolicy: guardPolicyForEndpoint(endpoint),
      residencyDelayMilliseconds: 5_000,
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');
    Campaign.create(directory, configuration, new LiveHost({
      endpoint, catalogue: buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase),
    }));
    return this.list();
  }

  /** Start (or resume) a campaign in this process. One at a time: two runners would race the ledger. */
  async start(name: string): Promise<CampaignStatus> {
    if (this.active) throw new CampaignServiceError(`${this.active.name} is already running; only one campaign runs at a time so two runners cannot race the same ledger`);
    const campaign = this.open(name);
    let pausing = false;
    this.active = { name, pause: () => { pausing = true; } };
    try {
      return await campaign.run({
        shouldPause: () => pausing,
        onProgress: (status, trace) => this.emit('campaignProgress', { status, trace }),
      });
    } finally {
      this.active = undefined;
      this.emit('campaignProgress', { status: campaign.status(), trace: undefined });
    }
  }

  /** Ask the running campaign to stop at the next attempt boundary. The attempt in flight completes. */
  pause(): void {
    this.active?.pause();
  }

  finalize(name: string, blindingSecret: string): FinalReport {
    return this.open(name).finalize({ blindingSecret });
  }

  activeName(): string | undefined {
    return this.active?.name;
  }

  productName(): string {
    return PRODUCT.name;
  }
}
