// Model Lab core · the live Ollama HTTP transport (port of `ModelLabOllamaHTTPTransport`).
//
// The ONE place the benchmark engine may touch a network. Three fail-closed properties:
//   • Construction REQUIRES a `LiveExecutionAuthorization`, obtainable only by acknowledging both
//     facts it names (the desktop application mints it when the user presses Start on a run whose
//     pre-flight summary states them).
//   • Endpoints must be LOOPBACK (127.0.0.1 / localhost / ::1): Cernum benchmarks the runtime
//     on THIS machine, so the hardware evidence stays truthful.
//   • Only the read/describe/generate surface exists here. No pull, create, copy, push, or delete.
//
// Every request carries its own timeout; cancellation aborts the transfer mid-flight.

import * as http from 'node:http';
import { CancellationToken } from './adapter';
import { OllamaChatReport, OllamaChatRequest, OllamaInstalledModel, OllamaModelReport, OllamaRunningModelReport, OllamaStreamChunk,
         OllamaStreamingTransport, OllamaTransport, OllamaTransportFailure, OllamaVersionReport, chatReportFrom, chatReportFromStream,
         chatRequestBody, chatStreamChunkFrom, chatStreamRequestBody } from './ollama';

export class LiveExecutionAuthorization {
  private constructor() {}
  static explicit(acknowledgeLocalModelExecution: boolean, acknowledgeEvidenceIsNotAuthorization: boolean): LiveExecutionAuthorization | undefined {
    if (!acknowledgeLocalModelExecution || !acknowledgeEvidenceIsNotAuthorization) return undefined;
    return new LiveExecutionAuthorization();
  }
}

export class LiveTransportConfigurationFailure extends Error {
  constructor(public readonly code: 'missingHost' | 'unsupportedScheme' | 'endpointNotLoopback' | 'invalidURL', message: string) {
    super(message);
    this.name = 'LiveTransportConfigurationFailure';
  }
}

export const PERMITTED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Validates an endpoint string the way the transport constructor will; returns the parsed URL. */
export function validateLoopbackEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LiveTransportConfigurationFailure('invalidURL', `endpoint '${endpoint}' is not a URL`);
  }
  if (url.protocol !== 'http:') throw new LiveTransportConfigurationFailure('unsupportedScheme', `endpoint scheme '${url.protocol.replace(':', '')}' is not http`);
  if (!url.hostname) throw new LiveTransportConfigurationFailure('missingHost', 'endpoint has no host');
  if (!PERMITTED_LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new LiveTransportConfigurationFailure('endpointNotLoopback',
      `endpoint host '${url.hostname}' is not loopback — Cernum benchmarks the local runtime on this machine only (127.0.0.1, localhost, ::1)`);
  }
  return url;
}

/** The reader half of a `fetch` response body. Named so a test can supply one without a browser. */
export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
export interface ByteStream {
  getReader(): ByteStreamReader;
}

export interface FetchLike {
  (input: string, init: {
    method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal;
    /**
     * The HTTP-client backstops, in milliseconds, DERIVED FROM the caller's own deadline.
     *
     * These are not the authoritative timeout and must never be: the caller's `signal` is. They
     * exist because the platform `fetch` applies its OWN undefeatable header deadline (Node's
     * undici defaults to 300_000 ms), which silently kills a legitimate local generation long
     * before a sealed case deadline is reached. A caller that states its deadline here gets an
     * HTTP client whose patience is at least that long — and still finite.
     *
     * An implementation that cannot honour them ignores them; a fake in a test may assert on them.
     */
    headersTimeoutMilliseconds?: number;
    bodyTimeoutMilliseconds?: number;
  }): Promise<{
    status: number;
    text(): Promise<string>;
    /** Present on a real `fetch` response. Only the streaming path reads it. */
    body?: ByteStream | null;
  }>;
}

/**
 * How much longer than the caller's own deadline the HTTP client is willing to wait.
 *
 * The grace is what keeps the CALLER authoritative. If the two deadlines were equal, whichever
 * timer fired first would decide, and a transport failure would sometimes be reported where a
 * case timeout is the truth. A small, fixed grace means the caller's abort always lands first,
 * and the backstop only ever catches a client that is wedged rather than slow.
 */
