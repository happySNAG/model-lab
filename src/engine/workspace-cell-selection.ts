// Benchmark engine · MATRIX CELL IDENTITY and EXACT CELL SELECTION: the primitive every partial
// matrix — an operator's hand-picked cells, or a continuation of a matrix a provider stopped — is
// compiled down to.
//
// WHY THIS EXISTS. `workspace-benchmark` ran `pack × repeats × models` and nothing smaller. When the
// first Codex discriminator matrix was stopped by a provider usage limit with nine cells never run,
// there was no supported way to run exactly those nine: re-running the same label collides with the
// sealed records (every one a harness fault) and would overwrite the telemetry beside them, and a
// fresh full matrix would duplicate eighteen runs that had already been scored. The honest answer is
// a way to name cells, not a way to repeat matrices.
//
// ONE PRIMITIVE, TWO WAYS IN. An operator can name cells directly (`--cells`), or Cernum can derive
// them from a source campaign (`--continue-from`, see `workspace-continuation.ts`). Both produce the
// SAME `WorkspaceCellSelection`, and `buildWorkspaceMatrixPlan` is the only thing that applies one.
// There is no second executor: a selected matrix is an ordinary plan whose cell list is shorter.
//
// A CELL IS A COORDINATE, NOT A RUN. `cmc1:` names "this pack, this route, this case, repeat r of n"
// — the logical slot in an experiment's design. Two runs of the same coordinate (an attempt a
// provider throttled, and the continuation that later completed it) share a cell id and are
// different runs; that is exactly how a combined report can tell history from evidence without
// double counting either. THE ORIGINAL REPEAT NUMBER IS PART OF THE COORDINATE and is never remapped:
// selecting repeat 3 of 3 produces a record that says repeat 3 of 3.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, digestObject } from './canonical';
import { EffortLevel, ProviderID } from './provider';

export class WorkspaceCellSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceCellSelectionError';
  }
}

// MARK: - Record naming

/** The one slug every workspace record directory name is built from. */
export const workspaceRecordSlug = (value: string): string =>
  value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

/**
 * The directory name of one matrix run: label, model, case and WHICH SAMPLE.
 *
 * Shared by the planner (which decides it) and the continuation reader (which checks a source
 * record is the record of the coordinate its row claims), so the two can never disagree about it.
 */
export function workspaceMatrixRecordName(runLabel: string, modelID: string, caseID: string, repeatIndex: number): string {
  return [workspaceRecordSlug(runLabel), workspaceRecordSlug(modelID), workspaceRecordSlug(caseID), `r${repeatIndex}`]
    .filter((part) => part.length > 0).join('-');
}

// MARK: - Cell identity

/** Every dimension of the plan a cell is a point in. Nothing about any run of it. */
export interface WorkspaceMatrixCellCoordinate {
  packID: string;
  packVersion: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  caseID: string;
  /** The ORIGINAL repeat index. Never renumbered by a selection or a continuation. */
  repeatIndex: number;
  /** How many repeats the experiment planned. Part of the identity: repeat 3 of 3 is not repeat 3 of 5. */
  repeatsPlanned: number;
}

/** `cmc1:` — the stable identity of one logical cell of a matrix design. */
export function workspaceMatrixCellID(coordinate: WorkspaceMatrixCellCoordinate): string {
  return 'cmc1:' + digestObject({
    packID: coordinate.packID,
    packVersion: coordinate.packVersion,
    provider: coordinate.provider,
    modelID: coordinate.modelID,
    effort: coordinate.effort,
    caseID: coordinate.caseID,
    repeatIndex: coordinate.repeatIndex,
    repeatsPlanned: coordinate.repeatsPlanned,
  });
}

/** One cell, as a person reads it. */
export function describeWorkspaceCellCoordinate(cell: {
  candidate: string; caseID: string; repeatIndex: number; repeatsPlanned: number;
}): string {
  return `${cell.candidate} · ${cell.caseID} · repeat ${cell.repeatIndex}/${cell.repeatsPlanned}`;
}

// MARK: - What a selection is

/**
 * Why a cell is in a selection. Recorded on the plan and on every record the cell produces.
 *
 *   operatorSelected             named by the operator with --cells, with no source campaign.
 *   notExecutedBecauseThrottled  the source matrix planned it and its throttle breaker DEFERRED it:
 *                                nothing was ever sent for it.
 *   providerThrottledAttempt     the source matrix EXECUTED it and the provider declined; the sealed
 *                                historical record stays where it is, and this is a new attempt.
 *   notExecuted                  the source matrix planned it and produced no record of it, for a
 *                                reason other than a throttle (cancelled, refused, measurement lost).
 *   recordWithoutResult          the source has a record directory for it with no terminal row — a
 *                                run that faulted or was interrupted before it sealed.
 */
