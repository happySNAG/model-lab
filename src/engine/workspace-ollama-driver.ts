// Benchmark engine · a LOCAL model on a workspace task, through an agent loop Cernum owns.
//
// NOT AN IMITATION OF THE CLI DRIVERS, BECAUSE THERE IS NO CLI. `claude`, `codex` and `opencode` each
// bring an agent loop, a tool set and a shell; Cernum only chooses flags. Ollama brings a model and a
// chat endpoint that can return tool calls. So here CERNUM is the harness: it offers the tools, carries
// out every call itself, bounds the loop, and decides what each tool may touch. That changes what this
// route can prove, in both directions, and both are stated rather than assumed:
//
//   STRONGER  Every file read and every file write is performed BY THIS ENGINE through `resolveInside`,
//             so `fileRead` and `fileWrite` are `engineObserved` here — on the CLI routes they are the
//             tool's account of itself. Identity is also stronger: the runtime names the model in every
//             reply, and the WEIGHTS DIGEST is read before and after the attempt, so a model re-pulled
//             or replaced mid-run is caught rather than scored.
//   NARROWER  There is no shell. Under the V1 execution policy (`execution-sandbox.ts`) Cernum never
//             executes a command a model chose, so the only command tool is `run_check`: the model names
//             one of the case's VISIBLE sealed checks by identifier, and the runner executes the case's
//             own argv on a throwaway copy of the tree, under the OS sandbox. That is category C, and it
//             is a different experiment from a CLI agent with a shell. `commandExecutionScope:
//             'sealedChecksOnly'` carries the difference onto every record, and a comparison that put
//             this route's rows beside a CLI route's without reading that field would be comparing
//             harnesses as much as models.
//
// THE LOCAL TRUST BOUNDARY. The endpoint must be loopback — `validateLoopbackEndpoint`, the same check
// the local prose path uses — so instruction, file contents and tool results never leave this machine.
// A model whose weights originated with an outside vendor needs no remote identity admission: what is
// being established is which WEIGHTS ran on THIS machine, and the runtime's digest answers exactly that.
// Nothing here sends any content to an external provider, and there is no code path that could.
//
// WHAT IS RECORDED, AND WHAT IS NOT INVENTED. The runtime's `prompt_eval_count` and `eval_count` are
// recorded as reported and summed across turns. Where a reply omits one, the figure is ABSENT, never
// zero and never estimated from characters. `prompt_eval_count` counts the tokens the runtime EVALUATED;
// with prefix-cache reuse that can be fewer than the prompt, and it is recorded as the runtime's number.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FetchLike, httpBackstopTimeoutsFor, loopbackHTTPFetch, validateLoopbackEndpoint } from '../core/ollama-http';
import { CanonicalValue, sha256Text } from './canonical';
import { machineKey, readMachineFingerprint } from './machine-availability';
import { resolveInside } from './isolation';
import { ProviderID } from './provider';
import { redactSecrets } from './redaction';
import { verifyProviderIdentity } from './verification';
import { NetworkPolicy, ToolPolicy } from './workspace-case';
import {
  WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, WorkspaceAgentCapabilities, WorkspaceAgentDriver,
  WorkspaceAgentFailureKind, WorkspaceAgentRequest, WorkspaceAgentResult,
} from './workspace-agent';
import { WorkspaceAgentUsage } from './workspace-host';

export const OLLAMA_WORKSPACE_DRIVER_ID = 'driver.ollama.workspace';

/** The version of Cernum's own loop and tool set. A change to either is a different experiment. */
export const OLLAMA_WORKSPACE_HARNESS_VERSION = 'cernum-local-agent-1';

export const OLLAMA_WORKSPACE_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/** Bounds on the loop. A local model costs no money, and still costs the operator's machine and time. */
export const OLLAMA_WORKSPACE_MAXIMUM_TURNS = 48;
export const OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN = 8_192;

