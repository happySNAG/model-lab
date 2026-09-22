// Benchmark engine · one attempt at a repository task, from a clean tree to a sealed verdict.
//
// THE SMALLEST THING THAT CAN HONESTLY MEASURE AGENTIC WORK, and nothing beyond it. Every attempt:
//
//    1  gets its OWN disposable directory under the benchmark sandbox, made by `mkdtemp`;
//    2  gets a fresh COPY of the immutable fixture — the fixture itself is opened read-only and is
//       never a working directory, so nothing a model does can reach the next attempt;
//    3  runs the case's setup, and is then COPIED AGAIN to `baseline/`, which nothing is ever handed.
//       Two trees rather than one, because a patch cannot be rendered from a tree that has been
//       overwritten in place, and a diff computed from digests alone cannot show anybody a line;
//    4  hands `work/` to the driver with an allow-listed environment and a scratch directory that is
//       NOT inside the tree being measured;
//    5  snapshots `work/` the moment the agent stops — BEFORE verification, so a test runner's own
//       artefacts are never attributed to the model;
//    6  checks `baseline/` is untouched, which is the cheapest test there is of whether the
//       confinement held;
//    7  runs verification with NO provider credentials at all, whatever the agent was given;
//    8  disposes of everything, unless the caller asked for a failed attempt to be preserved.
//
// THE VERDICT IS NEVER TAKEN FROM THE AGENT. `WorkspaceAgentResult.completed` means the tool exited
// under its own steam; it is recorded and it decides nothing. What decides is the tree this engine
// snapshotted and the commands this engine ran. A model that announces success and changes nothing
// scores exactly what a model that changes nothing scores.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, digestObject, sha256Text } from './canonical';
import { CLIResult, runCLI } from './cli-process';
import { resolveInside } from './isolation';
import { redactSecrets } from './redaction';
import { atomicWriteJSON } from './ledger';
import {
  WorkspaceCase, WorkspaceCommand, workspaceCaseDigest, workspaceComparabilityKey, workspaceInstructionText,
  validateWorkspaceCase,
} from './workspace-case';
import {
  PatchArtifact, TreeDiff, TreeSnapshot, CleanlinessFinding, assessPatchCleanliness, changedPathsOf,
  copyTree, diffSnapshots, renderPatch, snapshotTree,
} from './workspace-tree';
import { ScopeAssessment, assessScope } from './workspace-scope';
import {
  TerminationReason, TranscriptBuilder, WorkspaceTranscript, executablesOutsidePolicy, terminationReasonFor,
} from './workspace-transcript';
import {
  WorkspaceAgentDriver, WorkspaceAgentRequest, WorkspaceAgentResult, PriorAttemptBriefing,
  driverShortfalls, retryBriefingText, workspaceEnvironment, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX,
} from './workspace-agent';

export class WorkspaceExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceExecutionError';
  }
}

// MARK: - What one command produced

export interface CommandOutcome extends Record<string, CanonicalValue | undefined> {
  commandID: string;
  kind: string;
  executable: string;
  argv: string[];
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  /** The command ran and exited zero. A command that never started is `false` AND `started: false`. */
  passed: boolean;
  started: boolean;
  required: boolean;
  elapsedMilliseconds: number;
  stdoutDigest: string;
  stderrDigest: string;
  /** The last few lines, redacted and bounded — enough to read a failure, not enough to bury one. */
  stdoutTail: string;
  stderrTail: string;
  failureDetail?: string;
}

export const COMMAND_TAIL_CHARACTERS = 4_000;

function tail(text: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= COMMAND_TAIL_CHARACTERS) return redacted;
  return `…[${redacted.length - COMMAND_TAIL_CHARACTERS} earlier characters omitted]\n`
    + redacted.slice(redacted.length - COMMAND_TAIL_CHARACTERS);
}

export interface InvariantOutcome extends Record<string, CanonicalValue | undefined> {
  path: string;
  satisfied: boolean;
  detail: string;
}

// MARK: - What one attempt produced

export interface WorkspaceAttemptRecord {
  attemptIndex: number;
  startedAt: string;
  finishedAt: string;
  elapsedMilliseconds: number;

  /** The fixture as it was copied, before setup ran. Binds the case to the tree it actually got. */
  fixtureTreeDigest: string;
  /** The tree the agent was handed, after setup. Everything is diffed against this. */
  baselineTreeDigest: string;
  finalTreeDigest: string;

  diff: TreeDiff;
  patch: PatchArtifact;
  scope: ScopeAssessment;
  cleanliness: CleanlinessFinding[];
  /** Executables observed that the case's allow-list does not name. Empty when it names none. */
  executablesOutsidePolicy: string[];

