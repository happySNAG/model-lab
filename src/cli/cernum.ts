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
  DESIRED_CANDIDATE_LADDER, EFFORT_LEVELS, IdentitySmokeResult, PROVIDER_IDS, ProviderID, ProviderStatus, REQUESTED_COHORT, RuntimeLeaseError, SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SpendingError, SyntheticHost,
  configurationKey, ladderConfigurations, reconcileCohort,
  DIVERGENCE_MEANS, FinalRankings, OTLPObserver, OTLPTurnSource,
  ThinkingMode, allCredentialStatuses, allRankableSuiteIDs, authorizationDisclosure, authorizeSpending,
  breakCampaignLock, breakRuntimeLease, buildCampaignPlan, buildEngineCatalogue, buildHostForCampaign, campaignPaths,
  SubscriptionCLIAdapter, credentialStatus, describeBinding, describeCandidateMetrics, describeExecutionPolicy,
  IDENTITY_SMOKE_PROMPT, describeExpiry, describeSmoke, desiredCandidates, discoveryStorePath,
  identitySmokeTest, modelsFromSmokes,
  readDiscoveryStore, selectableFromStore, writeDiscoveryStore,
  discoverLocalModels, discoverProvider, isDiscoverableProvider, refuseToDiscover, estimateSpending, formatMicroUSD,
  guardPolicyForEndpoint, hostOptionsFor, inspectCampaignLock, leasedEndpoints, modelCanThink,
  modelStoreBaseline, normalizeEndpoint, offlineProviderStatuses, DISCOVERABLE_PROVIDERS, parseCeilingToMicroUSD,
  providersWithExecutionAdapter, billingBasisOf, executionClassOf, buildAdapter,
  METERED_AUTHORIZATION_NOTE, UNPRICED_METERED_DISCLOSURE, authorizationClassOf, authorizeSmoke,
  buildSmokeBinding, isSmokeAuthorizationRefusal, projectedMeteredBoundMicroUSD, renderMicroUSD,
  plannedWorkFor, pricingFor, privacyDisclosure, residencyDisclosure, steppingClock, syntheticCandidate,
  terminateAllCLIProcesses,
  ADMISSION_APPROVAL, ADMISSION_STAMP_LONG, ADMISSION_STAMP_SHORT, AdmittedCandidateEvidence,
  IDENTITY_UNVERIFIABLE_CAVEAT, IdentityAdmission, IdentityAdmissionError, NEVER_AFFECTS,
  REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionProvenance, authorizeIdentityAdmission,
  auditAdjudicationPacket, buildAdjudicationPacket, caseMaterialFor, readResultsJSONL,
  referredRows, reinterpretDispositions, renderAdjudicationBatches, writeArtefact, writeText,
  recountWithCorrectedDispositions, buildEngineCatalogue as buildCatalogueForRecount,
  INCOMPLETE_EVIDENCE_MEANS, SlotResult, outcomesFromLedger, rankCandidates, recommendRetention,
  FABLE_SUBSTITUTION_REASON, prepareManifest, renderPreparedManifest,
  applyRulingsToAnswerSheet, recordRulings, RulingsInput, RulingsRecord,
  costPolicyDisclosure,
} from '../engine/index';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND, environmentOverride } from '../shared/product';
import { COMMAND_SPECS, CommandSpec, acceptedOptions, commandSpec, effectSentence } from './command-spec';
import { TerminalCommandError, installTerminalCommand, terminalCommandStatus, uninstallTerminalCommand } from '../shared/terminal-install';

const DEFAULT_ENDPOINT = environmentOverride('OLLAMA_ENDPOINT') ?? 'http://127.0.0.1:11434';

/** The same root the desktop application uses, so both see the same campaigns. */
export function defaultCampaignRoot(): string {
  const override = environmentOverride('CAMPAIGN_ROOT');
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

/**
 * Read the argument list. STRICTLY, and without deciding anything.
 *
 * WHAT THIS USED TO DO, AND WHAT IT COST. The previous parser recognised only `--name`; anything
 * starting with a single dash fell through to the positional list, and any unrecognised `--name` was
 * stored and silently ignored. Combined with a command that defaulted to a live provider when it saw
 * no positionals, `cernum smoke --help` sent six real requests to Claude. See `command-spec.ts`.
 *
 * Three rules now:
 *   - `-h` and `--help` both parse as the `help` option, wherever they appear.
 *   - a single-dash token is an OPTION, never a positional, so it can be checked rather than used.
 *   - a value is only consumed when the option is declared to take one, so `--help claude` cannot
 *     swallow `claude` and leave the command looking argument-free.
 *
 * Validation against a command's declared options happens in `validate`, after the command is known.
 */
function parse(argv: string[]): { command: string; positional: string[]; options: Options; unknown: string[] } {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const options: Options = {};
  const unknown: string[] = [];
  const spec = commandSpec(command);
  const declared = new Map((spec ? acceptedOptions(spec) : []).map((option) => [option.name, option]));

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--') { positional.push(...rest.slice(i + 1)); break; }
    if (!token.startsWith('-') || token === '-') { positional.push(token); continue; }

    const bare = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const [rawName, inline] = bare.split('=');
    const name = rawName === 'h' ? 'help' : rawName;

    if (spec && !declared.has(name)) { unknown.push(token); continue; }
    if (inline !== undefined) { options[name] = inline; continue; }
    if (!declared.get(name)?.takesValue) { options[name] = true; continue; }

    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('-')) { options[name] = next; i += 1; }
    else options[name] = true;
  }
  return { command, positional, options, unknown };
}

/**
 * Options whose VALUE has a shape, and what that shape is.
 *
 * `parse` knows whether an option takes a value. It cannot know that `--max-attempts banana` is not
 * a count, and before v0.2.4 nothing else looked either: `Number(options['max-attempts'] ?? 0)`
 * turned it into `NaN`, `NaN > 0` is false, and the cap silently did not apply — on a command whose
 * whole purpose for a cap is to keep a spending run small. A malformed value is refused here, beside
 * the unknown-option refusal, before any command body exists to misread it.
 */
const OPTION_VALUE_SHAPES: Record<string, { kind: 'positiveInteger' | 'dollars'; hint: string }> = {
  'max-attempts': { kind: 'positiveInteger', hint: 'a whole number of requests, like 1 or 6' },
  repeats: { kind: 'positiveInteger', hint: 'a whole number of passes per case, like 1' },
  ceiling: { kind: 'dollars', hint: 'an amount in dollars, like 5 or 5.00' },
  'authorize-metered': { kind: 'dollars', hint: 'an amount in dollars, like 0.50 or 5.00' },
};

/**
 * Refuse a malformed option before dispatch. Prints, and does nothing else.
 *
 * Three refusals, and every one of them is a refusal rather than a repair: a value-taking option
 * given no value, a bare flag given a value, and a value that is not the shape the option is read
 * as. Repairing any of them would mean deciding what somebody meant by something they did not type.
 */
function validateOptionValues(command: string, spec: CommandSpec, options: Options): void {
  const declared = new Map(acceptedOptions(spec).map((option) => [option.name, option]));
  for (const [name, value] of Object.entries(options)) {
    const option = declared.get(name);
    if (!option) continue;
    if (option.takesValue && value === true) {
      fail(`${command}: --${name} needs a value and was given none.\n`
        + `  ${option.summary}\n`
        + `nothing was run. See '${TERMINAL_COMMAND} ${command} --help'.`, 2);
    }
    if (!option.takesValue && typeof value === 'string') {
      fail(`${command}: --${name} is a flag and takes no value, but was given '${value}'.\n`
        + `nothing was run. See '${TERMINAL_COMMAND} ${command} --help'.`, 2);
    }
    if (typeof value !== 'string') continue;
    if (value.trim().length === 0) {
      fail(`${command}: --${name} was given an empty value.\n`
        + `nothing was run. See '${TERMINAL_COMMAND} ${command} --help'.`, 2);
    }
    const shape = OPTION_VALUE_SHAPES[name];
    if (!shape) continue;
    const ok = shape.kind === 'positiveInteger'
      ? /^\d+$/.test(value.trim()) && Number(value.trim()) > 0
      : /^\$?\d+(\.\d{1,6})?$/.test(value.trim());
    if (!ok) {
      fail(`${command}: --${name} was given '${value}', which is not ${shape.hint}.\n`
        + `nothing was run. See '${TERMINAL_COMMAND} ${command} --help'.`, 2);
    }
  }
}

