// Cernum · what every terminal command is, what it accepts, and what it COSTS to run.
//
// THE INCIDENT THIS MODULE EXISTS FOR. On a MacBook Pro, `cernum smoke --help` did not print help.
// It sent six live requests to Claude and spent roughly $0.127 of subscription allowance at list
// value, because three ordinary-looking decisions in one argument parser combined:
//
//   1. `--help` was recognised only in the COMMAND position. As a flag on a subcommand it was parsed
//      as an ordinary option and then ignored by every command that did not look for it.
//   2. `smoke` defaulted to a live provider when no provider was named: `positional.length > 0 ?
//      positional : ['claudeCLI']`. `--help` produces no positionals, so asking for help selected
//      the default and ran the whole Claude ladder.
//   3. Unknown options were accepted silently. Nothing could refuse an argument it did not
//      understand, so a typo became a no-op rather than a stop.
//
// Any one of the three would have been harmless. A person asking a question was charged for it.
//
// THE STRUCTURAL ANSWER, which is why this is a table and not a patch. Help, option validation and
// the effect class are properties of a COMMAND, declared in one place, enforced before dispatch.
// A command added later is either in this table or it does not run — it cannot inherit a permissive
// parser by being forgotten, and it cannot spend money on its way to printing help.

/**
 * What running a command actually does. Ordered by consequence, and checked against the truth for
 * every command in the table below rather than guessed.
 */
export type EffectClass =
  /** Reads local state. Contacts nothing, writes nothing, spends nothing. */
  | 'readOnly'
  /** Writes files on this machine. Costs nothing and reaches no provider. */
  | 'writesLocal'
  /** Runs another CLI's read-only subcommands. No model is invoked and no allowance is consumed. */
  | 'invokesLocalTool'
  /** SENDS REQUESTS TO A MODEL. Consumes subscription allowance or is billed per token. */
  | 'spendsAllowance';

export interface OptionSpec {
  name: string;
  /** True when the option takes a value; false for a bare flag. */
  takesValue: boolean;
  summary: string;
}

export interface CommandSpec {
  name: string;
  effect: EffectClass;
  summary: string;
  /** How the positional arguments read, for the usage line. Empty when it takes none. */
  positional: string;
  options: OptionSpec[];
  /** True when `--dry-run` is accepted and shows what would happen without doing it. */
  supportsDryRun?: boolean;
  /** Extra lines printed by `<command> --help`. */
  detail?: string[];
}

/** Kept as an empty marker: `--root` is universal now, declared in UNIVERSAL_OPTIONS. */
const ROOT: OptionSpec[] = [];

/**
 * Every command, with the options it actually reads.
 *
 * This list was not written from the help text. It was derived by reading each command body AND the
 * helpers it calls — `executionFromOptions`, `readPricingFile` and `readIdentityAdmission` all read
 * options on `create`'s behalf and would have been missed by a glance at the function.
 */
