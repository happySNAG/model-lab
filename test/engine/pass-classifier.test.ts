// The Ordra pass classifier (cpc1): one exported pass record — display number, objective, scope,
// verification commands and worker authority — mapped by transparent rules to a ctt1 task type and tier,
// with the evidence for each, a confidence and the query for recommend; and a record no rule classifies
// refused with its reasons, never defaulted.
//
// FIXTURES ONLY. fixtures/pass-classifier holds realistic pass records; the pure function is called on
// them directly, and the command runs in a subprocess against the same files. Nothing is contacted.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PASS_CLASSIFIER_VERSION, PASS_OBJECTIVE_PHRASES, PASS_OBJECTIVE_WORDS, PASS_RULE_WEIGHTS, PassClassification,
  PassClassificationRefusal, PassClassifierAnswer, classifyPassFile, classifyPassRecord, isDocsPath, isTestPath,
} from '../../src/engine/pass-classifier';
import { ALL_ORDRA_TASK_TYPES, TASK_TAXONOMY_VERSION } from '../../src/engine/task-taxonomy';
import { recommendRoutes } from '../../src/engine/route-recommendation';
import { acceptedOptions, commandSpec } from '../../src/cli/command-spec';

const REPOSITORY = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPOSITORY, 'fixtures', 'pass-classifier');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-pass-classifier-'));
  temporaries.push(directory);
  return directory;
}

function fixture(name: string): string {
  return path.join(FIXTURES, `${name}.json`);
}

function classified(answer: PassClassifierAnswer): PassClassification {
  if (!answer.ok) throw new Error(`expected a classification, got refusals: ${answer.refusals.join(' | ')}`);
  return answer;
}

function refused(answer: PassClassifierAnswer): PassClassificationRefusal {
  if (answer.ok) throw new Error(`expected a refusal, got ${answer.taskType} ${answer.tier}`);
  return answer;
}

/** Every classifiable fixture, what it is, and what cpc1 must call it. */
const EXPECTED: { name: string; kind: string; displayNumber: string; taskType: string; tier: string; level: string }[] = [
  { name: 'gate-block-3', kind: 'gate', displayNumber: 'B3-9', taskType: 'verify', tier: 'tier2', level: 'medium' },
  { name: 'verify-crr2-schema', kind: 'verification-only', displayNumber: 'B4-7', taskType: 'verify', tier: 'tier1', level: 'high' },
  { name: 'verify-rerun-commands', kind: 'verification-only', displayNumber: 'B4-9', taskType: 'verify', tier: 'tier2', level: 'high' },
  { name: 'docs-pass-classifier', kind: 'docs', displayNumber: 'B4-8', taskType: 'docs', tier: 'tier1', level: 'high' },
  { name: 'docs-readme-rows', kind: 'docs', displayNumber: 'B3-10', taskType: 'docs', tier: 'tier1', level: 'high' },
  { name: 'test-repair-fallback-chain', kind: 'test repair', displayNumber: 'B2-4', taskType: 'test-repair', tier: 'tier1', level: 'high' },
  { name: 'test-repair-flaky-lock', kind: 'test repair', displayNumber: 'B2-7', taskType: 'test-repair', tier: 'tier1', level: 'high' },
  { name: 'feature-crr2-contract', kind: 'feature', displayNumber: 'B4-3', taskType: 'implement', tier: 'tier2', level: 'medium' },
  { name: 'feature-machine-keys', kind: 'feature', displayNumber: 'B2-1', taskType: 'implement', tier: 'tier3', level: 'medium' },
  { name: 'fix-tier-name-regression', kind: 'fix', displayNumber: 'B3-5', taskType: 'fix', tier: 'tier1', level: 'medium' },
  { name: 'refactor-wilson-interval', kind: 'refactor', displayNumber: 'B1-6', taskType: 'refactor', tier: 'tier1', level: 'medium' },
  { name: 'plan-block-5', kind: 'plan', displayNumber: 'B5-0', taskType: 'plan', tier: 'tier1', level: 'medium' },
  { name: 'review-quarantine-diff', kind: 'review', displayNumber: 'B4-5R', taskType: 'review', tier: 'tier1', level: 'medium' },
];

