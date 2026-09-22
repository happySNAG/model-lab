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
//
// WHAT CODEX CLI 0.155.0 EXPOSES, derived the same way:
//
//   codex login status          one line of PROSE — `Logged in using ChatGPT`, exit 0; `Not logged in`,
//                               exit 1. No JSON form (`--json` is refused). Not read: prose is not a field.
//   codex doctor --json         a redacted machine-readable report. Its `auth.credentials` check states
//                               the stored auth mode and whether ChatGPT tokens or an API key are stored
//                               — read from the local credential store — and it FAILS, with no stored
//                               mode, when there are no credentials at all. It also runs reachability
//                               checks: an HTTP probe of the inference URL (answered 405 — no inference
//                               request is formed) and a Responses WebSocket HANDSHAKE, which carries the
//                               session's bearer (it answers 401 without one) and sends no request frame.
//
// So the doctor is the probe. It is the command the Codex workspace driver already runs before its first
// request, it is a credential read plus a transport handshake, and it sends no model request and consumes
// no allowance. What it CANNOT say: whether stored tokens are still valid for inference, how much
// allowance remains, or whether the session is throttled. A handshake that succeeded is reported beside
// the session as the tool's own words and is never treated as proof that a model request would be served.
// Expired-token behaviour could not be established without a real session to break, so it is not claimed.

import { CLIResult, findExecutable, runCLI } from './cli-process';
import { CodexAuthStatus, codexSubscriptionUsable, parseCodexDoctorAuth } from './codex-cli';
import { environmentWithoutCredentials } from './redaction';
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
  codexCLI: {
    provider: 'codexCLI',
    executableName: 'codex',
    args: ['doctor', '--json'],
    purpose: 'the Codex CLI\'s own `doctor --json` report, run with every OPENAI_* and CODEX_* name removed from its '
      + 'environment, exactly as the workspace driver runs its children. It reads the local credential store and checks '
      + 'reachability (an HTTP probe and a WebSocket handshake that sends no request frame). It sends no prompt, makes '
      + 'no model request and consumes no allowance.',
  },
};

/** Names that could redirect a Codex process, change its credential, or change who pays. Never given to the probe. */
const CODEX_PROBE_REFUSED_ENVIRONMENT = /^(OPENAI_|CODEX_)/;

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

  /**
   * Whether the session is one this matrix may bill as subscription-included. Codex only: an API-key
   * session exists and is signed in, and it is still refused, because it bills a card per token.
   */
  sessionUsable?: boolean;
  sessionUsableReason?: string;
  /** The tool's own account of its authenticated transport handshake. Reported; never proof of service. */
  transportHandshake?: string;
  /** Environment NAMES withheld from the probe. Values are never read into this object. */
  environmentWithheld?: string[];
  /** True when the probe was deliberately NOT run yet: a dry run that contacts nothing. Never a refusal. */
  deferredToLiveRun?: boolean;
}

const CLAUDE_NO_ALLOWANCE_FIGURE =
  'Claude Code 2.1.278 exposes no remaining-allowance figure to a non-model command. `claude auth status --json` '
  + 'reports the account, the auth method and the plan tier and nothing about consumption; `claude doctor` reports '
  + 'installation health only; there is no usage or quota subcommand. So how much of this subscription\'s session '
  + 'allowance is left is NOT KNOWN before the matrix starts, and this engine will not derive a figure from a plan '
  + 'name. The live circuit breaker is what bounds the waste instead: the first session-limit decline stops the '
  + 'matrix, and the cells after it are recorded as not executed.';

