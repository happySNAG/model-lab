// The held-out rotation (cho1): a partition of a pack's cases by sha256(`${caseDigest}:${epoch}`), and
// the exposure of each case in run rows.
//
// FIXTURES ONLY. The cases are in-memory declarations, plus the registered catalogue (read and never
// run) for the digest check. Run rows are in-memory objects. No driver runs and no provider is
// contacted; the one file-backed check writes only under a temporary root in os.tmpdir(), removed in
// afterEach.

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HELD_OUT_IS_NOT_ENFORCED, HELD_OUT_ROTATION_SCHEMA, HeldOutCaseInput, HeldOutPartition, caseExposure,
  deriveHeldOutPartition, heldOutCaseInput,
} from '../../src/engine/held-out-rotation';
import {
  WORKSPACE_PACK_DISCRIMINATOR_ONE, WORKSPACE_PACK_FORWARD_COMPAT_ONE, allWorkspaceCases, workspacePackByID,
} from '../../src/engine/workspace-catalog';
import { resolveWorkspacePack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { workspaceCaseDigest } from '../../src/engine/workspace-case';

/** Taken from workspacePackDigest at a28ea13, before this module existed. Written out on purpose. */
const PACK_DIGESTS_AT_BASE: Record<string, string> = {
  [WORKSPACE_PACK_DISCRIMINATOR_ONE]: 'cwp1:03afd8f384dfe800245beb3e3f7ccf1eef1667c37a04672d0f3c1f91bd388edf',
  [WORKSPACE_PACK_FORWARD_COMPAT_ONE]: 'cwp1:8963add832ae8b58fea1a11c5c71a1aee8d9e6e438d2018441370e6236a2b2e0',
};

const fixtureCases = (count: number): HeldOutCaseInput[] =>
  Array.from({ length: count }, (_, index) => ({ id: `ws.fixture.${String(index).padStart(2, '0')}`, caseDigest: `cwc1:fixture-${index}` }));

const row = (caseDigest: unknown, status = 'pass') => ({ row: { caseDigest, status } as Record<string, unknown> });

const packCases = (packID: string) => {
  const pack = workspacePackByID(packID);
  expect(pack).toBeDefined();
  return resolveWorkspacePack(pack!, allWorkspaceCases()).map(heldOutCaseInput);
};

const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length > 0) fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

// ------------------------------------------------------------------ (a) deterministic, and it rotates

