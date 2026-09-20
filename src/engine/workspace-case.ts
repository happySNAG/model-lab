// Benchmark engine · a benchmark case whose subject is a REPOSITORY, not a reply.
//
// WHY THIS IS NOT A `BenchmarkCase`, AND WHY THAT IS NOT A NEAR MISS.
//
// `src/core/benchmark.ts` describes one exchange: a sealed message package goes out, one string
// comes back, an evaluator reads the string. Every part of its identity is built on that shape —
// `validateSuite` refuses a case with no messages, `caseDigest` seals the whole struct under
// `mlb1:`, and `comparabilityKey` declares two results comparable when the prompt, the scoring
// policy and the response format match. Three things follow, and together they settle it:
//
//   1  ADDING WORKSPACE FIELDS WOULD MOVE EVERY EXISTING DIGEST. `caseDigest` seals the struct, so a
//      new optional field changes the sealed bytes of cases that do not use it. `fixtures/parity/
//      store` re-seals Swift-written records to prove the two encoders agree; every one of those
//      comparisons would break, and every `comparabilityKey` already written to disk would stop
//      matching the case it was written for.
//   2  THE COMPARABILITY RULE WOULD BECOME FALSE. Two workspace results are comparable only when the
//      FIXTURE, the verification commands and the tool policy also match. A key that omits them
//      would declare a pass on last month's fixture comparable with a pass on this month's.
//   3  THE OBSERVATION IS THE WRONG SHAPE. `Observation.outputText` plus `toolCallObservationsRaw:
//      string[]` cannot represent a file write, a test run or a second attempt after a failure.
//
// So this is a SECOND, PARALLEL CASE TYPE with its own digest scheme, and the two never share a
// struct. What they DO share is everything below the case: the ledger, the plan, the frozen
// manifest, the lock, the guards, the spend tracker and the report all take a workspace case
// through `plannableCaseOf` and `promptRecordOf` without one line of change — `TERMINAL_STATUSES`
// has carried `patchFailure`, `scopeFailure`, `compilationFailure` and `behavioralFailure` since
// the port, because the Python harness this descends from already scored work of this kind.
//
// THE CASE IS THE CONTRACT. A result says which task version produced it by carrying
// `workspaceCaseDigest`, which binds the instruction, the fixture identity, the scope, the tool
// policy, every verification command and the scoring weights. Change any of them and it is a
// different task, visibly.

import { CanonicalValue, digestObject } from './canonical';
import { isForbiddenEnvironmentName } from './isolation';
import { ScopePolicy, WorkspaceScopeError, normalizeRelativePath, scopePolicy } from './workspace-scope';
import { PlannableCase } from './ledger';
import { PromptRecord, ScoredCoreEntry } from './manifest';

export const WORKSPACE_CASE_SCHEMA_VERSION = 1;

export class WorkspaceCaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceCaseError';
  }
}

/**
 * The capability a workspace case claims to measure.
 *
 * Separate from `CapabilityDimension` in the portable core, which enumerates conversational
 * qualities. A case declares several, because real work exercises several at once, and the ranking
 * counts an outcome under each one it declared rather than picking a winner.
 */
export type WorkspaceDimension =
  | 'repositoryComprehension'
  | 'fileLocation'
  | 'multiFileEditing'
  | 'toolUse'
  | 'testExecution'
  | 'failureInterpretation'
  | 'recoveryFromError'
  | 'regressionAvoidance'
  | 'scopeDiscipline'
  | 'patchCleanliness'
  | 'autonomousCompletion';

export const ALL_WORKSPACE_DIMENSIONS: WorkspaceDimension[] = [
  'repositoryComprehension', 'fileLocation', 'multiFileEditing', 'toolUse', 'testExecution',
  'failureInterpretation', 'recoveryFromError', 'regressionAvoidance', 'scopeDiscipline',
  'patchCleanliness', 'autonomousCompletion',
];

// MARK: - Commands

/**
 * What a command MEANS when it fails — which is the whole reason a case declares commands rather
 * than one test script.
 *
 * A build that does not compile and a test that fails are different facts about a model, and a
 * harness that collapses them into "non-zero exit" cannot tell a change that does not parse from a
 * change that parses and is wrong. The kind decides the terminal status in `workspace-scoring.ts`,
 * so it is part of the case's frozen identity rather than a label on the output.
 */
