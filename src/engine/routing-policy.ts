// Benchmark engine · WHAT MAY BE ROUTED TO, as a VERSIONED policy — so that changing the answer does
// not change what an earlier answer said.
//
// THE PROBLEM THIS EXISTS TO SOLVE. Pass 6 and Pass 7 approved the identity exception on a written
// condition: a candidate admitted under `requestAcceptedIdentityUnverifiable` is measured in full and
// is NEVER a routing target. That condition is recorded in `identity-admission.ts`, in sealed campaign
// manifests, and in approval documents that are signed and dated. Pass 8 decides the opposite — that
// such a route MAY be an Ordra candidate under stated conditions — and the naive way to ship that
// decision is to edit `isRoutable`. That would be wrong in a way that is hard to undo: every sealed
// record that says "this route is not routable, under the policy in force" would silently start being
// read under a policy that did not exist when it was written, and the repository would no longer be
// able to say what it had promised on the day it promised it.
//
// SO THE POLICY IS A VALUE WITH A VERSION, AND BOTH VERSIONS SHIP.
//
//   crp1  THE PASS 6/7 POLICY. Identity-admitted routes are never routing targets. Preserved here
//         VERBATIM and still evaluable: pass `crp1` and you get exactly the refusal the approvals
//         describe, today, in this build. `identity-admission.ts` is untouched — `isRoutable` still
//         returns false for an admitted state, because that function IS the crp1 rule and sealed
//         records cite it by name.
//   crp2  THE PASS 8 POLICY. An identity-admitted route MAY be routed, and only when NINE conditions
//         all hold. It supersedes crp1 PROSPECTIVELY: it governs decisions made from its approval
//         date forward and re-decides nothing that was decided before it.
//
// SUPERSESSION IS NOT ERASURE, AND THIS IS THE RULE THE WHOLE MODULE IS BUILT AROUND. A superseded
// policy keeps its own text, its own version, its own approval and its own verdicts. Nothing here
// rewrites a historical record, and `supersededBy` on crp1 is a forward pointer a reader follows —
// not a redirection that changes what crp1 says.
//
// IDENTITY IS NEVER UPGRADED BY BEING ROUTED. Under crp2 an admitted route is routable AND still
// reports `identityConfidence: unverifiable…`. A route that may be used is not a route that has been
// verified, and every candidate carrying one of these says so in the same breath as the permission.

import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, isRoutable } from './identity-admission';
import { IdentityConfidence } from './model-description';

export type RoutingPolicyVersion = 'crp1' | 'crp2';

/** The version a caller gets when it does not name one. Pass 8 forward, this is crp2. */
export const CURRENT_ROUTING_POLICY_VERSION: RoutingPolicyVersion = 'crp2';

/** The identity confidences that mean "nobody can say which model answered". */
export const UNVERIFIABLE_IDENTITY_CONFIDENCES: IdentityConfidence[] = [
  'unverifiableSubstitutionDetectable',
  'unverifiableSubstitutionUndetectable',
];

export function isUnverifiableIdentity(confidence: IdentityConfidence): boolean {
  return UNVERIFIABLE_IDENTITY_CONFIDENCES.includes(confidence);
}

/**
 * The nine conditions crp2 requires of an identity-admitted route, as a closed vocabulary.
 *
 * Named rather than numbered at the call site, because a reader who meets `identityAdmissionCurrent`
 * in an exclusion reason learns something, and one who meets "condition 6" has to come back here.
 */
export type RoutableCondition =
  | 'currentlyDiscovered'
  | 'availableOnRequestedMachine'
  | 'discoveryFresh'
  | 'qualificationEvidenceFresh'
  | 'sufficientCapabilityEvidence'
  | 'identityAdmissionCurrent'
  | 'spendPostureAllows'
  | 'noProviderStateBlocks'
  | 'taskDoesNotRequireVerifiedIdentity';

export const ROUTABLE_CONDITIONS: RoutableCondition[] = [
  'currentlyDiscovered',
  'availableOnRequestedMachine',
  'discoveryFresh',
  'qualificationEvidenceFresh',
  'sufficientCapabilityEvidence',
  'identityAdmissionCurrent',
  'spendPostureAllows',
  'noProviderStateBlocks',
  'taskDoesNotRequireVerifiedIdentity',
];