export const HTTP_BACKSTOP_GRACE_MILLISECONDS = 15_000;

/** The header/body backstops for a caller whose own deadline is `deadlineMilliseconds`. Always finite. */
export function httpBackstopTimeoutsFor(deadlineMilliseconds: number): {
  headersTimeoutMilliseconds: number; bodyTimeoutMilliseconds: number;
} {
  const bounded = Number.isFinite(deadlineMilliseconds) && deadlineMilliseconds > 0 ? Math.floor(deadlineMilliseconds) : 0;
  const backstop = bounded + HTTP_BACKSTOP_GRACE_MILLISECONDS;
  return { headersTimeoutMilliseconds: backstop, bodyTimeoutMilliseconds: backstop };
}

/**
 * A `FetchLike` over `node:http` that HONOURS the two backstops above.
 *
 * WHY NOT `fetch` WITH A DISPATCHER. Node's global `fetch` reads `init.dispatcher`, but it is served
 * by Node's own internal copy of undici; a dispatcher built from the `undici` package is a different
 * instance and is rejected with `UND_ERR_INVALID_ARG`. `undici` is also not a dependency of this
 * project — it is present only under `electron-builder` and `electron` — so importing it in `src/`
 * would make the engine depend on a package nobody declared. `node:http` is a Node builtin, needs no
 * dependency, and gives the two timeouts directly, so that is what this uses.
 *
 * Loopback is re-checked here as defence in depth: the callers validate their endpoint at
 * construction, and this refuses anything that is not loopback even if one day one of them does not.
 */
export function loopbackHTTPFetch(): FetchLike {
  return (input, init) => new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      reject(new Error(`'${input}' is not a URL`));
      return;
    }
    try {
      validateLoopbackEndpoint(url.origin);
    } catch (error) {
      reject(error);
      return;
    }

    // TWO SETTLEMENTS, TRACKED SEPARATELY, because this hands the response over at HEADERS and the
    // body is drained afterwards. Before the headers arrive a failure REJECTS the call; after them
    // it fails whoever is reading the body, and the call has already succeeded. Collapsing the two
    // is what makes a streaming transport report a mid-stream error as a connection failure.
    let headersSettled = false;
    let bodyFinished = false;
    let bodyFailure: Error | undefined;
    const queue: Buffer[] = [];
    const waiting: (() => void)[] = [];
    const wake = (): void => { for (const resume of waiting.splice(0)) resume(); };

    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => { if (headersTimer) clearTimeout(headersTimer); if (bodyTimer) clearTimeout(bodyTimer); };

    const request = http.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
      method: init.method, headers: init.headers,
    });

    /** End the body exactly once, however it ended, and never leave a socket or a timer behind. */
    const finish = (error?: Error): void => {
      if (bodyFinished) return;
      bodyFinished = true;
      bodyFailure = error;
      clearTimers();
      init.signal.removeEventListener('abort', onAbort);
      if (error !== undefined) request.destroy();
      if (!headersSettled) {
        headersSettled = true;
        reject(error ?? new Error('the response ended before any headers arrived'));
      }
      wake();
    };
    function onAbort(): void {
      // The caller's own deadline or cancellation. Named the way `fetch` names it so the callers'
      // existing `signal.aborted` branches keep reading the same.
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      finish(error);
    }

    // ATTACHED BEFORE ANY EARLY RETURN. `destroy()` makes the request emit `error`, and a request
    // with no `error` listener turns that into an uncaught exception that no caller can catch —
    // so the listener has to exist before anything can possibly destroy it, including the
    // already-aborted path immediately below. Once finished, `finish` swallows it.
    request.on('error', (error: Error) => finish(error));

    if (init.signal.aborted) { onAbort(); return; }
    init.signal.addEventListener('abort', onAbort, { once: true });

    if (init.headersTimeoutMilliseconds !== undefined) {
      headersTimer = setTimeout(() => finish(new Error(`no response headers within ${init.headersTimeoutMilliseconds} ms`)),
        init.headersTimeoutMilliseconds);
      headersTimer.unref?.();
    }

    request.on('response', (response) => {
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = undefined; }
      if (init.bodyTimeoutMilliseconds !== undefined) {
        bodyTimer = setTimeout(() => finish(new Error(`response body did not complete within ${init.bodyTimeoutMilliseconds} ms`)),
          init.bodyTimeoutMilliseconds);
        bodyTimer.unref?.();
      }
      response.on('data', (chunk: Buffer) => { queue.push(chunk); wake(); });
      response.on('error', (error: Error) => finish(error));
      response.on('end', () => finish());

      // ONE READER OR ONE `text()`, NEVER BOTH: they consume the same queue. Every caller in this
      // project picks one, and `text()` is memoised so a second call returns the same answer rather
      // than an empty remainder.
      let collected: Promise<string> | undefined;
      const readAll = async (): Promise<string> => {
        const parts: Buffer[] = [];
        for (;;) {
          if (queue.length > 0) { parts.push(...queue.splice(0)); continue; }
          if (bodyFinished) break;
          await new Promise<void>((resume) => waiting.push(resume));
        }
        if (bodyFailure !== undefined) throw bodyFailure;
        return Buffer.concat(parts).toString('utf8');
      };

      const reader: ByteStreamReader = {
        read: async () => {
          for (;;) {
            const chunk = queue.shift();
            if (chunk !== undefined) return { done: false, value: chunk };
            if (bodyFinished) {
              if (bodyFailure !== undefined) throw bodyFailure;
              return { done: true };
            }
            await new Promise<void>((resume) => waiting.push(resume));
          }
        },
        // Cancelling a reader that already finished is harmless; leaving the socket open is not.
        cancel: async () => { finish(); request.destroy(); },
      };

      headersSettled = true;
      resolve({
        status: response.statusCode ?? 0,
        text: () => (collected ??= readAll()),
        body: { getReader: () => reader },
      });
    });

    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

