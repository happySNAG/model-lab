// Cernum development runner · multi-file-edit result bytes, retained and proven.
//
// No model runs here. Every attempt is answered by an in-process adapter that edits the workspace it
// is handed. What is proven: a graded edit attempt keeps the final text of every file it changed and
// a unified diff of each, and nothing of the files it left alone; the stored baseline plus those
// bytes rebuild the graded snapshot digest, on write and on re-read; a missing, altered or swapped
// byte anywhere is a refusal; an oversized attempt keeps a manifest and no contents, never a
// truncated copy; redaction is declared and never passed off as the graded bytes; and
// `develop-reinterpret` re-grades an edit row from those bytes offline, with no provider reachable,
// without moving a byte of the campaign.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A TRIPWIRE FOR ANY PROVIDER PROCESS. Every provider this engine talks to is a child process or an
// HTTP request, so both are replaced with ones that record and refuse. The in-process adapter below
// needs neither, so a single recorded call is a failure.
const tripped: string[] = [];
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refuse = (name: string) => (...args: unknown[]) => {
    tripped.push(`${name} ${String(args[0])}`);
    throw new Error(`the edit evidence tests may not start a process (${name})`);
  };
  return {
    ...actual,
    spawn: refuse('spawn'), spawnSync: refuse('spawnSync'), exec: refuse('exec'), execSync: refuse('execSync'),
    execFile: refuse('execFile'), execFileSync: refuse('execFileSync'), fork: refuse('fork'),
  };
});

import { snapshotDigest, snapshotOf } from '../../src/core/development-fixture';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { DevelopmentTask } from '../../src/core/development-benchmark';
import { developmentSuites } from '../../src/core/development-catalog';
import { MULTI_FILE_EDIT_SUITE_ID } from '../../src/core/development-suites/multi-file-edit';
import { MAX_MYERS_EDITS, applyUnifiedDiff, unifiedDiff } from '../../src/core/unified-diff';
import {
  DEVELOPMENT_ARTEFACTS_DIRECTORY, DEVELOPMENT_PLAN_FILE, createDevelopmentCampaign, runDevelopmentCampaign,
} from '../../src/engine/development-campaign';
import {
  DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY, DevelopmentEditEvidence, EditEvidenceReference, buildEditEvidence,
  readVerifiedEditEvidence, snapshotSha256,
} from '../../src/engine/development-edit-evidence';
import { DevelopmentCampaignPlan, buildDevelopmentPlan } from '../../src/engine/development-plan';
import { readDevelopmentCampaignState } from '../../src/engine/development-report';
import {
  DEVELOPMENT_REINTERPRETATIONS_DIRECTORY, reinterpretDevelopmentCampaign,
} from '../../src/engine/development-reinterpretation';
import { FrontierAdapter, FrontierRequest, FrontierResponse } from '../../src/engine/frontier-adapter';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { scanForSecrets } from '../../src/engine/redaction';
import { REFERENCE_SOLUTIONS, apply, baseline } from './fixtures/ledgerlite-solutions';

const MACHINE = { machineIdentifier: 'test-machine', platform: 'darwin-arm64' };
const CLOCK = () => '2026-09-21T12:00:00Z';
const FIXED_NOW = () => new Date('2026-09-21T12:00:00Z');
const REGRADE = { producedAt: '2026-09-22T09:00:00Z', benchmarkVersion: '0.2.4', benchmarkCommit: 'd'.repeat(40), workingTreeDirty: false };

const EDIT_TASKS: DevelopmentTask[] = developmentSuites.flatMap((suite) => suite.tasks).filter((task) => task.kind === 'repositoryEdit');
const ADD_SURCHARGE = 'task.dev.multi-file-edit.add-region-surcharge';
const FIX_ROUNDING = 'task.dev.multi-file-edit.fix-negative-rounding';
const HONOUR_MODE = 'task.dev.multi-file-edit.honour-rounding-mode';
const SECRET = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsT';

// MARK: - Scaffolding

type Target = (taskID: string) => ReadonlyMap<string, string>;

