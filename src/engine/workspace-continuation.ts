// Benchmark engine · CONTINUATION: finish a matrix a provider (or anything else) stopped, as a NEW
// matrix of exactly the cells that never produced evidence — and combine the two for reporting
// without rewriting either.
//
// THE PROBLEM. A sealed matrix can stop early for reasons that say nothing about the models: a
// provider usage limit trips the breaker in `workspace-throttle.ts` and every later cell of that
// provider is DEFERRED. Those cells must still be run for the experiment to be complete, and there
// are exactly three wrong ways to do it: re-run the label (the sealed records refuse, each as a
// harness fault, and the telemetry file beside them is rewritten), re-run the whole matrix (every
// completed cell becomes duplicate scoring evidence), or edit the source (history is rewritten).
//
// WHAT THIS DOES INSTEAD.
//   1. READ THE SOURCE, READ-ONLY. `readWorkspaceContinuationSource` parses the source's ledgers
//      itself rather than through `Ledger.open`, because `Ledger.open` repairs a torn final line by
//      truncating it — a write. A torn or ambiguous source ledger is REFUSED here, never repaired.
//      The source is fingerprinted (`cmr1:`) over the exact bytes it read.
//   2. CLASSIFY EVERY CELL THE SOURCE PLANNED: completed (any sealed row the provider did not
//      decline — pass, fail, or unscored), a provider-throttled attempt, deferred by the breaker,
//      not executed for another reason, or a record directory with no terminal row.
//   3. COMPILE TO A CELL SELECTION. `planWorkspaceContinuation` produces the SAME
//      `WorkspaceCellSelection` an operator's `--cells` produces, with a reason and the source
//      evidence on every cell. `buildWorkspaceMatrixPlan` applies it; there is no second executor.
//   4. REPORT LOGICALLY. `combineWorkspaceContinuationEvidence` reads source and continuation
//      records and produces ONE row per planned cell — the source's own where it completed, the
//      continuation's where it did not — with every historical decline kept as provenance and every
//      surplus run listed as excluded. Neither root is written.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, digestObject, sha256Bytes } from './canonical';
import { EffortLevel, ProviderID } from './provider';
import { WorkspaceRunRow, workspaceRunWasProviderDeclined } from './workspace-aggregate';
import { workspaceRecordPaths, workspaceRecordRoot } from './workspace-campaign';
import { WorkspaceCase } from './workspace-case';
import {
  SOURCE_CAMPAIGN_IS_IMMUTABLE, WorkspaceCellSelection, WorkspaceCellSelectionReason, WorkspaceCellSelector,
  WorkspaceContinuationSummary, describeWorkspaceCellCoordinate, workspaceMatrixCellID, workspaceMatrixRecordName,
  workspaceRecordSlug,
} from './workspace-cell-selection';
import { matrixCandidateName } from './workspace-matrix-admission';
import { WorkspaceBenchmarkPack, resolveWorkspacePack, workspacePackDigest } from './workspace-pack';

export class WorkspaceContinuationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceContinuationError';
  }
}

// MARK: - Reading records without writing them

/** One workspace record directory, read without opening anything for writing. */
export interface WorkspaceRecordReadOnly {
  name: string;
  recordRoot: string;
  /** The terminal row, when the record has one. */
  row?: Record<string, unknown>;
  /** SHA-256 of the bytes read, so a fingerprint names exactly what was seen. Absent when the file is. */
  manifestSHA256?: string;
  resultsSHA256?: string;
  /** The binding deadline the manifest froze, when it froze one. */
  bindingTimeoutMilliseconds?: number;
}

/**
 * Read one record's terminal row and fingerprints, READ-ONLY.
 *
 * `Ledger.open` is deliberately not used: it truncates a torn final line, which is the right thing for
 * a campaign about to resume and the wrong thing for a source that must not change. So every non-empty
 * line must parse, and a workspace record must hold at most one terminal row; anything else is refused.
 */
export function readWorkspaceRecordReadOnly(recordRoot: string): WorkspaceRecordReadOnly {
  const paths = workspaceRecordPaths(recordRoot);
  const name = path.basename(recordRoot);
  const found: WorkspaceRecordReadOnly = { name, recordRoot };
  if (fs.existsSync(paths.manifest)) {
    const bytes = fs.readFileSync(paths.manifest);
    found.manifestSHA256 = sha256Bytes(bytes);
    try {
      const manifest = JSON.parse(bytes.toString('utf8')) as { operationalEnvelope?: { bindings?: { timeoutMilliseconds?: unknown }[] } };
      const timeout = manifest.operationalEnvelope?.bindings?.[0]?.timeoutMilliseconds;
      if (typeof timeout === 'number') found.bindingTimeoutMilliseconds = timeout;
    } catch {
      throw new WorkspaceContinuationError('recordUnreadable',
        `${paths.manifest} is not valid JSON. A record whose manifest cannot be read cannot be continued or reported.`);
    }
  }
  const results = path.join(paths.ledger, 'results.jsonl');
  if (!fs.existsSync(results)) return found;
  const bytes = fs.readFileSync(results);
  found.resultsSHA256 = sha256Bytes(bytes);
  const lines = bytes.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
  const rows = lines.map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new WorkspaceContinuationError('recordLedgerTorn',
        `${results} line ${index + 1} is not a complete JSON row. It is refused, not repaired: repairing it would `
        + 'write to a record this command only reads.');
    }
  });
  if (rows.length > 1) {
    throw new WorkspaceContinuationError('recordLedgerAmbiguous',
      `${results} holds ${rows.length} terminal rows, and a workspace record holds one. Refusing to choose between them.`);
  }
  if (rows.length === 1) found.row = rows[0];
  return found;
}