/** `<command> --help`: what it is, what it costs, and every option it will accept. Prints nothing else. */
function printCommandHelp(spec: CommandSpec): void {
  say(`${TERMINAL_COMMAND} ${spec.name}${spec.positional ? ` ${spec.positional}` : ''}`);
  say('');
  say(`  ${spec.summary}`);
  say('');
  say(`  ${effectSentence(spec.effect)}`);
  if (spec.detail && spec.detail.length > 0) {
    say('');
    for (const line of spec.detail) say(line.length > 0 ? `  ${line}` : '');
  }
  const options = acceptedOptions(spec);
  if (options.length > 0) {
    say('');
    say('  Options:');
    for (const option of options) {
      const flag = `--${option.name}${option.takesValue ? ' <value>' : ''}`;
      say(`    ${flag.padEnd(34)} ${option.summary}`);
    }
  }
  say('');
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
  // Printed LAST so it is the line still on screen when the reader looks away, and printed on every
  // status rather than only at creation: a campaign is watched over hours, and the one thing a
  // reader must not carry away from it is the impression that these rows are attributed.
  for (const admitted of status.admittedWithoutProvenIdentity) {
    say(`  ** IDENTITY UNVERIFIABLE — ${admitted.candidate} **`);
    for (const line of wrap(admitted.stamp, 74)) say(`     ${line}`);
  }
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
  otlp?: OTLPTurnSource;
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
    otlp: context.otlp,
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
      // WIDE ENOUGH FOR AN OPENCODE ADDRESS. These identifiers are `provider/model`, and the free
      // pool's longest runs to 39 characters — at 28 the column collapsed and the display names
      // stopped lining up the moment the pool was added.
      say(`  unproven  ${model.modelID.padEnd(42)} ${model.displayName}`);
    }
    say('');
  }
  say(`Run discovery explicitly: ${TERMINAL_COMMAND} discover [${DISCOVERABLE_PROVIDERS.join('|')}]`);
  // DERIVED, AND WITH THE SCOPE IN IT. This line named two providers by hand — so it omitted
  // OpenCode, which this build can execute — and its bracket syntax implied a default this command
  // does not have and will not get.
  say(`Prove a model by asking it once:  ${TERMINAL_COMMAND} smoke <${SMOKEABLE_PROVIDERS.join('|')}> --models <id,…>`);
  say(`  See what that would send without sending it:  add --dry-run.   Full options: ${TERMINAL_COMMAND} help smoke`);
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
 * The providers a smoke test can actually ask, derived from which ones can EXECUTE.
 *
 * Not a hand-kept list: `providersWithExecutionAdapter()` is the same answer `adaptersFor` gives a
 * campaign, so a provider that can run a campaign can be smoke tested and one that cannot is refused
 * here rather than failing later with an adapter that was never built.
 */
const SMOKEABLE_PROVIDERS: ProviderID[] = providersWithExecutionAdapter();

/**
 * What `discover` with no argument asks.
 *
 * The two subscription CLIs, because they are the providers a Cernum campaign is normally run
 * through and neither costs anything to ask. Every other provider is discovered by NAMING it —
 * including OpenCode, which is metered, and whose listing should be asked for deliberately rather
 * than swept up by a bare command.
 */
const DEFAULT_DISCOVERY = ['claudeCLI', 'codexCLI'];

/**
 * Ask a provider what it is and what this account may call. THIS INVOKES SOMETHING.
 *
 * Running the CLI's `--version` and its model listing costs no inference and spends no tokens.
 * Listing a metered provider's models is a request made with the user's key, which is why it happens
 * only here and never from a status read.
 */
async function commandDiscover(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());
  const wanted = positional.length > 0 ? positional : DEFAULT_DISCOVERY;
  // NAMES ARE CHECKED BEFORE ANYTHING RUNS. `discover claudeCLI opencode` used to discover Claude
  // and then fail, leaving half a run's evidence written and the person unsure which half.
  for (const provider of wanted) if (!isDiscoverableProvider(provider)) fail(refuseToDiscover(provider));
  const providers = wanted as ProviderID[];
  if (options['dry-run'] === true) {
    say('DRY RUN — no tool was run and no evidence was written.');
    say('');
    for (const provider of providers) {
      say(`  ${PROVIDER_LABELS[provider as ProviderID]} (${provider})`);
      say(`    would run its version, credential and model-listing subcommands`);
      say(`    ${effectSentence('invokesLocalTool')}`);
    }
    say('');
    say(`Run it for real with: ${TERMINAL_COMMAND} discover ${providers.join(' ')}`);
    return;
  }

  // A DISCOVERY THAT COULD NOT REACH A PROVIDER MUST NOT ERASE WHAT IT ESTABLISHED EARLIER.
  //
  // This used to drop every row for each named provider unconditionally and then write back only
  // what came out of this run. So `cernum discover opencodeCLI` on a machine where OpenCode is not
  // installed — or is installed and signed out, or answered nothing — DELETED the whole record for
  // that provider, including a `proven` row that a metered smoke had paid for. Nothing warned, and
  // nothing could recover it: the store is the evidence.
  //
  // A tool that did not answer is a fact about today, not a retraction of what was established
  // before. Rows survive; they age out through `DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS` like every
  // other proof, because their `discoveredAt` is untouched — a run that learned nothing does not get
  // to refresh anybody's freshness either.
  const existing = readDiscovered(root);
  const kept: DiscoveredFrontierModel[] = existing.filter((model) => !providers.includes(model.provider));
  const discovered: DiscoveredFrontierModel[] = [...kept];

  for (const provider of providers) {
    // One router, shared with the desktop application. This file used to decide for itself which
    // provider went to which discovery function, and its copy of that decision had no branch for
    // OpenCode — so `cernum discover opencodeCLI` denied a provider this same build supports.
    const status: ProviderStatus = await discoverProvider(provider);
    renderProviderStatus(status);
    if (status.models.length > 0) { discovered.push(...status.models); continue; }
    const previous = existing.filter((model) => model.provider === provider);
    if (previous.length === 0) continue;
    discovered.push(...previous);
    say('');
    say(`    ${previous.length} earlier row(s) for ${provider} were KEPT, not erased: this run learned nothing about`);
    say('    them, which is not the same as establishing that they are gone. Their timestamps are unchanged,');
    say('    so they still expire on their own schedule.');
  }

  writeDiscovered(root, discovered);
  const proven = discovered.filter((model) => model.availability === 'proven');
  const corrected = discovered.filter((model) => model.evidenceCorrectedBy !== undefined);
  say('');
  say(`${proven.length} model(s) are now selectable. Anything not listed as 'proven' cannot be put in a campaign.`);
  if (corrected.length > 0) {
    say(`${corrected.length} row(s) carried evidence a later release superseded; the correction is now written to`);
    say('disk beside the original text, which is preserved. No availability changed.');
  }
  say(`Recorded in ${discoveryStorePath(root)}`);
}

/**
 * Prove — or fail to prove — that this account can call a model, by asking it once who it is.
 *
 * THIS SENDS REAL REQUESTS. One per candidate and effort level, carrying a nine-word prompt. It is a
 * separate command from `discover` for exactly that reason: `discover` runs a tool's own read-only
 * subcommands and costs nothing, and this one talks to a model.
 *
 * It exists because no CLI this engine drives can answer "which models may this account call", though
 * they fail to answer it differently. `claude` has no model-listing command at all. `codex` has one —
 * `codex debug models` — but it renders a CATALOGUE of what the client knows about, and the service
 * refuses models that appear in it. `opencode models` is read from a cached catalogue of thousands of
 * models nobody has called. So the only honest route is to ask, once, and write down what came back.
 *
 * -- WHAT v0.2.4 CHANGED, AND THE AUDIT THAT FOUND IT -------------------------------------------
 *
 * A dry-run audit on a MacBook Pro read this command's preview against the record it would write and
 * found them describing different requests. The preview derived the billing basis from the provider
 * registry; the request was built by a local helper that wrote `subscriptionCLI`,
 * `subscriptionIncluded` and `subscriptionCLISession` as literals for every provider. A live OpenCode
 * smoke would therefore have spent metered money and recorded a $0 marginal charge covered by a
 * subscription. Nothing caught it, because the smoke path was the one binding-building path in this
 * engine that never ran `validateBinding`.
 *
 * There is now ONE binding per request, built by `buildSmokeBinding`, validated where it is built.
 * The preview renders it, the request is sent under it, the evidence file carries it, and the
 * discovery row is derived from it. And a metered request is refused outright unless it was
 * authorized by name — with a ceiling where a price exists, and with an explicit written
 * acknowledgement of an unknown amount, for exactly one request, where none does.
 */