/** An in-process adapter that makes the workspace hold exactly what `target` says. */
function editingAdapter(target: Target): FrontierAdapter & { calls: number } {
  const adapter = {
    provider: 'claudeCLI' as const,
    calls: 0,
    async complete(request: FrontierRequest): Promise<FrontierResponse> {
      adapter.calls += 1;
      const task = EDIT_TASKS.find((entry) => request.promptText.includes(entry.prompt.user));
      if (task) {
        const root = request.developmentWorkspace!.root;
        const wanted = target(task.id);
        for (const relative of baseline.keys()) if (!wanted.has(relative)) fs.rmSync(path.join(root, relative), { force: true });
        for (const [relative, contents] of wanted) {
          if (baseline.get(relative) === contents) continue;
          fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
          fs.writeFileSync(path.join(root, relative), contents);
        }
      }
      return {
        answerText: 'Done.', reportedModelID: '', usage: { inputTokens: 100, visibleOutputTokens: 20 },
        usageProvenance: 'providerReported', totalElapsedMilliseconds: 7, retryCount: 0, wastedTokens: 0,
      };
    },
  };
  return adapter;
}

const SOLVED: Target = (taskID) => apply(REFERENCE_SOLUTIONS[taskID]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  expect(tripped).toEqual([]);
});

function plan(): DevelopmentCampaignPlan {
  return buildDevelopmentPlan({
    label: 'edit-evidence', repeats: 1,
    candidates: [{
      name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', effort: 'high',
      retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    }],
    benchmarkVersion: '0.2.4', createdAt: '2026-09-21T00:00:00Z', machine: MACHINE,
    benchmarkCommit: 'c'.repeat(40), workingTreeDirty: false, suiteIDs: [MULTI_FILE_EDIT_SUITE_ID],
  });
}

async function campaign(target: Target = SOLVED, extra: Partial<Parameters<typeof runDevelopmentCampaign>[0]> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-edit-evidence-test-'));
  roots.push(base);
  const root = path.join(base, 'campaign');
  const built = plan();
  const ledger = createDevelopmentCampaign(root, built, CLOCK);
  const adapter = editingAdapter(target);
  await runDevelopmentCampaign({
    root, ledger, plan: built, adapters: { claudeCLI: adapter }, now: FIXED_NOW, sleep: async () => undefined, ...extra,
  });
  return { root, plan: built, adapter };
}

type Row = Record<string, unknown>;
const rowsOf = (root: string) => readDevelopmentCampaignState(root).rows as Row[];
const rowFor = (root: string, taskID: string) => rowsOf(root).find((row) => row.taskID === taskID)!;
const referenceOf = (row: Row) => row.editEvidence as EditEvidenceReference;
const evidenceFile = (root: string, row: Row) => path.join(root, referenceOf(row).file);
const evidenceOf = (root: string, row: Row) => JSON.parse(fs.readFileSync(evidenceFile(root, row), 'utf8')) as DevelopmentEditEvidence;

function verify(root: string, row: Row) {
  return readVerifiedEditEvidence(root, {
    slotKey: String(row.slotKey), runID: String(row.runID), fixtureRepoDigest: String(row.fixtureRepoDigest),
    baselineSnapshotDigest: String(row.baselineSnapshotDigest), resultSnapshotDigest: String(row.resultSnapshotDigest),
    reference: referenceOf(row),
  });
}

/** Rewrite a document, and — when asked — re-point the row's hash at the rewritten bytes. */
function rewriteEvidence(root: string, row: Row, change: (evidence: DevelopmentEditEvidence) => void, rehashRow: boolean): void {
  const file = evidenceFile(root, row);
  const evidence = evidenceOf(root, row);
  change(evidence);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
  if (!rehashRow) return;
  const hash = 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const resultsFile = path.join(root, 'results.jsonl');
  const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map((line) => {
    const parsed = JSON.parse(line);
    if (parsed.slotKey === row.slotKey) parsed.editEvidence.sha256 = hash;
    return JSON.stringify(parsed);
  });
  fs.writeFileSync(resultsFile, lines.join('\n') + '\n');
}

function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else out[path.relative(root, full)] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

// MARK: - The diff

