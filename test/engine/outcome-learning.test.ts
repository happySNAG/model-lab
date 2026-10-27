// Outcome learning (col1): the outcomes `cernum ingest-outcomes` sealed, aggregated per model, effort (cek1), ctt1
// task type and machine key into counts, success rate with a Wilson 95% interval, verification pass rate, retries
// and median and p90 duration — evidence class ordra_operational, reported apart from benchmark evidence, held
// back below a minimum sample, and never an input to a qualification verdict.
//
// FIXTURES ONLY. fixtures/outcome-learning holds two exported telemetry files, one per machine; every store is a
// fresh temporary root. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_OUTCOME_MINIMUM_SAMPLE, ORDRA_OPERATIONAL_EVIDENCE, OUTCOMES_ARE_OPERATIONAL_EVIDENCE_ONLY, OutcomeCell, OutcomeLearning,
  deriveOutcomeLearning, operationalEvidenceFor, outcomeEffortKey,
} from '../../src/engine/outcome-learning';
import { RouteOutcome, ingestRouteOutcomeFile, parseRouteTelemetryLine, routeOutcomeRunRows, routeOutcomesFrom } from '../../src/engine/route-outcome-ingest';
import { appendObservations, readObservationStore, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { observationsForRouting } from '../../src/engine/routing-contract';
import { deriveRouteQualification } from '../../src/engine/route-qualification';
import { deriveQualificationHistory } from '../../src/engine/qualification-history';
import { deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { wilsonInterval95Milli } from '../../src/engine/route-recommendation-crr2';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPOSITORY, 'fixtures', 'outcome-learning');
const STUDIO_FILE = path.join(FIXTURES, 'ordra-outcomes-studio.jsonl');
const LAPTOP_FILE = path.join(FIXTURES, 'ordra-outcomes-laptop.jsonl');
const STUDIO = 'cmk1:studio';
const LAPTOP = 'cmk1:laptop';
const NOW = new Date('2026-10-26T12:00:00Z');
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const CODEX = 'codexCLI:gpt-5-codex';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-outcome-learning-'));
  temporaries.push(directory);
  return directory;
}

/** A store holding both fixture files, each under its own machine. */
function seeded(): string {
  const root = temporary();
  ingestRouteOutcomeFile(root, STUDIO_FILE, { machineKey: STUDIO, machineLabel: 'studio', now: NOW });
  ingestRouteOutcomeFile(root, LAPTOP_FILE, { machineKey: LAPTOP, machineLabel: 'laptop', now: NOW });
  return root;
}

const files = (root: string): string[] => fs.readdirSync(root, { recursive: true }).map(String).sort();
const cell = (learning: OutcomeLearning, effortRouteKey: string, machineKey: string): OutcomeCell =>
  learning.cells.find((entry) => entry.effort.effortRouteKey === effortRouteKey && entry.machineKey === machineKey)!;

// ------------------------------------------------------------------ the optional cro1 fields

describe('the cro1 line carries task type and effort only when sent', () => {
  const base = {
    pass: 'P-1', attempt: 1, provider: 'claudeCLI', requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5',
    verification: 'passed', tokens: 10, durationMilliseconds: 1000, recordedAt: '2026-10-20T10:00:00Z',
  };

  it('seals a line without them to exactly the body it always did', () => {
    const parsed = parseRouteTelemetryLine(JSON.stringify(base));
    expect(parsed.ok).toBe(true);
    const outcome = (parsed as { outcome: RouteOutcome }).outcome;
    expect(Object.keys(outcome).sort()).toEqual(['actualModel', 'attempt', 'durationMilliseconds', 'findings', 'identity', 'pass',
      'provider', 'recordedAt', 'requestedModel', 'routeKey', 'rule', 'tokens', 'verification']);
  });

  it('reads them when sent, and refuses a value outside ctt1 or the effort ladder', () => {
    expect(parseRouteTelemetryLine(JSON.stringify({ ...base, taskType: 'fix', requestedEffort: 'high', appliedEffort: null })))
      .toMatchObject({ ok: true, outcome: { taskType: 'fix', requestedEffort: 'high', appliedEffort: null } });
    const refused = parseRouteTelemetryLine(JSON.stringify({ ...base, taskType: 'bugfix', requestedEffort: 'turbo', appliedEffort: 7 }));
    expect(refused.ok).toBe(false);
    const reasons = (refused as { reasons: string[] }).reasons.join('\n');
    for (const field of ['taskType', 'requestedEffort', 'appliedEffort']) expect(reasons).toContain(field);
  });

  it('keys an outcome by the applied effort only when the session reported one', () => {
    const outcome = (over: Record<string, unknown>) =>
      (parseRouteTelemetryLine(JSON.stringify({ ...base, ...over })) as { outcome: Parameters<typeof outcomeEffortKey>[0] }).outcome;
    expect(outcomeEffortKey(outcome({ requestedEffort: 'high', appliedEffort: 'medium' }))).toEqual({ state: 'observed', effort: 'medium' });
    expect(outcomeEffortKey(outcome({ requestedEffort: 'high', appliedEffort: null }))).toEqual({ state: 'unobservable', requestedEffort: 'high' });
    expect(outcomeEffortKey(outcome({}))).toEqual({ state: 'unobservable', requestedEffort: 'unrecorded' });
  });
});

