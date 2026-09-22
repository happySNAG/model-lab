// Benchmark engine · who may be handed a development workspace, and the synthetic candidate that
// exercises the whole runner without asking any model anything.
//
// WHO MAY RUN A DEVELOPMENT ATTEMPT IS A CLOSED LIST, AND IT HAS ONE ENTRY. A development attempt is
// only a measurement if the candidate actually worked INSIDE the disposable workspace, with the file
// tools this engine chose and no shell. `frontier-adapter.ts` has verified exactly one argument shape
// that does that — `claude -p --restricted` with an explicit tool list — and refuses Codex rather
// than send it one. The OpenCode and metered HTTP adapters do not read `developmentWorkspace` at all,
// so an attempt sent through them would be answered from nowhere and graded against an untouched
// fixture: a measurement of the plumbing, recorded as a measurement of the model. They are refused
// here, before a campaign is created, rather than discovered one ungradeable row at a time.
//
// THE SYNTHETIC CANDIDATE IS A CONTROL, NOT A MODEL. It is registered under the `ollama` provider
// because a binding needs a provider and that is the one whose execution class — local, no request
// leaves the machine, no credential — is literally true of it. It is never built for a real run and a
// real run never accepts it: a synthetic campaign is marked `synthetic` in its ledger meta, and
// `develop-resume` refuses to cross that line in either direction.
//
// IT KNOWS NO ANSWERS. The reference solutions live in the test tree and are not shipped. Given no
// script it does nothing at all — writes nothing, prints nothing — and is graded as the empty attempt
// that is. Given a script, it does exactly what the script says to the workspace it was handed, and
// every write goes through the same path fence (`resolveInside`) the reader uses.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEVELOPMENT_ANSWER_PATH, DevelopmentTask } from '../core/development-benchmark';
import { developmentSuites } from '../core/development-catalog';
import { DevelopmentCampaignPlan } from './development-plan';
import { FrontierAdapter, FrontierRequest, FrontierResponse } from './frontier-adapter';
import { resolveInside } from './isolation';
import { ProviderID } from './provider';

/**
 * Providers whose adapter has a VERIFIED development argument shape.
 *
 * Adding one is a pass of its own: establish what the tool's interface permits inside a working
 * directory, confirm it can be given file tools and no shell, and pin it with a test.
 */
export const DEVELOPMENT_EXECUTABLE_PROVIDERS: readonly ProviderID[] = ['claudeCLI'];

/** The provider a synthetic candidate is registered under. See the header for why this one. */
export const SYNTHETIC_DEVELOPMENT_PROVIDER: ProviderID = 'ollama';

export const SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT = 'cernum-development-synthetic-script-1';

export class DevelopmentEligibilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DevelopmentEligibilityError';
  }
}

/**
 * Why each candidate in this plan may not be run for real. Empty means every candidate may.
 *
 * Checked against the PLAN, so a preview names the same refusals a run would hit.
 */
export function developmentExecutionRefusals(plan: DevelopmentCampaignPlan): string[] {
  const refusals: string[] = [];
  for (const candidate of plan.candidates) {
    const { provider } = candidate.binding;
    if (!DEVELOPMENT_EXECUTABLE_PROVIDERS.includes(provider)) {
      refusals.push(`${candidate.name}: ${provider} has no verified development workspace argument shape. Only `
        + `${DEVELOPMENT_EXECUTABLE_PROVIDERS.join(', ')} can be handed a disposable repository with file tools and no `
        + 'shell; an attempt sent anywhere else would be graded against a workspace the candidate never saw.');
    }
    if (candidate.binding.identityState !== 'verified') {
      refusals.push(`${candidate.name}: identity is ${candidate.binding.identityState}. A development result is `
        + 'recorded against a named model, so the model has to have been proven first — run '
        + `\`cernum smoke ${provider} --models ${candidate.binding.requestedModelID}\` and plan again.`);
    }
    if (!candidate.costVerdict.authorized) {
      refusals.push(`${candidate.name}: cost eligibility ${candidate.costVerdict.eligibility} is not authorized. `
        + candidate.costVerdict.reason);
    }
  }
  return refusals;
}

/** Refuse, with every reason at once, a plan that may not be run for real. */
export function assertDevelopmentExecutable(plan: DevelopmentCampaignPlan): void {
  const refusals = developmentExecutionRefusals(plan);
  if (refusals.length > 0) {
    throw new DevelopmentEligibilityError('notExecutable',
      `this development campaign may not be run:\n${refusals.map((line) => `  · ${line}`).join('\n')}`);
  }
}

// MARK: - The synthetic candidate

