// Model Lab core · sealed, versioned scoring policies (port of `ModelLabScoringPolicy`).

import { fnv1a64Hex, seal, compareCodePoints } from './digest';
import { containsPhrase } from './text';
import { CapabilityDimension } from './evaluation';
import { BenchmarkSuite } from './benchmark';

export type ExpectedOutputMode = 'naturalLanguage' | 'structuredJSON' | 'toolDecision' | 'refusal' | 'explanation';

export type EvaluationMethod =
  | 'exactMatch' | 'normalizedMatch' | 'structuredSchema' | 'requiredConcepts' | 'prohibitedConcepts'
  | 'refusalClassification' | 'toolSelection' | 'orderedConstraints' | 'provenanceLabels' | 'uncertaintyLanguage'
  | 'rubricComposition' | 'caseDelegation' | 'humanReviewRequired';

export interface CaseDelegation { caseID: string; policyID: string; policyVersion: string }
export function delegationReference(d: CaseDelegation): string {
  return `${d.policyID}@${d.policyVersion}`;
}

export interface ConceptMatcher { label: string; anyOf: string[] }
export function conceptPresent(concept: ConceptMatcher, text: string): boolean {
  return concept.anyOf.some((form) => containsPhrase(text, form));
}

export interface GovernanceRule {
  ruleID: string;
  statement: string;
  violatingConcepts: ConceptMatcher[];
  requiredConcepts: ConceptMatcher[];
}

export interface EvaluationCriteria {
  exactExpectedText?: string;
  requiredConcepts: ConceptMatcher[];
  prohibitedConcepts: ConceptMatcher[];
  requiredJSONKeys: string[];
  expectsRefusal: boolean;
  refusalConcepts: ConceptMatcher[];
  expectedToolID?: string;
  authorizedToolIDs: string[];
  orderedConceptLabels: string[];
  requiredProvenanceConcepts: ConceptMatcher[];
  requiresUncertaintyLanguage: boolean;
  uncertaintyConcepts: ConceptMatcher[];
  subPolicyIDs: string[];
  caseDelegations: CaseDelegation[];
}

export function criteria(fields: Partial<EvaluationCriteria> = {}): EvaluationCriteria {
  return {
    exactExpectedText: fields.exactExpectedText,
    requiredConcepts: fields.requiredConcepts ?? [],
    prohibitedConcepts: fields.prohibitedConcepts ?? [],
    requiredJSONKeys: fields.requiredJSONKeys ?? [],
    expectsRefusal: fields.expectsRefusal ?? false,
    refusalConcepts: fields.refusalConcepts ?? [],
    expectedToolID: fields.expectedToolID,
    authorizedToolIDs: fields.authorizedToolIDs ?? [],
    orderedConceptLabels: fields.orderedConceptLabels ?? [],
    requiredProvenanceConcepts: fields.requiredProvenanceConcepts ?? [],
    requiresUncertaintyLanguage: fields.requiresUncertaintyLanguage ?? false,
    uncertaintyConcepts: fields.uncertaintyConcepts ?? [],
    subPolicyIDs: fields.subPolicyIDs ?? [],
    caseDelegations: fields.caseDelegations ?? [],
  };
}

export interface ScoringPolicy {
  id: string;
  version: string;
  dimension: CapabilityDimension;
  evaluatorID: string;
  method: EvaluationMethod;
  expectedOutputMode: ExpectedOutputMode;
  criteria: EvaluationCriteria;
  hardGovernance?: GovernanceRule;
  scoringGuidance: string;
}

export function policyDigest(policy: ScoringPolicy): string {
  return seal(policy, 'mlsp1:');
}

export class ScoringPolicyFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScoringPolicyFailure';
  }
}

export class ScoringPolicyCatalog {
  readonly policies: ScoringPolicy[];
  private readonly byKey = new Map<string, ScoringPolicy>();

  constructor(policies: ScoringPolicy[]) {
    this.policies = [...policies].sort((a, b) => compareCodePoints(a.id, b.id) || compareCodePoints(a.version, b.version));
    for (const policy of policies) this.byKey.set(`${policy.id}@${policy.version}`, policy);
  }

  policy(id: string, version: string): ScoringPolicy | undefined {
    return this.byKey.get(`${id}@${version}`);
  }

