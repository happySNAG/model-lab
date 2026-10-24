// The Ordra task taxonomy: one versioned, documented table (ctt1) from a pass's task type, structural
// tier and context requirement to a crc2 RouteCandidateQuery — and an unknown task type or tier
// refused with the reason, never defaulted.
//
// FIXTURES ONLY. The pure function is called directly; the command runs in a subprocess against a
// temporary root holding one fixture availability observation. No driver runs and no provider is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_ORDRA_TASK_TYPES, TASK_TAXONOMY, TASK_TAXONOMY_VERSION, TaskQueryAnswer, routeQueryForTask,
} from '../../src/engine/task-taxonomy';
import { ALL_WORKSPACE_DIMENSIONS } from '../../src/engine/workspace-case';
import { ROUTING_CONTRACT_VERSION, RouteCandidateSet } from '../../src/engine/routing-contract';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const MACHINE = 'cmk1:task-taxonomy-machine';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-task-taxonomy-'));
  temporaries.push(directory);
  return directory;
}

function refused(answer: TaskQueryAnswer): string[] {
  expect(answer.ok).toBe(false);
  return answer.ok ? [] : answer.refusals;
}

// ------------------------------------------------------------------ the table

describe('the taxonomy is one versioned table over existing workspace dimensions', () => {
  it('ctt1 is exactly this table — changing it means a new version', () => {
    expect(TASK_TAXONOMY_VERSION).toBe('ctt1');
    expect(ROUTING_CONTRACT_VERSION).toBe('crc2');
    expect(ALL_ORDRA_TASK_TYPES).toEqual(['implement', 'fix', 'test-repair', 'refactor', 'docs', 'verify', 'plan', 'review']);
    const zero = { costPolicy: 'zeroMarginalCostOnly', localOnly: false, preferSubscriptionOrFree: true };
    expect(TASK_TAXONOMY).toEqual({
      implement: { dimension: 'multiFileEditing', ...zero },
      fix: { dimension: 'failureInterpretation', ...zero },
      'test-repair': { dimension: 'testExecution', ...zero },
      refactor: { dimension: 'preservationUnderTransformation', ...zero },
      docs: { dimension: 'scopeDiscipline', ...zero },
      verify: { dimension: 'contractOverVisibleTests', ...zero },
      plan: { dimension: 'repositoryComprehension', ...zero },
      review: { dimension: 'regressionAvoidance', ...zero },
    });
  });

  it('maps every task type, and only to dimensions that exist', () => {
    expect(Object.keys(TASK_TAXONOMY).sort()).toEqual([...ALL_ORDRA_TASK_TYPES].sort());
    for (const row of Object.values(TASK_TAXONOMY)) expect(ALL_WORKSPACE_DIMENSIONS).toContain(row.dimension);
  });

  it('is documented, with every task type and its capability in the table', () => {
    const doc = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/task-taxonomy.md'), 'utf8');
    expect(doc).toContain(TASK_TAXONOMY_VERSION);
    for (const taskType of ALL_ORDRA_TASK_TYPES) {
      const row = TASK_TAXONOMY[taskType];
      expect(doc).toContain(`| \`${taskType}\` | \`workspace:${row.dimension}\` | \`${row.costPolicy}\` |`);
    }
  });
});

// ------------------------------------------------------------------ the function

