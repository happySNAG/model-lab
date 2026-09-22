// EXACT MATRIX-CELL SELECTION: the primitive every partial matrix compiles to — its identity, its
// parsing, how it narrows a plan, what each selected record carries, and how a matrix admission binds
// to exactly the selected cells.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED. Every run below uses a scripted driver that starts
// no process, or — for the telemetry test — a fake `codex` in a temporary directory that can reach only
// the loopback collector the test itself started.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allWorkspaceCases, BROKEN_SUM_MEAN, foundationFourPack } from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import {
  WorkspaceMatrixError, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan, runWorkspaceMatrix,
} from '../../src/engine/workspace-matrix';
import {
  WorkspaceCellSelectionError, describeWorkspaceCellCoordinate, parseWorkspaceCellList,
  parseWorkspaceCellSelectionFile, workspaceMatrixCellID,
} from '../../src/engine/workspace-cell-selection';
import {
  matrixAdmissionReferenceOf, parseWorkspaceMatrixAdmissionFile, recordAdmissionFromMatrix,
  sealWorkspaceMatrixAdmission,
} from '../../src/engine/workspace-matrix-admission';
import { admissionSealIsIntact } from '../../src/engine/identity-admission';
import { WorkspaceCampaign, workspaceRecordPaths } from '../../src/engine/workspace-campaign';
import { collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { CodexPreflight, CodexWorkspaceDriver, CODEX_CLI_VERSION_VERIFIED_AGAINST } from '../../src/engine/workspace-codex-driver';
import { WorkspaceMatrixTelemetryCollector } from '../../src/engine/workspace-matrix-telemetry';
import {
  A, ASTRA, B, DISCOVERY, NODE_DIRECTORY, PACK, RUN_OPTIONS, SOL, admissionText,
  claudeFactory, codexFactory, fakeCodexWithTelemetry, request, sealed, temporary,
} from './workspace-continuation-harness';

const LABEL = 'selection-test';
const explicit = (...cells: string[]) => ({ mode: 'explicit' as const, selectors: parseWorkspaceCellList(cells.join(','), PACK.caseIDs) });
const coordinate = (cell: { candidate: string; caseID: string; repeat: { repeatIndex: number; repeatsPlanned: number } }) =>
  `${cell.candidate}|${cell.caseID}|${cell.repeat.repeatIndex}/${cell.repeat.repeatsPlanned}`;

// MARK: - identity

describe('a matrix cell has one stable identity, made of the plan\'s own dimensions', () => {
  const base = { packID: PACK.id, packVersion: '1', provider: 'codexCLI' as const, modelID: ASTRA, effort: 'medium' as const,
    caseID: A, repeatIndex: 3, repeatsPlanned: 3 };

  it('is deterministic, and every dimension changes it', () => {
    const id = workspaceMatrixCellID(base);
    expect(id).toMatch(/^cmc1:[0-9a-f]{64}$/);
    expect(workspaceMatrixCellID({ ...base })).toBe(id);
    for (const change of [{ modelID: SOL }, { effort: 'max' as const }, { provider: 'claudeCLI' as const }, { caseID: B },
      { repeatIndex: 2 }, { repeatsPlanned: 5 }, { packID: 'pack.other' }, { packVersion: '2' }]) {
      expect(workspaceMatrixCellID({ ...base, ...change }), JSON.stringify(change)).not.toBe(id);
    }
  });

  it('is what every planned cell carries, selection or not', () => {
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL }));
    expect(plan.cells).toHaveLength(6);
    expect(new Set(plan.cells.map((cell) => cell.cellID)).size).toBe(6);
    for (const cell of plan.cells) {
      expect(cell.cellID).toBe(workspaceMatrixCellID({ ...base, caseID: cell.caseID, repeatIndex: cell.repeat.repeatIndex }));
      expect(cell.selection).toBeUndefined();
    }
  });
});

// MARK: - parsing

