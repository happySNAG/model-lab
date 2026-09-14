// The identity preflight, and the four things one minimal request can establish.
//
// EVERY FIXTURE HERE IS REAL OUTPUT from `claude` 2.1.251 with its private values removed. That
// matters more than usual in this file: Pass 4B built its parser against an imagined envelope and
// was wrong about the model field, the thinking-token path, the cached-input counts, the cost field
// and the error flag — five defects that a test written from the same imagination would have
// confirmed rather than caught.
//
// NOTHING IN THIS FILE CONTACTS ANYTHING. The CLI is a shell script in a temporary directory.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SubscriptionCLIAdapter, buildCLIArguments, detectEffortSubstitution, parseCLIResponse,
  resolveAnsweringModel, totalInputTokens,
} from '../../src/engine/frontier-adapter';
import { identitySmokeTest, readSmoke, IDENTITY_SMOKE_PROMPT } from '../../src/engine/identity-smoke';
import {
  DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS, describeExpiry, isEvidenceExpired, modelsFromSmokes,
  readDiscoveryStore, selectableFromStore, writeDiscoveryStore,
} from '../../src/engine/discovery-store';
import { parseAuthStatus } from '../../src/engine/discovery';
import {
  CLIENT_OBSERVED_THROUGHPUT_CAVEAT, END_TO_END_THROUGHPUT_CAVEAT, SUBSCRIPTION_NOT_FREE,
  clientObservedOutputThroughputMilli, costBreakdown, describeCost, endToEndOutputThroughputMilli,
  measuredQuantity, providerReportedGenerationThroughputMilli, quantityValue, reportedQuantity,
  unavailableQuantity,
} from '../../src/engine/frontier-metrics';
import { ProviderBinding } from '../../src/engine/provider';
import { subscriptionBinding, writeFakeCLI } from './frontier-harness';

/**
 * A shell fragment that prints a fixture verbatim.
 *
 * `echo '<json>'` cannot be used: the real refusal envelope contains an apostrophe ("There's an
 * issue with the selected model"), and a fixture that had to be edited to fit the test harness
 * would no longer be the thing that came back.
 */
function emit(fixture: string): string {
  return `cat <<'CERNUM_FIXTURE_EOF'\n${fixture}\nCERNUM_FIXTURE_EOF`;
}
import {
  AUTH_STATUS_SIGNED_IN, PROVEN_HAIKU, PROVEN_OPUS, PROVEN_SONNET_HIGH, REFUSED_UNKNOWN_MODEL,
  UNKNOWN_EFFORT_WARNING,
} from './fixtures/claude-cli';

function smokeBinding(modelID: string, overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return subscriptionBinding(`claudeCLI:${modelID}`, 'claudeCLI', {
    requestedModelID: modelID,
    identityState: 'unverifiable',
    verifiedModelID: '',
    identityEvidence: 'nothing has established this yet',
    maxOutputTokens: 16,
    ...overrides,
  });
}

// MARK: - The envelope Pass 4B guessed wrong

