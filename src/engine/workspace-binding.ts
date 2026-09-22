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
import {
  IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionFor, admissionProvenance,
} from './identity-admission';
import {
  ZeroMarginalCostConfirmation, validateZeroMarginalCostConfirmation, zeroMarginalCostConfirmationFreshness,
} from './cost-eligibility';

/** One installed local model, as discovery reported it. The digest is its identity. */
export interface LocalModelIdentitySource {
  modelID: string;
  runtimeDigest: string;
}

/**
 * What this machine's runtime says about a LOCAL route, as a pre-run identity.
 *
 * `verified` ONLY WITH A DIGEST, exactly as `localOllamaBinding` has always decided it: a model the
 * runtime reported a weights digest for is identified by those weights; one it did not is not. A model
 * the runtime does not list at all is `nothing` — never a digest carried over from another machine.
 */
export function resolveLocalPreRunIdentity(installed: LocalModelIdentitySource[], modelID: string): PreRunIdentity {
  const found = installed.find((model) => model.modelID === modelID);
  if (found === undefined) {
    return { state: 'unverifiable', verifiedModelID: '', resolvedFrom: 'nothing',
      evidence: `the local runtime on this machine does not list ${modelID}. Discovery is authoritative, and a local model `
        + 'is never assumed installed because it was installed somewhere else.' };
  }
  if (found.runtimeDigest.length === 0) {
    return { state: 'unverifiable', verifiedModelID: '', resolvedFrom: 'nothing',
      evidence: `the local runtime lists ${modelID} and reports no weights digest for it, so nothing establishes which weights answer.` };
  }
  return { state: 'verified', verifiedModelID: modelID, resolvedFrom: 'localRuntimeDigest',
    evidence: `the local runtime on this machine reported weights digest ${found.runtimeDigest} for ${modelID}; inference runs on `
      + 'this machine, so the digest — not a remote identity admission — is what identifies the model' };
}

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
  /**
   * `identityAdmission` is the ONE route by which a route nobody proved reaches a workspace run: a
   * person's sealed, campaign-bound authorization, under the Pass 6 exception, for `codexCLI` only.
   * It never produces `verified`, and it never fills `verifiedModelID`.
   */
  resolvedFrom: 'discoveryStore' | 'nothing' | 'identityAdmission' | 'localRuntimeDigest';
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

/**
 * Apply a sealed identity admission to what the store said, or leave it exactly as it was.
 *
 * STRONGER EVIDENCE WINS, as in `buildCampaignPlan`: a route the store has PROVEN is returned
 * untouched, and an admission that was not needed downgrades nothing. Otherwise the admission is read
 * through `admissionFor` — the same gate a prose campaign uses — whose default is refusal: no record, a
 * record for another campaign, a broken seal, or a configuration it does not name all leave the route
 * unproven, and `buildWorkspaceBinding` then refuses it as it always did.
 *
 * What an admitted route becomes is `requestAcceptedIdentityUnverifiable`, with an EMPTY verified
 * model. The requested identifier is never copied anywhere a returned one belongs.
 */
