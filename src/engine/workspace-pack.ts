// Benchmark engine · a BENCHMARK PACK: the named, sealed set of workspace cases a comparative run
// measures, and how many independent samples it takes of each.
//
// WHY A PACK IS NOT A SUITE. `WorkspaceSuite` is an AUTHORING unit: it is where a case's text lives,
// it decides `suiteID`/`suiteVersion` (both of which are inside `cwc1:`), and adding a case to one
// moves nothing that already exists. A PACK is a MEASUREMENT unit: it is the answer to "which
// experiment was run", it names cases that may come from several suites, and it carries the one
// setting a suite has no business holding — `repeatsPerCase`, which is a property of the experiment
// rather than of any task in it. Collapsing the two would mean either putting a sampling decision
// inside a case digest, which would make last week's results incomparable the moment somebody wanted
// five samples instead of three, or leaving the sampling out of the sealed identity altogether,
// which would make a three-sample and a one-sample matrix look like the same experiment.
//
// SO THE PACK HAS ITS OWN DIGEST AND THE CASES KEEP THEIRS. `cwp1:` binds the pack's identity, every
// member case's `cwc1:` and the repeat count. Changing a case moves the pack digest and not the
// other cases' digests; changing the repeat count moves the pack digest and no case digest at all.
// Both are what a reader needs: a per-case result stays comparable across packs, and the pack says
// which experiment produced the table.
//
// A REPEAT IS NOT A RETRY, and this file is where that distinction is written down because this is
// where the number lives. See `WORKSPACE_REPEAT_IS_NOT_RETRY`.

import { CanonicalValue, digestObject } from './canonical';
import { WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey } from './workspace-case';

export class WorkspacePackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspacePackError';
  }
}

export const WORKSPACE_PACK_SCHEMA_VERSION = 1;

/**
 * THE ONE SENTENCE THAT KEEPS THE TWO NUMBERS APART, carried on every plan and every aggregate so a
 * reader meeting either column knows which it is looking at.
 *
 * REPEAT — a fresh, independent run of the whole case from the sealed baseline, with its own
 * disposable workspace, its own manifest, its own ledger, its own transcript and its own patch. It
 * measures VARIANCE: how differently the same model does the same task on separate occasions.
 * Repeats are the pack's, and a repeat's record never learns that another repeat exists.
 *
 * RETRY — a second ATTEMPT inside one run, made after this engine's own verification told the model
 * what failed. It measures RECOVERY. Retries are the case's, bounded by
 * `execution.maximumAttempts`, and every attempt of one run is sealed into the same record.
 *
 * Averaging them together would answer neither question: three repeats of a case that needed two
 * attempts each is three results and six attempts, and a table that reported "six runs" would be
 * reporting a recovery ability as a sample size.
 */
export const WORKSPACE_REPEAT_IS_NOT_RETRY =
  'A REPEAT is a fresh independent run of the whole case from the sealed baseline — its own workspace, manifest, '
  + 'ledger, transcript and patch — and it measures variance between occasions. A RETRY is a second attempt inside '
  + 'ONE run, made after this engine\'s verification reported a failure, and it measures recovery. Repeats belong to '
  + 'the benchmark pack; retries belong to the case, bounded by its maximumAttempts. They are counted in separate '
  + 'columns and are never summed into one.';

/**
 * A named, sealed set of workspace cases and the sampling the pack prescribes.
 *
 * `caseIDs` rather than cases: the pack names WHICH tasks, and the catalogue holds WHAT they are.
 * Resolving one against a catalogue that does not carry a named case is a refusal rather than a
 * shorter pack — a matrix that silently ran three cases because the fourth was missing would report
 * a comparison nobody asked for.
 */
export interface WorkspaceBenchmarkPack extends Record<string, CanonicalValue | undefined> {
  schemaVersion: number;
  id: string;
  /** Bumped by hand when the MEMBERSHIP or the sampling changes, not when a member case changes. */
  version: string;
  title: string;
  description: string;
  caseIDs: string[];
  /**
   * How many independent runs of each case a comparative matrix takes by default.
   *
   * ON THE PACK AND NOT ON THE CASE, deliberately. Sampling is a property of the experiment: a case
   * measured once and the same case measured three times are the same task, and their per-run
   * results belong on the same row. Putting this inside `cwc1:` would make every stored result
   * incomparable the moment somebody wanted a different sample size.
   */
  repeatsPerCase: number;
}

export interface WorkspaceBenchmarkPackInput {
  id: string;
  version: string;
  title?: string;
  description?: string;
  caseIDs: string[];
  repeatsPerCase: number;
}