/** Every record directory under a campaign root whose name starts with `<label>-`. Read-only. */
export function readWorkspaceRecordsReadOnly(campaignRoot: string, label?: string): WorkspaceRecordReadOnly[] {
  const root = workspaceRecordRoot(campaignRoot);
  if (!fs.existsSync(root)) return [];
  const prefix = label === undefined ? undefined : `${workspaceRecordSlug(label)}-`;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (prefix === undefined || entry.name.startsWith(prefix))
      && fs.existsSync(path.join(root, entry.name, 'ledger')))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => readWorkspaceRecordReadOnly(path.join(root, entry.name)));
}

// MARK: - The source

/**
 * What happened to one cell the source planned, according to the source's own evidence.
 *
 * `completed` is ANY sealed row the provider did not decline — a pass, a failure, or a run that
 * measured nothing for another reason. Every one of those is evidence about the cell, so none is
 * eligible to run again: re-running a failure until it passes is not a continuation.
 */
export type WorkspaceSourceCellState =
  | 'completed'
  | 'providerThrottledAttempt'
  | 'notExecutedBecauseThrottled'
  | 'notExecuted'
  | 'recordWithoutResult';

export interface WorkspaceSourceCell {
  cellID: string;
  candidate: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  caseID: string;
  repeatIndex: number;
  repeatsPlanned: number;
  recordName: string;
  state: WorkspaceSourceCellState;
  recordRoot?: string;
  status?: string;
  row?: Record<string, unknown>;
}

export interface WorkspaceContinuationSource {
  label: string;
  campaignRoot: string;
  /** `cmr1:` over every record read and the aggregate, by bytes. */
  digest: string;
  pack: { id: string; version: string; digest: string };
  provider: ProviderID;
  effort: EffortLevel;
  repeatsPlanned: number;
  candidates: { candidate: string; modelID: string }[];
  /** Every cell the source planned, in its own execution order (model → repeat → case). */
  cells: WorkspaceSourceCell[];
  /** The records that belong to this matrix. */
  records: WorkspaceRecordReadOnly[];
  /** Directories whose name shares the label prefix but whose row places them in another matrix. */
  ignoredDirectories: string[];
  aggregate?: { path: string; sha256: string };
  experiment: WorkspaceContinuationSummary['sourceExperiment'];
}

const text = (row: Record<string, unknown> | undefined, key: string): string | undefined =>
  (row !== undefined && typeof row[key] === 'string' ? row[key] as string : undefined);
const integer = (row: Record<string, unknown> | undefined, key: string): number | undefined =>
  (row !== undefined && typeof row[key] === 'number' ? row[key] as number : undefined);

interface SourceAggregate {
  packID?: string; packVersion?: string; packDigest?: string;
  identity?: { matrixAdmission?: { matrixLabel?: string }; candidates?: { provider?: string; requestedModelID?: string; effort?: string }[] };
  execution?: { plannedRunCount?: number; notExecutedCells?: { candidate?: string; caseID?: string; repeatIndex?: number; disposition?: string }[] };
  cells?: { repeatsPlanned?: number }[];
}

/**
 * Read a source matrix — its records and, when present, its aggregate — without writing anything.
 *
 * WHAT DEFINES THE SOURCE'S PLAN. A matrix seals no plan file of its own, so the design is rebuilt from
 * what it did seal: the candidates named by its aggregate (which lists every route, including one that
 * produced no record) and by its rows, times the pack's cases, times the repeat count every row carries.
 * The aggregate's own planned count is then checked against that product, and a disagreement refuses.
 * Without an aggregate, a route that produced no record at all cannot be known, and the summary says so.
 */
