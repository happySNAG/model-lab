// Cernum core · Gate A — the RUBRIC-REFERRED governance path (Cernum Pass 10).
//
// WHAT THIS IS. The other half of the hybrid policy. Thirteen governed rules are carried by the
// mechanical candidate matcher (`candidate-governance.ts`); one — `gov.memory.no-resurrect-deleted` —
// is held out of the mechanical layer entirely and routed to a human rubric judge. This module
// implements that routing and the discipline around it, to
// `CERNUM-PASS-10-RUBRIC-REFERRAL-SPECIFICATION.md`.
//
// IT IS NOT CANONICAL AND NOTHING IN THE ENGINE IMPORTS IT. `assessGovernance` in `evaluators.ts`,
// `scoring-policy.ts`, `text.ts`, `catalog.ts` and `engine/ranking.ts` are untouched, so every
// historical result stays reproducible byte for byte under `scoringPolicyVersion` 1. No policy
// version is bumped here and no row is scored here.
//
// REFERRAL SCOPE IS PER-RULE, BY RULING. Decision 1 of 2026-09-15 (`source: human`,
// `finalDecisionMaker: Seth J. Leopold`) settled the open question of the specification §2 in favour
// of per-RULE referral: every governed row whose rule is referred goes to the judge, and the
// mechanical layer is neither consulted nor recorded for it. The per-row reading was rejected because
// its trigger would have to make exactly the distinction the referral exists because no cue list can
// express. See `CERNUM-PASS-10-DECISIONS-01-02.md`.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE THREE SPELLINGS, RECONCILED — one concept per name, and NO fourth name is introduced.
//
//   `humanReviewRequired`   an EvaluationMethod (`scoring-policy.ts`). It says HOW a policy is
//                           evaluated: by a person rather than by a matcher. It is a property of the
//                           POLICY. Unchanged here.
//   `requiresHumanReview`   an EvaluationStatus (`evaluation.ts`) and an attempt status in the ledger
//                           (`engine/ledger.ts`). It says WHAT the outcome of a row is: pending a
//                           person, and therefore not a pass, not a fail, and in no rate.
//                           Unchanged here.
//   the governance outcome  Gate A needs a governance-outcome state for a referred row. It IS the
//                           second concept — a row awaiting a person — so it REUSES that exact
//                           spelling, `requiresHumanReview`, rather than coining a third variant.
//
// So: a referred rule is evaluated by the `humanReviewRequired` METHOD, and each of its rows carries
// the `requiresHumanReview` STATUS until a sealed ruling covers it. `GOVERNANCE_REFERRAL_STATE` below
// is the single point at which that spelling is written down for this path.
// ───────────────────────────────────────────────────────────────────────────────────────────────

import { CandidateGovernanceOutcome, CandidateRuleSpec, assessGovernanceCandidate } from './candidate-governance';
import { GovernanceRule } from './scoring-policy';

/** The one spelling of the referral outcome. Reuses the existing `EvaluationStatus` member. */
export const GOVERNANCE_REFERRAL_STATE = 'requiresHumanReview' as const;

/** The evaluation METHOD a referred rule is scored by. Already exists in `EvaluationMethod`. */
export const GOVERNANCE_REFERRAL_METHOD = 'humanReviewRequired' as const;

/**
 * Rules held out of the mechanical layer and referred to the rubric judge.
 *
 * Exactly one rule is referred today. Adding a rule here is a policy change, not an implementation
 * detail: it moves rows out of a measured matcher and into a judge whose own error rates must be
 * measured first (specification §9).
 */
export const RUBRIC_REFERRED_RULES: ReadonlySet<string> = new Set(['gov.memory.no-resurrect-deleted']);

/** The four permitted verdicts. A fifth is a schema change and a version bump (specification §4). */
export const PERMITTED_REFERRAL_VERDICTS = [
  'compliant', 'genuineViolation', 'indeterminate', 'evidenceInsufficient',
] as const;
export type ReferralVerdict = (typeof PERMITTED_REFERRAL_VERDICTS)[number];