describe('routeQueryForTask maps a pass to a crc2 query', () => {
  it('fills capability, tier, context, cost policy, locality and the subscription preference', () => {
    const answer = routeQueryForTask({ machineKey: MACHINE, taskType: 'fix', tier: 2, contextTokens: 64_000 });
    expect(answer).toEqual({
      ok: true, taxonomyVersion: 'ctt1', taskType: 'fix', row: TASK_TAXONOMY.fix,
      query: {
        machineKey: MACHINE, capability: 'workspace:failureInterpretation', structuralTier: 'tier2',
        minimumContextTokens: 64_000, costPolicy: 'zeroMarginalCostOnly', localOnly: false, preferSubscriptionOrFree: true,
      },
    });
  });

  it('answers every task type at every tier', () => {
    for (const taskType of ALL_ORDRA_TASK_TYPES) {
      for (const [tier, expected] of [[1, 'tier1'], ['2', 'tier2'], ['tier3', 'tier3']] as const) {
        const answer = routeQueryForTask({ machineKey: MACHINE, taskType, tier, contextTokens: '200000' });
        if (!answer.ok) throw new Error(answer.refusals.join('; '));
        expect(answer.query.capability).toBe(`workspace:${TASK_TAXONOMY[taskType].dimension}`);
        expect(answer.query.structuralTier).toBe(expected);
        expect(answer.query.minimumContextTokens).toBe(200_000);
      }
    }
  });

  it('refuses an unknown task type with a reason, never a default capability', () => {
    for (const taskType of ['deploy', '', 'Implement', 'workspace:multiFileEditing', 'test_repair']) {
      const reasons = refused(routeQueryForTask({ machineKey: MACHINE, taskType, tier: 1, contextTokens: 1000 }));
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain(`task type '${taskType}' is not in task taxonomy ctt1`);
      expect(reasons[0]).toContain('never mapped to a default capability');
    }
  });

  it('refuses an unknown or unreadable tier, never defaulting it', () => {
    for (const tier of [0, 4, 1.5, -1, '', 'tier4', 'two', '1e0', NaN]) {
      const reasons = refused(routeQueryForTask({ machineKey: MACHINE, taskType: 'implement', tier, contextTokens: 1000 }));
      expect(reasons).toEqual([`structural tier '${String(tier)}' is not one of 1, 2, 3; an unknown tier is refused, never defaulted`]);
    }
  });

  it('refuses a context requirement that is not a positive whole number of tokens', () => {
    for (const contextTokens of [0, -5, 1.5, NaN, Infinity, '', 'abc', '12k', '1e5', '-1']) {
      const reasons = refused(routeQueryForTask({ machineKey: MACHINE, taskType: 'implement', tier: 1, contextTokens }));
      expect(reasons).toEqual([`context requirement '${String(contextTokens)}' is not a positive whole number of tokens`]);
    }
  });

  it('names every refusal at once, and an empty machine key among them', () => {
    const reasons = refused(routeQueryForTask({ machineKey: ' ', taskType: 'ship', tier: 9, contextTokens: 'lots' }));
    expect(reasons).toHaveLength(4);
    expect(reasons.join('\n')).toMatch(/task type 'ship'[\s\S]*tier '9'[\s\S]*context requirement 'lots'[\s\S]*no machine key/);
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

function observe(root: string): void {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  appendObservations(root, [routeAvailabilityObservation({ routeKey: 'claudeCLI:claude-haiku-4-5', machineKey: MACHINE,
    machineLabel: 'fixture-host', observedAt, available: true, reason: 'signed in (fixture)' }, 'claudeCLI',
  'a fixture availability reading')], { origin: 'observedHere', receivedAt: observedAt });
}

describe('cernum candidates --task --tier --context', () => {
  it('declares --task and --context on candidates', () => {
    expect(acceptedOptions(commandSpec('candidates')!).map((option) => option.name))
      .toEqual(expect.arrayContaining(['task', 'tier', 'context']));
  });

  it('answers the mapped query, names the taxonomy, and writes nothing', async () => {
    const root = temporary();
    observe(root);
    const before = fs.readdirSync(root).sort();
    const result = await cernum('candidates', '--task', 'refactor', '--tier', '2', '--context', '32000',
      '--machine', MACHINE, '--root', root, '--json');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const set = JSON.parse(result.stdout) as RouteCandidateSet & { task: { taxonomyVersion: string; taskType: string } };
    expect(set.contract).toBe('crc2');
    expect(set.query).toMatchObject({ machineKey: MACHINE, capability: 'workspace:preservationUnderTransformation',
      structuralTier: 'tier2', minimumContextTokens: 32_000, costPolicy: 'zeroMarginalCostOnly', localOnly: false,
      preferSubscriptionOrFree: true });
    expect(set.task).toMatchObject({ taxonomyVersion: 'ctt1', taskType: 'refactor' });
    // No benchmark evidence in the fixture root: the route is excluded with its reasons, not silently absent.
    expect(set.candidates).toEqual([]);
    expect(set.excluded.map((entry) => entry.routeKey)).toEqual(['claudeCLI:claude-haiku-4-5']);
    expect(fs.readdirSync(root).sort()).toEqual(before);

    const text = await cernum('candidates', '--task', 'refactor', '--tier', '2', '--context', '32000',
      '--machine', MACHINE, '--root', root);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Task: refactor (task taxonomy ctt1) · at least 32000 context tokens');
    expect(text.stdout).toContain('Capability: workspace:preservationUnderTransformation at tier2');
  });

  it('refuses an unknown task type or tier with the reason and exit 2, reading nothing', async () => {
    const root = temporary();
    const unknownTask = await cernum('candidates', '--task', 'deploy', '--tier', '1', '--context', '1000', '--machine', MACHINE, '--root', root);
    expect(unknownTask.status).toBe(2);
    expect(unknownTask.stderr).toContain("task type 'deploy' is not in task taxonomy ctt1");
    expect(unknownTask.stdout).toBe('');

    const unknownTier = await cernum('candidates', '--task', 'fix', '--tier', '4', '--context', '1000', '--machine', MACHINE, '--root', root);
    expect(unknownTier.status).toBe(2);
    expect(unknownTier.stderr).toContain("structural tier '4' is not one of 1, 2, 3");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses a missing tier or context, and flags the table decides, rather than defaulting or mixing them', async () => {
    const root = temporary();
    const missing = await cernum('candidates', '--task', 'fix', '--machine', MACHINE, '--root', root);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--task needs --tier and --context; nothing is defaulted');

    const clash = await cernum('candidates', 'workspace:toolUse', '--task', 'fix', '--tier', '1', '--context', '1000',
      '--cost-policy', 'metered', '--machine', MACHINE, '--root', root);
    expect(clash.status).toBe(2);
    expect(clash.stderr).toContain('<capability>, cost-policy cannot be given beside it');

    const stray = await cernum('candidates', 'workspace:toolUse', '--context', '1000', '--machine', MACHINE, '--root', root);
    expect(stray.status).toBe(2);
    expect(stray.stderr).toContain('--context is the context requirement of a --task');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
