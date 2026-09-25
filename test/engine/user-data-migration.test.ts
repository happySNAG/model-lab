// Cernum · the rename must not look like a deletion, AND must not be one.
//
// Every test here runs against REAL directories in a real temporary tree. The thing being verified is
// what happens to a person's files, and a mocked filesystem would verify that the mock was called --
// which is not the question. The question is whether eleven campaigns are still in both places
// afterwards.
//
// WHAT v0.2.1 DID, AND WHY THESE TESTS DID NOT CATCH IT. The migration MOVED: `fs.renameSync`, with
// a copy-then-`rmSync` fallback across devices. The suite asserted the destination was populated and
// never once asserted the SOURCE still existed, so "carried across" and "taken away" were
// indistinguishable to it. On a MacBook Pro on 2026-09-17, `evidence/` and `model-lab.log` left the
// `Model Lab` directory on first launch. Every test below that names the legacy side is there
// because of that.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MIGRATED_ENTRIES, MIGRATION_MARKER, LEGACY_PRODUCT_NAME,
  migrateUserData, legacyUserDataDirectory, entriesMatch,
} from '../../src/main/user-data-migration';
import { SettingsStore, evidenceRootFor } from '../../src/main/settings';
import { FileResultStore } from '../../src/core/file-store';
import { bundleDigest } from '../../src/core/store';

let root: string;
let legacy: string;
let current: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-migration-'));
  legacy = path.join(root, 'Model Lab');
  current = path.join(root, 'Cernum');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const LEDGER = '{"slotKey":"a"}\n';
const campaignFile = (base: string) =>
  path.join(base, 'campaigns', 'cernum-pass08-claude-canonical-a2', 'results.jsonl');

function seedLegacy(): void {
  fs.mkdirSync(path.join(legacy, 'campaigns', 'cernum-pass08-claude-canonical-a2'), { recursive: true });
  fs.writeFileSync(campaignFile(legacy), LEDGER);
  fs.mkdirSync(path.join(legacy, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'evidence', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"ollamaEndpoint":"http://127.0.0.1:11435"}');
  fs.writeFileSync(path.join(legacy, 'model-lab.log'), 'started\n');
  // Electron's own, which must NOT be carried across.
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cache', 'blob'), 'disposable');
}

/** Every file under a directory, with its bytes. The whole state, for before/after comparison. */
function snapshot(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const item of fs.readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) walk(next);
      else out[next] = fs.readFileSync(path.join(base, next), 'utf8');
    }
  };
  walk('');
  return out;
}

describe('the rename COPIES the evidence — the original stays where it was', () => {
  it('copies the campaigns, the evidence store, the settings and the log', () => {
    seedLegacy();
    const result = migrateUserData(legacy, current);
    expect(result.performed).toBe(true);
    expect(result.copied.sort()).toEqual([...MIGRATED_ENTRIES].sort());
    expect(fs.readFileSync(campaignFile(current), 'utf8')).toBe(LEDGER);
    expect(JSON.parse(fs.readFileSync(path.join(current, 'settings.json'), 'utf8')).ollamaEndpoint)
      .toBe('http://127.0.0.1:11435');
  });

  it('LEAVES EVERY ORIGINAL IN PLACE — the assertion v0.2.1 never made', () => {
    seedLegacy();
    const before = snapshot(legacy);

    migrateUserData(legacy, current);

    expect(snapshot(legacy)).toEqual(before);
    // Named individually, because these two are the ones that actually left a real machine.
    expect(fs.existsSync(path.join(legacy, 'evidence', 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'model-lab.log'), 'utf8')).toBe('started\n');
    expect(fs.readFileSync(campaignFile(legacy), 'utf8')).toBe(LEDGER);
  });

  it('says in its result, and in the marker, that the source was preserved', () => {
    seedLegacy();
    const result = migrateUserData(legacy, current);
    expect(result.sourcePreserved).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(current, MIGRATION_MARKER), 'utf8'));
    expect(marker.from).toBe(legacy);
    expect(marker.copied).toContain('campaigns');
    expect(marker.sourcePreserved).toBe(true);
    expect(marker.note).toContain('COPIED');
  });

  it('leaves Electron\'s disposable caches behind rather than copying them', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    expect(fs.existsSync(path.join(current, 'Cache'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'Cache'))).toBe(true);
  });

  it('carries `evidence/` across whole, including what is nested inside it', () => {
    seedLegacy();
    fs.mkdirSync(path.join(legacy, 'evidence', 'runs', 'pass08'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'evidence', 'runs', 'pass08', 'sealed.json'), '{"sealed":true}');

    migrateUserData(legacy, current);

    expect(fs.readFileSync(path.join(current, 'evidence', 'runs', 'pass08', 'sealed.json'), 'utf8')).toBe('{"sealed":true}');
    expect(fs.existsSync(path.join(legacy, 'evidence', 'runs', 'pass08', 'sealed.json'))).toBe(true);
  });

  it('carries `model-lab.log` across as a file, byte for byte, and keeps the original', () => {
    seedLegacy();
    fs.writeFileSync(path.join(legacy, 'model-lab.log'), 'line one\nline two\n');

    migrateUserData(legacy, current);

    expect(fs.readFileSync(path.join(current, 'model-lab.log'), 'utf8')).toBe('line one\nline two\n');
    expect(fs.readFileSync(path.join(legacy, 'model-lab.log'), 'utf8')).toBe('line one\nline two\n');
  });
});

