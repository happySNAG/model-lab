// Pass 8, Decisions 1 and 2 · the routing policy that supersedes the Pass 6/7 restriction
// PROSPECTIVELY, the per-query verified-identity constraint, and the distance between an
// authorization to benchmark free routes and evidence that any route is free.
//
// Nothing here contacts a provider, a runtime or a network. Every input is a value.

import { describe, expect, it } from 'vitest';
import {
  CURRENT_ROUTING_POLICY_VERSION, ROUTABLE_CONDITIONS, ROUTED_BUT_NOT_VERIFIED, ROUTING_POLICY_CRP1,
  ROUTING_POLICY_CRP2, crp1RefusesAdmittedState, identityPermitsRouting, isUnverifiableIdentity, routingPolicy,
} from '../../src/engine/routing-policy';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, NEVER_AFFECTS, isRoutable } from '../../src/engine/identity-admission';
import { RouteCandidateQuery, qualifiedRouteCandidates } from '../../src/engine/routing-contract';
import { RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import {
  AUTHORIZATION_IS_NOT_EVIDENCE, NOT_SUFFICIENT_EVIDENCE_OF_ZERO_COST, ZERO_COST_BENCHMARK_AUTHORIZATION,
  ZeroCostAuthorizationError, assertConfirmationIsObserved, confirmationStaledByDelta, refuseInferenceToProveCost,
  routeIsInsideAuthorization, zeroCostEvidencePath,
} from '../../src/engine/zero-cost-authorization';
import { CostPolicyError, ZeroMarginalCostConfirmation, costEligibilityFor } from '../../src/engine/cost-eligibility';
import { DiscoveryDelta } from '../../src/engine/discovery-refresh';
import { measuredQuantity } from '../../src/engine/frontier-metrics';

const NOW = new Date('2026-09-22T12:00:00Z');
const MACHINE = 'cmk1:here';
const ROUTE = 'opencode/big-pickle';
const CAPABILITY = 'workspace:multiFileEditing';

/**
 * A record with every condition satisfied EXCEPT the ones a test deliberately breaks.
 *
 * Built by hand rather than derived from sealed rows, because these tests are about the POLICY and a
 * derivation would make each one depend on the benchmark fixtures as well. `route-qualification-and-
 * routing.test.ts` proves the derivation against real sealed records; this file proves the rules.
 */
function admittedRecord(over: Partial<RouteQualificationRecord> = {}): RouteQualificationRecord {
  return {
    schema: 'crq1',
    routeKey: `opencodeCLI:${ROUTE}`,
    provider: 'opencodeCLI',
    modelID: ROUTE,
    effort: 'none',
    policy: V1_QUALIFICATION_POLICY,
    qualificationScope: 'route',
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: 'unverifiableSubstitutionUndetectable',
    bindingIdentityStates: [REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE],
    identityAdmitted: true,
    routingPolicyVersion: 'crp2',
    identityDisclosure: ROUTED_BUT_NOT_VERIFIED,
    billing: routeSpendPosture({ provider: 'opencodeCLI', modelID: ROUTE, confirmations: [confirmation()], now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] },
      development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 6, scoredRunCount: 6, packs: ['p'], recordRoots: [] },
    },
    capabilities: [{
      capability: CAPABILITY, source: 'workspace', verdict: 'qualified', scoredRunCount: 6, successCount: 6,
      successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '6/6 scored runs passed (≥ 90%)',
    }],
    discriminator: [],
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true,
    routableCapabilities: [CAPABILITY],
    notRoutableBecause: [],
    blockers: [],
    disclosure: 'no universal score',
    ...over,
  };
}

function confirmation(over: Partial<ZeroMarginalCostConfirmation> = {}): ZeroMarginalCostConfirmation {
  return {
    provider: 'opencodeCLI', modelID: ROUTE, accountBasis: 'the configured OpenCode credential',
    observedBillingRecord: 'account usage page, September statement: $0.00 charged for this route',
    observedAt: '2026-09-21T00:00:00Z', confirmedBy: 'the repository owner', ...over,
  };
}

