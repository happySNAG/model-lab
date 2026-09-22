// Benchmark engine · what is actually reachable, asked honestly, and never asked by accident.
//
// TWO LEVELS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT.
//
//   OFFLINE STATUS  is a PATH lookup and an environment read. It says whether a CLI is installed and
//                   whether a key is configured. It reaches no provider, spends nothing, consumes no
//                   rate-limit slot, and is therefore safe to run on every render of a settings
//                   screen. It CANNOT say whether a subscription is authenticated or which models an
//                   account may call, and it does not pretend to: those answers are `unknown`.
//
//   DISCOVERY       invokes something. It is only ever run because a person asked for it by name —
//                   a button, a command — and it says so in its result. It is what turns `unknown`
//                   into a fact.
//
// Opening the application performs OFFLINE STATUS and nothing else. That is not a convention this
// module hopes callers follow; the two are different functions, and the offline one has no code path
// that can reach a provider.
//
// A MODEL IS NOT AVAILABLE UNTIL SOMETHING PROVED IT.
//
// There is a ladder of models this project intends to test. Naming them is useful — a person needs
// to know what the plan is. Treating a name as an availability claim is not: model lineups change,
// a subscription tier may not include what another tier does, and a CLI version may predate a model
// entirely. So every name starts `unproven`, and ONLY AN IDENTITY SMOKE TEST moves it to `proven`. A
// campaign cannot select an `unproven` candidate at all.
//
// DISCOVERY NEVER PROVES A MODEL, AND THAT INCLUDES A METERED API'S OWN LISTING. Discovery finds out
// which identifiers a provider advertises to this account. That is worth recording and it is worth
// nothing more: no request was sent to a model, nothing answered, and no provider named a model in a
// reply. v0.2.4 wrote `proven` and a `verifiedModelID` for all 130 rows of an OpenAI `/v1/models`
// response, which recorded an advertisement as if a model had answered. See `parseModelListing`.
//
// NOTHING HERE SCRAPES ANYTHING. A subscription is reached by running the official CLI the user
// installed and authenticated. There is no browser session, no cookie jar, no private endpoint, and
// no credential read out of another tool's files.

import { ExecutionClass, PROVIDER_IDS, PROVIDER_LABELS, ProviderID, billingBasisOf, executionClassOf } from './provider';
import { CredentialStatus, CredentialLookupOptions, credentialStatus, isMeteredProvider } from './credentials';
import { CLIResult, findExecutable, runCLI } from './cli-process';
import { CodexAuthStatus, codexSubscriptionUsable, parseCodexDoctorAuth } from './codex-cli';
import { redactSecrets } from './redaction';
import { anthropicBaseURL, openaiBaseURL } from './host-factory';
import {
  OPENCODE_EXECUTABLE, OPENCODE_VERSION_ARGUMENTS, OPENCODE_MODELS_ARGUMENTS, OPENCODE_CREDENTIALS_ARGUMENTS,
  UNION_ALPHA_MODEL_ID, parseOpenCodeVersion, parseOpenCodeModels, parseOpenCodeCredentials,
  opencodeHasCredential, opencodeCredentialDisclosure, OPENCODE_SUPPORT_MATURITY, OPENCODE_COST_EXPLANATION,
  OPENCODE_LISTING_IS_A_CATALOGUE, OPENCODE_PROOF_PATH,
  OPENCODE_CATALOGUE_OBSERVED_AT, OPENCODE_CATALOGUE_SOURCE, OPENCODE_FREE_LIST_PRICE_EXPLANATION,
  UNION_ALPHA_NOT_LISTED_SINCE, UNION_ALPHA_RETIREMENT_NOTE,
} from './opencode-cli';

/** How far the truth about a provider has actually been established. */
export type Reachability =
  /** Nothing has been asked. The honest answer before discovery runs. */
  | 'unknown'
  /** Installed / configured AND something confirmed it answers. */
  | 'ready'
  /** The CLI is not on PATH. */
  | 'notInstalled'
  /** The CLI is installed but reported that it is not signed in. */
  | 'notAuthenticated'
  /** A metered provider with no key configured. */
  | 'noCredential'
  /** Something was asked and it did not answer. */
  | 'unreachable';

/** Whether a model can be put in a campaign, and what established that. */
export type ModelAvailability =
  /**
   * A MODEL WAS ASKED AND THE ANSWER CAME BACK NAMING IT. The only state a campaign may select.
   *
   * Established by an identity smoke test and by nothing else. NO LISTING REACHES THIS STATE, however
   * the listing was obtained. A client-side catalogue is the obvious case — `opencode models` reads a
   * cached file describing thousands of models it has never contacted, and `codex debug models`
   * renders what the client knows about while the service refuses entries in it — but an
   * account-scoped listing does not reach it either. A metered API's `/v1/models`, answered with the
   * caller's own key, reports what that key is ADVERTISED, which a provider may still refuse at call
   * time for tier, region, retirement or moderation; and an entry in it is not a reply from a model.
   *
   * Two releases learned this the same way. v0.2.1 wrote `proven` for every OpenCode listing and so
   * turned a file on disk into permission to spend (see `opencode-cli.ts`); v0.2.4 wrote `proven` for
   * every row of an OpenAI `/v1/models` response, on the reasoning this comment used to carry.
   */
  | 'proven'
  /**
   * Nothing has confirmed this account can invoke it. Not selectable.
   *
   * Covers both a candidate merely NAMED in the intended ladder and one DISCOVERED in a provider's
   * catalogue. Discovering a model is finding out it exists, which is worth recording and is not
   * worth anything more than that.
   */
  | 'unproven'
  /** Something asked and was told no — wrong tier, retired model, identifier the provider does not know. */
  | 'refused';

export interface DiscoveredFrontierModel {
  provider: ProviderID;
  /** The identifier a request would carry. */
  modelID: string;
  displayName: string;
  availability: ModelAvailability;
  /** In words: what established this, or what is still missing. Always populated. */
  evidence: string;
  /** The identifier the provider itself returned, when it returned one. Empty otherwise. */
  verifiedModelID: string;
  /** Effort levels this project intends to exercise. Desired, not confirmed. */
  desiredEfforts: string[];
  discoveredAt: string;
  /**
   * THE EVIDENCE THIS ROW USED TO CARRY, kept verbatim when a later release established that it was
   * wrong.
   *
   * A record that was wrong is still a record. Correcting the `evidence` field in place and throwing
   * the old text away would leave a store that has always agreed with the current build, which is
   * indistinguishable from a store nobody ever had to correct. See `supersedeStaleOpenCodeEvidence`.
   */
  supersededEvidence?: string;
  /** When the correction was applied, and by which release. Absent on a row that was never corrected. */
  evidenceCorrectedAt?: string;
  evidenceCorrectedBy?: string;
}

/**
 * What is known about a subscription session, and deliberately nothing more.
 *
 * There is no email, no organisation id, no organisation name and no token here. The CLI reports all
 * four; none of them answer any question this project has, and every one of them would be a private
 * account identifier written into a file somebody later shares.
 */
