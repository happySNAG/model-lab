// codex-cli 0.155.0 · the applied effort moved, and the join went quiet rather than wrong.
//
// A four-request Codex identity smoke on 2026-09-20 captured `reasoning_effort` for every one of its
// four conversations and reported "effort applied: not reported · correlated: false" for all four.
// Nothing was lost in transit: the observer was reading 0.154.0's attribute names.
//
//   0.154.0  effort on the TRACE spans, as `codex.turn.reasoning_effort`, and those spans carried
//            `conversation.id`, which is what the observation is keyed by.
//   0.155.0  effort on the `codex.conversation_starts` LOG record, as a flat `reasoning_effort`,
//            and NO span carries `conversation.id` at all — 1753 of them in the capture, not one
//            with a conversation on it. So the old names were not merely missing, they had become
//            unjoinable even if present.
//
// These cases run the REAL captured payloads through the real observer. The fixture is verbatim.
//
// WHAT THIS DOES NOT DO, and must never do. Correlating an effort is not identifying a model. The
// `model` and `slug` attributes in this telemetry are what the CLIENT SENT, and a client naming its
// own request is not a model naming itself in a reply. The last case here drives a whole campaign on
// a complete, correlated, real observation and asserts the row is STILL
// `requestAcceptedIdentityUnverifiable` with an empty `reportedModelID`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OTLPObserver } from '../../src/engine/otlp-observer';
import { Campaign } from '../../src/engine/campaign';
import { attemptMetricsFromRow } from '../../src/engine/frontier-metrics';
import {
  configurationFor, envelopeOf, routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';
import {
  CODEX_0155_CONVERSATION_STARTS, CODEX_0155_HTTP_SSE_COMPLETED_PAIR, CODEX_0155_MODEL_MANAGER_SPAN,
  CODEX_0155_SPANS_CARRYING_THE_CONVERSATION,
} from './fixtures/codex-otlp-0155-captured';

async function post(endpoint: string, payload: unknown): Promise<void> {
  await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

/** The captured start for one requested model at one effort. Throws rather than testing nothing. */
function captured(model: string, effort: string): { conversationID: string; payload: unknown } {
  const found = CODEX_0155_CONVERSATION_STARTS.find(
    (entry) => entry.requestedModel === model && entry.appliedEffort === effort);
  if (found === undefined) throw new Error(`no captured conversation for ${model} at ${effort}`);
  return { conversationID: found.conversationID, payload: found.payload };
}

/** The same captured payload with one attribute's value rewritten, for the conflict case. */
function withAttribute(payload: unknown, key: string, value: string): unknown {
  return JSON.parse(JSON.stringify(payload), (_name, node) => (
    node !== null && typeof node === 'object' && (node as { key?: unknown }).key === key
      ? { ...node, value: { stringValue: value } }
      : node));
}

let directory: string;
beforeEach(() => { directory = temporaryRoot('otlp-0155-'); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

async function observerFor(name: string): Promise<OTLPObserver> {
  return OTLPObserver.start({
    evidenceFile: path.join(directory, `${name}.jsonl`),
    observeTimeoutMilliseconds: 200,
    shutdownGraceMilliseconds: 0,
  });
}

describe('the applied effort is recovered from codex-cli 0.155.0 telemetry', () => {
  it('correlates a MEDIUM request to the medium effort the CLI says it applied', async () => {
    const observer = await observerFor('medium');
    const { conversationID, payload } = captured('gpt-5.6-sol', 'medium');
    await post(observer.endpoint, payload);
    const turn = await observer.observe(conversationID);
    expect(turn?.correlated).toBe(true);
    expect(turn?.turnReasoningEffort).toBe('medium');
    expect(turn?.effortAmbiguous).toBeUndefined();
    await observer.stop();
  });

  it('correlates a MAX request to the max effort the CLI says it applied', async () => {
    const observer = await observerFor('max');
    const { conversationID, payload } = captured('gpt-6-astra', 'max');
    await post(observer.endpoint, payload);
    const turn = await observer.observe(conversationID);
    expect(turn?.correlated).toBe(true);
    expect(turn?.turnReasoningEffort).toBe('max');
    await observer.stop();
  });

  it('recovers ALL FOUR captured conversations, each with its own effort', async () => {
    const observer = await observerFor('all-four');
    for (const entry of CODEX_0155_CONVERSATION_STARTS) await post(observer.endpoint, entry.payload);
    for (const entry of CODEX_0155_CONVERSATION_STARTS) {
      const turn = await observer.observe(entry.conversationID);
      expect(turn?.correlated).toBe(true);
      expect(turn?.turnReasoningEffort).toBe(entry.appliedEffort);
    }
    const summary = await observer.stop();
    expect(summary.conversationCount).toBe(4);
    expect(summary.correlatedCount).toBe(4);
  });
});

describe('a join that cannot be made deterministically is not made', () => {
  it('does not cross-associate four SEQUENTIAL requests, including two of the same model', async () => {
    // The trap this guards: gpt-5.6-sol ran at medium and then at max, and gpt-6-astra did the same.
    // A join keyed on anything but the conversation — the model, or arrival order — reads one of
    // each pair as the other.
    const observer = await observerFor('sequential');
    for (const entry of CODEX_0155_CONVERSATION_STARTS) await post(observer.endpoint, entry.payload);
    const solMedium = captured('gpt-5.6-sol', 'medium');
    const solMax = captured('gpt-5.6-sol', 'max');
    const astraMedium = captured('gpt-6-astra', 'medium');
    const astraMax = captured('gpt-6-astra', 'max');
    expect(solMedium.conversationID).not.toBe(solMax.conversationID);
    expect((await observer.observe(solMedium.conversationID))?.turnReasoningEffort).toBe('medium');
    expect((await observer.observe(solMax.conversationID))?.turnReasoningEffort).toBe('max');
    expect((await observer.observe(astraMedium.conversationID))?.turnReasoningEffort).toBe('medium');
    expect((await observer.observe(astraMax.conversationID))?.turnReasoningEffort).toBe('max');
    await observer.stop();
  });

  it('IGNORES model-manager startup tracing, which names a model nobody requested', async () => {
    // `gpt-5.6-luna` appears four times in the capture, only ever on `codex_models_manager::manager`
    // startup spans, and it was neither requested nor answered by anything. It carries no
    // conversation, so it must produce no observation and must not disturb one that exists.
    const observer = await observerFor('startup');
    const { conversationID, payload } = captured('gpt-5.6-sol', 'medium');
    await post(observer.endpoint, payload);
    await post(observer.endpoint, CODEX_0155_MODEL_MANAGER_SPAN);
    const turn = await observer.observe(conversationID);
    expect(turn?.turnReasoningEffort).toBe('medium');
    expect(turn?.correlated).toBe(true);
    const summary = await observer.stop();
    // The startup span started no conversation of its own.
    expect(summary.conversationCount).toBe(1);
    // And nothing about it reached the observation, which has no model field to reach in any case.
    expect(JSON.stringify(turn)).not.toContain('luna');
  });

  it('leaves an AMBIGUOUS effort unavailable rather than guessing between two values', async () => {
    const observer = await observerFor('ambiguous');
    const { conversationID, payload } = captured('gpt-5.6-sol', 'medium');
    await post(observer.endpoint, payload);
    // The same conversation, now claiming a different effort. Something is wrong upstream, and the
    // answer is not "whichever arrived last".
    await post(observer.endpoint, withAttribute(payload, 'reasoning_effort', 'max'));
    const turn = await observer.observe(conversationID);
    expect(turn?.effortAmbiguous).toBe(true);
    expect(turn?.turnReasoningEffort).toBeUndefined();
    expect(turn?.correlated).toBe(false);
    // A later record agreeing with one of them does not break the tie.
    await post(observer.endpoint, payload);
    const after = await observer.observe(conversationID);
    expect(after?.turnReasoningEffort).toBeUndefined();
    expect(after?.effortAmbiguous).toBe(true);
    // The conversation is still known, and still joinable.
    expect(after?.recordCount).toBeGreaterThan(0);
    expect(after?.correlationKey).toMatch(/^\[REDACTED:conversation\.id:\d+\]$/);
    await observer.stop();
  });
});

describe('recovering the effort does NOT recover an identity', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => { campaignRoot = temporaryRoot('otlp-0155-identity-'); root = path.join(campaignRoot, 'run'); });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  it('keeps a fully correlated REAL observation at requestAcceptedIdentityUnverifiable', async () => {
    // The observation here is the one the real capture produces, correlated and carrying the effort.
    const observer = await observerFor('identity');
    const { conversationID, payload } = captured('gpt-5.6-sol', 'medium');
    await post(observer.endpoint, payload);
    const observed = await observer.observe(conversationID);
    await observer.stop();
    expect(observed?.correlated).toBe(true);
    expect(observed?.turnReasoningEffort).toBe('medium');

    const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', {
      effort: 'medium', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
    }));
    const { host } = routingHost({
      envelope,
      adapters: {
        codexCLI: scriptedAdapter('codexCLI', {}, {
          // `codex exec` names no model, however much telemetry surrounds it.
          reportedModelID: '',
          usage: { inputTokens: 7_922, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, visibleOutputTokens: 5 },
          otlpTurn: observed,
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    const rows = [...campaign.ledger.results.values()];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The effort is now known...
      expect(row.otlpCorrelated).toBe(true);
      expect(row.otlpTurnReasoningEffort).toBe('medium');
      expect(row.otlpEffortMatchesBinding).toBe(true);
      // ...and the identity is exactly as unestablished as it was before.
      expect(row.reportedModelID).toBe('');
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      const metrics = attemptMetricsFromRow(row as Record<string, unknown>)!;
      expect(metrics.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(metrics.reportedModelID).toBe('');
    }
  });
});

// MARK: - Two shapes the real binary wrote that the fake did not (real-binary loopback matrix, 2026-09-21)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The captured spans with RAW ids put back where the capture has placeholders. The ids are synthetic. */
function spansWithRawIDs(conversationID: string): unknown {
  return JSON.parse(JSON.stringify(CODEX_0155_SPANS_CARRYING_THE_CONVERSATION)
    .split('[REDACTED:conversation.id:1]').join(conversationID)
    .split('[REDACTED:identifier:2]').join('01a0c692-0000-7000-8000-0000000000aa'));
}

describe('real 0.155.0 records: the usage record is kept, and the conversation id reaches no file', () => {
  it('keeps the usage record of an HTTP/SSE request, not the bare record written beside it, and counts a re-delivery once', async () => {
    const observer = await observerFor('sse-pair');
    await post(observer.endpoint, CODEX_0155_HTTP_SSE_COMPLETED_PAIR);
    await post(observer.endpoint, CODEX_0155_HTTP_SSE_COMPLETED_PAIR);
    const turn = await observer.observe('[REDACTED:conversation.id:1]');
    expect(turn?.requestUsage).toHaveLength(1);
    expect(turn?.requestUsage?.[0]).toMatchObject({
      effort: 'medium', inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0,
      outputTokens: 50, reasoningTokens: 20, toolTokens: 1050,
    });
    expect(turn?.requestReasoningEfforts).toEqual(['medium']);
    await observer.stop();
  });

  it('redacts the id under `thread.id`, `thread_id` and inside a debug string, to the conversation\'s own placeholder', async () => {
    const raw = '01a0c692-0000-7000-8000-000000000001';
    const observer = await observerFor('spans');
    await post(observer.endpoint, withAttribute(captured('gpt-5.6-sol', 'medium').payload, 'conversation.id', raw));
    await post(observer.endpoint, spansWithRawIDs(raw));
    const turn = await observer.observe(raw);
    const stopped = await observer.stop();
    const written = fs.readFileSync(stopped.evidenceFile, 'utf8');
    expect(written).not.toContain(raw);
    expect(written).not.toMatch(UUID);
    const key = turn!.correlationKey.replace(/[[\]]/g, '\\$&');
    expect(written).toMatch(new RegExp(`Thread \\{ thread_id: \\\\"${key}\\\\" \\}`));
    expect(written).toMatch(new RegExp(`"key":"thread_id","value":\\{"stringValue":"${key}"\\}`));
    expect(stopped.leakAuditClean).toBe(true);
  });

  it('redacts an id it has not yet seen as a conversation too, and its audit names a leak without repeating it', async () => {
    const raw = '01a0c692-0000-7000-8000-000000000002';
    const observer = await observerFor('spans-first');
    // Spans before any record naming the conversation: the id is not yet KNOWN, and still does not survive.
    await post(observer.endpoint, spansWithRawIDs(raw));
    await post(observer.endpoint, withAttribute(captured('gpt-5.6-sol', 'medium').payload, 'conversation.id', raw));
    await observer.observe(raw);
    // Something ELSE wrote the raw id into the file. The audit has to catch it, and must not echo it.
    fs.appendFileSync(path.join(directory, 'spans-first.jsonl'), `${JSON.stringify({ stray: raw })}\n`);
    const stopped = await observer.stop();
    expect(stopped.leakAuditClean).toBe(false);
    expect(stopped.leaks).toEqual([
      expect.stringMatching(/^conversation id \[REDACTED:conversation\.id:\d+\] written unredacted$/),
      '1 UUID-shaped identifier(s) written unredacted',
    ]);
    expect(JSON.stringify(stopped.leaks)).not.toContain(raw);
  });
});