export type CommandKind = 'setup' | 'build' | 'typecheck' | 'lint' | 'test' | 'hidden';

export interface WorkspaceCommand extends Record<string, CanonicalValue | undefined> {
  id: string;
  kind: CommandKind;
  executable: string;
  args: string[];
  timeoutMilliseconds: number;
  /**
   * `false` means the command is measured and does not decide the verdict — a lint that is reported
   * but not gating. A required command that fails decides the status for its kind.
   */
  required: boolean;
  /** Workspace-relative directory to run it in. Empty string is the workspace root. */
  workingSubdirectory: string;
}

export function workspaceCommand(fields: Partial<WorkspaceCommand> & Pick<WorkspaceCommand, 'id' | 'kind' | 'executable'>): WorkspaceCommand {
  return {
    id: fields.id,
    kind: fields.kind,
    executable: fields.executable,
    args: fields.args ?? [],
    timeoutMilliseconds: fields.timeoutMilliseconds ?? 120_000,
    required: fields.required ?? true,
    workingSubdirectory: fields.workingSubdirectory === undefined ? '' : normalizeRelativePath(fields.workingSubdirectory),
  };
}

// MARK: - Where the work starts from

/**
 * The immutable tree every attempt begins from.
 *
 * `expectedTreeDigest` is the fixture's identity, and supplying it is what makes a stored result
 * still mean something: a case that names a directory and nothing else silently re-points at
 * whatever is in that directory today. It is optional only so a case can be authored before its
 * fixture is sealed; `validateWorkspaceCase` refuses a case marked `sealed` without one.
 *
 * `pinnedCommit` is RECORDED AND NOT ACTED ON. Nothing in this engine clones or fetches: a fixture
 * is a directory on this machine, and a case that could pull one would be a case whose contents
 * depend on a network. The commit is there so a reader can find where the tree came from.
 */
export interface WorkspaceSource extends Record<string, CanonicalValue | undefined> {
  kind: 'fixtureDirectory';
  /** Relative to the fixture root the runner is given. Never absolute, never `..`. */
  fixturePath: string;
  expectedTreeDigest?: string;
  pinnedCommit?: string;
  /** Directory names not copied into the workspace, on top of the always-skipped set. */
  skipDirectories: string[];
  /** Run once, in order, after the copy and before the agent. A failure is a harness fault. */
  setupCommands: WorkspaceCommand[];
  /** True when the fixture has been sealed and its digest must match. */
  sealed: boolean;
}

// MARK: - What is asked

export interface WorkspaceTask extends Record<string, CanonicalValue | undefined> {
  /** The EXACT text handed to the agent. Frozen, digested, and never templated at run time. */
  instruction: string;
  scope: ScopePolicy;
  /**
   * Paths named to the agent as a starting point, when the case chooses to give one.
   *
   * A case that names none is measuring `fileLocation`; a case that names some is measuring
   * editing rather than searching. Both are legitimate, and which one it is has to be in the
   * digest, because a result from the hinted version is not comparable with one from the blind version.
   */
  briefingPaths: string[];
}

// MARK: - How it is run

export type NetworkPolicy =
  /** No outbound access is intended. Not enforced by this engine — see the note on `WorkspaceExecutionPolicy`. */
  | 'denied'
  /** The agent tool may reach its own provider to answer, and nothing else is intended. */
  | 'providerOnly'
  /** The task genuinely needs the network (a package install). Recorded loudly; rarely correct. */
  | 'unrestricted';

