// Benchmark engine · what a development campaign has established, read back from its ledger.
//
// THE REPORT IS DERIVED FROM THE ROWS ON DISK AND FROM NOTHING ELSE. No grade is recomputed, no
// model is asked anything and no file is written: a status read of a campaign that is still running
// in another process must not be able to disturb it. That is why this reads `results.jsonl` directly
// instead of opening a `Ledger`, whose load repairs a torn final line in place.
//
// COVERAGE IS NEVER COLLAPSED INTO A SCORE. Each dimension's rate is printed beside the coverage it
// rests on, and a campaign whose required repeats are not all graded says so in a line of its own,
// above the numbers — a rate over three of ten tasks is a real rate over three tasks, and it is not a
// score for the candidate.
//
// NOTHING HERE PROMOTES OR ROUTES. The roles and the eligibility verdict are the ones
// `development-evidence.ts` computes, and that module's verdict vocabulary has no approval in it.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { measured, unavailable, Measurement } from '../core/candidate';
import { DevelopmentProvenance } from '../core/development-benchmark';
import { DevelopmentTaskResult } from '../core/development-evaluation';
import {
  DevelopmentEligibility, DevelopmentEvidence, DevelopmentRepeatRecord, DevelopmentRole,
  assessDevelopmentEligibility, assessDevelopmentRoles, buildRepeatedDevelopmentEvidence,
} from '../core/development-evidence';
import { ALL_DEVELOPMENT_DIMENSIONS, DevelopmentDimension } from '../core/development-scoring';
import { CanonicalValue } from './canonical';
import { DEVELOPMENT_PLAN_FILE, DevelopmentCampaignError, recordedPromptVersion } from './development-campaign';
import { DevelopmentCampaignPlan } from './development-plan';
import { SlotResult } from './ledger';

export const DEVELOPMENT_NO_PROMOTION =
  'No development result promotes, routes or qualifies a candidate by itself. The roles in this report are an '
  + 'interpretation of the measurements, and acting on one is a decision a person makes.';

type Row = SlotResult & Record<string, CanonicalValue | undefined>;

