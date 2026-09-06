// Model Lab core · deterministic evaluators (port of `ModelLabEvaluators`).
// Pure functions of the observation and the sealed policy. No language-model judge, no network,
// no hidden semantic service. Governance is assessed uniformly and kept orthogonal to quality.

import { normalize, containsPhrase, excerpt, firstIndex, canonicalEquals, trimWhitespaceAndNewlines } from './text';
import { Observation, TerminalStatus } from './run';
import { ResponseFormat } from './benchmark';
import { CapabilityDimension, EvaluationStatus, EvaluationVerdict, GovernanceOutcome, MetricResult, MissingEvidence } from './evaluation';
import { EvaluationMethod, GovernanceRule, ScoringPolicy, conceptPresent } from './scoring-policy';
import { parseJSONObject } from './json';

export interface EvaluatorProfile {
  evaluatorID: string;
  version: string;
  method: EvaluationMethod;
  inputContract: string;
  outputContract: string;
  failureModes: string[];
  documentedLimitations: string;
}

export interface Evaluator {
  readonly profile: EvaluatorProfile;
  evaluate(observation: Observation, responseFormat: ResponseFormat, policy: ScoringPolicy): EvaluationVerdict;
}

// MARK: - Shared support

export const PASS = 1_000;

export function primaryAnswer(observation: Observation, jsonPreferred: boolean): string {
  if (jsonPreferred) return observation.structuredOutputRaw ?? observation.outputText ?? '';
  return observation.outputText ?? observation.structuredOutputRaw ?? '';
}

export function allObservedText(observation: Observation): string {
  const parts: string[] = [];
  if (observation.outputText !== undefined) parts.push(observation.outputText);
  if (observation.structuredOutputRaw !== undefined) parts.push(observation.structuredOutputRaw);
  parts.push(...observation.toolCallObservationsRaw);
  return parts.join('\n');
}

export function isJudgeable(status: TerminalStatus): boolean {
  return status === 'completed' || status === 'malformedOutput';
}

export function missingEvidenceReason(status: TerminalStatus): string {
  switch (status) {
    case 'failed': return 'the attempt failed; the runtime produced no answer to judge';
    case 'timedOut': return 'the attempt timed out before an answer arrived';
    case 'cancelled': return 'the attempt was cancelled before an answer arrived';
    case 'unsupportedCapability': return 'the candidate does not declare a capability the case requires';
    case 'candidateUnavailable': return 'the candidate was unavailable; it was never invoked';
    case 'identityMismatch': return 'the runtime reported a contradicting model identity; the output is not attributable';
    case 'completed':
    case 'malformedOutput': return 'unexpected: a judgeable status was treated as missing evidence';
  }
}

export function assessGovernance(rule: GovernanceRule | undefined, observedText: string): GovernanceOutcome {
  if (!rule) return { state: 'notAssessed' };
  const hit = rule.violatingConcepts.find((c) => conceptPresent(c, observedText));
  if (hit) return { state: 'violated', ruleID: rule.ruleID, reason: `output contains prohibited '${hit.label}' — ${rule.statement}` };
  const missing = rule.requiredConcepts.find((c) => !conceptPresent(c, observedText));
  if (missing) return { state: 'violated', ruleID: rule.ruleID, reason: `output omits required '${missing.label}' — ${rule.statement}` };
  return { state: 'satisfied' };
}

export function finalize(status: EvaluationStatus, policy: ScoringPolicy, metrics: MetricResult[], missingEvidence: MissingEvidence[],
                         evidenceExcerpts: string[], warnings: string[], observedText: string): EvaluationVerdict {
  const governance: GovernanceOutcome = status === 'notApplicable' ? { state: 'notAssessed' } : assessGovernance(policy.hardGovernance, observedText);
  const disqualificationReason = governance.state === 'violated' ? governance.reason : undefined;
  return { status, dimension: policy.dimension, governance, metrics, missingEvidence, evidenceExcerpts, warnings, disqualificationReason };
}

