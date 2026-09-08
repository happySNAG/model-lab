#!/usr/bin/env node
// The supported terminal interface to the benchmark engine.
//
// This command and the desktop application are two faces of ONE engine. It imports
// `src/engine/index.ts` and nothing deeper, exactly as the Electron main process does, and it
// writes campaigns into the same directory the application reads — so a campaign started here is
// visible in the application while it runs, and a campaign started there can be resumed here.
//
// It is deliberately small. Everything it does is one call into `Campaign`; the orchestration,
// the guards, the manifest verification and the ledger all live in the engine where both callers
// share them. A terminal that reimplemented any of that would eventually disagree with the
// application about what a campaign is.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Campaign, CampaignConfiguration, CampaignStatus, Ledger, LiveHost, SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE,
  SyntheticHost, allRankableSuiteIDs, buildEngineCatalogue, campaignPaths, discoverLocalModels, guardPolicyForEndpoint,
  modelStoreBaseline, steppingClock, syntheticCandidate,
} from '../engine/index';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../shared/product';

const DEFAULT_ENDPOINT = process.env.MODEL_LAB_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';

/** The same root the desktop application uses, so both see the same campaigns. */
export function defaultCampaignRoot(): string {
  const override = process.env.MODEL_LAB_CAMPAIGN_ROOT;
  if (override) return override;
  const home = os.homedir();
  const base = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', PRODUCT.name)
    : process.platform === 'win32' ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), PRODUCT.name)
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), PRODUCT.slug);
  return path.join(base, CAMPAIGN_DIRECTORY_NAME);
}

interface Options { [key: string]: string | boolean }

function parse(argv: string[]): { command: string; positional: string[]; options: Options } {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const options: Options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split('=');
    if (inline !== undefined) { options[name] = inline; continue; }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { options[name] = next; i += 1; }
    else options[name] = true;
  }
  return { command, positional, options };
}

function say(line = ''): void {
  process.stdout.write(line + '\n');
}

function fail(message: string): never {
  process.stderr.write(`${TERMINAL_COMMAND}: ${message}\n`);
  process.exit(1);
}

function campaignDirectory(root: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`campaign name '${name}' is not filesystem-safe (lowercase letters, digits, hyphens)`);
  return path.join(root, name);
}

