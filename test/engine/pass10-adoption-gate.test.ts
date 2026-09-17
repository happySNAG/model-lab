// Cernum · REQ-01 — the PERMANENT ADOPTION GATE for the repaired governance policy.
//
// This is not the development fixture. `pass10-candidate-governance.test.ts` asserts a readable
// 30-row subset and exists to prove the candidate is not inert. This file is the gate: it asserts
// the WHOLE adjudicated corpus, reading it from the sealed records rather than restating it, so the
// assertion and the adjudication cannot drift apart.
//
//   157 assertions, in three families:
//
//     132  adjudicated FALSE POSITIVES  — every governance row of the Pass 9 corpus, each ruled
//          `compliant` by a person.
//      24  seeded CONTROLS              — 17 known positives and 7 adversarial hedges, authored.
//          A matcher that clears everything scores perfectly on the 132 and is worthless.
//       1  confirmed FALSE NEGATIVE     — FNROW-14a8cef100f2, the one row of the Pass 10 census a
//          person ruled `genuineViolation`.
//
// ── DECISION 1 of 2026-09-15 — REFERRAL SCOPE IS PER-RULE ─────────────────────────────────────
//
// The adjudicator settled the open question of the rubric specification §2 in favour of per-RULE
// referral for `gov.memory.no-resurrect-deleted`. The rule's record is 13 false positives plus one
// live false negative — zero correct decisions in fourteen — so the rule itself is not reliable
// enough for mechanical scoring, and no row of it is scored mechanically.
//
// What that means for the 157, and it is not the per-row split this file used to assert:
//
//     119  adjudicated false positives under the other THIRTEEN rules  → clear mechanically
//      13  adjudicated false positives under the REFERRED rule         → refer, then their sealed
//                                                                        human rulings resolve them
//                                                                        `compliant`
//      23  seeded controls under the other thirteen rules              → detected mechanically
//       1  seeded control CTRLB-24 / CTRL-POS-06, referred rule        → refer, then its sealed
//                                                                        control ruling resolves it
//                                                                        `genuineViolation`
//       1  FNROW-14a8cef100f2, referred rule                           → refer, then its sealed
//                                                                        ruling resolves it
//                                                                        `genuineViolation`
//     ───
//     157  total, no row missing and none counted twice.
//
// A referral is not a clearance and a referral is not a detection, so the fifteen referred rows are
// asserted in two parts: the policy must produce `requiresHumanReview` for them — never a mechanical
// pass or a mechanical fail — and the sealed human ruling must then resolve each to the verdict a
// person actually recorded. Both halves must hold for the assertion to pass. This is one assertion
// per row, not two, so the total stays exactly 157.
//
// ── DECISION 2 of 2026-09-15 — THE REQ-01 JOIN IS REPOINTED AT THE RAW PASS 8 LEDGER ──────────
//
// REQ-01 requires the 132 to be joined to their response text THROUGH THE PASS 8 LEDGER. The
// previous run of this gate could not find one and joined through `CERNUM-PASS-09-REVIEW-PACKET.json`
// instead, flagging the deviation. The raw canonical ledger does exist, on the LaCie volume:
//
//     pass08-evidence/campaign-a2/results.jsonl   352 attempts
//     pass08-evidence/campaign-b2/results.jsonl   264 attempts
//                                                 616 total, each carrying `answerText`
//
// Both digests verify against `pass08-evidence/SHA256SUMS.txt` (61/61 OK). The join runs
// rowID → slotKey (sealed identity map) → ledger row, and `slotKey` is unique across all 616, so it
// is one-to-one in both directions.
//
// The review packet is still read, but as a CHECK rather than as the source: the text the gate
// asserts on now comes from the ledger, and every row must agree with the text the adjudicator
// actually read, modulo the packet's vendor-name redaction. 129 of 132 are byte-identical; 3 differ
// only where the packet replaced the vendor name. Anything else is a hard stop. Note this also
// corrects the record: the review packet's own `redaction` field says `null`, and the previous gate
// report cited that as evidence the packet text was unredacted. It carries 3 redactions.
//
// Counts are load-bearing. A subset fixture can pass while the matcher has regressed on a row nobody
// transcribed, so this file refuses to run at all unless it loads exactly 132, exactly 24 and
// exactly 1 — and, under Decision 1, exactly 119/13 and 23/1 within those families.

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { registeredSuites, policyCatalog } from '../../src/core/catalog';
import { CANDIDATE_SPEC_BY_RULE } from '../../src/core/candidate-governance-spec';
import {
  GOVERNANCE_REFERRAL_STATE, RUBRIC_REFERRED_RULES, ReferralRuling, ReferralVerdict,
  assessGovernanceHybrid, isReferredRule, resolveReferredRow,
} from '../../src/core/rubric-referral';
import { GovernanceRule } from '../../src/core/scoring-policy';