describe('the --cells selector is unambiguous by construction', () => {
  it('parses <case-id>@<repeat> by matching the pack\'s own case ids, split at the LAST @', () => {
    expect(parseWorkspaceCellList(`${A}@2, ${B}@3`, PACK.caseIDs)).toEqual([
      { caseID: A, repeatIndex: 2 }, { caseID: B, repeatIndex: 3 }]);
  });

  it('refuses anything it would have to guess at', () => {
    const refuses = (text: string, code: string) => {
      try { parseWorkspaceCellList(text, PACK.caseIDs); } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceCellSelectionError);
        expect((error as WorkspaceCellSelectionError).code).toBe(code);
        return;
      }
      throw new Error(`'${text}' was accepted`);
    };
    refuses(`${A}`, 'cellListMalformed');
    refuses(`${A}@`, 'cellListMalformed');
    refuses(`${A}@0`, 'cellListMalformed');
    refuses(`${A}@two`, 'cellListMalformed');
    refuses(`${A}@2,,${B}@1`, 'cellListMalformed');
    refuses('ws.no-such.case@1', 'cellSelectionUnknownCase');
    refuses(`${A.slice(0, -1)}@1`, 'cellSelectionUnknownCase');
    expect(() => parseWorkspaceCellList('x@1', ['a,b', 'c@d'])).toThrow(/--cells-file/);
  });

  it('reads the JSON form, with an optional per-cell model, and refuses unknown keys', () => {
    expect(parseWorkspaceCellSelectionFile(JSON.stringify({ cells: [{ caseID: 'odd,@id', repeatIndex: 2, modelID: ASTRA }] })))
      .toEqual([{ caseID: 'odd,@id', repeatIndex: 2, modelID: ASTRA }]);
    expect(() => parseWorkspaceCellSelectionFile(JSON.stringify({ cells: [{ caseID: A, repeat: 2 }] }))).toThrow(/unknown key/);
    expect(() => parseWorkspaceCellSelectionFile(JSON.stringify({ cells: [], all: true }))).toThrow(/unknown key/);
    expect(() => parseWorkspaceCellSelectionFile(JSON.stringify({ cells: [] }))).toThrow(/names no cell/);
  });
});

// MARK: - 1-8 · narrowing a plan