function readConfiguration(directory: string): CampaignConfiguration {
  const file = path.join(directory, 'configuration.json');
  if (!fs.existsSync(file)) fail(`no configuration.json in ${directory}; this is not a campaign directory`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CampaignConfiguration;
}

function renderStatus(status: CampaignStatus): void {
  say(`  ${status.label}  [${status.state}]`);
  say(`  ${status.manifestSeal}`);
  say(`  ${status.terminalCount}/${status.slotCount} attempts recorded, ${status.remaining} remaining${status.blockedCount > 0 ? `, ${status.blockedCount} blocked` : ''}`);
  const byStatus = Object.entries(status.byStatus).sort();
  if (byStatus.length > 0) say(`  outcomes: ${byStatus.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  if (status.candidatesComplete.length > 0) say(`  finished: ${status.candidatesComplete.join(', ')}`);
  if (status.currentCandidate) say(`  next: ${status.currentCandidate} · ${status.currentCaseID}`);
  if (status.standingAbort) {
    say(`  ABORTED at ${status.standingAbort.stage}: ${status.standingAbort.reason}`);
    say(`  ${status.standingAbort.blockedSlotCount} slot(s) blocked; they were never attempted and carry no result.`);
    say(`  Resolve the breach, then: ${TERMINAL_COMMAND} resume ${path.basename(status.root)}`);
  }
  if (!status.reconciliation.balances) say('  WARNING: the ledger does not balance; every rate derived from it is provisional.');
}

async function hostFor(configuration: CampaignConfiguration, options: Options) {
  const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
  if (options.synthetic) {
    const pinned = Object.fromEntries(configuration.candidates.map((candidate) => [candidate.name, candidate]));
    return new SyntheticHost({}, steppingClock(), pinned);
  }
  return new LiveHost({
    endpoint: String(options.endpoint ?? DEFAULT_ENDPOINT),
    catalogue,
    enableResidency: options['live-residency'] === true,
  });
}

// MARK: - Commands

async function commandModels(options: Options): Promise<void> {
  const endpoint = String(options.endpoint ?? DEFAULT_ENDPOINT);
  const models = await discoverLocalModels(endpoint);
  if (models.length === 0) { say(`No models are installed at ${endpoint}.`); return; }
  say(`${models.length} model(s) installed at ${endpoint}:`);
  for (const model of models) {
    const size = model.sizeBytes ? ` ${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '';
    say(`  ${model.name.padEnd(22)} ${model.parameterSize.padEnd(6)} ${model.quantization.padEnd(10)}${size}  ${model.runtimeDigest.slice(0, 12)}`);
  }
  say('');
  say('Discovery is read-only. This command never pulls, creates or deletes a model.');
}

async function commandSuites(): Promise<void> {
  const catalogue = buildEngineCatalogue(allRankableSuiteIDs(), 1);
  say(`${catalogue.suites.length} suite(s), ${catalogue.plannable.caseCount} case(s):`);
  for (const suite of catalogue.suites) {
    say(`  ${suite.id.raw.padEnd(42)} ${String(suite.cases.length).padStart(2)} case(s)  ${suite.title}`);
  }
}

async function commandCreate(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} create <name> --models a,b [--suites x,y] [--repeats n]`);
  const root = String(options.root ?? defaultCampaignRoot());
  const directory = campaignDirectory(root, name);
  if (Campaign.exists(directory)) fail(`a campaign already exists at ${directory}`);

  const suiteIDs = options.suites ? String(options.suites).split(',') : allRankableSuiteIDs();
  const repeatsPerCase = Number(options.repeats ?? 1);
  const endpoint = String(options.endpoint ?? DEFAULT_ENDPOINT);

  let candidates: CampaignConfiguration['candidates'];
  let hardware = SYNTHETIC_HARDWARE;
  let storeBaseline = SYNTHETIC_STORE_BASELINE;
  let runtimeVersion = 'synthetic-runtime-1.0';

  if (options.synthetic) {
    const names = String(options.models ?? 'alpha:1b,beta:2b').split(',');
    candidates = names.map(syntheticCandidate);
  } else {
    if (!options.models) fail('--models is required (comma-separated), or pass --synthetic to run against the deterministic host');
    const wanted = String(options.models).split(',');
    const installed = await discoverLocalModels(endpoint);
    candidates = wanted.map((wantedName) => {
      const found = installed.find((model) => model.name === wantedName || model.name === `${wantedName}:latest`);
      if (!found) fail(`model '${wantedName}' is not installed at ${endpoint}; run '${TERMINAL_COMMAND} models' to see what is`);
      return { name: found.name, modelID: found.name, runtimeDigest: found.runtimeDigest, parameterSize: found.parameterSize, quantization: found.quantization };
    });
    storeBaseline = modelStoreBaseline(installed);
    hardware = {
      platform: process.platform, architecture: process.arch, model: os.hostname(),
      cpuCoreCount: os.cpus().length, physicalMemoryBytes: os.totalmem(), osVersion: `${os.type()} ${os.release()}`,
    };
    runtimeVersion = String(options['runtime-version'] ?? 'ollama-unreported');
  }

  const configuration: CampaignConfiguration = {
    label: String(options.label ?? name),
    suiteIDs, repeatsPerCase, candidates, hardware, runtimeVersion, storeBaseline,
    guardPolicy: options.synthetic ? undefined : guardPolicyForEndpoint(endpoint),
    residencyDelayMilliseconds: options.synthetic ? 0 : 5_000,
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');

  const campaign = Campaign.create(directory, configuration, await hostFor(configuration, options));
  say(`Created ${name} at ${directory}`);
  renderStatus(campaign.status());
  say('');
  say(`Start it with: ${TERMINAL_COMMAND} run ${name}${options.synthetic ? ' --synthetic' : ''}`);
}

async function commandRun(positional: string[], options: Options, resuming: boolean): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} ${resuming ? 'resume' : 'run'} <name> [--max-attempts n]`);
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options));

  const verification = campaign.verify();
  if (!verification.intact && !verification.hardwareOnly) {
    say('The frozen manifest no longer describes this campaign:');
    for (const drift of verification.drifts) say(`  ${drift.field}: ${drift.meaning}`);
    say('');
    say('Nothing was run. A campaign whose benchmark moved cannot be resumed into the same evidence.');
    process.exit(2);
  }

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    say('');
    say('Pausing at the next attempt boundary — the attempt in flight will be recorded first.');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const maxAttempts = options['max-attempts'] !== undefined ? Number(options['max-attempts']) : undefined;
  say(`${resuming ? 'Resuming' : 'Running'} ${configuration.label}…`);
  const status = await campaign.run({
    maxAttempts,
    shouldPause: () => stopping,
    onProgress: (progress, trace) => {
      const bar = `${String(progress.terminalCount).padStart(4)}/${progress.slotCount}`;
      say(`  ${bar}  ${trace.status.padEnd(20)} ${trace.slotKey}`);
    },
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  say('');
  renderStatus(status);
  if (status.state === 'complete') say(`\nFinalize it with: ${TERMINAL_COMMAND} finalize ${name}`);
  if (status.state === 'paused') say(`\nResume it with: ${TERMINAL_COMMAND} resume ${name}${options.synthetic ? ' --synthetic' : ''}`);
  if (status.state === 'aborted') process.exit(3);
}

async function commandStatus(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const [name] = positional;
  if (name) {
    const directory = campaignDirectory(root, name);
    const configuration = readConfiguration(directory);
    renderStatus(Campaign.open(directory, configuration, await hostFor(configuration, options)).status());
    return;
  }
  if (!fs.existsSync(root)) { say(`No campaigns under ${root}.`); return; }
  const names = fs.readdirSync(root).filter((entry) => Campaign.exists(path.join(root, entry)));
  if (names.length === 0) { say(`No campaigns under ${root}.`); return; }
  say(`${names.length} campaign(s) under ${root}:`);
  for (const entry of names) {
    const ledger = Ledger.open(campaignPaths(path.join(root, entry)).ledger);
    const reconciliation = ledger.reconcile();
    const state = reconciliation.complete ? 'complete' : ledger.standingAbort() ? 'aborted' : reconciliation.terminal === 0 ? 'created' : 'paused';
    say(`  ${entry.padEnd(28)} ${state.padEnd(10)} ${reconciliation.terminal}/${reconciliation.slotCount}`);
  }
}

async function commandFinalize(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} finalize <name>`);
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options));

  // A blinding secret is generated per finalize and never stored beside the packet. Losing it means
  // a new packet must be built, which is the correct failure: an unblindable packet is safe.
  const secret = String(options.secret ?? randomBytes(24).toString('hex'));
  const report = campaign.finalize({ blindingSecret: secret });
  const paths = campaignPaths(directory);

  say(`${report.label}`);
  say(`  ${report.manifest.seal}`);
  say('');
  if (report.rankings.provisional) {
    say('PROVISIONAL — these rates are not final:');
    for (const reason of report.rankings.provisionalBecause) say(`  · ${reason}`);
    say('');
  }
  say('Rankings');
  for (const ranking of report.rankings.rankings) {
    const rate = 'measured' in ranking.overallPassRateMilli ? `${(ranking.overallPassRateMilli.measured / 10).toFixed(1)}%` : 'no rate';
    say(`  ${String(ranking.rank).padStart(2)}. ${ranking.candidate.padEnd(20)} ${rate.padStart(8)}  ${ranking.disqualified ? 'DISQUALIFIED' : ''}`);
    const roles = ranking.roles.filter((role) => role.qualified).map((role) => role.role);
    if (roles.length > 0) say(`      roles: ${roles.join(', ')}`);
  }
  say('');
  say(report.retention.heading);
  for (const line of report.retention.preamble) say(`  ${line}`);
  say('');
  for (const recommendation of report.retention.recommendations) say(`  · ${recommendation.statement}`);
  say('');
  if (report.humanReview.packetWritten) {
    say(`${report.humanReview.awaiting} answer(s) await blinded human review.`);
    say(`  packet: ${paths.packet}`);
    say(`  key:    ${paths.key}   (keep this apart from the packet until every verdict is recorded)`);
    say(`  audit:  ${report.humanReview.audit?.clean ? 'clean — no identity survived into the packet' : `LEAKED: ${report.humanReview.audit?.leaks.length} term(s)`}`);
  }
  say('');
  say(`Written: ${paths.report}`);
}

async function commandVerify(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} verify <name>`);
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const report = Campaign.open(directory, configuration, await hostFor(configuration, options)).verify();
  if (report.intact) { say(`${report.manifestID}: intact — every binding still matches what was frozen.`); return; }
  say(`${report.manifestID}: ${report.drifts.length} drift(s)${report.hardwareOnly ? ' (hardware only — a retest manifest is what this is for)' : ''}`);
  for (const drift of report.drifts) {
    say(`  ${drift.field}`);
    say(`    ${drift.meaning}`);
    say(`    frozen ${drift.frozen.slice(0, 24)} · observed ${drift.observed.slice(0, 24)}`);
  }
  process.exit(2);
}

