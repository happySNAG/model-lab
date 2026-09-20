// Benchmark engine · the contract every agent driver honours, defined before any provider is wired
// to it.
//
// WHY THE CONTRACT COMES FIRST. The prose side of this engine grew a `FrontierAdapter` interface
// and then three implementations, and the interface held because it was written down before the
// first one. The agentic side has a harder version of the same problem: `claude`, `codex` and
// `opencode` disagree about almost everything — how a working directory is named, whether tools can
// be enumerated, what a "turn" is, what the output format is, and whether the tool will tell you
// what it did. A contract written to fit whichever one is implemented first becomes that tool's
// shape wearing a general name, and the second implementation then either lies or leaks.
//
// SO THE CONTRACT ASKS FOR THE THINGS THE BENCHMARK NEEDS, AND EACH DRIVER DECLARES WHICH OF THEM
// IT CAN ACTUALLY DO. `WorkspaceAgentCapabilities` is not decoration: a case that requires command
// execution and a driver that cannot root a tool to a directory is a combination the runner REFUSES
// before spending anything, rather than running and quietly measuring something else.
//
// WHAT A DRIVER IS RESPONSIBLE FOR
//   · starting the tool with its working directory set to `workspaceRoot`, and expressing every
//     rooting flag the tool documents;
//   · expressing the tool policy through whatever switches the tool has, and REPORTING what it
//     could not express — never dropping it silently;
//   · emitting transcript events as they happen, marked `agentReported` unless the driver itself
//     observed the thing;
//   · returning when the tool finishes, its deadline passes, or the caller cancels.
//
// WHAT A DRIVER IS NOT RESPONSIBLE FOR, AND MUST NOT DO
//   · deciding whether the task succeeded. It reports what happened. The verdict is taken from the
//     tree and the verification commands, in `workspace-execution.ts`, by code that never sees the
//     driver's opinion.
//   · cleaning up the workspace. The runner owns it, before and after.
//   · retrying. Attempts are the runner's, because each one needs a fresh workspace and a recorded
//     boundary.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, sha256Bytes, sha256Text } from './canonical';
import { ProviderID } from './provider';
import { ScopePolicy } from './workspace-scope';
import { ToolPolicy, NetworkPolicy, ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK } from './workspace-case';
import { TranscriptBuilder, TranscriptEvent } from './workspace-transcript';
import { isForbiddenEnvironmentName, resolveInside } from './isolation';

export class WorkspaceAgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceAgentError';
  }
}

/**
 * What one driver can actually do, declared rather than assumed.
 *
 * `rootsToDirectory` is the one that decides whether a driver may be used at all. A tool that cannot
 * be told where to work will work wherever it was launched, which for a benchmark launched from a
 * checkout is the checkout — and a model that edits Cernum instead of the fixture has produced a
 * result about nothing while changing the thing that produced it.
 */
export interface WorkspaceAgentCapabilities extends Record<string, CanonicalValue | undefined> {
  rootsToDirectory: boolean;
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canExecuteCommands: boolean;
  /** The tool keeps working after a failed check without being asked again. */
  canIterateWithinOneInvocation: boolean;
  /** The tool's stream names the tools it used, so `agentReported` events can be emitted at all. */
  reportsToolCalls: boolean;
  /** The tool names the model that answered. False for every Codex path — see `identity-admission.ts`. */
  reportsModelIdentity: boolean;
  /** The tool documents a switch for each of `ToolPolicy`'s fields. Rarely all true. */
  expressesToolPolicy: boolean;
  /** The tool documents a network switch. Recording `false` is what keeps `networkPolicy` honest. */
  expressesNetworkPolicy: boolean;
}

/**
 * What the previous attempt produced, handed to the next one.
 *
 * DIGESTS AND STATUSES, NOT A DIFF. Attempt 2 starts from a clean copy of the fixture, so handing
 * it attempt 1's patch would be handing it work to re-apply rather than a failure to read. What is
 * measured by a second attempt is whether a model can act on what a check told it, so what it gets
 * is what the check said.
 */
export interface PriorAttemptBriefing extends Record<string, CanonicalValue | undefined> {
  attemptIndex: number;
  /** Why the previous attempt stopped, in the closed vocabulary rather than in prose. */
  terminationReason: string;
  outcome: string;
  /** The verification output the previous attempt failed on, bounded and redacted. */
  failureDetail: string;
  transcriptDigest: string;
  patchDigest: string;
}

