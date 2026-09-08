// Benchmark engine · the byte-exact encoding the frozen manifests, the ledger and the blinded
// packets are hashed under.
//
// WHY THIS IS NOT `core/digest.ts`. The portable core seals records with FNV-1a-64 over a
// Swift-compatible canonical form, and that form escapes `/` as `\/`. The proven Python harness
// hashes with SHA-256 over `json.dumps(obj, sort_keys=True, separators=(",", ":"),
// ensure_ascii=False)`, which does not escape `/`. Two canonical forms that differ by one byte
// produce two different digests, and a manifest whose digest disagrees with the harness that
// produced the evidence is not a manifest — it is a second opinion.
//
// So this module deliberately reproduces the Python encoding exactly, and `test/engine/canonical
// -parity.test.ts` pins it against recorded `json.dumps` output. Core's `seal()` is untouched and
// still governs core's own records; nothing here changes an existing digest.

import { createHash, createHmac } from 'node:crypto';

/** A value this encoder accepts. Floats are refused: every engine field is integer-scaled. */
export type CanonicalValue = string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue | undefined };

export class CanonicalEncodingFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalEncodingFailure';
  }
}

/** Code-point order, which is what Python's `sorted()` gives for `str` keys. */
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

/**
 * Python's `json.dumps` string form under `ensure_ascii=False`: the six short escapes, `\uXXXX`
 * for the remaining C0 controls, and every other character emitted literally. Notably `/` is NOT
 * escaped — that single byte is the whole reason this function exists.
 */
function encodeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"': out += '\\"'; continue;
      case '\\': out += '\\\\'; continue;
      case '\b': out += '\\b'; continue;
      case '\f': out += '\\f'; continue;
      case '\n': out += '\\n'; continue;
      case '\r': out += '\\r'; continue;
      case '\t': out += '\\t'; continue;
      default: break;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code >= 0xd800 && code <= 0xdfff) {
      // A lone surrogate has no agreed encoding across the two runtimes. Refusing it is the only
      // answer that cannot silently produce two different digests for the same value.
      throw new CanonicalEncodingFailure('a lone surrogate cannot be canonically encoded; the two runtimes disagree on its bytes');
    } else out += ch;
  }
  return out + '"';
}

/** `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, byte for byte. */
export function canonicalJSON(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CanonicalEncodingFailure(`non-integer number ${value}: every engine field is integer-scaled so the two runtimes cannot disagree on a float's shortest repr`);
    }
    if (!Number.isSafeInteger(value)) throw new CanonicalEncodingFailure(`${value} is outside the exactly-representable integer range`);
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, CanonicalValue | undefined>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort(compareCodePoints);
    return '{' + keys.map((k) => encodeString(k) + ':' + canonicalJSON(record[k]!)).join(',') + '}';
  }
  throw new CanonicalEncodingFailure(`unsupported value of type ${typeof value}`);
}

/** SHA-256 of a UTF-8 string, lowercase hex. The harness's `_sha_text`. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 of raw bytes, lowercase hex. The harness's `_sha_file`. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 over the canonical encoding. The harness's `_digest_obj`. */
export function digestObject(value: CanonicalValue): string {
  return sha256Text(canonicalJSON(value));
}

/** HMAC-SHA-256, lowercase hex — the blinding primitive. */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex');
}

/** A short, stable digest for display. Never used as an identity. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
