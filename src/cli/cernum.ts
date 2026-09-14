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
  Campaign, CampaignBuildError, CampaignConfiguration, CampaignError, CampaignLockError, CampaignStatus,
  DEFAULT_EXECUTION_POLICY, DiscoveredFrontierModel, EffortLevel, ExecutionPolicy, FrontierCandidateRequest,
  Ledger, LiveHost, MIXED_EXECUTION_REASONS, NONCANONICAL_REASONS, PRICING_FILE_NOTE, PROVIDER_LABELS, PricingSnapshot,
  DESIRED_CANDIDATE_LADDER, EFFORT_LEVELS, IdentitySmokeResult, ProviderID, ProviderStatus, REQUESTED_COHORT, RuntimeLeaseError, SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SpendingError, SyntheticHost,
  configurationKey, ladderConfigurations, reconcileCohort,
  ThinkingMode, allCredentialStatuses, allRankableSuiteIDs, anthropicBaseURL, authorizationDisclosure, authorizeSpending,
  breakCampaignLock, breakRuntimeLease, buildCampaignPlan, buildEngineCatalogue, buildHostForCampaign, campaignPaths,
  SubscriptionCLIAdapter, credentialStatus, describeBinding, describeCandidateMetrics, describeExecutionPolicy,
  IDENTITY_SMOKE_PROMPT, describeExpiry, describeSmoke, desiredCandidates, discoveryStorePath,
  identitySmokeTest, modelsFromSmokes,
  readDiscoveryStore, selectableFromStore, writeDiscoveryStore,
  discoverLocalModels, discoverMeteredProvider, discoverSubscriptionCLI, estimateSpending, formatMicroUSD,
  guardPolicyForEndpoint, hostOptionsFor, inspectCampaignLock, leasedEndpoints, modelCanThink,
  modelStoreBaseline, normalizeEndpoint, offlineProviderStatuses, openaiBaseURL, parseCeilingToMicroUSD,
  plannedWorkFor, pricingFor, privacyDisclosure, residencyDisclosure, steppingClock, syntheticCandidate,
  terminateAllCLIProcesses,
} from '../engine/index';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../shared/product';
import { TerminalCommandError, installTerminalCommand, terminalCommandStatus, uninstallTerminalCommand } from '../shared/terminal-install';

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

/**
 * How this invocation describes itself in a campaign lock. A refusal that can print the exact
 * command the other process is running is one a person can act on; "locked" is not.
 */
function invocation(argv: string[]): string {
  return [TERMINAL_COMMAND, ...argv].join(' ').slice(0, 200);
}

interface Options { [key: string]: string | boolean }

/** The policy a `create` was asked for. Canonical unless the person named the alternative. */
function executionFromOptions(options: Options): ExecutionPolicy {
  const residency = options['observe-only'] === true ? 'observeOnly' as const : 'managed' as const;
  const asked = options.thinking === undefined ? undefined : String(options.thinking).toLowerCase();
  let thinkingMode: ThinkingMode;
  switch (asked) {
    case undefined: thinkingMode = 'disabled'; break;
    case 'on': case 'true': case 'enabled': thinkingMode = 'enabled'; break;
    case 'off': case 'false': case 'disabled': thinkingMode = 'disabled'; break;
    case 'runtime': case 'runtime-default': thinkingMode = 'runtimeDefault'; break;
    default: fail(`--thinking must be 'on', 'off' or 'runtime-default', not '${asked}'`);
  }
  return { residency, thinkingMode };
}

/** The frozen policy of an existing campaign. A pre-format-3 campaign read as canonical, thinking off. */
function executionOf(configuration: CampaignConfiguration): ExecutionPolicy {
  return configuration.execution ?? DEFAULT_EXECUTION_POLICY;
}

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

function fail(message: string, code = 1): never {
  const [first, ...rest] = message.split('\n');
  process.stderr.write(`${TERMINAL_COMMAND}: ${first}\n`);
  for (const line of rest) process.stderr.write(`  ${line}\n`);
  process.exit(code);
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
  say(`  ${status.label}  [${status.state}]${status.canonical ? '' : '  ** OBSERVE-ONLY — noncanonical **'}`);
  say(`  ${status.manifestSeal}`);
  say(`  ${describeExecutionPolicy(status.execution)}`);
  if (status.operationalEnvelope) {
    say(`  providers: ${status.operationalEnvelope.providers.map((provider) => PROVIDER_LABELS[provider]).join(', ')}`);
    if (status.mixedExecution) say('  ** MIXED EXECUTION — task outcomes comparable; speed and cost are not **');
  }
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
  // Ownership is only worth printing when it belongs to someone else. "held by: me" is noise on
  // the status this very command just finished producing.
  if (status.owner && status.owner.state !== 'selfHeld') {
    say(`  held by: ${status.owner.processType} process ${status.owner.pid} on ${status.owner.hostname} [${status.owner.state}]`);
    say(`           ${status.owner.command}, since ${status.owner.acquiredAt}`);
  }
  if (!status.reconciliation.balances) say('  WARNING: the ledger does not balance; every rate derived from it is provisional.');
}

/**
 * The host this campaign runs on, built the way the campaign was FROZEN.
 *
 * Every choice here comes from the manifest's own configuration — never from a flag on this
 * invocation — and it is built by the SAME factory the desktop service calls. Two surfaces building
 * a host separately is the defect Pass 3 shipped and then fixed; the surface that could differ is
 * now every provider, adapter and credential in the campaign, so there is one factory.
 */