/**
 * What attempt 2 is TOLD about attempt 1, composed once, here, in one place.
 *
 * WHY THIS IS NOT A DRIVER'S JOB, AND WHY THE ABSENCE OF IT WAS A DEFECT. `PriorAttemptBriefing` has
 * existed since the workspace foundation and NOTHING SENT IT. Every driver wrote
 * `request.instruction` to the tool and nothing else, so a second attempt was handed the identical
 * text the first one got — which measures resampling, not recovery. A case declaring
 * `maximumAttempts: 2` was therefore measuring a different thing from the one its own comment
 * described.
 *
 * The fix cannot live in a driver. Wording composed by `claude`'s driver and wording composed by
 * `codex`'s driver would make one case two experiments, exactly as a driver-composed INSTRUCTION
 * would — which is why `workspaceInstructionText` lives on the case. So the retry section is
 * composed by the engine, appended by the runner, and every driver keeps sending
 * `request.instruction` verbatim without knowing which attempt this is.
 *
 * IT CARRIES THE CHECK'S OWN OUTPUT AND NO ADVICE. What is measured by a second attempt is whether
 * a model can read a failure, so the briefing states what happened and hands over the text the
 * verification produced. It does not name a file, suggest a cause or say what to change: a briefing
 * that did would be measuring whether the model can follow an instruction this engine wrote.
 *
 * DETERMINISTIC. No timestamp, no duration, no path outside the workspace — two runs that failed
 * the same way produce byte-identical briefings, so a transcript digest stays comparable.
 */
export function retryBriefingText(prior: PriorAttemptBriefing): string {
  return [
    `ATTEMPT ${prior.attemptIndex + 1} OF THIS TASK DID NOT PASS, and you are now making the next one.`,
    '',
    'You are looking at a FRESH COPY of the original repository. Nothing the previous attempt wrote is',
    'here: its edits were discarded, not kept, so start from what is in front of you rather than from',
    'what you remember writing.',
    '',
    `How it ended: ${prior.outcome} (${prior.terminationReason}).`,
    '',
    prior.failureDetail.trim().length === 0
      ? 'The checks produced no output to show you.'
      : ['This is what the checks reported, verbatim:', '', prior.failureDetail.trim()].join('\n'),
  ].join('\n');
}

export interface WorkspaceAgentRequest {
  /** Identity, so a driver can label what it starts and a log can be traced back to a task version. */
  caseID: string;
  caseVersion: string;
  caseDigest: string;
  attemptIndex: number;
  maximumAttempts: number;

  /**
   * The exact text to send. Composed by the CASE and the ENGINE; never by the driver.
   *
   * On attempt 1 this is exactly `workspaceInstructionText(case)` — the text the frozen manifest
   * sealed. On a later attempt the runner appends `retryBriefingText(prior)` to it, so a driver
   * still writes this field verbatim and still composes nothing. `prior` is on the request beside
   * it, for a driver whose tool has a better place to put a previous failure than the prompt.
   */
  instruction: string;
  /** ABSOLUTE path. The only tree this invocation may touch. */
  workspaceRoot: string;
  scope: ScopePolicy;
  tools: ToolPolicy;
  networkPolicy: NetworkPolicy;

  /** The complete environment for the child. Already filtered; a driver adds nothing to it. */
  environment: Record<string, string>;
  timeoutMilliseconds: number;
  temperatureMilli?: number;
  seed?: number;

  prior?: PriorAttemptBriefing;

  /** Events go here as they happen. The runner owns the builder. */
  transcript: TranscriptBuilder;
  /** Polled, so a pause reaches a child process. Same contract as the prose adapters. */
  shouldCancel?: () => boolean;
}

export type WorkspaceAgentFailureKind =
  | 'notInstalled' | 'spawnFailure' | 'timeout' | 'cancelled' | 'exitFailure'
  | 'notAuthenticated' | 'rateLimited' | 'transport' | 'malformedOutput'
  /** The driver could not express something the case froze. Refused, never downgraded. */
  | 'policyNotExpressible';

