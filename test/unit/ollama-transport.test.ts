// Unit · the live Ollama transport against a scripted loopback HTTP server: runtime unavailable,
// available, no models installed, model enumeration, model not found, malformed/partial responses,
// timeout, and mid-flight cancellation — each becoming honest evidence, never a crash or a retry.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { LiveExecutionAuthorization, LiveTransportConfigurationFailure, OllamaHTTPTransport, validateLoopbackEndpoint } from '@core/ollama-http';
import { OllamaLiveAdapter, OllamaTransportFailure, probeCandidate } from '@core/ollama';
import { CancellationToken } from '@core/adapter';
import { deterministicFake, makeCandidate } from '@core/candidate';
import { AttemptRequest } from '@core/adapter';
import { generationSettings } from '@core/benchmark';
import { planRun, syntheticEnvironment } from '@core/run';
import { RunExecutor } from '@core/executor';
import { InMemoryResultStore } from '@core/store';
import { foundationSuite } from '@core/foundation';
import { steppingClock } from '@core/digest';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

let server: http.Server;
let endpoint: string;
let handler: Handler;
const authorization = LiveExecutionAuthorization.explicit(true, true)!;

beforeEach(async () => {
  handler = (_req, _body, res) => { res.statusCode = 500; res.end('unscripted'); };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}

const request: AttemptRequest = {
  attemptID: 'attempt:t:0', messages: [{ role: 'user', content: 'Reply with exactly one word: pond.' }],
  generationSettings: generationSettings({ temperatureMilli: 0, maxOutputTokens: 16 }), responseFormat: 'plainText', executionBudgetMilliseconds: 2_000,
};
const liveCandidate = makeCandidate({ ...deterministicFake, id: { raw: 'candidate:ollama:m-1b:unreported:unreported' }, provider: 'ollama', exactModelIdentity: 'm:1b', executionClass: 'localHostProcess' });

describe('authorization and loopback refusal', () => {
  it('is unobtainable without both acknowledgements', () => {
    expect(LiveExecutionAuthorization.explicit(false, false)).toBeUndefined();
    expect(LiveExecutionAuthorization.explicit(true, false)).toBeUndefined();
    expect(LiveExecutionAuthorization.explicit(false, true)).toBeUndefined();
    expect(LiveExecutionAuthorization.explicit(true, true)).toBeDefined();
  });
  it('refuses non-loopback and non-http endpoints whole', () => {
    expect(() => validateLoopbackEndpoint('http://192.168.1.20:11434')).toThrow(LiveTransportConfigurationFailure);
    expect(() => validateLoopbackEndpoint('https://127.0.0.1:11434')).toThrow(LiveTransportConfigurationFailure);
    expect(() => validateLoopbackEndpoint('not a url')).toThrow(LiveTransportConfigurationFailure);
    expect(() => new OllamaHTTPTransport('http://localhost:11434', authorization)).not.toThrow();
    expect(() => new OllamaHTTPTransport('http://[::1]:11434', authorization)).not.toThrow();
  });
});

describe('runtime unavailable', () => {
  it('reports connectionFailed for a closed port, and the adapter records candidateUnavailable', async () => {
    const closed = `http://127.0.0.1:${(server.address() as AddressInfo).port + 1}`;
    const transport = new OllamaHTTPTransport(closed, authorization);
    await expect(transport.version()).rejects.toMatchObject({ kind: 'connectionFailed' });
    const observation = await new OllamaLiveAdapter(transport).invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('candidateUnavailable');
    expect(observation.errors[0].code).toBe('ollama.connectionFailed');
  });
  it('the default (unconfigured) adapter fails closed without any network', async () => {
    const observation = await new OllamaLiveAdapter().invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('candidateUnavailable');
    expect(observation.errors[0].code).toBe('adapter.notConfigured');
  });
});

describe('runtime available', () => {
  it('reads the version, enumerates installed models, and handles an empty library honestly', async () => {
    let models: unknown[] = [];
    handler = (req, _body, res) => {
      if (req.url === '/api/version') return json(res, 200, { version: '0.9.9-test' });
      if (req.url === '/api/tags') return json(res, 200, { models });
      if (req.url === '/api/ps') return json(res, 200, { models: [] });
      return json(res, 404, 'nope');
    };
    const transport = new OllamaHTTPTransport(endpoint, authorization);
    expect((await transport.version()).version).toBe('0.9.9-test');
    expect(await transport.installedModels()).toEqual([]);
    await expect(transport.model('m:1b')).rejects.toMatchObject({ kind: 'modelNotFound', model: 'm:1b' });
    models = [
      { name: 'm:1b', digest: 'sha256:abcdef0123456789abcdef', size: 1234, modified_at: '2026-01-01T00:00:00Z', details: { quantization_level: 'Q4_K_M', parameter_size: '1.2B', family: 'test' } },
      { name: 'other:latest', size: 99 },
    ];
    const listed = await transport.installedModels();
    expect(listed.map((m) => m.name)).toEqual(['m:1b', 'other:latest']);
    expect(listed[0].quantizationLevel).toBe('Q4_K_M');
    const report = await transport.model('other');
    expect(report.name).toBe('other:latest');
  });

  it('probes a truthful candidate (show metadata merged, context length from model_info)', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'm:1b', digest: 'sha256:abcdef0123456789abcdef', details: { quantization_level: 'Q8_0' } }] });
      if (req.url === '/api/show') return json(res, 200, { details: { parameter_size: '1.1B', family: 'fam' }, model_info: { 'fam.context_length': 4096 } });
      return json(res, 404, 'nope');
    };
    const candidate = await probeCandidate('m:1b', new OllamaHTTPTransport(endpoint, authorization));
    expect(candidate.id.raw).toBe('candidate:ollama:m-1b:digest-abcdef012345:q8_0');
    expect(candidate.declaredContextLimitTokens).toEqual({ measured: 4096 });
    expect(candidate.runtimeConfiguration.settings.find((s) => s.key === 'reportedFamily')?.value).toBe('fam');
    expect(candidate.availability).toEqual({ state: 'available' });
  });

  it('executes a real chat round-trip into a completed, identity-verified observation with telemetry', async () => {
    handler = (req, body, res) => {
      if (req.url === '/api/chat') {
        const sent = JSON.parse(body);
        expect(sent.think).toBe(false);
        expect(sent.stream).toBe(false);
        expect(sent.options.num_predict).toBe(16);
        return json(res, 200, { model: 'm:1b', message: { role: 'assistant', content: 'pond' }, done_reason: 'stop',
          total_duration: 1_500_000_000, load_duration: 20_000_000, prompt_eval_count: 12, prompt_eval_duration: 300_000_000, eval_count: 4, eval_duration: 400_000_000 });
      }
      if (req.url === '/api/ps') return json(res, 200, { models: [{ name: 'm:1b', size: 800, size_vram: 700 }] });
      return json(res, 404, 'nope');
    };
    const adapter = new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization), { measured: '0.9.9-test' });
    const observation = await adapter.invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('completed');
    expect(observation.outputText).toBe('pond');
    expect(observation.identityVerification).toEqual({ state: 'verifiedMatch', reported: 'm:1b' });
    expect(observation.providerReportedUsage).toEqual({ measured: { promptTokens: 12, completionTokens: 4 } });
    expect(observation.timing.totalElapsedMilliseconds).toEqual({ measured: 1500 });
    expect(observation.runtimeTelemetry?.tokensPerSecondMilli).toEqual({ measured: 10_000 });
    expect(observation.runtimeTelemetry?.modelMemoryBytes).toEqual({ measured: 700 });
    expect(observation.runtimeTelemetry?.thinkingMode).toEqual({ measured: 'disabled' });
  });

  it('fails an identity contradiction closed at the executor', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/api/chat') return json(res, 200, { model: 'someone-else:7b', message: { content: 'pond' } });
      if (req.url === '/api/ps') return json(res, 200, { models: [] });
      return json(res, 404, 'nope');
    };
    const adapter = new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization));
    const store = new InMemoryResultStore();
    const plan = planRun('live-mismatch', foundationSuite, [liveCandidate]);
    await new RunExecutor(adapter, store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    expect((await store.attempts('live-mismatch')).every((a) => a.terminalStatus === 'identityMismatch')).toBe(true);
  });
});