async function hostFor(configuration: CampaignConfiguration, options: Options, context: {
  authorization?: ReturnType<Campaign['readAuthorization']>;
  priorRows?: Record<string, unknown>[];
  shouldCancel?: () => boolean;
} = {}) {
  if (options.synthetic) {
    const pinned = Object.fromEntries(configuration.candidates.map((candidate) => [candidate.name, candidate]));
    return new SyntheticHost({}, steppingClock(), pinned);
  }
  return buildHostForCampaign(configuration, {
    endpoint: String(options.endpoint ?? DEFAULT_ENDPOINT),
    authorization: context.authorization,
    priorRows: context.priorRows,
    shouldCancel: context.shouldCancel,
  }).host;
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

// MARK: - Providers, credentials and discovery

/**
 * The discovery evidence, read through the engine's store rather than a copy kept here.
 *
 * This used to be three private functions in this file. They are in the engine now, because the
 * desktop application has to read the same evidence — and because two readers of one file that each
 * decide for themselves what a stale proof means is two answers to a question that has one.
 */
function readDiscovered(root: string): DiscoveredFrontierModel[] {
  return readDiscoveryStore(root).models;
}

function writeDiscovered(root: string, models: DiscoveredFrontierModel[]): void {
  writeDiscoveryStore(root, models);
}

function renderProviderStatus(status: ProviderStatus): void {
  say('');
  say(`  ${status.label}  [${status.reachability}]`);
  say(`    reached as   ${status.executionClass} · ${status.billingBasis}`);
  if (status.executablePath) say(`    command      ${status.executablePath}`);
  if (status.version) say(`    version      ${status.version}`);
  if (status.credential) say(`    credential   ${status.credential.masked} (${status.credential.environmentVariable})`);
  if (status.session) {
    // Plan and method, never identity. The tool also reports an email address, an organisation id
    // and an organisation name; none of them are read, so none of them can be printed here.
    say(`    session      signed in: ${status.session.loggedIn ? 'yes' : 'no'} · ${status.session.authMethod}`
      + ` · ${status.session.apiProvider}${status.session.subscriptionType ? ` · ${status.session.subscriptionType} plan` : ''}`);
  }
  say(`    probe        ${status.probe === 'offline' ? 'nothing was contacted to produce this' : 'this provider was invoked'}`);
  for (const line of wrap(status.detail, 76)) say(`    ${line}`);
  for (const model of status.models) {
    say(`      ${model.availability.padEnd(9)} ${model.modelID.padEnd(28)} ${model.displayName}`);
  }
}

/** Wrap a sentence for a terminal without breaking a word. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length === 0) { current = word; continue; }
    if (current.length + 1 + word.length > width) { lines.push(current); current = word; continue; }
    current += ` ${word}`;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * What can be said about every provider WITHOUT contacting any of them.
 *
 * This command makes no provider request of any kind. It is a PATH lookup and an environment read,
 * which is why it is safe to run constantly and why its answers are mostly `unknown`.
 */
/**
 * What was ASKED FOR, printed next to what is known about it.
 *
 * The rest of this command prints what discovery FOUND. This prints the request, which is the only
 * way a terminal can show something that went missing: a list built from results has no line for a
 * model nobody looked for. Pass 5B published a candidate list missing `claude-opus-5` and
 * `claude-fable-5-1` — both explicitly required — and nothing went red anywhere, because every
 * surface was rendering findings.
 *
 * A configuration that leaves the ladder is printed as MISSING, by name, and the command says so in
 * its first line rather than leaving it to be noticed.
 */
function renderRequestedCohort(cached: DiscoveredFrontierModel[]): void {
  const reconciliation = reconcileCohort();
  const ladder = new Set(ladderConfigurations().map(configurationKey));
  const proven = REQUESTED_COHORT.filter((entry) => cached.some((model) =>
    model.provider === entry.provider && model.modelID === entry.modelID && model.availability === 'proven'));

  say(`THE REQUESTED COHORT — ${reconciliation.requestedCount} configurations asked for, `
    + `${proven.length} proven.`);
  if (!reconciliation.complete) {
    say(`  !! ${reconciliation.missingFromLadder.length} REQUESTED CONFIGURATION(S) ARE NO LONGER ON THE LADDER.`);
    say('     They were asked for and something dropped them. Restore them, or record why they were');
    say('     withdrawn — do NOT substitute a neighbouring model for one of them.');
  }
  for (const entry of REQUESTED_COHORT) {
    const present = ladder.has(configurationKey(entry));
    const found = cached.find((model) => model.provider === entry.provider && model.modelID === entry.modelID);
    const state = !present ? 'MISSING  '
      : found === undefined ? 'not asked'
        : found.availability === 'proven' ? 'proven   '
          : found.availability === 'refused' ? 'refused  ' : 'unverif. ';
    const effort = entry.effort === 'none' ? '-' : entry.effort;
    say(`  ${state} ${entry.modelID.padEnd(18)} effort ${effort.padEnd(7)} ${entry.displayName}`);
  }
  say('');
}

async function commandProviders(options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const statuses = offlineProviderStatuses();
  say(`${statuses.length} provider(s). Nothing below contacted anything: this is a PATH lookup and a credential check.`);
  const cached = readDiscovered(root);
  for (const status of statuses) {
    const known = cached.filter((model) => model.provider === status.provider);
    renderProviderStatus({ ...status, models: known });
  }
  say('');
  renderRequestedCohort(cached);
  // An expired proof is REPORTED, not silently dropped. A candidate that quietly disappeared from a
  // list is a mystery; a candidate that says its proof aged out is an instruction.
  const { selectable, expired } = selectableFromStore({ writtenAt: '', models: cached });
  if (expired.length > 0) {
    say(`${expired.length} proof(s) have expired and are no longer selectable:`);
    for (const model of expired) for (const line of wrap(describeExpiry(model), 76)) say(`  ${line}`);
    say('');
  }
  if (selectable.length > 0) {
    say(`${selectable.length} model(s) are proven, unexpired and selectable.`);
    say('');
  }
  if (cached.length === 0) {
    say('No provider discovery has been run, so no frontier model is selectable yet.');
    say('The intended testing ladder, none of it confirmed:');
    for (const model of desiredCandidates(new Date().toISOString())) {
      say(`  unproven  ${model.modelID.padEnd(28)} ${model.displayName}`);
    }
    say('');
  }
  say(`Run discovery explicitly: ${TERMINAL_COMMAND} discover [claudeCLI|codexCLI|anthropicAPI|openaiAPI]`);
  say(`Prove a subscription model by asking it once:  ${TERMINAL_COMMAND} smoke [claudeCLI|codexCLI]   (spends allowance)`);
}

/** Credential configuration, masked. Shows that something is set and how long it is, and nothing else. */
async function commandCredentials(): Promise<void> {
  const statuses = allCredentialStatuses();
  say('Metered API credentials. Cernum never stores a key itself and never prints one.');
  for (const status of statuses) {
    say('');
    say(`  ${PROVIDER_LABELS[status.provider]}`);
    say(`    variable   ${status.environmentVariable}`);
    say(`    keychain   ${status.keychainService}`);
    say(`    state      ${status.masked}`);
    for (const line of wrap(status.remedy, 74)) say(`    ${line}`);
  }
  say('');
  say('Subscription CLIs are not listed here: `claude` and `codex` authenticate themselves, and Cernum');
  say('never reads their stored sessions, tokens or configuration.');
}

/**
 * Ask a provider what it is and what this account may call. THIS INVOKES SOMETHING.
 *
 * Running the CLI's `--version` and its model listing costs no inference and spends no tokens.
 * Listing a metered provider's models is a request made with the user's key, which is why it happens
 * only here and never from a status read.
 */
async function commandDiscover(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const wanted = positional.length > 0 ? positional as ProviderID[] : ['claudeCLI', 'codexCLI'] as ProviderID[];
  const discovered: DiscoveredFrontierModel[] = readDiscovered(root)
    .filter((model) => !wanted.includes(model.provider));

  for (const provider of wanted) {
    let status: ProviderStatus;
    if (provider === 'claudeCLI' || provider === 'codexCLI') {
      status = await discoverSubscriptionCLI(provider);
    } else if (provider === 'anthropicAPI' || provider === 'openaiAPI') {
      status = await discoverMeteredProvider(provider, {
        baseURL: provider === 'anthropicAPI' ? anthropicBaseURL() : openaiBaseURL(),
      });
    } else {
      fail(`'${provider}' is not a provider. Try claudeCLI, codexCLI, anthropicAPI or openaiAPI.`);
    }
    renderProviderStatus(status);
    discovered.push(...status.models);
  }

  writeDiscovered(root, discovered);
  const proven = discovered.filter((model) => model.availability === 'proven');
  say('');
  say(`${proven.length} model(s) are now selectable. Anything not listed as 'proven' cannot be put in a campaign.`);
  say(`Recorded in ${discoveryStorePath(root)}`);
}

/**
 * Prove — or fail to prove — that this account can call a model, by asking it once who it is.
 *
 * THIS SPENDS ALLOWANCE. One request per candidate and effort level, carrying a nine-word prompt.
 * It is a separate command from `discover` for exactly that reason: `discover` runs a tool's own
 * read-only subcommands and costs nothing, and this one talks to a model.
 *
 * It exists because NEITHER subscription CLI can answer "which models may this account call", though
 * they fail to answer it differently. `claude` has no model-listing command at all. `codex` has one
 * — `codex debug models` — but it renders a CATALOGUE of what the client knows about, and the
 * service refuses models that appear in it, so a listing proves nothing about this account.
 *
 * So the only honest route is to ask, once, and write down what came back — and for Codex even that
 * stops short of proof, because `codex exec` names no model in its reply. A Codex smoke establishes
 * that SOMETHING answered; it cannot establish what.
 */
async function commandSmoke(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const wanted = positional.length > 0 ? positional as ProviderID[] : ['claudeCLI'] as ProviderID[];

  for (const provider of wanted) {
    if (provider !== 'claudeCLI' && provider !== 'codexCLI') {
      fail(`'${provider}' is not a subscription CLI. An identity smoke test drives your own signed-in `
        + '`claude` or `codex`; metered API identity is established by `discover`, which lists models directly.');
    }
  }

  // The ladder is the PLAN, and the plan is the only thing that decides what is asked for. No
  // spelling is invented here and no variant is tried: one request per named identifier, as named.
  const requested = DESIRED_CANDIDATE_LADDER
    .filter((entry) => wanted.includes(entry.provider) && entry.modelID.length > 0);
  if (requested.length === 0) {
    fail('nothing on the intended testing ladder names a model for that provider, so there is nothing to ask for. '
      + 'A smoke test never invents an identifier.');
  }

  const budget = Number(options['max-attempts'] ?? 0);
  const pairs = requested.flatMap((entry) => entry.desiredEfforts.map((effort) => ({ entry, effort })));
  const planned = budget > 0 ? pairs.slice(0, budget) : pairs;

  say(`${planned.length} identity smoke test(s). Each one sends a single minimal prompt to a real model and`);
  say('consumes subscription allowance. Nothing here is a benchmark and no campaign is created.');
  say('');

  const results: IdentitySmokeResult[] = [];
  for (const { entry, effort } of planned) {
    if (!EFFORT_LEVELS.includes(effort as EffortLevel)) {
      fail(`'${effort}' is not an effort level this engine models. Valid: ${EFFORT_LEVELS.join(', ')}.`);
    }
    const binding = smokeBinding(entry.provider, entry.modelID, effort as EffortLevel);
    const adapter = new SubscriptionCLIAdapter({ provider: entry.provider });
    const result = await identitySmokeTest(binding, adapter);
    results.push(result);
    say(`  ${describeSmoke(result)}`);
    for (const line of wrap(result.evidence, 74)) say(`      ${line}`);
    say(`      tokens in ${renderQuantity(result.inputTokens)} · visible out ${renderQuantity(result.visibleOutputTokens)}`
      + ` · reasoning ${renderQuantity(result.reasoningTokens)}`);
    say(`      wall ${renderQuantity(result.totalWallClockMilliseconds)}ms · first visible output `
      + `${renderQuantity(result.timeToFirstVisibleTokenMilliseconds)}ms`);
    say(`      marginal API charge ${renderMoney(result.marginalAPIChargeMicroUSD)} (no card is billed)`);
    say(`      plan allowance consumed, at list value: ${renderMoney(result.subscriptionIncludedUsageMicroUSD)}`
      + (result.subscriptionIncludedUsageMicroUSD.provenance === 'unavailable' ? '' : ' — a zero charge is not a zero cost'));
    for (const note of result.notEnforceable) for (const line of wrap(note, 70)) say(`      ! ${line}`);
    say('');
  }

  // Written through the store, with the timestamp a later campaign checks for staleness. Nothing
  // about a successful model is written into source: the file is the evidence, and it expires.
  const names = new Map(DESIRED_CANDIDATE_LADDER.map((entry) => [entry.modelID, entry.displayName]));
  const fresh = modelsFromSmokes(results, names);
  const kept = readDiscovered(root).filter((model) => !fresh.some(
    (entry) => entry.provider === model.provider && entry.modelID === model.modelID));
  writeDiscovered(root, [...kept, ...fresh]);

  // The full evidence, on request, somewhere the caller names.
  //
  // It is written OUTSIDE the repository by whoever runs this, and it carries no account identifier:
  // the session fields are dropped at the parser, and every answer and error string has already been
  // through redaction. What it does carry is each verdict with the numbers behind it, which is what
  // a later reader needs to check a claim rather than take it.
  const evidencePath = options.evidence === undefined ? undefined : String(options.evidence);
  if (evidencePath) {
    fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    fs.writeFileSync(path.resolve(evidencePath), JSON.stringify({
      writtenAt: new Date().toISOString(),
      note: 'Identity smoke evidence. No credential, session token, email address, organisation id or '
        + 'organisation name appears here: the authentication parser keeps only whether the session is signed in, '
        + 'how, and the plan tier.',
      prompt: IDENTITY_SMOKE_PROMPT,
      results,
    }, null, 2) + '\n', 'utf8');
    say(`Evidence written to ${path.resolve(evidencePath)}`);
  }

  const proven = fresh.filter((model) => model.availability === 'proven');
  say(`${proven.length} of ${fresh.length} candidate(s) are now proven and selectable.`);
  say(`Recorded in ${discoveryStorePath(root)}`);
  say('No campaign was created. A preflight establishes who answers; it does not measure anything.');
}

/** A binding for one smoke test: the smallest honest request this engine can describe. */
function smokeBinding(provider: ProviderID, modelID: string, effort: EffortLevel) {
  return {
    candidate: `${provider}:${modelID}:${effort}`,
    provider,
    executionClass: 'subscriptionCLI' as const,
    requestedModelID: modelID,
    // UNVERIFIABLE IS THE HONEST STARTING STATE, and the whole point of the exercise is to change it.
    // A smoke binding that claimed a verified identity before asking would be assuming its answer.
    identityState: 'unverifiable' as const,
    verifiedModelID: '',
    identityEvidence: 'nothing has established this identity yet; that is what this request is for',
    effort,
    thinkingMode: 'runtimeDefault' as ThinkingMode,
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    maxInputTokens: 1_024,
    // The smallest budget worth naming. This CLI cannot enforce it — recorded on every attempt
    // rather than pretended otherwise — but the prompt asks for one word.
    maxOutputTokens: 16,
    timeoutMilliseconds: 120_000,
    retry: { maxRetries: 0, backoffMilliseconds: 0, retryOn: [] },
    billingBasis: 'subscriptionIncluded' as const,
    pricing: null,
    authorizationMode: 'subscriptionCLISession' as const,
  };
}

function renderQuantity(quantity: { provenance: string; value?: number }): string {
  return quantity.provenance === 'unavailable' ? 'not reported' : String(quantity.value);
}

/**
 * Money, to six decimal places, always.
 *
 * `formatMicroUSD` rounds anything above a cent to two places, which is right for a campaign total
 * and wrong here: one identity smoke consumes about $0.014 of allowance, and rounding a column of
 * those to $0.01 each loses a third of the figure before it is ever summed.
 */
function renderMoney(quantity: { provenance: string; value?: number }): string {
  if (quantity.provenance === 'unavailable') return 'not reported — which is not zero';
  return `$${((quantity.value ?? 0) / 1_000_000).toFixed(6)}`;
}

// MARK: - Money

function readPricingFile(options: Options): Record<string, unknown> {
  if (options.pricing === undefined) return {};
  const file = String(options.pricing);
  if (!fs.existsSync(file)) fail(`no pricing file at ${file}. ${PRICING_FILE_NOTE}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return fail(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What a campaign is expected to cost, without creating or running anything. */
async function commandCost(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} cost <name>`);
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const envelope = configuration.operationalEnvelope;
  if (!envelope) {
    say(`${name} binds no providers: it is a local campaign, and local execution has no monetary cost.`);
    say('Wall-clock time is still recorded. No electricity cost is invented, because no rate and no measurement');
    say('method were supplied.');
    return;
  }
  const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
  const work = plannedWorkFor(catalogue, configuration.candidates.map((candidate) => candidate.name), configuration.repeatsPerCase);
  const estimate = estimateSpending(envelope, work);

  say(`${configuration.label}`);
  say('');
  for (const binding of envelope.bindings) say(`  ${describeBinding(binding)}`);
  say('');
  if (!estimate.estimable) {
    say('This campaign\'s cost CANNOT be calculated, so Cernum will not offer a number to approve:');
    for (const reason of estimate.notEstimableBecause) for (const line of wrap(reason, 76)) say(`  · ${line}`);
    process.exit(2);
  }
  for (const line of authorizationDisclosure(estimate, 0)) for (const wrapped of wrap(line, 78)) say(`  ${wrapped}`);
  say('');
  const authorization = Campaign.exists(directory)
    ? Campaign.open(directory, configuration, await hostFor(configuration, options)).readAuthorization()
    : undefined;
  if (authorization) {
    say(`Authorized ${authorization.authorizedAt} by ${authorization.authorizedBy}, ceiling `
      + `${formatMicroUSD(authorization.hardCeilingMicroUSD)}.`);
  } else if (estimate.meteredCandidateCount > 0) {
    say(`NOT AUTHORIZED. No metered request will be sent until it is: ${TERMINAL_COMMAND} authorize ${name} --ceiling 5.00`);
  }
}

/**
 * Say yes to a specific amount of money, in writing, before the run.
 *
 * The record names the provider, the model, the planned attempts, the estimated floor and ceiling,
 * when the prices were captured, and a hard ceiling the run stops at. It is written to the campaign
 * directory and read back by the run, so it survives a resume, a crash and a change of surface.
 */
async function commandAuthorize(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} authorize <name> --ceiling <dollars> [--yes]`);
  if (options.ceiling === undefined) {
    fail('--ceiling is required, in dollars. A paid run authorised with no stopping condition is not an authorisation.');
  }
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const envelope = configuration.operationalEnvelope;
  if (!envelope || !envelope.hasMeteredBinding) {
    fail(`${name} has no metered candidate, so there is nothing to authorise. Subscription and local execution are `
      + 'not billed per token and are not governed by a dollar ceiling.', 2);
  }

  const catalogue = buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
  const work = plannedWorkFor(catalogue, configuration.candidates.map((candidate) => candidate.name), configuration.repeatsPerCase);
  const estimate = estimateSpending(envelope, work);
  let ceiling: number;
  try {
    ceiling = parseCeilingToMicroUSD(String(options.ceiling));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 2);
  }

  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options));
  say(`Authorising paid execution for ${configuration.label}:`);
  say('');
  for (const line of authorizationDisclosure(estimate, ceiling)) for (const wrapped of wrap(line, 78)) say(`  ${wrapped}`);
  say('');
  for (const line of privacyDisclosure(envelope.bindings.map((binding) => ({ label: PROVIDER_LABELS[binding.provider], executionClass: binding.executionClass })))) {
    for (const wrapped of wrap(line, 78)) say(`  ${wrapped}`);
  }
  say('');
  if (options.yes !== true) {
    fail('Nothing was authorised. Re-run with --yes once the figures above are what you intend to spend.', 3);
  }

  try {
    const authorization = authorizeSpending(estimate, {
      campaignID: campaign.campaignID,
      authorizedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      authorizedBy: invocation(process.argv.slice(2)),
      hardCeilingMicroUSD: ceiling,
      operationalEnvelopeDigest: campaign.manifest.operationalEnvelopeDigest ?? '',
    });
    campaign.writeAuthorization(authorization);
    say(`Authorized. Ceiling ${formatMicroUSD(ceiling)}. Written to ${campaignPaths(directory).authorization}`);
    say(`Run it with: ${TERMINAL_COMMAND} run ${name}`);
  } catch (error) {
    if (error instanceof SpendingError) fail(error.message, 2);
    throw error;
  }
}

async function commandSuites(): Promise<void> {
  const catalogue = buildEngineCatalogue(allRankableSuiteIDs(), 1);
  say(`${catalogue.suites.length} suite(s), ${catalogue.plannable.caseCount} case(s):`);
  for (const suite of catalogue.suites) {
    say(`  ${suite.id.raw.padEnd(42)} ${String(suite.cases.length).padStart(2)} case(s)  ${suite.title}`);
  }
}

/**
 * `provider:model[:effort]` — one frontier candidate.
 *
 * The candidate NAME includes the effort, because a model at high effort and the same model at max
 * effort are two different experiments and must not share a row, a rate or a cost. Naming them the
 * same thing is how a comparison quietly averages two configurations together.
 */
export function parseFrontierSpec(spec: string, thinkingMode: ThinkingMode, pricingFile: Record<string, unknown>): FrontierCandidateRequest {
  const parts = spec.split(':');
  if (parts.length < 2) {
    fail(`'${spec}' is not a frontier candidate. Write it as provider:model[:effort], for example `
      + 'claudeCLI:claude-sonnet-5:high');
  }
  const [provider, modelID, effortText] = parts as [ProviderID, string, string | undefined];
  const effort = (effortText ?? 'none') as EffortLevel;
  if (!['none', 'low', 'medium', 'high', 'max'].includes(effort)) {
    fail(`'${effortText}' is not an effort level. Use none, low, medium, high or max.`);
  }
  const pricing = pricingFor(pricingFile, provider, modelID);
  const credential = provider === 'anthropicAPI' || provider === 'openaiAPI' ? credentialStatus(provider) : undefined;
  return {
    name: effort === 'none' ? `${provider}:${modelID}` : `${provider}:${modelID}@${effort}`,
    provider,
    modelID,
    effort,
    thinkingMode,
    pricing,
    authorizationMode: credential === undefined ? undefined
      : credential.source === 'keychain' ? 'apiKeyKeychain' : 'apiKeyEnvironment',
  };
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

  const execution = executionFromOptions(options);
  const frontierSpecs = options.frontier ? String(options.frontier).split(',').filter((entry) => entry.length > 0) : [];

  // A synthetic campaign stays exactly what it was in Pass 3: local candidates, deterministic host,
  // no bindings, no provider. It is the control, and a control that gained a provider would stop
  // being one.
  if (options.synthetic) {
    if (frontierSpecs.length > 0) fail('--synthetic and --frontier are mutually exclusive: the deterministic host reaches no provider');
    const names = String(options.models ?? 'alpha:1b,beta:2b').split(',');
    const configuration: CampaignConfiguration = {
      label: String(options.label ?? name),
      suiteIDs, repeatsPerCase,
      candidates: names.map(syntheticCandidate),
      hardware: SYNTHETIC_HARDWARE,
      runtimeVersion: 'synthetic-runtime-1.0',
      storeBaseline: SYNTHETIC_STORE_BASELINE,
      execution,
      residencyDelayMilliseconds: 0,
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');
    const synthetic = Campaign.create(directory, configuration, await hostFor(configuration, options));
    say(`Created ${name} at ${directory}`);
    renderStatus(synthetic.status());
    say('');
    say(`Start it with: ${TERMINAL_COMMAND} run ${name} --synthetic`);
    return;
  }

  if (!options.models && frontierSpecs.length === 0) {
    fail('--models is required (comma-separated), or --frontier provider:model[:effort], or pass --synthetic to run '
      + 'against the deterministic host');
  }

  const localNames = options.models ? String(options.models).split(',').filter((entry) => entry.length > 0) : [];
  const installed = localNames.length > 0 ? await discoverLocalModels(endpoint) : [];
  const local = localNames.map((wantedName) => {
    const found = installed.find((model) => model.name === wantedName || model.name === `${wantedName}:latest`);
    if (!found) fail(`model '${wantedName}' is not installed at ${endpoint}; run '${TERMINAL_COMMAND} models' to see what is`);
    // Preflight, before anything is frozen: a campaign frozen with thinking ON against a model
    // the runtime says cannot think would have to either fail later or quietly run with thinking
    // off, and the second is worse.
    if (execution.thinkingMode === 'enabled' && modelCanThink(found) === false) {
      fail(`--thinking on was requested, but ${endpoint} reports that ${found.name} cannot think `
        + `(it reports: ${(found.capabilities ?? []).join(', ') || 'nothing'}). Nothing was frozen. `
        + `Choose a thinking-capable model, or create this campaign with --thinking off.`);
    }
    return { name: found.name, modelID: found.name, runtimeDigest: found.runtimeDigest, parameterSize: found.parameterSize, quantization: found.quantization };
  });

  const pricingFile = readPricingFile(options);
  const frontier = frontierSpecs.map((spec) => parseFrontierSpec(spec, execution.thinkingMode, pricingFile));

  // THE SAME BUILDER THE DESKTOP CALLS. Not an equivalent one written here — the same function, so
  // the terminal and the interface cannot produce campaigns with different frozen identities for the
  // same request.
  let built;
  try {
    built = buildCampaignPlan({
      label: String(options.label ?? name),
      suiteIDs,
      repeatsPerCase,
      local,
      frontier,
      observeOnly: execution.residency === 'observeOnly',
      thinkingMode: execution.thinkingMode,
      endpoint,
      hardware: {
        platform: process.platform, architecture: process.arch, model: os.hostname(),
        cpuCoreCount: os.cpus().length, physicalMemoryBytes: os.totalmem(), osVersion: `${os.type()} ${os.release()}`,
      },
      runtimeVersion: String(options['runtime-version'] ?? 'ollama-unreported'),
      storeBaseline: local.length > 0 ? modelStoreBaseline(installed) : undefined,
      provenModels: readDiscovered(root),
    });
  } catch (error) {
    if (error instanceof CampaignBuildError) return fail(error.message, 2);
    throw error;
  }

  const configuration = built.configuration;
  const candidates = configuration.candidates;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8');

  const campaign = Campaign.create(directory, configuration, await hostFor(configuration, options));
  say(`Created ${name} at ${directory}`);
  renderStatus(campaign.status());
  say('');
  for (const binding of built.envelope.bindings) say(`  ${describeBinding(binding)}`);
  say('');
  if (local.length > 0) {
    if (execution.residency === 'managed') {
      // A campaign of local models reads exactly as it did in Pass 3. Only a MIXED campaign gets the
      // narrower sentence, because only there is "canonical" a claim about some of the candidates
      // rather than all of them.
      say(frontier.length === 0
        ? 'This is a CANONICAL campaign. Before it runs:'
        : 'The LOCAL candidates in this campaign run canonically. Before it runs:');
      for (const line of residencyDisclosure(endpoint, local.map((candidate) => candidate.name))) say(`  · ${line}`);
    } else {
      say('This is an OBSERVE-ONLY campaign — noncanonical, and not comparable with a canonical run:');
      for (const reason of NONCANONICAL_REASONS) say(`  · ${reason}`);
    }
    say('');
  }
  if (built.frontierOnly) {
    say('No candidate runs on this machine, so this campaign takes no Ollama endpoint lease and manages no residency.');
    say('');
  }
  if (built.envelope.mixed) {
    say('MIXED EXECUTION — task outcomes will be comparable; speed and cost will not:');
    for (const reason of MIXED_EXECUTION_REASONS) for (const line of wrap(reason, 76)) say(`  · ${line}`);
    say('');
  }
  const external = built.envelope.bindings.filter((binding) => binding.executionClass !== 'localRuntime');
  if (external.length > 0) {
    say('BEFORE YOU START IT:');
    for (const line of privacyDisclosure(external.map((binding) => ({ label: PROVIDER_LABELS[binding.provider], executionClass: binding.executionClass })))) {
      for (const wrapped of wrap(line, 76)) say(`  · ${wrapped}`);
    }
    say('');
  }
  if (built.envelope.hasMeteredBinding) {
    say(`This campaign has metered candidates and is NOT yet authorised to spend anything.`);
    say(`  preview:   ${TERMINAL_COMMAND} cost ${name}`);
    say(`  authorize: ${TERMINAL_COMMAND} authorize ${name} --ceiling 5.00 --yes`);
    say('');
  }
  say(`Start it with: ${TERMINAL_COMMAND} run ${name}`);
}

async function commandRun(positional: string[], options: Options, resuming: boolean, invocationLine: string): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} ${resuming ? 'resume' : 'run'} <name> [--max-attempts n]`);
  const directory = campaignDirectory(String(options.root ?? defaultCampaignRoot()), name);
  const configuration = readConfiguration(directory);
  const execution = executionOf(configuration);

  // The mode is frozen. Asking for a different one here is refused rather than obeyed, because a
  // campaign that was canonical for its first half and observe-only for its second is neither.
  if (options['observe-only'] === true && execution.residency === 'managed') {
    fail(`${name} was frozen as a CANONICAL campaign, so --observe-only cannot be applied to it now. `
      + `The execution mode is bound into its manifest and cannot change after the freeze.\n`
      + `Create a separate observe-only campaign instead: ${TERMINAL_COMMAND} create ${name}-observed --observe-only …`, 2);
  }
  if (options.thinking !== undefined) {
    fail(`${name} was frozen with ${describeExecutionPolicy(execution)}. Thinking mode is bound into its manifest `
      + 'and cannot be changed on a run; create a new campaign to change it.', 2);
  }

  let stopping = false;

  // Opened twice on purpose. The first open reads the ledger and the authorization off disk; the
  // second builds the host WITH them, so a spending ceiling is enforced against everything this
  // campaign has already spent rather than restarting at zero on every resume.
  const reading = Campaign.open(directory, configuration, await hostFor(configuration, options));
  const authorization = reading.readAuthorization();
  const priorRows = reading.ledgerRows();
  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options, {
    authorization, priorRows, shouldCancel: () => stopping,
  }));

  const verification = campaign.verify();
  if (!verification.intact && !verification.hardwareOnly) {
    say('The frozen manifest no longer describes this campaign:');
    for (const drift of verification.drifts) say(`  ${drift.field}: ${drift.meaning}`);
    say('');
    say('Nothing was run. A campaign whose benchmark moved cannot be resumed into the same evidence.');
    process.exit(2);
  }

  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    say('');
    say('Pausing at the next attempt boundary — the attempt in flight will be recorded first.');
    // A subscription CLI is a child process, and a child process that is merely abandoned keeps
    // running: it keeps its slot in the rate limit and keeps consuming the allowance this run was
    // measuring. Stopping the group is what makes a pause actually stop.
    const stopped = terminateAllCLIProcesses();
    if (stopped > 0) say(`  stopping ${stopped} provider command(s) in flight.`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Refused here as well as in the host, and deliberately so. The host's refusal happens at the
  // first metered slot, which may be a hundred local attempts into the run; this one happens before
  // anything starts, which is the message a person can actually act on.
  if (configuration.operationalEnvelope?.hasMeteredBinding && !authorization) {
    fail(`${name} has metered candidates and no recorded spending authorization, so nothing was run and nothing was `
      + `sent.\n  preview:   ${TERMINAL_COMMAND} cost ${name}\n  authorize: ${TERMINAL_COMMAND} authorize ${name} --ceiling 5.00 --yes`, 6);
  }

  const maxAttempts = options['max-attempts'] !== undefined ? Number(options['max-attempts']) : undefined;
  let status: CampaignStatus;
  try {
    status = await campaign.run({
      maxAttempts,
      shouldPause: () => stopping,
      // Announced only once the campaign is genuinely ours and the manifest still holds. Saying
      // "Running…" and then being refused is a worse message than saying nothing yet.
      onStarted: () => {
        say(`${resuming ? 'Resuming' : 'Running'} ${configuration.label}…`);
        if (!options.synthetic && execution.residency === 'managed') {
          say(`  Cernum is managing model residency on ${String(options.endpoint ?? DEFAULT_ENDPOINT)} for this run, and on nothing else.`);
        }
        if (execution.residency === 'observeOnly') say('  OBSERVE-ONLY: residency is untouched, and these results are noncanonical.');
      },
      // Ownership is taken before the first request. A campaign the desktop application is already
      // running is refused here rather than discovered later by the ledger, after both processes
      // have paid for the same inference. The runtime lease is taken in the same breath, so a
      // DIFFERENT campaign already using this endpoint is refused too.
      owner: { processType: 'terminal', command: invocationLine },
      campaignRootDirectory: String(options.root ?? defaultCampaignRoot()),
      onProgress: (progress, trace) => {
        const bar = `${String(progress.terminalCount).padStart(4)}/${progress.slotCount}`;
        say(`  ${bar}  ${trace.status.padEnd(20)} ${trace.slotKey}`);
      },
    });
  } catch (error) {
    if (error instanceof RuntimeLeaseError) {
      fail(`${error.message}\n\nNothing was run — not one request was sent. `
        + `Once that campaign is genuinely stopped: ${TERMINAL_COMMAND} unlock --endpoint ${error.endpoint}`, 5);
    }
    if (error instanceof CampaignLockError) {
      fail(`${error.message}\n\nNothing was run. Once it is genuinely stopped: ${TERMINAL_COMMAND} unlock ${name}`, 4);
    }
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

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
  let report;
  try {
    report = campaign.finalize({ blindingSecret: secret, authorization: campaign.readAuthorization() });
  } catch (error) {
    if (error instanceof CampaignError && error.code === 'campaignInUse') fail(error.message, 4);
    throw error;
  }
  const paths = campaignPaths(directory);

  say(`${report.label}`);
  say(`  ${report.manifest.seal}`);
  say(`  ${describeExecutionPolicy(report.execution)}`);
  say('');
  if (!report.canonical) {
    say('*** OBSERVE-ONLY — NONCANONICAL. These results are not comparable with a canonical run. ***');
    for (const reason of report.noncanonicalBecause) say(`  · ${reason}`);
    say('');
  }
  if (report.mixedExecutionBecause.length > 0) {
    say('*** MIXED EXECUTION. Task outcomes are comparable; speed and cost are not. ***');
    for (const reason of report.mixedExecutionBecause) for (const line of wrap(reason, 76)) say(`  · ${line}`);
    say('');
  }
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
  if (report.frontierMetrics.length > 0) {
    say('Tokens, speed and cost — with how each figure was obtained');
    say(`  ${'candidate'.padEnd(24)}  ${'reached as'.padEnd(14)}  ${'success'.padStart(8)}  ${'cost/success'.padStart(16)}  quality`);
    for (const metrics of report.frontierMetrics) say(`  ${describeCandidateMetrics(metrics)}`);
    say('');
    say('  measurement quality: measured (we watched it) · providerReported (they told us) ·');
    say('  estimated (derived by a stated method) · unavailable (not known, and not guessed at).');
    say('');
  }
  if (report.spending) {
    say('Spending');
    say(`  authorized     ${report.spending.authorized ? 'yes' : 'NO'}`);
    if (report.spending.hardCeilingMicroUSD !== undefined) say(`  hard ceiling   ${formatMicroUSD(report.spending.hardCeilingMicroUSD)}`);
    say(`  recorded       ${formatMicroUSD(report.spending.recordedMicroUSD)} across ${report.spending.meteredAttempts} metered attempt(s)`);
    if (report.spending.stoppedAtCeiling) {
      say('  THIS RUN STOPPED AT ITS CEILING. The attempts already recorded are kept; the remaining');
      say('  slots were blocked and carry no result.');
    }
    say('');
  }
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

// MARK: - Ownership

async function commandLock(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} lock <name>`);
  const inspection = inspectCampaignLock(campaignDirectory(root, name));
  say(inspection.message);
  if (inspection.record) {
    say('');
    say(`  process    ${inspection.record.processType} pid ${inspection.record.pid} on ${inspection.record.hostname}`);
    say(`  command    ${inspection.record.command}`);
    say(`  acquired   ${inspection.record.acquiredAt}`);
    say(`  heartbeat  ${inspection.record.heartbeatAt} (${Math.round((inspection.heartbeatAgeMilliseconds ?? 0) / 1000)}s ago)`);
    say(`  state      ${inspection.state}`);
  }
}

async function commandEndpoints(options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const leases = leasedEndpoints(root);
  if (leases.length === 0) { say(`No benchmark endpoint is leased under ${root}.`); return; }
  say(`${leases.length} endpoint lease(s) under ${root}:`);
  for (const lease of leases) {
    const record = lease.record;
    if (!record) { say(`  (an undecodable lease file) — ${lease.message}`); continue; }
    say('');
    say(`  ${record.endpoint}`);
    say(`    campaign   ${record.campaignName}  [${lease.state}]`);
    say(`    process    ${record.processType} pid ${record.pid} on ${record.hostname}`);
    say(`    command    ${record.command}`);
    say(`    acquired   ${record.acquiredAt}`);
    if (record.modelStoreCount !== undefined) say(`    sees       ${record.modelStoreCount} model(s) installed there`);
  }
  say('');
  say('A campaign owns one endpoint at a time. Campaigns on genuinely different endpoints run side by side.');
}

async function commandUnlock(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());

  // `unlock --endpoint <url>` releases a runtime lease rather than a campaign lock.
  if (options.endpoint !== undefined && positional.length === 0) {
    const endpoint = String(options.endpoint);
    try {
      const previous = breakRuntimeLease(root, endpoint, `released by ${invocation(process.argv.slice(2))}`, { force: options.force === true });
      if (!previous.held) { say(`No campaign holds ${normalizeEndpoint(endpoint)}.`); return; }
      say(`Released the lease on ${normalizeEndpoint(endpoint)}.`);
      if (previous.record) say(`  it was held by campaign '${previous.record.campaignName}' in ${previous.record.processType} process ${previous.record.pid} (${previous.state})`);
      say(`  the release is recorded in ${root}/.runtime-leases/recovered/`);
    } catch (error) {
      if (error instanceof CampaignLockError) fail(error.message, 4);
      throw error;
    }
    return;
  }

  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} unlock <name> [--force]   or   ${TERMINAL_COMMAND} unlock --endpoint <url> [--force]`);
  const directory = campaignDirectory(root, name);
  try {
    const previous = breakCampaignLock(directory, `released by ${invocation(process.argv.slice(2))}`, { force: options.force === true });
    if (!previous.held) { say(`No process holds ${name}.`); return; }
    say(`Released the lock on ${name}.`);
    if (previous.record) say(`  it was held by ${previous.record.processType} process ${previous.record.pid} on ${previous.record.hostname} (${previous.state})`);
    say(`  the release is recorded in ${directory}/locks/`);
  } catch (error) {
    if (error instanceof CampaignLockError) fail(error.message, 4);
    throw error;
  }
}

