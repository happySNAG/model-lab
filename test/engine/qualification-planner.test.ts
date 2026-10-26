// The qualification request planner (cqn1): from the release report, the discovery delta and qualification
// history, one bounded request per route — smoke first, the discriminator matrix only after a passing
// smoke — each charged against an explicit, sealed request-budget ledger that refuses past the budget.
//
// FIXTURES ONLY. The snapshots and the alias statement are files under fixtures/model-lifecycle, the
// histories are values built here, and every ledger and request file lives in a temporary directory. The
// command is spawned with --machine and --root and with the network tripwire preloaded, so nothing reads
// this Mac's identity or campaign root and any connection is refused. Nothing here runs a request.

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveDiscoveryDelta } from '../../src/engine/discovery-delta';
import { DiscoverySnapshot } from '../../src/engine/discovery-refresh';
import { AliasStatement } from '../../src/engine/model-description';
import { appendObservations, discoverySnapshotObservation } from '../../src/engine/observation-store';
import { QualificationHistory } from '../../src/engine/qualification-history';
import {
  IDENTITY_SMOKE_BENCHMARK, QUALIFICATION_PLAN_SCHEMA, QUALIFICATION_REQUEST_SCHEMA, QualificationPlan,
  QualificationPlanError, QualificationPlanInputs, QualificationRequest, QualificationSmokeResult, RENEWAL_WINDOW_MILLISECONDS,
  deriveQualificationPlan, describeQualificationPlan, qualificationRequestDirectory, readRequestBudgetLedger,
  requestBudgetLedgerPath, stateRequestBudget, writeQualificationPlan,
} from '../../src/engine/qualification-planner';
import { deriveReleaseReport, readReleaseLedger, recordReleaseReport } from '../../src/engine/release-report';
import { WORKSPACE_PACK_DISCRIMINATOR_ONE, discriminatorOnePack } from '../../src/engine/workspace-catalog';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPOSITORY, 'fixtures', 'model-lifecycle');
const PRELOAD = path.join(__dirname, 'fixtures', 'no-network-preload.cjs');
const BEFORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot-2026-10-20.json'), 'utf8')) as DiscoverySnapshot;
const AFTER = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'snapshot-2026-10-25.json'), 'utf8')) as DiscoverySnapshot;
const ALIASES_FILE = path.join(FIXTURES, 'aliases.json');
const ALIASES = (JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) as { aliases: AliasStatement[] }).aliases;
const MACHINE = AFTER.machineKey;
const NOW = new Date('2026-10-26T00:00:00Z');
const DISCRIMINATOR_RUNS = discriminatorOnePack.caseIDs.length * discriminatorOnePack.repeatsPerCase;

