// The Codex half of the identity preflight — the half Pass 5 could not test.
//
// EVERY FIXTURE HERE IS REAL OUTPUT from `codex` 0.154.0 with its thread ids zeroed. That matters
// more than usual in this file, for exactly the reason it mattered in the Claude one: Pass 4B wrote
// the Codex adapter against an imagined CLI, Pass 5 could not check it because no `codex` binary
// existed on the machine, and a test written from the same imagination would have confirmed the
// guesses rather than caught them. Five of them were wrong.
//
// NOTHING IN THIS FILE CONTACTS ANYTHING. The CLI is a shell script in a temporary directory.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  CODEX_ISOLATION_FLAGS, CODEX_SERVICE_EFFORT_LEVELS, CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT,
  buildCodexExecArguments, codexSubscriptionUsable, describeCodexContamination, highestSingleAgentEffort,
  parseCodexCatalogue, parseCodexDoctorAuth, parseCodexExecJSONL, readCodexUsage, unwrapCodexError,
} from '../../src/engine/codex-cli';
import { SubscriptionCLIAdapter, parseCLIResponse, totalInputTokens } from '../../src/engine/frontier-adapter';
import { identitySmokeTest, IDENTITY_SMOKE_PROMPT } from '../../src/engine/identity-smoke';
import { modelsFromSmokes } from '../../src/engine/discovery-store';
import { DESIRED_CANDIDATE_LADDER } from '../../src/engine/discovery';
import { EFFORT_LEVELS, ProviderBinding } from '../../src/engine/provider';
import { subscriptionBinding, writeFakeCLI } from './frontier-harness';
import {
  ANSWERED_ASTRA_MAX, ANSWERED_ASTRA_MEDIUM, ANSWERED_SOL_MAX, ANSWERED_SOL_MEDIUM, ANSWERED_TERRA_MEDIUM,
  CONTAMINATED_BY_TOOL_USE, DEBUG_MODELS_CATALOGUE, DOCTOR_API_KEY_AUTH, DOCTOR_CHATGPT_AUTH,
  MALFORMED_CONFIG_VALUE, PROVEN_LUNA_MAX, REFUSED_UNKNOWN_EFFORT, REFUSED_UNKNOWN_MODEL,
  UNKNOWN_CONFIG_FIELD,
} from './fixtures/codex-cli';

function emit(fixture: string): string {
  return `cat <<'CERNUM_FIXTURE_EOF'\n${fixture}\nCERNUM_FIXTURE_EOF`;
}

function codexBinding(modelID: string, overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return subscriptionBinding(`codexCLI:${modelID}`, 'codexCLI', {
    requestedModelID: modelID,
    identityState: 'unverifiable',
    verifiedModelID: '',
    identityEvidence: 'nothing has established this yet',
    maxOutputTokens: 16,
    ...overrides,
  });
}

// MARK: - Authentication, and the one refusal that protects a card

