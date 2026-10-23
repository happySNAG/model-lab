// Cernum core · the development benchmark's task and suite specification.
//
// THIS IS A SECOND, PARALLEL SPECIFICATION, AND THE SEPARATION IS DELIBERATE.
//
// `benchmark.ts` describes a case as messages in and text out. Its suites are sealed against a
// cross-implementation parity corpus: `fixtures/parity/catalog.json` pins `allGovernedSuites`
// member for member, `registeredSuites.length` is asserted to be 14, and `policyCatalog`'s digest is
// pinned. Adding a development suite there would falsify those claims to gain a registry entry.
//
// It would also be WRONG ON THE MERITS, which matters more than the guard. A development task is not
// a prompt with an expected phrase in the answer. It carries a repository, it may permit the
// candidate to WRITE, it is judged by predicates over files rather than by matchers over prose, and
// it is measured on a dimension no existing role reads. Folding it into the text catalog would make
// every existing candidate look as though it had been asked a development question and declined to
// answer. It was never asked.
//
// So development tasks live in their own registry, with their own digests, their own validator and
// their own scoring contract — and a candidate with no development run has these dimensions reported
// as NOT MEASURED, which is a different statement from a zero and is the whole point.

import { seal, fnv1a64Hex, compareCodePoints } from './digest';
import { DevelopmentAssertion, assertionsDigest } from './development-assertions';
import { FixtureRepo, fixtureRepoDigest, validateFixtureRepo } from './development-fixture';
import { AnswerShape } from './json';
import {
  DEVELOPMENT_SCORING_CONTRACT_ID, DEVELOPMENT_SCORING_CONTRACT_VERSION, DevelopmentDimension,
  MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT, METRIC_SPEC_BY_ID, isDevelopmentMetricID,
} from './development-scoring';

/**
 * Where a read-only task's answer lands in the result snapshot.
 *
 * A repository-understanding task produces a JSON answer, not a repository edit — but judging it
 * with a SECOND assertion language would mean two vocabularies, two evaluators and two places for a
 * subtle disagreement to live. Instead the runner writes the candidate's answer into the result
 * snapshot at this path, and one predicate language covers both dimensions. The path is reserved:
 * the validator refuses a fixture that already contains it.
 */
export const DEVELOPMENT_ANSWER_PATH = 'cernum-answer.json';

export type DevelopmentTaskKind =
  /** Read-only. The repository is supplied; the answer is JSON at `DEVELOPMENT_ANSWER_PATH`. */
  | 'repositoryQuestion'
  /** The candidate edits the disposable workspace in place. */
  | 'repositoryEdit';

export interface DevelopmentPrompt {
  system: string;
  user: string;
}

export interface DevelopmentTask {
  id: string;
  suiteID: string;
  suiteVersion: string;
  dimension: DevelopmentDimension;
  kind: DevelopmentTaskKind;
  /** One line naming what is under test, for the evidence. */
  capabilityUnderTest: string;
  fixtureRepoID: string;
  fixtureRepoVersion: string;
  /** Sealed at authoring time and re-checked by the validator against the fixture it names. */
  fixtureRepoDigest: string;
  prompt: DevelopmentPrompt;
  /**
   * Paths this task genuinely requires the attempt to add or modify.
   *
   * On a `repositoryEdit` task this is the set a one-file patch cannot satisfy, and the validator
   * enforces its size. On a `repositoryQuestion` task it is exactly `[DEVELOPMENT_ANSWER_PATH]`.
   */
  requiredPaths: string[];
  /**
   * Paths the attempt may touch beyond the required ones — a legitimately optional edit. Anything
   * outside `requiredPaths ∪ permittedPaths` is out of scope and costs `unrelatedFilesUntouched`.
   */
  permittedPaths: string[];
  assertions: DevelopmentAssertion[];
  /**
   * The exact shape a `repositoryQuestion` answer must have: every key, and only those keys, with
   * their types. It is the shape the prompt already states, written down so a grader can check it
   * rather than infer it. Required on a question task and refused on an edit task. It is part of the
   * task digest, so declaring it is a change to the task's identity, never a silent one.
   */
  answerShape?: AnswerShape;
  executionBudgetMilliseconds: number;
  plannedRepetitions: number;
  scoringContractID: string;
  scoringContractVersion: string;
  provenance: string;
  tags: string[];
}

