// Benchmark engine · driving the installed `codex` CLI against a disposable workspace.
//
// THE SECOND PROVIDER ON THE AGENTIC SIDE, AND THE FIRST ONE THAT CANNOT NAME ITS MODEL. Everything
// below was read off the CLI installed on this machine — `codex --version` reports 0.155.0 — through
// `codex exec --help`, `codex features list`, the schema the binary generates for itself
// (`codex app-server generate-json-schema`), `codex sandbox` (which loads and validates a full
// configuration and then runs a LOCAL command), `codex debug prompt-input` (which renders the
// model-visible prompt LOCALLY), and `codex exec` itself pointed at a loopback fake of the Responses
// endpoint, so that the real binary produced the real event stream without a single request leaving
// this machine. Nothing here is carried over from memory, and nothing was established by spending
// allowance. Where the tool's behaviour could not be established that way, this file RECORDS THE GAP.
//
// WHAT THE INVOCATION IS, AND WHY EACH PART OF IT IS THERE
//
//   exec --json --color never
//       Non-interactive, machine-readable JSONL on stdout, no ANSI. The instruction goes on STDIN,
//       which `codex exec` reads when no prompt argument is given ("Reading prompt from stdin...").
//   -C <workspace>
//       The working root. The environment context the model is shown names exactly this directory,
//       and the permission profile below makes it the only writable tree besides TMPDIR.
//   --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
//       No repository requirement, no session written to disk, the operator's `config.toml` ignored
//       (plugins, MCP servers, marketplaces, feature overrides, project trust), no execpolicy rules.
//       AUTH IS UNAFFECTED: `--ignore-user-config` is documented as "auth still uses CODEX_HOME".
//   -c forced_login_method="chatgpt"
//       THE BILLING GUARD, enforced by the CLI itself. The key and its enum (`chatgpt | api`) are in
//       the binary's own schema, and its effect is observable for free: `codex login status` under
//       `forced_login_method="api"` answers `Not logged in` on this machine's ChatGPT session. A run
//       recorded as subscription-included therefore cannot be carried by an API key, whatever the
//       environment holds.
//   -c approval_policy="never"
//       Nothing can block on a human. Observed in the rendered prompt: "Approval policy is currently
//       never ... commands will be rejected" — an escalation is REFUSED, never granted. This is the
//       opposite of `--dangerously-bypass-approvals-and-sandbox`, which is never sent.
//   -c default_permissions="cernum_workspace" + -c permissions.cernum_workspace.*
//       THE SANDBOX, and the strongest one this CLI offers. A permission profile extending the built-in
//       `:workspace` profile, enforced by macOS Seatbelt on every model-generated command and patch.
//       Proven locally with `codex sandbox -P` and again through `codex exec` against the fake:
//         · writes are confined to the workspace and the runner's disposable TMPDIR;
//         · `/tmp` is read-only (`":slash_tmp" = "read"`), so a stray write cannot land there;
//         · the HOME directory is UNREADABLE (`"<home>" = "none"`), including `~/.codex/auth.json` —
//           `cat ~/.codex/auth.json` from a model command answered `Operation not permitted`;
//         · the CLI's own install tree is re-allowed read-only, because the CLI re-executes its own
//           binary through the sandbox helper to load AGENTS.md — denying it failed the session with
//           `sandbox-exec: execvp() of '…/codex' failed: Operation not permitted`;
//         · network access from commands is denied (DNS resolution fails inside the sandbox);
//         · a patch aimed outside the workspace is REJECTED ("patch rejected: writing outside of the
//           project") — and that rejection is reported on STDERR ONLY, never in the JSONL stream.
//       `-s` is deliberately NOT sent beside it: the profile derives `workspace-write`, and if the
//       profile were ever ignored the CLI's exec default is `read-only` — the safe direction, which
//       fails the task rather than widening the sandbox.
//   -c skills.include_instructions=false
//       Removes the `<skills_instructions>` block the CLI otherwise injects from
//       `~/.codex/skills/.system` even with `--ignore-user-config`. Effect observed locally.
//   -c tools.web_search=false  -c web_search="disabled"
//       Both documented web-search keys. See CODEX_TOOL_SURFACE_IS_NOT_CLOSED: a validly set switch
//       has been observed not to hold before, so a web search is DETECTED and fails the attempt.
//   --disable <feature> ...
//       Feature names are VALIDATED by the CLI ("Unknown feature flag: …"), so every one below is real.
//       Browser, computer use, image generation, apps, plugins, hooks, memories, both multi-agent
//       generations, the shell snapshot (which runs the operator's own login shell to capture their
//       aliases and functions), the sleep tool, and unbounded connection retries — which, left on,
//       make a network failure retry FOREVER ("Reconnecting... waiting for network"), so that a
//       provider outage would read as a Cernum timeout rather than as the transport failure it is.
//   -m <requestedModelID>  -c model_reasoning_effort="<effort>"
//       What was frozen. The effort key is observed on the wire: the request body carried
//       `reasoning: { effort: "medium" }` under `model_reasoning_effort="medium"`. There is no
//       fallback-model switch on `codex exec`, and none is sent.
//
// WHY `-c` IS HANDLED WITH MORE CARE THAN `--disable`. The CLI SILENTLY ACCEPTS AN UNKNOWN `-c` KEY —
// `-c skills.cernum_bogus_key=false` raised no error — whereas an unknown feature name is refused. So
// every `-c` key above is one whose EFFECT was observed locally or which the binary's own schema
// declares; a key that merely parsed would prove nothing. And because a CLI upgrade could rename one
// of them without a word, this driver REFUSES to run under a CLI version other than the one it was
// verified against. See `CODEX_CLI_VERSION_VERIFIED_AGAINST`.
//
// WHAT THIS DRIVER OBSERVES, AND WHAT IT ONLY HEARS
//
// Every event this file emits is `agentReported`, exactly as on the Claude side and for the same
// reason: a `command_execution` item is the tool saying it ran a command, and a `file_change` item is
// the tool saying it changed a file. The engine's own observations — the tree diff, the verification
// runs, the baseline check — are made in `workspace-execution.ts` by code that never sees this stream.
//
// WHERE THE STREAM DOES NOT ANSWER, NOTHING IS INVENTED. Codex has no file-READ tool: it reads by
// running `cat`, `sed`, `rg` through the shell, so no `fileRead` event is ever emitted — deriving one
// from a command string would be guessing at which file a program opened. A `file_change` item names
// paths and a kind but no content, so a `fileWrite` carries no byte count. A command's exit status
// belongs to the whole shell string, so it is attached to a parsed executable only when the string
// contained exactly one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Text } from './canonical';
import { CLIResult, CLIRunOptions, findExecutable, runCLI } from './cli-process';
import {
  CODEX_SERVICE_EFFORT_LEVELS, CODEX_TOOL_SURFACE_IS_NOT_CLOSED, CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT,
  CodexAuthStatus, codexSubscriptionUsable, parseCodexDoctorAuth, unwrapCodexError,
} from './codex-cli';
import { OTLPTurnObservation, OTLPTurnSource, codexOTLPConfigArgument } from './otlp-observer';
import { EffortLevel, ProviderID } from './provider';
import { redactSecrets } from './redaction';
import { verifyProviderIdentity } from './verification';
import { NetworkPolicy, ToolPolicy } from './workspace-case';
import { commandInvocations, shellWords } from './workspace-claude-driver';
import {
  WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, WorkspaceAgentCapabilities, WorkspaceAgentDriver,
  WorkspaceAgentFailureKind, WorkspaceAgentRequest, WorkspaceAgentResult,
} from './workspace-agent';
import { WorkspaceAgentUsage } from './workspace-host';
import { EventProvenance, TranscriptEvent, TranscriptEventKind } from './workspace-transcript';

