// Effort comparison (cec1): one model's pass rates between pairs of OBSERVED efforts, with 95% Wilson
// intervals and a separated / noSeparation / insufficient verdict.
//
// FIXTURES ONLY. Every row is an in-memory object; no driver runs, no file is written and no provider is
// contacted. The pure function is also checked to leave a temporary root under os.tmpdir() unchanged.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EFFORT_COMPARISON_SCHEMA, compareEfforts,
} from '../../src/engine/effort-comparison';
import { rowEffortKey } from '../../src/engine/effort-keyed-routes';
import { wilsonInterval95Milli } from '../../src/engine/route-recommendation-crr2';
import { WorkspaceRunRow } from '../../src/engine/workspace-aggregate';

const PROVIDER = 'codexCLI' as const;
const MODEL = 'gpt-test';

/** A run at an OBSERVED applied effort (measured by telemetry). */
function observedRow(effort: string, status: string, extra: Record<string, unknown> = {}): WorkspaceRunRow {
  return { recordRoot: '/nowhere', row: {
    provider: PROVIDER, requestedModelID: MODEL, requestedEffort: effort, status,
    appliedEffort: effort, appliedEffortVerdict: 'appliedEffortVerified', appliedEffortEvidenceSource: 'fixture telemetry', ...extra,
  } };
}

/** A run whose effort was requested but never measured. */
function unobservedRow(requested: string | undefined, status: string, modelID = MODEL): WorkspaceRunRow {
  return { recordRoot: '/nowhere', row: {
    provider: PROVIDER, requestedModelID: modelID, status, ...(requested === undefined ? {} : { requestedEffort: requested }),
  } };
}