describe('a selection narrows the plan to exactly the named cells, at their original coordinates', () => {
  it('1 · selects exactly one case at one repeat', () => {
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL,
      cellSelection: explicit(`${B}@2`) }));
    expect(plan.cells.map(coordinate)).toEqual([`codexCLI:${ASTRA}@medium|${B}|2/3`]);
    expect(plan.taskRunCount).toBe(1);
    expect(plan.selection).toMatchObject({ mode: 'explicit', fullPlanRunCount: 6, selectedRunCount: 1 });
    expect(plan.cells[0].selection).toMatchObject({ cellSelectionMode: 'explicit', cellSelectionReason: 'operatorSelected',
      matrixCellID: plan.cells[0].cellID, cellSelectionDigest: plan.selection!.selectionDigest });
  });

  it('2 · keeps the ORIGINAL repeat number: repeat 3 is sealed as repeat 3 of 3, not repeat 1 of 1', async () => {
    const root = temporary('cernum-sel-');
    const matrix = request({ campaignRoot: root, runLabel: LABEL, cellSelection: explicit(`${A}@3`),
      identityAdmission: undefined, modelIDs: [ASTRA] });
    const admitted = { ...matrix, identityAdmission: sealed(LABEL, { selectionDigest: buildWorkspaceMatrixPlan(matrix).selection!.selectionDigest }) };
    const plan = buildWorkspaceMatrixPlan(admitted);
    const cell = plan.cells[0];
    expect(cell.repeat.repeatIndex).toBe(3);
    expect(cell.repeat.repeatsPlanned).toBe(3);
    expect(cell.recordName).toBe(`${LABEL}-gpt-6-astra-ws-receipt-refunds-sign-r3`);
    expect(cell.recordLabel).toContain('repeat 3/3');
    // The same repeat group as the unselected plan's repeat 3 — a selected run is a sibling of the others.
    const full = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL }));
    expect(cell.repeat).toEqual(full.cells.find((entry) => entry.caseID === A && entry.repeat.repeatIndex === 3)!.repeat);

    const result = await runWorkspaceMatrix(plan, admitted, RUN_OPTIONS);
    expect(result.executedRunCount).toBe(1);
    const [row] = collectWorkspaceRunRows(root).map((run) => run.row);
    expect(row).toMatchObject({ repeatIndex: 3, repeatsPlanned: 3, repeatGroupID: cell.repeat.repeatGroupID, caseID: A,
      matrixCellID: cell.cellID, cellSelectionMode: 'explicit', cellSelectionReason: 'operatorSelected',
      cellSelectionDigest: plan.selection!.selectionDigest });
    const meta = JSON.parse(fs.readFileSync(path.join(workspaceRecordPaths(cell.recordRoot).ledger, 'meta.json'), 'utf8'));
    expect(meta.label).toContain('repeat 3/3');
    expect(meta.matrixCellID).toBe(cell.cellID);
    const record = JSON.parse(fs.readFileSync(workspaceRecordPaths(cell.recordRoot).record, 'utf8'));
    expect(record).toMatchObject({ repeatIndex: 3, repeatsPlanned: 3, matrixCellID: cell.cellID });
  });

  it('3 · selects several repeats of one case', () => {
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL,
      cellSelection: explicit(`${A}@1`, `${A}@3`) }));
    expect(plan.cells.map(coordinate)).toEqual([`codexCLI:${ASTRA}@medium|${A}|1/3`, `codexCLI:${ASTRA}@medium|${A}|3/3`]);
  });

  it('4 · selects several cases, and keeps the plan\'s own model → repeat → case order', () => {
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL,
      cellSelection: explicit(`${B}@3`, `${A}@2`, `${B}@1`) }));
    expect(plan.cells.map(coordinate)).toEqual([
      `codexCLI:${ASTRA}@medium|${B}|1/3`, `codexCLI:${ASTRA}@medium|${A}|2/3`, `codexCLI:${ASTRA}@medium|${B}|3/3`]);
  });

  it('5 · scopes by model: a selector applies to every model named, or to the one it names', () => {
    const root = temporary('cernum-sel-');
    const both = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, modelIDs: [SOL, ASTRA],
      cellSelection: explicit(`${A}@2`) }));
    expect(both.cells.map((cell) => cell.modelID)).toEqual([SOL, ASTRA]);
    const astraOnly = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, modelIDs: [SOL, ASTRA],
      cellSelection: { mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2, modelID: ASTRA }, { caseID: B, repeatIndex: 1, modelID: SOL }] } }));
    expect(astraOnly.cells.map(coordinate)).toEqual([`codexCLI:${SOL}@medium|${B}|1/3`, `codexCLI:${ASTRA}@medium|${A}|2/3`]);
    // A model named in --models with nothing selected is refused, not silently carried along.
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, modelIDs: [SOL, ASTRA],
      cellSelection: { mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2, modelID: ASTRA }] } })))
      .toThrow(expect.objectContaining({ code: 'cellSelectionModelUnselected' }));
    // …and a selector cannot add a model --models did not name.
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, modelIDs: [ASTRA],
      cellSelection: { mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2, modelID: SOL }] } })))
      .toThrow(expect.objectContaining({ code: 'cellSelectionUnknownModel' }));
  });

  it('6 · scopes by effort: the same case and repeat at another effort is another cell and another selection', () => {
    const root = temporary('cernum-sel-');
    const medium = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, cellSelection: explicit(`${A}@2`) }));
    const max = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, effort: 'max', cellSelection: explicit(`${A}@2`) }));
    expect(max.cells[0].candidate).toBe(`codexCLI:${ASTRA}@max`);
    expect(max.cells[0].cellID).not.toBe(medium.cells[0].cellID);
    expect(max.selection!.selectionDigest).not.toBe(medium.selection!.selectionDigest);
  });

  it('refuses a repeat beyond the planned count, a duplicate, an empty selection and a case outside the pack', () => {
    const root = temporary('cernum-sel-');
    const code = (selection: Parameters<typeof request>[0]['cellSelection'], extra = {}) => {
      try { buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, cellSelection: selection, ...extra })); }
      catch (error) { expect(error).toBeInstanceOf(WorkspaceMatrixError); return (error as WorkspaceMatrixError).code; }
      return 'accepted';
    };
    expect(code({ mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 4 }] })).toBe('cellSelectionRepeatOutOfRange');
    expect(code({ mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 3 }] }, { repeatsPerCase: 2 })).toBe('cellSelectionRepeatOutOfRange');
    expect(code({ mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2 }, { caseID: A, repeatIndex: 2, modelID: ASTRA }] }))
      .toBe('cellSelectionDuplicate');
    expect(code({ mode: 'explicit', selectors: [] })).toBe('cellSelectionEmpty');
    expect(code({ mode: 'explicit', selectors: [{ caseID: 'ws.broken-sum.mean', repeatIndex: 1 }] })).toBe('cellSelectionUnknownCase');
  });

  it('7 · the dry run lists every selected cell by coordinate, the selection digest, and both counts', () => {
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: temporary('cernum-sel-'), runLabel: LABEL,
      cellSelection: explicit(`${A}@2`, `${B}@3`) }));
    const text = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(text).toContain('full plan       1 models x 2 cases x 3 repeats = 6 runs — NOT what runs');
    expect(text).toContain('selected runs   2 independent runs, each at its ORIGINAL case and repeat (explicit operator selection)');
    expect(text).toContain('selection       EXPLICIT');
    expect(text).toContain(`selection dig.  ${plan.selection!.selectionDigest}`);
    expect(text).toContain('selected cells  2:');
    for (const cell of plan.cells) {
      expect(text).toContain(describeWorkspaceCellCoordinate({ ...cell, repeatIndex: cell.repeat.repeatIndex, repeatsPlanned: 3 }));
      expect(text).toContain(cell.cellID);
      expect(text).toContain(workspaceRecordPaths(cell.recordRoot).manifest);
    }
    expect(text).not.toContain('base task runs');
  });

  it('8 · the attempt ceiling, recovery design and allowance are computed from the selected cells only', () => {
    const retryPack = makeWorkspaceBenchmarkPack({ id: 'pack.test.selection-retry', version: '1', caseIDs: [BROKEN_SUM_MEAN.id, A], repeatsPerCase: 3 });
    const root = temporary('cernum-sel-');
    const full = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, pack: retryPack, modelIDs: ['claude-haiku-4-5'],
      provider: 'claudeCLI', effort: 'none', driverFactory: claudeFactory() }));
    expect(full.maximumProviderAttemptCount).toBe(3 * 2 + 3 * 1);
    const onlyOneAttemptCase = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, pack: retryPack,
      modelIDs: ['claude-haiku-4-5'], provider: 'claudeCLI', effort: 'none', driverFactory: claudeFactory(),
      cellSelection: { mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2 }, { caseID: A, repeatIndex: 3 }] } }));
    expect(onlyOneAttemptCase.runnableRunCount).toBe(2);
    expect(onlyOneAttemptCase.maximumProviderAttemptCount).toBe(2);
    expect(onlyOneAttemptCase.designedRecovery.retryCapableRunCount).toBe(0);
    const oneRetryCell = buildWorkspaceMatrixPlan(request({ campaignRoot: root, runLabel: LABEL, pack: retryPack,
      modelIDs: ['claude-haiku-4-5'], provider: 'claudeCLI', effort: 'none', driverFactory: claudeFactory(),
      cellSelection: { mode: 'explicit', selectors: [{ caseID: BROKEN_SUM_MEAN.id, repeatIndex: 3 }] } }));
    expect(oneRetryCell.maximumProviderAttemptCount).toBe(2);
    expect(oneRetryCell.designedRecovery.retryCapableRunCount).toBe(1);
  });

  it('refuses a selected cell whose record already exists under the label, instead of faulting at execution', async () => {
    const root = temporary('cernum-sel-');
    const matrix = request({ campaignRoot: root, runLabel: LABEL, provider: 'claudeCLI', effort: 'none',
      modelIDs: ['claude-haiku-4-5'], driverFactory: claudeFactory(), cellSelection: explicit(`${A}@2`) });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect((await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS)).executedRunCount).toBe(1);
    expect(() => buildWorkspaceMatrixPlan(matrix)).toThrow(expect.objectContaining({ code: 'cellSelectionRecordExists' }));
  });
});