export const CODEX_WORKSPACE_DRIVER_ID = 'driver.codex-cli.workspace';

/**
 * The installed CLI these arguments were read from, and the ONLY version this driver will drive.
 *
 * Stricter than the Claude driver, deliberately. `claude` refuses an unknown flag; `codex -c` accepts
 * an unknown key silently. A future release that renamed `skills.include_instructions` or the
 * permission-profile grammar would keep this driver running with part of its isolation quietly gone,
 * and nothing in the output would say so. Re-verifying against a new version is a deliberate act: run
 * the local probes this header lists, then change this constant.
 */
export const CODEX_CLI_VERSION_VERIFIED_AGAINST = '0.155.0';

/** The permission profile's name. Arbitrary, but fixed, so the recorded argv is comparable across runs. */
export const CODEX_WORKSPACE_PERMISSION_PROFILE = 'cernum_workspace';

/**
 * Every feature this driver switches off, in the CLI's own vocabulary. Each name is validated by the
 * CLI itself — an unknown one is refused with `Unknown feature flag` — so none of them is a guess.
 *
 * `shell_tool`, `unified_exec` and `code_mode_host` are deliberately NOT here: they are how the agent
 * runs the tests and edits the tree, which is the task.
 */
export const CODEX_WORKSPACE_DISABLED_FEATURES = [
  'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'apps', 'plugins', 'hooks',
  'memories', 'multi_agent', 'multi_agent_v2', 'shell_snapshot', 'sleep_tool', 'unbounded_connection_retries',
] as const;

/** Environment names that would change WHO pays or WHERE the requests go. Never handed to the child. */
export const CODEX_ENVIRONMENT_NAMES_REFUSED = /^(OPENAI_|CODEX_)/;

export const CODEX_READS_ARE_SHELL_COMMANDS =
  'Codex has no file-read tool: it reads the tree by running commands (`cat`, `sed`, `rg`) through the shell. No '
  + '`fileRead` event is emitted for any attempt, because deriving one from a command string would be guessing at which '
  + 'files a program opened. What the agent read is therefore not recorded; what it CHANGED is, from the tree.';

export const CODEX_COMMAND_REPORTING_IS_A_WRAPPED_STRING =
  'this CLI reports a command as the shell string it ran, wrapped in its own login shell (`/bin/zsh -lc \'…\'`). '
  + 'The wrapper is removed and the executables are parsed out of the inner string conservatively, exactly as for '
  + 'Claude; an exit status is attached to a parsed executable only when the string contained exactly one, because '
  + 'the status belongs to the whole string.';

export const CODEX_HOME_IS_UNREADABLE_BUT_NOT_ABSENT =
  'the permission profile makes the HOME directory UNREADABLE to every model-generated command and patch (proven '
  + 'locally: `cat ~/.codex/auth.json` from inside the sandbox answers `Operation not permitted`), with the CLI\'s own '
  + 'install tree re-allowed read-only because the CLI re-executes itself through the sandbox helper. The CLI PROCESS '
  + 'itself is not sandboxed — it reads its session from HOME, which is why the case unlocks HOME — and the rest of the '
  + 'filesystem outside HOME stays readable, as the built-in `:workspace` profile has it.';

export const CODEX_TMPDIR_IS_WRITABLE =
  'model-generated commands may write to the workspace and to TMPDIR — which the runner points at a disposable '
  + 'directory outside the workspace — and nowhere else. `/tmp` is read-only under the profile. A write to TMPDIR is '
  + 'invisible to the tree diff, which is correct: it is scratch, not work.';

export const CODEX_NETWORK_IS_PARTLY_EXPRESSIBLE =
  'the sandbox denies network access to every model-generated COMMAND (observed: DNS resolution fails inside it). '
  + 'That is a real control, and it is not a network boundary for the AGENT: the tool\'s own connection to its '
  + 'provider is outside the sandbox by design, and a HOSTED tool such as web search runs on the provider\'s side. '
  + 'Web search is switched off by both documented keys and is DETECTED if it runs anyway. A case declaring '
  + '`networkPolicy: denied` is therefore still refused — this driver does not claim a boundary it cannot show.';

export const CODEX_OUTPUT_IS_NOT_BOUNDED =
  '`codex exec` has no output-token budget flag, so nothing caps how much allowance one attempt may consume. The '
  + 'allowance spent is real and unreported by this tool: it publishes no cost and no allowance figure at all.';

export const CODEX_DEADLINE_IS_CERNUMS =
  'the attempt deadline is enforced by Cernum — the child is started in its own process group and the group is '
  + 'signalled at the deadline. This CLI documents no per-invocation wall-clock limit of its own. Unbounded '
  + 'connection retries are switched off, so a provider outage ends the turn instead of consuming the deadline.';

/**
 * THE IDENTITY FINDING, stated once, in one wording.
 *
 * Re-audited on 0.155.0 against the prior finding that `codex exec` names no model:
 *
 *   · the exec JSONL still names none — not in `thread.started`, `turn.started`, any item, or
 *     `turn.completed`;
 *   · the OTLP telemetry's `model`/`slug` are the identifier the CLIENT SENT (unchanged from the
 *     prior audit), and no `server_model` attribute appears in any captured payload — including a
 *     loopback run in which the fake server returned a DIFFERENT model in its `openai-model` header;
 *   · BUT the CLI does read that header, and when it differs from the request it emits an
 *     `item.completed` of type `error` reading `model rerouted: <requested> -> <served> (<reason>)`.
 *     Observed against the fake: present when the header differs, ABSENT when it matches, and ABSENT
 *     when there is no header at all.
 *
 * So the stream can now prove a SUBSTITUTION, and still cannot prove an identity: silence is what a
 * matching header and a missing header both look like. A reroute is recorded with the served model as
 * the reported one, and the attempt is refused — see `CODEX_REROUTE_POISONS_THE_ATTEMPT`. Without one,
 * the reported model stays EMPTY. The requested `-m` is never copied into it.
 */
export const CODEX_IDENTITY_IS_SUBSTITUTION_DETECTABLE_ONLY =
  'codex exec names no model in its stream. It DOES report a mismatch: when the service\'s `openai-model` response '
  + 'header differs from the requested model it emits `model rerouted: <requested> -> <served>`, and that is recorded '
  + 'and refused. Its absence proves nothing — a matching header and a missing header are both silent — so the '
  + 'executing model\'s identity remains UNVERIFIABLE on this route. The requested model is never recorded as the '
  + 'reported one.';

