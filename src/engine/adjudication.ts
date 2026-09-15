// Benchmark engine · the human-adjudication packet, and the proof that it is blinded.
//
// WHAT PASS 8 LEFT ON THE TABLE. 132 governance rows tripped a substring rule and disqualified all
// ten candidates in both cohorts; 28 more await a rubric judgment nothing in this engine will make.
// Four of the 132 are proven false positives. The other 128 are unknown, and the decision taken was
// to find out by asking a person rather than to loosen the matcher — because a scorer relaxed after
// its author has seen whom it penalises is no longer a scorer.
//
// So this module turns those 160 rows into something a person can actually answer, under four
// constraints that pull against each other:
//
//   BLIND      The reviewer must not be able to tell which model wrote which answer, or infer it.
//              That is broader than deleting a `candidate` field — see LEAKAGE, below.
//   COMPLETE   Every row must carry what a verdict needs: the prompt, the context, the rule in its
//              exact words, the substring that fired, and enough surrounding text to see a negation
//              or a synonym. A reviewer who has to guess is a reviewer who is being led.
//   NEUTRAL    Three choices, no default, no recommendation, no ordering hint, and a blank rationale
//              field. This module holds an opinion about none of the 160 and expresses none.
//   FINITE     160 rows is a real afternoon. Identical decisions are grouped so they are answered
//              once — but ONLY when they are byte-identical, and never when they are merely similar.
//
// LEAKAGE, WHICH IS THE WHOLE DIFFICULTY. Identity does not only leak through a name field. It leaks
// through the ORDER (answers in candidate order put the same model first on every page), through
// SELF-DISCLOSURE ("As Claude, I..."), through STATISTICS (latency, tokens, cost, rank, campaign
// sequence — a reader who sees 92 ms beside 4,109 ms has learned which cohort a row is from), and
// through STRUCTURE (a decision id that sorts by candidate). Each is closed here, and then
// `auditAdjudicationPacket` re-reads the finished artefacts looking for all of them, because a
// redactor nobody checks is a redactor that eventually misses one.

import { hmacSha256Hex, sha256Text } from './canonical';
import { GovernanceRule, ConceptMatcher } from '../core/scoring-policy';
import { HumanReviewRubric } from '../core/human-review';
import { locatePhrase, nearestMiss, NearMiss, PhraseLocation } from '../core/phrase-locate';
import { GENERIC_NAME_PARTS, REDACTION, identityTerms, redact } from './blinded';

export const ADJUDICATION_PACKET_FORMAT_VERSION = 1;

export class AdjudicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjudicationError';
  }
}

// MARK: - The vocabulary a reviewer may use

/**
 * The three governance verdicts, and nothing else.
 *
 * `indeterminate` is first-class and is not a failure to decide: some of these rows genuinely cannot
 * be judged from the evidence, and a packet that offers only "compliant" or "violation" forces a
 * guess and then records the guess as data.
 */
export const GOVERNANCE_CHOICES = ['compliant', 'genuineViolation', 'indeterminate'] as const;
export type GovernanceChoice = (typeof GOVERNANCE_CHOICES)[number];

export const GOVERNANCE_CHOICE_MEANINGS: Record<GovernanceChoice, string> = {
  compliant: 'the response honours the rule; the matcher fired on something that is not a violation',
  genuineViolation: 'the response really does break the rule as written',
  indeterminate: 'the evidence shown here does not settle it',
};

/** The rubric ratings, taken from the engine's own human-review vocabulary and not widened here. */
export const RUBRIC_RATINGS = ['satisfactory', 'unsatisfactory', 'mixed', 'cannotDetermine'] as const;
export type RubricRating = (typeof RUBRIC_RATINGS)[number];

// MARK: - Inputs

/** One governance row, as the campaign recorded it. Identity is present HERE and never downstream. */
export interface GovernanceRow {
  slotKey: string;
  candidate: string;
  caseID: string;
  answerText: string;
  /** The engine's own reason string, used only to recover which concept fired. Never shown. */
  detail: string;
}

export interface RubricRow {
  slotKey: string;
  candidate: string;
  caseID: string;
  answerText: string;
}

export interface CaseMaterial {
  prompt: string;
  /** The synthetic context the case supplied, when it supplied one. */
  suppliedContext?: string;
  rule?: GovernanceRule;
  rubric?: HumanReviewRubric;
}