export function readWorkspaceContinuationSource(input: {
  campaignRoot: string;
  label: string;
  pack: WorkspaceBenchmarkPack;
  cases: WorkspaceCase[];
  /** Defaults to `<campaignRoot>/aggregates/<label>.json` when that file exists. */
  aggregatePath?: string;
}): WorkspaceContinuationSource {
  const { campaignRoot, label, pack } = input;
  if (!fs.existsSync(workspaceRecordRoot(campaignRoot))) {
    throw new WorkspaceContinuationError('sourceNotFound',
      `there is no workspace record directory under ${campaignRoot}, so there is no matrix '${label}' to continue.`);
  }
  const packCases = resolveWorkspacePack(pack, input.cases);
  const packDigest = workspacePackDigest(pack, input.cases);
  const caseIDs = packCases.map((entry) => entry.id);

  const defaultAggregate = path.join(campaignRoot, 'aggregates', `${label}.json`);
  const aggregatePath = input.aggregatePath ?? (fs.existsSync(defaultAggregate) ? defaultAggregate : undefined);
  let aggregate: SourceAggregate | undefined;
  let aggregateSHA256: string | undefined;
  if (aggregatePath !== undefined) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(aggregatePath);
    } catch (error) {
      throw new WorkspaceContinuationError('sourceAggregateUnreadable',
        `could not read the source aggregate at ${aggregatePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    aggregateSHA256 = sha256Bytes(bytes);
    try {
      aggregate = JSON.parse(bytes.toString('utf8')) as SourceAggregate;
    } catch {
      throw new WorkspaceContinuationError('sourceAggregateUnreadable', `${aggregatePath} is not valid JSON.`);
    }
    const admittedLabel = aggregate.identity?.matrixAdmission?.matrixLabel;
    if (aggregate.packID !== pack.id || aggregate.packVersion !== pack.version || aggregate.packDigest !== packDigest
      || (admittedLabel !== undefined && admittedLabel !== label)) {
      throw new WorkspaceContinuationError('sourceAggregateMismatch',
        `${aggregatePath} describes ${aggregate.packID}@${aggregate.packVersion} (${aggregate.packDigest})`
        + `${admittedLabel === undefined ? '' : ` for matrix '${admittedLabel}'`}, not ${pack.id}@${pack.version} `
        + `(${packDigest}) for '${label}'. A continuation reads the source's own aggregate or none.`);
    }
  }

  // THE RECORDS. A directory whose row places it at a coordinate whose record name is NOT its own name
  // belongs to another matrix whose label happens to share this prefix, and is left alone.
  const records: WorkspaceRecordReadOnly[] = [];
  const rowless: WorkspaceRecordReadOnly[] = [];
  const ignoredDirectories: string[] = [];
  let provider: ProviderID | undefined;
  let effort: EffortLevel | undefined;
  const repeatCounts = new Set<number>();
  const candidates = new Map<string, string>();
  for (const record of readWorkspaceRecordsReadOnly(campaignRoot, label)) {
    const row = record.row;
    if (row === undefined) { rowless.push(record); continue; }
    const modelID = text(row, 'requestedModelID') ?? '';
    const caseID = text(row, 'caseID') ?? '';
    const repeatIndex = integer(row, 'repeatIndex');
    if (repeatIndex === undefined || workspaceMatrixRecordName(label, modelID, caseID, repeatIndex) !== record.name) {
      ignoredDirectories.push(record.recordRoot);
      continue;
    }
    if (text(row, 'packID') !== pack.id || text(row, 'packVersion') !== pack.version || text(row, 'packDigest') !== packDigest) {
      throw new WorkspaceContinuationError('sourcePackMismatch',
        `${record.recordRoot} ran ${text(row, 'packID')}@${text(row, 'packVersion')} (${text(row, 'packDigest')}), and this `
        + `continuation is of ${pack.id}@${pack.version} (${packDigest}). The sealed experiment has changed, or this is `
        + 'another matrix; either way its cells are not these cells.');
    }
    if (text(row, 'continuationSourceDigest') !== undefined) {
      throw new WorkspaceContinuationError('sourceIsContinuation',
        `${record.recordRoot} is itself a continuation record (of '${text(row, 'continuationSourceLabel')}'). Continue from `
        + 'the ORIGINAL matrix and name this one with --prior-continuation-root, so every cell keeps one source.');
    }
    const rowProvider = text(row, 'provider') as ProviderID;
    const rowEffort = (text(row, 'effort') ?? 'none') as EffortLevel;
    if ((provider !== undefined && provider !== rowProvider) || (effort !== undefined && effort !== rowEffort)) {
      throw new WorkspaceContinuationError('sourceInconsistent',
        `the source's records mix ${provider}@${effort} and ${rowProvider}@${rowEffort}. A matrix has one provider and one effort.`);
    }
    provider = rowProvider;
    effort = rowEffort;
    const planned = integer(row, 'repeatsPlanned');
    if (planned !== undefined) repeatCounts.add(planned);
    candidates.set(matrixCandidateName(rowProvider, modelID, rowEffort), modelID);
    records.push(record);
  }
  for (const entry of aggregate?.identity?.candidates ?? []) {
    const entryProvider = entry.provider as ProviderID;
    const entryEffort = (entry.effort ?? 'none') as EffortLevel;
    if ((provider !== undefined && provider !== entryProvider) || (effort !== undefined && effort !== entryEffort)) {
      throw new WorkspaceContinuationError('sourceInconsistent',
        `the source aggregate names ${entryProvider}@${entryEffort} beside records of ${provider}@${effort}.`);
    }
    provider = entryProvider;
    effort = entryEffort;
    candidates.set(matrixCandidateName(entryProvider, entry.requestedModelID ?? '', entryEffort), entry.requestedModelID ?? '');
  }
  for (const cell of aggregate?.cells ?? []) if (typeof cell.repeatsPlanned === 'number') repeatCounts.add(cell.repeatsPlanned);
  if (provider === undefined || effort === undefined || candidates.size === 0) {
    throw new WorkspaceContinuationError('sourceEmpty',
      `no sealed record of matrix '${label}' and no aggregate naming its routes was found under ${campaignRoot}.`);
  }
  if (repeatCounts.size !== 1) {
    throw new WorkspaceContinuationError('sourceInconsistent',
      repeatCounts.size === 0
        ? 'the source records no planned repeat count, so its cells cannot be named by their original repeat.'
        : `the source records more than one planned repeat count (${[...repeatCounts].join(', ')}).`);
  }
  const [repeatsPlanned] = [...repeatCounts];

  // THE DESIGN, in the source's own execution order, and what happened to each cell of it.
  const deferred = new Set((aggregate?.execution?.notExecutedCells ?? [])
    .filter((entry) => entry.disposition === 'providerThrottledBeforeExecution')
    .map((entry) => `${entry.candidate}\u0000${entry.caseID}\u0000${entry.repeatIndex}`));
  const cells: WorkspaceSourceCell[] = [];
  const candidateList = [...candidates.entries()].map(([candidate, modelID]) => ({ candidate, modelID }));
  for (const { candidate, modelID } of candidateList) {
    for (let repeatIndex = 1; repeatIndex <= repeatsPlanned; repeatIndex++) {
      for (const caseID of caseIDs) {
        const recordName = workspaceMatrixRecordName(label, modelID, caseID, repeatIndex);
        const record = records.find((entry) => entry.name === recordName);
        const empty = rowless.find((entry) => entry.name === recordName);
        const key = `${candidate}\u0000${caseID}\u0000${repeatIndex}`;
        if (record !== undefined && deferred.has(key)) {
          throw new WorkspaceContinuationError('sourceInconsistent',
            `${describeWorkspaceCellCoordinate({ candidate, caseID, repeatIndex, repeatsPlanned })} has a sealed record and `
            + 'is also listed by the source aggregate as never executed.');
        }
        const recordRoot = (record ?? empty)?.recordRoot;
        const state: WorkspaceSourceCellState = record?.row !== undefined
          ? (workspaceRunWasProviderDeclined(record.row) ? 'providerThrottledAttempt' : 'completed')
          : empty !== undefined ? 'recordWithoutResult'
            : deferred.has(key) ? 'notExecutedBecauseThrottled' : 'notExecuted';
        cells.push({
          cellID: workspaceMatrixCellID({
            packID: pack.id, packVersion: pack.version, provider, modelID, effort, caseID, repeatIndex, repeatsPlanned,
          }),
          candidate, provider, modelID, effort, caseID, repeatIndex, repeatsPlanned, recordName, state,
          ...(recordRoot === undefined ? {} : { recordRoot }),
          ...(record?.row === undefined ? {} : { status: text(record.row, 'status'), row: record.row }),
        });
      }
    }
  }
  const unplacedRows = records.filter((record) => !cells.some((cell) => cell.recordName === record.name));
  if (unplacedRows.length > 0) {
    throw new WorkspaceContinuationError('sourceInconsistent',
      `${unplacedRows.map((record) => record.recordRoot).join(', ')} ${unplacedRows.length === 1 ? 'is' : 'are'} not a cell of `
      + `the design (${candidateList.length} candidate(s) x ${caseIDs.length} case(s) x ${repeatsPlanned} repeat(s)).`);
  }
  for (const record of rowless) if (!cells.some((cell) => cell.recordName === record.name)) ignoredDirectories.push(record.recordRoot);
  const plannedRunCount = aggregate?.execution?.plannedRunCount;
  if (plannedRunCount !== undefined && plannedRunCount !== cells.length) {
    throw new WorkspaceContinuationError('sourceInconsistent',
      `the source aggregate says ${plannedRunCount} runs were planned, and its routes, cases and repeats make ${cells.length}.`);
  }

  // WHAT THE SOURCE'S EXPERIMENT WAS, from its own sealed records, for the planner's comparability check.
  const experiment: WorkspaceContinuationSource['experiment'] = {
    comparabilityKeys: {}, bindingTimeouts: {}, attemptCeilings: {}, driverIDs: {},
  };
  for (const record of records) {
    const row = record.row!;
    const caseID = text(row, 'caseID')!;
    const candidate = text(row, 'candidate')!;
    const set = <T>(map: Record<string, T>, key: string, value: T | undefined, what: string): void => {
      if (value === undefined) return;
      if (key in map && map[key] !== value) {
        throw new WorkspaceContinuationError('sourceInconsistent',
          `the source's records disagree about ${what} for ${key} (${String(map[key])} and ${String(value)}).`);
      }
      map[key] = value;
    };
    set(experiment.comparabilityKeys, caseID, text(row, 'comparabilityKey'), 'the comparability key');
    set(experiment.attemptCeilings, caseID, integer(row, 'attemptCeilingApplied') ?? null, 'the attempt cap');
    set(experiment.driverIDs, candidate, text(row, 'driverID'), 'the driver');
    set(experiment.bindingTimeouts, candidate, record.bindingTimeoutMilliseconds, 'the binding deadline');
  }

  const digest = 'cmr1:' + digestObject({
    label,
    packID: pack.id,
    packVersion: pack.version,
    packDigest,
    records: [...records, ...rowless].sort((a, b) => (a.name < b.name ? -1 : 1)).map((record) => ({
      name: record.name, manifestSHA256: record.manifestSHA256, resultsSHA256: record.resultsSHA256,
    })),
    aggregateSHA256,
  } as unknown as CanonicalValue);

  return {
    label, campaignRoot: path.resolve(campaignRoot), digest,
    pack: { id: pack.id, version: pack.version, digest: packDigest },
    provider, effort, repeatsPlanned, candidates: candidateList, cells, records: [...records, ...rowless], ignoredDirectories,
    ...(aggregatePath === undefined || aggregateSHA256 === undefined ? {}
      : { aggregate: { path: path.resolve(aggregatePath), sha256: aggregateSHA256 } }),
    experiment,
  };
}