export interface DevelopmentSuite {
  id: string;
  version: string;
  title: string;
  dimension: DevelopmentDimension;
  tasks: DevelopmentTask[];
}

export function makeDevelopmentTask(fields: DevelopmentTask): DevelopmentTask {
  return {
    ...fields,
    requiredPaths: [...new Set(fields.requiredPaths)].sort(compareCodePoints),
    permittedPaths: [...new Set(fields.permittedPaths)].sort(compareCodePoints),
    assertions: [...fields.assertions].sort((a, b) => compareCodePoints(a.id, b.id)),
    tags: [...new Set(fields.tags)].sort(compareCodePoints),
  };
}

export function makeDevelopmentSuite(id: string, version: string, title: string, dimension: DevelopmentDimension,
                                     tasks: DevelopmentTask[]): DevelopmentSuite {
  return { id, version, title, dimension, tasks: [...tasks].sort((a, b) => compareCodePoints(a.id, b.id)) };
}

/** `mldt1:` — one task's sealed identity, assertions and fixture digest included. */
export function developmentTaskDigest(task: DevelopmentTask): string {
  return seal({ ...task, assertions: assertionsDigest(task.assertions) }, 'mldt1:');
}

/** `mldsu1:` — the suite's identity. */
export function developmentSuiteDigest(suite: DevelopmentSuite): string {
  return 'mldsu1:' + fnv1a64Hex([suite.id, suite.version, suite.tasks.map(developmentTaskDigest).join('|')].join('||'));
}

/**
 * `mldk1:` — results are directly comparable only when every component matches.
 *
 * The scoring contract's version is in the basis, exactly as the text benchmark puts the scoring
 * policy's version in `mlk1:`: a task re-graded under a revised contract is a different measurement
 * and must not be ranked beside the old one.
 */
export function developmentComparabilityKey(task: DevelopmentTask): string {
  return 'mldk1:' + fnv1a64Hex([
    task.suiteID, task.suiteVersion, task.id, developmentTaskDigest(task),
    task.fixtureRepoID, task.fixtureRepoVersion, task.fixtureRepoDigest,
    task.scoringContractID, task.scoringContractVersion,
  ].join('|'));
}

// MARK: - Validation (fail-closed; the whole suite is refused on the first problem)

export class DevelopmentValidationFailure extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DevelopmentValidationFailure';
  }
}

/** Every path a predicate reads or writes, so the validator can check it against the fixture. */
function pathsReferencedBy(assertion: DevelopmentAssertion): string[] {
  const predicate = assertion.predicate;
  return predicate.kind === 'onlyTheseTouched' ? predicate.paths : [predicate.path];
}