// ------------------------------------------------------------------ the aggregation

describe('deriveOutcomeLearning', () => {
  it('aggregates per model, effort, task type and machine key, labelled ordra_operational', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    expect(learning).toMatchObject({ schema: 'col1', evidenceClass: ORDRA_OPERATIONAL_EVIDENCE, taxonomyVersion: 'ctt1',
      query: { taskType: 'any', machineKey: 'any' }, minimumSampleSize: DEFAULT_OUTCOME_MINIMUM_SAMPLE, outcomesRead: 19,
      disclosure: OUTCOMES_ARE_OPERATIONAL_EVIDENCE_ONLY });
    expect(DEFAULT_OUTCOME_MINIMUM_SAMPLE).toBe(5);
    expect(learning.cells.map((entry) => [entry.effort.effortRouteKey, entry.taskType, entry.machineKey, entry.sampleSize, entry.status]))
      .toEqual([
        [`${HAIKU}@high`, 'fix', STUDIO, 2, 'insufficient'],
        [`${HAIKU}@unobservable:high`, 'fix', LAPTOP, 3, 'insufficient'],
        [`${HAIKU}@unobservable:high`, 'fix', STUDIO, 6, 'sufficient'],
        [`${CODEX}@unobservable:medium`, 'implement', STUDIO, 5, 'sufficient'],
      ]);
    for (const entry of learning.cells) expect(entry.evidenceClass).toBe('ordra_operational');
  });

  it('reports counts, retries, success rate with its Wilson 95% interval, verification pass rate and duration', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    const haiku = cell(learning, `${HAIKU}@unobservable:high`, STUDIO);
    expect(haiku.counts).toEqual({ outcomes: 6, passed: 4, failed: 1, notRun: 1, retries: 1 });
    expect(haiku.influence).toBe('shownBesideQualification');
    // Success is passed over every outcome; verification pass rate is passed over passed + failed.
    expect(haiku.successRateMilli.value).toBe(667);
    expect(haiku.verificationPassRateMilli.value).toBe(800);
    const interval = wilsonInterval95Milli(4, 6)!;
    expect(haiku.interval95).toMatchObject({ method: 'wilson', z: 1.96,
      lowerMilli: { value: interval.lowerMilli }, upperMilli: { value: interval.upperMilli } });
    expect(interval.lowerMilli).toBeLessThan(667);
    expect(interval.upperMilli).toBeGreaterThan(667);
    // Nearest-rank over the five recorded durations; the retry recorded none and is counted missing.
    expect(haiku.durationMilliseconds).toMatchObject({ count: 5, missing: 1, median: { value: 30000 }, p90: { value: 50000 } });
    expect(haiku.evidenceWindow).toEqual({ from: '2026-10-20T09:00:00Z', to: '2026-10-20T14:00:00Z' });
    expect(haiku.recordIDs).toHaveLength(6);

    const codex = cell(learning, `${CODEX}@unobservable:medium`, STUDIO);
    expect(codex.counts).toEqual({ outcomes: 5, passed: 5, failed: 0, notRun: 0, retries: 0 });
    expect(codex.successRateMilli.value).toBe(1000);
    // Five of five: the Wilson lower bound is n / (n + z²), floored.
    expect(codex.interval95.lowerMilli.value).toBe(565);
    expect(codex.interval95.upperMilli.value).toBe(1000);
    expect(codex.durationMilliseconds).toMatchObject({ median: { value: 63000 }, p90: { value: 65000 } });
  });

  it('never pools an observed effort with an unobservable one, or one machine with another', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    const observed = cell(learning, `${HAIKU}@high`, STUDIO);
    expect(observed.effort).toEqual({ effortRouteKey: `${HAIKU}@high`, state: 'observed', effort: 'high', requestedEffort: 'high' });
    expect(cell(learning, `${HAIKU}@unobservable:high`, STUDIO).effort).toEqual({
      effortRouteKey: `${HAIKU}@unobservable:high`, state: 'unobservable', requestedEffort: 'high' });
    expect(cell(learning, `${HAIKU}@unobservable:high`, LAPTOP).counts.outcomes).toBe(3);
  });

  it('holds back a cell below the minimum sample: counts only, nothing derived, no influence', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    const small = cell(learning, `${HAIKU}@unobservable:high`, LAPTOP);
    expect(small).toMatchObject({ status: 'insufficient', influence: 'none', sampleSize: 3, minimumSampleSize: 5,
      counts: { outcomes: 3, passed: 2, failed: 1 } });
    for (const quantity of [small.successRateMilli, small.interval95.lowerMilli, small.interval95.upperMilli,
      small.verificationPassRateMilli, small.durationMilliseconds.median, small.durationMilliseconds.p90]) {
      expect(quantity.provenance).toBe('unavailable');
      expect(quantity.value).toBeUndefined();
      expect(quantity.note).toContain('minimum sample size of 5');
    }
    // A stated, lower minimum makes the same cell sufficient, and the answer says which minimum it used.
    const lowered = deriveOutcomeLearning(readObservationStore(seeded()), { minimumSampleSize: 3 });
    expect(lowered.minimumSampleSize).toBe(3);
    expect(cell(lowered, `${HAIKU}@unobservable:high`, LAPTOP)).toMatchObject({ status: 'sufficient', successRateMilli: { value: 667 } });
    expect(() => deriveOutcomeLearning(readObservationStore(seeded()), { minimumSampleSize: 0 })).toThrow(/minimum sample size/);
  });

  it('excludes substituted, unreported and untyped outcomes, each with its reason, and credits none of them', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    expect(learning.excluded.map((entry) => [entry.pass, entry.routeKey, entry.reasonCode])).toEqual([
      ['P-8303', HAIKU, 'noTaskType'], ['P-8301', 'claudeCLI:claude-sonnet-5', 'substituted'], ['P-8302', CODEX, 'unreported']]);
    expect(learning.cells.some((entry) => entry.routeKey === 'claudeCLI:claude-sonnet-5')).toBe(false);
    const inCells = learning.cells.reduce((sum, entry) => sum + entry.sampleSize, 0);
    expect(inCells + learning.excluded.length).toBe(learning.outcomesRead);
  });

  it('filters by task type and machine key, and refuses a task type outside ctt1', () => {
    const contents = readObservationStore(seeded());
    const fix = deriveOutcomeLearning(contents, { taskType: 'fix', machineKey: STUDIO });
    expect(fix.query).toEqual({ taskType: 'fix', machineKey: STUDIO });
    expect(fix.cells.map((entry) => entry.effort.effortRouteKey)).toEqual([`${HAIKU}@high`, `${HAIKU}@unobservable:high`]);
    expect(fix.cells.every((entry) => entry.taskType === 'fix' && entry.machineKey === STUDIO)).toBe(true);
    expect(deriveOutcomeLearning(contents, { machineKey: LAPTOP }).cells).toHaveLength(1);
    expect(() => deriveOutcomeLearning(contents, { taskType: 'bugfix' as never })).toThrow(/not a ctt1 task type/);
  });

  it('writes nothing', () => {
    const root = seeded();
    const before = files(root);
    deriveOutcomeLearning(readObservationStore(root));
    expect(files(root)).toEqual(before);
  });
});