const query = (over: Partial<RouteCandidateQuery> = {}): RouteCandidateQuery => ({
  machineKey: MACHINE, capability: CAPABILITY, costPolicy: 'zeroMarginalCostOnly', ...over,
});

const reasonsFor = (set: ReturnType<typeof qualifiedRouteCandidates>, routeKey: string): string =>
  (set.excluded.find((entry) => entry.routeKey === routeKey)?.reasons ?? []).join(' | ');

// 1–8 ───────────────────────────────────────────────────────────────────────────────────────────────
describe('1–8 · crp2 admits an identity-admitted route, and every other condition still refuses one', () => {
  it('1 · the new policy version allows identity-admitted routes, and says so in its own statement', () => {
    expect(CURRENT_ROUTING_POLICY_VERSION).toBe('crp2');
    expect(ROUTING_POLICY_CRP2.identityAdmittedRoutesMayBeRouted).toBe(true);
    expect(ROUTING_POLICY_CRP2.supersedes).toBe('crp1');
    expect(ROUTING_POLICY_CRP2.conditions).toEqual(ROUTABLE_CONDITIONS);
    expect(ROUTING_POLICY_CRP2.conditions).toHaveLength(9);
    const set = qualifiedRouteCandidates(query(), [{ record: admittedRecord() }]);
    expect(set.routingPolicyVersion).toBe('crp2');
    expect(set.candidates.map((entry) => entry.routeKey)).toEqual([`opencodeCLI:${ROUTE}`]);
  });

  it('2 · the historical policy is unchanged, still readable, and still refuses — through isRoutable itself', () => {
    expect(ROUTING_POLICY_CRP1.identityAdmittedRoutesMayBeRouted).toBe(false);
    expect(ROUTING_POLICY_CRP1.approval.approvedAt).toBe('2026-09-13');
    expect(ROUTING_POLICY_CRP1.supersededBy).toBe('crp2');
    expect(ROUTING_POLICY_CRP1.statement).toContain('NEVER a routing target');
    // The Pass 6/7 rule is still enforced by the function sealed records cite, not by a copy of it.
    expect(isRoutable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE as 'verified')).toBe(false);
    expect(crp1RefusesAdmittedState(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(true);
    expect(NEVER_AFFECTS.join(' ')).toContain('production routing');
    // And a query that ASKS for crp1 gets crp1's refusal, in crp1's words.
    const set = qualifiedRouteCandidates(query({ routingPolicyVersion: 'crp1' }), [{ record: admittedRecord() }]);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, `opencodeCLI:${ROUTE}`)).toContain('crp1 (Pass 6/7) admits no such route');
  });

  it('3 · requireVerifiedIdentity excludes an admitted route, and names the substitution risk', () => {
    const set = qualifiedRouteCandidates(query({ requireVerifiedIdentity: true }), [{ record: admittedRecord() }]);
    expect(set.candidates).toHaveLength(0);
    const reasons = reasonsFor(set, `opencodeCLI:${ROUTE}`);
    expect(reasons).toContain('requireVerifiedIdentity');
    expect(reasons).toContain('would not even be DETECTABLE');
    // Codex is the other admissible provider, and its risk is described differently on purpose.
    const codex = admittedRecord({ routeKey: 'codexCLI:gpt-5', provider: 'codexCLI', modelID: 'gpt-5',
      identityConfidence: 'unverifiableSubstitutionDetectable' });
    expect(reasonsFor(qualifiedRouteCandidates(query({ requireVerifiedIdentity: true }), [{ record: codex }]), 'codexCLI:gpt-5'))
      .toContain('reports a substitution when one happens');
  });

  it('4 · the DEFAULT includes a properly qualified admitted route, and still reports it as unverified', () => {
    const set = qualifiedRouteCandidates(query(), [{ record: admittedRecord() }]);
    const candidate = set.candidates[0]!;
    expect(candidate.identityAdmitted).toBe(true);
    expect(candidate.identityConfidence).toBe('unverifiableSubstitutionUndetectable');
    expect(isUnverifiableIdentity(candidate.identityConfidence)).toBe(true);
    // The permission and the limit arrive together. There is no candidate shape carrying only one.
    expect(candidate.identityDisclosure).toContain('may be routed under routing policy crp2');
    expect(candidate.identityDisclosure).toContain('UNVERIFIABLE');
    expect(candidate.identityDisclosure).not.toContain('verified identity is established');
  });

  it('5 · an UNQUALIFIED admitted route is still excluded — admission never substitutes for evidence', () => {
    const unqualified = admittedRecord({
      capabilities: [{ capability: CAPABILITY, source: 'workspace', verdict: 'notQualified', scoredRunCount: 6,
        successCount: 2, successRateMilli: measuredQuantity(333), evidenceRefs: [], reason: '2/6 scored runs passed (< 90%)' }],
      routableCapabilities: [], safeToRoute: false,
    });
    const set = qualifiedRouteCandidates(query(), [{ record: unqualified }]);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, `opencodeCLI:${ROUTE}`)).toContain('is notQualified');
    // And one with NO evidence at all is excluded for absence, which is a different sentence.
    const none = admittedRecord({ capabilities: [], routableCapabilities: [], safeToRoute: false });
    expect(reasonsFor(qualifiedRouteCandidates(query(), [{ record: none }]), `opencodeCLI:${ROUTE}`))
      .toContain('no evidence at all');
  });

  it('6 · a STALE admitted route is excluded, and the staleness reason is the one reported', () => {
    const stale = admittedRecord({
      staleness: { valid: false, reasons: ['staleModelMateriallyChanged'], detail: ['price in:0/out:0 → in:300/out:1500'] },
      blockers: [{ kind: 'staleness', reason: 'price in:0/out:0 → in:300/out:1500' }],
      safeToRoute: false,
    });
    const set = qualifiedRouteCandidates(query(), [{ record: stale }]);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, `opencodeCLI:${ROUTE}`)).toContain('staleness:');
    // And a query that explicitly demands fresh qualification says so in its own words.
    const asked = qualifiedRouteCandidates(query({ requireFreshQualification: true }), [{ record: stale }]);
    expect(reasonsFor(asked, `opencodeCLI:${ROUTE}`)).toContain('requires fresh qualification evidence');
  });

  it('7 · an UNAVAILABLE admitted route is excluded, however well qualified and however free', () => {
    const unavailable = admittedRecord({
      availableOnThisMachine: { state: 'unavailable', reason: 'opencode is not installed on this machine' },
      blockers: [{ kind: 'availability', reason: 'opencode is not installed on this machine' }],
      safeToRoute: false,
    });
    const set = qualifiedRouteCandidates(query(), [{ record: unavailable }]);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, `opencodeCLI:${ROUTE}`)).toContain('not installed on this machine');
    // A route never discovered here is refused for a DIFFERENT reason, and the two stay distinct.
    const undiscovered = admittedRecord({
      discovered: { state: 'neverDiscovered', reason: 'no refresh on this machine has observed it' },
      blockers: [{ kind: 'discovery', reason: 'neverDiscovered — no refresh on this machine has observed it' }],
      safeToRoute: false,
    });
    expect(reasonsFor(qualifiedRouteCandidates(query(), [{ record: undiscovered }]), `opencodeCLI:${ROUTE}`))
      .toContain('discovery:');
  });

  it('8 · an admission that is not current excludes the route, and crp2 names that as one of its nine conditions', () => {
    expect(ROUTING_POLICY_CRP2.conditions).toContain('identityAdmissionCurrent');
    // The derivation expresses an expired/absent admission as an identity blocker on a route that is
    // NOT admitted — nothing ever ran it under a live admission — and crp2 does not relax that one.
    const expired = admittedRecord({
      identityAdmitted: false,
      bindingIdentityStates: ['unverifiable'],
      identityConfidence: 'unknown',
      blockers: [{ kind: 'identity', reason: 'no run of this route ran under a verified identity (unverifiable)' }],
      safeToRoute: false,
    });
    const set = qualifiedRouteCandidates(query(), [{ record: expired }]);
    expect(set.candidates).toHaveLength(0);
    expect(reasonsFor(set, `opencodeCLI:${ROUTE}`)).toContain('no run of this route ran under a verified identity');
  });
});

