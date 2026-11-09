// Benchmark engine · a rotated held-out partition of a pack's cases, and how exposed each case already is (R-22).
//
// WHAT THIS IS. Fixture leakage is a case a model has already been run on: once its tree, its failing
// test and its sealed commands have been sent to a provider, a later pass on the same case is weaker
// evidence that the model generalises. This module gives two reporting tools for that.
//
//   deriveHeldOutPartition(cases, { epoch, heldOutCount }) ranks the given cases by
//   sha256(`${caseDigest}:${epoch}`) and puts the `heldOutCount` lowest-ranked cases in `heldOut` and
//   every other case in `exposed`. The same cases and the same epoch always give the same partition;
//   a new epoch re-ranks every case, so the held-out set rotates without anyone choosing it by hand.
//   The rank binds the case DIGEST (`cwc1:`), so a case whose meaning changes is re-ranked with it.
//
//   caseExposure(rows, partition) counts the run rows per `caseDigest` (the field every workspace run
//   row carries, `workspace-execution.ts`) and flags each held-out case that already appears in them.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT ENFORCED. Qualification (cqp1) does not consult a partition. A held-out case that is exposed is
//   reported, never refused, never excluded from evidence and never used to change a verdict.
//   NOT A CHANGE TO ANY CASE, PACK OR DIGEST. Both functions are pure: they read the ids and digests
//   they are given and the rows they are given, and they write, install and route nothing.
//   NOT A CHOICE. `heldOutCount` and `epoch` have no default; both are explicit, reviewable inputs.
//
// COUNTED means every row whose `caseDigest` is a non-empty string, whatever its status: a run that
// measured no model work may still have sent the case to a provider, and over-reporting exposure is
// the safe direction for a leakage check. Rows without a `caseDigest` are counted apart as
// `undigestedRows`; rows whose digest names no case in the partition are counted as `unmatchedRows`.

import { compareCodePoints, sha256Text } from './canonical';
import { WorkspaceCase, workspaceCaseDigest } from './workspace-case';
import { WorkspaceRunRow } from './workspace-aggregate';

export const HELD_OUT_ROTATION_SCHEMA = 'cho1';

export const HELD_OUT_IS_NOT_ENFORCED =
  'A held-out partition is reported only. Qualification (cqp1) does not consult it; no case, pack, digest or '
  + 'qualification input changes; an exposed held-out case is flagged, never excluded or refused.';

/** What the partition reads of a case: its id and its `cwc1:` digest. Nothing else. */
export interface HeldOutCaseInput {
  id: string;
  caseDigest: string;
}

export interface HeldOutPartitionOptions {
  /** The rotation epoch. A non-empty string or a non-negative integer; it has no default. */
  epoch: string | number;
  /** How many cases are held out. At least 1 and fewer than the number of cases; it has no default. */
  heldOutCount: number;
}

export interface HeldOutPartitionCase {
  id: string;
  caseDigest: string;
  /** sha256(`${caseDigest}:${epoch}`), lowercase hex. Lower ranks are held out first. */
  rankKey: string;
  part: 'heldOut' | 'exposed';
}

export interface HeldOutPartition {
  schema: typeof HELD_OUT_ROTATION_SCHEMA;
  epoch: string;
  heldOutCount: number;
  /** Held-out case ids, sorted by code point. */
  heldOut: string[];
  /** Every other case id, sorted by code point. */
  exposed: string[];
  /** Every case in rank order (rankKey, then id). */
  cases: HeldOutPartitionCase[];
}

export interface CaseExposureEntry {
  caseID: string;
  caseDigest: string;
  part: 'heldOut' | 'exposed';
  /** Run rows whose `caseDigest` is this case's digest. */
  runs: number;
  /** True only for a held-out case with at least one run row: the held-out case has leaked. */
  heldOutExposed: boolean;
}

export interface CaseExposureReport {
  schema: typeof HELD_OUT_ROTATION_SCHEMA;
  epoch: string;
  /** Run rows per `caseDigest`, over every digested row (including digests no case in the partition carries). */
  runsByCaseDigest: Record<string, number>;
  /** One entry per partition case, in the partition's rank order. */
  cases: CaseExposureEntry[];
  /** Ids of held-out cases already present in the rows, sorted by code point. */
  exposedHeldOut: string[];
  /** Rows whose `caseDigest` names no case in the partition. */
  unmatchedRows: number;
  /** Rows with no string `caseDigest`. */
  undigestedRows: number;
}

/** The partition input for a registered case: its id and `workspaceCaseDigest`. Reads, changes nothing. */
export function heldOutCaseInput(workspaceCase: WorkspaceCase): HeldOutCaseInput {
  return { id: workspaceCase.id, caseDigest: workspaceCaseDigest(workspaceCase) };
}

