// Cernum · carrying a person's evidence across the rename.
//
// THE PROBLEM THIS EXISTS FOR. Electron derives `userData` from the application's NAME. Renaming the
// product from "Model Lab" to "Cernum" therefore silently repoints that directory: the application
// comes up with no campaigns, no evidence store and default settings, while every byte is still on
// disk under the old name. Nothing is lost and nothing says so, which is the worst version of this
// failure -- a person reasonably concludes their benchmark history was deleted by an update.
//
// WHAT THIS DOES, AND WHAT IT REFUSES TO DO.
//
//   It moves only the entries the APPLICATION owns: the campaign directory, the evidence store, the
//   settings file and the log. Electron's own caches are left behind to be rebuilt, because they are
//   disposable and copying them would be the slow, pointless half of the job.
//
//   It NEVER overwrites. If an entry already exists at the destination, that entry is skipped and
//   reported as a conflict. A half-populated new directory is a situation for a person to look at,
//   not for a migration to resolve by picking a winner.
//
//   It NEVER deletes. A move that cannot be done as a rename is done as copy-then-remove-source, and
//   a failure at any point leaves the source intact. If this code has a bug, the outcome is a
//   duplicate -- never an absence.
//
// It takes its directories as arguments and touches no Electron API, so it is tested against real
// files rather than mocked ones.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The entries the application owns. Everything else in `userData` belongs to Electron. */
export const MIGRATED_ENTRIES: readonly string[] = [
  'campaigns',
  'evidence',
  'settings.json',
  'model-lab.log',
];

/** Written into the new directory so the move is a fact on disk, not an inference. */
export const MIGRATION_MARKER = 'migrated-from.json';

export interface MigrationResult {
  performed: boolean;
  /** One sentence, always populated, suitable for the application log. */
  reason: string;
  legacyDirectory: string;
  currentDirectory: string;
  moved: string[];
  /** Entries present in BOTH directories. Left untouched on both sides. */
  conflicts: string[];
  failures: { entry: string; detail: string }[];
}

function exists(target: string): boolean {
  try { fs.statSync(target); return true; } catch { return false; }
}

/**
 * Move one entry, preferring a rename and falling back to a copy.
 *
 * `fs.renameSync` fails with EXDEV when the two directories are on different filesystems, which is
 * ordinary on macOS when one of them has been relocated to an external volume. The fallback copies
 * first and only removes the source once the copy has completed.
 */
function moveEntry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
  }
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(from, { recursive: true, force: true });
}

/**
 * Carry the application's data from the pre-rename directory to the current one.
 *
 * Safe to call on every launch: once the legacy directory has given up its entries there is nothing
 * left to move, and the call becomes a pair of `stat`s.
 */
export function migrateUserData(legacyDirectory: string, currentDirectory: string): MigrationResult {
  const base: MigrationResult = {
    performed: false, reason: '', legacyDirectory, currentDirectory,
    moved: [], conflicts: [], failures: [],
  };

  if (path.resolve(legacyDirectory) === path.resolve(currentDirectory)) {
    return { ...base, reason: 'the data directory did not move; there is nothing to migrate' };
  }
  if (!exists(legacyDirectory)) {
    return { ...base, reason: `no previous data directory at ${legacyDirectory}` };
  }

  const present = MIGRATED_ENTRIES.filter((entry) => exists(path.join(legacyDirectory, entry)));
  if (present.length === 0) {
    return { ...base, reason: `${legacyDirectory} holds nothing this application owns` };
  }

  fs.mkdirSync(currentDirectory, { recursive: true });
  const moved: string[] = [];
  const conflicts: string[] = [];
  const failures: { entry: string; detail: string }[] = [];

  for (const entry of present) {
    const from = path.join(legacyDirectory, entry);
    const to = path.join(currentDirectory, entry);
    if (exists(to)) {
      // BOTH SIDES HAVE IT. Nothing is overwritten and nothing is merged: a person decides.
      conflicts.push(entry);
      continue;
    }
    try {
      moveEntry(from, to);
      moved.push(entry);
    } catch (error) {
      failures.push({ entry, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const reason = moved.length > 0
    ? `carried ${moved.length} item(s) forward from ${legacyDirectory}: ${moved.join(', ')}`
      + (conflicts.length > 0 ? `; left ${conflicts.join(', ')} in place because the new directory already had them` : '')
      + (failures.length > 0 ? `; FAILED to move ${failures.map((f) => f.entry).join(', ')} — the originals are untouched` : '')
    : conflicts.length > 0
      ? `nothing was moved: ${conflicts.join(', ')} exist in both directories and neither copy was touched`
      : `nothing was moved from ${legacyDirectory}`;

  if (moved.length > 0) {
    try {
      fs.writeFileSync(path.join(currentDirectory, MIGRATION_MARKER), JSON.stringify({
        migratedAt: new Date().toISOString(),
        from: legacyDirectory,
        to: currentDirectory,
        moved, conflicts,
        failures: failures.map((f) => f.entry),
        note: 'Written by the product rename migration. Entries not listed here were left where they were; '
            + 'Electron rebuilt its own caches. Nothing was deleted and nothing was overwritten.',
      }, null, 2) + '\n', 'utf8');
    } catch { /* the marker is a courtesy; failing to write it must never fail the migration */ }
  }

  return { performed: moved.length > 0, reason, legacyDirectory, currentDirectory, moved, conflicts, failures };
}

/** The pre-rename directory name, kept in one place so a reader can find what it was called. */
export const LEGACY_PRODUCT_NAME = 'Model Lab';

/** Where the data lived before the rename, given Electron's per-user application-data directory. */
export function legacyUserDataDirectory(appDataDirectory: string): string {
  return path.join(appDataDirectory, LEGACY_PRODUCT_NAME);
}