  setupOutcomes: CommandOutcome[];
  /**
   * The visible checks run against the untouched baseline, before the agent saw the tree.
   *
   * Empty when the case turned `establishBaseline` off. A check present here and in
   * `verificationOutcomes` is comparable across the change, which is the only honest way to say the
   * word "regression".
   */
  baselineOutcomes: CommandOutcome[];
  verificationOutcomes: CommandOutcome[];
  hiddenOutcomes: CommandOutcome[];
  invariantOutcomes: InvariantOutcome[];

  /** Everything the driver reported, minus the events (they are in the transcript). */
  agent: Omit<WorkspaceAgentResult, 'events'>;
  /**
   * WHY THIS ATTEMPT STOPPED. On the record as well as in the transcript, because the scorer reads
   * the record and a scorer that had to re-derive this from a failure kind would be a second place
   * for the mapping to live.
   */
  terminationReason: TerminationReason;
  transcript: WorkspaceTranscript;

  /**
   * A fault in the HARNESS, not in the model: a fixture digest that did not match, a setup command
   * that failed, a baseline that was modified underneath the attempt. Present means the attempt
   * measured nothing, and the scorer says so rather than blaming the candidate.
   */
  harnessFault?: { code: string; detail: string };
  /** Set when the workspace was kept for diagnosis instead of deleted. */
  preservedAt?: string;
}

export interface WorkspaceRunResult {
  caseID: string;
  caseVersion: string;
  caseDigest: string;
  comparabilityKey: string;
  driverID: string;
  attempts: WorkspaceAttemptRecord[];
  attemptsUsed: number;
  totalElapsedMilliseconds: number;
  /** Reasons the driver could not run this case at all. Non-empty means nothing was attempted. */
  refusedBecause: string[];
}

// MARK: - Options