const REFUSED = ['refused-no-verb', 'refused-read-only-implement', 'refused-tie', 'refused-malformed', 'refused-no-size'];

// ------------------------------------------------------------------ the fixtures

describe('the fixtures are realistic Ordra pass records', () => {
  it('holds at least 12 classifiable records across verification-only, docs, test repair, feature and gate passes', () => {
    expect(EXPECTED.length).toBeGreaterThanOrEqual(12);
    for (const kind of ['verification-only', 'docs', 'test repair', 'feature', 'gate']) {
      expect(EXPECTED.some((entry) => entry.kind === kind), kind).toBe(true);
    }
    const onDisk = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
    expect(onDisk).toEqual([...EXPECTED.map((entry) => entry.name), ...REFUSED].sort());
  });

  it('carries display_number, objective, scope, verification and worker_authority in every classifiable record', () => {
    for (const { name } of EXPECTED) {
      const raw = JSON.parse(fs.readFileSync(fixture(name), 'utf8')) as Record<string, unknown>;
      const record = (raw.payload ?? raw) as Record<string, unknown>;
      for (const field of ['display_number', 'objective', 'scope', 'verification', 'worker_authority']) {
        expect(record[field], `${name}.${field}`).toBeDefined();
      }
    }
  });
});

// ------------------------------------------------------------------ classification

