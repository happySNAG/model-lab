// Benchmark engine · taking a person's verdicts in, and refusing everything that is not one.
//
// THIS IS THE ONLY PLACE A VERDICT ENTERS CERNUM, and the verdicts are the most valuable evidence
// this programme has produced: 616 attempts can be re-measured for allowance, and a person's reading
// of 160 answers cannot be re-obtained at all. So intake is fail-closed in every direction, and the
// thing it protects hardest is the distinction between what a person decided and what anything else
// inferred.
//
// WHAT IS REFUSED, AND WHY EACH ONE MATTERS:
//
//   an unknown decision id        a verdict for a decision this packet does not contain is a verdict
//                                 from a different packet, and applying it would attach a person's
//                                 reasoning to an answer they never read.
//   an id outside the batch       rulings arrive a batch at a time. A ruling that lands outside its
//                                 declared batch is either a typo or a scope error, and both would
//                                 silently pre-decide work nobody has done yet.
//   a kind mismatch               a governance verdict on a rubric decision, or the reverse. The two
//                                 vocabularies are not interchangeable and coercing one into the
//                                 other invents a judgment.
//   a word not in the vocabulary  `probably compliant` is not one of the three choices. A scorer that
//                                 accepted free text would end up parsing sentiment.
//   partial rubric items          a rubric rating whose items do not match the frozen rubric exactly
//                                 is a rating against a different rubric.
//   an empty rationale            a verdict with no reasoning cannot be audited, cannot be appealed,
//                                 and cannot be distinguished later from a default.
//   a duplicate id                two verdicts for one decision, with no rule for which wins.
//   a reviewer's real name        the handle must be pseudonymous, by the same rule the core's
//                                 human-review intake has always enforced. An email address in an
//                                 evidence file is a person's identity in an evidence file.
//
// AND WHAT IT WILL NOT DO. It does not unblind. The record keys on decision ids and blinded row ids
// and never touches the sealed identity map, so recording a batch of rulings reveals nothing about
// which model wrote what — that join is a separate, later, deliberate step. An audit asserts it.
//
// A NON-GOVERNANCE OBSERVATION IS NOT A VERDICT, and is kept in its own list for that reason. A
// reviewer who notices that an answer is factually wrong about something the rule does not cover has
// found a real defect and should be able to write it down without it becoming a governance finding by
// proximity. Merging the two lists would let a quality note quietly disqualify a candidate.

import { AdjudicationPacket, GOVERNANCE_CHOICES, GovernanceChoice, RUBRIC_RATINGS, RubricRating } from './adjudication';
import { trimWhitespaceAndNewlines } from '../core/text';

export const RULINGS_FORMAT_VERSION = 1;

export class RulingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulingsError';
  }
}

export interface GovernanceRulingInput {
  decisionID: string;
  verdict: string;
  rationale: string;
}

export interface RubricRulingInput {
  decisionID: string;
  rating: string;
  itemRatings: Record<string, string>;
  rationale: string;
}

/**
 * Something the reviewer noticed that the rule does not cover.
 *
 * `separateFrom` names the verdict it must never be confused with, in the record itself, so a reader
 * of this file alone cannot mistake an observation for a finding.
 */
export interface QualityObservationInput {
  decisionID: string;
  observation: string;
  /** What this is NOT. Required: an observation whose scope is unstated will be read as a verdict. */
  separateFrom: string;
}

export interface RulingsInput {
  batchNumber: number;
  reviewerPseudonym: string;
  adjudicatedAt: string;
  governance: GovernanceRulingInput[];
  rubric: RubricRulingInput[];
  qualityObservations?: QualityObservationInput[];
}

export interface RecordedGovernanceRuling {
  decisionID: string;
  kind: 'governance';
  caseID: string;
  ruleID: string;
  /** Which of the two ways the matcher fired, carried so a per-rule analysis needs no re-derivation. */
  triggerKind: string;
  conceptLabel: string;
  verdict: GovernanceChoice;
  rationale: string;
  /** The blinded rows this one verdict settles. Still blinded: these are not slot keys. */
  coversRowIDs: string[];
}

export interface RecordedRubricRuling {
  decisionID: string;
  kind: 'rubric';
  caseID: string;
  rubricID: string;
  rubricVersion: string;
  rating: RubricRating;
  itemRatings: Record<string, RubricRating>;
  rationale: string;
  coversRowIDs: string[];
}