// MARK: - Planning the continuation

const REASON_FOR_STATE: Record<Exclude<WorkspaceSourceCellState, 'completed'>, WorkspaceCellSelectionReason> = {
  providerThrottledAttempt: 'providerThrottledAttempt',
  notExecutedBecauseThrottled: 'notExecutedBecauseThrottled',
  notExecuted: 'notExecuted',
  recordWithoutResult: 'recordWithoutResult',
};

export interface WorkspaceContinuationPlan {
  selection: WorkspaceCellSelection;
  /** In-scope source cells, each with whether it was selected and why not when it was not. */
  inScope: { cell: WorkspaceSourceCell; selected: boolean; excludedBecause?: string }[];
}

/**
 * Derive the cells a continuation will run, as an ordinary cell selection.
 *
 * ONLY WHAT NEVER PRODUCED EVIDENCE IS ELIGIBLE: a deferred cell, a cell the source never executed, a
 * record that never sealed — and, when the operator asks for them, provider-declined attempts. A
 * completed cell — in the source, or in an earlier continuation of the same source — is never eligible,
 * and naming one with `--cells` is REFUSED. There is no override: deliberately re-sampling a completed
 * cell is a new matrix, not a continuation.
 *
 * A PROVIDER-DECLINED ATTEMPT IS HELD BACK BY DEFAULT. It is eligible — it measured nothing about the
 * model — but unlike a deferred cell, something WAS sent for it, and a new attempt is a second request
 * for the same cell. So it runs only when the operator says so: `includeProviderThrottledAttempts`
 * (`--include-throttled-attempts`), or by naming that exact cell with `--cells`. Either way the sealed
 * original stays exactly where it is, and the combined report keeps it as history.
 */