const CODEX_NO_ALLOWANCE_FIGURE =
  'Codex CLI 0.155.0 exposes no remaining-allowance figure to a non-model command. `codex doctor --json` reports the '
  + 'credential store, configuration and reachability and nothing about consumption; `codex login status` prints one '
  + 'line of prose; there is no usage or quota subcommand. How much allowance is left is NOT KNOWN before the matrix '
  + 'starts. The live circuit breaker bounds the waste instead, and the first run is still what discovers a session the '
  + 'service will not serve.';

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
  const codex = options.provider === 'codexCLI';
  // THE CODEX PROBE SEES THE ENVIRONMENT THE RUNS WILL SEE. The workspace driver refuses every OPENAI_* and
  // CODEX_* name, so a probe that inherited them would be describing a session the runs never use — and
  // an OPENAI_API_KEY in the operator's shell would make it describe an API-key session that is never used.
  const withheld = codex ? Object.keys(environment).filter((name) => CODEX_PROBE_REFUSED_ENVIRONMENT.test(name)).sort() : [];
  const probeEnvironment = codex
    ? Object.fromEntries(Object.entries(environmentWithoutCredentials(environment))
      .filter(([name, value]) => !CODEX_PROBE_REFUSED_ENVIRONMENT.test(name) && value !== undefined)) as Record<string, string>
    : undefined;
  const base = {
    provider: options.provider,
    probe: printed,
    probePurpose: probe.purpose,
    remainingAllowance: unavailableQuantity(
      options.provider === 'claudeCLI' ? CLAUDE_NO_ALLOWANCE_FIGURE : codex ? CODEX_NO_ALLOWANCE_FIGURE : NO_PROBE),
    throttleState: 'notReported' as SessionThrottleState,
    ...(codex ? { environmentWithheld: withheld } : {}),
  };

  if (executablePath === undefined && options.runCommand === undefined) {
    return { ...base, probeSucceeded: false, probeFailure: `${probe.executableName} is not on PATH, so its session could not be asked about` };
  }

  const result = await (options.runCommand ?? runCLI)({
    executable: executablePath ?? probe.executableName,
    args: [...probe.args],
    // The doctor's reachability checks take a few seconds; the Claude probe keeps its own bound.
    timeoutMilliseconds: options.timeoutMilliseconds ?? (codex ? 60_000 : 20_000),
    ...(probeEnvironment === undefined ? {} : { replaceEnvironment: probeEnvironment }),
  });

  // `codex doctor` EXITS 1 WHEN ANY CHECK FAILS — including "no credentials" — and still prints the report,
  // so its answer is read whenever it printed one. Only a probe that could not run at all is unanswered.
  if (codex && (result.failure === undefined || result.failure.kind === 'exitFailure') && result.stdout.trim().length > 0) {
    return { ...base, ...readCodexDoctorSession(result.stdout, printed) };
  }

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
 * What `codex doctor --json` establishes about the session, and nothing it does not.
 *
 * NOTHING IDENTIFYING LEAVES THIS FUNCTION. The report carries the credential file's path (which names
 * the account holder's home directory) and the configured model; neither is copied. `raw` holds the four
 * typed auth fields and the check verdicts, and that is all.
 */
function readCodexDoctorSession(stdout: string, printed: string): Partial<ProviderSessionStatus> & { probeSucceeded: boolean } {
  let report: { checks?: Record<string, { status?: unknown; summary?: unknown; details?: Record<string, unknown> }> };
  try {
    report = JSON.parse(stdout.trim()) as typeof report;
  } catch {
    return { probeSucceeded: false, probeFailure: `${printed} did not print the documented JSON report, so nothing here can `
      + 'say what it reported. Cernum does not scrape an unrecognised format.' };
  }
  const credentials = report?.checks?.['auth.credentials'];
  if (credentials === undefined) {
    return { probeSucceeded: false, probeFailure: `${printed} printed no \`auth.credentials\` check, so how this session is `
      + 'authenticated is unknown' };
  }
  const handshakeCheck = report.checks?.['network.websocket_reachability'];
  const handshakeDetail = handshakeCheck?.details?.['handshake result'] ?? handshakeCheck?.details?.['handshake transport error'];
  const transportHandshake = handshakeCheck === undefined ? undefined
    : `${String(handshakeCheck.status)}${typeof handshakeDetail === 'string' ? ` — ${handshakeDetail.slice(0, 120)}` : ''}`;
  const auth: CodexAuthStatus | undefined = parseCodexDoctorAuth(stdout);
  const raw = {
    authCredentialsStatus: String(credentials.status ?? ''),
    storedAuthMode: auth?.storedAuthMode,
    chatgptTokensStored: auth?.chatgptTokensStored,
    apiKeyStored: auth?.apiKeyStored,
    websocketHandshakeStatus: handshakeCheck === undefined ? undefined : String(handshakeCheck.status),
  };
  if (auth === undefined) {
    // A FAILED credentials check with no stored mode is the tool saying there is no session. Anything
    // else without a stored mode is a shape this engine does not recognise, and is not guessed at.
    const noSession = credentials.status === 'fail';
    return {
      probeSucceeded: noSession,
      probeFailure: noSession ? undefined : `${printed} reported \`auth.credentials\` without a stored auth mode`,
      signedIn: noSession ? false : undefined,
      sessionUsable: noSession ? false : undefined,
      sessionUsableReason: noSession ? `the Codex CLI reports no stored credentials (${String(credentials.summary ?? 'no summary')})`
        : undefined,
      transportHandshake,
      raw,
    };
  }
  const subscription = codexSubscriptionUsable(auth);
  return {
    probeSucceeded: true,
    signedIn: auth.chatgptTokensStored || auth.apiKeyStored,
    authMethod: auth.storedAuthMode,
    sessionUsable: subscription.usable,
    sessionUsableReason: subscription.reason,
    transportHandshake,
    raw,
  };
}