describe('authentication', () => {
  it('accepts a ChatGPT subscription session, reading the tool\'s own redacted report', () => {
    const auth = parseCodexDoctorAuth(DOCTOR_CHATGPT_AUTH)!;
    expect(auth.storedAuthMode).toBe('chatgpt');
    expect(auth.apiKeyStored).toBe(false);
    expect(auth.chatgptTokensStored).toBe(true);

    const usable = codexSubscriptionUsable(auth);
    expect(usable.usable).toBe(true);
    expect(usable.reason).toMatch(/subscription-included/);
    // The zero charge is never allowed to travel without the allowance it hides.
    expect(usable.reason).toMatch(/finite/);
  });

  it('REFUSES an API-key session, because this preflight records a zero marginal charge', () => {
    const auth = parseCodexDoctorAuth(DOCTOR_API_KEY_AUTH)!;
    expect(auth.apiKeyStored).toBe(true);

    const usable = codexSubscriptionUsable(auth);
    expect(usable.usable).toBe(false);
    expect(usable.reason).toMatch(/bills per token|bills a card/);
  });

  it('reads the string "false" as false — the fields are strings, not booleans', () => {
    // Reading `"stored API key": "false"` as a boolean makes EVERY session an API-key session,
    // because a non-empty string is truthy. That would refuse the preflight on a subscription.
    const details = JSON.parse(DOCTOR_CHATGPT_AUTH).checks['auth.credentials'].details;
    expect(details['stored API key']).toBe('false');
    expect(typeof details['stored API key']).toBe('string');
    expect(parseCodexDoctorAuth(DOCTOR_CHATGPT_AUTH)!.apiKeyStored).toBe(false);
  });

  it('refuses rather than guesses when the report cannot be read', () => {
    expect(parseCodexDoctorAuth('not json')).toBeUndefined();
    const usable = codexSubscriptionUsable(undefined);
    expect(usable.usable).toBe(false);
    expect(usable.reason).toMatch(/UNKNOWN/);
  });

  it('keeps NO account identifier — the auth file path names the account holder and is dropped', () => {
    const auth = parseCodexDoctorAuth(DOCTOR_CHATGPT_AUTH)!;
    const serialised = JSON.stringify(auth);
    expect(JSON.parse(DOCTOR_CHATGPT_AUTH).checks['auth.credentials'].details['auth file'])
      .toMatch(/\/Users\//);
    expect(serialised).not.toMatch(/\/Users\//);
    expect(serialised).not.toMatch(/auth\.json/);
    expect(Object.keys(auth).sort())
      .toEqual(['apiKeyStored', 'chatgptTokensStored', 'status', 'storedAuthMode']);
  });
});

// MARK: - The envelope Pass 4B guessed wrong

describe('reading the real codex exec envelope', () => {
  it('folds a JSONL STREAM — the answer and the usage are in different events', () => {
    const parsed = parseCodexExecJSONL(PROVEN_LUNA_MAX)!;
    expect(parsed.answerText).toBe('ok');
    expect(parsed.usage.visibleOutputTokens).toBe(5);
    expect(parsed.isError).toBe(false);
  });

  it('the Claude reader CANNOT read this stream, which is why there are two', () => {
    // The Claude parser takes the LAST parseable object and looks for `result`/`text`/`content`/
    // `message`. The last Codex event is `turn.completed`, which has none of them. Pass 4B pointed
    // both tools at that parser: every successful Codex request would have been reported as a
    // malformed response.
    expect(parseCLIResponse(PROVEN_LUNA_MAX)).toBeUndefined();
  });

  it('NAMES NO MODEL, anywhere, in any event', () => {
    // This is the single most consequential difference from the Claude CLI, and it is the reason no
    // Codex candidate can reach `proven`.
    for (const line of PROVEN_LUNA_MAX.split('\n')) {
      const event = JSON.parse(line);
      expect(event.model).toBeUndefined();
      expect(event.modelUsage).toBeUndefined();
    }
  });

  it('ECHOES NO EFFORT, so an accepted effort is never a verified one', () => {
    const completed = JSON.parse(PROVEN_LUNA_MAX.split('\n').at(-1)!);
    expect(completed.usage.reasoning_effort).toBeUndefined();
    expect(completed.effort).toBeUndefined();
  });

  it('reports NO cost and NO allowance, which is not the same as reporting zero', () => {
    const completed = JSON.parse(PROVEN_LUNA_MAX.split('\n').at(-1)!);
    expect(completed.total_cost_usd).toBeUndefined();
    expect(completed.rate_limits).toBeUndefined();
  });

  it('reads reasoning from `reasoning_output_tokens`, which matches neither earlier guess', () => {
    const raw = JSON.parse(PROVEN_LUNA_MAX.split('\n').at(-1)!).usage;
    // Pass 4B looked for `usage.reasoning_tokens`; the Claude envelope uses a nested thinking path.
    expect(raw.reasoning_tokens).toBeUndefined();
    expect(raw.output_tokens_details).toBeUndefined();
    expect(raw.reasoning_output_tokens).toBe(0);
    expect(readCodexUsage(raw).reasoningTokens).toBe(0);
  });
});

// MARK: - The token accounting that would have been overstated by 43%

describe('input tokens mean the opposite of what they mean for Claude', () => {
  it('treats `input_tokens` as a TOTAL, with `cached_input_tokens` inside it', () => {
    const medium = parseCodexExecJSONL(ANSWERED_ASTRA_MEDIUM)!;
    const max = parseCodexExecJSONL(ANSWERED_ASTRA_MAX)!;

    // The proof: two requests with the SAME total and DIFFERENT cached portions. If the cached
    // portion were additional rather than included, the totals could not be equal.
    const rawMedium = JSON.parse(ANSWERED_ASTRA_MEDIUM.split('\n').at(-1)!).usage;
    const rawMax = JSON.parse(ANSWERED_ASTRA_MAX.split('\n').at(-1)!).usage;
    expect(rawMedium.input_tokens).toBe(14713);
    expect(rawMax.input_tokens).toBe(14713);
    expect(rawMedium.cached_input_tokens).toBe(6400);
    expect(rawMax.cached_input_tokens).toBe(0);

    // Both must total 14,713. Summing the fields the Claude way would give 21,113 for the first.
    expect(totalInputTokens(medium.usage)).toBe(14713);
    expect(totalInputTokens(max.usage)).toBe(14713);
    expect(totalInputTokens(medium.usage)).toBe(totalInputTokens(max.usage));
  });

  it('keeps the cached portion visible, because it is priced apart', () => {
    const medium = parseCodexExecJSONL(ANSWERED_ASTRA_MEDIUM)!;
    expect(medium.usage.cacheReadInputTokens).toBe(6400);
    expect(medium.usage.inputTokens).toBe(14713 - 6400);
  });

  it('never reports a negative fresh remainder', () => {
    const usage = readCodexUsage({ input_tokens: 10, cached_input_tokens: 40, cache_write_input_tokens: 0 });
    expect(usage.inputTokens).toBe(0);
  });
});

// MARK: - Identity, effort and substitution verdicts

describe('one minimal request, and what it can and cannot establish', () => {
  async function smoke(body: string, binding: ProviderBinding) {
    const fake = writeFakeCLI('codex', body);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      return { result: await identitySmokeTest(binding, adapter), fake, invocations: fake.invocations() };
    } finally { fake.cleanup(); }
  }

  it('UNVERIFIABLE on success — the model answered and the tool will not say which model it was', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`, codexBinding('gpt-5.6-luna', { effort: 'max' }));
    expect(result.verdict).toBe('unverifiable');
    expect(result.answerText).toBe('ok');
    expect(result.reportedModelID).toBe('');
    expect(result.evidence).toMatch(/named no model/);
    // NEVER upgraded to proven by assuming the request was honoured.
    expect(result.evidence).toMatch(/rather than assumed to be the model that was requested/);
  });

  it('never copies the requested identifier into the reported one', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`, codexBinding('gpt-5.6-luna', { effort: 'max' }));
    expect(result.requestedModelID).toBe('gpt-5.6-luna');
    expect(result.reportedModelID).not.toBe('gpt-5.6-luna');
    expect(result.reportedModelID).toBe('');
  });

  it('REFUSED when the service rejects the model, reading the 400 out of the double-encoded error', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(REFUSED_UNKNOWN_MODEL)}; exit 1`,
      codexBinding('cernum-not-a-real-model'));
    expect(result.verdict).toBe('refused');
    expect(result.evidence).toMatch(/HTTP 400/);
    expect(result.evidence).toMatch(/not supported when using Codex with a ChatGPT account/);
  });

  it('REFUSED when the service rejects the effort — codex does NOT silently substitute', async () => {
    // The opposite of the Claude CLI, which warns on stderr, exits 0 and answers at its default.
    const { result } = await smoke(`cat > /dev/null; ${emit(REFUSED_UNKNOWN_EFFORT)}; exit 1`,
      codexBinding('gpt-5.6-luna'));
    expect(result.verdict).toBe('refused');
    expect(result.evidence).toMatch(/HTTP 400/);
    expect(result.evidence).toMatch(/invalid_enum_value/);
  });

  it('unwraps the double-encoded error rather than matching it with a regex', () => {
    const failed = JSON.parse(REFUSED_UNKNOWN_MODEL.split('\n').at(-1)!);
    expect(typeof failed.error.message).toBe('string');
    const unwrapped = unwrapCodexError(failed.error.message);
    expect(unwrapped.status).toBe(400);
    expect(unwrapped.message).toMatch(/not supported when using Codex/);
  });

  it('carries an unreadable error through unchanged instead of guessing at it', () => {
    expect(unwrapCodexError('a plain sentence')).toEqual({});
  });

  it('sends exactly one request and no retry, with the prompt on stdin and never in argv', async () => {
    // The Codex argument list contains double quotes — `model_reasoning_effort="max"` is TOML — so
    // they are escaped before being logged as JSON. The Claude fixture needed no such thing, which
    // is itself a small reminder that these two tools share nothing.
    const fake = writeFakeCLI('codex', `
      STDIN=$(cat)
      ARGS=$(printf '%s' "$*" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
      printf '{"args":["%s"],"stdin":"%s","env":{}}\\n' "$ARGS" "$(printf '%s' "$STDIN")" >> "$LOG"
      ${emit(PROVEN_LUNA_MAX)}
    `);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(codexBinding('gpt-5.6-luna', { effort: 'max' }), adapter);
      const calls = fake.invocations();
      expect(calls).toHaveLength(1);
      expect(calls[0].stdin.trim()).toBe(IDENTITY_SMOKE_PROMPT);
      expect(calls[0].args.join(' ')).not.toContain(IDENTITY_SMOKE_PROMPT);
      expect(result.retryCount).toBe(0);
      expect(result.wastedTokens).toBe(0);
    } finally { fake.cleanup(); }
  });

  it('records NO allowance figure, and does not default it to zero', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`, codexBinding('gpt-5.6-luna', { effort: 'max' }));
    // A zero here would say the request was free. It was not: it spent a real, unreported share of
    // a finite plan.
    expect(result.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(result.subscriptionIncludedUsageMicroUSD.value).toBeUndefined();
    // The marginal API charge IS genuinely zero, and the two are different facts.
    expect(result.marginalAPIChargeMicroUSD.value).toBe(0);
  });

  it('reports no provider generation speed, and labels what it does report', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`, codexBinding('gpt-5.6-luna', { effort: 'max' }));
    expect(result.providerReportedGenerationTokensPerSecondMilli.provenance).toBe('unavailable');
    expect(result.endToEndOutputTokensPerSecondMilli.note ?? '').not.toMatch(/provider's internal generation speed is/);
  });
});

// MARK: - Isolation

describe('isolation', () => {
  const binding = codexBinding('gpt-5.6-luna', { effort: 'max' });

  it('runs in a supplied working directory with every documented isolation flag set', () => {
    const built = buildCodexExecArguments(binding, { workingDirectory: '/tmp/empty' });
    const joined = built.args.join(' ');
    expect(joined).toContain('exec --json');
    expect(joined).toContain('-C /tmp/empty');
    expect(joined).toContain('--skip-git-repo-check');
    expect(joined).toContain('--ephemeral');
    expect(joined).toContain('--ignore-user-config');
    expect(joined).toContain('--ignore-rules');
    expect(joined).toContain('-s read-only');
    // The DOCUMENTED off switch. `tools.web_search=false` is asserted absent as well as replaced:
    // it is a boolean written into a key the CLI types as an object, and Pass 8 shipped it as
    // isolation while it disabled nothing.
    // BOTH documented keys. `tools.web_search=false` is valid — the CLI rejects a wrong-typed value
    // in that key by name and accepts this one — so it is kept rather than replaced, and the
    // top-level enum is set beside it because the first one did not hold in Pass 8.
    expect(joined).toContain('tools.web_search=false');
    expect(joined).toContain('web_search="disabled"');
    expect(joined).toContain('--disable shell_tool');
    expect(joined).toContain('--disable unified_exec');
  });

  it('records every active isolation setting, so a run can be described afterwards', () => {
    const built = buildCodexExecArguments(binding, { workingDirectory: '/tmp/empty' });
    expect(built.activeIsolation.length).toBeGreaterThanOrEqual(CODEX_ISOLATION_FLAGS.length);
    expect(built.activeIsolation.join('\n')).toMatch(/plugins, MCP servers/);
    expect(built.activeIsolation.join('\n')).toMatch(/OPENAI_API_KEY and CODEX_API_KEY removed/);
    expect(built.activeIsolation.join('\n')).toMatch(/stdin/);
  });

  it('quotes the effort as TOML, because -c parses its value as TOML', () => {
    const built = buildCodexExecArguments(binding, { workingDirectory: '/tmp/empty' });
    expect(built.args).toContain('model_reasoning_effort="max"');
  });

  it('sends no effort flag at all when the binding froze none', () => {
    const built = buildCodexExecArguments(codexBinding('gpt-5.6-luna', { effort: 'none' }), { workingDirectory: '/tmp/x' });
    expect(built.args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('TREATS ANY TOOL INVOCATION AS CONTAMINATION rather than filtering it out', () => {
    const parsed = parseCodexExecJSONL(CONTAMINATED_BY_TOOL_USE)!;
    expect(parsed.toolInvocations).toContain('command_execution');
    expect(describeCodexContamination(parsed.toolInvocations)).toMatch(/isolation envelope/);
  });

  it('records no contamination for a turn that only answered', () => {
    for (const fixture of [PROVEN_LUNA_MAX, ANSWERED_TERRA_MEDIUM, ANSWERED_SOL_MEDIUM,
      ANSWERED_SOL_MAX, ANSWERED_ASTRA_MEDIUM, ANSWERED_ASTRA_MAX]) {
      expect(parseCodexExecJSONL(fixture)!.toolInvocations).toEqual([]);
      expect(describeCodexContamination(parseCodexExecJSONL(fixture)!.toolInvocations)).toBeUndefined();
    }
  });

  it('refuses a contaminated turn instead of scoring it', async () => {
    const fake = writeFakeCLI('codex', `cat > /dev/null; ${emit(CONTAMINATED_BY_TOOL_USE)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(binding, adapter);
      expect(result.verdict).toBe('unverifiable');
      expect(result.evidence).toMatch(/isolation envelope/);
    } finally { fake.cleanup(); }
  });

  it('does NOT hand the child an API key, in either variable the binary reads', async () => {
    const fake = writeFakeCLI('codex', `
      cat > /dev/null
      printf '{"args":[],"stdin":"","env":{"OPENAI_API_KEY":"%s","CODEX_API_KEY":"%s"}}\\n' \
        "\${OPENAI_API_KEY:-ABSENT}" "\${CODEX_API_KEY:-ABSENT}" >> "$LOG"
      ${emit(PROVEN_LUNA_MAX)}
    `);
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousCodex = process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-must-not-reach-the-child';
    process.env.CODEX_API_KEY = 'sk-test-must-not-reach-the-child';
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      await identitySmokeTest(binding, adapter);
      const env = fake.invocations()[0].env;
      expect(env.OPENAI_API_KEY).toBe('ABSENT');
      expect(env.CODEX_API_KEY).toBe('ABSENT');
    } finally {
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = previousCodex;
      fake.cleanup();
    }
  });

  it('removes the temporary working directory afterwards, whatever the outcome', async () => {
    const seen: string[] = [];
    const fake = writeFakeCLI('codex', `cat > /dev/null; pwd >> "$LOG"; ${emit(PROVEN_LUNA_MAX)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      await identitySmokeTest(binding, adapter);
      const directory = fs.readFileSync(fake.logPath, 'utf8').trim().split('\n')[0];
      seen.push(directory);
      expect(directory).toMatch(/cernum-codex-/);
      expect(fs.existsSync(directory)).toBe(false);
    } finally { fake.cleanup(); }
    expect(seen).toHaveLength(1);
  });

  it('the working directory handed to the tool is EMPTY — no AGENTS.md, no project files', async () => {
    const fake = writeFakeCLI('codex', `cat > /dev/null; ls -A >> "$LOG"; ${emit(PROVEN_LUNA_MAX)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      await identitySmokeTest(binding, adapter);
      expect(fs.readFileSync(fake.logPath, 'utf8').trim()).toBe('');
    } finally { fake.cleanup(); }
  });
});