export function makeWorkspaceBenchmarkPack(input: WorkspaceBenchmarkPackInput): WorkspaceBenchmarkPack {
  return {
    schemaVersion: WORKSPACE_PACK_SCHEMA_VERSION,
    id: input.id,
    version: input.version,
    title: input.title ?? input.id,
    description: input.description ?? '',
    // Sorted, so two packs naming the same cases in two orders are the same bytes. Execution order
    // is the matrix's business, not the pack's identity.
    caseIDs: [...new Set(input.caseIDs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    repeatsPerCase: input.repeatsPerCase,
  };
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * `cwp1:` — the identity of ONE EXPERIMENT: these tasks, at these versions, sampled this many times.
 *
 * Tagged like every digest in this codebase so a reader can tell at a glance which scheme produced
 * it. It binds each member's `cwc1:` rather than the case struct, so the pack digest moves exactly
 * when a member task changes meaning — and a case's own digest and comparability key are untouched
 * by being put in a pack.
 */
export function workspacePackDigest(pack: WorkspaceBenchmarkPack, cases: WorkspaceCase[]): string {
  return 'cwp1:' + digestObject({
    schemaVersion: pack.schemaVersion,
    id: pack.id,
    version: pack.version,
    repeatsPerCase: pack.repeatsPerCase,
    cases: resolveWorkspacePack(pack, cases).map((entry) => ({
      caseID: entry.id,
      caseVersion: entry.version,
      caseDigest: workspaceCaseDigest(entry),
      comparabilityKey: workspaceComparabilityKey(entry),
    })) as unknown as CanonicalValue,
  });
}

/**
 * The pack's cases, in the order the pack names them, or a refusal.
 *
 * FAIL-CLOSED. A pack naming a case this build does not carry is a pack whose digest describes an
 * experiment that cannot be run, and running the members that happen to exist would publish a
 * comparison under a name that promised a different one.
 */
export function resolveWorkspacePack(pack: WorkspaceBenchmarkPack, cases: WorkspaceCase[]): WorkspaceCase[] {
  return pack.caseIDs.map((caseID) => {
    const found = cases.find((entry) => entry.id === caseID);
    if (found === undefined) {
      throw new WorkspacePackError('unknownCase',
        `benchmark pack ${pack.id}@${pack.version} names the workspace case '${caseID}', which this build does not `
        + 'carry. A pack is the identity of an experiment: running the members that happen to exist would publish a '
        + 'comparison under a name that promised a different one.');
    }
    return found;
  });
}

/**
 * Refuse a pack that could not produce a comparison, at authoring time.
 *
 * Every rule here is about the PACK. The member cases are validated by `validateWorkspaceCase`,
 * which this deliberately does not re-implement.
 */
export function validateWorkspaceBenchmarkPack(pack: WorkspaceBenchmarkPack, cases: WorkspaceCase[]): void {
  const refuse = (code: string, message: string): never => {
    throw new WorkspacePackError(code, `benchmark pack ${pack.id}: ${message}`);
  };

  if (!SAFE_ID.test(pack.id)) refuse('unsafePackID', `'${pack.id}' is not a safe identifier (lowercase letters, digits, '.', '_', '-')`);
  if (pack.version.length === 0) refuse('emptyVersion', 'declares no version, so a result could never say which experiment it ran');
  if (pack.caseIDs.length === 0) refuse('emptyPack', 'names no case, so running it would measure nothing');
  if (!Number.isInteger(pack.repeatsPerCase) || pack.repeatsPerCase < 1) {
    refuse('nonPositiveRepeats', `declares ${pack.repeatsPerCase} repeats per case; a pack takes at least one sample of each`);
  }

  const resolved = resolveWorkspacePack(pack, cases);
  for (const entry of resolved) {
    if (!entry.source.sealed) {
      refuse('unsealedMember', `names '${entry.id}', whose fixture is not sealed. A pack is a comparison, and a member `
        + 'that accepts whatever is in its directory today would silently re-point at a different task between runs.');
    }
  }
}

// MARK: - Repeats

/**
 * One planned repeat of one case for one candidate.
 *
 * `repeatIndex` is 1-BASED because it is what a person counts: "the second of three". It is carried
 * on the ledger row and on the durable record, so a record read on its own says which sample it was
 * and how many were planned — and so an aggregate can prove it combined separate runs rather than
 * re-counting one.
 */
export interface WorkspaceRepeat {
  repeatIndex: number;
  repeatsPlanned: number;
  /**
   * The identity of the CELL these repeats are samples of: one candidate, one case, one pack.
   *
   * `cwr1:`. Every repeat of a cell carries the same one, which is what lets an aggregate group
   * samples without parsing a directory name — and two cells can never collide, because the
   * comparability key of the case is inside it.
   */
  repeatGroupID: string;
}

export function workspaceRepeatGroupID(options: {
  packID: string; packVersion: string; candidate: string; comparabilityKey: string;
}): string {
  return 'cwr1:' + digestObject({
    pack: `${options.packID}@${options.packVersion}`,
    candidate: options.candidate,
    comparabilityKey: options.comparabilityKey,
  });
}

/** The repeats of one cell, in order. Deliberately trivial: the value is that it exists once. */
export function planWorkspaceRepeats(repeatsPlanned: number, groupID: string): WorkspaceRepeat[] {
  if (!Number.isInteger(repeatsPlanned) || repeatsPlanned < 1) {
    throw new WorkspacePackError('nonPositiveRepeats',
      `${repeatsPlanned} repeats would record a cell nothing sampled. Ask for at least one, or leave the cell out.`);
  }
  return Array.from({ length: repeatsPlanned }, (_unused, index) => ({
    repeatIndex: index + 1, repeatsPlanned, repeatGroupID: groupID,
  }));
}