export interface SubscriptionSession {
  loggedIn: boolean;
  /** How the session authenticates, e.g. `claude.ai`. Not who it authenticates as. */
  authMethod: string;
  /** e.g. `firstParty`. Which service the requests actually go to. */
  apiProvider: string;
  /** The plan tier, e.g. `max`. What the allowance is, not whose it is. */
  subscriptionType: string;
}

export interface ProviderStatus {
  provider: ProviderID;
  label: string;
  executionClass: ExecutionClass;
  billingBasis: string;
  reachability: Reachability;
  /** One sentence a person can act on. */
  detail: string;
  /**
   * Whether any provider was contacted to produce this.
   *
   * `offline` is a promise about what this call did, and it is asserted in the tests: a status read
   * that said `offline` while having made a request would be the exact failure the split exists to
   * prevent.
   */
  probe: 'offline' | 'invoked';
  executablePath?: string;
  /** Only present after discovery: reading it requires running the tool. */
  version?: string;
  credential?: CredentialStatus;
  /** Only after discovery, and only for a subscription CLI. Carries no account identifiers. */
  session?: SubscriptionSession;
  /** Empty until discovery runs. An empty list is never presented as "no models exist". */
  models: DiscoveredFrontierModel[];
  checkedAt: string;
}

/** The executable each subscription CLI is invoked as. The official names, and nothing else. */
const CLI_EXECUTABLE: Partial<Record<ProviderID, string>> = {
  claudeCLI: 'claude',
  codexCLI: 'codex',
  // OPENCODE IS A CLI THAT IS BILLED LIKE AN API. It belongs in this map because it is reached by
  // running an executable, and it is NOT `subscriptionCLI` because the credential it carries is a
  // metered API key. Both halves matter, and the two branches below read this map rather than the
  // execution class so neither half is lost. See `opencode-cli.ts`.
  opencodeCLI: OPENCODE_EXECUTABLE,
};

/**
 * What a provider's own catalogue says a model costs to call. A LIST PRICE, NEVER A MEASURED CHARGE.
 *
 * Kept deliberately separate from `costProvenance`, which answers a different question: what did
 * Cernum actually observe this request cost. A provider can publish a zero list price for a model
 * whose real charge this engine still has no way to read back, and OpenCode is exactly that case.
 * Letting a published price stand in for an observed one is how a benchmark starts reporting a
 * number nobody measured.
 */
export type CataloguedCost = 'free' | 'paid' | 'unknown';

/**
 * WHERE A LADDER ROW'S NAME CAME FROM, AND WHEN SOMETHING LAST LOOKED.
 *
 * A ladder row is a plan, and a plan written from memory or from a documentation page is how a model
 * that was never offered ends up being asked for. This records the opposite: the exact command whose
 * output was read, the day it was read, and whether that output named this identifier.
 *
 * IT IS STILL NOT AVAILABILITY. `catalogueStatus: 'listed'` means a catalogue named it, which is
 * worth recording and is worth nothing more -- see `OPENCODE_LISTING_IS_A_CATALOGUE`. Every row
 * carrying one of these is still born `unproven`, and `selectableModels` still filters it out. The
 * field that can make a model selectable is `availability`, it lives on a discovered row rather than
 * on a plan, and nothing in this structure writes to it.
 */
export interface LadderProvenance {
  /** Whether a live provider listing named this identifier when it was last read. */
  catalogueStatus: 'listed' | 'notListed';
  /** The command whose output was read. Never documentation, never recollection. */
  source: string;
  observedAt: string;
  cataloguedCost: CataloguedCost;
  /** In words: what was read, and what it does and does not establish. */
  detail: string;
}

export interface LadderEntry {
  provider: ProviderID;
  modelID: string;
  displayName: string;
  /** Effort levels this project intends to exercise. Desired, not confirmed. */
  desiredEfforts: string[];
  /** Absent on a row nothing has checked against a live listing. Never inferred, never guessed. */
  provenance?: LadderProvenance;
}

/**
 * The six zero-list-price OpenCode models this project intends to test, as ladder rows.
 *
 * Declared as its own named constant rather than inlined so that "the free pool" is a thing the
 * tests, the terminal and a reader can each refer to by name, and so that a row leaving the pool is
 * one visible deletion rather than a line lost in a hundred-line literal.
 *
 * `displayName` is OpenCode's own `name` field from the catalogue, and `modelID` is OpenCode's own
 * `provider/model` address carried through unchanged -- so what Cernum asks for and what OpenCode
 * was told are the same bytes, exactly as for Union Alpha in the ladder below.
 */
export const FREE_OPENCODE_DEVELOPMENT_POOL: LadderEntry[] = ([
  ['opencode/big-pickle', 'Big Pickle', 'reasoning, multi-step problem solving and tool use; 200k context'],
  ['opencode/mimo-v2.5-free', 'MiMo V2.5 Free', 'open-weight omni model for text and agents; 200k context'],
  ['opencode/muse-spark-1.2-contributor-free', 'Muse Spark 1.2 Free', 'coding-focused: code generation, complex debugging, codebase understanding; 1M context'],
  ['opencode/muse-spark-1.3-contributor-free', 'Muse Spark 1.3 Free', 'multimodal reasoning for coding and agentic workflows; 1M context'],
  ['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', 'open-weight reasoning and agent accuracy; 1M context'],
  ['opencode/nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', 'open-weight MoE for agentic tasks; 262k context'],
] as const).map(([modelID, displayName, shape]): LadderEntry => ({
  provider: 'opencodeCLI',
  modelID,
  displayName,
  desiredEfforts: ['none'],
  provenance: {
    catalogueStatus: 'listed',
    source: OPENCODE_CATALOGUE_SOURCE,
    observedAt: OPENCODE_CATALOGUE_OBSERVED_AT,
    cataloguedCost: 'free',
    detail: `${shape}. ${OPENCODE_FREE_LIST_PRICE_EXPLANATION}`,
  },
}));

/**
 * The models this project INTENDS to test, once something proves the account can invoke them.
 *
 * This list is a plan, not a capability claim, and it is deliberately inert: every entry is born
 * `unproven`, `selectableModels` filters those out, and the campaign builder refuses one. Editing
 * this list can therefore never make a model runnable — only discovery can.
 */