/**
 * THE EXECUTION POLICY, AND WHAT IT DOES AND DOES NOT ENFORCE.
 *
 * Stated here rather than in a comment somewhere downstream, because this is the field a reader
 * will take as a guarantee, and it is not one.
 *
 *   ENFORCED. The agent's working directory is a fresh copy of the fixture under the benchmark
 *   sandbox, made per attempt. Every path the engine itself opens goes through `resolveInside`. The
 *   child's environment is an ALLOW-LIST — `environmentAllowlist` plus the handful of names that
 *   only describe the machine — so nothing else is inherited. The process is owned, grouped and
 *   killed at its deadline. Verification commands run with no provider credentials at all.
 *
 *   NOT ENFORCED, AND SAID PLAINLY. This is not an OS sandbox. An agent CLI that needs `HOME` to
 *   find its own session gets `HOME`, because a tool that cannot authenticate cannot be measured —
 *   and a process with `HOME` can read what is under it. `networkPolicy` is a DECLARATION of intent
 *   that the engine records and checks against the tool's own switches where the tool has them; it
 *   is not a firewall. `tools.commandExecution` is likewise expressed through whatever flags the
 *   driver has, and `codex-cli.ts` already documents, with evidence, that a validly-set switch on
 *   one of these tools need not hold.
 *
 * So the posture is the same one the rest of this engine takes: configure what can be configured,
 * OBSERVE what actually happened, and let the observation — not the configuration — decide the
 * verdict. `workspace-execution.ts` reads the final tree, not the agent's account of it.
 */
export interface ToolPolicy extends Record<string, CanonicalValue | undefined> {
  fileRead: boolean;
  fileWrite: boolean;
  commandExecution: boolean;
  /**
   * Executables a model-issued command may name, when `commandExecution` is on.
   *
   * Empty means "whatever the driver permits", which is honest about the fact that this engine
   * cannot police a shell it does not own. A non-empty list is passed to drivers that can express
   * it and is ALWAYS checked against the observed transcript afterwards, which is the part that
   * does not depend on the tool cooperating.
   */
  allowedExecutables: string[];
}

/**
 * Names a case may add to its environment allow-list even though `isForbiddenEnvironmentName`
 * refuses them everywhere else.
 *
 * TWO, AND BOTH ARE HERE BECAUSE A SUBSCRIPTION CLI CANNOT FIND ITS OWN SESSION WITHOUT THEM.
 * Refusing them would mean the only providers this benchmark can measure are the metered ones. They
 * may be asked for BY NAME, in the case, in the digest — and everything else credential-shaped stays
 * refused however it is spelled.
 *
 *   `HOME`  where a subscription CLI keeps its configuration and its session files.
 *   `USER`  ADDED AFTER THE FIRST LIVE CLAUDE RUN FAILED ON IT, and worth stating exactly, because
 *           the evidence corrects what this list used to imply. That run was handed `HOME` and not
 *           `USER`, and `claude` answered `Not logged in · Please run /login` before sending
 *           anything. Probing `claude auth status` under the same allow-list — which costs no
 *           allowance, because it reaches no model — established three things:
 *             · with `HOME` alone:        loggedIn false, authMethod none
 *             · with `HOME` and `USER`:   loggedIn true,  authMethod claude.ai, subscription max
 *             · with `USER` and NO HOME:  loggedIn true, and configDirectory still resolved to the
 *                                         real home directory
 *           The reason is that this CLI reads its OAuth token from the macOS Keychain by shelling
 *           out to `security find-generic-password -a <account>`, and the account it asks for is the
 *           user name. `USER` is what makes the session REACHABLE.
 *
 *           The third reading is the uncomfortable one and is recorded rather than buried: WITHHOLDING
 *           `HOME` DOES NOT WITHHOLD THE HOME DIRECTORY. Node resolves `os.homedir()` from the passwd
 *           database when the variable is absent, so a case that leaves `HOME` off its allow-list has
 *           not stopped the tool reading what is under it — it has only stopped handing it the path.
 *           `HOME` stays on this list because a case that means to be explicit should be able to say
 *           it, and the case below does; it is not, on this platform, a control.
 *
 * It lives beside the case rather than beside the driver because it is a rule about what may be
 * SEALED, and `validateWorkspaceCase` enforces it at authoring time. Catching it only when the
 * child is spawned would let a case carrying `ANTHROPIC_API_KEY` be written, reviewed, sealed and
 * shipped, and refuse for the first time on the machine that ran it.
 */
export const ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK = ['HOME', 'USER'];