describe('malformed and partial responses', () => {
  it('records a non-JSON chat body as a failed attempt with ollama.malformedResponse', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') { res.statusCode = 200; res.end('<html>oops</html>'); } else json(res, 200, { models: [] }); };
    const observation = await new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization)).invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('failed');
    expect(observation.errors[0].code).toBe('ollama.malformedResponse');
  });
  it('records a body that names no model as malformed, and a 404 as modelNotFound → candidateUnavailable', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') json(res, 200, { message: { content: 'x' } }); else json(res, 200, { models: [] }); };
    const t = new OllamaHTTPTransport(endpoint, authorization);
    let observation = await new OllamaLiveAdapter(t).invoke(request, liveCandidate, new CancellationToken());
    expect(observation.errors[0].code).toBe('ollama.malformedResponse');
    handler = (req, _body, res) => { if (req.url === '/api/chat') json(res, 404, { error: "model 'm:1b' not found" }); else json(res, 200, { models: [] }); };
    observation = await new OllamaLiveAdapter(t).invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('candidateUnavailable');
    expect(observation.errors[0].code).toBe('ollama.modelNotFound');
    handler = (req, _body, res) => { if (req.url === '/api/chat') json(res, 500, 'server exploded'); else json(res, 200, { models: [] }); };
    observation = await new OllamaLiveAdapter(t).invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('failed');
    expect(observation.errors[0].code).toBe('ollama.httpFailure');
  });
  it('treats an empty reply and a reasoning-only reply as distinct failures, never promoting the trace', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') json(res, 200, { model: 'm:1b', message: { content: '', thinking: 'let me think' }, done_reason: 'length' }); else json(res, 200, { models: [] }); };
    const observation = await new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization), { measured: 'x' }, 'enabled').invoke(request, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('failed');
    expect(observation.outputText).toBeUndefined();
    expect(observation.errors[0].detail).toContain('reported reasoning but no final answer');
    expect(observation.runtimeTelemetry?.thinkingTraceCharacterCount).toEqual({ measured: 12 });
    expect(observation.warnings.some((w) => w.includes("done reason 'length'"))).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('let me think');
  });
  it('records a JSON demand answered by prose as malformedOutput', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') json(res, 200, { model: 'm:1b', message: { content: 'blue' } }); else json(res, 200, { models: [] }); };
    const observation = await new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization)).invoke({ ...request, responseFormat: 'json' }, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('malformedOutput');
    expect(observation.errors[0].code).toBe('output.notJSON');
  });
});