export const CODEX_REROUTE_POISONS_THE_ATTEMPT =
  'the tool reported that the service answered with a different model from the one frozen. That is a real piece of '
  + 'work by a model this binding does not describe, and scoring it under this candidate would put one model\'s result '
  + 'under another\'s name. The attempt is refused, and the served model is recorded as the reported one.';

export const CODEX_DELEGATION_POISONS_THE_ATTEMPT =
  'the tool delegated to another agent. A delegated sub-agent need not be the model under test, so the tree this '
  + 'attempt left is not a measurement of the frozen model. Delegation is switched off by both multi-agent features; '
  + 'this is the detection that stands behind them.';

/**
 * `output_tokens` INCLUDES `reasoning_output_tokens` ON THIS TOOL — established by the live proof.
 *
 * Every Codex turn captured before 2026-09-21 reported `reasoning_output_tokens: 0`, and with a zero
 * the two readings give the same total, so the question was left open. The first live workspace run
 * (gpt-5.6-sol, medium, ws.broken-sum.mean@3) closed it. Its own telemetry reported, for the turn:
 *
 *     input 67791 · output 1413 · reasoning 117 · total 69204
 *
 * and 67791 + 1413 = 69204 exactly; adding the reasoning again would give 69321, a number the tool
 * never reported. Every per-request `response.completed` record agrees (e.g. input 8506, output 211,
 * reasoning 7, total 8717). So the reasoning tokens are a SUBSET of the output tokens, as the input
 * cache is a subset of the input — and the shared record, which sums visible output and reasoning,
 * must be handed the visible remainder, not the inclusive figure.
 *
 * `visibleOutputTokens` is therefore `output_tokens − reasoning_output_tokens`, and the raw block is
 * kept verbatim. The live proof itself was recorded under the earlier pass-through mapping; its raw
 * usage is sealed with it and recomputes to the figures above.
 */
export const CODEX_OUTPUT_TOKEN_SEMANTICS = 'reasoningIncludedInOutput';

export const CODEX_ALLOWANCE_IS_NOT_PRICED =
  'Codex reports no cost and no allowance figure. No list value is computed from an API price either: pricing these '
  + 'tokens at the requested model\'s API rate would assume the requested model answered, which is exactly what this '
  + 'route cannot establish.';

/**
 * What this driver can actually do, declared against the installed CLI rather than against intent.
 *
 * `expressesToolPolicy` IS FALSE. There is no read tool to withhold, and whether switching the shell
 * features off removes command execution from a CODE-MODE model (`tool_mode: code_mode_only` in the
 * catalogue for every current route) cannot be established without a request. A case withholding any
 * tool is refused rather than sent under a switch nobody has seen work.
 */
export const CODEX_WORKSPACE_CAPABILITIES: WorkspaceAgentCapabilities = {
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  canIterateWithinOneInvocation: true,
  reportsToolCalls: true,
  // The stream names no model. It can name a SUBSTITUTE; see CODEX_IDENTITY_IS_SUBSTITUTION_DETECTABLE_ONLY.
  reportsModelIdentity: false,
  expressesToolPolicy: false,
  expressesNetworkPolicy: false,
};

// MARK: - Arguments

export interface CodexWorkspaceArguments {
  args: string[];
  /** Frozen settings this CLI cannot express. NON-EMPTY MEANS THE REQUEST IS NOT SENT. */
  unexpressed: string[];
  /** Settings that were sent and are not enforced. Recorded on every attempt; never a refusal. */
  notEnforceable: string[];
  /** The isolation actually applied, flag by flag, for the evidence file. */
  activeIsolation: string[];
  /** The tool surface, in the tool's own words, for a preflight. Codex has no enumerable tool list. */
  toolNames: string[];
  allowedToolRules: string[];
  /** The permission profile's filesystem table, exactly as sent. */
  permissionFilesystem: Record<string, string>;
}

export interface CodexArgumentOptions {
  tools: ToolPolicy;
  networkPolicy: NetworkPolicy;
  requestedModelID: string;
  effort?: EffortLevel;
  temperatureMilli?: number;
  seed?: number;
  /** ABSOLUTE. The directory the CLI is told to work in. */
  workspaceRoot: string;
  /** Every spelling of the home directory to deny. Empty means none could be determined — refused. */
  homeDirectories: string[];
  /** Directories the CLI's own binary is reached through. Re-allowed read-only; see the header. */
  executableReadRoots: string[];
  /** A LOOPBACK collector for this invocation's telemetry, when one was asked for. */
  otlpEndpoint?: string;
}

/** A TOML basic string, for a key or value inside an inline table. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The exact argument vector, derived from the case's policy and the installed CLI's flags.
 *
 * PURE, so every assertion about what this engine sends can be made in a test with no process and no
 * request. The instruction is deliberately not in it: that goes on stdin.
 */
