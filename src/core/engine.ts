// Cernum core · evaluation engine (port of `ModelLabEvaluationEngine`).
// Binds an immutable attempt to its sealed policy and named evaluator; appends the evaluation, then
// its derived score projection — both append-only, both collision-refusing, so re-running is idempotent.

import { isoSeconds } from './digest';
import { AttemptRecord, DerivedScoreRecord } from './run';
import { ResponseFormat } from './benchmark';
import { EvaluationRecord, EvaluationStatus, EvaluationVerdict, GovernanceOutcome, agreesInSubstance, derivedScoreProjection, makeEvaluationRecord } from './evaluation';
import { ScoringPolicy, ScoringPolicyCatalog, delegationReference } from './scoring-policy';
import { Evaluator, allObservedText, assessGovernanceForPolicy, evaluatorByID, finalize, humanReviewProfile, isJudgeable, notApplicable, primaryAnswer, rubricProfile } from './evaluators';
import { excerpt } from './text';
import { generationVerdict, isGeneration2 } from './capability-generation';
import { ResultStore, ResultStoreError } from './store';

export class EvaluationEngineFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EvaluationEngineFailure';
  }
}

export interface EvaluationOutcome {
  record: EvaluationRecord;
  appended: boolean;
  score: DerivedScoreRecord;
  scoreAppended: boolean;
}

interface Produced { verdict: EvaluationVerdict; evaluatorID: string; evaluatorVersion: string }

export class EvaluationEngine {
  constructor(private readonly catalog: ScoringPolicyCatalog, private readonly now: () => Date) {}

  /** Pure except for the injected clock; appends nothing. */
  evaluate(attempt: AttemptRecord): EvaluationRecord {
    const policy = this.catalog.policy(attempt.scoringPolicyID, attempt.scoringPolicyVersion);
    if (!policy) throw new EvaluationEngineFailure('unknownScoringPolicy', `no scoring policy ${attempt.scoringPolicyID}@${attempt.scoringPolicyVersion} in the catalog`);
    const produced = this.produceVerdict(attempt, policy);
    return makeEvaluationRecord({
      attemptID: attempt.attemptID,
      candidateID: attempt.candidate.id,
      suiteID: attempt.suiteID,
      suiteVersion: attempt.suiteVersion,
      caseID: attempt.caseID,
      caseDigest: attempt.caseDigest,
      category: produced.verdict.dimension,
      comparabilityKey: attempt.comparabilityKey,
      evaluatorID: produced.evaluatorID,
      evaluatorVersion: produced.evaluatorVersion,
      scoringPolicyID: policy.id,
      scoringPolicyVersion: policy.version,
      scoringPolicyDigest: policyDigestOf(policy),
      verdict: produced.verdict,
      evaluatedAt: isoSeconds(this.now()),
    });
  }

  /**
   * The LEAF policy that actually judges this attempt, delegation already followed.
   *
   * Exposed so a second, separately-labelled reading of the same answer can be produced under the
   * SAME sealed policy the strict verdict used. A caller that resolved the policy itself would be a
   * caller with its own opinion about delegation, and the two opinions would drift.
   */
  leafPolicyFor(attempt: AttemptRecord): ScoringPolicy {
    const policy = this.catalog.policy(attempt.scoringPolicyID, attempt.scoringPolicyVersion);
    if (!policy) throw new EvaluationEngineFailure('unknownScoringPolicy', `no scoring policy ${attempt.scoringPolicyID}@${attempt.scoringPolicyVersion} in the catalog`);
    return policy.method === 'caseDelegation' ? this.delegate(attempt, policy) : policy;
  }

  async evaluateRun(runID: string, store: ResultStore): Promise<EvaluationOutcome[]> {
    const outcomes: EvaluationOutcome[] = [];
    for (const attempt of await store.attempts(runID)) outcomes.push(await this.appendEvaluation(attempt, store));
    return outcomes;
  }

  async evaluateAttempt(attemptID: string, store: ResultStore): Promise<EvaluationOutcome> {
    const attempt = await store.attempt(attemptID);
    if (!attempt) throw new ResultStoreError('unknownRun', `store holds no run ${attemptID}`, attemptID);
    return this.appendEvaluation(attempt, store);
  }

