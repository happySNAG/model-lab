// Cernum · v0.2.4 — a Codex smoke that measures what there is to measure, and says so where there
// is not.
//
// THE DEFECT THIS FILE PINS. `--otlp-observer` was wired into `run` and `resume` and nowhere else:
// `commandSmoke` built its adapter with `buildAdapter(provider)` and no options at all, so even had
// the flag been accepted there it would have been inert — the collector would have started, bound a
// port, exported nothing, and shut down reporting zero payloads. A Codex smoke therefore recorded
// `reportedEffort: undefined` forever, because `codex exec --json` echoes no effort and the one
// surface that does carry it was not reachable from this command.
//
// NOTHING HERE CONTACTS CODEX. The `codex` executable is a shell script written into a temporary
// directory. It reads the OTLP endpoint out of the `-c otel=…` argument Cernum passes it, POSTs the
// fixture payloads to that endpoint the way the real tool does, and then prints the JSONL envelope
// `codex exec --json` emits. That is exactly the seam the flag exists to drive, and driving it with
// a fake is what makes this testable without spending an allowance.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OTLPObserver } from '../../src/engine/otlp-observer';
import { SubscriptionCLIAdapter } from '../../src/engine/frontier-adapter';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE } from '../../src/engine/provider';
import { modelsFromSmokes } from '../../src/engine/discovery-store';

const THREAD = '01a0a12c-132c-7850-af85-3db4c290c727';
const EMAIL = 'someone@example.test';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-v024-telemetry-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

/** The `codex exec --json` envelope, as the real tool emits it: a thread id and a final answer. */
const CODEX_ENVELOPE = [
  JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 14_095, cached_input_tokens: 10_624, output_tokens: 5, reasoning_output_tokens: 0 },
  }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
].join('\n');

/** The TRACE payload, reduced from what codex-cli 0.154.0 actually sent to a loopback collector. */
function tracePayload(effort: string): unknown {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: [{
          name: 'session_task.turn',
          attributes: [
            { key: 'conversation.id', value: { stringValue: THREAD } },
            { key: 'user.email', value: { stringValue: EMAIL } },
            { key: 'codex.turn.reasoning_effort', value: { stringValue: effort } },
            { key: 'codex.turn.token_usage.input_tokens', value: { stringValue: '14095' } },
            { key: 'codex.turn.token_usage.cached_input_tokens', value: { stringValue: '10624' } },
            { key: 'codex.turn.token_usage.output_tokens', value: { stringValue: '5' } },
            { key: 'codex.turn.token_usage.reasoning_output_tokens', value: { stringValue: '0' } },
            { key: 'codex.turn.token_usage.total_tokens', value: { stringValue: '14100' } },
          ],
        }, {
          name: 'handle_responses',
          attributes: [
            { key: 'conversation.id', value: { stringValue: THREAD } },
            { key: 'codex.request.reasoning_effort', value: { stringValue: effort } },
          ],
        }],
      }],
    }],
  };
}

/**
 * A fake `codex` that EXPORTS TELEMETRY THE WAY THE REAL ONE DOES.
 *
 * It finds the endpoint in its own arguments — which is the property under test, since Cernum has to
 * have put it there — and posts the payload before answering. `exports: false` writes one that
 * ignores the flag, so "the collector saw nothing" can be told from "the flag never arrived".
 */