describe('running again is uneventful — idempotence, by content', () => {
  it('reports the second run as already carried across, not as a conflict', () => {
    seedLegacy();
    migrateUserData(legacy, current);

    const again = migrateUserData(legacy, current);

    expect(again.performed).toBe(false);
    expect(again.copied).toEqual([]);
    expect(again.conflicts).toEqual([]);
    expect(again.alreadyPresent.sort()).toEqual([...MIGRATED_ENTRIES].sort());
    expect(again.reason).toContain('already been carried across');
  });

  it('changes nothing on either side across repeated launches', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    const legacyAfterFirst = snapshot(legacy);
    const currentAfterFirst = snapshot(current);

    migrateUserData(legacy, current);
    migrateUserData(legacy, current);

    expect(snapshot(legacy)).toEqual(legacyAfterFirst);
    expect(snapshot(current)).toEqual(currentAfterFirst);
  });

  it('does not touch work done in Cernum after the migration', () => {
    // The destination is live: campaigns get added to it. A later launch must not react to that by
    // copying over them, and must not call the directory a conflict for having grown.
    seedLegacy();
    migrateUserData(legacy, current);
    fs.mkdirSync(path.join(current, 'campaigns', 'run-after-migrating'), { recursive: true });
    fs.writeFileSync(path.join(current, 'campaigns', 'run-after-migrating', 'results.jsonl'), '{"new":true}\n');

    const again = migrateUserData(legacy, current);

    // The two sides now legitimately differ, so this is a conflict — and BOTH survive untouched.
    expect(again.conflicts).toContain('campaigns');
    expect(again.copied).not.toContain('campaigns');
    expect(fs.readFileSync(path.join(current, 'campaigns', 'run-after-migrating', 'results.jsonl'), 'utf8')).toBe('{"new":true}\n');
    expect(fs.readFileSync(campaignFile(current), 'utf8')).toBe(LEDGER);
    expect(fs.readFileSync(campaignFile(legacy), 'utf8')).toBe(LEDGER);
  });
});

describe('the migration refuses to destroy anything', () => {
  it('never overwrites: an entry differing on both sides is left untouched on both sides', () => {
    seedLegacy();
    fs.mkdirSync(path.join(current, 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(current, 'campaigns', 'already-here.txt'), 'new');

    const result = migrateUserData(legacy, current);
    expect(result.conflicts).toContain('campaigns');
    expect(result.copied).not.toContain('campaigns');
    // BOTH copies survive, intact.
    expect(fs.existsSync(path.join(current, 'campaigns', 'already-here.txt'))).toBe(true);
    expect(fs.readFileSync(campaignFile(legacy), 'utf8')).toBe(LEDGER);
    expect(result.reason).toContain('different contents');
  });

  it('calls a same-named, different-sized file a conflict rather than matching on name', () => {
    seedLegacy();
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'model-lab.log'), 'a completely different log\n');

    const result = migrateUserData(legacy, current);

    expect(result.conflicts).toContain('model-lab.log');
    expect(fs.readFileSync(path.join(current, 'model-lab.log'), 'utf8')).toBe('a completely different log\n');
    expect(fs.readFileSync(path.join(legacy, 'model-lab.log'), 'utf8')).toBe('started\n');
  });

  it('calls a same-SIZED, different-content file a conflict — content decides, not length', () => {
    seedLegacy();
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'model-lab.log'), 'AAAAAAA\n');
    fs.writeFileSync(path.join(current, 'model-lab.log'), 'BBBBBBB\n');

    const result = migrateUserData(legacy, current);

    expect(result.conflicts).toContain('model-lab.log');
    expect(result.alreadyPresent).not.toContain('model-lab.log');
  });

  it('still copies the entries that are clear when another one conflicts', () => {
    seedLegacy();
    fs.mkdirSync(path.join(current, 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(current, 'campaigns', 'already-here.txt'), 'new');

    const result = migrateUserData(legacy, current);

    expect(result.conflicts).toEqual(['campaigns']);
    expect(result.copied.sort()).toEqual(['evidence', 'model-lab.log', 'settings.json']);
    expect(fs.existsSync(path.join(current, 'evidence', 'manifest.json'))).toBe(true);
  });

  it('leaves the source intact when a copy FAILS, and leaves no half-copy behind', () => {
    seedLegacy();
    // A destination that cannot be written into: the parent is read-only, so creating `evidence`
    // under it fails. The source must survive, and nothing partial may be left at the destination.
    fs.mkdirSync(current, { recursive: true });
    const unwritable = path.join(root, 'locked');
    fs.mkdirSync(unwritable, { recursive: true });
    fs.chmodSync(unwritable, 0o500);
    try {
      const result = migrateUserData(legacy, unwritable);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.reason).toContain('the originals are untouched');
      // THE POINT: a failed migration costs nothing.
      expect(fs.readFileSync(campaignFile(legacy), 'utf8')).toBe(LEDGER);
      expect(fs.existsSync(path.join(legacy, 'evidence', 'manifest.json'))).toBe(true);
      expect(fs.readFileSync(path.join(legacy, 'model-lab.log'), 'utf8')).toBe('started\n');
      for (const entry of result.failures) {
        expect(fs.existsSync(path.join(unwritable, entry.entry))).toBe(false);
      }
    } finally {
      fs.chmodSync(unwritable, 0o700);
    }
  });

  it('says plainly that nothing happened when there is no previous directory', () => {
    const result = migrateUserData(path.join(root, 'nothing-here'), current);
    expect(result.performed).toBe(false);
    expect(result.reason).toContain('no previous data directory');
  });

  it('does nothing when the directory did not actually move', () => {
    seedLegacy();
    const result = migrateUserData(legacy, legacy);
    expect(result.performed).toBe(false);
    expect(result.reason).toContain('did not move');
    expect(fs.existsSync(path.join(legacy, 'campaigns'))).toBe(true);
  });

  it('ignores a previous directory that holds only Electron\'s own files', () => {
    fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
    const result = migrateUserData(legacy, current);
    expect(result.performed).toBe(false);
    expect(result.reason).toContain('nothing this application owns');
  });
});