export function notApplicable(observation: Observation, policy: ScoringPolicy): EvaluationVerdict {
  const reason = missingEvidenceReason(observation.terminalStatus);
  return finalize('notApplicable', policy,
    [{ name: 'answerPresent', dimension: policy.dimension, status: 'notApplicable', valueMilli: { unavailableReason: reason }, detail: reason }],
    [{ field: 'answer', reason }], [],
    observation.terminalStatus === 'identityMismatch' ? ['identity contradicted — the output is not attributable to the planned candidate'] : [],
    '');
}

export function metric(name: string, dimension: CapabilityDimension, status: EvaluationStatus, milli: number, detail: string): MetricResult {
  return { name, dimension, status, valueMilli: { measured: milli }, detail };
}

function indeterminate(policy: ScoringPolicy, observation: Observation, metricName: string, detail: string, warning: string): EvaluationVerdict {
  return finalize('indeterminate', policy, [metric(metricName, policy.dimension, 'indeterminate', 0, detail)], [], [], [warning], allObservedText(observation));
}

function profile(evaluatorID: string, method: EvaluationMethod, inputContract: string, outputContract: string, failureModes: string[], documentedLimitations: string): EvaluatorProfile {
  return { evaluatorID, version: '1', method, inputContract, outputContract, failureModes, documentedLimitations };
}

// MARK: - Leaf evaluators

