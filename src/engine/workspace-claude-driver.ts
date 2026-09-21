// Benchmark engine · driving the installed `claude` CLI against a disposable workspace.
//
// THE FIRST REAL PROVIDER ON THE AGENTIC SIDE. Everything below was read off the CLI that is
// installed on this machine — `claude --version` reports 2.1.278, and every flag, every required
// combination and every field name here came from `claude --help` and from the binary's own
// argument and message schemas. Nothing is carried over from memory, and where the tool's behaviour
// could not be established without spending a request, this file RECORDS THE GAP rather than
// guessing at it.
//
// WHAT THE INVOCATION IS, AND WHY EACH PART OF IT IS THERE
//
//   -p --output-format stream-json --verbose
//       The machine-readable stream. `--verbose` is NOT optional: the CLI refuses the combination
//       without it — `Error: When using --print, --output-format=stream-json requires --verbose`.
//       It does not make the stream chattier in a way that matters here; it is the gate.
//   --safe-mode
//       Every customization off: CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and
//       agents, output styles, workflows. AUTH IS UNAFFECTED, which is exactly why this rather than
//       `--bare`: `--bare` also switches Anthropic auth to `ANTHROPIC_API_KEY`/`apiKeyHelper` and
//       never reads the OAuth session, which would turn a run recorded as subscription-included into
//       a metered one — the single worst thing this file could do. `--bare` is therefore REFUSED
//       here, permanently, and this comment is the reason.
//   --restricted
//       Confines the FILE tools to the working directories, ignores user, project and local settings
//       files, and refuses `bypassPermissions`. This is the only filesystem rooting control the CLI
//       documents, and it covers the file tools ONLY — see `CLAUDE_SHELL_IS_NOT_CONFINED`.
//   --tools <derived>
//       The built-in tool set, named explicitly from the case's `ToolPolicy`. `--restricted` removes
//       the code-running tools unless `--tools` names them, so `Bash` appears here exactly when the
//       case declares `commandExecution`. WebFetch and WebSearch are never named, so they are gone.
//   --allowedTools <derived>
//       The pre-approvals. With `--permission-mode dontAsk` this is the whole permission surface.
//   --permission-mode dontAsk --permission-prompts none
//       "Don't prompt for permissions, DENY if not pre-approved." This is the narrowest mode that
//       can complete a coding task non-interactively, and it is deliberately NOT
//       `--dangerously-skip-permissions` / `bypassPermissions`, whatever an interactive development
//       session on this machine happens to use. A benchmark that bypassed every check would be
//       measuring a model that was allowed to do anything, and would say nothing about one that was
//       not. `--permission-prompts none` is belt and braces: nothing can block waiting for a human.
//   --strict-mcp-config --setting-sources '' --disable-slash-commands --no-session-persistence
//       No MCP servers, no settings files, no skills, and nothing written into the user's session
//       store. `--safe-mode` and `--restricted` already cover most of this; they are stated anyway,
//       because "the request ran with nothing of this machine in it" should be a fact about the
//       ENGINE rather than a fact about which flag happened to win.
//   --model <requestedModelID>
//       What was frozen. NO `--fallback-model`, ever: a fallback is a silent substitution, and the
//       identity ladder exists to refuse exactly that.
//
//   The INSTRUCTION goes on stdin, never in argv — the same rule the prose adapter follows, and for
//   the same reason: argv is visible in the process table to every process on this machine.
//
// WHAT THIS DRIVER OBSERVES, AND WHAT IT ONLY HEARS
//
// Every event this file emits is `agentReported`. All of them. A `tool_use` block saying `Edit` is
// the tool stating that it asked for an edit; a `Bash` block is the tool stating that it asked to
// run something. Neither is a filesystem observation, and labelling one `engineObserved` would put
// a model's own account of its work into the record the scorer reads. The engine's observations —
// the tree diff, the verification runs, the baseline check, the attempt boundaries, the wall clock —
// are made in `workspace-execution.ts`, by code that never sees this stream.
//
// WHERE THE STREAM DOES NOT ANSWER, THE LIMITATION IS RECORDED. `Grep` and `Glob` read files and are
// not reported as file reads, because the tool names a pattern and not the files it touched. A
// `Bash` command is a shell STRING, not an argv, so the executable is parsed out conservatively and
// `CLAUDE_COMMAND_REPORTING_IS_A_STRING` says so on every run. None of it is invented.

import { sha256Text } from './canonical';
import { CLIResult, CLIRunOptions, findExecutable, runCLI } from './cli-process';
import { redactSecrets } from './redaction';
import { EffortLevel, ProviderID } from './provider';
import {
  CLAUDE_CLI_EFFORT_LEVELS, ParsedSubscriptionCLIResponse, detectEffortSubstitution, parseCLIResponse,
  resolveAnsweringModel, totalInputTokens,
} from './frontier-adapter';
import { NetworkPolicy, ToolPolicy } from './workspace-case';
import {
  WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, WorkspaceAgentCapabilities, WorkspaceAgentDriver,
  WorkspaceAgentFailureKind, WorkspaceAgentRequest, WorkspaceAgentResult,
} from './workspace-agent';
import { WorkspaceAgentUsage } from './workspace-host';
import { EventProvenance, TranscriptEvent, TranscriptEventKind } from './workspace-transcript';

