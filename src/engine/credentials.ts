// Benchmark engine · where a metered API key comes from, and everywhere it must never go.
//
// THE ONLY TWO SOURCES. An environment variable, or the macOS Keychain. Cernum does not have a third
// place, and in particular it has no place of its own: there is no credential file under the
// application's data directory, nothing in a campaign directory, nothing in a manifest, and nothing
// in Git. A product that stores the key itself has to also get its file permissions, its backups,
// its sync behaviour and its deletion right, and every one of those is a way to leak it that simply
// does not exist if the key is never stored.
//
// SUBSCRIPTION CLIS ARE NOT IN THIS MODULE AT ALL. `claude` and `codex` authenticate themselves.
// Cernum runs the user's own already-authenticated CLI and reads nothing of its session: not its
// token file, not its config directory, not its keychain entry. That is the difference between
// driving a tool somebody installed and impersonating them to a service.
//
// A MISSING CREDENTIAL IS A CLEAN REFUSAL, NOT A FAILED REQUEST. Discovering a missing key by
// sending a request and reading the 401 costs a round trip, writes a failure into the evidence, and
// — on some providers — counts against a rate limit. So the check happens before anything is sent,
// and the refusal names the variable to set.
//
// READING A KEY REGISTERS IT WITH THE REDACTOR, immediately and unconditionally. From that moment
// every string on its way to disk has that exact value stripped out of it, including error text this
// process never authored.

import { execFileSync } from 'node:child_process';
import type { ProviderID } from './provider';
import { maskCredential, redactError, registerSecret } from './redaction';

