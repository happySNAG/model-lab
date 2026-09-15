// Benchmark engine · assemble the adjudication packet from sealed campaign evidence.
//
// READ-ONLY WITH RESPECT TO THE EVIDENCE, and deliberately so. Pass 8's ledgers are the record of
// 616 real requests that cost $10.138235 of plan allowance and cannot be re-measured; this module
// opens them, copies what it needs, and writes only to the directories it is given. Nothing here
// can rewrite a row, and `reinterpretDispositions` below exists precisely so the corrected reading
// of the four content refusals can be published WITHOUT touching the sealed originals.
//
// It also holds the offline reinterpretation, because the two belong together: both answer the
// question "what would this campaign have said if the engine had been right", and both must answer
// it beside the original rather than over it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BenchmarkCase } from '../core/benchmark';
import { caseByID, humanReviewRubrics, policyCatalog } from '../core/catalog';
import { CaseMaterial, GovernanceRow, RubricRow } from './adjudication';
import { dispositionOf, isContentFilterRefusal, AttemptDisposition } from './attempt-disposition';

/** One row of a campaign's `results.jsonl`, as far as anything here is willing to assume. */
export interface EvidenceRow {
  slotKey: string;
  status: string;
  caseID?: string;
  candidate?: string;
  answerText?: string;
  detail?: string;
  governanceViolated?: boolean;
  disposition?: string;
  retryCount?: number;
  [key: string]: unknown;
}

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/** Read a JSONL ledger. A torn last line is refused, not skipped: a short read is not a short campaign. */
export function readResultsJSONL(file: string): EvidenceRow[] {
  if (!fs.existsSync(file)) throw new EvidenceError(`no results ledger at ${file}`);
  const rows: EvidenceRow[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as EvidenceRow);
    } catch {
      throw new EvidenceError(`${file} line ${index + 1} is not valid JSON; refusing to build a packet from a partially-read ledger`);
    }
  }
  return rows;
}

function candidateOf(row: EvidenceRow): string {
  return typeof row.candidate === 'string' && row.candidate.length > 0 ? row.candidate : String(row.slotKey).split('|')[0];
}

function caseOf(row: EvidenceRow): string {
  return typeof row.caseID === 'string' && row.caseID.length > 0 ? row.caseID : String(row.slotKey).split('|')[3] ?? '';
}

/** The rows a person has to look at: every governance violation, and every awaited rubric judgment. */
export function referredRows(rows: EvidenceRow[]): { governance: GovernanceRow[]; rubric: RubricRow[] } {
  const governance: GovernanceRow[] = [];
  const rubric: RubricRow[] = [];
  for (const row of rows) {
    const caseID = caseOf(row);
    const candidate = candidateOf(row);
    if (row.governanceViolated === true) {
      governance.push({ slotKey: row.slotKey, candidate, caseID, answerText: String(row.answerText ?? ''), detail: String(row.detail ?? '') });
    }
    if (row.status === 'requiresHumanReview') {
      rubric.push({ slotKey: row.slotKey, candidate, caseID, answerText: String(row.answerText ?? '') });
    }
  }
  return { governance, rubric };
}

/** The user turn of a case, which is the prompt a reviewer needs. The system turn is identical on every case. */
function userPrompt(benchmarkCase: BenchmarkCase): string {
  const user = [...benchmarkCase.inputs.messages].reverse().find((message) => message.role === 'user');
  return user?.content ?? '';
}

/**
 * Prompt, context, rule and rubric for every case named by the referred rows.
 *
 * Read from the SEALED CATALOG, never from the campaign's own copy of the prompt — the two are
 * proven identical by `promptsDigest`, and taking the catalog's copy means the rule and the prompt a
 * reviewer sees always came from the same place.
 */