const EVIDENCE_ROOT = process.env.CERNUM_EVIDENCE_ROOT
  ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';

/** Every source this gate reads, pinned. A changed digest is a hard stop, never a silent re-baseline. */
const SEALED_SOURCES = {
  // The RAW PASS 8 LEDGER — REQ-01's required join, repointed here by Decision 2. Digests are the
  // ones recorded in `pass08-evidence/SHA256SUMS.txt`.
  pass08LedgerA2: {
    path: 'pass08-evidence/campaign-a2/results.jsonl',
    digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0',
  },
  pass08LedgerB2: {
    path: 'pass08-evidence/campaign-b2/results.jsonl',
    digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96',
  },
  // rowID → slotKey, so the ledger can be addressed. Already opened in Pass 10 for the authorised join.
  pass09IdentityMap: {
    path: 'pass09-sealed/CERNUM-PASS-09-IDENTITY-MAP.SEALED.json',
    digest: '9d7ff549f10275a23a1b6d1b4f5992a00131c3fed4a93158dce51548ac9c23e7',
  },
  pass10FNIdentityMap: {
    path: 'pass10-sealed/CERNUM-PASS-10-FN-IDENTITY-MAP.SEALED.json',
    digest: '7d305a7b789a1e295b41cba55328137470b7230ac045e29aacdb251c82a2e83d',
  },
  // The rulings.
  pass09Adjudication: {
    path: 'pass09-evidence/rulings/CERNUM-PASS-09-ADJUDICATION-SEALED.json',
    digest: 'a8c45965a8684e88f9ed76230f992199550737d681a8090ed720f199afc59208',
  },
  pass09ReviewPacket: {
    path: 'pass09-evidence/review-packet/CERNUM-PASS-09-REVIEW-PACKET.json',
    digest: '27a3922426ceb493a5934449425f36c23f40b3ece954b14a9a36e065ec97955a',
  },
  pass10FNPacket: {
    path: 'pass10-evidence/fn-packet/CERNUM-PASS-10-FN-PACKET.json',
    digest: '46ce79890de9b434e6616fd83138c9de0c15e0bd2712f0e487f4bc28fe772449',
  },
  pass10Consolidated: {
    path: 'pass10-evidence/fn-packet/rulings/CERNUM-PASS-10-FN-CONSOLIDATED-LIVE.json',
    digest: '13076d1ca66c5b2d2369e363d8a3b6dcec32d5b2a1b4e0a68808fff8ba9b5ab9',
  },
  // The reviewer's own sealed sheet — the per-decision verdicts the referred rows resolve through.
  pass10AnswerSheet: {
    path: 'pass10-evidence/fn-packet/rulings/CERNUM-PASS-10-FN-ANSWER-SHEET-FILLED.json',
    digest: '0ff3f26fca240d69ea42949acd92ca24d8e27f96b97eb4a17903e9339870a93b',
  },
  // The control rulings, resolved from blinded label to control ID after their seal verified.
  pass10ControlsResolved: {
    path: 'pass10-evidence/fn-packet/rulings/CERNUM-PASS-10-FN-RULINGS-CONTROLS-RESOLVED.json',
    digest: '69550c72356d394d3eee9b2a91ab48e33390726cdccee670b8aa715ab47455ed',
  },
} as const;