// MARK: - The installed command

function renderTerminalCommandStatus(): void {
  const status = terminalCommandStatus();
  say(status.message);
  say('');
  say(`  command          ${status.command}`);
  say(`  in-app launcher  ${status.launcherPath ?? '(none — this is a development checkout)'}`);
  say(`  install path     ${status.installPath}`);
  say(`  installed        ${status.installed ? (status.installedIsOurs ? 'yes' : 'a file exists that we did not write') : 'no'}`);
  say(`  on PATH          ${status.directoryOnPath ? 'yes' : 'no'}`);
  if (status.pathHint) { say(''); for (const line of status.pathHint.split('\n')) say(`  ${line}`); }
}

async function commandWhere(): Promise<void> {
  say(`${PRODUCT.name} ${PRODUCT.version}`);
  say(`  campaigns        ${defaultCampaignRoot()}`);
  say(`  running from     ${process.argv[1]}`);
  say('');
  renderTerminalCommandStatus();
}

async function commandInstallCommand(): Promise<void> {
  try {
    const status = installTerminalCommand();
    for (const line of status.message.split('\n')) say(line);
    say('');
    say('That is the only file the install created. No PATH, shell profile, system directory or');
    say('privileged location was touched, and nothing runs at login.');
  } catch (error) {
    if (error instanceof TerminalCommandError) fail(error.message);
    throw error;
  }
}