export interface WorkspaceExecutionPolicy extends Record<string, CanonicalValue | undefined> {
  /** The deadline for ONE attempt, agent time only. Verification has its own per-command budgets. */
  timeoutMilliseconds: number;
  /**
   * How many times the agent may be given the workspace.
   *
   * 1 measures whether it gets it right first time. Above 1 measures recovery: attempt 2 starts
   * from a FRESH copy of the fixture and is told what attempt 1's verification reported, so what is
   * measured is reading a failure, not accumulating half-edits in a dirty tree.
   */
  maximumAttempts: number;
  tools: ToolPolicy;
  networkPolicy: NetworkPolicy;
  /** Extra environment names the agent's child process may inherit. Everything else is dropped. */
  environmentAllowlist: string[];
  /** Passed to drivers that can express it; recorded as unexpressed by those that cannot. */
  temperatureMilli?: number;
  seed?: number;
}

// MARK: - How it is judged

export interface FileInvariant extends Record<string, CanonicalValue | undefined> {
  path: string;
  mustExist?: boolean;
  mustContain: string[];
  mustNotContain: string[];
}

export function fileInvariant(fields: Partial<FileInvariant> & Pick<FileInvariant, 'path'>): FileInvariant {
  return {
    path: normalizeRelativePath(fields.path),
    mustExist: fields.mustExist,
    mustContain: fields.mustContain ?? [],
    mustNotContain: fields.mustNotContain ?? [],
  };
}

export interface WorkspaceVerification extends Record<string, CanonicalValue | undefined> {
  /** Run in declaration order, in the workspace, after the agent has finished. */
  commands: WorkspaceCommand[];
  /**
   * Checks the agent is never told about.
   *
   * They exist because the fastest way to make a named test pass is to write the code the named
   * test checks and nothing else. A hidden check is run in the same workspace, after the visible
   * ones, and its FAILURE is a real failure — it is hidden from the model, not from the record.
   */
  hiddenCommands: WorkspaceCommand[];
  invariants: FileInvariant[];
  /**
   * Paths whose modification is a failure regardless of scope.
   *
   * `scope.forbidden` already refuses these; this list is checked a second time against the final
   * tree, so a case author who edits one list and not the other gets a refusal at validation rather
   * than a quiet hole at run time.
   */
  forbiddenChanges: string[];
  /** Conflict markers and patch residue in the final tree fail the case. */
  requirePatchCleanliness: boolean;
  /**
   * Run the visible verification commands against a COPY of the untouched baseline first.
   *
   * THIS IS WHAT MAKES "no regressions" A MEASUREMENT RATHER THAN A HOPE. Without it, a failing
   * test after the change is indistinguishable from a test that was already failing before it —
   * which on a bug-fix case is the normal state of the world, since the reproducing test is
   * supposed to fail at the start. With it, every check has a before and an after, and a regression
   * is a check that PASSED and now does not. It costs one extra copy and one extra verification
   * pass, and a case that genuinely cannot afford that turns it off and loses the regression column
   * rather than getting an invented one.
   */
  establishBaseline: boolean;
  /** Zero means "unbounded". A ceiling is how a case says a 400-line answer to a 3-line bug is wrong. */
  maximumChangedLines: number;
  maximumChangedFiles: number;
}

/**
 * The weights, in thousandths, and the one thing a workspace score is allowed to be opinionated about.
 *
 * Integer-scaled because `canonicalJSON` refuses floats: two runtimes must not be able to disagree
 * on a weight's shortest representation. They sum to nothing in particular on purpose — the
 * composite is normalized by the sum at scoring time, so adding a dimension does not silently
 * rescale every stored score.
 */
export interface WorkspaceScoringPolicy extends Record<string, CanonicalValue | undefined> {
  id: string;
  version: string;
  taskSuccessWeightMilli: number;
  testsPassedWeightMilli: number;
  regressionFreeWeightMilli: number;
  scopeRespectedWeightMilli: number;
  patchCleanWeightMilli: number;
  firstAttemptWeightMilli: number;
  patchEconomyWeightMilli: number;
}