/** The outcome a referred row must produce instead of a mechanical answer. Spelled once, in the module. */
const REQUIRED_REFERRAL_OUTCOME: string = GOVERNANCE_REFERRAL_STATE;

/** The packet's vendor redaction, reproduced so the ledger text can be checked against what was read. */
const VENDOR_REDACTION_TOKEN = '[MODEL NAME REDACTED]';
const VENDOR_TERMS = /claude/gi;
function asRedactedForReview(text: string): string {
  return text.replace(VENDOR_TERMS, VENDOR_REDACTION_TOKEN);
}

function hardStop(detail: string): never {
  throw new Error(`ADOPTION GATE HARD STOP — ${detail}`);
}

function loadPinned(key: keyof typeof SEALED_SOURCES): Buffer {
  const { path, digest } = SEALED_SOURCES[key];
  const bytes = readFileSync(join(EVIDENCE_ROOT, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) {
    hardStop(
      `sealed evidence changed under ${key}.\n` +
      `  file:     ${path}\n  expected: ${digest}\n  actual:   ${actual}\n` +
      `A correction is an amendment recorded beside the sealed record, never an edit in place. ` +
      `Do not re-pin this digest to make the gate green.`);
  }
  return bytes;
}

function loadSealed(key: keyof typeof SEALED_SOURCES): any {
  return JSON.parse(loadPinned(key).toString('utf8'));
}

function requireExactly(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    hardStop(`loaded ${actual} ${label}, required exactly ${expected}. ` +
      `A subset cannot close REQ-01: it can pass while the matcher has regressed on a row nobody transcribed.`);
  }
}

/** The raw Pass 8 ledger, indexed by `slotKey`. REQ-01's required join target. */
function loadPass8Ledger(): Map<string, { answerText: string; campaign: string }> {
  const bySlot = new Map<string, { answerText: string; campaign: string }>();
  for (const [key, campaign] of [['pass08LedgerA2', 'campaign-a2'], ['pass08LedgerB2', 'campaign-b2']] as const) {
    const text = loadPinned(key).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      const row = JSON.parse(line);
      if (typeof row.slotKey !== 'string' || row.slotKey.length === 0) {
        hardStop(`a ${campaign} ledger row carries no slotKey; the join cannot be made one-to-one`);
      }
      if (bySlot.has(row.slotKey)) {
        hardStop(`duplicate slotKey in the Pass 8 ledger — ${row.slotKey}. The join must be one-to-one.`);
      }
      if (typeof row.answerText !== 'string') {
        hardStop(`ledger row ${row.slotKey} carries no answerText`);
      }
      bySlot.set(row.slotKey, { answerText: row.answerText, campaign });
    }
  }
  requireExactly('raw Pass 8 ledger attempts', bySlot.size, 616);
  return bySlot;
}

const ledger = loadPass8Ledger();

/** rowID → slotKey, from whichever sealed identity map governs the family. */
function identityIndex(key: 'pass09IdentityMap' | 'pass10FNIdentityMap'): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of loadSealed(key).rows) map.set(r.rowID, r.slotKey);
  return map;
}
const pass09Slot = identityIndex('pass09IdentityMap');
const pass10Slot = identityIndex('pass10FNIdentityMap');

/**
 * The response text for a row, taken FROM THE LEDGER — and checked against the text the adjudicator
 * actually read. The check is what stops the repoint from quietly changing what is being asserted.
 */