export function planWorkspaceContinuation(source: WorkspaceContinuationSource, request: {
  provider: ProviderID;
  modelIDs: string[];
  effort: EffortLevel;
  /** `--cells`, when given: narrows the eligible set, and must name only eligible cells. */
  explicit?: WorkspaceCellSelector[];
  /** Also select cells whose source attempt the provider declined. Implied for a cell `explicit` names. */
  includeProviderThrottledAttempts?: boolean;
  /** Rows of earlier continuations of this source, read-only. Completed cells in them are excluded too. */
  priorContinuationRows?: WorkspaceRunRow[];
  priorContinuationRoots?: string[];
}): WorkspaceContinuationPlan {
  if (request.provider !== source.provider || request.effort !== source.effort) {
    throw new WorkspaceContinuationError('continuationRouteMismatch',
      `the source ran ${source.provider} at effort ${source.effort}; this continuation asks for ${request.provider} at `
      + `${request.effort}. A continuation runs the source's own routes, or nothing.`);
  }
  const known = new Set(source.candidates.map((entry) => entry.modelID));
  const foreign = request.modelIDs.filter((modelID) => !known.has(modelID));
  if (foreign.length > 0) {
    throw new WorkspaceContinuationError('continuationModelNotInSource',
      `${foreign.join(', ')} ${foreign.length === 1 ? 'was' : 'were'} not in '${source.label}' (it ran `
      + `${[...known].join(', ')}). A continuation cannot add a route the source never planned.`);
  }

  const priorCompleted = new Set((request.priorContinuationRows ?? [])
    .filter(({ row }) => row.continuationSourceDigest === source.digest && !workspaceRunWasProviderDeclined(row))
    .map(({ row }) => String(row.matrixCellID)));

  const inScopeCells = source.cells.filter((cell) => request.modelIDs.includes(cell.modelID));
  const eligible = (cell: WorkspaceSourceCell): string | undefined =>
    cell.state === 'completed' ? `the source completed it (${cell.status ?? 'sealed'}); it is evidence already`
      : priorCompleted.has(cell.cellID) ? 'an earlier continuation of this source already completed it' : undefined;
  const heldBack = (cell: WorkspaceSourceCell): string | undefined =>
    cell.state === 'providerThrottledAttempt' && request.includeProviderThrottledAttempts !== true
      ? 'the source EXECUTED it and the provider declined; a new attempt is a second request for this cell, so it runs '
        + 'only with --include-throttled-attempts or when named with --cells'
      : undefined;

  let chosen: WorkspaceSourceCell[];
  if (request.explicit === undefined) {
    chosen = inScopeCells.filter((cell) => eligible(cell) === undefined && heldBack(cell) === undefined);
  } else {
    chosen = [];
    for (const selector of request.explicit) {
      const targets = inScopeCells.filter((cell) => cell.caseID === selector.caseID && cell.repeatIndex === selector.repeatIndex
        && (selector.modelID === undefined || cell.modelID === selector.modelID));
      if (targets.length === 0) {
        throw new WorkspaceContinuationError('continuationCellNotPlanned',
          `${selector.modelID === undefined ? '' : `${selector.modelID} `}${selector.caseID}@${selector.repeatIndex} is not a cell '${source.label}' `
          + `planned for ${request.modelIDs.join(', ')} (it planned repeats 1 to ${source.repeatsPlanned} of its own cases).`);
      }
      for (const cell of targets) {
        const why = eligible(cell);
        if (why !== undefined) {
          throw new WorkspaceContinuationError('cellAlreadyCompleted',
            `${describeWorkspaceCellCoordinate(cell)} cannot be continued: ${why}. Running it again would be duplicate `
            + 'scoring evidence, and a continuation never produces that. There is no override; a deliberate re-sample is a new matrix.');
        }
        if (!chosen.includes(cell)) chosen.push(cell);
      }
    }
    // Kept in the source's own order, whatever order --cells named them in.
    chosen = inScopeCells.filter((cell) => chosen.includes(cell));
  }

  const byState: Record<string, number> = {};
  for (const cell of source.cells) byState[cell.state] = (byState[cell.state] ?? 0) + 1;
  const summary: WorkspaceContinuationSummary = {
    sourceLabel: source.label,
    sourceRoot: source.campaignRoot,
    sourceDigest: source.digest,
    ...(source.aggregate === undefined ? {} : { sourceAggregatePath: source.aggregate.path, sourceAggregateSHA256: source.aggregate.sha256 }),
    sourcePackDigest: source.pack.digest,
    sourceCandidates: source.candidates.map((entry) => entry.candidate),
    sourceRepeatsPlanned: source.repeatsPlanned,
    sourcePlannedRunCount: source.cells.length,
    sourceRecordCount: source.records.length,
    sourceCellsByState: byState,
    outOfScopeRunCount: source.cells.length - inScopeCells.length,
    completedExcludedCount: inScopeCells.filter((cell) => cell.state === 'completed').length,
    completedByPriorContinuationCount: inScopeCells.filter((cell) => cell.state !== 'completed' && priorCompleted.has(cell.cellID)).length,
    priorContinuationRoots: request.priorContinuationRoots ?? [],
    eligibleRunCount: inScopeCells.filter((cell) => eligible(cell) === undefined).length,
    throttledAttemptsHeldBackCount: request.explicit !== undefined ? 0
      : inScopeCells.filter((cell) => eligible(cell) === undefined && heldBack(cell) !== undefined).length,
    explicitSubset: request.explicit !== undefined,
    sourceExperiment: source.experiment,
    immutability: SOURCE_CAMPAIGN_IS_IMMUTABLE,
  };
  return {
    selection: {
      mode: 'continuation',
      selectors: chosen.map((cell) => ({
        modelID: cell.modelID,
        caseID: cell.caseID,
        repeatIndex: cell.repeatIndex,
        reason: REASON_FOR_STATE[cell.state as Exclude<WorkspaceSourceCellState, 'completed'>],
        ...(cell.recordRoot === undefined ? {} : { source: { recordRoot: cell.recordRoot, ...(cell.status === undefined ? {} : { status: cell.status }) } }),
      })),
      continuation: summary,
    },
    inScope: inScopeCells.map((cell) => ({
      cell,
      selected: chosen.includes(cell),
      ...(chosen.includes(cell) ? {} : {
        excludedBecause: eligible(cell) ?? (request.explicit === undefined ? heldBack(cell) : undefined) ?? 'not named by --cells',
      }),
    })),
  };
}