/**
 * The largest context window this harness will ASK a local runtime to open, in tokens.
 *
 * The runtime does not size the window to the conversation: it opens the whole window up front and
 * holds the KV cache for it in memory. A model that reports 262_144 tokens would therefore have the
 * harness demand tens of gigabytes before the first turn, on a machine that may not have them — so
 * asking for a model's full reported context is not the safe reading of "use what was measured".
 *
 * What is measured stays measured: `localModelContextLengthTokens` on every record is still the
 * runtime's own number, untouched. This ceiling bounds the REQUEST, is recorded beside it as
 * `localModelContextWindowRequestedTokens`, and is raised by an operator who has the memory for it.
 */
export const OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS = 32_768;

export const OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES = 200_000;
export const OLLAMA_WORKSPACE_MAXIMUM_LISTED_FILES = 500;

/**
 * The window to ask for, given what the runtime said the model can do.
 *
 * UNKNOWN STAYS UNKNOWN. A runtime that published no context length gets no `num_ctx` at all: the
 * runtime then applies its own default, which is a fact about the runtime rather than a number this
 * harness made up. Inventing one here would put a fabricated window on the record beside genuinely
 * measured ones.
 */
export function ollamaWorkspaceContextWindow(contextLengthTokens: number | undefined,
                                             ceilingTokens: number = OLLAMA_WORKSPACE_CONTEXT_CEILING_TOKENS): number | undefined {
  if (contextLengthTokens === undefined || !Number.isFinite(contextLengthTokens) || contextLengthTokens <= 0) return undefined;
  return Math.min(Math.floor(contextLengthTokens), Math.floor(ceilingTokens));
}

export const OLLAMA_WORKSPACE_SYSTEM_PROMPT = [
  'You are working in a software repository through tools. The repository is your whole world: every path is relative',
  'to its root. Use list_files and read_file to understand it, write_file or replace_in_file to change it, and run_check',
  'to run one of the repository\'s named checks. When the task is complete, reply with a short summary and no tool call.',
].join(' ');

export const OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY =
  'this route has no shell. The model may run only the case\'s VISIBLE sealed checks, by identifier, through run_check; '
  + 'Cernum executes the case\'s own argv on a throwaway copy of the tree under the OS sandbox. Hidden checks are never '
  + 'offered. This is a narrower tool surface than a CLI agent\'s, and its rows are a different experiment from theirs.';

export const OLLAMA_IDENTITY_IS_THE_DIGEST =
  'identity on this route is the local runtime\'s weights digest, read before the first turn and again after the last, '
  + 'and compared with the digest frozen when the run was planned. The runtime also names the model tag in every reply. '
  + 'A digest that differs at any of the three readings refuses the attempt: different weights are a different model.';

export const OLLAMA_STAYS_ON_THIS_MACHINE =
  'the endpoint is loopback-only (127.0.0.1, localhost, ::1). The instruction, file contents and tool results are sent '
  + 'to the local runtime and nowhere else; no remote provider is involved.';

/**
 * What this driver can do. Every flag describes CERNUM'S harness, because Cernum is the tool.
 *
 * `expressesNetworkPolicy` is TRUE for the loop: no tool it offers can reach a network, and `run_check`
 * executes under a Seatbelt profile that denies every socket. The runtime itself is loopback-only.
 */
export const OLLAMA_WORKSPACE_CAPABILITIES: WorkspaceAgentCapabilities = {
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  canIterateWithinOneInvocation: true,
  reportsToolCalls: true,
  reportsModelIdentity: true,
  expressesToolPolicy: true,
  expressesNetworkPolicy: true,
  commandExecutionScope: 'sealedChecksOnly',
};

// MARK: - The runtime, over loopback

export interface LocalRuntimeModel {
  name: string;
  digest: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  contextLengthTokens?: number;
  /** What the runtime says the model can do. Undefined means it did not say. */
  capabilities?: string[];
}

export class OllamaRuntimeUnavailable extends Error {
  constructor(readonly kind: 'unreachable' | 'modelNotFound' | 'httpFailure' | 'malformed', message: string) {
    super(message);
    this.name = 'OllamaRuntimeUnavailable';
  }
}

interface JSONObject { [key: string]: unknown }
const isObject = (value: unknown): value is JSONObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A minimal client for the three calls this driver makes. Loopback is checked at construction. */
export class LocalRuntimeClient {
  readonly base: URL;

  constructor(endpoint: string, private readonly fetchImpl: FetchLike = loopbackHTTPFetch()) {
    this.base = validateLoopbackEndpoint(endpoint);
  }