export interface WorkspaceAgentResult {
  /** The tool ran to completion under its own steam. Says nothing about whether the task was done. */
  completed: boolean;
  /** The agent's closing prose, when it produced any. Recorded, never scored on its own. */
  finalMessage?: string;
  failure?: { kind: WorkspaceAgentFailureKind; detail: string };

  /** Who answered, when the tool says. Empty string means it named nobody — not "it was the one asked". */
  reportedModelID: string;
  /** Everything the driver could not express, in the case's own words. Empty is the good case. */
  unexpressed: string[];
  /** Settings the driver sent that the tool does not enforce. Recorded, never treated as a refusal. */
  notEnforceable: string[];
  /** The isolation actually applied, flag by flag, for the evidence. */
  activeIsolation: string[];

  elapsedMilliseconds: number;
  /** Token and cost figures, when the tool reports them. Shaped like the prose side's usage. */
  usage?: Record<string, CanonicalValue | undefined>;
  /** Events the driver emitted. The runner already has them; returned so a driver can be tested alone. */
  events: TranscriptEvent[];
}

export interface WorkspaceAgentDriver {
  readonly driverID: string;
  readonly provider: ProviderID;
  readonly capabilities: WorkspaceAgentCapabilities;
  run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult>;
}

/**
 * Refuse a driver that cannot do what the case requires, BEFORE anything is spent.
 *
 * Returns the reasons; empty means it may run. A refusal here is the cheapest one available: no
 * process is started, no allowance is consumed, and nothing has to be un-recorded afterwards.
 */
export function driverShortfalls(driver: WorkspaceAgentDriver, tools: ToolPolicy, networkPolicy: NetworkPolicy): string[] {
  const shortfalls: string[] = [];
  if (!driver.capabilities.rootsToDirectory) {
    shortfalls.push(`${driver.driverID} cannot be told which directory to work in, so it would work wherever it was `
      + 'launched. A workspace benchmark cannot be run through it at all.');
  }
  if (tools.fileRead && !driver.capabilities.canReadFiles) shortfalls.push(`${driver.driverID} cannot read files, which this case requires`);
  if (tools.fileWrite && !driver.capabilities.canWriteFiles) shortfalls.push(`${driver.driverID} cannot write files, which this case requires`);
  if (tools.commandExecution && !driver.capabilities.canExecuteCommands) {
    shortfalls.push(`${driver.driverID} cannot execute commands, which this case requires`);
  }
  if (!tools.commandExecution && driver.capabilities.canExecuteCommands && !driver.capabilities.expressesToolPolicy) {
    shortfalls.push(`this case forbids command execution and ${driver.driverID} documents no switch that turns it off, `
      + 'so the request would be sent under a policy the tool never received');
  }
  if (networkPolicy === 'denied' && !driver.capabilities.expressesNetworkPolicy) {
    shortfalls.push(`this case declares no network access and ${driver.driverID} documents no network switch, so the `
      + 'declaration could not be expressed to the tool. Cernum records what it observes rather than asserting this held.');
  }
  return shortfalls;
}

// MARK: - The environment a driver's child actually gets

/**
 * Names that describe the machine and carry no authority. Always allowed.
 *
 * `HOME` is NOT here, and that is the whole point of `environmentAllowlist`: a case that needs a
 * subscription CLI to find its own session says `HOME` out loud, in the frozen case, where a reader
 * can see it. It is never granted by default.
 */
export const ALWAYS_ALLOWED_ENVIRONMENT_NAMES = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'TERM'];

export { ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK };

export const WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX =
  'A workspace attempt runs in a fresh copy of the fixture with an ALLOW-LISTED environment: nothing is inherited '
  + 'unless the frozen case named it. That bounds what the tool is HANDED, not what a process on this machine can '
  + 'reach. A case that unlocks HOME so a subscription CLI can find its session has unlocked a directory that tool '
  + 'can read; Cernum states that rather than implying otherwise. What the verdict rests on is the final tree and '
  + 'the verification commands — both observed by this engine — never the tool\'s account of its own behaviour.';

/**
 * Build the child environment for one attempt.
 *
 * DEFAULT-DENY. The result contains the always-allowed machine names, plus exactly the names the
 * case listed, plus `TMPDIR` pointed INSIDE the workspace so a tool's scratch files land somewhere
 * disposable rather than in the user's temp directory. A listed name that is credential-shaped is
 * refused unless it is one of the names a case is permitted to unlock, so a case cannot quietly
 * pass `ANTHROPIC_API_KEY` to a run recorded as subscription-included.
 */
