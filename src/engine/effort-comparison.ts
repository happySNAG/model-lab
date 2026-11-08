// Benchmark engine · how one model's pass rate differs between the efforts it was observed at (R-59).
//
// WHAT THIS IS. Given scored workspace run rows, one provider and one model, this groups the model's
// runs by OBSERVED effort — the key `rowEffortKey` (`effort-keyed-routes.ts`) gives a row — and, for
// every pair of observed efforts, reports each side's runs, passes, pass rate and 95% Wilson interval
// (the existing `wilsonInterval95Milli`, `route-recommendation-crr2.ts`), with one verdict:
//
//   either side has fewer than `minimumRuns` scored runs (or no interval) → insufficient
//   otherwise, the two intervals are disjoint                            → separated
//   otherwise                                                            → noSeparation
//
// `minimumRuns` has NO default: the sample a caller is willing to compare on is an explicit, reviewable
// input, never a constant buried here.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT POOLED. A row whose effort key is unobservable is listed apart, under `unobservable`, keyed by
//   what was asked (`unobservable:<requested>`), and is never added to an observed effort's counts and
//   never compared with anything. A requested effort that was accepted is not an observed effort.
//   NOT INFERRED. No effort is read from a model name, a candidate label or a default. A model called
//   `…-high` whose runs measured no applied effort has no observed effort at all.
//   NOT ROUTING. It changes no route, no qualification record and no policy, and it writes nothing. It
//   is a pure function of the rows it is given.
//
// SCORED means what every quality rate's denominator means (`workspace-aggregate.ts`): a run whose
// status is in STATUSES_THAT_MEASURED_NO_WORK measured no model work and is counted as `unscored`, not
// as a failure. A PASS is `status === 'pass'`.

import { EFFORT_LEVELS, EffortLevel, ProviderID } from './provider';
import { EFFORT_UNOBSERVABLE, RequestedEffort, effortKeySuffix, rowEffortKey } from './effort-keyed-routes';
import { wilsonInterval95Milli } from './route-recommendation-crr2';
import { STATUSES_THAT_MEASURED_NO_WORK, WorkspaceRunRow } from './workspace-aggregate';

export const EFFORT_COMPARISON_SCHEMA = 'cec1';

export type EffortComparisonVerdict = 'separated' | 'noSeparation' | 'insufficient';

export const EFFORT_COMPARISON_IS_NOT_ROUTING =
  'An effort comparison reports how pass rates differ between OBSERVED efforts of one model. Unobservable runs are '
  + 'listed apart and never pooled or compared; no effort is read from a model name; nothing here changes routing.';

/** One effort's scored sample. `passRateMilli` and `interval95` are absent when nothing was scored. */
export interface EffortSample {
  runs: number;
  passes: number;
  /** Rows of this key that measured no model work (STATUSES_THAT_MEASURED_NO_WORK). Not in `runs`. */
  unscored: number;
  passRateMilli?: number;
  interval95?: { lowerMilli: number; upperMilli: number };
}

export interface ObservedEffortSample extends EffortSample {
  effort: EffortLevel;
}

export interface UnobservableEffortSample extends EffortSample {
  /** `unobservable:<requested>` — the key's suffix, never an effort. */
  effortKey: string;
  requestedEffort: RequestedEffort;
}

export interface EffortPairComparison {
  /** The lower effort in EFFORT_LEVELS order. */
  a: ObservedEffortSample;
  /** The higher effort in EFFORT_LEVELS order. */
  b: ObservedEffortSample;
  verdict: EffortComparisonVerdict;
  /** Set only when `separated`: the effort whose interval lies wholly above the other's. */
  higherPassRateEffort?: EffortLevel;
  reason: string;
}

export interface EffortComparisonReport {
  schema: typeof EFFORT_COMPARISON_SCHEMA;
  provider: ProviderID;
  modelID: string;
  minimumRuns: number;
  /** Observed efforts in EFFORT_LEVELS order. */
  efforts: ObservedEffortSample[];
  /** Every pair of observed efforts, (lower, higher), in EFFORT_LEVELS order. */
  comparisons: EffortPairComparison[];
  /** Unobservable keys, listed apart, in EFFORT_LEVELS order of the requested effort, `unrecorded` last. */
  unobservable: UnobservableEffortSample[];
  disclosure: string;
}

interface Tally { runs: number; passes: number; unscored: number }

function sampleOf(tally: Tally): EffortSample {
  const interval = wilsonInterval95Milli(tally.passes, tally.runs);
  return {
    runs: tally.runs, passes: tally.passes, unscored: tally.unscored,
    ...(tally.runs > 0 ? { passRateMilli: Math.round((tally.passes * 1000) / tally.runs) } : {}),
    ...(interval === undefined ? {} : { interval95: interval }),
  };
}