// ------------------------------------------------------------------ beside qualification, never inside it

const CASES = [{ id: 'case-a', dimensions: ['multiFileEditing'] }] as unknown as WorkspaceCase[];
/** Sealed benchmark runs of HAIKU: the only evidence a verdict reads. */
const SEALED = ['pass', 'pass', 'fail'].map((status, index) => ({
  recordRoot: `/fixture/haiku/${index}`,
  row: { provider: 'claudeCLI', requestedModelID: 'claude-haiku-4-5', caseID: 'case-a', status,
    wallClockMilliseconds: 1000, recordedAt: `2026-10-1${index}T10:00:00Z` },
}));

describe('operational evidence stays apart from benchmark evidence and never changes a verdict', () => {
  it('offers only sufficient cells to be shown beside qualification evidence', () => {
    const learning = deriveOutcomeLearning(readObservationStore(seeded()));
    const beside = operationalEvidenceFor(learning, { routeKey: HAIKU, taskType: 'fix', machineKey: STUDIO });
    expect(beside.evidenceClass).toBe('ordra_operational');
    expect(beside.cells.map((entry) => entry.effort.effortRouteKey)).toEqual([`${HAIKU}@unobservable:high`]);
    expect(beside.insufficientCellCount).toBe(1);
    expect(operationalEvidenceFor(learning, { routeKey: HAIKU, taskType: 'fix', machineKey: LAPTOP }))
      .toMatchObject({ cells: [], insufficientCellCount: 1 });
    expect(operationalEvidenceFor(learning, { routeKey: HAIKU, effortRouteKey: `${HAIKU}@high`, taskType: 'fix', machineKey: STUDIO }))
      .toMatchObject({ cells: [], insufficientCellCount: 1 });
  });

  it('leaves the qualification verdict and timeline exactly as they were, however many outcomes are learned from', () => {
    const root = temporary();
    appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: STUDIO, machineLabel: 'studio',
      observedAt: '2026-10-19T10:00:00Z', available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
    { origin: 'observedHere', receivedAt: '2026-10-19T10:00:00Z' });
    const verdict = () => deriveRouteQualification({ provider: 'claudeCLI', modelID: 'claude-haiku-4-5', machineKey: STUDIO,
      availability: observationsForRouting(readObservationStore(root)), workspaceRows: SEALED, workspaceCases: CASES, now: NOW });
    const timeline = () => deriveQualificationHistory({ routeKey: HAIKU, machineKey: STUDIO, contents: readObservationStore(root),
      workspaceRows: SEALED, workspaceCases: CASES });
    const before = { verdict: verdict(), timeline: timeline() };

    ingestRouteOutcomeFile(root, STUDIO_FILE, { machineKey: STUDIO, machineLabel: 'studio', now: NOW });
    const learning = deriveOutcomeLearning(readObservationStore(root), { minimumSampleSize: 1 });
    expect(learning.cells.filter((entry) => entry.routeKey === HAIKU && entry.status === 'sufficient').length).toBeGreaterThan(0);
    expect(verdict()).toEqual(before.verdict);
    expect(timeline()).toEqual(before.timeline);
  });

  it('reads no benchmark run, and the benchmark rollup of sealed runs is unchanged by it', () => {
    const contents = readObservationStore(seeded());
    const rollup = deriveMetricsRollup({ workspaceRows: SEALED, workspaceCases: CASES });
    deriveOutcomeLearning(contents);
    expect(deriveMetricsRollup({ workspaceRows: SEALED, workspaceCases: CASES })).toEqual(rollup);
    // The outcomes reach the rollup only through cro1's own run rows, unchanged by this module.
    expect(routeOutcomeRunRows(contents).every((entry) => entry.recordRoot.startsWith('routeOutcome:'))).toBe(true);
    expect(routeOutcomesFrom(contents)).toHaveLength(19);
  });

  it('is imported by no verdict, contract or ranking, and contacts nothing', () => {
    for (const file of ['route-qualification.ts', 'qualification-history.ts', 'routing-contract.ts', 'route-recommendation.ts',
      'route-recommendation-crr2.ts', 'fallback-chain.ts', 'effort-keyed-routes.ts', 'metrics-rollup.ts']) {
      const source = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', file), 'utf8');
      expect(source).not.toMatch(/outcome-learning|deriveOutcomeLearning|operationalEvidenceFor/);
    }
    const source = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', 'outcome-learning.ts'), 'utf8');
    expect(source).not.toMatch(/from '(node:)?(child_process|http|https|net|fs)'|fetch\(|spawn\(|-adapter'|-driver'/);
    // It reads no sealed benchmark run and calls no verdict.
    expect(source).not.toMatch(/from '\.\/(route-qualification|qualification-history|workspace-aggregate|metrics-rollup)'/);
    expect(source).not.toMatch(/deriveRouteQualification\(|WorkspaceRunRow/);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

function cernum(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('cernum outcomes --json [--task <type>] [--machine <key>]', () => {
  it('is declared read-only with --json, --task, --machine and --minimum-sample', () => {
    const spec = commandSpec('outcomes')!;
    expect(spec.effect).toBe('readOnly');
    expect(acceptedOptions(spec).map((option) => option.name))
      .toEqual(expect.arrayContaining(['json', 'task', 'machine', 'minimum-sample', 'root']));
  });

  it('answers the aggregation as JSON, filtered, and writes nothing', async () => {
    const root = seeded();
    const before = files(root);
    const result = await cernum('outcomes', '--json', '--task', 'fix', '--machine', STUDIO, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as OutcomeLearning;
    expect(answer).toEqual(deriveOutcomeLearning(readObservationStore(root), { taskType: 'fix', machineKey: STUDIO }));
    expect(answer.minimumSampleSize).toBe(5);
    expect(files(root)).toEqual(before);
  });

  it('refuses a task type outside ctt1, and a bad minimum sample, with exit 2', async () => {
    const root = seeded();
    const task = await cernum('outcomes', '--json', '--task', 'bugfix', '--root', root);
    expect(task.status).toBe(2);
    expect(task.stderr).toContain('not a ctt1 task type');
    expect(task.stdout).toBe('');
    const minimum = await cernum('outcomes', '--json', '--minimum-sample', '0', '--root', root);
    expect(minimum.status).toBe(2);
    expect(minimum.stderr).toContain('--minimum-sample');
  });
});