const temporaries: string[] = [];
afterAll(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/** One route's history as a value: a single verdict resting on evidence up to `evidenceTo`. */
function history(routeKey: string, verdict: 'safeToRoute' | 'notRoutable', evidenceTo: string): QualificationHistory {
  const at = routeKey.indexOf(':');
  return {
    schema: 'cqh1', routeKey, provider: routeKey.slice(0, at) as QualificationHistory['provider'], modelID: routeKey.slice(at + 1),
    effort: 'any', machineKey: MACHINE,
    entries: [{
      recordedAt: evidenceTo, policyID: 'cqp1', routingPolicyVersion: 'crp2', verdict, routableCapabilities: [], capabilities: [],
      blockers: [], evidenceWindow: { from: evidenceTo, to: evidenceTo, workspaceRuns: 3, observations: 1 },
      triggeredBy: [], stalenessRecorded: [], changed: true,
    }],
    undatedWorkspaceRuns: [], corrupt: [], disclosure: 'fixture history',
  };
}

/** A release ledger that already told about every model the earlier snapshot listed. */
function releaseRootAfterBefore(): string {
  const root = temporary('cernum-planner-release-');
  recordReleaseReport(root, deriveReleaseReport({ snapshot: BEFORE, ledger: readReleaseLedger(root), aliases: ALIASES }),
    { reportedAt: '2026-10-20T00:05:00Z' });
  return root;
}

const HISTORIES = [
  // Safe, on evidence to 30 September: under cqp1's 30 days it expires 30 October, within 7 days of NOW.
  history('claudeCLI:claude-haiku-4-5', 'safeToRoute', '2026-09-30T00:00:00Z'),
  // Safe on evidence to 22 October; the only change since is a newly listed alias, which stales nothing.
  history('claudeCLI:claude-sonnet-4-5', 'safeToRoute', '2026-10-22T00:00:00Z'),
  // Safe on evidence to 22 October; the CLI's runtime version moved on 25 October, which stales it.
  history('codexCLI:gpt-5-codex', 'safeToRoute', '2026-10-22T00:00:00Z'),
];
const SMOKES: QualificationSmokeResult[] = [
  { routeKey: 'codexCLI:gpt-5.1-codex', outcome: 'passed', observedAt: '2026-10-25T12:00:00Z', source: 'fixture smoke record' },
];

function inputs(budget: number | undefined, extra: Partial<QualificationPlanInputs> = {}): QualificationPlanInputs {
  const releaseRoot = releaseRootAfterBefore();
  return {
    now: NOW, machineKey: MACHINE,
    releaseReport: deriveReleaseReport({ snapshot: AFTER, ledger: readReleaseLedger(releaseRoot), aliases: ALIASES }),
    delta: deriveDiscoveryDelta(BEFORE, AFTER, { aliases: ALIASES }),
    snapshot: AFTER,
    histories: HISTORIES,
    ledger: { records: [], corrupt: [], ...(budget === undefined ? {} : { budget }), used: 0, ledgerDigest: 'fixture' },
    smokeResults: SMOKES,
    ...extra,
  };
}
const planned = (plan: QualificationPlan) => plan.requests.map((request) => [request.routeKey, request.stage, request.trigger.kind]);
const skippedAs = (plan: QualificationPlan) => Object.fromEntries(plan.skipped.map((entry) => [entry.routeKey, entry.reason]));

// ------------------------------------------------------------------ deciding

describe('qualification planner cqn1 · one bounded request per route', () => {
  it('plans a renewal, a changed route and the new releases — smoke first, the discriminator only after a passing smoke', () => {
    const plan = deriveQualificationPlan(inputs(21));
    expect(plan.schema).toBe(QUALIFICATION_PLAN_SCHEMA);
    // Renewals are charged first, then changed routes, then new models, each group by route key.
    expect(planned(plan)).toEqual([
      ['claudeCLI:claude-haiku-4-5', 'smoke', 'renewal'],
      ['codexCLI:gpt-5-codex', 'smoke', 'changed'],
      ['claudeCLI:claude-opus-5', 'smoke', 'new'],
      ['codexCLI:gpt-5.1-codex', 'discriminator', 'new'],
    ]);
    // One request per route.
    expect(new Set(plan.requests.map((request) => request.routeKey)).size).toBe(plan.requests.length);
    expect(plan.ledgerBefore).toEqual({ budget: 21, used: 0, remaining: 21, chargedByThisPlan: 0 });
    expect(plan.ledger).toEqual({ budget: 21, used: 3 + DISCRIMINATOR_RUNS, remaining: 0, chargedByThisPlan: 3 + DISCRIMINATOR_RUNS });
  });

  it('stores the benchmark version, the bound and the expiry in every request, and asks for an owner\'s approval', () => {
    const plan = deriveQualificationPlan(inputs(21));
    for (const request of plan.requests) {
      expect(request.schema).toBe(QUALIFICATION_REQUEST_SCHEMA);
      expect(request.requiresOwnerApproval).toBe(true);
      expect(request.costEligibility).toBe('subscription_included');
      expect(request.qualificationPolicyID).toBe('cqp1');
      expect(request.plannedAt).toBe('2026-10-26T00:00:00Z');
      expect(request.expiresAt).toBe('2026-11-02T00:00:00Z');
      expect(request.runCount).toBe(Math.max(request.caseIDs.length, 1) * request.repeatsPerCase);
    }
    const smoke = plan.requests.find((request) => request.routeKey === 'claudeCLI:claude-opus-5')!;
    expect(smoke.benchmark).toEqual({ id: IDENTITY_SMOKE_BENCHMARK.id, version: IDENTITY_SMOKE_BENCHMARK.version });
    expect(smoke.runCount).toBe(1);
    expect(smoke.caseIDs).toEqual([]);
    const matrix = plan.requests.find((request) => request.stage === 'discriminator')!;
    expect(matrix.benchmark).toEqual({ id: WORKSPACE_PACK_DISCRIMINATOR_ONE, version: discriminatorOnePack.version });
    expect(matrix.caseIDs).toEqual(discriminatorOnePack.caseIDs);
    expect(matrix.runCount).toBe(DISCRIMINATOR_RUNS);
    expect(matrix.trigger.detail.join(' ')).toContain('identity smoke passed at 2026-10-25T12:00:00Z');
    const renewal = plan.requests.find((request) => request.trigger.kind === 'renewal')!;
    expect(renewal.qualificationExpiresAt).toBe('2026-10-30T00:00:00Z');
  });

  it('does not re-plan an unchanged route with current evidence, nor one whose change stales nothing', () => {
    const plan = deriveQualificationPlan(inputs(21));
    expect(skippedAs(plan)['claudeCLI:claude-sonnet-4-5']).toBe('evidenceCurrent');
    // Evidence alone, current and far from expiry, with nothing new or changed naming the route.
    const quiet = deriveQualificationPlan(inputs(21, { releaseReport: undefined, delta: undefined, smokeResults: [],
      histories: [history('claudeCLI:claude-sonnet-4-5', 'safeToRoute', '2026-10-22T00:00:00Z')] }));
    expect(quiet.requests).toEqual([]);
    expect(quiet.skipped).toEqual([expect.objectContaining({ routeKey: 'claudeCLI:claude-sonnet-4-5', reason: 'evidenceCurrent' })]);
    expect(quiet.ledger.used).toBe(0);
  });

  it('plans a renewal exactly when the qualification expires within 7 days, and for one already expired', () => {
    const at = (evidenceTo: string) => deriveQualificationPlan(inputs(5, { releaseReport: undefined, delta: undefined, smokeResults: [],
      histories: [history('claudeCLI:claude-haiku-4-5', 'safeToRoute', evidenceTo)] }));
    // Expires 2 November 00:00:01, just outside the window.
    expect(at('2026-10-03T00:00:01Z').requests).toEqual([]);
    // Expires 2 November 00:00:00, exactly 7 days out.
    expect(planned(at('2026-10-03T00:00:00Z'))).toEqual([['claudeCLI:claude-haiku-4-5', 'smoke', 'renewal']]);
    // Expired on 21 October.
    const expired = at('2026-09-21T00:00:00Z');
    expect(planned(expired)).toEqual([['claudeCLI:claude-haiku-4-5', 'smoke', 'renewal']]);
    expect(expired.requests[0].trigger.detail[0]).toContain('expired');
    expect(RENEWAL_WINDOW_MILLISECONDS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('never plans a metered route, whatever triggers it', () => {
    // An empty release ledger reports opencode's big-pickle as new; opencode is billed per token.
    const plan = deriveQualificationPlan(inputs(100, {
      releaseReport: deriveReleaseReport({ snapshot: AFTER, ledger: readReleaseLedger(temporary('cernum-planner-empty-')), aliases: ALIASES }),
      histories: [...HISTORIES, history('anthropicAPI:claude-sonnet-4-5', 'safeToRoute', '2026-09-30T00:00:00Z')],
    }));
    expect(skippedAs(plan)['opencodeCLI:opencode/big-pickle']).toBe('metered');
    expect(skippedAs(plan)['anthropicAPI:claude-sonnet-4-5']).toBe('metered');
    expect(plan.requests.map((request) => request.provider)).not.toContain('opencodeCLI');
    expect(plan.requests.map((request) => request.provider)).not.toContain('anthropicAPI');
    expect(plan.requests.every((request) => request.costEligibility !== 'metered')).toBe(true);
  });

  it('plans nothing for a route that is not reachable or whose smoke did not pass', () => {
    const refusedListing: DiscoverySnapshot = { ...AFTER, routes: AFTER.routes.map((route) =>
      route.routeKey === 'claudeCLI:claude-opus-5' ? { ...route, availability: 'refused' as const } : route) };
    const plan = deriveQualificationPlan(inputs(21, {
      snapshot: refusedListing,
      smokeResults: [
        { routeKey: 'codexCLI:gpt-5.1-codex', outcome: 'refused', observedAt: '2026-10-25T12:00:00Z', source: 'fixture' },
        { routeKey: 'codexCLI:gpt-5-codex', outcome: 'failed', observedAt: '2026-10-25T13:00:00Z', source: 'fixture' },
      ],
    }));
    expect(skippedAs(plan)).toMatchObject({
      'claudeCLI:claude-opus-5': 'notReachable', 'codexCLI:gpt-5.1-codex': 'notReachable', 'codexCLI:gpt-5-codex': 'smokeDidNotPass',
    });
    expect(planned(plan)).toEqual([['claudeCLI:claude-haiku-4-5', 'smoke', 'renewal']]);
  });

  it('does not count a smoke older than the trigger: the route is smoke-tested again first', () => {
    const plan = deriveQualificationPlan(inputs(21, { smokeResults: [
      { routeKey: 'codexCLI:gpt-5.1-codex', outcome: 'passed', observedAt: '2026-10-24T00:00:00Z', source: 'before it was listed' },
    ] }));
    expect(plan.requests.find((request) => request.routeKey === 'codexCLI:gpt-5.1-codex')!.stage).toBe('smoke');
  });

  it('refuses a request that does not fit in what remains, whole and never shrunk, and charges the rest', () => {
    const plan = deriveQualificationPlan(inputs(20));
    expect(planned(plan)).toEqual([
      ['claudeCLI:claude-haiku-4-5', 'smoke', 'renewal'], ['codexCLI:gpt-5-codex', 'smoke', 'changed'],
      ['claudeCLI:claude-opus-5', 'smoke', 'new'],
    ]);
    const refused = plan.skipped.find((entry) => entry.routeKey === 'codexCLI:gpt-5.1-codex')!;
    expect(refused).toMatchObject({ reason: 'budgetExhausted', stage: 'discriminator', runCount: DISCRIMINATOR_RUNS });
    expect(plan.ledger).toEqual({ budget: 20, used: 3, remaining: 17, chargedByThisPlan: 3 });

    const spent = deriveQualificationPlan(inputs(30, { ledger: { records: [], corrupt: [], budget: 30, used: 30, ledgerDigest: 'x' } }));
    expect(spent.requests).toEqual([]);
    expect(spent.skipped.filter((entry) => entry.reason === 'budgetExhausted')).toHaveLength(4);
    expect(spent.ledger).toEqual({ budget: 30, used: 30, remaining: 0, chargedByThisPlan: 0 });
  });

  it('refuses to plan against no stated budget or a ledger that did not verify', () => {
    expect(() => deriveQualificationPlan(inputs(undefined))).toThrow(QualificationPlanError);
    expect(() => deriveQualificationPlan(inputs(5, { ledger: { records: [], corrupt: [{ line: 1, reason: 'x' }], budget: 5, used: 0,
      ledgerDigest: 'x' } }))).toThrow(/did not verify/);
  });

  it('is pure: the same inputs give the same plan, and nothing is written or run', () => {
    const fixed = inputs(21);
    expect(deriveQualificationPlan(fixed)).toEqual(deriveQualificationPlan(fixed));
    expect(describeQualificationPlan(deriveQualificationPlan(fixed)).join('\n')).toContain('PLANNED (not run');
  });
});

// ------------------------------------------------------------------ writing and the ledger

describe('qualification planner cqn1 · request files and the sealed budget ledger', () => {
  function plannedRoot(budget: number): string {
    const root = temporary('cernum-planner-write-');
    stateRequestBudget(root, { budget, statedAt: '2026-10-26T00:00:00Z', statedBy: 'fixture owner', reason: 'fixture budget' });
    return root;
  }

  it('writes one file per request and charges each on the ledger; a second plan charges nothing again', () => {
    const root = plannedRoot(21);
    const plan = deriveQualificationPlan(inputs(21, { ledger: readRequestBudgetLedger(root) }));
    const written = writeQualificationPlan(root, plan);
    expect(written.files).toHaveLength(4);
    for (const file of written.files) {
      expect(path.dirname(file)).toBe(path.join(qualificationRequestDirectory(root), 'requests'));
      const request = JSON.parse(fs.readFileSync(file, 'utf8')) as QualificationRequest;
      expect(request.benchmark.version).toMatch(/^\d+$/);
      expect(request.expiresAt).toBe('2026-11-02T00:00:00Z');
    }
    const ledger = readRequestBudgetLedger(root);
    expect(ledger.corrupt).toEqual([]);
    expect(ledger.records.map((record) => record.kind)).toEqual(['budget', 'charge', 'charge', 'charge', 'charge']);
    expect({ budget: ledger.budget, used: ledger.used }).toEqual({ budget: 21, used: 3 + DISCRIMINATOR_RUNS });

    const again = deriveQualificationPlan(inputs(21, { ledger }));
    expect(again.requests).toEqual([]);
    expect(again.skipped.filter((entry) => entry.reason === 'alreadyPlanned').map((entry) => entry.routeKey).sort()).toEqual([
      'claudeCLI:claude-haiku-4-5', 'claudeCLI:claude-opus-5', 'codexCLI:gpt-5-codex', 'codexCLI:gpt-5.1-codex',
    ]);
    expect(writeQualificationPlan(root, again)).toEqual({ files: [], charged: [] });
    expect(readRequestBudgetLedger(root).records).toHaveLength(5);
  });

  it('carries a planned smoke forward: once it passes, the discriminator is planned even after the model stops being new', () => {
    const root = plannedRoot(40);
    writeQualificationPlan(root, deriveQualificationPlan(inputs(40, { ledger: readRequestBudgetLedger(root) })));
    const later = deriveQualificationPlan({
      now: new Date('2026-10-27T00:00:00Z'), machineKey: MACHINE, histories: [], ledger: readRequestBudgetLedger(root),
      smokeResults: [{ routeKey: 'claudeCLI:claude-opus-5', outcome: 'passed', observedAt: '2026-10-26T06:00:00Z', source: 'fixture' }],
    });
    const matrix = later.requests.find((request) => request.routeKey === 'claudeCLI:claude-opus-5')!;
    expect(matrix.stage).toBe('discriminator');
    expect(matrix.trigger).toMatchObject({ kind: 'new', carriedFromLedger: true });
    // The other two smokes have not passed: their requests are still valid, so nothing is charged again.
    expect(later.requests).toHaveLength(1);
    expect(later.ledger.chargedByThisPlan).toBe(DISCRIMINATOR_RUNS);
  });

  it('refuses a ledger that moved since the plan, and a tampered ledger, writing nothing', () => {
    const root = plannedRoot(21);
    const plan = deriveQualificationPlan(inputs(21, { ledger: readRequestBudgetLedger(root) }));
    stateRequestBudget(root, { budget: 25, statedAt: '2026-10-26T00:01:00Z', statedBy: 'fixture owner', reason: 'raised' });
    expect(() => writeQualificationPlan(root, plan)).toThrow(/changed since this plan was derived/);
    expect(fs.existsSync(path.join(qualificationRequestDirectory(root), 'requests'))).toBe(false);

    const file = requestBudgetLedgerPath(root);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"budget":25', '"budget":2500'));
    const bytes = fs.readFileSync(file, 'utf8');
    const tampered = readRequestBudgetLedger(root);
    expect(tampered.corrupt).toHaveLength(1);
    expect(tampered.budget).toBe(21);
    expect(() => writeQualificationPlan(root, plan)).toThrow(/did not verify/);
    expect(() => stateRequestBudget(root, { budget: 1, statedAt: 'x', statedBy: 'y', reason: 'z' })).toThrow(QualificationPlanError);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

// ------------------------------------------------------------------ the command

function cernum(networkLog: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPOSITORY, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', ...args], {
      cwd: REPOSITORY,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CERNUM_NETWORK_LOG: networkLog },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const networkUse = (log: string): string[] => (!fs.existsSync(log) ? []
  : fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0 && !/ ipc /.test(line)));

describe('cernum plan-qualification', () => {
  function storeWith(...snapshots: DiscoverySnapshot[]): string {
    const root = temporary('cernum-planner-cli-');
    appendObservations(root, snapshots.map((snapshot) => discoverySnapshotObservation(snapshot, 'fixture-mac', 'fixture snapshot')),
      { origin: 'observedHere', receivedAt: '2026-10-25T00:00:01Z' });
    return root;
  }

  it('is declared with --json, --write, --budget, --smoke-results, --aliases and --machine', () => {
    const spec = commandSpec('plan-qualification')!;
    expect(spec.effect).toBe('writesLocal');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(
      expect.arrayContaining(['json', 'write', 'budget', 'smoke-results', 'aliases', 'machine', 'root', 'help']));
  });

  it('plans as JSON and writes nothing without --write; with it, writes the files and charges the ledger; contacts nothing', async () => {
    const root = storeWith(BEFORE, AFTER);
    const networkLog = path.join(temporary('cernum-planner-net-'), 'network.log');
    const noBudget = await cernum(networkLog, 'plan-qualification', '--json', '--machine', MACHINE, '--root', root);
    expect(noBudget.status).toBe(2);
    expect(noBudget.stderr).toContain('states no budget');

    const preview = await cernum(networkLog, 'plan-qualification', '--json', '--budget', '4', '--machine', MACHINE, '--root', root,
      '--aliases', ALIASES_FILE);
    expect(preview.stderr).toBe('');
    expect(preview.status).toBe(0);
    const shown = JSON.parse(preview.stdout) as QualificationPlan;
    expect(shown.schema).toBe(QUALIFICATION_PLAN_SCHEMA);
    // Five Claude and Codex models, each a smoke of one run, against a budget of four: the fifth is refused.
    expect(shown.requests.every((request) => request.stage === 'smoke')).toBe(true);
    expect(shown.requests).toHaveLength(4);
    expect(shown.skipped.filter((entry) => entry.reason === 'budgetExhausted')).toHaveLength(1);
    expect(shown.skipped.find((entry) => entry.routeKey === 'opencodeCLI:opencode/big-pickle')?.reason).toBe('metered');
    expect(shown.ledger).toMatchObject({ budget: 4, used: 4, remaining: 0 });
    expect(fs.existsSync(qualificationRequestDirectory(root))).toBe(false);

    const written = await cernum(networkLog, 'plan-qualification', '--json', '--write', '--budget', '5', '--machine', MACHINE,
      '--root', root, '--aliases', ALIASES_FILE);
    expect(written.status).toBe(0);
    const result = JSON.parse(written.stdout) as QualificationPlan & { written: { files: string[] } };
    expect(result.written.files).toHaveLength(5);
    expect(result.written.files.every((file) => fs.existsSync(file))).toBe(true);
    const ledger = readRequestBudgetLedger(root);
    expect({ budget: ledger.budget, used: ledger.used }).toEqual({ budget: 5, used: 5 });

    const again = await cernum(networkLog, 'plan-qualification', '--write', '--machine', MACHINE, '--root', root, '--aliases', ALIASES_FILE);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Nothing to write; the ledger is unchanged.');
    expect(readRequestBudgetLedger(root).records).toHaveLength(6);
    expect(networkUse(networkLog)).toEqual([]);
  }, 180_000);

  it('exits 4 on a tampered budget ledger and writes nothing', async () => {
    const root = storeWith(AFTER);
    stateRequestBudget(root, { budget: 3, statedAt: '2026-10-26T00:00:00Z', statedBy: 'fixture owner', reason: 'fixture' });
    const file = requestBudgetLedgerPath(root);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"budget":3', '"budget":300'));
    const bytes = fs.readFileSync(file, 'utf8');
    const networkLog = path.join(temporary('cernum-planner-net-'), 'network.log');
    const tampered = await cernum(networkLog, 'plan-qualification', '--write', '--machine', MACHINE, '--root', root);
    expect(tampered.status).toBe(4);
    expect(tampered.stderr).toContain('did not verify');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.existsSync(path.join(qualificationRequestDirectory(root), 'requests'))).toBe(false);
    expect(networkUse(networkLog)).toEqual([]);
  }, 120_000);
});