  private async call(method: 'GET' | 'POST', route: string, body: JSONObject | undefined, timeoutMilliseconds: number,
                     shouldCancel?: () => boolean): Promise<JSONObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    const poll = shouldCancel === undefined ? undefined : setInterval(() => { if (shouldCancel()) controller.abort(); }, 200);
    timer.unref?.();
    poll?.unref?.();
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(new URL(route, this.base).toString(), {
        method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
        // DERIVED FROM the deadline above, never a replacement for it: the controller aborts at
        // `timeoutMilliseconds`, these land a fixed grace later. Without them the platform client
        // applies its own 300_000 ms header deadline and kills a slow-but-legitimate local
        // generation while the sealed case deadline still has time left on it.
        ...httpBackstopTimeoutsFor(timeoutMilliseconds),
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new OllamaRuntimeUnavailable('unreachable', aborted
        ? `the local runtime did not answer ${route} before the deadline or a cancellation`
        : `the local runtime at ${this.base.origin} did not answer: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
    }
    const text = await response.text();
    if (response.status === 404) throw new OllamaRuntimeUnavailable('modelNotFound', `${route} answered 404: ${redactSecrets(text).slice(0, 200)}`);
    if (response.status < 200 || response.status >= 300) {
      throw new OllamaRuntimeUnavailable('httpFailure', `${route} answered HTTP ${response.status}: ${redactSecrets(text).slice(0, 300)}`);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isObject(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new OllamaRuntimeUnavailable('malformed', `${route} answered something that is not a JSON object`);
    }
  }

  async version(): Promise<string | undefined> {
    const reply = await this.call('GET', 'api/version', undefined, 10_000);
    return typeof reply.version === 'string' ? reply.version : undefined;
  }

  /** The installed model, by exact tag. Reads the listing and `/api/show`; never pulls anything. */
  async model(name: string): Promise<LocalRuntimeModel> {
    const tags = await this.call('GET', 'api/tags', undefined, 10_000);
    const rows = Array.isArray(tags.models) ? tags.models.filter(isObject) : [];
    const row = rows.find((entry) => entry.name === name || entry.model === name);
    if (row === undefined) throw new OllamaRuntimeUnavailable('modelNotFound', `the local runtime does not have '${name}' installed`);
    const details = isObject(row.details) ? row.details : {};
    const model: LocalRuntimeModel = {
      name,
      digest: typeof row.digest === 'string' ? row.digest : '',
      sizeBytes: asNumber(row.size),
      parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
      quantization: typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
      family: typeof details.family === 'string' ? details.family : undefined,
    };
    try {
      const shown = await this.call('POST', 'api/show', { model: name }, 10_000);
      if (Array.isArray(shown.capabilities)) model.capabilities = shown.capabilities.filter((c): c is string => typeof c === 'string');
      const info = isObject(shown.model_info) ? shown.model_info : {};
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith('.context_length') && typeof value === 'number') { model.contextLengthTokens = value; break; }
      }
    } catch (error) {
      // Metadata lost, not truth: the listing proved the model is installed and named its digest.
      if (error instanceof OllamaRuntimeUnavailable && error.kind === 'unreachable') throw error;
    }
    return model;
  }

  async chat(body: JSONObject, timeoutMilliseconds: number, shouldCancel?: () => boolean): Promise<JSONObject> {
    return this.call('POST', 'api/chat', body, timeoutMilliseconds, shouldCancel);
  }
}

// MARK: - The tools Cernum offers, and carries out

export interface OllamaToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: JSONObject };
}

/** The tool set, derived from the case's policy. Deterministic, so two attempts see the same tools. */
export function ollamaWorkspaceTools(tools: ToolPolicy, checks: { id: string; kind: string }[]): OllamaToolDefinition[] {
  const definitions: OllamaToolDefinition[] = [];
  const fn = (name: string, description: string, properties: JSONObject, required: string[]): OllamaToolDefinition =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  if (tools.fileRead) {
    definitions.push(fn('list_files', 'List files under a directory of the repository (default: the root).',
      { path: { type: 'string', description: 'directory relative to the repository root' } }, []));
    definitions.push(fn('read_file', 'Read one file of the repository.',
      { path: { type: 'string', description: 'file path relative to the repository root' } }, ['path']));
  }
  if (tools.fileWrite) {
    definitions.push(fn('write_file', 'Create or overwrite one file of the repository with the given content.',
      { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']));
    definitions.push(fn('replace_in_file', 'Replace one exact occurrence of old_text with new_text in a file.',
      { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']));
  }
  if (tools.commandExecution && checks.length > 0) {
    definitions.push(fn('run_check', `Run one of the repository's named checks and see its output. Available: ${checks
      .map((check) => `${check.id} (${check.kind})`).join(', ')}.`,
    { check_id: { type: 'string', enum: checks.map((check) => check.id) } }, ['check_id']));
  }
  return definitions;
}

function listFiles(root: string, relative: string): string[] {
  const start = resolveInside(root, relative.length === 0 ? '.' : relative);
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= OLLAMA_WORKSPACE_MAXIMUM_LISTED_FILES) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(start);
  return out;
}

// MARK: - The driver

export interface OllamaWorkspaceDriverOptions {
  /** The installed tag, exactly as discovery reported it. */
  requestedModelID: string;
  /** The weights digest frozen at planning time. Empty means none was known — refused. */
  expectedDigest: string;
  endpoint?: string;
  /** Injected by the tests: a fake runtime on the other end of `fetch`, never a real one. */
  fetch?: FetchLike;
  maximumTurns?: number;
  outputTokensPerTurn?: number;
  /** The ceiling on the window this harness asks the runtime to open. Defaults to the constant above. */
  contextCeilingTokens?: number;
  /** The machine, as a fingerprint key and a label. Injected by the tests; read from the OS in life. */
  machine?: { machineKey: string; label: string; platform: string };
}

interface ChatMessage extends JSONObject {
  role: string;
  content: string;
}

export class OllamaWorkspaceDriver implements WorkspaceAgentDriver {
  readonly driverID = OLLAMA_WORKSPACE_DRIVER_ID;

  readonly provider: ProviderID = 'ollama';

  readonly capabilities = OLLAMA_WORKSPACE_CAPABILITIES;

  /** No executable: the "tool" is Cernum. Kept for the disclosure shape the other drivers share. */
  readonly executablePath = undefined;

  readonly commandName = 'ollama';

  readonly cliVersionVerifiedAgainst = OLLAMA_WORKSPACE_HARNESS_VERSION;

  readonly endpoint: string;

  constructor(private readonly options: OllamaWorkspaceDriverOptions) {
    this.endpoint = options.endpoint ?? OLLAMA_WORKSPACE_DEFAULT_ENDPOINT;
  }

  /** What would be refused before anything is sent. PURE; for a preflight and for `run`. */
  unexpressedFor(tools: ToolPolicy, networkPolicy: NetworkPolicy, hasChecks: boolean): string[] {
    const refusals: string[] = [];
    try { validateLoopbackEndpoint(this.endpoint); } catch (error) {
      refusals.push(`endpoint ${this.endpoint}: ${error instanceof Error ? error.message : String(error)}. A local model must stay local.`);
    }
    if (this.options.expectedDigest.length === 0) {
      refusals.push('no weights digest was frozen for this model, so nothing could establish which weights answer. Discover '
        + 'the local runtime first; the digest is the identity on this route.');
    }
    if (tools.commandExecution && !hasChecks) {
      refusals.push('this case allows command execution and declares no visible check, and this route runs no command a '
        + 'model chose. There is nothing the model could run.');
    }
    if (tools.allowedExecutables.length > 0) {
      // Nothing to express: the model names no executable at all. Recorded as a policy that holds trivially.
    }
    if (networkPolicy === 'unrestricted') {
      refusals.push('networkPolicy unrestricted: no tool on this route reaches a network, so a task that needs one cannot be done.');
    }
    return refusals;
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const events = () => request.transcript.build().events.slice(before);
    const checks = request.sealedChecks?.checks ?? [];
    const unexpressed = this.unexpressedFor(request.tools, request.networkPolicy, checks.length > 0);
    const machine = this.options.machine ?? (() => {
      const fingerprint = readMachineFingerprint();
      return { machineKey: machineKey(fingerprint), label: fingerprint.hostname, platform: `${fingerprint.platform}-${fingerprint.architecture}` };
    })();
    const notEnforceable = [OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY, OLLAMA_IDENTITY_IS_THE_DIGEST,
      'the runtime\'s token counts are recorded as reported; a figure a reply omits is absent, never zero or estimated'];
    const baseIsolation = [
      `harness ${OLLAMA_WORKSPACE_HARNESS_VERSION}: Cernum's own loop, at most ${this.options.maximumTurns ?? OLLAMA_WORKSPACE_MAXIMUM_TURNS} `
        + `turns of at most ${this.options.outputTokensPerTurn ?? OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN} output tokens each`,
      'every file read and write performed by Cernum through resolveInside, confined to the workspace',
      OLLAMA_STAYS_ON_THIS_MACHINE,
      `endpoint ${this.endpoint} on ${machine.label} (${machine.machineKey}, ${machine.platform})`,
    ];

    const result = (kind: WorkspaceAgentFailureKind | undefined, detail: string,
                    extra: Partial<WorkspaceAgentResult> = {}): WorkspaceAgentResult => ({
      completed: kind === undefined,
      failure: kind === undefined ? undefined : { kind, detail },
      reportedModelID: '',
      unexpressed, notEnforceable,
      activeIsolation: [...baseIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      events: events(),
      ...extra,
    });

    if (unexpressed.length > 0) {
      return result('policyNotExpressible', `this case froze settings the local route cannot express, so nothing was sent: ${unexpressed.join('; ')}`);
    }

    const client = new LocalRuntimeClient(this.endpoint, this.options.fetch);
    let runtimeVersion: string | undefined;
    let model: LocalRuntimeModel;
    try {
      runtimeVersion = await client.version();
      model = await client.model(this.options.requestedModelID);
    } catch (error) {
      const unavailable = error instanceof OllamaRuntimeUnavailable ? error : undefined;
      return result(unavailable?.kind === 'modelNotFound' || unavailable?.kind === 'unreachable' ? 'notInstalled' : 'transport',
        `LOCAL RUNTIME UNAVAILABLE — ${redactSecrets(error instanceof Error ? error.message : String(error))}. This is a fact about `
        + 'this machine\'s runtime, not about the model, and it measured nothing.');
    }
    if (model.digest !== this.options.expectedDigest) {
      return result('policyNotExpressible', `the installed '${model.name}' has weights digest ${model.digest || '(none)'}, and `
        + `${this.options.expectedDigest} was frozen when this run was planned. Different weights are a different model; `
        + 'nothing was sent. Re-plan against what is installed now.');
    }
    if (model.capabilities !== undefined && !model.capabilities.includes('tools')) {
      return result('policyNotExpressible', `the runtime reports '${model.name}' can do ${model.capabilities.join(', ') || 'nothing'}, `
        + 'and not tools. A workspace task through this route needs tool calls; nothing was sent.');
    }

    const tools = ollamaWorkspaceTools(request.tools, checks);
    const messages: ChatMessage[] = [
      { role: 'system', content: OLLAMA_WORKSPACE_SYSTEM_PROMPT },
      { role: 'user', content: request.instruction },
    ];
    const maximumTurns = this.options.maximumTurns ?? OLLAMA_WORKSPACE_MAXIMUM_TURNS;
    const contextWindowTokens = ollamaWorkspaceContextWindow(model.contextLengthTokens, this.options.contextCeilingTokens);
    const deadline = startedAt + request.timeoutMilliseconds;
    const reported: string[] = [];
    const counts = { prompt: [] as number[], evaluated: [] as number[], total: [] as number[], load: [] as number[] };
    let thinkingSeen = false;
    let finalMessage: string | undefined;
    let failure: { kind: WorkspaceAgentFailureKind; detail: string } | undefined;
    let firstReplyMilliseconds: number | undefined;
    let turns = 0;

    const usage = (): WorkspaceAgentUsage => {
      const sum = (values: number[]): number | undefined => (values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0));
      const reportedModelID = reported[reported.length - 1] ?? '';
      return {
        inputTokens: sum(counts.prompt),
        freshInputTokens: sum(counts.prompt),
        visibleOutputTokens: sum(counts.evaluated),
        ...(thinkingSeen ? { outputTokenSemantics: 'evalCountIncludesThinking' } : {}),
        observedFirstOutputMilliseconds: firstReplyMilliseconds,
        providerReportedDurationMilliseconds: counts.total.length === 0 ? undefined : Math.round(sum(counts.total)! / 1e6),
        numTurns: turns,
        identityState: reportedModelID.length === 0 ? 'unverifiable' : verifyProviderIdentity(this.options.requestedModelID, reportedModelID).state,
        participantIDs: [...new Set(reported)].sort(),
        terminalReason: failure?.kind ?? (finalMessage === undefined ? undefined : 'stop'),
        localModelDigest: model.digest,
        localRuntimeVersion: runtimeVersion,
        localRuntimeEndpoint: this.endpoint,
        localModelContextLengthTokens: model.contextLengthTokens,
        localModelContextWindowRequestedTokens: contextWindowTokens,
        localModelSizeBytes: model.sizeBytes,
        executionMachine: machine.machineKey,
        executionMachineLabel: machine.label,
        executionPlatform: machine.platform,
        rawUsage: {
          promptEvalCounts: counts.prompt, evalCounts: counts.evaluated,
          loadDurationNanoseconds: counts.load, totalDurationNanoseconds: counts.total,
        } as unknown as CanonicalValue,
      };
    };

    for (;;) {
      if (request.shouldCancel?.()) { failure = { kind: 'cancelled', detail: 'the run was paused or aborted before this attempt finished' }; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { failure = { kind: 'timeout', detail: `the attempt's ${request.timeoutMilliseconds} ms deadline passed` }; break; }
      if (turns >= maximumTurns) {
        failure = { kind: 'exitFailure', detail: `the model used all ${maximumTurns} turns this harness allows without finishing` };
        break;
      }
      turns += 1;
      let reply: JSONObject;
      try {
        reply = await client.chat({
          model: this.options.requestedModelID, messages, tools, stream: false,
          options: {
            num_predict: this.options.outputTokensPerTurn ?? OLLAMA_WORKSPACE_OUTPUT_TOKENS_PER_TURN,
            // THE WINDOW CERNUM ALREADY MEASURED. Without this the runtime opens its own default
            // window — 4_096 on current Ollama — whatever the model can actually do, and a workspace
            // conversation that outgrows it is TRUNCATED: the user turn falls off the front and the
            // request is rejected for having no user query in it. Absent when the runtime published
            // no context length, so an unknown stays unknown rather than becoming a number.
            ...(contextWindowTokens === undefined ? {} : { num_ctx: contextWindowTokens }),
            ...(request.temperatureMilli === undefined ? {} : { temperature: request.temperatureMilli / 1000 }),
            ...(request.seed === undefined ? {} : { seed: request.seed }),
          },
        }, remaining, request.shouldCancel);
      } catch (error) {
        const unavailable = error instanceof OllamaRuntimeUnavailable ? error : undefined;
        const cancelled = request.shouldCancel?.() === true;
        failure = cancelled ? { kind: 'cancelled', detail: 'the run was paused or aborted mid-turn' }
          : Date.now() >= deadline ? { kind: 'timeout', detail: `the attempt's ${request.timeoutMilliseconds} ms deadline passed mid-turn` }
            : unavailable?.kind === 'modelNotFound' ? { kind: 'notInstalled', detail: `LOCAL RUNTIME: ${unavailable.message}` }
              : unavailable?.kind === 'malformed' ? { kind: 'malformedOutput', detail: unavailable.message }
                : { kind: 'transport', detail: `LOCAL RUNTIME UNAVAILABLE mid-attempt: ${redactSecrets(error instanceof Error ? error.message : String(error))}` };
        break;
      }
      if (firstReplyMilliseconds === undefined) firstReplyMilliseconds = Date.now() - startedAt;
      if (typeof reply.model === 'string' && reply.model.length > 0) reported.push(reply.model);
      const prompt = asNumber(reply.prompt_eval_count); if (prompt !== undefined) counts.prompt.push(prompt);
      const evaluated = asNumber(reply.eval_count); if (evaluated !== undefined) counts.evaluated.push(evaluated);
      const total = asNumber(reply.total_duration); if (total !== undefined) counts.total.push(total);
      const load = asNumber(reply.load_duration); if (load !== undefined) counts.load.push(load);

      const message = isObject(reply.message) ? reply.message : undefined;
      if (message === undefined) { failure = { kind: 'malformedOutput', detail: 'the runtime replied with no message object' }; break; }
      const content = typeof message.content === 'string' ? message.content : '';
      const thinking = typeof message.thinking === 'string' ? message.thinking : '';
      if (thinking.length > 0) {
        thinkingSeen = true;
        request.transcript.emit('message', 'agentReported', request.attemptIndex, thinking,
          { channel: 'thinking', textDigest: sha256Text(thinking), textByteCount: Buffer.byteLength(thinking, 'utf8') });
      }
      if (content.length > 0) {
        request.transcript.emit('message', 'agentReported', request.attemptIndex, content,
          { channel: 'visible', textDigest: sha256Text(content), textByteCount: Buffer.byteLength(content, 'utf8') });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
      messages.push({ role: 'assistant', content, ...(calls.length > 0 ? { tool_calls: calls } : {}) } as ChatMessage);
      if (calls.length === 0) { finalMessage = content.trim().length > 0 ? content.trim() : undefined; break; }

      for (const [index, call] of calls.entries()) {
        const fn = isObject(call.function) ? call.function : {};
        const name = typeof fn.name === 'string' ? fn.name : 'unknown';
        let args: JSONObject = {};
        if (isObject(fn.arguments)) args = fn.arguments;
        else if (typeof fn.arguments === 'string') { try { const parsed = JSON.parse(fn.arguments); if (isObject(parsed)) args = parsed; } catch { /* reported below */ } }
        const callID = `turn${turns}-call${index}`;
        request.transcript.emit('toolCall', 'agentReported', request.attemptIndex, `${name} ${typeof args.path === 'string' ? args.path : typeof args.check_id === 'string' ? args.check_id : ''}`.trim(),
          { toolName: name, callID, argumentsDigest: sha256Text(JSON.stringify(args)) });
        const output = await this.carryOut(name, args, request, callID, tools);
        request.transcript.emit('toolResult', 'engineObserved', request.attemptIndex, output.text.length === 0 ? '(no output)' : output.text,
          { callID, ok: output.ok, byteCount: Buffer.byteLength(output.text, 'utf8') });
        messages.push({ role: 'tool', content: output.text, tool_name: name } as ChatMessage);
      }
    }

    // THE DIGEST AGAIN, after the last turn. A model re-pulled mid-run would otherwise be scored as the first one.
    let digestAfter: string | undefined;
    try { digestAfter = (await client.model(this.options.requestedModelID)).digest; } catch { digestAfter = undefined; }
    const reportedModelID = reported[reported.length - 1] ?? '';
    const substituted = reported.find((name) => verifyProviderIdentity(this.options.requestedModelID, name).state === 'substituted');
    if (failure === undefined && substituted !== undefined) {
      failure = { kind: 'policyNotExpressible', detail: `the runtime named ${substituted} as the answering model and `
        + `${this.options.requestedModelID} was requested; the attempt is refused and the served model kept` };
    }
    if (failure === undefined && digestAfter !== undefined && digestAfter !== model.digest) {
      failure = { kind: 'policyNotExpressible', detail: `the weights digest changed during the attempt (${model.digest} → ${digestAfter}); `
        + 'the work was done by weights this binding does not describe' };
    }

    return {
      completed: failure === undefined,
      finalMessage,
      failure,
      reportedModelID,
      unexpressed, notEnforceable,
      activeIsolation: [...baseIsolation, `runtime ${runtimeVersion ?? '(version unreported)'} · weights digest ${model.digest} `
        + `verified before the first turn${digestAfter === undefined ? '' : ' and after the last'}`, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      usage: usage(),
      events: events(),
    };
  }

  /** Carry out one tool call. Every path is confined; every effect is Cernum's own. */
  private async carryOut(name: string, args: JSONObject, request: WorkspaceAgentRequest, callID: string,
                         offered: OllamaToolDefinition[]): Promise<{ ok: boolean; text: string }> {
    const root = request.workspaceRoot;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    if (!offered.some((tool) => tool.function.name === name)) {
      return { ok: false, text: `'${name}' is not a tool offered here. Offered: ${offered.map((tool) => tool.function.name).join(', ')}` };
    }
    try {
      switch (name) {
        case 'list_files': {
          const files = listFiles(root, text(args.path));
          return { ok: true, text: files.join('\n') };
        }
        case 'read_file': {
          const relative = text(args.path);
          const target = resolveInside(root, relative);
          const bytes = fs.readFileSync(target);
          request.transcript.emit('fileRead', 'engineObserved', request.attemptIndex, `read ${relative}`,
            { path: relative, toolName: name, callID, afterSHA256: sha256Text(bytes.toString('utf8')) });
          const body = bytes.subarray(0, OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES).toString('utf8');
          return { ok: true, text: bytes.length > OLLAMA_WORKSPACE_MAXIMUM_READ_BYTES ? `${body}\n…[truncated]` : body };
        }
        case 'write_file': case 'replace_in_file': {
          const relative = text(args.path);
          const target = resolveInside(root, relative);
          const beforeContents = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
          let contents: string;
          if (name === 'write_file') {
            contents = text(args.content);
          } else {
            const oldText = text(args.old_text);
            if (beforeContents === undefined) return { ok: false, text: `${relative} does not exist` };
            const at = oldText.length === 0 ? -1 : beforeContents.indexOf(oldText);
            if (at < 0) return { ok: false, text: `old_text was not found in ${relative}` };
            if (beforeContents.indexOf(oldText, at + 1) >= 0) return { ok: false, text: `old_text occurs more than once in ${relative}` };
            contents = beforeContents.slice(0, at) + text(args.new_text) + beforeContents.slice(at + oldText.length);
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, contents);
          request.transcript.emit('fileWrite', 'engineObserved', request.attemptIndex, `wrote ${relative}`, {
            path: relative, toolName: name, callID,
            beforeSHA256: beforeContents === undefined ? undefined : sha256Text(beforeContents),
            afterSHA256: sha256Text(contents), byteCount: Buffer.byteLength(contents, 'utf8'),
          });
          return { ok: true, text: `wrote ${relative} (${Buffer.byteLength(contents, 'utf8')} bytes)` };
        }
        case 'run_check': {
          const runner = request.sealedChecks;
          if (runner === undefined) return { ok: false, text: 'this case has no checks to run' };
          const outcome = await runner.run(text(args.check_id));
          if (!outcome.known) return { ok: false, text: outcome.detail };
          return { ok: outcome.passed, text: `${outcome.checkID}: ${outcome.passed ? 'PASSED' : outcome.timedOut ? 'TIMED OUT' : `FAILED (exit ${outcome.exitCode ?? 'none'})`}\n${outcome.output}` };
        }
        default:
          return { ok: false, text: `'${name}' is not a tool this harness implements` };
      }
    } catch (error) {
      // A refused path is the ENGINE saying no, recorded as a boundary refusal as well as told to the model.
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      if (/outside|escape|symlink|resolve/i.test(detail)) {
        request.transcript.emit('boundaryRefusal', 'engineObserved', request.attemptIndex, detail, { path: text(args.path) });
      }
      return { ok: false, text: detail };
    }
  }
}

/** The lines a preflight prints about what this driver will do. */
export function describeOllamaInvocation(driver: OllamaWorkspaceDriver, tools: ToolPolicy,
                                         checks: { id: string; kind: string }[]): string[] {
  return [
    `endpoint        ${driver.endpoint} (loopback only)`,
    `harness         ${OLLAMA_WORKSPACE_HARNESS_VERSION}`,
    `tools           ${ollamaWorkspaceTools(tools, checks).map((tool) => tool.function.name).join(', ') || '(none)'}`,
    `commands        ${OLLAMA_COMMANDS_ARE_SEALED_CHECKS_ONLY}`,
    `identity        ${OLLAMA_IDENTITY_IS_THE_DIGEST}`,
    `privacy         ${OLLAMA_STAYS_ON_THIS_MACHINE}`,
  ];
}