export class OllamaHTTPTransport implements OllamaStreamingTransport {
  private readonly endpoint: URL;
  private readonly fetchImpl: FetchLike;

  constructor(endpoint: string, authorization: LiveExecutionAuthorization, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    if (!(authorization instanceof LiveExecutionAuthorization)) throw new LiveTransportConfigurationFailure('missingHost', 'live transport requires the explicit authorization value');
    this.endpoint = validateLoopbackEndpoint(endpoint);
    this.fetchImpl = fetchImpl;
  }

  async version(): Promise<OllamaVersionReport> {
    const wire = await this.getJSON('api/version', 10_000);
    if (typeof wire.version !== 'string') throw new OllamaTransportFailure('malformedResponse', 'api/version response did not decode: no version field');
    return { version: wire.version };
  }

  /** The installed-model listing (what the Models screen shows). Read-only. */
  async installedModels(): Promise<OllamaInstalledModel[]> {
    const wire = await this.getJSON('api/tags', 10_000);
    const rows = Array.isArray(wire.models) ? (wire.models as Record<string, unknown>[]) : [];
    return rows.filter((r) => typeof r.name === 'string').map((r) => {
      const details = (r.details && typeof r.details === 'object' ? r.details : {}) as Record<string, unknown>;
      return {
        name: r.name as string,
        digest: typeof r.digest === 'string' ? r.digest : undefined,
        sizeBytes: typeof r.size === 'number' ? r.size : undefined,
        modifiedAt: typeof r.modified_at === 'string' ? r.modified_at : undefined,
        quantizationLevel: typeof details.quantization_level === 'string' ? details.quantization_level : undefined,
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
        family: typeof details.family === 'string' ? details.family : undefined,
        // Absent stays absent. An empty list would mean "it can do nothing", which is a claim the
        // runtime did not make.
        capabilities: capabilitiesOf(r.capabilities),
      };
    });
  }