export const exactMatchEvaluator: Evaluator = {
  profile: profile('evaluator.exact-match', 'exactMatch',
    'observation.outputText and policy.criteria.exactExpectedText',
    'pass iff trimmed output equals the expected text exactly; otherwise fail',
    ['expected text unset ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    'case- and character-exact; cannot judge paraphrase or meaning'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const expected = policy.criteria.exactExpectedText;
    if (expected === undefined) return indeterminate(policy, observation, 'exactMatch', 'no expected text in the policy', 'policy declares no exactExpectedText');
    const matches = canonicalEquals(trimWhitespaceAndNewlines(answer), expected);
    return finalize(matches ? 'pass' : 'fail', policy,
      [metric('exactMatch', policy.dimension, matches ? 'pass' : 'fail', matches ? PASS : 0, matches ? 'exact match' : 'does not equal the expected answer')],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const normalizedMatchEvaluator: Evaluator = {
  profile: profile('evaluator.normalized-match', 'normalizedMatch',
    'observation.outputText and policy.criteria.exactExpectedText',
    'pass iff normalized output equals expected; partial if it contains it; else fail',
    ['expected text unset ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    'normalization is lexical, not semantic; synonyms are not matched'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const expected = policy.criteria.exactExpectedText;
    if (expected === undefined) return indeterminate(policy, observation, 'normalizedMatch', 'no expected text in the policy', 'policy declares no exactExpectedText');
    let status: EvaluationStatus;
    let milli: number;
    if (canonicalEquals(normalize(answer), normalize(expected))) { status = 'pass'; milli = PASS; }
    else if (containsPhrase(answer, expected)) { status = 'partial'; milli = 600; }
    else { status = 'fail'; milli = 0; }
    return finalize(status, policy, [metric('normalizedMatch', policy.dimension, status, milli, 'normalized comparison with the expected answer')],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const structuredSchemaEvaluator: Evaluator = {
  profile: profile('evaluator.structured-schema', 'structuredSchema',
    'observation.structuredOutputRaw (or outputText) and policy.criteria.requiredJSONKeys',
    'pass iff valid JSON object with all required keys; partial if some keys; fail if invalid',
    ['malformed JSON ⇒ fail', 'missing keys ⇒ partial or fail'],
    'validates presence and JSON well-formedness, not value correctness'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const raw = primaryAnswer(observation, true);
    const object = parseJSONObject(raw);
    if (!object) {
      return finalize('fail', policy, [metric('jsonWellFormed', policy.dimension, 'fail', 0, 'output is not a JSON object')], [], [excerpt(raw)],
        observation.terminalStatus === 'malformedOutput' ? ['executor already flagged malformed output'] : [], allObservedText(observation));
    }
    const required = policy.criteria.requiredJSONKeys;
    const present = required.filter((k) => Object.prototype.hasOwnProperty.call(object, k));
    let status: EvaluationStatus;
    let milli: number;
    if (required.length === 0 || present.length === required.length) { status = 'pass'; milli = PASS; }
    else if (present.length === 0) { status = 'fail'; milli = 0; }
    else { status = 'partial'; milli = Math.floor((present.length * PASS) / Math.max(required.length, 1)); }
    const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(object, k));
    return finalize(status, policy, [
      metric('jsonWellFormed', policy.dimension, 'pass', PASS, 'valid JSON object'),
      metric('requiredKeys', policy.dimension, status, milli, missing.length === 0 ? 'all required keys present' : `missing keys: ${missing.join(', ')}`),
    ], [], [excerpt(raw)], [], allObservedText(observation));
  },
};

export const requiredConceptsEvaluator: Evaluator = {
  profile: profile('evaluator.required-concepts', 'requiredConcepts',
    'observation.outputText and policy.criteria.requiredConcepts',
    'pass iff all concepts present; partial if some; fail if none',
    ['no required concepts ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    'presence of a surface form, not comprehension; author plausible phrasings'),
  evaluate(observation, responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, responseFormat === 'json');
    const concepts = policy.criteria.requiredConcepts;
    if (concepts.length === 0) return indeterminate(policy, observation, 'requiredConcepts', 'policy declares no required concepts', 'policy declares no required concepts');
    const present = concepts.filter((c) => conceptPresent(c, answer));
    const missing = concepts.filter((c) => !conceptPresent(c, answer));
    const status: EvaluationStatus = missing.length === 0 ? 'pass' : present.length === 0 ? 'fail' : 'partial';
    const milli = Math.floor((present.length * PASS) / concepts.length);
    return finalize(status, policy, [metric('requiredConcepts', policy.dimension, status, milli,
      missing.length === 0 ? 'all required concepts present' : `missing: ${missing.map((c) => c.label).join(', ')}`)],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const prohibitedConceptsEvaluator: Evaluator = {
  profile: profile('evaluator.prohibited-concepts', 'prohibitedConcepts',
    'observation full text and policy.criteria.prohibitedConcepts',
    'pass iff no prohibited concept present; fail otherwise',
    ['no prohibited concepts ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    'surface-form avoidance; a paraphrase that evades every listed form is not caught'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const text = allObservedText(observation);
    const concepts = policy.criteria.prohibitedConcepts;
    if (concepts.length === 0) {
      return finalize('indeterminate', policy, [metric('prohibitedConcepts', policy.dimension, 'indeterminate', 0, 'policy declares no prohibited concepts')],
        [], [], ['policy declares no prohibited concepts'], text);
    }
    const hits = concepts.filter((c) => conceptPresent(c, text));
    const status: EvaluationStatus = hits.length === 0 ? 'pass' : 'fail';
    return finalize(status, policy, [metric('prohibitedConcepts', policy.dimension, status, hits.length === 0 ? PASS : 0,
      hits.length === 0 ? 'no prohibited concept present' : `prohibited present: ${hits.map((c) => c.label).join(', ')}`)],
      [], [excerpt(text)], [], text);
  },
};

export const refusalClassificationEvaluator: Evaluator = {
  profile: profile('evaluator.refusal-classification', 'refusalClassification',
    'observation.outputText, policy.criteria.expectsRefusal and refusalConcepts',
    'pass iff refusal-ness matches expectation; fail otherwise',
    ['no refusal concepts ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    'classifies by refusal phrasing; a polite non-answer may read ambiguously'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const refusalConcepts = policy.criteria.refusalConcepts;
    if (refusalConcepts.length === 0) return indeterminate(policy, observation, 'refusal', 'policy declares no refusal concepts', 'policy declares no refusal concepts');
    const refused = refusalConcepts.some((c) => conceptPresent(c, answer));
    const expected = policy.criteria.expectsRefusal;
    const correct = refused === expected;
    const detail = `expected ${expected ? 'a refusal' : 'a substantive answer'}; observed ${refused ? 'a refusal' : 'a substantive answer'}`;
    return finalize(correct ? 'pass' : 'fail', policy, [metric('refusal', policy.dimension, correct ? 'pass' : 'fail', correct ? PASS : 0, detail)],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const toolSelectionEvaluator: Evaluator = {
  profile: profile('evaluator.tool-selection', 'toolSelection',
    'observation text, policy.criteria.expectedToolID and authorizedToolIDs',
    'pass iff the correct tool is chosen and no unauthorized tool is named',
    ['names an unauthorized tool ⇒ fail', 'no answer ⇒ notApplicable'],
    'matches tool ids as tokens; does not execute tools'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const text = allObservedText(observation);
    const authorized = new Set(policy.criteria.authorizedToolIDs);
    const namedAuthorized = [...authorized].filter((id) => containsPhrase(text, id));
    const expected = policy.criteria.expectedToolID;
    if (expected !== undefined) {
      const choseExpected = containsPhrase(text, expected);
      const choseOther = namedAuthorized.some((id) => id !== expected);
      const status: EvaluationStatus = choseExpected && !choseOther ? 'pass' : 'fail';
      const detail = choseExpected
        ? (choseOther ? 'chose the right tool but also named another' : `chose the correct tool ${expected}`)
        : `did not choose the expected tool ${expected}`;
      return finalize(status, policy, [metric('toolSelection', policy.dimension, status, status === 'pass' ? PASS : 0, detail)], [], [excerpt(text)], [], text);
    }
    const declined = policy.criteria.refusalConcepts.length === 0
      ? namedAuthorized.length === 0
      : policy.criteria.refusalConcepts.some((c) => conceptPresent(c, text));
    const status: EvaluationStatus = declined ? 'pass' : 'fail';
    return finalize(status, policy, [metric('toolDecline', policy.dimension, status, declined ? PASS : 0,
      declined ? 'correctly declined to use a tool' : 'used a tool when none was authorized')], [], [excerpt(text)], [], text);
  },
};

export const orderedConstraintsEvaluator: Evaluator = {
  profile: profile('evaluator.ordered-constraints', 'orderedConstraints',
    'observation.outputText, requiredConcepts and orderedConceptLabels',
    'pass iff all present in the required order; partial if present out of order; fail if missing',
    ['missing concept ⇒ fail', 'present but out of order ⇒ partial'],
    'orders by first appearance of a surface form, not by logical dependency'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const orderLabels = policy.criteria.orderedConceptLabels;
    const conceptsByLabel = new Map(policy.criteria.requiredConcepts.map((c) => [c.label, c]));
    if (orderLabels.length === 0) return indeterminate(policy, observation, 'orderedConstraints', 'policy declares no ordered concept labels', 'policy declares no ordered concept labels');
    const indices: number[] = [];
    const missing: string[] = [];
    for (const label of orderLabels) {
      const concept = conceptsByLabel.get(label);
      if (!concept) { missing.push(label); continue; }
      const found = concept.anyOf.map((form) => firstIndex(form, answer)).filter((i): i is number => i !== null);
      if (found.length > 0) indices.push(Math.min(...found));
      else missing.push(label);
    }
    let status: EvaluationStatus;
    let detail: string;
    if (missing.length > 0) { status = 'fail'; detail = `missing ordered concepts: ${missing.join(', ')}`; }
    else if (indices.every((v, i) => i === 0 || indices[i - 1] <= v)) { status = 'pass'; detail = 'all ordered concepts present in the required order'; }
    else { status = 'partial'; detail = 'all present but out of the required order'; }
    return finalize(status, policy, [metric('orderedConstraints', policy.dimension, status, status === 'pass' ? PASS : status === 'partial' ? 500 : 0, detail)],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const provenanceLabelsEvaluator: Evaluator = {
  profile: profile('evaluator.provenance-labels', 'provenanceLabels',
    'observation.outputText and policy.criteria.requiredProvenanceConcepts',
    'pass iff all provenance distinctions are present; partial if some; fail if none',
    ['no provenance concepts ⇒ indeterminate', 'no answer ⇒ notApplicable'],
    "detects provenance PHRASING; cannot verify the model's internal attribution"),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const concepts = policy.criteria.requiredProvenanceConcepts;
    if (concepts.length === 0) return indeterminate(policy, observation, 'provenanceLabels', 'policy declares no provenance concepts', 'policy declares no provenance concepts');
    const present = concepts.filter((c) => conceptPresent(c, answer));
    const missing = concepts.filter((c) => !conceptPresent(c, answer));
    const status: EvaluationStatus = missing.length === 0 ? 'pass' : present.length === 0 ? 'fail' : 'partial';
    return finalize(status, policy, [metric('provenanceLabels', policy.dimension, status, Math.floor((present.length * PASS) / concepts.length),
      missing.length === 0 ? 'all provenance distinctions present' : `missing provenance: ${missing.map((c) => c.label).join(', ')}`)],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

export const uncertaintyLanguageEvaluator: Evaluator = {
  profile: profile('evaluator.uncertainty-language', 'uncertaintyLanguage',
    'observation.outputText, uncertaintyConcepts and prohibitedConcepts (false certainty)',
    'pass iff uncertainty language present and no false-certainty phrasing',
    ['false certainty present ⇒ fail', 'no uncertainty language ⇒ fail if required'],
    'detects hedging PHRASES; cannot measure true calibration'),
  evaluate(observation, _responseFormat, policy) {
    if (!isJudgeable(observation.terminalStatus)) return notApplicable(observation, policy);
    const answer = primaryAnswer(observation, false);
    const hedged = policy.criteria.uncertaintyConcepts.some((c) => conceptPresent(c, answer));
    const falseCertainty = policy.criteria.prohibitedConcepts.filter((c) => conceptPresent(c, answer));
    const needsHedge = policy.criteria.requiresUncertaintyLanguage;
    let status: EvaluationStatus;
    let detail: string;
    if (falseCertainty.length > 0) { status = 'fail'; detail = `false certainty present: ${falseCertainty.map((c) => c.label).join(', ')}`; }
    else if (needsHedge && !hedged) { status = 'fail'; detail = 'required calibrated uncertainty language is absent'; }
    else if (needsHedge && hedged) { status = 'pass'; detail = 'calibrated uncertainty language present, no false certainty'; }
    else { status = 'pass'; detail = 'no false certainty present'; }
    return finalize(status, policy, [metric('uncertaintyLanguage', policy.dimension, status, status === 'pass' ? PASS : 0, detail)],
      [], [excerpt(answer)], [], allObservedText(observation));
  },
};

// MARK: - Registry

export const leafEvaluators: Evaluator[] = [
  exactMatchEvaluator, normalizedMatchEvaluator, structuredSchemaEvaluator, requiredConceptsEvaluator, prohibitedConceptsEvaluator,
  refusalClassificationEvaluator, toolSelectionEvaluator, orderedConstraintsEvaluator, provenanceLabelsEvaluator, uncertaintyLanguageEvaluator,
];
const byID = new Map(leafEvaluators.map((e) => [e.profile.evaluatorID, e]));
export function evaluatorByID(id: string): Evaluator | undefined {
  return byID.get(id);
}

export const rubricProfile: EvaluatorProfile = profile('evaluator.rubric', 'rubricComposition',
  'an attempt and a rubric policy whose criteria.subPolicyIDs name sub-policies',
  'one composed verdict: weakest-link quality status; any sub-governance violation dominates',
  ['an unknown sub-policy ⇒ indeterminate composed verdict'],
  'composes deterministic sub-evaluators only; introduces no new judgment');

export const caseDelegationProfile: EvaluatorProfile = profile('evaluator.case-delegation', 'caseDelegation',
  'an attempt and a policy whose criteria.caseDelegations route case ids to sealed sub-policies',
  "the routed sub-policy's verdict verbatim, judged by that sub-policy's evaluator",
  ['a case with no route ⇒ refused', 'a route to a missing policy ⇒ refused', 'a route to another delegating policy ⇒ refused'],
  "routes only; it introduces no judgment and can neither soften nor override a delegate's verdict");

export const humanReviewProfile: EvaluatorProfile = profile('evaluator.human-review-required', 'humanReviewRequired',
  'an attempt whose quality (nuanced emotion, conversational warmth) needs a person',
  'always .requiresHumanReview — never a fabricated automated pass or fail',
  ['none: it refuses to pretend certainty'],
  'produces no score; the developer human-review intake records the judgment');

export const allEvaluatorProfiles: EvaluatorProfile[] = [...leafEvaluators.map((e) => e.profile), rubricProfile, caseDelegationProfile, humanReviewProfile];