describe('(a) the same epoch gives the same partition; a different epoch can rotate it', () => {
  it('is identical for the same cases and epoch, in any input order', () => {
    const cases = fixtureCases(10);
    const first = deriveHeldOutPartition(cases, { epoch: 'e1', heldOutCount: 3 });
    expect(first.schema).toBe(HELD_OUT_ROTATION_SCHEMA);
    expect(first.epoch).toBe('e1');
    expect(deriveHeldOutPartition(cases, { epoch: 'e1', heldOutCount: 3 })).toEqual(first);
    expect(JSON.stringify(deriveHeldOutPartition([...cases].reverse(), { epoch: 'e1', heldOutCount: 3 }))).toBe(JSON.stringify(first));
  });

  it('a numeric epoch and its decimal string give the same partition', () => {
    const cases = fixtureCases(6);
    expect(deriveHeldOutPartition(cases, { epoch: 7, heldOutCount: 2 })).toEqual(deriveHeldOutPartition(cases, { epoch: '7', heldOutCount: 2 }));
  });

  it('ranks by sha256 of `${caseDigest}:${epoch}`', () => {
    const cases = fixtureCases(5);
    const partition = deriveHeldOutPartition(cases, { epoch: 3, heldOutCount: 2 });
    const expected = [...cases]
      .map((entry) => ({ id: entry.id, key: createHash('sha256').update(`${entry.caseDigest}:3`).digest('hex') }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    expect(partition.cases.map((entry) => entry.id)).toEqual(expected.map((entry) => entry.id));
    expect(partition.heldOut).toEqual(expected.slice(0, 2).map((entry) => entry.id).sort());
  });

  it('a different epoch rotates the held-out set, for fixtures and for a registered pack', () => {
    const cases = fixtureCases(10);
    const base = deriveHeldOutPartition(cases, { epoch: 0, heldOutCount: 3 });
    const rotated = Array.from({ length: 20 }, (_, epoch) => epoch + 1)
      .map((epoch) => deriveHeldOutPartition(cases, { epoch, heldOutCount: 3 }))
      .find((partition) => JSON.stringify(partition.heldOut) !== JSON.stringify(base.heldOut));
    expect(rotated).toBeDefined();

    const discriminator = packCases(WORKSPACE_PACK_DISCRIMINATOR_ONE);
    expect(discriminator.length).toBeGreaterThan(1);
    const packBase = deriveHeldOutPartition(discriminator, { epoch: 0, heldOutCount: 1 });
    const packRotated = Array.from({ length: 20 }, (_, epoch) => epoch + 1)
      .map((epoch) => deriveHeldOutPartition(discriminator, { epoch, heldOutCount: 1 }))
      .find((partition) => partition.heldOut[0] !== packBase.heldOut[0]);
    expect(packRotated).toBeDefined();
  });
});

// ------------------------------------------------------------------ (b) disjoint and covering

describe('(b) the two parts are disjoint and together cover the input', () => {
  it('holds for every count and several epochs', () => {
    const cases = fixtureCases(7);
    const allIDs = cases.map((entry) => entry.id).sort();
    for (const epoch of ['a', 'b', 0, 1, 99]) {
      for (let heldOutCount = 1; heldOutCount < cases.length; heldOutCount += 1) {
        const partition = deriveHeldOutPartition(cases, { epoch, heldOutCount });
        expect(partition.heldOut).toHaveLength(heldOutCount);
        expect(partition.exposed).toHaveLength(cases.length - heldOutCount);
        expect(partition.heldOut.filter((id) => partition.exposed.includes(id))).toEqual([]);
        expect([...partition.heldOut, ...partition.exposed].sort()).toEqual(allIDs);
        expect(partition.cases.filter((entry) => entry.part === 'heldOut').map((entry) => entry.id).sort()).toEqual(partition.heldOut);
      }
    }
  });

  it('holds for the registered forward-compat pack', () => {
    const cases = packCases(WORKSPACE_PACK_FORWARD_COMPAT_ONE);
    const partition = deriveHeldOutPartition(cases, { epoch: 'cho1-test', heldOutCount: 1 });
    expect([...partition.heldOut, ...partition.exposed].sort()).toEqual(cases.map((entry) => entry.id).sort());
    expect(partition.heldOut.filter((id) => partition.exposed.includes(id))).toEqual([]);
  });
});

// ------------------------------------------------------------------ (c) exposure

describe('(c) a held-out case present in run rows is flagged exposed', () => {
  const cases = fixtureCases(6);
  const partition: HeldOutPartition = deriveHeldOutPartition(cases, { epoch: 'leak', heldOutCount: 2 });
  const digestOf = (id: string) => cases.find((entry) => entry.id === id)!.caseDigest;

  it('flags the held-out case that has runs, and only it', () => {
    const [leaked, clean] = partition.heldOut;
    const exposedCase = partition.exposed[0]!;
    const report = caseExposure([
      row(digestOf(leaked!)), row(digestOf(leaked!), 'fail'),
      row(digestOf(exposedCase)), row('cwc1:not-in-partition'), row(undefined), { row: {} },
    ], partition);
    expect(report.schema).toBe(HELD_OUT_ROTATION_SCHEMA);
    expect(report.exposedHeldOut).toEqual([leaked]);
    const entry = (id: string) => report.cases.find((candidate) => candidate.caseID === id)!;
    expect(entry(leaked!)).toMatchObject({ part: 'heldOut', runs: 2, heldOutExposed: true });
    expect(entry(clean!)).toMatchObject({ part: 'heldOut', runs: 0, heldOutExposed: false });
    expect(entry(exposedCase)).toMatchObject({ part: 'exposed', runs: 1, heldOutExposed: false });
    expect(report.runsByCaseDigest[digestOf(leaked!)]).toBe(2);
    expect(report.unmatchedRows).toBe(1);
    expect(report.undigestedRows).toBe(2);
  });

  it('no rows means nothing is exposed', () => {
    const report = caseExposure([], partition);
    expect(report.exposedHeldOut).toEqual([]);
    expect(report.cases.every((entry) => entry.runs === 0 && !entry.heldOutExposed)).toBe(true);
  });

  it('matches rows read back from a file under os.tmpdir() by caseDigest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-cho1-'));
    temporaryRoots.push(root);
    const file = path.join(root, 'rows.json');
    fs.writeFileSync(file, JSON.stringify([{ caseDigest: digestOf(partition.heldOut[1]!), status: 'pass' }]));
    const rows = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[]).map((entry) => ({ row: entry }));
    expect(caseExposure(rows, partition).exposedHeldOut).toEqual([partition.heldOut[1]]);
  });

  it('leaves the rows and the partition unchanged', () => {
    const rows = [row(digestOf(partition.heldOut[0]!))];
    const before = structuredClone({ rows, partition });
    caseExposure(rows, partition);
    expect({ rows, partition }).toEqual(before);
  });
});

