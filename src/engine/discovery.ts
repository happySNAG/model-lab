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
// entirely. So every name starts `unproven`, and only provider discovery or an identity smoke test
// moves it to `proven`. A campaign cannot select an `unproven` candidate at all.
//
// NOTHING HERE SCRAPES ANYTHING. A subscription is reached by running the official CLI the user
// installed and authenticated. There is no browser session, no cookie jar, no private endpoint, and
// no credential read out of another tool's files.

import { ExecutionClass, PROVIDER_LABELS, ProviderID, billingBasisOf, executionClassOf } from './provider';
import { CredentialStatus, CredentialLookupOptions, credentialStatus, isMeteredProvider } from './credentials';
import { CLIResult, findExecutable, runCLI } from './cli-process';
import { redactSecrets } from './redaction';

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
  /** A provider listing or an identity smoke test confirmed this account can invoke it. */
  | 'proven'
  /** Named as a desired candidate. Nothing has confirmed it. Not selectable. */
  | 'unproven'
  /** Something asked and was told no — wrong tier, retired model, unknown name. */
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
  /** Empty until discovery runs. An empty list is never presented as "no models exist". */
  models: DiscoveredFrontierModel[];
  checkedAt: string;
}

/** The executable each subscription CLI is invoked as. The official names, and nothing else. */
const CLI_EXECUTABLE: Partial<Record<ProviderID, string>> = {
  claudeCLI: 'claude',
  codexCLI: 'codex',
};

/**
 * The models this project INTENDS to test, once something proves the account can invoke them.
 *
 * This list is a plan, not a capability claim, and it is deliberately inert: every entry is born
 * `unproven`, `selectableModels` filters those out, and the campaign builder refuses one. Editing
 * this list can therefore never make a model runnable — only discovery can.
 */
export const DESIRED_CANDIDATE_LADDER: { provider: ProviderID; modelID: string; displayName: string; desiredEfforts: string[] }[] = [
  { provider: 'claudeCLI', modelID: 'luna-max', displayName: 'Luna Max', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', desiredEfforts: ['none'] },
  { provider: 'claudeCLI', modelID: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', desiredEfforts: ['high', 'max'] },
  { provider: 'claudeCLI', modelID: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', desiredEfforts: ['none'] },
  { provider: 'codexCLI', modelID: '', displayName: 'whichever models this Codex subscription reports', desiredEfforts: ['none'] },
];

const LADDER_CAVEAT =
  'named in the intended testing ladder, and nothing has confirmed it. A model identifier is not a capability claim: '
  + 'lineups change, a subscription tier may not include what another does, and an installed CLI may predate a model '
  + 'entirely. Run provider discovery or an identity smoke test before this becomes selectable.';

/** The ladder as unproven rows, for a screen that wants to show the plan without implying it works. */
export function desiredCandidates(at: string): DiscoveredFrontierModel[] {
  return DESIRED_CANDIDATE_LADDER
    .filter((entry) => entry.modelID.length > 0)
    .map((entry) => ({
      provider: entry.provider,
      modelID: entry.modelID,
      displayName: entry.displayName,
      availability: 'unproven' as const,
      evidence: `${entry.displayName} is ${LADDER_CAVEAT}`,
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

    if (executionClass === 'subscriptionCLI') {
      const executable = CLI_EXECUTABLE[provider]!;
      const executablePath = locate(executable);
      if (!executablePath) {
        return {
          ...base,
          reachability: 'notInstalled',
          detail: `\`${executable}\` is not on this machine's PATH. Cernum drives the official CLI you installed and `
            + 'authenticated yourself — it never installs one, never reads its stored session, and never reaches the '
            + 'service any other way.',
        };
      }
      return {
        ...base,
        reachability: 'unknown',
        executablePath,
        detail: `\`${executable}\` is installed at ${executablePath}. Whether it is signed in, and which models this `
          + 'subscription may call, can only be learned by running it — so nothing here has, and nothing will until '
          + 'you ask for discovery.',
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
      detail: `\`${executable}\` is not on this machine's PATH, so there was nothing to run and nothing was run.`,
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

  // The model listing. A tool that does not offer one leaves the ladder unproven rather than
  // producing an invented list — and the result says which of those happened.
  const listing = await run({ executable: executablePath, args: ['models', 'list', '--json'], timeoutMilliseconds });
  if (listing.failure) {
    const unauthenticated = /not (?:logged|signed) in|unauthenticated|please (?:log|sign) in|no active session/i
      .test(`${listing.stdout}\n${listing.stderr}`);
    return {
      ...base,
      executablePath,
      version: versionText,
      reachability: unauthenticated ? 'notAuthenticated' : 'unknown',
      models: desiredCandidates(checkedAt).filter((model) => model.provider === provider),
      detail: unauthenticated
        ? `\`${executable}\` is installed but reports that it is not signed in. Authenticate it yourself, the way you `
          + 'normally would; Cernum does not carry out a sign-in and does not hold your session.'
        : `\`${executable} --version\` answered (${versionText}), but it offers no machine-readable model listing `
          + `(${redactSecrets(listing.failure.detail)}). Nothing here knows which models this subscription may call, so every `
          + 'candidate stays unproven until an identity smoke test establishes one by name.',
    };
  }

  const models = parseModelListing(listing.stdout, provider, checkedAt);
  return {
    ...base,
    executablePath,
    version: versionText,
    reachability: 'ready',
    models,
    detail: models.length > 0
      ? `\`${executable}\` ${versionText} is signed in and reports ${models.length} model(s) this subscription may call.`
      : `\`${executable}\` ${versionText} is signed in but reported no models. That is its answer, not an assumption: `
        + 'no candidate is selectable for this provider.',
  };
}

/**
 * Read a CLI's model listing.
 *
 * Accepts the two shapes tools actually emit — a bare array, or an object with a `models`/`data`
 * array — and NOTHING else. A listing that does not parse yields no models at all, because a
 * partially-understood listing is how a name that was never offered becomes a proven candidate.
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
      availability: 'proven',
      // Deliberately provider-neutral wording: the same parser reads a subscription CLI's listing
      // and a metered API's, and calling an API "the CLI" would misdescribe how the answer was got.
      evidence: `${PROVIDER_LABELS[provider]} listed this model as one this account may call, at ${at}`,
      verifiedModelID: id,
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
      evidence: `${PROVIDER_LABELS[provider]} listed the models this account may call, and `
        + `${entry.displayName} was not among them`,
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
      detail: `the key is accepted and the provider listed the models it may call, at ${checkedAt}.`,
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