export class CredentialError extends Error {
  constructor(readonly code: 'missing' | 'unsupportedProvider' | 'keychainUnavailable', message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** Where a key was found. `absent` is a first-class answer, not an error state. */
export type CredentialSource = 'environment' | 'keychain' | 'absent';

export interface CredentialStatus {
  provider: ProviderID;
  /** The environment variable this provider's key is read from. Names only — never a value. */
  environmentVariable: string;
  /** The Keychain service name, on a platform that has one. */
  keychainService: string;
  source: CredentialSource;
  present: boolean;
  /** "set · 108 characters · never shown, never written to disk", or "not set". */
  masked: string;
  /** What to do about it, in words, when it is absent. */
  remedy: string;
}

/** The two metered providers, and the variable each one's key is read from. */
const METERED: Record<string, { environmentVariable: string; keychainService: string; label: string }> = {
  anthropicAPI: { environmentVariable: 'ANTHROPIC_API_KEY', keychainService: 'cernum.anthropicAPI', label: 'the Anthropic API' },
  openaiAPI: { environmentVariable: 'OPENAI_API_KEY', keychainService: 'cernum.openaiAPI', label: 'the OpenAI API' },
};

export function isMeteredProvider(provider: ProviderID): boolean {
  return provider in METERED;
}

/** The environment variable a provider's key is read from. Refuses a provider that has no key. */
export function environmentVariableFor(provider: ProviderID): string {
  const entry = METERED[provider];
  if (!entry) {
    throw new CredentialError('unsupportedProvider',
      `${provider} is not reached with an API key: a local runtime needs none, and a subscription CLI authenticates itself`);
  }
  return entry.environmentVariable;
}

export interface CredentialLookupOptions {
  /** Injected so a test can drive the resolver without touching the real environment. */
  environment?: NodeJS.ProcessEnv;
  /** Injected so a test can drive the Keychain path without a real Keychain. */
  readKeychain?: (service: string, account: string) => string | undefined;
  /** The Keychain account. Defaults to the OS user; recorded, never derived from a key. */
  account?: string;
  /** Skip the Keychain entirely. Used by the offline paths that must touch nothing. */
  environmentOnly?: boolean;
}

/**
 * Read the macOS Keychain for one generic password.
 *
 * `security find-generic-password -w` prints the secret to stdout and nothing else. It is only ever
 * called for a service name Cernum itself writes, so this cannot be pointed at somebody else's
 * entry, and it exits non-zero when the entry is absent — which is an answer, not a failure.
 */
function readMacKeychain(service: string, account: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    // An absent entry and an unavailable Keychain are both "no key here". Neither is worth an
    // exception: the caller's next step is the same either way, and the error text from `security`
    // is not something a person can act on.
    return undefined;
  }
}

/**
 * Find a provider's key, or report plainly that there is none.
 *
 * Environment first, because an explicitly exported variable is the more deliberate of the two and
 * because it is the only one that works identically on every platform.
 */
export function resolveCredential(provider: ProviderID, options: CredentialLookupOptions = {}): { value?: string; source: CredentialSource } {
  const entry = METERED[provider];
  if (!entry) return { source: 'absent' };

  const environment = options.environment ?? process.env;
  const fromEnvironment = environment[entry.environmentVariable];
  if (fromEnvironment && fromEnvironment.trim().length > 0) {
    const value = fromEnvironment.trim();
    registerSecret(value);
    return { value, source: 'environment' };
  }

  if (options.environmentOnly === true) return { source: 'absent' };

  const account = options.account ?? environment.USER ?? 'cernum';
  const read = options.readKeychain ?? readMacKeychain;
  const fromKeychain = read(entry.keychainService, account);
  if (fromKeychain && fromKeychain.trim().length > 0) {
    const value = fromKeychain.trim();
    registerSecret(value);
    return { value, source: 'keychain' };
  }

  return { source: 'absent' };
}

/**
 * What the interface and the terminal show about one provider's credential.
 *
 * Contains no part of the value at any length. `present` plus a length is the whole of what a person
 * needs to answer "have I configured this", and it is also the whole of what is safe to show.
 */
export function credentialStatus(provider: ProviderID, options: CredentialLookupOptions = {}): CredentialStatus {
  const entry = METERED[provider];
  if (!entry) {
    throw new CredentialError('unsupportedProvider', `${provider} is not reached with an API key`);
  }
  const resolved = resolveCredential(provider, options);
  return {
    provider,
    environmentVariable: entry.environmentVariable,
    keychainService: entry.keychainService,
    source: resolved.source,
    present: resolved.value !== undefined,
    masked: maskCredential(resolved.value),
    remedy: resolved.value !== undefined
      ? `found in the ${resolved.source}`
      : `no key for ${entry.label}. Export ${entry.environmentVariable}, or store it in the Keychain under the service `
        + `'${entry.keychainService}'. Cernum never writes it to disk itself.`,
  };
}

/**
 * Get the key or refuse, with a message naming what to set.
 *
 * This is the ONLY function a metered adapter calls. An adapter that read `process.env` itself would
 * be an adapter whose key never passed through `registerSecret`, which is how a value ends up in an
 * error message nobody stripped.
 */
export function requireCredential(provider: ProviderID, options: CredentialLookupOptions = {}): string {
  const status = credentialStatus(provider, options);
  const resolved = resolveCredential(provider, options);
  if (resolved.value === undefined) {
    throw new CredentialError('missing',
      `${status.remedy} Nothing was sent, and no charge was incurred.`);
  }
  return resolved.value;
}

/** Which authorization mode a resolved credential corresponds to, for the frozen binding. */
export function authorizationModeFor(source: CredentialSource): 'apiKeyEnvironment' | 'apiKeyKeychain' {
  // An absent credential never reaches a binding — `requireCredential` refuses first — so the only
  // two reachable answers are the two real sources.
  return source === 'keychain' ? 'apiKeyKeychain' : 'apiKeyEnvironment';
}

/**
 * Write a key into the macOS Keychain. The one action that puts a credential anywhere durable, and
 * it puts it somewhere the OS owns rather than somewhere Cernum owns.
 */
export function storeInKeychain(provider: ProviderID, value: string, options: { account?: string } = {}): void {
  const entry = METERED[provider];
  if (!entry) throw new CredentialError('unsupportedProvider', `${provider} is not reached with an API key`);
  if (process.platform !== 'darwin') {
    throw new CredentialError('keychainUnavailable',
      `there is no Keychain on ${process.platform}; export ${entry.environmentVariable} instead`);
  }
  registerSecret(value);
  const account = options.account ?? process.env.USER ?? 'cernum';
  try {
    // `-w` takes the value as an argument, which would put it in this process's own argv. Piping it
    // on stdin keeps it out of the process table, where anything on the machine could read it.
    execFileSync('security', ['add-generic-password', '-s', entry.keychainService, '-a', account, '-U', '-w'],
      { input: value, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (error) {
    throw new CredentialError('keychainUnavailable', `the Keychain refused the entry: ${redactError(error)}`);
  }
}

/** Every metered provider's credential status at once, for a settings screen or a status command. */
export function allCredentialStatuses(options: CredentialLookupOptions = {}): CredentialStatus[] {
  return (Object.keys(METERED) as ProviderID[]).map((provider) => credentialStatus(provider, options));
}

/** The variable names only, for `.env.example` and for documentation. Never any values. */
export function credentialVariableNames(): string[] {
  return Object.values(METERED).map((entry) => entry.environmentVariable).sort();
}
