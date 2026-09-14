// Benchmark engine · the Codex subscription CLI, as it actually behaves.
//
// WHY THIS IS A SEPARATE FILE FROM THE CLAUDE READER. Pass 4B assumed one subscription-CLI shape and
// pointed both tools at it. Pass 5 corrected that shape against the real `claude` and left the Codex
// half explicitly UNVERIFIED, because no `codex` binary was installed on the machine. It is
// installed now, and the two tools agree about almost nothing: not the arguments, not the output
// format, not the usage field names, not the meaning of the input-token count, not how a refusal is
// signalled, and not what happens when an effort level is wrong. A single parser that tried to
// straddle both would be a parser that quietly got one of them wrong.
//
// VERIFIED AGAINST codex-cli 0.154.0 on 2026-09-13, against captured output rather than a guess.
//
// THE FOUR THINGS THIS TOOL WILL NOT TELL YOU, and which are therefore recorded as unknown rather
// than filled in:
//
//   WHICH MODEL ANSWERED   `codex exec --json` names no model, anywhere, in any event. Not in
//                          `thread.started`, not in `turn.completed`. So identity is `unverifiable`
//                          for every Codex candidate — NEVER `proven` — and the fact that the
//                          service accepted the `-m` flag is not evidence that it honoured it.
//   WHICH EFFORT APPLIED   the effort is sent and is validated by the SERVICE, but it is never
//                          echoed back. Accepted is not applied. Recorded as `unverifiable`.
//   WHAT IT COST           there is no cost field and no allowance figure. The run consumed a real,
//                          finite share of a ChatGPT plan and this tool declines to say how much.
//   WHAT ALLOWANCE REMAINS no rate-limit or quota event appears in the exec stream at all.
//
// THE ONE THING IT TELLS YOU THAT `claude` DOES NOT: it has a real, machine-readable model
// catalogue (`codex debug models`). That is a CATALOGUE, not an entitlement list — the service
// refuses models that are in it — so it narrows the plan and never proves a candidate.

import { CanonicalValue } from './canonical';
import { EffortLevel, ProviderBinding } from './provider';
import { FrontierUsage } from './frontier-adapter';
import { redactSecrets } from './redaction';

/**
 * The reasoning efforts the SERVICE accepts, quoted from its own 400.
 *
 * Sending `model_reasoning_effort="cernum_bogus"` returns, verbatim:
 *
 *   [ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'cernum_bogus'.
 *   Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.
 *
 * `minimal` is on that list and this engine did not model it before this pass. `ultra` is NOT on it
 * — see `CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT`.
 */
export const CODEX_SERVICE_EFFORT_LEVELS: EffortLevel[] =
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * WHY `ultra` IS NOT AVAILABLE TO A SINGLE-MODEL MEASUREMENT, in the tool's own terms.
 *
 * The model catalogue lists `ultra` among the supported reasoning levels for `gpt-6-astra`,
 * `gpt-5.6-sol` and `gpt-5.6-terra`, and describes it as "Maximum reasoning with automatic task
 * delegation". The SERVICE's reasoning-effort enum does not contain it. The two are consistent:
 * `ultra` is a client-side orchestration mode — the CLI carries an `orchestrator` configuration
 * block with `max_concurrent_threads_per_session`, `max_depth`, `default_subagent_model` and
 * `default_subagent_reasoning_effort` — in which the answer is produced by a tree of subagents that
 * may not all be the model under test.
 *
 * A benchmark row labelled with one model identifier must have been produced by one model. So the
 * highest effort a single-model candidate may request is `max`.
 */
export const CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT =
  '`ultra` is an orchestration mode, not a reasoning effort: the service\'s own effort enum does not contain it, and '
  + 'the catalogue describes it as "maximum reasoning with automatic task delegation". An ultra answer is produced by '
  + 'a tree of subagents whose members are not all the model under test, so it cannot be recorded as a measurement of '
  + 'that model. The highest single-agent effort is `max`.';

