// CONTINUATION of a stopped matrix, and the COMBINED LOGICAL REPORT: how Cernum finishes a matrix a
// provider stopped — as a NEW matrix, in a new root, of exactly the cells that produced no evidence —
// and reports source and continuation together without writing either.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED. Source matrices are run by the real engine against
// a scripted driver that "throttles" part-way; the discriminator-shaped source is written by hand in the
// engine's own formats; the CLI tests put a RECORDING `codex` and `claude` first on PATH and assert that
// neither was ever run. The historical campaign on this machine is not read by any test here.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { allWorkspaceCases, discriminatorOnePack } from '../../src/engine/workspace-catalog';
import { WorkspaceMatrixError, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan, runWorkspaceMatrix } from '../../src/engine/workspace-matrix';
import {
  WorkspaceContinuationError, combineWorkspaceContinuationEvidence, planWorkspaceContinuation, readWorkspaceContinuationRows,
  readWorkspaceContinuationSource, readWorkspaceRecordReadOnly,
} from '../../src/engine/workspace-continuation';
import { aggregateWorkspaceRuns, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { discoveryStorePath } from '../../src/engine/discovery-store';
import { workspaceRecordPaths } from '../../src/engine/workspace-campaign';
import {
  A, ASTRA, ASTRA_EXECUTED, B, CHANGES_NOTHING, DISCRIMINATOR_CASES, DISCRIMINATOR_LABEL, EXPECTED_ASTRA_CONTINUATION,
  NODE_DIRECTORY, PACK, RUN_OPTIONS, SOL, SOURCE_LABEL, THROTTLED, acceptedCodexRoute, codexFactory, repositoryRoot,
  request, runSourceMatrix, sealed, temporary, treeDigest, writeDiscriminatorShapedSource, CodexScript,
} from './workspace-continuation-harness';

const CONTINUATION_LABEL = 'codex-source-01-cont-01';
const cells = allWorkspaceCases();
const readSource = (root: string) => readWorkspaceContinuationSource({ campaignRoot: root, label: SOURCE_LABEL, pack: PACK, cases: cells });
const at = (cell: { caseID: string; repeatIndex?: number; repeat?: { repeatIndex: number } }) =>
  `${cell.caseID}@${cell.repeatIndex ?? cell.repeat?.repeatIndex}`;

/** Plan and run a continuation matrix exactly as the CLI does: source → selection → ordinary plan → ordinary run. */
async function continueMatrix(options: {
  sourceRoot: string; root?: string; label?: string; include?: boolean; explicit?: Parameters<typeof planWorkspaceContinuation>[1]['explicit'];
  script?: CodexScript; priorRoots?: string[];
}) {
  const root = options.root ?? temporary('cernum-cont-');
  const label = options.label ?? CONTINUATION_LABEL;
  const calls: string[] = [];
  const source = readSource(options.sourceRoot);
  const priorRoots = [root, ...(options.priorRoots ?? [])];
  const planned = planWorkspaceContinuation(source, {
    provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium', explicit: options.explicit,
    includeProviderThrottledAttempts: options.include,
    priorContinuationRows: priorRoots.flatMap((prior) => readWorkspaceContinuationRows(prior)), priorContinuationRoots: priorRoots,
  });
  const base = request({ campaignRoot: root, runLabel: label, cellSelection: planned.selection,
    driverFactory: codexFactory({ calls, script: options.script }) });
  const digest = buildWorkspaceMatrixPlan(base).selection!.selectionDigest;
  const matrix = { ...base, identityAdmission: sealed(label, { selectionDigest: digest }) };
  const plan = buildWorkspaceMatrixPlan(matrix);
  const result = await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
  return { root, label, source, planned, plan, result, calls };
}

// MARK: - reading the source

describe('the source is read, classified and fingerprinted without being written', () => {
  it('classifies every cell the source planned from its own evidence', async () => {
    const { root, calls } = await runSourceMatrix();
    expect(calls).toEqual([
      `${SOL}|${A}|1`, `${SOL}|${B}|1`, `${SOL}|${A}|2`, `${SOL}|${B}|2`, `${SOL}|${A}|3`, `${SOL}|${B}|3`,
      `${ASTRA}|${A}|1`, `${ASTRA}|${B}|1`, `${ASTRA}|${A}|2`, `${ASTRA}|${B}|2`]);
    const source = readSource(root);
    expect(source.cells).toHaveLength(12);
    expect(source.records).toHaveLength(10);
    expect(source.repeatsPlanned).toBe(3);
    expect(source.aggregate?.path).toBe(path.join(root, 'aggregates', `${SOURCE_LABEL}.json`));
    const state = (model: string, cell: string) => source.cells.find((entry) => entry.modelID === model && at(entry) === cell)!.state;
    for (const cell of [`${A}@1`, `${B}@1`, `${A}@2`, `${B}@2`, `${A}@3`, `${B}@3`]) expect(state(SOL, cell)).toBe('completed');
    expect(state(ASTRA, `${A}@1`)).toBe('completed');
    expect(state(ASTRA, `${A}@2`)).toBe('completed');
    expect(state(ASTRA, `${B}@2`)).toBe('providerThrottledAttempt');
    expect(state(ASTRA, `${A}@3`)).toBe('notExecutedBecauseThrottled');
    expect(state(ASTRA, `${B}@3`)).toBe('notExecutedBecauseThrottled');
    expect(source.digest).toMatch(/^cmr1:[0-9a-f]{64}$/);
    expect(readSource(root).digest).toBe(source.digest);
  });

  it('12 · reading, planning, continuing and reporting leave every byte of the source unchanged', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const before = treeDigest(sourceRoot);
    const continuation = await continueMatrix({ sourceRoot, include: true });
    readSource(sourceRoot);
    combineWorkspaceContinuationEvidence(readSource(sourceRoot), [{ label: continuation.label, rows: readWorkspaceContinuationRows(continuation.root) }]);
    expect(treeDigest(sourceRoot)).toEqual(before);
    expect(readSource(sourceRoot).digest).toBe(continuation.source.digest);
  });

  it('12 · a torn source ledger is REFUSED, never repaired', async () => {
    const { root } = await runSourceMatrix();
    const record = readSource(root).records[0];
    const results = path.join(workspaceRecordPaths(record.recordRoot).ledger, 'results.jsonl');
    fs.appendFileSync(results, '{"slotKey": "half-writ');
    const torn = fs.readFileSync(results);
    expect(() => readSource(root)).toThrow(expect.objectContaining({ code: 'recordLedgerTorn' }));
    expect(fs.readFileSync(results)).toEqual(torn);
    // …whereas `Ledger.open` — which the ordinary aggregate reader uses — would have truncated it.
    expect(() => readWorkspaceRecordReadOnly(record.recordRoot)).toThrow(WorkspaceContinuationError);
  });

  it('refuses a source whose pack digest differs, whose aggregate is of another matrix, or that is itself a continuation', async () => {
    const { root } = await runSourceMatrix();
    const aggregate = path.join(root, 'aggregates', `${SOURCE_LABEL}.json`);
    const text = fs.readFileSync(aggregate, 'utf8');
    fs.writeFileSync(aggregate, text.replace(/"packDigest": "cwp1:[0-9a-f]+"/, '"packDigest": "cwp1:other"'));
    expect(() => readSource(root)).toThrow(expect.objectContaining({ code: 'sourceAggregateMismatch' }));
    fs.writeFileSync(aggregate, text);
    const continuation = await continueMatrix({ sourceRoot: root });
    expect(() => readWorkspaceContinuationSource({ campaignRoot: continuation.root, label: CONTINUATION_LABEL, pack: PACK, cases: cells }))
      .toThrow(expect.objectContaining({ code: 'sourceIsContinuation' }));
  });
});