// 9–13 ──────────────────────────────────────────────────────────────────────────────────────────────
describe('9–13 · the authorization to benchmark free routes is not evidence that any route is free', () => {
  it('9 · the authorization is recorded verbatim and explicitly proves nothing', () => {
    expect(ZERO_COST_BENCHMARK_AUTHORIZATION.words).toContain('A public price listing alone is not sufficient evidence');
    expect(ZERO_COST_BENCHMARK_AUTHORIZATION.authorizedAt).toBe('2026-09-22');
    expect(AUTHORIZATION_IS_NOT_EVIDENCE).toContain('PERMISSION, not a finding');
    expect(NOT_SUFFICIENT_EVIDENCE_OF_ZERO_COST[0]).toContain('the authorization above, on its own');

    // Being inside the authorized scope is not being free, and the return value says both.
    const scope = routeIsInsideAuthorization('opencodeCLI', ROUTE);
    expect(scope).toMatchObject({ insideScope: true, stillNeedsObservation: true });
    expect(scope.reason).toContain(AUTHORIZATION_IS_NOT_EVIDENCE);
    expect(routeIsInsideAuthorization('anthropicAPI', 'claude-sonnet-5').insideScope).toBe(false);

    // And the authorization pasted into the evidence field is refused as what it is.
    expect(() => assertConfirmationIsObserved(confirmation({
      observedBillingRecord: 'I authorize Cernum to benchmark OpenCode routes at zero marginal cost',
    }))).toThrow(ZeroCostAuthorizationError);
    // The scope alone still leaves the route metered until an observation exists.
    expect(costEligibilityFor({ provider: 'opencodeCLI', modelID: ROUTE }).eligibility).toBe('metered');
  });

  it('10 · a published $0 price is not sufficient, on any spelling the honest mistake takes', () => {
    for (const record of ['published list price $0/$0', 'the catalogue price is zero', 'models.json says 0',
      'the pricing file', 'documentation says it is free']) {
      expect(() => costEligibilityFor({ provider: 'opencodeCLI', modelID: ROUTE,
        confirmations: [confirmation({ observedBillingRecord: record })] })).toThrow(CostPolicyError);
    }
    // A route whose PUBLISHED price really is $0/$0 is still metered until somebody reads the account.
    const posture = routeSpendPosture({ provider: 'opencodeCLI', modelID: ROUTE, now: NOW });
    expect(posture).toMatchObject({ eligibility: 'metered', mayAutoSpend: false, mayRouteByDefault: false });
    // And proving it free here would need an inference request, which this pass refuses to make.
    expect(zeroCostEvidencePath('opencodeCLI').availableWithoutInference).toBe(false);
    expect(refuseInferenceToProveCost('opencodeCLI', ROUTE).code).toBe('inferenceWouldBeRequired');
  });

  it('11 · an OBSERVED account reading is accepted, binds to the exact route, and carries its provenance', () => {
    const verdict = costEligibilityFor({ provider: 'opencodeCLI', modelID: ROUTE, confirmations: [confirmation()] });
    expect(verdict.eligibility).toBe('free_confirmed');
    expect(verdict.reason).toContain('September statement');
    expect(verdict.reason).toContain('2026-09-21T00:00:00Z');
    expect(verdict.reason).toContain('the repository owner');
    expect(routeSpendPosture({ provider: 'opencodeCLI', modelID: ROUTE, confirmations: [confirmation()], now: NOW }))
      .toMatchObject({ zeroMarginalCost: true, mayBenchmark: true, mayAutoSpend: true, mayRouteByDefault: true });

    // BOUND TO THE EXACT ROUTE. A confirmation for one model says nothing about its neighbour.
    expect(costEligibilityFor({ provider: 'opencodeCLI', modelID: 'opencode/other-model',
      confirmations: [confirmation()] }).eligibility).toBe('metered');
  });

  it('12 · an expired confirmation is rejected, and the route falls back to metered rather than to free', () => {
    const aged = new Date('2026-11-30T00:00:00Z');
    expect(confirmationStaledByDelta(confirmation(), undefined, aged))
      .toMatchObject({ current: false, reasons: ['confirmationExpiredByAge'] });
    const posture = routeSpendPosture({ provider: 'opencodeCLI', modelID: ROUTE, confirmations: [confirmation()], now: aged });
    expect(posture).toMatchObject({ eligibility: 'metered', zeroMarginalCost: false, mayAutoSpend: false, mayRouteByDefault: false });
    expect(posture.reasons.join(' ')).toContain('no longer current');
    // A confirmation with no readable date cannot be shown to be current, so it is not.
    expect(confirmationStaledByDelta(confirmation({ observedAt: 'sometime last week' }), undefined, NOW).current).toBe(false);
  });

  it('13 · a price or free-status delta stales a confirmation immediately, however young it is', () => {
    const yesterday = confirmation({ observedAt: '2026-09-21T23:00:00Z' });
    const priceMoved: DiscoveryDelta = {
      routeKey: `opencodeCLI:${ROUTE}`, kinds: ['priceChanged'], detail: ['published price in:0/out:0 → in:300/out:1500'],
      qualificationNowStale: true,
    };
    const staled = confirmationStaledByDelta(yesterday, priceMoved, NOW);
    expect(staled.current).toBe(false);
    expect(staled.reasons).toContain('publishedPriceChanged');
    expect(staled.detail.join(' ')).toContain('re-read the account');

    const freeMoved: DiscoveryDelta = { ...priceMoved, kinds: ['freeStatusChanged'],
      detail: ['published free status true → false'] };
    expect(confirmationStaledByDelta(yesterday, freeMoved, NOW).reasons).toContain('publishedFreeStatusChanged');

    const gone: DiscoveryDelta = { ...priceMoved, kinds: ['disappeared'], detail: ['was listed and is no longer'] };
    expect(confirmationStaledByDelta(yesterday, gone, NOW).reasons).toContain('routeNoLongerListed');

    // A delta about ANOTHER route leaves this confirmation alone, and an unmoved route keeps it current.
    const elsewhere: DiscoveryDelta = { ...priceMoved, routeKey: 'opencodeCLI:opencode/other' };
    expect(confirmationStaledByDelta(yesterday, elsewhere, NOW).current).toBe(true);
    const quiet: DiscoveryDelta = { ...priceMoved, kinds: ['noMaterialChange'], detail: ['nothing moved'], qualificationNowStale: false };
    expect(confirmationStaledByDelta(yesterday, quiet, NOW)).toMatchObject({ current: true, reasons: ['confirmationCurrent'] });
  });
});