async function commandRetest(positional: string[], options: Options): Promise<void> {
  const [name, target] = positional;
  if (!name || !target) fail(`usage: ${TERMINAL_COMMAND} retest <name> <new-name> [--reason "..."]`);
  const root = String(options.root ?? defaultCampaignRoot());
  const directory = campaignDirectory(root, name);
  const configuration = readConfiguration(directory);
  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options));
  const targetDirectory = campaignDirectory(root, target);
  const hardware = {
    platform: process.platform, architecture: process.arch, model: os.hostname(),
    cpuCoreCount: os.cpus().length, physicalMemoryBytes: os.totalmem(), osVersion: `${os.type()} ${os.release()}`,
  };
  const derived = campaign.deriveRetest(targetDirectory, hardware, String(options['runtime-version'] ?? configuration.runtimeVersion),
    String(options.reason ?? 'retest on different hardware'));
  fs.writeFileSync(path.join(targetDirectory, 'configuration.json'),
    JSON.stringify({ ...configuration, label: `${configuration.label} (retest)`, hardware, storeBaseline: undefined }, null, 2) + '\n', 'utf8');
  say(`Derived ${derived.manifestID} for this machine, from ${derived.retestOf?.manifestID}.`);
  say('  The benchmark is carried across byte-identically: same prompts, same scored core, same evaluators, same candidates.');
  say('  Quality is comparable between the two. Latency is NOT — that is what changed.');
  say(`  Written: ${campaignPaths(targetDirectory).manifest}`);
}