function ledgerTextFor(rowID: string, slotByRow: Map<string, string>, adjudicatedText: string): string {
  const slotKey = slotByRow.get(rowID);
  if (!slotKey) hardStop(`no slotKey for ${rowID} in the sealed identity map; the ledger join cannot be made`);
  const entry = ledger.get(slotKey!);
  if (!entry) hardStop(`slotKey ${slotKey} for ${rowID} is absent from the raw Pass 8 ledger`);
  const raw = entry!.answerText;
  if (raw.length === 0) hardStop(`ledger row for ${rowID} carries empty answerText`);
  if (raw !== adjudicatedText && asRedactedForReview(raw) !== adjudicatedText) {
    hardStop(
      `the raw Pass 8 ledger and the adjudicated packet disagree for ${rowID}, and the difference is ` +
      `not the packet's vendor redaction.\n  ledger:  ${JSON.stringify(raw.slice(0, 160))}\n` +
      `  packet:  ${JSON.stringify(adjudicatedText.slice(0, 160))}\n` +
      `The gate asserts on the ledger; it may not assert on text a person never saw.`);
  }
  return raw;
}

const ruleByID = new Map<string, GovernanceRule>();
for (const suite of registeredSuites) {
  for (const c of suite.cases) {
    const policy = policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion);
    if (policy?.hardGovernance) ruleByID.set(policy.hardGovernance.ruleID, policy.hardGovernance);
  }
}
function rule(id: string): GovernanceRule {
  const found = ruleByID.get(id);
  if (!found) hardStop(`no governed rule ${id} in the catalog`);
  return found!;
}

interface GateRow {
  assertion: number;
  family: string;
  id: string;
  ruleID: string;
  text: string;
  /** Where the asserted text came from. The 133 observed rows join the ledger; controls are authored. */
  textSource: 'pass08-ledger' | 'authored-control';
  referred: boolean;
  /** For a referred row: the verdict its sealed human ruling must resolve to. */
  expectedResolution?: ReferralVerdict;
}

/** Family 1 — all 132 adjudicated false positives, expanded from the 130 sealed governance decisions. */
function loadFalsePositives(): GateRow[] {
  const sealed = loadSealed('pass09Adjudication');
  const packet = loadSealed('pass09ReviewPacket');
  const textByDecision = new Map<string, string>(
    packet.decisions.map((d: any) => [d.decisionID, d.responseText]));

  const rows: GateRow[] = [];
  const seen = new Set<string>();
  for (const r of sealed.rulings) {
    if (r.kind !== 'governance') continue;
    if (r.verdict !== 'compliant') {
      hardStop(`governance decision ${r.decisionID} is '${r.verdict}', not 'compliant'. ` +
               `This family asserts adjudicated false positives only.`);
    }
    const adjudicated = textByDecision.get(r.decisionID);
    if (typeof adjudicated !== 'string' || adjudicated.length === 0) {
      hardStop(`no adjudicated response text for ${r.decisionID}`);
    }
    for (const rowID of r.coversRowIDs) {
      if (seen.has(rowID)) hardStop(`duplicate row ${rowID}`);
      seen.add(rowID);
      const referred = isReferredRule(r.ruleID);
      rows.push({
        assertion: 0, family: 'adjudicated-false-positive', id: rowID, ruleID: r.ruleID,
        text: ledgerTextFor(rowID, pass09Slot, adjudicated!),
        textSource: 'pass08-ledger',
        referred,
        // Under per-rule referral these 13 still reach `compliant` — but through the rubric judge,
        // on the strength of the ruling a person already recorded, not through the mechanical layer.
        expectedResolution: referred ? (r.verdict as ReferralVerdict) : undefined,
      });
    }
  }
  requireExactly('adjudicated false-positive rows', rows.length, 132);
  requireExactly('adjudicated false positives under the referred rule',
                 rows.filter((r) => r.referred).length, 13);
  requireExactly('adjudicated false positives under the thirteen mechanical rules',
                 rows.filter((r) => !r.referred).length, 119);
  return rows;
}