/** What each condition means, in the words an exclusion reason is built from. */
export const ROUTABLE_CONDITION_DESCRIPTIONS: Record<RoutableCondition, string> = {
  currentlyDiscovered: 'the route is named by the current discovery of the provider that serves it',
  availableOnRequestedMachine: 'an observation taken ON the requested machine says the route is reachable from it',
  discoveryFresh: 'that discovery is inside its freshness window, not carried forward from an old refresh',
  qualificationEvidenceFresh: 'the qualification evidence still describes the route that exists now — no material change, no expiry',
  sufficientCapabilityEvidence: 'the route is QUALIFIED for the capability asked about, at the tier asked about',
  identityAdmissionCurrent: 'the identity admission this route runs under is valid and unexpired',
  spendPostureAllows: 'who pays is established and the billing posture permits execution',
  noProviderStateBlocks: 'no recorded provider refusal, throttle or session state currently blocks execution',
  taskDoesNotRequireVerifiedIdentity: 'the task did not ask for verified model identity (`requireVerifiedIdentity`)',
};

export interface RoutingPolicy {
  version: RoutingPolicyVersion;
  /** The pass, decision, date and authority that put this version in force. */
  approval: {
    readonly pass: string;
    readonly decision: string;
    readonly approvedAt: string;
    readonly approvedBy: string;
  };
  /** May a route whose served identity cannot be independently verified be a routing candidate? */
  identityAdmittedRoutesMayBeRouted: boolean;
  /** When `identityAdmittedRoutesMayBeRouted`, every condition that must ALSO hold. */
  conditions: RoutableCondition[];
  /** The version this one replaced, and the one that replaced it. Both are forward/back POINTERS only. */
  supersedes?: RoutingPolicyVersion;
  supersededBy?: RoutingPolicyVersion;
  /** The policy in full, in the words a surface prints. */
  statement: string;
}

/**
 * crp1 — THE PASS 6/7 POLICY, PRESERVED.
 *
 * Do not edit this value to reflect a later decision. Its whole purpose is to still say, in this
 * build, exactly what the approvals of 2026-09-13 and 2026-09-20 said. A record written under crp1 is
 * read under crp1.
 */
export const ROUTING_POLICY_CRP1: RoutingPolicy = {
  version: 'crp1',
  approval: {
    pass: 'Cernum Pass 6, extended by Pass 7',
    decision: '1(b) — admit identity-unverifiable candidates for MEASUREMENT ONLY; routing never consults one',
    approvedAt: '2026-09-13',
    approvedBy: 'the repository owner, in writing, in the Pass 6 approval prompt; extended to opencodeCLI on 2026-09-20',
  },
  identityAdmittedRoutesMayBeRouted: false,
  conditions: [],
  supersededBy: 'crp2',
  statement:
    'A candidate admitted under the accepted-request identity exception is measured in full and published in full, and is '
    + 'NEVER a routing target. The provider accepted an identifier and something answered; nothing named what. A routing '
    + 'decision made on that basis is a decision about a model nobody can name. See `isRoutable`, which is this rule.',
};

/**
 * crp2 — THE PASS 8 POLICY.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A REVERSAL OF THE REASONING. crp1's argument was that a routing
 * decision needs to know which model it is choosing. That argument holds for PROVENANCE-SENSITIVE
 * work and does not hold for ordinary coding, where what the operator needs is a route that has been
 * measured doing the work and is available and paid for. crp2 splits those two cases instead of
 * choosing between them: routing is permitted by default, and a task that genuinely needs to name the
 * model asks for `requireVerifiedIdentity` and gets crp1's refusal back, per query, with its reason.
 *
 * WHAT DID NOT CHANGE. The identity is still unverifiable and is still reported as unverifiable on
 * every candidate, every exclusion and every surface. Routing an admitted route does not verify it,
 * does not promote it, and does not make it citable as "this model did the work".
 */