  /** Two ordered append-only phases: the judgment, then its derived score projection. */
  async appendEvaluation(attempt: AttemptRecord, store: ResultStore): Promise<EvaluationOutcome> {
    const computed = this.evaluate(attempt);
    let authoritative = computed;
    let evaluationAppended = false;
    try {
      await store.appendEvaluation(computed);
      evaluationAppended = true;
    } catch (error) {
      if (!(error instanceof ResultStoreError) || error.code !== 'duplicateEvaluation') throw error;
      const existing = (await store.evaluations(attempt.attemptID)).find((e) => e.evaluationID === computed.evaluationID);
      if (!existing) throw new EvaluationEngineFailure('unreadableCollision', `the store refused ${computed.evaluationID} as a duplicate but cannot produce the colliding record — the store state is ambiguous and was left untouched`);
      if (!agreesInSubstance(existing, computed)) {
        throw new EvaluationEngineFailure('conflictingEvaluation', `the store already holds evaluation ${computed.evaluationID} with a DIFFERENT judgment; nothing was overwritten — a changed verdict under a stable evaluator version needs a new evaluator version, not a rewrite`);
      }
      authoritative = existing;
    }
    const score = derivedScoreProjection(authoritative);
    let scoreAppended = false;
    try {
      await store.appendScore(score);
      scoreAppended = true;
    } catch (error) {
      if (!(error instanceof ResultStoreError) || error.code !== 'duplicateScore') throw error;
      const existingScore = (await store.scores(attempt.attemptID)).find((s) => s.scoreID === score.scoreID);
      if (!existingScore) throw new EvaluationEngineFailure('unreadableCollision', `the store refused ${score.scoreID} as a duplicate but cannot produce the colliding record — the store state is ambiguous and was left untouched`);
      if (JSON.stringify(existingScore) !== JSON.stringify(score)) {
        throw new EvaluationEngineFailure('conflictingScore', `the store already holds derived score ${score.scoreID} with DIFFERENT content; nothing was overwritten — the stored score does not match the projection of the stored evaluation`);
      }
    }
    return { record: authoritative, appended: evaluationAppended, score, scoreAppended };
  }

  // MARK: - Verdict production

  private produceVerdict(attempt: AttemptRecord, policy: ScoringPolicy): Produced {
    const responseFormat: ResponseFormat = policy.expectedOutputMode === 'structuredJSON' ? 'json' : 'plainText';
    switch (policy.method) {
      case 'humanReviewRequired':
        return { verdict: this.humanReviewVerdict(attempt, policy), evaluatorID: humanReviewProfile.evaluatorID, evaluatorVersion: humanReviewProfile.version };
      case 'rubricComposition':
        return { verdict: this.composeRubric(attempt, policy), evaluatorID: rubricProfile.evaluatorID, evaluatorVersion: rubricProfile.version };
      case 'caseDelegation':
        return this.produceVerdict(attempt, this.delegate(attempt, policy));
      default: {
        const evaluator = evaluatorByID(policy.evaluatorID);
        if (!evaluator) throw new EvaluationEngineFailure('evaluatorNotFound', `no evaluator ${policy.evaluatorID} is registered`);
        if (evaluator.profile.method !== policy.method) {
          throw new EvaluationEngineFailure('methodMismatch', `policy method ${policy.method} does not match evaluator method ${evaluator.profile.method}`);
        }
        const verdict = evaluator.evaluate(attempt.observation, responseFormat, policy);
        return { verdict: this.applyGeneration(attempt, policy, verdict), evaluatorID: evaluator.profile.evaluatorID, evaluatorVersion: evaluator.profile.version };
      }
    }
  }

  /**
   * Generation dispatch, applied to the leaf verdict the canonical evaluator just produced.
   *
   * Under generation 1 this returns the verdict untouched, so every stored row still resolves to
   * exactly what produced it. Under generation 2 the narrowed capability repair re-reads the answer
   * and may move the status — and when P5-NARROW-01 withdrew the repair for a case, generation 1's
   * verdict is what stands.
   *
   * The repair re-reads QUALITY only. A governed rule that fired, or that was referred to a person,
   * already decided the row in `finalize`, and `generationVerdict` refuses to overturn either.
   *
   * `rubricComposition` is not dispatched here: it is outside the repair's primitive, and no policy in
   * the catalog composes a rubric. If one ever does, it arrives at this branch as out-of-scope and is
   * returned unchanged rather than silently half-repaired.
   */
  private applyGeneration(attempt: AttemptRecord, policy: ScoringPolicy, verdict: EvaluationVerdict): EvaluationVerdict {
    if (!isGeneration2(policy)) return verdict;
    const answer = primaryAnswer(attempt.observation, false);
    const outcome = generationVerdict(policy, attempt.caseID.raw, answer, verdict);
    if (!outcome.moved && !outcome.narrowed) return verdict;
    return {
      ...verdict,
      status: outcome.status,
      warnings: [...verdict.warnings, `scoring policy generation 2: ${outcome.why}`],
    };
  }

