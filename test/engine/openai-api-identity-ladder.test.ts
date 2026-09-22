// Cernum · the OpenAI API identity ladder — four names, one rung each, and nothing proven by listing.
//
// WHAT THIS LADDER IS FOR. `discover openaiAPI` reads `/v1/models` and is served a catalogue of well
// over a hundred entries, most of which are embedding, audio, image and moderation endpoints that
// cannot answer an identity prompt at all. v0.2.4 recorded that catalogue as `proven` and made every
// one of those campaign-selectable; the fix was to make a listing VISIBILITY rather than EXECUTION
// PROOF, and it holds. What the fix does not do is prove anything, which is the gap this ladder
// fills: four identifiers, named in source, asked one at a time, and believed only when the API's
// own response envelope names the model that answered.
//
// THE FOUR ARE ALSO ON THE CODEX LADDER, AND THAT IS NOT A DUPLICATE. A ChatGPT subscription
// accepting `gpt-5.6-sol` says nothing about whether an API key may call it, what the API returns as
// the answering model, or what the request costs. Two routes, two credentials, two billing bases,
// two questions.
//
// NOTHING IN THIS FILE CONTACTS OPENAI. The adapter tests drive a loopback mock; the CLI tests run
// `--dry-run` and assert that the preview refuses. A test here that reached a provider would be the
// failure it is looking for.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESIRED_CANDIDATE_LADDER, FREE_OPENCODE_DEVELOPMENT_POOL, ProviderStatus, parseModelListing, selectableModels,
} from '../../src/engine/discovery';
import { modelsFromSmokes } from '../../src/engine/discovery-store';
import {
  AUTHORIZED_COHORT, OPENAI_API_IDENTITY_ADDITIONS, configurationKey, ladderConfigurations, reconcileCohort,
} from '../../src/engine/reconciliation';
import {
  MeteredAPIAdapter, OPENAI_API_EFFORT_LEVELS, OPENAI_API_IDENTITY_EVIDENCE, buildAPIBody, unexpressedAPISettings,
} from '../../src/engine/frontier-adapter';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import {
  authorizeSmoke, buildSmokeBinding, isSmokeAuthorizationRefusal, projectedMeteredBoundMicroUSD,
} from '../../src/engine/smoke-binding';
import { EffortLevel, PricingSnapshot } from '../../src/engine/provider';
import { startMockProvider } from './frontier-harness';
import { FIXTURE_OPENAI_KEY } from '../secret-fixtures';

/** The four this pass approved, written out here a third time so a silent edit has nowhere to hide. */
const APPROVED = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-astra'];

/** A real OpenAI `/v1/models` page is mostly this: endpoints that answer no prompt of any kind. */
const NON_TEXT_CATALOGUE = ['text-embedding-3-large', 'whisper-1', 'tts-1-hd', 'dall-e-3', 'omni-moderation-latest'];

const ladderFor = (provider: string) => DESIRED_CANDIDATE_LADDER.filter((entry) => entry.provider === provider);

const credentials = { environment: { OPENAI_API_KEY: FIXTURE_OPENAI_KEY }, readKeychain: () => undefined };

const PRICES: PricingSnapshot = {
  source: 'a fixture written by this test. NOT a real price and never fetched from anyone.',
  capturedAt: '2026-09-20T00:00:00Z',
  currency: 'USD',
  inputMicroUSDPerMillionTokens: 1_250_000,
  outputMicroUSDPerMillionTokens: 10_000_000,
  reasoningMicroUSDPerMillionTokens: null,
};

/** One streamed chat-completions turn, as the OpenAI API frames it. `model` is the identity claim. */
function openAIStreamFrames(reportedModelID: string, options: { nameTheModel?: boolean } = {}): string[] {
  const named = options.nameTheModel !== false;
  return [
    JSON.stringify({ ...(named ? { model: reportedModelID } : {}), choices: [{ delta: { role: 'assistant' } }] }),
    JSON.stringify({ ...(named ? { model: reportedModelID } : {}), choices: [{ delta: { content: 'ok' } }] }),
    JSON.stringify({
      ...(named ? { model: reportedModelID } : {}),
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 64 } },
    }),
  ];
}