function text(value: CanonicalValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function count(value: CanonicalValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function measureOf(value: CanonicalValue | undefined, reason: string): Measurement<number> {
  return typeof value === 'number' ? measured(value) : unavailable(reason);
}

/** The provenance a row carries, reassembled from its columns. */
function provenanceOfRow(row: Row): DevelopmentProvenance {
  return {
    benchmarkVersion: text(row.benchmarkVersion),
    benchmarkCommit: text(row.benchmarkCommit),
    machineIdentifier: text(row.machineIdentifier),
    platform: text(row.platform),
    suiteID: text(row.suiteID),
    suiteVersion: text(row.suiteVersion),
    suiteDigest: text(row.suiteDigest),
    taskID: text(row.taskID),
    taskDigest: text(row.taskDigest),
    comparabilityKey: text(row.comparabilityKey),
    fixtureRepoID: text(row.fixtureRepoID),
    fixtureRepoVersion: text(row.fixtureRepoVersion),
    fixtureRepoDigest: text(row.fixtureRepoDigest),
    contractID: text(row.contractID),
    contractVersion: text(row.contractVersion),
    contractDigest: text(row.contractDigest),
    executedAt: text(row.executedAt),
  };
}

/**
 * One ledger row as the evidence layer reads it.
 *
 * A graded row becomes a `DevelopmentTaskResult` reassembled from the columns `developmentResultRow`
 * wrote — so evidence can be re-derived from the evidence file alone, months later, without the
 * workspace that no longer exists. Every other row is an EXCLUSION, carrying its disposition.
 */
export function developmentRepeatFromRow(row: Row): DevelopmentRepeatRecord {
  const base = {
    taskID: text(row.taskID),
    dimension: text(row.dimension) as DevelopmentDimension,
    repeat: count(row.repeat) ?? 0,
    disposition: text(row.disposition),
  };
  if (row.measurementState !== 'graded') {
    return { ...base, excludedBecause: text(row.notMeasuredBecause) || 'the row records no grade' };
  }
  const metrics = Array.isArray(row.metrics) ? row.metrics as Record<string, CanonicalValue>[] : [];
  const outcomes = Array.isArray(row.assertionOutcomes) ? row.assertionOutcomes as Record<string, CanonicalValue>[] : [];
  const result: DevelopmentTaskResult = {
    taskID: base.taskID,
    suiteID: text(row.suiteID),
    dimension: base.dimension,
    taskDigest: text(row.taskDigest),
    comparabilityKey: text(row.comparabilityKey),
    baselineSnapshotDigest: text(row.baselineSnapshotDigest),
    resultSnapshotDigest: text(row.resultSnapshotDigest),
    outcomes: outcomes.map((entry) => ({
      id: text(entry.id), metric: text(entry.metric), visibility: text(entry.visibility) as never,
      shortcutProbe: entry.shortcutProbe === true, held: entry.held === true, detail: text(entry.detail),
    })),
    grade: {
      structuralCredit: text(row.structuralCredit) as never,
      executedCredit: text(row.executedCredit) as never,
      credit: text(row.credit) as never,
      creditReason: text(row.creditReason),
      metrics: metrics.map((entry) => ({
        id: text(entry.id) as never,
        tier: text(entry.tier) as never,
        status: text(entry.status) as never,
        valueMilli: measureOf(entry.valueMilli, text(entry.detail) || 'no value was recorded'),
        assertionIDs: Array.isArray(entry.assertionIDs) ? entry.assertionIDs.map((id) => String(id)) : [],
        detail: text(entry.detail),
      })),
      shortcutSuspected: row.shortcutSuspected === true,
      shortcutReasons: Array.isArray(row.shortcutReasons) ? row.shortcutReasons.map((reason) => String(reason)) : [],
      heldOutPassRateMilli: measureOf(row.heldOutPassRateMilli, 'this task declares no held-out assertion'),
    },
    provenance: provenanceOfRow(row),
  };
  return { ...base, result };
}

export interface DevelopmentCandidateReport {
  candidate: string;
  provider: string;
  modelID: string;
  effort: string;
  executionClass: string;
  costEligibility: string;
  costEligibilityReason: string;
  identityState: string;
  identityEvidence: string;
  /** Every model identifier a provider named on this candidate's rows. More than one is a problem. */
  reportedModelIDs: string[];
  plannedAttempts: number;
  terminalAttempts: number;
  pendingAttempts: number;
  statusCounts: { pass: number; partial: number; fail: number; timeout: number; unevaluable: number };
  /** Rows on which no model answered, by disposition. Never counted as a failure. */
  exclusions: Record<string, number>;
  retries: { attemptsRetried: number; totalRetries: number; wastedTokens: number };
  telemetry: {
    inputTokens: number;
    outputTokens: number;
    rowsWithUsage: number;
    elapsedMilliseconds: number;
    /** Marginal API charge, integer microUSD, over rows that reported one. */
    costMicroUSD: number;
    rowsWithCost: number;
    /** Subscription allowance consumed at list value — a budget spent down, never a bill. */
    subscriptionAllowanceMicroUSD: number;
  };
  evidence: DevelopmentEvidence;
  roles: DevelopmentRole[];
  eligibility: DevelopmentEligibility;
  /** True only when every planned task has every required repeat graded, on every dimension the plan covers. */
  coverageComplete: boolean;
  warnings: string[];
}

export interface DevelopmentCampaignReport {
  label: string;
  planDigest: string;
  /** The prompt contract the campaign's attempts were sent under. See `DEVELOPMENT_PROMPT_VERSION`. */
  promptVersion: string;
  benchmarkVersion: string;
  benchmarkCommit: string;
  workingTreeDirty?: boolean;
  machineIdentifier: string;
  platform: string;
  suiteIDs: string[];
  repeats: number;
  synthetic: boolean;
  plannedAttempts: number;
  terminalAttempts: number;
  /** Rows that repeated a slot already recorded. Ignored: the first terminal row per slot wins. */
  duplicateRows: number;
  /** Rows naming a slot the plan does not describe. Ignored, and reported. */
  unplannedRows: number;
  candidates: DevelopmentCandidateReport[];
  complete: boolean;
  derivedAt: string;
  noPromotion: string;
}

/**
 * The report, from a plan and the rows it produced.
 *
 * Rows are deduplicated by slot key, first wins, before anything is counted — the same rule the
 * ledger applies on load — so a duplicated line cannot add an attempt, a repeat or a task.
 */
export function buildDevelopmentCampaignReport(options: {
  plan: DevelopmentCampaignPlan;
  rows: Row[];
  derivedAt: string;
  synthetic?: boolean;
}): DevelopmentCampaignReport {
  const { plan } = options;
  const planned = new Map(plan.attempts.map((attempt) => [attempt.slotKey, attempt]));
  const firstBySlot = new Map<string, Row>();
  let duplicateRows = 0;
  let unplannedRows = 0;
  for (const row of options.rows) {
    if (!planned.has(row.slotKey)) { unplannedRows += 1; continue; }
    if (firstBySlot.has(row.slotKey)) { duplicateRows += 1; continue; }
    firstBySlot.set(row.slotKey, row);
  }

  const candidates = plan.candidates.map((candidate): DevelopmentCandidateReport => {
    const attempts = plan.attempts.filter((attempt) => attempt.candidate === candidate.name);
    const rows = attempts.map((attempt) => firstBySlot.get(attempt.slotKey)).filter((row): row is Row => row !== undefined);

    const plannedTaskIDs = Object.fromEntries(ALL_DEVELOPMENT_DIMENSIONS.map((dimension) => [dimension,
      [...new Set(attempts.filter((attempt) => attempt.dimension === dimension).map((attempt) => attempt.taskID))]],
    )) as Record<DevelopmentDimension, string[]>;
    const evidence = buildRepeatedDevelopmentEvidence(candidate.name, rows.map(developmentRepeatFromRow), {
      plannedTaskCounts: {
        repositoryUnderstanding: plannedTaskIDs.repositoryUnderstanding.length,
        multiFileEditing: plannedTaskIDs.multiFileEditing.length,
      },
      plannedTaskIDs,
      requiredRepeats: plan.repeats,
    }, options.derivedAt);

    const statusCounts = { pass: 0, partial: 0, fail: 0, timeout: 0, unevaluable: 0 };
    const exclusions: Record<string, number> = {};
    const retries = { attemptsRetried: 0, totalRetries: 0, wastedTokens: 0 };
    const telemetry = {
      inputTokens: 0, outputTokens: 0, rowsWithUsage: 0, elapsedMilliseconds: 0,
      costMicroUSD: 0, rowsWithCost: 0, subscriptionAllowanceMicroUSD: 0,
    };
    const reported = new Set<string>();
    for (const row of rows) {
      if (row.measurementState !== 'graded') {
        statusCounts.unevaluable += 1;
        const disposition = text(row.disposition) || 'unrecorded';
        exclusions[disposition] = (exclusions[disposition] ?? 0) + 1;
      } else if (row.status === 'pass' || row.status === 'partial' || row.status === 'fail' || row.status === 'timeout') {
        statusCounts[row.status] += 1;
      } else {
        statusCounts.fail += 1;
      }
      const retryCount = count(row.retryCount) ?? 0;
      if (retryCount > 0) retries.attemptsRetried += 1;
      retries.totalRetries += retryCount;
      const record = (row.telemetry ?? {}) as Record<string, CanonicalValue>;
      retries.wastedTokens += count(record.wastedTokens) ?? 0;
      const input = count(record.inputTokens);
      const output = count(record.visibleOutputTokens);
      if (input !== undefined || output !== undefined) telemetry.rowsWithUsage += 1;
      telemetry.inputTokens += input ?? 0;
      telemetry.outputTokens += output ?? 0;
      telemetry.elapsedMilliseconds += count(row.totalElapsedMilliseconds) ?? 0;
      const cost = count(record.costMicroUSD);
      if (cost !== undefined) { telemetry.costMicroUSD += cost; telemetry.rowsWithCost += 1; }
      telemetry.subscriptionAllowanceMicroUSD += count(record.subscriptionIncludedUsageMicroUSD) ?? 0;
      if (text(row.reportedModelID).length > 0) reported.add(text(row.reportedModelID));
    }

    // Coverage is over what THIS PLAN asked. A dimension it planned no task on is not a gap in this
    // campaign — the eligibility verdict below still names it as outstanding for the candidate.
    const inScope = evidence.dimensions.filter((entry) => entry.plannedTaskCount > 0);
    const coverageComplete = inScope.every((entry) => entry.state === 'measured');
    const warnings: string[] = [];
    if (!coverageComplete) {
      const gaps = inScope
        .filter((entry) => entry.state !== 'measured')
        .map((entry) => `${entry.dimension} ${entry.gradedTaskCount}/${entry.plannedTaskCount} task(s) fully covered `
          + `(${entry.gradedRepeatCount}/${entry.requiredRepeatCount} repeat(s) graded, ${entry.excludedRepeatCount} excluded, `
          + `${entry.missingRepeatCount} not run)`);
      warnings.push(`COVERAGE INCOMPLETE — ${gaps.join('; ')}. Any rate shown rests on part of the suite and is not a score for this candidate.`);
    }
    if (reported.size > 1) {
      warnings.push(`the provider named ${reported.size} different models on this candidate's rows: ${[...reported].sort().join(', ')}`);
    }
    const mixed = evidence.dimensions.reduce((sum, entry) => sum + entry.mixedTaskCount, 0);
    if (mixed > 0) warnings.push(`${mixed} task(s) produced different credit on different repeats; see the per-task stability`);

    return {
      candidate: candidate.name,
      provider: candidate.binding.provider,
      modelID: candidate.binding.requestedModelID,
      effort: candidate.binding.effort,
      executionClass: candidate.binding.executionClass,
      costEligibility: candidate.costVerdict.eligibility,
      costEligibilityReason: candidate.costVerdict.reason,
      identityState: candidate.binding.identityState,
      identityEvidence: candidate.binding.identityEvidence,
      reportedModelIDs: [...reported].sort(),
      plannedAttempts: attempts.length,
      terminalAttempts: rows.length,
      pendingAttempts: attempts.length - rows.length,
      statusCounts,
      exclusions,
      retries,
      telemetry,
      evidence,
      roles: assessDevelopmentRoles(evidence),
      eligibility: assessDevelopmentEligibility(evidence),
      coverageComplete,
      warnings,
    };
  });

  return {
    label: plan.label,
    planDigest: plan.planDigest,
    promptVersion: recordedPromptVersion(plan),
    benchmarkVersion: plan.benchmarkVersion,
    benchmarkCommit: plan.benchmarkCommit,
    workingTreeDirty: plan.workingTreeDirty,
    machineIdentifier: plan.machineIdentifier,
    platform: plan.platform,
    suiteIDs: plan.suiteIDs,
    repeats: plan.repeats,
    synthetic: options.synthetic === true,
    plannedAttempts: plan.attempts.length,
    terminalAttempts: firstBySlot.size,
    duplicateRows,
    unplannedRows,
    candidates,
    complete: candidates.every((candidate) => candidate.coverageComplete),
    derivedAt: options.derivedAt,
    noPromotion: DEVELOPMENT_NO_PROMOTION,
  };
}

/**
 * Read a development campaign WITHOUT opening its ledger for writing.
 *
 * A torn final line — a write interrupted mid-row — is skipped and counted rather than repaired:
 * repair belongs to the process that will append next, and a status read is not that process.
 */
export function readDevelopmentCampaignState(root: string): {
  plan: DevelopmentCampaignPlan; meta: Record<string, CanonicalValue>; rows: Row[]; unreadableLines: number;
} {
  const planFile = path.join(root, DEVELOPMENT_PLAN_FILE);
  const metaFile = path.join(root, 'meta.json');
  if (!fs.existsSync(planFile) || !fs.existsSync(metaFile)) {
    throw new DevelopmentCampaignError('noCampaign', `${root} holds no development campaign`);
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, CanonicalValue>;
  if (meta.campaignKind !== 'development') {
    throw new DevelopmentCampaignError('notDevelopment', `the campaign at ${root} is not a development campaign`);
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as DevelopmentCampaignPlan;
  const rows: Row[] = [];
  let unreadableLines = 0;
  const resultsFile = path.join(root, 'results.jsonl');
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        unreadableLines += 1;
      }
    }
  }
  return { plan, meta, rows, unreadableLines };
}

function percent(value: Measurement<number>): string {
  return 'measured' in value ? `${(value.measured / 10).toFixed(1)}%` : 'no rate';
}

const STATE_LABEL: Record<string, string> = {
  notMeasured: 'NOT MEASURED', partiallyMeasured: 'PARTIALLY MEASURED — INCOMPLETE COVERAGE', measured: 'MEASURED',
};

/** What `cernum develop-status` prints. */
export function describeDevelopmentCampaignReport(report: DevelopmentCampaignReport): string[] {
  const lines = [
    `DEVELOPMENT CAMPAIGN STATUS · ${report.label}${report.synthetic ? ' · SYNTHETIC' : ''}`,
    '',
    `  plan digest       ${report.planDigest}`,
    `  prompt            ${report.promptVersion}`,
    `  benchmark         ${report.benchmarkVersion} at ${report.benchmarkCommit || 'an UNKNOWN commit'}`
      + (report.workingTreeDirty === true ? ' (working tree was DIRTY when planned)' : ''),
    `  machine           ${report.machineIdentifier} (${report.platform})`,
    `  suites            ${report.suiteIDs.join(', ')}`,
    `  repeats           ${report.repeats} required per task`,
    `  attempts          ${report.terminalAttempts} of ${report.plannedAttempts} terminal`,
  ];
  if (report.duplicateRows > 0 || report.unplannedRows > 0) {
    lines.push(`  ignored rows      ${report.duplicateRows} duplicate, ${report.unplannedRows} unplanned — never counted`);
  }
  if (report.synthetic) {
    lines.push('  provider spend    NONE — synthetic candidate; no provider, network or hosted model was contacted');
  }
  lines.push('');
  lines.push(report.complete
    ? 'COVERAGE COMPLETE — every planned task has every required repeat graded.'
    : 'COVERAGE INCOMPLETE — at least one candidate is missing required task repeats. No figure below is a final score.');

  for (const candidate of report.candidates) {
    lines.push('', `  ${candidate.candidate}`);
    lines.push(`      provider      ${candidate.provider} · ${candidate.modelID} · effort ${candidate.effort} · ${candidate.executionClass}`);
    lines.push(`      cost          ${candidate.costEligibility} — ${candidate.costEligibilityReason}`);
    lines.push(`      identity      ${candidate.identityState} — ${candidate.identityEvidence}`
      + (candidate.reportedModelIDs.length > 0 ? ` · provider named ${candidate.reportedModelIDs.join(', ')}` : ''));
    lines.push(`      attempts      ${candidate.terminalAttempts}/${candidate.plannedAttempts} terminal, ${candidate.pendingAttempts} pending`);
    const s = candidate.statusCounts;
    lines.push(`      outcomes      pass ${s.pass} · partial ${s.partial} · fail ${s.fail} · timeout ${s.timeout} · unevaluable ${s.unevaluable}`);
    const excluded = Object.entries(candidate.exclusions).sort(([a], [b]) => a.localeCompare(b));
    lines.push(`      exclusions    ${excluded.length === 0 ? 'none' : excluded.map(([kind, n]) => `${kind} ${n}`).join(' · ')}`
      + ' (transport/account/refusal — excluded from every rate, never counted as a model failure)');
    lines.push(`      retries       ${candidate.retries.totalRetries} retr(y/ies) on ${candidate.retries.attemptsRetried} attempt(s), `
      + `${candidate.retries.wastedTokens} token(s) discarded — a retry is never an additional repeat`);
    const t = candidate.telemetry;
    lines.push(`      telemetry     ${t.rowsWithUsage > 0 ? `${t.inputTokens} input / ${t.outputTokens} output token(s) over ${t.rowsWithUsage} row(s)` : 'no token usage reported'}`
      + ` · ${t.elapsedMilliseconds} ms elapsed · charge ${t.rowsWithCost > 0 ? `${t.costMicroUSD} µUSD` : 'unreported'}`
      + ` · allowance ${t.subscriptionAllowanceMicroUSD} µUSD`);
    for (const entry of candidate.evidence.dimensions) {
      lines.push(`      ${entry.dimension.padEnd(24)} ${STATE_LABEL[entry.state]} — structural ${percent(entry.structuralPassRateMilli)}`
        + ` over ${entry.scoredTaskCount} scored task(s); tasks fully covered ${entry.gradedTaskCount}/${entry.plannedTaskCount};`
        + ` repeats graded ${entry.gradedRepeatCount}/${entry.requiredRepeatCount}`
        + (entry.excludedRepeatCount > 0 ? `, ${entry.excludedRepeatCount} excluded` : '')
        + (entry.mixedTaskCount > 0 ? `; ${entry.mixedTaskCount} mixed across repeats` : ''));
      for (const task of entry.tasks) {
        lines.push(`        ${task.taskID.padEnd(52)} ${task.measured ? 'measured  ' : 'INCOMPLETE'} `
          + `graded [${task.gradedRepeats.join(',')}] excluded [${task.excludedRepeats.join(',')}] missing [${task.missingRepeats.join(',')}] `
          + `score ${percent(task.structuralScoreMilli)} ${task.stability}`);
      }
      if (!entry.executedTierMeasured && entry.dimension === 'multiFileEditing') {
        lines.push(`        executed tier NOT MEASURED — ${entry.executedTierBecause}`);
      }
    }
    for (const role of candidate.roles) {
      lines.push(`      role          ${role.role}: ${role.qualified ? 'qualified' : 'not qualified'} (structural ${role.structuralStanding})`);
    }
    lines.push(`      evidence      ${candidate.eligibility.verdict} — ${candidate.eligibility.because}`);
    for (const warning of candidate.warnings) lines.push(`      WARNING       ${warning}`);
  }
  lines.push('', report.noPromotion);
  return lines;
}
