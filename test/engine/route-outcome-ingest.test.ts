// Outcome feedback (cro1): an exported Ordra route-telemetry file — pass, attempt, requested model, the model the
// session's reported usage names, verification, tokens, duration — ingested into the observation store as sealed
// observations, idempotently. A requested model that differs from the reported one is a substitution finding; a
// malformed or duplicate line is quarantined with its reason, never dropped. Outcomes feed the metrics rollup and
// never a qualification verdict.
//
// FIXTURES ONLY. The telemetry file is fixtures/route-outcomes/ordra-route-telemetry.jsonl; every store is a fresh
// temporary root. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ROUTE_OUTCOMES_NEVER_DECIDE_A_VERDICT, RouteOutcome, RouteOutcomeIngestResult, RouteOutcomeQuarantine,
  ingestRouteOutcomeFile, ingestRouteOutcomes, parseRouteTelemetryLine, routeOutcomeQuarantinesFrom, routeOutcomeRunRows,
  routeOutcomesFrom,
} from '../../src/engine/route-outcome-ingest';
import {
  OBSERVATION_KINDS, appendObservations, readObservationStore, routeAvailabilityObservation, verifyObservationRecord,
} from '../../src/engine/observation-store';
import { observationsForRouting } from '../../src/engine/routing-contract';
import { deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { deriveRouteQualification } from '../../src/engine/route-qualification';
import { deriveQualificationHistory } from '../../src/engine/qualification-history';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURE = path.join(REPOSITORY, 'fixtures', 'route-outcomes', 'ordra-route-telemetry.jsonl');
const HERE = 'cmk1:outcome-machine';
const LABEL = 'fixture-host';
const NOW = new Date('2026-10-26T12:00:00Z');
const LATER = new Date('2026-10-27T12:00:00Z');
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const SONNET = 'claudeCLI:claude-sonnet-5';
const CODEX = 'codexCLI:gpt-5-codex';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-outcomes-'));
  temporaries.push(directory);
  return directory;
}

const ingest = (root: string, now = NOW): RouteOutcomeIngestResult =>
  ingestRouteOutcomeFile(root, FIXTURE, { machineKey: HERE, machineLabel: LABEL, now });
const files = (root: string): string[] => fs.readdirSync(root, { recursive: true }).map(String).sort();
const line = (over: Record<string, unknown> = {}): string => JSON.stringify({
  pass: 'P-1', attempt: 1, provider: 'claudeCLI', requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5',
  verification: 'passed', tokens: 10, durationMilliseconds: 1000, recordedAt: '2026-10-20T10:00:00Z', ...over,
});

// ------------------------------------------------------------------ one line

describe('parseRouteTelemetryLine', () => {
  it('reads every field, and names the identity from the requested and reported models by exact string', () => {
    const matched = parseRouteTelemetryLine(line());
    expect(matched).toMatchObject({ ok: true, outcome: { pass: 'P-1', attempt: 1, routeKey: HAIKU, identity: 'matched',
      verification: 'passed', tokens: 10, durationMilliseconds: 1000, findings: [] } });
    const swapped = parseRouteTelemetryLine(line({ requestedModel: 'claude-sonnet-5' }));
    expect(swapped).toMatchObject({ ok: true, outcome: { routeKey: SONNET, identity: 'substituted',
      findings: [{ kind: 'substitution', requestedModel: 'claude-sonnet-5', actualModel: 'claude-haiku-4-5' }] } });
    // A dated alias is still a different string: a finding, never assumed to be the same model.
    expect(parseRouteTelemetryLine(line({ actualModel: 'claude-haiku-4-5-20251001' }))).toMatchObject({ ok: true, outcome: { identity: 'substituted' } });
    expect(parseRouteTelemetryLine(line({ actualModel: null, tokens: null, durationMilliseconds: undefined })))
      .toMatchObject({ ok: true, outcome: { identity: 'unreported', actualModel: null, tokens: null, durationMilliseconds: null, findings: [] } });
  });

  it('refuses a line with every reason it fails, and never infers a provider from a model name', () => {
    const refused = parseRouteTelemetryLine(JSON.stringify({ pass: '', attempt: 0, requestedModel: 'claude-haiku-4-5',
      verification: 'maybe', tokens: -1, durationMilliseconds: 1.5, recordedAt: 'yesterday' }));
    expect(refused.ok).toBe(false);
    const reasons = (refused as { reasons: string[] }).reasons.join('\n');
    for (const field of ['pass', 'attempt', 'provider', 'actualModel', 'verification', 'tokens', 'durationMilliseconds', 'recordedAt']) {
      expect(reasons).toContain(field);
    }
    expect(reasons).toContain('never inferred from a model name');
    expect(parseRouteTelemetryLine('{"pass":')).toMatchObject({ ok: false });
    expect(parseRouteTelemetryLine('[1,2]')).toMatchObject({ ok: false, reasons: [expect.stringContaining('an array')] });
  });
});