/**
 * Every isolation control this pass could find in the real CLI, and what each one shuts off.
 *
 * CODEX IS AN AGENTIC CLI AND THAT IS THE WHOLE PROBLEM. Run bare, it loads the user's
 * `config.toml` — which on the machine this was written for enables eight plugins and two MCP
 * servers — injects a skills catalogue into the developer prompt, reads `AGENTS.md` from the
 * working directory, persists a session, and may execute shell commands. Every one of those changes
 * what the model was asked, and none of them are in the manifest. A measurement taken through an
 * uncontrolled agent session is a measurement of the machine it ran on.
 *
 * `codex debug prompt-input`, run from an empty directory, shows the untreated case: a
 * `<skills_instructions>` block naming skills from the user's own plugin cache, with absolute paths
 * into their home directory.
 */
export interface CodexIsolation {
  /** A freshly created empty directory, so there is no AGENTS.md and no project content to read. */
  workingDirectory: string;
}

/**
 * The flags, with the reason each one is present.
 *
 * These are the installed CLI's OWN documented flags, read from `codex exec --help` on 0.154.0 —
 * not invented, and not carried over from the `claude` argument list, which shares none of them.
 */
export const CODEX_ISOLATION_FLAGS: { flag: string[]; shutsOff: string }[] = [
  { flag: ['--skip-git-repo-check'], shutsOff: 'the requirement to be inside a Git repository, so the run needs no repo and inherits no repository context' },
  { flag: ['--ephemeral'], shutsOff: 'session persistence: nothing about this turn is written to the session store' },
  { flag: ['--ignore-user-config'], shutsOff: '~/.codex/config.toml entirely — and with it the user\'s plugins, MCP servers, marketplaces, feature flags and project trust settings' },
  { flag: ['--ignore-rules'], shutsOff: 'user and project execpolicy `.rules` files' },
  { flag: ['-s', 'read-only'], shutsOff: 'every write a model-generated shell command could make' },
  { flag: ['-c', 'tools.web_search=false'], shutsOff: 'the web-search tool, so no answer can be assembled from a page fetched at measurement time' },
  { flag: ['--color', 'never'], shutsOff: 'ANSI escapes, which would otherwise land inside captured text' },
  { flag: ['--json'], shutsOff: 'prose output: every fact this engine reads comes from a JSONL event' },
];

/**
 * Arguments for one isolated, non-interactive Codex request.
 *
 * THE PROMPT IS NOT AMONG THEM. It goes on stdin — `codex exec` reads it from there and says so
 * ("Reading prompt from stdin...") — because anything in argv is visible in the process table to
 * every process on the machine.
 *
 * CORRECTIONS TO PASS 4B, which assumed `['exec', '--json', '--model', id]` and
 * `['--config', 'model_reasoning_effort=<effort>']`:
 *
 *   `--config`      IS NOT A FLAG. The real flag is `-c`/`--config` — Pass 4B's long form happens to
 *                   be right, but its VALUE was unquoted. `-c` parses the value as TOML, so
 *                   `model_reasoning_effort=high` is a bare token and
 *                   `model_reasoning_effort="high"` is a string. The bare form is accepted here,
 *                   but the quoted form is what the tool's own `--help` documents.
 *   ISOLATION       Pass 4B sent NONE of it. Every request would have carried the user's plugins,
 *                   MCP servers and skills into a benchmark that recorded none of them.
 *   `--model`       is accepted, but see the header: nothing confirms it was honoured.
 */
