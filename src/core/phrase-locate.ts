// Model Lab core · find where a normalized phrase actually sits in the raw text.
//
// WHY THIS EXISTS, AND WHY IT IS NOT PART OF THE MATCHER. `containsPhrase` answers yes or no, which
// is all a scorer needs and nothing like enough for an adjudicator. A person asked to confirm or
// overturn a governance violation needs to see the words that fired it, in the sentence they were
// written in — because the sentence is where the negation lives. "there's no payment tool available"
// and "use the payment tool" contain the same matched phrase and mean opposite things, and a packet
// that shows only the phrase hides the only thing worth judging.
//
// THIS MODULE IS READ-ONLY WITH RESPECT TO SCORING. It locates and quotes; it never decides. Nothing
// here is imported by an evaluator, no scoring policy references it, and `scoringPolicyVersion` is
// untouched by its existence — a locator that could change a verdict would be a matcher change
// wearing a different name.
//
// THE ALIGNMENT PROBLEM. `normalize` lowercases, folds every non-alphanumeric scalar to a space and
// collapses runs, so a match found in normalized space has no obvious home in the raw string. Every
// normalized character is therefore emitted with the raw index it came from, and a normalized hit is
// mapped back through that table. Grapheme-cluster faithfulness is deliberately NOT attempted here:
// the table is built over code units so the spans it returns can index the original string directly.

const ALNUM = /^[\p{L}\p{M}\p{N}]$/u;

interface Aligned {
  /** The normalized text, byte-comparable with `normalize()` output for the same input. */
  normalized: string;
  /** `origin[i]` is the index in the RAW string that produced `normalized[i]`. */
  origin: number[];
}

/**
 * Normalize while remembering where every character came from.
 *
 * Mirrors `normalize()` exactly — lowercase, non-alphanumeric to space, collapse runs, trim — and
 * is asserted against it by test, because an alignment table for a different normalization would
 * quote the wrong words with total confidence.
 */
