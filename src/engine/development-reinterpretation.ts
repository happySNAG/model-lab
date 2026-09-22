// Benchmark engine · re-reading a sealed development campaign under a newer scoring contract.
//
// NOTHING IS RE-RUN, NOTHING IS SENT, AND NOTHING THE CAMPAIGN RECORDED IS TOUCHED. The campaign's
// `results.jsonl`, plan, meta and per-attempt artefacts are read, hashed, and hashed again after the
// reinterpretation is written; a difference is a refusal. The output is a second, dated, identified
// document in `reinterpretations/` beside the campaign, so a reader holds the recorded result and the
// re-read one at the same time and can see exactly which rows moved and why.
//
// ONLY WHAT CAN BE RE-DERIVED FROM RECORDED BYTES IS RE-GRADED. A repository-understanding row is
// graded from its answer text, and the artefact keeps that text — so it can be graded again. A
// multi-file-edit row is graded from the workspace the attempt left behind, and that workspace was
// deleted after grading; only its digest survives. Those rows are carried unchanged and listed as
// such. (Contract 2 does not change multi-file-edit grading, so carrying them is also correct.)
//
// THE RAW ANSWER IS PROVEN TO BE THE GRADED ANSWER BEFORE IT IS RE-GRADED. Each artefact's text is
// first graded under the ORIGINAL contract, by the task as it was sealed then, and must reproduce
// the recorded row assertion for assertion. An artefact that was truncated, redacted, or belongs to
// some other attempt fails that check, and the whole reinterpretation is refused: a re-read that
// cannot show it started from the same bytes is a new measurement pretending to be an old one.
//
// THE ANSWER KEY IS PROVEN UNCHANGED THE SAME WAY. The current task, with its contract-2 fields taken
// back out, must digest to the task digest recorded on the row. The assertions, prompt and fixture
// are all in that digest, so a match means the only thing that differs is how an answer is read.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DevelopmentTask, developmentComparabilityKey, developmentTaskDigest,
} from '../core/development-benchmark';
import { developmentFixtureByID, developmentTaskByID } from '../core/development-catalog';
import { DevelopmentTaskResult, answerReadingRulesFor, gradeRepositoryQuestion } from '../core/development-evaluation';
import {
  DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION, developmentContractDigest,
} from '../core/development-scoring';
import { seal } from '../core/digest';
import { CanonicalValue } from './canonical';
import {
  DEVELOPMENT_ARTEFACTS_DIRECTORY, DEVELOPMENT_PLAN_FILE, DevelopmentCampaignError, developmentArtefactFileName,
  recordedPromptVersion,
} from './development-campaign';
import { DevelopmentCampaignPlan } from './development-plan';
import {
  DevelopmentAnswerFormat, answerFormatOf, answerReadingOfRow, buildDevelopmentCampaignReport,
  readDevelopmentCampaignState,
} from './development-report';
import { atomicWriteJSON } from './ledger';

export const DEVELOPMENT_REINTERPRETATIONS_DIRECTORY = 'reinterpretations';

/** The artefact keeps at most this many characters of answer text; a full one may have been cut. */
const ARTEFACT_ANSWER_LIMIT = 200_000;

export const DEVELOPMENT_REINTERPRETATION_NOTE =
  'OFFLINE AND BESIDE THE ORIGINAL. No request was sent and no attempt was re-run. Not one byte of the '
  + 'campaign\'s results, plan, meta or artefacts was modified; their hashes are recorded here as they were '
  + 'read. Each repository-understanding answer was first re-graded under the contract it was originally '
  + 'graded under and reproduced its recorded row exactly, and only then graded under the current contract. '
  + 'The recorded campaign result stands as the campaign result; this document is a second, identified '
  + 'reading of the same answers.';

type Row = Record<string, CanonicalValue | undefined>;