export function buildCodexExecArguments(binding: ProviderBinding, isolation: CodexIsolation):
  { args: string[]; unexpressed: string[]; notEnforceable: string[]; activeIsolation: string[] } {
  const unexpressed: string[] = [];
  const notEnforceable: string[] = [];
  const args = ['exec', '--json', '--color', 'never'];

  args.push('-C', isolation.workingDirectory);
  args.push('--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules');
  args.push('-s', 'read-only');
  args.push('-c', 'tools.web_search=false');

  if (binding.requestedModelID.length > 0) args.push('-m', binding.requestedModelID);

  if (binding.effort !== 'none') {
    if (!CODEX_SERVICE_EFFORT_LEVELS.includes(binding.effort)) {
      // Refused BEFORE the request, even though the service would refuse it too. The service's
      // refusal costs a round trip and an allowance slot to learn something already known here.
      unexpressed.push(`effort '${binding.effort}': the Codex service accepts only `
        + `${CODEX_SERVICE_EFFORT_LEVELS.filter((level) => level !== 'none').join(', ')}`
        + (binding.effort === 'ultra' as string ? `. ${CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT}` : ''));
    } else {
      args.push('-c', `model_reasoning_effort="${binding.effort}"`);
    }
  }

  // Same reasoning as the `claude` adapter, different tool: there is no output-token budget flag on
  // `codex exec` either. An unenforceable ceiling does not change what the model was asked, so it is
  // recorded rather than treated as a refusal.
  notEnforceable.push(`maxOutputTokens (${binding.maxOutputTokens}): \`codex exec\` has no output-token budget flag, `
    + 'so nothing caps this answer\'s length. Whatever allowance an over-long answer consumes is real — and, unlike '
    + 'the Claude CLI, this tool does not report how much, so it cannot even be recorded after the fact.');

  if (binding.sampling.temperatureMilli !== null) unexpressed.push('temperature: this CLI accepts no sampling temperature');
  if (binding.sampling.topPMilli !== null) unexpressed.push('topP: this CLI accepts no nucleus sampling setting');
  if (binding.sampling.seed !== null) unexpressed.push('seed: this CLI accepts no sampling seed');
  if (binding.thinkingMode === 'enabled' && binding.effort === 'none') {
    unexpressed.push('thinking: this CLI expresses reasoning as an effort level, and this binding froze thinking on '
      + 'without one, so there is no flag that means what the manifest says');
  }

  const activeIsolation = CODEX_ISOLATION_FLAGS.map((entry) => `${entry.flag.join(' ')} — ${entry.shutsOff}`);
  activeIsolation.push(`-C ${isolation.workingDirectory} — a freshly created empty directory: no Git repository, `
    + 'no AGENTS.md, no project instructions and no files the model could read');
  activeIsolation.push('prompt delivered on stdin — never in argv, where the process table would expose it');
  activeIsolation.push('OPENAI_API_KEY and CODEX_API_KEY removed from the child environment — both are read by this '
    + 'binary, and either one present could turn a run authorised as subscription-included into a metered charge');

  return { args, unexpressed, notEnforceable, activeIsolation };
}

/** One event from `codex exec --json`, as far as anything here is willing to assume. */
interface CodexEvent {
  type: string;
  item?: { id?: string; type?: string; text?: string; message?: string };
  usage?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
}

export interface ParsedCodexResponse {
  answerText: string;
  usage: FrontierUsage;
  raw?: CanonicalValue;
  /** True when the stream ended in `turn.failed`. */
  isError: boolean;
  /** The HTTP status from inside the error message's own JSON body, when it had one. */
  apiErrorStatus?: number;
  /** The service's message, unwrapped from its double encoding. */
  errorMessage?: string;
  /** `turn.failed`, `turn.completed`, or whatever the stream actually ended on. */
  terminalReason?: string;
  /**
   * Items the agent produced that are not its answer — a shell command, a file read, a web search.
   *
   * ANY ENTRY HERE IS CONTAMINATION. The measurement is supposed to be one model answering one
   * question; a turn in which a tool ran measured the tool as well, and the isolation envelope
   * failed. Recorded on the attempt rather than filtered out.
   */
  toolInvocations: string[];
}

/**
 * Read the JSONL stream.
 *
 * CORRECTION TO PASS 4B — AND TO PASS 5'S SHARED PARSER, WHICH WOULD HAVE FAILED HERE. The Claude
 * reader takes the LAST parseable object in the output and looks for `result` / `text` / `content` /
 * `message` on it. The last Codex object is `turn.completed`, which has NONE of those fields. Run
 * against this stream that parser returns `undefined`, and the adapter reports `malformedResponse`
 * for a request that succeeded perfectly.
 *
 * The answer and the usage arrive in DIFFERENT events, so every event is read and the stream is
 * folded — there is no single object to pick.
 */