export interface WorkspaceRunOptions {
  case: WorkspaceCase;
  driver: WorkspaceAgentDriver;
  /** Absolute. The case's `fixturePath` resolves INSIDE this, and never outside it. */
  fixtureRoot: string;
  /** Absolute. Every disposable workspace is made under here — the benchmark sandbox, nothing else. */
  sandboxRoot: string;
  /** Absolute. Where a preserved attempt's evidence is written. Nothing is written without one. */
  evidenceRoot?: string;
  /** Keep a failed attempt's tree instead of deleting it. Off by default; on for a diagnostic run. */
  preserveFailedWorkspaces?: boolean;
  environmentSource?: NodeJS.ProcessEnv;
  shouldCancel?: () => boolean;
  now?: () => number;
  /** Injected by the tests so a verification command need not be a real process. */
  runCommand?: (options: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
  /** Called after every attempt, so a caller can render progress without waiting for the run. */
  onAttempt?: (record: WorkspaceAttemptRecord) => void;
}

/**
 * REFUSE A SANDBOX THAT IS SOMEBODY'S WORKING TREE.
 *
 * THE ACCIDENT THIS EXISTS TO PREVENT. `sandboxRoot` is supplied by the caller, and the obvious
 * wrong value is the checkout the benchmark was launched from — a terminal command run with `--root
 * .`, a service that defaults to the application directory, a test that reaches for `process.cwd()`.
 * Nothing in the mechanics would object: the runner makes a `cernum-ws-*` subdirectory, works inside
 * it, and deletes it. It would not destroy the repository. It WOULD scatter working trees through
 * somebody's source checkout, hand a model a directory adjacent to their real work, and — the part
 * that matters — produce a run whose isolation story is untrue.
 *
 * So the check is structural rather than a warning: a `.git` at the sandbox root or at any ancestor
 * of it means this is inside a working tree, and the run is refused before a directory is made. The
 * fixture root is deliberately NOT checked this way — fixtures live in this repository, under
 * version control, which is exactly where they belong.
 *
 * The second half refuses a sandbox that contains, is contained by, or IS the fixture root. An
 * attempt materialised beside the fixture it copies is an attempt one `..` away from its own
 * baseline, and the guarantee that the source tree is untouchable stops being structural.
 */
export function assertSandboxRootIsSafe(sandboxRoot: string, fixtureRoot: string): void {
  // BOTH SIDES ARE REALPATH'D, and the first version of this check was wrong for not doing it. On
  // macOS the OS temp directory is `/var/folders/…`, a symlink to `/private/var/folders/…`. A
  // sandbox spelled one way and a fixture spelled the other are the same directory and compared as
  // different ones, so the overlap this function exists to refuse went straight through it.
  const real = (candidate: string): string =>
    fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
  const sandbox = real(sandboxRoot);
  const fixture = real(fixtureRoot);

  for (let directory = sandbox; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) {
      throw new WorkspaceExecutionError('sandboxInsideWorkingTree',
        `refusing to use ${sandbox} as a benchmark sandbox: ${directory} is a Git working tree. A workspace `
        + 'benchmark materialises disposable trees and hands one to a model, and doing that inside somebody\'s '
        + 'checkout is how a benchmark ends up adjacent to real work. Point --root at a directory outside any '
        + 'repository — the campaign root or the OS temp directory.');
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }

  const contains = (outer: string, inner: string): boolean =>
    inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  if (contains(sandbox, fixture) || contains(fixture, sandbox)) {
    throw new WorkspaceExecutionError('sandboxOverlapsFixture',
      `refusing a benchmark sandbox (${sandbox}) that overlaps the fixture root (${fixture}). An attempt `
      + 'materialised beside the tree it copies is one `..` away from its own baseline, and "the fixture is '
      + 'never reachable" stops being a structural fact.');
  }
}

const isoSeconds = (milliseconds: number): string => new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// MARK: - The run

/**
 * Run one case through one driver, up to its attempt ceiling, and return the evidence.
 *
 * NEVER THROWS FOR A FAILED ATTEMPT. A timeout, a scope violation, a failing test and a driver that
 * could not start are all ORDINARY OUTCOMES of asking a model to do work, and turning them into
 * exceptions loses the transcript that explains them. It throws only when the caller asked for
 * something impossible — a fixture that is not there, a sandbox outside the sandbox.
 */
export async function runWorkspaceCase(options: WorkspaceRunOptions): Promise<WorkspaceRunResult> {
  const workspaceCase = options.case;
  validateWorkspaceCase(workspaceCase);

  const now = options.now ?? (() => Date.now());
  const caseDigest = workspaceCaseDigest(workspaceCase);
  const startedAtMilliseconds = now();

  // Checked BEFORE the driver shortfall reply is composed and before any directory is made: a
  // misconfigured sandbox is the caller asking for something impossible, so it throws rather than
  // becoming a recorded outcome.
  assertSandboxRootIsSafe(options.sandboxRoot, options.fixtureRoot);

  const shortfalls = driverShortfalls(options.driver, workspaceCase.execution.tools, workspaceCase.execution.networkPolicy);
  if (shortfalls.length > 0) {
    // Refused BEFORE a workspace is made and before anything is spent. A driver that cannot do what
    // the case requires would produce a row that looks like a measurement of the model.
    return {
      caseID: workspaceCase.id, caseVersion: workspaceCase.version, caseDigest,
      comparabilityKey: workspaceComparabilityKey(workspaceCase),
      driverID: options.driver.driverID, attempts: [], attemptsUsed: 0,
      totalElapsedMilliseconds: now() - startedAtMilliseconds, refusedBecause: shortfalls,
    };
  }

  const fixtureSource = resolveInside(options.fixtureRoot, workspaceCase.source.fixturePath);
  if (!fs.existsSync(fixtureSource)) {
    throw new WorkspaceExecutionError('fixtureMissing',
      `workspace case ${workspaceCase.id} names the fixture '${workspaceCase.source.fixturePath}', which is not under ${options.fixtureRoot}`);
  }

  const attempts: WorkspaceAttemptRecord[] = [];
  let prior: PriorAttemptBriefing | undefined;

  for (let attemptIndex = 0; attemptIndex < workspaceCase.execution.maximumAttempts; attemptIndex++) {
    if (options.shouldCancel?.()) break;
    const record = await runOneAttempt(options, { attemptIndex, fixtureSource, caseDigest, prior, now });
    attempts.push(record);
    options.onAttempt?.(record);

    if (record.harnessFault) break;
    if (attemptSucceeded(record)) break;
    prior = briefingFrom(record);
  }

  return {
    caseID: workspaceCase.id,
    caseVersion: workspaceCase.version,
    caseDigest,
    comparabilityKey: workspaceComparabilityKey(workspaceCase),
    driverID: options.driver.driverID,
    attempts,
    attemptsUsed: attempts.length,
    totalElapsedMilliseconds: now() - startedAtMilliseconds,
    refusedBecause: [],
  };
}

/** Everything required held. Used only to decide whether another attempt is worth making. */
export function attemptSucceeded(record: WorkspaceAttemptRecord): boolean {
  if (record.harnessFault) return false;
  if (record.agent.failure) return false;
  if (!record.scope.clean) return false;
  const requiredCommands = [...record.verificationOutcomes, ...record.hiddenOutcomes].filter((outcome) => outcome.required);
  if (requiredCommands.some((outcome) => !outcome.passed)) return false;
  return record.invariantOutcomes.every((outcome) => outcome.satisfied);
}

function briefingFrom(record: WorkspaceAttemptRecord): PriorAttemptBriefing {
  const failed = [...record.verificationOutcomes, ...record.hiddenOutcomes].find((outcome) => outcome.required && !outcome.passed);
  const scopeDetail = record.scope.clean ? '' : record.scope.violations.map((violation) => violation.reason).join('; ');
  return {
    attemptIndex: record.attemptIndex,
    terminationReason: record.terminationReason,
    outcome: record.agent.failure ? `the tool failed: ${record.agent.failure.kind}` : failed ? `${failed.commandID} failed` : scopeDetail.length > 0 ? 'the change went outside the task scope' : 'the work was not verified',
    failureDetail: failed ? `${failed.executable} ${failed.argv.join(' ')}\n${failed.stdoutTail}\n${failed.stderrTail}`.trim() : scopeDetail,
    transcriptDigest: record.transcript.transcriptDigest,
    patchDigest: record.patch.patchDigest,
  };
}

// MARK: - One attempt

interface AttemptContext {
  attemptIndex: number;
  fixtureSource: string;
  caseDigest: string;
  prior?: PriorAttemptBriefing;
  now: () => number;
}

async function runOneAttempt(options: WorkspaceRunOptions, context: AttemptContext): Promise<WorkspaceAttemptRecord> {
  const workspaceCase = options.case;
  const { attemptIndex, now } = context;
  const startedAtMilliseconds = now();

  fs.mkdirSync(options.sandboxRoot, { recursive: true });
  const attemptRoot = fs.mkdtempSync(path.join(fs.realpathSync(options.sandboxRoot), `cernum-ws-${workspaceCase.id}-${attemptIndex}-`));
  const workRoot = path.join(attemptRoot, 'work');
  // THE BUILDER IS MADE AFTER THE WORKSPACE IS NAMED, so it can reconcile the paths a driver reports
  // against the tree this attempt actually measures. The root is handed over rather than looked up,
  // because the runner is the only thing that knows which disposable directory this is.
  const transcript = new TranscriptBuilder(startedAtMilliseconds, now, workRoot);
  const baselineRoot = path.join(attemptRoot, 'baseline');
  const scratchRoot = path.join(attemptRoot, 'tmp');
  fs.mkdirSync(scratchRoot, { recursive: true });

  const skeleton = (): Omit<WorkspaceAttemptRecord, 'agent' | 'transcript' | 'terminationReason'> => ({
    attemptIndex,
    startedAt: isoSeconds(startedAtMilliseconds),
    finishedAt: isoSeconds(now()),
    elapsedMilliseconds: now() - startedAtMilliseconds,
    fixtureTreeDigest: '', baselineTreeDigest: '', finalTreeDigest: '',
    diff: { changes: [], changedPaths: [], addedFileCount: 0, removedFileCount: 0, modifiedFileCount: 0, addedLineCount: 0, removedLineCount: 0, clean: true, beforeTreeDigest: '', afterTreeDigest: '' },
    patch: { text: '', patchDigest: digestObject(''), byteCount: 0, truncated: false, omittedPaths: [] },
    scope: { violations: [], inScopePaths: [], clean: true },
    cleanliness: [], executablesOutsidePolicy: [],
    setupOutcomes: [], baselineOutcomes: [], verificationOutcomes: [], hiddenOutcomes: [], invariantOutcomes: [],
  });

  const emptyAgent: Omit<WorkspaceAgentResult, 'events'> = {
    completed: false, reportedModelID: '', unexpressed: [], notEnforceable: [],
    activeIsolation: [], elapsedMilliseconds: 0,
  };

  const finishWithFault = (code: string, detail: string): WorkspaceAttemptRecord => {
    const reason: TerminationReason = code === 'workspaceEscape' ? 'workspaceEscape' : 'harnessFault';
    transcript.emit('harnessFault', 'engineObserved', attemptIndex, detail, { reason: code, terminationReason: reason });
    const record: WorkspaceAttemptRecord = {
      ...skeleton(), agent: emptyAgent, transcript: transcript.build(),
      terminationReason: reason, harnessFault: { code, detail },
    };
    return finalizeWorkspace(options, record, { attemptRoot, workRoot });
  };

  try {
    // 1. The fixture, copied in as data. The original is opened read-only and never written to.
    copyTree(context.fixtureSource, workRoot, { skipDirectories: workspaceCase.source.skipDirectories });
    const fixtureSnapshot = snapshotTree(workRoot, {
      skipDirectories: workspaceCase.source.skipDirectories, capturedAt: isoSeconds(now()),
    });

    // A sealed fixture that has drifted is a harness fault, not a model failure. Checked BEFORE
    // anything is spent, because a result against the wrong tree is worse than no result.
    if (workspaceCase.source.sealed && workspaceCase.source.expectedTreeDigest !== fixtureSnapshot.treeDigest) {
      return finishWithFault('fixtureDrift',
        `the fixture at '${workspaceCase.source.fixturePath}' digests to ${fixtureSnapshot.treeDigest}, not the `
        + `${workspaceCase.source.expectedTreeDigest} this case was sealed against. The task would have been run `
        + 'against a tree nobody authorised; refusing it.');
    }

    // 2. Setup. Runs in the work tree so its effects are part of the baseline every attempt shares.
    const setupOutcomes: CommandOutcome[] = [];
    for (const command of workspaceCase.source.setupCommands) {
      const outcome = await runWorkspaceCommand(options, command, workRoot, scratchRoot, transcript, attemptIndex, 'setup');
      setupOutcomes.push(outcome);
      if (command.required && !outcome.passed) {
        const record = finishWithFault('setupFailed',
          `setup command '${command.id}' (${command.executable}) did not succeed, so no attempt at this case could be `
          + `a measurement of a model: ${outcome.failureDetail ?? `exit ${outcome.exitCode}`}`);
        record.setupOutcomes = setupOutcomes;
        return record;
      }
    }

    // 3. The pristine copy the patch is rendered against. Made AFTER setup, so setup's own output is
    //    baseline rather than something the model appears to have written.
    copyTree(workRoot, baselineRoot, { skipDirectories: workspaceCase.source.skipDirectories });
    const baseline = snapshotTree(baselineRoot, {
      skipDirectories: workspaceCase.source.skipDirectories, capturedAt: isoSeconds(now()),
    });

    // 3b. The BEFORE reading. Run in a throwaway copy so the checks' own artefacts never land in the
    //     baseline the patch is rendered against, and never in the tree the agent is handed.
    const baselineOutcomes: CommandOutcome[] = [];
    if (workspaceCase.verification.establishBaseline && workspaceCase.verification.commands.length > 0) {
      const probeRoot = path.join(attemptRoot, 'probe');
      copyTree(workRoot, probeRoot, { skipDirectories: workspaceCase.source.skipDirectories });
      for (const command of workspaceCase.verification.commands) {
        baselineOutcomes.push(await runWorkspaceCommand(options, command, probeRoot, scratchRoot, transcript, attemptIndex, 'baseline'));
      }
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }

    // AN INITIAL ATTEMPT AND A RETRY ARE DIFFERENT BOUNDARIES, and the transcript says which without
    // anybody comparing an index to zero. The prior ending travels with it, so attempt 2's
    // transcript is readable on its own.
    if (context.prior !== undefined) {
      transcript.emit('retryStarted', 'engineObserved', attemptIndex,
        `starting again from a clean copy of the fixture after attempt ${context.prior.attemptIndex + 1} `
        + `ended: ${context.prior.outcome}`, {
          priorAttemptIndex: context.prior.attemptIndex,
          terminationReason: context.prior.terminationReason as TerminationReason,
          patchDigest: context.prior.patchDigest,
          workspaceTreeDigest: baseline.treeDigest,
        });
    }

    // WHAT IS ACTUALLY SENT THIS ATTEMPT. The frozen instruction on attempt 1, and that same text
    // plus the engine-composed retry briefing on every attempt after it. Composed HERE rather than
    // in a driver, for the reason `workspaceInstructionText` is composed by the case: two drivers
    // wording a retry differently would make one case two experiments. Until this existed, nothing
    // sent `prior` at all and a second attempt was a resample rather than a recovery.
    const instructionAsSent = context.prior === undefined
      ? workspaceInstructionText(workspaceCase)
      : `${workspaceInstructionText(workspaceCase)}\n\n${retryBriefingText(context.prior)}`;

    transcript.emit('attemptStarted', 'engineObserved', attemptIndex,
      `attempt ${attemptIndex + 1} of ${workspaceCase.execution.maximumAttempts} on ${workspaceCase.id}@${workspaceCase.version}`,
      {
        workspaceTreeDigest: baseline.treeDigest,
        // The text this attempt was handed, sealed rather than merely composed: a reader comparing
        // two attempts can see that the second one was told something the first was not.
        textDigest: sha256Text(instructionAsSent),
        textByteCount: Buffer.byteLength(instructionAsSent, 'utf8'),
      });

    // 4. The agent. Its environment is an allow-list; its scratch space is outside the tree.
    const environment = workspaceEnvironment({
      allowlist: workspaceCase.execution.environmentAllowlist,
      temporaryDirectory: scratchRoot,
      source: options.environmentSource,
    });

    const request: WorkspaceAgentRequest = {
      caseID: workspaceCase.id,
      caseVersion: workspaceCase.version,
      caseDigest: context.caseDigest,
      attemptIndex,
      maximumAttempts: workspaceCase.execution.maximumAttempts,
      instruction: instructionAsSent,
      workspaceRoot: fs.realpathSync(workRoot),
      scope: workspaceCase.task.scope,
      tools: workspaceCase.execution.tools,
      networkPolicy: workspaceCase.execution.networkPolicy,
      environment,
      timeoutMilliseconds: workspaceCase.execution.timeoutMilliseconds,
      temperatureMilli: workspaceCase.execution.temperatureMilli,
      seed: workspaceCase.execution.seed,
      prior: context.prior,
      transcript,
      shouldCancel: options.shouldCancel,
    };

    let agentResult: WorkspaceAgentResult;
    try {
      agentResult = await options.driver.run(request);
    } catch (error) {
      // A driver that throws is a driver defect. It is recorded as the tool failing, never as the
      // model answering badly, and the attempt still produces a full tree diff.
      agentResult = {
        completed: false,
        failure: { kind: 'spawnFailure', detail: redactSecrets(error instanceof Error ? error.message : String(error)) },
        reportedModelID: '', unexpressed: [], notEnforceable: [], activeIsolation: [],
        elapsedMilliseconds: now() - startedAtMilliseconds, events: [],
      };
    }

    // THE ANSWER OF RECORD, as its own event. `agentReported`, because it is the tool's closing
    // claim: it is written down and it decides nothing.
    if (agentResult.finalMessage !== undefined && agentResult.finalMessage.length > 0) {
      transcript.emit('finalResponse', 'agentReported', attemptIndex, agentResult.finalMessage, {
        channel: 'visible',
        textDigest: sha256Text(agentResult.finalMessage),
        textByteCount: Buffer.byteLength(agentResult.finalMessage, 'utf8'),
      });
    }

    const terminationReason = terminationReasonFor(agentResult.failure?.kind);
    transcript.emit('attemptFinished', 'engineObserved', attemptIndex,
      agentResult.failure ? `${agentResult.failure.kind}: ${agentResult.failure.detail}` : 'the tool finished under its own steam',
      { ok: agentResult.completed, elapsedMilliseconds: agentResult.elapsedMilliseconds, terminationReason });

    // 5. The tree, snapshotted the moment the agent stops and BEFORE any verification runs, so a
    //    test runner's caches and coverage files are never attributed to the model.
    const final = snapshotTree(workRoot, {
      skipDirectories: workspaceCase.source.skipDirectories, capturedAt: isoSeconds(now()),
    });

    // 6. Did the confinement hold? The baseline copy was never handed to anything; a byte of
    //    difference in it means something reached outside the directory it was given.
    const baselineAfter = snapshotTree(baselineRoot, { skipDirectories: workspaceCase.source.skipDirectories, capturedAt: isoSeconds(now()) });
    if (baselineAfter.treeDigest !== baseline.treeDigest) {
      transcript.emit('boundaryRefusal', 'engineObserved', attemptIndex,
        'the pristine baseline copy changed during this attempt, which means something wrote outside the workspace it was given');
      const record = finishWithFault('workspaceEscape',
        `the baseline tree digested ${baseline.treeDigest} before the attempt and ${baselineAfter.treeDigest} after it. `
        + 'Nothing is ever handed that directory, so this attempt reached outside the workspace and cannot be scored.');
      record.setupOutcomes = setupOutcomes;
      return record;
    }

    const diff = diffSnapshots(baseline, final, { beforeRoot: baselineRoot, afterRoot: workRoot });
    const patch = renderPatch(diff, { beforeRoot: baselineRoot, afterRoot: workRoot });
    const scope = assessScope(workspaceCase.task.scope, changedPathsOf(diff));
    const cleanliness = workspaceCase.verification.requirePatchCleanliness ? assessPatchCleanliness(workRoot, diff) : [];

    // 7. Verification. NO provider credentials reach it, whatever the agent was given: a check that
    //    could authenticate to a model is a check that could ask one whether it passed.
    const verificationOutcomes: CommandOutcome[] = [];
    for (const command of workspaceCase.verification.commands) {
      verificationOutcomes.push(await runWorkspaceCommand(options, command, workRoot, scratchRoot, transcript, attemptIndex));
    }
    const hiddenOutcomes: CommandOutcome[] = [];
    for (const command of workspaceCase.verification.hiddenCommands) {
      hiddenOutcomes.push(await runWorkspaceCommand(options, command, workRoot, scratchRoot, transcript, attemptIndex));
    }

    const invariantOutcomes = workspaceCase.verification.invariants.map((invariant) => checkInvariant(workRoot, invariant));
    const builtTranscript = transcript.build();

    const record: WorkspaceAttemptRecord = {
      attemptIndex,
      startedAt: isoSeconds(startedAtMilliseconds),
      finishedAt: isoSeconds(now()),
      elapsedMilliseconds: now() - startedAtMilliseconds,
      fixtureTreeDigest: fixtureSnapshot.treeDigest,
      baselineTreeDigest: baseline.treeDigest,
      finalTreeDigest: final.treeDigest,
      diff,
      patch,
      scope,
      cleanliness,
      executablesOutsidePolicy: executablesOutsidePolicy(builtTranscript.summary, workspaceCase.execution.tools.allowedExecutables),
      setupOutcomes,
      baselineOutcomes,
      verificationOutcomes,
      hiddenOutcomes,
      invariantOutcomes,
      agent: {
        completed: agentResult.completed,
        finalMessage: agentResult.finalMessage === undefined ? undefined : redactSecrets(agentResult.finalMessage),
        failure: agentResult.failure,
        reportedModelID: agentResult.reportedModelID,
        unexpressed: agentResult.unexpressed,
        notEnforceable: agentResult.notEnforceable,
        activeIsolation: [...agentResult.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
        elapsedMilliseconds: agentResult.elapsedMilliseconds,
        usage: agentResult.usage,
        // Only when the driver measured one, so an attempt record from any other driver is unchanged.
        ...(agentResult.appliedEffortEvidence === undefined ? {} : { appliedEffortEvidence: agentResult.appliedEffortEvidence }),
      },
      transcript: builtTranscript,
      terminationReason,
    };

    return finalizeWorkspace(options, record, { attemptRoot, workRoot });
  } catch (error) {
    if (error instanceof WorkspaceExecutionError) throw error;
    return finishWithFault('harnessThrew', redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

// MARK: - Running one command inside the workspace

/**
 * Run one of the case's commands, in the workspace, under a stripped environment.
 *
 * `replaceEnvironment` rather than `extraEnvironment`: a verification command inherits NOTHING. It
 * gets `PATH`, the locale names, and a scratch directory. Not `HOME`, not one provider variable,
 * and not whatever the operator happens to have exported — so a test that passes here passes
 * because the code works, and a test that reaches a model to ask cannot authenticate to one.
 */
async function runWorkspaceCommand(options: WorkspaceRunOptions, command: WorkspaceCommand, workRoot: string,
                                   scratchRoot: string, transcript: TranscriptBuilder, attemptIndex: number,
                                   phase: 'setup' | 'baseline' | 'afterChange' = 'afterChange'): Promise<CommandOutcome> {
  const run = options.runCommand ?? runCLI;
  const workingDirectory = command.workingSubdirectory.length === 0
    ? fs.realpathSync(workRoot)
    : resolveInside(workRoot, command.workingSubdirectory);

  const environment: Record<string, string> = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    const value = (options.environmentSource ?? process.env)[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.TMPDIR = scratchRoot;

  const result = await run({
    executable: command.executable,
    args: command.args,
    timeoutMilliseconds: command.timeoutMilliseconds,
    workingDirectory,
    replaceEnvironment: environment,
    shouldCancel: options.shouldCancel,
  });

  const timedOut = result.failure?.kind === 'timeout';
  const started = result.failure?.kind !== 'notInstalled' && result.failure?.kind !== 'spawnFailure';
  const outcome: CommandOutcome = {
    commandID: command.id,
    kind: command.kind,
    executable: command.executable,
    argv: command.args,
    exitCode: result.exitCode,
    signal: result.signal ?? undefined,
    timedOut,
    passed: started && result.exitCode === 0 && result.failure === undefined,
    started,
    required: command.required,
    elapsedMilliseconds: result.elapsedMilliseconds,
    stdoutDigest: sha256Text(result.stdout),
    stderrDigest: sha256Text(result.stderr),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    failureDetail: result.failure?.detail,
  };

  transcript.emit(command.kind === 'setup' ? 'commandExecuted' : 'verificationRan', 'engineObserved', attemptIndex,
    `${command.id}: ${command.executable} ${command.args.join(' ')}`.trim(), {
      commandID: command.id,
      commandKind: command.kind,
      executable: command.executable,
      argv: command.args,
      exitCode: result.exitCode,
      signal: result.signal ?? undefined,
      elapsedMilliseconds: result.elapsedMilliseconds,
      stdoutDigest: outcome.stdoutDigest,
      stderrDigest: outcome.stderrDigest,
      stdoutByteCount: Buffer.byteLength(result.stdout, 'utf8'),
      stderrByteCount: Buffer.byteLength(result.stderr, 'utf8'),
      // Kept apart, and kept at all: a reader of the transcript alone must be able to see why a
      // check failed without holding the attempt record beside it.
      stdoutTail: outcome.stdoutTail,
      stderrTail: outcome.stderrTail,
      ok: outcome.passed,
      // WHICH SIDE OF THE CHANGE THIS READING IS FROM. Without it the before and after runs of the
      // same command are two identical-looking rows, and a regression cannot be read off the transcript.
      reason: phase,
    });

  return outcome;
}

function checkInvariant(workRoot: string, invariant: { path: string; mustExist?: boolean; mustContain: string[]; mustNotContain: string[] }): InvariantOutcome {
  let contents: string | undefined;
  let exists = false;
  try {
    const resolved = resolveInside(workRoot, invariant.path);
    exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    if (exists) contents = fs.readFileSync(resolved, 'utf8');
  } catch {
    exists = false;
  }

  if (invariant.mustExist === true && !exists) {
    return { path: invariant.path, satisfied: false, detail: `${invariant.path} does not exist, and this case requires it to` };
  }
  if (invariant.mustExist === false && exists) {
    return { path: invariant.path, satisfied: false, detail: `${invariant.path} exists, and this case requires it not to` };
  }
  if (contents === undefined) {
    const needsContent = invariant.mustContain.length > 0 || invariant.mustNotContain.length > 0;
    return needsContent
      ? { path: invariant.path, satisfied: false, detail: `${invariant.path} could not be read, so its content invariants could not be checked — unchecked is not satisfied` }
      : { path: invariant.path, satisfied: true, detail: `${invariant.path} is absent, as this case permits` };
  }
  const missing = invariant.mustContain.filter((fragment) => !contents!.includes(fragment));
  if (missing.length > 0) {
    return { path: invariant.path, satisfied: false, detail: `${invariant.path} does not contain ${missing.map((fragment) => JSON.stringify(fragment)).join(', ')}` };
  }
  const present = invariant.mustNotContain.filter((fragment) => contents!.includes(fragment));
  if (present.length > 0) {
    return { path: invariant.path, satisfied: false, detail: `${invariant.path} still contains ${present.map((fragment) => JSON.stringify(fragment)).join(', ')}` };
  }
  return { path: invariant.path, satisfied: true, detail: `${invariant.path} satisfies every declared invariant` };
}

// MARK: - Teardown, and the one case where it does not happen

/**
 * Delete the attempt directory, or keep it and write the evidence beside it.
 *
 * PRESERVATION IS OPT-IN AND IS RECORDED ON THE ROW. A harness that kept every failed workspace
 * would fill a disk on a long campaign, and a harness that kept one silently would leave a model's
 * output on a machine nobody expected it on. So the caller asks, the attempt says where it was kept,
 * and the guards' disk floor is what stops a diagnostic run from filling the volume.
 */
function finalizeWorkspace(options: WorkspaceRunOptions, record: WorkspaceAttemptRecord,
                           roots: { attemptRoot: string; workRoot: string }): WorkspaceAttemptRecord {
  const failed = record.harnessFault !== undefined || !attemptSucceeded(record);
  const preserve = failed && options.preserveFailedWorkspaces === true;

  if (options.evidenceRoot !== undefined) {
    const directory = path.join(options.evidenceRoot, options.case.id, `attempt-${record.attemptIndex}`);
    fs.mkdirSync(directory, { recursive: true });
    if (record.patch.text.length > 0) fs.writeFileSync(path.join(directory, 'patch.diff'), record.patch.text, 'utf8');
    fs.writeFileSync(path.join(directory, 'transcript.jsonl'),
      record.transcript.events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    atomicWriteJSON(path.join(directory, 'attempt.json'), {
      ...record, patch: { ...record.patch, text: undefined }, transcript: { ...record.transcript, events: undefined },
    } as unknown as CanonicalValue);
  }

  if (preserve) {
    record.preservedAt = roots.attemptRoot;
    return record;
  }
  fs.rmSync(roots.attemptRoot, { recursive: true, force: true });
  return record;
}