export type WorkspaceCellSelectionReason =
  | 'operatorSelected'
  | 'notExecutedBecauseThrottled'
  | 'providerThrottledAttempt'
  | 'notExecuted'
  | 'recordWithoutResult';

export const WORKSPACE_CELL_SELECTION_REASONS: WorkspaceCellSelectionReason[] = [
  'operatorSelected', 'notExecutedBecauseThrottled', 'providerThrottledAttempt', 'notExecuted', 'recordWithoutResult',
];

/** What the source campaign says about one cell a continuation selected. Absent for an explicit selection. */
export interface WorkspaceCellSourceEvidence {
  /** The source record this attempt follows, when there is one (a throttled attempt, a faulted record). */
  recordRoot?: string;
  /** Its sealed status, when it has one. Historical, and never rewritten. */
  status?: string;
}

/** One requested cell. `modelID` absent means "this case and repeat, for every model in --models". */
export interface WorkspaceCellSelector {
  modelID?: string;
  caseID: string;
  repeatIndex: number;
  /** Supplied by a continuation. An explicit selector is `operatorSelected`. */
  reason?: WorkspaceCellSelectionReason;
  source?: WorkspaceCellSourceEvidence;
}

/**
 * What a continuation read from its source, carried on the plan so the dry run can print it and the
 * aggregate can record it. Built by `workspace-continuation.ts`; described, never interpreted, here.
 */
export interface WorkspaceContinuationSummary {
  sourceLabel: string;
  sourceRoot: string;
  /** `cmr1:` over every source record's sealed bytes and the source aggregate's, read-only. */
  sourceDigest: string;
  sourceAggregatePath?: string;
  sourceAggregateSHA256?: string;
  sourcePackDigest: string;
  sourceCandidates: string[];
  sourceRepeatsPlanned: number;
  /** The whole source design: every candidate x case x repeat it planned. */
  sourcePlannedRunCount: number;
  sourceRecordCount: number;
  /** Every source cell by what the source says happened to it. Over the whole design, not just this route. */
  sourceCellsByState: Record<string, number>;
  /** Source cells on routes this continuation was not asked to run. Never selected. */
  outOfScopeRunCount: number;
  /** In-scope cells the source completed. Excluded, and never re-run. */
  completedExcludedCount: number;
  /** In-scope cells an earlier continuation of the same source already completed. Also excluded. */
  completedByPriorContinuationCount: number;
  priorContinuationRoots: string[];
  /** In-scope cells eligible to run, before any explicit --cells narrowing. Includes held-back attempts. */
  eligibleRunCount: number;
  /**
   * Eligible cells whose source attempt the provider declined and which were NOT selected because the
   * operator did not ask for them (`--include-throttled-attempts`, or naming them with `--cells`).
   */
  throttledAttemptsHeldBackCount: number;
  /** Whether --cells narrowed the eligible set. */
  explicitSubset: boolean;
  /**
   * What the source's sealed records say its experiment WAS, so the planner can refuse a continuation
   * that would run the same cells under different conditions. Each map holds only what the source
   * actually recorded; a key the source has no record for constrains nothing.
   */
  sourceExperiment: {
    /** `cwk1:` per case, from the source rows. */
    comparabilityKeys: Record<string, string>;
    /** The binding's per-attempt deadline per candidate, from the source manifests. */
    bindingTimeouts: Record<string, number>;
    /** The operator attempt cap per case (`null`: none applied), from the source rows. */
    attemptCeilings: Record<string, number | null>;
    /** The workspace driver per candidate, from the source rows. */
    driverIDs: Record<string, string>;
  };
  immutability: string;
}

/** The operator's (or the continuation planner's) request to run only some cells of a matrix. */
export interface WorkspaceCellSelection {
  mode: 'explicit' | 'continuation';
  selectors: WorkspaceCellSelector[];
  /** Present exactly in continuation mode. */
  continuation?: WorkspaceContinuationSummary;
}

/**
 * The provenance one selected cell's record carries: which cell, which selection, why, and from
 * which source. Written to the ledger meta before the request, and to the row and record after it.
 */