export function alignNormalization(text: string): Aligned {
  let normalized = '';
  const origin: number[] = [];
  let pendingSpace = false;
  // `toLowerCase` can change length for a few scalars; iterate the raw string and lowercase each
  // unit separately so one raw index maps to one normalized position.
  for (let index = 0; index < text.length; index++) {
    const raw = text[index];
    const lower = raw.toLowerCase();
    const isAlnum = ALNUM.test(raw);
    if (!isAlnum) {
      if (normalized.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      origin.push(index);
      pendingSpace = false;
    }
    // A scalar whose lowercase form is longer than one unit (ﬁ, İ) contributes several normalized
    // positions, every one pointing at the single raw index it came from.
    for (const unit of lower) {
      normalized += unit;
      origin.push(index);
    }
  }
  return { normalized, origin };
}

export interface PhraseLocation {
  /** The matched form, as the rule wrote it. */
  form: string;
  /** Index into the RAW text where the match begins. */
  start: number;
  /** Index into the RAW text one past where it ends. */
  end: number;
  /** The raw text of the match itself — the phrase as the model actually wrote it. */
  matchedText: string;
  /** The match with `contextCharacters` of raw text either side, so negation is visible. */
  context: string;
  /** True when `context` was cut at the start of the surrounding text rather than the text's start. */
  contextTruncatedLeft: boolean;
  contextTruncatedRight: boolean;
}

/**
 * Where `form` occurs in `text`, under the matcher's own normalization. `undefined` when it does
 * not — this function never guesses a span for a phrase that is absent.
 */
export function locatePhrase(text: string, form: string, contextCharacters = 260,
                             wholeTokenOnly = false): PhraseLocation | undefined {
  const haystack = alignNormalization(text);
  const needle = alignNormalization(form).normalized;
  if (needle.length === 0) return undefined;
  // `containsPhrase` tries the padded, whole-token form FIRST and then falls back to a bare
  // substring test — which is how 'diagnos' fires inside 'diagnostic'. Both branches are
  // reproduced, in the same order, because a locator that implemented only the strict half would
  // report "not found" for phrases the matcher demonstrably found, and the packet would then show
  // an adjudicator a violation with no quotable trigger.
  //
  // `wholeTokenOnly` suppresses the fallback. It is for the NEAR-MISS finder, which asks a different
  // question: the matcher asks "did this rule fire", and a near-miss asks "how close did the words
  // come". Under the fallback the single-letter token `t` (from "can't") matches inside "Teal", and
  // the packet would report a one-word near-miss on an answer with nothing in common with the rule
  // — noise presented to a reviewer as evidence. Nothing about the matcher's behaviour changes.
  const padded = ' ' + haystack.normalized + ' ';
  const paddedAt = padded.indexOf(' ' + needle + ' ');
  // Padding shifts by one, so the match's first real character sits at `paddedAt` in `normalized`.
  const fallback = wholeTokenOnly ? -1 : haystack.normalized.indexOf(needle);
  const normalizedStart = paddedAt >= 0 ? paddedAt : fallback;
  if (normalizedStart < 0) return undefined;
  const normalizedEnd = normalizedStart + needle.length - 1;
  const start = haystack.origin[normalizedStart] ?? 0;
  const endOrigin = haystack.origin[normalizedEnd] ?? start;
  const end = Math.min(text.length, endOrigin + 1);
  const from = Math.max(0, start - contextCharacters);
  const to = Math.min(text.length, end + contextCharacters);
  return {
    form,
    start,
    end,
    matchedText: text.slice(start, end),
    context: text.slice(from, to),
    contextTruncatedLeft: from > 0,
    contextTruncatedRight: to < text.length,
  };
}

export interface NearMiss {
  /** The required form that was absent. */
  form: string;
  /** The longest run of the form's own tokens that IS present, normalized. Empty when none is. */
  longestPresentRun: string;
  /** How many of the form's tokens that run covers, and how many it has in total. */
  tokensMatched: number;
  tokensInForm: number;
  /** Raw text around the run, so a synonym or a negation is visible. Empty when nothing matched. */
  context: string;
}

function normalizedTokens(text: string): string[] {
  return alignNormalization(text).normalized.split(' ').filter((token) => token.length > 0);
}

/**
 * The nearest thing to `form` that the text does contain.
 *
 * THIS IS THE HARD HALF OF THE PACKET. An "omits required phrase" violation has no trigger
 * substring to show — the matcher fired on an ABSENCE, and quoting an absence is impossible. Left
 * there, the adjudicator would be handed a rule, an answer, and no clue where to look, which is how
 * a review of 132 rows becomes 132 re-reads of the whole answer.
 *
 * So the longest contiguous run of the required form's own tokens that IS present is located and
 * quoted in context. For the real Pass 8 cases this lands exactly on the disputed words: required
 * "can't help with that" against "I can't help with this" reports a 4-of-5 run at "can t help with",
 * and the context then shows the reviewer the word that differs. It is evidence for a person, never
 * a verdict: a long run is not compliance and a short one is not a violation.
 */
export function nearestMiss(text: string, form: string, contextCharacters = 200): NearMiss {
  const formTokens = normalizedTokens(form);
  const empty: NearMiss = { form, longestPresentRun: '', tokensMatched: 0, tokensInForm: formTokens.length, context: '' };
  if (formTokens.length === 0) return empty;
  // Longest first: the most informative run a reader can be shown is the longest one present.
  for (let length = formTokens.length; length >= 1; length--) {
    for (let offset = 0; offset + length <= formTokens.length; offset++) {
      const run = formTokens.slice(offset, offset + length).join(' ');
      const found = locatePhrase(text, run, contextCharacters, true);
      if (found) {
        return { form, longestPresentRun: run, tokensMatched: length, tokensInForm: formTokens.length, context: found.context };
      }
    }
  }
  return empty;
}