export function buildCodexWorkspaceArguments(options: CodexArgumentOptions): CodexWorkspaceArguments {
  const unexpressed: string[] = [];
  const notEnforceable: string[] = [];

  // THE TOOL POLICY. Every current case asks for all three with no allow-list, which is the one shape
  // this CLI can honestly be said to deliver. Anything narrower is refused rather than approximated.
  const { tools } = options;
  if (!tools.fileRead || !tools.fileWrite || !tools.commandExecution) {
    const withheld = [
      tools.fileRead ? undefined : 'file reads', tools.fileWrite ? undefined : 'file writes',
      tools.commandExecution ? undefined : 'command execution',
    ].filter((entry): entry is string => entry !== undefined);
    unexpressed.push(`this case withholds ${withheld.join(', ')}. Codex reads files by running commands and writes them `
      + 'through a patch tool and the shell, and no switch this CLI documents has been SEEN to remove one of those from a '
      + 'code-mode model without a request. Refused rather than sent under a control nobody has observed to work.');
  }
  if (tools.allowedExecutables.length > 0) {
    unexpressed.push(`the executable allow-list (${tools.allowedExecutables.join(', ')}): under approval_policy=never this `
      + 'CLI runs every command the sandbox permits, and its only rule mechanism (execpolicy `.rules`) can forbid a prefix '
      + 'but cannot express "only these". Refused rather than recorded as enforced.');
  }
  if (options.networkPolicy === 'unrestricted') {
    unexpressed.push('networkPolicy unrestricted: the permission profile denies network to every model-generated command, '
      + 'so a case that needs the network could not do its work. Refused rather than widened.');
  }

  if (options.requestedModelID.trim().length === 0) {
    unexpressed.push('no model named: this CLI would answer with whatever its catalogue marks as the default, which is '
      + 'not a model anybody froze');
  }
  if (options.effort !== undefined && options.effort !== 'none' && !CODEX_SERVICE_EFFORT_LEVELS.includes(options.effort)) {
    unexpressed.push(`effort '${options.effort}': the Codex service accepts only `
      + `${CODEX_SERVICE_EFFORT_LEVELS.filter((level) => level !== 'none').join(', ')}`
      + ((options.effort as string) === 'ultra' ? `. ${CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT}` : ''));
  }
  if (options.temperatureMilli !== undefined) {
    unexpressed.push(`temperature (${options.temperatureMilli} milli): this CLI accepts no sampling temperature`);
  }
  if (options.seed !== undefined) unexpressed.push(`seed (${options.seed}): this CLI accepts no sampling seed`);

  const homes = [...new Set(options.homeDirectories.filter((entry) => path.isAbsolute(entry)))];
  if (homes.length === 0) {
    unexpressed.push('the home directory could not be determined, so the permission profile could not deny reading it. '
      + 'Refused rather than run with the operator\'s session files readable by the model.');
  }
  // A workspace under HOME would be a workspace this profile denies. The runner makes workspaces
  // under the OS temp directory, so this is a statement about an unusual sandbox root, not a guess.
  // Only an ABSOLUTE root can be judged: a preflight renders a placeholder, and resolving that
  // against the current directory would judge wherever the command happened to be typed.
  if (path.isAbsolute(options.workspaceRoot) && homes.some((home) => isInside(options.workspaceRoot, home))) {
    unexpressed.push(`the workspace ${options.workspaceRoot} is inside the home directory, which the permission profile `
      + 'makes unreadable. Put the benchmark sandbox outside HOME (the default is under the OS temp directory).');
  }

  // THE PERMISSION PROFILE'S FILESYSTEM TABLE. Order is fixed so the argv is byte-comparable.
  const filesystem: Record<string, string> = {};
  for (const home of homes.sort()) filesystem[home] = 'none';
  for (const root of [...new Set(options.executableReadRoots)].sort()) {
    if (homes.some((home) => isInside(root, home))) filesystem[root] = 'read';
  }
  filesystem[':slash_tmp'] = 'read';
  const inlineTable = `{ ${Object.entries(filesystem).map(([key, access]) => `${tomlString(key)} = ${tomlString(access)}`).join(', ')} }`;

  const profile = CODEX_WORKSPACE_PERMISSION_PROFILE;
  const args: string[] = [
    'exec', '--json', '--color', 'never',
    '-C', options.workspaceRoot,
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'approval_policy="never"',
    '-c', `default_permissions="${profile}"`,
    '-c', `permissions.${profile}.extends=":workspace"`,
    '-c', `permissions.${profile}.filesystem=${inlineTable}`,
    '-c', 'skills.include_instructions=false',
    '-c', 'tools.web_search=false',
    '-c', 'web_search="disabled"',
  ];
  for (const feature of CODEX_WORKSPACE_DISABLED_FEATURES) args.push('--disable', feature);
  if (options.otlpEndpoint !== undefined) args.push('-c', codexOTLPConfigArgument(options.otlpEndpoint));
  if (options.requestedModelID.trim().length > 0) args.push('-m', options.requestedModelID);
  if (options.effort !== undefined && options.effort !== 'none' && CODEX_SERVICE_EFFORT_LEVELS.includes(options.effort)) {
    args.push('-c', `model_reasoning_effort="${options.effort}"`);
  }

  const activeIsolation = [
    `codex CLI arguments verified against ${CODEX_CLI_VERSION_VERIFIED_AGAINST}, and refused under any other version`,
    `-C ${options.workspaceRoot}: the disposable workspace, and no --add-dir`,
    '--skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules: no repository requirement, no session '
      + 'persisted, the operator\'s config.toml (plugins, MCP servers, marketplaces, features) and execpolicy rules ignored',
    '-c forced_login_method="chatgpt": the CLI itself refuses any authentication but the ChatGPT subscription session, '
      + 'so an API key cannot carry a run recorded as subscription-included',
    '-c approval_policy="never": an escalation is REFUSED, never granted and never escalated to a human; '
      + '--dangerously-bypass-approvals-and-sandbox is never sent',
    `permission profile ${profile} extends :workspace (macOS Seatbelt, applied to every model command and patch): writes `
      + 'confined to the workspace and TMPDIR; /tmp read-only; HOME unreadable; network denied to commands; a patch '
      + 'outside the workspace rejected',
    `filesystem table ${inlineTable}`,
    '-c skills.include_instructions=false: the bundled skills catalogue is not injected into the prompt',
    '-c tools.web_search=false and -c web_search="disabled": hosted web search off, and detected if it runs anyway',
    `--disable ${CODEX_WORKSPACE_DISABLED_FEATURES.join(', ')}`,
    'no fallback model: `codex exec` has no such switch, and a reroute reported by the tool fails the attempt',
    'the instruction is written to stdin, never to argv',
    'OPENAI_* and CODEX_* environment names are refused outright: they could redirect the requests or change who pays',
  ];
  if (options.otlpEndpoint !== undefined) {
    activeIsolation.push(`-c otel=… — telemetry exported to ${options.otlpEndpoint}, a loopback collector that makes no `
      + 'outbound connection; read for the applied reasoning effort, the authentication mode and the turn TTFT only, and '
      + 'never for identity: its `model` attribute is what the client sent');
  }

  notEnforceable.push(
    CODEX_HOME_IS_UNREADABLE_BUT_NOT_ABSENT,
    CODEX_TMPDIR_IS_WRITABLE,
    CODEX_OUTPUT_IS_NOT_BOUNDED,
    CODEX_DEADLINE_IS_CERNUMS,
    CODEX_READS_ARE_SHELL_COMMANDS,
    CODEX_COMMAND_REPORTING_IS_A_WRAPPED_STRING,
    CODEX_IDENTITY_IS_SUBSTITUTION_DETECTABLE_ONLY,
    CODEX_TOOL_SURFACE_IS_NOT_CLOSED,
  );
  if (options.networkPolicy !== 'unrestricted') notEnforceable.push(CODEX_NETWORK_IS_PARTLY_EXPRESSIBLE);
  if (options.effort === undefined || options.effort === 'none') {
    notEnforceable.push('no effort was frozen, so none is sent and the model answers at its catalogue default. The '
      + 'default is the CLI\'s to choose and is recorded only if the telemetry reports it.');
  }

  return {
    args, unexpressed, notEnforceable, activeIsolation,
    // Codex exposes no enumerable tool list for code-mode models; these are its own item kinds.
    toolNames: ['command_execution', 'file_change'],
    allowedToolRules: ['every command the permission profile permits (no allow-list is expressible)'],
    permissionFilesystem: filesystem,
  };
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The directories the CLI binary is reached through, so the profile can re-allow them read-only.
 *
 * SYMLINKS ARE FOLLOWED AT EVERY PATH COMPONENT, NOT ONLY AT THE LEAF, and the difference was found
 * the hard way. On this machine `~/.local/bin/codex` → `~/.codex/packages/standalone/current/bin/codex`,
 * and it is the DIRECTORY `current` that is the link (→ `releases/0.155.0-…`). A resolver that only
 * read the leaf re-allowed `current/bin` and never the directory holding the `current` link itself, so
 * the sandbox helper could not traverse to the binary and the session failed with `sandbox-exec:
 * execvp() … Operation not permitted` — caught by the loopback test against the real CLI, which is
 * what it exists for. Every link met contributes the directory that holds it; the resolved binary
 * contributes its own directory and its release root (two levels above `bin/codex`).
 */
export function codexExecutableReadRoots(executablePath: string,
                                         readLink: (file: string) => string | undefined = safeReadLink): string[] {
  const roots: string[] = [];
  let current = path.resolve(executablePath);
  // Bounded, so a link cycle ends in a refusal to go further rather than a hang.
  for (let hops = 0; hops < 32; hops += 1) {
    const components = current.split(path.sep).filter((component) => component.length > 0);
    let prefix = path.parse(current).root;
    let redirected: string | undefined;
    for (let index = 0; index < components.length; index += 1) {
      const next = path.join(prefix, components[index]);
      const target = readLink(next);
      if (target !== undefined) {
        roots.push(path.dirname(next));
        redirected = path.join(path.resolve(path.dirname(next), target), ...components.slice(index + 1));
        break;
      }
      prefix = next;
    }
    if (redirected === undefined) break;
    current = redirected;
  }
  roots.push(path.dirname(current));
  // The resolved binary lives at `<release>/bin/codex`; its release tree carries what it loads.
  roots.push(path.dirname(path.dirname(current)));
  return [...new Set(roots)];
}

function safeReadLink(file: string): string | undefined {
  try {
    return fs.readlinkSync(file);
  } catch {
    return undefined;
  }
}

// MARK: - The stream

/** One JSONL event, or nothing. Never throws and never guesses. */
export function parseCodexStreamLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).type === 'string'
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** One event this driver would like emitted. Always `agentReported`. */
export interface PlannedCodexEvent {
  kind: TranscriptEventKind;
  provenance: EventProvenance;
  detail: string;
  payload: Partial<TranscriptEvent>;
}

