// Benchmark engine · the binding one WORKSPACE run is executed under, built once and validated
// where it is built.
//
// WHY THIS IS A BUILDER AND NOT A LITERAL. `smoke-binding.ts` exists because the smoke path was the
// one binding-building route in this engine that never ran `validateBinding`, and a preview and a
// live request consequently described two different things. The first workspace run repeated the
// shape of that defect from the other end: it assembled a binding by hand in a scratchpad script,
// and `validateBinding` refused the result — so the proof ran a binding that the engine's own
// validator said was invalid, and the reason was a rule about PROSE budgets applied to a contract
// that has none. Both halves of that are fixed here. There is one builder, it produces a binding
// that declares its contract explicitly, and it validates what it produced before returning it.
//
// WHAT IT RESOLVES, AND FROM WHERE
//
//   IDENTITY comes from the discovery store this machine already has — the same file
//   `buildCampaignPlan` reads, through the same `selectableFromStore`. It is NOT a second cache, and
//   there is deliberately no new one: `claude-haiku-4-5` was proven by an identity smoke on this
//   machine, that proof lives in `.providers/discovered.json` with the moment it was established,
//   and it EXPIRES. A workspace run that started from `unverifiable` while a live, execution-backed
//   proof for the exact `provider:model` route sat on disk would be recording less than is known.
//
//   THE BUDGETS come from the contract and not from a number somebody picked. A workspace request
//   has nowhere to carry a provider-side token ceiling — see `CLAUDE_OUTPUT_IS_NOT_BOUNDED` — so the
//   binding says so, in `tokenCeiling`, and names none. See `WORKSPACE_TOKEN_CEILING_IS_UNEXPRESSED`.
//
// WHAT IT REFUSES, AND WHY THE EXCEPTION BUYS NOTHING. The token-ceiling exception relaxes the
// BUDGET rule and nothing else. An unproven route is refused here exactly as `buildCampaignPlan`
// refuses one; a provider mismatch, a wrong execution class, a wrong authorization mode, a metered
// binding without pricing and every identity rule are all enforced by the same `validateBinding`
// call every other binding in this engine passes through.

import { DiscoveredFrontierModel } from './discovery';
import { DiscoveryEvidence, selectableFromStore } from './discovery-store';
import { ThinkingMode } from './execution';
import {
  EffortLevel, NO_RETRY, PricingSnapshot, ProviderBinding, ProviderBindingError, ProviderID,
  authorizationModeForProvider, billingBasisOf, executionClassOf, validateBinding,
} from './provider';
import { WorkspaceCase } from './workspace-case';

export class WorkspaceBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceBindingError';
  }
}

/**
 * What was known about this route BEFORE the request, and where that came from.
 *
 * Returned beside the binding rather than only folded into it, so a preflight can print the
 * provenance without re-reading the store and a record can seal it. `resolvedFrom` is the answer to
 * "which mechanism established this", and there is exactly one mechanism that can say `proven`.
 */
export interface PreRunIdentity {
  state: ProviderBinding['identityState'];
  verifiedModelID: string;
  evidence: string;
  resolvedFrom: 'discoveryStore' | 'nothing';
  /** When the proof was established, ISO-8601, when there was one. */
  provenAt?: string;
}

/**
 * Resolve what this machine already knows about a `provider:model` route.
 *
 * READS THE SAME EVIDENCE A CAMPAIGN READS, through the same expiry rule: a proof older than
 * `DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS` is not selectable, because a lineup can change and a
 * stale proof spends a run's allowance discovering that it has.
 */
export function resolvePreRunIdentity(evidence: DiscoveryEvidence, provider: ProviderID, modelID: string,
                                      now = new Date()): PreRunIdentity {
  const { selectable } = selectableFromStore(evidence, now);
  const proven = selectable.find((model) => model.provider === provider && model.modelID === modelID);
  if (proven === undefined) {
    return {
      state: 'unverifiable',
      verifiedModelID: '',
      evidence: `nothing on this machine establishes that this account can call ${modelID} on ${provider}: the `
        + 'discovery store holds no unexpired identity proof for that exact route.',
      resolvedFrom: 'nothing',
    };
  }
  return {
    // `verified` ONLY when the proof named a model. A row proven with an empty returned identifier
    // established that something answered and not which model did, and it is recorded as such.
    state: proven.verifiedModelID.length > 0 ? 'verified' : 'unverifiable',
    verifiedModelID: proven.verifiedModelID,
    evidence: proven.evidence,
    resolvedFrom: 'discoveryStore',
    provenAt: proven.discoveredAt,
  };
}

export interface WorkspaceBindingRequest {
  /** The candidate name this run records. A model at two efforts is two candidates, as ever. */
  candidate: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  thinkingMode?: ThinkingMode;
  /**
   * The per-attempt deadline, in milliseconds. Taken from the CASE unless an operator narrows it.
   *
   * On the binding as well as in the case because `validateBinding` refuses a binding with no
   * timeout, and because a reader of the envelope alone should be able to see what bounded the run.
   */
  timeoutMilliseconds: number;
  /** Required for a metered provider; `validateBinding` refuses one without it. */
  pricing?: PricingSnapshot;
  /** What discovery proved. Read through `resolvePreRunIdentity`; never bypassed. */
  identity: PreRunIdentity;
}