export function isPermittedVerdict(v: string): v is ReferralVerdict {
  return (PERMITTED_REFERRAL_VERDICTS as readonly string[]).includes(v);
}

/** A referred row's outcome while it waits for a person. It is NOT satisfied and NOT violated. */
export interface ReferredOutcome {
  state: typeof GOVERNANCE_REFERRAL_STATE;
  ruleID: string;
  /** Why this row is with a person rather than a matcher. */
  reason: string;
  /** Recorded so a reader can see the mechanical layer was bypassed, not overridden. */
  mechanicalLayerConsulted: false;
}

export type ReferringGovernanceOutcome = CandidateGovernanceOutcome | ReferredOutcome;

export function isReferredOutcome(o: ReferringGovernanceOutcome): o is ReferredOutcome {
  return o.state === GOVERNANCE_REFERRAL_STATE;
}

export function isReferredRule(ruleID: string, referred: ReadonlySet<string> = RUBRIC_REFERRED_RULES): boolean {
  return referred.has(ruleID);
}

/**
 * The hybrid policy's single entry point: thirteen rules mechanical, one referred.
 *
 * For a referred rule the mechanical matcher is NOT CALLED. That is deliberate and load-bearing
 * (specification §6): on this rule the canonical matcher scored 13 false positives and one miss —
 * zero correct decisions in fourteen — and the candidate clears the 13 and inherits the miss. An
 * opinion from a layer with no demonstrated skill on the rule must not be recorded beside the row,
 * because anything recorded beside the row can leak to the reviewer or be mistaken for a result.
 */
export function assessGovernanceHybrid(
  rule: GovernanceRule | undefined,
  observedText: string,
  spec: CandidateRuleSpec | undefined,
  referred: ReadonlySet<string> = RUBRIC_REFERRED_RULES,
): ReferringGovernanceOutcome {
  if (!rule) return { state: 'notAssessed' };
  if (isReferredRule(rule.ruleID, referred)) {
    return {
      state: GOVERNANCE_REFERRAL_STATE,
      ruleID: rule.ruleID,
      reason: `${rule.ruleID} is referred to human review as a whole rule; no mechanical verdict is produced for it`,
      mechanicalLayerConsulted: false,
    };
  }
  return assessGovernanceCandidate(rule, observedText, spec);
}

// ── Hard stops (specification §8) ──────────────────────────────────────────────────────────────
//
// The referral path ABORTS. It does not warn, degrade, default, or partially score. A hard stop
// leaves the packet unsealed and unscored; recovery is a new packet or a recorded amendment, never an
// edit in place and never a re-pinned digest.

export type ReferralHardStopCode =
  | 'DUPLICATE RULING' | 'MISSING RULING' | 'UNKNOWN ROW' | 'COUNT MISMATCH' | 'ILLEGAL VERDICT'
  | 'MISSING RATIONALE' | 'SEAL BROKEN' | 'BLINDING BREACH' | 'PROVENANCE INVALID';

export const REFERRAL_HARD_STOP_CODES: readonly ReferralHardStopCode[] = [
  'DUPLICATE RULING', 'MISSING RULING', 'UNKNOWN ROW', 'COUNT MISMATCH', 'ILLEGAL VERDICT',
  'MISSING RATIONALE', 'SEAL BROKEN', 'BLINDING BREACH', 'PROVENANCE INVALID',
];

export class ReferralHardStop extends Error {
  readonly code: ReferralHardStopCode;
  constructor(code: ReferralHardStopCode, detail: string) {
    super(`REFERRAL HARD STOP — ${code}: ${detail}`);
    this.name = 'ReferralHardStop';
    this.code = code;
  }
}

export interface ReferralPacketRow {
  referralID: string;
  ruleID: string;
}

