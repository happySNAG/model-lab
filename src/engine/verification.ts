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