  async model(name: string): Promise<OllamaModelReport> {
    const rows = await this.installedModels();
    const row = rows.find((r) => r.name === name || r.name === name + ':latest');
    if (!row) throw new OllamaTransportFailure('modelNotFound', `model '${name}' not found`, undefined, name);
    let contextLength: number | undefined;
    let quantization = row.quantizationLevel;
    let parameterSize = row.parameterSize;
    let family = row.family;
    let capabilities = row.capabilities;
    try {
      const shown = await this.postJSON('api/show', JSON.stringify({ model: name, name }), 10_000);
      const details = (shown.details && typeof shown.details === 'object' ? shown.details : {}) as Record<string, unknown>;
      quantization = quantization ?? (typeof details.quantization_level === 'string' ? details.quantization_level : undefined);
      parameterSize = parameterSize ?? (typeof details.parameter_size === 'string' ? details.parameter_size : undefined);
      family = family ?? (typeof details.family === 'string' ? details.family : undefined);
      capabilities = capabilitiesOf(shown.capabilities) ?? capabilities;
      const info = (shown.model_info && typeof shown.model_info === 'object' ? shown.model_info : {}) as Record<string, unknown>;
      for (const key of Object.keys(info)) {
        if (key.endsWith('.context_length') && typeof info[key] === 'number') { contextLength = info[key] as number; break; }
      }
    } catch (error) {
      // A show failure loses metadata, not truth: the listing row already proved existence.
      if (error instanceof OllamaTransportFailure && error.kind === 'modelNotFound') throw error;
    }
    return {
      name: row.name === name + ':latest' ? row.name : name,
      digest: row.digest, quantizationLevel: quantization, parameterSize, family, contextLengthTokens: contextLength, capabilities,
    };
  }

  async runningModels(): Promise<OllamaRunningModelReport[]> {
    const wire = await this.getJSON('api/ps', 10_000);
    const rows = Array.isArray(wire.models) ? (wire.models as Record<string, unknown>[]) : [];
    return rows.filter((r) => typeof r.name === 'string').map((r) => ({
      name: r.name as string,
      sizeBytes: typeof r.size === 'number' ? r.size : undefined,
      sizeVRAMBytes: typeof r.size_vram === 'number' ? r.size_vram : undefined,
    }));
  }

  async chat(request: OllamaChatRequest, cancellation: CancellationToken): Promise<OllamaChatReport> {
    const text = await this.perform('api/chat', 'POST', chatRequestBody(request), request.timeoutMilliseconds, cancellation);
    return chatReportFrom(text);
  }

  /**
   * Send one chat and hand every NDJSON line to `onChunk` as it lands, with the millisecond offset
   * from the instant the request was sent.
   *
   * The clock is read HERE, at the point of arrival, and nowhere else. That is the entire reason
   * this method exists: `chat` above can report what the runtime says it spent, but only this one
   * can report when anything actually showed up.
   */
  async chatStream(request: OllamaChatRequest, cancellation: CancellationToken,
                   onChunk: (chunk: OllamaStreamChunk, atMilliseconds: number) => void): Promise<OllamaChatReport> {
    const startedAt = Date.now();
    const chunks: OllamaStreamChunk[] = [];
    await this.performStreaming('api/chat', chatStreamRequestBody(request), request.timeoutMilliseconds, cancellation, (line) => {
      const chunk = chatStreamChunkFrom(line);
      chunks.push(chunk);
      onChunk(chunk, Date.now() - startedAt);
    });
    return chatReportFromStream(request.model, chunks);
  }

  // MARK: HTTP plumbing (loopback-only by construction above)