export function admitPreRunIdentity(identity: PreRunIdentity, request: {
  provider: ProviderID; modelID: string; effort: EffortLevel; campaignLabel: string; admission?: IdentityAdmission;
}): { identity: PreRunIdentity; admissionReason?: string } {
  if (identity.state === 'verified' || request.admission === undefined) return { identity };
  const decision = admissionFor({
    provider: request.provider, modelID: request.modelID, effort: request.effort,
    campaignLabel: request.campaignLabel, admission: request.admission,
  });
  if (!decision.admitted || decision.evidence === undefined) return { identity, admissionReason: decision.reason };
  return {
    identity: {
      state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      verifiedModelID: '',
      evidence: admissionProvenance(decision.evidence).join(' · '),
      resolvedFrom: 'identityAdmission',
      // NO `provenAt`: nothing was proven. The smoke evidence's capture time is in `evidence`, where it
      // is labelled for what it is, rather than in a field every surface prints as "proven <date>".
    },
    admissionReason: decision.reason,
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
  /**
   * The signed observation that this METERED route costs this account nothing at the margin. The only
   * thing that lets a metered route run a workspace task, which carries no token ceiling. Validated in
   * full here — every field, the published-price tells, the exact route, and its age.
   */
  zeroMarginalCost?: ZeroMarginalCostConfirmation;
  /** The weights digest of a LOCAL route, from this machine's runtime. Required for `ollama`. */
  localModelDigest?: string;
  now?: Date;
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
  const admitted = request.identity.state === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
    && request.identity.resolvedFrom === 'identityAdmission';
  if (request.provider === 'ollama') {
    // A LOCAL ROUTE IS IDENTIFIED BY ITS WEIGHTS, and the digest the binding freezes must be the one the
    // identity was resolved from — a digest supplied separately from the identity would be two claims.
    if (request.identity.resolvedFrom !== 'localRuntimeDigest' || (request.localModelDigest ?? '').length === 0
        || !request.identity.evidence.includes(request.localModelDigest ?? '\u0000')) {
      throw new WorkspaceBindingError('localIdentityUnresolved',
        `${request.modelID} is a local route, and a local workspace run is bound to the weights digest this machine's runtime `
        + `reports. ${request.identity.evidence}`);
    }
  }
  if (request.zeroMarginalCost !== undefined) {
    const confirmation = request.zeroMarginalCost;
    validateZeroMarginalCostConfirmation(confirmation);
    if (confirmation.provider !== request.provider || confirmation.modelID !== request.modelID) {
      throw new WorkspaceBindingError('zeroMarginalCostForAnotherRoute',
        `the zero-marginal-cost confirmation names ${confirmation.provider}:${confirmation.modelID}, not `
        + `${request.provider}:${request.modelID}. A confirmation is about one route on one account.`);
    }
    const freshness = zeroMarginalCostConfirmationFreshness(confirmation, request.now ?? new Date());
    if (!freshness.fresh) throw new WorkspaceBindingError('zeroMarginalCostStale', freshness.reason);
  }
  if (request.identity.state !== 'verified' && !admitted) {
    // THE SAME REFUSAL `buildCampaignPlan` MAKES, on the same evidence, for the same reason. A model
    // nobody proved this account can call must not be spendable on, and must not be recorded as
    // having answered. The workspace contract relaxes the BUDGET rule and nothing else.
    throw new WorkspaceBindingError('unprovenRoute',
      `${request.modelID} on ${request.provider} has not been proven callable by this account, so it cannot be run `
      + `against a workspace case. ${request.identity.evidence} A model identifier is a plan, not a capability: `
      + `prove it once with an identity smoke test and the proof is then read from the discovery store. A route whose `
      + 'tool can never name its model (codexCLI) can instead be admitted by a sealed identity admission — for ONE run '
      + '(`workspace`), or per exact route across ONE sealed matrix (`workspace-benchmark`) — which records it as '
      + 'requestAcceptedIdentityUnverifiable and never as verified.');
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
    ...(request.zeroMarginalCost === undefined ? {} : {
      zeroMarginalCostBasis: {
        provider: request.zeroMarginalCost.provider, modelID: request.zeroMarginalCost.modelID,
        accountBasis: request.zeroMarginalCost.accountBasis, observedBillingRecord: request.zeroMarginalCost.observedBillingRecord,
        observedAt: request.zeroMarginalCost.observedAt, confirmedBy: request.zeroMarginalCost.confirmedBy,
      },
    }),
    ...(request.provider === 'ollama' ? { localModelDigest: request.localModelDigest } : {}),
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
  if (identity.resolvedFrom === 'localRuntimeDigest') {
    return [
      `pre-run identity  ${identity.state} as ${identity.verifiedModelID} — resolved from THIS machine's local runtime`,
      `                  ${identity.evidence}`,
    ];
  }
  if (identity.resolvedFrom === 'identityAdmission') {
    return [
      `pre-run identity  ${identity.state} — ADMITTED BY A SEALED IDENTITY ADMISSION, NOT PROVEN`,
      '                  the tool accepted this identifier and something answered when it was smoke-tested; nothing',
      '                  has established WHICH model answers. The returned model is empty and stays empty.',
      `                  ${identity.evidence}`,
    ];
  }
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