describe('the unified diff', () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ['one line changed in the middle', 'a\nb\nc\nd\ne\nf\ng\nh\ni\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\n'],
    ['two distant hunks', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n',
      Array.from({ length: 40 }, (_, i) => (i === 3 || i === 30 ? `changed ${i}` : `line ${i}`)).join('\n') + '\n'],
    ['lines inserted and removed', 'one\ntwo\nthree\nfour\n', 'zero\none\nthree\nfour\nfive\n'],
    ['a final newline removed', 'a\nb\n', 'a\nb'],
    ['a final newline added', 'a\nb', 'a\nb\n'],
    ['no final newline on either side', 'a\nb', 'a\nc'],
    ['a file added', undefined, 'new\nfile\n'],
    ['a file added with no final newline', undefined, 'new'],
    ['a file removed', 'old\nfile\n', undefined],
    ['an empty file added', undefined, ''],
    ['a file emptied', 'x\ny\n', ''],
    ['carriage returns kept', 'a\r\nb\r\n', 'a\r\nB\r\n'],
    ['a content line that looks like diff syntax', 'x\n', '@@ -1,1 +1,1 @@\n\\ No newline at end of file\n--- a/x\n'],
  ];

  it.each(cases)('%s: applying the diff to the baseline gives exactly the new text', (_name, before, after) => {
    const diff = unifiedDiff('src/f.js', before, after);
    expect(applyUnifiedDiff(before, diff)).toBe(after);
  });

  it('writes the format git and patch read, with three lines of context', () => {
    expect(unifiedDiff('src/f.js', 'a\nb\nc\nd\ne\nf\ng\nh\ni\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\n')).toBe([
      '--- a/src/f.js', '+++ b/src/f.js', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h', '',
    ].join('\n'));
    expect(unifiedDiff('n.txt', undefined, 'x')).toBe(['--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,1 @@', '+x',
      '\\ No newline at end of file', ''].join('\n'));
    expect(unifiedDiff('same', 'a\n', 'a\n')).toBe('');
  });

  it('stays correct past the minimal-diff bound, by replacing the changed middle', () => {
    const before = Array.from({ length: MAX_MYERS_EDITS + 10 }, (_, i) => `old ${i}`).join('\n') + '\n';
    const after = Array.from({ length: MAX_MYERS_EDITS + 10 }, (_, i) => `new ${i}`).join('\n') + '\n';
    expect(applyUnifiedDiff(before, unifiedDiff('big', before, after))).toBe(after);
  });

  it('refuses a diff whose context does not match, rather than applying it loosely', () => {
    const diff = unifiedDiff('f', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(() => applyUnifiedDiff('a\nX\nc\n', diff)).toThrow(/expects/);
    expect(() => applyUnifiedDiff('a\nb\nc\n', diff.replace('@@ -1,3 +1,3 @@', '@@ -1,2 +1,3 @@'))).toThrow(/declares/);
  });

  it('is a diff the system patch tool applies to the same result', async () => {
    // The real module, for this one test only: the tripwire guards everything else in the file.
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    if (real.spawnSync('patch', ['--version']).error) return; // no system patch here; the round-trip tests still hold
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-diff-patch-'));
    roots.push(directory);
    for (const [relative, contents] of baseline) {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
      fs.writeFileSync(path.join(directory, relative), contents);
    }
    const solved = apply(REFERENCE_SOLUTIONS[ADD_SURCHARGE], REFERENCE_SOLUTIONS[HONOUR_MODE]);
    const changed = [...solved.keys()].filter((relative) => solved.get(relative) !== baseline.get(relative));
    const diff = changed.map((relative) => unifiedDiff(relative, baseline.get(relative), solved.get(relative))).join('');
    fs.writeFileSync(path.join(directory, 'change.diff'), diff);
    const patched = real.spawnSync('patch', ['-p1', '-s', '-i', 'change.diff'], { cwd: directory, encoding: 'utf8' });
    expect(patched.status, `${patched.stdout}${patched.stderr}`).toBe(0);
    for (const relative of changed) expect(fs.readFileSync(path.join(directory, relative), 'utf8'), relative).toBe(solved.get(relative));
  });

  it('matches the reference solutions: every diff applies to the sealed baseline', () => {
    for (const task of EDIT_TASKS) {
      const solved = apply(REFERENCE_SOLUTIONS[task.id]);
      for (const relative of new Set([...solved.keys(), ...baseline.keys()])) {
        const before = baseline.get(relative);
        const after = solved.get(relative);
        expect(applyUnifiedDiff(before, unifiedDiff(relative, before, after)), `${task.id} ${relative}`).toBe(after);
      }
    }
  });
});

