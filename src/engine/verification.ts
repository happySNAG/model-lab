// Benchmark engine · the two verifications that decide whether an attempt measured what it claims:
// did the model actually receive the context we supplied, and is it actually the model we pinned.
//
// These are separated from scoring on purpose. A failure here is a MEASUREMENT fault, not a model
// failure, and conflating the two is how a benchmark quietly reports the harness's own bug as the
// candidate's. The distinction is the same one `transport_integrity_v2.py` turns on:
//
//     the model answered badly            -> a real capability failure, scored
//     the context never arrived intact    -> a measurement fault, and not the model's
//     the weights were not the pinned ones-> a measurement fault, and the attempt is poisoned
//
// They are told apart by WHO AUTHORED THE BYTES. Both checks compare against values the harness
// authored and sealed before the request, so a failure is the transport's or the runtime's by
// construction.

import { sha256Text } from './canonical';

// MARK: - Supplied-context verification

export type SuppliedContextState = 'intact' | 'absent' | 'mutated' | 'truncated' | 'notSupplied';

export interface SuppliedContextVerification {
  state: SuppliedContextState;
  /** The digest the manifest froze. Empty when no context was supplied for this case. */
  expectedDigest: string;
  observedDigest: string;
  expectedCharacterCount: number;
  observedCharacterCount: number;
  detail: string;
}

/**
 * Verify that the context the request actually carried is byte-identical to the context the
 * manifest froze.
 *
 * `assembled` is what the adapter is about to send — read back out of the assembled request, not
 * out of the case definition, because the case definition is the thing being checked against.
 * Checking the case against itself would pass in exactly the situation this exists to catch.
 */
export function verifySuppliedContext(frozenContext: string | undefined, assembled: string | undefined): SuppliedContextVerification {
  if (frozenContext === undefined || frozenContext.length === 0) {
    if (assembled !== undefined && assembled.length > 0) {
      return {
        state: 'mutated', expectedDigest: '', observedDigest: sha256Text(assembled),
        expectedCharacterCount: 0, observedCharacterCount: assembled.length,
        detail: 'the case supplies no context, but the assembled request carries one; the harness added something the manifest never froze',
      };
    }
    return {
      state: 'notSupplied', expectedDigest: '', observedDigest: '',
      expectedCharacterCount: 0, observedCharacterCount: 0,
      detail: 'this case supplies no context, so there is nothing to verify',
    };
  }

  const expectedDigest = sha256Text(frozenContext);
  if (assembled === undefined || assembled.length === 0) {
    return {
      state: 'absent', expectedDigest, observedDigest: '',
      expectedCharacterCount: frozenContext.length, observedCharacterCount: 0,
      detail: 'the assembled request carries no supplied context; the model was asked a context question without the context, so any answer measures guessing rather than retrieval',
    };
  }

  const observedDigest = sha256Text(assembled);
  if (observedDigest === expectedDigest) {
    return {
      state: 'intact', expectedDigest, observedDigest,
      expectedCharacterCount: frozenContext.length, observedCharacterCount: assembled.length,
      detail: 'the supplied context reached the request byte for byte',
    };
  }

  // Truncation is named separately from mutation because it has a different cause and a different
  // fix: a truncated context is a budget problem, a mutated one is a transport problem.
  if (frozenContext.startsWith(assembled)) {
    return {
      state: 'truncated', expectedDigest, observedDigest,
      expectedCharacterCount: frozenContext.length, observedCharacterCount: assembled.length,
      detail: `the supplied context was cut short at ${assembled.length} of ${frozenContext.length} characters; the model never saw the rest, so a retrieval failure here is the budget's, not the model's`,
    };
  }
  return {
    state: 'mutated', expectedDigest, observedDigest,
    expectedCharacterCount: frozenContext.length, observedCharacterCount: assembled.length,
    detail: 'the supplied context that reached the request is not the one the manifest froze; the transport changed the bytes, so this attempt measures the harness rather than the model',
  };
}

export function suppliedContextIsUsable(verification: SuppliedContextVerification): boolean {
  return verification.state === 'intact' || verification.state === 'notSupplied';
}

// MARK: - Model identity verification

export type ModelIdentityState = 'verified' | 'mismatch' | 'unverifiable';

/** What the manifest pinned about a model, before any request was made. */
export interface PinnedModelIdentity {
  name: string;
  modelID: string;
  runtimeDigest: string;
  parameterSize: string;
  quantization: string;
}

/** What the runtime says right now, when asked. Any field the runtime does not report is undefined. */
export interface ObservedModelIdentity {
  name?: string;
  modelID?: string;
  runtimeDigest?: string;
  parameterSize?: string;
  quantization?: string;
  /**
   * What the runtime says this model can do ('completion', 'tools', 'thinking', 'vision', …).
   * Undefined means the runtime did not say — which is different from saying "it cannot".
   */
  capabilities?: string[];
}

export interface ModelIdentityVerification {
  state: ModelIdentityState;
  pinned: PinnedModelIdentity;
  observed: ObservedModelIdentity;
  mismatches: { field: string; pinned: string; observed: string }[];
  /** Fields the runtime declined to report. Not a mismatch — but not a verification either. */
  unreported: string[];
  detail: string;
}

