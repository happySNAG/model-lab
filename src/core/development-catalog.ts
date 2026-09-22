// Model Lab core · the development benchmark's registry.
//
// The counterpart of `catalog.ts`, and deliberately not part of it. `catalog.ts` registers the
// fourteen text suites whose identity is sealed against the Swift parity corpus; this file registers
// the development suites, which have no Swift counterpart, no scoring policy, and no place in a
// capability rate that was computed before they existed.
//
// KEEPING THE TWO REGISTRIES APART IS WHAT MAKES "NOT MEASURED" TRUE. A candidate measured before
// this pass has no development result, and there is no table it can be joined into where one would
// be silently imputed. That is a structural guarantee rather than a flag somebody has to remember
// to set.

import { compareCodePoints, fnv1a64Hex } from './digest';
import { FixtureRepo } from './development-fixture';
import { developmentFixtureRepos } from './development-fixtures/ledgerlite';
import {
  DevelopmentSuite, DevelopmentTask, developmentSuiteDigest, validateDevelopmentSuite,
} from './development-benchmark';
import { DevelopmentDimension, developmentContractDigest } from './development-scoring';
import { multiFileEditSuite } from './development-suites/multi-file-edit';
import { repositoryUnderstandingSuite } from './development-suites/repo-understanding';

export const developmentFixtures: FixtureRepo[] = developmentFixtureRepos;

/** Every development suite this engine can plan. Nothing dynamic; nothing discovered. */
export const developmentSuites: DevelopmentSuite[] = [repositoryUnderstandingSuite, multiFileEditSuite];

export function developmentSuiteByID(id: string): DevelopmentSuite | undefined {
  return developmentSuites.find((suite) => suite.id === id);
}

export function developmentTaskByID(id: string): DevelopmentTask | undefined {
  for (const suite of developmentSuites) for (const task of suite.tasks) if (task.id === id) return task;
  return undefined;
}

export function developmentFixtureByID(id: string, version: string): FixtureRepo | undefined {
  return developmentFixtures.find((repo) => repo.id === id && repo.version === version);
}

export function developmentSuitesFor(dimension: DevelopmentDimension): DevelopmentSuite[] {
  return developmentSuites.filter((suite) => suite.dimension === dimension);
}

/**
 * Validate every registered suite against every registered fixture. Fail-closed, and called by the
 * tests rather than at module load: a throw at import time would take the whole application down
 * over a benchmark nobody had asked to run.
 */
export function validateDevelopmentCatalog(): void {
  const seenSuiteIDs = new Set<string>();
  const seenTaskIDs = new Set<string>();
  for (const suite of developmentSuites) {
    if (seenSuiteIDs.has(suite.id)) throw new Error(`duplicate development suite id ${suite.id}`);
    seenSuiteIDs.add(suite.id);
    validateDevelopmentSuite(suite, developmentFixtures);
    for (const task of suite.tasks) {
      if (seenTaskIDs.has(task.id)) throw new Error(`development task id ${task.id} is registered in more than one suite`);
      seenTaskIDs.add(task.id);
    }
  }
}

/**
 * `mldcat1:` — the registry's identity: every suite digest plus the contract that grades them.
 *
 * The contract is in the basis because a re-graded result is a different measurement, and a reader
 * comparing two campaigns needs one value that changes when either the tasks or the grading did.
 */
export function developmentCatalogDigest(): string {
  const suites = [...developmentSuites]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((suite) => `${suite.id}@${suite.version}=${developmentSuiteDigest(suite)}`);
  return 'mldcat1:' + fnv1a64Hex([...suites, developmentContractDigest()].join('|'));
}

export function developmentTaskCount(): number {
  return developmentSuites.reduce((total, suite) => total + suite.tasks.length, 0);
}