export const DESIRED_CANDIDATE_LADDER: LadderEntry[] = [
  // OPUS 5 AND FABLE 5.1 ARE REQUIRED COHORT MEMBERS, AND NEITHER IS THE MODEL BELOW IT.
  //
  // Pass 5B tested what it had and reported what it tested, honestly. But its combined candidate
  // list contained neither `claude-opus-5` nor `claude-fable-5-1`, and both had been explicitly
  // required. Nothing refused them and nothing recorded them as missing — they were simply never
  // asked for, so no row ever said they were absent. THAT is the failure mode this block exists to
  // prevent: not a wrong answer, but a question that quietly stopped being asked.
  //
  // The two nearest names are NOT substitutes, and the resemblance is exactly what makes the
  // substitution tempting:
  //   `claude-opus-4-8`  is a DIFFERENT MODEL from `claude-opus-5`.  Not an alias, not a build of it.
  //   `claude-sonnet-5`  is a DIFFERENT MODEL from `claude-fable-5-1`. A shared `5` is not a lineage.
  // Either swap would produce a cohort that looked complete while measuring something nobody asked
  // about — the same class of error as reading a model's prose self-description as its identity.
  //
  // Both carry historical identity evidence, preserved unchanged and NOT treated as current proof
  // (see `reconciliation.ts`): Opus 5 verified over 108 stored attempts on 2026-08-19, and Fable 5.1
  // verified by a single authorized probe on 2026-09-02 whose STRUCTURED stream self-named
  // `claude-fable-5-1` while its prose said "Claude Fable 5". History earns a model its place in the
  // plan. It never earns it a place in a cohort: these rows are born `unproven` like every other.
  { provider: 'claudeCLI', modelID: 'claude-opus-5', displayName: 'Claude Opus 5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', desiredEfforts: ['high'] },
  { provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', desiredEfforts: ['high', 'max'] },
  { provider: 'claudeCLI', modelID: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', desiredEfforts: ['none'] },
  // LUNA IS AN OPENAI MODEL AND BELONGS HERE, NOT ABOVE.
  //
  // Pass 5 asked the `claude` CLI for a model it called `luna-max`, was told 404, and concluded that
  // "Luna Max does not exist". The 404 was correct and the conclusion was wrong: the Claude CLI had
  // been asked for a model from the Codex family, which it has never served and could not serve. The
  // full name is GPT-5.6 Luna; "Luna Max" is that model at MAX REASONING EFFORT, which is a model
  // plus a setting rather than a model identifier — which is why sending it as one could only 404.
  //
  // A refusal is only evidence about the provider that was asked. Asking the wrong provider proves
  // nothing about the model, and this ladder now keeps identifier and effort in the two separate
  // columns the rest of the engine already uses.
  { provider: 'codexCLI', modelID: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', desiredEfforts: ['max'] },
  { provider: 'codexCLI', modelID: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', desiredEfforts: ['medium'] },
  { provider: 'codexCLI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', desiredEfforts: ['medium', 'max'] },
  { provider: 'codexCLI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', desiredEfforts: ['medium', 'max'] },
  // THE OPENAI API IDENTITY LADDER — FOUR IDENTIFIERS, ONE RUNG EACH, AND IT IS NOT A BENCHMARK.
  //
  // These are the same four models the Codex rows above name, reached THE OTHER WAY: through the
  // published HTTP API, billed per token against the user's own key, instead of through a ChatGPT
  // subscription. They are not duplicates, and NEITHER ROUTE PROVES THE OTHER. A Codex smoke can
  // establish that a subscription accepted an identifier; it cannot establish that an API key may
  // call it, what the API names as the answering model, or what the request costs. `executionClassOf`
  // already keeps the two apart for exactly that reason, and a proof carries the provider with it.
  //
  // ONE RUNG EACH, AND THE RUNG IS `low`. This ladder exists to find out WHO ANSWERS, not how well.
  // The rung was chosen from the only captured evidence this repository holds about these four
  // identifiers — the Codex catalogue in `codex debug models` — read for two things:
  //
  //   the DEFAULT level each model declares   sol low · astra low · luna medium · terra medium
  //   the LOWEST level each model supports    low, for all four
  //
  // So the defaults DIFFER and the floor does not, and `low` is the cheapest request that can be
  // made of every one of them. It is strictly cheaper than leaving the effort unstated for Luna and
  // Terra, whose declared default is medium: `none` would not save a reasoning token, it would only
  // stop the record from saying which level answered.
  //
  // THAT CATALOGUE DESCRIBES THE CODEX SERVICE, NOT THIS ENDPOINT, and it is used here only to
  // NARROW what is asked for. It is not evidence that the metered API accepts any level for any of
  // these identifiers, nothing here claims it is, and if the endpoint refuses `low` that refusal is
  // recorded as a fact about this account rather than retried at another level.
  //
  // NOT `minimal`: no catalogue entry for any of the four declares it, so asking for it would be
  // inventing a level — the Pass 5 error of turning an unasked question into an answer.
  // NOT `max` or `xhigh`: see `OPENAI_API_EFFORT_LEVELS`. `max` is not expressible on this endpoint
  // at all — the adapter used to rewrite it to `high`, which would have frozen one level in the
  // manifest and sent another — and nothing has established that `xhigh` is accepted here.
  //
  // Every row is born `unproven` like every other row in this list, and a metered smoke is refused
  // outright unless it was authorized by name. Editing this list cannot make anything runnable.
  { provider: 'openaiAPI', modelID: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', desiredEfforts: ['low'] },
  { provider: 'openaiAPI', modelID: 'gpt-6-astra', displayName: 'GPT-6 Astra', desiredEfforts: ['low'] },
  // UNION ALPHA, ADDRESSED THE WAY OPENCODE ADDRESSES IT.
  //
  // `opencode/union-alpha` is not a Cernum convention laid over OpenCode's: OpenCode's own `--model`
  // flag takes `provider/model`, and `opencode models` prints this exact string. The identifier is
  // carried through unchanged so that what Cernum asks for and what OpenCode was told are the same
  // bytes.
  //
  // It is born `unproven` like every other row here, and it is reached through a METERED API, so a
  // campaign that selects it spends the user's own money per token. `desiredEfforts` is `none`
  // because nothing has established which variants OpenCode accepts for this model, and asking for
  // an effort level a provider does not have is how Pass 5 turned a correct 404 into a wrong
  // conclusion.
  //
  // AND AS OF 2026-09-20, OPENCODE NO LONGER LISTS IT. The row stays, marked `notListed` with the
  // date and the command that established it, because "we never asked" and "we asked and it is gone"
  // are different facts and only the second is true. See `UNION_ALPHA_RETIREMENT_NOTE`.
  {
    provider: 'opencodeCLI', modelID: UNION_ALPHA_MODEL_ID, displayName: 'Union Alpha', desiredEfforts: ['none'],
    provenance: {
      catalogueStatus: 'notListed',
      source: OPENCODE_CATALOGUE_SOURCE,
      observedAt: UNION_ALPHA_NOT_LISTED_SINCE,
      // UNKNOWN rather than `paid`. The catalogue no longer carries the model, so it no longer
      // carries a price for it, and the last price anyone saw is not a price that is still offered.
      cataloguedCost: 'unknown',
      detail: UNION_ALPHA_RETIREMENT_NOTE,
    },
  },
  // THE FREE OPENCODE POOL, READ OFF THE LIVE LISTING ON 2026-09-20 AND NOT OUT OF ANYONE'S MEMORY.
  //
  // WHY THESE SIX AND NOT SOME OTHERS. `opencode models` named 71 identifiers under the `opencode`
  // provider. Seven of the 71 carry a catalogue list price of input $0 / output $0. Six of those
  // seven describe themselves as reasoning, coding or agentic models and report `tool_call: true`,
  // which is the shape of work Cernum benchmarks. The seventh, `opencode/ling-3.0-flash-fin-free`,
  // is a FINANCE-domain model -- free and tool-capable, and not a development model, so it is left
  // off deliberately rather than by oversight, and named here so the omission is a decision on the
  // record instead of a gap somebody later fills by guessing.
  //
  // WHAT ADDING THEM DOES, EXACTLY. It makes them DISCOVERABLE and it makes them nameable to
  // `cernum smoke --models`. It does not make them selectable, routable, or qualified: these rows
  // are born `unproven` like every other row in this list, `selectableModels` drops them, and the
  // campaign builder refuses one. Discovery will not change that either -- an OpenCode listing is a
  // cached catalogue, so discovering these six moves them from "named in a plan" to "named in a plan
  // and also present in a catalogue", which is not a step towards being callable. Only an authorized
  // request that was sent and came back can do that. See `OPENCODE_PROOF_PATH`.
  //
  // EVERY ONE ENTERS AT EFFORT `none`, INCLUDING THE TWO THE CATALOGUE GIVES EFFORT LEVELS FOR. The
  // catalogue reports `minimal|low|medium|high|xhigh` for both Muse Spark rows. That is the same
  // cached file that proves nothing about entitlement, and Pass 5 has already demonstrated what
  // happens when a request carries a setting the provider turns out not to accept: a correct refusal
  // gets read as a fact about the model. Efforts are added after execution is proven, not before.
  ...FREE_OPENCODE_DEVELOPMENT_POOL,
];
const LADDER_CAVEAT =
  'named in the intended testing ladder, and nothing has confirmed it. A model identifier is not a capability claim: '
  + 'lineups change, a subscription tier may not include what another does, and an installed CLI may predate a model '
  + 'entirely. Run an identity smoke test before this becomes selectable: discovery can find the identifier, and '
  + 'only a request that came back naming the model can prove it.';

/** The ladder as unproven rows, for a screen that wants to show the plan without implying it works. */
export function desiredCandidates(at: string): DiscoveredFrontierModel[] {
  return DESIRED_CANDIDATE_LADDER
    .filter((entry) => entry.modelID.length > 0)
    .map((entry) => ({
      provider: entry.provider,
      modelID: entry.modelID,
      displayName: entry.displayName,
      availability: 'unproven' as const,
      // THE PROVENANCE IS APPENDED, NOT SUBSTITUTED. A row whose identifier was read off a live
      // listing is better evidenced than one written from memory, and saying so is useful. It is
      // still `unproven`, and the caveat that says why stays in front of the provenance rather than
      // being softened by it — which is the order a reader needs, because "OpenCode listed this on
      // 2026-09-20" is exactly the sentence that reads like availability if it comes first.
      evidence: `${entry.displayName} is ${LADDER_CAVEAT}`
        + (entry.provenance
          ? ` Provenance: ${entry.provenance.source} ${entry.provenance.catalogueStatus === 'listed' ? 'named' : 'did NOT name'}`
            + ` ${entry.modelID} on ${entry.provenance.observedAt}; catalogued cost ${entry.provenance.cataloguedCost}.`
            + ` ${entry.provenance.detail}`
          : ''),
      verifiedModelID: '',
      desiredEfforts: entry.desiredEfforts,
      discoveredAt: at,
    }));
}

export interface OfflineStatusOptions extends CredentialLookupOptions {
  now?: () => Date;
  /** Injected so a test can present a PATH without writing to the real one. */
  findExecutable?: (name: string) => string | undefined;
}

function iso(now: () => Date): string {
  return now().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * How to say "it is not here" without saying something that is not true.
 *
 * This sentence used to read "is not on this machine's PATH", which was accurate while
 * `findExecutable` read PATH and stopped. It no longer does -- see `installerDirectories` in
 * `cli-process.ts` -- so the sentence would now understate the search and invite the reader to fix a
 * PATH that was never the problem. It names what was actually looked at.
 */
export function notFoundPhrase(executable: string): string {
  return `\`${executable}\` was not found on PATH, nor in the directories CLI installers write to`;
}

/**
 * What can be said about every provider WITHOUT contacting any of them.
 *
 * This is what a settings screen, a status command and application startup call. It performs a PATH
 * lookup for the two CLIs and reads the credential configuration for the two APIs. That is all it
 * can do, and saying so — `reachability: 'unknown'`, `probe: 'offline'` — is more useful than a
 * confident answer it has no way to have.
 */
export function offlineProviderStatuses(options: OfflineStatusOptions = {}): ProviderStatus[] {
  const now = options.now ?? (() => new Date());
  const checkedAt = iso(now);
  const locate = options.findExecutable ?? ((name: string) => findExecutable(name));

  return (Object.keys(PROVIDER_LABELS) as ProviderID[]).map((provider): ProviderStatus => {
    const executionClass = executionClassOf(provider);
    const base = {
      provider,
      label: PROVIDER_LABELS[provider],
      executionClass,
      billingBasis: billingBasisOf(executionClass),
      probe: 'offline' as const,
      models: [] as DiscoveredFrontierModel[],
      checkedAt,
    };

    if (provider === 'ollama') {
      // The local runtime already has its own status surface, built in Pass 3 and unchanged. Saying
      // `unknown` here rather than duplicating that check keeps one answer about Ollama rather than
      // two that can disagree.
      return {
        ...base,
        reachability: 'unknown',
        detail: 'the local runtime reports its own status on the Home screen and through `cernum models`; '
          + 'this view does not contact it a second time',
      };
    }

    // ANY provider reached by running an executable, whether it is billed as a subscription or as a
    // metered API. Keyed off the executable map rather than the execution class, because OpenCode is
    // both a CLI and metered, and an execution-class test would send it to the API-key branch below —
    // where `credentialStatus` THROWS for a provider that has no environment variable to read.
    const cliExecutable = CLI_EXECUTABLE[provider];
    if (cliExecutable) {
      const executablePath = locate(cliExecutable);
      const metered = executionClass === 'meteredAPI';
      if (!executablePath) {
        return {
          ...base,
          reachability: 'notInstalled',
          detail: `${notFoundPhrase(cliExecutable)}. Cernum drives the official CLI you installed and `
            + 'authenticated yourself — it never installs one, never reads its stored session, and never reaches the '
            + 'service any other way.',
        };
      }
      return {
        ...base,
        reachability: 'unknown',
        executablePath,
        detail: `\`${cliExecutable}\` is installed at ${executablePath}. Whether it is signed in, and which models it `
          + `may call, can only be learned by running it — so nothing here has, and nothing will until you ask for `
          + `discovery.${metered ? ' Requests through this provider are billed per token against your own key.' : ''}`,
      };
    }

    const credential = credentialStatus(provider, options);
    return {
      ...base,
      credential,
      reachability: credential.present ? 'unknown' : 'noCredential',
      detail: credential.present
        ? `a key is configured (${credential.source}). Whether it works, and which models it may call, would take a `
          + 'request to find out — and a request to this provider costs money, so none has been made.'
        : credential.remedy,
    };
  });
}

// MARK: - Discovery, which invokes something

export interface DiscoveryOptions {
  now?: () => Date;
  findExecutable?: (name: string) => string | undefined;
  /** Injected so every test drives a fake executable rather than the real one. */
  run?: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  timeoutMilliseconds?: number;
  credentials?: CredentialLookupOptions;
}

/**
 * Ask a subscription CLI what it is and what it can reach.
 *
 * The two questions are asked with the tool's own documented, read-only subcommands. There is no
 * request to a model here and no token spent on inference: `--version` reports the build, and the
 * model listing reports what the signed-in account may select. A CLI that offers no such listing
 * answers nothing, and the result says exactly that rather than falling back to a guess.
 */
export async function discoverSubscriptionCLI(provider: ProviderID, options: DiscoveryOptions = {}): Promise<ProviderStatus> {
  const now = options.now ?? (() => new Date());
  const checkedAt = iso(now);
  const executable = CLI_EXECUTABLE[provider];
  const executionClass = executionClassOf(provider);
  const base = {
    provider,
    label: PROVIDER_LABELS[provider],
    executionClass,
    billingBasis: billingBasisOf(executionClass),
    probe: 'invoked' as const,
    models: [] as DiscoveredFrontierModel[],
    checkedAt,
  };
  if (!executable) {
    return { ...base, probe: 'offline', reachability: 'unknown', detail: `${provider} is not a subscription CLI` };
  }

  const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
  const executablePath = locate(executable);
  if (!executablePath) {
    return {
      ...base,
      probe: 'offline',
      reachability: 'notInstalled',
      detail: `${notFoundPhrase(executable)}, so there was nothing to run and nothing was run.`,
    };
  }

  const run = options.run ?? runCLI;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;

  const version = await run({ executable: executablePath, args: ['--version'], timeoutMilliseconds });
  if (version.failure) {
    return {
      ...base,
      executablePath,
      reachability: 'unreachable',
      detail: `\`${executable} --version\` did not answer: ${redactSecrets(version.failure.detail)}`,
    };
  }
  const versionText = version.stdout.trim().split('\n')[0] ?? '';

  // AUTHENTICATION, ASKED THE WAY THE TOOL ANSWERS IT.
  //
  // CORRECTION TO PASS 4B: Pass 4B asked for `<cli> models list --json` and inferred authentication
  // from PROSE when that failed, matching phrases like "not logged in" against stdout and stderr.
  // The installed `claude` 2.1.251 has NO `models` command at all — so the call always failed, the
  // prose match always missed, and every run of discovery returned `unknown`. It also has a
  // documented machine-readable answer to exactly this question, which Pass 4B never asked:
  // `claude auth status --json`.
  const auth = await run({ executable: executablePath, args: authStatusArguments(provider), timeoutMilliseconds });
  const session = provider === 'codexCLI' ? codexSession(auth.stdout) : parseAuthStatus(auth.stdout);

  // A CODEX CLI SIGNED IN WITH AN API KEY IS NOT A SUBSCRIPTION, AND IS REFUSED RATHER THAN USED.
  //
  // The same binary serves both, and the difference is invisible from the outside: identical
  // commands, identical output, and a per-token charge against a card in one case and a plan
  // allowance in the other. This engine labels Codex execution `subscriptionIncluded` with a zero
  // marginal charge, so running it against a metered session would report a real charge as free.
  if (provider === 'codexCLI') {
    const usable = codexSubscriptionUsable(parseCodexDoctorAuth(auth.stdout));
    if (!usable.usable) {
      return {
        ...base,
        executablePath,
        version: versionText,
        reachability: 'notAuthenticated',
        models: desiredCandidates(checkedAt).filter((model) => model.provider === provider),
        detail: usable.reason,
      };
    }
  }

  if (!session) {
    return {
      ...base,
      executablePath,
      version: versionText,
      reachability: 'unknown',
      models: desiredCandidates(checkedAt).filter((model) => model.provider === provider),
      detail: `\`${executable} --version\` answered (${versionText}), but its authentication status could not be read `
        + `in a machine-readable form (${redactSecrets(auth.failure?.detail ?? 'the output did not parse')}). Nothing `
        + 'here will guess from prose, so whether this subscription is signed in is unknown and every candidate stays '
        + 'unproven.',
    };
  }

  if (!session.loggedIn) {
    return {
      ...base,
      executablePath,
      version: versionText,
      reachability: 'notAuthenticated',
      models: desiredCandidates(checkedAt).filter((model) => model.provider === provider),
      detail: `\`${executable}\` is installed but reports that it is not signed in. Authenticate it yourself, the way `
        + 'you normally would; Cernum does not carry out a sign-in and does not hold your session.',
    };
  }

  // SIGNED IN, AND STILL UNABLE TO LIST MODELS.
  //
  // This is the honest end of discovery for this tool, and it is a real limitation rather than a
  // failure: `claude` documents no model-listing subcommand in any form. So nothing here knows which
  // models the subscription may call, and the ladder stays UNPROVEN. The only remaining route from
  // `unproven` to `proven` is an identity smoke test — one minimal request per candidate, which
  // names the model in its own answer. That is a request, it consumes allowance, and it therefore
  // happens only when a person asks for it by name.
  // WHAT EACH TOOL CAN AND CANNOT ESTABLISH, said separately, because they differ.
  //
  // CORRECTION TO PASS 5: this sentence used to assert that the signed-in CLI "offers NO
  // model-listing command" for BOTH providers. That is true of `claude` and FALSE of `codex`, which
  // documents `codex debug models` — "Render the raw model catalog as JSON" — and answers it. Pass 5
  // could not have known: no `codex` binary was installed when it ran.
  //
  // It changes the wording and NOT the verdict. A catalogue is what the client knows about, not what
  // the account may invoke, and the service makes that distinction itself: a model absent from the
  // catalogue is refused with "not supported when using Codex with a ChatGPT account", which is an
  // account-level judgement no local file can make. So every Codex candidate stays `unproven` too,
  // and for a second reason on top: `codex exec --json` never names the model that answered, so even
  // a successful smoke leaves identity `unverifiable`.
  const listing = provider === 'codexCLI'
    ? 'It DOES offer a machine-readable model catalogue (`codex debug models`), but a catalogue is what this client '
      + 'knows about rather than what this account may invoke — the service refuses models that appear in it — and '
      + '`codex exec` never names the model that answered, so identity stays unverifiable even on success.'
    : 'It offers NO model-listing command, so which models the subscription may call is still unknown.';

  return {
    ...base,
    executablePath,
    version: versionText,
    reachability: 'ready',
    session,
    models: desiredCandidates(checkedAt).filter((model) => model.provider === provider),
    detail: `\`${executable}\` ${versionText} is signed in (${session.authMethod}`
      + `${session.subscriptionType ? `, ${session.subscriptionType} plan` : ''}) and this account can reach the `
      + `service. ${listing} Run an identity smoke test to establish what a real request returns. Nothing is `
      + 'selectable until something does.',
  };
}

/**
 * How each subscription CLI is asked whether it is signed in. Its own documented subcommand.
 *
 * CORRECTION TO PASS 4B: `codex login status --json` DOES NOT EXIST. Verified against 0.154.0,
 * which answers `error: unexpected argument '--json' found`. `codex login status` without the flag
 * prints one line of PROSE — `Logged in using ChatGPT` — and this engine does not read prose where a
 * machine-readable field is required.
 *
 * The machine-readable answer is `codex doctor --json`, documented as "Emit a redacted
 * machine-readable report", whose `auth.credentials` check reports the stored auth mode, whether an
 * API key is stored and whether ChatGPT tokens are. See `parseCodexDoctorAuth`.
 */
function authStatusArguments(provider: ProviderID): string[] {
  return provider === 'claudeCLI' ? ['auth', 'status', '--json'] : ['doctor', '--json'];
}

/**
 * Read a CLI's authentication status, keeping NOTHING that identifies the account.
 *
 * The real answer carries an email address, an organisation id and an organisation name. None of
 * them are needed to know whether a benchmark can run, and all three would end up in evidence files
 * and reports if this function returned the object it parsed. So the fields are named one by one and
 * the rest is dropped here, at the boundary, rather than redacted later by something that might be
 * forgotten.
 */
export function parseAuthStatus(stdout: string): SubscriptionSession | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (typeof parsed.loggedIn !== 'boolean') return undefined;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    loggedIn: parsed.loggedIn,
    authMethod: text(parsed.authMethod),
    apiProvider: text(parsed.apiProvider),
    subscriptionType: text(parsed.subscriptionType),
  };
}

/**
 * The Codex equivalent of `parseAuthStatus`, mapped onto the same shape and keeping just as little.
 *
 * The two tools answer the question in completely different documents — `claude auth status --json`
 * returns a flat object with a `loggedIn` boolean; `codex doctor --json` returns a report whose
 * `auth.credentials` check carries STRING fields, so `"stored API key": "false"` is the string
 * `false` and reading it as a boolean makes every session look like an API-key session.
 *
 * `subscriptionType` is left EMPTY rather than filled in. Codex reports no plan tier anywhere this
 * pass could find, and writing "max" or "plus" into it from anything other than the tool's own
 * statement would be inventing the one fact the field exists to carry.
 */
function codexSession(stdout: string): SubscriptionSession | undefined {
  const auth: CodexAuthStatus | undefined = parseCodexDoctorAuth(stdout);
  if (!auth) return undefined;
  return {
    loggedIn: auth.chatgptTokensStored || auth.apiKeyStored,
    authMethod: auth.storedAuthMode,
    apiProvider: 'openai',
    subscriptionType: '',
  };
}

/**
 * WHAT A LISTING ESTABLISHES, AND THE ONE THING IT CANNOT.
 *
 * A listing — a CLI's catalogue, or a metered API's `/v1/models` answered with this account's own
 * key — can establish that an identifier was ADVERTISED OR VISIBLE to this account. It cannot
 * establish that the model answered a request, because no request was made: nothing was asked, and
 * no provider named a model in a reply. The two are different facts and the store keeps them apart.
 */
export const LISTING_IS_NOT_EXECUTION =
  'A model listing reports which identifiers a provider advertised to this account. It is not a reply from a model: '
  + 'nothing was asked and nothing answered. An account-scoped listing is better evidence than a client-side '
  + 'catalogue and it is still not execution — an advertised identifier can be refused at call time for tier, region, '
  + 'retirement or moderation. So a listed model is recorded as DISCOVERED and UNPROVEN, and `verifiedModelID` stays '
  + 'EMPTY, because no provider has named a model in answer to a request.';

/** HOW A LISTED MODEL BECOMES PROVEN. One route, and it costs what a request costs. */
export const LISTING_PROOF_PATH =
  'A listed model becomes selectable only through an identity smoke test — one request that was sent and came back '
  + 'naming the model that answered: `cernum smoke <provider> --models <id>`. Against a metered API that request is '
  + 'billed per token against your own credential and is refused unless it was authorized by name.';

/**
 * Read a model listing.
 *
 * Accepts the two shapes tools actually emit — a bare array, or an object with a `models`/`data`
 * array — and NOTHING else. A listing that does not parse yields no models at all, because a
 * partially-understood listing is how a name that was never offered becomes a candidate.
 *
 * EVERY ROW IT RETURNS IS `unproven` WITH AN EMPTY `verifiedModelID`. v0.2.4 returned `proven` here
 * with `verifiedModelID` set to the advertised identifier, which gave a catalogue entry the same
 * standing in the store as a model that had answered — and on a live OpenAI account made 130 models
 * campaign-selectable, including embedding, audio, image and moderation endpoints that cannot answer
 * an identity prompt at all. Nothing this function returns may be selected; see `LISTING_PROOF_PATH`.
 */
export function parseModelListing(stdout: string, provider: ProviderID, at: string): DiscoveredFrontierModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(parsed) ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { models?: unknown[] }).models)
      ? (parsed as { models: unknown[] }).models
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown[] }).data)
        ? (parsed as { data: unknown[] }).data
        : [];

  const wanted = new Map(DESIRED_CANDIDATE_LADDER.filter((entry) => entry.provider === provider)
    .map((entry) => [entry.modelID, entry]));

  const out: DiscoveredFrontierModel[] = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row
      : typeof row === 'object' && row !== null
        ? String((row as { id?: unknown; name?: unknown; model?: unknown }).id
          ?? (row as { name?: unknown }).name ?? (row as { model?: unknown }).model ?? '')
        : '';
    if (id.length === 0) continue;
    const displayName = typeof row === 'object' && row !== null && typeof (row as { display_name?: unknown }).display_name === 'string'
      ? (row as { display_name: string }).display_name
      : (wanted.get(id)?.displayName ?? id);
    out.push({
      provider,
      modelID: id,
      displayName,
      availability: 'unproven',
      // Deliberately provider-neutral wording: the same parser reads a subscription CLI's listing
      // and a metered API's, and calling an API "the CLI" would misdescribe how the answer was got.
      // It says LISTED rather than "may call": what this account may call is the question a listing
      // does not answer.
      evidence: `${PROVIDER_LABELS[provider]} listed ${id} at ${at}: DISCOVERED, NOT PROVEN. `
        + `${LISTING_IS_NOT_EXECUTION} ${LISTING_PROOF_PATH}`,
      verifiedModelID: '',
      desiredEfforts: wanted.get(id)?.desiredEfforts ?? [],
      discoveredAt: at,
    });
  }

  // Anything on the ladder the tool did NOT list stays unproven and is reported as such, so the plan
  // and the reality are both visible instead of the plan quietly disappearing.
  for (const [id, entry] of wanted) {
    if (out.some((model) => model.modelID === id)) continue;
    out.push({
      provider,
      modelID: id,
      displayName: entry.displayName,
      availability: 'refused',
      evidence: `${PROVIDER_LABELS[provider]} listed the models it advertises to this account at ${at}, and `
        + `${entry.displayName} was not among them. Being listed would not have proven it either — nothing in a `
        + 'listing does — but being absent from one this account was served is a reason not to plan around it.',
      verifiedModelID: '',
      desiredEfforts: entry.desiredEfforts,
      discoveredAt: at,
    });
  }
  return out.sort((a, b) => (a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0));
}