// MARK: - The combined logical report

/** Where one logical cell's counted evidence came from. */
export type WorkspaceLogicalEvidenceOrigin = 'source' | 'continuation' | 'missing';

export interface WorkspaceLogicalCell {
  cellID: string;
  candidate: string;
  caseID: string;
  repeatIndex: number;
  repeatsPlanned: number;
  sourceState: WorkspaceSourceCellState;
  evidence: WorkspaceLogicalEvidenceOrigin;
  evidenceRecordRoot?: string;
  evidenceStatus?: string;
  /** Runs of this cell that are NOT its evidence and are kept as history: provider declines, in either root. */
  history: { origin: 'source' | 'continuation'; recordRoot: string; status?: string; why: string }[];
  /** Runs of this cell that completed AFTER it already had evidence. Listed, never counted. */
  excluded: { recordRoot: string; status?: string; why: string }[];
}

export interface WorkspaceLogicalReport {
  sourceLabel: string;
  sourceDigest: string;
  continuationLabels: string[];
  cells: WorkspaceLogicalCell[];
  /** Exactly one row per logical cell that has evidence. Feed to `aggregateWorkspaceRuns`. */
  logicalRows: WorkspaceRunRow[];
  counts: {
    plannedCells: number;
    fromSource: number;
    fromContinuation: number;
    missing: number;
    historicalProviderDeclines: number;
    excludedSurplusRuns: number;
    ignoredContinuationRows: number;
  };
  /** Continuation rows that are not of this source, or not of any cell it planned. */
  ignored: { recordRoot: string; why: string }[];
  disclosure: string;
}