export const DEFAULT_WORKSPACE_SCORING_POLICY: WorkspaceScoringPolicy = {
  id: 'policy.workspace.default',
  version: '1',
  taskSuccessWeightMilli: 400,
  testsPassedWeightMilli: 200,
  regressionFreeWeightMilli: 150,
  scopeRespectedWeightMilli: 100,
  patchCleanWeightMilli: 50,
  firstAttemptWeightMilli: 60,
  patchEconomyWeightMilli: 40,
};

// MARK: - The case

export interface WorkspaceCase {
  schemaVersion: number;
  id: string;
  /** The task's own version. Bumped by hand when the task changes meaning, not when a typo is fixed. */
  version: string;
  suiteID: string;
  suiteVersion: string;
  title: string;
  description: string;
  dimensions: WorkspaceDimension[];
  source: WorkspaceSource;
  task: WorkspaceTask;
  execution: WorkspaceExecutionPolicy;
  verification: WorkspaceVerification;
  scoring: WorkspaceScoringPolicy;
  tags: string[];
}

/**
 * The shape a case is AUTHORED in, spelled out field by field.
 *
 * Deliberately not `Partial<Omit<…>>` over the structs above. Every one of them carries a
 * `Record<string, CanonicalValue | undefined>` index signature so it can be canonically encoded, and
 * `Omit` over an indexed type collapses its declared properties INTO that index signature — which
 * silently widens `briefingPaths` from `string[]` to `CanonicalValue`. Writing the author-facing
 * shape out is three dozen lines and keeps every field's real type.
 */
export interface WorkspaceCaseInput {
  id: string;
  version: string;
  suiteID: string;
  suiteVersion: string;
  title?: string;
  description?: string;
  dimensions?: WorkspaceDimension[];
  tags?: string[];
  scoring?: WorkspaceScoringPolicy;
  source: {
    fixturePath: string;
    expectedTreeDigest?: string;
    pinnedCommit?: string;
    skipDirectories?: string[];
    setupCommands?: WorkspaceCommand[];
    sealed?: boolean;
  };
  task: {
    instruction: string;
    scope?: { allowed?: string[]; forbidden?: string[] };
    briefingPaths?: string[];
  };
  execution?: {
    timeoutMilliseconds?: number;
    maximumAttempts?: number;
    tools?: Partial<ToolPolicy>;
    networkPolicy?: NetworkPolicy;
    environmentAllowlist?: string[];
    temperatureMilli?: number;
    seed?: number;
  };
  verification?: {
    commands?: WorkspaceCommand[];
    hiddenCommands?: WorkspaceCommand[];
    invariants?: FileInvariant[];
    forbiddenChanges?: string[];
    requirePatchCleanliness?: boolean;
    establishBaseline?: boolean;
    maximumChangedLines?: number;
    maximumChangedFiles?: number;
  };
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [],
};

export const DEFAULT_WORKSPACE_EXECUTION_POLICY: WorkspaceExecutionPolicy = {
  timeoutMilliseconds: 900_000,
  maximumAttempts: 1,
  tools: DEFAULT_TOOL_POLICY,
  networkPolicy: 'providerOnly',
  environmentAllowlist: [],
};