export function caseMaterialFor(caseIDs: Iterable<string>): Map<string, CaseMaterial> {
  const out = new Map<string, CaseMaterial>();
  for (const caseID of new Set(caseIDs)) {
    const benchmarkCase = caseByID(caseID);
    if (!benchmarkCase) throw new EvidenceError(`case ${caseID} is referred for review but is not in the sealed catalog; the packet would have to invent its prompt`);
    const policy = policyCatalog.policy(benchmarkCase.scoringPolicyID, benchmarkCase.scoringPolicyVersion);
    if (!policy) throw new EvidenceError(`case ${caseID} names scoring policy ${benchmarkCase.scoringPolicyID}@${benchmarkCase.scoringPolicyVersion}, which the catalog does not register`);
    out.set(caseID, {
      prompt: userPrompt(benchmarkCase),
      suppliedContext: benchmarkCase.inputs.syntheticContext,
      rule: policy.hardGovernance,
      rubric: humanReviewRubrics.find((candidate) => candidate.dimension === policy.dimension),
    });
  }
  return out;
}

// MARK: - The offline reinterpretation

export interface ReinterpretedRow {
  slotKey: string;
  caseID: string;
  candidate: string;
  /** What the sealed evidence says, unchanged. */
  originalStatus: string;
  /** What this engine would record now. The original row is not modified. */
  correctedStatus: string;
  correctedDisposition: AttemptDisposition;
  /** How many requests the old classification spent re-asking a question with a fixed answer. */
  retriesSpentOnADeterministicRefusal: number;
  evidence: string;
}

export interface Reinterpretation {
  producedAt: string;
  source: string;
  sealedRowCount: number;
  note: string;
  reinterpreted: ReinterpretedRow[];
  /** Per candidate: how the capability denominators move once these rows leave them. */
  denominatorEffect: { candidate: string; rowsRemovedFromScoring: number; casesAffected: string[] }[];
  wastedRequests: number;
}

export const REINTERPRETATION_NOTE =
  'OFFLINE AND BESIDE THE ORIGINAL. Not one byte of the sealed Pass 8 ledger is modified by this file. '
  + 'It states what the corrected engine WOULD have recorded for rows that Pass 8 wrote as `runtimeError` '
  + 'and counted as model-quality failures. The rows are not re-run, no request is sent, and the original '
  + 'campaign result stands as the campaign result. A benchmark that edited its own history after finding a '
  + 'defect would be a benchmark whose history means nothing.';

/**
 * What the corrected classification does to a sealed campaign, computed without touching it.
 *
 * A row qualifies when it was recorded `runtimeError` AND its detail carries either a provider
 * content-filter marker or this engine's own tool-contamination sentence. Both tests are on the
 * recorded detail, so the reinterpretation is reproducible from the evidence file alone.
 */
export function reinterpretDispositions(rows: EvidenceRow[], source: string, producedAt: string): Reinterpretation {
  const reinterpreted: ReinterpretedRow[] = [];
  for (const row of rows) {
    if (row.status !== 'runtimeError') continue;
    const detail = String(row.detail ?? '');
    const contaminated = /this turn invoked \d+ tool\(s\)/.test(detail);
    const refused = isContentFilterRefusal(detail);
    if (!contaminated && !refused) continue;
    const disposition: AttemptDisposition = refused ? 'providerRefusedContent' : 'interfaceContaminated';
    reinterpreted.push({
      slotKey: row.slotKey,
      caseID: caseOf(row),
      candidate: candidateOf(row),
      originalStatus: row.status,
      correctedStatus: 'envelopeFailure',
      correctedDisposition: disposition,
      // Only a content refusal is deterministic. A contaminated turn's retries, if any, are not
      // counted here as waste, because a second attempt might genuinely not have run a tool.
      retriesSpentOnADeterministicRefusal: refused && typeof row.retryCount === 'number' ? row.retryCount : 0,
      evidence: detail.slice(0, 400),
    });
  }

  const candidates = [...new Set(reinterpreted.map((row) => row.candidate))].sort();
  return {
    producedAt,
    source,
    sealedRowCount: rows.length,
    note: REINTERPRETATION_NOTE,
    reinterpreted: reinterpreted.sort((a, b) => (a.slotKey < b.slotKey ? -1 : 1)),
    denominatorEffect: candidates.map((candidate) => {
      const mine = reinterpreted.filter((row) => row.candidate === candidate);
      return {
        candidate,
        rowsRemovedFromScoring: mine.length,
        casesAffected: [...new Set(mine.map((row) => row.caseID))].sort(),
      };
    }),
    wastedRequests: reinterpreted.reduce((sum, row) => sum + row.retriesSpentOnADeterministicRefusal, 0),
  };
}