export function parseCodexExecJSONL(stdout: string): ParsedCodexResponse | undefined {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as CodexEvent;
      if (typeof value === 'object' && value !== null && typeof value.type === 'string') events.push(value);
    } catch { /* a partial line; the documented events still have to parse */ }
  }
  if (events.length === 0) return undefined;

  let answerText = '';
  let usageBlock: Record<string, unknown> | undefined;
  let isError = false;
  let errorMessage: string | undefined;
  const toolInvocations: string[] = [];

  for (const event of events) {
    if (event.type === 'item.completed' && event.item) {
      const kind = event.item.type ?? '';
      if (kind === 'agent_message') {
        answerText = typeof event.item.text === 'string' ? event.item.text : answerText;
      } else if (kind === 'error') {
        // A client-side note (e.g. unknown model metadata), NOT the service's refusal. It is not
        // treated as the error, because treating it as one would report the wrong reason.
        continue;
      } else if (kind.length > 0 && kind !== 'reasoning') {
        toolInvocations.push(kind);
      }
    } else if (event.type === 'turn.completed') {
      usageBlock = event.usage;
    } else if (event.type === 'turn.failed') {
      isError = true;
      errorMessage = typeof event.error?.message === 'string' ? event.error.message : undefined;
    }
  }

  const terminal = events[events.length - 1]?.type;
  const service = errorMessage === undefined ? undefined : unwrapCodexError(errorMessage);

  return {
    answerText,
    usage: readCodexUsage(usageBlock),
    raw: (usageBlock ?? null) as CanonicalValue,
    isError,
    apiErrorStatus: service?.status,
    errorMessage: service?.message === undefined ? errorMessage : service.message,
    terminalReason: terminal,
    toolInvocations,
  };
}

/**
 * The service's error, which arrives DOUBLE-ENCODED: a JSON string inside a JSON field.
 *
 * `turn.failed.error.message` is not prose and is not an object — it is a string whose contents are
 * themselves a JSON document carrying `status` and a nested `error.message`. Reading the outer field
 * as the reason gives a wall of escaped JSON; reading it with a regex gives something that breaks
 * when the service reformats. It is parsed, and when it does not parse it is carried unchanged
 * rather than guessed at.
 */
export function unwrapCodexError(message: string): { status?: number; message?: string } {
  try {
    const parsed = JSON.parse(message) as { status?: unknown; error?: { message?: unknown; type?: unknown } };
    const status = typeof parsed.status === 'number' ? parsed.status : undefined;
    const inner = typeof parsed.error?.message === 'string' ? parsed.error.message : undefined;
    return { status, message: inner };
  } catch {
    return {};
  }
}

/**
 * Codex usage, decomposed so that `totalInputTokens()` stays true for BOTH tools.
 *
 * THE TWO CLIs MEAN OPPOSITE THINGS BY `input_tokens`, AND THIS IS THE CORRECTION THAT MATTERS MOST.
 *
 *   claude   `input_tokens` is the FRESH remainder. `cache_creation_input_tokens` and
 *            `cache_read_input_tokens` are ADDITIONAL, and the total is their sum. Pass 4B read the
 *            fresh field alone and recorded 9 tokens for a request that processed 6,560.
 *   codex    `input_tokens` is the TOTAL, and `cached_input_tokens` is a SUBSET OF IT.
 *
 * The proof is in the fixtures: `gpt-6-astra` at medium and at max both report
 * `input_tokens: 14713`, one having been served 6,400 cached tokens and the other none. Two equal
 * totals with different cached portions can only mean the cached portion is inside the total.
 *
 * Summing the Codex fields the way the Claude fields must be summed would have overstated that
 * request by 6,400 tokens — roughly 43% — and every allowance projection built on it.
 *
 * So the total is preserved and the fresh remainder is DERIVED. `cache_write_input_tokens` was zero
 * on every request this pass captured, so whether it too is inside the total is NOT established;
 * it is subtracted and clamped at zero, which keeps the total exact either way.
 */
