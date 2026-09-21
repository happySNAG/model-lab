// Benchmark engine · asking a provider's CLI about the SESSION, never about a model.
//
// WHAT THIS IS FOR. A forty-eight-run matrix that starts against an already-exhausted subscription
// spends an hour producing forty-eight records of a 429. The circuit breaker in
// `workspace-throttle.ts` stops that AFTER the first decline; the cheaper thing is to know before
// the first request whether the session can be used at all. So this module asks the installed CLI
// what it will say about its own session — and asks it in a way that cannot become a model request.
//
// THE HARD RULE. A preflight that could send a prompt is not a preflight: it is a run that a dry
// run did not print, billed to the allowance it was checking. So the probe argv is not composed
// from anything a caller passes. It is looked up from a frozen table below, checked against that
// table by exact equality, and checked again against a deny-list of every flag this CLI uses to
// carry a prompt or continue a conversation. Both checks have to pass. `assertNonModelProbe` is
// exported so the test suite asserts the property directly rather than trusting the call site.
//
// WHAT CLAUDE CODE 2.1.278 ACTUALLY EXPOSES, derived from the installed binary rather than memory:
//
//   claude auth status --json   {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
//                                "email":…,"orgId":…,"orgName":…,"subscriptionType":"max"}
//   claude doctor               installation health: version, platform, update channel. No usage.
//
// Neither reports remaining allowance, neither reports whether the session is currently throttled,
// and neither reports a reset time. There is no `claude usage`, no `claude quota`, and `auth
// status` carries no rate-limit field of any kind. So this module reports what exists — whether a
// session exists at all, and what plan it is on — and reports remaining allowance as UNAVAILABLE
// with the reason. It does not divide a plan tier by a token price to manufacture a budget. A
// benchmark that claimed to know remaining capacity it cannot observe would be making up the one
// number an operator would most want to trust.

import { CLIResult, findExecutable, runCLI } from './cli-process';
import { Quantity, unavailableQuantity } from './frontier-metrics';
import { ProviderID } from './provider';

export class ProviderSessionProbeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderSessionProbeError';
  }
}

/** One frozen, argument-free way to ask a CLI about its own session. */
export interface NonModelProbe {
  provider: ProviderID;
  executableName: string;
  /** Frozen. Never composed, never extended by a caller, never interpolated into. */
  args: readonly string[];
  /** What this command does, in the tool's own documented terms. */
  purpose: string;
}

/**
 * Every probe this build is willing to run. A provider absent from here has no preflight, and that
 * is reported as an absence rather than worked around.
 */
export const NON_MODEL_SESSION_PROBES: Partial<Record<ProviderID, NonModelProbe>> = {
  claudeCLI: {
    provider: 'claudeCLI',
    executableName: 'claude',
    args: ['auth', 'status', '--json'],
    purpose: 'Claude Code\'s own `auth status` subcommand, which prints the signed-in account and plan as JSON. It '
      + 'is a credential read: it starts no session, sends no prompt and consumes no allowance.',
  },
};

/**
 * Flags this family of CLIs uses to carry a prompt, resume a conversation or pick a model.
 *
 * A deny-list is the weaker of the two checks here and is deliberately kept anyway: the exact-match
 * check below proves the argv is one of the frozen probes, and this proves that whatever is in the
 * frozen table could not have been a model request even if somebody edits the table carelessly.
 */
const ARGUMENTS_THAT_COULD_REACH_A_MODEL = [
  '-p', '--print', '--prompt', '-c', '--continue', '--resume', '--model', '--agent', '--agents',
  '--append-system-prompt', '--system-prompt', '--system-prompt-file', '--append-system-prompt-file',
  '--cloud', '--bg', '--background', '--effort', 'ultrareview',
];

/**
 * Refuse anything that is not one of the frozen probes, or that carries a prompt-bearing flag.
 *
 * Throws rather than returning false: a preflight that silently declined to check would be
 * indistinguishable from one that checked and found nothing.
 */
