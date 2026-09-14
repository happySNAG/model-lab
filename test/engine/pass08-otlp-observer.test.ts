// Pass 8 · reading a tool's telemetry without keeping who ran it, and without learning who answered.
//
// Two properties are load-bearing and each has its own describe block:
//
//   NOTHING IDENTIFYING REACHES A FILE. Every record `codex` exports carries `user.email` and
//   `user.account_id` in clear. Redaction happens at ingest, and these tests assert on what is ON
//   DISK rather than on what the redactor says it did.
//   NOTHING ESTABLISHES IDENTITY. A Codex row carrying a complete observation is still
//   `requestAcceptedIdentityUnverifiable` with an empty `reportedModelID`. This is the guarantee
//   Pass 5B through Pass 7 rest on, and telemetry is exactly the kind of thing that erodes it.
//
// The payload fixture is the real shape, reduced: attribute names and nesting exactly as codex-cli
// 0.154.0 emitted them to a loopback collector on 2026-09-14.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OTLPObserver, attributeSets, codexOTLPConfigArgument } from '../../src/engine/otlp-observer';
import { buildCodexExecArguments, parseCodexExecJSONL } from '../../src/engine/codex-cli';
import { Campaign, campaignPaths, isProviderThrottle } from '../../src/engine/campaign';
import { attemptMetricsFromRow } from '../../src/engine/frontier-metrics';
import {
  configurationFor, envelopeOf, routingHost, scriptedAdapter, subscriptionBinding, temporaryRoot,
} from './frontier-harness';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/identity-admission';

const THREAD = '01a0a12c-132c-7850-af85-3db4c290c727';
const EMAIL = 'someone@example.test';

/** A log payload in the shape codex actually sends: identifiers on every record. */
function logPayload(conversationID = THREAD): unknown {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'host.name', value: { stringValue: 'a-machine.local' } }] },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: 'codex.conversation_starts' } },
            { key: 'conversation.id', value: { stringValue: conversationID } },
            { key: 'user.email', value: { stringValue: EMAIL } },
            { key: 'user.account_id', value: { stringValue: '00000000-0000-0000-0000-000000000000' } },
            { key: 'model', value: { stringValue: 'gpt-5.6-sol' } },
            { key: 'reasoning_effort', value: { stringValue: 'medium' } },
            { key: 'mcp_servers', value: { stringValue: 'codex_apps' } },
          ],
        }],
      }],
    }],
  };
}

/** The TRACE payload, which is where the effort and the token decomposition actually live. */
function tracePayload(conversationID = THREAD, effort = 'medium'): unknown {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          name: 'session_task.turn',
          attributes: [
            { key: 'conversation.id', value: { stringValue: conversationID } },
            { key: 'user.email', value: { stringValue: EMAIL } },
            { key: 'codex.turn.reasoning_effort', value: { stringValue: effort } },
            { key: 'codex.turn.token_usage.input_tokens', value: { stringValue: '14095' } },
            { key: 'codex.turn.token_usage.non_cached_input_tokens', value: { stringValue: '3471' } },
            { key: 'codex.turn.token_usage.cached_input_tokens', value: { stringValue: '10624' } },
            { key: 'codex.turn.token_usage.cache_write_input_tokens', value: { stringValue: '0' } },
            { key: 'codex.turn.token_usage.output_tokens', value: { stringValue: '5' } },
            { key: 'codex.turn.token_usage.reasoning_output_tokens', value: { stringValue: '0' } },
            { key: 'codex.turn.token_usage.total_tokens', value: { stringValue: '14100' } },
          ],
        }, {
          name: 'handle_responses',
          attributes: [
            { key: 'conversation.id', value: { stringValue: conversationID } },
            { key: 'codex.request.reasoning_effort', value: { stringValue: effort } },
          ],
        }],
      }],
    }],
  };
}

