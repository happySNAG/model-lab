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
  {
    name: 'workspace', effect: 'spendsAllowance', positional: '<case-id>',
    summary: 'run one WORKSPACE case — hands a model a repository and measures the work. SENDS REAL REQUESTS',
    options: [...ROOT,
      { name: 'provider', takesValue: true, summary: 'which provider drives the workspace. Required; no default' },
      { name: 'model', takesValue: true, summary: 'the model identifier to ask for. Required; must already be proven' },
      { name: 'effort', takesValue: true, summary: "reasoning effort, where the provider has one. Default 'none'" },
      { name: 'max-attempts', takesValue: true, summary: "cap attempts below the case's own ceiling" },
      { name: 'timeout', takesValue: true, summary: "narrow the per-attempt deadline, in milliseconds. Never widens the case's" },
      { name: 'record', takesValue: true, summary: 'name for the durable record directory. Defaults to case + timestamp' },
      { name: 'evidence', takesValue: true, summary: 'ALSO write the full run JSON to this file' },
      { name: 'fixtures', takesValue: true, summary: "fixture root the case's fixturePath resolves inside" },
      { name: 'sandbox', takesValue: true, summary: 'where disposable workspaces are made. Must be outside every Git working tree' },
      { name: 'preserve-failed', takesValue: false, summary: 'keep a failed attempt\'s tree for diagnosis' },
      { name: 'admit-identity-unverifiable', takesValue: true, summary: 'a written, sealed identity admission (codexCLI only) for this one run' },
      { name: 'otlp-observer', takesValue: true, summary: 'codexCLI only: collect the CLI\'s own telemetry on loopback into this directory' },
      { name: 'yes', takesValue: false, summary: 'confirm the live run (required; --dry-run needs none)' }],
    supportsDryRun: true,
    detail: [
      'THIS SENDS REAL REQUESTS. A workspace case hands a model a disposable copy of a sealed fixture,',
      'an instruction, a tool policy and an allow-listed environment, then reads the TREE it left behind.',
      'The verdict comes from the filesystem diff and from verification commands this engine runs itself —',
      'never from the model\'s account of what it did.',
      '',
      'SCOPE — every part is named, and none of it is defaulted.',
      '  <case-id>           the workspace case, e.g. ws.broken-sum.mean.',
      '  --provider <id>     the provider whose WORKSPACE DRIVER runs it. A provider Cernum can send a',
      '                      prompt to is not necessarily one it can hand a repository: if no workspace',
      '                      driver exists for it, this refuses with "workspace driver unavailable"',
      '                      rather than falling through to prose execution. An answer produced by',
      '                      asking a model to describe a fix is not an answer to this question.',
      '  --model <id>        must already be PROVEN for this exact provider:model route. The proof is',
      '                      read from the discovery store an identity smoke test writes; there is no',
      '                      second cache and nothing here invents an identifier.',
      '  --admit-identity-unverifiable <file>',
      '                      codexCLI ONLY. `codex exec` never names the model that answered, so no',
      '                      Codex route can be proven. A person\'s written admission — the same file',
      '                      `create` takes — seals the run to THIS record as',
      '                      requestAcceptedIdentityUnverifiable: never verified, never routable,',
      '                      never promotable, and the returned model stays empty.',
      '  --otlp-observer <dir>',
      '                      codexCLI ONLY. Point the CLI\'s telemetry at a loopback collector and',
      '                      record the effort, authentication mode and TTFT it reports about itself.',
      '',
      'PREVIEW — always available, always free.',
      '  --dry-run           print the case identity, the fixture digest, the resolved pre-run identity,',
      '                      the driver and its executable, the exact argument vector, the tool names,',
      '                      the environment allow-list, every control that is NOT enforceable, the',
      '                      verification commands, the attempt ceiling, the billing basis and where the',
      '                      record would be written. Sends nothing, freezes nothing, writes nothing.',
      '',
      'WHAT IS SEALED. A run writes a durable record: a frozen manifest binding the case digest, the',
      'comparability key, the instruction as sent, the evaluators and the provider binding; one ledger',
      'row carrying the scorecard, the patch digest, the baseline and final tree digests, the',
      'verification results, tokens, cost, allowance and waste; the case verbatim; and the per-attempt',
      'patch and transcript. A later reader can say which task, fixture, tool policy, model route and',
      'evaluator produced a score without reconstructing any of it from console output.',
      '',
      'IDENTITY IS TWO FACTS, NOT ONE. What was known about the route BEFORE the request is recorded as',
      'the binding identity state and is never rewritten afterwards. What the request itself established',
      'is recorded beside it as the execution identity verdict. A row showing `verified` beside a model',
      'the tool named is two independent statements, and the record says which is which.',
      '',
      'SPENDING. Every workspace driver that exists today is a SUBSCRIPTION CLI: the marginal API charge',
      'is a true zero, no card is billed, and the plan allowance consumed is read from the provider\'s own',
      'reply where it reports one (claude does; codex reports none, and that is recorded as unreported,',
      'never as zero). The Codex driver makes the CLI itself refuse any login but the ChatGPT session.',
      'There is deliberately NO --authorize-metered here, and',
      'that is not an omission. A metered workspace binding is refused by the binding validator itself:',
      'a workspace request carries no token ceiling, so the worst case for one attempt cannot be',
      'computed, and a spending ceiling enforced against an uncomputable bound is not a ceiling. When a',
      'metered workspace contract can express a bound, the authorization flag will come with it.',
      '',
      'THE ATTEMPT CEILING IS AN OPERATOR SETTING. --max-attempts narrows what the frozen case allows and',
      'never widens it, and the row says the operator capped it rather than the case. The case digest',
      'does not move, so a capped run stays comparable with an uncapped one on everything else.',
    ],
  },
  {
    name: 'workspace-benchmark', effect: 'spendsAllowance', positional: '<pack-id>',
    summary: 'run a sealed workspace PACK across several models, with repeats — SENDS REAL REQUESTS',
    options: [...ROOT,
      { name: 'provider', takesValue: true, summary: 'which provider drives every run. Required; no default' },
      { name: 'models', takesValue: true, summary: 'comma-separated model ids, one row of the comparison each. Required' },
      { name: 'effort', takesValue: true, summary: "reasoning effort, where the provider has one. Default 'none'" },
      { name: 'repeats', takesValue: true, summary: "independent runs per case. Defaults to the sealed pack's own number" },
      { name: 'max-attempts', takesValue: true, summary: "cap attempts below each case's own ceiling" },
      { name: 'timeout', takesValue: true, summary: "narrow the per-attempt deadline, in milliseconds. Never widens a case's" },
      { name: 'label', takesValue: true, summary: 'the stem every record directory in this matrix is named from' },
      { name: 'aggregate', takesValue: true, summary: 'ALSO write the cross-record aggregate to this file' },
      { name: 'fixtures', takesValue: true, summary: "fixture root the cases' fixturePaths resolve inside" },
      { name: 'sandbox', takesValue: true, summary: 'where disposable workspaces are made. Must be outside every Git working tree' },
      { name: 'preserve-failed', takesValue: false, summary: "keep a failed attempt's tree for diagnosis" },
      { name: 'admit-identity-unverifiable', takesValue: true, summary: 'codexCLI only: a written MATRIX admission, sealed per route to this matrix and pack' },
      { name: 'otlp-observer', takesValue: true, summary: 'codexCLI only: where the REQUIRED loopback effort collector writes. Default: beside the records' },
      { name: 'cells', takesValue: true, summary: 'run ONLY these cells: <case-id>@<repeat>,… — the ORIGINAL repeat number, for every model named' },
      { name: 'cells-file', takesValue: true, summary: 'the same, as JSON { "cells": [ { "caseID", "repeatIndex", "modelID"? } ] }' },
      { name: 'continue-from', takesValue: true, summary: 'the LABEL of a stopped matrix to continue: runs only its cells that produced no evidence' },
      { name: 'source-root', takesValue: true, summary: 'the campaign root that matrix is in. Required with --continue-from; read, never written' },
      { name: 'source-aggregate', takesValue: true, summary: "that matrix's aggregate file. Default: <source-root>/aggregates/<label>.json when present" },
      { name: 'include-throttled-attempts', takesValue: false, summary: 'also continue cells the source SENT and the provider declined (held back by default)' },
      { name: 'prior-continuation-root', takesValue: true, summary: 'comma-separated roots of earlier continuations of the same source; their completed cells are excluded' },
      { name: 'yes', takesValue: false, summary: 'confirm the live matrix (required; --dry-run needs none)' }],
    supportsDryRun: true,
    detail: [
      'THIS SENDS REAL REQUESTS — many of them. A benchmark pack is a sealed set of workspace cases and',
      'a sample count; a matrix runs every case, for every model named, the sampled number of times, and',
      'seals one durable record per run. Four models x four cases x three repeats is forty-eight',
      'independent runs, each with its own workspace, manifest, ledger, transcript and patch.',
      '',
      'A REPEAT IS NOT A RETRY, and the two are counted in different columns.',
      '  --repeats n         independent RUNS of the whole case from the sealed baseline, each with its',
      '                      own fresh workspace and its own record. Repeats measure VARIANCE, they are',
      '                      the pack\'s, and they are what --repeats sets.',
      '  --max-attempts n    caps the RETRIES inside one run — the second attempt a case allows after',
      '                      this engine\'s own verification reported a failure. Retries measure',
      '                      RECOVERY, they are the case\'s, and this narrows what a case allows and',
      '                      never widens it.',
      'Three repeats of a case that allows two attempts is three results and at most six attempts.',
      '',
      'PREVIEW — always available, always free.',
      '  --dry-run           print the pack digest, every case id/version/digest, the binding and',
      '                      identity state of every model, the driver and its exact argument vector,',
      '                      the environment shortfalls, the attempt ceiling, the billing basis, where',
      '                      every record would be written, and what Cernum can and cannot say about',
      '                      cost before running. Sends nothing, freezes nothing, writes nothing.',
      '',
      'WHAT CAN BE SAID ABOUT COST BEFOREHAND. The marginal API charge is a TRUE zero for every',
      'workspace driver that exists, because every one of them is a subscription CLI. The plan',
      'ALLOWANCE is the number actually spent, and it cannot be computed from a frozen case: a workspace',
      'request carries no token ceiling, so there is no bound to derive one from. What Cernum will do is',
      'read what the SAME model spent on the SAME sealed experiment before, from records on this',
      'machine, and report that as an estimate naming its method. A cell with no prior run estimates',
      'nothing and says so; it does not estimate zero.',
      '',
      'REFUSALS ARE PART OF THE PLAN. A model this account has never been shown able to call, a provider',
      'with no workspace driver, a driver that cannot do what a case requires — every one is decided',
      'while the matrix is planned, printed by the dry run, and skipped with its reason recorded. A',
      'matrix with three runnable models and one unproven one runs three and says so.',

      '',
      'IDENTITY-UNVERIFIABLE ROUTES (codexCLI). `codex exec` never names the model that answered, so no',
      'Codex route can be proven, and every one is REFUSED unless the operator passes',
      '  --admit-identity-unverifiable <file>',
      'a written MATRIX admission. It is read and sealed by THIS invocation to THIS matrix\'s --label and',
      'pack; there is no environment variable or configuration default for it, and nothing carries one',
      'forward from an earlier matrix. The file is JSON:',
      '  { "admissionScope": "workspaceMatrix",',
      '    "authorizedBy": "<who, in their own words>", "reason": "<why>", "intent": "<what for>",',
      '    "pack": { "id": "<pack id>", "version": "<v>", "digest": "<cwp1: digest the dry run prints>" },',
      '    "admitted": [ { "provider": "codexCLI", "requestedModelID": "<model>",',
      '      "requestedEffort": "<effort>", "driverID": "driver.codex-cli.workspace",',
      '      "cliVersion": "0.155.0", "executionClass": "subscriptionCLI",',
      '      "billingBasis": "subscriptionIncluded", "authenticationBasis": "<how signed in>",',
      '      "evidenceDigest": "<identity-smoke evidence>", "evidenceCapturedAt": "<when>" } ] }',
      'Each entry admits ONE exact route: that provider, model and effort, on that driver and CLI',
      'version, billed that way, in that pack. Another effort, another model, another pack, another',
      'driver or the metered API is not admitted, and an entry this matrix would not use is refused.',
      'An admitted route also needs an unexpired identity smoke on this machine showing the provider',
      'accepted the request. Every record it produces is stamped requestAcceptedIdentityUnverifiable,',
      'carries the matrix admission digest and its own per-record seal, and is NEVER written verified.',
      'A reported "model rerouted: A -> B" fails that run and is listed; it proves nothing about B or A',
      'for any later run. A single-record admission file (no admissionScope) is refused here.',
      '',
      'APPLIED EFFORT (codexCLI). The effort frozen into every argv is what was REQUESTED; what the tool',
      'APPLIED is measured on every run from its own OTLP telemetry, collected on 127.0.0.1 by a loopback',
      'collector this command starts itself (no outbound connection, no change to auth or billing), and',
      'joined to each run ONLY by the conversation id that run printed. A dry run shows the requirement',
      'and never an applied effort. A run whose telemetry is missing, ambiguous or shows another effort',
      'keeps its evidence and its score, and its route is NOT qualified at the requested effort. A',
      'collector that cannot start refuses the matrix before anything is sent; one that fails mid-way',
      'stops the Codex runs after it. Neither is ever recorded as a provider or model failure.',
      '  --otlp-observer <dir>  where the redacted telemetry is written (default <root>/workspace/<label>.otlp)',
      '',
      'RUNNING ONLY SOME CELLS. A cell is one coordinate of the matrix design: model, case, and repeat r of n.',
      '  --cells <list>       <case-id>@<repeat>, comma-separated, for every model in --models. The repeat',
      '                       is the ORIGINAL one: ws.a@3 runs, and records, repeat 3 of the planned count.',
      '  --cells-file <file>  the same as JSON, with an optional per-cell modelID — unambiguous whatever',
      '                       punctuation a case id holds.',
      'A selected matrix is the SAME plan with fewer cells: same bindings, same record names, same seals. The',
      'dry run lists every selected cell, and every count — runs, attempt ceiling, allowance — is of the',
      'selected cells only. A selected cell whose record already exists under --label is refused.',
      '',
      'CONTINUING A STOPPED MATRIX. When a provider stops a matrix, its deferred cells are not failures and',
      'must still run. Re-running the same label cannot do it (the sealed records refuse), and re-running the',
      'whole matrix would duplicate every completed cell. Instead:',
      '  --continue-from <label> --source-root <dir>   (plus --provider, --models, --effort as before)',
      'reads that matrix READ-ONLY — its records and its aggregate, fingerprinted as cmr1: — classifies every',
      'cell it planned, and selects exactly the cells that produced no evidence: deferred by the throttle',
      'breaker, never executed, or faulted before sealing. A cell the source COMPLETED (pass, fail or',
      'unscored) is never selected, and naming one with --cells is refused; there is no override. A cell the',
      'source SENT and the provider declined is held back unless --include-throttled-attempts (or --cells)',
      'names it; its sealed record stays where it is, as history. The continuation runs under a NEW --label',
      'in a DIFFERENT --root, refuses a different pack digest, route, deadline, attempt cap or driver, and',
      'stamps every record with its cell (cmc1:), its selection (cms1:), the reason it was selected and the',
      'source it continues. The source is never written: a torn source ledger is refused, not repaired.',
      '',
      'AN ADMISSION FOR SELECTED CELLS names them. Add to the matrix admission file:',
      '  "selection": { "digest": "<the cms1: digest the dry run prints>" }',
      'It then admits those cells and nothing else — no other case, repeat, route, effort or pack, and not',
      'the whole matrix — and every record\'s own admission is bound to its one cell. A whole-matrix admission',
      'does not admit a selection.',
      '',
      'Combine a source and its continuation for reporting with `cernum workspace-report`.',
    ],
  },
  {
    name: 'workspace-report', effect: 'writesLocal', positional: '<pack-id>',
    summary: 'the LOGICAL matrix of a source and its continuation: one row per planned cell, read-only',
    options: [...ROOT,
      { name: 'source-root', takesValue: true, summary: 'the source campaign root. Required' },
      { name: 'source-label', takesValue: true, summary: 'the source matrix label. Required' },
      { name: 'source-aggregate', takesValue: true, summary: "the source's aggregate. Default: <source-root>/aggregates/<label>.json when present" },
      { name: 'continuation-root', takesValue: true, summary: 'comma-separated campaign roots holding continuations of that source' },
      { name: 'continuation-label', takesValue: true, summary: 'comma-separated continuation labels to include. Default: every continuation of the source in those roots' },
      { name: 'out', takesValue: true, summary: 'ALSO write the logical report as JSON to this file' }],
    detail: [
      'Reads a source matrix and the continuations that finished it, and reports the matrix the experiment',
      'PLANNED: exactly one row per cell. A cell\'s counted evidence is the source\'s own sealed run wherever',
      'the provider did not decline it, otherwise the first continuation run of that cell the provider did not',
      'decline. A declined attempt in either campaign is shown beside its cell as history and never counted;',
      'a later run of a cell that already has evidence is listed as EXCLUDED and never counted.',
      '',
      'Nothing is merged on disk. Neither root is written; the only file this can write is --out.',
    ],
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
