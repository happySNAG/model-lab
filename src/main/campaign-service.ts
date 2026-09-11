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
  Campaign, CampaignConfiguration, CampaignStatus, DEFAULT_EXECUTION_POLICY, ExecutionPolicy, Ledger, LiveHost,
  NONCANONICAL_REASONS, allRankableSuiteIDs, buildEngineCatalogue, campaignPaths, describeExecutionPolicy,
  discoverLocalModels, guardPolicyForEndpoint, hostOptionsFor, inspectCampaignLock, leasedEndpoints, modelCanThink, modelStoreBaseline,
  residencyDisclosure,
} from '../engine/index';
import type { FinalReport } from '../engine/campaign';
import type { VerificationReport } from '../engine/manifest';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../shared/product';
import type {
  CampaignRow, CampaignDetail, CampaignCreateRequest, CampaignExecutionRow, CampaignStartDisclosure, TerminalCommandRow,
} from '../shared/ipc';
import { installTerminalCommand, terminalCommandStatus, uninstallTerminalCommand } from '../shared/terminal-install';

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

  private executionOf(configuration: CampaignConfiguration): ExecutionPolicy {
    return configuration.execution ?? DEFAULT_EXECUTION_POLICY;
  }

  /**
   * Open a campaign with a host configured the way the campaign was FROZEN.
   *
   * `enableResidency` is the fix for the release-blocking defect: this service used to build its
   * host without it, so `LiveResidency` was disabled and the end-of-candidate release threw
   * `LiveResidencyDisabled` out of `run()` — every desktop-started live campaign ended in an error
   * rather than a result. Cernum is an active benchmark controller: for a canonical campaign it is
   * authorised to manage residency on the selected benchmark endpoint, and that authority is
   * disclosed at Start rather than assumed silently. For an observe-only campaign it stays off, and
   * the campaign is labelled noncanonical everywhere it appears.
   */
  private open(name: string): Campaign {
    const configuration = this.configuration(name);
    const execution = this.executionOf(configuration);
    return Campaign.open(this.directory(name), configuration, new LiveHost({
      endpoint: this.endpoint(),
      catalogue: buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase),
      ...hostOptionsFor(execution),
    }));
  }

  private executionRow(execution: ExecutionPolicy): CampaignExecutionRow {
    const canonical = execution.residency === 'managed';
    return {
      residency: execution.residency,
      thinkingMode: execution.thinkingMode,
      canonical,
      summary: describeExecutionPolicy(execution),
      noncanonicalBecause: canonical ? [] : NONCANONICAL_REASONS,
    };
  }

  /**
   * What to tell a person before this campaign starts. Read once, at Start.
   *
   * Authored in the engine and merely relayed here, so the terminal and the interface cannot drift
   * into two different accounts of the same authority.
   */
  disclosure(name: string): CampaignStartDisclosure {
    const configuration = this.configuration(name);
    const execution = this.executionOf(configuration);
    const endpoint = this.endpoint();
    const candidates = configuration.candidates.map((candidate) => candidate.name);
    return {
      name,
      endpoint,
      candidates,
      canonical: execution.residency === 'managed',
      lines: execution.residency === 'managed' ? residencyDisclosure(endpoint, candidates) : NONCANONICAL_REASONS,
    };
  }

  leasedEndpoints(): { endpoint: string; campaignName: string; processType: string; pid: number; state: string; message: string }[] {
    return leasedEndpoints(this.root())
      .filter((lease) => lease.record?.endpoint)
      .map((lease) => ({
        endpoint: lease.record!.endpoint!,
        campaignName: lease.record!.campaignName,
        processType: lease.record!.processType,
        pid: lease.record!.pid,
        state: lease.state ?? 'live',
        message: lease.message,
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
        // Read from the lock file, not from this process's memory: a campaign the terminal is
        // running has no object here, and showing it as idle while it advances is the exact
        // confusion the lock exists to remove.
        const lock = inspectCampaignLock(directory);
        rows.push({
          name,
          label: typeof meta.label === 'string' ? meta.label : name,
          state: reconciliation.complete ? 'complete'
            : lock.held && (lock.state === 'live' || lock.state === 'selfHeld') ? 'running'
              : abort ? 'aborted' : reconciliation.terminal === 0 ? 'created' : 'paused',
          slotCount: reconciliation.slotCount,
          terminalCount: reconciliation.terminal,
          blockedCount: reconciliation.blocked,
          balances: reconciliation.balances,
          manifestID: typeof meta.manifestID === 'string' ? meta.manifestID : '',
          createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
          running: this.active?.name === name,
          directory,
          execution: this.executionRow(this.executionOf(
            JSON.parse(fs.readFileSync(path.join(directory, 'configuration.json'), 'utf8')) as CampaignConfiguration)),
          owner: lock.held && lock.record ? {
            processType: lock.record.processType, command: lock.record.command, pid: lock.record.pid,
            hostname: lock.record.hostname, acquiredAt: lock.record.acquiredAt,
            state: lock.state ?? 'live', message: lock.message,
          } : undefined,
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
      execution: this.executionRow(campaign.execution),
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
        canonical: report.canonical ?? true,
        noncanonicalBecause: report.noncanonicalBecause ?? [],
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
    const execution: ExecutionPolicy = {
      residency: request.observeOnly === true ? 'observeOnly' : 'managed',
      thinkingMode: request.thinkingMode ?? 'disabled',
    };
    const candidates = request.modelNames.map((wanted) => {
      const found = installed.find((model) => model.name === wanted || model.name === `${wanted}:latest`);
      if (!found) throw new CampaignServiceError(`model '${wanted}' is not installed at ${endpoint}`);
      // Refused at create, before anything is frozen. Substituting thinking-off would record
      // answers to a different experiment under a manifest that says otherwise.
      if (execution.thinkingMode === 'enabled' && modelCanThink(found) === false) {
        throw new CampaignServiceError(
          `Thinking was requested, but ${endpoint} reports that ${found.name} cannot think `
          + `(it reports: ${(found.capabilities ?? []).join(', ') || 'nothing'}). Nothing was created. `
          + 'Choose a thinking-capable model, or turn thinking off for this campaign.');
      }
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
      execution,
      storeBaseline: modelStoreBaseline(installed),
      guardPolicy: guardPolicyForEndpoint(endpoint),
      residencyDelayMilliseconds: 5_000,
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');
    Campaign.create(directory, configuration, new LiveHost({
      endpoint,
      catalogue: buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase),
      ...hostOptionsFor(execution),
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
        // The in-process guard above stops two windows of THIS application; the campaign lock is
        // what stops this application and a terminal, which no amount of in-process state can see.
        owner: { processType: 'desktop', command: `${PRODUCT.name} ${PRODUCT.version} · Campaigns screen` },
        // The runtime lease lives beside the campaigns, so a campaign the terminal is running
        // against this endpoint refuses this one before a single request is sent.
        campaignRootDirectory: this.root(),
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

  // ------------------------------------------------------------------ the installed terminal command

  terminalCommand(): TerminalCommandRow {
    return terminalCommandStatus();
  }

  /** Writes one file into a directory the user owns. Never PATH, never a profile, never elevated. */
  installTerminalCommand(): TerminalCommandRow {
    return installTerminalCommand();
  }

  /** Removes exactly the file `installTerminalCommand` wrote, identified by its marker. */
  uninstallTerminalCommand(): TerminalCommandRow {
    return uninstallTerminalCommand();
  }
}