function runs(effort: string, passes: number, failures: number): WorkspaceRunRow[] {
  return [
    ...Array.from({ length: passes }, () => observedRow(effort, 'pass')),
    ...Array.from({ length: failures }, () => observedRow(effort, 'fail')),
  ];
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('compareEfforts (cec1)', () => {
  it('(a) given rows at two efforts, counts and intervals equal wilsonInterval95Milli\'s', () => {
    const rows = [...runs('low', 3, 5), ...runs('high', 7, 1),
      observedRow('high', 'runtimeError')];
    const report = compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 5 });
    expect(report.schema).toBe(EFFORT_COMPARISON_SCHEMA);
    expect(report.efforts.map((e) => e.effort)).toEqual(['low', 'high']);
    const [low, high] = report.efforts;
    expect(low).toMatchObject({ runs: 8, passes: 3, unscored: 0, passRateMilli: 375 });
    expect(high).toMatchObject({ runs: 8, passes: 7, unscored: 1, passRateMilli: 875 });
    expect(low.interval95).toEqual(wilsonInterval95Milli(3, 8));
    expect(high.interval95).toEqual(wilsonInterval95Milli(7, 8));
    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0].a).toEqual(low);
    expect(report.comparisons[0].b).toEqual(high);
  });

  it('(b) overlapping intervals give noSeparation and disjoint ones separated', () => {
    const overlap = compareEfforts([...runs('low', 5, 5), ...runs('high', 6, 4)], PROVIDER, MODEL, { minimumRuns: 5 });
    const lo = wilsonInterval95Milli(5, 10)!;
    const hi = wilsonInterval95Milli(6, 10)!;
    expect(lo.upperMilli >= hi.lowerMilli && hi.upperMilli >= lo.lowerMilli).toBe(true);
    expect(overlap.comparisons[0].verdict).toBe('noSeparation');
    expect(overlap.comparisons[0].higherPassRateEffort).toBeUndefined();

    const disjoint = compareEfforts([...runs('low', 0, 20), ...runs('high', 20, 0)], PROVIDER, MODEL, { minimumRuns: 5 });
    const dLow = wilsonInterval95Milli(0, 20)!;
    const dHigh = wilsonInterval95Milli(20, 20)!;
    expect(dLow.upperMilli < dHigh.lowerMilli).toBe(true);
    expect(disjoint.comparisons[0].verdict).toBe('separated');
    expect(disjoint.comparisons[0].higherPassRateEffort).toBe('high');

    // Three efforts give every pair, in EFFORT_LEVELS order.
    const three = compareEfforts([...runs('max', 20, 0), ...runs('low', 0, 20), ...runs('medium', 10, 10)], PROVIDER, MODEL, { minimumRuns: 5 });
    expect(three.comparisons.map((c) => [c.a.effort, c.b.effort])).toEqual([['low', 'medium'], ['low', 'max'], ['medium', 'max']]);
  });

  it('(c) an unobservable key is listed apart, never compared', () => {
    const rows = [...runs('low', 2, 8), ...runs('high', 8, 2),
      unobservedRow('high', 'pass'), unobservedRow('high', 'pass'), unobservedRow('high', 'fail'),
      unobservedRow('max', 'pass'), unobservedRow(undefined, 'fail'),
      // An unmeasured verdict with an appliedEffort is still unobservable.
      { recordRoot: '/nowhere', row: { provider: PROVIDER, requestedModelID: MODEL, requestedEffort: 'low', status: 'pass',
        appliedEffort: 'low', appliedEffortVerdict: 'appliedEffortUnavailable' } }];
    const report = compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 3 });
    expect(report.efforts.map((e) => e.effort)).toEqual(['low', 'high']);
    expect(report.efforts.find((e) => e.effort === 'high')).toMatchObject({ runs: 10, passes: 8 });
    expect(report.efforts.find((e) => e.effort === 'low')).toMatchObject({ runs: 10, passes: 2 });
    expect(report.unobservable.map((u) => u.effortKey)).toEqual(['unobservable:low', 'unobservable:high', 'unobservable:max', 'unobservable:unrecorded']);
    expect(report.unobservable.find((u) => u.effortKey === 'unobservable:high')).toMatchObject({ runs: 3, passes: 2, requestedEffort: 'high' });
    expect(report.comparisons).toHaveLength(1);
    for (const comparison of report.comparisons) {
      expect(JSON.stringify([comparison.a, comparison.b])).not.toContain('unobservable');
    }

    // Only unobservable rows: nothing observed, nothing compared.
    const none = compareEfforts([unobservedRow('high', 'pass'), unobservedRow('low', 'fail')], PROVIDER, MODEL, { minimumRuns: 1 });
    expect(none.efforts).toEqual([]);
    expect(none.comparisons).toEqual([]);
    expect(none.unobservable).toHaveLength(2);
  });

  it('(d) below minimumRuns the verdict is insufficient', () => {
    const rows = [...runs('low', 0, 20), ...runs('high', 4, 0)];
    const report = compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 5 });
    expect(report.comparisons[0].verdict).toBe('insufficient');
    expect(report.comparisons[0].reason).toContain('high has 4 scored run(s)');
    // Unscored rows do not count toward the minimum.
    const padded = compareEfforts([...rows, observedRow('high', 'envelopeFailure')], PROVIDER, MODEL, { minimumRuns: 5 });
    expect(padded.comparisons[0].verdict).toBe('insufficient');
    // The same samples at a lower explicit minimum are compared.
    expect(compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 4 }).comparisons[0].verdict).not.toBe('insufficient');
    // minimumRuns is explicit: missing or invalid values are refused.
    expect(() => compareEfforts(rows, PROVIDER, MODEL, {} as { minimumRuns: number })).toThrow(/minimumRuns/);
    expect(() => compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 0 })).toThrow(/minimumRuns/);
    expect(() => compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 2.5 })).toThrow(/minimumRuns/);
  });

  it('(e) a model name containing an effort word yields no effort', () => {
    const named = 'gpt-test-high';
    const rows = [unobservedRow(undefined, 'pass', named), unobservedRow(undefined, 'fail', named),
      { recordRoot: '/nowhere', row: { provider: PROVIDER, requestedModelID: named, candidate: `${PROVIDER}:${named}`, status: 'pass' } }];
    for (const { row } of rows) expect(rowEffortKey(row).key).toEqual({ state: 'unobservable', requestedEffort: 'unrecorded' });
    const report = compareEfforts(rows, PROVIDER, named, { minimumRuns: 1 });
    expect(report.efforts).toEqual([]);
    expect(report.comparisons).toEqual([]);
    expect(report.unobservable).toEqual([expect.objectContaining({ effortKey: 'unobservable:unrecorded', runs: 3, passes: 2 })]);
  });

  it('ignores other routes and writes nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-cec1-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'marker.txt'), 'unchanged');
    const before = fs.readdirSync(root);
    const rows = [...runs('low', 3, 3), ...runs('high', 3, 3),
      { recordRoot: root, row: { ...observedRow('max', 'pass').row, requestedModelID: 'other-model' } },
      { recordRoot: root, row: { ...observedRow('max', 'pass').row, provider: 'claudeCLI' } }];
    const frozen = JSON.stringify(rows);
    const report = compareEfforts(rows, PROVIDER, MODEL, { minimumRuns: 3 });
    expect(report.efforts.map((e) => e.effort)).toEqual(['low', 'high']);
    expect(JSON.stringify(rows)).toBe(frozen);
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.readFileSync(path.join(root, 'marker.txt'), 'utf8')).toBe('unchanged');
  });
});