// MARK: - 17-18 · admission binds the selected cells

describe('a matrix admission for selected cells authorises those cells and nothing else', () => {
  const root = () => temporary('cernum-sel-adm-');
  const astraNine = () => explicit(`${A}@2`, `${B}@3`);
  const digestOf = (selection = astraNine(), overrides = {}) =>
    buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, cellSelection: selection, ...overrides })).selection!.selectionDigest;

  it('parses and seals the selection digest, and refuses a malformed one', () => {
    const digest = digestOf();
    const admission = sealed(LABEL, { selectionDigest: digest });
    expect(admission.cellSelectionDigest).toBe(digest);
    expect(admission.entries.every((entry) => entry.entryDigest.startsWith('cme1:'))).toBe(true);
    for (const bad of [{ digest: 'cmc1:abc' }, { digest, extra: 1 }, 'cms1:x', {}, [digest]]) {
      const text = { ...JSON.parse(admissionText()), selection: bad };
      expect(() => parseWorkspaceMatrixAdmissionFile(JSON.stringify(text)), JSON.stringify(bad))
        .toThrow(expect.objectContaining({ code: 'selectionMalformed' }));
    }
  });

  it('17 · admits the selection it names, and binds every record\'s admission to that record\'s own cell', () => {
    const selection = astraNine();
    const digest = digestOf(selection);
    const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, cellSelection: selection,
      identityAdmission: sealed(LABEL, { selectionDigest: digest }) }));
    expect(plan.runnableRunCount).toBe(2);
    expect(plan.admittedUnverifiableRunCount).toBe(2);
    for (const cell of plan.cells) {
      const reference = cell.identityAdmission!.matrixAdmission!;
      expect(reference.cellSelectionDigest).toBe(digest);
      expect(reference.matrixCellID).toBe(cell.cellID);
      expect(admissionSealIsIntact(cell.identityAdmission!)).toBe(true);
    }
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).toContain(`ONLY the selection ${digest}`);
  });

  it('17 · a record refuses an admission bound to another cell of the same selection', () => {
    const selection = astraNine();
    const request1 = request({ campaignRoot: root(), runLabel: LABEL, cellSelection: selection,
      identityAdmission: sealed(LABEL, { selectionDigest: digestOf(selection) }) });
    const plan = buildWorkspaceMatrixPlan(request1);
    const [first, second] = plan.cells;
    const model = plan.models[0];
    const create = (identityAdmission: typeof first.identityAdmission, cellSelection: typeof second.selection) => WorkspaceCampaign.create({
      root: second.recordRoot, label: second.recordLabel, case: allWorkspaceCases().find((entry) => entry.id === second.caseID)!,
      binding: model.binding!, identity: model.identity, identityAdmission, cellSelection,
      driver: request1.driverFactory!({ provider: 'codexCLI', requestedModelID: ASTRA, effort: 'medium' })!,
      hardware: RUN_OPTIONS.hardware, runtimeVersion: 'test', fixtureRoot: request1.fixtureRoot, sandboxRoot: request1.sandboxRoot,
      repeat: second.repeat, pack: { id: plan.packID, version: plan.packVersion, digest: plan.packDigest },
    });
    // first's admission, sealed to first's label AND first's cell, cannot be frozen into second's record.
    const relabelled = recordAdmissionFromMatrix(plan.identityAdmission!, model.admission.entry!, second.recordLabel, { matrixCellID: first.cellID });
    expect(() => create(relabelled, second.selection)).toThrow(/matrix cell/);
    // …and a record claiming no selection refuses an admission that names one.
    const own = second.identityAdmission;
    expect(() => create(own, undefined)).toThrow(/cell selection/);
    expect(fs.existsSync(second.recordRoot)).toBe(false);
  });

  it('18 · an admission for one selection authorises no other selection, and not the whole matrix', () => {
    const digest = digestOf();
    const admission = sealed(LABEL, { selectionDigest: digest });
    const refusal = (overrides: Parameters<typeof request>[0]) => {
      try { buildWorkspaceMatrixPlan(request({ runLabel: LABEL, identityAdmission: admission, ...overrides })); }
      catch (error) { return (error as WorkspaceMatrixError).code; }
      return 'accepted';
    };
    expect(refusal({ campaignRoot: root(), cellSelection: astraNine() })).toBe('accepted');
    // another case / repeat
    expect(refusal({ campaignRoot: root(), cellSelection: explicit(`${A}@2`, `${B}@2`) })).toBe('matrixAdmissionSelectionMismatch');
    expect(refusal({ campaignRoot: root(), cellSelection: explicit(`${A}@2`) })).toBe('matrixAdmissionSelectionMismatch');
    expect(refusal({ campaignRoot: root(), cellSelection: explicit(`${A}@2`, `${B}@3`, `${A}@1`) })).toBe('matrixAdmissionSelectionMismatch');
    // the whole matrix
    expect(refusal({ campaignRoot: root() })).toBe('matrixAdmissionSelectionMismatch');
    // and a whole-matrix admission does not authorise a selection
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, cellSelection: astraNine(),
      identityAdmission: sealed(LABEL) }))).toThrow(expect.objectContaining({ code: 'matrixAdmissionSelectionMismatch' }));
  });

  it('18 · …and not Sol, not max, not another pack, not another driver, not the metered API', () => {
    const selection = astraNine();
    const digest = digestOf(selection);
    // Sol, named in --models beside Astra with the same selection: Sol's route is not in the admission.
    const withSol = explicit(`${A}@2`, `${B}@3`);
    const solDigest = digestOf(withSol, { modelIDs: [SOL, ASTRA] });
    const both = buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, modelIDs: [SOL, ASTRA], cellSelection: withSol,
      identityAdmission: sealed(LABEL, { selectionDigest: solDigest }) }));
    expect(both.models.find((model) => model.modelID === SOL)!.runnable).toBe(false);
    expect(both.cells.filter((cell) => cell.modelID === SOL).every((cell) => !cell.runnable && cell.identityAdmission === undefined)).toBe(true);
    // max: the same cells at max are a different selection, and the admission's route is medium.
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, effort: 'max', cellSelection: selection,
      identityAdmission: sealed(LABEL, { selectionDigest: digest }) }))).toThrow(WorkspaceMatrixError);
    const maxDigest = digestOf(selection, { effort: 'max' });
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, effort: 'max', cellSelection: selection,
      identityAdmission: sealed(LABEL, { selectionDigest: maxDigest }) }))).toThrow(/does not run|matrixAdmissionEntryUnused/);
    // another pack
    expect(() => buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, pack: foundationFourPack,
      cellSelection: { mode: 'explicit', selectors: [{ caseID: A, repeatIndex: 2 }] },
      identityAdmission: sealed(LABEL, { selectionDigest: digest }) }))).toThrow(expect.objectContaining({ code: 'matrixAdmissionScopeMismatch' }));
    // another driver, or metered billing: the entry disagrees and the route is refused
    for (const routeOverrides of [{ driverID: 'driver.other' }, { billingBasis: 'meteredAPI', executionClass: 'meteredAPI' }]) {
      const plan = buildWorkspaceMatrixPlan(request({ campaignRoot: root(), runLabel: LABEL, cellSelection: selection,
        identityAdmission: sealed(LABEL, { selectionDigest: digest, routeOverrides }) }));
      expect(plan.runnableRunCount).toBe(0);
    }
  });
});