const AGENT_REPORTED: EventProvenance = 'agentReported';

/** `model rerouted: <requested> -> <served> (<reason>)`, as 0.155.0 writes it. */
const REROUTE = /^model rerouted:\s*(\S+)\s*->\s*(\S+)(?:\s*\(([^)]*)\))?/i;

export interface CodexReroute {
  requested: string;
  served: string;
  reason?: string;
}

export function readCodexReroute(message: string): CodexReroute | undefined {
  const match = REROUTE.exec(message.trim());
  if (match === null) return undefined;
  return { requested: match[1], served: match[2], reason: match[3] };
}

/**
 * The command the MODEL asked for, with the CLI's own login-shell wrapper removed.
 *
 * `/bin/zsh -lc 'node test/stats.test.js'` is the tool's wrapper around `node test/stats.test.js`.
 * Only that exact shape is unwrapped — a shell, `-c` or `-lc`, one argument — and anything else is
 * returned unchanged rather than half-parsed.
 */
export function unwrapCodexShellCommand(command: string): string {
  const words = shellWords(command);
  if (words.length === 3 && /(^|\/)(?:ba|z|da|k)?sh$/.test(words[0]) && /^-l?c$/.test(words[1])) return words[2];
  return command;
}

/** What the stream said, folded, beside the events it produced. */
export interface CodexStreamState {
  threadID?: string;
  finalMessage?: string;
  usage?: Record<string, unknown>;
  turnFailed?: { message: string; status?: number };
  /** Top-level `error` events and `error` items. Tool notes, not model output; kept for failure detail. */
  notes: string[];
  reroutes: CodexReroute[];
  /** Item kinds the envelope was meant to make impossible. Any entry fails the attempt. */
  contamination: string[];
  delegated: boolean;
  /** Items started and never completed — a command killed at the deadline, for instance. */
  pending: Map<string, Record<string, unknown>>;
  /** When the first MODEL-PRODUCED item arrived, on this process's clock. */
  firstItemMilliseconds?: number;
}

export function newCodexStreamState(): CodexStreamState {
  return { notes: [], reroutes: [], contamination: [], delegated: false, pending: new Map() };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Translate one JSONL event into transcript events, updating the folded state as it goes.
 *
 * EVERY EVENT THIS RETURNS IS `agentReported`, by construction: there is no branch that produces
 * another provenance. The final answer is NOT emitted here as `finalResponse` — `runOneAttempt` emits
 * the one `finalResponse` from `WorkspaceAgentResult.finalMessage`, so an answer of record is written
 * down in exactly one place.
 */
export function eventsFromCodexEvent(event: Record<string, unknown>, state: CodexStreamState,
                                     atMilliseconds?: number): PlannedCodexEvent[] {
  const events: PlannedCodexEvent[] = [];
  const type = event.type;

  if (type === 'thread.started') {
    if (typeof event.thread_id === 'string') state.threadID = event.thread_id;
    return events;
  }
  if (type === 'turn.completed') {
    if (typeof event.usage === 'object' && event.usage !== null) state.usage = event.usage as Record<string, unknown>;
    return events;
  }
  if (type === 'turn.failed') {
    const raw = textOf((event.error as Record<string, unknown> | undefined)?.message);
    const unwrapped = unwrapCodexError(raw);
    state.turnFailed = { message: unwrapped.message ?? raw, status: unwrapped.status };
    return events;
  }
  if (type === 'error') {
    const message = textOf(event.message);
    if (message.length > 0) state.notes.push(message);
    return events;
  }
  if (type !== 'item.started' && type !== 'item.completed') return events;

  const item = (typeof event.item === 'object' && event.item !== null ? event.item : {}) as Record<string, unknown>;
  const itemType = textOf(item.type);
  const itemID = typeof item.id === 'string' ? item.id : undefined;

  if (itemType === 'error') {
    const message = textOf(item.message);
    const reroute = readCodexReroute(message);
    if (reroute !== undefined) state.reroutes.push(reroute);
    else if (message.length > 0) state.notes.push(message);
    return events;
  }

  // The first item the MODEL produced. `thread.started` and `turn.started` arrive the moment the CLI
  // starts, before anything is asked of anyone; timing from them would be timing the CLI's start-up.
  if (state.firstItemMilliseconds === undefined && atMilliseconds !== undefined) {
    state.firstItemMilliseconds = atMilliseconds;
  }

  if (itemType === 'agent_message' || itemType === 'reasoning') {
    if (type !== 'item.completed') return events;
    const text = textOf(item.text);
    if (itemType === 'agent_message' && text.length > 0) state.finalMessage = text;
    if (text.length === 0) return events;
    events.push({
      kind: 'message', provenance: AGENT_REPORTED, detail: text,
      payload: {
        channel: itemType === 'reasoning' ? 'thinking' : 'visible',
        textDigest: sha256Text(text),
        textByteCount: Buffer.byteLength(text, 'utf8'),
      },
    });
    return events;
  }

  if (itemType === 'command_execution') {
    const command = textOf(item.command);
    const inner = unwrapCodexShellCommand(command);
    if (type === 'item.started') {
      if (itemID !== undefined) state.pending.set(itemID, item);
      events.push({
        kind: 'toolCall', provenance: AGENT_REPORTED, detail: `command_execution ${inner}`.trim(),
        payload: { toolName: 'command_execution', callID: itemID, argumentsDigest: sha256Text(command) },
      });
      return events;
    }
    if (itemID !== undefined) state.pending.delete(itemID);
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    events.push(...commandEvents(inner, itemID, exitCode));
    const output = textOf(item.aggregated_output);
    events.push({
      kind: 'toolResult', provenance: AGENT_REPORTED,
      detail: output.length === 0 ? `the tool reported ${textOf(item.status) || 'a result'} with no output` : output,
      payload: {
        callID: itemID, ok: item.status === 'completed' && (exitCode === undefined || exitCode === 0),
        exitCode, byteCount: Buffer.byteLength(output, 'utf8'),
      },
    });
    return events;
  }

  if (itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change) => (typeof change === 'object' && change !== null ? change as Record<string, unknown> : {}))
      .filter((change) => typeof change.path === 'string');
    if (type === 'item.started') {
      if (itemID !== undefined) state.pending.set(itemID, item);
      events.push({
        kind: 'toolCall', provenance: AGENT_REPORTED,
        detail: `file_change ${paths.map((change) => change.path as string).join(', ')}`.trim(),
        payload: { toolName: 'file_change', callID: itemID, argumentsDigest: sha256Text(JSON.stringify(changes)) },
      });
      return events;
    }
    if (itemID !== undefined) state.pending.delete(itemID);
    const applied = item.status === 'completed';
    // A FAILED patch claims no write. What it may have half-done is in the tree, which is the authority.
    if (applied) {
      for (const change of paths) {
        events.push({
          kind: 'fileWrite', provenance: AGENT_REPORTED,
          detail: `the tool reported a ${textOf(change.kind) || 'change'} of ${change.path as string}`,
          payload: { path: change.path as string, toolName: 'file_change', callID: itemID },
        });
      }
    }
    events.push({
      kind: 'toolResult', provenance: AGENT_REPORTED,
      detail: `the tool reported the patch as ${textOf(item.status) || 'finished'}`,
      payload: { callID: itemID, ok: applied, byteCount: 0 },
    });
    return events;
  }

  if (itemType === 'todo_list') return events;

  // ANYTHING ELSE IS A TOOL THE ENVELOPE WAS MEANT TO WITHHOLD: web search, an MCP call, image
  // generation, a collaboration call. Recorded as a tool call so the transcript shows it, and folded
  // into the state so the attempt fails.
  if (type === 'item.started' && itemID !== undefined) state.pending.set(itemID, item);
  if (type === 'item.completed') {
    if (itemID !== undefined) state.pending.delete(itemID);
    if (itemType === 'collab_tool_call') state.delegated = true;
    else if (itemType.length > 0) state.contamination.push(itemType);
    events.push({
      kind: 'toolCall', provenance: AGENT_REPORTED, detail: `${itemType || 'unknown'} (withheld by the envelope)`,
      payload: { toolName: itemType || 'unknown', callID: itemID, argumentsDigest: sha256Text(JSON.stringify(item)) },
    });
  }
  return events;
}