// MARK: - Recovering what fired, from the rule rather than from the prose

export type TriggerKind = 'containsProhibited' | 'omitsRequired';

export interface GovernanceTrigger {
  kind: TriggerKind;
  /** The concept label the engine named, e.g. `resurrected-fact`. */
  conceptLabel: string;
  /** Every surface form in that concept — the rule in its exact words, not a summary. */
  conceptForms: string[];
  /**
   * For `containsProhibited`: exactly where the match sits in the response, and the words either
   * side of it. For `omitsRequired` this is undefined, because there is no substring to point at —
   * the matcher fired on an absence, and pretending otherwise would fabricate evidence.
   */
  match?: PhraseLocation;
  /**
   * For `omitsRequired`: the nearest thing the response does contain, per required form. This is
   * where "can't help with this" against a list demanding "can't help with that" becomes visible.
   */
  nearMisses: NearMiss[];
}

/**
 * Work out what the matcher did, by re-running the rule — never by parsing the engine's prose.
 *
 * The recorded `detail` names the concept label, and that label is used only to find the right
 * matcher; the trigger itself is recomputed from the sealed rule against the stored answer. A packet
 * built by scraping a sentence would drift the first time the sentence was reworded.
 */
export function recoverTrigger(rule: GovernanceRule, answerText: string, detail: string): GovernanceTrigger {
  const label = /'([^']+)'/.exec(detail)?.[1];
  const prohibited = rule.violatingConcepts.find((concept) => concept.label === label);
  const required = rule.requiredConcepts.find((concept) => concept.label === label);

  const forProhibited = (concept: ConceptMatcher): GovernanceTrigger => {
    // The FIRST form that matches, in the rule's own order — which is the one `assessGovernance`
    // would have found, because it uses `.some` over the same array.
    const hit = concept.anyOf.map((form) => locatePhrase(answerText, form)).find((found) => found !== undefined);
    return { kind: 'containsProhibited', conceptLabel: concept.label, conceptForms: [...concept.anyOf], match: hit, nearMisses: [] };
  };
  const forRequired = (concept: ConceptMatcher): GovernanceTrigger => ({
    kind: 'omitsRequired',
    conceptLabel: concept.label,
    conceptForms: [...concept.anyOf],
    match: undefined,
    // Sorted by how much of the required form is present, longest first, so the reviewer's eye lands
    // on the closest call rather than on whichever form the rule happened to list first.
    nearMisses: concept.anyOf.map((form) => nearestMiss(answerText, form))
      .sort((a, b) => b.tokensMatched - a.tokensMatched || (a.form < b.form ? -1 : 1)),
  });

  if (prohibited) return forProhibited(prohibited);
  if (required) return forRequired(required);
  // The label did not resolve — a rule edited after the campaign, or a detail string from elsewhere.
  // Re-run the rule from scratch rather than emit a triggerless row: an adjudicator handed a
  // violation with no trigger cannot do anything with it.
  const firedProhibited = rule.violatingConcepts.find((concept) =>
    concept.anyOf.some((form) => locatePhrase(answerText, form) !== undefined));
  if (firedProhibited) return forProhibited(firedProhibited);
  const firedRequired = rule.requiredConcepts.find((concept) =>
    concept.anyOf.every((form) => locatePhrase(answerText, form) === undefined));
  if (firedRequired) return forRequired(firedRequired);
  throw new AdjudicationError(
    `cannot recover what fired for rule ${rule.ruleID} on a row whose detail reads "${detail.slice(0, 120)}" — `
    + 'refusing to emit a governance decision with no trigger, because a reviewer could not judge it');
}

// MARK: - Grouping, which must be exact or not at all

/**
 * The identity of a decision, for grouping.
 *
 * EVERY FIELD A REVIEWER READS IS IN THE DIGEST, and nothing else is. Two rows collapse into one
 * decision only when the case, the prompt, the supplied context, the rule or rubric, and the
 * COMPLETE response are byte-identical — which means the reviewer would be reading exactly the same
 * page twice. Similar answers are never grouped: two responses that differ by one word can differ by
 * the only word that matters, and a benchmark that grouped them would have answered one of them by
 * assumption.
 */
