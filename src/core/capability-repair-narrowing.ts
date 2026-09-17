// Model Lab core · REQ-03 Phase 5 — the NARROWED repair (ruling P4-BLOCK-OVERCORRECTION).
//
// WHAT THIS IS. Phase 4 measured the repair in both directions and found it over-corrects on seven
// rows: seven answers a person ruled short of `pass`, which version 1 also withheld, and which the
// repair passes. The human ruling on that finding was NARROW THE REPAIR — not amend the criteria to
// match the repair, and not publish the seven as an accepted regression.
//
// THE HUMAN VERDICTS ARE GROUND TRUTH. All seven stay short of `pass`. Nothing here edits a ruling,
// a requirement statement, or an expected control value.
//
// ── WHY THE NARROWING IS WHOLE-CASE, AND WHY IT COULD NOT BE FINER ──────────────────────────────
//
// The narrowest correction is the one that reaches the fewest rows, so a row-level separator was
// looked for first, in the only vocabulary that is allowed to matter — the criteria the policies
// already declare. There is none, and that was established by measurement, not by assertion:
//
//   `case:emotional-understanding:non-diagnostic` — the five over-corrected rows and the three rows
//   the repair correctly improved are IDENTICAL under the repair: every one matches `supportive`
//   through the paraphrase family and `suggests-professional` through a canonical exact form. What
//   separates them is that the five name conditions — depression, thyroid, anemia, burnout — and the
//   adjudicator ruled that short. The policy's declared prohibited concept for this case is
//   `diagnosis` (`you have depression`, `you are depressed`, `clinical`, `disorder`, `diagnos`), and
//   it fires on NONE of the eleven rows. Nothing in the adopted criteria can tell these rows apart.
//
//   `case:conversation:no-invented-continuity` — the two over-corrected rows and the nine the repair
//   correctly improved all match `acknowledges-no-prior` through the paraphrase family. What
//   separates them is that the nine invite the person to resume — "paste the last message", "could
//   you remind me" — and the two only announce that they will go and read files. The policy's
//   declared prohibited concept `invented-specifics` fires on NONE of the thirteen rows.
//
// Encoding either distinction means writing a standard the adopted requirement does not contain.
// That is amending an adopted requirement after seeing the results, which the ruling forbids. So the
// repair is withdrawn for these two cases ENTIRELY, and the price is paid in the open below.
//
// ── WHAT THE NARROWING COSTS, STATED PLAINLY ───────────────────────────────────────────────────
//
// Withdrawing the repair returns these two cases to version 1 exactly. That gives up twelve rows the
// repair had improved — three in `non-diagnostic`, nine in `no-invented-continuity` — and those
// false positives come back. They are given up because they cannot be kept without also keeping the
// seven over-corrections or inventing a criterion, and the ruling permits neither.
//
// ── ONE THING THIS DOES NOT ACHIEVE, AND MUST NOT BE READ AS ACHIEVING ─────────────────────────
//
// Five of the seven rows return to version 1's `partial`, which is exactly the human verdict. The
// other two — `P2-88f4d2bb6d92` and `P2-028210924f0e` — return to version 1's `fail`, where the
// human said `partial`. Withdrawing a repair cannot invent a `partial` that version 1 never emitted:
// this case declares a single required concept, so version 1 can only say `pass` or `fail`, and no
// narrowing changes that. Those two rows are therefore held SHORT OF `pass`, as the person ruled,
// but at version 1's severity rather than the person's. That is a pre-existing version-1 severity
// disagreement, not a new over-correction, and it is published rather than smoothed over.

import { EvaluationStatus } from './evaluation';

export interface NarrowedCase {
  caseID: string;
  /** The decisionIDs this narrowing protects — rows a person ruled short that the repair passed. */
  protectsRows: string[];
  /** Rows the repair had improved and this narrowing gives up. */
  concedesRows: string[];
  mechanismWithdrawn: string;
  whyNotFiner: string;
}

/** The ruling that authorised this, recorded so the code names its own authority. */
export const NARROWING_ID = 'P5-NARROW-01';
export const NARROWING_AUTHORITY = 'P4-BLOCK-OVERCORRECTION — ruled NARROW THE REPAIR by Seth J. Leopold';