/** Family 2 — all 24 seeded controls. Authored, not observed; they never enter any model's result. */
function loadControls(): GateRow[] {
  const packet = loadSealed('pass10FNPacket');
  const resolved = loadSealed('pass10ControlsResolved');
  const rulingByControl = new Map<string, any>(resolved.controls.map((c: any) => [c.controlID, c]));

  const rows: GateRow[] = packet.controls.items.map((i: any) => {
    if (i.expected !== 'genuineViolation') {
      hardStop(`control ${i.controlID} expects '${i.expected}', not 'genuineViolation'`);
    }
    const referred = isReferredRule(i.ruleID);
    let expectedResolution: ReferralVerdict | undefined;
    if (referred) {
      const ruling = rulingByControl.get(i.controlID);
      if (!ruling) hardStop(`control ${i.controlID} is on the referred rule but has no sealed control ruling`);
      expectedResolution = ruling.humanVerdict as ReferralVerdict;
    }
    return {
      assertion: 0, family: `control:${i.family}`, id: i.controlID, ruleID: i.ruleID,
      text: i.responseText, textSource: 'authored-control' as const, referred, expectedResolution,
    };
  });
  requireExactly('seeded controls', rows.length, 24);
  requireExactly('seeded controls under the referred rule', rows.filter((r) => r.referred).length, 1);
  requireExactly('seeded controls under the thirteen mechanical rules',
                 rows.filter((r) => !r.referred).length, 23);
  return rows;
}

/** Family 3 — the one confirmed live false negative. */
function loadConfirmedFalseNegatives(): GateRow[] {
  const cons = loadSealed('pass10Consolidated');
  const packet = loadSealed('pass10FNPacket');
  const sheet = loadSealed('pass10AnswerSheet');
  const textByDecision = new Map<string, string>(
    packet.decisions.map((d: any) => [d.decisionID, d.responseText]));
  const verdictByDecision = new Map<string, string>(
    sheet.answers.map((a: any) => [a.decisionID, a.verdict]));

  const rows: GateRow[] = [];
  for (const fn of cons.falseNegatives) {
    const adjudicated = textByDecision.get(fn.decisionID);
    if (typeof adjudicated !== 'string') hardStop(`no response text for ${fn.decisionID}`);
    const verdict = verdictByDecision.get(fn.decisionID);
    if (verdict !== 'genuineViolation') {
      hardStop(`${fn.decisionID} is listed as a false negative but its sealed verdict is '${verdict}'`);
    }
    for (const rowID of fn.coversRowIDs) {
      rows.push({
        assertion: 0, family: 'confirmed-false-negative', id: rowID, ruleID: fn.ruleID,
        text: ledgerTextFor(rowID, pass10Slot, adjudicated!),
        textSource: 'pass08-ledger',
        referred: isReferredRule(fn.ruleID),
        expectedResolution: verdict as ReferralVerdict,
      });
    }
  }
  requireExactly('confirmed false-negative rows', rows.length, 1);
  if (rows[0].id !== 'FNROW-14a8cef100f2') {
    hardStop(`expected FNROW-14a8cef100f2, loaded ${rows[0].id}`);
  }
  if (!rows[0].referred) {
    hardStop(`FNROW-14a8cef100f2 is on ${rows[0].ruleID}, which Decision 1 referred as a whole rule, ` +
             `but the referred set does not contain it`);
  }
  return rows;
}

/** What the hybrid policy produces for a row today: thirteen rules mechanical, one referred. */
function policyOutcome(row: GateRow): string {
  return assessGovernanceHybrid(rule(row.ruleID), row.text, CANDIDATE_SPEC_BY_RULE.get(row.ruleID)).state;
}

/**
 * The required outcome, per Decision 1 — PER-RULE referral.
 *
 * Every row of `gov.memory.no-resurrect-deleted` must produce the referral state, whatever family it
 * belongs to. "Cleared" and "detected" are not the right words for those rows and the gate no longer
 * uses them: a referral is neither.
 */
function requiredOutcome(row: GateRow): string {
  if (row.referred) return REQUIRED_REFERRAL_OUTCOME;
  if (row.family === 'adjudicated-false-positive') return 'satisfied';
  return 'violated';
}

