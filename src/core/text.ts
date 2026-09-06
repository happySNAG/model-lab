// Model Lab core · deterministic text normalization (port of `ModelLabTextNormalization`).
//
// Evaluators compare model output against sealed criteria using ONLY these pure helpers — never a
// second language model, never a network service, never a fuzzy semantic score. Lowercase, fold
// every non-alphanumeric scalar to a space, collapse runs, trim. Two people reading a fixture can
// predict exactly what will match.
//
// Swift semantics that need care in JavaScript:
//   • `CharacterSet.alphanumerics` = Unicode categories L*, M*, N*.
//   • `String.count` / `prefix` / index distances count grapheme clusters (Swift `Character`s).
//   • Swift string equality and containment are canonical-equivalence aware, so comparisons here
//     NFC-normalize both sides while `normalize()` itself returns the un-normalized scalars (byte
//     parity with the Swift output is proven by `fixtures/parity/normalization.json`).

const ALNUM = /^[\p{L}\p{M}\p{N}]$/u;
// Swift `.whitespacesAndNewlines`: Zs + TAB + U+000A–U+000D + U+0085 + U+2028 + U+2029.
const LEADING_WS = /^[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]+/u;
const TRAILING_WS = /[\p{Zs}\t\n\v\f\r\u0085\u2028\u2029]+$/u;

let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimWhitespaceAndNewlines(text: string): string {
  return text.replace(LEADING_WS, '').replace(TRAILING_WS, '');
}

/** Canonical comparison form: lowercased, punctuation → spaces, whitespace runs collapsed, trimmed. */
/** Swift `split(separator: " ")` over Characters: only a grapheme cluster that IS a bare space separates. */
function splitOnSpaceGraphemes(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const g of graphemes(text)) {
    if (g === ' ') {
      if (current.length > 0) parts.push(current);
      current = '';
    } else {
      current += g;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function normalize(text: string): string {
  let spaced = '';
  for (const scalar of text.toLowerCase()) spaced += ALNUM.test(scalar) ? scalar : ' ';
  return splitOnSpaceGraphemes(spaced).join(' ');
}

export function tokens(text: string): string[] {
  return splitOnSpaceGraphemes(normalize(text));
}

function nfc(text: string): string {
  return text.normalize('NFC');
}

/** Swift `==` on strings (canonical equivalence). */
export function canonicalEquals(a: string, b: string): boolean {
  return nfc(a) === nfc(b);
}

/** Does the normalized haystack contain the normalized needle? */
export function containsPhrase(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalize(needle);
  if (normalizedNeedle.length === 0) return false;
  const paddedHaystack = ' ' + normalize(haystack) + ' ';
  const paddedNeedle = ' ' + normalizedNeedle + ' ';
  if (nfc(paddedHaystack).includes(nfc(paddedNeedle))) return true;
  return nfc(normalize(haystack)).includes(nfc(normalizedNeedle));
}

/** Grapheme index at which the normalized needle first appears in the normalized haystack, or null. */
export function firstIndex(needle: string, haystack: string): number | null {
  const normalizedHaystack = nfc(normalize(haystack));
  const normalizedNeedle = nfc(normalize(needle));
  if (normalizedNeedle.length === 0) return null;
  const at = normalizedHaystack.indexOf(normalizedNeedle);
  if (at < 0) return null;
  return graphemeCount(normalizedHaystack.slice(0, at));
}

/** A short, normalized excerpt (grapheme-bounded) for evidence records. */
export function excerpt(text: string, limit = 240): string {
  const normalized = normalize(text);
  const parts = graphemes(normalized);
  if (parts.length <= limit) return normalized;
  return parts.slice(0, limit).join('') + '…';
}