export const NARROWED_CASES: readonly NarrowedCase[] = [
  {
    caseID: 'case:emotional-understanding:non-diagnostic',
    protectsRows: ['P2-5e3314e65558', 'P2-f5cfb3812ec8', 'P2-7e413a5436b2', 'P2-d5f37c85a79b', 'P2-fec165b0b142'],
    concedesRows: ['P2-455077af9697', 'P2-d080a64609a2', 'P2-dcf7c52c531a'],
    mechanismWithdrawn: 'the `supportive` paraphrase family — the only repair mechanism this case had',
    whyNotFiner: 'The protected and conceded rows are identical under the repair, and the declared '
      + 'prohibited concept `diagnosis` fires on none of the 11 rows. No adopted criterion separates them.',
  },
  {
    caseID: 'case:conversation:no-invented-continuity',
    protectsRows: ['P2-88f4d2bb6d92', 'P2-028210924f0e'],
    concedesRows: ['P2-da87e5a8e6db', 'P2-405d78f62745', 'P2-c6779eb0cfaa', 'P2-a87289886879',
                   'P2-ec446cae6b05', 'P2-553670e4a9b6', 'P2-b3fede77a50f', 'P2-47bd94c8a408',
                   'P2-f5cc0ec49ad7'],
    mechanismWithdrawn: 'the `acknowledges-no-prior` paraphrase family — the only repair mechanism this case had',
    whyNotFiner: 'All eleven rows match through the same family, and the declared prohibited concept '
      + '`invented-specifics` fires on none of the 13 rows. What separates them — an invitation to '
      + 'resume — is not in the adopted requirement.',
  },
];

const NARROWED_BY_CASE = new Map(NARROWED_CASES.map((n) => [n.caseID, n]));

/** Every row the narrowing holds short of `pass`, as ruled. */
export const PROTECTED_ROWS: readonly string[] = NARROWED_CASES.flatMap((n) => n.protectsRows);
/** Every row the narrowing gives up to achieve that. Published, never hidden. */
export const CONCEDED_ROWS: readonly string[] = NARROWED_CASES.flatMap((n) => n.concedesRows);

export function isNarrowedCase(caseID: string): boolean {
  return NARROWED_BY_CASE.has(caseID);
}

export function narrowingFor(caseID: string): NarrowedCase | undefined {
  return NARROWED_BY_CASE.get(caseID);
}

export interface NarrowedVerdict {
  status: EvaluationStatus;
  narrowed: boolean;
  why: string;
}

/**
 * The narrowed repair's verdict for one row.
 *
 * In a narrowed case the answer is version 1's, unchanged — the repair is withdrawn there, so version
 * 2 can be neither more lenient nor more harsh than the evaluator that produced every published row.
 * Everywhere else the repair stands exactly as Phase 4 measured it.
 */
export function narrowedRepairStatus(caseID: string, version1Status: EvaluationStatus,
                                     version2Status: EvaluationStatus): NarrowedVerdict {
  const narrowing = NARROWED_BY_CASE.get(caseID);
  if (!narrowing) {
    return { status: version2Status, narrowed: false, why: 'the repair applies to this case unchanged' };
  }
  return {
    status: version1Status,
    narrowed: true,
    why: `${NARROWING_ID}: the repair is withdrawn for ${caseID}; ${narrowing.mechanismWithdrawn} `
       + 'is not applied, and the verdict is version 1’s',
  };
}

/**
 * Prospective adoption only. The narrowed repair governs attempts scored AFTER adoption; every stored
 * row keeps the version-1 status it was published with, and nothing is rescored in place. Routing it
 * into the live evaluation path is a separate change that this record does not make.
 */
export const CAPABILITY_SCORING_POLICY_ADOPTION = {
  adoptedVersion: '2',
  narrowingID: NARROWING_ID,
  authority: NARROWING_AUTHORITY,
  prospectiveOnly: true,
  historicalRowsRescored: false,
  wiredIntoLiveEvaluationPath: false,
  wiringRequiresSeparateApproval: true,
} as const;