async function commandSmoke(positional: string[], options: Options): Promise<void> {
  const root = String(options.root ?? defaultCampaignRoot());

  // EXACTLY ONE PROVIDER, NAMED BY THE PERSON. There is no default and there will not be one: the
  // v0.2.2 default of `claudeCLI` is what turned `cernum smoke --help` into six billed requests.
  if (positional.length === 0) {
    fail('no provider named, and this command has no default.\n'
      + `Name one: ${TERMINAL_COMMAND} smoke <provider> --models <id,…>\n`
      + `Providers that can be smoke tested: ${SMOKEABLE_PROVIDERS.join(', ')}\n`
      + `See what it would send without sending it: ${TERMINAL_COMMAND} smoke <provider> --models <id,…> --dry-run`, 2);
  }
  if (positional.length > 1) {
    fail(`one provider at a time, but ${positional.length} were named: ${positional.join(', ')}.`, 2);
  }
  const provider = positional[0] as ProviderID;
  if (!SMOKEABLE_PROVIDERS.includes(provider)) {
    fail(`'${provider}' cannot be smoke tested. Cernum can ask: ${SMOKEABLE_PROVIDERS.join(', ')}.\n`
      + 'A smoke test drives a CLI you installed and authenticated yourself. Note that `discover` does '
      + 'NOT establish identity either: it reads a listing, and a listing says what a provider knows '
      + 'about, not what it will answer to.', 2);
  }

  // AND AN EXPLICIT CANDIDATE SCOPE. Naming a provider is not enough: the whole ladder is six
  // requests on Claude, which is precisely the bill the incident produced.
  const ladder = DESIRED_CANDIDATE_LADDER
    .filter((entry) => entry.provider === provider && entry.modelID.length > 0);
  if (ladder.length === 0) {
    fail(`nothing on the intended testing ladder names a model for ${provider}, so there is nothing to ask for. `
      + 'A smoke test never invents an identifier.', 2);
  }
  const named = typeof options.models === 'string'
    ? options.models.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    : [];
  if (named.length === 0 && options['all-ladder'] !== true) {
    fail('no candidate scope given, and this command has no default scope.\n'
      + `Either name the models:  --models ${ladder[0].modelID}\n`
      + `or ask for all ${ladder.length} on this provider's ladder, deliberately:  --all-ladder\n`
      + `The ladder for ${provider} is: ${ladder.map((entry) => entry.modelID).join(', ')}`, 2);
  }
  const requested = named.length > 0
    ? named.map((id) => {
        const entry = ladder.find((candidate) => candidate.modelID === id);
        if (!entry) {
          fail(`'${id}' is not on ${provider}'s intended ladder, and a smoke test never invents an identifier.\n`
            + `Ladder: ${ladder.map((candidate) => candidate.modelID).join(', ')}`, 2);
        }
        return entry;
      })
    : ladder;

  const budget = Number(options['max-attempts'] ?? 0);
  const pairs = requested.flatMap((entry) => entry.desiredEfforts.map((effort) => ({ entry, effort })));
  const planned = budget > 0 ? pairs.slice(0, budget) : pairs;

  // THE BINDINGS, BUILT ONCE, HERE. Everything below — the preview, the authorization decision, the
  // requests themselves, the evidence file and the discovery rows — reads these objects. There is no
  // second description of this run for any of them to disagree with.
  const pricingFile = readPricingFile(options);
  const bindings = planned.map(({ entry, effort }) => {
    if (!EFFORT_LEVELS.includes(effort as EffortLevel)) {
      fail(`'${effort}' is not an effort level this engine models. Valid: ${EFFORT_LEVELS.join(', ')}.`, 2);
    }
    try {
      return buildSmokeBinding({
        provider: entry.provider,
        modelID: entry.modelID,
        effort: effort as EffortLevel,
        pricing: pricingFor(pricingFile, entry.provider, entry.modelID) ?? null,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 2);
    }
  });

  // TELEMETRY IS CODEX-ONLY, AND IS REFUSED BEFORE ANYTHING IS SENT RATHER THAN IGNORED IN FLIGHT.
  // Until v0.2.4 `--otlp-observer` was not even accepted here, and the adapter this command built was
  // constructed with no options at all — so the flag would have been inert had it been.
  const otlpDirectory = options['otlp-observer'] === undefined ? undefined : String(options['otlp-observer']);
  if (otlpDirectory !== undefined && provider !== 'codexCLI') {
    fail(`--otlp-observer was given for ${provider}. Only the Codex CLI exposes an exporter this engine reads, so `
      + 'nothing would export telemetry to the collector. No collector was started and nothing was sent.', 2);
  }

  const dryRun = options['dry-run'] === true;
  const metered = bindings.some((binding) => binding.billingBasis === 'meteredAPI');
  const ceilingMicroUSD = options['authorize-metered'] === undefined ? undefined
    : parseSmokeCeiling(String(options['authorize-metered']));
  const authorization = authorizeSmoke({
    bindings,
    ceilingMicroUSD,
    unpricedAcknowledged: options['authorize-unpriced-metered'] === true,
  });

  // WHAT WOULD BE SENT, ALWAYS PRINTED BEFORE ANYTHING IS SENT. Under --dry-run this is the whole
  // command; otherwise it is the disclosure that precedes the first request. ONE renderer, so the
  // preview and the live disclosure cannot drift.
  say(dryRun ? 'DRY RUN — nothing below is sent, and no allowance is consumed.' : 'About to send real requests.');
  say('');
  say(`  provider              ${PROVIDER_LABELS[provider]} (${provider})`);
  say(`  candidates            ${requested.length} (${named.length > 0 ? 'named with --models' : "--all-ladder: this provider's whole ladder"})`);
  say(`  requests to be sent   ${planned.length}${budget > 0 && pairs.length > planned.length ? ` (capped by --max-attempts from ${pairs.length})` : ''}`);
  say(`  execution class       ${bindings[0].executionClass}`);
  say(`  authorization class   ${authorizationClassOf(bindings[0])}`);
  say(`  authorization mode    ${bindings[0].authorizationMode}`);
  if (otlpDirectory !== undefined) say(`  telemetry             loopback OTLP collector in ${path.resolve(otlpDirectory)}`);
  say('');
  for (const binding of bindings) {
    const bound = projectedMeteredBoundMicroUSD(binding);
    say(`    ${binding.requestedModelID.padEnd(24)} effort ${binding.effort.padEnd(8)} 1 request`
      + `   ${binding.billingBasis}`
      + (binding.billingBasis !== 'meteredAPI' ? ''
        : bound === undefined ? '  cost UNAVAILABLE (no price supplied)'
          : `  worst case ${renderMicroUSD(bound)}`));
    if (binding.pricing) say(`      prices: ${binding.pricing.source} (captured ${binding.pricing.capturedAt})`);
  }
  say('');

  // THE AUTHORIZATION POSITION, STATED IN BOTH MODES. A dry-run reports what a live run would need
  // rather than refusing: the whole point of a preview is that a person can read the requirement
  // before they are standing in front of it.
  if (isSmokeAuthorizationRefusal(authorization)) {
    if (!dryRun) {
      fail(`this run is not authorized.\n${authorization.message}`, 6);
    }
    say('  AUTHORIZATION REQUIRED — a live run of this scope would be REFUSED as it stands:');
    for (const paragraph of authorization.message.split('\n')) {
      if (paragraph.trim().length === 0) { say(''); continue; }
      // Indented lines in these messages are already laid out as commands to type; wrapping them
      // would break the thing a person is meant to copy.
      if (paragraph.startsWith('  ')) { say(`    ${paragraph}`); continue; }
      for (const line of wrap(paragraph, 72)) say(`    ${line}`);
    }
    say('');
  } else {
    say(`  authorization         ${authorization.kind}`);
    for (const line of wrap(authorization.statement, 70)) say(`    ${line}`);
    say('');
  }

  if (dryRun) {
    say(isSmokeAuthorizationRefusal(authorization)
      ? 'No request was sent, and none would be: this scope is not authorized as it stands. Supply the '
        + 'authorization named above, then re-run with --dry-run again to confirm before sending anything.'
      : 'No request was sent. Re-run without --dry-run to send the requests listed above.');
    return;
  }

  if (metered) {
    // Said again, immediately before the first request, because the line between "previewed" and
    // "sent" is the line money crosses.
    for (const line of wrap(METERED_AUTHORIZATION_NOTE, 74)) say(`  ${line}`);
    if (!isSmokeAuthorizationRefusal(authorization) && authorization.kind === 'unpricedAcknowledged') {
      say('');
      for (const line of wrap(UNPRICED_METERED_DISCLOSURE, 74)) say(`  ${line}`);
    }
    say('');
  }
  say(`${planned.length} identity smoke test(s). Each one sends a single minimal prompt to a real model.`);
  say('Nothing here is a benchmark and no campaign is created.');
  say('');

  const observer = otlpDirectory === undefined ? undefined : await OTLPObserver.start({
    evidenceFile: path.join(otlpDirectory, 'smoke-otlp-payloads.redacted.jsonl'),
  });
  if (observer) {
    say(`OTLP observer on ${observer.endpoint} — loopback only, no outbound connection.`);
    say('  Reading: the reasoning effort the tool says it applied, and its token decomposition.');
    say('  NOT reading identity: the telemetry names the model this client REQUESTED, which is not');
    say('  a model naming itself. A Codex smoke stays requestAcceptedIdentityUnverifiable.');
    say('  Spans arrive a few seconds after a request closes, so a turn may still be pending when');
    say('  its result prints; the correlation key on each result is how it is collected afterwards.');
    say('  Identifiers (user.email, user.account_id, conversation.id) are redacted at ingest.');
    say('');
  }

  const results: IdentitySmokeResult[] = [];
  try {
    for (const binding of bindings) {
      // THE ADAPTER COMES FROM THE SAME FACTORY A CAMPAIGN USES, AND NOW WITH THE SAME OPTIONS. This
      // line used to construct one with no options, which is why `--otlp-observer` could not have
      // worked here even once it was accepted.
      const adapter = buildAdapter(binding.provider, process.env, { otlp: observer });
      if (!adapter) fail(`no execution adapter for ${binding.provider}; this is a bug, and nothing was sent.`, 70);
      const result = await identitySmokeTest(binding, adapter);
      results.push(result);
      say(`  ${describeSmoke(result)}`);
      for (const line of wrap(result.evidence, 74)) say(`      ${line}`);
      say(`      identity state ${result.identityState} · binding ${result.billingBasis} · auth ${result.authorizationMode}`);
      say(`      tokens in ${renderQuantity(result.inputTokens)} · visible out ${renderQuantity(result.visibleOutputTokens)}`
        + ` · reasoning ${renderQuantity(result.reasoningTokens)}`);
      say(`      wall ${renderQuantity(result.totalWallClockMilliseconds)}ms · first visible output `
        + `${renderQuantity(result.timeToFirstVisibleTokenMilliseconds)}ms · retries ${result.retryCount}`);
      say(`      effort applied, as the provider reported it: ${result.reportedEffort.length > 0 ? result.reportedEffort : 'not reported'}`);
      if (result.telemetry) {
        say(`      telemetry ${result.telemetry.correlated ? 'observed in flight' : 'pending — collect by correlation key'}`
          + ` · key ${result.telemetry.correlationKey} · records ${result.telemetry.recordCount}`);
        say(`      telemetry effort: turn ${result.telemetry.turnReasoningEffort ?? 'not reported'}`
          + ` · request ${result.telemetry.requestReasoningEffort ?? 'not reported'}`);
      }
      say(`      marginal API charge ${renderMoney(result.marginalAPIChargeMicroUSD)}`
        + (result.billingBasis === 'meteredAPI' ? ' — billed to your own credential' : ' (no card is billed)'));
      // The allowance line is printed only where there IS an allowance. Rendering
      // `subscriptionIncludedUsageMicroUSD` for a metered row under the words "plan allowance
      // consumed" would describe a subscription this candidate does not have.
      if (result.billingBasis === 'subscriptionIncluded') {
        say(`      plan allowance consumed, at list value: ${renderMoney(result.subscriptionIncludedUsageMicroUSD)}`
          + (result.subscriptionIncludedUsageMicroUSD.provenance === 'unavailable' ? '' : ' — a zero charge is not a zero cost'));
      } else {
        say('      plan allowance consumed: none — this is not a subscription, it is billed per token');
      }
      for (const note of result.notEnforceable) for (const line of wrap(note, 70)) say(`      ! ${line}`);
      say('');
    }
  } finally {
    if (observer) {
      const summary = await observer.stop();
      say('OTLP observer stopped.');
      say(`  payloads ${summary.payloadCount} · conversations ${summary.conversationCount} · `
        + `observed in-flight ${summary.correlatedCount} · identifiers redacted ${summary.redactionCount} `
        + `(${summary.distinctIdentifiers} distinct)`);
      say(`  evidence: ${summary.evidenceFile}`);
      say(`  join table: ${summary.indexFile} — keyed by the correlation key on each result`);
      say(`  leak audit: ${summary.leakAuditClean ? 'clean — nothing email-shaped survived redaction'
        : `FAILED — ${summary.leaks.length} identifier(s) reached the file`}`);
      if (!summary.leakAuditClean) say('  *** The evidence file must not be shared until that is resolved. ***');
      say('');
    }
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
  // through redaction. What it does carry is each verdict with the numbers behind it, THE BINDING
  // EACH REQUEST WAS SENT UNDER, and the authorization it was sent on — which is what a later reader
  // needs to check a claim rather than take it.
  const evidencePath = options.evidence === undefined ? undefined : String(options.evidence);
  if (evidencePath) {
    fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    fs.writeFileSync(path.resolve(evidencePath), JSON.stringify({
      writtenAt: new Date().toISOString(),
      cernumVersion: PRODUCT.version,
      note: 'Identity smoke evidence. No credential, session token, email address, organisation id or '
        + 'organisation name appears here: the authentication parser keeps only whether the session is signed in, '
        + 'how, and the plan tier. The bindings below are the objects these requests were actually sent under, and '
        + 'the same objects the preview was rendered from.',
      prompt: IDENTITY_SMOKE_PROMPT,
      authorization,
      bindings,
      results,
    }, null, 2) + '\n', 'utf8');
    say(`Evidence written to ${path.resolve(evidencePath)}`);
  }

  const proven = fresh.filter((model) => model.availability === 'proven');
  say(`${proven.length} of ${fresh.length} candidate(s) are now proven and selectable.`);
  say(`Recorded in ${discoveryStorePath(root)}`);
  say('No campaign was created. A preflight establishes who answers; it does not measure anything.');
}

/** A spending ceiling, in the dollars a person types. Refused rather than coerced. */
function parseSmokeCeiling(text: string): number {
  try {
    return parseCeilingToMicroUSD(text);
  } catch (error) {
    return fail(`--authorize-metered ${text}: ${error instanceof Error ? error.message : String(error)}\n`
      + 'Nothing was sent.', 2);
  }
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
    // OpenCode carries no API-key environment variable to read: the tool holds its own credential,
    // and the manifest says exactly that rather than naming a key Cernum does not have.
    authorizationMode: provider === 'opencodeCLI' ? 'toolManagedCredential' as const
      : credential === undefined ? undefined
        : credential.source === 'keychain' ? 'apiKeyKeychain' as const : 'apiKeyEnvironment' as const,
  };
}

/**
 * Read a written identity-admission authorization, and seal it to THIS campaign.
 *
 * WHAT THE FILE IS. A person's written statement that they know a named Codex configuration cannot
 * have its identity proven, that they want it measured anyway, and what evidence they are resting
 * that on. It is not generated by this command and it is not derived from a smoke test: the whole
 * point is that a person wrote it down.
 *
 * WHAT THIS FUNCTION FILLS IN, AND WHY THAT IS NOT CHEATING. `campaignLabel` and `authorizedAt`
 * come from the campaign being created, which is what binds the authorization to one campaign
 * rather than letting a file be reused. `returnedModelID` is set to the empty string and `state` to
 * the one legal state — neither is a fact being invented, because in this state no other value is
 * permitted, and `authorizeIdentityAdmission` refuses anything else. Everything a reader would
 * actually need to judge the exception — which configurations, on what CLI, on what authentication,
 * resting on which evidence captured when — must be in the file, and the record is refused if any
 * of it is missing.
 */
function readIdentityAdmission(options: Options, campaignLabel: string): IdentityAdmission | undefined {
  const file = options['admit-identity-unverifiable'];
  if (file === undefined || file === true) return undefined;
  let parsed: { authorizedBy?: unknown; admitted?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(String(file), 'utf8')) as typeof parsed;
  } catch (error) {
    return fail(`could not read the identity admission at ${String(file)}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (typeof parsed.authorizedBy !== 'string' || parsed.authorizedBy.trim().length === 0) {
    return fail('an identity admission must name who authorised it, in their own words. A record with no author is '
      + 'an exception nobody took responsibility for.', 2);
  }
  if (!Array.isArray(parsed.admitted) || parsed.admitted.length === 0) {
    return fail('an identity admission must list the exact configurations it admits. An empty list would be a '
      + 'provider-wide exception, which this design does not offer.', 2);
  }
  const admitted: AdmittedCandidateEvidence[] = (parsed.admitted as Record<string, unknown>[]).map((entry) => ({
    provider: String(entry.provider ?? '') as ProviderID,
    requestedModelID: String(entry.requestedModelID ?? ''),
    requestedEffort: String(entry.requestedEffort ?? '') as EffortLevel,
    cliVersion: String(entry.cliVersion ?? ''),
    authenticationBasis: String(entry.authenticationBasis ?? ''),
    evidenceDigest: String(entry.evidenceDigest ?? ''),
    evidenceCapturedAt: String(entry.evidenceCapturedAt ?? ''),
    returnedModelID: '',
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  }));
  try {
    return authorizeIdentityAdmission({
      campaignLabel,
      authorizedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      authorizedBy: parsed.authorizedBy,
      admitted,
    });
  } catch (error) {
    if (error instanceof IdentityAdmissionError) return fail(error.message, 2);
    throw error;
  }
}

/** Everything a person should have read before an exception like this takes effect. */
function identityAdmissionDisclosure(admission: IdentityAdmission): string[] {
  const lines = [
    `${ADMISSION_APPROVAL.pass}, decision ${ADMISSION_APPROVAL.decision}.`,
    '',
    `This campaign will run ${admission.admitted.length} candidate(s) whose identity CANNOT be proven:`,
  ];
  for (const entry of admission.admitted) {
    lines.push(`  · ${entry.requestedModelID} at effort ${entry.requestedEffort} on ${entry.provider}`);
    for (const line of admissionProvenance(entry).slice(0, 8)) lines.push(`      ${line}`);
  }
  lines.push('', ADMISSION_STAMP_LONG, '', 'What this exception does NOT do:');
  for (const never of NEVER_AFFECTS) lines.push(`  · ${never}`);
  lines.push('', `Authorised by: ${admission.authorizedBy}`, `Sealed as: ${admission.admissionDigest}`);
  return lines;
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

  // Read and sealed BEFORE anything is frozen, and confirmed separately from being supplied. Naming
  // the file says what you would authorise; --yes-identity-unverifiable says you did. The same shape
  // as `authorize --yes`, and for the same reason: the disclosure is worth nothing if the act of
  // passing a path is itself the consent.
  const identityAdmission = readIdentityAdmission(options, String(options.label ?? name));
  if (identityAdmission) {
    say('');
    for (const line of identityAdmissionDisclosure(identityAdmission)) {
      if (line.length === 0) say('');
      else for (const wrapped of wrap(line, 78)) say(`  ${wrapped}`);
    }
    say('');
    if (options['yes-identity-unverifiable'] !== true) {
      fail('Nothing was created. Re-run with --yes-identity-unverifiable once the disclosure above is what you '
        + 'intend. Without it, these candidates are refused as unproven, which is the default and stays the '
        + 'default for every campaign that does not say otherwise.', 3);
    }
  }

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
      identityAdmission,
    });
  } catch (error) {
    if (error instanceof CampaignBuildError) return fail(error.message, 2);
    throw error;
  }

  // THE COST POLICY IS RECORDED ON THE CAMPAIGN, NOT APPLIED TO THE INVOCATION.
  //
  // Every campaign created by this command is governed by the project cost policy, so the opt-in is
  // written into the configuration where `run` and `resume` will read it back. Confirmations and
  // overrides are the evidence the gate may consult, and there are none by default: a metered or
  // unclassifiable candidate is blocked, and rescuing one takes a written record rather than a flag.
  const configuration: CampaignConfiguration = { ...built.configuration, costPolicy: {} };
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
  // WHO PAYS FOR EACH CANDIDATE, stated for every row rather than inferred for most of them. Printed
  // before the run rather than after it, because the point of the table is to be read while the
  // cohort can still be changed.
  // The disclosure indents its own rows to show which reason belongs to which candidate, so the
  // indent is measured and reapplied to every wrapped fragment. Wrapping that flattened it would
  // turn a table into a paragraph and lose exactly the thing the table is for.
  for (const line of costPolicyDisclosure(built.costEligibility)) {
    if (line.length === 0) { say(''); continue; }
    const indent = ' '.repeat(2 + (line.length - line.trimStart().length));
    for (const wrapped of wrap(line.trimStart(), 78 - indent.length)) say(`${indent}${wrapped}`);
  }
  say('');
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

  // WHAT THIS RUN WOULD SEND, WITHOUT SENDING IT. Placed after the frozen-policy refusals, so a
  // dry run reports the same refusals a real one would, and before any lock, lease or request.
  if (options['dry-run'] === true) {
    const bindings = configuration.operationalEnvelope?.bindings ?? [];
    const external = bindings.filter((binding) => binding.provider !== 'ollama');
    say(`DRY RUN — ${name} was not started, no lock was taken and no request was sent.`);
    say('');
    say(`  campaign              ${name}`);
    say(`  policy                ${describeExecutionPolicy(execution)}`);
    say(`  candidates            ${bindings.length}`);
    for (const binding of bindings) {
      say(`    ${binding.candidate.padEnd(38)} ${binding.provider} · ${binding.billingBasis}`);
    }
    say('');
    if (external.length === 0) {
      say('  Every candidate runs on this machine. No prompt would leave it.');
    } else {
      // One line per provider, rendered from an ACTUAL BINDING of that provider rather than from its
      // id, so what is printed here describes the requests this campaign froze — pricing included.
      const perProvider = external.filter((binding, index) =>
        external.findIndex((other) => other.provider === binding.provider) === index);
      say(`  authorization classes ${perProvider.map((binding) => `${binding.provider}: ${authorizationClassOf(binding)}`).join('\n                        ')}`);
      say('');
      say('  A real run would send prompts to an external provider and consume allowance.');
    }
    say('');
    say(`Run it for real with: ${TERMINAL_COMMAND} ${resuming ? 'resume' : 'run'} ${name}`);
    return;
  }

  let stopping = false;

  // THE TELEMETRY COLLECTOR IS OPT-IN, PER CAMPAIGN, AND ONLY FOR CODEX.
  //
  // `codex exec --json` echoes no reasoning effort, so Pass 6 and Pass 7 could only ever record a
  // Codex candidate's effort as accepted and never as applied. The tool's own OTLP exporter does
  // carry it. This starts a collector on loopback, with an ephemeral port and no outbound
  // connection, and points each `codex exec` invocation at it through a per-invocation override —
  // the operator's `~/.codex/config.toml` is never touched, and `--ignore-user-config` means it
  // could not have reached the request anyway.
  //
  // It is a flag rather than a default because exporting a tool's telemetry anywhere is a decision,
  // and because every record `codex` emits carries the operator's email address. Those identifiers
  // are redacted at ingest, before a byte is written, and the file is audited on shutdown.
  const otlpDirectory = options['otlp-observer'] === undefined ? undefined : String(options['otlp-observer']);
  const usesCodex = (configuration.operationalEnvelope?.bindings ?? []).some((binding) => binding.provider === 'codexCLI');
  if (otlpDirectory !== undefined && !usesCodex) {
    fail('--otlp-observer was given for a campaign with no codexCLI candidate. Nothing would export telemetry to it, '
      + 'so the collector was not started and nothing was run. Only the Codex CLI exposes an exporter this engine reads.', 2);
  }
  const observer = otlpDirectory === undefined ? undefined : await OTLPObserver.start({
    evidenceFile: path.join(otlpDirectory, `${name}-otlp-payloads.redacted.jsonl`),
  });
  if (observer) {
    // Said before the run, because a reader of the log should not have to infer it from a column of
    // `otlpCorrelated: false`. The spans this reads arrive seconds AFTER each attempt closes, so the
    // join happens after the campaign rather than during it.
    say('  Spans arrive a few seconds after each attempt closes, so effort and token figures are');
    say('  joined AFTER the run, on the correlation key recorded on every row.');
  }
  if (observer) {
    say(`OTLP observer on ${observer.endpoint} — loopback only, no outbound connection.`);
    say('  Reading: the reasoning effort the tool says it applied, and its token decomposition.');
    say('  NOT reading identity: the telemetry names the model this client REQUESTED, which is not');
    say('  a model naming itself. Every Codex row stays requestAcceptedIdentityUnverifiable.');
    say('  Identifiers (user.email, user.account_id, conversation.id) are redacted at ingest.');
    say('');
  }

  // Opened twice on purpose. The first open reads the ledger and the authorization off disk; the
  // second builds the host WITH them, so a spending ceiling is enforced against everything this
  // campaign has already spent rather than restarting at zero on every resume.
  const reading = Campaign.open(directory, configuration, await hostFor(configuration, options));
  const authorization = reading.readAuthorization();
  const priorRows = reading.ledgerRows();
  const campaign = Campaign.open(directory, configuration, await hostFor(configuration, options, {
    authorization, priorRows, shouldCancel: () => stopping, otlp: observer,
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
    // Closed whether the run completed, paused, aborted or threw — and its own output audited
    // before anything else is printed. A collector left listening would outlive the campaign it
    // was isolated to.
    if (observer) {
      const summary = await observer.stop();
      say('');
      say('OTLP observer stopped.');
      say(`  payloads ${summary.payloadCount} · conversations ${summary.conversationCount} · `
        + `observed in-flight ${summary.correlatedCount} · identifiers redacted ${summary.redactionCount} `
        + `(${summary.distinctIdentifiers} distinct)`);
      say(`  evidence: ${summary.evidenceFile}`);
      say(`  join table: ${summary.indexFile} — keyed by the correlation key on each ledger row`);
      say(`  leak audit: ${summary.leakAuditClean ? 'clean — nothing email-shaped survived redaction'
        : `FAILED — ${summary.leaks.length} identifier(s) reached the file`}`);
      if (!summary.leakAuditClean) {
        say('  *** The evidence file must not be shared until that is resolved. ***');
      }
    }
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
  // One printer, two tables. Two hand-written loops would be two loops that could come to disagree
  // about what a rank means, and a reader comparing the tables would be comparing the printing.
  const sayRankings = (heading: string, table: FinalRankings): void => {
    say(heading);
    for (const line of wrap(table.viewLabel, 76)) say(`  ${line}`);
    for (const ranking of table.rankings) {
      const rate = 'measured' in ranking.overallPassRateMilli ? `${(ranking.overallPassRateMilli.measured / 10).toFixed(1)}%` : 'no rate';
      say(`  ${String(ranking.rank).padStart(2)}. ${ranking.candidate.padEnd(20)} ${rate.padStart(8)}  ${ranking.disqualified ? 'DISQUALIFIED' : ''}`);
      const roles = ranking.roles.filter((role) => role.qualified).map((role) => role.role);
      if (roles.length > 0) say(`      roles: ${roles.join(', ')}`);
      // Said on the ranking row itself. A candidate can sit at rank 1 on a real measurement and
      // still be a candidate nobody may act on, and those two facts have to arrive together.
      if (!ranking.promotable) say(`      ** ${ADMISSION_STAMP_SHORT} — no role, no retention recommendation **`);
    }
    say('');
  };

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
  // BEFORE THE TABLES, like the divergence list and for the same reason. A reader who reaches a
  // leaderboard without having been told that its top row rests on a fifth of the attempts has
  // already drawn the conclusion Pass 11 published.
  if (report.rankings.incompleteEvidence.length > 0) {
    say(`*** ${report.rankings.incompleteEvidence.length} CANDIDATE(S) BELOW REST ON PART OF THE PLAN ***`);
    for (const line of wrap(report.rankings.incompleteEvidenceMeans, 76)) say(`  ${line}`);
    say('');
    for (const entry of report.rankings.incompleteEvidence) {
      say(`  · ${entry.candidate}: coverage ${(entry.measuredCoverageMilli / 10).toFixed(1)}%`);
      for (const line of wrap(entry.because, 72)) say(`      ${line}`);
    }
    say('');
  }
  // TWO TABLES, IN THIS ORDER, ALWAYS BOTH.
  //
  // The divergence list comes FIRST, before either leaderboard. A reader who reaches a table showing
  // four Claude configurations at 75% without having read that every one of those shortfalls is a
  // markdown fence round a correct answer has already drawn the conclusion Pass 6 drew.
  if (report.rankings.divergences.length > 0) {
    say(`*** ${report.rankings.divergences.length} OUTCOME(S) ARE SCORED DIFFERENTLY BY THE TWO READINGS BELOW ***`);
    for (const line of wrap(DIVERGENCE_MEANS, 76)) say(`  ${line}`);
    say('');
    for (const divergence of report.rankings.divergences) {
      say(`  · ${divergence.candidate} on ${divergence.caseID}`);
      say(`      strict transport: ${divergence.strict}    semantic schema: ${divergence.semantic}`);
    }
    say('');
  }

  sayRankings('Rankings — strict JSON transport compliance', report.rankings);
  sayRankings('Rankings — semantic JSON / schema correctness', report.rankingsSemanticJSONView);
  say('  A capability role is awarded on the STRICT table only: the output real work would receive is');
  say('  the output as it arrives, fence included. The semantic table explains a shortfall; it does');
  say('  not license a promotion.');
  say('');
  // BEFORE the rankings and the metrics, not after them. A reader who reaches a leaderboard without
  // having read this has already formed the impression it exists to prevent.
  if (report.identityConfidence.admitted.length > 0) {
    say('*** IDENTITY CONFIDENCE — READ BEFORE THE NUMBERS BELOW ***');
    for (const line of wrap(report.identityConfidence.disclosure, 76)) say(`  ${line}`);
    say('');
    for (const provenance of report.identityConfidence.provenance) {
      for (const line of provenance) for (const wrapped of wrap(line, 74)) say(`    ${wrapped}`);
      say('');
    }
  }
  if (report.frontierMetrics.length > 0) {
    say('Tokens, speed and cost — with how each figure was obtained');
    say(`  ${'candidate'.padEnd(24)}  ${'reached as'.padEnd(14)}  ${'success'.padStart(8)}  ${'cost/success'.padStart(16)}  quality`);
    for (const metrics of report.frontierMetrics) say(`  ${describeCandidateMetrics(metrics)}`);
    say('');
    // THE INPUT TOTAL AND THE ALLOWANCE, SPELLED OUT.
    //
    // `describeCandidateMetrics` above is one line per candidate and has no room for the split. This
    // block exists because Pass 6's single "in" column was the FRESH REMAINDER on both providers and
    // understated Claude by ~1,650x and Codex by ~1.75x while looking like a token count — and
    // because the allowance beside it is the figure that says a subscription is not free.
    say('  input tokens, decomposed — the total is what a cost rests on');
    for (const metrics of report.frontierMetrics) {
      const q = (quantity: { provenance: string; value?: number }): string =>
        (quantity.provenance === 'unavailable' ? 'not known' : String(quantity.value ?? 0).padStart(9));
      say(`    ${metrics.candidate.padEnd(24)} all ${q(metrics.inputTokens)}  = fresh ${q(metrics.freshInputTokens)}`
        + `  + cache write ${q(metrics.cacheCreationInputTokens)}  + cache read ${q(metrics.cacheReadInputTokens)}`);
      if (metrics.billingBasis === 'subscriptionIncluded') {
        const allowance = metrics.subscriptionIncludedUsageMicroUSD;
        say(`    ${' '.padEnd(24)} plan allowance consumed, at list value: ${renderMoney(allowance)}`
          + (allowance.provenance === 'unavailable' ? '' : '  (NOT a charge — no card was billed)'));
        if (allowance.provenance === 'unavailable' && allowance.note) {
          for (const line of wrap(allowance.note, 68)) say(`    ${' '.padEnd(24)} ! ${line}`);
        }
      }
    }
    say('');
    say('  measurement quality: measured (we watched it) · providerReported (they told us) ·');
    say('  estimated (derived by a stated method) · unavailable (not known, and not guessed at).');
    if (report.frontierMetrics.some((metrics) => metrics.identityDisclosureRequired)) {
      say('');
      for (const line of wrap(IDENTITY_UNVERIFIABLE_CAVEAT, 76)) say(`  ${line}`);
    }
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

/**
 * `cernum help`, and `cernum help <command>`.
 *
 * THE TOPIC USED TO BE READ AND THROWN AWAY. `cernum help smoke` parsed `smoke` into the positional
 * list and then called a function that took no arguments, so it printed the general index — a
 * two-line entry mentioning only `--evidence` — for the one command in this program that spends
 * money. --models, --dry-run and --all-ladder were all implemented and none of them appeared. A
 * person looking for the safe way to preview a spending command was shown the least informative page
 * the program has, which is how somebody ends up typing the command to find out what it does.
 *
 * It routes to `printCommandHelp` now: the SAME renderer `<command> --help` uses, reading the SAME
 * table, so the three spellings cannot describe a command differently.
 */
function commandHelp(topic: string[] = []): void {
  if (topic.length > 1) {
    fail(`one topic at a time, but ${topic.length} were named: ${topic.join(', ')}.\n`
      + `Try '${TERMINAL_COMMAND} help ${topic[0]}'.`, 2);
  }
  if (topic.length === 1) {
    const name = topic[0];
    // `help help` is the one topic that prints the general index rather than a page about itself,
    // because that is what a person typing it means.
    if (name === 'help') return commandGeneralHelp();
    const spec = commandSpec(name);
    if (!spec) {
      fail(`no command named '${name}', so there is no help for it.\n`
        + `Commands: ${COMMAND_SPECS.map((entry) => entry.name).join(', ')}\n`
        + 'Nothing was run.', 2);
    }
    return printCommandHelp(spec);
  }
  return commandGeneralHelp();
}

function commandGeneralHelp(): void {
  say(`${PRODUCT.name} benchmark engine · ${TERMINAL_COMMAND} ${PRODUCT.version}`);
  say('');
  say('  providers                       every provider\'s status, WITHOUT contacting any of them');
  say('  discover [<provider>]           ask a provider what it is and what this account may call');
  say(`                                  ${DISCOVERABLE_PROVIDERS.join(', ')}; default ${DEFAULT_DISCOVERY.join(' and ')}`);
  say('  smoke <provider> --models a,b   prove a model by asking it once who it is — SENDS REAL REQUESTS');
  say('                                  --dry-run first: it prints every request and sends none.');
  say('                                  A metered provider is refused without --authorize-metered.');
  say(`                                  Full options: ${TERMINAL_COMMAND} help smoke`);
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
  say('  adjudicate <results.jsonl...> --out <dir> --key-out <dir>');
  say('                                  build the blinded human-review packet, the blank answer sheet');
  say('                                  and the sealed identity map. --key-out must NOT be inside --out.');
  say('  prepare <name> --frontier p:m:e --exclude-suites a,b --out <dir>');
  say('                                  write a campaign down without freezing, binding or sending it');
  say('  record-rulings <packet.json> --rulings <f.json> --out <dir>');
  say('                                  validate one batch of human verdicts and record them, blinded');
  say('  reinterpret <results.jsonl...> --out <file>');
  say('                                  the corrected reading of a sealed campaign, written beside it');
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
  say(`  help <command>                  everything one command accepts — same page as \`<command> --help\``);
  say('  where                           where campaigns live, and whether this command is installed');
  say('  install-command                 install this command for your account (one file, no PATH change)');
  say('  uninstall-command               remove exactly the file install-command wrote');
  say('');
  say('  --root <dir>        campaign directory (default: the application\'s own)');
  say('  --endpoint <url>    Ollama endpoint (default: ' + DEFAULT_ENDPOINT + ')');
  say('  --suites a,b        suite ids (default: every ranked suite)');
  say('  --repeats n         passes per case (default: 1)');
  say('  --max-attempts n    stop after n attempts — how a small smoke run is kept small');
  say('  --otlp-observer <dir>');
  say('                      run a loopback OTLP collector for this campaign and read the Codex');
  say('                      CLI\'s own telemetry: the reasoning effort it says it APPLIED, which');
  say('                      `codex exec --json` never echoes, and its token decomposition, checked');
  say('                      against stdout rather than trusted over it. Codex candidates only.');
  say('                      The collector binds 127.0.0.1 on an ephemeral port and makes no');
  say('                      outbound connection; each invocation is pointed at it by a');
  say('                      per-invocation override, so ~/.codex/config.toml is never touched.');
  say('                      NOTHING in that telemetry establishes model identity — it names the');
  say('                      model this client REQUESTED — so every Codex row stays');
  say('                      requestAcceptedIdentityUnverifiable. Every record `codex` exports');
  say('                      carries the operator\'s email address and account id; both are');
  say('                      redacted at ingest, and the file is audited on shutdown.');
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
  say('                                 opencodeCLI (your own OpenCode CLI, billed per token by a');
  say('                                 metered service — UNTESTED: no scored Cernum campaign has');
  say('                                 been run through it)');
  say('                      A model that provider discovery has not PROVEN this account can call is');
  say('                      refused here. A model name is a plan, not a capability.');
  say('  --admit-identity-unverifiable <file>');
  say('                      run named configurations whose identity CANNOT be proven, under a written,');
  say('                      sealed, per-campaign authorization. Applies to codexCLI and opencodeCLI');
  say('                      only: `codex exec` names no model in any reply, and `opencode run --format');
  say('                      json` emits no assistant message. On OpenCode a substituted model would be');
  say('                      INDISTINGUISHABLE, so that path cannot detect substitution at all — weaker');
  say('                      than Codex, and admitted knowing it. Every attempt, report, chart, export');
  say('                      and screen stamps the state; the returned-model field stays empty; the');
  say('                      candidate earns no capability role and no retention recommendation, and is');
  say('                      never a routing or promotion target. Requires --yes-identity-unverifiable.');
  say('                      Without this, an unproven candidate is refused, which is the default.');
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

// MARK: - Pass 9 · blinded adjudication and the offline reinterpretation

/**
 * Build the human-review packet from one or more campaigns' sealed evidence.
 *
 * THE KEY DIRECTORY IS A SEPARATE ARGUMENT AND HAS NO DEFAULT UNDER THE PACKET. `--key-out` must
 * name a directory that is not inside `--out`, and the command refuses otherwise: a blinding whose
 * key ships in the same folder as the packet is a label, not a property.
 */
async function commandAdjudicate(positional: string[], options: Options): Promise<void> {
  const ledgers = positional.length > 0 ? positional : [];
  if (ledgers.length === 0) fail('name at least one results.jsonl to adjudicate');
  const out = typeof options.out === 'string' ? options.out : undefined;
  const keyOut = typeof options['key-out'] === 'string' ? options['key-out'] : undefined;
  if (!out) fail('--out <dir> is required: where the reviewer packet is written');
  if (!keyOut) fail('--key-out <dir> is required: where the sealed identity map is written, and it must not be inside --out');
  const outResolved = path.resolve(out!);
  const keyResolved = path.resolve(keyOut!);
  if (keyResolved === outResolved || keyResolved.startsWith(outResolved + path.sep)) {
    fail(`--key-out (${keyResolved}) is inside --out (${outResolved}). The map that reverses the blinding never ships beside the packet it reverses.`);
  }

  const rows = ledgers.flatMap((file) => readResultsJSONL(file));
  const { governance, rubric } = referredRows(rows);
  const material = caseMaterialFor([...governance.map((r) => r.caseID), ...rubric.map((r) => r.caseID)]);
  const candidates = [...new Set([...governance, ...rubric].map((row) => ({ name: row.candidate })).map((c) => c.name))]
    .sort().map((name) => ({ name }));

  // Generated per build and never stored beside the packet. Losing it means a new packet must be
  // built, which is the correct failure: an unblindable packet is safe.
  const secret = typeof options.secret === 'string' ? options.secret : randomBytes(32).toString('hex');
  const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const batchSize = options.batch === undefined ? 20 : Number(options.batch);
  const { packet, identityMap, answerSheet } = buildAdjudicationPacket({
    governanceRows: governance, rubricRows: rubric, material, candidates, secret, builtAt, batchSize,
  });

  const batches = renderAdjudicationBatches(packet);
  const audit = auditAdjudicationPacket(packet, candidates, batches.map((batch) => batch.markdown));

  writeArtefact(path.join(outResolved, 'CERNUM-PASS-09-REVIEW-PACKET.json'), packet);
  writeArtefact(path.join(outResolved, 'CERNUM-PASS-09-ANSWER-SHEET-BLANK.json'), answerSheet);
  for (const batch of batches) writeText(path.join(outResolved, batch.fileName), batch.markdown);
  writeArtefact(path.join(keyResolved, 'CERNUM-PASS-09-IDENTITY-MAP.SEALED.json'), identityMap);
  writeArtefact(path.join(keyResolved, 'CERNUM-PASS-09-LEAKAGE-AUDIT.json'), audit);

  say(`${packet.rawRowCount} raw rows (${packet.governanceRowCount} governance, ${packet.rubricRowCount} rubric)`);
  say(`${packet.decisionCount} human decisions after exact grouping (${packet.governanceDecisionCount} governance, ${packet.rubricDecisionCount} rubric)`);
  say(`${batches.length} batch file(s), at most ${packet.batchSize} decisions each`);
  say(`packet: ${outResolved}`);
  say(`sealed: ${keyResolved}   (keep this apart from the packet until every verdict is recorded)`);
  say(`leakage audit: ${audit.clean ? 'CLEAN' : `LEAKED — ${audit.termLeaks.length} term(s), ${audit.fieldLeaks.length} field(s)`}`
    + ` · ${audit.termsChecked} terms, ${audit.decisionsChecked} decisions, ${audit.charactersScanned} characters scanned`);
  if (!audit.clean) fail('the packet is not blinded; it has not been handed over and must be rebuilt');
}

/**
 * The rankings and retention notes a sealed campaign yields when its own rows are read correctly.
 *
 * NOTHING IS RE-RUN AND NOTHING IS WRITTEN BACK. The campaign's own `rankings.json` stays exactly as
 * it was published; this is a second, dated table written into the `--out` artefact beside it, so a
 * reader can hold the published result and the corrected one at the same time and see which rows
 * moved. Producing it through `rankCandidates` rather than by hand is the point: a re-derivation
 * computed by different code from the code that produces results is a third opinion, not a check.
 */
function rederiveRankings(rows: { slotKey: string; status: string; [key: string]: unknown }[], producedAt: string) {
  const catalogue = buildCatalogueForRecount(allRankableSuiteIDs(), 1);
  // `dimensions`, not `cases.get(...).category`. The category is what KIND of case it is; the
  // dimension is the capability the ranking groups by, and it is the map `Campaign.finalize` uses.
  // Reading the wrong one leaves the overall rate correct — the same rows are scored either way —
  // and silently re-labels every per-dimension row, which is exactly the sort of quiet disagreement
  // between two readings of one campaign that this pass exists to stop.
  const outcomes = outcomesFromLedger(rows as unknown as SlotResult[],
    (caseID) => catalogue.dimensions.get(caseID));
  // No reconciliation is supplied and the table says so on its face: this is a re-reading of an
  // evidence file, not a finalization of a live campaign, and it must not pass itself off as one.
  const rankings = rankCandidates({ outcomes, derivedAt: producedAt });
  return { rankings, retention: recommendRetention(rankings) };
}

/** The corrected reading of a sealed campaign, written beside it and never over it. */
async function commandReinterpret(positional: string[], options: Options): Promise<void> {
  if (positional.length === 0) fail('name at least one results.jsonl to reinterpret');
  const out = typeof options.out === 'string' ? options.out : undefined;
  if (!out) fail('--out <file> is required: where the corrected interpretation is written');
  const producedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const all = positional.map((file) => ({ file, rows: readResultsJSONL(file) }));
  // The dimension lookup comes from the sealed catalogue, so the recount below counts the same
  // rows into the same dimensions the campaign did.
  const catalogue = buildCatalogueForRecount(allRankableSuiteIDs(), 1);
  const dimensionForCase = (caseID: string): string | undefined => catalogue.cases.get(caseID)?.category;
  const reports = all.map((entry) => ({
    ...reinterpretDispositions(entry.rows, entry.file, producedAt),
    recount: recountWithCorrectedDispositions(entry.rows, dimensionForCase),
    // THE RE-DERIVED TABLE, not just the re-derived rates. A recount answers "what does this
    // candidate's number become"; a campaign is decided by rank, role and retention, and Pass 11's
    // defect moved all three. Derived by the shipped ranking, from the sealed rows, with the
    // corrected reading of their own recorded detail — so this is the production code path applied
    // to the evidence file, not a second opinion written for the occasion.
    rederived: rederiveRankings(entry.rows, producedAt),
  }));
  writeArtefact(path.resolve(out!), { producedAt, sources: positional, reports });
  for (const report of reports) {
    say(`${report.source}: ${report.sealedRowCount} sealed rows, ${report.reinterpreted.length} reinterpreted, `
      + `${report.wastedRequests} request(s) spent retrying a deterministic refusal`);
    for (const line of report.recount.filter((entry) => entry.deltaMilli !== null && entry.deltaMilli !== 0)) {
      say(`    ${line.candidate}: ${(line.sealedPassRateMilli ?? 0) / 10}% sealed -> `
        + `${(line.correctedPassRateMilli ?? 0) / 10}% corrected (n ${line.sealedScoredCount} -> ${line.correctedScoredCount})`);
    }
    for (const ranking of report.rederived.rankings.rankings) {
      const rate = 'measured' in ranking.overallPassRateMilli ? `${(ranking.overallPassRateMilli.measured / 10).toFixed(1)}%` : 'no rate';
      say(`    ${String(ranking.rank).padStart(2)}. ${ranking.candidate.padEnd(30)} ${rate.padStart(8)}`
        + `  coverage ${(ranking.measuredCoverageMilli / 10).toFixed(1)}%`
        + `${ranking.disqualified ? '  DISQUALIFIED' : ''}${ranking.evidenceIncomplete ? '  ** PARTIAL EVIDENCE **' : ''}`);
    }
    if (report.rederived.rankings.incompleteEvidence.length > 0) {
      for (const line of wrap(INCOMPLETE_EVIDENCE_MEANS, 74)) say(`    ${line}`);
    }
  }
  say(`written: ${path.resolve(out!)} — the sealed ledgers are unchanged`);
}

/**
 * ONE frontier spec, parsed strictly, for the commands that accept exactly one.
 *
 * THE DEFECT THIS CORRECTS. `prepare` destructured `spec.split(':')` into three names and checked
 * only that the first two were non-empty. Every part after the third was silently dropped, and
 * because `prepare` — unlike `create` — never splits on commas, a comma-separated list did not fail:
 * it was absorbed. `--frontier codexCLI:gpt-5.6-luna:max,codexCLI:gpt-5.6-terra:medium,...` prepared
 * ONE candidate whose effort was the string `max,codexCLI`, and wrote that into a document a person
 * is meant to approve. Nothing downstream validated the effort, so the invalid value survived into
 * the artefact and into its rendered table.
 *
 * WHY THIS REFUSES RATHER THAN SPLITTING. `create` takes a cohort and splits `--frontier` on commas;
 * `prepare` takes one candidate and its whole output — the name, the candidate block, the attempt
 * count — is shaped for one. Teaching it to accept a list here would be inventing a contract rather
 * than enforcing the one that exists, and it would quietly change what `prepare` means. So a list is
 * an explicit refusal that names `create` as the command that wants one.
 *
 * WHAT IS REJECTED, AND WHY EACH. A comma (a list, addressed above); anything other than two or
 * three colon-separated parts (a fourth part is text with nowhere to go, and silently dropping it is
 * the original defect); an empty or whitespace-only provider, model or effort (a blank field is not
 * a value); a provider that is not one Cernum has (a document about a provider that does not exist
 * describes nothing); and an effort outside the canonical set (the check that was missing entirely).
 *
 * Throws rather than calling `fail`, so the rule is testable in-process. The caller converts.
 */
export function parseSoleFrontierSpec(spec: string): { provider: ProviderID; requestedModelID: string; effort: EffortLevel } {
  const shape = "must read provider:model[:effort], for example 'codexCLI:gpt-6-astra:max'";
  if (spec.includes(',')) {
    throw new Error(`--frontier '${spec}' names more than one candidate. \`prepare\` writes ONE candidate down: `
      + `its name, its candidate block and its attempt count are all shaped for one, so a list has nowhere to go. `
      + `Prepare them one at a time, or use \`create --frontier a,b,c\`, which takes a cohort.`);
  }
  const parts = spec.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`--frontier '${spec}' ${shape}. It has ${parts.length} colon-separated part(s). `
      + 'Nothing here is dropped silently: extra text is refused rather than folded into the effort.');
  }
  const [provider, requestedModelID, effortText] = parts;
  for (const [field, value] of [['provider', provider], ['model', requestedModelID]] as [string, string][]) {
    if (value.trim().length === 0) throw new Error(`--frontier '${spec}' has an empty ${field}. It ${shape}.`);
    if (value.trim() !== value) throw new Error(`--frontier '${spec}' has whitespace around the ${field}. It ${shape}.`);
  }
  if (!PROVIDER_IDS.includes(provider as ProviderID)) {
    throw new Error(`'${provider}' is not a provider Cernum has. Use one of ${PROVIDER_IDS.join(', ')}.`);
  }
  if (effortText !== undefined && (effortText.trim().length === 0 || effortText.trim() !== effortText)) {
    throw new Error(`--frontier '${spec}' has an empty or padded effort. Omit the third part, or name a level: `
      + `${EFFORT_LEVELS.join(', ')}.`);
  }
  const effort = (effortText ?? 'none') as EffortLevel;
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new Error(`'${effortText}' is not an effort level. Use ${EFFORT_LEVELS.join(', ')}.`);
  }
  return { provider: provider as ProviderID, requestedModelID, effort };
}

