// Cernum core · honest measurements and the capability-based candidate contract.
// Port of `ModelLabMeasurement`, `ModelLabCapabilityClaim`, `ModelLabCandidate*`, and the registry.
// Every type is shaped exactly like its persisted JSON so records round-trip byte-identically.

import { fnv1a64Hex, seal, compareCodePoints } from './digest';
import { trimWhitespaceAndNewlines } from './text';

// MARK: - Measurement (measured or explicitly unavailable — never zero, never guessed)

export type Measurement<T> = { measured: T } | { unavailableReason: string };

export function measured<T>(value: T): Measurement<T> {
  return { measured: value };
}
export function unavailable<T = never>(reason: string): Measurement<T> {
  return { unavailableReason: reason };
}
export function measuredValue<T>(m: Measurement<T>): T | undefined {
  return 'measured' in m ? m.measured : undefined;
}
export function isUnavailable<T>(m: Measurement<T>): boolean {
  return 'unavailableReason' in m;
}
/** The value, or the reason it is missing — never a silent blank. */
export function describeMeasurement<T>(m: Measurement<T>, unit = ''): string {
  return 'measured' in m ? `${String(m.measured)}${unit}` : `unavailable (${m.unavailableReason})`;
}

export type CapabilityClaim = 'declared' | 'verified' | 'notSupported' | 'unknown';
/** Fail-closed: only declared or verified support is plannable. */
export function permitsPlanning(claim: CapabilityClaim): boolean {
  return claim === 'declared' || claim === 'verified';
}

// MARK: - Identity and vocabulary

export interface CandidateID { raw: string }
export function candidateID(raw: string): CandidateID {
  return { raw };
}

function normComponent(s: string): string {
  const trimmed = trimWhitespaceAndNewlines(s).toLowerCase();
  const cleaned = Array.from(trimmed, (c) => (c === ':' || c === ' ' || c === '|' ? '-' : c)).join('');
  return cleaned.length === 0 ? 'unspecified' : cleaned;
}
/** `candidate:<provider>:<model>:<version>:<quantization>` — deterministic on every machine. */
export function deterministicCandidateID(provider: string, model: string, version: string, quantization: string): CandidateID {
  return candidateID(`candidate:${normComponent(provider)}:${normComponent(model)}:${normComponent(version)}:${normComponent(quantization)}`);
}

export type ExecutionClass = 'inProcess' | 'localHostProcess' | 'localNetworkRelay' | 'remoteService';
export type PrivacyClass = 'onDeviceOnly' | 'ownerNetworkOnly' | 'remoteThirdParty';
export type Reproducibility = 'deterministic' | 'bestEffort' | 'nondeterministic' | 'unknown';
export type Availability = { state: 'available' } | { state: 'unavailable'; reason: string };
export type Modality = 'text' | 'image' | 'audio';
export type RequiredCapability = 'textGeneration' | 'streaming' | 'structuredOutput' | 'toolCalls';

export function sortedStrings<T extends string>(values: T[]): T[] {
  return [...values].sort(compareCodePoints);
}

// MARK: - Runtime configuration

export interface ConfigurationEntry { key: string; value: string }
export interface RuntimeConfiguration { settings: ConfigurationEntry[] }

export function runtimeConfiguration(pairs: Record<string, string>): RuntimeConfiguration {
  return {
    settings: Object.keys(pairs)
      .map((key) => ({ key, value: pairs[key] }))
      .sort((a, b) => compareCodePoints(a.key, b.key)),
  };
}
/** Deterministic runtime-configuration identity (`mlrc1:`). */
export function configurationID(configuration: RuntimeConfiguration): string {
  return 'mlrc1:' + fnv1a64Hex(configuration.settings.map((e) => `${e.key}=${e.value}`).join('|'));
}
export function configurationValue(configuration: RuntimeConfiguration, key: string): string | undefined {
  return configuration.settings.find((e) => e.key === key)?.value;
}

// MARK: - Descriptor