// MARK: - Only the approved four are on the ladder

describe('the OpenAI API smoke ladder is exactly what was approved', () => {
  it('names four identifiers and no others', () => {
    expect(ladderFor('openaiAPI').map((entry) => entry.modelID).sort()).toEqual([...APPROVED].sort());
  });

  it('asks each of them once, at low, and never at a level the body cannot carry', () => {
    for (const entry of ladderFor('openaiAPI')) {
      // ONE RUNG. A smoke ladder that asked two efforts per model would double a metered bill to
      // answer a question — who is on the other end — that the first request already answers.
      expect(entry.desiredEfforts, entry.modelID).toEqual(['low']);
      expect(OPENAI_API_EFFORT_LEVELS, entry.modelID).toContain(entry.desiredEfforts[0] as EffortLevel);
    }
    expect(ladderConfigurations().filter((entry) => entry.provider === 'openaiAPI')).toHaveLength(4);
  });

  it('is authorised as its own scope, and reconciles with nothing missing and nothing extra', () => {
    expect(OPENAI_API_IDENTITY_ADDITIONS.map((entry) => entry.modelID).sort()).toEqual([...APPROVED].sort());
    const result = reconcileCohort();
    expect(result.extraInLadder).toEqual([]);
    expect(result.missingFromLadder).toEqual([]);
    for (const entry of OPENAI_API_IDENTITY_ADDITIONS) {
      expect(AUTHORIZED_COHORT.map(configurationKey)).toContain(configurationKey(entry));
    }
  });

  it('leaves the Claude, Codex and OpenCode ladders exactly as they were', () => {
    expect(ladderFor('claudeCLI').map((entry) => entry.modelID)).toEqual([
      'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8',
    ]);
    expect(ladderFor('codexCLI').map((entry) => `${entry.modelID}:${entry.desiredEfforts.join('+')}`)).toEqual([
      'gpt-5.6-luna:max', 'gpt-5.6-terra:medium', 'gpt-5.6-sol:medium+max', 'gpt-6-astra:medium+max',
    ]);
    // The free OpenCode pool arrived on the Mac mini line under its own authorisation; this pass left
    // the OpenCode ladder as that line defined it, and asserts it is exactly Union Alpha plus that pool.
    expect(ladderFor('opencodeCLI').map((entry) => entry.modelID)).toEqual([
      'opencode/union-alpha', ...FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => entry.modelID),
    ]);
  });

  it('keeps the two routes to the same name apart, so proving one never proves the other', () => {
    for (const modelID of APPROVED) {
      const rows = DESIRED_CANDIDATE_LADDER.filter((entry) => entry.modelID === modelID);
      expect(rows.map((entry) => entry.provider).sort(), modelID).toEqual(['codexCLI', 'openaiAPI']);
    }
  });
});

// MARK: - A listing still proves nothing, and cannot widen the ladder