/** Write down a campaign without freezing it, binding it, or sending anything. */
async function commandPrepare(positional: string[], options: Options): Promise<void> {
  const [name] = positional;
  if (!name) fail(`usage: ${TERMINAL_COMMAND} prepare <name> --frontier provider:model[:effort] --exclude-suites a,b --out <dir>`);
  const spec = typeof options.frontier === 'string' ? options.frontier : undefined;
  if (!spec) fail('--frontier provider:model[:effort] is required');
  const out = typeof options.out === 'string' ? options.out : undefined;
  if (!out) fail('--out <dir> is required');
  let provider: ProviderID;
  let requestedModelID: string;
  let effort: EffortLevel;
  try {
    ({ provider, requestedModelID, effort } = parseSoleFrontierSpec(spec!));
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const suiteIDs = options.suites ? String(options.suites).split(',') : allRankableSuiteIDs();
  const excludeSuiteIDs = options['exclude-suites'] ? String(options['exclude-suites']).split(',') : [];
  const manifest = prepareManifest({
    name,
    candidate: { name: `${provider}:${requestedModelID}${effort === 'none' ? '' : '@' + effort}`, provider, requestedModelID, effort },
    suiteIDs,
    excludeSuiteIDs,
    exclusionReason: typeof options.reason === 'string' ? options.reason : FABLE_SUBSTITUTION_REASON,
    repeatsPerCase: Number(options.repeats ?? 2),
    preparedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    beforeItMayRun: [
      'A person authorises the run. This document is not an authorisation.',
      'The identity evidence for this configuration is re-proved if it has expired — one request.',
      'The manifest is frozen by `cernum create`, which binds the candidate and costs one request per configuration.',
    ],
  });
  const directory = path.resolve(out!);
  writeArtefact(path.join(directory, `CERNUM-PASS-09-PREPARED-MANIFEST-${name}.json`), manifest);
  writeText(path.join(directory, `CERNUM-PASS-09-PREPARED-MANIFEST-${name}.md`), renderPreparedManifest(manifest));
  say(`prepared ${manifest.caseCount} case(s) x ${manifest.repeatsPerCase} repeat(s) = ${manifest.caseCount * manifest.repeatsPerCase} attempt(s)`);
  say(`excluded ${manifest.excludedCaseCount} case(s); dimensions without evidence: ${manifest.dimensionsWithoutEvidence.join(', ') || 'none'}`);
  say(`written: ${directory}`);
  say('NOTHING WAS SENT. This is a document, not a frozen manifest and not an authorisation.');
}

/**
 * Take a batch of human rulings in, validate them against the packet, and record them.
 *
 * The verdicts are the most valuable evidence this programme has: a campaign can be re-measured and
 * a person's reading of 160 answers cannot. So nothing is coerced — a ruling that does not validate
 * is refused with the reason, and no file is written.
 */
async function commandRecordRulings(positional: string[], options: Options): Promise<void> {
  const [packetPath] = positional;
  if (!packetPath) fail(`usage: ${TERMINAL_COMMAND} record-rulings <packet.json> --rulings <file.json> --out <dir>`);
  const rulingsPath = typeof options.rulings === 'string' ? options.rulings : undefined;
  const out = typeof options.out === 'string' ? options.out : undefined;
  if (!rulingsPath) fail('--rulings <file.json> is required');
  if (!out) fail('--out <dir> is required');

  const packet = JSON.parse(fs.readFileSync(packetPath!, 'utf8')) as Parameters<typeof recordRulings>[0];
  const input = JSON.parse(fs.readFileSync(rulingsPath!, 'utf8')) as RulingsInput;
  const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { record, verification } = recordRulings(packet, input, recordedAt);

  const directory = path.resolve(out!);
  const batch = String(record.provenance.batchNumber).padStart(2, '0');
  writeArtefact(path.join(directory, `CERNUM-PASS-09-RULINGS-BATCH-${batch}.json`), record);

  // The answer sheet is refilled from EVERY recorded batch on disk, so it is always the union of what
  // has been adjudicated rather than only the batch just handed in.
  const sheetPath = path.join(path.dirname(packetPath!), 'CERNUM-PASS-09-ANSWER-SHEET-BLANK.json');
  if (fs.existsSync(sheetPath)) {
    const blank = JSON.parse(fs.readFileSync(sheetPath, 'utf8')) as { answers: unknown[] };
    const recorded = fs.readdirSync(directory)
      .filter((name) => /^CERNUM-PASS-09-RULINGS-BATCH-\d+\.json$/.test(name)).sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as RulingsRecord);
    writeArtefact(path.join(directory, 'CERNUM-PASS-09-ANSWER-SHEET-FILLED.json'),
      applyRulingsToAnswerSheet(blank, recorded));
    const filledBatches = recorded.map((entry) => entry.provenance.batchNumber).sort((a, b) => a - b);
    say(`answer sheet refilled from batch(es) ${filledBatches.join(', ')} — every other decision left blank`);
  }
  writeArtefact(path.join(directory, `CERNUM-PASS-09-RULINGS-BATCH-${batch}-VERIFICATION.json`), verification);

  say(`batch ${record.provenance.batchNumber}: ${verification.decisionsRuled} of ${verification.decisionsInBatch} decisions ruled`
    + ` (${verification.governanceCount} governance, ${verification.rubricCount} rubric), ${verification.rowsSettled} row(s) settled`);
  say(`  governance verdicts: ${Object.entries(verification.verdictTally).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  say(`  rubric ratings:      ${Object.entries(verification.ratingTally).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`
    + ` · ${verification.rubricItemsRated} item rating(s)`);
  if (verification.qualityObservations > 0) {
    say(`  quality observations: ${verification.qualityObservations} — recorded apart from the verdicts, changing none of them`);
  }
  say(`  batch complete: ${verification.batchComplete ? 'yes' : `no — ${verification.outstandingDecisionIDs.length} outstanding`}`);
  say(`  still blinded: ${!verification.containsCandidateName && !verification.containsSlotKey ? 'yes' : 'NO'}`
    + ` · every rationale present: ${verification.everyRationaleNonEmpty ? 'yes' : 'NO'}`);
  say(`  batches not ruled by this record: ${record.scope.unruledBatchNumbers.join(', ') || 'none'}`);
  say(`written: ${directory}`);
  if (!verification.valid) fail('the recorded rulings did not verify; treat the written files as suspect');
}

export async function main(argv: string[]): Promise<void> {
  // A terminal command has to survive its reader going away. `cernum status | head -3` closes the
  // pipe while there is still output queued, and without this Node turns that into an unhandled
  // 'error' event and a stack trace, where a person expected three lines and their prompt back.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(0); });
  }
  const { command, positional, options, unknown } = parse(argv);
  const invocationLine = invocation(argv);

  // ------------------------------------------------------------------ the gate
  //
  // NOTHING BELOW THIS BLOCK RUNS UNTIL THE ARGUMENTS ARE UNDERSTOOD. Help is answered here, for
  // every command, before the command body exists to have a side effect. Unknown options stop the
  // program rather than being carried into it. This ordering IS the fix: `cernum smoke --help` spent
  // real allowance because help was a thing a command had to remember to check for, and `smoke`
  // reached its live default first.
  const spec = commandSpec(command);
  const helpAsked = command === 'help' || command === '--help' || command === '-h';
  if (!helpAsked && !spec) {
    fail(`unknown command '${command}'. Try '${TERMINAL_COMMAND} help'.`);
  }
  if (spec && unknown.length > 0) {
    // REFUSED, not ignored, AND REFUSED BEFORE HELP IS PRINTED. An option this build does not
    // understand may be the one carrying the limit, the ceiling or the scope, and guessing which is
    // not something a parser may do — including guessing that a person who also typed `--help` did
    // not mean the flag it could not read. Refusing prints a message and sends nothing, so this is
    // no less safe than answering help; it is only more honest about what was typed.
    const accepted = acceptedOptions(spec).map((option) => `--${option.name}`).join(', ');
    fail(`${command}: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}\n`
      + `accepted here: ${accepted}\n`
      + `nothing was run. See '${TERMINAL_COMMAND} ${command} --help'.`, 2);
  }
  if (spec) validateOptionValues(command, spec, options);
  if (helpAsked) return commandHelp(positional);
  if (options.help === true) {
    printCommandHelp(spec!);
    return;
  }

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
    case 'prepare': return commandPrepare(positional, options);
    case 'record-rulings': return commandRecordRulings(positional, options);
    case 'adjudicate': return commandAdjudicate(positional, options);
    case 'reinterpret': return commandReinterpret(positional, options);
    case 'lock': return commandLock(positional, options);
    case 'unlock': return commandUnlock(positional, options);
    case 'endpoints': return commandEndpoints(options);
    case 'where': return commandWhere();
    case 'install-command': return commandInstallCommand();
    case 'uninstall-command': return commandUninstallCommand();
    case 'help': return commandHelp();
    // Unreachable: an unknown command was refused by the gate above, and every name in
    // COMMAND_SPECS has a case here — `cli-argument-safety.test.ts` walks the table to prove it.
    default: fail(`'${command}' is declared but not wired to an implementation. This is a bug.`, 70);
  }
}

// Only run when invoked as a command, so the module stays importable by tests.
if (process.argv[1] && /cernum(\.[jt]s)?$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}