/** The sealed human rulings a referred row resolves through — Gate A's resolution path, exercised. */
function sealedRulingsForReferredRows(rows: GateRow[]): Map<string, ReferralRuling> {
  const sealed = loadSealed('pass09Adjudication');
  const resolved = loadSealed('pass10ControlsResolved');
  const sheet = loadSealed('pass10AnswerSheet');
  const cons = loadSealed('pass10Consolidated');

  const rationaleByRow = new Map<string, string>();
  const verdictByRow = new Map<string, string>();
  for (const r of sealed.rulings) {
    for (const rowID of r.coversRowIDs ?? []) {
      verdictByRow.set(rowID, r.verdict);
      rationaleByRow.set(rowID, r.rationale ?? '');
    }
  }
  for (const c of resolved.controls) {
    verdictByRow.set(c.controlID, c.humanVerdict);
    rationaleByRow.set(c.controlID, c.rationale ?? '');
  }
  const sheetVerdict = new Map<string, string>(sheet.answers.map((a: any) => [a.decisionID, a.verdict]));
  const sheetRationale = new Map<string, string>(sheet.answers.map((a: any) => [a.decisionID, a.rationale]));
  for (const fn of cons.falseNegatives) {
    for (const rowID of fn.coversRowIDs) {
      verdictByRow.set(rowID, sheetVerdict.get(fn.decisionID) ?? '');
      rationaleByRow.set(rowID, sheetRationale.get(fn.decisionID) ?? fn.rationale ?? '');
    }
  }

  const rulings = new Map<string, ReferralRuling>();
  for (const row of rows) {
    if (!row.referred) continue;
    const verdict = verdictByRow.get(row.id);
    const rationale = rationaleByRow.get(row.id);
    if (verdict === undefined || rationale === undefined) {
      hardStop(`referred row ${row.id} has no sealed human ruling; a referred row may not be resolved ` +
               `by a default, a timeout, or an implementer's judgement`);
    }
    rulings.set(row.id, { referralID: row.id, verdict: verdict!, rationale: rationale! });
  }
  return rulings;
}

const falsePositives = loadFalsePositives();
const controls = loadControls();
const confirmedFalseNegatives = loadConfirmedFalseNegatives();
const all = [...falsePositives, ...controls, ...confirmedFalseNegatives];
all.forEach((r, i) => { r.assertion = i + 1; });
requireExactly('total gate assertions', all.length, 157);
requireExactly('rows referred to human review under the per-rule reading',
               all.filter((r) => r.referred).length, 15);

const sealedRulings = sealedRulingsForReferredRows(all);

const results: any[] = [];
function record(row: GateRow, expected: string, actual: string,
                resolution?: { expected?: string; actual?: string; passed: boolean }): void {
  const outcomeOK = actual === expected;
  results.push({
    assertion: row.assertion, family: row.family, id: row.id, ruleID: row.ruleID,
    rubricReferredRule: row.referred, textSource: row.textSource,
    expected, actual,
    resolutionExpected: resolution?.expected, resolutionActual: resolution?.actual,
    passed: outcomeOK && (resolution ? resolution.passed : true),
  });
}

/** A referred row: it must refer, and its sealed ruling must then resolve it to the recorded verdict. */
function assertReferred(row: GateRow): void {
  const actual = policyOutcome(row);
  const resolved = resolveReferredRow({ referralID: row.id, ruleID: row.ruleID }, sealedRulings);
  record(row, requiredOutcome(row), actual, {
    expected: row.expectedResolution, actual: resolved.verdict,
    passed: resolved.verdict === row.expectedResolution,
  });
  // A referred row is never a mechanical pass and never a mechanical fail.
  expect(actual).not.toBe('satisfied');
  expect(actual).not.toBe('violated');
  expect(actual).toBe(REQUIRED_REFERRAL_OUTCOME);
  // And the human ruling that already exists resolves it.
  expect(resolved.verdict).toBe(row.expectedResolution);
  expect(resolved.rationale.trim().length).toBeGreaterThan(0);
}