/** Normalization, in one place: sorted lists, normalized paths, defaults filled in. */
export function makeWorkspaceCase(input: WorkspaceCaseInput): WorkspaceCase {
  const sortedStrings = (values: string[]): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const verification = input.verification;
  const execution = input.execution;

  return {
    schemaVersion: WORKSPACE_CASE_SCHEMA_VERSION,
    id: input.id,
    version: input.version,
    suiteID: input.suiteID,
    suiteVersion: input.suiteVersion,
    title: input.title ?? input.id,
    description: input.description ?? '',
    dimensions: ([...new Set(input.dimensions ?? ['multiFileEditing'])] as WorkspaceDimension[])
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    source: {
      kind: 'fixtureDirectory',
      fixturePath: normalizeRelativePath(input.source.fixturePath),
      expectedTreeDigest: input.source.expectedTreeDigest,
      pinnedCommit: input.source.pinnedCommit,
      skipDirectories: sortedStrings(input.source.skipDirectories ?? []),
      setupCommands: input.source.setupCommands ?? [],
      sealed: input.source.sealed ?? input.source.expectedTreeDigest !== undefined,
    },
    task: {
      instruction: input.task.instruction,
      scope: scopePolicy(input.task.scope),
      briefingPaths: sortedStrings((input.task.briefingPaths ?? []).map(normalizeRelativePath)),
    },
    execution: {
      ...DEFAULT_WORKSPACE_EXECUTION_POLICY,
      ...execution,
      tools: { ...DEFAULT_TOOL_POLICY, ...execution?.tools, allowedExecutables: sortedStrings(execution?.tools?.allowedExecutables ?? []) },
      environmentAllowlist: sortedStrings(execution?.environmentAllowlist ?? []),
    },
    verification: {
      commands: verification?.commands ?? [],
      hiddenCommands: verification?.hiddenCommands ?? [],
      invariants: verification?.invariants ?? [],
      forbiddenChanges: sortedStrings((verification?.forbiddenChanges ?? []).map(normalizeRelativePath)),
      requirePatchCleanliness: verification?.requirePatchCleanliness ?? true,
      establishBaseline: verification?.establishBaseline ?? true,
      maximumChangedLines: verification?.maximumChangedLines ?? 0,
      maximumChangedFiles: verification?.maximumChangedFiles ?? 0,
    },
    scoring: input.scoring ?? DEFAULT_WORKSPACE_SCORING_POLICY,
    tags: sortedStrings(input.tags ?? []),
  };
}

// MARK: - Identity

/**
 * `cwc1:` — the task's identity.
 *
 * Tagged, like every digest in this codebase, so a reader can tell at a glance which scheme
 * produced it and can never mistake it for the `mlb1:` of a prose case.
 */
export function workspaceCaseDigest(c: WorkspaceCase): string {
  return 'cwc1:' + digestObject(c as unknown as CanonicalValue);
}

/**
 * `cwk1:` — when two workspace results may be put on the same row.
 *
 * WIDER THAN THE PROSE VERSION, deliberately. `comparabilityKey` in the core binds the prompt, the
 * policy and the response format. Here the FIXTURE, the SCOPE, the TOOL POLICY and every
 * VERIFICATION COMMAND are bound too, because each of them changes what a pass means. A model that
 * passed with a shell and a model that passed without one did not do the same thing.
 */
export function workspaceComparabilityKey(c: WorkspaceCase): string {
  return 'cwk1:' + digestObject({
    caseID: c.id,
    caseVersion: c.version,
    suite: `${c.suiteID}@${c.suiteVersion}`,
    caseDigest: workspaceCaseDigest(c),
    fixture: c.source.expectedTreeDigest ?? `unsealed:${c.source.fixturePath}`,
    scope: c.task.scope as unknown as CanonicalValue,
    tools: c.execution.tools as unknown as CanonicalValue,
    networkPolicy: c.execution.networkPolicy,
    // EXPLICIT, not merely transitive through `caseDigest`. Unlocking HOME so a subscription CLI can
    // find its session is a real difference in what the tool could reach, and a reader comparing two
    // keys should be able to see the basis that made them differ rather than being told the whole
    // case digest moved. A run with HOME and a run without it are not the same experiment.
    environmentAllowlist: c.execution.environmentAllowlist,
    maximumAttempts: c.execution.maximumAttempts,
    verification: c.verification as unknown as CanonicalValue,
    scoring: `${c.scoring.id}@${c.scoring.version}`,
  });
}

/** `scoringMode` for the plan slot and the scored core: the shape a reader can sort a table by. */
export function workspaceScoringMode(c: WorkspaceCase): string {
  return `workspace:${c.scoring.id}@${c.scoring.version}`;
}