export const LOGICAL_REPORT_COUNTS_EACH_CELL_ONCE =
  'One row per planned cell, and only one: the source\'s own sealed run wherever the provider did not decline it, '
  + 'otherwise the FIRST continuation run of that cell the provider did not decline. A declined attempt in either '
  + 'campaign is history, shown beside its cell and never counted; a later run of a cell that already has evidence is '
  + 'listed as excluded and never counted. Neither campaign root is written.';

/**
 * Combine a source matrix with its continuations into the logical matrix the experiment planned.
 *
 * READ-ONLY IN BOTH DIRECTIONS. Nothing is copied, moved or merged on disk; the returned rows point at
 * the records they came from, so every number in a report built from them is one step from its evidence.
 */
export function combineWorkspaceContinuationEvidence(source: WorkspaceContinuationSource,
                                                     continuations: { label: string; rows: WorkspaceRunRow[] }[]): WorkspaceLogicalReport {
  const ignored: WorkspaceLogicalReport['ignored'] = [];
  const byCell = new Map<string, WorkspaceRunRow[]>();
  for (const continuation of continuations) {
    for (const run of continuation.rows) {
      const cellID = typeof run.row.matrixCellID === 'string' ? run.row.matrixCellID : undefined;
      if (run.row.continuationSourceDigest !== source.digest) {
        ignored.push({ recordRoot: run.recordRoot, why: run.row.continuationSourceDigest === undefined
          ? 'not a continuation record' : `a continuation of another source (${String(run.row.continuationSourceDigest)})` });
        continue;
      }
      if (cellID === undefined || !source.cells.some((cell) => cell.cellID === cellID)) {
        ignored.push({ recordRoot: run.recordRoot, why: 'names no cell this source planned' });
        continue;
      }
      byCell.set(cellID, [...(byCell.get(cellID) ?? []), run]);
    }
  }

  const cells: WorkspaceLogicalCell[] = [];
  const logicalRows: WorkspaceRunRow[] = [];
  for (const cell of source.cells) {
    const entry: WorkspaceLogicalCell = {
      cellID: cell.cellID, candidate: cell.candidate, caseID: cell.caseID, repeatIndex: cell.repeatIndex,
      repeatsPlanned: cell.repeatsPlanned, sourceState: cell.state, evidence: 'missing', history: [], excluded: [],
    };
    const later = [...(byCell.get(cell.cellID) ?? [])].sort((a, b) => {
      const at = String(a.row.recordedAt ?? '');
      const bt = String(b.row.recordedAt ?? '');
      return at < bt ? -1 : at > bt ? 1 : (a.recordRoot < b.recordRoot ? -1 : 1);
    });
    if (cell.state === 'completed' && cell.row !== undefined && cell.recordRoot !== undefined) {
      entry.evidence = 'source';
      entry.evidenceRecordRoot = cell.recordRoot;
      entry.evidenceStatus = cell.status;
      logicalRows.push({ recordRoot: cell.recordRoot, row: cell.row });
      for (const run of later) {
        entry.excluded.push({ recordRoot: run.recordRoot, status: text(run.row, 'status'),
          why: 'the source already completed this cell; a continuation run of it is surplus and is not counted' });
      }
    } else {
      if (cell.state === 'providerThrottledAttempt' && cell.recordRoot !== undefined) {
        entry.history.push({ origin: 'source', recordRoot: cell.recordRoot, status: cell.status,
          why: 'the original attempt: the PROVIDER declined it. Historical, kept, never counted as a model outcome' });
      }
      for (const run of later) {
        if (workspaceRunWasProviderDeclined(run.row)) {
          entry.history.push({ origin: 'continuation', recordRoot: run.recordRoot, status: text(run.row, 'status'),
            why: 'a continuation attempt the provider declined. Kept, never counted' });
        } else if (entry.evidence === 'missing') {
          entry.evidence = 'continuation';
          entry.evidenceRecordRoot = run.recordRoot;
          entry.evidenceStatus = text(run.row, 'status');
          logicalRows.push(run);
        } else {
          entry.excluded.push({ recordRoot: run.recordRoot, status: text(run.row, 'status'),
            why: 'this cell already has continuation evidence from an earlier run; a later one is surplus and is not counted' });
        }
      }
    }
    cells.push(entry);
  }
  return {
    sourceLabel: source.label,
    sourceDigest: source.digest,
    continuationLabels: continuations.map((entry) => entry.label),
    cells,
    logicalRows,
    counts: {
      plannedCells: cells.length,
      fromSource: cells.filter((cell) => cell.evidence === 'source').length,
      fromContinuation: cells.filter((cell) => cell.evidence === 'continuation').length,
      missing: cells.filter((cell) => cell.evidence === 'missing').length,
      historicalProviderDeclines: cells.reduce((sum, cell) => sum + cell.history.length, 0),
      excludedSurplusRuns: cells.reduce((sum, cell) => sum + cell.excluded.length, 0),
      ignoredContinuationRows: ignored.length,
    },
    ignored,
    disclosure: LOGICAL_REPORT_COUNTS_EACH_CELL_ONCE,
  };
}

