// Model Lab core · disposable fixture repositories for the development benchmark.
//
// WHY A REPOSITORY IS A FIRST-CLASS FIXTURE, AND NOT A `syntheticContext` STRING. Every case this
// engine scored before this pass was a prompt and an answer. `SyntheticInputPackage` carries one
// optional context blob capped at 4 000 characters, which is the right shape for "here is a note,
// answer a question about it" and the wrong shape for "here is a project, tell me which file the
// public API actually calls". A development question is about RELATIONSHIPS BETWEEN FILES, and a
// fixture that has no files cannot pose one.
//
// WHAT A FIXTURE REPOSITORY IS. Sealed, versioned, in-repository DATA — a list of relative paths,
// each with its text and its declared role. It is not a checkout, not a submodule, and not a
// reference to anything on the machine. It is materialized by COPYING into a disposable workspace
// (`engine/isolation.ts`), exactly the way fixtures are already placed, so an attempt can read and
// write it freely and nothing it does survives the attempt.
//
// THE ROLE IS PART OF THE FIXTURE, NOT AN INFERENCE. `generated` is the one that earns its keep: a
// model that proposes editing a generated file instead of its source of truth has made a specific,
// recognisable development mistake, and a benchmark that inferred "generated" from a filename
// convention could not tell that mistake from a naming accident. So the fixture DECLARES it, the
// validator requires a generated file to name a source that exists, and the scorer reads the
// declaration rather than guessing.

import { seal, compareCodePoints } from './digest';

/** What a file IS in the project, declared by the fixture rather than inferred from its path. */
export type FixtureFileRole =
  /** Hand-written implementation. The source of truth for its own behaviour. */
  | 'source'
  /** Produced by a generator from some other file. Editing it directly is a development error. */
  | 'generated'
  /** Test material: a test module, or a case table a test module reads. */
  | 'test'
  /** Configuration and data the implementation reads at runtime. */
  | 'config'
  /** Prose. Never load-bearing for behaviour. */
  | 'doc'
  /** The generators and scripts that produce `generated` files. */
  | 'tooling';

export const ALL_FIXTURE_FILE_ROLES: FixtureFileRole[] = ['source', 'generated', 'test', 'config', 'doc', 'tooling'];

export interface FixtureFile {
  /** POSIX-relative, no leading `./`, no `..`, no absolute paths. Enforced by the validator. */
  path: string;
  role: FixtureFileRole;
  contents: string;
  /**
   * Required on a `generated` file and refused on every other role: the path this file was produced
   * from. The validator requires that path to exist in the same fixture, so "the source of truth for
   * this generated file" is a fact the fixture states and the scorer can check, never a guess.
   */
  generatedFrom?: string;
}

export interface FixtureRepo {
  id: string;
  version: string;
  title: string;
  /** One line, for a reader of the evidence. Never shown to a candidate. */
  summary: string;
  files: FixtureFile[];
}

