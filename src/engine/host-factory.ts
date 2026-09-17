// Benchmark engine · building the host for a campaign, in one place both surfaces call.
//
// This is `hostOptionsFor`'s bigger sibling, and it exists for the same reason. Pass 3's
// release-blocking defect was two callers configuring a host slightly differently; the surface that
// could differ is now every provider, adapter, base URL, spend tracker and credential source in the
// campaign. One function, called by the terminal and by the Electron service, is the only structural
// answer to that.
//
// THE FORMAT DECIDES THE HOST, AND THE MANIFEST DECIDES THE FORMAT.
//
//   no envelope (format 3)   a plain LiveHost, byte-for-byte the Pass 3 arrangement. A campaign
//                            frozen before this pass runs exactly as it always did, through exactly
//                            the same object, with nothing new in its path.
//   an envelope (format 4)   a RoutingHost, which routes per candidate on the FROZEN binding.
//
// BASE URLS ARE OVERRIDABLE, AND THAT IS DELIBERATE. The tests point them at a mock server on
// loopback. That is the only way to exercise a paid code path without paying, which is what this
// pass required. The override is an environment variable rather than a setting, so it cannot be
// left switched on in a saved configuration where somebody would later mistake a mock's answers for
// a provider's.

import { CampaignConfiguration, CampaignHost } from './campaign';
import { EngineCatalogue, buildEngineCatalogue } from './catalogue';
import { hostOptionsFor, DEFAULT_EXECUTION_POLICY } from './execution';
import { LiveHost } from './live-host';
import { RoutingHost } from './frontier-host';
import { FrontierAdapter, MeteredAPIAdapter, SubscriptionCLIAdapter } from './frontier-adapter';
import { OpenCodeAdapter } from './opencode-adapter';
import { OperationalEnvelope, PROVIDER_IDS, ProviderID, isLocal } from './provider';
import { SpendTracker, SpendingAuthorization, restoreSpendFromRows } from './spending';
import { CredentialLookupOptions } from './credentials';
import { OTLPTurnSource } from './otlp-observer';
import { operationalEnvelopeDigest } from './provider';

/** The published endpoints. Overridable ONLY through the environment, and only for a mock server. */
export function anthropicBaseURL(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CERNUM_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
}

export function openaiBaseURL(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CERNUM_OPENAI_BASE_URL ?? 'https://api.openai.com';
}

export interface AdapterOptions {
  environment?: NodeJS.ProcessEnv;
  credentials?: CredentialLookupOptions;
  /** Supplied by the tests to drive a fake executable; never set in life. */
  overrides?: Partial<Record<ProviderID, FrontierAdapter>>;
  /**
   * A loopback OTLP collector for this campaign, when the operator asked for one.
   *
   * Reaches the Codex adapter only — the adapter itself drops it for any other provider — and is
   * absent in the ordinary case. A campaign exports a tool's telemetry nowhere unless it was asked.
   */
  otlp?: OTLPTurnSource;
}

/**
 * Which providers this build can EXECUTE, and the one place that decides.
 *
 * SEPARATED OUT IN v0.2.3, because "can Cernum run this?" was previously answerable only by reading
 * a switch statement inside `adaptersFor` — and the terminal, the campaign builder and the smoke
 * command each answered it for themselves. `smoke` kept its own list of two providers, which is how
 * OpenCode could be a supported provider everywhere except the one command that would have proved a
 * model. One function, and `providersWithExecutionAdapter()` derives the list from it.
 */
export function buildAdapter(provider: ProviderID, environment: NodeJS.ProcessEnv = process.env,
                             options: AdapterOptions = {}): FrontierAdapter | undefined {
  switch (provider) {
    case 'claudeCLI': case 'codexCLI':
      return new SubscriptionCLIAdapter({ provider, otlp: options.otlp });
    case 'opencodeCLI':
      // METERED, AND A CLI. It takes neither of the branches beside it: the subscription adapter
      // would drive arguments `opencode` does not have, and the metered adapter speaks HTTP to a
      // base URL with an API key, which is not how OpenCode is reached. See `opencode-adapter.ts`.
      return new OpenCodeAdapter();
    case 'anthropicAPI':
      return new MeteredAPIAdapter({ provider: 'anthropicAPI', baseURL: anthropicBaseURL(environment), credentials: options.credentials });
    case 'openaiAPI':
      return new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: openaiBaseURL(environment), credentials: options.credentials });
    default:
      return undefined;
  }
}