export const CLAUDE_WORKSPACE_DRIVER_ID = 'driver.claude-cli.workspace';

/**
 * The installed CLI these arguments were read from.
 *
 * Recorded because it is the ONLY thing that makes the rest of this file checkable. A flag set
 * derived from a tool's `--help` is true of that tool's version and of nothing else, and a reader
 * who finds this file disagreeing with their `claude --help` needs to know which one moved.
 */
export const CLAUDE_CLI_VERSION_VERIFIED_AGAINST = '2.1.278';

/** The built-in tool names this driver may name. Read off the CLI's own documentation, not guessed. */
export const CLAUDE_TOOL_FOR = {
  fileRead: ['Read', 'Glob', 'Grep'],
  fileWrite: ['Write', 'Edit'],
  commandExecution: ['Bash'],
} as const;

export const CLAUDE_SHELL_IS_NOT_CONFINED =
  '--restricted confines the FILE tools (Read, Write, Edit, Glob, Grep) to the working directory. It does not '
  + 'confine Bash: a shell can cd anywhere the process can reach, and no flag this CLI documents changes that. The '
  + 'workspace boundary is therefore OBSERVED rather than asserted — the pristine baseline copy is re-digested after '
  + 'every attempt, and a byte of difference in it fails the attempt as a workspace escape.';

export const CLAUDE_NETWORK_IS_NOT_EXPRESSIBLE =
  'this CLI documents no network switch. WebFetch and WebSearch are withheld by not naming them in --tools, which '
  + 'removes the network-reaching TOOLS — it is not a network boundary, because Bash can still reach the network. '
  + 'The case\'s networkPolicy is recorded as a declaration and never as an enforcement.';

export const CLAUDE_COMMAND_REPORTING_IS_A_STRING =
  'this CLI reports a Bash tool call as a single shell command STRING, not as an executable and an argv. The '
  + 'executables recorded for such a call are parsed out of that string by splitting it on the shell operators that '
  + 'appear outside quotes; a command built at run time, or one hidden behind a script, names an executable this '
  + 'parse cannot see. The executable allow-list is therefore a DETECTION, and the verdict rests on the final tree.';

export const CLAUDE_OUTPUT_IS_NOT_BOUNDED =
  'this CLI has no output-token budget flag that applies to a subscription session (--max-budget-usd caps dollars '
  + 'for API-key users), so nothing caps how much allowance one attempt may consume. The allowance spent is real and '
  + 'is recorded; it was not bounded.';

export const CLAUDE_DEADLINE_IS_CERNUMS =
  'the attempt deadline is enforced by Cernum — the child is started in its own process group and the group is '
  + 'signalled at the deadline. This CLI documents no per-invocation wall-clock limit of its own, so a timeout is an '
  + 'observation of this engine stopping the tool, never of the tool stopping itself.';

/**
 * What this driver can actually do, declared against the installed CLI rather than against intent.
 *
 * `expressesNetworkPolicy` IS FALSE, and that is the one that matters. The harness would like to say
 * a workspace attempt had no network; this CLI gives it no way to say so, and marking the capability
 * true because the benchmark wants it would make `driverShortfalls` wave through a case declaring
 * `networkPolicy: 'denied'` under a control that does not exist. False here means such a case is
 * refused before anything is spent, which is the correct outcome.
 */
export const CLAUDE_WORKSPACE_CAPABILITIES: WorkspaceAgentCapabilities = {
  // Told where to work by cwd, and `--restricted` confines the file tools to it. Not the shell.
  rootsToDirectory: true,
  canReadFiles: true,
  canWriteFiles: true,
  canExecuteCommands: true,
  // One `-p` invocation runs the whole agentic loop: it re-reads, re-runs and re-edits on its own.
  canIterateWithinOneInvocation: true,
  // `tool_use` blocks in the stream name every tool it asked for.
  reportsToolCalls: true,
  // `modelUsage` on the result message names every model that took part, with a canonical alias.
  reportsModelIdentity: true,
  // `--tools`, `--allowedTools` and `--disallowedTools` cover every field of `ToolPolicy`.
  expressesToolPolicy: true,
  expressesNetworkPolicy: false,
};

// MARK: - Arguments

export interface ClaudeWorkspaceArguments {
  args: string[];
  /**
   * Frozen settings this CLI cannot express. NON-EMPTY MEANS THE REQUEST IS NOT SENT: an attempt run
   * under settings the case did not authorise is worse than no attempt.
   */
  unexpressed: string[];
  /** Settings that were sent and are not enforced. Recorded on every attempt; never a refusal. */
  notEnforceable: string[];
  /** The isolation actually applied, flag by flag, for the evidence file. */
  activeIsolation: string[];
  /** The `--tools` list, exposed so a preflight can print it without re-deriving it. */
  toolNames: string[];
  /** The `--allowedTools` rules, same reason. */
  allowedToolRules: string[];
}