export function assertNonModelProbe(probe: NonModelProbe): void {
  const declared = NON_MODEL_SESSION_PROBES[probe.provider];
  if (declared === undefined) {
    throw new ProviderSessionProbeError('noProbeForProvider',
      `${probe.provider} has no non-model session probe in this build, so nothing may be run for it.`);
  }
  if (probe.executableName !== declared.executableName
    || probe.args.length !== declared.args.length
    || probe.args.some((argument, index) => argument !== declared.args[index])) {
    throw new ProviderSessionProbeError('probeNotDeclared',
      `refusing to run '${probe.executableName} ${probe.args.join(' ')}' as a session probe: it is not the frozen `
      + `probe this build declares for ${probe.provider}, which is `
      + `'${declared.executableName} ${declared.args.join(' ')}'. A preflight composes no arguments.`);
  }
  for (const argument of probe.args) {
    if (ARGUMENTS_THAT_COULD_REACH_A_MODEL.includes(argument)) {
      throw new ProviderSessionProbeError('probeCouldReachAModel',
        `refusing to run a session probe containing '${argument}': that argument can carry a prompt, resume a `
        + 'conversation or select a model, and a preflight that could send a request is not a preflight.');
    }
  }
}

/** Whether the provider says anything at all about being throttled right now. */
export type SessionThrottleState =
  /** The tool reports no throttle information of any kind. The honest answer for Claude Code 2.1.x. */
  | 'notReported'
  | 'notThrottled'
  | 'throttled';

export interface ProviderSessionStatus {
  provider: ProviderID;
  /** The exact command run, so a reader can run it themselves and get the same answer. */
  probe: string;
  probePurpose: string;
  /** True only when the probe ran to completion and produced the form this build understands. */
  probeSucceeded: boolean;
  /** Why the probe could not answer, when it could not. */
  probeFailure?: string;

  /** Whether a usable session exists at all. Undefined when the probe could not say. */
  signedIn?: boolean;
  /** The plan the account is on, in the provider's own word. Never converted into an allowance. */
  subscriptionType?: string;
  authMethod?: string;

  /**
   * How much allowance is left.
   *
   * ALWAYS `unavailable` for every provider in this build, and the note says which commands were
   * examined and what they do not report. It is a `Quantity` rather than an optional number so that
   * the absence is a first-class value carrying its own reason, exactly like every other absent
   * figure in this engine — and so that nothing downstream can treat "not reported" as "plenty".
   */
  remainingAllowance: Quantity;
  throttleState: SessionThrottleState;
  /** A reset time, only if the provider reported one. Never computed. */
  resetReported?: string;

  /** What the tool said, verbatim and parsed, for the evidence. Absent when it said nothing usable. */
  raw?: Record<string, unknown>;
}

const CLAUDE_NO_ALLOWANCE_FIGURE =
  'Claude Code 2.1.278 exposes no remaining-allowance figure to a non-model command. `claude auth status --json` '
  + 'reports the account, the auth method and the plan tier and nothing about consumption; `claude doctor` reports '
  + 'installation health only; there is no usage or quota subcommand. So how much of this subscription\'s session '
  + 'allowance is left is NOT KNOWN before the matrix starts, and this engine will not derive a figure from a plan '
  + 'name. The live circuit breaker is what bounds the waste instead: the first session-limit decline stops the '
  + 'matrix, and the cells after it are recorded as not executed.';

const NO_PROBE =
  'this provider has no non-model session probe in this build, so nothing was asked and nothing is claimed. It is '
  + 'not zero and it is not plenty: it is unknown.';

/**
 * Ask the provider's CLI about its session, without going near a model.
 *
 * Never throws for an absent tool or a tool that answered in an unfamiliar shape: a preflight that
 * fell over because a CLI changed its wording would be worse than the state it was checking. Every
 * such case comes back as `probeSucceeded: false` with the reason, and remaining allowance stays
 * unavailable — which it would have been anyway.
 */
