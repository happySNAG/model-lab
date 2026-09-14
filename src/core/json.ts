// Model Lab core · JSON parsing with Swift `JSONSerialization.jsonObject(with:)` semantics:
// a top-level container (object or array) is required; scalars at the top level are NOT JSON documents.

export function parseJSONContainer(text: string): Record<string, unknown> | unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown> | unknown[];
}

export function parseJSONObject(text: string): Record<string, unknown> | undefined {
  const value = parseJSONContainer(text);
  if (value === undefined || Array.isArray(value)) return undefined;
  return value;
}

// MARK: - The one fence a semantic reading may remove

/**
 * WHAT A MARKDOWN FENCE IS, AND WHY REMOVING IT IS A SECOND QUESTION AND NOT A LOOSER FIRST ONE.
 *
 * Cernum Pass 6 measured twelve configurations on `json-shape`. Every one produced correct JSON with
 * the required key. Six emitted it bare and scored 100%; four wrapped it in a ```json fence and
 * scored 75% or 50%. That single convention produced the entire apparent ordering of the pilot.
 *
 * Both readings are real and they answer different questions:
 *
 *   TRANSPORT COMPLIANCE   can this output be handed straight to `JSON.parse`, or to Swift's
 *                          `JSONSerialization`, with nothing in between? A fence makes the answer
 *                          NO, and that is a true and useful fact about an integration.
 *   SEMANTIC CORRECTNESS   did the model produce the right object with the right keys? A fence is
 *                          irrelevant to that, and scoring it as a failure measures punctuation.
 *
 * So this function does not make the strict parse more forgiving. It is the input to a SECOND,
 * SEPARATELY LABELLED result, and the strict failure is still recorded as a failure.
 *
 * EXACTLY ONE FENCE, AND NOTHING OUTSIDE IT. The fence must open the text and close it, with no
 * commentary before or after and no second fence inside. A model that writes a sentence, then a
 * fence, then another sentence has not produced a JSON document by any reading, and unwrapping
 * that would be the loosening this function exists to avoid.
 */
export interface FenceUnwrap {
  /** The text a semantic parse should read. Identical to the input when no fence was removed. */
  text: string;
  fenceRemoved: boolean;
  /** The fence's info string — `json` in the common case — when there was one. */
  infoString?: string;
  /**
   * Why a fence was NOT removed from text that looked fenced. Empty when the text was bare (there
   * was nothing to remove) or when one fence was removed cleanly.
   */
  refusedBecause?: string;
}

const FENCE_LINE = /^\s*(?:```|~~~)/;

export function unwrapSingleJSONFence(text: string): FenceUnwrap {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const fenceLineIndexes = lines.map((line, index) => (FENCE_LINE.test(line) ? index : -1)).filter((index) => index >= 0);
  if (fenceLineIndexes.length === 0) {
    // Not fenced at all. There is nothing to remove, and nothing to refuse.
    return { text: trimmed, fenceRemoved: false };
  }
  // A fence SOMEWHERE in the text is the case that has to be refused out loud rather than passed
  // through. "Here is the object you asked for:" followed by a fenced document is prose containing
  // JSON, not a JSON document — and a reader who saw only `fenceRemoved: false` could not tell that
  // from bare JSON, which is the one distinction this function exists to record.

  if (fenceLineIndexes.length !== 2) {
    return {
      text: trimmed,
      fenceRemoved: false,
      refusedBecause: fenceLineIndexes.length < 2
        ? 'the text opens a code fence and never closes it, so there is no single enclosed document to read'
        : `the text contains ${fenceLineIndexes.length} fence lines, and only a single enclosing fence may be removed — `
          + 'more than one means there is content between fences, which is commentary and not a JSON document',
    };
  }

  const [open, close] = fenceLineIndexes;
  if (open !== 0) {
    return { text: trimmed, fenceRemoved: false, refusedBecause: 'text appears before the opening fence' };
  }
  if (close !== lines.length - 1) {
    return { text: trimmed, fenceRemoved: false, refusedBecause: 'text appears after the closing fence' };
  }
  // The closing line carries the marker and nothing else. `\`\`\` trailing words` is not a fence close.
  const closing = lines[close].trim();
  if (closing !== '```' && closing !== '~~~') {
    return { text: trimmed, fenceRemoved: false, refusedBecause: `the closing fence line carries other content: ${closing}` };
  }
  const infoString = lines[open].trim().replace(/^(?:```|~~~)/, '').trim();
  if (infoString.includes('`')) {
    return { text: trimmed, fenceRemoved: false, refusedBecause: 'the opening fence line is malformed' };
  }
  return {
    text: lines.slice(open + 1, close).join('\n').trim(),
    fenceRemoved: true,
    infoString: infoString.length > 0 ? infoString : undefined,
  };
}

/**
 * The semantic reading of a JSON answer: at most one enclosing fence removed, then the SAME strict
 * parse. Nothing else is relaxed — a malformed document inside a fence is still malformed.
 */
export function parseJSONObjectAfterSingleFence(text: string): { object?: Record<string, unknown>; unwrap: FenceUnwrap } {
  const unwrap = unwrapSingleJSONFence(text);
  return { object: parseJSONObject(unwrap.text), unwrap };
}