function fakeCodex(options: { exports: boolean; effort?: string }): string {
  const payload = path.join(directory, 'trace.json');
  fs.writeFileSync(payload, JSON.stringify(tracePayload(options.effort ?? 'medium')));
  const envelope = path.join(directory, 'envelope.jsonl');
  fs.writeFileSync(envelope, `${CODEX_ENVELOPE}\n`);
  const argumentsLog = path.join(directory, 'codex.args');
  const executable = path.join(directory, 'codex');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argumentsLog)}`,
    'cat > /dev/null',
    ...(options.exports ? [
      // Dig the endpoint out of the `-c otel={ exporter = { "otlp-http" = { endpoint = "…" …` argument.
      `endpoint=$(printf '%s' "$*" | sed -n 's/.*endpoint = "\\([^"]*\\)".*/\\1/p')`,
      'if [ -n "$endpoint" ]; then',
      `  curl -s -X POST -H 'content-type: application/json' --data @${JSON.stringify(payload)} "$endpoint" > /dev/null 2>&1`,
      'fi',
    ] : []),
    `cat ${JSON.stringify(envelope)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return executable;
}

const codexArguments = (): string[] => {
  const log = path.join(directory, 'codex.args');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim().length > 0);
};

async function smokeCodex(options: { exports: boolean; effort?: string; withObserver: boolean }) {
  const binding = buildSmokeBinding({ provider: 'codexCLI', modelID: 'gpt-5.6-sol', effort: 'medium' });
  const observer = options.withObserver
    ? await OTLPObserver.start({
        evidenceFile: path.join(directory, 'payloads.redacted.jsonl'),
        observeTimeoutMilliseconds: 2_000,
        shutdownGraceMilliseconds: 0,
      })
    : undefined;
  try {
    const adapter = new SubscriptionCLIAdapter({
      provider: 'codexCLI', executablePath: fakeCodex(options), otlp: observer,
    });
    const result = await identitySmokeTest(binding, adapter);
    return { result, summary: observer ? await observer.stop() : undefined };
  } catch (error) {
    if (observer) await observer.stop();
    throw error;
  }
}

describe('v0.2.4 · --otlp-observer reaches the smoke adapter, which it never did before', () => {
  it('puts the collector endpoint into the invocation, so the tool can export to it', async () => {
    await smokeCodex({ exports: true, withObserver: true });
    const invocation = codexArguments().join(' ');
    expect(invocation).toContain('otel=');
    expect(invocation).toMatch(/endpoint = "http:\/\/127\.0\.0\.1:\d+"/);
    // And the per-invocation override is how it gets there: the user's own config is never touched.
    expect(invocation).toContain('--ignore-user-config');
  }, 60_000);

  it('records the reasoning effort the tool says it APPLIED — the figure stdout never carries', async () => {
    const { result } = await smokeCodex({ exports: true, effort: 'medium', withObserver: true });

    // `codex exec --json` echoes no effort at all, which is why this field was empty forever.
    expect(result.reportedEffort).toBe('');
    expect(result.telemetry).toBeDefined();
    expect(result.telemetry?.turnReasoningEffort).toBe('medium');
    expect(result.telemetry?.requestReasoningEffort).toBe('medium');
    expect(result.telemetry?.correlated).toBe(true);
  }, 60_000);

  it('records the token decomposition beside the counts read off stdout', async () => {
    const { result } = await smokeCodex({ exports: true, withObserver: true });

    expect(result.telemetry?.inputTokens).toBe(14_095);
    expect(result.telemetry?.cachedInputTokens).toBe(10_624);
    expect(result.telemetry?.outputTokens).toBe(5);
    expect(result.telemetry?.totalTokens).toBe(14_100);
    // stdout is still read and still authoritative for the recorded quantities.
    expect(result.inputTokens.value).toBe(14_095);
    expect(result.visibleOutputTokens.value).toBe(5);
    expect(result.inputTokens.provenance).toBe('providerReported');
  }, 60_000);

  it('records latency, retries and allowance — measured, zero and unavailable respectively', async () => {
    const { result } = await smokeCodex({ exports: true, withObserver: true });

    expect(result.totalWallClockMilliseconds.provenance).toBe('measured');
    expect(result.totalWallClockMilliseconds.value).toBeGreaterThan(0);
    expect(result.retryCount).toBe(0);
    // Codex reports NO allowance figure. Unavailable, with a reason — never zero.
    expect(result.subscriptionIncludedUsageMicroUSD.provenance).toBe('unavailable');
    expect(result.subscriptionIncludedUsageMicroUSD.note).toMatch(/not zero/);
    // And the generation-speed question is answered honestly rather than computed from wall clock.
    expect(result.providerReportedGenerationTokensPerSecondMilli.provenance).toBe('unavailable');
  }, 60_000);

  it('marks the telemetry absent rather than empty when no collector was asked for', async () => {
    const { result } = await smokeCodex({ exports: true, withObserver: false });
    expect(result.telemetry).toBeUndefined();
    expect(codexArguments().join(' ')).not.toContain('otel=');
  }, 60_000);

  it('tells a pending observation from an absent one when the tool exported nothing', async () => {
    const { result, summary } = await smokeCodex({ exports: false, withObserver: true });
    // The flag arrived; the tool exported nothing. That is `correlated: false` with a key to collect
    // on later, NOT a claim that nothing was observed.
    expect(result.telemetry?.correlated).toBe(false);
    expect(result.telemetry?.correlationKey.length).toBeGreaterThan(0);
    expect(result.telemetry?.turnReasoningEffort).toBeUndefined();
    expect(summary?.payloadCount).toBe(0);
  }, 60_000);
});

describe('v0.2.4 · telemetry establishes no identity, however complete it is', () => {
  it('keeps a Codex smoke at requestAcceptedIdentityUnverifiable with a complete observation', async () => {
    const { result } = await smokeCodex({ exports: true, withObserver: true });

    expect(result.verdict).toBe('unverifiable');
    expect(result.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    // The telemetry names the model this CLIENT SENT. That is not a model naming itself.
    expect(result.reportedModelID).toBe('');
    expect(result.evidence).toMatch(/named no model/);
    expect(result.evidence).toContain('requestAcceptedIdentityUnverifiable');
  }, 60_000);

  it('makes nothing selectable off the back of it', async () => {
    const { result } = await smokeCodex({ exports: true, withObserver: true });
    const [row] = modelsFromSmokes([result]);

    expect(row.availability).toBe('unproven');
    expect(row.verifiedModelID).toBe('');
    expect(row.evidence).toContain('requestAcceptedIdentityUnverifiable');
  }, 60_000);

  it('redacts the operator identifiers out of the evidence file at ingest', async () => {
    const { summary } = await smokeCodex({ exports: true, withObserver: true });
    const written = fs.readFileSync(summary!.evidenceFile, 'utf8');

    expect(written).not.toContain(EMAIL);
    expect(summary!.leakAuditClean).toBe(true);
    expect(summary!.redactionCount).toBeGreaterThan(0);
  }, 60_000);
});
