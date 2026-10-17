// Benchmark engine · WHICH providers discovery may contact at all, as a versioned list.
//
// WHY A LIST, AND WHY VERSIONED. `PROVIDER_IDS` says which providers Cernum knows how to reach. That is
// not the same as which ones the owner has authorised it to reach: the 2026-10-16 mission authorises
// Claude models, OpenAI models and supported local Ollama models, and OpenCode was not authorised. A
// refresh that probed every declared provider would contact one nobody agreed to. So discovery asks
// this list first, and a provider not on it is NOT CONTACTED — its probe is never called — and is
// written into the result as refused, with a reason naming the list's version.
//
// The version is stamped on every snapshot, so a reader of a stored snapshot can tell which list
// decided what it contains, and a later list (cpa2) can never be mistaken for the one that applied.
//
// NO CONFIGURATION SURFACE. The default is a constant here. An override is a value passed in by code —
// a test, or a future operator setting that would itself be versioned — never a file that is watched
// or anything read from the network.

import { PROVIDER_IDS, ProviderID } from './provider';

export const PROVIDER_ALLOWLIST_VERSION = 'cpa1' as const;

export interface ProviderAllowlist {
  /** `cpa1` for the default; an override names its base version and the providers it allows. */
  version: string;
  source: 'default' | 'override';
  /** Sorted, without duplicates. */
  providers: readonly ProviderID[];
}

/** cpa1: Claude (CLI and API), OpenAI (Codex CLI and API) and the local Ollama runtime. Not OpenCode. */
export const DEFAULT_PROVIDER_ALLOWLIST: ProviderAllowlist = Object.freeze({
  version: PROVIDER_ALLOWLIST_VERSION,
  source: 'default' as const,
  providers: Object.freeze(['anthropicAPI', 'claudeCLI', 'codexCLI', 'ollama', 'openaiAPI'] as ProviderID[]),
});

/**
 * An explicit list, passed programmatically. Its version names exactly what it allows, so a snapshot
 * taken under an override can never be read as one taken under the default.
 */
export function overrideProviderAllowlist(providers: readonly ProviderID[]): ProviderAllowlist {
  const unknown = providers.filter((provider) => !PROVIDER_IDS.includes(provider));
  if (unknown.length > 0) {
    throw new Error(`a provider allowlist override names ${unknown.join(', ')}, which is not a declared provider. `
      + `Declared: ${PROVIDER_IDS.join(', ')}.`);
  }
  const sorted = [...new Set(providers)].sort();
  return { version: `${PROVIDER_ALLOWLIST_VERSION}-override[${sorted.join(',')}]`, source: 'override', providers: sorted };
}

export function isProviderAllowed(allowlist: ProviderAllowlist, provider: ProviderID): boolean {
  return allowlist.providers.includes(provider);
}

/** The sentence recorded for a provider the list refused. Names the list's version. */
export function providerAllowlistRefusal(allowlist: ProviderAllowlist, provider: ProviderID): string {
  return `refused: ${provider} is not on provider allowlist ${allowlist.version} `
    + `(${allowlist.providers.join(', ') || 'empty'}), so it was not contacted`;
}
