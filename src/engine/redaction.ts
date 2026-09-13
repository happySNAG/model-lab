// Benchmark engine · the one place a secret is removed from something about to be written down.
//
// THE PROBLEM THIS SOLVES IS NOT "DO NOT LOG THE KEY". Nobody writes `log(apiKey)`. Secrets reach
// artefacts the indirect way: a provider returns a 401 whose body echoes the Authorization header, a
// CLI prints its own invocation on failure, a stack trace carries a request object, a URL has a
// token in its query string. Every one of those arrives as an ordinary error message and gets
// recorded because recording error messages is the right thing to do.
//
// So the rule here is not "remember to redact". It is: EVERY string that crosses into a ledger row,
// an event, a manifest, a report, a terminal line or a test fixture goes through `redact` first, and
// `redact` does not need to be told what the secret is. It recognises credential SHAPES.
//
// WHY SHAPES RATHER THAN A REGISTRY OF KNOWN VALUES. A registry only catches the keys this process
// happens to have loaded. It misses a key the user pasted into a different field, a key belonging to
// a second account, and a key echoed by a provider that this process never held. Shapes catch those.
// The registry is kept too, as a second pass, because a shape matcher cannot recognise a credential
// that looks like an ordinary word.
//
// REDACTION IS NOT REVERSIBLE AND DOES NOT PRESERVE THE VALUE. The replacement records the KIND and
// the LENGTH, never a prefix and never a suffix. A "helpfully" preserved first four characters is
// four characters of a secret written into an artefact that outlives the run.

/** What a redacted span is replaced with. Carries the kind and length; never any of the value. */
function marker(kind: string, length: number): string {
  return `[redacted:${kind}:${length}chars]`;
}

/**
 * Credential shapes, most specific first.
 *
 * Each pattern is anchored on a prefix a provider actually issues, so an ordinary sentence cannot
 * match one by accident. The generic high-entropy rule deliberately is NOT here: it fires on
 * digests, manifest ids and slot keys, all of which are supposed to be readable.
 */