async function commandUninstallCommand(): Promise<void> {
  try {
    const status = uninstallTerminalCommand();
    for (const line of status.message.split('\n')) say(line);
  } catch (error) {
    if (error instanceof TerminalCommandError) fail(error.message);
    throw error;
  }
}

function commandHelp(): void {
  say(`${PRODUCT.name} benchmark engine · ${TERMINAL_COMMAND} ${PRODUCT.version}`);
  say('');
  say('  providers                       every provider\'s status, WITHOUT contacting any of them');
  say('  discover [<provider>]           ask a provider what it is and what this account may call');
  say('  smoke [<provider>]              prove a model by asking it once who it is — SPENDS ALLOWANCE');
  say('                                  --evidence <file>  write the full per-request evidence there');
  say('  credentials                     which API keys are configured (masked; never printed)');
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
  say('  cost <name>                     what a campaign is estimated to cost, without running it');
  say('  authorize <name> --ceiling 5.00 --yes');
  say('                                  record explicit authorization for paid execution');
  say('');
  say('  lock <name>                     who holds this campaign, and whether they are still alive');
  say('  unlock <name> [--force]         release a crashed owner\'s lock; --force for a live one');
  say('  endpoints                       which benchmark endpoints are leased, and by which campaign');
  say('  unlock --endpoint <url>         release a crashed campaign\'s hold on an endpoint');
  say('');
  say('  where                           where campaigns live, and whether this command is installed');
  say('  install-command                 install this command for your account (one file, no PATH change)');
  say('  uninstall-command               remove exactly the file install-command wrote');
  say('');
  say('  --root <dir>        campaign directory (default: the application\'s own)');
  say('  --endpoint <url>    Ollama endpoint (default: ' + DEFAULT_ENDPOINT + ')');
  say('  --suites a,b        suite ids (default: every ranked suite)');
  say('  --repeats n         passes per case (default: 1)');
  say('  --max-attempts n    stop after n attempts — how a small smoke run is kept small');
  say('  --synthetic         drive the deterministic host; no request reaches any server');
  say('');
  say('  Execution mode, chosen at CREATE and frozen into the manifest:');
  say('  --observe-only      do NOT manage residency. Cernum touches nothing on the endpoint, and the');
  say('                      results are labelled noncanonical and not comparable with a canonical run.');
  say('                      Without it, a campaign is canonical: Cernum unloads each candidate\'s weights');
  say('                      before the next one loads, on the selected endpoint only, and proves it.');
  say('  --thinking on|off   ask the model to think first, or not. Default off. Frozen; a model the');
  say('                      runtime says cannot think is refused at create rather than substituted.');
  say('');
  say('  Frontier candidates, chosen at CREATE and frozen into the manifest:');
  say('  --frontier <spec>,… provider:model[:effort], e.g. claudeCLI:claude-sonnet-5:high');
  say('                      providers: claudeCLI, codexCLI (your own signed-in CLI, subscription-included)');
  say('                                 anthropicAPI, openaiAPI (billed per token against your key)');
  say('                      A model that provider discovery has not PROVEN this account can call is');
  say('                      refused here. A model name is a plan, not a capability.');
  say('  --pricing <file>    published prices for the metered candidates, with source and timestamp.');
  say('                      Required for a metered candidate: Cernum never fetches prices, and will');
  say('                      not run a paid campaign it cannot price.');
  say('');
  say('  Local execution costs no money. Subscription execution is subscription-included, with a');
  say('  marginal API charge of $0 and a finite allowance — it is not free. Only metered API');
  say('  execution is billed per token, and none of it happens without a recorded authorization.');
  say('');
  say('  --live-residency    accepted and ignored: residency management is now the default. There is');
  say('                      nothing to remember to switch on, and nothing to forget.');
  say('');
  say('Campaigns are written where the desktop application reads them, so a run started here is');
  say('visible there while it runs, and a run started there can be resumed here.');
}