export const COMMAND_SPECS: CommandSpec[] = [
  {
    name: 'providers', effect: 'readOnly', positional: '',
    summary: "every provider's status, WITHOUT contacting any of them",
    options: [...ROOT],
  },
  {
    name: 'discover', effect: 'invokesLocalTool', positional: '[<provider>…]',
    summary: 'ask a provider what it is and what this account may call',
    options: [...ROOT],
    supportsDryRun: true,
    detail: [
      'Runs the named tool\'s own version, credential and model-listing subcommands. No model is',
      'invoked and no allowance is consumed. A listing is not a proof: an OpenCode model comes back',
      'discovered and unproven however complete the listing is.',
    ],
  },
  {
    name: 'smoke', effect: 'spendsAllowance', positional: '<provider>',
    summary: 'prove a model by asking it once who it is — SENDS REAL REQUESTS',
    options: [
      ...ROOT,
      { name: 'models', takesValue: true, summary: 'comma-separated model ids to ask. Required unless --all-ladder' },
      { name: 'all-ladder', takesValue: false, summary: "ask every candidate on this provider's intended ladder" },
      { name: 'max-attempts', takesValue: true, summary: 'stop after this many requests' },
      { name: 'evidence', takesValue: true, summary: 'write the full per-request evidence to this file' },
      { name: 'pricing', takesValue: true, summary: 'published prices for a metered provider, with source and date' },
      { name: 'authorize-metered', takesValue: true, summary: 'authorize a metered run up to this ceiling, in dollars' },
      { name: 'authorize-unpriced-metered', takesValue: false,
        summary: 'acknowledge an UNKNOWN metered charge, for exactly one request' },
      { name: 'otlp-observer', takesValue: true, summary: "loopback OTLP collector directory — Codex only" },
      { name: 'yes', takesValue: false, summary: 'skip the confirmation prompt (non-interactive use)' },
    ],
    supportsDryRun: true,
    detail: [
      'THIS SENDS REAL REQUESTS. One request per model and effort level, carrying a nine-word prompt.',
      'It is the only way a subscription or metered model becomes selectable: neither `claude` nor',
      '`codex` can answer "which models may this account call", and an OpenCode listing is a cached',
      'catalogue rather than an entitlement check.',
      '',
      'SCOPE — both halves are required, and neither has a default.',
      '  <provider>          one of the providers Cernum can execute. Named, never defaulted.',
      '  --models <id,…>     exactly the models to ask, from this provider\'s intended ladder.',
      '  --all-ladder        or, deliberately, every candidate on that ladder.',
      '  --max-attempts n    cap the requests actually sent, after the scope is resolved.',
      'Until v0.2.3 this command defaulted to claudeCLI and the whole Claude ladder when given no',
      'positional argument, so `cernum smoke --help` sent six live requests and spent about $0.127.',
      '',
      'PREVIEW — always available, always free.',
      '  --dry-run           print exactly which requests would be sent, the binding each would be',
      '                      sent under, and what each would cost. Sends none. Use it first.',
      '  The dry-run and the live run are rendered from the SAME binding object, so a preview cannot',
      '  describe a request other than the one that happens.',
      '',
      'METERED AUTHORIZATION — required before any metered provider is asked anything.',
      '  opencodeCLI, anthropicAPI and openaiAPI are billed PER TOKEN against your own credential.',
      '  A metered smoke spends real money and is refused unless it was authorized by name:',
      '  --pricing <file>    published prices, with the source you took them from and when. Cernum',
      '                      never fetches prices.',
      '  --authorize-metered <dollars>',
      '                      authorize up to a ceiling. The worst case for the scope is computed from',
      '                      the frozen budgets and refused if it exceeds what you authorized.',
      '  --authorize-unpriced-metered',
      '                      when no price is known there is no bound to check. This acknowledges, in',
      '                      writing, that the provider MAY BILL YOU AN AMOUNT CERNUM CANNOT STATE,',
      '                      and it covers EXACTLY ONE request. The cost is recorded as unavailable',
      '                      on every artefact — never as zero.',
      '  Subscription providers need no spending authorization: no card is billed. They still consume',
      '  a finite plan allowance, which is recorded rather than called free.',
      '',
      'TELEMETRY',
      '  --otlp-observer <dir>',
      '                      run a loopback OTLP collector and read the Codex CLI\'s own telemetry for',
      '                      these requests: the reasoning effort it says it APPLIED, which `codex exec',
      '                      --json` never echoes, and its token decomposition. codexCLI only; given',
      '                      for any other provider it refuses rather than starting a collector nothing',
      '                      would export to. Binds 127.0.0.1 on an ephemeral port, makes no outbound',
      '                      connection, and never touches ~/.codex/config.toml. Every record `codex`',
      '                      exports carries the operator\'s email address and account id; both are',
      '                      redacted at ingest and the file is audited on shutdown.',
      '  Latency, retries, token counts and plan allowance are recorded for every provider that',
      '  reports them, and marked unavailable — with a reason — for every provider that does not.',
      '',
      'IDENTITY, AND WHAT ONE REQUEST CAN ESTABLISH',
      '  proven        the provider named the model and it matched what was asked for.',
      '  substituted   the provider named a DIFFERENT model. Recorded as refused, never accepted.',
      '  unverifiable  something answered and named no model.',
      '  refused       the account, the model or the effort level was rejected.',
      '  A codexCLI request that is accepted and answered lands on requestAcceptedIdentityUnverifiable:',
      '  `codex exec` names no model in any reply, so a Codex smoke can establish that the provider',
      '  ACCEPTED the identifier and something answered, and never which model did. That state is not',
      '  proof and makes nothing selectable; running such a candidate in a campaign takes a separate',
      '  sealed authorization — see `cernum help create` and --admit-identity-unverifiable.',
      '',
      'There is NO retry. One request, one verdict, recorded whatever it says.',
    ],
  },
  { name: 'credentials', effect: 'readOnly', positional: '', summary: 'which API keys are configured (masked; never printed)', options: [] },
  { name: 'models', effect: 'readOnly', positional: '', summary: 'list the models installed locally (read-only)',
    options: [] },
  { name: 'suites', effect: 'readOnly', positional: '', summary: 'the benchmark suites this engine can plan', options: [] },
  { name: 'cost', effect: 'readOnly', positional: '<name>', summary: 'what a campaign is estimated to cost, without running it', options: [...ROOT] },
  {
    name: 'authorize', effect: 'writesLocal', positional: '<name>',
    summary: 'authorize spending for a campaign, up to a ceiling',
    options: [...ROOT,
      { name: 'ceiling', takesValue: true, summary: 'maximum spend, in dollars' },
      { name: 'yes', takesValue: false, summary: 'confirm without prompting' }],
  },
  {
    name: 'create', effect: 'writesLocal', positional: '<name>',
    summary: 'freeze a campaign: what will run, on what, and under which policy',
    options: [...ROOT,
      { name: 'models', takesValue: true, summary: 'comma-separated local models' },
      { name: 'frontier', takesValue: true, summary: 'provider:model[:effort], comma-separated' },
      { name: 'suites', takesValue: true, summary: 'benchmark suites to plan' },
      { name: 'repeats', takesValue: true, summary: 'attempts per case' },
      { name: 'label', takesValue: true, summary: 'human-readable label' },
      { name: 'runtime-version', takesValue: true, summary: 'runtime version to record' },
      { name: 'pricing', takesValue: true, summary: 'pricing file for metered candidates' },
      { name: 'synthetic', takesValue: false, summary: 'deterministic host; no request reaches any server' },
      { name: 'observe-only', takesValue: false, summary: 'do not manage residency; results are noncanonical' },
      { name: 'thinking', takesValue: true, summary: "'on', 'off' or 'runtime-default'" },
      { name: 'admit-identity-unverifiable', takesValue: true, summary: 'sealed authorization file for unverifiable identities' },
      { name: 'yes-identity-unverifiable', takesValue: false, summary: 'confirm the sealed authorization' }],
  },
  {
    name: 'run', effect: 'spendsAllowance', positional: '<name>',
    summary: 'run a frozen campaign — SENDS REAL REQUESTS for every frontier candidate',
    options: [...ROOT,
      { name: 'max-attempts', takesValue: true, summary: 'stop after this many attempts' },
      { name: 'synthetic', takesValue: false, summary: 'deterministic host; no request reaches any server' },
      { name: 'observe-only', takesValue: false, summary: 'do not manage residency' },
      { name: 'thinking', takesValue: true, summary: "'on', 'off' or 'runtime-default'" },
      { name: 'otlp-observer', takesValue: true, summary: 'OTLP collector endpoint' }],
    supportsDryRun: true,
  },
  {
    name: 'resume', effect: 'spendsAllowance', positional: '<name>',
    summary: 'resume an interrupted campaign — SENDS REAL REQUESTS',
    options: [...ROOT,
      { name: 'max-attempts', takesValue: true, summary: 'stop after this many attempts' },
      { name: 'synthetic', takesValue: false, summary: 'deterministic host; no request reaches any server' },
      { name: 'observe-only', takesValue: false, summary: 'do not manage residency' },
      { name: 'thinking', takesValue: true, summary: "'on', 'off' or 'runtime-default'" },
      { name: 'otlp-observer', takesValue: true, summary: 'OTLP collector endpoint' }],
    supportsDryRun: true,
  },
  { name: 'status', effect: 'readOnly', positional: '<name>', summary: 'where a campaign got to', options: [...ROOT] },
  { name: 'verify', effect: 'readOnly', positional: '<name>', summary: 'check a campaign against what was frozen', options: [...ROOT] },
  { name: 'finalize', effect: 'writesLocal', positional: '<name>', summary: 'finalize into rankings and retention notes',
    options: [...ROOT, { name: 'secret', takesValue: true, summary: 'blinding secret' }] },
  { name: 'retest', effect: 'writesLocal', positional: '<name>', summary: 'derive a retest from a finished campaign',
    options: [...ROOT, { name: 'reason', takesValue: true, summary: 'why the retest exists' },
      { name: 'runtime-version', takesValue: true, summary: 'runtime version to record' }] },
  { name: 'prepare', effect: 'writesLocal', positional: '<name>', summary: 'prepare a campaign plan',
    options: [{ name: 'out', takesValue: true, summary: 'where to write' },
      { name: 'suites', takesValue: true, summary: 'suites to include' },
      { name: 'exclude-suites', takesValue: true, summary: 'suites to leave out' },
      { name: 'frontier', takesValue: true, summary: 'frontier candidates' },
      { name: 'repeats', takesValue: true, summary: 'attempts per case' },
      { name: 'reason', takesValue: true, summary: 'why this preparation exists' }] },
  { name: 'record-rulings', effect: 'writesLocal', positional: '<name>', summary: 'record human rulings',
    options: [{ name: 'out', takesValue: true, summary: 'where to write' },
      { name: 'rulings', takesValue: true, summary: 'rulings file to read' }] },
  { name: 'adjudicate', effect: 'writesLocal', positional: '<name>', summary: 'open the blinded adjudication packet',
    options: [{ name: 'out', takesValue: true, summary: 'where to write' },
      { name: 'batch', takesValue: true, summary: 'batch identifier' },
      { name: 'key-out', takesValue: true, summary: 'where to write the unblinding key' },
      { name: 'secret', takesValue: true, summary: 'blinding secret' }] },
  { name: 'reinterpret', effect: 'writesLocal', positional: '<name>', summary: 'reinterpret recorded results',
    options: [{ name: 'out', takesValue: true, summary: 'where to write' }] },
  { name: 'lock', effect: 'writesLocal', positional: '<name>', summary: 'take a campaign lock', options: [...ROOT] },
  { name: 'unlock', effect: 'writesLocal', positional: '[<name>]', summary: 'release a campaign or endpoint lock',
    // `--endpoint` is universal; on this command it names the lease to release.
    options: [...ROOT, { name: 'force', takesValue: false, summary: 'release a lease this process does not hold' }] },
  { name: 'endpoints', effect: 'readOnly', positional: '', summary: 'which endpoints are leased', options: [...ROOT] },
  { name: 'where', effect: 'readOnly', positional: '', summary: 'where this build, its data and its terminal command are', options: [] },
  { name: 'install-command', effect: 'writesLocal', positional: '', summary: 'install the `cernum` terminal command for your account', options: [] },
  { name: 'uninstall-command', effect: 'writesLocal', positional: '', summary: 'remove the terminal command this application installed', options: [] },
  {
    name: 'help', effect: 'readOnly', positional: '[<command>]',
    summary: 'this help, or the full help for one command',
    options: [],
    detail: [
      '`cernum help <command>` prints exactly what `cernum <command> --help` prints, and prints it',
      'for the command NAMED rather than for `help`. Until v0.2.4 the topic was parsed and then',
      'discarded, so `cernum help smoke` printed the general index and none of smoke\'s own options —',
      'including --models, --dry-run and --all-ladder, all of which were implemented at the time.',
      'A person looking for the safe way to preview a spending command was shown the least',
      'informative page the program has.',
      '',
      'Every help path reads local state and sends nothing, whichever way it is spelled.',
    ],
  },
];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => spec.name === name);
}

