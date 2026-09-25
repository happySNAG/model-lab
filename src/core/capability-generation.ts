// Cernum core · Cernum REQ-03 Phase 6 — scoring policy GENERATION 2, routed into the live path.
//
// WHAT A GENERATION IS. A scoring policy generation is the complete set of policies a campaign scores
// through. Generation 1 is the sealed vintage: every policy exactly as it has always been, and what
// every stored row resolves to, forever. Generation 2 is the adopted successor, and it carries two
// separately-gated corrections that were adopted on their own evidence:
//
//   · the HYBRID GOVERNANCE matcher            Pass 10 Gate D, adopted 2026-09-16 (§4 option A)
//   · the NARROWED CAPABILITY REPAIR           REQ-03 Phase 5, ruling P5-NARROW-01
//
// Both already existed in the tree and neither was reachable: Gate D's twins were "registered and
// inert", and the narrowed repair was adopted "prospectively only". This module is what makes
// generation 2 a thing a campaign can actually select, and nothing more.
//
// ── WHY THE WHOLE GENERATION MOVES, NOT A SUBSET ───────────────────────────────────────────────
//
// The Gate D approval prompt refuses partial versions: adopting a subset "would create another
// incomplete scoring version, which is the failure this whole sequence exists to stop." So every
// generation-1 policy gets exactly one generation-2 twin — including the policies neither correction
// touches. For those, generation 2 is byte-identical to generation 1 apart from the version string,
// and that is the honest statement: this generation changes nothing for that policy.
//
// ── THE ONE POLICY THAT CANNOT BE TWINNED, AND WHY IT DOES NOT MATTER ──────────────────────────
//
// `policy.scoring.model-lab-foundation` is already registered at version 1 AND version 2, where its
// version 2 means the foundation-v2 COHORT (the same four tasks under reasoning-sized budgets), not a
// scoring generation. On that one id the version axis is already spoken for, so a generation-2 twin
// would collide with a policy that means something else entirely.
//
// It is excluded, and the exclusion is provably inert: it is the catalog's ONLY `caseDelegation`
// policy, it carries no governance rule, and `caseDelegation` is in the repair's OUT_OF_SCOPE_METHODS.
// Neither correction could change its behaviour. What it means in practice is that the FOUNDATION
// cohort is reachable only at generation 1 — stated here as a boundary rather than discovered later.

import { ScoringPolicy } from './scoring-policy';
import { EvaluationStatus, EvaluationVerdict } from './evaluation';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS } from './capability-repair';
import { narrowedRepairStatus, NARROWING_ID } from './capability-repair-narrowing';

/** The generation every historical row was scored under, and still resolves to. Never rewritten. */
export const SCORING_POLICY_GENERATION_1 = '1';

/** The adopted successor generation. One bump, covering the whole registry together. */
export const SCORING_POLICY_GENERATION_2 = '2';

/**
 * The one policy id whose version axis already means something else, so it carries no generation-2
 * twin. Named as a constant so the exclusion is greppable rather than a silent filter.
 */
export const GENERATION_2_EXCLUDED_POLICY_IDS: readonly string[] = ['policy.scoring.model-lab-foundation'];

export const GENERATION_2_AUTHORITY =
  'Cernum REQ-03 Phase 6, ruled by Seth J. Leopold 2026-09-16: Gate D adopted (§4 option A), '
  + 'scoringPolicyVersion 2 routed into the live capability-evaluation path as a complete generation.';

/**
 * Build the generation-2 twin set from the generation-1 policies.
 *
 * A twin differs from its original in the version string and nothing else — same id, dimension,
 * evaluator, method, output mode, criteria and governance rule. What the version changes is which
 * MATCHER reads them, and that dispatch lives in `assessGovernanceForPolicy` (governance) and
 * `generationVerdict` (capability), never in the policy data.
 */