export interface RecordedQualityObservation {
  decisionID: string;
  caseID: string;
  observation: string;
  separateFrom: string;
  /** Stated on every one of them, not in a header a reader may not reach. */
  isGovernanceFinding: false;
  affectsVerdict: false;
}

export interface RulingsProvenance {
  /** `human` is the only value this module will write. */
  source: 'human';
  /** Stated as a field so it survives into every downstream artefact. */
  modelParticipation: 'none — no model produced, suggested, ranked, defaulted or revised any verdict here';
  reviewerPseudonym: string;
  adjudicatedAt: string;
  recordedAt: string;
  packetFormatVersion: number;
  packetBuiltAt: string;
  batchNumber: number;
  note: string;
}

export interface RulingsRecord {
  rulingsFormatVersion: number;
  provenance: RulingsProvenance;
  governance: RecordedGovernanceRuling[];
  rubric: RecordedRubricRuling[];
  qualityObservations: RecordedQualityObservation[];
  /** What this record settles, and what it explicitly leaves open. */
  scope: {
    batchNumber: number;
    decisionsInBatch: number;
    decisionsRuled: number;
    rowsSettled: number;
    outstandingDecisionIDs: string[];
    batchComplete: boolean;
    unruledBatchNumbers: number[];
    appliesToOtherBatches: false;
    unblinded: false;
  };
}

export interface RulingsVerification {
  valid: boolean;
  batchNumber: number;
  decisionsInBatch: number;
  decisionsRuled: number;
  rowsSettled: number;
  governanceCount: number;
  rubricCount: number;
  /** Tallies, reported rather than interpreted. This module draws no conclusion from them. */
  verdictTally: Record<string, number>;
  ratingTally: Record<string, number>;
  rubricItemsRated: number;
  qualityObservations: number;
  outstandingDecisionIDs: string[];
  batchComplete: boolean;
  /** Blinding checks on the finished record. */
  containsCandidateName: boolean;
  containsSlotKey: boolean;
  everyRationaleNonEmpty: boolean;
}

const OBSERVATION_IS_NOT_A_VERDICT =
  'Recorded as a quality observation, NOT as a governance finding. It does not change the verdict on '
  + 'this decision, does not count toward any governance rate, and must never be folded into one.';

function requirePseudonym(handle: string): string {
  const trimmed = trimWhitespaceAndNewlines(handle);
  if (trimmed.length === 0) throw new RulingsError('the reviewer handle is empty; an unattributed set of verdicts cannot be audited or appealed');
  if (trimmed.includes('@') || trimmed.includes(' ')) {
    throw new RulingsError(`reviewer handle '${handle}' is not a pseudonym — use an opaque handle, never a name or an email address. `
      + 'An identity in an evidence file is an identity that travels with every copy of it.');
  }
  return trimmed;
}

function requireRationale(decisionID: string, rationale: string): string {
  const trimmed = trimWhitespaceAndNewlines(rationale);
  if (trimmed.length === 0) {
    throw new RulingsError(`the ruling for ${decisionID} carries no rationale; a verdict with no reasoning cannot be audited later, `
      + 'and cannot be told apart from a default');
  }
  return trimmed;
}

/**
 * Validate a batch of human rulings against the packet they were made from, and record them.
 *
 * Every rejection names the decision and says what is wrong with it, because the person who wrote
 * these verdicts is the one who has to fix a rejected file, and "invalid input" would make them read
 * this source to find out why.
 */