export interface ClaudeArgumentOptions {
  tools: ToolPolicy;
  networkPolicy: NetworkPolicy;
  /** What was frozen. Empty means the binding named no model, which this CLI reads as its default. */
  requestedModelID: string;
  /** `'none'` when the binding froze no effort level. */
  effort?: EffortLevel;
  temperatureMilli?: number;
  seed?: number;
}

/**
 * The exact argument vector, derived from the case's policy and the installed CLI's flags.
 *
 * PURE, so every assertion about what this engine sends can be made in a test with no process and no
 * request. The one thing it deliberately does NOT do is put the instruction anywhere: that goes on
 * stdin, in `run`.
 */
export function buildClaudeWorkspaceArguments(options: ClaudeArgumentOptions): ClaudeWorkspaceArguments {
  const unexpressed: string[] = [];
  const notEnforceable: string[] = [];
  const activeIsolation: string[] = [];

  const toolNames: string[] = [];
  if (options.tools.fileRead) toolNames.push(...CLAUDE_TOOL_FOR.fileRead);
  if (options.tools.fileWrite) toolNames.push(...CLAUDE_TOOL_FOR.fileWrite);
  if (options.tools.commandExecution) toolNames.push(...CLAUDE_TOOL_FOR.commandExecution);

  // THE PRE-APPROVALS, AND NOTHING ELSE. Under `dontAsk` every tool call that is not matched here is
  // denied rather than escalated, so this list is the complete statement of what the model may do.
  const allowedToolRules: string[] = [];
  if (options.tools.fileRead) allowedToolRules.push(...CLAUDE_TOOL_FOR.fileRead);
  if (options.tools.fileWrite) allowedToolRules.push(...CLAUDE_TOOL_FOR.fileWrite);
  if (options.tools.commandExecution) {
    if (options.tools.allowedExecutables.length === 0) {
      // The case named no executables, which its own comment defines as "whatever the driver
      // permits". Bare `Bash` is that, and the transcript still records every command named.
      allowedToolRules.push('Bash');
    } else {
      // `Bash(npm *)` is the wildcard form this CLI documents; `Bash(npm run:*)` is its legacy
      // prefix form. The wildcard form is used because it is the documented current one.
      for (const executable of options.tools.allowedExecutables) allowedToolRules.push(`Bash(${executable} *)`);
      notEnforceable.push(`the executable allow-list (${options.tools.allowedExecutables.join(', ')}) is expressed as `
        + `${options.tools.allowedExecutables.map((executable) => `Bash(${executable} *)`).join(', ')}. That matches the `
        + 'command the tool ASKS to run; a command that shells out to another executable from inside an approved one '
        + 'is not matched by it. ' + CLAUDE_COMMAND_REPORTING_IS_A_STRING);
    }
  }

  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    // REQUIRED. The CLI refuses `-p --output-format stream-json` without it.
    '--verbose',
    '--safe-mode',
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];

  // `--tools ""` disables every tool, which is what a case forbidding all three genuinely asks for.
  args.push('--tools', toolNames.join(','));
  if (allowedToolRules.length > 0) args.push('--allowedTools', allowedToolRules.join(','));

  if (options.requestedModelID.length > 0) args.push('--model', options.requestedModelID);

  if (options.effort !== undefined && options.effort !== 'none') {
    if (!CLAUDE_CLI_EFFORT_LEVELS.includes(options.effort)) {
      // Refused rather than sent: this CLI warns on stderr and answers at its DEFAULT effort with
      // exit 0, so a request sent under an unsupported level is a real answer at a setting the
      // manifest does not describe. `detectEffortSubstitution` catches the same thing after the fact.
      unexpressed.push(`effort '${options.effort}': this CLI documents only ${CLAUDE_CLI_EFFORT_LEVELS.join(', ')}, `
        + 'and silently falls back to its default for anything else');
    } else {
      args.push('--effort', options.effort);
    }
  }

  // Sampling is not expressible through this CLI. A case that froze one and ran anyway would be a
  // case whose digest describes a setting that never reached the tool.
  if (options.temperatureMilli !== undefined) {
    unexpressed.push(`temperature (${options.temperatureMilli} milli): this CLI accepts no sampling temperature`);
  }
  if (options.seed !== undefined) unexpressed.push(`seed (${options.seed}): this CLI accepts no sampling seed`);

  activeIsolation.push(
    `claude CLI arguments verified against ${CLAUDE_CLI_VERSION_VERIFIED_AGAINST}`,
    'working directory: the disposable workspace, and no --add-dir',
    '--restricted: file tools confined to the working directory; user, project and local settings ignored; '
      + 'bypassPermissions refused',
    '--safe-mode: CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents, output styles and workflows off '
      + '(auth unaffected)',
    '--permission-mode dontAsk with --permission-prompts none: anything not pre-approved is DENIED, never bypassed '
      + 'and never escalated to a human',
    `--tools ${toolNames.join(',') || '(none)'}: WebFetch, WebSearch and every other built-in are withheld`,
    `--allowedTools ${allowedToolRules.join(',') || '(none)'}`,
    '--strict-mcp-config, --setting-sources "", --disable-slash-commands, --no-session-persistence',
    'no --fallback-model: a fallback would be a silent model substitution',
    'no --bare: it switches Anthropic auth to an API key and would bill a run recorded as subscription-included',
    'the instruction is written to stdin, never to argv',
  );

  notEnforceable.push(
    CLAUDE_SHELL_IS_NOT_CONFINED,
    CLAUDE_OUTPUT_IS_NOT_BOUNDED,
    CLAUDE_DEADLINE_IS_CERNUMS,
  );
  if (options.networkPolicy !== 'unrestricted') notEnforceable.push(CLAUDE_NETWORK_IS_NOT_EXPRESSIBLE);

  return { args, unexpressed, notEnforceable, activeIsolation, toolNames, allowedToolRules };
}