/** What the synthetic candidate does to one task's workspace. Every field is optional. */
export interface SyntheticTaskAction {
  /** Printed as the reply. */
  answerText?: string;
  /** Written to the reserved answer path, exactly as given. */
  answerFile?: string;
  /** Workspace-relative path to new contents, or to `null` to delete it. */
  files?: Record<string, string | null>;
}

export interface SyntheticDevelopmentScript {
  format: typeof SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT;
  /** By task id. A task with no entry is attempted and nothing is done to it. */
  tasks: Record<string, SyntheticTaskAction>;
}

/** Parse and check a script file's contents. Refuses anything it does not understand. */
export function parseSyntheticDevelopmentScript(text: string): SyntheticDevelopmentScript {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DevelopmentEligibilityError('badScript', `the synthetic script is not JSON: ${(error as Error).message}`);
  }
  const script = value as Partial<SyntheticDevelopmentScript>;
  if (script === null || typeof script !== 'object' || script.format !== SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT) {
    throw new DevelopmentEligibilityError('badScript',
      `the synthetic script must declare "format": "${SYNTHETIC_DEVELOPMENT_SCRIPT_FORMAT}"`);
  }
  if (script.tasks === null || typeof script.tasks !== 'object') {
    throw new DevelopmentEligibilityError('badScript', 'the synthetic script has no "tasks" object');
  }
  const known = new Set(developmentSuites.flatMap((suite) => suite.tasks.map((task) => task.id)));
  for (const [taskID, action] of Object.entries(script.tasks)) {
    if (!known.has(taskID)) {
      throw new DevelopmentEligibilityError('badScript', `the synthetic script names ${taskID}, which is not a registered development task`);
    }
    for (const [relative, contents] of Object.entries(action.files ?? {})) {
      if (contents !== null && typeof contents !== 'string') {
        throw new DevelopmentEligibilityError('badScript', `${taskID}: ${relative} must map to a string or null`);
      }
    }
  }
  return script as SyntheticDevelopmentScript;
}

const REGISTERED_TASKS: DevelopmentTask[] = developmentSuites.flatMap((suite) => suite.tasks);

/** Which registered task a request is for, recovered from the prompt the runner actually sent. */
function taskForPrompt(promptText: string): DevelopmentTask | undefined {
  const matches = REGISTERED_TASKS.filter((task) => promptText.includes(task.prompt.user));
  return matches.length === 1 ? matches[0] : undefined;
}

/** A record of one synthetic turn, kept for whoever has to audit where it acted. */
export interface SyntheticTurn {
  taskID: string;
  workspaceRoot: string;
  wrote: string[];
  deleted: string[];
}

/**
 * The synthetic candidate. Contacts nothing: no process, no socket, no credential.
 *
 * It refuses a request that carries no development workspace, because the only thing it exists to
 * do is act on one — a synthetic answer to a text case would be a result from nowhere.
 */
export class SyntheticDevelopmentAdapter implements FrontierAdapter {
  readonly provider: ProviderID = SYNTHETIC_DEVELOPMENT_PROVIDER;
  readonly turns: SyntheticTurn[] = [];

  constructor(private readonly script?: SyntheticDevelopmentScript) {}

  async complete(request: FrontierRequest): Promise<FrontierResponse> {
    const blank: FrontierResponse = {
      answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
      totalElapsedMilliseconds: 0, retryCount: 0, wastedTokens: 0,
    };
    const workspace = request.developmentWorkspace;
    if (!workspace) {
      return { ...blank, failure: { kind: 'budgetRefused', detail: 'the synthetic development candidate answers development attempts only' } };
    }
    const task = taskForPrompt(request.promptText);
    if (!task) {
      return { ...blank, failure: { kind: 'budgetRefused', detail: 'the synthetic development candidate could not tell which task it was sent' } };
    }

    const action = this.script?.tasks[task.id] ?? {};
    const turn: SyntheticTurn = { taskID: task.id, workspaceRoot: workspace.root, wrote: [], deleted: [] };
    const files: [string, string | null][] = Object.entries(action.files ?? {});
    if (action.answerFile !== undefined) files.push([DEVELOPMENT_ANSWER_PATH, action.answerFile]);
    for (const [relative, contents] of files) {
      // THE SAME FENCE THE READER USES. A script that named `../x` or an absolute path is refused
      // here rather than written, so the synthetic candidate is held to the rule a real one is.
      const target = resolveInside(workspace.root, relative);
      if (contents === null) {
        fs.rmSync(target, { force: true });
        turn.deleted.push(relative);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
        turn.wrote.push(relative);
      }
    }
    this.turns.push(turn);

    return {
      ...blank,
      answerText: action.answerText ?? '',
      // The synthetic candidate names itself: it is the one thing that is certainly true about who
      // answered. It is never a real model's identifier, because a synthetic binding never asks for one.
      reportedModelID: request.binding.requestedModelID,
    };
  }
}