export async function readProviderSessionStatus(options: {
  provider: ProviderID;
  environmentSource?: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number;
  /** Injected by the tests, so the probe's argv can be asserted without a CLI installed. */
  runCommand?: (request: Parameters<typeof runCLI>[0]) => Promise<CLIResult>;
}): Promise<ProviderSessionStatus> {
  const probe = NON_MODEL_SESSION_PROBES[options.provider];
  if (probe === undefined) {
    return {
      provider: options.provider,
      probe: '(none)',
      probePurpose: 'this build declares no non-model way to ask this provider about its session',
      probeSucceeded: false,
      probeFailure: `no non-model session probe is declared for ${options.provider}`,
      remainingAllowance: unavailableQuantity(NO_PROBE),
      throttleState: 'notReported',
    };
  }

  // THE GUARD RUNS ON EVERY CALL, not only in the tests. It is cheap and it is the whole promise.
  assertNonModelProbe(probe);

  const environment = options.environmentSource ?? process.env;
  const executablePath = findExecutable(probe.executableName, environment);
  const printed = `${probe.executableName} ${probe.args.join(' ')}`;
  const base = {
    provider: options.provider,
    probe: printed,
    probePurpose: probe.purpose,
    remainingAllowance: unavailableQuantity(
      options.provider === 'claudeCLI' ? CLAUDE_NO_ALLOWANCE_FIGURE : NO_PROBE),
    throttleState: 'notReported' as SessionThrottleState,
  };

  if (executablePath === undefined && options.runCommand === undefined) {
    return { ...base, probeSucceeded: false, probeFailure: `${probe.executableName} is not on PATH, so its session could not be asked about` };
  }

  const result = await (options.runCommand ?? runCLI)({
    executable: executablePath ?? probe.executableName,
    args: [...probe.args],
    timeoutMilliseconds: options.timeoutMilliseconds ?? 20_000,
  });

  if (result.failure !== undefined || result.exitCode !== 0) {
    return {
      ...base,
      probeSucceeded: false,
      probeFailure: `${printed} exited ${result.exitCode ?? 'without a status'}`
        + `${result.failure === undefined ? '' : ` (${result.failure.kind}: ${result.failure.detail})`}`,
    };
  }

  let parsed: Record<string, unknown> | undefined;
  try {
    const candidate: unknown = JSON.parse(result.stdout.trim());
    if (typeof candidate === 'object' && candidate !== null) parsed = candidate as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return {
      ...base,
      probeSucceeded: false,
      probeFailure: `${printed} exited cleanly but did not print the documented JSON object, so nothing here can `
        + 'say what it reported. Cernum does not scrape an unrecognised format.',
    };
  }

  const string = (key: string): string | undefined => (typeof parsed?.[key] === 'string' ? parsed[key] as string : undefined);
  return {
    ...base,
    probeSucceeded: true,
    signedIn: typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined,
    subscriptionType: string('subscriptionType'),
    authMethod: string('authMethod'),
    raw: parsed,
  };
}

/**
 * Whether a matrix should be refused outright on the strength of the preflight.
 *
 * ONLY ON A FACT, NEVER ON A GUESS. The one thing the probe can establish is that no session exists
 * — `loggedIn: false` — and a matrix launched against that would produce nothing but
 * `notAuthenticated` records. Everything else, including "this is a big matrix and the allowance
 * might not cover it", is NOT something the probe can support, so it produces no refusal and no
 * warning pretending to be one.
 */
export function sessionPreflightRefusal(status: ProviderSessionStatus): string | undefined {
  if (status.probeSucceeded && status.signedIn === false) {
    return `${status.provider} reports no signed-in session (${status.probe}), so every run in this matrix would be `
      + 'declined for authentication before a model saw anything. Sign in and re-run.';
  }
  if (status.throttleState === 'throttled') {
    return `${status.provider} reports that it is currently throttled`
      + `${status.resetReported === undefined ? '' : ` (${status.resetReported})`}, so a matrix started now would `
      + 'spend its runs on declines.';
  }
  return undefined;
}

/** The preflight, as a person reads it in a dry run. */
export function describeProviderSessionStatus(status: ProviderSessionStatus): string[] {
  const lines: string[] = [];
  lines.push(`session probe   ${status.probe}`);
  lines.push(`                ${status.probePurpose}`);
  if (!status.probeSucceeded) {
    lines.push(`  UNANSWERED    ${status.probeFailure ?? 'the probe produced no answer'}`);
  } else {
    lines.push(`  signed in     ${status.signedIn === undefined ? 'not reported' : status.signedIn ? 'yes' : 'NO'}`
      + `${status.authMethod === undefined ? '' : ` · ${status.authMethod}`}`
      + `${status.subscriptionType === undefined ? '' : ` · plan ${status.subscriptionType}`}`);
  }
  lines.push(`  throttled now ${status.throttleState === 'notReported'
    ? 'NOT REPORTED — this tool exposes no throttle state to a non-model command'
    : status.throttleState}`);
  lines.push('  allowance     NOT KNOWN — and not "plenty".');
  lines.push(`                ${status.remainingAllowance.note ?? ''}`);
  return lines;
}
