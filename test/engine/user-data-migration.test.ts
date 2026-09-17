// Cernum · the rename must not look like a deletion.
//
// Every test here runs against REAL directories in a real temporary tree. The thing being verified is
// file movement, and a mocked filesystem would verify that the mock was called -- which is not the
// question. The question is whether a person's eleven campaigns are still there afterwards.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MIGRATED_ENTRIES, MIGRATION_MARKER, LEGACY_PRODUCT_NAME,
  migrateUserData, legacyUserDataDirectory,
} from '../../src/main/user-data-migration';

let root: string;
let legacy: string;
let current: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-migration-'));
  legacy = path.join(root, 'Model Lab');
  current = path.join(root, 'Cernum');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedLegacy(): void {
  fs.mkdirSync(path.join(legacy, 'campaigns', 'cernum-pass08-claude-canonical-a2'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'campaigns', 'cernum-pass08-claude-canonical-a2', 'results.jsonl'), '{"slotKey":"a"}\n');
  fs.mkdirSync(path.join(legacy, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'evidence', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"ollamaEndpoint":"http://127.0.0.1:11435"}');
  fs.writeFileSync(path.join(legacy, 'model-lab.log'), 'started\n');
  // Electron's own, which must NOT be carried across.
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cache', 'blob'), 'disposable');
}

describe('the rename carries the evidence with it', () => {
  it('moves the campaigns, the evidence store, the settings and the log', () => {
    seedLegacy();
    const result = migrateUserData(legacy, current);
    expect(result.performed).toBe(true);
    expect(result.moved.sort()).toEqual([...MIGRATED_ENTRIES].sort());
    expect(fs.readFileSync(path.join(current, 'campaigns', 'cernum-pass08-claude-canonical-a2', 'results.jsonl'), 'utf8'))
      .toBe('{"slotKey":"a"}\n');
    expect(JSON.parse(fs.readFileSync(path.join(current, 'settings.json'), 'utf8')).ollamaEndpoint)
      .toBe('http://127.0.0.1:11435');
  });

  it('leaves Electron\'s disposable caches behind rather than copying them', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    expect(fs.existsSync(path.join(current, 'Cache'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'Cache'))).toBe(true);
  });

  it('records the move on disk, so it is a fact rather than an inference', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    const marker = JSON.parse(fs.readFileSync(path.join(current, MIGRATION_MARKER), 'utf8'));
    expect(marker.from).toBe(legacy);
    expect(marker.moved).toContain('campaigns');
  });

  it('is safe to run again: the second call finds nothing and does nothing', () => {
    seedLegacy();
    migrateUserData(legacy, current);
    const again = migrateUserData(legacy, current);
    expect(again.performed).toBe(false);
    expect(again.moved).toEqual([]);
    expect(fs.existsSync(path.join(current, 'campaigns'))).toBe(true);
  });
});

describe('the migration refuses to destroy anything', () => {
  it('never overwrites: an entry in both directories is left untouched on both sides', () => {
    seedLegacy();
    fs.mkdirSync(path.join(current, 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(current, 'campaigns', 'already-here.txt'), 'new');

    const result = migrateUserData(legacy, current);
    expect(result.conflicts).toContain('campaigns');
    expect(result.moved).not.toContain('campaigns');
    // BOTH copies survive, intact.
    expect(fs.existsSync(path.join(current, 'campaigns', 'already-here.txt'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'campaigns', 'cernum-pass08-claude-canonical-a2', 'results.jsonl'))).toBe(true);
    expect(result.reason).toContain('already had them');
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

describe('the legacy location is named, not guessed', () => {
  it('points at the pre-rename product directory', () => {
    expect(LEGACY_PRODUCT_NAME).toBe('Model Lab');
    expect(legacyUserDataDirectory('/Users/x/Library/Application Support'))
      .toBe('/Users/x/Library/Application Support/Model Lab');
  });
});