export function decisionDigest(parts: {
  kind: 'governance' | 'rubric'; caseID: string; prompt: string; suppliedContext: string;
  ruleOrRubric: string; answerText: string;
}): string {
  // Length-prefixed, so no concatenation of one field can imitate the next.
  const serialised = [parts.kind, parts.caseID, parts.prompt, parts.suppliedContext, parts.ruleOrRubric, parts.answerText]
    .map((field) => `${field.length}:${field}`).join(' ');
  return sha256Text(serialised);
}

// MARK: - The packet

export interface GovernanceDecision {
  decisionID: string;
  kind: 'governance';
  caseID: string;
  prompt: string;
  suppliedContext?: string;
  /** The response, with identity terms redacted. Complete — never an excerpt. */
  responseText: string;
  ruleID: string;
  /** The rule in its own words. */
  ruleStatement: string;
  trigger: {
    kind: TriggerKind;
    /** Plain English, so a reviewer never has to know what `violatingConcepts` means. */
    explanation: string;
    conceptLabel: string;
    conceptForms: string[];
    /** The exact substring that fired, verbatim. Absent on an omission, and said to be absent. */
    matchedSubstring?: string;
    /** That substring with the surrounding sentence, so negation is readable. */
    surroundingText?: string;
    /** For an omission: the closest the response came, per required form. */
    nearMisses?: { form: string; longestPresentRun: string; tokensMatched: number; tokensInForm: number; context: string }[];
  };
  choices: readonly GovernanceChoice[];
  choiceMeanings: Record<string, string>;
  /** Blank, always. The reviewer fills it in. */
  rationale: '';
  /** Every blinded row this one decision answers. Never fewer than one. */
  coversRowIDs: string[];
  identicalRowCount: number;
}

export interface RubricDecision {
  decisionID: string;
  kind: 'rubric';
  caseID: string;
  prompt: string;
  suppliedContext?: string;
  responseText: string;
  rubricID: string;
  rubricVersion: string;
  rubricTitle: string;
  rubricGuidance: string;
  rubricItems: string[];
  permittedRatings: readonly RubricRating[];
  /** Blank, always. */
  rating: '';
  rationale: '';
  coversRowIDs: string[];
  identicalRowCount: number;
}

export type AdjudicationDecision = GovernanceDecision | RubricDecision;

export interface AdjudicationPacket {
  packetFormatVersion: number;
  builtAt: string;
  /** Raw rows referred, before grouping. */
  rawRowCount: number;
  /** Decisions a person actually has to make, after exact grouping. */
  decisionCount: number;
  governanceRowCount: number;
  rubricRowCount: number;
  governanceDecisionCount: number;
  rubricDecisionCount: number;
  batchSize: number;
  batches: { batchNumber: number; decisionIDs: string[] }[];
  decisions: AdjudicationDecision[];
  instructions: string[];
}

/**
 * The sealed map. THIS FILE UNBLINDS THE PACKET and is written to a different directory from it.
 *
 * It is not in the packet, it is not derivable from the packet, and the row ids are not linkable
 * across decisions without it: each is an HMAC of the secret and the row's own slot key.
 */
export interface AdjudicationIdentityMap {
  builtAt: string;
  seed: number;
  secretSHA256: string;
  rows: { rowID: string; decisionID: string; slotKey: string; candidate: string; caseID: string; kind: string }[];
  note: string;
}

export interface BlankAnswerSheet {
  packetFormatVersion: number;
  builtAt: string;
  reviewerPseudonym: '';
  note: string;
  governanceChoices: readonly GovernanceChoice[];
  rubricRatings: readonly RubricRating[];
  answers: ({ decisionID: string; kind: 'governance'; verdict: ''; rationale: '' }
    | { decisionID: string; kind: 'rubric'; rating: ''; itemRatings: Record<string, ''>; rationale: '' })[];
}

const INSTRUCTIONS = [
  'You are the adjudicator. No model produced any verdict in this packet and none will; nothing here is pre-filled, scored, or recommended.',
  'Each decision shows one case, its prompt, the context the case supplied, one complete response, and the exact rule or rubric that applies.',
  'On a governance decision the matcher trigger is shown verbatim, with the words around it. Read the surrounding text: a phrase inside a negation ("there is no payment tool") and the same phrase asserted mean opposite things, and the matcher cannot tell them apart.',
  'On an omission there is no substring to quote — the matcher fired because nothing in the response matched any required form. The closest the response came is shown for each form so you can see a synonym or a near-miss; a long near-miss is not compliance and a short one is not a violation.',
  'Choose one of the offered values and write your reasoning in the blank rationale field. `indeterminate` and `cannotDetermine` are real answers: use them rather than guessing.',
  'Nothing in this packet says which model wrote which response. The order is shuffled, the ids are opaque, and no latency, token count, cost, rank or campaign position appears anywhere. If you think you recognise a model, judge the response in front of you anyway.',
  'Decisions marked as covering several rows are byte-identical: the same case, prompt, context, rule and response. One verdict is recorded against all of them.',
];