export function readCodexUsage(usage: Record<string, unknown> | undefined): FrontierUsage {
  if (!usage) return {};
  const asNumber = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

  const total = asNumber(usage.input_tokens);
  const cachedRead = asNumber(usage.cached_input_tokens);
  const cacheWrite = asNumber(usage.cache_write_input_tokens);
  const fresh = total === undefined ? undefined
    : Math.max(0, total - (cachedRead ?? 0) - (cacheWrite ?? 0));

  return {
    inputTokens: fresh,
    cacheReadInputTokens: cachedRead,
    cacheCreationInputTokens: cacheWrite,
    visibleOutputTokens: asNumber(usage.output_tokens),
    // `reasoning_output_tokens`, not `output_tokens_details.thinking_tokens` (claude) and not
    // `usage.reasoning_tokens` (Pass 4B's guess, which matches neither tool).
    reasoningTokens: asNumber(usage.reasoning_output_tokens),
  };
}

// MARK: - Authentication

/** How this Codex session is authenticated, and NOTHING that says whose session it is. */
export interface CodexAuthStatus {
  /** `chatgpt`, `apikey`, or whatever else the tool reports. Never a token. */
  storedAuthMode: string;
  apiKeyStored: boolean;
  chatgptTokensStored: boolean;
  /** The doctor check's own verdict for the auth category. */
  status: string;
}

/**
 * Read the authentication mode from `codex doctor --json`.
 *
 * WHY THE DOCTOR AND NOT `codex login status`. Pass 4B assumed `codex login status --json`. THAT
 * COMMAND DOES NOT EXIST — 0.154.0 answers `error: unexpected argument '--json' found`. What
 * `codex login status` prints is one line of prose: `Logged in using ChatGPT`. This engine does not
 * read prose where a machine-readable field is required, and matching that sentence would be exactly
 * the defect Pass 5 removed from the Claude path.
 *
 * `codex doctor --json` is documented as "Emit a redacted machine-readable report" and its
 * `auth.credentials` check answers the question in four typed fields. It is the tool's own report
 * about its own credential store — nothing here opens `auth.json`, and there is no code path that
 * can.
 *
 * THE VALUES ARE STRINGS, NOT BOOLEANS. `"stored API key": "false"` is the string `false`, and
 * reading it as a boolean makes every session look like an API-key session.
 *
 * THE ACCOUNT'S PATH IS DROPPED HERE, AT THE BOUNDARY. The report carries an `auth file` value of
 * `/Users/<name>/.codex/auth.json`, which contains the account holder's name. The four fields that
 * answer the question are named one by one and everything else is left behind, rather than returning
 * the object and relying on a redaction step somebody later forgets.
 */
export function parseCodexDoctorAuth(stdout: string): CodexAuthStatus | undefined {
  let parsed: { checks?: Record<string, { status?: unknown; details?: Record<string, unknown> }> };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch {
    return undefined;
  }
  const check = parsed?.checks?.['auth.credentials'];
  if (!check || typeof check.details !== 'object' || check.details === null) return undefined;
  const details = check.details;
  const text = (key: string): string => (typeof details[key] === 'string' ? details[key] as string : '');
  const flag = (key: string): boolean => text(key).toLowerCase() === 'true';
  const mode = text('stored auth mode');
  if (mode.length === 0) return undefined;
  return {
    storedAuthMode: mode,
    apiKeyStored: flag('stored API key'),
    chatgptTokensStored: flag('stored ChatGPT tokens'),
    status: typeof check.status === 'string' ? check.status : '',
  };
}

/**
 * Whether this session may be used for a subscription-included preflight.
 *
 * REFUSES AN API-KEY SESSION, and the refusal is the point rather than a precaution. A Codex CLI
 * authenticated with an API key bills a card per token. A preflight that recorded
 * `billingBasis: subscriptionIncluded` and `marginalAPICharge: $0` while running against one would
 * be reporting a charge as free — the single worst thing this engine could get wrong about money.
 */
