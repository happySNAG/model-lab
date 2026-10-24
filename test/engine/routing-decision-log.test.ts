// Cernum · the routing decision log: every `candidates` answer can be appended as a sealed, digested,
// append-only record of the query, the answer, the policy versions and the reason the answer moved
// since the previous one to the same query — and a record that was tampered with is refused.
//
// Fixtures only. The engine is driven with hand-built candidate sets over fixed instants; the command
// is spawned against a temporary root holding fixture observations, with --machine so nothing reads
// this Mac's identity. Nothing contacts a model, a provider or the network.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { digestObject } from '../../src/engine/canonical';
import { appendObservations, routeAvailabilityObservation } from '../../src/engine/observation-store';
import { RouteCandidate, RouteCandidateQuery, RouteCandidateSet } from '../../src/engine/routing-contract';
import {
  ROUTING_DECISION_LOG_SCHEMA, RoutingDecisionLogContents, RoutingDecisionLogError, RoutingDecisionRecord,
  appendRoutingDecision, decisionsForQuery, readRoutingDecisionLog, routingDecisionLogPath, routingQueryDigest,
  sealRoutingDecision, verifyRoutingDecisionRecord,
} from '../../src/engine/routing-decision-log';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const MACHINE = 'cmk1:decision-log-machine';
const CAPABILITY = 'workspace:multiFileEditing';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-decision-log-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

function query(overrides: Partial<RouteCandidateQuery> = {}): RouteCandidateQuery {
  return { machineKey: MACHINE, capability: CAPABILITY, costPolicy: 'allowMeteredWithAuthorization',
    requireVerifiedIdentity: false, routingPolicyVersion: 'crp2', ...overrides };
}

/** A candidate carrying only what the log reads. The full record is not needed to log an answer. */
function candidate(routeKey: string, group: RouteCandidate['group'] = 'zeroMarginalCost'): RouteCandidate {
  return {
    routeKey, group, locality: 'remote', identityConfidence: 'verified', identityAdmitted: false,
    availability: { state: 'available', observedOnMachine: MACHINE, machineLabel: 'fixture-host', origin: 'observedHere', reason: 'fixture' },
    capabilityEvidence: { capability: CAPABILITY, verdict: 'qualified', reason: `3/3 scored runs of ${routeKey} passed (fixture)` },
    record: { policy: { policyID: 'cqp1' } },
  } as unknown as RouteCandidate;
}

function answer(candidates: RouteCandidate[], excluded: RouteCandidateSet['excluded'] = [],
                q: RouteCandidateQuery = query()): RouteCandidateSet {
  const groupRank = (entry: RouteCandidate) => (entry.group === 'zeroMarginalCost' ? 0 : 1);
  return {
    contract: 'crc2', query: q, routingPolicyVersion: q.routingPolicyVersion ?? 'crp2',
    candidates: [...candidates].sort((a, b) => groupRank(a) - groupRank(b) || (a.routeKey < b.routeKey ? -1 : 1)),
    excluded, ordering: 'zero-marginal-cost group first, then route key; NO preference within a group',
    disclosure: 'fixture',
  };
}

const at = (minute: number) => new Date(Date.parse('2026-10-24T09:00:00Z') + minute * 60_000).toISOString();
const append = (root: string, set: RouteCandidateSet, minute: number) =>
  appendRoutingDecision(root, set, { decidedAt: at(minute), provenance: 'a fixture answer' });