function sha256(bytes: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function text(value: CanonicalValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function failedAssertionIDs(outcomes: { id: string; held: boolean }[]): string[] {
  return outcomes.filter((outcome) => !outcome.held).map((outcome) => outcome.id).sort();
}

/** The task exactly as it was sealed under contract 1: no declared shape, the old version. */
export function contract1EquivalentTask(task: DevelopmentTask): DevelopmentTask {
  const { answerShape: _unused, ...rest } = task;
  return { ...rest, scoringContractVersion: '1' };
}

/** The task as it was sealed under the version a row records. Only 1 and the current one are known. */
function taskAsSealedUnder(task: DevelopmentTask, contractVersion: string): DevelopmentTask {
  if (contractVersion === DEVELOPMENT_SCORING_CONTRACT_VERSION) return task;
  if (contractVersion === '1') return contract1EquivalentTask(task);
  throw new DevelopmentCampaignError('unknownContract',
    `a row was graded under contract version ${contractVersion}, which this build cannot reconstruct`);
}

function statusFor(originalStatus: string, result: DevelopmentTaskResult): string {
  // A timeout is reported as the timeout it was, exactly as `developmentTerminalStatus` does.
  if (originalStatus === 'timeout') return 'timeout';
  const credit = result.grade.credit;
  return credit === 'full' ? 'pass' : credit === 'partial' ? 'partial' : 'fail';
}

export interface ReinterpretedAnswerRow {
  slotKey: string;
  candidate: string;
  taskID: string;
  repeat: number;
  rawAnswer: { artefactFile: string; sha256: string; characters: number };
  answerKey: { recordedTaskDigest: string; originalContractEquivalentDigest: string; unchanged: true };
  reproducedUnderOriginalContract: true;
  before: {
    status: string; structuralCredit: string; strictlyParsed: boolean; reading: string; failedAssertions: string[];
  };
  after: {
    status: string; structuralCredit: string; strictlyParsed: boolean; reading: string;
    terminalObjectExtracted: boolean; terminalExtractionRefusedBecause?: string;
    shapeValid?: boolean; shapeViolations: string[]; failedAssertions: string[];
  };
  changed: boolean;
}

export interface DimensionSummary {
  statusCounts: Record<string, number>;
  /** Share of repeats with full structural credit, averaged per task — the `develop-status` score. */
  structuralScoreMilli: number | null;
  /** Mean held-out assertion pass rate over graded repeats. The finer-grained semantic figure. */
  meanHeldOutPassRateMilli: number | null;
  tasksFullyCovered: string;
  repeatsGraded: string;
  mixedTasks: number;
}

export interface CandidateSummary {
  candidate: string;
  repositoryUnderstanding: DimensionSummary & { answerFormat: DevelopmentAnswerFormat };
  multiFileEditing: DimensionSummary;
}

export interface DevelopmentReinterpretation {
  kind: 'developmentReinterpretation';
  formatVersion: 1;
  reinterpretationID: string;
  producedAt: string;
  note: string;
  original: {
    campaign: string;
    planDigest: string;
    promptVersion: string;
    contract: string;
    contractDigest: string;
    benchmarkCommit: string;
    resultsSha256: string;
    planSha256: string;
    metaSha256: string;
    /** One digest over every artefact read, by file name. */
    artefactsSha256: string;
    rowCount: number;
  };
  regradedUnder: {
    contract: string;
    contractDigest: string;
    readingRules: string;
    benchmarkVersion: string;
    benchmarkCommit: string;
    workingTreeDirty?: boolean;
  };
  scope: string;
  rows: ReinterpretedAnswerRow[];
  carriedUnchanged: { slotKey: string; dimension: string; because: string }[];
  summary: { before: CandidateSummary[]; after: CandidateSummary[] };
}

function summarise(plan: DevelopmentCampaignPlan, rows: Row[], derivedAt: string): CandidateSummary[] {
  const report = buildDevelopmentCampaignReport({ plan, rows: rows as never, derivedAt });
  return report.candidates.map((candidate) => {
    const mine = rows.filter((row) => row.candidate === candidate.candidate);
    const dimension = (name: 'repositoryUnderstanding' | 'multiFileEditing'): DimensionSummary => {
      const entry = candidate.evidence.dimensions.find((each) => each.dimension === name)!;
      const graded = mine.filter((row) => row.dimension === name && row.measurementState === 'graded');
      const statusCounts: Record<string, number> = {};
      for (const row of mine.filter((each) => each.dimension === name)) {
        const status = row.measurementState === 'graded' ? text(row.status) : 'unevaluable';
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }
      const heldOut = graded.map((row) => row.heldOutPassRateMilli).filter((value): value is number => typeof value === 'number');
      return {
        statusCounts,
        structuralScoreMilli: 'measured' in entry.structuralPassRateMilli ? entry.structuralPassRateMilli.measured : null,
        meanHeldOutPassRateMilli: heldOut.length === 0 ? null
          : Math.round(heldOut.reduce((sum, value) => sum + value, 0) / heldOut.length),
        tasksFullyCovered: `${entry.gradedTaskCount}/${entry.plannedTaskCount}`,
        repeatsGraded: `${entry.gradedRepeatCount}/${entry.requiredRepeatCount}`,
        mixedTasks: entry.mixedTaskCount,
      };
    };
    return {
      candidate: candidate.candidate,
      repositoryUnderstanding: { ...dimension('repositoryUnderstanding'), answerFormat: answerFormatOf(mine) },
      multiFileEditing: dimension('multiFileEditing'),
    };
  });
}

/** The row a re-graded attempt would have written, carrying where it came from. */
function reinterpretedRow(original: Row, task: DevelopmentTask, result: DevelopmentTaskResult,
                          status: string, reinterpretationID: string): Row {
  const grade = result.grade;
  const answer = result.answer!;
  return {
    ...original,
    status,
    taskDigest: developmentTaskDigest(task),
    comparabilityKey: developmentComparabilityKey(task),
    contractID: DEVELOPMENT_SCORING_CONTRACT_ID,
    contractVersion: DEVELOPMENT_SCORING_CONTRACT_VERSION,
    contractDigest: developmentContractDigest(),
    resultSnapshotDigest: result.resultSnapshotDigest,
    structuralCredit: grade.structuralCredit,
    executedCredit: grade.executedCredit,
    credit: grade.credit,
    creditReason: grade.creditReason,
    heldOutPassRateMilli: 'measured' in grade.heldOutPassRateMilli ? grade.heldOutPassRateMilli.measured : null,
    shortcutSuspected: grade.shortcutSuspected,
    shortcutReasons: grade.shortcutReasons,
    metrics: grade.metrics.map((metric) => ({
      id: metric.id, tier: metric.tier, status: metric.status,
      valueMilli: 'measured' in metric.valueMilli ? metric.valueMilli.measured : null,
      assertionIDs: metric.assertionIDs, detail: metric.detail,
    })),
    assertionOutcomes: result.outcomes.map((outcome) => ({
      id: outcome.id, metric: outcome.metric, visibility: outcome.visibility, held: outcome.held,
      shortcutProbe: outcome.shortcutProbe, detail: outcome.detail,
    })),
    answerStrictlyParsed: answer.strictlyParsed,
    answerSemanticallyParsed: answer.semanticallyParsed,
    answerFenceRemoved: answer.fenceRemoved,
    answerReadingRules: answer.rules,
    answerReading: answer.reading,
    answerTerminalObjectExtracted: answer.terminalObjectExtracted,
    answerTerminalExtractionRefusedBecause: answer.terminalExtractionRefusedBecause,
    answerShapeValid: answer.shapeValid,
    answerShapeViolations: answer.shapeViolations,
    originalTaskDigest: text(original.taskDigest),
    originalContractVersion: text(original.contractVersion),
    reinterpretationID,
  };
}

function hashIfPresent(file: string): string {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : 'absent';
}

/**
 * Re-read a development campaign's repository-understanding answers under the current contract.
 *
 * Returns the reinterpretation and writes it only when `write` is true. Throws, having written
 * nothing, when any answer cannot be shown to be the bytes that were originally graded.
 */
export function reinterpretDevelopmentCampaign(options: {
  root: string;
  producedAt: string;
  benchmarkVersion: string;
  benchmarkCommit: string;
  workingTreeDirty?: boolean;
  write: boolean;
}): { reinterpretation: DevelopmentReinterpretation; writtenTo?: string } {
  const { root, producedAt } = options;
  const resultsFile = path.join(root, 'results.jsonl');
  const planFile = path.join(root, DEVELOPMENT_PLAN_FILE);
  const metaFile = path.join(root, 'meta.json');
  const before = { results: hashIfPresent(resultsFile), plan: hashIfPresent(planFile), meta: hashIfPresent(metaFile) };

  const state = readDevelopmentCampaignState(root);
  if (state.unreadableLines > 0) {
    throw new DevelopmentCampaignError('unreadableRows',
      `${state.unreadableLines} line(s) of ${resultsFile} do not parse; a reinterpretation of part of a campaign is not one`);
  }
  const { plan } = state;
  const originalRows = state.rows as Row[];

  const artefactHashes: Record<string, string> = {};
  const regraded: { original: Row; task: DevelopmentTask; result: DevelopmentTaskResult; row: ReinterpretedAnswerRow }[] = [];
  const carriedUnchanged: DevelopmentReinterpretation['carriedUnchanged'] = [];

  for (const original of originalRows) {
    const slotKey = text(original.slotKey);
    if (original.dimension !== 'repositoryUnderstanding') {
      carriedUnchanged.push({ slotKey, dimension: text(original.dimension),
        because: 'graded from a workspace that was deleted after grading; only its digest was kept, so it cannot be '
          + 're-derived — and contract 2 does not change multi-file-edit grading' });
      continue;
    }
    if (original.measurementState !== 'graded') {
      carriedUnchanged.push({ slotKey, dimension: text(original.dimension),
        because: 'no model answered this attempt, so there is no answer to read under any contract' });
      continue;
    }
    if (original.answerSource !== 'providerReply' && original.answerSource !== 'none') {
      throw new DevelopmentCampaignError('answerNotRecorded',
        `${slotKey} was graded from ${text(original.answerSource) || 'an unrecorded source'}, whose bytes the artefact `
        + 'does not keep; the campaign cannot be reinterpreted from recorded evidence');
    }

    const artefactName = developmentArtefactFileName(slotKey);
    const artefactPath = path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY, artefactName);
    if (!fs.existsSync(artefactPath)) {
      throw new DevelopmentCampaignError('artefactMissing', `${slotKey} has no artefact at ${artefactPath}; its answer was not kept`);
    }
    const artefactBytes = fs.readFileSync(artefactPath);
    artefactHashes[artefactName] = sha256(artefactBytes);
    const artefact = JSON.parse(artefactBytes.toString('utf8')) as Record<string, CanonicalValue>;
    if (artefact.slotKey !== slotKey || artefact.runID !== original.runID) {
      throw new DevelopmentCampaignError('artefactMismatch', `${artefactPath} does not describe ${slotKey} (run ${text(original.runID)})`);
    }
    const answerText = text(artefact.answerText);
    if (answerText.length >= ARTEFACT_ANSWER_LIMIT) {
      throw new DevelopmentCampaignError('answerTruncated',
        `${slotKey}'s recorded answer reaches the artefact's ${ARTEFACT_ANSWER_LIMIT}-character limit and may have been cut`);
    }

    const current = developmentTaskByID(text(original.taskID));
    const repo = current && developmentFixtureByID(current.fixtureRepoID, current.fixtureRepoVersion);
    if (!current || !repo) {
      throw new DevelopmentCampaignError('unknownTask', `${text(original.taskID)} is not in this build's development registry`);
    }

    // The answer key: the task as sealed under the row's contract must be the task the row names.
    const originalVersion = text(original.contractVersion);
    const asSealed = taskAsSealedUnder(current, originalVersion);
    const sealedDigest = developmentTaskDigest(asSealed);
    if (sealedDigest !== original.taskDigest) {
      throw new DevelopmentCampaignError('answerKeyChanged',
        `${text(original.taskID)} digests to ${sealedDigest} under contract ${originalVersion}, but ${slotKey} was graded `
        + `against ${text(original.taskDigest)}. The task itself changed, so its answers cannot be re-read as the same measurement.`);
    }

    // The raw answer: graded as it originally was, it must reproduce the recorded row exactly.
    const reproduced = gradeRepositoryQuestion(asSealed, repo, answerText,
      { taskDigest: sealedDigest, comparabilityKey: text(original.comparabilityKey) },
      { contractVersion: originalVersion });
    const recordedOutcomes = (Array.isArray(original.assertionOutcomes) ? original.assertionOutcomes : [])
      .map((entry) => entry as Record<string, CanonicalValue>)
      .map((entry) => `${text(entry.id)}=${entry.held === true}`).sort();
    const reproducedOutcomes = reproduced.outcomes.map((outcome) => `${outcome.id}=${outcome.held}`).sort();
    if (JSON.stringify(recordedOutcomes) !== JSON.stringify(reproducedOutcomes)
        || reproduced.grade.structuralCredit !== original.structuralCredit
        || reproduced.answer!.strictlyParsed !== original.answerStrictlyParsed) {
      throw new DevelopmentCampaignError('notReproduced',
        `${slotKey}: the recorded answer text, graded under contract ${originalVersion}, does not reproduce the recorded `
        + 'row, so it is not provably the answer that was graded. Nothing was written.');
    }

    const result = gradeRepositoryQuestion(current, repo, answerText,
      { taskDigest: developmentTaskDigest(current), comparabilityKey: developmentComparabilityKey(current) });
    const answer = result.answer!;
    const beforeReading = answerReadingOfRow(original).reading;
    const status = statusFor(text(original.status), result);
    regraded.push({
      original, task: current, result,
      row: {
        slotKey,
        candidate: text(original.candidate),
        taskID: text(original.taskID),
        repeat: typeof original.repeat === 'number' ? original.repeat : 0,
        rawAnswer: { artefactFile: `${DEVELOPMENT_ARTEFACTS_DIRECTORY}/${artefactName}`, sha256: sha256(answerText), characters: answerText.length },
        answerKey: { recordedTaskDigest: text(original.taskDigest), originalContractEquivalentDigest: sealedDigest, unchanged: true },
        reproducedUnderOriginalContract: true,
        before: {
          status: text(original.status),
          structuralCredit: text(original.structuralCredit),
          strictlyParsed: original.answerStrictlyParsed === true,
          reading: beforeReading,
          failedAssertions: recordedOutcomes.filter((entry) => entry.endsWith('=false')).map((entry) => entry.slice(0, -6)),
        },
        after: {
          status,
          structuralCredit: result.grade.structuralCredit,
          strictlyParsed: answer.strictlyParsed,
          reading: answer.reading,
          terminalObjectExtracted: answer.terminalObjectExtracted,
          terminalExtractionRefusedBecause: answer.terminalExtractionRefusedBecause,
          shapeValid: answer.shapeValid,
          shapeViolations: answer.shapeViolations,
          failedAssertions: failedAssertionIDs(result.outcomes),
        },
        changed: status !== text(original.status) || result.grade.structuralCredit !== original.structuralCredit,
      },
    });
  }

  const artefactsSha256 = sha256(JSON.stringify(Object.entries(artefactHashes).sort(([a], [b]) => a.localeCompare(b))));
  const reinterpretationID = seal({
    planDigest: plan.planDigest, results: before.results, artefacts: artefactsSha256,
    contractDigest: developmentContractDigest(), producedAt,
  }, 'mldri1:');

  const regradedBySlot = new Map(regraded.map((entry) => [text(entry.original.slotKey),
    reinterpretedRow(entry.original, entry.task, entry.result, entry.row.after.status, reinterpretationID)]));
  const afterRows = originalRows.map((row) => regradedBySlot.get(text(row.slotKey)) ?? row);

  const reinterpretation: DevelopmentReinterpretation = {
    kind: 'developmentReinterpretation',
    formatVersion: 1,
    reinterpretationID,
    producedAt,
    note: DEVELOPMENT_REINTERPRETATION_NOTE,
    original: {
      campaign: plan.label,
      planDigest: plan.planDigest,
      promptVersion: recordedPromptVersion(plan),
      contract: `${plan.contractID}@${plan.contractVersion}`,
      contractDigest: plan.contractDigest,
      benchmarkCommit: plan.benchmarkCommit,
      resultsSha256: before.results,
      planSha256: before.plan,
      metaSha256: before.meta,
      artefactsSha256,
      rowCount: originalRows.length,
    },
    regradedUnder: {
      contract: `${DEVELOPMENT_SCORING_CONTRACT_ID}@${DEVELOPMENT_SCORING_CONTRACT_VERSION}`,
      contractDigest: developmentContractDigest(),
      readingRules: answerReadingRulesFor(DEVELOPMENT_SCORING_CONTRACT_VERSION),
      benchmarkVersion: options.benchmarkVersion,
      benchmarkCommit: options.benchmarkCommit,
      workingTreeDirty: options.workingTreeDirty,
    },
    scope: 'repository-understanding rows are re-graded from their recorded answer text; every other row is carried '
      + 'unchanged and listed under carriedUnchanged with the reason',
    rows: regraded.map((entry) => entry.row),
    carriedUnchanged,
    summary: {
      before: summarise(plan, originalRows, producedAt),
      after: summarise(plan, afterRows, producedAt),
    },
  };

  if (!options.write) return { reinterpretation };

  const directory = path.join(root, DEVELOPMENT_REINTERPRETATIONS_DIRECTORY);
  const target = path.join(directory, `${reinterpretationID.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  if (fs.existsSync(target)) {
    throw new DevelopmentCampaignError('reinterpretationExists', `${target} already exists; a reinterpretation is never overwritten`);
  }
  fs.mkdirSync(directory, { recursive: true });
  atomicWriteJSON(target, reinterpretation as unknown as CanonicalValue);

  const after = { results: hashIfPresent(resultsFile), plan: hashIfPresent(planFile), meta: hashIfPresent(metaFile) };
  if (after.results !== before.results || after.plan !== before.plan || after.meta !== before.meta) {
    throw new DevelopmentCampaignError('evidenceMoved',
      `the campaign's recorded files changed while it was being reinterpreted (${JSON.stringify({ before, after })}); `
      + `the reinterpretation at ${target} describes files that are no longer on disk and must not be used`);
  }
  return { reinterpretation, writtenTo: target };
}

