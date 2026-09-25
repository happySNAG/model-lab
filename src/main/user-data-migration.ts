// Cernum · carrying a person's evidence across the rename, WITHOUT taking it away from where it was.
//
// THE PROBLEM THIS EXISTS FOR. Electron derives `userData` from the application's NAME. Renaming the
// product from "Model Lab" to "Cernum" therefore silently repoints that directory: the application
// comes up with no campaigns, no evidence store and default settings, while every byte is still on
// disk under the old name. Nothing is lost and nothing says so, which is the worst version of this
// failure -- a person reasonably concludes their benchmark history was deleted by an update.
//
// THE DEFECT THIS FILE WAS REWRITTEN TO FIX (v0.2.2). Until v0.2.1 this migration MOVED. Its own
// header said "It NEVER deletes", and that sentence was false as written: `fs.renameSync` takes the
// source away, and the cross-device fallback copied and then called `fs.rmSync` on the original. On
// a real machine -- a MacBook Pro, on 2026-09-17 -- `evidence/` and `model-lab.log` left the
// `Model Lab` directory on first launch and existed afterwards only under `Cernum`. Nothing was
// lost, and the release notes still described behaviour the code did not have.
//
// A migration is now a COPY, and the source is read-only to this module. There is no code path here
// that renames, unlinks or removes anything inside the legacy directory -- the one `rm` in this file
// removes a PARTIAL DESTINATION this module itself just created and could not finish.
//
// WHY COPY RATHER THAN MOVE. A move makes the old directory an unreliable witness: after it, the
// only copy of an evidence store is the one the new code just wrote, and if that write was wrong
// there is nothing to compare against. Duplication costs disk and buys a second opinion. A person
// who wants the space back can delete the old directory themselves, knowing what they are deleting.
//
// It takes its directories as arguments and touches no Electron API, so it is tested against real
// files rather than mocked ones.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The entries the application owns. Everything else in `userData` belongs to Electron. */
export const MIGRATED_ENTRIES: readonly string[] = [
  'campaigns',
  'evidence',
  'settings.json',
  // The pre-rename log name. It is copied across under the SAME name and kept as history beside
  // `cernum.log`; renaming it here would make the migration miss it on every old install.
  'model-lab.log',
];

/** Written into the new directory so the copy is a fact on disk, not an inference. */
export const MIGRATION_MARKER = 'migrated-from.json';

export interface MigrationResult {
  performed: boolean;
  /** One sentence, always populated, suitable for the application log. */
  reason: string;
  legacyDirectory: string;
  currentDirectory: string;
  /** Entries copied by THIS call. The originals are still in the legacy directory. */
  copied: string[];
  /**
   * Entries already at the destination and identical to the source. This is the steady state after a
   * successful migration, and it is not a conflict: running again is meant to be uneventful.
   */
  alreadyPresent: string[];
  /** Entries present on BOTH sides with DIFFERENT contents. Left untouched on both sides. */
  conflicts: string[];
  failures: { entry: string; detail: string }[];
  /** Always true. Stated so a caller can log it rather than assume it. */
  sourcePreserved: true;
}

function exists(target: string): boolean {
  try { fs.statSync(target); return true; } catch { return false; }
}

/** Every file under `root`, as paths relative to it. A file argument yields a single empty path. */
function filesUnder(root: string): string[] {
  const stats = fs.statSync(root);
  if (!stats.isDirectory()) return [''];
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Whether two entries hold the same bytes.
 *
 * THE IDEMPOTENCY QUESTION, ANSWERED BY CONTENT. After a copy, both sides hold the same data, and a
 * later launch must call that "already carried across" rather than "conflict" -- otherwise the
 * normal state of every migrated machine reads as a problem needing a person. Compared by relative
 * path set first, then size, then SHA-256, so a same-sized different file cannot pass.
 */
export function entriesMatch(a: string, b: string): boolean {
  try {
    const aDirectory = fs.statSync(a).isDirectory();
    if (aDirectory !== fs.statSync(b).isDirectory()) return false;
    if (!aDirectory) return fs.statSync(a).size === fs.statSync(b).size && digest(a) === digest(b);

    const left = filesUnder(a);
    const right = filesUnder(b);
    if (left.length !== right.length) return false;
    if (left.some((relative, index) => relative !== right[index])) return false;
    for (const relative of left) {
      const one = path.join(a, relative);
      const two = path.join(b, relative);
      if (fs.statSync(one).size !== fs.statSync(two).size) return false;
      if (digest(one) !== digest(two)) return false;
    }
    return true;
  } catch {
    // Unreadable on either side is not "the same". It is a conflict for a person to look at.
    return false;
  }
}

/**
 * Copy one entry. The source is never renamed, never unlinked and never truncated.
 *
 * `errorOnExist` guards the destination even though the caller has already checked it, because the
 * check and the copy are not atomic. A copy that fails part-way leaves a partial directory that a
 * LATER launch would compare against the source, find different, and report as a conflict — so the
 * partial destination is removed here, and only ever the destination.
 */
function copyEntry(from: string, to: string): void {
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* best effort; never touches the source */ }
    throw error;
  }
}

