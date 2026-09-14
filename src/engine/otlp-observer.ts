// Benchmark engine · reading a tool's own telemetry, without keeping who ran it.
//
// WHY THIS EXISTS. `codex exec --json` reports no model identity, no cost, no rate-limit figure and —
// the part this module is for — NO ECHO OF THE REASONING EFFORT IT APPLIED. Pass 6 recorded effort as
// accepted-but-unverifiable on both providers and could not do better. Pass 7 established
// empirically that the Codex CLI's OpenTelemetry exporter DOES carry it: `codex.turn.reasoning_effort`
// on the turn span, `codex.request.reasoning_effort` on each request span, and a full token
// decomposition that agrees exactly with the `turn.completed` usage block the adapter already reads.
//
// So a frozen effort level can be checked against what the tool says it did. That is the whole of
// what this module is allowed to establish.
//
// WHAT IT MAY NEVER ESTABLISH — and this is the load-bearing rule.
//
//   `model` and `slug` in this telemetry are THE IDENTIFIER THE CLIENT SENT. A client naming its own
//   request is not a model naming itself in a reply. Nothing that arrives here is evidence of which
//   model answered, `reportedModelID` is never written from it, and a Codex candidate stays
//   `requestAcceptedIdentityUnverifiable` however much telemetry it produces. A collector that could
//   upgrade an identity would be a collector that turned self-report into proof.
//
// WHAT IT IS NOT. Not a proxy, not a man-in-the-middle, not a way to read anything the CLI does not
// itself choose to export. It binds 127.0.0.1 on an EPHEMERAL port — so two campaigns cannot collide
// on a fixed one — and makes no outbound connection of any kind. The CLI is pointed at it by a
// per-invocation `-c` override, so the operator's `~/.codex/config.toml` is never edited and no other
// Codex session on the machine is affected. (The benchmark path also passes `--ignore-user-config`,
// which means that file could not reach the request anyway.)
//
// THE IDENTIFIERS ARE THE REASON THIS IS A MODULE AND NOT A SCRIPT. Every record `codex` exports
// carries `user.email` and `user.account_id` in clear. It redacts the PROMPT itself — the attribute
// arrives as the literal `[REDACTED]` — and does not redact the operator. So redaction happens HERE,
// at ingest, before a byte is written: an evidence file that had to be scrubbed afterwards is an
// evidence file that was wrong the moment it was created. `stop()` then re-reads what it wrote and
// audits it, because a redactor nobody checked is a claim rather than a property.
//
// CORRELATION WITHOUT KEEPING THE KEY. `conversation.id` in the telemetry is byte-identical to the
// `thread_id` the CLI prints on stdout, which is how an observation is matched to the attempt that
// produced it. That real value lives in memory for the length of the run and reaches no file: what is
// written carries a stable placeholder, and the durable link to an attempt is the LEDGER ROW, whose
// key is a slot key and not an identifier of anybody.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

/**
 * Attribute values that must never reach a file.
 *
 * `conversation.id` is here as well as being the correlation key: it is kept in memory and replaced
 * on the way to disk. `service.instance.id` and `host.name` name this machine, and no finding needs
 * them.
 */
export const OTLP_SENSITIVE_ATTRIBUTES = [
  'user.email', 'user.account_id', 'conversation.id', 'host.name', 'service.instance.id',
] as const;

/** What one Codex turn said about itself. Every field optional: the tool may say nothing. */
export interface OTLPTurnObservation {
  /** True when a turn span for this conversation actually arrived. False means nothing was observed. */
  correlated: boolean;
  /** `codex.turn.reasoning_effort` — the effort the CLI says it applied to the turn. */
  turnReasoningEffort?: string;
  /** `codex.request.reasoning_effort` — the effort it says it sent on the request. */
  requestReasoningEffort?: string;
  inputTokens?: number;
  nonCachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  /** Which MCP servers the tool attached. `codex_apps` survives `--ignore-user-config`. */
  mcpServers?: string;
  /** How many telemetry records mentioned this conversation. Zero means it was never seen. */
  recordCount: number;
}

/** The seam the adapter uses, so nothing in the adapter depends on an HTTP server existing. */
export interface OTLPTurnSource {
  readonly endpoint: string;
  observe(threadID: string): Promise<OTLPTurnObservation | undefined>;
}

export interface OTLPObserverOptions {
  /** Where the redacted payloads are written. One file per campaign. */
  evidenceFile: string;
  /** How long `observe` waits for a turn span after the child has exited. */
  observeTimeoutMilliseconds?: number;
  /** Fixed port, for a test that needs one. Life uses an ephemeral port. */
  port?: number;
}

interface Pending { resolve: () => void; timer: NodeJS.Timeout }

