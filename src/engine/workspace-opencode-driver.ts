// Benchmark engine · driving the installed `opencode` CLI against a disposable workspace.
//
// THE THIRD AGENT CLI ON THE WORKSPACE SIDE, AND NOT A COPY OF EITHER OF THE OTHER TWO. OpenCode
// differs from Codex and Claude in the three places that decide what a row can prove:
//
//   BILLING     it is METERED — an API credential against OpenCode Zen, per token — so a workspace
//               binding through it is refused unless the route carries a signed zero-marginal-cost
//               confirmation (`free_confirmed`). A published $0 list price is not one. See
//               `validateBinding` and `cost-eligibility.ts`.
//   IDENTITY    `opencode run --format json` emits no assistant message, which is the only place
//               OpenCode names the model that answered. So a reply names nobody, and — unlike Codex,
//               which at least REPORTS a reroute — a substitution on this path returns the same bytes.
//               See `OPENCODE_WORKSPACE_IDENTITY_LIMITATION`: this route is strictly weaker than
//               Codex's, and the difference is stated rather than smoothed over.
//   POLICY      OpenCode's controls are a PERMISSION TABLE and a TOOLS MAP in its configuration, not
//               flags. Both were read back from the CLI itself with `opencode debug config` and
//               `opencode debug agent build`, run locally under a Seatbelt profile that denied every
//               socket — so the probe provably reached no provider — against opencode-ai@1.18.31.
//
// HOW EVERY PART OF THE INVOCATION WAS ESTABLISHED
//
//   run --format json --model <provider/model> --dir <workspace> --pure --title <fixed>
//       From `opencode run --help` (sends nothing). `--format json` is the envelope the prose adapter
//       already parses from a CAPTURED live reply (`test/engine/fixtures/opencode-run-json.ts`).
//       `--title` is given so the CLI never asks a model to name the session: an untitled run asks the
//       configured `small_model`, which on this machine is a DIFFERENT model from any under test.
//       `--auto` ("auto-approve permissions that are not explicitly denied (dangerous!)") is NEVER
//       sent; the permission table below states every decision explicitly instead.
//   OPENCODE_CONFIG_CONTENT = { permission, tools, model, small_model, share, autoupdate }
//       Observed merged into the resolved configuration by `opencode debug config`, and observed to
//       change the effective agent in `opencode debug agent build`: `bash: deny` turns the shell tool
//       off, `tools.webfetch|websearch|task|todowrite|skill|question: false` remove those tools, and
//       `external_directory: deny` is appended after the CLI's own defaults. `small_model` is pinned to
//       the requested model so no housekeeping request can reach another one.
//   XDG_CONFIG_HOME = <empty directory under the attempt's scratch TMPDIR>
//       Observed to move OpenCode's global configuration directory (`opencode debug paths`), which
//       drops the operator's own `opencode.json` — on this machine it names a default model and a
//       custom provider — out of the measured run. AUTH IS UNAFFECTED: the credential lives under
//       XDG_DATA_HOME (`~/.local/share/opencode`), which is not moved.
//   OPENCODE_DISABLE_PROJECT_CONFIG, _CLAUDE_CODE, _EXTERNAL_SKILLS, _DEFAULT_PLUGINS, _LSP_DOWNLOAD,
//   _MODELS_FETCH, _AUTOUPDATE, _SHARE = 1
//       Names read from the binary's own strings. `_CLAUDE_CODE` and `_EXTERNAL_SKILLS` were observed to
//       remove the operator's `~/.claude/skills` directories from the agent's external-directory
//       allow-list. The others are recorded as SENT, not as observed: their effect needs a request.
//
// WHY THE DRIVER ADDS TO THE ENVIRONMENT, WHEN THE OTHER TWO ADD NOTHING. OpenCode has no flag for its
// permission table, so the only way to state the policy to the tool is through its configuration, and
// the only way to do that without writing a file into the tree being measured is the environment.
// Every name added here is Cernum-authored, non-credential and listed in `activeIsolation`; every
// OPENCODE_* name arriving from the allow-listed environment is REFUSED outright, because
// `OPENCODE_API_KEY`, `OPENCODE_AUTH_CONTENT` and `OPENCODE_CONFIG` could each change who pays or what
// runs; and a case-listed name can never be overwritten by one added here.
//
// WHAT THIS DRIVER OBSERVES, AND WHAT IT ONLY HEARS. Every event is `agentReported`, as on the other two
// drivers. The `tool_use` part shape (`{type:"tool", tool, callID, state:{status, input, output|error}}`)
// is the SDK's DECLARED `ToolPart` type — the one live OpenCode capture this repository holds contains
// no tool call — so it is read tolerantly and `OPENCODE_TOOL_EVENTS_ARE_DECLARED_NOT_CAPTURED` says so on
// every attempt. The verdict never depends on it: it comes from the tree and the sealed checks.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAllowanceExhaustion } from './attempt-disposition';
import { CanonicalValue, sha256Text } from './canonical';
import { CLIResult, CLIRunOptions, findExecutable, runCLI } from './cli-process';
import { OPENCODE_EXECUTABLE, parseOpenCodeVersion } from './opencode-cli';
import { EffortLevel, IDENTITY_UNNAMEABLE_BECAUSE, ProviderID } from './provider';
import { redactSecrets } from './redaction';
import { verifyProviderIdentity } from './verification';
import { NetworkPolicy, ToolPolicy } from './workspace-case';
import { WORKSPACE_ONLY_THROTTLE, commandInvocations } from './workspace-claude-driver';
import {
  WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, WorkspaceAgentCapabilities, WorkspaceAgentDriver,
  WorkspaceAgentFailureKind, WorkspaceAgentRequest, WorkspaceAgentResult,
} from './workspace-agent';
import { WorkspaceAgentUsage } from './workspace-host';
import { EventProvenance, TranscriptEvent, TranscriptEventKind } from './workspace-transcript';