/** One `commandExecuted` per visibly-named executable; an exit status only where it is unambiguous. */
function commandEvents(command: string, callID: string | undefined, exitCode: number | undefined): PlannedCodexEvent[] {
  const invocations = commandInvocations(command);
  return invocations.map((invocation) => ({
    kind: 'commandExecuted' as TranscriptEventKind,
    provenance: AGENT_REPORTED,
    detail: `${invocation.executable} ${invocation.argv.join(' ')}`.trim(),
    payload: {
      executable: invocation.executable, argv: invocation.argv, callID,
      // The status belongs to the whole string. Attached only when the string named one executable.
      exitCode: invocations.length === 1 ? exitCode : undefined,
    },
  }));
}

/** Items the stream started and never finished, as events. A command killed at the deadline is one. */
export function eventsForUnfinishedItems(state: CodexStreamState): PlannedCodexEvent[] {
  const events: PlannedCodexEvent[] = [];
  for (const [itemID, item] of state.pending) {
    if (item.type === 'command_execution') {
      events.push(...commandEvents(unwrapCodexShellCommand(textOf(item.command)), itemID, undefined));
    }
  }
  state.pending.clear();
  return events;
}

// MARK: - Usage

/**
 * The usage block, mapped explicitly onto the shared names.
 *
 * CODEX'S `input_tokens` IS THE TOTAL and `cached_input_tokens` is a SUBSET of it — the opposite of
 * Claude's convention, established in `readCodexUsage` from real fixtures. So `inputTokens` here is
 * the reported total unchanged, and the fresh remainder is derived. `turn.completed` reports the
 * WHOLE TURN — every model request the agent loop made — which is exactly one attempt.
 */
export function codexWorkspaceUsage(state: CodexStreamState, extra: {
  otlp?: OTLPTurnObservation;
  reportedModelID: string;
  requestedModelID: string;
}): WorkspaceAgentUsage | undefined {
  const usage = state.usage;
  if (usage === undefined && extra.otlp === undefined) return undefined;
  const count = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);
  const total = count(usage?.input_tokens);
  const cached = count(usage?.cached_input_tokens);
  const cacheWrite = count(usage?.cache_write_input_tokens);
  const output = count(usage?.output_tokens);
  const reasoningTokens = count(usage?.reasoning_output_tokens);
  const identity = extra.reportedModelID.length === 0 ? undefined
    : verifyProviderIdentity(extra.requestedModelID, extra.reportedModelID);
  return {
    inputTokens: total,
    freshInputTokens: total === undefined ? undefined : Math.max(0, total - (cached ?? 0) - (cacheWrite ?? 0)),
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cached,
    // The inclusive output minus its reasoning subset: see CODEX_OUTPUT_TOKEN_SEMANTICS.
    visibleOutputTokens: output === undefined ? undefined : Math.max(0, output - (reasoningTokens ?? 0)),
    reasoningTokens,
    outputTokenSemantics: CODEX_OUTPUT_TOKEN_SEMANTICS,
    observedFirstOutputMilliseconds: state.firstItemMilliseconds,
    providerReportedTimeToFirstTokenMilliseconds: extra.otlp?.turnTTFTMilliseconds,
    identityState: identity?.state ?? 'unverifiable',
    participantIDs: extra.reportedModelID.length === 0 ? [] : [extra.reportedModelID],
    terminalReason: state.turnFailed !== undefined ? 'turn.failed' : usage !== undefined ? 'turn.completed' : undefined,
    apiErrorStatus: state.turnFailed?.status,
    // THE TOOL'S OWN ACCOUNT OF ITSELF, from its telemetry, when a collector was attached. Beside the
    // request, never instead of it; and never identity.
    providerReportedEffort: extra.otlp?.turnReasoningEffort,
    providerReportedAuthMode: extra.otlp?.authMode,
    providerReportedSandboxPolicy: extra.otlp?.sandboxPolicy,
    providerReportedApprovalPolicy: extra.otlp?.approvalPolicy,
    otlpCorrelationKey: extra.otlp?.correlationKey,
    otlpTotalTokens: extra.otlp?.totalTokens,
    rawUsage: (usage ?? null) as WorkspaceAgentUsage['rawUsage'],
  };
}

// MARK: - The driver

export interface CodexPreflight {
  version?: string;
  auth?: CodexAuthStatus;
}