// MARK: - 9-11 · what a continuation selects

describe('a continuation selects exactly the cells that produced no evidence', () => {
  it('9-10 · excludes every completed cell and selects every deferred one, at its original coordinate', async () => {
    const { root } = await runSourceMatrix();
    const planned = planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium' });
    expect(planned.selection.mode).toBe('continuation');
    expect(planned.selection.selectors.map(at)).toEqual([`${A}@3`, `${B}@3`]);
    expect(planned.selection.selectors.every((selector) => selector.reason === 'notExecutedBecauseThrottled' && selector.modelID === ASTRA))
      .toBe(true);
    expect(planned.selection.continuation).toMatchObject({
      sourceLabel: SOURCE_LABEL, sourcePlannedRunCount: 12, sourceRecordCount: 10, outOfScopeRunCount: 6,
      completedExcludedCount: 3, eligibleRunCount: 3, throttledAttemptsHeldBackCount: 1,
      sourceCellsByState: { completed: 9, providerThrottledAttempt: 1, notExecutedBecauseThrottled: 2 },
    });
    const held = planned.inScope.find((entry) => at(entry.cell) === `${B}@2`)!;
    expect(held.selected).toBe(false);
    expect(held.excludedBecause).toContain('--include-throttled-attempts');
  });

  it('11 · a throttled attempt is eligible on request: a NEW record in a new root, the historical one untouched', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const source = readSource(sourceRoot);
    const historical = source.cells.find((cell) => cell.modelID === ASTRA && at(cell) === `${B}@2`)!;
    const before = treeDigest(historical.recordRoot!);
    const continuation = await continueMatrix({ sourceRoot, include: true });
    expect(continuation.calls).toEqual([`${ASTRA}|${B}|1`, `${ASTRA}|${A}|1`, `${ASTRA}|${B}|2`]);
    expect(continuation.plan.cells.map(at)).toEqual([`${B}@2`, `${A}@3`, `${B}@3`]);
    const retried = continuation.plan.cells.find((cell) => at(cell) === `${B}@2`)!;
    expect(retried.recordRoot.startsWith(continuation.root)).toBe(true);
    expect(retried.recordRoot).not.toBe(historical.recordRoot);
    expect(retried.selection).toMatchObject({ cellSelectionReason: 'providerThrottledAttempt', continuationSourceRecordRoot: historical.recordRoot,
      continuationSourceStatus: 'runtimeError', continuationSourceLabel: SOURCE_LABEL, continuationSourceDigest: source.digest });
    expect(treeDigest(historical.recordRoot!)).toEqual(before);
    expect(readWorkspaceRecordReadOnly(historical.recordRoot!).row).toMatchObject({ status: 'runtimeError', providerThrottled: true });
  });

  it('11 · naming the throttled cell with --cells selects it without the flag; naming a deferred one narrows the set', async () => {
    const { root } = await runSourceMatrix();
    const explicit = planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      explicit: [{ caseID: B, repeatIndex: 2 }, { caseID: B, repeatIndex: 3 }] });
    expect(explicit.selection.selectors.map((selector) => `${at(selector)} ${selector.reason}`))
      .toEqual([`${B}@2 providerThrottledAttempt`, `${B}@3 notExecutedBecauseThrottled`]);
    expect(explicit.selection.continuation?.explicitSubset).toBe(true);
  });

  it('13 · runs under a new label in a new root, with every record carrying its cell, its selection and its source', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const continuation = await continueMatrix({ sourceRoot });
    expect(continuation.result.executedRunCount).toBe(2);
    const rows = collectWorkspaceRunRows(continuation.root);
    expect(rows).toHaveLength(2);
    for (const { row, recordRoot } of rows) {
      expect(path.basename(recordRoot).startsWith(`${CONTINUATION_LABEL}-`)).toBe(true);
      expect(row).toMatchObject({ repeatIndex: 3, repeatsPlanned: 3, cellSelectionMode: 'continuation',
        cellSelectionReason: 'notExecutedBecauseThrottled', continuationSourceLabel: SOURCE_LABEL,
        continuationSourceDigest: continuation.source.digest, continuationSourceRoot: continuation.source.campaignRoot,
        cellSelectionDigest: continuation.plan.selection!.selectionDigest, packDigest: continuation.source.pack.digest,
        bindingIdentityState: 'requestAcceptedIdentityUnverifiable' });
      expect(continuation.source.cells.some((cell) => cell.cellID === row.matrixCellID && cell.state === 'notExecutedBecauseThrottled')).toBe(true);
    }
    const text = describeWorkspaceMatrixPlan(continuation.plan).join('\n');
    expect(text).toContain(`CONTINUATION of '${SOURCE_LABEL}'`);
    expect(text).toContain('never written');
  });

  it('refuses a continuation that would run a different experiment: another deadline, attempt cap or driver', async () => {
    const { root } = await runSourceMatrix();
    const selection = planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium' }).selection;
    // Admitted, so the route is BOUND: the deadline compared is the binding's, which a refused route has none of.
    const digest = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-cont-'), runLabel: CONTINUATION_LABEL,
      cellSelection: selection })).selection!.selectionDigest;
    const code = (overrides: Partial<Parameters<typeof request>[0]>) => {
      try {
        buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-cont-'), runLabel: CONTINUATION_LABEL, cellSelection: selection,
          identityAdmission: sealed(CONTINUATION_LABEL, { selectionDigest: digest }), ...overrides }));
      }
      catch (error) { return (error as WorkspaceMatrixError).code; }
      return 'accepted';
    };
    expect(code({})).toBe('accepted');
    expect(code({ timeoutMilliseconds: 1000 })).toBe('continuationNotComparable');
    const withDriver = (driverID: string) => ({ driverFactory: (binding: Parameters<ReturnType<typeof codexFactory>>[0]) => {
      const driver = codexFactory()(binding);
      return driver === undefined ? undefined : { ...driver, driverID };
    } });
    expect(code(withDriver('driver.some-other'))).toBe('continuationNotComparable');
  });

  it('refuses another route, effort or model the source never planned', async () => {
    const { root } = await runSourceMatrix();
    const source = readSource(root);
    expect(() => planWorkspaceContinuation(source, { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'max' }))
      .toThrow(expect.objectContaining({ code: 'continuationRouteMismatch' }));
    expect(() => planWorkspaceContinuation(source, { provider: 'claudeCLI', modelIDs: [ASTRA], effort: 'medium' }))
      .toThrow(expect.objectContaining({ code: 'continuationRouteMismatch' }));
    expect(() => planWorkspaceContinuation(source, { provider: 'codexCLI', modelIDs: ['gpt-9'], effort: 'medium' }))
      .toThrow(expect.objectContaining({ code: 'continuationModelNotInSource' }));
  });
});