/**
 * Carry the application's data from the pre-rename directory to the current one, leaving the
 * original exactly where it is.
 *
 * Safe to call on every launch, and meant to be: once the entries have been copied, later calls
 * confirm the two sides still match and report that they did nothing.
 */
export function migrateUserData(legacyDirectory: string, currentDirectory: string): MigrationResult {
  const base: MigrationResult = {
    performed: false, reason: '', legacyDirectory, currentDirectory,
    copied: [], alreadyPresent: [], conflicts: [], failures: [], sourcePreserved: true,
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
  const copied: string[] = [];
  const alreadyPresent: string[] = [];
  const conflicts: string[] = [];
  const failures: { entry: string; detail: string }[] = [];

  for (const entry of present) {
    const from = path.join(legacyDirectory, entry);
    const to = path.join(currentDirectory, entry);
    if (exists(to)) {
      // BOTH SIDES HAVE IT. Identical means this has already been done; different means a person
      // decides. Nothing is overwritten and nothing is merged in either case.
      if (entriesMatch(from, to)) alreadyPresent.push(entry);
      else conflicts.push(entry);
      continue;
    }
    try {
      copyEntry(from, to);
      copied.push(entry);
    } catch (error) {
      failures.push({ entry, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const clauses: string[] = [];
  if (copied.length > 0) clauses.push(`copied ${copied.length} item(s) forward from ${legacyDirectory}: ${copied.join(', ')} (the originals are still there)`);
  if (alreadyPresent.length > 0) clauses.push(`${alreadyPresent.join(', ')} had already been carried across and still match`);
  if (conflicts.length > 0) clauses.push(`left ${conflicts.join(', ')} alone on both sides: they exist in both directories with different contents`);
  if (failures.length > 0) clauses.push(`FAILED to copy ${failures.map((f) => f.entry).join(', ')} — the originals are untouched`);
  const reason = clauses.length > 0 ? clauses.join('; ') : `nothing was copied from ${legacyDirectory}`;

  if (copied.length > 0) {
    try {
      fs.writeFileSync(path.join(currentDirectory, MIGRATION_MARKER), JSON.stringify({
        migratedAt: new Date().toISOString(),
        from: legacyDirectory,
        to: currentDirectory,
        copied, alreadyPresent, conflicts,
        failures: failures.map((f) => f.entry),
        sourcePreserved: true,
        note: 'Written by the product rename migration. Entries here were COPIED: every original is still in '
            + `${legacyDirectory}, which this application does not modify. Entries not listed were left where `
            + 'they were, and Electron rebuilt its own caches. Nothing was deleted and nothing was overwritten. '
            + 'Delete the old directory yourself if you want the space back.',
      }, null, 2) + '\n', 'utf8');
    } catch { /* the marker is a courtesy; failing to write it must never fail the migration */ }
  }

  return {
    performed: copied.length > 0,
    reason, legacyDirectory, currentDirectory,
    copied, alreadyPresent, conflicts, failures,
    sourcePreserved: true,
  };
}

/** The pre-rename directory name, kept in one place so a reader can find what it was called. */
export const LEGACY_PRODUCT_NAME = 'Model Lab';

/** Where the data lived before the rename, given Electron's per-user application-data directory. */
export function legacyUserDataDirectory(appDataDirectory: string): string {
  return path.join(appDataDirectory, LEGACY_PRODUCT_NAME);
}