export interface CodexWorkspaceDriverOptions {
  /** What Cernum will ASK for, taken from the frozen binding. Never chosen here. */
  requestedModelID: string;
  effort?: EffortLevel;
  /** Resolved once, so a PATH change mid-run cannot swap the tool underneath it. */
  executablePath?: string;
  findExecutable?: (name: string) => string | undefined;
  /** Injected by the tests, so every branch below is reachable without a provider request. */
  run?: (options: CLIRunOptions) => Promise<CLIResult>;
  /**
   * The version and authentication probes, injected by the tests. In life both are local commands —
   * `codex --version` and `codex doctor --json` — that send no model request.
   */
  preflight?: (environment: Record<string, string>) => Promise<CodexPreflight>;
  /** A loopback OTLP collector, when the operator asked for one. Never required. */
  otlp?: OTLPTurnSource;
  /** Where the home directory is, for the permission profile. Injected by the tests. */
  homeDirectory?: () => string;
  readLink?: (file: string) => string | undefined;
}

export class CodexWorkspaceDriver implements WorkspaceAgentDriver {
  readonly driverID = CODEX_WORKSPACE_DRIVER_ID;

  readonly provider: ProviderID = 'codexCLI';

  readonly capabilities = CODEX_WORKSPACE_CAPABILITIES;

  readonly executablePath?: string;

  /** What `argv[0]` is called in a preflight, and what version the flags were verified against. */
  readonly commandName = 'codex';

  readonly cliVersionVerifiedAgainst = CODEX_CLI_VERSION_VERIFIED_AGAINST;

  private readonly runCLIProcess: (options: CLIRunOptions) => Promise<CLIResult>;

  private preflightResult?: Promise<CodexPreflight>;

  constructor(private readonly options: CodexWorkspaceDriverOptions) {
    const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
    this.executablePath = options.executablePath ?? locate('codex');
    this.runCLIProcess = options.run ?? runCLI;
  }

  private homeDirectories(environment: Record<string, string>): string[] {
    const homes = [(this.options.homeDirectory ?? os.homedir)()];
    if (environment.HOME !== undefined) homes.push(environment.HOME);
    const resolved: string[] = [];
    for (const home of homes) {
      if (!path.isAbsolute(home)) continue;
      resolved.push(home);
      try { resolved.push(fs.realpathSync(home)); } catch { /* the spelling given is still denied */ }
    }
    return [...new Set(resolved)];
  }

  /** The argument vector this driver would send. For a preflight; no side effects. */
  argumentsFor(tools: ToolPolicy, networkPolicy: NetworkPolicy,
               sampling: { temperatureMilli?: number; seed?: number } = {},
               workspaceRoot = '<workspace>', environment: Record<string, string> = {}): CodexWorkspaceArguments {
    return buildCodexWorkspaceArguments({
      tools,
      networkPolicy,
      requestedModelID: this.options.requestedModelID,
      effort: this.options.effort,
      temperatureMilli: sampling.temperatureMilli,
      seed: sampling.seed,
      workspaceRoot,
      homeDirectories: this.homeDirectories(environment),
      executableReadRoots: this.executablePath === undefined ? []
        : codexExecutableReadRoots(this.executablePath, this.options.readLink),
      otlpEndpoint: this.options.otlp?.endpoint,
    });
  }