function logFiles(root: string): string[] {
  const directory = routingDecisionLogPath(root);
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function rewrite(filePath: string, edit: (record: RoutingDecisionRecord) => RoutingDecisionRecord): void {
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RoutingDecisionRecord;
  fs.writeFileSync(filePath, JSON.stringify(edit(record), null, 2) + '\n');
}

// ------------------------------------------------------------------ the record

describe('each answer is a sealed, digested record of the query, the answer and the policy versions', () => {
  it('records the query, the answer, the routing contract, routing and qualification policies, and the time', () => {
    const root = temporary();
    const set = answer([candidate('claudeCLI:claude-haiku-4-5')],
      [{ routeKey: 'ollama:gemma3:4b', reasons: ['capability: no evidence at all for workspace:multiFileEditing'] }]);
    const { record, written, filePath } = append(root, set, 0);
    expect(written).toBe(true);
    expect(record.schema).toBe(ROUTING_DECISION_LOG_SCHEMA);
    expect(path.basename(filePath)).toBe(`${record.recordID}.json`);
    expect(record.decidedAt).toBe(at(0));
    expect(record.machineKey).toBe(MACHINE);
    expect(record.query).toEqual(set.query);
    expect(record.queryDigest).toBe(routingQueryDigest(set.query));
    expect(record.policies).toEqual({ routingContract: 'crc2', routingPolicy: 'crp2', qualificationPolicies: ['cqp1'] });
    expect(record.answer.candidates).toEqual([expect.objectContaining({
      routeKey: 'claudeCLI:claude-haiku-4-5', position: 0, group: 'zeroMarginalCost', capabilityVerdict: 'qualified',
      qualificationPolicyID: 'cqp1', availabilityState: 'available',
    })]);
    expect(record.answer.excluded).toEqual(set.excluded);
    expect(record.previousDecisionID).toBeUndefined();
    expect(record.change.basis).toBe('firstAnswer');

    // The identity IS the content: every field but recordID is under the digest.
    expect(verifyRoutingDecisionRecord(record)).toEqual({ intact: true, reason: 'the content digests to its own recordID' });
    const { recordID: _id, ...rest } = record;
    expect(sealRoutingDecision(rest).recordID).toBe(record.recordID);
    const log = readRoutingDecisionLog(root);
    expect(log.corrupt).toEqual([]);
    expect(log.decisions).toEqual([record]);
    expect(log.logDigest).toBe(digestObject([record.recordID]));
  });

  it('is append-only: a later answer is a new record naming the one before, and the earlier file is untouched', () => {
    const root = temporary();
    const first = append(root, answer([candidate('claudeCLI:claude-haiku-4-5')]), 0);
    const bytes = fs.readFileSync(first.filePath);
    const second = append(root, answer([candidate('claudeCLI:claude-haiku-4-5')]), 5);
    expect(second.written).toBe(true);
    expect(second.record.recordID).not.toBe(first.record.recordID);
    expect(second.record.previousDecisionID).toBe(first.record.recordID);
    expect(second.record.change).toEqual({ basis: 'unchanged', added: [], removed: [], reordered: [], policyChanges: [], exclusionsChanged: 0 });
    expect(fs.readFileSync(first.filePath)).toEqual(bytes);
    expect(logFiles(root)).toHaveLength(2);
    expect(readRoutingDecisionLog(root).decisions.map((record) => record.recordID)).toEqual([first.record.recordID, second.record.recordID]);
  });

  it('keeps one chain per query, and treats the routing policy version as a property of the answer, not of the query', () => {
    const root = temporary();
    const a = append(root, answer([candidate('claudeCLI:claude-haiku-4-5')]), 0);
    const other = append(root, answer([], [], query({ capability: 'workspace:debugging' })), 1);
    expect(other.record.change.basis).toBe('firstAnswer');
    expect(other.record.queryDigest).not.toBe(a.record.queryDigest);
    const underCrp1 = append(root, answer([candidate('claudeCLI:claude-haiku-4-5')], [], query({ routingPolicyVersion: 'crp1' })), 2);
    expect(underCrp1.record.queryDigest).toBe(a.record.queryDigest);
    expect(underCrp1.record.previousDecisionID).toBe(a.record.recordID);
    expect(underCrp1.record.change.basis).toBe('changed');
    expect(underCrp1.record.change.policyChanges).toEqual([{ policy: 'routingPolicy', from: 'crp2', to: 'crp1' }]);
    expect(decisionsForQuery(readRoutingDecisionLog(root), a.record.queryDigest)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ the reason for a change

describe('the reason for any change from the previous answer to the same query', () => {
  it('names every route added, removed or reordered, with its cause', () => {
    const root = temporary();
    append(root, answer(
      [candidate('claudeCLI:claude-haiku-4-5'), candidate('codexCLI:gpt-5-codex'), candidate('opencodeCLI:opencode/big-pickle', 'meteredRequiresAuthorization')],
      [{ routeKey: 'ollama:gemma3:4b', reasons: ['capability: workspace:multiFileEditing is insufficientEvidence — 2 scored run(s)'] }]), 0);
    const next = append(root, answer(
      [
        candidate('claudeCLI:claude-haiku-4-5', 'meteredRequiresAuthorization'),
        candidate('codexCLI:gpt-5-codex'),
        candidate('ollama:gemma3:4b'),
        candidate('anthropicAPI:claude-sonnet-4-5', 'meteredRequiresAuthorization'),
      ],
      [{ routeKey: 'opencodeCLI:opencode/big-pickle', reasons: ['availability: signed out (fixture)'] }]), 10);
    const change = next.record.change;
    expect(change.basis).toBe('changed');
    expect(change.added.map((entry) => entry.routeKey).sort()).toEqual(['anthropicAPI:claude-sonnet-4-5', 'ollama:gemma3:4b']);
    const gemma = change.added.find((entry) => entry.routeKey === 'ollama:gemma3:4b')!;
    expect(gemma.causes[0]).toBe('previously excluded: capability: workspace:multiFileEditing is insufficientEvidence — 2 scored run(s)');
    expect(gemma.causes[1]).toMatch(/^now qualified: 3\/3 scored runs/);
    const sonnet = change.added.find((entry) => entry.routeKey === 'anthropicAPI:claude-sonnet-4-5')!;
    expect(sonnet.causes[0]).toContain('not considered in the previous answer');
    expect(change.removed).toEqual([{ routeKey: 'opencodeCLI:opencode/big-pickle', previousPosition: 2,
      causes: ['now excluded: availability: signed out (fixture)'] }]);
    // Haiku moved from first to after codex and gemma because its OWN group changed; codex moved
    // relative to it, because of it. Gemma's arrival alone reorders nothing.
    expect(change.reordered).toEqual([
      { routeKey: 'codexCLI:gpt-5-codex', from: 1, to: 0, causes: ['moved relative to claudeCLI:claude-haiku-4-5, whose group changed'] },
      { routeKey: 'claudeCLI:claude-haiku-4-5', from: 0, to: 3,
        causes: ['its group changed from zeroMarginalCost to meteredRequiresAuthorization'] },
    ]);
    expect(change.exclusionsChanged).toBe(2);
    expect(readRoutingDecisionLog(root).corrupt).toEqual([]);
  });

  it('does not call an insertion a reorder, and states a route that is no longer considered at all', () => {
    const root = temporary();
    append(root, answer([candidate('codexCLI:gpt-5-codex'), candidate('ollama:qwen3:8b')]), 0);
    const next = append(root, answer([candidate('claudeCLI:claude-haiku-4-5'), candidate('codexCLI:gpt-5-codex')]), 1);
    expect(next.record.change.reordered).toEqual([]);
    expect(next.record.change.added.map((entry) => entry.routeKey)).toEqual(['claudeCLI:claude-haiku-4-5']);
    expect(next.record.change.removed).toEqual([{ routeKey: 'ollama:qwen3:8b', previousPosition: 1,
      causes: ['no longer considered: it has no availability observation on this machine now'] }]);
  });

  it('carries a policy change into the cause of every route it moved', () => {
    const root = temporary();
    append(root, answer([], [{ routeKey: 'codexCLI:gpt-5-codex', reasons: ['identity: crp1 does not route identity-unverifiable routes'] }],
      query({ routingPolicyVersion: 'crp1' })), 0);
    const next = append(root, answer([candidate('codexCLI:gpt-5-codex')], [], query({ routingPolicyVersion: 'crp2' })), 1);
    expect(next.record.policies.routingPolicy).toBe('crp2');
    expect(next.record.change.policyChanges).toEqual([{ policy: 'routingPolicy', from: 'crp1', to: 'crp2' }]);
    expect(next.record.change.added[0].causes).toEqual([
      'previously excluded: identity: crp1 does not route identity-unverifiable routes',
      'now qualified: 3/3 scored runs of codexCLI:gpt-5-codex passed (fixture)',
      'routingPolicy changed from crp1 to crp2',
    ]);
  });

  it('refuses an answer dated before the previous answer to the same query, writing nothing', () => {
    const root = temporary();
    append(root, answer([]), 10);
    expect(() => append(root, answer([]), 5)).toThrow(RoutingDecisionLogError);
    expect(() => append(root, answer([]), 5)).toThrow(/before the previous answer/);
    expect(logFiles(root)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ tampering

describe('a tampered record is detected and refused', () => {
  function threeAnswers(): { root: string; ids: string[]; paths: string[] } {
    const root = temporary();
    const outcomes = [
      append(root, answer([candidate('claudeCLI:claude-haiku-4-5')]), 0),
      append(root, answer([candidate('claudeCLI:claude-haiku-4-5'), candidate('codexCLI:gpt-5-codex')]), 1),
      append(root, answer([candidate('codexCLI:gpt-5-codex')]), 2),
    ];
    return { root, ids: outcomes.map((entry) => entry.record.recordID), paths: outcomes.map((entry) => entry.filePath) };
  }
  const refused = (log: RoutingDecisionLogContents) => log.corrupt.map((entry) => path.basename(entry.filePath, '.json'));

  it('refuses a record whose answer was edited, and refuses to append to the log while it is there', () => {
    const { root, ids, paths } = threeAnswers();
    rewrite(paths[1], (record) => ({ ...record, answer: { ...record.answer, candidates: record.answer.candidates.slice(0, 1) } }));
    const log = readRoutingDecisionLog(root);
    // The edited record fails its digest, and the record after it — whose change was stated against
    // it — is refused with it: its predecessor is no longer one the log can vouch for.
    expect(refused(log).sort()).toEqual([ids[1], ids[2]].sort());
    expect(log.corrupt.find((entry) => entry.filePath === paths[1])!.reason).toMatch(/content digests to .* but the record is named/);
    expect(log.corrupt.find((entry) => entry.filePath === paths[2])!.reason).toMatch(/holds no intact record by that name/);
    expect(log.decisions.map((record) => record.recordID)).toEqual([ids[0]]);

    const before = logFiles(root);
    expect(() => append(root, answer([]), 3)).toThrow(RoutingDecisionLogError);
    expect(() => append(root, answer([]), 3)).toThrow(/did not verify, so nothing was appended/);
    expect(logFiles(root)).toEqual(before);
  });

  it('refuses a record that was edited and re-sealed under a new name, because its stated change no longer follows', () => {
    const { root, ids, paths } = threeAnswers();
    const original = JSON.parse(fs.readFileSync(paths[2], 'utf8')) as RoutingDecisionRecord;
    // A forger who knows the format: drop codex from the last answer, re-seal, rename.
    const { recordID: _old, schema: _schema, ...rest } = original;
    const forged = sealRoutingDecision({ ...rest, answer: { ...rest.answer, candidates: [] } });
    fs.rmSync(paths[2]);
    fs.writeFileSync(path.join(routingDecisionLogPath(root), `${forged.recordID}.json`), JSON.stringify(forged, null, 2));
    expect(verifyRoutingDecisionRecord(forged).intact).toBe(true);
    const log = readRoutingDecisionLog(root);
    expect(refused(log)).toEqual([forged.recordID]);
    expect(log.corrupt[0].reason).toBe('the change it states is not the change its answer and its previous answer imply');
    expect(log.decisions.map((record) => record.recordID)).toEqual(ids.slice(0, 2));
  });

  it('refuses the successor of a removed record, and a record moved under another name', () => {
    const { root, ids, paths } = threeAnswers();
    fs.rmSync(paths[1]);
    let log = readRoutingDecisionLog(root);
    expect(refused(log)).toEqual([ids[2]]);
    expect(log.corrupt[0].reason).toContain(`names ${ids[1].slice(0, 16)}… as the previous answer`);

    const moved = path.join(routingDecisionLogPath(root), `${'0'.repeat(64)}.json`);
    fs.renameSync(paths[0], moved);
    log = readRoutingDecisionLog(root);
    expect(log.corrupt.find((entry) => entry.filePath === moved)!.reason).toBe(`the file is named ${'0'.repeat(64)}.json but holds ${ids[0]}.json`);
    expect(log.decisions).toEqual([]);
  });

  it('refuses a file that is not a record at all, without throwing', () => {
    const root = temporary();
    append(root, answer([]), 0);
    const directory = routingDecisionLogPath(root);
    fs.writeFileSync(path.join(directory, 'garbage.json'), '{ not json');
    fs.writeFileSync(path.join(directory, 'null.json'), 'null');
    fs.writeFileSync(path.join(directory, 'wrong-schema.json'), JSON.stringify({ schema: 'cos1', recordID: 'x' }));
    const log = readRoutingDecisionLog(root);
    expect(log.decisions).toHaveLength(1);
    expect(log.corrupt.map((entry) => [path.basename(entry.filePath), entry.reason.slice(0, 20)])).toEqual([
      ['garbage.json', 'the file is not read'], ['null.json', 'the file holds null,'], ['wrong-schema.json', "schema is 'cos1', no"],
    ]);
  });

  it('reads an absent log as empty and creates nothing', () => {
    const root = temporary();
    const log = readRoutingDecisionLog(root);
    expect(log.decisions).toEqual([]);
    expect(log.corrupt).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

// ------------------------------------------------------------------ the commands, in a subprocess

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

function digestTree(root: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else { hash.update(full); hash.update(fs.readFileSync(full)); }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function observe(root: string, routeKey: string, provider: 'claudeCLI' | 'codexCLI'): void {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  appendObservations(root, [routeAvailabilityObservation({ routeKey, machineKey: MACHINE, machineLabel: 'fixture-host', observedAt,
    available: true, reason: 'signed in (fixture)' }, provider, 'a fixture availability reading')], { origin: 'observedHere', receivedAt: observedAt });
}

describe('cernum candidates --log and cernum decision-log', () => {
  it('declares --log on candidates and a read-only decision-log', () => {
    expect(acceptedOptions(commandSpec('candidates')!).map((option) => option.name)).toContain('log');
    const view = commandSpec('decision-log')!;
    expect(view.effect).toBe('readOnly');
    expect(acceptedOptions(view).map((option) => option.name)).toEqual(expect.arrayContaining(['json', 'capability', 'query', 'help']));
  });

  it('writes nothing without --log, appends with it, explains the change, and refuses a tampered log', async () => {
    const root = temporary();
    observe(root, 'claudeCLI:claude-haiku-4-5', 'claudeCLI');
    const args = ['candidates', CAPABILITY, '--machine', MACHINE, '--root', root];

    // OFF BY DEFAULT: the answer is printed and the root is byte-identical afterwards.
    const before = digestTree(root);
    const plain = await cernum(...args, '--json');
    expect(plain.stderr).toBe('');
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout).loggedDecision).toBeUndefined();
    expect(digestTree(root)).toBe(before);
    expect(fs.existsSync(routingDecisionLogPath(root))).toBe(false);

    const first = await cernum(...args, '--log', '--json');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const firstSet = JSON.parse(first.stdout) as RouteCandidateSet & { loggedDecision: { recordID: string; written: boolean; change: { basis: string } } };
    expect(firstSet.loggedDecision).toMatchObject({ written: true, change: { basis: 'firstAnswer' } });
    expect(firstSet.excluded.map((entry) => entry.routeKey)).toEqual(['claudeCLI:claude-haiku-4-5']);

    // A second route becomes observable: still no candidate, so the answer is unchanged, and the
    // exclusion that appeared is counted, not mistaken for a change of answer.
    observe(root, 'codexCLI:gpt-5-codex', 'codexCLI');
    const second = await cernum(...args, '--log');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Logged as [0-9a-f]{64}/);
    expect(second.stdout).toContain('unchanged since the previous answer (1 exclusion reason(s) moved)');

    let log = readRoutingDecisionLog(root);
    expect(log.corrupt).toEqual([]);
    expect(log.decisions).toHaveLength(2);
    expect(log.decisions[0].recordID).toBe(firstSet.loggedDecision.recordID);
    expect(log.decisions[1].previousDecisionID).toBe(log.decisions[0].recordID);
    expect(log.decisions[1].policies).toEqual({ routingContract: 'crc2', routingPolicy: 'crp2', qualificationPolicies: ['cqp1'] });
    expect(log.decisions[1].query).toMatchObject({ machineKey: MACHINE, capability: CAPABILITY, routingPolicyVersion: 'crp2' });

    // The view is read-only and shows both answers in order.
    const viewBefore = digestTree(root);
    const view = await cernum('decision-log', '--root', root);
    expect(view.stderr).toBe('');
    expect(view.status).toBe(0);
    expect(view.stdout).toContain(`log digest ${log.logDigest}`);
    expect(view.stdout).toContain('first logged answer to this query');
    expect(view.stdout).toContain('policies   crc2 · crp2 · cqp1');
    const json = await cernum('decision-log', '--root', root, '--json', '--capability', CAPABILITY);
    expect(json.status).toBe(0);
    expect((JSON.parse(json.stdout) as RoutingDecisionLogContents).decisions.map((record) => record.recordID))
      .toEqual(log.decisions.map((record) => record.recordID));
    expect(digestTree(root)).toBe(viewBefore);

    // Tamper with the first record: the view names it and exits 4; candidates --log refuses and writes nothing.
    const tampered = path.join(routingDecisionLogPath(root), `${log.decisions[0].recordID}.json`);
    rewrite(tampered, (record) => ({ ...record, decidedAt: '2020-01-01T00:00:00.000Z' }));
    const refusedView = await cernum('decision-log', '--root', root);
    expect(refusedView.status).toBe(4);
    expect(refusedView.stdout).toContain(tampered);
    expect(refusedView.stderr).toContain('did not verify');
    const filesBefore = logFiles(root);
    const refusedAppend = await cernum(...args, '--log');
    expect(refusedAppend.status).toBe(4);
    expect(refusedAppend.stderr).toContain('nothing was appended');
    expect(logFiles(root)).toEqual(filesBefore);
    log = readRoutingDecisionLog(root);
    expect(log.corrupt).toHaveLength(2);
  }, 180_000);
});