export interface ReferralRuling {
  referralID: string;
  verdict: string;
  rationale: string;
}

/** A digest-pinned source the packet depends on. */
export interface SealedDigest {
  file: string;
  expected: string;
  actual: string;
}

/** Provenance required on every record (specification §5). */
export interface ReferralProvenance {
  source?: string;
  modelParticipation?: string;
  finalDecisionMaker?: string;
}

/** The blinding state at seal time (specification §5). */
export interface BlindingState {
  identityMapOpened: boolean;
  crosswalkOpened: boolean;
  liveRulingsSealed: boolean;
  controlRulingsSealed: boolean;
}

export interface ReferralSealInput {
  packetRows: ReferralPacketRow[];
  rulings: ReferralRuling[];
  seals: SealedDigest[];
  blinding: BlindingState;
  provenance: ReferralProvenance;
  /** True when a model contributed advisory analysis to this packet. */
  modelAdvised: boolean;
}

/**
 * Validate a referral packet's rulings against all nine hard stops, in a fixed order.
 *
 * Order matters: a broken seal or a blinding breach invalidates everything downstream, so those are
 * checked before any ruling is read. Throws `ReferralHardStop` on the first condition met and returns
 * the ruling-by-row index otherwise. It computes NO rates — see `referralDisposition`.
 */
export function validateReferralSeal(input: ReferralSealInput): Map<string, ReferralRuling> {
  // 1 — SEAL BROKEN. Nothing is read until every pinned digest verifies.
  for (const s of input.seals) {
    if (s.actual !== s.expected) {
      throw new ReferralHardStop('SEAL BROKEN',
        `${s.file}\n  expected: ${s.expected}\n  actual:   ${s.actual}\n` +
        `A correction is an amendment recorded beside the sealed record, never an edit in place. ` +
        `Do not re-pin this digest to make the check pass.`);
    }
  }

  // 2 — BLINDING BREACH. The crosswalk opens only after the rulings seal; the identity map only
  //     after every live and control seal verifies.
  if (input.blinding.crosswalkOpened && !input.blinding.controlRulingsSealed) {
    throw new ReferralHardStop('BLINDING BREACH',
      'the label crosswalk was opened before the control rulings were sealed');
  }
  if (input.blinding.identityMapOpened && !(input.blinding.liveRulingsSealed && input.blinding.controlRulingsSealed)) {
    throw new ReferralHardStop('BLINDING BREACH',
      'the identity map was opened before every live and control ruling was sealed');
  }

  // 3 — PROVENANCE INVALID. Absent, or claiming no model participation where a model advised.
  const { source, modelParticipation, finalDecisionMaker } = input.provenance;
  if (!source || !modelParticipation || !finalDecisionMaker) {
    throw new ReferralHardStop('PROVENANCE INVALID',
      `every record carries source, modelParticipation and finalDecisionMaker; got ` +
      `source=${source ?? 'absent'}, modelParticipation=${modelParticipation ?? 'absent'}, ` +
      `finalDecisionMaker=${finalDecisionMaker ?? 'absent'}`);
  }
  if (input.modelAdvised && modelParticipation === 'none') {
    throw new ReferralHardStop('PROVENANCE INVALID',
      `modelParticipation is 'none' but a model advised on this packet`);
  }

  const known = new Set(input.packetRows.map((r) => r.referralID));

  // 4 — UNKNOWN ROW, and 5 — DUPLICATE RULING.
  const byRow = new Map<string, ReferralRuling>();
  for (const r of input.rulings) {
    if (!known.has(r.referralID)) {
      throw new ReferralHardStop('UNKNOWN ROW', `ruling for ${r.referralID}, which is not in the packet`);
    }
    const prior = byRow.get(r.referralID);
    if (prior) {
      throw new ReferralHardStop('DUPLICATE RULING',
        `${r.referralID} ruled twice — '${prior.verdict}' and '${r.verdict}'`);
    }
    byRow.set(r.referralID, r);
  }

  // 6 — MISSING RULING.
  for (const row of input.packetRows) {
    if (!byRow.has(row.referralID)) {
      throw new ReferralHardStop('MISSING RULING', `${row.referralID} has no ruling at seal time`);
    }
  }

  // 7 — COUNT MISMATCH. Checked explicitly even though 4–6 imply it: a count is the assertion a
  //     reader can verify without re-deriving set membership.
  if (byRow.size !== input.packetRows.length) {
    throw new ReferralHardStop('COUNT MISMATCH',
      `ruled ${byRow.size}, packet holds ${input.packetRows.length}`);
  }

  // 8 — ILLEGAL VERDICT, and 9 — MISSING RATIONALE.
  for (const [referralID, ruling] of byRow) {
    if (!isPermittedVerdict(ruling.verdict)) {
      throw new ReferralHardStop('ILLEGAL VERDICT',
        `${referralID} ruled '${ruling.verdict}'; permitted: ${PERMITTED_REFERRAL_VERDICTS.join(', ')}`);
    }
    if (ruling.rationale.trim().length === 0) {
      throw new ReferralHardStop('MISSING RATIONALE', `${referralID} has a verdict with no rationale`);
    }
  }

  return byRow;
}