const SHAPES: { kind: string; pattern: RegExp }[] = [
  { kind: 'anthropicKey', pattern: /sk-ant-[A-Za-z0-9_\-]{16,}/g },
  { kind: 'openaiProjectKey', pattern: /sk-proj-[A-Za-z0-9_\-]{16,}/g },
  { kind: 'openaiKey', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { kind: 'bearerToken', pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-~+/]{16,}=*/g },
  { kind: 'githubToken', pattern: /gh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: 'googleKey', pattern: /AIza[A-Za-z0-9_\-]{20,}/g },
  { kind: 'awsAccessKeyID', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g },
  { kind: 'privateKeyBlock', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * Header and field names whose VALUE is a credential whatever it looks like.
 *
 * This catches the case shapes cannot: a provider that issues plain-looking keys, and a user whose
 * key is a word. Matched on the assignment form these appear in inside error text and JSON.
 */
const NAMED_SECRETS = [
  'authorization', 'x-api-key', 'api-key', 'apikey', 'api_key',
  'anthropic_api_key', 'openai_api_key', 'access_token', 'refresh_token',
  'secret', 'password', 'session_key', 'sessionkey', 'bearer',
];

const NAMED_PATTERN = new RegExp(
  // name, then a separator a real serialisation uses, then the value up to the next delimiter.
  `\\b(${NAMED_SECRETS.join('|')})\\b(\\s*[:=]\\s*)(")?([^"'\\s,;}\\]&]{8,})(")?`,
  'gi',
);

/** A token carried in a URL query string, which is how a key ends up in a logged request line. */
const QUERY_SECRET = /([?&](?:api[_-]?key|access_token|token|key)=)([^&\s"']{8,})/gi;

/** Values this process knows are secrets, registered by whatever loaded them. Never persisted. */
const registry = new Set<string>();

/**
 * Tell the redactor about a value it must never let through.
 *
 * Called by the credential resolver the moment a key is read, so a key that reaches this process at
 * all is redacted from that moment on, including out of error text this process never authored.
 * Short values are refused rather than registered: registering a three-character secret would redact
 * every occurrence of those three characters in every message.
 */
export function registerSecret(value: string | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  registry.add(trimmed);
}

/** Forget every registered value. For tests, and for a process that has dropped its credentials. */
export function forgetRegisteredSecrets(): void {
  registry.clear();
}

/** How many values are registered. Exposed so a test can assert the registry without reading it. */
export function registeredSecretCount(): number {
  return registry.size;
}

/**
 * Remove every credential-shaped span from a string.
 *
 * Idempotent: redacting an already-redacted string changes nothing, because a marker contains no
 * credential shape. That matters because these strings pass through several layers on their way to
 * disk and each one redacts defensively rather than trusting the last.
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text;
  let out = text;

  // Registered values first: an exact known secret must not be left half-matched by a shape rule.
  for (const secret of registry) {
    if (out.includes(secret)) out = out.split(secret).join(marker('registered', secret.length));
  }

  for (const { kind, pattern } of SHAPES) {
    out = out.replace(pattern, (match) => marker(kind, match.length));
  }

  out = out.replace(QUERY_SECRET, (_match, prefix: string, value: string) => `${prefix}${marker('urlToken', value.length)}`);

  out = out.replace(NAMED_PATTERN, (match, name: string, separator: string, openQuote: string | undefined,
                                    value: string, closeQuote: string | undefined) => {
    // A value that is already a marker is left alone, so redaction stays idempotent.
    if (value.startsWith('[redacted:')) return match;
    return `${name}${separator}${openQuote ?? ''}${marker('namedSecret', value.length)}${closeQuote ?? ''}`;
  });

  return out;
}

/** Redact recursively through any JSON-shaped value, leaving its structure untouched. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(entry);
    return out as unknown as T;
  }
  return value;
}

/** An error's message, redacted. Stacks are dropped: a stack can carry a request object verbatim. */
export function redactError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Strip credential-bearing variables out of a child process's environment.
 *
 * A subscription CLI is authenticated by its OWN session. It has no business inheriting this
 * process's API keys, and a CLI that was handed one might use it — turning a run the person
 * authorised as subscription-included into a metered charge they never approved.
 */
export function environmentWithoutCredentials(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const lowered = name.toLowerCase();
    const bearsCredential = NAMED_SECRETS.some((secret) => lowered.includes(secret.replace(/[-_]/g, '')))
      || /(^|_)(api[_-]?key|token|secret|password)(_|$)/i.test(name);
    if (bearsCredential) continue;
    out[name] = value;
  }
  return out;
}

/**
 * What a person is shown in place of a credential they have configured.
 *
 * Never a prefix, never a suffix, never a fragment. The two facts worth showing are that something
 * is there and how long it is, and neither of those narrows a search for the value.
 */
export function maskCredential(value: string | undefined): string {
  if (!value || value.length === 0) return 'not set';
  return `set · ${value.length} characters · never shown, never written to disk`;
}

/**
 * Scan a finished artefact for anything that still looks like a credential.
 *
 * Used by the secret-scan test and by the report: redaction that is only asserted at the point of
 * writing is redaction nobody checked at the point of reading.
 */
export function scanForSecrets(text: string): { kind: string; count: number }[] {
  const found: { kind: string; count: number }[] = [];
  for (const { kind, pattern } of SHAPES) {
    const matches = text.match(new RegExp(pattern.source, 'g'));
    if (matches && matches.length > 0) found.push({ kind, count: matches.length });
  }
  for (const secret of registry) {
    const count = text.split(secret).length - 1;
    if (count > 0) found.push({ kind: 'registeredValue', count });
  }
  return found;
}

/** Exposed for the scanner's own test: the shapes it recognises, by name. */
export const SECRET_SHAPE_KINDS = SHAPES.map((shape) => shape.kind);