// MARK: - 19 · telemetry

describe('19 · Codex applied-effort telemetry works unchanged on selected cells', () => {
  it('measures medium on every selected run, joined by its own conversation id, with the selection stamped beside it', async () => {
    const root = temporary('cernum-sel-otlp-');
    const fake = fakeCodexWithTelemetry();
    const collector = await WorkspaceMatrixTelemetryCollector.start({
      directory: path.join(root, 'otlp'), runLabel: LABEL, observeTimeoutMilliseconds: 500, shutdownGraceMilliseconds: 0 });
    const subscription: CodexPreflight = { version: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      auth: { storedAuthMode: 'chatgpt', apiKeyStored: false, chatgptTokensStored: true, status: 'ok' } };
    const selection = explicit(`${A}@3`, `${B}@2`);
    const base = request({
      campaignRoot: root, runLabel: LABEL, cellSelection: selection, attemptCeiling: 1,
      effortTelemetry: { endpoint: collector.endpoint, observerAvailable: true, availabilityDetail: 'test collector', collector },
      driverFactory: (binding, context) => (binding.provider !== 'codexCLI' ? undefined : new CodexWorkspaceDriver({
        requestedModelID: binding.requestedModelID, effort: binding.effort, executablePath: fake.executable,
        preflight: async () => subscription, otlp: context?.otlp })),
      environmentSource: { PATH: `${NODE_DIRECTORY}:/usr/bin:/bin`, HOME: '/tmp/home', USER: 'somebody',
        OPENAI_API_KEY: 'sk-cernum-test-not-a-key' },
    });
    const digest = buildWorkspaceMatrixPlan(base).selection!.selectionDigest;
    const matrix = { ...base, identityAdmission: sealed(LABEL, { selectionDigest: digest }) };
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.appliedEffortTelemetry.measuredRunCount).toBe(2);
    const result = await runWorkspaceMatrix(plan, matrix, { ...RUN_OPTIONS, environmentSource: matrix.environmentSource });
    const telemetry = await collector.stop();
    expect(result.executedRunCount).toBe(2);
    expect(result.appliedEffortVerdicts.map((entry) => entry.verdict)).toEqual(['appliedEffortVerified', 'appliedEffortVerified']);
    expect(telemetry.summary.collisions).toEqual([]);
    expect(fake.invocations()).toHaveLength(2);
    for (const argv of fake.invocations()) expect(argv).toContain('model_reasoning_effort="medium"');
    const rows = collectWorkspaceRunRows(root).map((run) => run.row);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ requestedEffort: 'medium', appliedEffort: 'medium', appliedEffortVerdict: 'appliedEffortVerified',
        bindingIdentityState: 'requestAcceptedIdentityUnverifiable', billingBasis: 'subscriptionIncluded',
        cellSelectionDigest: digest, cellSelectionReason: 'operatorSelected' });
      expect(row.inputTokens).toBe(67791);
    }
    expect(rows.map((row) => `${row.caseID}@${row.repeatIndex}/${row.repeatsPlanned}`).sort()).toEqual([`${A}@3/3`, `${B}@2/3`]);
    expect(JSON.stringify(rows)).not.toContain('sk-cernum-test-not-a-key');
  }, 60_000);
});