// MARK: - Validation (fail-closed; the first problem refuses the whole suite)

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function validateWorkspaceCase(c: WorkspaceCase): void {
  const refuse = (code: string, message: string): never => {
    throw new WorkspaceCaseError(code, `workspace case ${c.id}: ${message}`);
  };

  if (!SAFE_ID.test(c.id)) refuse('unsafeCaseID', `'${c.id}' is not a safe identifier (lowercase letters, digits, '.', '_', '-')`);
  if (c.version.length === 0) refuse('emptyVersion', 'declares no version, so a result could never say which task it ran');
  if (c.task.instruction.trim().length === 0) refuse('emptyInstruction', 'has an empty instruction; there is nothing to ask');
  if (c.dimensions.length === 0) refuse('noDimensions', 'declares no capability dimension, so nothing it measures would be counted');
  if (c.execution.maximumAttempts < 1) refuse('nonPositiveAttempts', 'allows zero attempts, which measures nothing');
  if (c.execution.timeoutMilliseconds < 1) refuse('nonPositiveTimeout', 'declares no positive timeout');
  if (c.source.sealed && c.source.expectedTreeDigest === undefined) {
    refuse('sealedWithoutDigest', 'is marked sealed but names no expected tree digest, so it would accept whatever is '
      + 'in that directory today — which is exactly the drift sealing exists to catch');
  }

  const visible = [...c.source.setupCommands, ...c.verification.commands];
  const all = [...visible, ...c.verification.hiddenCommands];
  if (c.verification.commands.length === 0 && c.verification.hiddenCommands.length === 0 && c.verification.invariants.length === 0) {
    refuse('nothingVerified', 'declares no verification command and no invariant, so every attempt would pass');
  }
  const seenCommandIDs = new Set<string>();
  for (const command of all) {
    if (!SAFE_ID.test(command.id)) refuse('unsafeCommandID', `command id '${command.id}' is not a safe identifier`);
    if (seenCommandIDs.has(command.id)) refuse('duplicateCommandID', `declares command id '${command.id}' twice`);
    seenCommandIDs.add(command.id);
    if (command.executable.length === 0) refuse('emptyExecutable', `command '${command.id}' names no executable`);
    if (command.timeoutMilliseconds < 1) refuse('nonPositiveCommandTimeout', `command '${command.id}' declares no positive timeout`);
  }
  for (const command of c.verification.hiddenCommands) {
    if (command.kind !== 'hidden') refuse('hiddenCommandMislabelled', `hidden command '${command.id}' declares kind '${command.kind}'; a hidden check must declare 'hidden' so nothing downstream can mistake it for a visible one`);
  }
  for (const command of c.source.setupCommands) {
    if (command.kind !== 'setup') refuse('setupCommandMislabelled', `setup command '${command.id}' declares kind '${command.kind}'`);
  }

  // The two forbidden lists must agree, because a case author who updates one and not the other has
  // written a rule that is enforced in one place and not the other — which is worse than no rule.
  for (const forbidden of c.verification.forbiddenChanges) {
    if (!c.task.scope.forbidden.includes(forbidden)) {
      refuse('forbiddenListsDisagree', `verification forbids changes to '${forbidden}', which the task scope does not `
        + 'forbid. Both lists must name it, so the agent is told and the result is checked');
    }
  }

  try {
    for (const pattern of [...c.task.scope.allowed, ...c.task.scope.forbidden]) normalizeRelativePath(pattern);
    for (const invariant of c.verification.invariants) normalizeRelativePath(invariant.path);
  } catch (error) {
    if (error instanceof WorkspaceScopeError) refuse('unsafePath', error.message);
    throw error;
  }

  // A credential-shaped name is refused AT SEAL TIME, not when a child is spawned. A case that
  // handed a provider key to a tool authenticated by its own session could turn a run recorded as
  // subscription-included into a metered charge, and that must be unsealeable rather than merely
  // unrunnable.
  for (const name of c.execution.environmentAllowlist) {
    if (isForbiddenEnvironmentName(name) && !ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK.includes(name)) {
      refuse('forbiddenEnvironmentName', `asks for '${name}' in the agent's environment. It is credential-shaped, and `
        + `only ${ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK.join(', ')} may be unlocked by a case.`);
    }
  }

  if (c.verification.maximumChangedLines < 0 || c.verification.maximumChangedFiles < 0) {
    refuse('negativeCeiling', 'declares a negative change ceiling');
  }
  const weights = [
    c.scoring.taskSuccessWeightMilli, c.scoring.testsPassedWeightMilli, c.scoring.regressionFreeWeightMilli,
    c.scoring.scopeRespectedWeightMilli, c.scoring.patchCleanWeightMilli, c.scoring.firstAttemptWeightMilli,
    c.scoring.patchEconomyWeightMilli,
  ];
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    refuse('invalidWeight', 'declares a negative or non-integer scoring weight; every weight is an integer in thousandths');
  }
  if (weights.reduce((sum, weight) => sum + weight, 0) === 0) {
    refuse('zeroWeights', 'declares zero total scoring weight, so every attempt would score the same');
  }
}

