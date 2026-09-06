// Parity · the on-disk evidence store. A store written by the canonical Swift file store is opened by
// the portable file store: every envelope digest is recomputed and must match, the bundle digest must
// match, and a store written here re-seals byte-identically (so the Swift CLI can validate it too).

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileResultStore } from '@core/file-store';
import { bundleDigest } from '@core/store';
import { canonicalJSON, seal, steppingClock } from '@core/digest';
import { planRun, syntheticEnvironmentWithHardware } from '@core/run';
import { deterministicFake } from '@core/candidate';
import { foundationSuite } from '@core/foundation';
import { DeterministicFakeAdapter } from '@core/fake-adapter';
import { RunExecutor } from '@core/executor';
import { CancellationToken } from '@core/adapter';
import { EvaluationEngine } from '@core/engine';
import { policyCatalog } from '@core/catalog';
import { fixturesRoot, loadFixture } from './fixtures';

interface StoreSummary { totalRecords: number; corruptRecords: number; bundleDigest: string; runIDs: string[] }

describe('Swift-written store read by the portable store', () => {
  const root = path.join(fixturesRoot, 'store');
  const summary = loadFixture<StoreSummary>('store-summary.json');

  it('opens, validates every envelope digest, and reports the same integrity', async () => {
    const store = await FileResultStore.open(root);
    const integrity = await store.integrity();
    expect(integrity.totalRecords).toBe(summary.totalRecords);
    expect(integrity.corruptRecords).toBe(summary.corruptRecords);
    expect(integrity.decodableRecords).toBe(summary.totalRecords);
    expect(await store.runIDs()).toEqual(summary.runIDs);
  });

  it('exports a bundle with the same digest as the Swift export', async () => {
    const store = await FileResultStore.open(root);
    const bundle = await store.exportAll();
    expect(bundleDigest(bundle)).toBe(summary.bundleDigest);
    expect(bundle.humanReviews.length).toBe(1);
    expect(bundle.recommendations.length).toBe(1);
    expect(bundle.plans.length).toBe(2);
  });

  it('re-seals every stored payload to its stored envelope digest (canonical-encoding parity on real records)', async () => {
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.json') && entry.name !== 'store-manifest.json') files.push(full);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(seal(envelope.payload, 'mla1:'), file).toBe(envelope.payloadDigest);
    }
  });
});

describe('portable store written on disk', () => {
  it('writes the canonical layout, refuses collisions, survives reopen, and surfaces corruption honestly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-lab-store-'));
    const store = await FileResultStore.open(root);
    const clock = steppingClock();
    const plan = planRun('disk-run-1', foundationSuite, [deterministicFake]);
    const executor = new RunExecutor(new DeterministicFakeAdapter('succeed'), store, syntheticEnvironmentWithHardware, clock);
    await executor.execute(plan, foundationSuite, new CancellationToken());
    await new EvaluationEngine(policyCatalog, clock).evaluateRun('disk-run-1', store);

    for (const p of ['store-manifest.json', 'runs/disk-run-1/plan.json', 'runs/disk-run-1/summary.json', 'runs/disk-run-1/attempts/0.json', 'scores', 'evaluations', 'reviews', 'recommendations']) {
      await expect(fs.access(path.join(root, p))).resolves.toBeUndefined();
    }
    await expect(store.appendPlan(plan)).rejects.toMatchObject({ code: 'duplicateRun' });
    const digestBefore = bundleDigest(await store.exportAll());

    const reopened = await FileResultStore.open(root);
    expect(await reopened.runIDs()).toEqual(['disk-run-1']);
    expect((await reopened.attempts('disk-run-1')).length).toBe(5);
    expect(bundleDigest(await reopened.exportAll())).toBe(digestBefore);
    const integrity = await reopened.integrity();
    expect(integrity.corruptRecords).toBe(0);

    // Tamper with one record: the digest check refuses it, and integrity counts it.
    const attemptFile = path.join(root, 'runs/disk-run-1/attempts/0.json');
    const envelope = JSON.parse(await fs.readFile(attemptFile, 'utf8'));
    envelope.payload.observation.outputText = 'tampered';
    await fs.writeFile(attemptFile, JSON.stringify(envelope));
    await expect(reopened.attempts('disk-run-1')).rejects.toMatchObject({ code: 'corruptRecord' });
    expect((await reopened.integrity()).corruptRecords).toBe(1);

    // Envelope payloads are canonical-encodable (no floats, no undefined leaks).
    expect(() => canonicalJSON(envelope.payload)).not.toThrow();
  });
});