function tallyRow(tally: Tally, row: Record<string, unknown>): void {
  if (STATUSES_THAT_MEASURED_NO_WORK.includes(String(row.status))) { tally.unscored += 1; return; }
  tally.runs += 1;
  if (row.status === 'pass') tally.passes += 1;
}

function comparePair(a: ObservedEffortSample, b: ObservedEffortSample, minimumRuns: number): EffortPairComparison {
  const short = [a, b].filter((side) => side.runs < minimumRuns || side.interval95 === undefined);
  if (short.length > 0) {
    return { a, b, verdict: 'insufficient',
      reason: short.map((side) => `${side.effort} has ${side.runs} scored run(s), fewer than the minimum of ${minimumRuns}`).join('; ') };
  }
  const ia = a.interval95!;
  const ib = b.interval95!;
  if (ia.upperMilli < ib.lowerMilli || ib.upperMilli < ia.lowerMilli) {
    const higher = ia.lowerMilli > ib.upperMilli ? a.effort : b.effort;
    return { a, b, verdict: 'separated', higherPassRateEffort: higher,
      reason: `the 95% Wilson intervals [${ia.lowerMilli}, ${ia.upperMilli}] and [${ib.lowerMilli}, ${ib.upperMilli}] are disjoint` };
  }
  return { a, b, verdict: 'noSeparation',
    reason: `the 95% Wilson intervals [${ia.lowerMilli}, ${ia.upperMilli}] and [${ib.lowerMilli}, ${ib.upperMilli}] overlap` };
}

const requestedRank = (requested: RequestedEffort): number =>
  (requested === 'unrecorded' ? EFFORT_LEVELS.length : EFFORT_LEVELS.indexOf(requested));

/**
 * Compare one model's pass rates between every pair of its observed efforts. Pure: reads `rows`, writes nothing.
 * Rows of any other provider or model (`row.provider`, `row.requestedModelID`) are ignored.
 */
export function compareEfforts(
  rows: WorkspaceRunRow[], provider: ProviderID, modelID: string, options: { minimumRuns: number },
): EffortComparisonReport {
  const minimumRuns = options?.minimumRuns;
  if (!Number.isInteger(minimumRuns) || minimumRuns < 1) {
    throw new Error(`compareEfforts needs an explicit minimumRuns, a whole number of at least 1; got ${String(minimumRuns)}.`);
  }
  const observed = new Map<EffortLevel, Tally>();
  const unobservable = new Map<string, { requestedEffort: RequestedEffort; tally: Tally }>();
  for (const { row } of rows) {
    if (row.provider !== provider || row.requestedModelID !== modelID) continue;
    const { key } = rowEffortKey(row);
    if (key.state === 'observed') {
      const tally = observed.get(key.effort) ?? { runs: 0, passes: 0, unscored: 0 };
      observed.set(key.effort, tally);
      tallyRow(tally, row);
    } else {
      const suffix = effortKeySuffix(key);
      const entry = unobservable.get(suffix) ?? { requestedEffort: key.requestedEffort, tally: { runs: 0, passes: 0, unscored: 0 } };
      unobservable.set(suffix, entry);
      tallyRow(entry.tally, row);
    }
  }

  const efforts: ObservedEffortSample[] = EFFORT_LEVELS
    .filter((effort) => observed.has(effort))
    .map((effort) => ({ effort, ...sampleOf(observed.get(effort)!) }));
  const comparisons: EffortPairComparison[] = [];
  for (let i = 0; i < efforts.length; i += 1) {
    for (let j = i + 1; j < efforts.length; j += 1) comparisons.push(comparePair(efforts[i], efforts[j], minimumRuns));
  }
  const unobservableSamples: UnobservableEffortSample[] = [...unobservable.entries()]
    .sort(([, x], [, y]) => requestedRank(x.requestedEffort) - requestedRank(y.requestedEffort))
    .map(([effortKey, entry]) => ({ effortKey, requestedEffort: entry.requestedEffort, ...sampleOf(entry.tally) }));

  return {
    schema: EFFORT_COMPARISON_SCHEMA, provider, modelID, minimumRuns,
    efforts, comparisons, unobservable: unobservableSamples,
    disclosure: EFFORT_COMPARISON_IS_NOT_ROUTING,
  };
}

/** True for a key suffix that names no observed effort — the only kind listed under `unobservable`. */
export function isUnobservableSuffix(suffix: string): boolean {
  return suffix.startsWith(`${EFFORT_UNOBSERVABLE}:`);
}