  private delegate(attempt: AttemptRecord, policy: ScoringPolicy): ScoringPolicy {
    const caseID = attempt.caseID.raw;
    const route = policy.criteria.caseDelegations.find((d) => d.caseID === caseID);
    if (!route) throw new EvaluationEngineFailure('undelegatedCase', `scoring policy ${policy.id} declares no delegation route for case ${caseID}`);
    const target = this.catalog.policy(route.policyID, route.policyVersion);
    if (!target) throw new EvaluationEngineFailure('unknownDelegatedPolicy', `case ${caseID} is routed to scoring policy ${delegationReference(route)} which the catalog lacks`);
    if (target.method === 'caseDelegation') {
      throw new EvaluationEngineFailure('delegationChain', `scoring policy ${policy.id} routes to ${delegationReference(route)}, which itself delegates — delegation chains are refused`);
    }
    return target;
  }

  private humanReviewVerdict(attempt: AttemptRecord, policy: ScoringPolicy): EvaluationVerdict {
    if (!isJudgeable(attempt.observation.terminalStatus)) return notApplicable(attempt.observation, policy);
    const observedText = allObservedText(attempt.observation);
    const answer = primaryAnswer(attempt.observation, false);
    return finalize('requiresHumanReview', policy, [{
      name: 'humanReviewRequired', dimension: policy.dimension, status: 'requiresHumanReview',
      valueMilli: { unavailableReason: 'nuanced quality is not deterministically scorable; a person must judge' },
      detail: 'deterministic scoring declined; recorded as requiring human review',
    }], [], [excerpt(answer)], [], observedText);
  }

  private composeRubric(attempt: AttemptRecord, policy: ScoringPolicy): EvaluationVerdict {
    const subVerdicts: EvaluationVerdict[] = [];
    for (const reference of policy.criteria.subPolicyIDs) {
      const at = reference.indexOf('@');
      if (at < 0) throw new EvaluationEngineFailure('malformedSubPolicyReference', `sub-policy reference ${reference} is not id@version`);
      const sub = this.catalog.policy(reference.slice(0, at), reference.slice(at + 1));
      if (!sub) throw new EvaluationEngineFailure('unknownSubPolicy', `rubric names sub-policy ${reference} which the catalog lacks`);
      const responseFormat: ResponseFormat = sub.expectedOutputMode === 'structuredJSON' ? 'json' : 'plainText';
      let subVerdict: EvaluationVerdict;
      const evaluator: Evaluator | undefined = evaluatorByID(sub.evaluatorID);
      if (sub.method === 'humanReviewRequired') subVerdict = this.humanReviewVerdict(attempt, sub);
      else if (evaluator && evaluator.profile.method === sub.method) subVerdict = evaluator.evaluate(attempt.observation, responseFormat, sub);
      else throw new EvaluationEngineFailure('evaluatorNotFound', `no evaluator ${sub.evaluatorID} is registered`);
      subVerdicts.push(subVerdict);
    }
    const statusOrder: EvaluationStatus[] = ['fail', 'requiresHumanReview', 'indeterminate', 'partial', 'pass', 'notApplicable'];
    const composedStatus = statusOrder.find((s) => subVerdicts.some((v) => v.status === s)) ?? 'notApplicable';
    const observedText = allObservedText(attempt.observation);
    let governance: GovernanceOutcome = { state: 'notAssessed' };
    const violated = subVerdicts.find((v) => v.governance.state === 'violated')?.governance;
    if (violated) governance = violated;
    else {
      // Version-dispatched, exactly like the leaf path: a composed rubric must not be the one place a
      // governed rule silently keeps the canonical matcher under the hybrid version. No governed policy
      // composes a rubric today, so this changes nothing now and cannot drift later.
      const own: GovernanceOutcome = composedStatus === 'notApplicable' ? { state: 'notAssessed' } : assessGovernanceForPolicy(policy, observedText);
      if (own.state === 'violated') governance = own;
      else if (own.state === 'requiresHumanReview') governance = own;
      else if (own.state === 'satisfied' || subVerdicts.some((v) => v.governance.state === 'satisfied')) governance = { state: 'satisfied' };
    }
    const disqualificationReason = governance.state === 'violated' ? governance.reason : undefined;
    const excerpts = [...new Set(subVerdicts.flatMap((v) => v.evidenceExcerpts))].sort();
    return {
      status: composedStatus, dimension: policy.dimension, governance,
      metrics: subVerdicts.flatMap((v) => v.metrics),
      missingEvidence: subVerdicts.flatMap((v) => v.missingEvidence),
      evidenceExcerpts: excerpts,
      warnings: subVerdicts.flatMap((v) => v.warnings),
      disqualificationReason,
    };
  }
}

const policyDigestCache = new WeakMap<ScoringPolicy, string>();
function policyDigestOf(policy: ScoringPolicy): string {
  let digest = policyDigestCache.get(policy);
  if (!digest) {
    // Imported lazily to keep the module graph acyclic for bundlers.
    digest = seal(policy, 'mlsp1:');
    policyDigestCache.set(policy, digest);
  }
  return digest;
}
import { seal } from './digest';