describe('a catalogue cannot put anything on this ladder', () => {
  it('records every listed model as unproven, including the four this ladder plans to ask for', () => {
    const body = JSON.stringify({ data: [...APPROVED, ...NON_TEXT_CATALOGUE].map((id) => ({ id })) });
    const rows = parseModelListing(body, 'openaiAPI', 'now');
    expect(rows).toHaveLength(APPROVED.length + NON_TEXT_CATALOGUE.length);
    expect(rows.filter((model) => model.availability === 'proven')).toEqual([]);
    expect(rows.filter((model) => model.verifiedModelID !== '')).toEqual([]);
    for (const model of rows.filter((row) => APPROVED.includes(row.modelID))) {
      expect(model.availability, model.modelID).toBe('unproven');
      expect(model.evidence, model.modelID).toMatch(/DISCOVERED, NOT PROVEN/);
      expect(model.evidence, model.modelID).toMatch(/identity smoke test/);
    }
  });

  it('makes nothing selectable, however many models the account is served', () => {
    const body = JSON.stringify({ data: [...APPROVED, ...NON_TEXT_CATALOGUE].map((id) => ({ id })) });
    const status: ProviderStatus = {
      provider: 'openaiAPI', label: 'OpenAI API', executionClass: 'meteredAPI', billingBasis: 'perToken',
      reachability: 'ready', detail: '', probe: 'invoked', checkedAt: 'now',
      models: parseModelListing(body, 'openaiAPI', 'now'),
    };
    expect(selectableModels([status])).toEqual([]);
  });

  it('NO NON-TEXT ENDPOINT CAN REACH THIS LADDER: the ladder is a constant, not a filter over a listing', () => {
    const before = ladderFor('openaiAPI').map((entry) => entry.modelID);
    parseModelListing(JSON.stringify({ data: NON_TEXT_CATALOGUE.map((id) => ({ id })) }), 'openaiAPI', 'now');
    expect(ladderFor('openaiAPI').map((entry) => entry.modelID)).toEqual(before);
    for (const id of NON_TEXT_CATALOGUE) {
      expect(DESIRED_CANDIDATE_LADDER.some((entry) => entry.modelID === id), id).toBe(false);
    }
  });
});

// MARK: - Identity comes from the response envelope, or it does not come at all

describe('what one OpenAI API request can establish about who answered', () => {
  it('proves a model only when the API names it and the name matches exactly', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIStreamFrames('gpt-5.6-sol'));
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'low' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(result.verdict).toBe('proven');
      expect(result.identityState).toBe('verified');
      expect(result.reportedModelID).toBe('gpt-5.6-sol');
      expect(result.evidence).toMatch(/named gpt-5\.6-sol as the model that answered/);
      // The request that proved it is the request the binding froze: `low`, on the wire, verbatim.
      expect(JSON.parse(provider.requests[0].body).reasoning_effort).toBe('low');
      expect(JSON.parse(provider.requests[0].body).model).toBe('gpt-5.6-sol');
      expect(modelsFromSmokes([result])[0].availability).toBe('proven');
      expect(modelsFromSmokes([result])[0].verifiedModelID).toBe('gpt-5.6-sol');
    } finally { await provider.close(); }
  });

  it('A DATED BUILD IS NOT THE NAME THAT WAS FROZEN: a mismatch never verifies the requested id', async () => {
    const provider = await startMockProvider('');
    try {
      // The substitution that actually happens on this API: an alias is answered by the dated build
      // behind it. Cernum does not prefix-match and does not strip the date.
      provider.streamFrames(openAIStreamFrames('gpt-5.6-sol-2026-05-01'));
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'low' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(result.verdict).toBe('substituted');
      expect(result.identityState).toBe('unverifiable');
      expect(result.reportedModelID).toBe('gpt-5.6-sol-2026-05-01');
      expect(result.evidence).toMatch(/is not a result for the model that was asked for/);
      const [row] = modelsFromSmokes([result]);
      expect(row.availability).toBe('refused');
      expect(row.verifiedModelID).toBe('');
    } finally { await provider.close(); }
  });

  it('carries an answer that names no model as unverifiable, and never as the Codex exception', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIStreamFrames('gpt-5.6-luna', { nameTheModel: false }));
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-luna', effort: 'low' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(result.answerText).toBe('ok');
      expect(result.reportedModelID).toBe('');
      expect(result.verdict).toBe('unverifiable');
      // `requestAcceptedIdentityUnverifiable` is the CODEX exception and applies to no other
      // provider. The OpenAI API does report identity, so a request of it that named no model has a
      // different problem, and recording it under that state would conceal which one.
      expect(result.identityState).toBe('unverifiable');
      expect(modelsFromSmokes([result])[0].availability).toBe('unproven');
    } finally { await provider.close(); }
  });

  it('never treats the model\'s own prose as identity: only the envelope counts', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames([
        JSON.stringify({ choices: [{ delta: { content: 'I am GPT-5.6 Terra, and I am happy to help.' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 12 } }),
      ]);
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-terra', effort: 'low' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(result.answerText).toMatch(/GPT-5\.6 Terra/);
      expect(result.reportedModelID).toBe('');
      expect(result.verdict).toBe('unverifiable');
    } finally { await provider.close(); }
  });

  it('states in one place what an OpenAI response can and cannot settle', () => {
    expect(OPENAI_API_IDENTITY_EVIDENCE).toMatch(/response envelope/);
    expect(OPENAI_API_IDENTITY_EVIDENCE).toMatch(/substituted/);
  });
});