export class OTLPObserver implements OTLPTurnSource {
  readonly endpoint: string;
  private payloadCount = 0;
  private readonly byConversation = new Map<string, OTLPTurnObservation>();
  private readonly waiting = new Map<string, Pending[]>();
  private readonly placeholders = new Map<string, string>();
  private redactionCount = 0;

  private constructor(private readonly server: http.Server, port: number,
                      private readonly options: OTLPObserverOptions) {
    this.endpoint = `http://127.0.0.1:${port}`;
  }

  static async start(options: OTLPObserverOptions): Promise<OTLPObserver> {
    fs.mkdirSync(path.dirname(path.resolve(options.evidenceFile)), { recursive: true });
    // Truncated at start, so a resumed campaign's file is the resumed run's and not two runs merged.
    fs.writeFileSync(path.resolve(options.evidenceFile), '', 'utf8');
    const server = http.createServer();
    const observer = await new Promise<OTLPObserver>((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 and port 0: loopback only, and an ephemeral port so two campaigns on one machine
      // cannot take each other's collector.
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        resolve(new OTLPObserver(server, address.port, options));
      });
    });
    server.on('request', (request, response) => observer.receive(request, response));
    return observer;
  }

  private receive(request: http.IncomingMessage, response: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      this.payloadCount += 1;
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = undefined; }
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
        // INDEX FIRST, from the unredacted value, then write the redacted copy. The real
        // conversation id is needed to match an attempt and must not reach the file, so the only
        // place it exists is this call stack and the in-memory map.
        this.index(parsed);
        fs.appendFileSync(path.resolve(this.options.evidenceFile),
          `${JSON.stringify({ at: new Date().toISOString(), url: request.url, json: this.redact(parsed) })}\n`, 'utf8');
      } else {
        // A payload this engine cannot read is recorded as having arrived, and its bytes are NOT
        // kept: an unparsed body cannot be redacted, and an unredactable body cannot be evidence.
        fs.appendFileSync(path.resolve(this.options.evidenceFile),
          `${JSON.stringify({ at: new Date().toISOString(), url: request.url, unreadable: true, bytes: body.length })}\n`, 'utf8');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  }

  // MARK: - Reading what arrived

  private index(payload: unknown): void {
    for (const attributes of attributeSets(payload)) {
      const conversationID = attributes['conversation.id'];
      if (typeof conversationID !== 'string' || conversationID.length === 0) continue;
      const entry = this.byConversation.get(conversationID)
        ?? { correlated: false, recordCount: 0 } as OTLPTurnObservation;
      entry.recordCount += 1;
      const text = (key: string): string | undefined =>
        (typeof attributes[key] === 'string' ? attributes[key] as string : undefined);
      const count = (key: string): number | undefined => {
        const value = attributes[key];
        if (typeof value === 'number') return Math.round(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
        return undefined;
      };
      // The turn span is the record that makes an observation complete. Everything else refines it.
      const turnEffort = text('codex.turn.reasoning_effort');
      if (turnEffort !== undefined) { entry.turnReasoningEffort = turnEffort; entry.correlated = true; }
      entry.requestReasoningEffort = text('codex.request.reasoning_effort') ?? entry.requestReasoningEffort;
      entry.mcpServers = text('mcp_servers') ?? entry.mcpServers;
      const assign = (field: keyof OTLPTurnObservation, key: string): void => {
        const value = count(key);
        if (value !== undefined) (entry as unknown as Record<string, unknown>)[field] = value;
      };
      assign('inputTokens', 'codex.turn.token_usage.input_tokens');
      assign('nonCachedInputTokens', 'codex.turn.token_usage.non_cached_input_tokens');
      assign('cachedInputTokens', 'codex.turn.token_usage.cached_input_tokens');
      assign('cacheWriteInputTokens', 'codex.turn.token_usage.cache_write_input_tokens');
      assign('outputTokens', 'codex.turn.token_usage.output_tokens');
      assign('reasoningOutputTokens', 'codex.turn.token_usage.reasoning_output_tokens');
      assign('totalTokens', 'codex.turn.token_usage.total_tokens');
      this.byConversation.set(conversationID, entry);
      if (entry.correlated) this.wake(conversationID);
    }
  }

  private wake(conversationID: string): void {
    for (const pending of this.waiting.get(conversationID) ?? []) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.waiting.delete(conversationID);
  }

  /**
   * The observation for one turn, waiting a BOUNDED time for it.
   *
   * The CLI flushes its exporter on shutdown, so in practice the records are already here when the
   * child exits. The wait covers jitter and is short: a campaign must never stall on telemetry,
   * because telemetry is not what it is measuring. A timeout returns what arrived — possibly an
   * uncorrelated record, possibly nothing — and never throws.
   */
  async observe(threadID: string): Promise<OTLPTurnObservation | undefined> {
    if (threadID.length === 0) return undefined;
    const existing = this.byConversation.get(threadID);
    if (existing?.correlated) return existing;
    const timeout = this.options.observeTimeoutMilliseconds ?? 2_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const list = (this.waiting.get(threadID) ?? []).filter((entry) => entry.timer !== timer);
        if (list.length === 0) this.waiting.delete(threadID); else this.waiting.set(threadID, list);
        resolve();
      }, timeout);
      this.waiting.set(threadID, [...(this.waiting.get(threadID) ?? []), { resolve, timer }]);
    });
    return this.byConversation.get(threadID);
  }

  // MARK: - Redaction, at ingest

  private placeholderFor(key: string, value: string): string {
    const cacheKey = `${key} ${value}`;
    let placeholder = this.placeholders.get(cacheKey);
    if (placeholder === undefined) {
      // Stable per distinct value, so "the same conversation" stays readable in the file without the
      // identifier being in it.
      placeholder = `[REDACTED:${key}:${this.placeholders.size + 1}]`;
      this.placeholders.set(cacheKey, placeholder);
    }
    this.redactionCount += 1;
    return placeholder;
  }

  private redact(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((entry) => this.redact(entry));
    if (node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    // An OTLP attribute is `{ key, value: { stringValue: ... } }`: the key and the value it governs
    // are siblings, so the rewrite has to happen at the pair rather than at the leaf.
    if (typeof record.key === 'string' && (OTLP_SENSITIVE_ATTRIBUTES as readonly string[]).includes(record.key)
      && record.value !== null && typeof record.value === 'object') {
      const value = record.value as Record<string, unknown>;
      const field = ['stringValue', 'intValue', 'doubleValue'].find((name) => name in value);
      if (field !== undefined) {
        return { ...record, value: { ...value, [field]: this.placeholderFor(record.key, String(value[field])) } };
      }
    }
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, this.redact(value)]));
  }

  // MARK: - Shutting down, and proving what was written

  async stop(): Promise<{
    payloadCount: number; redactionCount: number; distinctIdentifiers: number;
    conversationCount: number; correlatedCount: number;
    leakAuditClean: boolean; leaks: string[]; evidenceFile: string; endpoint: string;
  }> {
    for (const [conversationID] of this.waiting) this.wake(conversationID);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // PROOF, NOT ASSERTION. The file is re-read and searched for the shape a surviving email address
    // would have. A redactor whose own output nobody checked is a claim.
    const file = path.resolve(this.options.evidenceFile);
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const leaks = [...written.matchAll(EMAIL_SHAPE)].map((match) => match[0]);
    return {
      payloadCount: this.payloadCount,
      redactionCount: this.redactionCount,
      distinctIdentifiers: this.placeholders.size,
      conversationCount: this.byConversation.size,
      correlatedCount: [...this.byConversation.values()].filter((entry) => entry.correlated).length,
      leakAuditClean: leaks.length === 0,
      leaks,
      evidenceFile: file,
      endpoint: this.endpoint,
    };
  }
}