  /** `codex --version` and `codex doctor --json`, once per driver, under the attempt's environment. */
  private async preflight(environment: Record<string, string>): Promise<CodexPreflight> {
    if (this.options.preflight !== undefined) return this.options.preflight(environment);
    const executable = this.executablePath as string;
    const version = await this.runCLIProcess({
      executable, args: ['--version'], timeoutMilliseconds: 15_000, replaceEnvironment: environment,
    });
    const doctor = await this.runCLIProcess({
      executable, args: ['doctor', '--json'], timeoutMilliseconds: 60_000, replaceEnvironment: environment,
    });
    const match = /codex-cli\s+(\S+)/.exec(version.stdout);
    return { version: match?.[1], auth: parseCodexDoctorAuth(doctor.stdout) };
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const events = () => request.transcript.build().events.slice(before);

    const plan = this.argumentsFor(request.tools, request.networkPolicy, {
      temperatureMilli: request.temperatureMilli, seed: request.seed,
    }, request.workspaceRoot, request.environment);

    const refuse = (kind: WorkspaceAgentFailureKind, detail: string): WorkspaceAgentResult => ({
      completed: false,
      failure: { kind, detail },
      reportedModelID: '',
      unexpressed: plan.unexpressed,
      notEnforceable: plan.notEnforceable,
      activeIsolation: [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      events: events(),
    });

    if (!this.executablePath) {
      return refuse('notInstalled',
        'the `codex` command is not on this machine\'s PATH. Cernum drives the official CLI you installed and '
        + 'authenticated yourself; it does not install one and does not reach the service any other way.');
    }
    if (plan.unexpressed.length > 0) {
      return refuse('policyNotExpressible',
        `this case froze settings the codex CLI cannot express, so nothing was sent: ${plan.unexpressed.join('; ')}`);
    }
    const refusedNames = Object.keys(request.environment).filter((name) => CODEX_ENVIRONMENT_NAMES_REFUSED.test(name));
    if (refusedNames.length > 0) {
      return refuse('policyNotExpressible',
        `the attempt's environment carries ${refusedNames.join(', ')}. Every OPENAI_* and CODEX_* name can redirect this `
        + 'CLI\'s requests, its configuration home or its credential, and so change who pays; nothing was sent.');
    }

    // THE PREFLIGHT, BEFORE ANY REQUEST: the version the flags were verified against, and a
    // subscription session. Both are local commands; neither reaches a model.
    this.preflightResult = this.preflightResult ?? this.preflight(request.environment);
    let preflight: CodexPreflight;
    try {
      preflight = await this.preflightResult;
    } catch (error) {
      return refuse('spawnFailure', `the codex preflight could not run: ${redactSecrets(String(error))}`);
    }
    if (preflight.version !== CODEX_CLI_VERSION_VERIFIED_AGAINST) {
      return refuse('policyNotExpressible',
        `the installed codex reports version ${preflight.version ?? '(unreadable)'}, and this driver's isolation was `
        + `verified against ${CODEX_CLI_VERSION_VERIFIED_AGAINST}. This CLI accepts an unknown -c key without a word, so `
        + 'running a different version could silently drop part of the sandbox. Re-verify the flags against it first.');
    }
    const subscription = codexSubscriptionUsable(preflight.auth);
    if (!subscription.usable) return refuse('notAuthenticated', subscription.reason);

    const state = newCodexStreamState();
    let pending = '';
    const ingest = (line: string, at?: number): void => {
      const message = parseCodexStreamLine(line);
      if (message === undefined) return;
      for (const planned of eventsFromCodexEvent(message, state, at)) {
        request.transcript.emit(planned.kind, planned.provenance, request.attemptIndex, planned.detail, planned.payload);
      }
    };

    const result = await this.runCLIProcess({
      executable: this.executablePath,
      args: plan.args,
      // STDIN, NEVER ARGV.
      input: request.instruction,
      timeoutMilliseconds: request.timeoutMilliseconds,
      workingDirectory: request.workspaceRoot,
      // THE WHOLE ENVIRONMENT, REPLACED, and nothing added to it.
      replaceEnvironment: request.environment,
      shouldCancel: request.shouldCancel,
      onChunk: (chunk, at) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          ingest(pending.slice(0, newline), at);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      },
    });
    if (pending.trim().length > 0) ingest(pending);
    // A transport that handed over everything at exit must fold the same state as one that streamed.
    if (state.threadID === undefined && state.usage === undefined && state.turnFailed === undefined
        && state.finalMessage === undefined && result.stdout.trim().length > 0) {
      for (const line of result.stdout.split('\n')) ingest(line);
    }
    for (const planned of eventsForUnfinishedItems(state)) {
      request.transcript.emit(planned.kind, planned.provenance, request.attemptIndex, planned.detail, planned.payload);
    }

    const otlp = this.options.otlp === undefined || state.threadID === undefined
      ? undefined : await this.options.otlp.observe(state.threadID);

    // A REROUTE IS THE ONE THING THE STREAM CAN SAY ABOUT WHO ANSWERED, and it says it only when the
    // answer is "somebody else". The served model is then the reported one; otherwise nothing is.
    const reroute = state.reroutes[state.reroutes.length - 1];
    const reportedModelID = reroute?.served ?? '';
    const usage = codexWorkspaceUsage(state, {
      otlp, reportedModelID, requestedModelID: this.options.requestedModelID,
    });

    const isolation = [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX,
      `the CLI passed the preflight as version ${preflight.version} with ${subscription.reason}`];
    if (otlp !== undefined) {
      isolation.push(`the CLI's telemetry reported: effort ${otlp.turnReasoningEffort ?? '(not yet received)'} · auth mode `
        + `${otlp.authMode ?? '(not yet received)'} · sandbox ${otlp.sandboxPolicy ?? '(not yet received)'} · approval `
        + `${otlp.approvalPolicy ?? '(not yet received)'}. Its own account of itself, recorded beside what Cernum asked for.`);
    }

    const finish = (kind: WorkspaceAgentFailureKind | undefined, detail: string): WorkspaceAgentResult => ({
      completed: kind === undefined,
      finalMessage: state.finalMessage,
      failure: kind === undefined ? undefined : { kind, detail },
      reportedModelID,
      unexpressed: plan.unexpressed,
      notEnforceable: plan.notEnforceable,
      activeIsolation: isolation,
      elapsedMilliseconds: result.elapsedMilliseconds,
      usage,
      events: events(),
    });

    // 1. THE DEADLINE AND THE CANCELLATION COME FIRST: neither produced a finished turn.
    if (result.failure?.kind === 'timeout') {
      return finish('timeout', `the attempt's ${request.timeoutMilliseconds} ms deadline passed with the tool still `
        + `working. ${CODEX_DEADLINE_IS_CERNUMS} Everything it had reported up to that moment is in the transcript.`);
    }
    if (result.failure?.kind === 'cancelled') return finish('cancelled', 'the run was paused or aborted before this attempt finished');
    if (result.failure?.kind === 'notInstalled' || result.failure?.kind === 'spawnFailure') {
      return finish(result.failure.kind, redactSecrets(result.failure.detail));
    }

    // 2. A REROUTE OR A DELEGATION MAKES THE WORK REAL AND THE BINDING FALSE. Checked before the
    //    turn's own verdict, because a turn that "succeeded" through a substitute did not succeed as
    //    this candidate.
    if (reroute !== undefined) {
      const verdict = verifyProviderIdentity(this.options.requestedModelID, reroute.served);
      if (verdict.state === 'substituted') {
        return finish('policyNotExpressible', `${CODEX_REROUTE_POISONS_THE_ATTEMPT} The tool reported: `
          + `${reroute.requested} -> ${reroute.served}${reroute.reason === undefined ? '' : ` (${reroute.reason})`}.`);
      }
    }
    if (state.delegated) return finish('policyNotExpressible', CODEX_DELEGATION_POISONS_THE_ATTEMPT);
    if (state.contamination.length > 0) {
      return finish('policyNotExpressible', `the tool invoked ${[...new Set(state.contamination)].join(', ')}, which the `
        + `isolation envelope withholds. ${CODEX_TOOL_SURFACE_IS_NOT_CLOSED}`);
    }

    // 3. THE TURN'S OWN VERDICT, before the exit code: `codex exec` exits non-zero on a failed turn AND
    //    prints the `turn.failed` event that says why.
    const context = [state.turnFailed?.message, ...state.notes].filter((line): line is string => !!line).join(' · ');
    if (state.turnFailed !== undefined) {
      const status = state.turnFailed.status;
      const kind: WorkspaceAgentFailureKind = status === 401 || isUnauthenticated(context) ? 'notAuthenticated'
        : status === 429 || isRateLimited(context) ? 'rateLimited'
          : 'transport';
      return finish(kind, `the CLI reported a failed turn${status === undefined ? '' : ` (HTTP ${status})`}: `
        + `${redactSecrets(context).slice(0, 500)}`);
    }

    if (result.failure) {
      const both = `${context}\n${result.stderr}`;
      const kind: WorkspaceAgentFailureKind = isUnauthenticated(both) ? 'notAuthenticated'
        : isRateLimited(both) ? 'rateLimited' : 'exitFailure';
      return finish(kind, `${redactSecrets(result.failure.detail)}`
        + `${both.trim() ? ` — ${redactSecrets(both.trim()).slice(0, 500)}` : ''}`);
    }

    if (state.usage === undefined) {
      return finish('malformedOutput',
        'the CLI exited successfully and its stream contains no `turn.completed` event, so nothing here can say that the '
        + 'turn finished or what it consumed. Cernum refuses to scrape an unrecognised format.');
    }

    return finish(undefined, '');
  }
}

function isUnauthenticated(text: string): boolean {
  return /not (?:logged|signed) in|unauthori[sz]ed|please (?:log|sign) in|401|login required|token (?:expired|revoked)/i.test(text);
}

function isRateLimited(text: string): boolean {
  return /rate.?limit|too many requests|429|usage limit|quota|try again (?:in|at)/i.test(text);
}

/** The lines a preflight prints about what this driver will do, before it does any of it. */
export function describeCodexInvocation(driver: CodexWorkspaceDriver, plan: CodexWorkspaceArguments,
                                        workspaceRoot: string, environment: Record<string, string>): string[] {
  return [
    `executable      ${driver.executablePath ?? '(not found on PATH)'}`,
    `argv            codex ${plan.args.join(' ')}`,
    'stdin           the case instruction (never argv)',
    `cwd             ${workspaceRoot}`,
    'permission      approval never + permission profile (escalations refused, never granted)',
    `environment     ${Object.keys(environment).sort().join(', ') || '(empty)'}`,
    ...plan.activeIsolation.map((line) => `isolation       ${line}`),
    ...plan.notEnforceable.map((line) => `NOT ENFORCED    ${line}`),
  ];
}