// MARK: - Effort levels are expressed verbatim or refused

describe('an effort level this API cannot carry is refused, never mapped onto the nearest one', () => {
  it('sends the levels it can express unchanged', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh'] as EffortLevel[]) {
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort });
      expect(unexpressedAPISettings(binding), effort).toEqual([]);
      expect(buildAPIBody(binding, 'x', true).reasoning_effort, effort).toBe(effort);
    }
    const none = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'none' });
    expect(buildAPIBody(none, 'x', true).reasoning_effort).toBeUndefined();
  });

  it('THE REGRESSION ITSELF: `max` is never quietly sent as `high`', () => {
    const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'max' });
    expect(OPENAI_API_EFFORT_LEVELS).not.toContain('max');
    expect(unexpressedAPISettings(binding)).toHaveLength(1);
    expect(unexpressedAPISettings(binding)[0]).toMatch(/effort 'max'/);
    // The old line read `binding.effort === 'max' ? 'high' : binding.effort`, which froze one level
    // in the manifest and put a different one on the wire.
    expect(buildAPIBody(binding, 'x', true).reasoning_effort).not.toBe('high');
  });

  it('refuses such a binding BEFORE a socket opens, so nothing is sent and nothing is billed', async () => {
    const provider = await startMockProvider('');
    try {
      provider.streamFrames(openAIStreamFrames('gpt-5.6-sol'));
      const binding = buildSmokeBinding({ provider: 'openaiAPI', modelID: 'gpt-5.6-sol', effort: 'max' });
      const adapter = new MeteredAPIAdapter({ provider: 'openaiAPI', baseURL: provider.baseURL, credentials });
      const result = await identitySmokeTest(binding, adapter);

      expect(provider.requests).toEqual([]);
      expect(result.verdict).toBe('refused');
      expect(result.identityState).toBe('unverifiable');
      expect(result.evidence).toMatch(/budgetRefused/);
      expect(result.evidence).toMatch(/Nothing was sent and nothing was billed/);
      expect(result.marginalAPIChargeMicroUSD.provenance).toBe('unavailable');
    } finally { await provider.close(); }
  });

  it('does not narrow the Anthropic API, which expresses reasoning as a budget rather than an enum', () => {
    for (const effort of ['max', 'xhigh', 'minimal'] as EffortLevel[]) {
      const binding = buildSmokeBinding({ provider: 'anthropicAPI', modelID: 'claude-haiku-4-5', effort });
      expect(unexpressedAPISettings(binding), effort).toEqual([]);
    }
  });
});

// MARK: - The money gate, which is where this pass stops