describe('reading the real CLI envelope', () => {
  it('finds the model identity in `modelUsage`, because there is no `model` field', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    expect(JSON.parse(PROVEN_HAIKU).model).toBeUndefined();
    expect(parsed.participants.map((entry) => entry.modelID)).toContain('claude-haiku-4-5');
    expect(resolveAnsweringModel('claude-haiku-4-5', parsed.participants).state).toBe('verified');
  });

  it('matches a dated identifier against its canonical name rather than calling it a substitution', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    // The tool reports both `claude-haiku-4-5-20251001` and `claude-haiku-4-5`; they are one model.
    const dated = parsed.participants.find((entry) => entry.modelID === 'claude-haiku-4-5-20251001')!;
    expect(dated.canonicalModel).toBe('claude-haiku-4-5');
    expect(resolveAnsweringModel('claude-haiku-4-5', [dated]).state).toBe('verified');
  });

  it('reads thinking tokens from output_tokens_details, where they actually are', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    const raw = JSON.parse(PROVEN_HAIKU);
    expect(raw.usage.reasoning_tokens).toBeUndefined();
    expect(raw.usage.thinking_tokens).toBeUndefined();
    expect(raw.usage.output_tokens_details.thinking_tokens).toBe(38);
    expect(parsed.usage.reasoningTokens).toBe(38);
  });

  it('counts cached input, which is two orders of magnitude larger than the prompt', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    expect(parsed.usage.inputTokens).toBe(9);
    expect(parsed.usage.cacheCreationInputTokens).toBe(6_551);
    // Pass 4B recorded 9. The request actually processed 6,560 input tokens.
    expect(totalInputTokens(parsed.usage)).toBe(6_560);
  });

  it('reads the tool\'s own cost figure, which Pass 4B assumed did not exist on a subscription', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    expect(parsed.subscriptionIncludedUsageMicroUSD).toBe(14_273);
  });

  it('does not mistake `duration_api_ms` for a generation duration', () => {
    const parsed = parseCLIResponse(PROVEN_HAIKU)!;
    // 1,790 ms of "API duration" inside a 926 ms turn: a sum across concurrent calls, not a
    // duration anything could be divided by.
    expect(parsed.providerReportedAPIDurationMilliseconds).toBe(1_790);
    expect(parsed.providerReportedDurationMilliseconds).toBe(926);
    expect(parsed.providerReportedAPIDurationMilliseconds!)
      .toBeGreaterThan(parsed.providerReportedDurationMilliseconds!);
  });

  it('trusts `is_error`, not `subtype`, which says "success" on a refusal', () => {
    const parsed = parseCLIResponse(REFUSED_UNKNOWN_MODEL)!;
    expect(JSON.parse(REFUSED_UNKNOWN_MODEL).subtype).toBe('success');
    expect(parsed.isError).toBe(true);
    expect(parsed.apiErrorStatus).toBe(404);
    expect(parsed.terminalReason).toBe('api_error');
    expect(parsed.participants).toEqual([]);
  });
});

// MARK: - The four verdicts

