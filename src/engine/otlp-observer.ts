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

/**
 * WHERE THE APPLIED EFFORT IS READ FROM, and why there is more than one place.
 *
 * codex-cli 0.154.0 put it on the TRACE spans, as `codex.turn.reasoning_effort` and
 * `codex.request.reasoning_effort`, and those spans carried `conversation.id`. 0.155.0 moved it to
 * the `codex.conversation_starts` LOG record as a flat `reasoning_effort`, and STOPPED putting
 * `conversation.id` on spans at all — so on 0.155.0 the old names are not merely absent, they are
 * unjoinable. An observer reading only the 0.154.0 names records four perfectly good conversations
 * as `correlated: false` and reports the effort as unavailable, which is what it did.
 *
 * Both are read, so an upgrade in either direction keeps working. The flat name is taken ONLY from
 * the conversation-start record: `reasoning_effort` is a common enough attribute name that reading
 * it from any record that happened to carry it would be how unrelated telemetry gets attached to a
 * request.
 */
const CONVERSATION_STARTS_EVENT = 'codex.conversation_starts';

/** The per-turn TTFT record 0.155.0 exports, carrying `duration_ms`. Observed in captured telemetry. */
const TURN_TTFT_EVENT = 'codex.turn_ttft';

/**
 * Record an effort, or refuse to.
 *
 * Two different efforts for one conversation means the join is wrong somewhere, and the honest
 * answer is that this turn's effort is unavailable — not the first value, and not the last one to
 * arrive. Once ambiguous, always ambiguous: a third record agreeing with one of them does not break
 * the tie, it just makes the count 2-1.
 */
function recordEffort(entry: OTLPTurnObservation, effort: string, source: string): void {
  if (entry.effortAmbiguous === true) return;
  if (entry.turnReasoningEffort !== undefined && entry.turnReasoningEffort !== effort) {
    entry.effortAmbiguous = true;
    entry.turnReasoningEffort = undefined;
    entry.turnReasoningEffortSource = undefined;
    entry.correlated = false;
    return;
  }
  entry.turnReasoningEffort = effort;
  entry.turnReasoningEffortSource = source;
  entry.correlated = true;
}

/** The per-request record 0.155.0 exports for each streamed response, carrying its effort and token counts. */
const SSE_EVENT = 'codex.sse_event';

/** One completed model request, as the tool's telemetry counted it. Verbatim; nothing here re-derives a figure. */
export interface OTLPRequestUsage {
  /** `event.timestamp` of the record, which is also how an exporter's re-delivery of it is recognised. */
  at: string;
  effort?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  toolTokens?: number;
}