function assertMechanical(row: GateRow): void {
  const actual = policyOutcome(row);
  record(row, requiredOutcome(row), actual);
  expect(actual).toBe(requiredOutcome(row));
}

describe('REQ-01 · permanent adoption gate · 157 assertions · per-rule referral · raw Pass 8 ledger join', () => {
  describe('family 1 — 132 adjudicated false positives (119 clear mechanically, 13 refer)', () => {
    for (const row of falsePositives) {
      const what = row.referred ? 'refers, and resolves compliant' : 'clears';
      it(`#${row.assertion} ${row.id} (${row.ruleID}) ${what}`, () => {
        if (row.referred) assertReferred(row); else assertMechanical(row);
      });
    }
  });

  describe('family 2 — 24 seeded controls (23 detected mechanically, CTRL-POS-06 refers)', () => {
    for (const row of controls) {
      const what = row.referred ? 'refers, and resolves genuineViolation' : 'is detected';
      it(`#${row.assertion} ${row.id} (${row.ruleID}) ${what}`, () => {
        if (row.referred) assertReferred(row); else assertMechanical(row);
      });
    }
  });

  describe('family 3 — the confirmed false negative must not silently pass', () => {
    for (const row of confirmedFalseNegatives) {
      it(`#${row.assertion} ${row.id} (${row.ruleID}) refers, and resolves genuineViolation`, () => {
        assertReferred(row);
      });
    }
  });

  it('joins every observed row through the raw Pass 8 ledger', () => {
    const observed = all.filter((r) => r.textSource === 'pass08-ledger');
    expect(observed.length).toBe(133);
    expect(all.filter((r) => r.textSource === 'authored-control').length).toBe(24);
  });

  it('writes the gate report', () => {
    const out = process.env.CERNUM_GATE_REPORT;
    if (!out) return;
    const passed = results.filter((r) => r.passed).length;
    writeFileSync(out, JSON.stringify({
      gate: 'REQ-01', assertionsRequired: 157, assertionsLoaded: all.length,
      counts: {
        adjudicatedFalsePositives: falsePositives.length,
        adjudicatedFalsePositivesMechanical: falsePositives.filter((r) => !r.referred).length,
        adjudicatedFalsePositivesReferred: falsePositives.filter((r) => r.referred).length,
        seededControls: controls.length,
        seededControlsMechanical: controls.filter((r) => !r.referred).length,
        seededControlsReferred: controls.filter((r) => r.referred).length,
        confirmedFalseNegatives: confirmedFalseNegatives.length,
        referredRowsTotal: all.filter((r) => r.referred).length,
      },
      passed, failed: results.length - passed,
      req01Closes: passed === 157,
      referralReadingUsed: 'per-rule (Decision 1, 2026-09-15, source: human, finalDecisionMaker: Seth J. Leopold)',
      rubricReferredRules: [...RUBRIC_REFERRED_RULES],
      requiredReferralOutcome: REQUIRED_REFERRAL_OUTCOME,
      join: {
        requirement: 'REQ-01 — join the adjudicated rows to their response text through the Pass 8 ledger',
        honoured: true,
        source: ['pass08-evidence/campaign-a2/results.jsonl', 'pass08-evidence/campaign-b2/results.jsonl'],
        ledgerAttempts: ledger.size,
        key: 'rowID → slotKey (sealed identity map) → ledger row; slotKey unique across all 616',
        rowsJoined: all.filter((r) => r.textSource === 'pass08-ledger').length,
        authoredControlsNotInLedger: all.filter((r) => r.textSource === 'authored-control').length,
        checkedAgainst: 'pass09-evidence/review-packet/CERNUM-PASS-09-REVIEW-PACKET.json',
        note: 'Ledger text must equal the adjudicated text, or equal it after the packet\'s vendor '
            + 'redaction. 129 identical, 3 redaction-explained, 0 unexplained.',
      },
      sealedSources: SEALED_SOURCES,
      results,
    }, null, 2));
  });
});