export interface WorkspaceCellSelectionStamp {
  matrixCellID: string;
  cellSelectionMode: 'explicit' | 'continuation';
  cellSelectionReason: WorkspaceCellSelectionReason;
  /** `cms1:` of the whole selection this record was one cell of. */
  cellSelectionDigest: string;
  continuationSourceLabel?: string;
  continuationSourceDigest?: string;
  continuationSourceRoot?: string;
  continuationSourceRecordRoot?: string;
  continuationSourceStatus?: string;
}

/** The selection a plan was built under, as the dry run prints it and the aggregate records it. */
export interface WorkspaceMatrixPlanSelection {
  mode: 'explicit' | 'continuation';
  selectionDigest: string;
  /** The runs the same matrix would have had with no selection. */
  fullPlanRunCount: number;
  selectedRunCount: number;
  cells: {
    cellID: string;
    candidate: string;
    modelID: string;
    caseID: string;
    repeatIndex: number;
    repeatsPlanned: number;
    reason: WorkspaceCellSelectionReason;
    sourceRecordRoot?: string;
    sourceStatus?: string;
  }[];
  continuation?: WorkspaceContinuationSummary;
  disclosure: string;
}

export const CELL_SELECTION_IS_NOT_A_NEW_EXPERIMENT =
  'A selected matrix runs a SUBSET of one sealed experiment\'s cells, each at its original coordinate: the same pack '
  + 'digest, the same route, the same case and the same repeat number of the same planned count. It is not a smaller '
  + 'experiment, and its rows are comparable with the rest of that experiment\'s cells only because nothing about a '
  + 'cell changes when it is selected.';

export const SOURCE_CAMPAIGN_IS_IMMUTABLE =
  'The source campaign is read and never written: no record, ledger, aggregate or telemetry file under its root is '
  + 'opened for writing, a torn or corrupt source ledger is refused rather than repaired, and every continuation '
  + 'record is sealed under a different label in a different campaign root.';

/** `cms1:` — binds a record, an admission and an aggregate to exactly this set of cells and this source. */
export function workspaceCellSelectionDigest(input: {
  mode: 'explicit' | 'continuation';
  packID: string;
  packVersion: string;
  packDigest: string;
  provider: ProviderID;
  effort: EffortLevel;
  continuation?: { sourceLabel: string; sourceDigest: string };
  cells: { cellID: string; reason: WorkspaceCellSelectionReason }[];
}): string {
  return 'cms1:' + digestObject({
    mode: input.mode,
    packID: input.packID,
    packVersion: input.packVersion,
    packDigest: input.packDigest,
    provider: input.provider,
    effort: input.effort,
    continuation: input.continuation === undefined ? undefined
      : { sourceLabel: input.continuation.sourceLabel, sourceDigest: input.continuation.sourceDigest },
    cells: [...input.cells].sort((a, b) => (a.cellID < b.cellID ? -1 : a.cellID > b.cellID ? 1 : 0))
      .map((cell) => ({ cellID: cell.cellID, reason: cell.reason })),
  } as unknown as CanonicalValue);
}

/** The row, record and ledger-meta fields a selected cell's record carries. Empty for an unselected matrix. */
export function cellSelectionFieldsOf(stamp: WorkspaceCellSelectionStamp | undefined): Partial<WorkspaceCellSelectionStamp> {
  if (stamp === undefined) return {};
  return { ...stamp };
}

// MARK: - Parsing the operator's selector

/**
 * Parse `--cells`: a comma-separated list of `<case-id>@<repeat>`.
 *
 * UNAMBIGUOUS BY CONSTRUCTION, NOT BY CONVENTION. A token is split at its LAST `@`, the part after it
 * must be a whole number, and the part before it must EQUAL one of the pack's own case ids — it is
 * matched, never pattern-guessed. A pack whose case ids contain `,` or `@` cannot be addressed this
 * way at all, and is refused with a pointer to `--cells-file`, where every field is its own JSON value.
 */