/** What one Codex turn said about itself. Every field optional: the tool may say nothing. */
export interface OTLPTurnObservation {
  /**
   * THE DURABLE LINK BETWEEN A LEDGER ROW AND THIS TOOL'S TELEMETRY, and it is not an identifier.
   *
   * Measured on a live campaign: the Codex CLI flushes its LOG records promptly but its TRACE spans
   * arrive 3.8-10.8 seconds AFTER the attempt has finished and been recorded — the exporter shuts
   * down on its own schedule, well after the adapter has read stdout and returned. The effort and
   * the token decomposition are on those spans. So the attempt cannot wait for them: blocking long
   * enough to catch one would have added roughly 48 minutes to a 264-attempt campaign, to learn
   * something that arrives on its own a few seconds later.
   *
   * Instead the row carries this key, the evidence file carries the same key, and the two are joined
   * AFTER the run. It is the placeholder the redactor assigned to this conversation — stable for the
   * length of the campaign, meaningless outside it, and already the only form of the conversation id
   * that is allowed to reach a file.
   */
  correlationKey: string;
  /**
   * True when a turn span had ALREADY arrived while the attempt was still open. Usually FALSE, and
   * false is not a failure: it means the observation is pending, and `correlationKey` is how it is
   * collected. A row is never told that nothing was observed when something was merely late.
   */
  correlated: boolean;
  /** The effort the CLI says it applied to the turn. See `CONVERSATION_STARTS_EVENT` for where it is read from. */
  turnReasoningEffort?: string;
  /** Which attribute `turnReasoningEffort` was read from, so a row can say which record it rests on. */
  turnReasoningEffortSource?: string;
  /** `codex.request.reasoning_effort` — the effort it says it sent on the request. */
  requestReasoningEffort?: string;
  /**
   * EVERY distinct per-request effort, sorted: 0.154.0's `codex.request.reasoning_effort` and 0.155.0's
   * `model_reasoning_effort` on a `codex.sse_event` record. More than one value means the requests of one
   * conversation were not all made at one effort — which is a finding, not a join error.
   */
  requestReasoningEfforts?: string[];
  /**
   * The model identifiers THE CLIENT SENT (`model`, `slug`), distinct and sorted. Never an identity: read
   * only so an observation naming a different request can be refused rather than attributed.
   */
  clientSentModels?: string[];
  /** `auth.env_openai_api_key_present` on the conversation-start record: the tool's own word on whether it saw a key. */
  apiKeyEnvironmentPresent?: boolean;
  /** One entry per completed request, de-duplicated by timestamp because the exporter re-delivers records. */
  requestUsage?: OTLPRequestUsage[];
  /**
   * Set ONLY by a view that scopes this observer to one run, never by the observer itself: why the
   * records carrying this conversation id cannot be attributed to the attempt that asked for them.
   */
  attributionRefused?: string;
  /** Set when the collector itself had failed before this observation could be completed. */
  observerFailure?: string;
  /**
   * Set when one conversation reported two DIFFERENT efforts. The value is then dropped and never
   * reinstated: a join that cannot say which of two figures belongs to this turn has not correlated
   * it, and reporting either one would be a guess wearing the evidence's clothes.
   */
  effortAmbiguous?: boolean;
  inputTokens?: number;
  nonCachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  /** Which MCP servers the tool attached. `codex_apps` survives `--ignore-user-config`. */
  mcpServers?: string;
  /**
   * `auth_mode` on the conversation-start record — `Chatgpt` on a subscription session. The tool's own
   * statement of how this turn was authenticated, which is billing evidence and not identity.
   */
  authMode?: string;
  /** `sandbox_policy` and `approval_policy` on the same record: what the tool says it ran under. */
  sandboxPolicy?: string;
  approvalPolicy?: string;
  /** `duration_ms` on the `codex.turn_ttft` record: the tool's own time to first token for the turn. */
  turnTTFTMilliseconds?: number;
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
  /** How long `observe` waits for a turn span. Short by design — see `correlationKey`. */
  observeTimeoutMilliseconds?: number;
  /** How long `stop` waits for spans still in the exporter's queue before closing the socket. */
  shutdownGraceMilliseconds?: number;
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
  private unreadableCount = 0;
  private failureReason?: string;
  private stopping = false;

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
    // A COLLECTOR THAT DIED IS A MEASUREMENT FAILURE, and it has to be visible as one. Without this, a
    // socket that closed mid-matrix would look exactly like a tool that exported nothing.
    server.on('error', (error) => { observer.failureReason ??= `the collector's socket failed: ${String(error)}`; });
    server.on('close', () => {
      if (!observer.stopping) observer.failureReason ??= 'the collector\'s socket closed before it was stopped';
    });
    return observer;
  }

  /**
   * Whether a loopback collector COULD be started here, without starting one.
   *
   * Binds 127.0.0.1 on an ephemeral port and releases it at once. Writes no file and makes no
   * connection, which is what lets a dry run answer "observer available" honestly.
   */
  static async probeLoopback(): Promise<{ available: boolean; detail: string }> {
    const server = http.createServer();
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return { available: true, detail: `a loopback socket was bound (127.0.0.1:${port}) and released; the live collector `
        + 'takes its own ephemeral port when the run starts' };
    } catch (error) {
      return { available: false, detail: `no loopback socket could be bound: ${String(error)}` };
    }
  }

  /** Why the collector stopped working, if it did. Undefined while it is healthy. */
  get failure(): string | undefined {
    return this.failureReason;
  }

  /** Payloads that arrived and could not be parsed. Counted; their bytes are never kept. */
  get unreadablePayloadCount(): number {
    return this.unreadableCount;
  }

  /** Every observation, keyed by its redacted placeholder — the same table `stop` writes. */
  snapshot(): Record<string, OTLPTurnObservation> {
    const index: Record<string, OTLPTurnObservation> = {};
    for (const observation of this.byConversation.values()) {
      index[observation.correlationKey] = JSON.parse(JSON.stringify(observation)) as OTLPTurnObservation;
    }
    return index;
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
        this.unreadableCount += 1;
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
        // The key is minted on first sight, by the SAME function the redactor uses, so a row written
        // now and a span written ten seconds from now carry the same one.
        ?? { correlated: false, recordCount: 0, correlationKey: this.placeholderFor('conversation.id', conversationID) } as OTLPTurnObservation;
      entry.recordCount += 1;
      const text = (key: string): string | undefined =>
        (typeof attributes[key] === 'string' ? attributes[key] as string : undefined);
      const count = (key: string): number | undefined => {
        const value = attributes[key];
        if (typeof value === 'number') return Math.round(value);
        if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
        return undefined;
      };
      // The record carrying the effort is what makes an observation complete. Everything else refines
      // it. WHICH record that is depends on the CLI version — see `CONVERSATION_STARTS_EVENT`.
      const spanEffort = text('codex.turn.reasoning_effort');
      const startEffort = text('event.name') === CONVERSATION_STARTS_EVENT ? text('reasoning_effort') : undefined;
      if (spanEffort !== undefined) recordEffort(entry, spanEffort, 'otlp:codex.turn.reasoning_effort');
      else if (startEffort !== undefined) recordEffort(entry, startEffort, 'otlp:codex.conversation_starts.reasoning_effort');
      entry.requestReasoningEffort = text('codex.request.reasoning_effort') ?? entry.requestReasoningEffort;
      // THE PER-REQUEST EFFORT, read ONLY from the record whose meaning is known: 0.155.0 puts it on the
      // `codex.sse_event` for a completed response as `model_reasoning_effort`.
      const requestEffort = text('codex.request.reasoning_effort')
        ?? (text('event.name') === SSE_EVENT ? text('model_reasoning_effort') : undefined);
      if (requestEffort !== undefined) {
        entry.requestReasoningEfforts = [...new Set([...(entry.requestReasoningEfforts ?? []), requestEffort])].sort();
      }
      // What the CLIENT says it asked for. Kept to REFUSE a foreign observation, never as an identity.
      for (const key of ['model', 'slug']) {
        const sent = text(key);
        if (sent !== undefined) entry.clientSentModels = [...new Set([...(entry.clientSentModels ?? []), sent])].sort();
      }
      if (text('event.name') === SSE_EVENT && text('event.kind') === 'response.completed') {
        const request: OTLPRequestUsage = {
          at: text('event.timestamp') ?? '', effort: text('model_reasoning_effort'),
          inputTokens: count('input_token_count'), cachedInputTokens: count('cached_token_count'),
          cacheWriteInputTokens: count('cache_write_token_count'), outputTokens: count('output_token_count'),
          reasoningTokens: count('reasoning_token_count'), toolTokens: count('tool_token_count'),
        };
        // ONLY THE RECORD THAT CARRIES THE COUNTS IS A USAGE RECORD. On the HTTP/SSE transport 0.155.0 writes a
        // second, bare `response.completed` for the same request, with the SAME timestamp and nothing but a
        // duration; keyed by timestamp alone, whichever of the two landed first swallowed the other.
        const carriesUsage = Object.entries(request).some(([key, value]) => key !== 'at' && value !== undefined);
        const usage = entry.requestUsage ?? [];
        // An exporter re-delivers a batch it is unsure of; the same record twice — identical in every
        // field, not merely in its timestamp — is one request, not two.
        if (carriesUsage && !usage.some((existing) => JSON.stringify(existing) === JSON.stringify(request))) {
          usage.push(request);
          entry.requestUsage = usage;
        }
      }
      entry.mcpServers = text('mcp_servers') ?? entry.mcpServers;
      // Read ONLY from the record whose meaning is known, for the reason given on
      // `CONVERSATION_STARTS_EVENT`: these are common attribute names.
      if (text('event.name') === CONVERSATION_STARTS_EVENT) {
        const keyPresent = attributes['auth.env_openai_api_key_present'];
        if (typeof keyPresent === 'boolean') entry.apiKeyEnvironmentPresent = keyPresent;
        entry.authMode = text('auth_mode') ?? entry.authMode;
        entry.sandboxPolicy = text('sandbox_policy') ?? entry.sandboxPolicy;
        entry.approvalPolicy = text('approval_policy') ?? entry.approvalPolicy;
      }
      if (text('event.name') === TURN_TTFT_EVENT && entry.turnTTFTMilliseconds === undefined) {
        entry.turnTTFTMilliseconds = count('duration_ms');
      }
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
    // A SHORT wait, and deliberately short. See the note on `correlationKey`: the span this would be
    // waiting for arrives seconds after the attempt closes, so waiting for it stalls the campaign
    // without catching it. The wait is kept only for the case where it has very nearly arrived.
    const timeout = this.options.observeTimeoutMilliseconds ?? 250;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const list = (this.waiting.get(threadID) ?? []).filter((entry) => entry.timer !== timer);
        if (list.length === 0) this.waiting.delete(threadID); else this.waiting.set(threadID, list);
        resolve();
      }, timeout);
      this.waiting.set(threadID, [...(this.waiting.get(threadID) ?? []), { resolve, timer }]);
    });
    const found = this.byConversation.get(threadID);
    if (found) return found;
    // Nothing has arrived for this thread yet — which on this tool is the ordinary case. The key is
    // minted anyway, so the row can be joined to whatever arrives later. An observation with no
    // figures and a key is honest; one with no key would be unrecoverable.
    const pending: OTLPTurnObservation = {
      correlated: false, recordCount: 0, correlationKey: this.placeholderFor('conversation.id', threadID),
    };
    this.byConversation.set(threadID, pending);
    return pending;
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
    // THE CONVERSATION ID IS NOT ONLY WHERE IT IS NAMED. 0.155.0's spans carry it as `thread.id`, as
    // `thread_id`, and inside a debug string (`Thread { thread_id: "…" }`), so a list of keys cannot be
    // complete. Every UUID-shaped run of characters in any string is replaced; one this observer already
    // knows as a conversation id gets that conversation's placeholder.
    if (typeof node === 'string') {
      return node.replace(UUID_SHAPE, (match) =>
        this.placeholderFor(this.byConversation.has(match) ? 'conversation.id' : 'identifier', match));
    }
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
    conversationCount: number; correlatedCount: number; indexFile: string;
    leakAuditClean: boolean; leaks: string[]; evidenceFile: string; endpoint: string;
    unreadablePayloadCount: number; failure?: string;
  }> {
    for (const [conversationID] of this.waiting) this.wake(conversationID);
    this.stopping = true;
    // A grace period before the socket closes, so the spans still in the exporter's queue are not
    // thrown away by shutting down the thing they are being sent to. Measured at 3.8-10.8s per turn
    // on a live campaign; this covers the last few attempts' worth.
    await new Promise<void>((resolve) => setTimeout(resolve, this.options.shutdownGraceMilliseconds ?? 15_000));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    // PROOF, NOT ASSERTION. The file is re-read and searched for the shape a surviving email address
    // would have. A redactor whose own output nobody checked is a claim.
    const file = path.resolve(this.options.evidenceFile);
    const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const leaks = [...written.matchAll(EMAIL_SHAPE)].map((match) => match[0]);
    // And for the join key itself, which the email check cannot see. A leak is NAMED by its placeholder,
    // never by its value, so the audit's own report does not repeat what it caught.
    for (const [conversationID, observation] of this.byConversation) {
      if (written.includes(conversationID)) leaks.push(`conversation id ${observation.correlationKey} written unredacted`);
    }
    const shaped = written.match(UUID_SHAPE)?.length ?? 0;
    if (shaped > 0) leaks.push(`${shaped} UUID-shaped identifier(s) written unredacted`);
    // THE JOIN TABLE, keyed by the placeholder and never by the identifier. This is what turns a
    // late-arriving span into a figure a report can attach to an attempt.
    const indexFile = `${file.replace(/\.jsonl$/, '')}.index.json`;
    const index: Record<string, OTLPTurnObservation> = {};
    for (const observation of this.byConversation.values()) index[observation.correlationKey] = observation;
    fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return {
      indexFile,
      payloadCount: this.payloadCount,
      redactionCount: this.redactionCount,
      distinctIdentifiers: this.placeholders.size,
      conversationCount: this.byConversation.size,
      correlatedCount: [...this.byConversation.values()].filter((entry) => entry.correlated).length,
      leakAuditClean: leaks.length === 0,
      leaks,
      evidenceFile: file,
      endpoint: this.endpoint,
      unreadablePayloadCount: this.unreadableCount,
      failure: this.failureReason,
    };
  }
}

const EMAIL_SHAPE = new RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}', 'g');

/** A conversation, thread, turn or submission id as 0.155.0 writes them. None of them is evidence of anything. */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