  validate(): void {
    const seen = new Set<string>();
    for (const policy of this.policies) {
      if (policy.id.length === 0) throw new ScoringPolicyFailure('emptyID', `scoring policy has an empty id (near ${policy.id})`);
      if (policy.version.length === 0) throw new ScoringPolicyFailure('emptyVersion', `scoring policy ${policy.id} has an empty version`);
      const key = `${policy.id}@${policy.version}`;
      if (seen.has(key)) throw new ScoringPolicyFailure('duplicatePolicyID', `duplicate scoring policy id ${key}`);
      seen.add(key);
      if (policy.scoringGuidance.length === 0) throw new ScoringPolicyFailure('emptyGuidance', `scoring policy ${policy.id} has no scoring guidance`);
      if (policy.hardGovernance && policy.hardGovernance.violatingConcepts.length === 0 && policy.hardGovernance.requiredConcepts.length === 0) {
        throw new ScoringPolicyFailure('governanceRuleWithoutTeeth', `scoring policy ${policy.id} declares a hard governance rule with neither violating nor required concepts`);
      }
      this.validateDelegationRoutes(policy);
    }
  }

  private validateDelegationRoutes(policy: ScoringPolicy): void {
    const routes = policy.criteria.caseDelegations;
    if (policy.method !== 'caseDelegation') {
      if (routes.length > 0) throw new ScoringPolicyFailure('delegationRoutesOnNonDelegatingPolicy', `scoring policy ${policy.id} declares delegation routes but its method is not caseDelegation`);
      return;
    }
    if (routes.length === 0) throw new ScoringPolicyFailure('delegationWithoutRoutes', `case-delegating scoring policy ${policy.id} declares no routes — it could judge nothing`);
    const routed = new Set<string>();
    for (const route of routes) {
      if (route.caseID.length === 0 || route.policyID.length === 0 || route.policyVersion.length === 0) {
        throw new ScoringPolicyFailure('malformedDelegationRoute', `scoring policy ${policy.id} declares a malformed delegation route (${route.caseID} → ${delegationReference(route)}); a route needs a case id, a policy id, and a version`);
      }
      if (routed.has(route.caseID)) throw new ScoringPolicyFailure('duplicateDelegationRoute', `scoring policy ${policy.id} routes case ${route.caseID} more than once — routing must be unambiguous`);
      routed.add(route.caseID);
      const target = this.policy(route.policyID, route.policyVersion);
      if (!target) throw new ScoringPolicyFailure('delegationTargetMissing', `scoring policy ${policy.id} routes case ${route.caseID} to ${delegationReference(route)}, which the catalog lacks`);
      if (target.method === 'caseDelegation') throw new ScoringPolicyFailure('delegationTargetAlsoDelegates', `scoring policy ${policy.id} routes to ${delegationReference(route)}, which itself delegates — delegation chains are refused`);
    }
  }

  /** Fail-closed: every case in the suites must resolve its declared policy id@version (and be routed if it delegates). */
  validateReferences(suites: BenchmarkSuite[]): void {
    for (const suite of suites) {
      for (const c of suite.cases) {
        if (c.scoringPolicyID.length === 0 || c.scoringPolicyVersion.length === 0) {
          throw new ScoringPolicyFailure('emptyReference', `case ${c.id.raw} (suite ${suite.id.raw}) declares an incomplete scoring policy reference '${c.scoringPolicyID}@${c.scoringPolicyVersion}'`);
        }
        const registered = this.policies.filter((p) => p.id === c.scoringPolicyID).map((p) => p.version).sort(compareCodePoints);
        if (registered.length === 0) {
          throw new ScoringPolicyFailure('unknownPolicyID', `case ${c.id.raw} (suite ${suite.id.raw}) references scoring policy id ${c.scoringPolicyID}, which the active catalog does not register at any version`);
        }
        const resolved = this.policy(c.scoringPolicyID, c.scoringPolicyVersion);
        if (!resolved) {
          throw new ScoringPolicyFailure('unknownPolicyVersion', `case ${c.id.raw} (suite ${suite.id.raw}) references scoring policy ${c.scoringPolicyID}@${c.scoringPolicyVersion}; the active catalog registers ${c.scoringPolicyID} only at version(s) ${registered.join(', ')}`);
        }
        if (resolved.method === 'caseDelegation' && !resolved.criteria.caseDelegations.some((d) => d.caseID === c.id.raw)) {
          throw new ScoringPolicyFailure('unroutedDelegatedCase', `case ${c.id.raw} (suite ${suite.id.raw}) references case-delegating policy ${c.scoringPolicyID}@${c.scoringPolicyVersion}, which declares no route for that case — nothing would judge it`);
        }
      }
    }
  }

  catalogDigest(): string {
    return 'mlspc1:' + fnv1a64Hex(this.policies.map(policyDigest).join('|'));
  }
}