// ------------------------------------------------------------------ (d) refusals

describe('(d) heldOutCount at or above the case count is refused', () => {
  const cases = fixtureCases(4);

  it('refuses heldOutCount equal to and above the case count', () => {
    expect(() => deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: 4 })).toThrow(/fewer than the 4 cases/);
    expect(() => deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: 5 })).toThrow(/fewer than the 4 cases/);
    expect(() => deriveHeldOutPartition([], { epoch: 1, heldOutCount: 1 })).toThrow(/fewer than the 0 cases/);
  });

  it('refuses heldOutCount below 1 or fractional, and a bad epoch', () => {
    expect(() => deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: 0 })).toThrow(/at least 1/);
    expect(() => deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: -1 })).toThrow(/at least 1/);
    expect(() => deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: 1.5 })).toThrow(/integer/);
    expect(() => deriveHeldOutPartition(cases, { epoch: '', heldOutCount: 1 })).toThrow(/epoch/);
    expect(() => deriveHeldOutPartition(cases, { epoch: -1, heldOutCount: 1 })).toThrow(/epoch/);
  });

  it('refuses duplicate ids or digests', () => {
    expect(() => deriveHeldOutPartition([...cases, { ...cases[0]!, caseDigest: 'cwc1:other' }], { epoch: 1, heldOutCount: 1 })).toThrow(/appears twice/);
    expect(() => deriveHeldOutPartition([...cases, { id: 'ws.fixture.new', caseDigest: cases[0]!.caseDigest }], { epoch: 1, heldOutCount: 1 })).toThrow(/appears twice/);
  });

  it('accepts one fewer than the case count', () => {
    expect(deriveHeldOutPartition(cases, { epoch: 1, heldOutCount: 3 }).exposed).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ (e) nothing moved

describe('(e) the existing pack digests are unchanged, checked against literal values', () => {
  it('states that it is reporting only', () => {
    expect(HELD_OUT_IS_NOT_ENFORCED).toMatch(/cqp1/);
  });

  it('the discriminator and forward-compat pack digests equal their base values before and after partitioning', () => {
    const cases = allWorkspaceCases();
    const digests = () => Object.fromEntries(
      [WORKSPACE_PACK_DISCRIMINATOR_ONE, WORKSPACE_PACK_FORWARD_COMPAT_ONE].map((id) => [id, workspacePackDigest(workspacePackByID(id)!, cases)]),
    );
    const caseDigests = cases.map(workspaceCaseDigest);
    const snapshot = structuredClone(cases);
    expect(digests()).toEqual(PACK_DIGESTS_AT_BASE);

    for (const id of [WORKSPACE_PACK_DISCRIMINATOR_ONE, WORKSPACE_PACK_FORWARD_COMPAT_ONE]) {
      const inputs = packCases(id);
      const partition = deriveHeldOutPartition(inputs, { epoch: 'cho1', heldOutCount: 1 });
      caseExposure(inputs.map((entry) => ({ row: { caseDigest: entry.caseDigest } })), partition);
    }

    expect(digests()).toEqual(PACK_DIGESTS_AT_BASE);
    expect(cases.map(workspaceCaseDigest)).toEqual(caseDigests);
    expect(cases).toEqual(snapshot);
  });
});