export interface CandidateDescriptor {
  id: CandidateID;
  displayName: string;
  provider: string;
  exactModelIdentity: string;
  artifactDigest: Measurement<string>;
  executionClass: ExecutionClass;
  quantization: string;
  declaredContextLimitTokens: Measurement<number>;
  inputModalities: Modality[];
  outputModalities: Modality[];
  streaming: CapabilityClaim;
  structuredOutput: CapabilityClaim;
  toolCalls: CapabilityClaim;
  runtimeConfiguration: RuntimeConfiguration;
  reproducibility: Reproducibility;
  privacyClass: PrivacyClass;
  availability: Availability;
}

/** Construct a descriptor with the Swift initializer's normalization (sorted modalities). */
export function makeCandidate(fields: CandidateDescriptor): CandidateDescriptor {
  return { ...fields, inputModalities: sortedStrings(fields.inputModalities), outputModalities: sortedStrings(fields.outputModalities) };
}

export function descriptorDigest(candidate: CandidateDescriptor): string {
  return seal(candidate, 'mlc1:');
}

export function claimFor(candidate: CandidateDescriptor, capability: RequiredCapability): CapabilityClaim {
  switch (capability) {
    case 'textGeneration':
      return candidate.inputModalities.includes('text') && candidate.outputModalities.includes('text') ? 'declared' : 'notSupported';
    case 'streaming': return candidate.streaming;
    case 'structuredOutput': return candidate.structuredOutput;
    case 'toolCalls': return candidate.toolCalls;
  }
}

// MARK: - Registry (literal, reviewed rows — description is not authorization)

export const deterministicFake: CandidateDescriptor = makeCandidate({
  id: deterministicCandidateID('model-lab-fake', 'deterministic-reference', '1', 'none'),
  displayName: 'Deterministic Reference Fake',
  provider: 'model-lab-fake',
  exactModelIdentity: 'deterministic-reference:1',
  artifactDigest: unavailable('no artifact exists — the fake runs in-process'),
  executionClass: 'inProcess',
  quantization: 'none',
  declaredContextLimitTokens: measured(8_192),
  inputModalities: ['text'],
  outputModalities: ['text'],
  streaming: 'notSupported',
  structuredOutput: 'declared',
  toolCalls: 'notSupported',
  runtimeConfiguration: runtimeConfiguration({ mode: 'deterministic' }),
  reproducibility: 'deterministic',
  privacyClass: 'onDeviceOnly',
  availability: { state: 'available' },
});

/**
 * A second registry entry that exists ONLY so this registry stays byte-identical to the sealed
 * reference corpus (see docs/PARITY.md). It describes a private network relay from the project the
 * engine was first written for; it is permanently `unavailable`, has no adapter and no transport in
 * this codebase, and Cernum never lists or runs it — the application offers the Ollama models it
 * finds plus the built-in reference model, and nothing else. Its wording is pinned test data and is
 * deliberately left exactly as the corpus recorded it.
 */
export const skippyRelayGemma: CandidateDescriptor = makeCandidate({
  id: deterministicCandidateID('skippy-relay', 'gemma4-e4b', 'unreported', 'unreported'),
  displayName: 'Skippy Relay (gemma4:e4b)',
  provider: 'skippy-relay',
  exactModelIdentity: 'gemma4:e4b',
  artifactDigest: unavailable('the bridge does not report the model artifact; capture at the Ollama boundary is Campaign 3 work'),
  executionClass: 'localNetworkRelay',
  quantization: 'unreported',
  declaredContextLimitTokens: unavailable('the bridge does not report a context limit; capture at the Ollama boundary is Campaign 3 work'),
  inputModalities: ['text'],
  outputModalities: ['text'],
  streaming: 'notSupported',
  structuredOutput: 'unknown',
  toolCalls: 'unknown',
  runtimeConfiguration: runtimeConfiguration({ transport: 'bridge-relay-chat' }),
  reproducibility: 'unknown',
  privacyClass: 'ownerNetworkOnly',
  availability: { state: 'unavailable', reason: 'Campaign 1 constructs no live transport; wiring one is a later explicit act' },
});

/** The sealed registry, in conception order. Used by the parity suite; not a menu of runnable models. */
export const registryAll: CandidateDescriptor[] = [deterministicFake, skippyRelayGemma];