export const ROUTING_POLICY_CRP2: RoutingPolicy = {
  version: 'crp2',
  approval: {
    pass: 'Cernum Pass 8',
    decision: 'Decision 1 — identity-admitted Codex and OpenCode routes MAY be Ordra routing candidates when every '
      + 'condition in `conditions` holds; a task may still demand verified identity per query',
    approvedAt: '2026-09-22',
    approvedBy: 'the repository owner, in writing, in the Pass 8 governance prompt',
  },
  identityAdmittedRoutesMayBeRouted: true,
  conditions: ROUTABLE_CONDITIONS,
  supersedes: 'crp1',
  statement:
    'A route whose exact served-model identity cannot be independently verified MAY be a routing candidate, and only when '
    + 'ALL of these hold: it is currently discovered; it is available on the requested machine; that discovery is fresh; its '
    + 'qualification evidence is fresh; it has sufficient capability-specific evidence for the requested task; its identity '
    + 'admission is valid and current; the billing posture allows execution; no provider or session state blocks execution; '
    + 'and the task does not require verified model identity. It continues to report identity as ADMITTED/UNVERIFIABLE and is '
    + 'never represented as verified. This supersedes crp1 PROSPECTIVELY: records decided under crp1 keep crp1\'s verdict and '
    + 'crp1\'s wording.',
};

export const ROUTING_POLICIES: Record<RoutingPolicyVersion, RoutingPolicy> = {
  crp1: ROUTING_POLICY_CRP1,
  crp2: ROUTING_POLICY_CRP2,
};

export function routingPolicy(version: RoutingPolicyVersion = CURRENT_ROUTING_POLICY_VERSION): RoutingPolicy {
  return ROUTING_POLICIES[version];
}

/**
 * The sentence a surface prints beside a routable identity-admitted route.
 *
 * Deliberately says the permission and the limit in one breath, because a reader who is told only the
 * first has been told the misleading half.
 */
export const ROUTED_BUT_NOT_VERIFIED =
  'This route may be routed under routing policy crp2, and its served-model identity remains UNVERIFIABLE. The provider '
  + 'accepted the identifier and something answered; nothing named what. Measurements attributed to it mean "what answered '
  + 'when this identifier was requested", never "this model answered". A task that needs the model named must ask for '
  + 'requireVerifiedIdentity, which excludes this route and says so.';

/** Why a verified-identity task excludes this route. One wording, so no surface softens it. */
export function verifiedIdentityExclusionReason(routeKey: string, confidence: IdentityConfidence): string {
  return `identity: ${routeKey} is admitted, not verified (${confidence}) — this query set requireVerifiedIdentity, which `
    + 'admits only routes whose served-model identity is independently established. '
    + `${confidence === 'unverifiableSubstitutionUndetectable'
      ? 'On this path a substitution would not even be DETECTABLE, let alone reported.'
      : 'This tool reports a substitution when one happens, but never names the model that answered.'}`;
}

/** Why crp1 excludes this route. The Pass 6/7 wording, unchanged. */
export function crp1ExclusionReason(routeKey: string): string {
  return `identity: ${routeKey} ran under the accepted-request identity exception. Routing policy crp1 (Pass 6/7) admits no `
    + 'such route as a routing target, whatever else is established about it.';
}

/**
 * Does `policy` permit routing a route in this identity state at all?
 *
 * `admitted` is the structural fact — a run of this route carried `requestAcceptedIdentityUnverifiable`,
 * or its description says the identity is unverifiable. `requireVerifiedIdentity` is the QUERY's demand.
 * The two are kept apart so an exclusion can say which one refused.
 */
export function identityPermitsRouting(options: {
  policy: RoutingPolicy;
  routeKey: string;
  admitted: boolean;
  identityConfidence: IdentityConfidence;
  requireVerifiedIdentity: boolean;
}): { permitted: boolean; reason: string } {
  const unverifiable = options.admitted || isUnverifiableIdentity(options.identityConfidence);
  if (!unverifiable) {
    return { permitted: true, reason: `identity is established (${options.identityConfidence})` };
  }
  if (options.requireVerifiedIdentity) {
    return { permitted: false, reason: verifiedIdentityExclusionReason(options.routeKey, options.identityConfidence) };
  }
  if (!options.policy.identityAdmittedRoutesMayBeRouted) {
    return { permitted: false, reason: crp1ExclusionReason(options.routeKey) };
  }
  return { permitted: true, reason: ROUTED_BUT_NOT_VERIFIED };
}

/**
 * The crp1 rule, evaluated through the function sealed records cite.
 *
 * Present so that "crp1 still refuses what it always refused" is provable against `isRoutable` itself
 * rather than against a second copy of the rule that could drift from it.
 */
export function crp1RefusesAdmittedState(state: string): boolean {
  return state === REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE && !isRoutable(state as 'verified');
}