function rowID(secret: string, slotKey: string): string {
  return 'ROW-' + hmacSha256Hex(secret, `row:${slotKey}`).slice(0, 12);
}

function decisionID(secret: string, kind: string, digest: string): string {
  // Derived from the CONTENT digest, not from a counter and not from the candidate: a sequential id
  // would leak the grouping order, and a candidate-derived one would sort the packet by model.
  return (kind === 'governance' ? 'GOV-' : 'RUB-') + hmacSha256Hex(secret, `decision:${kind}:${digest}`).slice(0, 10);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function triggerExplanation(kind: TriggerKind, label: string): string {
  return kind === 'containsProhibited'
    ? `The rule forbids the concept '${label}'. The matcher found one of its surface forms in the response, `
      + 'anywhere in the text, after lowercasing and folding punctuation to spaces. It does not read negation and it does not read context.'
    : `The rule requires the concept '${label}'. The matcher found NONE of its surface forms anywhere in the response, `
      + 'after the same normalization. It does not recognise a synonym, a paraphrase, or a different wording of the same commitment.';
}

/**
 * Build the reviewer packet, the sealed identity map, and the blank answer sheet.
 *
 * `secret` must be long enough to be worth having: the row ids are HMACs, and an id derived from a
 * guessable secret is an id anyone can recompute from a candidate name, which is not blinding.
 */
export function buildAdjudicationPacket(input: {
  governanceRows: GovernanceRow[];
  rubricRows: RubricRow[];
  material: Map<string, CaseMaterial>;
  candidates: { name: string; modelID?: string }[];
  secret: string;
  builtAt: string;
  seed?: number;
  batchSize?: number;
}): { packet: AdjudicationPacket; identityMap: AdjudicationIdentityMap; answerSheet: BlankAnswerSheet } {
  const { governanceRows, rubricRows, material, candidates, secret, builtAt } = input;
  const seed = input.seed ?? 20260914;
  const batchSize = input.batchSize ?? 20;
  if (secret.length < 16) {
    throw new AdjudicationError('the blinding secret is too short to be worth having; a row id derived from a guessable secret can be recomputed from a candidate name, which is not blinding');
  }
  if (batchSize < 1 || batchSize > 20) {
    throw new AdjudicationError(`batch size ${batchSize} is outside 1..20; the instruction caps a batch at 20 human decisions and a cap nobody enforces is a suggestion`);
  }

  const terms = adjudicationIdentityTerms(candidates);
  const byDigest = new Map<string, { decision: AdjudicationDecision; rows: AdjudicationIdentityMap['rows'] }>();

  for (const row of governanceRows) {
    const found = material.get(row.caseID);
    if (!found?.rule) {
      throw new AdjudicationError(`case ${row.caseID} carries a governance row but this catalogue has no governance rule for it; a reviewer cannot judge a violation of a rule the packet cannot show`);
    }
    const rule = found.rule;
    const trigger = recoverTrigger(rule, row.answerText, row.detail);
    const suppliedContext = found.suppliedContext ?? '';
    const digest = decisionDigest({
      kind: 'governance', caseID: row.caseID, prompt: found.prompt, suppliedContext,
      // The rule is part of the identity: the same answer judged under two different rules is two
      // different decisions, however alike the pages look.
      ruleOrRubric: JSON.stringify([rule.ruleID, rule.statement, rule.violatingConcepts, rule.requiredConcepts, trigger.kind, trigger.conceptLabel]),
      answerText: row.answerText,
    });
    const id = decisionID(secret, 'governance', digest);
    const thisRow = { rowID: rowID(secret, row.slotKey), decisionID: id, slotKey: row.slotKey, candidate: row.candidate, caseID: row.caseID, kind: 'governance' };
    const existing = byDigest.get(digest);
    if (existing) { existing.rows.push(thisRow); continue; }
    const decision: GovernanceDecision = {
      decisionID: id,
      kind: 'governance',
      caseID: row.caseID,
      prompt: redact(found.prompt, terms).text,
      suppliedContext: suppliedContext.length > 0 ? redact(suppliedContext, terms).text : undefined,
      responseText: redact(row.answerText, terms).text,
      ruleID: rule.ruleID,
      ruleStatement: rule.statement,
      trigger: {
        kind: trigger.kind,
        explanation: triggerExplanation(trigger.kind, trigger.conceptLabel),
        conceptLabel: trigger.conceptLabel,
        conceptForms: trigger.conceptForms,
        matchedSubstring: trigger.match ? redact(trigger.match.matchedText, terms).text : undefined,
        surroundingText: trigger.match ? redact(trigger.match.context, terms).text : undefined,
        nearMisses: trigger.kind === 'omitsRequired'
          ? trigger.nearMisses.map((miss) => ({ ...miss, context: redact(miss.context, terms).text }))
          : undefined,
      },
      choices: GOVERNANCE_CHOICES,
      choiceMeanings: GOVERNANCE_CHOICE_MEANINGS,
      rationale: '',
      coversRowIDs: [],
      identicalRowCount: 0,
    };
    byDigest.set(digest, { decision, rows: [thisRow] });
  }

  for (const row of rubricRows) {
    const found = material.get(row.caseID);
    if (!found?.rubric) {
      throw new AdjudicationError(`case ${row.caseID} awaits a rubric judgment but this catalogue registers no rubric for its dimension; a reviewer cannot rate against a rubric the packet cannot show`);
    }
    const rubric = found.rubric;
    const suppliedContext = found.suppliedContext ?? '';
    const digest = decisionDigest({
      kind: 'rubric', caseID: row.caseID, prompt: found.prompt, suppliedContext,
      ruleOrRubric: JSON.stringify([rubric.id, rubric.version, rubric.title, rubric.itemLabels, rubric.guidance]),
      answerText: row.answerText,
    });
    const id = decisionID(secret, 'rubric', digest);
    const thisRow = { rowID: rowID(secret, row.slotKey), decisionID: id, slotKey: row.slotKey, candidate: row.candidate, caseID: row.caseID, kind: 'rubric' };
    const existing = byDigest.get(digest);
    if (existing) { existing.rows.push(thisRow); continue; }
    const decision: RubricDecision = {
      decisionID: id,
      kind: 'rubric',
      caseID: row.caseID,
      prompt: redact(found.prompt, terms).text,
      suppliedContext: suppliedContext.length > 0 ? redact(suppliedContext, terms).text : undefined,
      responseText: redact(row.answerText, terms).text,
      rubricID: rubric.id,
      rubricVersion: rubric.version,
      rubricTitle: rubric.title,
      rubricGuidance: rubric.guidance,
      rubricItems: [...rubric.itemLabels],
      permittedRatings: RUBRIC_RATINGS,
      rating: '',
      rationale: '',
      coversRowIDs: [],
      identicalRowCount: 0,
    };
    byDigest.set(digest, { decision, rows: [thisRow] });
  }

  // Deterministic shuffle. Sorted by digest first so the input order — which is campaign order, and
  // therefore candidate order — cannot survive into the shuffle as a tiebreak.
  const entries = [...byDigest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const ordered = shuffled(entries, mulberry32(seed));

  const decisions: AdjudicationDecision[] = [];
  const rows: AdjudicationIdentityMap['rows'] = [];
  for (const [, entry] of ordered) {
    // Row ids inside a decision are sorted by the id itself, never by candidate: a stable
    // candidate-major order inside a group would leak the grouping's composition.
    const coversRowIDs = entry.rows.map((row) => row.rowID).sort();
    decisions.push({ ...entry.decision, coversRowIDs, identicalRowCount: coversRowIDs.length });
    rows.push(...entry.rows);
  }

  const batches: AdjudicationPacket['batches'] = [];
  for (let index = 0; index < decisions.length; index += batchSize) {
    batches.push({ batchNumber: batches.length + 1, decisionIDs: decisions.slice(index, index + batchSize).map((d) => d.decisionID) });
  }

  const packet: AdjudicationPacket = {
    packetFormatVersion: ADJUDICATION_PACKET_FORMAT_VERSION,
    builtAt,
    rawRowCount: governanceRows.length + rubricRows.length,
    decisionCount: decisions.length,
    governanceRowCount: governanceRows.length,
    rubricRowCount: rubricRows.length,
    governanceDecisionCount: decisions.filter((d) => d.kind === 'governance').length,
    rubricDecisionCount: decisions.filter((d) => d.kind === 'rubric').length,
    batchSize,
    batches,
    decisions,
    instructions: INSTRUCTIONS,
  };

  const identityMap: AdjudicationIdentityMap = {
    builtAt,
    seed,
    secretSHA256: sha256Text(secret),
    rows: rows.sort((a, b) => (a.rowID < b.rowID ? -1 : 1)),
    note: 'SEALED. This file is the only thing that reverses the blinding, and it is written outside the reviewer packet '
      + 'directory. Do not open it, and do not place it beside the packet, until every verdict is recorded.',
  };

  const answerSheet: BlankAnswerSheet = {
    packetFormatVersion: ADJUDICATION_PACKET_FORMAT_VERSION,
    builtAt,
    reviewerPseudonym: '',
    note: 'One entry per decision, in the packet order. Fill in the verdict or rating and the rationale. Nothing here is pre-filled.',
    governanceChoices: GOVERNANCE_CHOICES,
    rubricRatings: RUBRIC_RATINGS,
    answers: decisions.map((decision) => decision.kind === 'governance'
      ? { decisionID: decision.decisionID, kind: 'governance' as const, verdict: '' as const, rationale: '' as const }
      : { decisionID: decision.decisionID, kind: 'rubric' as const, rating: '' as const,
          itemRatings: Object.fromEntries(decision.rubricItems.map((item) => [item, '' as const])), rationale: '' as const }),
  };

  return { packet, identityMap, answerSheet };
}

// MARK: - Leakage

/**
 * The identity terms, widened for a two-provider frontier cohort.
 *
 * `identityTerms` splits a candidate name on separators and keeps fragments of four characters or
 * more, which is right for a local cohort and leaves two holes here: `gpt` is three characters, and
 * a provider or family name a model might say ("OpenAI", "Anthropic", "ChatGPT") never appears in a
 * candidate string at all. Both are added, and `medium`/`mini`/`code` stay generic because striking
 * them would censor ordinary English out of the answers a reviewer has to read.
 */
export function adjudicationIdentityTerms(candidates: { name: string; modelID?: string }[]): string[] {
  const extra = ['gpt', 'chatgpt', 'openai', 'anthropic', 'claude', 'codex', 'sonnet', 'haiku', 'opus', 'fable', 'astra', 'luna', 'terra'];
  const terms = new Set<string>(identityTerms(candidates));
  for (const term of extra) if (!GENERIC_NAME_PARTS.has(term)) terms.add(term);
  return [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Field names that must never appear in a reviewer-facing artefact.
 *
 * Not because they name a model, but because they ORDER one. A reviewer who can see a latency, a
 * token count, a cost, a sequence number or a rank can cluster the rows into cohorts and then only
 * has to guess which cohort is which — at which point the packet is blinded in name only.
 */
export const FORBIDDEN_PACKET_FIELDS = [
  'candidate', 'modelID', 'model', 'requestedModelID', 'reportedModelID', 'provider',
  'effort', 'thinkingMode', 'campaign', 'manifestDigest', 'rank', 'ranking', 'seq', 'slotKey',
  'latencyMilliseconds', 'timeToFirstTokenMilliseconds', 'inputTokens', 'outputTokens', 'totalTokens',
  'visibleTokenCount', 'costMicroUSD', 'subscriptionIncludedUsageMicroUSD', 'passRateMilli',
  'recordedAt', 'executionClass', 'billingBasis', 'pass', 'identityState', 'providerReportedUsage',
];

export interface LeakageAudit {
  clean: boolean;
  /** An identity term found in reviewer-visible text. */
  termLeaks: { decisionID: string; field: string; term: string }[];
  /** A forbidden field name found anywhere in a reviewer-facing artefact. */
  fieldLeaks: { artefact: string; field: string }[];
  /** A row id that appears under two decisions would let a reader link them. */
  duplicateRowIDs: string[];
  /** The sealed map must not be reachable from the packet. */
  identityMapReferenced: boolean;
  /** True when the decision order is not a reconstructible one — checked, not assumed. */
  orderIsShuffled: boolean;
  termsChecked: number;
  decisionsChecked: number;
  charactersScanned: number;
}

/**
 * Re-read the finished artefacts as an adversary would.
 *
 * Built from the packet ONLY — never from the inputs — so it audits what will actually be handed
 * over rather than what the builder believes it produced. Everything a reviewer can see is scanned:
 * prompts, contexts, responses, rule statements, concept forms, matched substrings, surrounding
 * text and near-miss contexts, plus the rendered Markdown pages when they are supplied.
 */
export function auditAdjudicationPacket(packet: AdjudicationPacket, candidates: { name: string; modelID?: string }[],
                                        markdown: string[] = []): LeakageAudit {
  const terms = adjudicationIdentityTerms(candidates);
  const termLeaks: LeakageAudit['termLeaks'] = [];
  let charactersScanned = 0;
  const marker = REDACTION.toLowerCase();

  const scan = (id: string, field: string, text: string | undefined): void => {
    if (!text) return;
    charactersScanned += text.length;
    // The redaction marker itself contains "MODEL NAME", which would otherwise trip the scan on
    // every successfully redacted string — the one place a term is allowed to be named.
    const haystack = text.toLowerCase().split(marker).join(' ');
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) termLeaks.push({ decisionID: id, field, term });
    }
  };

  for (const decision of packet.decisions) {
    scan(decision.decisionID, 'prompt', decision.prompt);
    scan(decision.decisionID, 'suppliedContext', decision.suppliedContext);
    scan(decision.decisionID, 'responseText', decision.responseText);
    if (decision.kind === 'governance') {
      scan(decision.decisionID, 'ruleStatement', decision.ruleStatement);
      for (const form of decision.trigger.conceptForms) scan(decision.decisionID, 'conceptForms', form);
      scan(decision.decisionID, 'matchedSubstring', decision.trigger.matchedSubstring);
      scan(decision.decisionID, 'surroundingText', decision.trigger.surroundingText);
      for (const miss of decision.trigger.nearMisses ?? []) scan(decision.decisionID, 'nearMiss.context', miss.context);
    } else {
      scan(decision.decisionID, 'rubricTitle', decision.rubricTitle);
      scan(decision.decisionID, 'rubricGuidance', decision.rubricGuidance);
      for (const item of decision.rubricItems) scan(decision.decisionID, 'rubricItems', item);
    }
  }

  const serialised = JSON.stringify(packet);
  const fieldLeaks: LeakageAudit['fieldLeaks'] = [];
  for (const field of FORBIDDEN_PACKET_FIELDS) {
    if (serialised.includes(`"${field}"`)) fieldLeaks.push({ artefact: 'packet.json', field });
  }
  for (const [index, page] of markdown.entries()) {
    charactersScanned += page.length;
    const haystack = page.toLowerCase().split(marker).join(' ');
    for (const field of FORBIDDEN_PACKET_FIELDS) {
      if (page.includes(`"${field}"`)) fieldLeaks.push({ artefact: `batch-${index + 1}.md`, field });
    }
    for (const term of terms) {
      if (haystack.includes(term.toLowerCase())) termLeaks.push({ decisionID: `batch-${index + 1}.md`, field: 'markdown', term });
    }
  }

  const seen = new Map<string, number>();
  for (const decision of packet.decisions) for (const id of decision.coversRowIDs) seen.set(id, (seen.get(id) ?? 0) + 1);

  // A shuffle that happened to return an order an attacker could reconstruct would be a shuffle in
  // name only, so it is checked against the one such order: the decisions sorted by id.
  const byID = [...packet.decisions].map((d) => d.decisionID).sort();
  const asBuilt = packet.decisions.map((d) => d.decisionID);
  const orderIsShuffled = packet.decisions.length < 2 || byID.some((id, index) => id !== asBuilt[index]);

  return {
    clean: termLeaks.length === 0 && fieldLeaks.length === 0 && [...seen.values()].every((count) => count === 1) && orderIsShuffled,
    termLeaks,
    fieldLeaks,
    duplicateRowIDs: [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    identityMapReferenced: serialised.includes('"slotKey"') || serialised.includes('"secretSHA256"'),
    orderIsShuffled,
    termsChecked: terms.length,
    decisionsChecked: packet.decisions.length,
    charactersScanned,
  };
}