/** Commands that send model requests. Named so a caller can be careful about exactly these. */
export function spendingCommands(): string[] {
  return COMMAND_SPECS.filter((spec) => spec.effect === 'spendsAllowance').map((spec) => spec.name);
}

/** The one sentence that says what running this costs. Printed by help and before live execution. */
export function effectSentence(effect: EffectClass): string {
  switch (effect) {
    case 'readOnly': return 'Reads local state. Contacts nothing, writes nothing, spends nothing.';
    case 'writesLocal': return 'Writes files on this machine. Reaches no provider and spends nothing.';
    case 'invokesLocalTool': return "Runs another tool's read-only subcommands. No model is invoked and no allowance is consumed.";
    case 'spendsAllowance': return 'SENDS REAL REQUESTS TO A MODEL and consumes allowance or is billed per token.';
  }
}

/**
 * Options every command accepts.
 *
 * `--help` is here so no command can be built without one. `--root` and `--endpoint` are here
 * because they say WHERE THINGS ARE rather than what to do, and wrappers reasonably append them to
 * every invocation — a strict parser that rejected `cernum credentials --root …` would turn a
 * safety fix into a breaking change for every script anybody has written. They are the only two
 * with that character: everything else is declared by the command that reads it, so a typo like
 * `--modles` is still refused.
 */
export const UNIVERSAL_OPTIONS: OptionSpec[] = [
  { name: 'help', takesValue: false, summary: 'print this help and exit, doing nothing else' },
  { name: 'root', takesValue: true, summary: 'campaign directory to use instead of the default' },
  { name: 'endpoint', takesValue: true, summary: 'local runtime endpoint, where a command uses one' },
];

/** Every option name a command will accept, including the universal ones and --dry-run. */
export function acceptedOptions(spec: CommandSpec): OptionSpec[] {
  const dryRun: OptionSpec[] = spec.supportsDryRun
    ? [{ name: 'dry-run', takesValue: false, summary: 'print exactly what would be done, do none of it, and exit' }]
    : [];
  return [...spec.options, ...dryRun, ...UNIVERSAL_OPTIONS];
}