/**
 * Compare the pinned identity to what the runtime reports.
 *
 * A field the runtime does not report is recorded as UNREPORTED, never as a match. That is the
 * whole discipline: "the runtime did not tell us" and "the runtime told us it is the same" are
 * different facts, and a verification that conflates them is not a verification. An identity is
 * `verified` only when the runtime digest — the one field that actually identifies the weights —
 * was reported and matched.
 */
export function verifyModelIdentity(pinned: PinnedModelIdentity, observed: ObservedModelIdentity): ModelIdentityVerification {
  const mismatches: { field: string; pinned: string; observed: string }[] = [];
  const unreported: string[] = [];
  const fields: (keyof PinnedModelIdentity)[] = ['name', 'modelID', 'runtimeDigest', 'parameterSize', 'quantization'];

  for (const field of fields) {
    const pinnedValue = pinned[field];
    const observedValue = observed[field];
    if (pinnedValue === '') continue; // nothing was pinned for this field, so there is nothing to contradict
    if (observedValue === undefined || observedValue === '') { unreported.push(field); continue; }
    if (observedValue !== pinnedValue) mismatches.push({ field, pinned: pinnedValue, observed: observedValue });
  }

  if (mismatches.length > 0) {
    return {
      state: 'mismatch', pinned, observed, mismatches, unreported,
      detail: `the runtime is serving different weights than the ones pinned: ${mismatches.map((m) => `${m.field} is ${m.observed}, not ${m.pinned}`).join('; ')}`,
    };
  }
  if (pinned.runtimeDigest !== '' && !unreported.includes('runtimeDigest')) {
    return {
      state: 'verified', pinned, observed, mismatches, unreported,
      detail: unreported.length === 0
        ? 'every pinned field was reported by the runtime and matched'
        : `the runtime digest was reported and matched; the runtime did not report ${unreported.join(', ')}`,
    };
  }
  return {
    state: 'unverifiable', pinned, observed, mismatches, unreported,
    detail: pinned.runtimeDigest === ''
      ? 'no runtime digest was pinned for this model, so its weights cannot be verified — nothing contradicts the pin, but nothing confirms it either'
      : 'the runtime did not report a digest for the loaded model, so its weights cannot be verified — nothing contradicts the pin, but nothing confirms it either',
  };
}

/** A mismatch poisons the attempt. An unverifiable identity does not — it is recorded and carried. */
export function identityPermitsExecution(verification: ModelIdentityVerification): boolean {
  return verification.state !== 'mismatch';
}

// MARK: - Thinking-mode preflight

export type ThinkingModeState =
  /** The runtime reports the capability the frozen mode needs. */
  | 'supported'
  /** The runtime reports its capabilities and the needed one is not among them. */
  | 'unsupported'
  /** The runtime reports no capability list, so nothing here can be confirmed either way. */
  | 'unverifiable'
  /** The frozen mode needs no capability (thinking off, or left to the runtime). */
  | 'notRequired';

export interface ThinkingModeVerification {
  state: ThinkingModeState;
  frozenMode: string;
  reportedCapabilities?: string[];
  detail: string;
}

/**
 * Check the runtime can actually do what the manifest froze — BEFORE the request, not after.
 *
 * The rule this enforces is "fail preflight rather than substitute". A campaign frozen with
 * thinking enabled, run against a model that cannot think, must stop; it must never quietly send
 * the request with thinking off and record the answers as though the frozen configuration had been
 * honoured. Those answers would be real answers to a different experiment.
 *
 * A runtime that reports NO capability list is `unverifiable`, not `unsupported`. "It did not tell
 * us" and "it told us it cannot" are different facts, and only the second is grounds to refuse —
 * the same discipline `verifyModelIdentity` applies to the weights.
 */
export function verifyThinkingMode(frozenMode: string, observed: ObservedModelIdentity): ThinkingModeVerification {
  if (frozenMode !== 'enabled') {
    return {
      state: 'notRequired',
      frozenMode,
      reportedCapabilities: observed.capabilities,
      detail: frozenMode === 'disabled'
        ? 'thinking is frozen off, which every model supports'
        : 'thinking is frozen to the runtime default, which asks the runtime for nothing in particular',
    };
  }
  if (observed.capabilities === undefined) {
    return {
      state: 'unverifiable',
      frozenMode,
      detail: 'thinking is frozen on, and the runtime reported no capability list for this model; nothing contradicts the request, but nothing confirms it either',
    };
  }
  if (observed.capabilities.includes('thinking')) {
    return {
      state: 'supported',
      frozenMode,
      reportedCapabilities: observed.capabilities,
      detail: 'the runtime reports this model can think, which is what the manifest froze',
    };
  }
  return {
    state: 'unsupported',
    frozenMode,
    reportedCapabilities: observed.capabilities,
    detail: `this campaign was frozen with thinking ON, and the runtime reports that ${observed.modelID ?? observed.name ?? 'this model'} `
      + `cannot think (it reports: ${observed.capabilities.join(', ') || 'nothing'}). The frozen configuration cannot be honoured, and `
      + 'running with thinking off instead would record answers to a different experiment under this manifest.',
  };
}

/** Only a reported, positive absence stops a campaign. An unreported capability list does not. */
export function thinkingModePermitsExecution(verification: ThinkingModeVerification): boolean {
  return verification.state !== 'unsupported';
}