// MARK: - 20-22 · nothing changes without a selector

describe('without a selector, every plan, record and admission is exactly what it was', () => {
  it('21 · no selector: the whole matrix, no selection block, and no selection field on any row', async () => {
    const root = temporary('cernum-sel-none-');
    const calls: string[] = [];
    const matrix = request({ campaignRoot: root, runLabel: LABEL, identityAdmission: sealed(LABEL), driverFactory: codexFactory({ calls }) });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.selection).toBeUndefined();
    expect(plan.taskRunCount).toBe(6);
    expect(plan.cells.every((cell) => cell.selection === undefined)).toBe(true);
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).toContain('base task runs  1 models x 2 cases x 3 repeats = 6 independent runs');
    // The per-record admission derived without a selection is byte-for-byte the one derived before selections existed.
    const entry = plan.models[0].admission.entry!;
    for (const cell of plan.cells) {
      expect(cell.identityAdmission).toEqual(recordAdmissionFromMatrix(plan.identityAdmission!, entry, cell.recordLabel));
      expect(cell.identityAdmission!.matrixAdmission).not.toHaveProperty('cellSelectionDigest');
      expect(cell.identityAdmission!.matrixAdmission).not.toHaveProperty('matrixCellID');
    }
    expect(matrixAdmissionReferenceOf(plan.identityAdmission!, entry)).not.toHaveProperty('matrixCellID');
    expect(plan.identityAdmission).not.toHaveProperty('cellSelectionDigest');
    await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
    expect(calls).toHaveLength(6);
    for (const { row, recordRoot } of collectWorkspaceRunRows(root)) {
      for (const key of ['matrixCellID', 'cellSelectionMode', 'cellSelectionReason', 'cellSelectionDigest', 'continuationSourceLabel',
        'continuationSourceDigest']) {
        expect(row, key).not.toHaveProperty(key);
        const meta = JSON.parse(fs.readFileSync(path.join(workspaceRecordPaths(recordRoot).ledger, 'meta.json'), 'utf8'));
        expect(meta, key).not.toHaveProperty(key);
      }
    }
  });

  it('a whole-matrix admission seals to the same digest whether or not the file format knows about selections', () => {
    const parsed = parseWorkspaceMatrixAdmissionFile(admissionText());
    expect(parsed).not.toHaveProperty('cellSelectionDigest');
    const one = sealWorkspaceMatrixAdmission(parsed, { matrixLabel: LABEL, authorizedAt: '2026-09-22T12:00:00Z' });
    const withUndefined = sealWorkspaceMatrixAdmission({ ...parsed, cellSelectionDigest: undefined },
      { matrixLabel: LABEL, authorizedAt: '2026-09-22T12:00:00Z' });
    expect(withUndefined.matrixAdmissionDigest).toBe(one.matrixAdmissionDigest);
    expect(withUndefined.entries[0].entryDigest).toBe(one.entries[0].entryDigest);
  });

  it('20 · a Claude full-pack matrix plans, runs and records exactly as before, with no admission and no selection', async () => {
    const root = temporary('cernum-sel-claude-');
    const calls: string[] = [];
    const matrix = request({ campaignRoot: root, runLabel: LABEL, provider: 'claudeCLI', effort: 'none',
      modelIDs: ['claude-haiku-4-5'], driverFactory: claudeFactory(calls), discovery: DISCOVERY });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.selection).toBeUndefined();
    expect(plan.runnableRunCount).toBe(6);
    expect(plan.models[0].admission.required).toBe(false);
    expect(plan.appliedEffortTelemetry.measuredRunCount).toBe(0);
    const text = describeWorkspaceMatrixPlan(plan).join('\n');
    for (const line of ['selection       ', 'selection dig.', 'selected runs', 'selected cells', 'full plan ']) {
      expect(text).not.toContain(line);
    }
    const result = await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
    expect(result.executedRunCount).toBe(6);
    expect(calls).toHaveLength(6);
    for (const { row } of collectWorkspaceRunRows(root)) {
      expect(row).not.toHaveProperty('matrixCellID');
      expect(row).not.toHaveProperty('appliedEffortVerdict');
      expect(row).not.toHaveProperty('identityAdmissionDigest');
    }
  });

  it('a Claude matrix can be selected too, needing no admission', async () => {
    const root = temporary('cernum-sel-claude-');
    const calls: string[] = [];
    const matrix = request({ campaignRoot: root, runLabel: LABEL, provider: 'claudeCLI', effort: 'none',
      modelIDs: ['claude-haiku-4-5'], driverFactory: claudeFactory(calls), cellSelection: explicit(`${B}@3`) });
    const plan = buildWorkspaceMatrixPlan(matrix);
    expect(plan.runnableRunCount).toBe(1);
    await runWorkspaceMatrix(plan, matrix, RUN_OPTIONS);
    expect(calls).toEqual([`claude-haiku-4-5|${B}`]);
    expect(collectWorkspaceRunRows(root)[0].row).toMatchObject({ repeatIndex: 3, repeatsPlanned: 3, cellSelectionReason: 'operatorSelected' });
  });
});