export const OPENCODE_WORKSPACE_DRIVER_ID = 'driver.opencode-cli.workspace';

/**
 * The ONLY version this driver will drive, as the Codex driver does and for the same reason: an
 * unknown configuration key is accepted without a word, so a release that renamed `permission` or a
 * tool would keep this driver running with part of its policy quietly gone.
 */
export const OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST = '1.18.31';

/** Every OpenCode tool withheld by the tools map. Observed removed in `opencode debug agent build`. */
export const OPENCODE_WORKSPACE_WITHHELD_TOOLS = ['webfetch', 'websearch', 'task', 'todowrite', 'skill', 'question'] as const;

/** Behaviour switches read from the binary's strings. Sent as `1`. See the header for which were observed. */
export const OPENCODE_WORKSPACE_DISABLE_SWITCHES = [
  'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_MODELS_FETCH',
  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_SHARE',
] as const;

/** Environment names that could change who pays, what is read, or what runs. Never handed to the child. */
export const OPENCODE_ENVIRONMENT_NAMES_REFUSED = /^(OPENCODE_|XDG_CONFIG_HOME$)/;

/** The directory name, under the attempt's scratch TMPDIR, that stands in for the global config dir. */
export const OPENCODE_EMPTY_CONFIG_DIRECTORY = 'cernum-opencode-empty-config';

export const OPENCODE_WORKSPACE_IDENTITY_LIMITATION =
  'opencode run --format json (opencode-ai 1.18.31) emits no assistant message, the only event in which OpenCode names '
  + 'the model that answered. Exact execution identity on this route is therefore UNVERIFIABLE, and — unlike codex exec, '
  + 'which reports a reroute when the service substitutes a model — a substitution here would return the same bytes: the '
  + 'route cannot DETECT substitution at all. A row means "what answered when this identifier was requested through '
  + 'OpenCode on this credential", never "this model answered". The requested identifier is never recorded as the '
  + 'reported one. If a future stream carries an assistant message naming a different model, the attempt is refused '
  + 'and the served model is kept.';

export const OPENCODE_TOOL_EVENTS_ARE_DECLARED_NOT_CAPTURED =
  'tool calls are read from `tool_use` events shaped as the SDK DECLARES a ToolPart ({tool, callID, state}). The only '
  + 'live OpenCode capture Cernum holds carries no tool call, so this shape is the tool\'s published type rather than an '
  + 'observed one. Events that do not match it are skipped, never guessed at; the verdict comes from the tree.';

export const OPENCODE_SHELL_IS_NOT_CONFINED =
  'OpenCode\'s bash tool runs as this user with no OS sandbox. `external_directory: deny` refuses the FILE tools outside '
  + 'the workspace; it is a permission OpenCode checks, not a boundary the kernel enforces, and a shell command can cd '
  + 'anywhere the process can reach. The workspace boundary is therefore OBSERVED — the pristine baseline is re-digested '
  + 'after every attempt — rather than asserted.';

export const OPENCODE_NETWORK_IS_NOT_EXPRESSIBLE =
  'OpenCode documents no network switch. `webfetch` and `websearch` are removed by the tools map, which removes the '
  + 'network-reaching TOOLS; bash can still reach the network. The case\'s networkPolicy is a declaration, not an '
  + 'enforcement.';

export const OPENCODE_OUTPUT_IS_NOT_BOUNDED =
  '`opencode run` has no output-token budget flag, so nothing caps how many tokens one attempt consumes. They are '
  + 'counted from each step-finish part and recorded; they were not bounded. A metered OpenCode binding may run a '
  + 'workspace task only under a signed zero-marginal-cost confirmation for its exact route.';

export const OPENCODE_DEADLINE_IS_CERNUMS =
  'the attempt deadline is enforced by Cernum — the child runs in its own process group, which is signalled at the '
  + 'deadline. `opencode run` documents no wall-clock limit of its own.';