describe('one minimal request, four possible verdicts', () => {
  async function smoke(body: string, binding = smokeBinding('claude-haiku-4-5')) {
    const fake = writeFakeCLI('claude', body);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      return { result: await identitySmokeTest(binding, adapter), fake, invocations: fake.invocations() };
    } finally { fake.cleanup(); }
  }

  it('PROVEN when the tool names the model that was asked for', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(PROVEN_HAIKU)}`);
    expect(result.verdict).toBe('proven');
    expect(result.requestedModelID).toBe('claude-haiku-4-5');
    expect(result.reportedModelID).toBe('claude-haiku-4-5');
    expect(result.answerText).toBe('ok');
    expect(result.evidence).toMatch(/named claude-haiku-4-5 as the model that answered/);
    // The housekeeping model is disclosed rather than hidden by the match.
    expect(result.participatingModelIDs).toContain('claude-haiku-4-5-20251001');
    expect(result.evidence).toMatch(/housekeeping/);
  });

  it('REFUSED when the account cannot call the model, without retrying to get a nicer answer', async () => {
    const { result } = await smoke(`cat > /dev/null; ${emit(REFUSED_UNKNOWN_MODEL)}; exit 1`,
      smokeBinding('luna-max'));
    expect(result.verdict).toBe('refused');
    expect(result.retryCount).toBe(0);
    expect(result.evidence).toMatch(/rejected this request/);
    // And the error prose is NOT recorded as the model's answer.
    expect(result.answerText).toBe('');
  });

  it('SUBSTITUTED when a different model answers, which is never accepted as a result', async () => {
    const swapped = JSON.stringify({
      result: 'ok',
      modelUsage: { 'claude-haiku-4-5': { canonicalModel: 'claude-haiku-4-5', outputTokens: 4 } },
      usage: { input_tokens: 2, output_tokens: 4 },
      is_error: false,
    });
    const { result } = await smoke(`cat > /dev/null; ${emit(swapped)}`, smokeBinding('claude-opus-4-8'));
    expect(result.verdict).toBe('substituted');
    expect(result.reportedModelID).toBe('claude-haiku-4-5');
    expect(result.evidence).toMatch(/claude-opus-4-8 was requested and claude-haiku-4-5 answered/);
  });

  it('UNVERIFIABLE when the tool answers and names nothing, never upgraded to proven', async () => {
    const anonymous = JSON.stringify({ result: 'ok', usage: { input_tokens: 2, output_tokens: 4 }, is_error: false });
    const { result } = await smoke(`cat > /dev/null; ${emit(anonymous)}`);
    expect(result.verdict).toBe('unverifiable');
    expect(result.reportedModelID).toBe('');
    expect(result.evidence).toMatch(/recorded as unverifiable rather than assumed/);
  });

  it('sends exactly one request, carrying the prompt on stdin and never in argv', async () => {
    const fake = writeFakeCLI('claude', `
      STDIN=$(cat)
      printf '{"args":%s,"stdin":%s,"env":{}}\\n' "$(printf '%s' "$*" | sed 's/.*/["&"]/')" "$(printf '%s' "$STDIN" | sed 's/.*/"&"/')" >> "$LOG"
      ${emit(PROVEN_HAIKU)}
    `);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      await identitySmokeTest(smokeBinding('claude-haiku-4-5'), adapter);
      const calls = fake.invocations();
      expect(calls).toHaveLength(1);
      expect(calls[0].stdin.trim()).toBe(IDENTITY_SMOKE_PROMPT);
      expect(calls[0].args.join(' ')).not.toContain(IDENTITY_SMOKE_PROMPT);
      // And the settings that would otherwise shape the request are all switched off explicitly.
      expect(calls[0].args.join(' ')).toContain('--strict-mcp-config');
    } finally { fake.cleanup(); }
  });
});

// MARK: - Effort, and the substitution that arrives through a warning

describe('an effort level the tool cannot apply', () => {
  it('refuses a level outside the CLI\'s documented set before anything is sent', () => {
    const { args, unexpressed } = buildCLIArguments(smokeBinding('claude-sonnet-5', { effort: 'xhigh' }));
    expect(args).toContain('--effort');
    expect(unexpressed).toEqual([]);
    // `none` means no flag at all, which is different from asking for low.
    expect(buildCLIArguments(smokeBinding('claude-sonnet-5', { effort: 'none' })).args).not.toContain('--effort');
  });

  it('detects the warning the tool prints when it IGNORES an effort level and answers anyway', () => {
    expect(detectEffortSubstitution('')).toBeUndefined();
    const detected = detectEffortSubstitution(UNKNOWN_EFFORT_WARNING)!;
    expect(detected).toMatch(/answered at its DEFAULT effort instead/);
  });

  it('turns that warning into a refusal, because the answer is real and the manifest is not', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; echo "${UNKNOWN_EFFORT_WARNING}" >&2; ${emit(PROVEN_SONNET_HIGH)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-sonnet-5', { effort: 'high' }), adapter);
      // Exit code 0 and a perfectly good answer — and it is still not a result at the frozen effort.
      expect(result.verdict).toBe('refused');
      expect(result.evidence).toMatch(/DEFAULT effort/);
    } finally { fake.cleanup(); }
  });

  it('records an output budget this CLI cannot enforce, without refusing every request over it', () => {
    const { unexpressed, notEnforceable } = buildCLIArguments(smokeBinding('claude-sonnet-5'));
    expect(unexpressed).toEqual([]);
    expect(notEnforceable.join(' ')).toMatch(/no output-token budget flag/);
  });
});

// MARK: - The two throughput distinctions

describe('tokens per second is three measurements, not one', () => {
  it('has no provider-reported generation speed when the provider reports no generation duration', () => {
    const quantity = providerReportedGenerationThroughputMilli(
      reportedQuantity(100), unavailableQuantity('no duration'));
    expect(quantity.provenance).toBe('unavailable');
    // The caller's own, more specific reason survives rather than being replaced by the generic one.
    expect(quantity.note).toBe('no duration');
    expect(providerReportedGenerationThroughputMilli(reportedQuantity(100), measuredQuantity(0)).note)
      .toMatch(/reported no generation duration/);
  });

  it('computes the provider-reported figure ONLY from the provider\'s own duration', () => {
    const quantity = providerReportedGenerationThroughputMilli(reportedQuantity(100), reportedQuantity(2_000));
    expect(quantityValue(quantity)).toBe(50_000);
    expect(quantity.provenance).toBe('providerReported');
  });

  it('keeps client-observed apart from end-to-end, and both apart from the provider\'s speed', () => {
    const tokens = reportedQuantity(100);
    // First visible output at 500 ms, done at 2,500 ms, whole request 2,500 ms.
    const observed = clientObservedOutputThroughputMilli(tokens, 500, 2_500);
    const endToEnd = endToEndOutputThroughputMilli(tokens, 2_500);
    expect(quantityValue(observed)).toBe(50_000);
    expect(quantityValue(endToEnd)).toBe(40_000);
    // The end-to-end figure is the slower one: it carries the wait before the first token.
    expect(quantityValue(endToEnd)!).toBeLessThan(quantityValue(observed)!);
    expect(observed.note).toBe(CLIENT_OBSERVED_THROUGHPUT_CAVEAT);
    expect(endToEnd.note).toBe(END_TO_END_THROUGHPUT_CAVEAT);
    for (const quantity of [observed, endToEnd]) {
      expect(quantity.note).toMatch(/NOT the provider's internal generation speed/);
    }
  });

  it('records no client-observed figure at all when nothing watched the stream', () => {
    const quantity = clientObservedOutputThroughputMilli(reportedQuantity(100), undefined, 2_500);
    expect(quantity.provenance).toBe('unavailable');
    expect(quantity.note).toMatch(/no streaming timestamps were observed/);
    // ...and the end-to-end figure still exists, which is the whole point of keeping them apart.
    expect(quantityValue(endToEndOutputThroughputMilli(reportedQuantity(100), 2_500))).toBe(40_000);
  });

  it('a real smoke reports end-to-end throughput and NO provider generation speed', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; ${emit(PROVEN_OPUS)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-opus-4-8'), adapter);
      expect(result.providerReportedGenerationTokensPerSecondMilli.provenance).toBe('unavailable');
      expect(result.providerReportedGenerationTokensPerSecondMilli.note).toMatch(/duration_api_ms/);
      expect(result.endToEndOutputTokensPerSecondMilli.provenance).toBe('measured');
    } finally { fake.cleanup(); }
  });
});

// MARK: - The three cost distinctions

describe('a marginal charge, an allowance, and what it actually cost you', () => {
  it('never renders subscription execution as "cost $0"', () => {
    const breakdown = costBreakdown({ billingBasis: 'subscriptionIncluded', providerReportedUsageMicroUSD: 14_273 });
    expect(quantityValue(breakdown.marginalAPIChargeMicroUSD)).toBe(0);
    expect(quantityValue(breakdown.subscriptionIncludedUsageMicroUSD)).toBe(14_273);
    expect(breakdown.effectiveUserCostMicroUSD.provenance).toBe('unavailable');
    expect(breakdown.effectiveUserCostMicroUSD.note).toBe(SUBSCRIPTION_NOT_FREE);

    const sentence = describeCost(breakdown, 'subscriptionIncluded');
    expect(sentence).toMatch(/plan allowance consumed \(list value\) \$0\.014273/);
    expect(sentence).toMatch(/effective cost to you: not known/);
    expect(sentence).toMatch(/finite monthly allowance/);
  });

  it('says an unreported allowance is unknown, and says out loud that it is not zero', () => {
    const breakdown = costBreakdown({ billingBasis: 'subscriptionIncluded' });
    expect(breakdown.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(breakdown.subscriptionIncludedUsageMicroUSD.note).toMatch(/It is not zero\./);
  });

  it('keeps a metered charge out of the allowance column, and vice versa', () => {
    const metered = costBreakdown({
      billingBasis: 'meteredAPI', meteredChargeMicroUSD: 600, meteredChargeProvenance: 'providerReported',
    });
    expect(quantityValue(metered.marginalAPIChargeMicroUSD)).toBe(600);
    expect(metered.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    // Metered is the one basis where the charge IS what the person pays.
    expect(quantityValue(metered.effectiveUserCostMicroUSD)).toBe(600);

    const local = costBreakdown({ billingBasis: 'local' });
    expect(quantityValue(local.marginalAPIChargeMicroUSD)).toBe(0);
    expect(quantityValue(local.effectiveUserCostMicroUSD)).toBe(0);
    expect(local.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
  });

  it('carries the allowance out of a real smoke rather than reporting a free request', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; ${emit(PROVEN_HAIKU)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-haiku-4-5'), adapter);
      expect(quantityValue(result.marginalAPIChargeMicroUSD)).toBe(0);
      expect(quantityValue(result.subscriptionIncludedUsageMicroUSD)).toBe(14_273);
      expect(result.effectiveUserCostMicroUSD.provenance).toBe('unavailable');
    } finally { fake.cleanup(); }
  });
});

// MARK: - Leakage

describe('nothing private leaves the preflight', () => {
  it('drops the account identifiers `claude auth status` volunteers', () => {
    const session = parseAuthStatus(AUTH_STATUS_SIGNED_IN)!;
    expect(session).toEqual({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max',
    });
    const serialised = JSON.stringify(session);
    for (const leak of ['redacted@example.test', '00000000-0000-0000-0000-000000000000',
      'Redacted Organization', '/redacted/projects']) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('refuses a status that is not machine-readable rather than reading prose out of it', () => {
    expect(parseAuthStatus('You are logged in as somebody@example.test')).toBeUndefined();
    expect(parseAuthStatus('{"authMethod":"claude.ai"}')).toBeUndefined();
    expect(parseAuthStatus('')).toBeUndefined();
  });

  it('writes no credential into a smoke result, even when the tool echoes one back', async () => {
    const leaked = JSON.stringify({
      result: 'ok sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
      modelUsage: { 'claude-haiku-4-5': { canonicalModel: 'claude-haiku-4-5' } },
      usage: { input_tokens: 2, output_tokens: 4 }, is_error: false,
    });
    const fake = writeFakeCLI('claude', `cat > /dev/null; ${emit(leaked)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-haiku-4-5'), adapter);
      expect(JSON.stringify(result)).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    } finally { fake.cleanup(); }
  });

  it('does not hand the child process this environment\'s API key', async () => {
    const fake = writeFakeCLI('claude', `
      echo "{\\"args\\":[],\\"stdin\\":\\"\\",\\"env\\":{\\"ANTHROPIC_API_KEY\\":\\"\${ANTHROPIC_API_KEY:-absent}\\"}}" >> "$LOG"
      cat > /dev/null; ${emit(PROVEN_HAIKU)}
    `);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      await identitySmokeTest(smokeBinding('claude-haiku-4-5'), adapter);
      // A subscription run that inherited a key could bill the card instead of the plan.
      expect(fake.invocations()[0].env.ANTHROPIC_API_KEY).toBe('absent');
    } finally { fake.cleanup(); }
  });
});