function commandHelp(): void {
  say(`${PRODUCT.name} benchmark engine · ${TERMINAL_COMMAND} ${PRODUCT.version}`);
  say('');
  say('  models                          list the models installed locally (read-only)');
  say('  suites                          list the benchmark suites this engine can plan');
  say('  create <name> --models a,b      freeze a manifest and write the plan');
  say('  run <name>                      run it; Ctrl-C pauses cleanly at the next attempt');
  say('  resume <name>                   re-verify the manifest and carry on where it stopped');
  say('  status [<name>]                 one campaign, or every campaign');
  say('  verify <name>                   recompute every manifest binding and report what moved');
  say('  finalize <name>                 reconcile, rank, interpret, and build the blinded packet');
  say('  retest <name> <new-name>        derive a manifest for this machine from another one');
  say('');
  say('  --root <dir>        campaign directory (default: the application\'s own)');
  say('  --endpoint <url>    Ollama endpoint (default: ' + DEFAULT_ENDPOINT + ')');
  say('  --suites a,b        suite ids (default: every ranked suite)');
  say('  --repeats n         passes per case (default: 1)');
  say('  --max-attempts n    stop after n attempts — how a small smoke run is kept small');
  say('  --synthetic         drive the deterministic host; no request reaches any server');
  say('  --live-residency    enable live unload/verify at candidate transitions');
  say('');
  say('Campaigns are written where the desktop application reads them, so a run started here is');
  say('visible there while it runs, and a run started there can be resumed here.');
}

export async function main(argv: string[]): Promise<void> {
  const { command, positional, options } = parse(argv);
  switch (command) {
    case 'models': return commandModels(options);
    case 'suites': return commandSuites();
    case 'create': return commandCreate(positional, options);
    case 'run': return commandRun(positional, options, false);
    case 'resume': return commandRun(positional, options, true);
    case 'status': return commandStatus(positional, options);
    case 'verify': return commandVerify(positional, options);
    case 'finalize': return commandFinalize(positional, options);
    case 'retest': return commandRetest(positional, options);
    case 'help': case '--help': case '-h': return commandHelp();
    default: fail(`unknown command '${command}'. Try '${TERMINAL_COMMAND} help'.`);
  }
}

// Only run when invoked as a command, so the module stays importable by tests.
if (process.argv[1] && /cernum(\.[jt]s)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}