/** A continuation's rows, read-only: every record under its root whose row continues some source. */
export function readWorkspaceContinuationRows(campaignRoot: string, label?: string): WorkspaceRunRow[] {
  return readWorkspaceRecordsReadOnly(campaignRoot, label)
    .filter((record) => record.row !== undefined && typeof record.row.continuationSourceDigest === 'string')
    .map((record) => ({ recordRoot: record.recordRoot, row: record.row! }));
}

/** The logical report, as a person reads it: every cell, where its counted evidence came from, and its history. */
export function describeWorkspaceLogicalReport(report: WorkspaceLogicalReport): string[] {
  const lines: string[] = [];
  lines.push(`source          ${report.sourceLabel} · ${report.sourceDigest}`);
  lines.push(`continuations   ${report.continuationLabels.length === 0 ? 'none' : report.continuationLabels.join(', ')}`);
  lines.push(`logical cells   ${report.counts.plannedCells} planned · ${report.counts.fromSource} from the source · `
    + `${report.counts.fromContinuation} from a continuation · ${report.counts.missing} still missing`);
  lines.push(`history         ${report.counts.historicalProviderDeclines} provider-declined attempt(s), kept and not counted`);
  lines.push(`excluded        ${report.counts.excludedSurplusRuns} surplus run(s), listed and not counted`);
  if (report.counts.ignoredContinuationRows > 0) {
    lines.push(`ignored         ${report.counts.ignoredContinuationRows} row(s) that do not continue this source`);
  }
  lines.push('');
  for (const cell of report.cells) {
    lines.push(`  ${describeWorkspaceCellCoordinate(cell).padEnd(72)} ${cell.evidence.padEnd(12)} ${cell.evidenceStatus ?? '—'}`);
    if (cell.evidenceRecordRoot !== undefined && cell.evidence === 'continuation') {
      lines.push(`    evidence  ${cell.evidenceRecordRoot}`);
    }
    for (const entry of cell.history) lines.push(`    history   ${entry.origin} ${entry.status ?? ''} · ${entry.recordRoot} — ${entry.why}`);
    for (const entry of cell.excluded) lines.push(`    EXCLUDED  ${entry.status ?? ''} · ${entry.recordRoot} — ${entry.why}`);
  }
  for (const entry of report.ignored) lines.push(`  ignored   ${entry.recordRoot} — ${entry.why}`);
  lines.push('');
  lines.push(report.disclosure);
  return lines;
}