describe('entriesMatch decides "already done" from bytes', () => {
  it('matches a directory copied faithfully', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    expect(entriesMatch(path.join(legacy, 'evidence'), path.join(current, 'evidence'))).toBe(true);
    expect(entriesMatch(path.join(legacy, 'campaigns'), path.join(current, 'campaigns'))).toBe(true);
  });

  it('refuses a directory that gained a file', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    fs.writeFileSync(path.join(current, 'evidence', 'extra.json'), '{}');
    expect(entriesMatch(path.join(legacy, 'evidence'), path.join(current, 'evidence'))).toBe(false);
  });

  it('refuses a file compared against a directory', () => {
    seedLegacy();
    expect(entriesMatch(path.join(legacy, 'model-lab.log'), path.join(legacy, 'evidence'))).toBe(false);
  });

  it('refuses rather than throwing when one side cannot be read', () => {
    seedLegacy();
    expect(entriesMatch(path.join(legacy, 'evidence'), path.join(root, 'no-such-thing'))).toBe(false);
  });
});

describe('the legacy location is named, not guessed', () => {
  it('points at the pre-rename product directory', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('Model Lab');
    expect(legacyUserDataDirectory('/Users/x/Library/Application Support'))
      .toBe('/Users/x/Library/Application Support/Model Lab');
  });
});

describe('an install from the Model Lab era still LOADS after the rename, not merely copies', () => {
  // Copying bytes is necessary but not sufficient: the point is that Cernum then reads them. The
  // evidence here is the sealed parity store, which was written under the old identity (its manifest
  // still says "Skippy Model Lab"), so it is a real pre-rename store rather than one made up for this.
  const sealedStore = path.resolve(__dirname, '../../fixtures/parity/store');

  it('reads the migrated settings and opens the migrated evidence store with every run intact', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.cpSync(sealedStore, path.join(legacy, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"ollamaEndpoint":"http://127.0.0.1:11435","thinkingMode":"enabled"}');
    fs.writeFileSync(path.join(legacy, 'model-lab.log'), 'started\n');

    const result = migrateUserData(legacy, current);
    expect(result.copied.sort()).toEqual(['evidence', 'model-lab.log', 'settings.json']);

    const settings = new SettingsStore(path.join(current, 'settings.json')).get();
    expect(settings.ollamaEndpoint).toBe('http://127.0.0.1:11435');
    expect(settings.thinkingMode).toBe('enabled');

    const migrated = await FileResultStore.open(evidenceRootFor(current, settings));
    expect((await migrated.runIDs()).sort()).toEqual(fs.readdirSync(path.join(sealedStore, 'runs')).sort());

    // The same records, byte for byte in digest terms, as a store opened straight from the sealed copy.
    const reference = path.join(root, 'reference');
    fs.cpSync(sealedStore, reference, { recursive: true });
    expect(bundleDigest(await migrated.exportAll()))
      .toBe(bundleDigest(await (await FileResultStore.open(reference)).exportAll()));
  });
});