export class FixtureRepoValidationFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FixtureRepoValidationFailure';
  }
}

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-]*(\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/;

/** Normalizing constructor: files sorted by path, so two fixtures with the same content seal alike. */
export function makeFixtureRepo(fields: FixtureRepo): FixtureRepo {
  return { ...fields, files: [...fields.files].sort((a, b) => compareCodePoints(a.path, b.path)) };
}

/** `mldr1:` — the fixture repository's sealed identity. Bound into every task that uses it. */
export function fixtureRepoDigest(repo: FixtureRepo): string {
  return seal(repo, 'mldr1:');
}

/**
 * Fail-closed validation. The whole fixture is refused on the first problem, for the same reason
 * `validateSuite` is: a benchmark that runs a half-valid fixture produces numbers nobody can read.
 */
export function validateFixtureRepo(repo: FixtureRepo): void {
  if (repo.id.length === 0) throw new FixtureRepoValidationFailure('emptyID', 'a fixture repository with no id cannot be referenced by a task');
  if (repo.version.length === 0) throw new FixtureRepoValidationFailure('emptyVersion', `fixture repository ${repo.id} declares no version`);
  if (repo.files.length === 0) throw new FixtureRepoValidationFailure('emptyRepo', `fixture repository ${repo.id} has no files; a repository-understanding question over zero files asks nothing`);

  const byPath = new Map<string, FixtureFile>();
  for (const file of repo.files) {
    if (!SAFE_PATH.test(file.path)) {
      throw new FixtureRepoValidationFailure('unsafePath',
        `fixture repository ${repo.id} declares path '${file.path}', which is not a plain POSIX-relative path (no leading ./, no .., no absolute paths, no backslashes)`);
    }
    if (byPath.has(file.path)) throw new FixtureRepoValidationFailure('duplicatePath', `fixture repository ${repo.id} declares ${file.path} twice`);
    byPath.set(file.path, file);
    if (file.contents.length === 0) {
      throw new FixtureRepoValidationFailure('emptyFile', `fixture repository ${repo.id} declares ${file.path} with no contents; an empty file in a fixture is almost always a transcription accident`);
    }
  }

  for (const file of repo.files) {
    if (file.role === 'generated') {
      if (file.generatedFrom === undefined) {
        throw new FixtureRepoValidationFailure('generatedWithoutSource',
          `fixture repository ${repo.id} marks ${file.path} generated but names no source; "which file is the source of truth" is a question this fixture must be able to answer`);
      }
      if (!byPath.has(file.generatedFrom)) {
        throw new FixtureRepoValidationFailure('generatedFromMissing',
          `fixture repository ${repo.id} says ${file.path} is generated from ${file.generatedFrom}, which the fixture does not contain`);
      }
      if (file.generatedFrom === file.path) {
        throw new FixtureRepoValidationFailure('generatedFromItself', `fixture repository ${repo.id} says ${file.path} is generated from itself`);
      }
    } else if (file.generatedFrom !== undefined) {
      throw new FixtureRepoValidationFailure('sourceNamesGenerator',
        `fixture repository ${repo.id} gives ${file.path} a generatedFrom but its role is '${file.role}'; only a generated file is produced from another`);
    }
  }

  if (!repo.files.some((f) => f.role === 'source')) {
    throw new FixtureRepoValidationFailure('noSource', `fixture repository ${repo.id} contains no source file; there is no implementation to reason about`);
  }
}

// MARK: - Snapshots

/**
 * A repository as a scorer sees it: path → text, and nothing else.
 *
 * The baseline snapshot comes from the sealed fixture; the result snapshot comes from reading the
 * disposable workspace back after the attempt. Both are the same shape ON PURPOSE, so every
 * assertion is written once and can be pointed at either — which is what makes "unchanged from
 * baseline" and "changed from baseline" expressible in the same vocabulary as everything else.
 */
export type RepoSnapshot = ReadonlyMap<string, string>;

export function snapshotOf(repo: FixtureRepo): RepoSnapshot {
  return new Map(repo.files.map((file) => [file.path, file.contents]));
}

export function snapshotPaths(snapshot: RepoSnapshot): string[] {
  return [...snapshot.keys()].sort(compareCodePoints);
}

/** `mldsnap1:` — a snapshot's identity, so "which bytes were scored" is recordable. */
export function snapshotDigest(snapshot: RepoSnapshot): string {
  return seal(snapshotPaths(snapshot).map((path) => ({ path, contents: snapshot.get(path) })), 'mldsnap1:');
}

export interface SnapshotDifference {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
}

/** What an attempt did to the repository, by path. The single input to every churn/scope metric. */
export function diffSnapshots(baseline: RepoSnapshot, result: RepoSnapshot): SnapshotDifference {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const path of snapshotPaths(result)) {
    const before = baseline.get(path);
    if (before === undefined) added.push(path);
    else if (before === result.get(path)) unchanged.push(path);
    else modified.push(path);
  }
  for (const path of snapshotPaths(baseline)) if (!result.has(path)) removed.push(path);
  return { added, removed, modified, unchanged };
}

/** Every path the attempt touched, in one sorted list: added, removed or modified. */
export function touchedPaths(difference: SnapshotDifference): string[] {
  return [...difference.added, ...difference.removed, ...difference.modified].sort(compareCodePoints);
}