// MARK: - 14 · never duplicate scoring evidence

describe('14 · a continuation never produces duplicate scoring evidence', () => {
  it('refuses a completed cell named with --cells, with no override', async () => {
    const { root } = await runSourceMatrix();
    for (const explicit of [[{ caseID: A, repeatIndex: 1 }], [{ caseID: A, repeatIndex: 3 }, { caseID: A, repeatIndex: 2 }]]) {
      expect(() => planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium', explicit }))
        .toThrow(expect.objectContaining({ code: 'cellAlreadyCompleted' }));
    }
    expect(() => planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      explicit: [{ caseID: A, repeatIndex: 4 }] })).toThrow(expect.objectContaining({ code: 'continuationCellNotPlanned' }));
  });

  it('never selects a Sol cell: Sol completed everything, so naming Sol is refused rather than re-run', async () => {
    const { root } = await runSourceMatrix();
    const sol = planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [SOL, ASTRA], effort: 'medium' });
    expect(sol.selection.selectors.every((selector) => selector.modelID === ASTRA)).toBe(true);
    expect(sol.selection.continuation?.completedExcludedCount).toBe(9);
    // …and a plan naming Sol with nothing to run refuses outright instead of planning an empty route.
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-cont-'), runLabel: CONTINUATION_LABEL,
      modelIDs: [SOL, ASTRA], cellSelection: sol.selection }))).toThrow(expect.objectContaining({ code: 'cellSelectionModelUnselected' }));
    const onlySol = planWorkspaceContinuation(readSource(root), { provider: 'codexCLI', modelIDs: [SOL], effort: 'medium' });
    expect(onlySol.selection.selectors).toEqual([]);
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-cont-'), runLabel: CONTINUATION_LABEL,
      modelIDs: [SOL], cellSelection: onlySol.selection }))).toThrow(expect.objectContaining({ code: 'cellSelectionEmpty' }));
  });

  it('a second continuation in the same root finds nothing left; the same label is refused before anything is sent', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const first = await continueMatrix({ sourceRoot, include: true });
    expect(first.result.executedRunCount).toBe(3);
    const again = planWorkspaceContinuation(readSource(sourceRoot), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      includeProviderThrottledAttempts: true, priorContinuationRows: readWorkspaceContinuationRows(first.root) });
    expect(again.selection.selectors).toEqual([]);
    expect(again.selection.continuation?.completedByPriorContinuationCount).toBe(3);
    expect(() => planWorkspaceContinuation(readSource(sourceRoot), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      explicit: [{ caseID: A, repeatIndex: 3 }], priorContinuationRows: readWorkspaceContinuationRows(first.root) }))
      .toThrow(expect.objectContaining({ code: 'cellAlreadyCompleted' }));
    // Replaying the first continuation's own selection under its own label collides with its sealed records.
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: first.root, runLabel: first.label,
      cellSelection: first.planned.selection }))).toThrow(expect.objectContaining({ code: 'cellSelectionRecordExists' }));
  });

  it('a continuation the provider throttles again leaves its declined cell eligible for the next one, and only that', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const first = await continueMatrix({ sourceRoot, include: true,
      script: (_model, caseID, run) => (caseID === A && run === 1 ? THROTTLED : CHANGES_NOTHING) });
    // B@2 ran, A@3 was declined, B@3 was deferred behind it.
    expect(first.calls).toEqual([`${ASTRA}|${B}|1`, `${ASTRA}|${A}|1`]);
    const next = planWorkspaceContinuation(readSource(sourceRoot), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      includeProviderThrottledAttempts: true, priorContinuationRows: readWorkspaceContinuationRows(first.root) });
    expect(next.selection.selectors.map(at)).toEqual([`${A}@3`, `${B}@3`]);
  });
});