describe('timeout and cancellation', () => {
  it('times out at the execution budget and records timedOut', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') setTimeout(() => json(res, 200, { model: 'm:1b', message: { content: 'late' } }), 800); else json(res, 200, { models: [] }); };
    const observation = await new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization)).invoke({ ...request, executionBudgetMilliseconds: 150 }, liveCandidate, new CancellationToken());
    expect(observation.terminalStatus).toBe('timedOut');
    expect(observation.errors[0].code).toBe('ollama.timeout');
  });
  it('abandons the request when cancelled mid-flight and records cancelled', async () => {
    handler = (req, _body, res) => { if (req.url === '/api/chat') setTimeout(() => json(res, 200, { model: 'm:1b', message: { content: 'late' } }), 800); else json(res, 200, { models: [] }); };
    const token = new CancellationToken();
    setTimeout(() => token.cancel(), 100);
    const started = Date.now();
    const observation = await new OllamaLiveAdapter(new OllamaHTTPTransport(endpoint, authorization)).invoke(request, liveCandidate, token);
    expect(observation.terminalStatus).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(700);
  });
  it('never spells a model-mutating endpoint', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/core/ollama-http.ts', import.meta.url), 'utf8'));
    for (const token of ['api/pull', 'api/create', 'api/copy', 'api/push', 'api/delete', 'api/embed']) expect(source).not.toContain(token);
    expect(source).toContain('api/chat');
  });
});

describe('failure vocabulary', () => {
  it('OllamaTransportFailure carries its kind', () => {
    const failure = new OllamaTransportFailure('timeout');
    expect(failure.kind).toBe('timeout');
  });
});