describe('a metered smoke of this ladder is refused until it is priced or acknowledged', () => {
  const bindings = () => APPROVED.map((modelID) =>
    buildSmokeBinding({ provider: 'openaiAPI', modelID, effort: 'low' }));

  it('builds every binding as metered, keyed to a key the user supplied, and unproven', () => {
    for (const binding of bindings()) {
      expect(binding.billingBasis, binding.candidate).toBe('meteredAPI');
      expect(binding.executionClass, binding.candidate).toBe('meteredAPI');
      expect(binding.authorizationMode, binding.candidate).toBe('apiKeyEnvironment');
      expect(binding.identityState, binding.candidate).toBe('unverifiable');
      expect(binding.verifiedModelID, binding.candidate).toBe('');
      // No price is held for any of these, so no bound can be computed — and no bound is invented.
      expect(binding.pricing, binding.candidate).toBeNull();
      expect(projectedMeteredBoundMicroUSD(binding), binding.candidate).toBeUndefined();
    }
  });

  it('refuses all four unpriced, and will not let an acknowledgement cover a scope of four', () => {
    const unpriced = authorizeSmoke({ bindings: bindings(), unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(unpriced) && unpriced.code).toBe('unpricedNeedsAcknowledgement');

    const acknowledged = authorizeSmoke({ bindings: bindings(), unpricedAcknowledged: true });
    expect(isSmokeAuthorizationRefusal(acknowledged) && acknowledged.code).toBe('unpricedNeedsOneAttemptScope');
  });

  it('authorises the four against a ceiling once prices are supplied, and records the bound it checked', () => {
    const priced = APPROVED.map((modelID) =>
      buildSmokeBinding({ provider: 'openaiAPI', modelID, effort: 'low', pricing: PRICES }));
    const perRequest = projectedMeteredBoundMicroUSD(priced[0])!;
    const authorization = authorizeSmoke({ bindings: priced, ceilingMicroUSD: 1_000_000, unpricedAcknowledged: false });
    expect(isSmokeAuthorizationRefusal(authorization)).toBe(false);
    if (isSmokeAuthorizationRefusal(authorization)) return;
    expect(authorization.kind).toBe('pricedCeiling');
    expect(authorization.requestCount).toBe(4);
    expect(authorization.projectedBoundMicroUSD).toBe(perRequest * 4);
  });
});

// MARK: - The command's own scope, previewed and never sent

describe('`cernum smoke openaiAPI` asks for these four and refuses anything else', () => {
  const root = path.resolve(__dirname, '..', '..');
  const NODE_DIRECTORY = path.dirname(process.execPath);
  let campaigns: string;

  beforeEach(() => { campaigns = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-openai-ladder-')); });
  afterEach(() => { fs.rmSync(campaigns, { recursive: true, force: true }); });

  function cernum(...args: string[]) {
    const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
      cwd: root,
      encoding: 'utf8',
      // No key, so a request that somehow escaped the dry run would refuse at the credential rather
      // than reach OpenAI. The dry run is the assertion; this is the second lock on the same door.
      env: { ...process.env, OPENAI_API_KEY: '', PATH: `${NODE_DIRECTORY}:/usr/bin:/bin` },
    });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  }

  it('previews exactly four requests, and states that a live run of them is not authorized', () => {
    const output = cernum('smoke', 'openaiAPI', '--all-ladder', '--dry-run');
    expect(output).toMatch(/DRY RUN — nothing below is sent/);
    expect(output).toMatch(/requests to be sent\s+4/);
    expect(output).toMatch(/AUTHORIZATION REQUIRED/);
    expect(output).toMatch(/cost UNAVAILABLE \(no price supplied\)/);
    for (const modelID of APPROVED) expect(output, modelID).toContain(modelID);
    expect(output).toMatch(/No request was sent/);
  }, 60_000);

  it('refuses a catalogue identifier that is not on the ladder, and invents nothing', () => {
    const output = cernum('smoke', 'openaiAPI', '--models', 'text-embedding-3-large', '--dry-run');
    expect(output).toMatch(/is not on openaiAPI's intended ladder/);
    expect(output).toMatch(/a smoke test never invents an identifier/);
    expect(output).not.toMatch(/requests to be sent/);
  }, 60_000);
});