export function validateDevelopmentSuite(suite: DevelopmentSuite, repos: FixtureRepo[]): void {
  const repoByKey = new Map(repos.map((repo) => [`${repo.id}@${repo.version}`, repo]));
  for (const repo of repos) validateFixtureRepo(repo);

  if (suite.tasks.length === 0) {
    throw new DevelopmentValidationFailure('emptySuite', `development suite ${suite.id} declares no tasks`);
  }

  const seen = new Set<string>();
  for (const task of suite.tasks) {
    if (seen.has(task.id)) throw new DevelopmentValidationFailure('duplicateTaskID', `duplicate development task id ${task.id}`);
    seen.add(task.id);

    if (task.suiteID !== suite.id) {
      throw new DevelopmentValidationFailure('taskOutsideSuite', `task ${task.id} declares suite ${task.suiteID} inside suite ${suite.id}`);
    }
    if (task.suiteVersion !== suite.version) {
      throw new DevelopmentValidationFailure('suiteVersionMismatch', `task ${task.id} declares version ${task.suiteVersion}, suite is ${suite.version}`);
    }
    if (task.dimension !== suite.dimension) {
      throw new DevelopmentValidationFailure('dimensionMismatch',
        `task ${task.id} measures ${task.dimension} inside suite ${suite.id}, which measures ${suite.dimension}; a suite whose tasks count under different dimensions produces a rate nobody can read`);
    }
    if (task.prompt.system.length === 0 || task.prompt.user.length === 0) {
      throw new DevelopmentValidationFailure('emptyPrompt', `task ${task.id} has an empty prompt`);
    }
    if (task.executionBudgetMilliseconds < 1) {
      throw new DevelopmentValidationFailure('nonPositiveBudget', `task ${task.id} has no positive execution budget`);
    }
    if (task.plannedRepetitions < 1) {
      throw new DevelopmentValidationFailure('nonPositiveRepetitions', `task ${task.id} plans zero repetitions`);
    }
    if (task.scoringContractID !== DEVELOPMENT_SCORING_CONTRACT_ID || task.scoringContractVersion !== DEVELOPMENT_SCORING_CONTRACT_VERSION) {
      throw new DevelopmentValidationFailure('unknownScoringContract',
        `task ${task.id} references scoring contract ${task.scoringContractID}@${task.scoringContractVersion}; this engine registers only ${DEVELOPMENT_SCORING_CONTRACT_ID}@${DEVELOPMENT_SCORING_CONTRACT_VERSION}`);
    }

    const repo = repoByKey.get(`${task.fixtureRepoID}@${task.fixtureRepoVersion}`);
    if (!repo) {
      throw new DevelopmentValidationFailure('unknownFixtureRepo',
        `task ${task.id} references fixture repository ${task.fixtureRepoID}@${task.fixtureRepoVersion}, which is not registered`);
    }
    const actualDigest = fixtureRepoDigest(repo);
    if (task.fixtureRepoDigest !== actualDigest) {
      throw new DevelopmentValidationFailure('fixtureRepoDigestDrift',
        `task ${task.id} was sealed against fixture repository digest ${task.fixtureRepoDigest}, but ${task.fixtureRepoID}@${task.fixtureRepoVersion} now digests to ${actualDigest}; the fixture changed under a task that did not`);
    }
    const repoPaths = new Set(repo.files.map((file) => file.path));
    if (repoPaths.has(DEVELOPMENT_ANSWER_PATH)) {
      throw new DevelopmentValidationFailure('answerPathCollision',
        `fixture repository ${repo.id} contains ${DEVELOPMENT_ANSWER_PATH}, which is reserved for a task's recorded answer`);
    }

    // The one-file gate, enforced where a task is AUTHORED rather than only where it is graded.
    if (task.kind === 'repositoryEdit') {
      if (task.requiredPaths.length < MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT) {
        throw new DevelopmentValidationFailure('taskTooNarrow',
          `multi-file-editing task ${task.id} requires only ${task.requiredPaths.length} file(s); ${MINIMUM_REQUIRED_FILES_FOR_MULTI_FILE_EDIT} is the minimum, because a task a one-file patch can satisfy does not measure this dimension`);
      }
      if (task.requiredPaths.includes(DEVELOPMENT_ANSWER_PATH)) {
        throw new DevelopmentValidationFailure('editTaskWantsAnswerFile',
          `edit task ${task.id} requires ${DEVELOPMENT_ANSWER_PATH}; an edit task is judged by what it did to the repository, not by a written answer`);
      }
    } else {
      if (task.requiredPaths.length !== 1 || task.requiredPaths[0] !== DEVELOPMENT_ANSWER_PATH) {
        throw new DevelopmentValidationFailure('questionTaskPaths',
          `read-only task ${task.id} must require exactly [${DEVELOPMENT_ANSWER_PATH}]; it requires ${JSON.stringify(task.requiredPaths)}`);
      }
    }

    if (task.kind === 'repositoryQuestion') validateAnswerShape(task);
    else if (task.answerShape !== undefined) {
      throw new DevelopmentValidationFailure('editTaskDeclaresAnswerShape',
        `edit task ${task.id} declares an answer shape; an edit task produces no answer to shape`);
    }

    const inScope = new Set([...task.requiredPaths, ...task.permittedPaths, DEVELOPMENT_ANSWER_PATH]);

    if (task.assertions.length === 0) {
      throw new DevelopmentValidationFailure('noAssertions', `task ${task.id} declares no assertions; nothing would judge it`);
    }
    if (!task.assertions.some((assertion) => assertion.visibility === 'heldOut')) {
      throw new DevelopmentValidationFailure('noHeldOutAssertion',
        `task ${task.id} declares no held-out assertion; every one of its checks is something the prompt already states, so it would measure transcription rather than understanding`);
    }
    const assertionIDs = new Set<string>();
    for (const assertion of task.assertions) {
      if (assertionIDs.has(assertion.id)) {
        throw new DevelopmentValidationFailure('duplicateAssertionID', `task ${task.id} declares assertion ${assertion.id} twice`);
      }
      assertionIDs.add(assertion.id);
      if (!isDevelopmentMetricID(assertion.metric)) {
        throw new DevelopmentValidationFailure('unknownMetric', `task ${task.id} assertion ${assertion.id} rolls up into unknown metric '${assertion.metric}'`);
      }
      const spec = METRIC_SPEC_BY_ID.get(assertion.metric as never)!;
      if (spec.dimension !== task.dimension) {
        throw new DevelopmentValidationFailure('metricOutsideDimension',
          `task ${task.id} measures ${task.dimension} but assertion ${assertion.id} rolls up into ${assertion.metric}, which belongs to ${spec.dimension}`);
      }
      if (spec.tier === 'executed') {
        throw new DevelopmentValidationFailure('assertionOnExecutedMetric',
          `task ${task.id} attaches assertion ${assertion.id} to ${assertion.metric}, an EXECUTED-tier metric; an executed metric is decided by running the code, and attaching a structural predicate to it would let a static check masquerade as a test run`);
      }
      for (const path of pathsReferencedBy(assertion)) {
        if (!repoPaths.has(path) && !inScope.has(path)) {
          throw new DevelopmentValidationFailure('assertionPathUnknown',
            `task ${task.id} assertion ${assertion.id} names ${path}, which is neither in fixture repository ${repo.id} nor among the task's required or permitted paths`);
        }
      }
    }
  }
}

