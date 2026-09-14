// Real `codex` CLI output, captured on 2026-09-13 from codex-cli 0.154.0, WITH EVERY PRIVATE VALUE
// REMOVED.
//
// PASS 5 COULD NOT CAPTURE THESE. No `codex` binary was installed when Pass 5 ran, so its Codex
// assumptions — inherited from Pass 4B — went into the report flagged as unverified. Several of them
// were wrong. These fixtures are the real envelopes those corrections are tested against.
//
// Thread ids are zeroed. Nothing else is touched, so a field that moves in a future CLI version
// breaks a test here rather than silently changing what a benchmark records.
//
// NO ACCOUNT IDENTIFIER EVER APPEARED IN THESE ENVELOPES. `codex exec --json` carries no email
// address, no organisation and no token. The one place an identifier could reach a file is the
// doctor report's `auth file` path, which contains the user's home directory name — and which the
// parser drops at the boundary rather than redacting later.

/* eslint-disable max-len */

const THREAD = '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000000"}';

/**
 * The complete, documented success stream. FOUR EVENTS, and the last one is NOT an answer object.
 *
 * Note what is NOT here, because each absence is a correction to an assumption Pass 4B made:
 * no model identifier, no reasoning-effort echo, no cost, no rate-limit or allowance figure, and
 * no timestamp on any event.
 */
export const PROVEN_LUNA_MAX = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":12049,"cached_input_tokens":8960,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

export const ANSWERED_TERRA_MEDIUM = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13612,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

export const ANSWERED_SOL_MEDIUM = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13612,"cached_input_tokens":10624,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

export const ANSWERED_SOL_MAX = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13822,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

/**
 * `gpt-6-astra` at medium and at max, captured minutes apart.
 *
 * THESE TWO ARE THE EVIDENCE THAT `input_tokens` IS A TOTAL, NOT A REMAINDER. Both report
 * `input_tokens: 14713`, while one was served 6,400 cached tokens and the other none. If
 * `input_tokens` excluded the cached portion the two could not be equal, so `cached_input_tokens`
 * is a SUBSET of `input_tokens` and adding them double-counts. The `claude` envelope is the other
 * way round, and summing the Codex fields the way the Claude fields must be summed would overstate
 * this request by 6,400 tokens.
 */
export const ANSWERED_ASTRA_MEDIUM = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14713,"cached_input_tokens":6400,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

export const ANSWERED_ASTRA_MAX = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14713,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

/**
 * An unknown model. Exit code 1.
 *
 * The refusal arrives as a `turn.failed` whose `error.message` is a JSON-ENCODED STRING that has to
 * be parsed a second time to reach `status`. The model name in the prose is the one that was asked
 * for, and the CLI ALSO emits an `item.completed` of type `error` warning that it fell back to
 * default metadata — which is a client-side note, not the refusal.
 */