export function parseWorkspaceCellList(text: string, packCaseIDs: string[]): WorkspaceCellSelector[] {
  const unsafe = packCaseIDs.filter((id) => id.includes(',') || id.includes('@'));
  if (unsafe.length > 0) {
    throw new WorkspaceCellSelectionError('cellListAmbiguous',
      `this pack has case id(s) containing ',' or '@' (${unsafe.join(', ')}), so an inline --cells list cannot name `
      + 'them unambiguously. Use --cells-file, which names every field as its own JSON value.');
  }
  const tokens = text.split(',').map((token) => token.trim());
  if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
    throw new WorkspaceCellSelectionError('cellSelectionEmpty', '--cells named no cell.');
  }
  return tokens.map((token) => {
    if (token.length === 0) {
      throw new WorkspaceCellSelectionError('cellListMalformed',
        `--cells has an empty entry in '${text}'. Every entry is <case-id>@<repeat>, separated by commas.`);
    }
    const at = token.lastIndexOf('@');
    if (at <= 0 || at === token.length - 1) {
      throw new WorkspaceCellSelectionError('cellListMalformed',
        `'${token}' is not <case-id>@<repeat>. Name the case and the ORIGINAL repeat number, like `
        + `${packCaseIDs[0] ?? 'ws.case'}@2.`);
    }
    const caseID = token.slice(0, at);
    const repeatText = token.slice(at + 1);
    if (!/^\d+$/.test(repeatText) || Number(repeatText) < 1) {
      throw new WorkspaceCellSelectionError('cellListMalformed',
        `'${token}': '${repeatText}' is not a repeat number. Repeats are counted from 1.`);
    }
    if (!packCaseIDs.includes(caseID)) {
      throw new WorkspaceCellSelectionError('cellSelectionUnknownCase',
        `'${caseID}' is not a case of this pack. Its cases are: ${packCaseIDs.join(', ')}.`);
    }
    return { caseID, repeatIndex: Number(repeatText) };
  });
}

/**
 * Parse `--cells-file`: `{ "cells": [ { "caseID": "...", "repeatIndex": 2, "modelID": "..." } ] }`.
 *
 * `modelID` is optional and, when present, narrows that entry to one model of --models. Every other
 * key is refused, so a misspelt field is a stop rather than a silently wider selection.
 */
export function parseWorkspaceCellSelectionFile(text: string): WorkspaceCellSelector[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceCellSelectionError('cellFileUnreadable',
      `the cell selection file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cells = (parsed as { cells?: unknown } | null)?.cells;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(cells)) {
    throw new WorkspaceCellSelectionError('cellFileUnreadable',
      'the cell selection file must be a JSON object with a "cells" array.');
  }
  const extraTop = Object.keys(parsed as object).filter((key) => key !== 'cells');
  if (extraTop.length > 0) {
    throw new WorkspaceCellSelectionError('cellFileUnreadable',
      `the cell selection file has unknown key(s) ${extraTop.join(', ')}; it takes only "cells".`);
  }
  if (cells.length === 0) throw new WorkspaceCellSelectionError('cellSelectionEmpty', 'the cell selection file names no cell.');
  return cells.map((entry, index) => {
    const at = `cells[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new WorkspaceCellSelectionError('cellFileUnreadable', `${at} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !['caseID', 'repeatIndex', 'modelID'].includes(key));
    if (unknown.length > 0) {
      throw new WorkspaceCellSelectionError('cellFileUnreadable',
        `${at} has unknown key(s) ${unknown.join(', ')}; a cell is caseID, repeatIndex and optionally modelID.`);
    }
    if (typeof record.caseID !== 'string' || record.caseID.length === 0) {
      throw new WorkspaceCellSelectionError('cellFileUnreadable', `${at}.caseID must be a non-empty string.`);
    }
    if (typeof record.repeatIndex !== 'number' || !Number.isInteger(record.repeatIndex) || record.repeatIndex < 1) {
      throw new WorkspaceCellSelectionError('cellFileUnreadable', `${at}.repeatIndex must be a whole number from 1.`);
    }
    if (record.modelID !== undefined && (typeof record.modelID !== 'string' || record.modelID.length === 0)) {
      throw new WorkspaceCellSelectionError('cellFileUnreadable', `${at}.modelID, when given, must be a non-empty string.`);
    }
    return {
      caseID: record.caseID,
      repeatIndex: record.repeatIndex,
      ...(record.modelID === undefined ? {} : { modelID: record.modelID as string }),
    };
  });
}

/** `--cells` as the operator would retype it, for the "re-run without --dry-run" line. */
export function renderWorkspaceCellList(selectors: WorkspaceCellSelector[]): string {
  return selectors.map((selector) => `${selector.caseID}@${selector.repeatIndex}`).join(',');
}

/** The one path comparison every "is this the same root" check uses. */
export function sameCampaignRoot(a: string, b: string): boolean {
  const real = (value: string): string => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  return real(a) === real(b);
}