describe('classifyPassRecord maps each pass to a ctt1 task type and tier, with evidence', () => {
  for (const expected of EXPECTED) {
    it(`${expected.name} (${expected.kind}) is ${expected.taskType} at ${expected.tier}`, () => {
      const answer = classified(classifyPassFile(fixture(expected.name)));
      expect(answer.schema).toBe(PASS_CLASSIFIER_VERSION);
      expect(answer.taxonomyVersion).toBe(TASK_TAXONOMY_VERSION);
      expect(answer.displayNumber).toBe(expected.displayNumber);
      expect(answer.taskType).toBe(expected.taskType);
      expect(answer.tier).toBe(expected.tier);
      expect(answer.confidence.level).toBe(expected.level);
      expect(answer.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('names the evidence for the type: every item supports the chosen type, and one comes from the objective', () => {
    for (const { name } of EXPECTED) {
      const answer = classified(classifyPassFile(fixture(name)));
      expect(answer.evidence.taskType.length, name).toBeGreaterThan(0);
      for (const item of answer.evidence.taskType) {
        expect(item.taskType).toBe(answer.taskType);
        expect(item.rule).not.toBe('');
        expect(item.matched.length).toBeGreaterThan(0);
        expect(item.detail).not.toBe('');
      }
      expect(answer.evidence.taskType.some((item) => item.source === 'objective'), name).toBe(true);
      expect(answer.evidence.scores[answer.taskType]).toBe(answer.evidence.taskType.reduce((sum, item) => sum + item.weight, 0));
      expect(answer.evidence.exclusions.some((item) => item.taskType === answer.taskType), name).toBe(false);
    }
  });

  it('names the evidence for the tier, and the tier is the highest any tier rule indicates', () => {
    const order = ['tier1', 'tier2', 'tier3'];
    for (const { name } of EXPECTED) {
      const answer = classified(classifyPassFile(fixture(name)));
      expect(answer.evidence.tier.length, name).toBeGreaterThan(0);
      expect(answer.evidence.tier.some((item) => item.tier === answer.tier)).toBe(true);
      expect(Math.max(...answer.evidence.tier.map((item) => order.indexOf(item.tier)))).toBe(order.indexOf(answer.tier));
    }
  });

  it('reads the specific rules it should on representative records', () => {
    const repair = classified(classifyPassFile(fixture('test-repair-fallback-chain')));
    expect(repair.evidence.taskType.map((item) => item.rule)).toEqual(expect.arrayContaining([
      'objective.phrase.failing-tests', 'objective.phrase.back-to-green', 'authority.tests-only', 'scope.tests-only',
      'verification.runs-scoped-test']));
    // "Repair" leads, so fix is scored — and loses to the more specific test-repair rules.
    expect(repair.evidence.scores.fix).toBe(PASS_RULE_WEIGHTS.objectiveLeadingVerb);
    expect(repair.evidence.exclusions.map((item) => `${item.taskType}:${item.rule}`)).toEqual(['implement:authority.tests-only', 'docs:authority.tests-only']);

    const gate = classified(classifyPassFile(fixture('gate-block-3')));
    expect(gate.evidence.exclusions.filter((item) => item.rule === 'authority.read-only').map((item) => item.taskType).sort())
      .toEqual(['docs', 'fix', 'implement', 'refactor', 'test-repair']);
    expect(gate.evidence.taskType.map((item) => item.rule)).toEqual(expect.arrayContaining(['objective.leading-verb', 'verification.checks-only']));

    const plan = classified(classifyPassFile(fixture('plan-block-5')));
    // Writing only a plan document scores docs from the authority, but docs is not named by the objective.
    expect(plan.evidence.scores.docs).toBe(PASS_RULE_WEIGHTS.authorityOnly);
    expect(plan.confidence.typeShare).toBe(0.71);

    const machineKeys = classified(classifyPassFile(fixture('feature-machine-keys')));
    expect(machineKeys.evidence.tier.find((item) => item.rule === 'tier.cross-cutting')?.matched).toEqual(['across every']);
    expect(machineKeys.evidence.tier.find((item) => item.rule === 'tier.verification-count')?.tier).toBe('tier3');

    const docs = classified(classifyPassFile(fixture('docs-pass-classifier')));
    // Paths and file names are not prose: docs/ordra-lane/pass-classifier.md is not the word "docs".
    expect(docs.evidence.taskType.find((item) => item.rule === 'objective.leading-verb')?.matched).toEqual(['document']);
  });

  it('reports a confidence as min(type share, tier agreement) with the sources that agree', () => {
    for (const { name } of EXPECTED) {
      const { confidence } = classified(classifyPassFile(fixture(name)));
      expect(confidence.value).toBe(Math.min(confidence.typeShare, confidence.tierAgreement));
      expect(confidence.value).toBeGreaterThan(0);
      expect(confidence.value).toBeLessThanOrEqual(1);
      expect(confidence.sourcesAgreeing).toBeGreaterThanOrEqual(1);
      if (confidence.level === 'high') expect(confidence.value >= 0.75 && confidence.sourcesAgreeing >= 2).toBe(true);
    }
  });

  it('hands recommend a ctt1 query it accepts, and invents no context requirement', () => {
    for (const { name } of EXPECTED) {
      const answer = classified(classifyPassFile(fixture(name)));
      const digit = answer.tier.slice(-1);
      expect(answer.query).toEqual({
        taxonomyVersion: 'ctt1', taskType: answer.taskType, structuralTier: answer.tier, contextTokens: null,
        contextReason: expect.stringContaining('none is invented'),
        arguments: ['recommend', answer.taskType, '--tier', digit, '--contract', 'crr2', '--json'],
        command: `cernum recommend ${answer.taskType} --tier ${digit} --contract crr2 --json`,
      });
      const recommended = recommendRoutes({ machineKey: 'cmk1:pass-classifier', taskType: answer.query.taskType, tier: digit },
        { now: new Date('2026-10-26T00:00:00Z'), routes: [] });
      expect(recommended.ok, name).toBe(true);
    }
  });

  it('reads an Ordra event carrying the record as payload exactly as the bare record', () => {
    const event = JSON.parse(fs.readFileSync(fixture('gate-block-3'), 'utf8')) as { payload: unknown };
    const fromEvent = classified(classifyPassRecord(event));
    const fromPayload = classified(classifyPassRecord(event.payload));
    expect(fromEvent).toEqual(fromPayload);
  });

  it('is deterministic: the same bytes give the same answer', () => {
    for (const { name } of EXPECTED) expect(classifyPassFile(fixture(name))).toEqual(classifyPassFile(fixture(name)));
  });
});

// ------------------------------------------------------------------ refusal, never a default

describe('a record no rule classifies is refused with every reason, never defaulted', () => {
  it('refuses an objective whose words name no task type', () => {
    const answer = refused(classifyPassFile(fixture('refused-no-verb')));
    expect(answer.displayNumber).toBe('B4-X1');
    expect(answer.refusals).toEqual([expect.stringContaining('no objective rule matched')]);
    expect(answer.refusals[0]).toContain('never given a default type');
    expect(answer).not.toHaveProperty('taskType');
    expect(answer).not.toHaveProperty('query');
  });

  it('refuses when every type the objective names is ruled out by the worker authority', () => {
    const answer = refused(classifyPassFile(fixture('refused-read-only-implement')));
    expect(answer.refusals).toEqual([expect.stringContaining("the objective names 'implement' but it is ruled out (authority.read-only")]);
    expect(answer.evidence?.exclusions.map((item) => item.taskType)).toContain('implement');
  });

  it('refuses a tie rather than breaking it by a default order', () => {
    const answer = refused(classifyPassFile(fixture('refused-tie')));
    expect(answer.refusals).toEqual([expect.stringContaining("ties between 'fix' and 'refactor'")]);
    expect(answer.evidence?.scores.fix).toBe(answer.evidence?.scores.refactor);
  });

  it('refuses a record with nothing that measures its size, never defaulting the tier', () => {
    const answer = refused(classifyPassFile(fixture('refused-no-size')));
    expect(answer.refusals).toEqual([expect.stringContaining('no tier rule applies')]);
  });

  it('refuses a malformed record and names every unreadable field at once', () => {
    const answer = refused(classifyPassFile(fixture('refused-malformed')));
    expect(answer.displayNumber).toBe('B4-X4');
    expect(answer.refusals).toEqual([
      expect.stringContaining('scope is missing'),
      expect.stringContaining('verification is missing'),
      expect.stringContaining('worker_authority is missing'),
    ]);
    expect(answer.evidence).toBeUndefined();
  });

  it('refuses a file that is not JSON, and a value that is not an object', () => {
    const directory = temporary();
    const file = path.join(directory, 'broken.json');
    fs.writeFileSync(file, '{ "display_number": "B9-1", ');
    const answer = refused(classifyPassFile(file));
    expect(answer.refusals).toEqual([expect.stringContaining('the file is not JSON')]);
    expect(answer.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(refused(classifyPassRecord(['B9-1'])).refusals).toEqual(['the pass record is not a JSON object']);
  });

  it('refuses a missing paths_writable rather than assuming the worker may or may not write', () => {
    const record = JSON.parse(fs.readFileSync(fixture('docs-readme-rows'), 'utf8')) as { worker_authority: Record<string, unknown> };
    delete record.worker_authority.paths_writable;
    expect(refused(classifyPassRecord(record)).refusals).toEqual([expect.stringContaining('paths_writable is missing')]);
  });
});

// ------------------------------------------------------------------ the rules are pinned and documented

describe('the rules are fixed, versioned and documented', () => {
  it('pins cpc1 and its weights', () => {
    expect(PASS_CLASSIFIER_VERSION).toBe('cpc1');
    expect(PASS_RULE_WEIGHTS).toEqual({
      objectivePhrase: 4, objectiveLeadingVerb: 3, objectiveKeyword: 1, authorityOnly: 2, scopeOnly: 1, verificationShape: 1,
    });
    expect(Object.keys(PASS_OBJECTIVE_WORDS).sort()).toEqual([...ALL_ORDRA_TASK_TYPES].sort());
  });

  it('classifies paths by shape only', () => {
    for (const p of ['docs', 'docs/ordra-lane/x.md', 'README.md', './CHANGELOG', 'notes.txt']) expect(isDocsPath(p), p).toBe(true);
    for (const p of ['src', 'src/engine/lock.ts', 'test/engine/lock.test.ts']) expect(isDocsPath(p), p).toBe(false);
    for (const p of ['test', 'test/engine/lock.test.ts', 'fixtures/pass-classifier', 'src/x.spec.ts', 'pkg/__tests__/']) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src', 'src/engine/lock.ts', 'docs', 'testing-notes']) expect(isTestPath(p), p).toBe(false);
  });

  it('is documented, with every rule, every weight and the refusals', () => {
    const doc = fs.readFileSync(path.join(REPOSITORY, 'docs/ordra-lane/pass-classifier.md'), 'utf8');
    expect(doc).toContain('cpc1');
    expect(doc).toContain('ctt1');
    const rules = [
      'objective.leading-verb', 'objective.keyword', ...PASS_OBJECTIVE_PHRASES.map((phrase) => phrase.rule),
      'authority.read-only', 'authority.docs-only', 'authority.tests-only', 'scope.docs-only', 'scope.tests-only',
      'verification.none', 'verification.checks-only', 'verification.runs-scoped-test',
      'tier.verification-count', 'tier.scope-count', 'tier.scope-areas', 'tier.cross-cutting',
    ];
    for (const rule of rules) expect(doc, rule).toContain(`\`${rule}\``);
    for (const words of Object.values(PASS_OBJECTIVE_WORDS)) for (const word of words) expect(doc, word).toContain(word);
    expect(doc).toContain('never defaulted');
  });

  it('has a README row linking the doc', () => {
    const readme = fs.readFileSync(path.join(REPOSITORY, 'README.md'), 'utf8');
    const row = readme.split('\n').find((line) => line.startsWith('| `cernum classify-pass'));
    expect(row).toBeDefined();
    expect(row).toContain('[docs/ordra-lane/pass-classifier.md](docs/ordra-lane/pass-classifier.md)');
  });
});

// ------------------------------------------------------------------ the command

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

describe('cernum classify-pass <file> --json', () => {
  it('is declared read-only with --json', () => {
    const spec = commandSpec('classify-pass')!;
    expect(spec.effect).toBe('readOnly');
    expect(spec.positional).toBe('<file>');
    expect(acceptedOptions(spec).map((option) => option.name)).toEqual(expect.arrayContaining(['json', 'help']));
  });

  it('prints the classification as JSON and exits 0', async () => {
    const file = fixture('test-repair-fallback-chain');
    const result = await cernum('classify-pass', file, '--json');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed).toEqual({ file, ...classifyPassFile(file) });
  }, 60_000);

  it('prints a refusal as JSON with every reason and exits 2', async () => {
    const file = fixture('refused-no-verb');
    const result = await cernum('classify-pass', file, '--json');
    expect(result.status).toBe(2);
    const printed = JSON.parse(result.stdout) as { ok: boolean; refusals: string[] };
    expect(printed.ok).toBe(false);
    expect(printed.refusals[0]).toContain('no objective rule matched');
    expect(printed).not.toHaveProperty('taskType');
  }, 60_000);

  it('prints the evidence and the query for a person, and refuses a missing file with exit 2', async () => {
    const human = await cernum('classify-pass', fixture('feature-machine-keys'));
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('task type   implement');
    expect(human.stdout).toContain('tier        tier3');
    expect(human.stdout).toContain('recommend implement --tier 3 --contract crr2 --json');
    const missing = await cernum('classify-pass', path.join(temporary(), 'absent.json'), '--json');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('is not a readable file');
  }, 60_000);
});