function epochText(epoch: unknown): string {
  if (typeof epoch === 'string' && epoch !== '') return epoch;
  if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) return String(epoch);
  throw new Error(`held-out rotation: epoch must be a non-empty string or a non-negative integer, got ${JSON.stringify(epoch)}`);
}

/**
 * Split `cases` into held-out and exposed by sha256(`${caseDigest}:${epoch}`).
 *
 * REFUSES, with a thrown error: a `heldOutCount` that is not an integer, is below 1, or is at or above
 * the number of cases (a partition with nothing exposed, or nothing held out, is not a partition); an
 * epoch that is empty, negative or fractional; a case with an empty id or digest; and two cases sharing
 * an id or a digest (exposure is matched by digest, so a shared digest would be ambiguous).
 */
export function deriveHeldOutPartition(cases: readonly HeldOutCaseInput[], options: HeldOutPartitionOptions): HeldOutPartition {
  const epoch = epochText(options?.epoch);
  const heldOutCount = options?.heldOutCount;
  if (typeof heldOutCount !== 'number' || !Number.isInteger(heldOutCount)) {
    throw new Error(`held-out rotation: heldOutCount must be an integer, got ${JSON.stringify(heldOutCount)}`);
  }
  if (heldOutCount < 1) {
    throw new Error(`held-out rotation: heldOutCount must be at least 1, got ${heldOutCount}`);
  }
  if (heldOutCount >= cases.length) {
    throw new Error(`held-out rotation: heldOutCount ${heldOutCount} must be fewer than the ${cases.length} cases given`);
  }
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const entry of cases) {
    if (typeof entry.id !== 'string' || entry.id === '') throw new Error('held-out rotation: a case has an empty id');
    if (typeof entry.caseDigest !== 'string' || entry.caseDigest === '') {
      throw new Error(`held-out rotation: case ${entry.id} has an empty caseDigest`);
    }
    if (ids.has(entry.id)) throw new Error(`held-out rotation: case id ${entry.id} appears twice`);
    if (digests.has(entry.caseDigest)) throw new Error(`held-out rotation: caseDigest ${entry.caseDigest} appears twice`);
    ids.add(entry.id);
    digests.add(entry.caseDigest);
  }

  const ranked = cases
    .map((entry) => ({ id: entry.id, caseDigest: entry.caseDigest, rankKey: sha256Text(`${entry.caseDigest}:${epoch}`) }))
    .sort((a, b) => compareCodePoints(a.rankKey, b.rankKey) || compareCodePoints(a.id, b.id));
  const partitioned: HeldOutPartitionCase[] = ranked.map((entry, index) => ({
    ...entry, part: index < heldOutCount ? 'heldOut' : 'exposed',
  }));
  const idsOf = (part: HeldOutPartitionCase['part']) =>
    partitioned.filter((entry) => entry.part === part).map((entry) => entry.id).sort(compareCodePoints);

  return {
    schema: HELD_OUT_ROTATION_SCHEMA,
    epoch,
    heldOutCount,
    heldOut: idsOf('heldOut'),
    exposed: idsOf('exposed'),
    cases: partitioned,
  };
}

/**
 * Count run rows per `caseDigest` and flag every held-out case that already appears in them.
 *
 * Pure: reads `row.caseDigest` of each row and the partition, and nothing else. It decides nothing.
 */
export function caseExposure(rows: readonly Pick<WorkspaceRunRow, 'row'>[], partition: HeldOutPartition): CaseExposureReport {
  const runsByCaseDigest: Record<string, number> = {};
  let undigestedRows = 0;
  for (const { row } of rows) {
    const digest = row?.caseDigest;
    if (typeof digest !== 'string' || digest === '') {
      undigestedRows += 1;
      continue;
    }
    runsByCaseDigest[digest] = (runsByCaseDigest[digest] ?? 0) + 1;
  }

  const known = new Set(partition.cases.map((entry) => entry.caseDigest));
  const unmatchedRows = Object.entries(runsByCaseDigest)
    .filter(([digest]) => !known.has(digest))
    .reduce((sum, [, count]) => sum + count, 0);

  const cases: CaseExposureEntry[] = partition.cases.map((entry) => {
    const runs = runsByCaseDigest[entry.caseDigest] ?? 0;
    return { caseID: entry.id, caseDigest: entry.caseDigest, part: entry.part, runs, heldOutExposed: entry.part === 'heldOut' && runs > 0 };
  });

  const sortedCounts: Record<string, number> = {};
  for (const digest of Object.keys(runsByCaseDigest).sort(compareCodePoints)) sortedCounts[digest] = runsByCaseDigest[digest]!;

  return {
    schema: HELD_OUT_ROTATION_SCHEMA,
    epoch: partition.epoch,
    runsByCaseDigest: sortedCounts,
    cases,
    exposedHeldOut: cases.filter((entry) => entry.heldOutExposed).map((entry) => entry.caseID).sort(compareCodePoints),
    unmatchedRows,
    undigestedRows,
  };
}