  private async getJSON(path: string, timeoutMilliseconds: number): Promise<Record<string, unknown>> {
    return this.decode(path, await this.perform(path, 'GET', undefined, timeoutMilliseconds));
  }
  private async postJSON(path: string, body: string, timeoutMilliseconds: number): Promise<Record<string, unknown>> {
    return this.decode(path, await this.perform(path, 'POST', body, timeoutMilliseconds));
  }
  private decode(path: string, text: string): Record<string, unknown> {
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Record<string, unknown>;
    } catch (error) {
      throw new OllamaTransportFailure('malformedResponse', `${path} response did not decode: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async perform(path: string, method: string, body: string | undefined, timeoutMilliseconds: number, cancellation?: CancellationToken): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMilliseconds);
    const unsubscribe = cancellation?.onCancel(() => { cancelled = true; controller.abort(); });
    if (cancellation?.isCancelled) { cancelled = true; controller.abort(); }
    try {
      const url = new URL(path, this.endpoint.href.endsWith('/') ? this.endpoint.href : this.endpoint.href + '/').href;
      let response: { status: number; text(): Promise<string> };
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (cancelled) throw new OllamaTransportFailure('cancelled');
        if (timedOut) throw new OllamaTransportFailure('timeout');
        throw new OllamaTransportFailure('connectionFailed', describeNetworkError(error));
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (cancelled) throw new OllamaTransportFailure('cancelled');
        if (timedOut) throw new OllamaTransportFailure('timeout');
        throw new OllamaTransportFailure('connectionFailed', describeNetworkError(error));
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = text.slice(0, 500);
        if (response.status === 404 && detail.includes('not found')) {
          const quoted = detail.split("'");
          const model = quoted.length > 1 ? quoted[1] : 'unreported';
          throw new OllamaTransportFailure('modelNotFound', detail, 404, model);
        }
        throw new OllamaTransportFailure('httpFailure', detail, response.status);
      }
      return text;
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }

  /**
   * The streaming twin of `perform`. Same loopback constraint, same timeout, same cancellation —
   * the difference is that the body is consumed incrementally instead of after it is complete.
   */
  private async performStreaming(path: string, body: string, timeoutMilliseconds: number,
                                 cancellation: CancellationToken | undefined, onLine: (line: string) => void): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMilliseconds);
    const unsubscribe = cancellation?.onCancel(() => { cancelled = true; controller.abort(); });
    if (cancellation?.isCancelled) { cancelled = true; controller.abort(); }
    try {
      const url = new URL(path, this.endpoint.href.endsWith('/') ? this.endpoint.href : this.endpoint.href + '/').href;
      let response: { status: number; text(): Promise<string>; body?: ByteStream | null };
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (cancelled) throw new OllamaTransportFailure('cancelled');
        if (timedOut) throw new OllamaTransportFailure('timeout');
        throw new OllamaTransportFailure('connectionFailed', describeNetworkError(error));
      }
      if (response.status < 200 || response.status >= 300) {
        // A failure arrives as an ordinary body, so it is read the ordinary way.
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        if (response.status === 404 && detail.includes('not found')) {
          const quoted = detail.split("'");
          throw new OllamaTransportFailure('modelNotFound', detail, 404, quoted.length > 1 ? quoted[1] : 'unreported');
        }
        throw new OllamaTransportFailure('httpFailure', detail, response.status);
      }
      if (!response.body) {
        throw new OllamaTransportFailure('malformedResponse',
          'the runtime accepted a streaming request but returned no readable stream, so no arrival time could be observed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) buffered += decoder.decode(value, { stream: true });
          let newline = buffered.indexOf('\n');
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line.length > 0) onLine(line);
            newline = buffered.indexOf('\n');
          }
        }
      } catch (error) {
        if (cancelled) throw new OllamaTransportFailure('cancelled');
        if (timedOut) throw new OllamaTransportFailure('timeout');
        if (error instanceof OllamaTransportFailure) throw error;
        throw new OllamaTransportFailure('connectionFailed', describeNetworkError(error));
      } finally {
        // Cancelling a reader that already finished is harmless; leaving one open is not.
        await reader.cancel().catch(() => undefined);
      }
      buffered += decoder.decode();
      const trailing = buffered.trim();
      if (trailing.length > 0) onLine(trailing);
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }
}

/** A capability list, or undefined when the runtime published none. Never an empty list. */
function capabilitiesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((entry): entry is string => typeof entry === 'string');
  return names.length > 0 ? names : undefined;
}

export function describeNetworkError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { cause?: { code?: string; message?: string }; code?: string; message?: string };
    const code = e.cause?.code ?? e.code;
    if (code) return `${code}${e.cause?.message ? `: ${e.cause.message}` : ''}`;
    if (e.message) return e.message;
  }
  return String(error);
}