// MARK: - 15-16 · the combined logical report

describe('15-16 · the combined report counts each planned cell exactly once, and keeps every decline as history', () => {
  it('uses the source where it completed and the continuation where it did not; the original throttle stays visible', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const continuation = await continueMatrix({ sourceRoot, include: true });
    const source = readSource(sourceRoot);
    const report = combineWorkspaceContinuationEvidence(source,
      [{ label: continuation.label, rows: readWorkspaceContinuationRows(continuation.root) }]);
    expect(report.counts).toEqual({ plannedCells: 12, fromSource: 9, fromContinuation: 3, missing: 0,
      historicalProviderDeclines: 1, excludedSurplusRuns: 0, ignoredContinuationRows: 0 });
    expect(report.logicalRows).toHaveLength(12);
    expect(new Set(report.logicalRows.map((run) => run.recordRoot)).size).toBe(12);
    const throttled = report.cells.find((cell) => cell.candidate.includes(ASTRA) && at(cell) === `${B}@2`)!;
    expect(throttled.evidence).toBe('continuation');
    expect(throttled.evidenceRecordRoot!.startsWith(continuation.root)).toBe(true);
    expect(throttled.history).toEqual([expect.objectContaining({ origin: 'source', status: 'runtimeError',
      recordRoot: source.cells.find((cell) => cell.cellID === throttled.cellID)!.recordRoot })]);
    // The historical decline is NOT a logical row, and the aggregate over the logical rows sees 3 runs per cell.
    expect(report.logicalRows.some((run) => run.recordRoot === throttled.history[0].recordRoot)).toBe(false);
    const aggregate = aggregateWorkspaceRuns(report.logicalRows);
    expect(aggregate).toHaveLength(4);
    for (const cell of aggregate) {
      expect(cell.quality.statusCounts).not.toHaveProperty('runtimeError');
      expect(Object.values(cell.quality.statusCounts).reduce((sum, count) => sum + count, 0)).toBe(3);
    }
  });

  it('never double-counts a surplus continuation run, and keeps a continuation decline as history', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const first = await continueMatrix({ sourceRoot, include: true,
      script: (_model, caseID, run) => (caseID === B && run === 1 ? THROTTLED : CHANGES_NOTHING) });
    // B@2 declined again in the first continuation, and A@3, B@3 were deferred behind it, so the second
    // legitimately runs all three. A THIRD, deliberately not told about the second, re-selects all three —
    // surplus runs the report must list and must not count.
    const second = await continueMatrix({ sourceRoot, include: true, label: 'codex-source-01-cont-02' });
    const third = await continueMatrix({ sourceRoot, include: true, label: 'codex-source-01-cont-03' });
    const report = combineWorkspaceContinuationEvidence(readSource(sourceRoot), [
      { label: first.label, rows: readWorkspaceContinuationRows(first.root) },
      { label: second.label, rows: readWorkspaceContinuationRows(second.root) },
      { label: third.label, rows: readWorkspaceContinuationRows(third.root) },
    ]);
    expect(report.counts).toMatchObject({ plannedCells: 12, fromSource: 9, fromContinuation: 3, missing: 0,
      historicalProviderDeclines: 2, excludedSurplusRuns: 3 });
    expect(report.logicalRows).toHaveLength(12);
    const b2 = report.cells.find((cell) => cell.candidate.includes(ASTRA) && at(cell) === `${B}@2`)!;
    expect(b2.history.map((entry) => entry.origin)).toEqual(['source', 'continuation']);
    expect(b2.evidenceRecordRoot!.startsWith(second.root)).toBe(true);
    expect(b2.excluded.map((entry) => entry.recordRoot.startsWith(third.root))).toEqual([true]);
  });

  it('with no continuation yet, reports the missing cells as missing — never as failures, never as zeros', async () => {
    const { root } = await runSourceMatrix();
    const report = combineWorkspaceContinuationEvidence(readSource(root), []);
    expect(report.counts).toMatchObject({ plannedCells: 12, fromSource: 9, fromContinuation: 0, missing: 3, historicalProviderDeclines: 1 });
    expect(report.logicalRows).toHaveLength(9);
  });

  it('ignores rows that do not continue this source', async () => {
    const { root: sourceRoot } = await runSourceMatrix();
    const { root: otherSource } = await runSourceMatrix();
    const other = await continueMatrix({ sourceRoot: otherSource });
    const report = combineWorkspaceContinuationEvidence(readSource(sourceRoot),
      [{ label: other.label, rows: readWorkspaceContinuationRows(other.root) }]);
    expect(report.counts.fromContinuation).toBe(0);
    expect(report.counts.ignoredContinuationRows).toBe(2);
  });
});