export function workspaceEnvironment(options: {
  allowlist: string[];
  /**
   * Where the tool's scratch files go. OUTSIDE the workspace, deliberately.
   *
   * Pointing `TMPDIR` at the workspace itself was the first arrangement and it was wrong: a tool
   * that writes one lock file into its temp directory would then have written a file into the tree
   * being diffed, and the case would score a scope violation for the tool's housekeeping. It is
   * still disposable, still under the benchmark sandbox, and still not the user's `/tmp`.
   */
  temporaryDirectory: string;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.source ?? process.env;
  const out: Record<string, string> = {};
  const permitted = new Set(ALWAYS_ALLOWED_ENVIRONMENT_NAMES);

  for (const name of options.allowlist) {
    if (isForbiddenEnvironmentName(name) && !ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK.includes(name)) {
      throw new WorkspaceAgentError('forbiddenEnvironmentName',
        `this case asks for '${name}' in the agent's environment. It is credential-shaped, and a benchmark that hands a `
        + 'provider credential to a tool authenticated by its own session can turn a run recorded as '
        + `subscription-included into a metered charge. Only ${ENVIRONMENT_NAMES_A_CASE_MAY_UNLOCK.join(', ')} may be unlocked by a case.`);
    }
    permitted.add(name);
  }

  for (const name of permitted) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  // Last, so it cannot be overridden by an inherited value.
  out.TMPDIR = options.temporaryDirectory;
  return out;
}

// MARK: - A deterministic driver, so every path is testable without a provider

/**
 * One scripted step. The test author says what the "agent" does; the runner is none the wiser.
 *
 * Mirrors `ScriptedFrontierAdapter` on the prose side, and exists for the same reason: every branch
 * of the runner — success, scope violation, dirty patch, timeout, retry-then-recover — has to be
 * reachable in a test without a request leaving the machine.
 */
export type ScriptedStep =
  | { do: 'write'; path: string; contents: string }
  | { do: 'delete'; path: string }
  | { do: 'read'; path: string }
  | { do: 'say'; text: string }
  | { do: 'runCommand'; executable: string; args?: string[]; exitCode?: number }
  | { do: 'fail'; kind: WorkspaceAgentFailureKind; detail: string }
  /**
   * Plant a symlink inside the workspace. Creating one is legitimate — a model may run `ln -s` —
   * and the question the confinement has to answer is whether writing THROUGH it is refused.
   */
  | { do: 'symlink'; path: string; target: string }
  /** Write OUTSIDE the workspace root. The driver refuses it and records a boundary refusal. */
  | { do: 'escape'; path: string };

export interface ScriptedAttempt {
  steps: ScriptedStep[];
  finalMessage?: string;
}

export const SCRIPTED_DRIVER_CAPABILITIES: WorkspaceAgentCapabilities = {
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  canIterateWithinOneInvocation: true,
  reportsToolCalls: true,
  reportsModelIdentity: true,
  expressesToolPolicy: true,
  expressesNetworkPolicy: true,
};

/**
 * A driver that does exactly what a script says, inside the workspace, with no provider involved.
 *
 * It goes through `resolveInside` for every path, so `{ do: 'escape' }` is genuinely refused by the
 * same confinement the real drivers will use rather than by a special case in a test.
 */
export class ScriptedWorkspaceAgent implements WorkspaceAgentDriver {
  readonly driverID = 'driver.scripted';

  readonly provider: ProviderID;

  readonly capabilities: WorkspaceAgentCapabilities;

  constructor(private readonly attempts: ScriptedAttempt[],
              options: { provider?: ProviderID; capabilities?: Partial<WorkspaceAgentCapabilities> } = {}) {
    this.provider = options.provider ?? 'claudeCLI';
    this.capabilities = { ...SCRIPTED_DRIVER_CAPABILITIES, ...options.capabilities };
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const script = this.attempts[Math.min(request.attemptIndex, this.attempts.length - 1)] ?? { steps: [] };
    let failure: WorkspaceAgentResult['failure'];

    const digestOf = (relative: string): string | undefined => {
      try {
        return sha256Bytes(fs.readFileSync(resolveInside(request.workspaceRoot, relative)));
      } catch {
        return undefined;
      }
    };

    for (const step of script.steps) {
      if (request.shouldCancel?.()) {
        failure = { kind: 'cancelled', detail: 'the run was paused or aborted before this attempt finished' };
        break;
      }
      switch (step.do) {
        case 'say':
          request.transcript.emit('message', 'agentReported', request.attemptIndex, step.text,
            { channel: 'visible', textDigest: sha256Text(step.text), textByteCount: Buffer.byteLength(step.text, 'utf8') });
          break;
        case 'read': {
          request.transcript.emit('toolCall', 'agentReported', request.attemptIndex, `read ${step.path}`,
            { toolName: 'readFile', argumentsDigest: sha256Text(step.path) });
          request.transcript.emit('fileRead', 'engineObserved', request.attemptIndex, `read ${step.path}`,
            { path: step.path, afterSHA256: digestOf(step.path) });
          break;
        }
        case 'write': {
          const beforeSHA256 = digestOf(step.path);
          let target: string;
          try {
            // The confinement, on the ordinary path rather than only on the deliberate escape: a
            // write THROUGH a planted symlink is refused here, exactly as a real driver's would be.
            target = resolveInside(request.workspaceRoot, step.path);
          } catch (error) {
            request.transcript.emit('boundaryRefusal', 'engineObserved', request.attemptIndex,
              error instanceof Error ? error.message : String(error), { path: step.path });
            break;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, step.contents);
          request.transcript.emit('toolCall', 'agentReported', request.attemptIndex, `write ${step.path}`,
            { toolName: 'writeFile', argumentsDigest: sha256Text(step.path) });
          request.transcript.emit('fileWrite', 'engineObserved', request.attemptIndex, `wrote ${step.path}`, {
            path: step.path, beforeSHA256, afterSHA256: sha256Text(step.contents),
            byteCount: Buffer.byteLength(step.contents, 'utf8'),
          });
          break;
        }
        case 'delete': {
          const beforeSHA256 = digestOf(step.path);
          fs.rmSync(resolveInside(request.workspaceRoot, step.path), { force: true });
          request.transcript.emit('fileWrite', 'engineObserved', request.attemptIndex, `deleted ${step.path}`,
            { path: step.path, beforeSHA256 });
          break;
        }
        case 'runCommand': {
          // `agentReported`, NOT `engineObserved`, and the difference is the whole point. This step
          // does not run anything — it states an exit code. Labelling a stated exit status as
          // observed would let a driver assert a green test run into the record the scorer reads,
          // which is exactly what the provenance split exists to refuse. A real driver reading its
          // tool's stream is in the same position: the tool ran the command, the engine did not.
          const exitCode = step.exitCode ?? 0;
          request.transcript.emit('commandExecuted', 'agentReported', request.attemptIndex,
            `${step.executable} ${(step.args ?? []).join(' ')}`.trim(),
            { executable: step.executable, argv: step.args ?? [], exitCode, elapsedMilliseconds: 0 });
          break;
        }
        case 'escape': {
          // The confinement, not a test fixture pretending to be one.
          try {
            resolveInside(request.workspaceRoot, step.path);
            request.transcript.emit('harnessFault', 'engineObserved', request.attemptIndex,
              `the scripted escape to ${step.path} was not refused, which means the confinement did not hold`);
          } catch (error) {
            request.transcript.emit('boundaryRefusal', 'engineObserved', request.attemptIndex,
              error instanceof Error ? error.message : String(error), { path: step.path });
          }
          break;
        }
        case 'symlink': {
          const link = resolveInside(request.workspaceRoot, step.path);
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.symlinkSync(step.target, link);
          request.transcript.emit('fileWrite', 'engineObserved', request.attemptIndex,
            `created a symlink at ${step.path}`, { path: step.path });
          break;
        }
        case 'fail':
          failure = { kind: step.kind, detail: step.detail };
          break;
      }
      if (failure) break;
    }

    return {
      completed: failure === undefined,
      finalMessage: script.finalMessage,
      failure,
      reportedModelID: this.capabilities.reportsModelIdentity ? 'scripted-model' : '',
      unexpressed: [],
      notEnforceable: [],
      activeIsolation: [`workspace rooted at ${request.workspaceRoot}`, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      events: request.transcript.build().events.slice(before),
    };
  }
}