// MARK: - The stream

/**
 * One line of `--output-format stream-json`, or nothing.
 *
 * Never throws and never guesses. A line that is not a JSON object is ignored: this CLI writes its
 * warnings to stderr, but a future one that interleaved a banner on stdout must not be able to make
 * an attempt look malformed.
 */
export function parseClaudeStreamLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** One event this driver would like emitted. Always `agentReported` — see the header. */
export interface PlannedEvent {
  kind: TranscriptEventKind;
  provenance: EventProvenance;
  detail: string;
  payload: Partial<TranscriptEvent>;
}

const AGENT_REPORTED: EventProvenance = 'agentReported';

/** The file-path argument a tool call names, when it names one. */
function pathArgument(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Split a shell command into the segments a separate executable could run in.
 *
 * CONSERVATIVE BY CONSTRUCTION. It splits on `&&`, `||`, `|`, `|&`, `;`, a background `&` and
 * newlines that appear OUTSIDE single quotes, double quotes and backslash escapes, and it does
 * nothing else — no variable expansion, no substitution, no understanding of `$(...)`. That is
 * deliberate: a parser that tried to be clever would produce confident wrong answers about what ran,
 * and what this is for is naming the executables that were VISIBLY asked for. Everything it cannot
 * see is covered by `CLAUDE_COMMAND_REPORTING_IS_A_STRING` and by the fact that the verdict comes
 * from the tree.
 *
 * AN `&` INSIDE A REDIRECTION IS NOT A SEPARATOR. `node test/x.js 2>&1` is one command, and treating
 * its `&` as "run in the background" split it into `node test/x.js 2>` and `1` — so a transcript
 * reported an executable called `1`. The redirection forms are recognised by their neighbours: an
 * `&` straight after `>` or `<` duplicates a descriptor (`2>&1`, `>&2`, `<&3`), and an `&` straight
 * before `>` redirects both streams (`&>file`, `&>>file`). Only an `&` that is neither is a separator.
 */
export function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { current += character; escaped = true; continue; }
    if (quote !== undefined) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||' || pair === '|&') { segments.push(current); current = ''; index += 1; continue; }
    if (character === '&') {
      const previous = current[current.length - 1];
      const redirection = previous === '>' || previous === '<' || command[index + 1] === '>';
      if (redirection) { current += character; continue; }
      segments.push(current); current = '';
      continue;
    }
    if (character === ';' || character === '|' || character === '\n') {
      segments.push(current); current = '';
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Split one segment into words, respecting quotes, without expanding anything. */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;
  const flush = () => { if (started) { words.push(current); current = ''; started = false; } };
  for (const character of segment) {
    if (escaped) { current += character; started = true; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote !== undefined) {
      if (character === quote) { quote = undefined; continue; }
      current += character; started = true; continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) { flush(); continue; }
    current += character; started = true;
  }
  flush();
  return words;
}

/** Leading `FOO=bar` assignments are the environment, not the executable. Skipped, and only these. */
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function commandInvocations(command: string): { executable: string; argv: string[] }[] {
  const invocations: { executable: string; argv: string[] }[] = [];
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    let index = 0;
    while (index < words.length && ENVIRONMENT_ASSIGNMENT.test(words[index])) index += 1;
    const executable = words[index];
    if (executable === undefined || executable.length === 0) continue;
    // A subshell or a redirection that opens a segment names no executable of its own.
    if (executable === '(' || executable === '{' || executable.startsWith('<') || executable.startsWith('>')) continue;
    invocations.push({ executable, argv: words.slice(index + 1) });
  }
  return invocations;
}