/**
 * A metered provider's model listing.
 *
 * Reaching a paid provider's `/v1/models` is not itself a billed inference request, but it is still
 * a request made with the user's key, so it happens only when asked for by name — never from a
 * status read. The credential is required first, so a missing key refuses cleanly instead of
 * producing a 401 in the evidence.
 */
export async function discoverMeteredProvider(provider: ProviderID, options: DiscoveryOptions & {
  baseURL: string;
  fetchImplementation?: typeof fetch;
} ): Promise<ProviderStatus> {
  const now = options.now ?? (() => new Date());
  const checkedAt = iso(now);
  const executionClass = executionClassOf(provider);
  const base = {
    provider,
    label: PROVIDER_LABELS[provider],
    executionClass,
    billingBasis: billingBasisOf(executionClass),
    models: [] as DiscoveredFrontierModel[],
    checkedAt,
  };
  if (!isMeteredProvider(provider)) {
    return { ...base, probe: 'offline', reachability: 'unknown', detail: `${provider} is not a metered API provider` };
  }

  const credential = credentialStatus(provider, options.credentials ?? {});
  if (!credential.present) {
    // Refused BEFORE the request. No round trip, no 401 written into the evidence, no rate-limit slot.
    return { ...base, probe: 'offline', credential, reachability: 'noCredential', detail: credential.remedy };
  }

  const { requireCredential } = await import('./credentials');
  const key = requireCredential(provider, options.credentials ?? {});
  const doFetch = options.fetchImplementation ?? fetch;
  const headers: Record<string, string> = provider === 'anthropicAPI'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };

  try {
    const response = await doFetch(`${options.baseURL.replace(/\/+$/, '')}/v1/models`, { headers });
    const body = await response.text();
    if (!response.ok) {
      return {
        ...base,
        probe: 'invoked',
        credential,
        reachability: response.status === 401 || response.status === 403 ? 'notAuthenticated' : 'unreachable',
        detail: `the provider answered ${response.status}: ${redactSecrets(body).slice(0, 400)}`,
      };
    }
    return {
      ...base,
      probe: 'invoked',
      credential,
      reachability: 'ready',
      models: parseModelListing(body, provider, checkedAt),
      detail: `the key is accepted and the provider listed the models it advertises to this account, at ${checkedAt}. `
        + `${LISTING_IS_NOT_EXECUTION} ${LISTING_PROOF_PATH}`,
    };
  } catch (error) {
    return {
      ...base,
      probe: 'invoked',
      credential,
      reachability: 'unreachable',
      detail: `the provider could not be reached: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

/**
 * Ask OpenCode what it is, what it can reach, and whether it holds a credential.
 *
 * THREE READ-ONLY SUBCOMMANDS, NONE OF WHICH REACHES A MODEL: `--version`, `models`, and
 * `providers list`. No inference is run and no token is spent, which is the same promise
 * `discoverSubscriptionCLI` makes -- and it matters more here, because OpenCode is METERED and a
 * discovery call that quietly invoked a model would spend the user's money to answer a status query.
 *
 * Every parser this calls refuses input it does not recognise rather than guessing. OpenCode has no
 * `--json` on either listing, and `opencode models --json` prints the HELP SCREEN and exits 0 -- so a
 * tolerant parser would read `Positionals:` as a model. See `opencode-cli.ts`.
 */
export async function discoverOpenCodeCLI(options: DiscoveryOptions = {}): Promise<ProviderStatus> {
  const provider: ProviderID = 'opencodeCLI';
  const now = options.now ?? (() => new Date());
  const checkedAt = iso(now);
  const executionClass = executionClassOf(provider);
  const base = {
    provider,
    label: PROVIDER_LABELS[provider],
    executionClass,
    billingBasis: billingBasisOf(executionClass),
    probe: 'invoked' as const,
    models: [] as DiscoveredFrontierModel[],
    checkedAt,
  };

  const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
  const executablePath = locate(OPENCODE_EXECUTABLE);
  if (!executablePath) {
    return {
      ...base,
      probe: 'offline',
      reachability: 'notInstalled',
      detail: `${notFoundPhrase(OPENCODE_EXECUTABLE)}, so there was nothing to run and nothing was run. `
        + OPENCODE_SUPPORT_MATURITY,
    };
  }

  const run = options.run ?? runCLI;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;

  const versionResult = await run({ executable: executablePath, args: OPENCODE_VERSION_ARGUMENTS, timeoutMilliseconds });
  if (versionResult.failure) {
    return {
      ...base,
      executablePath,
      reachability: 'unreachable',
      detail: `\`${OPENCODE_EXECUTABLE} --version\` did not answer: ${redactSecrets(versionResult.failure.detail)}`,
    };
  }
  const version = parseOpenCodeVersion(versionResult.stdout);
  if (!version) {
    return {
      ...base,
      executablePath,
      reachability: 'unreachable',
      detail: `\`${OPENCODE_EXECUTABLE} --version\` answered something that is not a version, so the build is unknown. `
        + 'Nothing is recorded rather than recording the raw line as if it were one.',
    };
  }

  const credentialsResult = await run({ executable: executablePath, args: OPENCODE_CREDENTIALS_ARGUMENTS, timeoutMilliseconds });
  const parsedCredentials = parseOpenCodeCredentials(credentialsResult.stdout);
  const disclosure = opencodeCredentialDisclosure(parsedCredentials);
  if (!opencodeHasCredential(parsedCredentials)) {
    return {
      ...base,
      executablePath,
      version,
      reachability: 'noCredential',
      detail: `${disclosure} ${OPENCODE_SUPPORT_MATURITY}`,
    };
  }

  const modelsResult = await run({ executable: executablePath, args: OPENCODE_MODELS_ARGUMENTS, timeoutMilliseconds });
  if (modelsResult.failure) {
    return {
      ...base,
      executablePath,
      version,
      reachability: 'unreachable',
      detail: `\`${OPENCODE_EXECUTABLE} models\` did not answer: ${redactSecrets(modelsResult.failure.detail)}`,
    };
  }
  const listed = parseOpenCodeModels(modelsResult.stdout);
  if (listed.length === 0) {
    return {
      ...base,
      executablePath,
      version,
      reachability: 'unreachable',
      detail: `\`${OPENCODE_EXECUTABLE} models\` listed nothing this parser recognises as \`provider/model\`. An empty `
        + 'list is NOT reported as "no models exist" -- it is reported as a question that did not get an answer.',
    };
  }

  // A LISTING IS A CATALOGUE, NOT A PROOF. Every model here is DISCOVERED and UNPROVEN, and none is
  // selectable. v0.2.1 wrote `proven` for each one, which claimed this account can invoke a model on
  // the strength of a file OpenCode caches describing thousands of models it has never called. See
  // `OPENCODE_LISTING_IS_A_CATALOGUE`. `verifiedModelID` stays EMPTY for the same reason: nothing
  // came back from a model, so there is no identifier a provider returned.
  const desired = DESIRED_CANDIDATE_LADDER.filter((entry) => entry.provider === provider);
  const models: DiscoveredFrontierModel[] = listed.map((modelID) => {
    const planned = desired.find((entry) => entry.modelID === modelID);
    return {
      provider,
      modelID,
      displayName: planned?.displayName ?? modelID,
      availability: 'unproven' as const,
      evidence: `\`${OPENCODE_EXECUTABLE} models\` named ${modelID} at ${checkedAt}: DISCOVERED, NOT PROVEN. `
        + `${OPENCODE_LISTING_IS_A_CATALOGUE} ${OPENCODE_PROOF_PATH} `
        + OPENCODE_COST_EXPLANATION,
      verifiedModelID: '',
      desiredEfforts: planned?.desiredEfforts ?? [],
      discoveredAt: checkedAt,
    };
  });
  for (const entry of desired) {
    if (listed.includes(entry.modelID)) continue;
    models.push({
      provider,
      modelID: entry.modelID,
      displayName: entry.displayName,
      availability: 'refused' as const,
      evidence: `\`${OPENCODE_EXECUTABLE} models\` did not name ${entry.modelID} at ${checkedAt}, though it named `
        + `${listed.length} others. OpenCode does not know this identifier, which is recorded as refused rather `
        + 'than quietly omitted. Being named would not have proven it either — nothing in this listing does.',
      verifiedModelID: '',
      desiredEfforts: entry.desiredEfforts,
      discoveredAt: checkedAt,
    });
  }

  const unionAlpha = models.find((m) => m.modelID === UNION_ALPHA_MODEL_ID);
  // `ready` describes OPENCODE — it ran and answered. It has never described a model, and now that
  // no OpenCode model is proven, the sentence says which of the two it is talking about.
  return {
    ...base,
    executablePath,
    version,
    reachability: 'ready',
    models,
    detail: `OpenCode ${version} named ${listed.length} models at ${checkedAt}, none of them proven. `
      + `${UNION_ALPHA_MODEL_ID} was ${unionAlpha && unionAlpha.availability !== 'refused' ? 'DISCOVERED (unproven)' : 'NOT named'}. `
      + `${OPENCODE_LISTING_IS_A_CATALOGUE} ${OPENCODE_PROOF_PATH} `
      + `${disclosure} ${OPENCODE_SUPPORT_MATURITY}`,
  };
}