// MARK: - Writing the evidence

describe('a graded edit attempt keeps its bytes', () => {
  it('keeps a one-file edit: its final text, its diff, and nothing of the files it left alone', async () => {
    const oneFile: Target = () => {
      const files = new Map(baseline);
      files.set('src/util/money.js', baseline.get('src/util/money.js')!.replace('return Math.round(value);',
        'return value < 0 ? -Math.round(-value) : Math.round(value);'));
      return files;
    };
    const { root } = await campaign(oneFile);
    const row = rowFor(root, FIX_ROUNDING);
    const reference = referenceOf(row);
    expect(reference).toMatchObject({ state: 'byteExact', changedFileCount: 1, notByteExactBecause: [] });
    expect(reference.file).toBe(`${DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY}/${path.basename(reference.file)}`);

    const evidence = evidenceOf(root, row);
    expect(evidence.changes).toHaveLength(1);
    const [change] = evidence.changes;
    expect(change).toMatchObject({ path: 'src/util/money.js', change: 'modified' });
    expect(change.contents).toBe(oneFile(FIX_ROUNDING).get('src/util/money.js'));
    expect(change.diff).toContain('--- a/src/util/money.js\n+++ b/src/util/money.js\n@@ ');
    expect(change.diff).toContain('-  return Math.round(value);\n+  return value < 0 ? -Math.round(-value) : Math.round(value);\n');
    expect(change.resultSha256).toBe(change.retainedSha256);
    // Unchanged files are counted, not copied.
    expect(evidence.unchangedFileCount).toBe(baseline.size - 1);
    expect(evidence.changedFileCount).toBe(1);
    expect(evidence.selfVerification).toMatchObject({ baselineReproduced: true, diffsApply: true, snapshotReproduced: true });
    expect(evidence.result.snapshotDigest).toBe(row.resultSnapshotDigest);
    expect(evidence.baseline.snapshotDigest).toBe(row.baselineSnapshotDigest);
  });

  it('keeps a multi-file edit: every added, modified and removed path, and the baseline once', async () => {
    const { root } = await campaign();
    for (const task of EDIT_TASKS) {
      const row = rowFor(root, task.id);
      const solved = apply(REFERENCE_SOLUTIONS[task.id]);
      const evidence = evidenceOf(root, row);
      const changed = [...new Set([...solved.keys(), ...baseline.keys()])]
        .filter((relative) => solved.get(relative) !== baseline.get(relative)).sort();
      expect(evidence.changes.map((change) => change.path), task.id).toEqual(changed);
      expect(changed.length, task.id).toBeGreaterThan(1);
      for (const change of evidence.changes) {
        expect(change.contents, `${task.id} ${change.path}`).toBe(solved.get(change.path));
        expect(change.change).toBe(baseline.has(change.path) ? (solved.has(change.path) ? 'modified' : 'removed') : 'added');
        expect(applyUnifiedDiff(baseline.get(change.path), change.diff!)).toBe(solved.get(change.path));
      }
      // No unchanged file's text appears anywhere in the document.
      const kept = new Set(evidence.changes.map((change) => change.path));
      for (const [relative] of baseline) if (!kept.has(relative)) expect(evidence.changes.some((change) => change.path === relative)).toBe(false);
      expect(evidence.unchangedFileCount + evidence.changes.filter((change) => change.change !== 'added').length).toBe(baseline.size);
      expect(referenceOf(row).state).toBe('byteExact');
    }
    const added = evidenceOf(root, rowFor(root, ADD_SURCHARGE)).changes.find((change) => change.change === 'added')!;
    expect(added.diff!.startsWith('--- /dev/null\n+++ b/')).toBe(true);
    expect(fs.readdirSync(path.join(root, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY, 'baselines'))).toEqual([`${ledgerlite.id}@${ledgerlite.version}.json`]);
  });

  it('writes the evidence before the row, and the row commits to its hash', async () => {
    const { root } = await campaign();
    for (const row of rowsOf(root)) {
      const hash = 'sha256:' + createHash('sha256').update(fs.readFileSync(evidenceFile(root, row))).digest('hex');
      expect(referenceOf(row).sha256).toBe(hash);
    }
  });

  it('keeps no edit evidence for an attempt no model answered', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-edit-evidence-test-'));
    roots.push(base);
    const root = path.join(base, 'campaign');
    const built = plan();
    const ledger = createDevelopmentCampaign(root, built, CLOCK);
    const failing: FrontierAdapter = {
      provider: 'claudeCLI',
      async complete(): Promise<FrontierResponse> {
        return { answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable', totalElapsedMilliseconds: 1,
          retryCount: 0, wastedTokens: 0, failure: { kind: 'transport', detail: 'connection reset' } };
      },
    };
    await runDevelopmentCampaign({ root, ledger, plan: built, adapters: { claudeCLI: failing }, now: FIXED_NOW, sleep: async () => undefined });
    for (const row of rowsOf(root)) {
      expect(row.measurementState).toBe('notMeasured');
      expect(row.editEvidence).toBeUndefined();
    }
    expect(fs.existsSync(path.join(root, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY))).toBe(false);
  });
});