export async function main(argv: string[]): Promise<void> {
  // A terminal command has to survive its reader going away. `cernum status | head -3` closes the
  // pipe while there is still output queued, and without this Node turns that into an unhandled
  // 'error' event and a stack trace, where a person expected three lines and their prompt back.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); });
  }
  const { command, positional, options } = parse(argv);
  const invocationLine = invocation(argv);
  switch (command) {
    case 'providers': return commandProviders(options);
    case 'discover': return commandDiscover(positional, options);
    case 'smoke': return commandSmoke(positional, options);
    case 'credentials': return commandCredentials();
    case 'cost': return commandCost(positional, options);
    case 'authorize': return commandAuthorize(positional, options);
    case 'models': return commandModels(options);
    case 'suites': return commandSuites();
    case 'create': return commandCreate(positional, options);
    case 'run': return commandRun(positional, options, false, invocationLine);
    case 'resume': return commandRun(positional, options, true, invocationLine);
    case 'status': return commandStatus(positional, options);
    case 'verify': return commandVerify(positional, options);
    case 'finalize': return commandFinalize(positional, options);
    case 'retest': return commandRetest(positional, options);
    case 'lock': return commandLock(positional, options);
    case 'unlock': return commandUnlock(positional, options);
    case 'endpoints': return commandEndpoints(options);
    case 'where': return commandWhere();
    case 'install-command': return commandInstallCommand();
    case 'uninstall-command': return commandUninstallCommand();
    case 'help': case '--help': case '-h': return commandHelp();
    default: fail(`unknown command '${command}'. Try '${TERMINAL_COMMAND} help'.`);
  }
}

// Only run when invoked as a command, so the module stays importable by tests.
if (process.argv[1] && /cernum(\.[jt]s)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}