// ------------------------------------------------------------------ the file, into the store

describe('ingestRouteOutcomes', () => {
  it('ingests the exported file as sealed routeOutcome observations', () => {
    const root = temporary();
    const result = ingest(root);
    expect(result).toMatchObject({ schema: 'cro1', machineKey: HERE, lineCount: 10, blankLines: 1,
      disclosure: ROUTE_OUTCOMES_NEVER_DECIDE_A_VERDICT });
    expect(result.ingested.map((entry) => entry.line)).toEqual([1, 2, 3, 9, 10]);
    expect(result.alreadyPresent).toEqual([]);

    const contents = readObservationStore(root);
    expect(contents.corrupt).toEqual([]);
    const outcomes = routeOutcomesFrom(contents);
    expect(outcomes).toHaveLength(5);
    for (const { stored } of outcomes) {
      expect(stored.record.kind).toBe('routeOutcome');
      expect(verifyObservationRecord(stored.record).intact).toBe(true);
      expect(stored.record.machineKey).toBe(HERE);
      // No record-level route: the availability views and the qualification timeline select on it.
      expect(stored.record.routeKey).toBeUndefined();
    }
    expect(OBSERVATION_KINDS).toEqual(expect.arrayContaining(['routeOutcome', 'routeOutcomeQuarantine']));
    const first = outcomes.find(({ outcome }) => outcome.pass === 'P-9001' && outcome.attempt === 1)!;
    expect(first.stored.record.observedAt).toBe('2026-10-20T10:00:00Z');
    expect(first.outcome).toEqual<RouteOutcome>({ rule: 'cro1', pass: 'P-9001', attempt: 1, provider: 'claudeCLI', routeKey: HAIKU,
      requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5', identity: 'matched', verification: 'passed',
      tokens: 1200, durationMilliseconds: 42000, recordedAt: '2026-10-20T10:00:00Z', findings: [] });
  });

  it('records a requested model that differs from the reported one as a substitution finding', () => {
    const root = temporary();
    const result = ingest(root);
    expect(result.substitutions).toEqual([expect.objectContaining({ line: 2, pass: 'P-9001', attempt: 2, routeKey: SONNET,
      identity: 'substituted', kind: 'substitution', requestedModel: 'claude-sonnet-5', actualModel: 'claude-haiku-4-5' })]);
    const stored = routeOutcomesFrom(readObservationStore(root)).find(({ outcome }) => outcome.identity === 'substituted')!;
    expect(stored.outcome.findings).toEqual([{ kind: 'substitution', requestedModel: 'claude-sonnet-5', actualModel: 'claude-haiku-4-5' }]);
    expect(stored.stored.record.recordID).toBe(result.substitutions[0]!.recordID);
    // A session that reported no model usage is unreported, not a substitution.
    expect(routeOutcomesFrom(readObservationStore(root)).find(({ outcome }) => outcome.routeKey === CODEX)!.outcome)
      .toMatchObject({ identity: 'unreported', actualModel: null, findings: [] });
  });

  it('quarantines every malformed and duplicate line with its reason and its text, and drops none', () => {
    const root = temporary();
    const result = ingest(root);
    expect(result.quarantined.map((entry) => [entry.line, entry.reasonCode, entry.written])).toEqual([
      [4, 'malformed', true], [5, 'duplicate', true], [7, 'duplicate', true], [8, 'malformed', true]]);
    const reasons = Object.fromEntries(result.quarantined.map((entry) => [entry.line, entry.reason]));
    expect(reasons[4]).toContain('not JSON');
    expect(reasons[5]).toContain('an exact repeat of line 1');
    expect(reasons[7]).toContain('already on line 2 with different content');
    expect(reasons[8]).toContain('provider');

    // NOTHING DROPPED: every line that was not blank is an outcome or a quarantine, and each quarantine holds the
    // line exactly as it arrived.
    const text = fs.readFileSync(FIXTURE, 'utf8').split('\n');
    const nonBlank = text.map((value, index) => ({ value, line: index + 1 })).filter((entry) => entry.value.trim().length > 0);
    expect(result.ingested.length + result.alreadyPresent.length + result.quarantined.length).toBe(nonBlank.length);
    const quarantines = routeOutcomeQuarantinesFrom(readObservationStore(root));
    expect(quarantines).toHaveLength(4);
    for (const { stored, quarantine } of quarantines) {
      expect(verifyObservationRecord(stored.record).intact).toBe(true);
      expect(quarantine).toMatchObject<Partial<RouteOutcomeQuarantine>>({ rule: 'cro1', sourceDigest: result.sourceDigest });
      expect(quarantine.text).toBe(text[quarantine.line - 1]);
      expect(quarantine.reason.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: ingesting the same file again writes nothing, quarantines included', () => {
    const root = temporary();
    ingest(root);
    const before = files(root);
    const again = ingest(root, LATER);
    expect(again.ingested).toEqual([]);
    expect(again.alreadyPresent.map((entry) => entry.line)).toEqual([1, 2, 3, 9, 10]);
    expect(again.quarantined.map((entry) => [entry.line, entry.written])).toEqual([[4, false], [5, false], [7, false], [8, false]]);
    // The substitution is still reported, because it is still in the file.
    expect(again.substitutions.map((entry) => entry.line)).toEqual([2]);
    expect(files(root)).toEqual(before);
  });

  it('quarantines a pass and attempt the store already holds with different content, and leaves the stored record alone', () => {
    const root = temporary();
    ingest(root);
    const held = routeOutcomesFrom(readObservationStore(root)).find(({ outcome }) => outcome.pass === 'P-9001' && outcome.attempt === 1)!;
    const result = ingestRouteOutcomes(root, Buffer.from(`${line({ pass: 'P-9001', attempt: 1, verification: 'failed' })}\n`
      + `${line({ pass: 'P-9100', attempt: 1 })}\n`), { machineKey: HERE, machineLabel: LABEL, now: LATER });
    expect(result.ingested.map((entry) => entry.line)).toEqual([2]);
    expect(result.quarantined).toEqual([expect.objectContaining({ line: 1, reasonCode: 'duplicate', written: true })]);
    expect(result.quarantined[0]!.reason).toContain(held.stored.record.recordID);
    const after = routeOutcomesFrom(readObservationStore(root)).filter(({ outcome }) => outcome.pass === 'P-9001' && outcome.attempt === 1);
    expect(after.map(({ stored }) => stored.record)).toEqual([held.stored.record]);
  });

  it('refuses an unreadable file whole, writing nothing', () => {
    const root = temporary();
    expect(() => ingestRouteOutcomeFile(root, path.join(root, 'absent.jsonl'), { machineKey: HERE, machineLabel: LABEL, now: NOW }))
      .toThrow(/could not be read.*Nothing was ingested/);
    expect(files(root)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the rollup, and never a verdict

const CASES = [{ id: 'case-a', dimensions: ['multiFileEditing'] }] as unknown as WorkspaceCase[];
/** Three sealed benchmark runs of HAIKU, two passing. */
const SEALED = ['pass', 'pass', 'fail'].map((status, index) => ({
  recordRoot: `/fixture/haiku/${index}`,
  row: { provider: 'claudeCLI', requestedModelID: 'claude-haiku-4-5', caseID: 'case-a', status,
    wallClockMilliseconds: 1000, recordedAt: `2026-10-1${index}T10:00:00Z` },
}));

function withAvailability(root: string): void {
  appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: LABEL,
    observedAt: '2026-10-19T10:00:00Z', available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
  { origin: 'observedHere', receivedAt: '2026-10-19T10:00:00Z' });
}

describe('outcomes feed the metrics rollup and never a verdict', () => {
  it('hands only matched, verified outcomes to the rollup, on the route entry', () => {
    const root = temporary();
    ingest(root);
    const rows = routeOutcomeRunRows(readObservationStore(root));
    // Line 1 passed and line 9 failed on HAIKU; the substitution, the unreported identity and notRun stay out.
    expect(rows.map((entry) => [entry.row.requestedModelID, entry.row.status, entry.row.pass, entry.row.attempt])).toEqual([
      ['claude-haiku-4-5', 'pass', 'P-9001', 1], ['claude-haiku-4-5', 'fail', 'P-9003', 2]]);
    const rollup = deriveMetricsRollup({ workspaceRows: [...SEALED, ...rows], workspaceCases: CASES });
    expect(rollup.routes.map((route) => route.routeKey)).toEqual([HAIKU]);
    const haiku = rollup.routes[0]!;
    expect(haiku.route).toMatchObject({ runCount: 5, scoredRunCount: 5, passCount: 3, failedRunCount: 2 });
    expect(haiku.route.wallClockMilliseconds.p90.value).toBe(90000);
    expect(haiku.route.totalTokens).toMatchObject({ count: 2, missing: 3 });
    // The outcomes carry no case, so the capability entry is the sealed runs' alone.
    expect(haiku.capabilities.find((entry) => entry.capability === 'workspace:multiFileEditing')).toMatchObject({ runCount: 3, passCount: 2 });
    expect(haiku.unclassifiedRunCount).toBe(2);
  });

  it('leaves every qualification verdict and the qualification timeline exactly as they were', () => {
    const root = temporary();
    withAvailability(root);
    const verdict = () => {
      const contents = readObservationStore(root);
      return deriveRouteQualification({ provider: 'claudeCLI', modelID: 'claude-haiku-4-5', machineKey: HERE,
        availability: observationsForRouting(contents), workspaceRows: SEALED, workspaceCases: CASES, now: NOW });
    };
    const timeline = () => deriveQualificationHistory({ routeKey: HAIKU, machineKey: HERE, contents: readObservationStore(root),
      workspaceRows: SEALED, workspaceCases: CASES });
    const before = { verdict: verdict(), timeline: timeline() };
    ingest(root);
    expect(routeOutcomesFrom(readObservationStore(root)).length).toBe(5);
    expect(verdict()).toEqual(before.verdict);
    expect(timeline()).toEqual(before.timeline);
  });

  it('is never read by the qualification verdict or the timeline', () => {
    for (const file of ['route-qualification.ts', 'qualification-history.ts', 'routing-contract.ts']) {
      const source = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', file), 'utf8');
      expect(source).not.toMatch(/routeOutcome|route-outcome-ingest/);
    }
    const ingestSource = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', 'route-outcome-ingest.ts'), 'utf8');
    expect(ingestSource).not.toMatch(/from '(node:)?(child_process|http|https|net)'|fetch\(|spawn\(|-adapter'|-driver'/);
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

describe('cernum ingest-outcomes <file> --json', () => {
  it('is declared as a local write taking one file, with --json and --machine', () => {
    const spec = commandSpec('ingest-outcomes')!;
    expect(spec.effect).toBe('writesLocal');
    expect(spec.positional).toBe('<file>');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['json', 'machine', 'root']));
  });

  it('ingests, reports substitutions and quarantines, and writes nothing the second time', async () => {
    const root = temporary();
    const first = await cernum('ingest-outcomes', FIXTURE, '--json', '--machine', HERE, '--root', root);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const answer = JSON.parse(first.stdout) as RouteOutcomeIngestResult & { file: string };
    expect(answer).toMatchObject({ schema: 'cro1', file: FIXTURE, machineKey: HERE, lineCount: 10, blankLines: 1 });
    expect(answer.ingested).toHaveLength(5);
    expect(answer.substitutions.map((entry) => [entry.requestedModel, entry.actualModel])).toEqual([['claude-sonnet-5', 'claude-haiku-4-5']]);
    expect(answer.quarantined.map((entry) => entry.reasonCode)).toEqual(['malformed', 'duplicate', 'duplicate', 'malformed']);
    const before = files(root);

    const second = await cernum('ingest-outcomes', FIXTURE, '--json', '--machine', HERE, '--root', root);
    expect(second.status).toBe(0);
    const again = JSON.parse(second.stdout) as RouteOutcomeIngestResult;
    expect(again.ingested).toEqual([]);
    expect(again.alreadyPresent).toHaveLength(5);
    expect(again.quarantined.every((entry) => !entry.written)).toBe(true);
    expect(files(root)).toEqual(before);
  });

  it('refuses a missing file with exit 2, ingesting nothing', async () => {
    const root = temporary();
    const result = await cernum('ingest-outcomes', path.join(root, 'absent.jsonl'), '--json', '--machine', HERE, '--root', root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Nothing was ingested');
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