const EMAIL_SHAPE = new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}', 'g');

/** One flat map per `attributes` array anywhere in an OTLP payload, values already unwrapped. */
export function attributeSets(payload: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const entry of node) walk(entry); return; }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.attributes)) {
      const flat: Record<string, unknown> = {};
      for (const attribute of record.attributes) {
        if (attribute === null || typeof attribute !== 'object') continue;
        const pair = attribute as Record<string, unknown>;
        if (typeof pair.key !== 'string') continue;
        flat[pair.key] = unwrapAnyValue(pair.value);
      }
      if (Object.keys(flat).length > 0) out.push(flat);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return out;
}

/** An OTLP `AnyValue` as a plain scalar. Anything richer is left alone rather than flattened wrongly. */
function unwrapAnyValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  for (const field of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (field in record) return record[field];
  }
  return value;
}

/**
 * The `-c otel=...` override that points one `codex exec` invocation at a collector.
 *
 * All three exporters, because Pass 7 learned this the hard way: setting only `exporter` delivers
 * LOGS alone, and `codex.turn.reasoning_effort` and the token decomposition live on the TRACE spans.
 * A probe that configured one exporter would have concluded effort was unobtainable.
 */
export function codexOTLPConfigArgument(endpoint: string): string {
  const exporter = `{ "otlp-http" = { endpoint = "${endpoint}", protocol = "json" } }`;
  return `otel={ exporter = ${exporter}, trace_exporter = ${exporter}, metrics_exporter = ${exporter} }`;
}
