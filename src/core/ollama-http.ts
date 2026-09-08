// Model Lab core · the live Ollama HTTP transport (port of `ModelLabOllamaHTTPTransport`).
//
// The ONE place the benchmark engine may touch a network. Three fail-closed properties:
//   • Construction REQUIRES a `LiveExecutionAuthorization`, obtainable only by acknowledging both
//     facts it names (the desktop application mints it when the user presses Start on a run whose
//     pre-flight summary states them).
//   • Endpoints must be LOOPBACK (127.0.0.1 / localhost / ::1): Model Lab benchmarks the runtime
//     on THIS machine, so the hardware evidence stays truthful.
//   • Only the read/describe/generate surface exists here. No pull, create, copy, push, or delete.
//
// Every request carries its own timeout; cancellation aborts the transfer mid-flight.

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
      `endpoint host '${url.hostname}' is not loopback — Model Lab benchmarks the runtime on this machine only (127.0.0.1, localhost, ::1)`);
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
  (input: string, init: { method: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{
    status: number;
    text(): Promise<string>;
    /** Present on a real `fetch` response. Only the streaming path reads it. */
    body?: ByteStream | null;
  }>;
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
    try {
      const shown = await this.postJSON('api/show', JSON.stringify({ model: name, name }), 10_000);
      const details = (shown.details && typeof shown.details === 'object' ? shown.details : {}) as Record<string, unknown>;
      quantization = quantization ?? (typeof details.quantization_level === 'string' ? details.quantization_level : undefined);
      parameterSize = parameterSize ?? (typeof details.parameter_size === 'string' ? details.parameter_size : undefined);
      family = family ?? (typeof details.family === 'string' ? details.family : undefined);
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
      digest: row.digest, quantizationLevel: quantization, parameterSize, family, contextLengthTokens: contextLength,
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

export function describeNetworkError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { cause?: { code?: string; message?: string }; code?: string; message?: string };
    const code = e.cause?.code ?? e.code;
    if (code) return `${code}${e.cause?.message ? `: ${e.cause.message}` : ''}`;
    if (e.message) return e.message;
  }
  return String(error);
}