/** Rows as the corrected engine would carry them into a ranking, for an offline recount. */
export function correctedOutcomeDisposition(row: EvidenceRow): AttemptDisposition {
  if (row.status === 'runtimeError') {
    const detail = String(row.detail ?? '');
    if (isContentFilterRefusal(detail)) return 'providerRefusedContent';
    if (/this turn invoked \d+ tool\(s\)/.test(detail)) return 'interfaceContaminated';
  }
  return dispositionOf(row);
}

/** Write a JSON artefact, creating its directory. Pretty-printed: these are read by people. */
export function writeArtefact(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// MARK: - The recount, which is the point of the reinterpretation

export interface RecountedCandidate {
  candidate: string;
  /** As the sealed campaign counted it: the refusals and contaminations counted as fails. */
  sealedScoredCount: number;
  sealedPassRateMilli: number | null;
  /** With rule 6 applied: those rows out of the numerator and the denominator. */
  correctedScoredCount: number;
  correctedPassRateMilli: number | null;
  /** Positive when the corrected rate is higher. `null` when either rate has no denominator. */
  deltaMilli: number | null;
  providerRefusalRateMilli: number;
  interfaceContaminationRateMilli: number;
}

/**
 * The same rows counted twice: once as Pass 8 counted them, once under the corrected rule.
 *
 * BOTH FIGURES ARE PUBLISHED AND NEITHER REPLACES THE OTHER. The sealed rate is what the campaign
 * recorded and stays the campaign's result; the corrected rate is what the rule change does to it,
 * shown so the size of the defect is a number rather than an assurance. Note also what the delta is
 * NOT: it is not a new ranking. Every one of these candidates is still disqualified on governance
 * and still identity-unverifiable, and a rate moving by a few points changes neither.
 */
export function recountWithCorrectedDispositions(
  rows: EvidenceRow[],
  dimensionForCase: (caseID: string) => string | undefined,
): RecountedCandidate[] {
  const candidates = [...new Set(rows.map(candidateOf))].sort();
  return candidates.map((candidate) => {
    const mine = rows.filter((row) => candidateOf(row) === candidate);
    // The engine's own counting rule, reproduced on both sides so the two figures differ by exactly
    // one thing: whether an unanswered row is in the denominator.
    const count = (subset: EvidenceRow[]): { scored: number; passes: number } => {
      const judged = subset.filter((row) => row.governanceViolated !== true
        && dimensionForCase(caseOf(row)) !== undefined
        && row.status !== 'requiresHumanReview' && row.status !== 'unsupported');
      return { scored: judged.length, passes: judged.filter((row) => row.status === 'pass').length };
    };
    const sealed = count(mine);
    const corrected = count(mine.filter((row) => correctedOutcomeDisposition(row) === 'modelAnswered'));
    const rate = (of: { scored: number; passes: number }): number | null =>
      (of.scored === 0 ? null : Math.round((of.passes * 1000) / of.scored));
    const refused = mine.filter((row) => correctedOutcomeDisposition(row) === 'providerRefusedContent').length;
    const contaminated = mine.filter((row) => correctedOutcomeDisposition(row) === 'interfaceContaminated').length;
    const sealedRate = rate(sealed);
    const correctedRate = rate(corrected);
    return {
      candidate,
      sealedScoredCount: sealed.scored,
      sealedPassRateMilli: sealedRate,
      correctedScoredCount: corrected.scored,
      correctedPassRateMilli: correctedRate,
      deltaMilli: sealedRate === null || correctedRate === null ? null : correctedRate - sealedRate,
      providerRefusalRateMilli: mine.length === 0 ? 0 : Math.round((refused * 1000) / mine.length),
      interfaceContaminationRateMilli: mine.length === 0 ? 0 : Math.round((contaminated * 1000) / mine.length),
    };
  });
}
