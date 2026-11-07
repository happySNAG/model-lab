// Task taxonomy ctt2, beside an unchanged ctt1: ctt1's eight rows, unchanged, plus `preservation-critical`
// → workspace:forwardCompatibilityReasoning, zero marginal cost only, not local only, preferring subscription
// or free. ctt2 is chosen only by an explicit `--taxonomy ctt2`; without it every answer is ctt1.
//
// FIXTURES ONLY. The pure functions are called directly; the commands run in a subprocess against a
// temporary root under os.tmpdir() holding one fixture availability observation and no benchmark evidence,
// so nothing holds forwardCompatibilityReasoning evidence and nothing is ranked. No driver runs, no provider
// is contacted, and the forward-compatibility pack is not run.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_CTT2_TASK_TYPES, ALL_ORDRA_TASK_TYPES, ALL_TASK_TAXONOMY_VERSIONS, Ctt2TaskQueryAnswer, TASK_TAXONOMY, TASK_TAXONOMY_CTT2,
  TASK_TAXONOMY_CTT2_VERSION, TASK_TAXONOMY_VERSION, TaskQueryAnswer, routeQueryForTask, routeQueryForTaskCtt2, routeQueryForTaskUnder,
  taskTaxonomyVersionFrom,
} from '../../src/engine/task-taxonomy';
import { ALL_WORKSPACE_DIMENSIONS } from '../../src/engine/workspace-case';
import { RouteCandidateSet } from '../../src/engine/routing-contract';
import {
  Crr2Recommendation, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA, recommendRoutesCrr2,
} from '../../src/engine/route-recommendation-crr2';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';
import { JsonSchema, validateAgainstSchema } from './json-schema-subset';

const REPOSITORY = path.resolve(__dirname, '../..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPOSITORY, ROUTE_RECOMMENDATION_CRR2_JSON_SCHEMA), 'utf8')) as JsonSchema;
const MACHINE = 'cmk1:task-taxonomy-ctt2-machine';
const HAIKU = 'claudeCLI:claude-haiku-4-5';
const CAPABILITY = 'workspace:forwardCompatibilityReasoning';
const CTT1_TYPES = 'implement, fix, test-repair, refactor, docs, verify, plan, review';
const ZERO = { costPolicy: 'zeroMarginalCostOnly', localOnly: false, preferSubscriptionOrFree: true } as const;

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ctt2-'));
  temporaries.push(directory);
  return directory;
}

function refused(answer: TaskQueryAnswer | Ctt2TaskQueryAnswer): string[] {
  expect(answer.ok).toBe(false);
  return answer.ok ? [] : answer.refusals;
}