/**
 * The preflight a DRY RUN reports for a probe it will not run.
 *
 * `codex doctor --json` opens an authenticated transport handshake, and a dry run contacts nothing —
 * the rule `cernum workspace --dry-run` already keeps. So a Codex dry run names the probe, says when it
 * will run, and claims nothing about the session. The live run runs it before the first request.
 */
export function deferredProviderSessionStatus(provider: ProviderID): ProviderSessionStatus | undefined {
  const probe = NON_MODEL_SESSION_PROBES[provider];
  if (provider !== 'codexCLI' || probe === undefined) return undefined;
  assertNonModelProbe(probe);
  return {
    provider,
    probe: `${probe.executableName} ${probe.args.join(' ')}`,
    probePurpose: probe.purpose,
    probeSucceeded: false,
    probeFailure: 'DEFERRED — a dry run contacts nothing, and this probe opens an authenticated transport handshake. It '
      + 'runs before the first request of the live matrix, which is refused if it finds no usable ChatGPT session.',
    deferredToLiveRun: true,
    remainingAllowance: unavailableQuantity(CODEX_NO_ALLOWANCE_FIGURE),
    throttleState: 'notReported',
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
  // A SESSION THAT EXISTS AND MUST NOT BE USED: an API-key Codex login bills a card per token, and this
  // matrix records every run as subscription-included. A fact from the tool's own report, not a guess.
  if (status.probeSucceeded && status.signedIn !== false && status.sessionUsable === false) {
    return `${status.provider} is signed in, but not with a session this matrix may bill as subscription-included `
      + `(${status.probe}): ${status.sessionUsableReason ?? 'no reason given'}`;
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
  if (status.deferredToLiveRun === true) {
    lines.push(`  NOT YET RUN   ${status.probeFailure ?? 'deferred to the live run'}`);
  } else if (!status.probeSucceeded) {
    lines.push(`  UNANSWERED    ${status.probeFailure ?? 'the probe produced no answer'}`);
  } else {
    lines.push(`  signed in     ${status.signedIn === undefined ? 'not reported' : status.signedIn ? 'yes' : 'NO'}`
      + `${status.authMethod === undefined ? '' : ` · ${status.authMethod}`}`
      + `${status.subscriptionType === undefined ? '' : ` · plan ${status.subscriptionType}`}`);
  }
  if (status.sessionUsable !== undefined) {
    lines.push(`  usable        ${status.sessionUsable ? 'yes — ChatGPT subscription session' : 'NO'}`
      + `${status.sessionUsableReason === undefined ? '' : ` — ${status.sessionUsableReason}`}`);
  }
  if (status.transportHandshake !== undefined) {
    lines.push(`  handshake     ${status.transportHandshake} (the tool's own words; NOT proof a model request would be served)`);
  }
  if (status.environmentWithheld !== undefined) {
    lines.push(`  env withheld  ${status.environmentWithheld.length === 0 ? 'none present'
      : status.environmentWithheld.join(', ')} (OPENAI_*/CODEX_* never reach the probe or any Codex run)`);
  }
  lines.push(`  throttled now ${status.throttleState === 'notReported'
    ? 'NOT REPORTED — this tool exposes no throttle state to a non-model command'
    : status.throttleState}`);
  lines.push('  allowance     NOT KNOWN — and not "plenty".');
  lines.push(`                ${status.remainingAllowance.note ?? ''}`);
  return lines;
}
