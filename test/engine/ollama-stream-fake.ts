// A fake Ollama `/api/chat` STREAM, for tests that must not touch a runtime or a network.
//
// WHY A HELPER RATHER THAN A LITERAL. The driver's correctness under streaming is mostly about
// BOUNDARIES: one network chunk is not one JSON event, an event can straddle two chunks, a
// multi-byte character can straddle two chunks, and the counts live only on the terminal event. A
// hand-written literal tends to be one tidy chunk per event, which is the one case that was never
// in doubt. So every fake here serialises to NDJSON and is then re-cut into chunks of a size the
// test chooses, deliberately unaligned with the events.

import { ByteStream, ByteStreamReader } from '../../src/core/ollama-http';

export interface StreamedChatOptions {
  model: string;
  /** The visible content, delivered in pieces. Empty means the turn produced no content. */
  content?: string;
  /** Delivered on one event, the way Ollama sends them. */
  toolCalls?: unknown[];
  thinking?: string;
  /** On the TERMINAL event only, which is the only place the driver reads them. */
  promptEvalCount?: number;
  evalCount?: number;
  totalDuration?: number;
  loadDuration?: number;
  promptEvalDuration?: number;
  evalDuration?: number;
  doneReason?: string;
  /** Omit the terminal `done` event entirely: a stream that just stops. */
  omitTerminalEvent?: boolean;
  /** Appended verbatim after the events, for malformed-payload tests. */
  trailingRaw?: string;
  /** An `{"error": …}` event instead of finishing. */
  errorEvent?: string;
}

/** The NDJSON a streamed turn puts on the wire, as one string. */
export function streamedChatNDJSON(options: StreamedChatOptions): string {
  const lines: string[] = [];
  const at = '2026-09-23T12:00:00Z';
  const piece = (message: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ model: options.model, created_at: at, message: { role: 'assistant', ...message }, done: false }));
  };
  for (const part of splitIntoTokens(options.thinking ?? '')) piece({ content: '', thinking: part });
  for (const part of splitIntoTokens(options.content ?? '')) piece({ content: part });
  if (options.toolCalls !== undefined && options.toolCalls.length > 0) piece({ content: '', tool_calls: options.toolCalls });
  if (options.errorEvent !== undefined) {
    lines.push(JSON.stringify({ error: options.errorEvent }));
  } else if (!options.omitTerminalEvent) {
    lines.push(JSON.stringify({
      model: options.model, created_at: at, message: { role: 'assistant', content: '' },
      done: true, done_reason: options.doneReason ?? 'stop',
      ...(options.promptEvalCount === undefined ? {} : { prompt_eval_count: options.promptEvalCount }),
      ...(options.evalCount === undefined ? {} : { eval_count: options.evalCount }),
      ...(options.totalDuration === undefined ? {} : { total_duration: options.totalDuration }),
      ...(options.loadDuration === undefined ? {} : { load_duration: options.loadDuration }),
      ...(options.promptEvalDuration === undefined ? {} : { prompt_eval_duration: options.promptEvalDuration }),
      ...(options.evalDuration === undefined ? {} : { eval_duration: options.evalDuration }),
    }));
  }
  const body = lines.map((line) => `${line}\n`).join('');
  return options.trailingRaw === undefined ? body : body + options.trailingRaw;
}

/** Words, so a content string becomes several events rather than one. */
function splitIntoTokens(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/(?<=\s)/).filter((part) => part.length > 0);
}

export interface ChunkingOptions {
  /** Bytes per network chunk. Deliberately unaligned with the JSON events. */
  chunkBytes?: number;
  /**
   * One chunk per NDJSON line instead. For the timing tests, where what is being asserted is WHEN a
   * complete event landed and an arbitrary byte cut would make that depend on the payload's length.
   */
  chunkPerLine?: boolean;
  /** Milliseconds before each chunk. A number applies to every chunk; a list is per chunk. */
  delayMilliseconds?: number | number[];
  /** Throw mid-stream after this many chunks, as a broken socket would. */
  failAfterChunks?: number;
  failure?: Error;
  /** Never end and never yield: a stream that is open and silent. Ends when the reader is cancelled. */
  hangAfterChunks?: number;
  /**
   * The caller's abort signal, honoured the way a real socket honours it: a read in flight FAILS
   * when the signal fires. Without this a fake stream would go on sleeping through a deadline that
   * a real one would have been killed by, and the deadline tests would prove nothing.
   */
  signal?: AbortSignal;
  /** Called when the reader is cancelled, so a test can assert the stream was actually closed. */
  onCancelled?: () => void;
}

/** A `ByteStream` over `text`, cut into chunks that do not respect event boundaries. */
export function byteStreamOf(text: string, options: ChunkingOptions = {}): ByteStream {
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  if (options.chunkPerLine === true) {
    for (const line of text.split(/(?<=\n)/)) if (line.length > 0) chunks.push(Buffer.from(line, 'utf8'));
  } else {
    const size = Math.max(1, options.chunkBytes ?? 7);
    for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
  }
  let index = 0;
  let cancelled = false;
  /** Sleep, unless the caller's signal fires first — which is what a real socket does. */
  const waitOrAbort = (milliseconds: number | undefined): Promise<void> => new Promise((resolve, reject) => {
    const abort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (options.signal?.aborted) { abort(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (milliseconds !== undefined) {
      timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', abort, { once: true });
  });

  const reader: ByteStreamReader = {
    read: async () => {
      if (cancelled) return { done: true };
      if (options.failAfterChunks !== undefined && index >= options.failAfterChunks) {
        throw options.failure ?? new Error('ECONNRESET: the stream broke');
      }
      if (options.hangAfterChunks !== undefined && index >= options.hangAfterChunks) {
        // Open and silent. Only a cancel or an abort — which is what a deadline or a pause does — ends this.
        await waitOrAbort(undefined);
      }
      if (index >= chunks.length) return { done: true };
      const delay = Array.isArray(options.delayMilliseconds)
        ? options.delayMilliseconds[Math.min(index, options.delayMilliseconds.length - 1)] ?? 0
        : options.delayMilliseconds ?? 0;
      if (delay > 0) await waitOrAbort(delay);
      if (cancelled) return { done: true };
      const chunk = chunks[index];
      index += 1;
      return { done: false, value: chunk };
    },
    cancel: async () => { cancelled = true; options.onCancelled?.(); },
  };
  return { getReader: () => reader };
}

/** A whole streamed `/api/chat` response: 200, a readable NDJSON body, no buffered `text()`. */
export function streamedChatResponse(options: StreamedChatOptions & ChunkingOptions) {
  const text = streamedChatNDJSON(options);
  return {
    status: 200,
    text: async () => text,
    body: byteStreamOf(text, options),
  };
}