/**
 * Every provider Cernum can discover by asking it, and the one function that decides which is which.
 *
 * THE DEFECT THIS CLOSES. Until v0.2.1 this decision was written out twice -- once in
 * `src/cli/cernum.ts` and once in `src/main/campaign-service.ts` -- and the two had drifted. The
 * desktop application routed `opencodeCLI` to `discoverOpenCodeCLI`; the terminal did not, so
 * `cernum discover opencodeCLI` answered "'opencodeCLI' is not a provider" about a provider the same
 * build supports, listed in its own `cernum providers` output, on a machine where the CLI was
 * installed and authenticated. Union Alpha could not be proven from a terminal at all, and so could
 * not enter a manifest.
 *
 * Adding the missing branch would have fixed the symptom and left the shape that produced it. A
 * router two surfaces share cannot disagree with itself, and `discoverableProviders` below is
 * derived from `PROVIDER_IDS`, so a provider added later is either routed here or named by the test
 * that walks every id -- it cannot be silently unreachable from one surface.
 */
export const DISCOVERABLE_PROVIDERS: ProviderID[] = PROVIDER_IDS.filter((provider) => provider !== 'ollama');

/**
 * True for a provider `discoverProvider` will route.
 *
 * `ollama` is excluded on purpose and not by omission: the local runtime is not asked what models it
 * may call, it is listed directly by `discoverLocalModels`, and `refuseToDiscover` says so by name
 * rather than calling it unknown.
 */