/** Every provider a campaign or a smoke test can actually send a request through. */
export function providersWithExecutionAdapter(): ProviderID[] {
  return PROVIDER_IDS.filter((provider) => !isLocal({ provider } as never) && buildAdapter(provider) !== undefined);
}

/**
 * One adapter per frontier provider the envelope actually names.
 *
 * Nothing is constructed for a provider this campaign does not use, so a campaign of local models
 * and a Claude subscription never builds an OpenAI adapter, never reads an OpenAI key, and cannot
 * fail because one is missing.
 */
export function adaptersFor(envelope: OperationalEnvelope, options: AdapterOptions = {}): Partial<Record<ProviderID, FrontierAdapter>> {
  const environment = options.environment ?? process.env;
  const adapters: Partial<Record<ProviderID, FrontierAdapter>> = {};
  for (const binding of envelope.bindings) {
    if (isLocal(binding)) continue;
    if (adapters[binding.provider]) continue;
    const override = options.overrides?.[binding.provider];
    if (override) { adapters[binding.provider] = override; continue; }
    const built = buildAdapter(binding.provider, environment, options);
    if (built) adapters[binding.provider] = built;
  }
  return adapters;
}

export interface HostFactoryOptions extends AdapterOptions {
  endpoint: string;
  catalogue?: EngineCatalogue;
  /** The authorization already on disk for this campaign, when there is one. */
  authorization?: SpendingAuthorization;
  /** Terminal rows from a resumed campaign, so a spending ceiling survives a restart. */
  priorRows?: Record<string, unknown>[];
  shouldCancel?: () => boolean;
  now?: () => Date;
  diskPath?: string;
}

export interface BuiltHost {
  host: CampaignHost;
  /** Present only for a format-4 campaign. The running total a ceiling is enforced against. */
  spend?: SpendTracker;
  /** True when this campaign reaches no local runtime and therefore takes no endpoint lease. */
  frontierOnly: boolean;
}

/**
 * The host for one campaign, configured the way that campaign was FROZEN.
 *
 * `configuration.operationalEnvelope` is read rather than any run-time flag, for the same reason the
 * residency mode is: a policy that can be changed between resumes is not frozen, and a campaign that
 * was Sonnet for its first half and Haiku for its second is not a campaign anybody authorised.
 */
export function buildHostForCampaign(configuration: CampaignConfiguration, options: HostFactoryOptions): BuiltHost {
  const catalogue = options.catalogue ?? buildEngineCatalogue(configuration.suiteIDs, configuration.repeatsPerCase);
  const execution = configuration.execution ?? DEFAULT_EXECUTION_POLICY;
  const envelope = configuration.operationalEnvelope;

  if (!envelope) {
    // Format 3. The Pass 3 arrangement, untouched: same object, same options, same code path.
    return {
      host: new LiveHost({ endpoint: options.endpoint, catalogue, diskPath: options.diskPath, ...hostOptionsFor(execution) }),
      frontierOnly: false,
    };
  }

  const hasLocal = envelope.bindings.some(isLocal);
  const localHost = hasLocal
    ? new LiveHost({ endpoint: options.endpoint, catalogue, diskPath: options.diskPath, ...hostOptionsFor(execution) })
    : undefined;

  const spend = new SpendTracker(options.authorization, operationalEnvelopeDigest(envelope));
  if (options.priorRows) restoreSpendFromRows(spend, options.priorRows);

  return {
    host: new RoutingHost({
      envelope,
      catalogue,
      adapters: adaptersFor(envelope, options),
      localHost,
      spend,
      storeBaseline: configuration.storeBaseline,
      diskPath: options.diskPath,
      now: options.now,
      shouldCancel: options.shouldCancel,
    }),
    spend,
    frontierOnly: !hasLocal,
  };
}