/**
 * A question task's declared shape must BE the shape its prompt states, and must cover every key its
 * assertions read. Either mismatch would let the shape check refuse an answer the prompt asked for,
 * or accept one the assertions cannot read — so both are refused where the task is authored.
 */
function validateAnswerShape(task: DevelopmentTask): void {
  const shape = task.answerShape;
  if (shape === undefined || Object.keys(shape).length === 0) {
    throw new DevelopmentValidationFailure('questionTaskWithoutAnswerShape',
      `read-only task ${task.id} declares no answer shape; the grading contract checks every answer against one`);
  }
  for (const key of Object.keys(shape)) {
    if (!task.prompt.user.includes(`"${key}"`)) {
      throw new DevelopmentValidationFailure('answerShapeNotInPrompt',
        `read-only task ${task.id} declares answer key "${key}", which its prompt never states`);
    }
  }
  for (const assertion of task.assertions) {
    const predicate = assertion.predicate as { path?: string; pointer?: string };
    if (predicate.path !== DEVELOPMENT_ANSWER_PATH || typeof predicate.pointer !== 'string') continue;
    const key = predicate.pointer.split('/')[1] ?? '';
    if (!(key in shape)) {
      throw new DevelopmentValidationFailure('assertionOutsideAnswerShape',
        `read-only task ${task.id} assertion ${assertion.id} reads "${key}", which its answer shape does not declare`);
    }
  }
}

// MARK: - Provenance

/**
 * What must be recorded beside every development result.
 *
 * The text benchmark records its identity in the frozen manifest and its machine in
 * `HardwareIdentity`. A development result needs both plus two things the text benchmark never
 * needed: WHICH FIXTURE the task ran against (a fixture is code, and code changes) and WHICH COMMIT
 * of this benchmark produced the grade (a scoring contract is code too). Without them a development
 * score is a number with no experiment behind it.
 */
export interface DevelopmentProvenance {
  benchmarkVersion: string;
  /** The Cernum commit that produced this grade. Empty string means "the runner could not read it". */
  benchmarkCommit: string;
  /** Stable identifier for the machine that executed the task. */
  machineIdentifier: string;
  platform: string;
  suiteID: string;
  suiteVersion: string;
  suiteDigest: string;
  taskID: string;
  taskDigest: string;
  comparabilityKey: string;
  fixtureRepoID: string;
  fixtureRepoVersion: string;
  fixtureRepoDigest: string;
  contractID: string;
  contractVersion: string;
  contractDigest: string;
  /** ISO-8601 whole seconds. */
  executedAt: string;
}

export function provenanceIsComplete(provenance: DevelopmentProvenance): { complete: boolean; missing: string[] } {
  const missing = (Object.entries(provenance) as [string, string][])
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key)
    .sort(compareCodePoints);
  return { complete: missing.length === 0, missing };
}