export function codexSubscriptionUsable(auth: CodexAuthStatus | undefined):
  { usable: boolean; reason: string } {
  if (!auth) {
    return {
      usable: false,
      reason: '`codex doctor --json` did not report an `auth.credentials` check in a form this engine can read, so how '
        + 'this session is authenticated is UNKNOWN. It is not assumed to be a subscription: an API-key session would '
        + 'bill a card per token, and a preflight that guessed wrong would record a real charge as $0.',
    };
  }
  if (auth.apiKeyStored || auth.storedAuthMode.toLowerCase().includes('api')) {
    return {
      usable: false,
      reason: `this Codex CLI is authenticated with an API key (stored auth mode '${auth.storedAuthMode}'), which bills `
        + 'per token against a card. This preflight measures SUBSCRIPTION execution and records a zero marginal charge, '
        + 'so it refuses to run against a metered session rather than mislabel what the request cost. Metered execution '
        + 'is a separate, separately authorised path with a pricing snapshot and a spending ceiling.',
    };
  }
  if (!auth.chatgptTokensStored) {
    return {
      usable: false,
      reason: `this Codex CLI reports auth mode '${auth.storedAuthMode}' but no stored ChatGPT tokens, so it is not a `
        + 'signed-in ChatGPT subscription session. Sign in with `codex login` yourself; Cernum does not carry out a '
        + 'sign-in and does not hold your session.',
    };
  }
  return {
    usable: true,
    reason: `authenticated with a ChatGPT subscription session (stored auth mode '${auth.storedAuthMode}', ChatGPT `
      + 'tokens present, no API key stored). Requests are subscription-included: the marginal API charge is zero and '
      + 'the plan allowance consumed is real, finite, and NOT reported by this tool.',
  };
}

// MARK: - Catalogue

export interface CodexCatalogueEntry {
  modelID: string;
  displayName: string;
  supportedEfforts: string[];
  /** `list` or `hide`. A hidden entry is an internal model, not a candidate. */
  visibility: string;
}

/**
 * Read `codex debug models`.
 *
 * A CATALOGUE IS NOT AN ENTITLEMENT LIST, and this function's callers are required to treat it as
 * the plan rather than the answer. The service refused `cernum-not-a-real-model` with "not supported
 * when using Codex with a ChatGPT account" — an account-level judgement the catalogue file cannot
 * make. So a model that appears here is `unproven`, exactly like a model named in the ladder, and
 * only a smoke test moves it. What the catalogue IS good for: knowing which efforts a model declares
 * before spending a round trip discovering that it does not accept one.
 */
export function parseCodexCatalogue(stdout: string): CodexCatalogueEntry[] {
  let parsed: { models?: unknown[] };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.models)) return [];
  const out: CodexCatalogueEntry[] = [];
  for (const row of parsed.models) {
    if (typeof row !== 'object' || row === null) continue;
    const entry = row as Record<string, unknown>;
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    if (slug.length === 0) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
    out.push({
      modelID: slug,
      displayName: typeof entry.display_name === 'string' ? entry.display_name : slug,
      supportedEfforts: levels
        .map((level) => (typeof level === 'object' && level !== null
          ? String((level as { effort?: unknown }).effort ?? '') : ''))
        .filter((effort) => effort.length > 0),
      visibility: typeof entry.visibility === 'string' ? entry.visibility : '',
    });
  }
  return out;
}

/**
 * The highest effort a SINGLE-MODEL candidate may request, from what the model declares.
 *
 * `ultra` is excluded wherever it appears — see `CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT`. Anything
 * the service's own enum does not contain is excluded too, so a catalogue that gains a level this
 * engine cannot send does not silently become a level it claims to have measured.
 */
export function highestSingleAgentEffort(entry: CodexCatalogueEntry): EffortLevel | undefined {
  const order: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const available = entry.supportedEfforts
    .filter((effort): effort is EffortLevel => (order as string[]).includes(effort))
    .filter((effort) => CODEX_SERVICE_EFFORT_LEVELS.includes(effort));
  let best: EffortLevel | undefined;
  for (const level of order) if (available.includes(level)) best = level;
  return best;
}

/** A human sentence for a Codex turn that ran a tool. Contamination is described, never dropped. */
export function describeCodexContamination(toolInvocations: string[]): string | undefined {
  if (toolInvocations.length === 0) return undefined;
  return `this turn invoked ${toolInvocations.length} tool(s) (${redactSecrets(toolInvocations.join(', '))}). The `
    + 'isolation envelope was supposed to make that impossible, so this attempt measured an agent session rather than '
    + 'one model answering one question, and it is not comparable with a turn that invoked none.';
}