export function isDiscoverableProvider(provider: string): provider is ProviderID {
  return DISCOVERABLE_PROVIDERS.includes(provider as ProviderID);
}

/** What to tell a person who named something this cannot discover. Never a bare "not a provider". */
export function refuseToDiscover(provider: string): string {
  if (provider === 'ollama') {
    return 'the local runtime is not discovered this way: it is listed directly. Run `cernum models`.';
  }
  return `'${provider}' is not a provider Cernum can discover. Try ${DISCOVERABLE_PROVIDERS.join(', ')}.`;
}

/**
 * Ask ONE provider what it is and what this account may call. THIS INVOKES SOMETHING.
 *
 * Each branch below costs what its own documentation says it costs, and no branch reaches a model:
 * the two subscription CLIs and OpenCode run their tool's read-only subcommands, and the metered API
 * branch reads a model listing with the user's key. Nothing here spends inference allowance.
 *
 * The three branches are not interchangeable and none of them is a default. A CLI sent to the
 * metered branch would have `credentialStatus` THROW on it for want of an API-key environment
 * variable, and a metered API sent to the CLI branch would be looked for on PATH as an executable
 * that does not exist. OpenCode is both a CLI and metered, which is exactly why it needs its own
 * branch and exactly how it fell through the terminal's copy of this decision.
 */
