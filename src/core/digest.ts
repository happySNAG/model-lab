// Cernum core · canonical serialization and digesting.
//
// Ported from the canonical Swift implementation (`ModelLabDigest`). One hashing story: FNV-1a-64
// over UTF-8 bytes, over a CANONICAL JSON form that must be byte-identical to what Swift's
// `JSONEncoder` with `.sortedKeys` produces:
//   • compact (no whitespace), keys sorted by Unicode scalar value,
//   • `/` escaped as `\/`, `"` and `\` escaped, `\b \f \n \r \t` short escapes, other C0 controls as
//     `\u00XX`, everything else (including DEL, U+2028, non-ASCII) emitted raw as UTF-8,
//   • dates as ISO-8601 whole seconds with a `Z` suffix, optionals absent when nil,
//   • no floating-point fields anywhere (every setting is an integer).
// Parity with the Swift encoder is proven by `fixtures/parity/digest.json` and by re-sealing every
// record of the Swift-written store under `fixtures/parity/store`.
//
// Scheme tags: mlc1 candidate · mlb1 case · mls1 suite · mlp1 plan · mlip1 input package ·
// mlo1 request · mlk1 comparability key · mle1 export · mlrc1 runtime configuration ·
// mla1 envelope · mlsp1 scoring policy · mlspc1 catalog · mlrp1 recommendation policy · mlhr1 rubric.

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** Deterministic FNV-1a-64 over UTF-8 bytes → hex string (no zero padding, exactly like Swift's `String(hash, radix: 16)`). */
export function fnv1a64Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16);
}

/** Compare two strings by Unicode scalar (code point) order — Swift's `String <` for the identifiers used here. */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0)!;
    const cb = nb.value.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

function escapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i];
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '/': out += '\\/'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default:
        if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
        else out += ch;
    }
  }
  return out + '"';
}

/**
 * The canonical form: sorted keys, compact, Swift-compatible escaping. `undefined` properties are
 * omitted (the Swift encoder omits nil optionals). Numbers must be integers.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) throw new Error('canonicalJSON: undefined is not encodable at the top level');
  if (typeof value === 'string') return escapeString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`canonicalJSON: non-integer number ${value} — every lab field is integer-scaled`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort(compareCodePoints);
    return '{' + keys.map((k) => escapeString(k) + ':' + canonicalJSON(record[k])).join(',') + '}';
  }
  throw new Error(`canonicalJSON: unsupported value ${String(value)}`);
}

/** Digest a value under a scheme tag: `<tag>` + fnv1a64Hex(canonical JSON). */
export function seal(value: unknown, tag: string): string {
  return tag + fnv1a64Hex(canonicalJSON(value));
}

/** Human-inspectable form for files a person opens: sorted keys, two-space indent. Decoders never depend on it. */
export function inspectableJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

export function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodePoints)) {
      const v = record[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

// MARK: - Instants (ISO-8601, whole seconds, `Z`)

/** The instant encoding every record uses — exactly what Swift's `.iso8601` strategy writes. */
export function isoSeconds(date: Date): string {
  const d = new Date(Math.floor(date.getTime() / 1000) * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseISO(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`not an ISO-8601 instant: ${text}`);
  return date;
}

/** A fixed, stepping synthetic clock for deterministic tests (the Campaign 2 convention: t0 + 1s per call). */
export const T0 = new Date(1_760_007_600 * 1000);
export function steppingClock(from: Date = T0): () => Date {
  let step = 0;
  return () => {
    step += 1;
    return new Date(from.getTime() + step * 1000);
  };
}
