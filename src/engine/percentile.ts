// Benchmark engine · THE ONE PERCENTILE RULE: nearest rank, over values that were actually recorded.
//
// THE DEFINITION. For n recorded values sorted ascending and a percentile p in (0, 100], the p-th
// percentile is the value at 1-based rank ceil(p / 100 × n). So:
//
//   median (p50)  of [10, 20, 30, 40]  is rank ceil(2.0) = 2  → 20
//   p90           of [10, 20, 30, 40]  is rank ceil(3.6) = 4  → 40
//   p90           of ten values        is rank 9
//   any p         of one value         is that value
//
// WHY NEAREST RANK. Every answer is a value some run really recorded. An interpolated median of 1 000 ms
// and 2 000 ms is 1 500 ms, a wall clock no run took; nearest rank never reports a number that is not
// in the evidence. The cost is that an even-sized median is the lower middle value, not the midpoint,
// and that is the documented behaviour, not a rounding accident.
//
// NOTHING IS INVENTED FOR NOTHING. No values gives `undefined`, never 0: a percentile of no evidence
// does not exist. A value that is not a finite number is refused rather than sorted somewhere.

export class PercentileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PercentileError';
  }
}

/** The p-th percentile of `values` by nearest rank, or `undefined` when there are no values. */
export function nearestRankPercentile(values: readonly number[], p: number): number | undefined {
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new PercentileError(`a nearest-rank percentile needs p in (0, 100], not ${p}`);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new PercentileError('a percentile is taken over finite recorded numbers only');
  }
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  // The small tolerance keeps p × n from landing one rank high through floating point: 90 × 10 / 100
  // must be exactly rank 9, and is.
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100 - 1e-9));
  return sorted[rank - 1];
}

/** The nearest-rank median: the 50th percentile. The lower middle value of an even-sized set. */
export function nearestRankMedian(values: readonly number[]): number | undefined {
  return nearestRankPercentile(values, 50);
}
