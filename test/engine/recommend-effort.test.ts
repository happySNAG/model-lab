// crr2's effort recommendation, opt-in behind `--recommend-effort` (G-22942 C1; R-27, R-30, V1-18). An
// effort is named only when the selected entry is a cek1 effort-keyed record whose key was observed;
// otherwise it is unobservable with the reason. An escalation names the next higher EFFORT_LEVELS effort of
// the same provider:model only when an observed cek1 entry for it is ranked; otherwise none with the reason.
// Without --recommend-effort the crr2 document is unchanged. No effort is read from a model name.
//
// FIXTURES ONLY. Records and run rows are hand-written here; the command runs in a subprocess against a
// temporary root under os.tmpdir() holding one fixture availability observation. No provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Crr2Recommendation, Crr2Request, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA, recommendRoutesCrr2,
} from '../../src/engine/route-recommendation-crr2';
import {
  Crr2EffortRecommendation, Crr2RecommendationWithEffort, effortRecommendationOf, withEffortRecommendation,
} from '../../src/engine/recommend-effort';
import { RouteAvailabilitySource, RouteForQuery } from '../../src/engine/routing-contract';
import { CapabilityQualification, RouteQualificationRecord, V1_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import { EvidenceEffort } from '../../src/engine/effort-keyed-routes';
import { routeSpendPosture } from '../../src/engine/route-spend-posture';
import { measuredQuantity } from '../../src/engine/frontier-metrics';
import { MetricsRollup, deriveMetricsRollup } from '../../src/engine/metrics-rollup';
import { ModelDescription, known } from '../../src/engine/model-description';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { EFFORT_LEVELS, ProviderID } from '../../src/engine/provider';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import { JsonSchema, validateAgainstSchema } from './json-schema-subset';

const REPOSITORY = path.resolve(__dirname, '../..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPOSITORY, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA), 'utf8')) as JsonSchema;
const NOW = new Date('2026-11-07T12:00:00Z');
const HERE = 'cmk1:recommend-effort-machine';
const CAPABILITY = 'workspace:multiFileEditing';
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const HAIKU = 'claudeCLI:claude-haiku-4-5';
const GEMMA = 'ollama:gemma3:4b';
// Model names that SPELL an effort. Their effort is never read from the name.
const NAMED_HIGH = 'codexCLI:gpt-5-codex-high';
const NAMED_AT_XHIGH = 'claudeCLI:fixture-model@xhigh';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-effort-'));
  temporaries.push(directory);
  return directory;
}

const qualified = (capability: string): CapabilityQualification => ({
  capability, source: 'workspace', verdict: 'qualified', scoredRunCount: 3, successCount: 3,
  successRateMilli: measuredQuantity(1000), evidenceRefs: ['case-a'], reason: '3/3 scored runs passed (≥ 90%)',
});

function record(routeKey: string, over: Partial<RouteQualificationRecord> = {}): RouteQualificationRecord {
  const at = routeKey.indexOf(':');
  const provider = routeKey.slice(0, at) as ProviderID;
  const modelID = routeKey.slice(at + 1);
  return {
    schema: 'crq1', routeKey, provider, modelID, effort: 'any', policy: V1_QUALIFICATION_POLICY,
    qualificationScope: provider === 'ollama' ? 'machine' : 'route',
    locus: provider === 'ollama' ? { machineKey: HERE } : undefined,
    discovered: { state: 'currentlyDiscovered', reason: 'observed just now' },
    availableOnThisMachine: { state: 'available', reason: 'installed and signed in' },
    identityConfidence: provider === 'ollama' ? 'verifiedByLocalDigest' : 'verifiedByProvider',
    bindingIdentityStates: ['verified'], identityAdmitted: false, routingPolicyVersion: 'crp2',
    billing: routeSpendPosture({ provider, modelID, now: NOW }),
    evidence: {
      prose: { present: false, candidates: [] }, development: { present: false, candidates: [] },
      workspace: { present: true, runCount: 3, scoredRunCount: 3, packs: ['p'], recordRoots: [] },
    },
    capabilities: [qualified(CAPABILITY)],
    discriminator: [],
    lastSuccessfulQualificationAt: hoursAgo(24),
    efficiency: { medianWallClockMilliseconds: measuredQuantity(1000), medianTotalTokens: measuredQuantity(100), basis: 'medians' },
    staleness: { valid: true, reasons: ['qualificationStillValid'], detail: ['nothing moved'] },
    safeToRoute: true, routableCapabilities: [CAPABILITY], notRoutableBecause: [], blockers: [],
    disclosure: 'no universal score',
    ...over,
  };
}

const keyedAt = (routeKey: string, suffix: string, over: Partial<EvidenceEffort> = {}): EvidenceEffort => ({
  effortRouteKey: `${routeKey}@${suffix}`,
  state: suffix.startsWith('unobservable') ? 'unobservable' : 'observed',
  ...(suffix.startsWith('unobservable') ? {} : { effort: suffix as EvidenceEffort['effort'] }),
  requestedEfforts: [(suffix.startsWith('unobservable:') ? suffix.slice('unobservable:'.length) : suffix) as EvidenceEffort['requestedEfforts'][number]],
  runCount: 10, mismatchedRunCount: 0,
  basis: [suffix.startsWith('unobservable') ? 'this run\'s driver measures no applied effort' : 'appliedEffortVerified: fixture telemetry'],
  notKeyed: [], ...over,
});

const available = (): RouteAvailabilitySource => ({
  state: 'available', observedOnMachine: HERE, machineLabel: 'fixture-host', origin: 'observedHere',
  observedAt: hoursAgo(1), reason: 'installed and signed in',
});
const WIDE = ({ contextWindowTokens: known(200_000, 'fixture catalogue'), locality: 'remote' }) as unknown as ModelDescription;

const CASES = [{ id: 'case-a', dimensions: ['multiFileEditing'] }] as unknown as WorkspaceCase[];
function rows(routeKey: string, passes: number, runs: number, wallClock: number): { recordRoot: string; row: Record<string, unknown> }[] {
  const at = routeKey.indexOf(':');
  return Array.from({ length: runs }, (_, index) => ({
    recordRoot: `/fixture/${routeKey}/${index}`,
    row: { provider: routeKey.slice(0, at), requestedModelID: routeKey.slice(at + 1), caseID: 'case-a',
      status: index < passes ? 'pass' : 'fail', wallClockMilliseconds: wallClock, recordedAt: hoursAgo(60 - index) },
  }));
}
const rollup = (...sets: ReturnType<typeof rows>[]): MetricsRollup => deriveMetricsRollup({ workspaceRows: sets.flat(), workspaceCases: CASES });

/** A keyed route at `suffix`, with a rollup of `passes`/`runs` under that key alone. */
type Keyed = { routeKey: string; suffix?: string; passes: number; runs: number };
function answerFor(entries: Keyed[], over: Partial<Crr2Request> = {}): Crr2Recommendation {
  const routes: RouteForQuery[] = entries.map((entry) => ({ record: record(entry.routeKey,
    entry.suffix === undefined ? {} : { evidenceEffort: keyedAt(entry.routeKey, entry.suffix) }), description: WIDE, availability: available() }));
  const keyedMetrics: Record<string, MetricsRollup> = {};
  for (const entry of entries) {
    if (entry.suffix !== undefined) keyedMetrics[`${entry.routeKey}@${entry.suffix}`] = rollup(rows(entry.routeKey, entry.passes, entry.runs, 1000));
  }
  const pooled = entries.filter((entry) => entry.suffix === undefined).map((entry) => rows(entry.routeKey, entry.passes, entry.runs, 1000));
  const answer = recommendRoutesCrr2({ machineKey: HERE, taskType: 'implement', ...over },
    { now: NOW, routes, metrics: rollup(...pooled), keyedMetrics });
  if (!answer.ok) throw new Error(`refused: ${answer.refusals.join('; ')}`);
  return answer;
}
const valid = (document: unknown): string[] => validateAgainstSchema(JSON.parse(JSON.stringify(document)), SCHEMA);
function recommended(entries: Keyed[], over: Partial<Crr2Request> = {}): { answer: Crr2Recommendation; effort: Crr2EffortRecommendation } {
  const answer = answerFor(entries, over);
  const document = withEffortRecommendation(answer);
  expect(valid(document)).toEqual([]);
  return { answer, effort: document.effortRecommendation };
}

describe('crr2 effortRecommendation · the effort is named only on an observed cek1 key of the selected entry', () => {
  it('names the observed effort and its key when the first-ranked entry is cek1-keyed and observed', () => {
    const { answer, effort } = recommended([
      { routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 },
      { routeKey: GEMMA, suffix: 'medium', passes: 5, runs: 10 },
    ]);
    expect(answer.order[0]).toBe(`${HAIKU}@high`);
    expect(effort).toMatchObject({ state: 'observed', effort: 'high', routeKey: `${HAIKU}@high`,
      basis: ['appliedEffortVerified: fixture telemetry'] });
    expect(effort).not.toHaveProperty('reason');
  });

  it('is unobservable with code nothingRanked when nothing is ranked', () => {
    const { answer, effort } = recommended([]);
    expect(answer.ranking).toEqual([]);
    expect(effort).toEqual({ state: 'unobservable', code: 'nothingRanked',
      reason: expect.stringContaining('nothing is ranked'), escalation: expect.objectContaining({ none: true, code: 'noObservedEffort' }) });
    expect(effort).not.toHaveProperty('effort');
  });

  it('is unobservable with code pooled when the first-ranked record was derived without an effort key', () => {
    const { answer, effort } = recommended([{ routeKey: HAIKU, passes: 40, runs: 40 },
      { routeKey: GEMMA, suffix: 'medium', passes: 5, runs: 10 }]);
    expect(answer.order[0]).toBe(HAIKU);
    expect(answer.ranking[0]!.effort.pooled).toBe(true);
    expect(effort).toMatchObject({ state: 'unobservable', code: 'pooled', escalation: { none: true, code: 'noObservedEffort' } });
    expect((effort as { reason: string }).reason).toContain('without an effort key');
    expect(effort).not.toHaveProperty('effort');
  });

  it('is unobservable with code effortUnobservable when the first-ranked key is @unobservable:<requested>', () => {
    const { answer, effort } = recommended([
      { routeKey: HAIKU, suffix: 'unobservable:high', passes: 40, runs: 40 },
      // An observed xhigh of the same route is ranked, but there is no observed effort to escalate FROM.
      { routeKey: HAIKU, suffix: 'xhigh', passes: 5, runs: 10 },
    ]);
    expect(answer.order[0]).toBe(`${HAIKU}@unobservable:high`);
    expect(effort).toMatchObject({ state: 'unobservable', code: 'effortUnobservable', escalation: { none: true, code: 'noObservedEffort' } });
    expect((effort as { reason: string }).reason).toContain('no telemetry measured the applied effort');
    expect(effort).not.toHaveProperty('effort');
    expect(effort.escalation).not.toHaveProperty('effort');
  });
});

describe('crr2 effortRecommendation · escalation is the next higher effort of the same provider:model, only when observed and ranked', () => {
  it('names the next higher EFFORT_LEVELS effort when an observed cek1 entry for it is ranked', () => {
    const { answer, effort } = recommended([
      { routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 },
      { routeKey: HAIKU, suffix: 'xhigh', passes: 18, runs: 20 },
      { routeKey: HAIKU, suffix: 'max', passes: 19, runs: 20 },
    ]);
    expect(answer.order[0]).toBe(`${HAIKU}@high`);
    expect(EFFORT_LEVELS[EFFORT_LEVELS.indexOf('high') + 1]).toBe('xhigh');
    const rank = answer.ranking.find((entry) => entry.key === `${HAIKU}@xhigh`)!.rank;
    expect(effort.escalation).toEqual({ effort: 'xhigh', routeKey: `${HAIKU}@xhigh`, rank, reason: expect.stringContaining('next higher effort') });
  });

  it('names none (notRanked) when the next level is not ranked, and never skips to a higher one', () => {
    const { effort } = recommended([
      { routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 },
      { routeKey: HAIKU, suffix: 'max', passes: 19, runs: 20 },
    ]);
    expect(effort).toMatchObject({ state: 'observed', effort: 'high' });
    expect(effort.escalation).toEqual({ none: true, code: 'notRanked', reason: expect.stringContaining(`${HAIKU}@xhigh`) });
  });

  it('names none (notRanked) when the next level exists only as an unobservable key', () => {
    const { effort } = recommended([
      { routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 },
      { routeKey: HAIKU, suffix: 'unobservable:xhigh', passes: 18, runs: 20 },
    ]);
    expect(effort.escalation).toMatchObject({ none: true, code: 'notRanked' });
  });

  it('names none (notRanked) when the next level is observed only for another provider:model', () => {
    const { effort } = recommended([
      { routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 },
      { routeKey: 'opencodeCLI:claude-haiku-4-5', suffix: 'xhigh', passes: 18, runs: 20 },
      { routeKey: GEMMA, suffix: 'xhigh', passes: 18, runs: 20 },
    ]);
    expect(effort.escalation).toMatchObject({ none: true, code: 'notRanked' });
  });

  it('names none (notRanked) when the next level is observed but excluded, not ranked', () => {
    const answer = answerFor([{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }]);
    const excluded = recommendRoutesCrr2({ machineKey: HERE, taskType: 'implement' }, { now: NOW,
      routes: [
        { record: record(HAIKU, { evidenceEffort: keyedAt(HAIKU, 'high') }), description: WIDE, availability: available() },
        { record: record(HAIKU, { evidenceEffort: keyedAt(HAIKU, 'xhigh'), staleness: { valid: false, reasons: [], detail: ['expired'] } }),
          description: WIDE, availability: available() },
      ],
      keyedMetrics: { [`${HAIKU}@high`]: rollup(rows(HAIKU, 40, 40, 1000)), [`${HAIKU}@xhigh`]: rollup(rows(HAIKU, 20, 20, 1000)) } });
    if (!excluded.ok) throw new Error('refused');
    expect(excluded.exclusions.map((entry) => entry.key)).toEqual([`${HAIKU}@xhigh`]);
    expect(effortRecommendationOf(excluded).escalation).toMatchObject({ none: true, code: 'notRanked' });
    expect(effortRecommendationOf(answer).escalation).toMatchObject({ none: true, code: 'notRanked' });
  });

  it('names none (highestEffort) at max, the highest level', () => {
    const { effort } = recommended([{ routeKey: HAIKU, suffix: 'max', passes: 40, runs: 40 }]);
    expect(EFFORT_LEVELS[EFFORT_LEVELS.length - 1]).toBe('max');
    expect(effort).toMatchObject({ state: 'observed', effort: 'max', escalation: { none: true, code: 'highestEffort' } });
  });

  it('escalates from an observed none to minimal, step by step along EFFORT_LEVELS', () => {
    const { effort } = recommended([
      { routeKey: HAIKU, suffix: 'none', passes: 40, runs: 40 },
      { routeKey: HAIKU, suffix: 'minimal', passes: 18, runs: 20 },
    ]);
    expect(effort).toMatchObject({ state: 'observed', effort: 'none', escalation: { effort: 'minimal', routeKey: `${HAIKU}@minimal` } });
  });
});

describe('crr2 effortRecommendation · no effort is read from a model name', () => {
  it('a pooled record whose model name spells an effort is still unobservable', () => {
    for (const routeKey of [NAMED_HIGH, NAMED_AT_XHIGH]) {
      const { answer, effort } = recommended([{ routeKey, passes: 40, runs: 40 }]);
      expect(answer.order).toEqual([routeKey]);
      expect(effort).toMatchObject({ state: 'unobservable', code: 'pooled', escalation: { none: true, code: 'noObservedEffort' } });
      expect(effort).not.toHaveProperty('effort');
    }
  });

  it('an observed key on a model named for another effort recommends the observed effort, and escalates by the key', () => {
    const { effort } = recommended([
      { routeKey: NAMED_HIGH, suffix: 'low', passes: 40, runs: 40 },
      { routeKey: NAMED_HIGH, suffix: 'medium', passes: 18, runs: 20 },
      { routeKey: NAMED_HIGH, suffix: 'xhigh', passes: 18, runs: 20 },
    ]);
    expect(effort).toMatchObject({ state: 'observed', effort: 'low', routeKey: `${NAMED_HIGH}@low`,
      escalation: { effort: 'medium', routeKey: `${NAMED_HIGH}@medium` } });
  });

  it('a model id containing @<effort> does not make an unobservable key observed', () => {
    const { effort } = recommended([{ routeKey: NAMED_AT_XHIGH, suffix: 'unobservable:unrecorded', passes: 40, runs: 40 }]);
    expect(effort).toMatchObject({ state: 'unobservable', code: 'effortUnobservable' });
  });
});

describe('crr2 effortRecommendation · the document and its schema', () => {
  it('without the property the document is exactly crr2 as before; with it, the same keys in the same order plus one last', () => {
    const answer = answerFor([{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }, { routeKey: HAIKU, suffix: 'xhigh', passes: 18, runs: 20 }]);
    const before = JSON.stringify(answer, null, 2);
    const document: Crr2RecommendationWithEffort = withEffortRecommendation(answer);
    expect(JSON.stringify(answer, null, 2)).toBe(before);
    expect(Object.keys(answer)).not.toContain('effortRecommendation');
    expect(Object.keys(document)).toEqual([...Object.keys(answer), 'effortRecommendation']);
    const { effortRecommendation, ...rest } = document;
    expect(effortRecommendation.state).toBe('observed');
    expect(JSON.stringify(rest, null, 2)).toBe(before);
    expect(document.contractVersion).toBe(1);
    expect(valid(answer)).toEqual([]);
    expect(valid(document)).toEqual([]);
  });

  it('the schema admits effortRecommendation as optional, refuses unknown keys inside it, and still refuses an unknown top-level key', () => {
    const properties = SCHEMA.properties as Record<string, JsonSchema>;
    expect(properties.effortRecommendation).toBeDefined();
    expect(SCHEMA.required as string[]).not.toContain('effortRecommendation');
    expect(properties.contractVersion).toEqual({ const: 1 });
    const document = JSON.parse(JSON.stringify(withEffortRecommendation(answerFor([{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }])))) as
      Crr2RecommendationWithEffort & Record<string, unknown>;
    expect(validateAgainstSchema(document, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema({ ...document, effortRecommendation: { ...document.effortRecommendation, winner: 'high' } }, SCHEMA))
      .toEqual(["$.effortRecommendation: 'winner' is not allowed"]);
    expect(validateAgainstSchema({ ...document, effortRecommendation: { ...document.effortRecommendation, effort: 'ultra' } }, SCHEMA))
      .toEqual([expect.stringContaining('$.effortRecommendation.effort')]);
    expect(validateAgainstSchema({ ...document, effortRecommendation: { ...document.effortRecommendation,
      escalation: { none: true, code: 'notRanked', reason: 'x', guess: 'xhigh' } } }, SCHEMA))
      .toEqual(["$.effortRecommendation.escalation: 'guess' is not allowed"]);
    expect(validateAgainstSchema({ ...document, winner: HAIKU }, SCHEMA)).toEqual(["$: 'winner' is not allowed"]);
  });

  it('every state the recommendation can take validates against the schema', () => {
    const cases: Keyed[][] = [
      [], [{ routeKey: HAIKU, passes: 40, runs: 40 }], [{ routeKey: HAIKU, suffix: 'unobservable:max', passes: 40, runs: 40 }],
      [{ routeKey: HAIKU, suffix: 'max', passes: 40, runs: 40 }], [{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }],
      [{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }, { routeKey: HAIKU, suffix: 'xhigh', passes: 18, runs: 20 }],
    ];
    for (const entries of cases) expect(valid(withEffortRecommendation(answerFor(entries)))).toEqual([]);
    expect(valid(withEffortRecommendation(answerFor([{ routeKey: HAIKU, suffix: 'high', passes: 40, runs: 40 }], { allowMetered: true })))).toEqual([]);
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

function fixtureRoot(): string {
  const root = temporary();
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: HERE, machineLabel: 'fixture-host',
    observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
  { origin: 'observedHere', receivedAt: observedAt });
  return root;
}

const withoutInstant = (text: string): string => text.replace(/"answeredAt": "[^"]+"/u, '"answeredAt": "<instant>"');

describe('cernum recommend <task-type> --contract crr2 --recommend-effort --json', () => {
  it('declares --recommend-effort as a boolean option of recommend', () => {
    const option = acceptedOptions(commandSpec('recommend')!).find((entry) => entry.name === 'recommend-effort');
    expect(option).toMatchObject({ takesValue: false });
    expect(commandSpec('recommend')!.detail!.join(' ')).toContain('--recommend-effort');
  });

  it('adds a schema-valid effortRecommendation, and without the flag the document is unchanged', async () => {
    const root = fixtureRoot();
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const plain = await cernum('recommend', 'implement', '--contract', 'crr2', '--json', '--machine', HERE, '--root', root);
    const withEffort = await cernum('recommend', 'implement', '--contract', 'crr2', '--recommend-effort', '--json', '--machine', HERE, '--root', root);
    expect(plain.stderr).toBe('');
    expect(withEffort.stderr).toBe('');
    expect(plain.status).toBe(0);
    expect(withEffort.status).toBe(0);
    const plainDocument = JSON.parse(plain.stdout) as Crr2Recommendation;
    const document = JSON.parse(withEffort.stdout) as Crr2RecommendationWithEffort;
    expect(Object.keys(plainDocument)).not.toContain('effortRecommendation');
    expect(validateAgainstSchema(plainDocument, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema(document, SCHEMA)).toEqual([]);
    // No benchmark evidence in the fixture root: nothing is ranked, so no effort is named.
    expect(document.effortRecommendation).toMatchObject({ state: 'unobservable', code: 'nothingRanked',
      escalation: { none: true, code: 'noObservedEffort' } });
    const { effortRecommendation: _dropped, ...rest } = document;
    expect(withoutInstant(JSON.stringify(rest, null, 2))).toBe(withoutInstant(plain.stdout.trimEnd()));
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);

    const text = await cernum('recommend', 'implement', '--contract', 'crr2', '--recommend-effort', '--machine', HERE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Effort: unobservable');
    expect(text.stdout).toContain('Escalation: none');
    const plainText = await cernum('recommend', 'implement', '--contract', 'crr2', '--machine', HERE, '--root', root);
    expect(plainText.stdout).not.toContain('Effort:');
  });

  it('refuses --recommend-effort beside crr1 with the reason and exit 2, reading nothing', async () => {
    const root = fixtureRoot();
    for (const args of [[], ['--contract', 'crr1']]) {
      const refused = await cernum('recommend', 'implement', ...args, '--recommend-effort', '--json', '--machine', HERE, '--root', root);
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('--recommend-effort belongs to --contract crr2');
    }
  });
});