export const REFUSED_UNKNOWN_MODEL = [
  THREAD,
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `cernum-not-a-real-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'cernum-not-a-real-model\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'cernum-not-a-real-model\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
].join('\n');

/**
 * An effort level the service does not accept. Captured with `-c model_reasoning_effort="..."`.
 *
 * THIS IS THE OPPOSITE OF THE `claude` CLI'S BEHAVIOUR AND IT MATTERS. `claude` warns on stderr,
 * exits 0 and silently answers at its default effort. `codex` sends the value to the service, which
 * refuses the turn with HTTP 400 and names every level it does accept. An unsupported effort here
 * cannot silently become a different one — but it also costs a round trip to find out.
 */
export const REFUSED_UNKNOWN_EFFORT = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\n  \\"type\\": \\"error\\",\\n  \\"error\\": {\\n    \\"type\\": \\"invalid_request_error\\",\\n    \\"code\\": null,\\n    \\"message\\": \\"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: \'cernum_bogus\'. Supported values are: \'none\', \'minimal\', \'low\', \'medium\', \'high\', \'xhigh\', and \'max\'.\\",\\n    \\"param\\": null\\n  },\\n  \\"status\\": 400\\n}"}',
  '{"type":"turn.failed","error":{"message":"{\\n  \\"type\\": \\"error\\",\\n  \\"error\\": {\\n    \\"type\\": \\"invalid_request_error\\",\\n    \\"code\\": null,\\n    \\"message\\": \\"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: \'cernum_bogus\'. Supported values are: \'none\', \'minimal\', \'low\', \'medium\', \'high\', \'xhigh\', and \'max\'.\\",\\n    \\"param\\": null\\n  },\\n  \\"status\\": 400\\n}"}}',
].join('\n');

/**
 * A HAND-BUILT stream in which the agent invoked a tool. There is no captured one because NO RUN IN
 * THIS PASS INVOKED A TOOL — which is the result the isolation envelope was built to produce.
 *
 * It exists so the contamination detector is tested against something, rather than being trusted
 * because it never fired. Built from the `item.completed` shape the real captures establish.
 */
export const CONTAMINATED_BY_TOOL_USE = [
  THREAD,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls -la","aggregated_output":"total 0","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
].join('\n');

/** What the CLI writes locally, before contacting anything, when a config field is unknown. Verbatim. */
export const UNKNOWN_CONFIG_FIELD =
  'Error loading config.toml: unknown configuration field `tools.cernum_bogus_key` in -c/--config override';

/** What it writes when a recognised field is given a value of the wrong type. Verbatim. */
export const MALFORMED_CONFIG_VALUE =
  'Error loading config.toml: data did not match any variant of untagged enum WebSearchToolConfigInput\nin `tools.web_search`';

/**
 * `codex doctor --json`, trimmed to the one check that answers the question and with the account's
 * home path left in so the test can prove the parser DROPS it.
 *
 * The doctor report is the tool's own REDACTED machine-readable report. It is the only
 * machine-readable answer this CLI gives to "how is this session authenticated", because
 * `codex login status` prints one line of prose and `codex login status --json` DOES NOT EXIST.
 */
export const DOCTOR_CHATGPT_AUTH = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-09-13T00:00:00Z',
  overallStatus: 'warning',
  codexVersion: '0.154.0',
  checks: {
    'auth.credentials': {
      id: 'auth.credentials',
      category: 'auth',
      status: 'ok',
      summary: 'auth is configured',
      details: {
        'auth file': '/Users/redacted/.codex/auth.json',
        'auth storage mode': 'File',
        'stored API key': 'false',
        'stored ChatGPT tokens': 'true',
        'stored agent identity': 'false',
        'stored auth mode': 'chatgpt',
      },
      remediation: null,
      durationMs: 0,
    },
  },
});

/** The same report for a session authenticated with an API key. Metered billing — must be refused. */
export const DOCTOR_API_KEY_AUTH = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '2026-09-13T00:00:00Z',
  overallStatus: 'ok',
  codexVersion: '0.154.0',
  checks: {
    'auth.credentials': {
      id: 'auth.credentials',
      category: 'auth',
      status: 'ok',
      summary: 'auth is configured',
      details: {
        'auth file': '/Users/redacted/.codex/auth.json',
        'auth storage mode': 'File',
        'stored API key': 'true',
        'stored ChatGPT tokens': 'false',
        'stored agent identity': 'false',
        'stored auth mode': 'apikey',
      },
      remediation: null,
      durationMs: 0,
    },
  },
});

/**
 * `codex debug models`, trimmed to the four identifiers this pass asked for plus one hidden entry.
 *
 * THIS IS A CATALOGUE, NOT AN ENTITLEMENT LIST, and the distinction is the whole reason the smoke
 * test still has to run. `cernum-not-a-real-model` is absent from it and was refused by the SERVICE
 * with "not supported when using Codex with a ChatGPT account" — the service decides, not the file.
 */
export const DEBUG_MODELS_CATALOGUE = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      visibility: 'list',
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'GPT-5.6-Luna',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' },
      ],
      visibility: 'list',
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      visibility: 'list',
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      visibility: 'list',
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
      visibility: 'hide',
    },
  ],
});