export const OPENCODE_TOKENS_ARE_PER_STEP =
  'OpenCode reports tokens on each step-finish part, one per model request inside the agent loop. The attempt\'s '
  + 'figures are the SUM over steps (the last report per part id wins, as the stream re-emits parts). The captured '
  + 'envelope proves the components are disjoint: total = input + output + reasoning + cache.read, so cache.read is '
  + 'additional to the fresh input and reasoning is not a subset of output.';

/**
 * What this driver can do, declared against the installed CLI.
 *
 * `expressesToolPolicy` IS TRUE BECAUSE IT WAS SEEN, not because it is wanted: the resolved agent under
 * `bash: deny` listed `bash: false`, and edit/write are governed by `permission.edit`. File READS cannot
 * be withheld without removing the tool the agent navigates with, so a case withholding reads is refused.
 */
export const OPENCODE_WORKSPACE_CAPABILITIES: WorkspaceAgentCapabilities = {
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  canIterateWithinOneInvocation: true,
  reportsToolCalls: true,
  reportsModelIdentity: false,
  expressesToolPolicy: true,
  expressesNetworkPolicy: false,
  commandExecutionScope: 'modelChosen',
};

// MARK: - Arguments and configuration

export interface OpenCodeWorkspaceArguments {
  args: string[];
  /** The configuration, as sent in OPENCODE_CONFIG_CONTENT. Parsed form, for a test and a preflight. */
  configuration: Record<string, CanonicalValue>;
  /** The Cernum-authored names added to the child's environment, values included. No credential is among them. */
  environmentAdditions: Record<string, string>;
  unexpressed: string[];
  notEnforceable: string[];
  activeIsolation: string[];
  toolNames: string[];
  allowedToolRules: string[];
}

export interface OpenCodeArgumentOptions {
  tools: ToolPolicy;
  networkPolicy: NetworkPolicy;
  requestedModelID: string;
  effort?: EffortLevel;
  temperatureMilli?: number;
  seed?: number;
  workspaceRoot: string;
  /** The attempt's scratch TMPDIR, outside the workspace. The empty config directory is made under it. */
  scratchDirectory: string;
  caseID: string;
}

/** PURE: the exact argv, configuration and environment additions. The instruction goes on stdin. */
export function buildOpenCodeWorkspaceArguments(options: OpenCodeArgumentOptions): OpenCodeWorkspaceArguments {
  const unexpressed: string[] = [];
  const notEnforceable: string[] = [];
  const { tools } = options;

  if (!tools.fileRead) {
    unexpressed.push('this case withholds file reads. OpenCode\'s read, glob and grep tools are how its agent navigates, '
      + 'and removing them has not been observed to leave a working agent. Refused rather than approximated.');
  }
  if (tools.allowedExecutables.length > 0) {
    unexpressed.push(`the executable allow-list (${tools.allowedExecutables.join(', ')}): OpenCode's bash permission accepts `
      + 'command patterns, and no pattern table has been observed to hold without a request. Refused rather than recorded '
      + 'as enforced.');
  }
  if (options.networkPolicy === 'denied') {
    unexpressed.push('networkPolicy denied: OpenCode documents no network switch, and bash can reach the network.');
  }
  if (options.requestedModelID.trim().length === 0 || !options.requestedModelID.includes('/')) {
    unexpressed.push(`model '${options.requestedModelID}': OpenCode addresses a model as provider/model, and anything else `
      + 'would be answered by whatever its configuration names as the default');
  }
  if (options.temperatureMilli !== undefined) {
    unexpressed.push(`temperature (${options.temperatureMilli} milli): \`opencode run\` accepts no sampling temperature`);
  }
  if (options.seed !== undefined) unexpressed.push(`seed (${options.seed}): \`opencode run\` accepts no sampling seed`);

  const toolsMap: Record<string, boolean> = {};
  for (const withheld of OPENCODE_WORKSPACE_WITHHELD_TOOLS) toolsMap[withheld] = false;
  if (!tools.commandExecution) toolsMap.bash = false;
  if (!tools.fileWrite) { toolsMap.edit = false; toolsMap.write = false; }

  const configuration: Record<string, CanonicalValue> = {
    model: options.requestedModelID,
    // PINNED TO THE MODEL UNDER TEST. Any housekeeping request the CLI still makes cannot reach another model.
    small_model: options.requestedModelID,
    permission: {
      edit: tools.fileWrite ? 'allow' : 'deny',
      bash: tools.commandExecution ? 'allow' : 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
    },
    tools: toolsMap,
    share: 'disabled',
    autoupdate: false,
  };

  const environmentAdditions: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
    XDG_CONFIG_HOME: path.join(options.scratchDirectory, OPENCODE_EMPTY_CONFIG_DIRECTORY),
  };
  for (const name of OPENCODE_WORKSPACE_DISABLE_SWITCHES) environmentAdditions[name] = '1';

  const args = ['run', '--format', 'json', '--model', options.requestedModelID, '--dir', options.workspaceRoot, '--pure',
    '--title', `cernum-workspace ${options.caseID}`];
  if (options.effort !== undefined && options.effort !== 'none') args.push('--variant', options.effort);

  const toolNames = ['read', 'glob', 'grep', ...(tools.fileWrite ? ['edit', 'write'] : []), ...(tools.commandExecution ? ['bash'] : [])];
  const activeIsolation = [
    `opencode CLI arguments and configuration verified against ${OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST}, and refused `
      + 'under any other version',
    `--dir ${options.workspaceRoot} and the working directory: the disposable workspace`,
    '--pure: external plugins off; --title fixed: no model is asked to title the session',
    `OPENCODE_CONFIG_CONTENT: permission edit ${tools.fileWrite ? 'allow' : 'deny'}, bash ${tools.commandExecution ? 'allow' : 'deny'}, `
      + 'webfetch deny, external_directory deny, doom_loop deny; tools '
      + `${Object.entries(toolsMap).map(([name, on]) => `${name}=${on}`).join(', ')}; small_model pinned to the requested model; `
      + 'share disabled; autoupdate off',
    'XDG_CONFIG_HOME: an empty directory under the scratch TMPDIR, so the operator\'s own opencode.json is not read '
      + '(authentication, under XDG_DATA_HOME, is unaffected)',
    `${OPENCODE_WORKSPACE_DISABLE_SWITCHES.join(', ')} = 1`,
    'never --auto: nothing is auto-approved, every decision is stated in the permission table',
    'OPENCODE_* and XDG_CONFIG_HOME names from the inherited environment are refused: they could change who pays or what runs',
    'the instruction is written to stdin, never to argv',
  ];
  if (options.effort !== undefined && options.effort !== 'none') {
    notEnforceable.push(`effort '${options.effort}' is sent as --variant, which OpenCode calls provider-specific; whether this `
      + 'model honours it is not reported by the stream and is not recorded as applied.');
  }
  notEnforceable.push(
    OPENCODE_SHELL_IS_NOT_CONFINED, OPENCODE_OUTPUT_IS_NOT_BOUNDED, OPENCODE_DEADLINE_IS_CERNUMS,
    OPENCODE_WORKSPACE_IDENTITY_LIMITATION, OPENCODE_TOOL_EVENTS_ARE_DECLARED_NOT_CAPTURED, OPENCODE_TOKENS_ARE_PER_STEP,
  );
  if (options.networkPolicy !== 'unrestricted') notEnforceable.push(OPENCODE_NETWORK_IS_NOT_EXPRESSIBLE);

  return {
    args, configuration, environmentAdditions, unexpressed, notEnforceable, activeIsolation, toolNames,
    allowedToolRules: [`permission.edit=${tools.fileWrite ? 'allow' : 'deny'}`, `permission.bash=${tools.commandExecution ? 'allow' : 'deny'}`],
  };
}