export async function discoverProvider(provider: ProviderID, options: DiscoveryOptions & {
  baseURL?: string;
  fetchImplementation?: typeof fetch;
} = {}): Promise<ProviderStatus> {
  if (provider === 'claudeCLI' || provider === 'codexCLI') {
    return discoverSubscriptionCLI(provider, options);
  }
  if (provider === 'opencodeCLI') {
    return discoverOpenCodeCLI(options);
  }
  if (provider === 'anthropicAPI' || provider === 'openaiAPI') {
    return discoverMeteredProvider(provider, {
      ...options,
      baseURL: options.baseURL ?? (provider === 'anthropicAPI' ? anthropicBaseURL() : openaiBaseURL()),
    });
  }
  throw new Error(refuseToDiscover(provider));
}

/** Only what something actually proved. This is what a campaign builder is allowed to offer. */
export function selectableModels(statuses: ProviderStatus[]): DiscoveredFrontierModel[] {
  return statuses.flatMap((status) => status.models).filter((model) => model.availability === 'proven');
}

/** The sentence shown before a frontier campaign runs. One place, every surface. */
export function privacyDisclosure(providers: { label: string; executionClass: ExecutionClass }[]): string[] {
  const external = providers.filter((entry) => entry.executionClass !== 'localRuntime');
  if (external.length === 0) {
    return ['Every candidate in this campaign runs on this machine. No prompt leaves it.'];
  }
  const names = [...new Set(external.map((entry) => entry.label))].join(', ');
  return [
    `This campaign sends prompts to an external provider: ${names}.`,
    'Every benchmark prompt, every supplied context and every answer for those candidates leaves this machine and is '
      + 'processed on the provider\'s systems, under the provider\'s terms and retention policy — not Cernum\'s.',
    'Cernum has no way to recall a prompt once it has been sent, and no way to make a provider forget one.',
    'Candidates that run on the local runtime are unaffected: their prompts never leave this machine.',
    'You are asked once, before the campaign starts, and not again between attempts.',
  ];
}