export function recordRulings(packet: AdjudicationPacket, input: RulingsInput, recordedAt: string):
  { record: RulingsRecord; verification: RulingsVerification } {
  const batch = packet.batches.find((entry) => entry.batchNumber === input.batchNumber);
  if (!batch) {
    throw new RulingsError(`this packet has no batch ${input.batchNumber}; it has batches `
      + `${packet.batches.map((entry) => entry.batchNumber).join(', ')}`);
  }
  const reviewerPseudonym = requirePseudonym(input.reviewerPseudonym);
  const byID = new Map(packet.decisions.map((decision) => [decision.decisionID, decision]));
  const inBatch = new Set(batch.decisionIDs);
  const seen = new Set<string>();

  const locate = (decisionID: string, expected: 'governance' | 'rubric') => {
    const decision = byID.get(decisionID);
    if (!decision) {
      throw new RulingsError(`no decision ${decisionID} in this packet — this ruling is from a different packet, `
        + 'and applying it would attach a verdict to an answer nobody read');
    }
    if (!inBatch.has(decisionID)) {
      throw new RulingsError(`decision ${decisionID} is not in batch ${input.batchNumber}; rulings are recorded one batch at a `
        + 'time, and a ruling outside its declared batch would pre-decide work that has not been done');
    }
    if (seen.has(decisionID)) throw new RulingsError(`two rulings for ${decisionID}; there is no rule for which one would win`);
    seen.add(decisionID);
    if (decision.kind !== expected) {
      throw new RulingsError(`decision ${decisionID} is a ${decision.kind} decision, but a ${expected} ruling was given for it; `
        + 'the two vocabularies are not interchangeable');
    }
    return decision;
  };

  const governance: RecordedGovernanceRuling[] = input.governance.map((ruling) => {
    const decision = locate(ruling.decisionID, 'governance');
    if (decision.kind !== 'governance') throw new RulingsError('unreachable: kind was checked');
    if (!(GOVERNANCE_CHOICES as readonly string[]).includes(ruling.verdict)) {
      throw new RulingsError(`'${ruling.verdict}' is not a permitted governance verdict for ${ruling.decisionID}; `
        + `the choices are ${GOVERNANCE_CHOICES.join(', ')}`);
    }
    return {
      decisionID: decision.decisionID,
      kind: 'governance',
      caseID: decision.caseID,
      ruleID: decision.ruleID,
      triggerKind: decision.trigger.kind,
      conceptLabel: decision.trigger.conceptLabel,
      verdict: ruling.verdict as GovernanceChoice,
      rationale: requireRationale(ruling.decisionID, ruling.rationale),
      coversRowIDs: [...decision.coversRowIDs],
    };
  });

  const rubric: RecordedRubricRuling[] = input.rubric.map((ruling) => {
    const decision = locate(ruling.decisionID, 'rubric');
    if (decision.kind !== 'rubric') throw new RulingsError('unreachable: kind was checked');
    if (!(RUBRIC_RATINGS as readonly string[]).includes(ruling.rating)) {
      throw new RulingsError(`'${ruling.rating}' is not a permitted rubric rating for ${ruling.decisionID}; `
        + `the ratings are ${RUBRIC_RATINGS.join(', ')}`);
    }
    // The items must match the FROZEN rubric exactly. A rating against a subset, a superset, or a
    // renamed item is a rating against a different rubric, however similar it looks.
    const expected = [...decision.rubricItems].sort();
    const given = Object.keys(ruling.itemRatings).sort();
    if (expected.length !== given.length || expected.some((item, index) => item !== given[index])) {
      throw new RulingsError(`the item ratings for ${ruling.decisionID} do not match its frozen rubric `
        + `${decision.rubricID}@${decision.rubricVersion}. Expected exactly [${expected.join(', ')}]; got [${given.join(', ')}]`);
    }
    const itemRatings: Record<string, RubricRating> = {};
    for (const [item, rating] of Object.entries(ruling.itemRatings)) {
      if (!(RUBRIC_RATINGS as readonly string[]).includes(rating)) {
        throw new RulingsError(`'${rating}' is not a permitted rating for item '${item}' of ${ruling.decisionID}`);
      }
      itemRatings[item] = rating as RubricRating;
    }
    return {
      decisionID: decision.decisionID,
      kind: 'rubric',
      caseID: decision.caseID,
      rubricID: decision.rubricID,
      rubricVersion: decision.rubricVersion,
      rating: ruling.rating as RubricRating,
      itemRatings,
      rationale: requireRationale(ruling.decisionID, ruling.rationale),
      coversRowIDs: [...decision.coversRowIDs],
    };
  });

  const qualityObservations: RecordedQualityObservation[] = (input.qualityObservations ?? []).map((entry) => {
    const decision = byID.get(entry.decisionID);
    if (!decision) throw new RulingsError(`no decision ${entry.decisionID} in this packet to attach an observation to`);
    if (!inBatch.has(entry.decisionID)) {
      throw new RulingsError(`decision ${entry.decisionID} is not in batch ${input.batchNumber}, so an observation about it `
        + 'does not belong in this batch\'s record');
    }
    if (trimWhitespaceAndNewlines(entry.observation).length === 0) {
      throw new RulingsError(`the observation on ${entry.decisionID} is empty`);
    }
    if (trimWhitespaceAndNewlines(entry.separateFrom).length === 0) {
      throw new RulingsError(`the observation on ${entry.decisionID} does not say what it is separate from; an observation whose `
        + 'scope is unstated will be read as a verdict');
    }
    return {
      decisionID: entry.decisionID,
      caseID: decision.caseID,
      observation: trimWhitespaceAndNewlines(entry.observation),
      separateFrom: trimWhitespaceAndNewlines(entry.separateFrom),
      isGovernanceFinding: false,
      affectsVerdict: false,
    };
  });

  const ruledIDs = new Set([...governance, ...rubric].map((ruling) => ruling.decisionID));
  const outstandingDecisionIDs = batch.decisionIDs.filter((id) => !ruledIDs.has(id));
  const rowsSettled = [...ruledIDs].reduce((sum, id) => sum + (byID.get(id)?.identicalRowCount ?? 0), 0);
  const unruledBatchNumbers = packet.batches.map((entry) => entry.batchNumber).filter((n) => n !== input.batchNumber);

  const record: RulingsRecord = {
    rulingsFormatVersion: RULINGS_FORMAT_VERSION,
    provenance: {
      source: 'human',
      modelParticipation: 'none — no model produced, suggested, ranked, defaulted or revised any verdict here',
      reviewerPseudonym,
      adjudicatedAt: input.adjudicatedAt,
      recordedAt,
      packetFormatVersion: packet.packetFormatVersion,
      packetBuiltAt: packet.builtAt,
      batchNumber: input.batchNumber,
      note: 'These verdicts and every word of their rationales were written by the adjudicator. They were '
        + 'transcribed into this record verbatim and neither summarised nor normalised. Nothing here is '
        + 'derived, inferred, or filled in.',
    },
    governance,
    rubric,
    qualityObservations,
    scope: {
      batchNumber: input.batchNumber,
      decisionsInBatch: batch.decisionIDs.length,
      decisionsRuled: ruledIDs.size,
      rowsSettled,
      outstandingDecisionIDs,
      batchComplete: outstandingDecisionIDs.length === 0,
      unruledBatchNumbers,
      appliesToOtherBatches: false,
      unblinded: false,
    },
  };

  const serialised = JSON.stringify(record);
  const verification: RulingsVerification = {
    valid: true,
    batchNumber: input.batchNumber,
    decisionsInBatch: batch.decisionIDs.length,
    decisionsRuled: ruledIDs.size,
    rowsSettled,
    governanceCount: governance.length,
    rubricCount: rubric.length,
    verdictTally: tally(governance.map((ruling) => ruling.verdict)),
    ratingTally: tally(rubric.map((ruling) => ruling.rating)),
    rubricItemsRated: rubric.reduce((sum, ruling) => sum + Object.keys(ruling.itemRatings).length, 0),
    qualityObservations: qualityObservations.length,
    outstandingDecisionIDs,
    batchComplete: outstandingDecisionIDs.length === 0,
    // The record must stay blinded. It keys on decision and blinded row ids, and a candidate name or
    // a slot key in here would mean the join happened early and by accident.
    containsCandidateName: /claudeCLI|codexCLI/.test(serialised),
    containsSlotKey: serialised.includes('slotKey') || /\|suite\./.test(serialised),
    everyRationaleNonEmpty: [...governance, ...rubric].every((ruling) => ruling.rationale.length > 0),
  };
  verification.valid = !verification.containsCandidateName && !verification.containsSlotKey
    && verification.everyRationaleNonEmpty;
  return { record, verification };
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/**
 * Fill the blank answer sheet from a recorded batch, leaving every other batch blank.
 *
 * Returned as a NEW sheet rather than a mutation, and every decision the rulings do not name keeps
 * its empty strings — so a half-adjudicated sheet is visibly half-adjudicated rather than looking
 * complete with defaults in it.
 */
export function applyRulingsToAnswerSheet(sheet: { answers: unknown[]; [key: string]: unknown },
                                          records: RulingsRecord[]): { answers: unknown[]; [key: string]: unknown } {
  const governance = new Map<string, RecordedGovernanceRuling>();
  const rubric = new Map<string, RecordedRubricRuling>();
  for (const record of records) {
    for (const ruling of record.governance) governance.set(ruling.decisionID, ruling);
    for (const ruling of record.rubric) rubric.set(ruling.decisionID, ruling);
  }
  const answers = sheet.answers.map((raw) => {
    const answer = raw as { decisionID: string; kind: string };
    const gov = governance.get(answer.decisionID);
    if (gov) return { ...answer, verdict: gov.verdict, rationale: gov.rationale };
    const rub = rubric.get(answer.decisionID);
    if (rub) return { ...answer, rating: rub.rating, itemRatings: rub.itemRatings, rationale: rub.rationale };
    return { ...answer };
  });
  return { ...sheet, answers };
}