/** Every path under a root with its bytes, so "writes nothing" also covers a file rewritten in place. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const relative of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const full = path.join(root, relative);
    entries[relative] = fs.statSync(full).isDirectory() ? '<dir>' : fs.readFileSync(full).toString('base64');
  }
  return entries;
}

// ------------------------------------------------------------------ (a) the ctt2 table, literally

describe('(a) ctt2 is ctt1\'s eight rows, unchanged, plus preservation-critical', () => {
  it('is exactly this table, at version ctt2', () => {
    expect(TASK_TAXONOMY_CTT2_VERSION).toBe('ctt2');
    expect(ALL_TASK_TAXONOMY_VERSIONS).toEqual(['ctt1', 'ctt2']);
    expect(ALL_CTT2_TASK_TYPES).toEqual(['implement', 'fix', 'test-repair', 'refactor', 'docs', 'verify', 'plan', 'review',
      'preservation-critical']);
    expect(TASK_TAXONOMY_CTT2).toEqual({
      implement: { dimension: 'multiFileEditing', ...ZERO },
      fix: { dimension: 'failureInterpretation', ...ZERO },
      'test-repair': { dimension: 'testExecution', ...ZERO },
      refactor: { dimension: 'preservationUnderTransformation', ...ZERO },
      docs: { dimension: 'scopeDiscipline', ...ZERO },
      verify: { dimension: 'contractOverVisibleTests', ...ZERO },
      plan: { dimension: 'repositoryComprehension', ...ZERO },
      review: { dimension: 'regressionAvoidance', ...ZERO },
      'preservation-critical': { dimension: 'forwardCompatibilityReasoning', ...ZERO },
    });
    expect(Object.keys(TASK_TAXONOMY_CTT2)).toEqual(ALL_CTT2_TASK_TYPES);
    for (const taskType of ALL_ORDRA_TASK_TYPES) expect(TASK_TAXONOMY_CTT2[taskType]).toEqual(TASK_TAXONOMY[taskType]);
    for (const row of Object.values(TASK_TAXONOMY_CTT2)) expect(ALL_WORKSPACE_DIMENSIONS).toContain(row.dimension);
  });

  it('maps preservation-critical to its query, naming ctt2', () => {
    expect(routeQueryForTaskCtt2({ machineKey: MACHINE, taskType: 'preservation-critical', tier: 2, contextTokens: 64_000 })).toEqual({
      ok: true, taxonomyVersion: 'ctt2', taskType: 'preservation-critical', row: TASK_TAXONOMY_CTT2['preservation-critical'],
      query: { machineKey: MACHINE, capability: CAPABILITY, structuralTier: 'tier2', minimumContextTokens: 64_000, ...ZERO },
    });
    expect(routeQueryForTaskUnder('ctt2', { machineKey: MACHINE, taskType: 'preservation-critical', tier: 1, contextTokens: 1 }))
      .toMatchObject({ ok: true, taxonomyVersion: 'ctt2', query: { capability: CAPABILITY } });
  });

  it('answers ctt1\'s eight types with ctt1\'s queries, differing only in the version it names', () => {
    for (const taskType of ALL_ORDRA_TASK_TYPES) {
      const one = routeQueryForTask({ machineKey: MACHINE, taskType, tier: 3, contextTokens: 1000 });
      const two = routeQueryForTaskCtt2({ machineKey: MACHINE, taskType, tier: 3, contextTokens: 1000 });
      expect(two).toEqual({ ...one, taxonomyVersion: 'ctt2' });
    }
  });
});

// ------------------------------------------------------------------ (b) ctt1 unchanged

describe('(b) ctt1 is unchanged', () => {
  it('keeps its table, its type list, its version and its refusal text', () => {
    expect(TASK_TAXONOMY_VERSION).toBe('ctt1');
    expect(ALL_ORDRA_TASK_TYPES).toEqual(['implement', 'fix', 'test-repair', 'refactor', 'docs', 'verify', 'plan', 'review']);
    expect(TASK_TAXONOMY).toEqual({
      implement: { dimension: 'multiFileEditing', ...ZERO },
      fix: { dimension: 'failureInterpretation', ...ZERO },
      'test-repair': { dimension: 'testExecution', ...ZERO },
      refactor: { dimension: 'preservationUnderTransformation', ...ZERO },
      docs: { dimension: 'scopeDiscipline', ...ZERO },
      verify: { dimension: 'contractOverVisibleTests', ...ZERO },
      plan: { dimension: 'repositoryComprehension', ...ZERO },
      review: { dimension: 'regressionAvoidance', ...ZERO },
    });
    expect(Object.keys(TASK_TAXONOMY)).not.toContain('preservation-critical');
    const answer = routeQueryForTask({ machineKey: MACHINE, taskType: 'deploy', tier: 1, contextTokens: 1000 });
    expect(answer).toEqual({ ok: false, taxonomyVersion: 'ctt1', refusals: [
      `task type 'deploy' is not in task taxonomy ctt1 (${CTT1_TYPES}); an unknown task type is refused, never mapped to a default capability`,
    ] });
    expect(routeQueryForTaskUnder('ctt1', { machineKey: MACHINE, taskType: 'deploy', tier: 1, contextTokens: 1000 })).toEqual(answer);
  });

  it('does not know preservation-critical: ctt2 is reached only by naming it', () => {
    expect(refused(routeQueryForTask({ machineKey: MACHINE, taskType: 'preservation-critical', tier: 1, contextTokens: 1000 })))
      .toEqual([`task type 'preservation-critical' is not in task taxonomy ctt1 (${CTT1_TYPES}); `
        + 'an unknown task type is refused, never mapped to a default capability']);
    const crr2 = recommendRoutesCrr2({ machineKey: MACHINE, taskType: 'preservation-critical' }, { now: new Date(), routes: [] });
    expect(crr2).toMatchObject({ contract: 'crr2', ok: false, taxonomyVersion: 'ctt1' });
  });

  it('answers a crr2 document without a taxonomy exactly as one asked for ctt1', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const plain = recommendRoutesCrr2({ machineKey: MACHINE, taskType: 'implement', tier: 2 }, { now, routes: [] });
    const named = recommendRoutesCrr2({ machineKey: MACHINE, taskType: 'implement', tier: 2, taxonomyVersion: 'ctt1' }, { now, routes: [] });
    expect(JSON.stringify(named)).toBe(JSON.stringify(plain));
    expect(plain).toMatchObject({ ok: true, taxonomyVersion: 'ctt1', query: { capability: 'workspace:multiFileEditing' } });
  });
});

// ------------------------------------------------------------------ (c) refusal, never a default

describe('(c) ctt2 refuses what it cannot read, with the reason, never a default', () => {
  it('refuses an unknown task type, naming ctt2 and its nine types', () => {
    for (const taskType of ['deploy', '', 'Preservation-Critical', 'preservation_critical', CAPABILITY]) {
      const reasons = refused(routeQueryForTaskCtt2({ machineKey: MACHINE, taskType, tier: 1, contextTokens: 1000 }));
      expect(reasons).toEqual([`task type '${taskType}' is not in task taxonomy ctt2 (${CTT1_TYPES}, preservation-critical); `
        + 'an unknown task type is refused, never mapped to a default capability']);
    }
    const answer = routeQueryForTaskCtt2({ machineKey: MACHINE, taskType: 'deploy', tier: 1, contextTokens: 1000 });
    expect(answer).toEqual({ ok: false, taxonomyVersion: 'ctt2', refusals: expect.any(Array) });
    expect(Object.keys(answer)).not.toContain('query');
  });

  it('refuses a bad tier, context or machine key as ctt1 does, all at once', () => {
    const reasons = refused(routeQueryForTaskCtt2({ machineKey: ' ', taskType: 'ship', tier: 9, contextTokens: 'lots' }));
    expect(reasons).toHaveLength(4);
    expect(reasons.join('\n')).toMatch(/task type 'ship' is not in task taxonomy ctt2[\s\S]*tier '9'[\s\S]*context requirement 'lots'[\s\S]*no machine key/);
  });

  it('refuses an unknown taxonomy version by name', () => {
    expect(taskTaxonomyVersionFrom('ctt2')).toEqual({ ok: true, version: 'ctt2' });
    expect(taskTaxonomyVersionFrom('ctt1')).toEqual({ ok: true, version: 'ctt1' });
    expect(taskTaxonomyVersionFrom('ctt3')).toEqual({ ok: false,
      refusal: "task taxonomy 'ctt3' is not one of ctt1, ctt2; an unknown taxonomy is refused, never defaulted" });
  });

  it('refuses an unknown task type in a crr2 request under ctt2, naming ctt2', () => {
    const answer = recommendRoutesCrr2({ machineKey: MACHINE, taskType: 'deploy', taxonomyVersion: 'ctt2' }, { now: new Date(), routes: [] });
    expect(answer).toMatchObject({ contract: 'crr2', ok: false, taxonomyVersion: 'ctt2', isSelection: false, launches: false });
    expect(answer.ok ? [] : answer.refusals[0]).toContain("task type 'deploy' is not in task taxonomy ctt2");
  });
});

// ------------------------------------------------------------------ (d, e) the commands, in a subprocess

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
  appendObservations(root, [routeAvailabilityObservation({ routeKey: HAIKU, machineKey: MACHINE, machineLabel: 'fixture-host',
    observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI', 'a fixture availability reading')],
  { origin: 'observedHere', receivedAt: observedAt });
  return root;
}

describe('(d) candidates --task preservation-critical --taxonomy ctt2, with no forwardCompatibilityReasoning evidence', () => {
  it('declares --taxonomy on candidates and recommend', () => {
    for (const name of ['candidates', 'recommend']) {
      expect(acceptedOptions(commandSpec(name)!).map((option) => option.name)).toContain('taxonomy');
    }
  });

  it('names the capability and ctt2, ranks nothing, and writes nothing', async () => {
    const root = fixtureRoot();
    const before = snapshot(root);
    const result = await cernum('candidates', '--task', 'preservation-critical', '--taxonomy', 'ctt2', '--tier', '2',
      '--context', '32000', '--machine', MACHINE, '--root', root, '--json');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const set = JSON.parse(result.stdout) as RouteCandidateSet & { task: { taxonomyVersion: string; taskType: string } };
    expect(set.query).toMatchObject({ machineKey: MACHINE, capability: CAPABILITY, structuralTier: 'tier2',
      minimumContextTokens: 32_000, ...ZERO });
    expect(set.task).toEqual({ taxonomyVersion: 'ctt2', taskType: 'preservation-critical', row: TASK_TAXONOMY_CTT2['preservation-critical'] });
    expect(set.candidates).toEqual([]);
    expect(set.excluded.map((entry) => entry.routeKey)).toEqual([HAIKU]);
    expect(snapshot(root)).toEqual(before);

    const text = await cernum('candidates', '--task', 'preservation-critical', '--taxonomy', 'ctt2', '--tier', '2',
      '--context', '32000', '--machine', MACHINE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Task: preservation-critical (task taxonomy ctt2) · at least 32000 context tokens');
    expect(text.stdout).toContain(`Capability: ${CAPABILITY} at tier2`);
    expect(text.stdout).toContain('No route qualifies for this query.');
    expect(snapshot(root)).toEqual(before);
  });

  it('stays on ctt1 without --taxonomy, and refuses preservation-critical there', async () => {
    const root = fixtureRoot();
    const before = snapshot(root);
    const plain = await cernum('candidates', '--task', 'refactor', '--tier', '2', '--context', '32000', '--machine', MACHINE, '--root', root, '--json');
    expect(plain.status).toBe(0);
    expect((JSON.parse(plain.stdout) as { task: { taxonomyVersion: string } }).task.taxonomyVersion).toBe('ctt1');
    const unknown = await cernum('candidates', '--task', 'preservation-critical', '--tier', '2', '--context', '32000',
      '--machine', MACHINE, '--root', root);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("task type 'preservation-critical' is not in task taxonomy ctt1");
    expect(unknown.stdout).toBe('');
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses an unknown --taxonomy, or --taxonomy without --task, with the reason and exit 2', async () => {
    const root = temporary();
    const unknown = await cernum('candidates', '--task', 'fix', '--taxonomy', 'ctt9', '--tier', '1', '--context', '1000',
      '--machine', MACHINE, '--root', root);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("task taxonomy 'ctt9' is not one of ctt1, ctt2");
    expect(unknown.stdout).toBe('');
    const stray = await cernum('candidates', CAPABILITY, '--taxonomy', 'ctt2', '--machine', MACHINE, '--root', root);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain('--taxonomy names the task taxonomy a --task is mapped by');
    const ctt2Unknown = await cernum('candidates', '--task', 'deploy', '--taxonomy', 'ctt2', '--tier', '1', '--context', '1000',
      '--machine', MACHINE, '--root', root);
    expect(ctt2Unknown.status).toBe(2);
    expect(ctt2Unknown.stderr).toContain("task type 'deploy' is not in task taxonomy ctt2");
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('(d, e) recommend preservation-critical --taxonomy ctt2 --contract crr2 --json', () => {
  it('names the capability and ctt2, ranks nothing, writes nothing, and validates against the crr2 schema', async () => {
    const root = fixtureRoot();
    const before = snapshot(root);
    const result = await cernum('recommend', 'preservation-critical', '--taxonomy', 'ctt2', '--contract', 'crr2', '--json',
      '--machine', MACHINE, '--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as Crr2Recommendation;
    expect(validateAgainstSchema(answer, SCHEMA)).toEqual([]);
    expect(answer).toMatchObject({ contract: 'crr2', contractVersion: 1, ok: true, taxonomyVersion: 'ctt2', advisory: true,
      isSelection: false, launches: false, confidence: { level: 'none' },
      query: { taskType: 'preservation-critical', machineKey: MACHINE, capability: CAPABILITY, allowMetered: false,
        costPolicy: 'zeroMarginalCostOnly', routeQuery: { capability: CAPABILITY } } });
    expect(answer.ranking).toEqual([]);
    expect(answer.order).toEqual([]);
    expect(answer.selected).toBeUndefined();
    expect(answer.uncertainties.map((entry) => entry.code)).toContain('nothingRanked');
    expect(answer.exclusions.map((entry) => entry.key)).toEqual([HAIKU]);
    expect(answer.reasons[0]).toContain(`task 'preservation-critical' maps by task taxonomy ctt2 to ${CAPABILITY}`);
    expect(snapshot(root)).toEqual(before);

    const text = await cernum('recommend', 'preservation-critical', '--taxonomy', 'ctt2', '--contract', 'crr2', '--machine', MACHINE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('task taxonomy ctt2');
    expect(text.stdout).toContain(`Task: preservation-critical → ${CAPABILITY}`);
    expect(text.stdout).toContain('No route qualifies for this task, so nothing is ranked.');
    expect(snapshot(root)).toEqual(before);
  });

  it('still answers ctt1 without --taxonomy, and that document still validates', async () => {
    const root = fixtureRoot();
    const result = await cernum('recommend', 'implement', '--contract', 'crr2', '--json', '--machine', MACHINE, '--root', root);
    expect(result.status).toBe(0);
    const answer = JSON.parse(result.stdout) as Crr2Recommendation;
    expect(answer.taxonomyVersion).toBe('ctt1');
    expect(validateAgainstSchema(answer, SCHEMA)).toEqual([]);
    const unnamed = await cernum('recommend', 'preservation-critical', '--contract', 'crr2', '--json', '--machine', MACHINE, '--root', root);
    expect(unnamed.status).toBe(2);
    expect(unnamed.stderr).toContain("task type 'preservation-critical' is not in task taxonomy ctt1");
  });

  it('refuses an unknown --taxonomy, and ctt2 beside crr1, with the reason and exit 2', async () => {
    const root = temporary();
    const unknown = await cernum('recommend', 'implement', '--taxonomy', 'ctt3', '--contract', 'crr2', '--machine', MACHINE, '--root', root);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("task taxonomy 'ctt3' is not one of ctt1, ctt2");
    expect(unknown.stdout).toBe('');
    const crr1 = await cernum('recommend', 'preservation-critical', '--taxonomy', 'ctt2', '--machine', MACHINE, '--root', root);
    expect(crr1.status).toBe(2);
    expect(crr1.stderr).toContain('--taxonomy ctt2 belongs to --contract crr2');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('the schema admits ctt1 and ctt2 and nothing else', () => {
    const answer = recommendRoutesCrr2({ machineKey: MACHINE, taskType: 'preservation-critical', taxonomyVersion: 'ctt2' },
      { now: new Date('2026-11-06T12:00:00Z'), routes: [] });
    expect(answer.ok).toBe(true);
    const document = JSON.parse(JSON.stringify(answer)) as Record<string, unknown>;
    expect(validateAgainstSchema(document, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema({ ...document, taxonomyVersion: 'ctt3' }, SCHEMA))
      .toEqual(['$.taxonomyVersion: "ctt3" is not one of ["ctt1","ctt2"]']);
  });
});

// ------------------------------------------------------------------ (f) documented

describe('(f) ctt2 is documented', () => {
  it('has a ctt2 section with the preservation-critical row in docs/ordra-lane/task-taxonomy.md', () => {
    const doc = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/task-taxonomy.md'), 'utf8');
    expect(doc).toContain('## The table, `ctt2`');
    const row = TASK_TAXONOMY_CTT2['preservation-critical'];
    expect(doc).toContain(`| \`preservation-critical\` | \`workspace:${row.dimension}\` | \`${row.costPolicy}\` | no | yes |`);
    expect(doc).toContain('--taxonomy ctt2');
    const crr2 = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/recommend-crr2.md'), 'utf8');
    expect(crr2).toContain('--taxonomy ctt2');
  });
});