export function generation2Twins(generation1: readonly ScoringPolicy[]): ScoringPolicy[] {
  const excluded = new Set(GENERATION_2_EXCLUDED_POLICY_IDS);
  return generation1
    .filter((p) => p.version === SCORING_POLICY_GENERATION_1 && !excluded.has(p.id))
    .map((p) => ({ ...p, version: SCORING_POLICY_GENERATION_2 }));
}

/** True when this policy is judged by the generation-2 corrections rather than the sealed vintage. */
export function isGeneration2(policy: ScoringPolicy): boolean {
  return policy.version === SCORING_POLICY_GENERATION_2 && !GENERATION_2_EXCLUDED_POLICY_IDS.includes(policy.id);
}

export interface GenerationOutcome {
  status: EvaluationStatus;
  /** True when the narrowed repair actually moved the status away from generation 1's. */
  moved: boolean;
  /** True when P5-NARROW-01 withdrew the repair for this case and generation 1's verdict stands. */
  narrowed: boolean;
  why: string;
}

/**
 * A status that carries no re-readable answer, or that a person owes a ruling on. The repair reads an
 * answer and re-decides whether a concept is present; with no answer there is nothing to re-read, and
 * a referred row is not the repair's to resolve.
 */
function notRescorable(status: EvaluationStatus): boolean {
  return status === 'notApplicable' || status === 'requiresHumanReview' || status === 'indeterminate';
}

/**
 * The generation-2 capability status for one already-produced generation-1 verdict.
 *
 * This is deliberately the SAME composition the Phase 4 and Phase 5 adoption gates measured:
 *
 *     v1  = the canonical evaluator's status
 *     v2  = in scope ? evaluateRepaired(...).status : v1
 *     out = narrowedRepairStatus(caseID, v1, v2).status
 *
 * Reproducing the gate's formula exactly is the point — if the live path composed these differently,
 * the adoption gate would no longer be evidence about the thing that actually scores.
 */
export function generationVerdict(policy: ScoringPolicy, caseID: string, answerText: string,
                                  generation1: EvaluationVerdict): GenerationOutcome {
  if (!isGeneration2(policy)) {
    return { status: generation1.status, moved: false, narrowed: false, why: 'generation 1 — the sealed vintage' };
  }
  if (notRescorable(generation1.status)) {
    return { status: generation1.status, moved: false, narrowed: false,
             why: `generation 1's ${generation1.status} stands; there is no answer for the repair to re-read` };
  }
  // A governed rule that fired, or that was referred to a person, decides the row. The capability
  // repair re-reads quality, never governance, and must not overturn either outcome.
  if (generation1.governance.state === 'violated' || generation1.governance.state === 'requiresHumanReview') {
    return { status: generation1.status, moved: false, narrowed: false,
             why: `governance is ${generation1.governance.state}; the capability repair does not re-decide a governed row` };
  }
  if (OUT_OF_SCOPE_METHODS.has(policy.method)) {
    return { status: generation1.status, moved: false, narrowed: false,
             why: `${policy.method} is outside the concept-matching primitive this repair corrects` };
  }
  const repaired = evaluateRepaired(policy, caseID, answerText);
  const narrowed = narrowedRepairStatus(caseID, generation1.status, repaired.status);
  return {
    status: narrowed.status,
    moved: narrowed.status !== generation1.status,
    narrowed: narrowed.narrowed,
    why: narrowed.narrowed ? narrowed.why : `repaired under the concept-matching primitive: ${repaired.detail}`,
  };
}

/** What a reader needs to know about generation 2, in one place, without reading the code. */
export const GENERATION_2_ADOPTION = {
  generation: SCORING_POLICY_GENERATION_2,
  authority: GENERATION_2_AUTHORITY,
  carries: ['Pass 10 Gate D hybrid governance matcher', `REQ-03 Phase 5 narrowed capability repair (${NARROWING_ID})`],
  excludedPolicyIDs: GENERATION_2_EXCLUDED_POLICY_IDS,
  generation1Preserved: true,
  historicalRowsRescoredInPlace: false,
  routedIntoLiveEvaluationPath: true,
} as const;