// The policy as a value ─────────────────────────────────────────────────────────────────────────────
describe('the policy is a value with a version, and both versions ship', () => {
  it('resolves each version by name and defaults to the current one', () => {
    expect(routingPolicy('crp1')).toBe(ROUTING_POLICY_CRP1);
    expect(routingPolicy('crp2')).toBe(ROUTING_POLICY_CRP2);
    expect(routingPolicy()).toBe(ROUTING_POLICY_CRP2);
  });

  it('never permits an admitted route under crp1, and never calls one verified under crp2', () => {
    const under = (version: 'crp1' | 'crp2', requireVerifiedIdentity: boolean) => identityPermitsRouting({
      policy: routingPolicy(version), routeKey: `opencodeCLI:${ROUTE}`, admitted: true,
      identityConfidence: 'unverifiableSubstitutionUndetectable', requireVerifiedIdentity,
    });
    expect(under('crp1', false).permitted).toBe(false);
    expect(under('crp1', true).permitted).toBe(false);
    expect(under('crp2', true).permitted).toBe(false);
    const permitted = under('crp2', false);
    expect(permitted.permitted).toBe(true);
    expect(permitted.reason).toContain('UNVERIFIABLE');

    // A route whose identity IS established is permitted by both, and neither calls it admitted.
    const verified = identityPermitsRouting({ policy: routingPolicy('crp1'), routeKey: 'ollama:gemma3:4b',
      admitted: false, identityConfidence: 'verifiedByLocalDigest', requireVerifiedIdentity: true });
    expect(verified).toMatchObject({ permitted: true });
    expect(verified.reason).toContain('identity is established');
  });
});