/**
 * The binding a workspace run executes under, validated before it is returned.
 *
 * Throws `WorkspaceBindingError` for the things this builder decides and re-throws
 * `ProviderBindingError` untouched for the things the shared validator decides — so a refusal
 * always names the rule that produced it rather than being re-worded here.
 */
export function buildWorkspaceBinding(request: WorkspaceBindingRequest): ProviderBinding {
  if (request.modelID.trim().length === 0) {
    throw new WorkspaceBindingError('noModelRequested',
      'a workspace run with no model identifier asks nobody to do the work. Name the model.');
  }
  if (request.identity.state !== 'verified') {
    // THE SAME REFUSAL `buildCampaignPlan` MAKES, on the same evidence, for the same reason. A model
    // nobody proved this account can call must not be spendable on, and must not be recorded as
    // having answered. The workspace contract relaxes the BUDGET rule and nothing else.
    throw new WorkspaceBindingError('unprovenRoute',
      `${request.modelID} on ${request.provider} has not been proven callable by this account, so it cannot be run `
      + `against a workspace case. ${request.identity.evidence} A model identifier is a plan, not a capability: `
      + `prove it once with an identity smoke test and the proof is then read from the discovery store.`);
  }

  const executionClass = executionClassOf(request.provider);
  const binding: ProviderBinding = {
    candidate: request.candidate,
    provider: request.provider,
    executionClass,
    requestedModelID: request.modelID,
    identityState: request.identity.state,
    verifiedModelID: request.identity.verifiedModelID,
    identityEvidence: request.identity.evidence,
    effort: request.effort,
    thinkingMode: request.thinkingMode ?? 'runtimeDefault',
    sampling: { temperatureMilli: null, topPMilli: null, seed: null },
    // THE TWO FIELDS THIS WHOLE MODULE EXISTS FOR. The contract says what shape of request this is;
    // the ceiling declaration says the contract has nowhere to put one. `validateBinding` then
    // requires the budgets below to be exactly zero, so the zero is a consequence of a declaration
    // rather than a magic value somebody has to recognise.
    executionContract: 'workspaceTask',
    tokenCeiling: 'notExpressibleByContract',
    maxInputTokens: 0,
    maxOutputTokens: 0,
    timeoutMilliseconds: request.timeoutMilliseconds,
    // THE RUNNER OWNS ATTEMPTS, not `withRetry`: each one needs a fresh workspace, which a request
    // retry cannot make. A retry policy here would be a second, invisible attempt loop.
    retry: NO_RETRY,
    billingBasis: billingBasisOf(executionClass),
    pricing: request.pricing ?? null,
    authorizationMode: authorizationModeForProvider(request.provider),
  };

  // VALIDATED WHERE IT IS BUILT. Every caller — the preflight, the durable record, the live run —
  // reads this one object, so a preview cannot describe a binding other than the one that executes.
  validateBinding(binding);
  return binding;
}

/** The per-attempt deadline a run actually uses: the case's, unless an operator asked for less. */
export function workspaceTimeoutFor(workspaceCase: WorkspaceCase, operatorTimeoutMilliseconds?: number): number {
  if (operatorTimeoutMilliseconds === undefined) return workspaceCase.execution.timeoutMilliseconds;
  if (operatorTimeoutMilliseconds < 1) {
    throw new WorkspaceBindingError('nonPositiveTimeout',
      `a timeout of ${operatorTimeoutMilliseconds} ms would stop every attempt before it started`);
  }
  // NEVER RAISES THE CASE'S OWN DEADLINE, exactly as the attempt ceiling never raises its own
  // attempt count: an operator may narrow what a frozen case allows and may not widen it.
  return Math.min(operatorTimeoutMilliseconds, workspaceCase.execution.timeoutMilliseconds);
}

/** The lines a preflight prints about what was known before the request. Rendered in one place. */
export function describePreRunIdentity(identity: PreRunIdentity): string[] {
  if (identity.resolvedFrom === 'nothing') {
    return [
      'pre-run identity  NOTHING PROVEN — no unexpired proof for this route is on this machine',
      `                  ${identity.evidence}`,
    ];
  }
  return [
    `pre-run identity  ${identity.state}${identity.verifiedModelID.length > 0 ? ` as ${identity.verifiedModelID}` : ''}`
      + ` · resolved from the discovery store, proven ${identity.provenAt ?? '(undated)'}`,
    '                  this is what was known BEFORE the request. What the request itself establishes is recorded',
    '                  separately, afterwards, as the execution identity verdict.',
  ];
}

/** Bindings this builder produced that a provider registry would refuse. Re-exported for the tests. */
export { ProviderBindingError };

/** Convenience for a caller that has a store on disk rather than a parsed evidence object. */
export function preRunIdentityFrom(models: DiscoveredFrontierModel[], writtenAt: string,
                                   provider: ProviderID, modelID: string, now = new Date()): PreRunIdentity {
  return resolvePreRunIdentity({ writtenAt, models }, provider, modelID, now);
}