async function post(endpoint: string, payload: unknown): Promise<void> {
  await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

let directory: string;
beforeEach(() => { directory = temporaryRoot('otlp-observer-'); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

// MARK: - The collector

describe('the collector binds loopback and keeps what arrives', () => {
  it('listens on 127.0.0.1 with an ephemeral port, so two campaigns cannot collide', async () => {
    const first = await OTLPObserver.start({ evidenceFile: path.join(directory, 'a.jsonl'), shutdownGraceMilliseconds: 0 });
    const second = await OTLPObserver.start({ evidenceFile: path.join(directory, 'b.jsonl'), shutdownGraceMilliseconds: 0 });
    expect(first.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(second.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.endpoint).not.toBe(second.endpoint);
    await first.stop();
    await second.stop();
  });

  it('reads the effort and the token decomposition out of the TRACE payload', async () => {
    const observer = await OTLPObserver.start({ evidenceFile: path.join(directory, 'c.jsonl'), observeTimeoutMilliseconds: 200, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, logPayload());
    await post(observer.endpoint, tracePayload());
    const turn = await observer.observe(THREAD);
    expect(turn?.correlated).toBe(true);
    expect(turn?.turnReasoningEffort).toBe('medium');
    expect(turn?.requestReasoningEffort).toBe('medium');
    expect(turn?.inputTokens).toBe(14_095);
    expect(turn?.nonCachedInputTokens).toBe(3_471);
    expect(turn?.cachedInputTokens).toBe(10_624);
    expect(turn?.outputTokens).toBe(5);
    expect(turn?.totalTokens).toBe(14_100);
    expect(turn?.mcpServers).toBe('codex_apps');
    await observer.stop();
  });

  it('returns UNCORRELATED rather than waiting forever when no turn span arrives', async () => {
    const observer = await OTLPObserver.start({ evidenceFile: path.join(directory, 'd.jsonl'), observeTimeoutMilliseconds: 120, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, logPayload());
    const turn = await observer.observe(THREAD);
    // Logs arrived, so the conversation is known; no turn span, so nothing is claimed about effort.
    expect(turn?.correlated).toBe(false);
    expect(turn?.turnReasoningEffort).toBeUndefined();
    expect(turn?.recordCount).toBeGreaterThan(0);
    await observer.stop();
  });

  it('returns a PENDING observation for a thread it has not seen, and undefined for no thread at all', async () => {
    const observer = await OTLPObserver.start({ evidenceFile: path.join(directory, 'e.jsonl'), observeTimeoutMilliseconds: 80, shutdownGraceMilliseconds: 0 });
    // Not undefined, and the difference matters: this tool's spans arrive after the attempt closes,
    // so "nothing yet" is the ordinary case and it still needs a key to be joined on later.
    const pending = await observer.observe('a-thread-that-never-ran');
    expect(pending).toBeDefined();
    expect(pending!.correlated).toBe(false);
    expect(pending!.recordCount).toBe(0);
    expect(pending!.correlationKey).toMatch(/^\[REDACTED:conversation\.id:\d+\]$/);
    // An empty thread id is a different thing entirely: there is nothing to key on, and nothing is
    // invented for it.
    expect(await observer.observe('')).toBeUndefined();
    await observer.stop();
  });

  it('keeps conversations apart, so one attempt cannot read another\'s effort', async () => {
    const observer = await OTLPObserver.start({ evidenceFile: path.join(directory, 'f.jsonl'), observeTimeoutMilliseconds: 150, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, tracePayload('conversation-one', 'medium'));
    await post(observer.endpoint, tracePayload('conversation-two', 'max'));
    expect((await observer.observe('conversation-one'))?.turnReasoningEffort).toBe('medium');
    expect((await observer.observe('conversation-two'))?.turnReasoningEffort).toBe('max');
    await observer.stop();
  });
});

// MARK: - Redaction, proven against the file

describe('no identifier reaches the evidence file', () => {
  it('redacts user.email, user.account_id, conversation.id and host.name AT INGEST', async () => {
    const evidenceFile = path.join(directory, 'g.jsonl');
    const observer = await OTLPObserver.start({ evidenceFile, observeTimeoutMilliseconds: 150, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, logPayload());
    await post(observer.endpoint, tracePayload());
    const summary = await observer.stop();

    // Asserted on the BYTES, not on the summary. A redactor is only as good as its output.
    const written = fs.readFileSync(evidenceFile, 'utf8');
    expect(written).not.toContain(EMAIL);
    expect(written).not.toContain(THREAD);
    expect(written).not.toContain('a-machine.local');
    expect(written).toContain('[REDACTED:user.email:');
    expect(written).toContain('[REDACTED:conversation.id:');
    expect(summary.leakAuditClean).toBe(true);
    expect(summary.leaks).toEqual([]);
    expect(summary.redactionCount).toBeGreaterThan(0);
  });

  it('keeps the non-identifying attributes, so the file is still evidence', async () => {
    const evidenceFile = path.join(directory, 'h.jsonl');
    const observer = await OTLPObserver.start({ evidenceFile, observeTimeoutMilliseconds: 150, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, tracePayload(THREAD, 'max'));
    await observer.stop();
    const written = fs.readFileSync(evidenceFile, 'utf8');
    expect(written).toContain('codex.turn.reasoning_effort');
    expect(written).toContain('max');
    expect(written).toContain('codex.turn.token_usage.non_cached_input_tokens');
  });

  it('gives one identifier ONE placeholder, so two records stay correlatable without it', async () => {
    const evidenceFile = path.join(directory, 'i.jsonl');
    const observer = await OTLPObserver.start({ evidenceFile, observeTimeoutMilliseconds: 150, shutdownGraceMilliseconds: 0 });
    await post(observer.endpoint, logPayload());
    await post(observer.endpoint, tracePayload());
    const summary = await observer.stop();
    const written = fs.readFileSync(evidenceFile, 'utf8');
    const placeholders = new Set([...written.matchAll(/\[REDACTED:conversation\.id:\d+\]/g)].map((m) => m[0]));
    expect(placeholders.size).toBe(1);
    expect(summary.distinctIdentifiers).toBeGreaterThan(1);
  });

  it('refuses to keep the bytes of a payload it cannot parse, because it cannot redact one', async () => {
    const evidenceFile = path.join(directory, 'j.jsonl');
    const observer = await OTLPObserver.start({ evidenceFile, observeTimeoutMilliseconds: 80, shutdownGraceMilliseconds: 0 });
    await fetch(observer.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: `binary ${EMAIL} payload`,
    });
    const summary = await observer.stop();
    const written = fs.readFileSync(evidenceFile, 'utf8');
    expect(written).not.toContain(EMAIL);
    expect(written).toContain('"unreadable":true');
    expect(summary.payloadCount).toBe(1);
    expect(summary.leakAuditClean).toBe(true);
  });

  it('truncates the file on start, so a resumed run is not two runs merged', async () => {
    const evidenceFile = path.join(directory, 'k.jsonl');
    fs.writeFileSync(evidenceFile, '{"stale":true}\n', 'utf8');
    const observer = await OTLPObserver.start({ evidenceFile, shutdownGraceMilliseconds: 0 });
    await observer.stop();
    expect(fs.readFileSync(evidenceFile, 'utf8')).not.toContain('stale');
  });
});

// MARK: - The argument the CLI is actually given

describe('pointing one invocation at the collector', () => {
  const binding = subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', { effort: 'medium' });

  it('configures ALL THREE exporters, because the effort lives on the traces', () => {
    const argument = codexOTLPConfigArgument('http://127.0.0.1:41234');
    expect(argument).toContain('exporter =');
    expect(argument).toContain('trace_exporter =');
    expect(argument).toContain('metrics_exporter =');
    expect(argument).toContain('http://127.0.0.1:41234');
  });

  it('adds the override only when an endpoint was given, and discloses it', () => {
    const without = buildCodexExecArguments(binding, { workingDirectory: '/tmp/x' });
    expect(without.args.join(' ')).not.toContain('otel=');
    expect(without.activeIsolation.join(' ')).not.toContain('OpenTelemetry');

    const with_ = buildCodexExecArguments(binding, { workingDirectory: '/tmp/x', otlpEndpoint: 'http://127.0.0.1:9' });
    expect(with_.args.join(' ')).toContain('otel=');
    // Where a tool's telemetry goes is part of what a reader must be able to check.
    expect(with_.activeIsolation.join(' ')).toContain('http://127.0.0.1:9');
    expect(with_.activeIsolation.join(' ')).toContain('establishes which model answered');
  });

  it('keeps every isolation flag it had before', () => {
    const args = buildCodexExecArguments(binding, { workingDirectory: '/tmp/x', otlpEndpoint: 'http://127.0.0.1:9' }).args.join(' ');
    for (const flag of ['--ignore-user-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', 'tools.web_search=false']) {
      expect(args).toContain(flag);
    }
  });
});

describe('matching a turn to its own telemetry', () => {
  it('captures the thread id, which is what the telemetry calls conversation.id', () => {
    const stdout = [
      `{"type":"thread.started","thread_id":"${THREAD}"}`,
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pond"}}',
      '{"type":"turn.completed","usage":{"input_tokens":14095,"cached_input_tokens":10624,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    const parsed = parseCodexExecJSONL(stdout)!;
    expect(parsed.threadID).toBe(THREAD);
    // And the figure the telemetry reports as `non_cached_input_tokens` is the one the adapter
    // derives from the total, which is what makes the cross-check meaningful.
    expect(parsed.usage.inputTokens).toBe(14_095 - 10_624);
  });

  it('leaves the thread id undefined when the tool never started a thread', () => {
    expect(parseCodexExecJSONL('{"type":"turn.started"}')!.threadID).toBeUndefined();
  });
});

// MARK: - The guarantee this must not break

describe('telemetry NEVER establishes identity', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => { campaignRoot = temporaryRoot('otlp-identity-'); root = path.join(campaignRoot, 'run'); });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  it('records a full observation and STILL leaves reportedModelID empty', async () => {
    const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', {
      effort: 'medium', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      // Deliberately empty. The engine refuses a binding that claims the accepted-request state AND
      // a returned model identifier, which is the invariant this whole file exists to protect.
      verifiedModelID: '',
    }));
    const { host } = routingHost({
      envelope,
      adapters: {
        codexCLI: scriptedAdapter('codexCLI', {}, {
          // What a real Codex reply looks like: it names nothing.
          reportedModelID: '',
          usage: { inputTokens: 3_471, cacheReadInputTokens: 10_624, cacheCreationInputTokens: 0, visibleOutputTokens: 5 },
          otlpTurn: {
            correlated: true, recordCount: 9, correlationKey: '[REDACTED:conversation.id:1]',
            turnReasoningEffort: 'medium', requestReasoningEffort: 'medium',
            inputTokens: 14_095, nonCachedInputTokens: 3_471, cachedInputTokens: 10_624,
            cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 14_100,
            mcpServers: 'codex_apps',
          },
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });

    const rows = [...campaign.ledger.results.values()];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // THE GUARANTEE. A complete observation, and identity is still unestablished.
      expect(row.reportedModelID).toBe('');
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(row.otlpObserved).toBe(true);
      expect(row.otlpCorrelated).toBe(true);
      expect(row.otlpTurnReasoningEffort).toBe('medium');
      // The effort the binding froze, confirmed against what the tool says it applied.
      expect(row.otlpEffortMatchesBinding).toBe(true);
      // The two independent routes to the fresh-input figure agree.
      expect(row.otlpTokensAgreeWithStdout).toBe(true);
      expect(row.otlpNonCachedInputTokens).toBe(row.freshInputTokens);
      // And the telemetry has NOT replaced the counted columns.
      expect(row.inputTokens).toBe(3_471 + 10_624);
      // Still no allowance: telemetry carries no cost figure of any kind.
      expect(row.subscriptionIncludedUsageMicroUSD).toBeUndefined();
      expect(row.subscriptionAllowanceState).toBe('unavailable');
      // And a candidate carrying all of that is still not promotable.
      const metrics = attemptMetricsFromRow(row as Record<string, unknown>)!;
      expect(metrics.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(metrics.reportedModelID).toBe('');
    }
  });

  it('records an effort MISMATCH rather than silently accepting it', async () => {
    const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-sol@max', 'codexCLI', {
      effort: 'max', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
    }));
    const { host } = routingHost({
      envelope,
      adapters: {
        codexCLI: scriptedAdapter('codexCLI', {}, {
          reportedModelID: '',
          usage: { inputTokens: 100, visibleOutputTokens: 5 },
          // The tool says it applied `medium` to a binding that froze `max`. That is the whole
          // reason this figure is worth recording.
          otlpTurn: { correlated: true, recordCount: 4, correlationKey: '[REDACTED:conversation.id:1]',
            turnReasoningEffort: 'medium', outputTokens: 5, nonCachedInputTokens: 100 },
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    for (const row of campaign.ledger.results.values()) {
      expect(row.otlpTurnReasoningEffort).toBe('medium');
      expect(row.otlpEffortMatchesBinding).toBe(false);
    }
  });

  it('leaves every otlp column ABSENT when no collector ran', async () => {
    const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', { effort: 'medium' }));
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    for (const row of campaign.ledger.results.values()) {
      // "Nobody asked" and "we asked and nothing came" are different facts about a row.
      expect(row.otlpObserved).toBeUndefined();
      expect(row.otlpCorrelated).toBeUndefined();
      expect(row.otlpTurnReasoningEffort).toBeUndefined();
    }
  });
});

describe('reading OTLP attributes', () => {
  it('flattens every attributes array it finds, unwrapping AnyValue', () => {
    const sets = attributeSets(tracePayload());
    expect(sets.length).toBeGreaterThanOrEqual(2);
    const turn = sets.find((set) => 'codex.turn.reasoning_effort' in set)!;
    expect(turn['codex.turn.reasoning_effort']).toBe('medium');
    expect(turn['codex.turn.token_usage.output_tokens']).toBe('5');
  });

  it('finds nothing in a payload with no attributes, rather than throwing', () => {
    expect(attributeSets({})).toEqual([]);
    expect(attributeSets(null)).toEqual([]);
    expect(attributeSets([1, 2, 3])).toEqual([]);
  });
});

// MARK: - Throttling is the provider's decision, not the model's score

describe('provider throttling is never a model-quality failure', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => { campaignRoot = temporaryRoot('otlp-throttle-'); root = path.join(campaignRoot, 'run'); });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  const envelope = () => envelopeOf(
    subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', {
      effort: 'medium', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
    }),
    subscriptionBinding('codexCLI:gpt-6-astra@medium', 'codexCLI', {
      effort: 'medium', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
    }),
  );

  it('classifies a rate limit and an expired session as throttling, and a timeout as NOT', () => {
    expect(isProviderThrottle('codexCLI.rateLimited')).toBe(true);
    expect(isProviderThrottle('claudeCLI.notAuthenticated')).toBe(true);
    expect(isProviderThrottle('rateLimited')).toBe(true);
    // Genuinely ambiguous — a slow model or a slow network — so it stays a recorded outcome.
    expect(isProviderThrottle('codexCLI.timeout')).toBe(false);
    expect(isProviderThrottle('codexCLI.refused')).toBe(false);
    expect(isProviderThrottle('codexCLI.malformedResponse')).toBe(false);
  });

  it('ABORTS on a rate limit and writes no result, leaving the slot runnable', async () => {
    const built = envelope();
    const { host } = routingHost({
      envelope: built,
      adapters: {
        codexCLI: scriptedAdapter('codexCLI', {}, {
          failure: { kind: 'rateLimited', detail: 'usage limit reached; resets in 3 hours' },
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(built), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });

    expect(status.state).toBe('aborted');
    // NOTHING was recorded. Not a fail, not a runtimeError — nothing.
    expect(campaign.ledger.results.size).toBe(0);
    const abort = campaign.ledger.standingAbort()!;
    expect(abort.stage).toBe('providerThrottling');
    expect(abort.reason).toMatch(/NOT counted as a failure of the model/);
    // Every slot stays runnable, the throttled one included.
    expect(abort.blockedSlotCount).toBe(campaign.ledger.plan.length);
    expect(campaign.ledger.events().some((event) => event.kind === 'providerThrottled')).toBe(true);
  });

  it('records a THROTTLED attempt in no ranking, because there is no row to rank', async () => {
    const built = envelope();
    const { host } = routingHost({
      envelope: built,
      adapters: {
        codexCLI: scriptedAdapter('codexCLI', {}, {
          failure: { kind: 'rateLimited', detail: 'usage limit reached' },
        }),
      },
    });
    const campaign = Campaign.create(root, configurationFor(built), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    const report = campaign.finalize();
    // No candidate has a rate, and none has a zero either: nothing was measured.
    expect(report.rankings.rankings).toEqual([]);
    expect(report.reconciliation.byStatus).toEqual({});
    expect(report.rankings.provisional).toBe(true);
  });

  it('resumes after the reset and completes, superseding the abort rather than deleting it', async () => {
    const built = envelope();
    let throttled = true;
    const adapter = scriptedAdapter('codexCLI', {}, { answerText: 'ok' });
    const throttling = {
      provider: 'codexCLI' as const,
      async complete(request: Parameters<typeof adapter.complete>[0]) {
        if (throttled) {
          return {
            answerText: '', reportedModelID: '', usage: {}, usageProvenance: 'unavailable' as const,
            totalElapsedMilliseconds: 10, retryCount: 0, wastedTokens: 0,
            failure: { kind: 'rateLimited' as const, detail: 'usage limit reached' },
          };
        }
        return adapter.complete(request);
      },
    };
    const first = Campaign.create(root, configurationFor(built), routingHost({ envelope: built, adapters: { codexCLI: throttling } }).host);
    expect((await first.run({ campaignRootDirectory: campaignRoot })).state).toBe('aborted');
    expect(first.ledger.results.size).toBe(0);

    // The allowance resets.
    throttled = false;
    const resumed = Campaign.open(root, configurationFor(built), routingHost({ envelope: built, adapters: { codexCLI: throttling } }).host);
    const status = await resumed.run({ campaignRootDirectory: campaignRoot });
    expect(status.state).toBe('complete');
    expect(status.reconciliation.balances).toBe(true);
    expect(status.terminalCount).toBe(status.slotCount);
    // The original abort is KEPT, superseded.
    const aborts = fs.readdirSync(path.join(root, 'ledger', 'aborts'));
    expect(aborts.length).toBe(1);
    const filed = JSON.parse(fs.readFileSync(path.join(root, 'ledger', 'aborts', aborts[0]), 'utf8'));
    expect(filed.stage).toBe('providerThrottling');
    expect(filed.supersededAt).toBeTruthy();
  });

  it('substitutes NO other model: the aborted candidate\'s slots stay its own', async () => {
    const built = envelope();
    const { host } = routingHost({
      envelope: built,
      adapters: { codexCLI: scriptedAdapter('codexCLI', {}, { failure: { kind: 'rateLimited', detail: 'limit' } }) },
    });
    const campaign = Campaign.create(root, configurationFor(built), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    const abort = campaign.ledger.standingAbort()!;
    // Each blocked slot still names the candidate that was planned for it.
    for (const key of abort.blockedSlotKeys) {
      expect(campaign.ledger.slot(key)!.candidate).toBe(key.split('|')[0]);
    }
  });
});

// MARK: - The join that replaces waiting

describe('joining a row to a span that arrives after the attempt closed', () => {
  it('mints a correlation key even when NOTHING has arrived yet', async () => {
    const observer = await OTLPObserver.start({
      evidenceFile: path.join(directory, 'join-a.jsonl'), observeTimeoutMilliseconds: 40, shutdownGraceMilliseconds: 0,
    });
    // The ordinary case on this tool: the attempt finishes before any span arrives.
    const turn = await observer.observe(THREAD);
    expect(turn).toBeDefined();
    expect(turn!.correlated).toBe(false);
    expect(turn!.correlationKey).toMatch(/^\[REDACTED:conversation\.id:\d+\]$/);
    await observer.stop();
  });

  it('gives the same key to the row and to the span that turns up later', async () => {
    const evidenceFile = path.join(directory, 'join-b.jsonl');
    const observer = await OTLPObserver.start({
      evidenceFile, observeTimeoutMilliseconds: 40, shutdownGraceMilliseconds: 0,
    });
    // The attempt closes first and takes a key with it.
    const atAttemptTime = await observer.observe(THREAD);
    expect(atAttemptTime!.correlated).toBe(false);

    // Seconds later, in life, the span lands.
    await post(observer.endpoint, tracePayload(THREAD, 'max'));
    const summary = await observer.stop();

    // The join table is keyed by exactly what the row recorded.
    const index = JSON.parse(fs.readFileSync(summary.indexFile, 'utf8')) as Record<string, {
      correlated: boolean; turnReasoningEffort?: string; nonCachedInputTokens?: number;
    }>;
    const joined = index[atAttemptTime!.correlationKey];
    expect(joined).toBeDefined();
    expect(joined.correlated).toBe(true);
    expect(joined.turnReasoningEffort).toBe('max');
    expect(joined.nonCachedInputTokens).toBe(3_471);
    // And the key is still not an identifier.
    expect(fs.readFileSync(evidenceFile, 'utf8')).not.toContain(THREAD);
    expect(JSON.stringify(index)).not.toContain(THREAD);
  });

  it('keys the join table by placeholder, never by the conversation id', async () => {
    const observer = await OTLPObserver.start({
      evidenceFile: path.join(directory, 'join-c.jsonl'), observeTimeoutMilliseconds: 40, shutdownGraceMilliseconds: 0,
    });
    await post(observer.endpoint, tracePayload('conversation-alpha', 'medium'));
    await post(observer.endpoint, tracePayload('conversation-beta', 'max'));
    const summary = await observer.stop();
    const index = JSON.parse(fs.readFileSync(summary.indexFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(index)).toHaveLength(2);
    for (const key of Object.keys(index)) expect(key).toMatch(/^\[REDACTED:conversation\.id:\d+\]$/);
    expect(Object.keys(index)).not.toContain('conversation-alpha');
  });

  it('records the key on the ledger row, so the row is joinable without the id', async () => {
    const campaignRoot = temporaryRoot('otlp-join-');
    try {
      const envelope = envelopeOf(subscriptionBinding('codexCLI:gpt-5.6-sol@medium', 'codexCLI', {
        effort: 'medium', identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
      }));
      const { host } = routingHost({
        envelope,
        adapters: {
          codexCLI: scriptedAdapter('codexCLI', {}, {
            reportedModelID: '',
            usage: { inputTokens: 3_471, cacheReadInputTokens: 10_624, visibleOutputTokens: 5 },
            // What the adapter actually gets back at attempt time: a key, and nothing else yet.
            otlpTurn: { correlated: false, recordCount: 0, correlationKey: '[REDACTED:conversation.id:7]' },
          }),
        },
      });
      const campaign = Campaign.create(path.join(campaignRoot, 'run'), configurationFor(envelope), host);
      await campaign.run({ campaignRootDirectory: campaignRoot });
      for (const row of campaign.ledger.results.values()) {
        expect(row.otlpObserved).toBe(true);
        expect(row.otlpCorrelated).toBe(false);
        expect(row.otlpCorrelationKey).toBe('[REDACTED:conversation.id:7]');
        // Still no identity, still no allowance, still the counted tokens.
        expect(row.reportedModelID).toBe('');
        expect(row.inputTokens).toBe(3_471 + 10_624);
      }
    } finally {
      fs.rmSync(campaignRoot, { recursive: true, force: true });
    }
  });
});