// MARK: - The stream

export interface PlannedOpenCodeEvent {
  kind: TranscriptEventKind;
  provenance: EventProvenance;
  detail: string;
  payload: Partial<TranscriptEvent>;
}

const AGENT_REPORTED: EventProvenance = 'agentReported';

interface JSONObject { [key: string]: unknown }
const isObject = (value: unknown): value is JSONObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface OpenCodeStepUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/** What the stream said, folded. */
export interface OpenCodeStreamState {
  sessionID?: string;
  /** The visible text, by part id; the last emission of a part wins. */
  textByPartID: Map<string, string>;
  /** Token reports, by step-finish part id; the last emission wins. */
  stepsByPartID: Map<string, OpenCodeStepUsage>;
  finishReason?: string;
  error?: { name: string; message: string; statusCode?: number };
  /** Tool call ids already reported as started, so a re-emitted part is not a second call. */
  announcedCalls: Set<string>;
  /** Tool call ids whose result has been reported. */
  settledCalls: Set<string>;
  /** A model named by an assistant message, should one ever reach this stream. */
  reportedModelIDs: string[];
  /** Tools the configuration withheld that ran anyway. Any entry fails the attempt. */
  contamination: string[];
  firstStepMilliseconds?: number;
}

export function newOpenCodeStreamState(): OpenCodeStreamState {
  return {
    textByPartID: new Map(), stepsByPartID: new Map(), announcedCalls: new Set(), settledCalls: new Set(),
    reportedModelIDs: [], contamination: [],
  };
}