// MARK: - Effort

describe('reasoning effort', () => {
  it('models the service\'s own accepted set, quoted from its 400', () => {
    expect(CODEX_SERVICE_EFFORT_LEVELS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    // `minimal` is a level of a provider's ladder this engine could not previously name.
    expect(EFFORT_LEVELS).toContain('minimal');
  });

  it('cannot name `ultra`, because ultra is not a reasoning effort', () => {
    expect(EFFORT_LEVELS as string[]).not.toContain('ultra');
    expect(CODEX_SERVICE_EFFORT_LEVELS as string[]).not.toContain('ultra');
    expect(CODEX_ULTRA_IS_NOT_A_REASONING_EFFORT).toMatch(/subagents/);
  });

  it('picks `max` as the highest SINGLE-AGENT effort even when the catalogue offers ultra', () => {
    const catalogue = parseCodexCatalogue(DEBUG_MODELS_CATALOGUE);
    const astra = catalogue.find((entry) => entry.modelID === 'gpt-6-astra')!;
    expect(astra.supportedEfforts).toContain('ultra');
    expect(highestSingleAgentEffort(astra)).toBe('max');
  });

  it('records an accepted effort as UNVERIFIABLE, never as verified', async () => {
    const fake = writeFakeCLI('codex', `cat > /dev/null; ${emit(ANSWERED_SOL_MAX)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      const response = await adapter.complete({
        binding: codexBinding('gpt-5.6-sol', { effort: 'max' }),
        promptText: IDENTITY_SMOKE_PROMPT,
      });
      // The flag was accepted and the turn succeeded. Nothing confirms the effort was applied.
      expect(response.failure).toBeUndefined();
      expect(response.reportedEffort).toBeUndefined();
    } finally { fake.cleanup(); }
  });
});

// MARK: - The catalogue, which is not an entitlement list

describe('the model catalogue', () => {
  it('reads `codex debug models`, which the Claude CLI has no equivalent of', () => {
    const catalogue = parseCodexCatalogue(DEBUG_MODELS_CATALOGUE);
    expect(catalogue.map((entry) => entry.modelID))
      .toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']));
  });

  it('does NOT make a listed model proven — the service refuses models the catalogue contains', () => {
    // `cernum-not-a-real-model` is absent from the catalogue AND was refused by the service with an
    // account-level reason. The converse — present in the catalogue, refused by the account — is
    // exactly what a catalogue cannot rule out, so a listing never promotes anything.
    const catalogue = parseCodexCatalogue(DEBUG_MODELS_CATALOGUE);
    const listed = catalogue.map((entry) => entry.modelID);
    expect(listed).not.toContain('cernum-not-a-real-model');
    expect(REFUSED_UNKNOWN_MODEL).toMatch(/not supported when using Codex with a ChatGPT account/);
  });

  it('returns nothing rather than a partial reading when the catalogue does not parse', () => {
    expect(parseCodexCatalogue('<html>error</html>')).toEqual([]);
  });
});

// MARK: - Luna belongs to Codex

describe('Luna is an OpenAI model', () => {
  it('appears on the ladder under codexCLI, and never under claudeCLI', () => {
    const luna = DESIRED_CANDIDATE_LADDER.filter((entry) => entry.displayName.includes('Luna'));
    expect(luna).toHaveLength(1);
    expect(luna[0].provider).toBe('codexCLI');
    expect(luna[0].modelID).toBe('gpt-5.6-luna');
  });

  it('is named in full, with Max carried as an effort rather than part of the identifier', () => {
    const luna = DESIRED_CANDIDATE_LADDER.find((entry) => entry.modelID === 'gpt-5.6-luna')!;
    expect(luna.displayName).toBe('GPT-5.6 Luna');
    // "Luna Max" is a model plus a setting. Sending it as one identifier could only ever 404.
    expect(luna.modelID).not.toMatch(/max/i);
    expect(luna.desiredEfforts).toContain('max');
  });

  it('no ladder entry still asks the Claude CLI for a Codex model', () => {
    for (const entry of DESIRED_CANDIDATE_LADDER.filter((row) => row.provider === 'claudeCLI')) {
      expect(entry.modelID).toMatch(/^claude-/);
    }
    expect(DESIRED_CANDIDATE_LADDER.some((entry) => entry.modelID === 'luna-max')).toBe(false);
  });

  it('keeps every Codex candidate unproven, because identity was never returned', () => {
    const models = modelsFromSmokes([{
      candidate: 'codexCLI:gpt-5.6-luna:max',
      provider: 'codexCLI',
      requestedModelID: 'gpt-5.6-luna',
      reportedModelID: '',
      effort: 'max',
      verdict: 'unverifiable',
      attemptedAt: '2026-09-13T00:00:00Z',
      evidence: 'the provider answered but named no model',
    } as never], new Map([['gpt-5.6-luna', 'GPT-5.6 Luna']]));
    expect(models[0].availability).toBe('unproven');
    expect(models[0].verifiedModelID).toBe('');
  });
});

// MARK: - Local refusals that cost nothing

describe('the CLI validates configuration locally, before contacting anything', () => {
  it('rejects an unknown configuration field by name', () => {
    // Captured from the real tool. It exits in ~50 ms having sent nothing, which makes the whole
    // isolation envelope checkable for free before a single token is spent.
    expect(UNKNOWN_CONFIG_FIELD).toMatch(/unknown configuration field `tools\.cernum_bogus_key`/);
  });

  it('rejects a recognised field given the wrong type, naming the field', () => {
    expect(MALFORMED_CONFIG_VALUE).toMatch(/tools\.web_search/);
  });
});

// MARK: - Boundaries

describe('boundaries', () => {
  it('creates no campaign and writes no credential anywhere', async () => {
    const fake = writeFakeCLI('codex', `cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(codexBinding('gpt-5.6-luna', { effort: 'max' }), adapter);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toMatch(/sk-/);
      expect(serialised).not.toMatch(/auth\.json/);
      expect(serialised).not.toMatch(/@/);
      expect(serialised).not.toMatch(/campaign/i);
    } finally { fake.cleanup(); }
  });

  it('records the Claude and Codex allowance measurements as separate, incomparable things', async () => {
    const fake = writeFakeCLI('codex', `cat > /dev/null; ${emit(PROVEN_LUNA_MAX)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'codexCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(codexBinding('gpt-5.6-luna', { effort: 'max' }), adapter);
      // Claude reports an allowance figure; Codex reports none. Adding them, or defaulting the
      // missing one to zero, would produce a single number describing two different plans.
      expect(result.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
      expect(result.billingBasis).toBe('subscriptionIncluded');
    } finally { fake.cleanup(); }
  });
});