/** Every reinterpretation recorded beside a campaign, by file name. */
export function listDevelopmentReinterpretations(root: string): string[] {
  const directory = path.join(root, DEVELOPMENT_REINTERPRETATIONS_DIRECTORY);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort() : [];
}

/** What `cernum develop-reinterpret` prints. */
export function describeDevelopmentReinterpretation(value: DevelopmentReinterpretation): string[] {
  const pct = (milli: number | null) => (milli === null ? 'no rate' : `${(milli / 10).toFixed(1)}%`);
  const counts = (entry: Record<string, number>) =>
    ['pass', 'partial', 'fail', 'timeout', 'unevaluable'].map((key) => `${key} ${entry[key] ?? 0}`).join(' · ');
  const format = (entry: DevelopmentAnswerFormat) =>
    `strict ${entry.strict}/${entry.gradedAnswers} · terminal-object ${entry.terminalObject} · single-fence ${entry.singleFence} · unread ${entry.unread}`;
  const lines = [
    `DEVELOPMENT REINTERPRETATION · ${value.original.campaign}`,
    '',
    `  id                ${value.reinterpretationID}`,
    `  produced          ${value.producedAt}`,
    `  original          ${value.original.contract} (${value.original.contractDigest}) · plan ${value.original.planDigest} · ${value.original.promptVersion}`,
    `  re-graded under   ${value.regradedUnder.contract} (${value.regradedUnder.contractDigest}) · ${value.regradedUnder.readingRules}`,
    `  at                ${value.regradedUnder.benchmarkVersion} ${value.regradedUnder.benchmarkCommit || 'UNKNOWN commit'}`
      + (value.regradedUnder.workingTreeDirty === true ? ' (working tree DIRTY)' : ''),
    `  evidence          results ${value.original.resultsSha256.slice(0, 23)}… · artefacts ${value.original.artefactsSha256.slice(0, 23)}…`,
    `  re-graded         ${value.rows.length} answer(s), every one reproduced under the original contract first`,
    `  carried           ${value.carriedUnchanged.length} row(s) unchanged (not re-derivable, or no answer)`,
    `  changed           ${value.rows.filter((row) => row.changed).length} row(s)`,
  ];
  for (const after of value.summary.after) {
    const before = value.summary.before.find((entry) => entry.candidate === after.candidate)!;
    const b = before.repositoryUnderstanding;
    const a = after.repositoryUnderstanding;
    lines.push('', `  ${after.candidate} · repositoryUnderstanding`);
    lines.push(`      before        ${counts(b.statusCounts)} · score ${pct(b.structuralScoreMilli)} · held-out ${pct(b.meanHeldOutPassRateMilli)} · ${format(b.answerFormat)}`);
    lines.push(`      after         ${counts(a.statusCounts)} · score ${pct(a.structuralScoreMilli)} · held-out ${pct(a.meanHeldOutPassRateMilli)} · ${format(a.answerFormat)}`);
    lines.push(`      coverage      tasks ${a.tasksFullyCovered} · repeats ${a.repeatsGraded} · mixed ${b.mixedTasks} -> ${a.mixedTasks}`);
  }
  const changed = value.rows.filter((row) => row.changed);
  if (changed.length > 0) lines.push('', '  rows that moved');
  for (const row of changed) {
    lines.push(`      ${row.candidate} ${row.taskID.split('.').pop()} r${row.repeat}: ${row.before.status} -> ${row.after.status}`
      + ` (${row.after.reading}${row.after.failedAssertions.length > 0 ? `; failed ${row.after.failedAssertions.join(', ')}` : ''})`);
  }
  lines.push('', '  ' + value.note);
  return lines;
}