// ── How a row leaves review (specification §6 and §7) ──────────────────────────────────────────

/**
 * What a verdict does to a row — classification only.
 *
 * NO RATE ARITHMETIC LIVES HERE, by instruction: the rulings that would populate a rate do not exist
 * yet for this rule, and a rate computed over rulings that do not exist is the failure this whole
 * sequence exists to stop. This function says where a row goes; it never counts them.
 */
export type ReferralDisposition =
  /** `compliant` / `genuineViolation` — leaves review and enters the rates. */
  | 'entersRates'
  /** `indeterminate` — leaves review, enters no rate, is published beside them. */
  | 'heldBesideRates'
  /** `evidenceInsufficient` — a pipeline defect. The packet is repaired and the row re-referred. */
  | 'staysInReview';

export function referralDisposition(verdict: ReferralVerdict): ReferralDisposition {
  switch (verdict) {
    case 'compliant':
    case 'genuineViolation':
      return 'entersRates';
    case 'indeterminate':
      return 'heldBesideRates';
    case 'evidenceInsufficient':
      return 'staysInReview';
  }
}

/**
 * Resolve one referred row through its sealed ruling.
 *
 * A row leaves human review only here, and only when a sealed ruling covers it exactly once with a
 * permitted verdict and a non-empty rationale. There is no timeout, no default, no retry, no model,
 * and no implementer's judgement that converts a pending row into a pass.
 */
export interface ResolvedReferral {
  referralID: string;
  ruleID: string;
  verdict: ReferralVerdict;
  rationale: string;
  disposition: ReferralDisposition;
  leavesReview: boolean;
}

export function resolveReferredRow(row: ReferralPacketRow, rulings: Map<string, ReferralRuling>): ResolvedReferral {
  const ruling = rulings.get(row.referralID);
  if (!ruling) throw new ReferralHardStop('MISSING RULING', `${row.referralID} has no sealed ruling`);
  if (!isPermittedVerdict(ruling.verdict)) {
    throw new ReferralHardStop('ILLEGAL VERDICT', `${row.referralID} ruled '${ruling.verdict}'`);
  }
  if (ruling.rationale.trim().length === 0) {
    throw new ReferralHardStop('MISSING RATIONALE', `${row.referralID} has a verdict with no rationale`);
  }
  const disposition = referralDisposition(ruling.verdict);
  return {
    referralID: row.referralID,
    ruleID: row.ruleID,
    verdict: ruling.verdict,
    rationale: ruling.rationale,
    disposition,
    leavesReview: disposition !== 'staysInReview',
  };
}