// MARK: - Suites

export interface WorkspaceSuite {
  id: string;
  version: string;
  title: string;
  cases: WorkspaceCase[];
}

export function makeWorkspaceSuite(id: string, version: string, title: string, cases: WorkspaceCase[]): WorkspaceSuite {
  return { id, version, title, cases: [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

export function workspaceSuiteDigest(suite: WorkspaceSuite): string {
  return 'cws1:' + digestObject({
    id: suite.id, version: suite.version, cases: suite.cases.map(workspaceCaseDigest),
  });
}

export function validateWorkspaceSuite(suite: WorkspaceSuite): void {
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (seen.has(c.id)) throw new WorkspaceCaseError('duplicateCaseID', `duplicate workspace case id ${c.id} in suite ${suite.id}`);
    seen.add(c.id);
    if (c.suiteID !== suite.id) {
      throw new WorkspaceCaseError('caseOutsideSuite', `workspace case ${c.id} declares suite ${c.suiteID} inside suite ${suite.id}`);
    }
    if (c.suiteVersion !== suite.version) {
      throw new WorkspaceCaseError('suiteVersionMismatch', `workspace case ${c.id} declares version ${c.suiteVersion}, suite is ${suite.version}`);
    }
    validateWorkspaceCase(c);
  }
}

// MARK: - Projection into the existing campaign machinery

/**
 * The instruction EXACTLY as the agent receives it, which is what the manifest freezes.
 *
 * The scope and the briefing are appended here rather than left to a driver, because a driver that
 * composed them would be a driver whose wording is not in the digest — and two drivers would word
 * it differently, making the same case two experiments.
 */
export function workspaceInstructionText(c: WorkspaceCase): string {
  const lines = [c.task.instruction.trim()];
  if (c.task.briefingPaths.length > 0) {
    lines.push('', `Files relevant to this task: ${c.task.briefingPaths.join(', ')}.`);
  }
  if (c.task.scope.allowed.length > 0) {
    lines.push('', `You may change only these paths: ${c.task.scope.allowed.join(', ')}.`);
  }
  if (c.task.scope.forbidden.length > 0) {
    lines.push(`You must not change these paths: ${c.task.scope.forbidden.join(', ')}.`);
  }
  const visibleChecks = c.verification.commands.filter((command) => command.required);
  if (visibleChecks.length > 0) {
    lines.push('', 'This work is checked by: '
      + visibleChecks.map((command) => `${command.executable} ${command.args.join(' ')}`.trim()).join('; ') + '.');
  }
  return lines.join('\n');
}

/** The manifest's prompt record. The instruction is the prompt; there is no supplied context. */
export function workspacePromptRecordOf(c: WorkspaceCase): PromptRecord {
  return { caseID: c.id, text: workspaceInstructionText(c) };
}

export function workspaceScoredCoreEntryOf(c: WorkspaceCase): Omit<ScoredCoreEntry, 'promptSHA256'> {
  return {
    caseID: c.id,
    caseDigest: workspaceCaseDigest(c),
    comparabilityKey: workspaceComparabilityKey(c),
    scoringMode: workspaceScoringMode(c),
    // A workspace agent's output length is not a benchmark setting: the work is the patch, not the
    // prose. Zero means "this case sets no output ceiling", which is what every driver is told.
    maxOutputTokens: 0,
  };
}

/** The plan slot's view. Nothing in `buildPlan` or the ledger needs to know this is a workspace case. */
export function workspacePlannableCaseOf(c: WorkspaceCase, executionOrdinal: number): PlannableCase {
  return {
    ...workspaceScoredCoreEntryOf(c),
    inputBudgetTokens: 0,
    executionOrdinal,
  };
}