// MARK: - Proving the bytes

describe('the retained bytes reproduce the graded digest, or nothing is graded from them', () => {
  it('rebuilds the graded snapshot from the stored baseline and the retained files', async () => {
    const { root } = await campaign();
    for (const task of EDIT_TASKS) {
      const row = rowFor(root, task.id);
      const verified = verify(root, row);
      expect(verified.usable, task.id).toBe(true);
      if (!verified.usable) continue;
      expect(snapshotDigest(verified.snapshot)).toBe(row.resultSnapshotDigest);
      expect(snapshotSha256(verified.snapshot)).toBe(referenceOf(row).resultSnapshotSha256);
      expect(snapshotDigest(verified.snapshot)).toBe(snapshotDigest(apply(REFERENCE_SOLUTIONS[task.id])));
    }
  });

  it('refuses when the evidence document is missing', async () => {
    const { root } = await campaign();
    const row = rowFor(root, HONOUR_MODE);
    fs.rmSync(evidenceFile(root, row));
    expect(() => verify(root, row)).toThrow(/is not on disk/);
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false })).toThrow(/is not on disk/);
  });

  it('refuses when a retained file is dropped from the evidence, even with the row re-pointed at it', async () => {
    const { root } = await campaign();
    const row = rowFor(root, HONOUR_MODE);
    rewriteEvidence(root, row, (evidence) => { evidence.changes = evidence.changes.slice(1); }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/rebuild|not the graded/);
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false })).toThrow(/rebuild|not the graded/);
  });

  it('refuses when a retained file\'s text is removed', async () => {
    const { root } = await campaign();
    rewriteEvidence(root, rowFor(root, HONOUR_MODE), (evidence) => { delete evidence.changes[0].contents; }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/text is missing/);
  });

  it('refuses a tampered document by its hash, before reading a byte of it', async () => {
    const { root } = await campaign();
    const row = rowFor(root, HONOUR_MODE);
    rewriteEvidence(root, row, (evidence) => { evidence.changes[0].contents += '\n// tampered'; }, false);
    expect(() => verify(root, row)).toThrow(/hashes to .* and the row recorded/);
    const before = hashes(root);
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true })).toThrow(/Nothing was written/);
    expect(hashes(root)).toEqual(before);
  });

  it('refuses a tampered retained file even when the row\'s hash was re-pointed at the tampered document', async () => {
    const { root } = await campaign();
    rewriteEvidence(root, rowFor(root, HONOUR_MODE), (evidence) => { evidence.changes[0].contents += '\n// tampered'; }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/does not hash to/);

    // ...and when its own hash inside the document was forged too, the diff and the digest still catch it.
    rewriteEvidence(root, rowFor(root, HONOUR_MODE), (evidence) => {
      evidence.changes[0].retainedSha256 = 'sha256:' + createHash('sha256').update(evidence.changes[0].contents!).digest('hex');
    }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/diff/);
    rewriteEvidence(root, rowFor(root, HONOUR_MODE), (evidence) => {
      const change = evidence.changes[0];
      change.diff = unifiedDiff(change.path, baseline.get(change.path), change.contents);
    }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/not the graded/);
  });

  it('refuses a tampered stored baseline', async () => {
    const { root } = await campaign();
    const file = path.join(root, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY, 'baselines', `${ledgerlite.id}@${ledgerlite.version}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.repo.files[0].contents += ' ';
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/seals to/);
  });
});

// MARK: - Bounds and redaction

describe('an oversized attempt keeps a manifest and no contents', () => {
  it('marks the evidence incomplete, names the bound, and keeps nothing it could have truncated', async () => {
    const { root } = await campaign(SOLVED, { editEvidenceLimits: { maxChangedFiles: 256, maxRetainedBytes: 200 } });
    for (const task of EDIT_TASKS) {
      const row = rowFor(root, task.id);
      const evidence = evidenceOf(root, row);
      expect(evidence.state, task.id).toBe('incomplete');
      expect(referenceOf(row).state).toBe('incomplete');
      expect(evidence.notByteExactBecause.join(' ')).toMatch(/over the 200-byte edit evidence bound; no contents were retained/);
      expect(evidence.retainedBytes).toBe(0);
      for (const change of evidence.changes) {
        expect(change.contents).toBeUndefined();
        expect(change.diff).toBeUndefined();
        expect(change.path.length).toBeGreaterThan(0);
      }
      // The grade itself is untouched: evidence limits never change what was measured.
      expect(row.structuralCredit).toBe('full');
      const verified = verify(root, row);
      expect(verified.usable).toBe(false);
    }
  });

  it('applies the changed-file bound the same way', async () => {
    const { root } = await campaign(SOLVED, { editEvidenceLimits: { maxChangedFiles: 1, maxRetainedBytes: 4_194_304 } });
    const evidence = evidenceOf(root, rowFor(root, HONOUR_MODE));
    expect(evidence.state).toBe('incomplete');
    expect(evidence.notByteExactBecause.join(' ')).toMatch(/changed paths, over the 1-path edit evidence bound/);
  });

  it('carries an incomplete row unchanged through a reinterpretation, and says why', async () => {
    const { root } = await campaign(SOLVED, { editEvidenceLimits: { maxChangedFiles: 256, maxRetainedBytes: 200 } });
    const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    expect(reinterpretation.editRows).toEqual([]);
    expect(reinterpretation.carriedUnchanged.map((entry) => entry.kind)).toEqual(EDIT_TASKS.map(() => 'editEvidenceNotGradeable'));
    for (const entry of reinterpretation.carriedUnchanged) expect(entry.because).toMatch(/declared incomplete/);
  });
});

describe('redaction is declared, and redacted bytes are never passed off as the graded ones', () => {
  const withSecret: Target = (taskID) => {
    const files = apply(REFERENCE_SOLUTIONS[taskID]);
    files.set('src/config/credentials.js', `module.exports = { key: '${SECRET}' };\n`);
    return files;
  };

  it('records which file was redacted, how, and the hash of the original bytes', async () => {
    const { root } = await campaign(withSecret);
    const row = rowFor(root, HONOUR_MODE);
    const evidence = evidenceOf(root, row);
    expect(evidence.state).toBe('redacted');
    expect(referenceOf(row).state).toBe('redacted');
    const redacted = evidence.changes.find((change) => change.path === 'src/config/credentials.js')!;
    expect(redacted.redaction).toEqual({ kinds: ['anthropicKey'], originalCharacters: withSecret(HONOUR_MODE).get('src/config/credentials.js')!.length,
      retainedCharacters: redacted.contents!.length });
    expect(redacted.contents).not.toContain(SECRET);
    expect(redacted.contents).toContain('[redacted:anthropicKey:');
    expect(redacted.resultSha256).toBe('sha256:' + createHash('sha256').update(withSecret(HONOUR_MODE).get('src/config/credentials.js')!).digest('hex'));
    expect(redacted.retainedSha256).not.toBe(redacted.resultSha256);
    expect(evidence.notByteExactBecause.join(' ')).toMatch(/src\/config\/credentials\.js \(anthropicKey\).*not the text that was graded/);
    // The unredacted files are kept byte-for-byte, and nothing on disk still carries the secret.
    for (const change of evidence.changes.filter((entry) => entry.redaction === undefined && entry.change !== 'removed')) {
      expect(change.retainedSha256).toBe(change.resultSha256);
    }
    expect(scanForSecrets(fs.readFileSync(evidenceFile(root, row), 'utf8'))).toEqual([]);
    expect(evidence.retained!.snapshotDigest).not.toBe(evidence.result.snapshotDigest);
    expect(evidence.selfVerification.snapshotReproduced).toBe(true);
  });

  it('proves the redacted bytes intact, and still refuses to grade from them', async () => {
    const { root } = await campaign(withSecret);
    const row = rowFor(root, HONOUR_MODE);
    const verified = verify(root, row);
    expect(verified.usable).toBe(false);
    if (!verified.usable) expect(verified.because).toMatch(/intact but redacted/);
    const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    expect(reinterpretation.editRows).toEqual([]);
    expect(reinterpretation.carriedUnchanged.every((entry) => entry.kind === 'editEvidenceNotGradeable')).toBe(true);

    // Tampering with redacted evidence is still tampering.
    rewriteEvidence(root, row, (evidence) => {
      const change = evidence.changes.find((entry) => entry.path === 'src/config/credentials.js')!;
      change.contents = change.contents!.replace('key', 'KEY');
      change.retainedSha256 = 'sha256:' + createHash('sha256').update(change.contents).digest('hex');
      change.diff = unifiedDiff(change.path, undefined, change.contents);
    }, true);
    expect(() => verify(root, rowFor(root, HONOUR_MODE))).toThrow(/retained \(redacted\) bytes do not reproduce/);
  });

  it('never declares a redacted document byte-exact, built directly', () => {
    const result = withSecret(FIX_ROUNDING);
    const evidence = buildEditEvidence({
      slotKey: 's', runID: 'r', taskID: FIX_ROUNDING, repo: ledgerlite, result,
      gradedResultSnapshotDigest: snapshotDigest(result), gradedBaselineSnapshotDigest: snapshotDigest(snapshotOf(ledgerlite)),
      gradedFromBoundedReading: false,
    });
    expect(evidence.state).toBe('redacted');
    // And a document whose graded digest is not what its bytes rebuild is written incomplete, not good.
    const wrong = buildEditEvidence({
      slotKey: 's', runID: 'r', taskID: FIX_ROUNDING, repo: ledgerlite, result: apply(REFERENCE_SOLUTIONS[FIX_ROUNDING]),
      gradedResultSnapshotDigest: 'mldsnap1:0', gradedBaselineSnapshotDigest: snapshotDigest(snapshotOf(ledgerlite)),
      gradedFromBoundedReading: false,
    });
    expect(wrong.state).toBe('incomplete');
    expect(wrong.notByteExactBecause.join(' ')).toMatch(/write-time proof failed/);
    expect(wrong.changes.every((change) => change.contents === undefined)).toBe(true);
  });
});

// MARK: - Offline reinterpretation

describe('develop-reinterpret re-grades an edit row from its retained bytes, offline', () => {
  it('rebuilds, reproduces and re-grades every edit row, and moves nothing it did not have to', async () => {
    const { root, adapter } = await campaign();
    const callsBefore = adapter.calls;
    const before = hashes(root);

    const { reinterpretation, writtenTo } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true });

    expect(adapter.calls).toBe(callsBefore);
    expect(reinterpretation.formatVersion).toBe(2);
    expect(reinterpretation.editRows).toHaveLength(EDIT_TASKS.length);
    expect(reinterpretation.carriedUnchanged).toEqual([]);
    for (const row of reinterpretation.editRows) {
      const recorded = rowFor(root, row.taskID);
      expect(row.reproducedUnderOriginalContract).toBe(true);
      expect(row.answerKey.unchanged).toBe(true);
      expect(row.resultSnapshot).toEqual({ digest: recorded.resultSnapshotDigest, sha256: referenceOf(recorded).resultSnapshotSha256, reproduced: true });
      expect(row.evidence.sha256).toBe(referenceOf(recorded).sha256);
      expect(row.before.status).toBe(recorded.status);
      expect(row.after).toEqual({ status: row.before.status, structuralCredit: row.before.structuralCredit, failedAssertions: row.before.failedAssertions });
      expect(row.changed).toBe(false);
    }
    expect(Object.keys(reinterpretation.original.evidenceFiles)).toEqual(expect.arrayContaining([
      'results.jsonl', DEVELOPMENT_PLAN_FILE, ...rowsOf(root).map((row) => referenceOf(row).file),
      `${DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY}/baselines/${ledgerlite.id}@${ledgerlite.version}.json`,
    ]));

    // The original evidence is byte-for-byte what it was; the reinterpretation is a new file beside it.
    const after = hashes(root);
    for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
    expect(Object.keys(after).filter((file) => !(file in before))).toEqual([path.relative(root, writtenTo!)]);
    expect(path.dirname(writtenTo!)).toBe(path.join(root, DEVELOPMENT_REINTERPRETATIONS_DIRECTORY));
  });

  it('reproduces a failing edit exactly, failed assertions included', async () => {
    // Change the code but not the case table: a near-miss that must fail the same assertions twice.
    const nearMiss: Target = (taskID) => {
      const files = apply(REFERENCE_SOLUTIONS[taskID]);
      files.set('test/cases/rounding.cases.json', baseline.get('test/cases/rounding.cases.json')!);
      return files;
    };
    const { root } = await campaign(nearMiss);
    const recorded = rowFor(root, FIX_ROUNDING);
    expect(recorded.structuralCredit).not.toBe('full');
    const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    const row = reinterpretation.editRows.find((entry) => entry.taskID === FIX_ROUNDING)!;
    expect(row.before.failedAssertions.length).toBeGreaterThan(0);
    expect(row.after.failedAssertions).toEqual(row.before.failedAssertions);
    expect(row.after.status).toBe(recorded.status);
  });

  it('refuses when the retained bytes grade differently from the recorded row', async () => {
    const { root } = await campaign();
    const resultsFile = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map((line) => {
      const parsed = JSON.parse(line);
      if (parsed.taskID === HONOUR_MODE) parsed.structuralCredit = 'none';
      return JSON.stringify(parsed);
    });
    fs.writeFileSync(resultsFile, lines.join('\n') + '\n');
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false })).toThrow(/does not reproduce the recorded row/);
  });

  it('carries a row from a campaign that predates edit evidence, as dev-cohort-2\'s are', async () => {
    const { root } = await campaign();
    const resultsFile = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map((line) => {
      const { editEvidence: _unused, ...rest } = JSON.parse(line);
      return JSON.stringify(rest);
    });
    fs.writeFileSync(resultsFile, lines.join('\n') + '\n');
    fs.rmSync(path.join(root, DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY), { recursive: true });
    const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    expect(reinterpretation.editRows).toEqual([]);
    expect(reinterpretation.carriedUnchanged.map((entry) => entry.kind)).toEqual(EDIT_TASKS.map(() => 'noEditEvidence'));
  });

  it('never needs a provider: no adapter is taken, and no process or request is started', async () => {
    const { root } = await campaign();
    fs.rmSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY), { recursive: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('no request may be sent'); });
    try {
      const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true });
      expect(reinterpretation.editRows).toHaveLength(EDIT_TASKS.length);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(tripped).toEqual([]);
    // The modules that re-read evidence do not import anything that can reach a provider.
    for (const module of ['development-reinterpretation.ts', 'development-edit-evidence.ts']) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'engine', module), 'utf8');
      expect(source, module).not.toMatch(/from '\.\/(frontier-adapter|frontier-host|development-execution|claude|codex|opencode|http)/);
      expect(source, module).not.toMatch(/child_process|node:net|node:http/);
    }
  });
});