// MARK: - the historical campaign's shape: exactly nine cells

describe('the Astra continuation of the discriminator campaign\'s shape selects exactly the nine deferred cells', () => {
  const readDiscriminator = (root: string) => readWorkspaceContinuationSource({
    campaignRoot: root, label: DISCRIMINATOR_LABEL, pack: discriminatorOnePack, cases: cells });

  it('reads 36 planned, sol 18/18, astra 8 scored + 1 throttled + 9 deferred, and derives the nine', () => {
    const source = readDiscriminator(writeDiscriminatorShapedSource());
    expect(source.cells).toHaveLength(36);
    const tally = (model: string, state: string) => source.cells.filter((cell) => cell.modelID === model && cell.state === state).length;
    expect(tally(SOL, 'completed')).toBe(18);
    expect(tally(ASTRA, 'completed')).toBe(8);
    expect(source.cells.filter((cell) => cell.modelID === ASTRA && cell.status === 'pass')).toHaveLength(6);
    expect(tally(ASTRA, 'providerThrottledAttempt')).toBe(1);
    expect(tally(ASTRA, 'notExecutedBecauseThrottled')).toBe(9);
    const planned = planWorkspaceContinuation(source, { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium' });
    expect(planned.selection.selectors.map(at)).toEqual(EXPECTED_ASTRA_CONTINUATION);
    expect(planned.selection.selectors.every((selector) => selector.modelID === ASTRA)).toBe(true);
    expect(planned.selection.continuation).toMatchObject({ sourcePlannedRunCount: 36, outOfScopeRunCount: 18,
      completedExcludedCount: 8, eligibleRunCount: 10, throttledAttemptsHeldBackCount: 1 });
  });

  it('plans them as nine runs of gpt-6-astra @ medium at their original repeats, admitted by a selection admission and nothing wider', () => {
    const sourceRoot = writeDiscriminatorShapedSource();
    const planned = planWorkspaceContinuation(readDiscriminator(sourceRoot), { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium' });
    const label = 'codex-discriminator-medium-v1-01-astra-cont-01';
    const base = request({ campaignRoot: temporary('cernum-disc-cont-'), runLabel: label, pack: discriminatorOnePack,
      cellSelection: planned.selection });
    const digest = buildWorkspaceMatrixPlan(base).selection!.selectionDigest;
    const plan = buildWorkspaceMatrixPlan({ ...base, identityAdmission: sealed(label, { pack: discriminatorOnePack, selectionDigest: digest }) });
    expect(plan.taskRunCount).toBe(9);
    expect(plan.runnableRunCount).toBe(9);
    expect(plan.selection!.fullPlanRunCount).toBe(18);
    expect(plan.maximumProviderAttemptCount).toBe(plan.cells.reduce((sum, cell) => sum + cell.caseMaximumAttempts, 0));
    expect(plan.cells.every((cell) => cell.candidate === `codexCLI:${ASTRA}@medium`)).toBe(true);
    expect(plan.cells.map((cell) => `${at(cell)}/${cell.repeat.repeatsPlanned}`)).toEqual(EXPECTED_ASTRA_CONTINUATION.map((cell) => `${cell}/3`));
    expect(plan.cells.every((cell) => cell.recordLabel.endsWith(`repeat ${cell.repeat.repeatIndex}/3`))).toBe(true);
    expect(plan.appliedEffortTelemetry.measuredRunCount).toBe(0);
    expect(plan.models[0].effortTelemetry).toMatchObject({ requestedEffort: 'medium', measurable: true });
    // Every cell's record admission names this selection and its own cell.
    expect(plan.cells.every((cell) => cell.identityAdmission?.matrixAdmission?.cellSelectionDigest === digest
      && cell.identityAdmission.matrixAdmission.matrixCellID === cell.cellID)).toBe(true);
    // A whole-pack admission — like the one the source ran under — does not admit it.
    expect(() => buildWorkspaceMatrixPlan({ ...base, identityAdmission: sealed(label, { pack: discriminatorOnePack }) }))
      .toThrow(expect.objectContaining({ code: 'matrixAdmissionSelectionMismatch' }));
  });

  it('adding the throttled attempt makes ten, and the logical report then has all eighteen astra cells', () => {
    const source = readDiscriminator(writeDiscriminatorShapedSource());
    const planned = planWorkspaceContinuation(source, { provider: 'codexCLI', modelIDs: [ASTRA], effort: 'medium',
      includeProviderThrottledAttempts: true });
    expect(planned.selection.selectors.map(at)).toEqual(['ws.d1.config-migrate.upgrade@2', ...EXPECTED_ASTRA_CONTINUATION]);
    const withoutIt = combineWorkspaceContinuationEvidence(source, []);
    expect(withoutIt.counts).toMatchObject({ plannedCells: 36, fromSource: 26, missing: 10, historicalProviderDeclines: 1 });
    expect(DISCRIMINATOR_CASES).toHaveLength(6);
    expect(ASTRA_EXECUTED).toHaveLength(9);
  });
});

// MARK: - the real command, with nothing reachable

describe('cernum workspace-benchmark --continue-from, and cernum workspace-report', () => {
  let campaigns: string;
  let fakeBin: string;
  let sourceRoot: string;

  beforeEach(() => {
    campaigns = temporary('cernum-cont-cli-');
    fakeBin = temporary('cernum-cont-bin-');
    sourceRoot = writeDiscriminatorShapedSource();
    for (const name of ['codex', 'claude']) {
      fs.writeFileSync(path.join(fakeBin, name), [
        '#!/bin/sh', `echo "$@" >> ${JSON.stringify(path.join(fakeBin, `${name}.invocations`))}`, 'exit 97', '',
      ].join('\n'), { mode: 0o755 });
    }
    const file = discoveryStorePath(campaigns);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ writtenAt: new Date().toISOString(), models: [acceptedCodexRoute(ASTRA), acceptedCodexRoute(SOL)] }));
  });

  const cernum = (...args: string[]) => {
    const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args], {
      cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin` },
    });
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  const nothingRan = () => {
    for (const name of ['codex', 'claude']) expect(fs.existsSync(path.join(fakeBin, `${name}.invocations`)), name).toBe(false);
  };
  const astra = ['workspace-benchmark', discriminatorOnePack.id, '--provider', 'codexCLI', '--models', ASTRA, '--effort', 'medium',
    '--label', 'astra-cont-01'];

  it('7, 12 · the dry run shows the source, the exclusions, exactly the nine cells, and sends nothing', () => {
    const before = treeDigest(sourceRoot);
    const dry = cernum(...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns, '--dry-run');
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain('DRY RUN');
    expect(dry.output).toContain(`selection       CONTINUATION of '${DISCRIMINATOR_LABEL}'`);
    expect(dry.output).toContain('full plan       1 models x 6 cases x 3 repeats = 18 runs');
    expect(dry.output).toContain('selected runs   9 independent runs');
    expect(dry.output).toContain('source plan   36 runs');
    expect(dry.output).toContain('out of scope  18 run(s)');
    expect(dry.output).toContain('completed     8 run(s) of this route the source completed — EXCLUDED');
    expect(dry.output).toContain('held back     1 provider-declined attempt(s) NOT selected');
    expect(dry.output).toContain('selected cells  9:');
    for (const cell of EXPECTED_ASTRA_CONTINUATION) {
      const [caseID, repeat] = cell.split('@');
      expect(dry.output).toContain(`codexCLI:${ASTRA}@medium · ${caseID} · repeat ${repeat}/3  notExecutedBecauseThrottled`);
    }
    expect(dry.output).not.toContain(`codexCLI:${SOL}@medium · ws.d1`);
    expect(dry.output).toContain('immutable     The source campaign is read and never written');
    expect(dry.output).toContain('REQUIRED — ABSENT');
    expect(dry.output).toMatch(/"selection": \{ "digest": "cms1:[0-9a-f]{64}" \}/);
    expect(dry.output).toContain(`--continue-from ${DISCRIMINATOR_LABEL} --source-root ${sourceRoot}`);
    expect(dry.output).toContain('No request was sent');
    expect(fs.existsSync(path.join(campaigns, 'workspace'))).toBe(false);
    expect(treeDigest(sourceRoot)).toEqual(before);
    nothingRan();
  }, 120_000);

  it('17 · with a selection admission the nine are admitted; a whole-pack admission is refused', () => {
    const dry = cernum(...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns, '--dry-run');
    const digest = /"digest": "(cms1:[0-9a-f]{64})"/.exec(dry.output)![1];
    const file = path.join(campaigns, 'admission.json');
    const admission = (selectionDigest?: string) => {
      const body = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'aggregates', `${DISCRIMINATOR_LABEL}.json`), 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ admissionScope: 'workspaceMatrix', authorizedBy: 'test', reason: 'test', intent: 'test',
        pack: { id: discriminatorOnePack.id, version: '1', digest: body.packDigest },
        admitted: [{ provider: 'codexCLI', requestedModelID: ASTRA, requestedEffort: 'medium', driverID: 'driver.codex-cli.workspace',
          cliVersion: '0.155.0', executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
          authenticationBasis: 'fixture', evidenceDigest: 'sha256:fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z' }],
        ...(selectionDigest === undefined ? {} : { selection: { digest: selectionDigest } }) }));
      return file;
    };
    const admitted = cernum(...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns,
      '--admit-identity-unverifiable', admission(digest), '--dry-run');
    expect(admitted.status, admitted.output).toBe(0);
    expect(admitted.output).toContain('runnable      9');
    expect(admitted.output).toContain(`ONLY the selection ${digest}`);
    const whole = cernum(...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns,
      '--admit-identity-unverifiable', admission(), '--dry-run');
    expect(whole.status).toBe(2);
    expect(whole.output).toContain('matrixAdmissionSelectionMismatch');
    nothingRan();
  }, 120_000);

  it('refuses the source\'s own root, the source\'s own label, a completed cell, and a mismatched repeat count', () => {
    const cases: [string[], string][] = [
      [[...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', sourceRoot], 'DIFFERENT campaign root'],
      [[...astra.slice(0, -1), DISCRIMINATOR_LABEL, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns],
        'runs under a NEW label'],
      [[...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns,
        '--cells', 'ws.d1.log-redact.mask@1'], 'cellAlreadyCompleted'],
      [[...astra, '--continue-from', DISCRIMINATOR_LABEL, '--source-root', sourceRoot, '--root', campaigns, '--repeats', '2'],
        'disagrees with the source'],
      [[...astra, '--continue-from', DISCRIMINATOR_LABEL, '--root', campaigns], 'needs --source-root'],
      [[...astra, '--source-root', sourceRoot, '--root', campaigns], 'only means something with --continue-from'],
    ];
    const before = treeDigest(sourceRoot);
    for (const [args, message] of cases) {
      const result = cernum(...args, '--dry-run');
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.output).toContain(message);
    }
    expect(treeDigest(sourceRoot)).toEqual(before);
    nothingRan();
  }, 240_000);

  it('7 · --cells alone dry-runs an explicit selection of exactly the named cells', () => {
    const dry = cernum(...astra, '--cells', 'ws.d1.log-redact.mask@2,ws.d1.config-migrate.upgrade@3', '--root', campaigns, '--dry-run');
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain('selection       EXPLICIT');
    expect(dry.output).toContain('selected cells  2:');
    expect(dry.output).toContain(`codexCLI:${ASTRA}@medium · ws.d1.log-redact.mask · repeat 2/3  operatorSelected`);
    expect(dry.output).toContain(`codexCLI:${ASTRA}@medium · ws.d1.config-migrate.upgrade · repeat 3/3  operatorSelected`);
    const bad = cernum(...astra, '--cells', 'ws.d1.log-redact.mask', '--root', campaigns, '--dry-run');
    expect(bad.status).toBe(2);
    expect(bad.output).toContain('cellListMalformed');
    nothingRan();
  }, 120_000);

  it('workspace-report reads the source and writes nowhere but --out', () => {
    const before = treeDigest(sourceRoot);
    const out = path.join(temporary('cernum-report-out-'), 'logical.json');
    const report = cernum('workspace-report', discriminatorOnePack.id, '--source-root', sourceRoot, '--source-label', DISCRIMINATOR_LABEL,
      '--continuation-root', campaigns, '--out', out);
    expect(report.status, report.output).toBe(0);
    expect(report.output).toContain('logical cells   36 planned · 26 from the source · 0 from a continuation · 10 still missing');
    expect(report.output).toContain('history         1 provider-declined attempt(s), kept and not counted');
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.counts.plannedCells).toBe(36);
    expect(written.logicalRows).toHaveLength(26);
    for (const [root, flag] of [[sourceRoot, []], [campaigns, ['--continuation-root', campaigns]]] as const) {
      const inside = cernum('workspace-report', discriminatorOnePack.id, '--source-root', sourceRoot, '--source-label', DISCRIMINATOR_LABEL,
        ...flag, '--out', path.join(root, 'report.json'));
      expect(inside.status).toBe(2);
      expect(inside.output).toContain('writes nowhere inside a campaign it reads');
      expect(fs.existsSync(path.join(root, 'report.json'))).toBe(false);
    }
    expect(treeDigest(sourceRoot)).toEqual(before);
    nothingRan();
  }, 120_000);
});