/** The text a content block carries, when it carries any. */
function blockText(block: Record<string, unknown>): string {
  for (const key of ['text', 'thinking']) {
    const value = block[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** A `tool_result` block's content, which this CLI writes as a string or as a list of text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => (typeof entry === 'object' && entry !== null ? blockText(entry as Record<string, unknown>) : ''))
      .filter((text) => text.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * Translate one stream message into transcript events.
 *
 * EVERY EVENT THIS RETURNS IS `agentReported`, unconditionally and by construction. There is no
 * branch in this function that can produce another provenance, which is what makes the rule
 * checkable rather than merely intended — and the transcript builder drops an engine-only kind from
 * a driver anyway, recording the attempt as a harness fault if one ever appears.
 *
 * The `result` message deliberately produces NO event. Its `result` field is the agent's answer of
 * record, and `runOneAttempt` emits the one `finalResponse` for it from `WorkspaceAgentResult.
 * finalMessage`, so that there is exactly one place an answer of record is written down.
 */
export function eventsFromClaudeMessage(message: Record<string, unknown>): PlannedEvent[] {
  const events: PlannedEvent[] = [];
  const type = message.type;

  if (type === 'assistant') {
    const inner = (message.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(inner.content) ? inner.content : [];
    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue;
      const block = raw as Record<string, unknown>;
      if (block.type === 'text' || block.type === 'thinking') {
        const text = blockText(block);
        if (text.length === 0) continue;
        events.push({
          kind: 'message',
          provenance: AGENT_REPORTED,
          detail: text,
          payload: {
            channel: block.type === 'thinking' ? 'thinking' : 'visible',
            textDigest: sha256Text(text),
            textByteCount: Buffer.byteLength(text, 'utf8'),
          },
        });
        continue;
      }
      if (block.type !== 'tool_use') continue;

      const toolName = typeof block.name === 'string' ? block.name : 'unknown';
      const callID = typeof block.id === 'string' ? block.id : undefined;
      const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>;
      // THE ARGUMENTS ARE DIGESTED, NEVER RECORDED VERBATIM. A tool call's input can carry a whole
      // file; the transcript records that a call was made with a particular input, not the input.
      const argumentsDigest = sha256Text(JSON.stringify(input));

      events.push({
        kind: 'toolCall',
        provenance: AGENT_REPORTED,
        detail: `${toolName}${pathArgument(input) === undefined ? '' : ` ${pathArgument(input)}`}`,
        payload: { toolName, callID, argumentsDigest },
      });

      // The derived events. Only where the tool NAMES the thing it touched: `Grep` and `Glob` name a
      // pattern, so they produce a tool call and no file read. Inventing one would be inventing a path.
      const targetPath = pathArgument(input);
      if (toolName === 'Read' && targetPath !== undefined) {
        events.push({
          kind: 'fileRead', provenance: AGENT_REPORTED,
          detail: `the tool reported reading ${targetPath}`, payload: { path: targetPath, toolName, callID },
        });
      } else if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') && targetPath !== undefined) {
        const contents = input.content;
        events.push({
          kind: 'fileWrite', provenance: AGENT_REPORTED,
          detail: `the tool reported writing ${targetPath}`,
          payload: {
            path: targetPath, toolName, callID,
            byteCount: typeof contents === 'string' ? Buffer.byteLength(contents, 'utf8') : undefined,
          },
        });
      } else if (toolName === 'Bash' && typeof input.command === 'string') {
        for (const invocation of commandInvocations(input.command)) {
          events.push({
            kind: 'commandExecuted', provenance: AGENT_REPORTED,
            detail: `${invocation.executable} ${invocation.argv.join(' ')}`.trim(),
            payload: {
              executable: invocation.executable, argv: invocation.argv, callID,
              // NO `exitCode`. The tool has not run it yet at this point in the stream, and the
              // summary counts a command with no recorded status as neither passed nor failed —
              // which is the truth. The `tool_result` that follows carries `ok`.
            },
          });
        }
      }
    }
    return events;
  }

  if (type === 'user') {
    const inner = (message.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(inner.content) ? inner.content : [];
    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue;
      const block = raw as Record<string, unknown>;
      if (block.type !== 'tool_result') continue;
      const text = toolResultText(block.content);
      events.push({
        kind: 'toolResult',
        provenance: AGENT_REPORTED,
        detail: text.length === 0 ? 'the tool reported a result with no text' : text,
        payload: {
          callID: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          ok: block.is_error !== true,
          byteCount: Buffer.byteLength(text, 'utf8'),
        },
      });
    }
    return events;
  }

  return events;
}

/** What the `system`/`init` message declared. The tool's own account of its configuration. */
export interface ClaudeSessionInit {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools: string[];
  mcpServerCount: number;
  apiKeySource?: string;
  claudeCodeVersion?: string;
}

export function readSessionInit(message: Record<string, unknown>): ClaudeSessionInit | undefined {
  if (message.type !== 'system' || message.subtype !== 'init') return undefined;
  const mcp = message.mcp_servers;
  return {
    cwd: typeof message.cwd === 'string' ? message.cwd : undefined,
    model: typeof message.model === 'string' ? message.model : undefined,
    permissionMode: typeof message.permissionMode === 'string' ? message.permissionMode : undefined,
    tools: Array.isArray(message.tools) ? message.tools.filter((name): name is string => typeof name === 'string') : [],
    mcpServerCount: Array.isArray(mcp) ? mcp.length : 0,
    apiKeySource: typeof message.apiKeySource === 'string' ? message.apiKeySource : undefined,
    claudeCodeVersion: typeof message.claude_code_version === 'string' ? message.claude_code_version : undefined,
  };
}

// MARK: - Usage

/**
 * The usage block, built from the SAME parser the prose adapter uses.
 *
 * `parseCLIResponse` was written against this tool's envelope and already knows the five things Pass
 * 4B got wrong about it — that `model` does not exist and identity lives in `modelUsage`, that
 * thinking tokens are nested, that the cache counters exist and dominate, that `total_cost_usd` is
 * present on a subscription run, and that `subtype` says "success" on a refusal. A second parser
 * here would be a second place for those five corrections to be forgotten, so there is not one: the
 * stream's LAST JSON object is the `result` message, which is exactly the envelope that parser
 * reads.
 */
export function claudeWorkspaceUsage(parsed: ParsedSubscriptionCLIResponse, extra: {
  requestedModelID: string;
  observedFirstOutputMilliseconds?: number;
  numTurns?: number;
}): WorkspaceAgentUsage {
  const identity = resolveAnsweringModel(extra.requestedModelID, parsed.participants);
  return {
    inputTokens: totalInputTokens(parsed.usage),
    freshInputTokens: parsed.usage.inputTokens,
    cacheCreationInputTokens: parsed.usage.cacheCreationInputTokens,
    cacheReadInputTokens: parsed.usage.cacheReadInputTokens,
    visibleOutputTokens: parsed.usage.visibleOutputTokens,
    reasoningTokens: parsed.usage.reasoningTokens,
    subscriptionIncludedUsageMicroUSD: parsed.subscriptionIncludedUsageMicroUSD,
    providerReportedTimeToFirstTokenMilliseconds: parsed.providerReportedTimeToFirstTokenMilliseconds,
    observedFirstOutputMilliseconds: extra.observedFirstOutputMilliseconds,
    providerReportedDurationMilliseconds: parsed.providerReportedDurationMilliseconds,
    providerReportedAPIDurationMilliseconds: parsed.providerReportedAPIDurationMilliseconds,
    identityState: identity.state,
    participantIDs: identity.participantIDs,
    terminalReason: parsed.terminalReason,
    apiErrorStatus: parsed.apiErrorStatus,
    numTurns: extra.numTurns,
    rawUsage: parsed.raw,
  };
}

// MARK: - The driver

export interface ClaudeWorkspaceDriverOptions {
  /** What Cernum will ASK for, taken from the frozen binding. Never chosen here. */
  requestedModelID: string;
  /** The frozen effort level. `'none'` or absent means the binding froze none. */
  effort?: EffortLevel;
  /** Resolved once, so a PATH change mid-run cannot swap the tool underneath it. */
  executablePath?: string;
  findExecutable?: (name: string) => string | undefined;
  /** Injected by the tests, so every branch below is reachable without a provider request. */
  run?: (options: CLIRunOptions) => Promise<CLIResult>;
}

export class ClaudeWorkspaceDriver implements WorkspaceAgentDriver {
  readonly driverID = CLAUDE_WORKSPACE_DRIVER_ID;

  readonly provider: ProviderID = 'claudeCLI';

  readonly capabilities = CLAUDE_WORKSPACE_CAPABILITIES;

  readonly executablePath?: string;

  private readonly runCLIProcess: (options: CLIRunOptions) => Promise<CLIResult>;

  constructor(private readonly options: ClaudeWorkspaceDriverOptions) {
    const locate = options.findExecutable ?? ((name: string) => findExecutable(name));
    this.executablePath = options.executablePath ?? locate('claude');
    this.runCLIProcess = options.run ?? runCLI;
  }

  /** The argument vector this driver would send for a given policy. For a preflight; no side effects. */
  argumentsFor(tools: ToolPolicy, networkPolicy: NetworkPolicy,
               sampling: { temperatureMilli?: number; seed?: number } = {}): ClaudeWorkspaceArguments {
    return buildClaudeWorkspaceArguments({
      tools,
      networkPolicy,
      requestedModelID: this.options.requestedModelID,
      effort: this.options.effort,
      temperatureMilli: sampling.temperatureMilli,
      seed: sampling.seed,
    });
  }

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    const startedAt = Date.now();
    const before = request.transcript.count;
    const events = () => request.transcript.build().events.slice(before);

    const plan = this.argumentsFor(request.tools, request.networkPolicy, {
      temperatureMilli: request.temperatureMilli,
      seed: request.seed,
    });

    const refuse = (kind: WorkspaceAgentFailureKind, detail: string,
                    extra: Partial<WorkspaceAgentResult> = {}): WorkspaceAgentResult => ({
      completed: false,
      failure: { kind, detail },
      reportedModelID: '',
      unexpressed: plan.unexpressed,
      notEnforceable: plan.notEnforceable,
      activeIsolation: [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX],
      elapsedMilliseconds: Date.now() - startedAt,
      events: events(),
      ...extra,
    });

    if (!this.executablePath) {
      return refuse('notInstalled',
        'the `claude` command is not on this machine\'s PATH. Cernum drives the official CLI you installed and '
        + 'authenticated yourself; it does not install one and does not reach the service any other way.');
    }
    if (plan.unexpressed.length > 0) {
      // BEFORE THE SPAWN. A run that sent this would produce a real patch under settings the case
      // does not describe, which is worse than no patch.
      return refuse('policyNotExpressible',
        `this case froze settings the claude CLI cannot express, so nothing was sent: ${plan.unexpressed.join('; ')}`);
    }

    // The stream, read line by line as it arrives, so an attempt killed at its deadline still leaves
    // every event up to the moment it died.
    let pending = '';
    let sessionInit: ClaudeSessionInit | undefined;
    let observedFirstOutputMilliseconds: number | undefined;
    const ingest = (line: string): void => {
      const message = parseClaudeStreamLine(line);
      if (message === undefined) return;
      sessionInit = sessionInit ?? readSessionInit(message);
      for (const planned of eventsFromClaudeMessage(message)) {
        request.transcript.emit(planned.kind, planned.provenance, request.attemptIndex, planned.detail, planned.payload);
      }
    };

    const result = await this.runCLIProcess({
      executable: this.executablePath,
      args: plan.args,
      // STDIN, NEVER ARGV. Anything in argv is readable from the process table by every process on
      // this machine, and the instruction is the thing being measured.
      input: request.instruction,
      timeoutMilliseconds: request.timeoutMilliseconds,
      // THE DISPOSABLE WORKSPACE, AND NOTHING ELSE. No `--add-dir`, so this is the whole of what
      // `--restricted` confines the file tools to.
      workingDirectory: request.workspaceRoot,
      // THE WHOLE ENVIRONMENT, REPLACED. The runner already built it from the case's allow-list;
      // this driver adds nothing, which is what keeps `environmentAllowlist` the complete statement.
      replaceEnvironment: request.environment,
      shouldCancel: request.shouldCancel,
      onFirstOutput: (at) => { observedFirstOutputMilliseconds = at; },
      onChunk: (chunk) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          ingest(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      },
    });
    if (pending.trim().length > 0) ingest(pending);

    // THE INIT MESSAGE IS READ FROM THE COLLECTED STDOUT TOO, not only from the chunks as they
    // arrived. Reading it only while streaming made the working-directory check depend on WHETHER
    // the output was delivered in pieces — a tool that flushed everything at exit, or a transport
    // that handed this driver one complete buffer, would silently skip the one check that catches a
    // run answered in the wrong tree. A check that is only sometimes performed is not a check.
    if (sessionInit === undefined) {
      for (const line of result.stdout.split('\n')) {
        const message = parseClaudeStreamLine(line);
        if (message === undefined) continue;
        const init = readSessionInit(message);
        if (init !== undefined) { sessionInit = init; break; }
      }
    }

    const parsed = parseCLIResponse(result.stdout);
    const usage = parsed === undefined ? undefined : claudeWorkspaceUsage(parsed, {
      requestedModelID: this.options.requestedModelID,
      observedFirstOutputMilliseconds,
      numTurns: undefined,
    });
    const isolation = [...plan.activeIsolation, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX];
    if (sessionInit !== undefined) {
      isolation.push(`the CLI reported its session as: cwd ${sessionInit.cwd ?? '(unstated)'} · model `
        + `${sessionInit.model ?? '(unstated)'} · permission mode ${sessionInit.permissionMode ?? '(unstated)'} · `
        + `tools ${sessionInit.tools.join(',') || '(none)'} · ${sessionInit.mcpServerCount} MCP server(s) · `
        + `version ${sessionInit.claudeCodeVersion ?? '(unstated)'}. This is the tool's own account of its `
        + 'configuration, recorded beside what Cernum asked for rather than in place of it.');
    }

    const finish = (kind: WorkspaceAgentFailureKind | undefined, detail: string): WorkspaceAgentResult => ({
      completed: kind === undefined,
      finalMessage: parsed !== undefined && !parsed.isError && parsed.answerText.length > 0 ? parsed.answerText : undefined,
      failure: kind === undefined ? undefined : { kind, detail },
      reportedModelID: kind === undefined || kind === 'malformedOutput'
        ? resolveAnsweringModel(this.options.requestedModelID, parsed?.participants ?? []).reportedModelID
        : '',
      unexpressed: plan.unexpressed,
      notEnforceable: plan.notEnforceable,
      activeIsolation: isolation,
      elapsedMilliseconds: result.elapsedMilliseconds,
      usage,
      events: events(),
    });

    // 1. THE DEADLINE AND THE CANCELLATION COME FIRST, because neither produced a finished envelope
    //    and reading one as a refusal would misname an unfinished measurement.
    if (result.failure?.kind === 'timeout') {
      return finish('timeout', `the attempt's ${request.timeoutMilliseconds} ms deadline passed with the tool still `
        + `working. ${CLAUDE_DEADLINE_IS_CERNUMS} Everything it had reported up to that moment is in the transcript.`);
    }
    if (result.failure?.kind === 'cancelled') {
      return finish('cancelled', 'the run was paused or aborted before this attempt finished');
    }
    if (result.failure?.kind === 'notInstalled' || result.failure?.kind === 'spawnFailure') {
      return finish(result.failure.kind === 'notInstalled' ? 'notInstalled' : 'spawnFailure',
        redactSecrets(result.failure.detail));
    }

    // 2. THE ENVELOPE'S OWN ERROR FLAGS, before the exit code. A refused model exits non-zero and
    //    STILL prints its documented result message; reading the shell's verdict first would turn a
    //    clean, machine-readable 404 into an opaque transport fault and lose the one field that says
    //    what happened. `subtype` is deliberately not consulted: it says "success" on a 404.
    if (parsed?.isError) {
      const status = parsed.apiErrorStatus;
      const kind: WorkspaceAgentFailureKind = status === 401 ? 'notAuthenticated'
        : status === 429 ? 'rateLimited'
          : 'transport';
      return finish(kind, `the CLI reported a failed turn (${parsed.terminalReason ?? 'no terminal reason'}`
        + `${status === undefined ? '' : `, HTTP ${status}`}): ${redactSecrets(parsed.answerText).slice(0, 400)}`);
    }

    // 3. An effort level the tool WARNED it was ignoring makes the work real and the BINDING false.
    const effortSubstituted = detectEffortSubstitution(result.stderr);
    if (effortSubstituted) return finish('policyNotExpressible', effortSubstituted);

    if (result.failure) {
      const both = `${result.stdout}\n${result.stderr}`;
      const unauthenticated = /not (?:logged|signed) in|unauthenticated|please (?:log|sign) in|no active session/i.test(both);
      const rateLimited = /rate.?limit|too many requests|429|quota|usage limit/i.test(both);
      const kind: WorkspaceAgentFailureKind = unauthenticated ? 'notAuthenticated' : rateLimited ? 'rateLimited' : 'exitFailure';
      return finish(kind, `${redactSecrets(result.failure.detail)}`
        + `${result.stderr ? ` — ${redactSecrets(result.stderr).slice(0, 500)}` : ''}`);
    }

    if (parsed === undefined) {
      return finish('malformedOutput',
        'the CLI exited successfully and its stream contains no result message in the documented form, so nothing '
        + 'here can say what it did or which model did it. Cernum refuses to scrape an unrecognised format: a '
        + 'benchmark that did would produce different results the next time the tool changed its wording.');
    }

    // 4. THE WORKING DIRECTORY THE TOOL SAYS IT USED. A mismatch means the request was answered
    //    somewhere other than the workspace this attempt made, and nothing about the model was
    //    measured — so it is an envelope failure rather than a result. The engine's own baseline
    //    check catches an escape after the fact; this catches the arrangement before anyone reads
    //    a clean diff and concludes the model did nothing.
    if (sessionInit?.cwd !== undefined && !sameDirectory(sessionInit.cwd, request.workspaceRoot)) {
      return finish('policyNotExpressible',
        `the CLI reported its working directory as '${sessionInit.cwd}', and this attempt's workspace is `
        + `'${request.workspaceRoot}'. The work was not done in the tree this attempt measures, so there is no `
        + 'reading of the model here.');
    }

    return finish(undefined, '');
  }
}

/** Two spellings of one directory, with the trailing separator and `/private` symlinking allowed for. */
function sameDirectory(a: string, b: string): boolean {
  const normalise = (value: string): string => value.replace(/\/+$/, '');
  const left = normalise(a);
  const right = normalise(b);
  if (left === right) return true;
  // macOS spells the OS temp directory `/var/folders/…` and `/private/var/folders/…` for the same
  // place. The runner realpaths its side; the tool may report either.
  return normalise(left.replace(/^\/private/, '')) === normalise(right.replace(/^\/private/, ''));
}

/** The lines a preflight prints about what this driver will do, before it does any of it. */
export function describeClaudeInvocation(driver: ClaudeWorkspaceDriver, plan: ClaudeWorkspaceArguments,
                                         workspaceRoot: string, environment: Record<string, string>): string[] {
  return [
    `executable      ${driver.executablePath ?? '(not found on PATH)'}`,
    `argv            claude ${plan.args.map((argument) => (argument === '' ? "''" : argument)).join(' ')}`,
    'stdin           the case instruction (never argv)',
    `cwd             ${workspaceRoot}`,
    `tools           ${plan.toolNames.join(', ') || '(none)'}`,
    `allowed         ${plan.allowedToolRules.join(', ') || '(none)'}`,
    'permission      dontAsk + permission-prompts none (deny anything not pre-approved)',
    `environment     ${Object.keys(environment).sort().join(', ') || '(empty)'}`,
    ...plan.activeIsolation.map((line) => `isolation       ${line}`),
    ...plan.notEnforceable.map((line) => `NOT ENFORCED    ${line}`),
  ] as string[];
}