export function parseOpenCodeStreamLine(line: string): JSONObject | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isObject(value) && typeof value.type === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The path a tool call names. OpenCode's tools spell it `filePath`; `path` is accepted for list/glob. */
function pathArgument(input: JSONObject): string | undefined {
  for (const key of ['filePath', 'file_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

const WITHHELD = new Set<string>(OPENCODE_WORKSPACE_WITHHELD_TOOLS);

/** Translate one `tool_use` part into transcript events. Every one is `agentReported`. */
function toolEvents(part: JSONObject, state: OpenCodeStreamState): PlannedOpenCodeEvent[] {
  const events: PlannedOpenCodeEvent[] = [];
  const toolName = asText(part.tool) || 'unknown';
  const callID = asText(part.callID) || asText(part.id) || undefined;
  const status = isObject(part.state) ? asText(part.state.status) : '';
  const input = isObject(part.state) && isObject(part.state.input) ? part.state.input : {};
  const key = callID ?? sha256Text(JSON.stringify(part));

  if (!state.announcedCalls.has(key)) {
    state.announcedCalls.add(key);
    const target = pathArgument(input);
    events.push({
      kind: 'toolCall', provenance: AGENT_REPORTED,
      detail: `${toolName}${target === undefined ? '' : ` ${target}`}`,
      payload: { toolName, callID, argumentsDigest: sha256Text(JSON.stringify(input)) },
    });
    if (WITHHELD.has(toolName)) state.contamination.push(toolName);
    if (toolName === 'read' && target !== undefined) {
      events.push({ kind: 'fileRead', provenance: AGENT_REPORTED, detail: `the tool reported reading ${target}`,
        payload: { path: target, toolName, callID } });
    } else if ((toolName === 'write' || toolName === 'edit' || toolName === 'patch') && target !== undefined) {
      const content = typeof input.content === 'string' ? input.content : undefined;
      events.push({ kind: 'fileWrite', provenance: AGENT_REPORTED, detail: `the tool reported writing ${target}`,
        payload: { path: target, toolName, callID,
          byteCount: content === undefined ? undefined : Buffer.byteLength(content, 'utf8') } });
    } else if (toolName === 'bash' && typeof input.command === 'string') {
      for (const invocation of commandInvocations(input.command)) {
        events.push({ kind: 'commandExecuted', provenance: AGENT_REPORTED,
          detail: `${invocation.executable} ${invocation.argv.join(' ')}`.trim(),
          payload: { executable: invocation.executable, argv: invocation.argv, callID } });
      }
    }
  }

  if ((status === 'completed' || status === 'error') && !state.settledCalls.has(key)) {
    state.settledCalls.add(key);
    const toolState = part.state as JSONObject;
    const text = status === 'completed' ? asText(toolState.output) : asText(toolState.error);
    events.push({
      kind: 'toolResult', provenance: AGENT_REPORTED,
      detail: text.length === 0 ? `the tool reported ${status} with no text` : text,
      payload: { callID, ok: status === 'completed', byteCount: Buffer.byteLength(text, 'utf8') },
    });
  }
  return events;
}

/**
 * Fold one event into the state and return the transcript events it produces.
 *
 * The CLI framing (`step_start`, `text`, `reasoning`, `tool_use`, `step_finish`, `error`) is the one
 * `run --format json` writes; the SERVER framing (`message.updated`) is read only so that an identity
 * can be caught if one ever arrives — see `OPENCODE_WORKSPACE_IDENTITY_LIMITATION`.
 */
export function eventsFromOpenCodeEvent(event: JSONObject, state: OpenCodeStreamState, atMilliseconds?: number):
  PlannedOpenCodeEvent[] {
  const type = asText(event.type);
  if (state.sessionID === undefined && typeof event.sessionID === 'string') state.sessionID = event.sessionID;
  const part = isObject(event.part) ? event.part : undefined;

  if (type === 'error') {
    const error = isObject(event.error) ? event.error : {};
    const data = isObject(error.data) ? error.data : {};
    state.error = { name: asText(error.name) || 'UnknownError', message: asText(data.message) || asText(error.message),
      statusCode: asNumber(data.statusCode) };
    return [];
  }
  if (type === 'message.updated') {
    const properties = isObject(event.properties) ? event.properties : {};
    const info = isObject(properties.info) ? properties.info : {};
    if (info.role === 'assistant' && typeof info.modelID === 'string' && info.modelID.length > 0) {
      const provider = asText(info.providerID);
      state.reportedModelIDs.push(provider.length > 0 ? `${provider}/${info.modelID}` : info.modelID);
    }
    return [];
  }
  if (part === undefined) return [];

  if (type === 'step_start' || part.type === 'step-start') {
    if (state.firstStepMilliseconds === undefined && atMilliseconds !== undefined) state.firstStepMilliseconds = atMilliseconds;
    return [];
  }
  if (type === 'step_finish' || part.type === 'step-finish') {
    const tokens = isObject(part.tokens) ? part.tokens : undefined;
    const cache = tokens && isObject(tokens.cache) ? tokens.cache : undefined;
    const id = asText(part.id) || `step-${state.stepsByPartID.size}`;
    state.stepsByPartID.set(id, {
      input: tokens ? asNumber(tokens.input) : undefined,
      output: tokens ? asNumber(tokens.output) : undefined,
      reasoning: tokens ? asNumber(tokens.reasoning) : undefined,
      cacheRead: cache ? asNumber(cache.read) : undefined,
      cacheWrite: cache ? asNumber(cache.write) : undefined,
      cost: asNumber(part.cost),
    });
    if (typeof part.reason === 'string') state.finishReason = part.reason;
    return [];
  }
  if (type === 'text' || part.type === 'text') {
    if (part.synthetic === true || part.ignored === true || typeof part.text !== 'string') return [];
    const id = asText(part.id) || `text-${state.textByPartID.size}`;
    const first = !state.textByPartID.has(id);
    state.textByPartID.set(id, part.text);
    if (!first || part.text.length === 0) return [];
    return [{ kind: 'message', provenance: AGENT_REPORTED, detail: part.text,
      payload: { channel: 'visible', textDigest: sha256Text(part.text), textByteCount: Buffer.byteLength(part.text, 'utf8') } }];
  }
  if (type === 'reasoning' || part.type === 'reasoning') {
    const text = asText(part.text);
    if (text.length === 0) return [];
    return [{ kind: 'message', provenance: AGENT_REPORTED, detail: text,
      payload: { channel: 'thinking', textDigest: sha256Text(text), textByteCount: Buffer.byteLength(text, 'utf8') } }];
  }
  if (type === 'tool_use' || part.type === 'tool') return toolEvents(part, state);
  return [];
}

/** The attempt's usage: the sum over step-finish reports. Absent when no step reported tokens. */
export function openCodeWorkspaceUsage(state: OpenCodeStreamState, requestedModelID: string, reportedModelID: string):
  WorkspaceAgentUsage | undefined {
  const steps = [...state.stepsByPartID.values()];
  const sum = (field: keyof OpenCodeStepUsage): number | undefined => {
    const values = steps.map((step) => step[field]).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const fresh = sum('input');
  const cacheRead = sum('cacheRead');
  const cacheWrite = sum('cacheWrite');
  const anyInput = fresh !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
  if (steps.length === 0) return undefined;
  const identity = reportedModelID.length === 0 ? undefined : verifyProviderIdentity(requestedModelID, reportedModelID);
  const cost = sum('cost');
  return {
    // EVERY input token: fresh + cache-read + cache-write, the quantity a charge is computed from.
    inputTokens: anyInput ? (fresh ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined,
    freshInputTokens: fresh,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    visibleOutputTokens: sum('output'),
    reasoningTokens: sum('reasoning'),
    numTurns: steps.length,
    identityState: identity?.state ?? 'unverifiable',
    participantIDs: reportedModelID.length === 0 ? [] : [reportedModelID],
    terminalReason: state.error !== undefined ? `error:${state.error.name}` : state.finishReason,
    apiErrorStatus: state.error?.statusCode,
    observedFirstOutputMilliseconds: state.firstStepMilliseconds,
    rawUsage: {
      steps: steps.map((step) => ({ ...step })) as unknown as CanonicalValue,
      // OpenCode's own cost figure, UNIT UNDECLARED, preserved under a name that says so and never
      // turned into a charge — the same treatment the prose adapter gives it.
      ...(cost === undefined ? {} : { openCodeReportedCostUnitUnverified: cost }),
    },
  };
}

/** Classify an OpenCode error into the workspace vocabulary. A provider refusal is never `transport`. */
export function classifyOpenCodeWorkspaceError(error: { name: string; message: string; statusCode?: number }):
  WorkspaceAgentFailureKind {
  const text = `${error.name} ${error.message}`;
  if (error.name === 'ProviderAuthError' || error.statusCode === 401 || error.statusCode === 403) return 'notAuthenticated';
  if (error.statusCode === 429 || isAllowanceExhaustion(text) || WORKSPACE_ONLY_THROTTLE.test(text) || /rate.?limit/i.test(text)) {
    return 'rateLimited';
  }
  if (error.name === 'MessageAbortedError') return 'cancelled';
  if (error.name === 'MessageOutputLengthError') return 'malformedOutput';
  return 'transport';
}

// MARK: - The driver

export interface OpenCodeWorkspaceDriverOptions {
  requestedModelID: string;
  effort?: EffortLevel;
  executablePath?: string;
  findExecutable?: (name: string) => string | undefined;
  /** Injected by the tests, so every branch is reachable without a provider request. */
  run?: (options: CLIRunOptions) => Promise<CLIResult>;
  /** `opencode --version`, injected by the tests. In life a local command that reaches no model. */
  version?: (environment: Record<string, string>) => Promise<string | undefined>;
}

export class OpenCodeWorkspaceDriver implements WorkspaceAgentDriver {
  readonly driverID = OPENCODE_WORKSPACE_DRIVER_ID;

  readonly provider: ProviderID = 'opencodeCLI';

  readonly capabilities = OPENCODE_WORKSPACE_CAPABILITIES;

  readonly executablePath?: string;

  readonly commandName = OPENCODE_EXECUTABLE;

  readonly cliVersionVerifiedAgainst = OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST;

  private readonly runCLIProcess: (options: CLIRunOptions) => Promise<CLIResult>;

  private versionResult?: Promise<string | undefined>;

  constructor(private readonly options: OpenCodeWorkspaceDriverOptions) {
    const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
    this.executablePath = options.executablePath ?? locate(OPENCODE_EXECUTABLE);
    this.runCLIProcess = options.run ?? runCLI;
  }

  argumentsFor(tools: ToolPolicy, networkPolicy: NetworkPolicy,
               sampling: { temperatureMilli?: number; seed?: number } = {},
               workspaceRoot = '<workspace>', scratchDirectory = '<scratch>', caseID = '<case>'): OpenCodeWorkspaceArguments {
    return buildOpenCodeWorkspaceArguments({
      tools, networkPolicy, requestedModelID: this.options.requestedModelID, effort: this.options.effort,
      temperatureMilli: sampling.temperatureMilli, seed: sampling.seed, workspaceRoot, scratchDirectory, caseID,
    });
  }

  private async readVersion(environment: Record<string, string>): Promise<string | undefined> {
    if (this.options.version !== undefined) return this.options.version(environment);
    const result = await this.runCLIProcess({
      executable: this.executablePath as string, args: ['--version'], timeoutMilliseconds: 15_000,
      replaceEnvironment: environment,
    });
    return parseOpenCodeVersion(result.stdout);
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const events = () => request.transcript.build().events.slice(before);
    const scratch = request.environment.TMPDIR ?? path.join(request.workspaceRoot, '..', 'tmp');

    const plan = this.argumentsFor(request.tools, request.networkPolicy,
      { temperatureMilli: request.temperatureMilli, seed: request.seed }, request.workspaceRoot, scratch, request.caseID);

    const refuse = (kind: WorkspaceAgentFailureKind, detail: string): WorkspaceAgentResult => ({
      completed: false, failure: { kind, detail }, reportedModelID: '',
      unexpressed: plan.unexpressed, notEnforceable: plan.notEnforceable,
      activeIsolation: [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt, events: events(),
    });

    if (!this.executablePath) {
      return refuse('notInstalled', 'the `opencode` command was not found. Cernum drives the OpenCode CLI you installed and '
        + 'authenticated yourself; it does not install one and does not reach the service any other way.');
    }
    if (plan.unexpressed.length > 0) {
      return refuse('policyNotExpressible',
        `this case froze settings the opencode CLI cannot express, so nothing was sent: ${plan.unexpressed.join('; ')}`);
    }
    const refusedNames = Object.keys(request.environment).filter((name) => OPENCODE_ENVIRONMENT_NAMES_REFUSED.test(name));
    if (refusedNames.length > 0) {
      return refuse('policyNotExpressible', `the attempt's environment carries ${refusedNames.sort().join(', ')}. Every `
        + 'OPENCODE_* name and XDG_CONFIG_HOME can change this CLI\'s credential, configuration or behaviour, and so who '
        + 'pays or what runs; nothing was sent.');
    }

    this.versionResult = this.versionResult ?? this.readVersion(request.environment);
    let version: string | undefined;
    try {
      version = await this.versionResult;
    } catch (error) {
      return refuse('spawnFailure', `the opencode version probe could not run: ${redactSecrets(String(error))}`);
    }
    if (version !== OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST) {
      return refuse('policyNotExpressible', `the installed opencode reports version ${version ?? '(unreadable)'}, and this `
        + `driver's permission table and switches were verified against ${OPENCODE_WORKSPACE_CLI_VERSION_VERIFIED_AGAINST}. `
        + 'OpenCode accepts an unknown configuration key without a word, so a different version could silently drop part of '
        + 'the policy. Re-verify against it first.');
    }

    // The empty global configuration directory, made now so OpenCode finds nothing in it.
    try { fs.mkdirSync(plan.environmentAdditions.XDG_CONFIG_HOME, { recursive: true }); } catch { /* reported below by the CLI */ }

    const state = newOpenCodeStreamState();
    let pending = '';
    const ingest = (line: string, at?: number): void => {
      const message = parseOpenCodeStreamLine(line);
      if (message === undefined) return;
      for (const planned of eventsFromOpenCodeEvent(message, state, at)) {
        request.transcript.emit(planned.kind, planned.provenance, request.attemptIndex, planned.detail, planned.payload);
      }
    };

    const result = await this.runCLIProcess({
      executable: this.executablePath,
      args: plan.args,
      input: request.instruction,
      timeoutMilliseconds: request.timeoutMilliseconds,
      workingDirectory: request.workspaceRoot,
      // THE CASE'S ALLOW-LISTED ENVIRONMENT, PLUS ONLY CERNUM'S OWN NON-CREDENTIAL CONFIGURATION. The
      // allow-listed names come last so nothing added here can overwrite one the case named.
      replaceEnvironment: { ...plan.environmentAdditions, ...request.environment },
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
    if (state.stepsByPartID.size === 0 && state.textByPartID.size === 0 && state.error === undefined
        && result.stdout.trim().length > 0) {
      for (const line of result.stdout.split('\n')) ingest(line);
    }

    // IDENTITY: the stream's word or nothing. A named model that differs from the request is a substitution.
    const reportedModelID = state.reportedModelIDs[state.reportedModelIDs.length - 1] ?? '';
    const usage = openCodeWorkspaceUsage(state, this.options.requestedModelID, reportedModelID);
    const finalMessage = [...state.textByPartID.values()].join('').trim();

    const finish = (kind: WorkspaceAgentFailureKind | undefined, detail: string): WorkspaceAgentResult => ({
      completed: kind === undefined,
      finalMessage: finalMessage.length > 0 ? finalMessage : undefined,
      failure: kind === undefined ? undefined : { kind, detail },
      reportedModelID,
      unexpressed: plan.unexpressed,
      notEnforceable: plan.notEnforceable,
      activeIsolation: [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX,
        `the CLI passed the preflight as opencode ${version}`],
      elapsedMilliseconds: result.elapsedMilliseconds,
      usage,
      events: events(),
    });

    if (result.failure?.kind === 'timeout') {
      return finish('timeout', `the attempt's ${request.timeoutMilliseconds} ms deadline passed with the tool still working. `
        + `${OPENCODE_DEADLINE_IS_CERNUMS} Everything it reported up to that moment is in the transcript.`);
    }
    if (result.failure?.kind === 'cancelled') return finish('cancelled', 'the run was paused or aborted before this attempt finished');
    if (result.failure?.kind === 'notInstalled' || result.failure?.kind === 'spawnFailure') {
      return finish(result.failure.kind, redactSecrets(result.failure.detail));
    }

    // A SUBSTITUTION MAKES THE WORK REAL AND THE BINDING FALSE. Checked before the turn's own verdict.
    if (reportedModelID.length > 0 && verifyProviderIdentity(this.options.requestedModelID, reportedModelID).state === 'substituted') {
      return finish('policyNotExpressible', `the stream named ${reportedModelID} as the answering model and ${this.options.requestedModelID} `
        + 'was requested. That work was done by a model this binding does not describe; the attempt is refused and the served '
        + 'model is kept as the reported one.');
    }
    if (state.contamination.length > 0) {
      return finish('policyNotExpressible', `the tool invoked ${[...new Set(state.contamination)].join(', ')}, which the `
        + 'configuration withholds. The tool surface did not hold, so this attempt is not a measurement under the frozen policy.');
    }

    // THE ENVELOPE'S OWN ERROR BEFORE THE EXIT CODE: a refusal exits non-zero and still says why.
    if (state.error !== undefined) {
      const kind = classifyOpenCodeWorkspaceError(state.error);
      return finish(kind, `OpenCode reported ${state.error.name}${state.error.statusCode === undefined ? '' : ` (HTTP ${state.error.statusCode})`}: `
        + redactSecrets(state.error.message).slice(0, 400));
    }
    if (result.failure) {
      const both = `${result.stdout}\n${result.stderr}`;
      const kind: WorkspaceAgentFailureKind = /ProviderAuthError|not (?:logged|signed) in|unauthori[sz]ed|no credential/i.test(both)
        ? 'notAuthenticated'
        : classifyOpenCodeWorkspaceError({ name: '', message: both }) === 'rateLimited' ? 'rateLimited' : 'exitFailure';
      return finish(kind, `${redactSecrets(result.failure.detail)}${result.stderr ? ` — ${redactSecrets(result.stderr).slice(0, 500)}` : ''}`);
    }
    if (state.stepsByPartID.size === 0) {
      return finish('malformedOutput', 'the CLI exited successfully and its stream contains no step-finish part, so nothing here '
        + 'can say that a model turn completed or what it consumed. Cernum refuses to scrape an unrecognised format.');
    }
    return finish(undefined, '');
  }
}

/** The identity note an OpenCode row carries, for the admission and the qualification view. */
export const OPENCODE_IDENTITY_UNNAMEABLE = IDENTITY_UNNAMEABLE_BECAUSE.opencodeCLI ?? '';

/** The lines a preflight prints about what this driver will do. */
export function describeOpenCodeInvocation(driver: OpenCodeWorkspaceDriver, plan: OpenCodeWorkspaceArguments,
                                           workspaceRoot: string, environment: Record<string, string>): string[] {
  return [
    `executable      ${driver.executablePath ?? '(not found)'}`,
    `argv            opencode ${plan.args.join(' ')}`,
    'stdin           the case instruction (never argv)',
    `cwd             ${workspaceRoot}`,
    `tools           ${plan.toolNames.join(', ')}`,
    `configuration   ${JSON.stringify(plan.configuration)}`,
    `environment     ${[...Object.keys(environment), ...Object.keys(plan.environmentAdditions)].sort().join(', ')}`,
    ...plan.activeIsolation.map((line) => `isolation       ${line}`),
    ...plan.notEnforceable.map((line) => `NOT ENFORCED    ${line}`),
  ];
}