// MARK: - An interrupted tool

describe('an interrupted smoke leaves nothing running', () => {
  it('stops a tool that outlives its deadline and records the timeout as unverifiable', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; sleep 30`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-haiku-4-5', { timeoutMilliseconds: 400 }), adapter);
      // A timeout establishes nothing about identity, and is never a refusal: the account may well
      // be able to call this model, and this attempt simply did not find out.
      expect(result.verdict).toBe('unverifiable');
      expect(result.evidence).toMatch(/did not complete \(timeout\)/);
      expect(result.retryCount).toBe(0);
    } finally { fake.cleanup(); }
  }, 20_000);

  it('stops when the caller cancels, without a retry sneaking a second request in', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; sleep 30; ${emit(PROVEN_HAIKU)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-haiku-4-5', { timeoutMilliseconds: 30_000 }), adapter,
        { shouldCancel: () => true });
      expect(result.verdict).toBe('unverifiable');
      expect(fake.invocations().length).toBeLessThanOrEqual(1);
    } finally { fake.cleanup(); }
  }, 20_000);
});

// MARK: - The store, and evidence that goes stale

describe('discovery evidence expires', () => {
  function temporaryRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-store-'));
  }

  it('turns verdicts into store rows without hard-coding a single model name', () => {
    const at = '2026-09-13T18:00:00Z';
    const rows = modelsFromSmokes([
      { ...blankSmoke(), requestedModelID: 'claude-sonnet-5', effort: 'high', verdict: 'proven',
        reportedModelID: 'claude-sonnet-5', attemptedAt: at },
      { ...blankSmoke(), requestedModelID: 'luna-max', effort: 'none', verdict: 'refused', attemptedAt: at },
      { ...blankSmoke(), requestedModelID: 'anon', effort: 'none', verdict: 'unverifiable', attemptedAt: at },
      { ...blankSmoke(), requestedModelID: 'swapped', effort: 'none', verdict: 'substituted', attemptedAt: at },
    ]);
    const availability = new Map(rows.map((row) => [row.modelID, row.availability]));
    expect(availability.get('claude-sonnet-5')).toBe('proven');
    expect(availability.get('luna-max')).toBe('refused');
    expect(availability.get('anon')).toBe('unproven');
    // A model that answered under a different name is NOT selectable.
    expect(availability.get('swapped')).toBe('refused');
  });

  it('keeps the pessimistic verdict when one model is proven at one effort and refused at another', () => {
    const at = '2026-09-13T18:00:00Z';
    const rows = modelsFromSmokes([
      { ...blankSmoke(), requestedModelID: 'm', effort: 'high', verdict: 'refused', attemptedAt: at },
      { ...blankSmoke(), requestedModelID: 'm', effort: 'max', verdict: 'proven', reportedModelID: 'm', attemptedAt: at },
    ]);
    expect(rows[0].availability).toBe('refused');
    expect(rows[0].desiredEfforts).toEqual(['high', 'max']);
  });

  it('round-trips through the store with the timestamp a campaign checks', () => {
    const root = temporaryRoot();
    try {
      const at = new Date('2026-09-13T18:00:00Z');
      writeDiscoveryStore(root, modelsFromSmokes([
        { ...blankSmoke(), requestedModelID: 'm', verdict: 'proven', reportedModelID: 'm', attemptedAt: at.toISOString() },
      ]), at);
      const evidence = readDiscoveryStore(root);
      expect(evidence.writtenAt).toBe(at.toISOString());
      expect(evidence.models[0].verifiedModelID).toBe('m');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a proof older than the window as EXPIRED rather than selectable', () => {
    const provenAt = new Date('2026-09-01T00:00:00Z');
    const models = modelsFromSmokes([
      { ...blankSmoke(), requestedModelID: 'm', verdict: 'proven', reportedModelID: 'm', attemptedAt: provenAt.toISOString() },
    ]);
    const justInside = new Date(provenAt.getTime() + DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS - 1_000);
    const justOutside = new Date(provenAt.getTime() + DISCOVERY_EVIDENCE_MAX_AGE_MILLISECONDS + 1_000);
    expect(isEvidenceExpired(models[0], justInside)).toBe(false);
    expect(isEvidenceExpired(models[0], justOutside)).toBe(true);

    const fresh = selectableFromStore({ writtenAt: '', models }, justInside);
    expect(fresh.selectable).toHaveLength(1);
    expect(fresh.expired).toHaveLength(0);

    const stale = selectableFromStore({ writtenAt: '', models }, justOutside);
    expect(stale.selectable).toHaveLength(0);
    expect(stale.expired).toHaveLength(1);
    expect(describeExpiry(models[0], justOutside)).toMatch(/has expired/);
  });

  it('treats an undated proof as expired, because it cannot be shown to be fresh', () => {
    const models = modelsFromSmokes([
      { ...blankSmoke(), requestedModelID: 'm', verdict: 'proven', reportedModelID: 'm', attemptedAt: 'not a date' },
    ]);
    expect(isEvidenceExpired(models[0], new Date())).toBe(true);
    expect(describeExpiry(models[0])).toMatch(/undated/);
  });

  it('establishes nothing from a store that does not parse', () => {
    const root = temporaryRoot();
    try {
      const file = path.join(root, '.providers', 'discovered.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ this is not json', 'utf8');
      expect(readDiscoveryStore(root).models).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// MARK: - A preflight is not a campaign

describe('a preflight creates no campaign', () => {
  it('writes only the discovery store, and no campaign directory, ledger or manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-preflight-'));
    try {
      writeDiscoveryStore(root, modelsFromSmokes([
        { ...blankSmoke(), requestedModelID: 'm', verdict: 'proven', reportedModelID: 'm',
          attemptedAt: new Date().toISOString() },
      ]));
      const entries = fs.readdirSync(root);
      expect(entries).toEqual(['.providers']);
      const everything = walk(root);
      expect(everything.map((entry) => path.basename(entry))).toEqual(['discovered.json']);
      // No manifest, no ledger, no lock: the three files a campaign always leaves behind.
      for (const name of ['manifest.json', 'ledger.jsonl', 'campaign.lock']) {
        expect(everything.some((entry) => entry.endsWith(name))).toBe(false);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('produces a result shape carrying no scored outcome to mistake for a benchmark', async () => {
    const fake = writeFakeCLI('claude', `cat > /dev/null; ${emit(PROVEN_HAIKU)}`);
    try {
      const adapter = new SubscriptionCLIAdapter({ provider: 'claudeCLI', executablePath: fake.executablePath });
      const result = await identitySmokeTest(smokeBinding('claude-haiku-4-5'), adapter);
      for (const forbidden of ['status', 'score', 'passed', 'suite', 'slotKey', 'rank']) {
        expect(Object.keys(result)).not.toContain(forbidden);
      }
    } finally { fake.cleanup(); }
  });
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** A smoke result with nothing established, for the store tests to override one field of. */
function blankSmoke() {
  return readSmoke(smokeBinding('placeholder'), {
    answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable',
    totalElapsedMilliseconds: 0, retryCount: 0, wastedTokens: 0,
  }, '2026-09-13T18:00:00Z');
}
