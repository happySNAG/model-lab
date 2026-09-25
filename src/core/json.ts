// Cernum core · JSON parsing with Swift `JSONSerialization.jsonObject(with:)` semantics:
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

// MARK: - The one terminal object a development answer may be read from

/**
 * WHAT THIS READING IS FOR. `dev-cohort-2` measured Sonnet 5 putting one sentence of prose before an
 * otherwise correct JSON answer on 6 of 14 repository-understanding attempts, under a prompt that
 * forbade exactly that twice. Graded strictly, five correct answers scored as total failures, and the
 * dimension's ordering came from a sentence of narration rather than from reading the repository.
 * The strict reading is still recorded, on every row, as the compliance fact it is. This is the THIRD
 * reading, and it answers only "is there one unambiguous answer object at the end of this reply?".
 *
 * WHAT IT ACCEPTS — exactly one shape:
 *
 *   <optional prose>            anything, as long as it contains no JSON object and no code fence
 *   <line break>
 *   {…}  or  ```json\n{…}\n```   one JSON object, beginning a line, and the LAST thing in the reply
 *
 * WHAT IT REFUSES, each with a reason that is recorded rather than swallowed:
 *
 *   · text after the object            "{…}\n\nHope that helps" is prose containing JSON
 *   · a second JSON object in the prose  two candidates means the choice between them is a guess
 *   · a fence anywhere but around the terminal object, or more than one fenced block
 *   · a terminal object that is not valid JSON — nothing is repaired, quoted or re-balanced
 *   · an object that does not begin a line  "the answer is {…}" gives no boundary to read
 *
 * HOW THE OBJECT IS FOUND, AND WHY IT IS NOT A REGEX. Every `{` that begins a line is a candidate
 * start. From each, a scanner that understands JSON strings and escapes finds the matching `}`; a
 * candidate counts only when that brace is the final character of the reply AND `JSON.parse` accepts
 * the span as an object. Two valid objects cannot both end at the final character without one
 * containing the other, and a contained object cannot end at the same brace as its container, so at
 * most one candidate can succeed — the extraction is deterministic by construction, and the code
 * refuses rather than chooses if that ever fails to hold. Whether the object has the right SHAPE is
 * a separate question for the caller, which knows what shape the task asked for.
 */
export interface TerminalObjectExtraction {
  /** Present only when exactly one terminal object was found and it parsed. */
  object?: Record<string, unknown>;
  /** The object's own text when extracted; otherwise the trimmed input. */
  text: string;
  extracted: boolean;
  /** True when the terminal object was enclosed in the reply's only code fence. */
  fenced: boolean;
  /** Characters of prose before the object, after trimming. Zero when nothing was extracted. */
  prefixLength: number;
  /** Why nothing was extracted. Absent exactly when `extracted` is true. */
  refusedBecause?: string;
}

/**
 * The index of the `}` that closes the object opened at `start`, or -1 when it never closes.
 * Braces inside JSON strings are not structure; a backslash escapes the character after it.
 */
export function matchingObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every complete JSON object anywhere in `text`, outermost first, as start indexes. */
function objectsWithin(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{') continue;
    const end = matchingObjectEnd(text, index);
    if (end < 0) continue;
    if (parseJSONObject(text.slice(index, end + 1)) !== undefined) {
      found.push(index);
      index = end;
    }
  }
  return found;
}

function refuse(trimmed: string, refusedBecause: string): TerminalObjectExtraction {
  return { text: trimmed, extracted: false, fenced: false, prefixLength: 0, refusedBecause };
}

function beginsLine(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (text[cursor] === '\n') return true;
    if (text[cursor] !== ' ' && text[cursor] !== '\t' && text[cursor] !== '\r') return false;
  }
  return true;
}

/** The single terminal JSON object of a reply, or the reason there is not exactly one. */
export function extractTerminalJSONObject(input: string): TerminalObjectExtraction {
  const trimmed = input.trim();
  if (trimmed.length === 0) return refuse(trimmed, 'the reply is empty');

  const lines = trimmed.split('\n');
  const fenceLines = lines.map((line, index) => (FENCE_LINE.test(line) ? index : -1)).filter((index) => index >= 0);

  let prefix: string;
  let body: string;
  let fenced = false;
  if (fenceLines.length > 0) {
    // A fence is accepted only as the envelope of the terminal object: exactly two fence lines, the
    // second of them the reply's last line and carrying nothing but the marker.
    if (fenceLines.length !== 2) {
      return refuse(trimmed, `the reply contains ${fenceLines.length} fence line(s); only one fenced block, enclosing `
        + 'the terminal object, may be read');
    }
    const [open, close] = fenceLines;
    const closing = lines[close].trim();
    if (close !== lines.length - 1 || (closing !== '```' && closing !== '~~~')) {
      return refuse(trimmed, 'text follows the fenced block, so the reply does not end with its answer');
    }
    if (lines[open].trim().replace(/^(?:```|~~~)/, '').includes('`')) {
      return refuse(trimmed, 'the opening fence line is malformed');
    }
    prefix = lines.slice(0, open).join('\n').trim();
    body = lines.slice(open + 1, close).join('\n').trim();
    fenced = true;
    if (!body.startsWith('{') || matchingObjectEnd(body, 0) !== body.length - 1) {
      return refuse(trimmed, 'the fenced block is not exactly one JSON object');
    }
  } else {
    if (!trimmed.endsWith('}')) {
      return refuse(trimmed, 'the reply does not end with a JSON object; text after the answer is not read past');
    }
    const terminal: number[] = [];
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] === '{' && beginsLine(trimmed, index) && matchingObjectEnd(trimmed, index) === trimmed.length - 1) {
        terminal.push(index);
      }
    }
    if (terminal.length === 0) {
      return refuse(trimmed, 'no object beginning a line closes at the end of the reply, so there is no terminal object to read');
    }
    const parsing = terminal.filter((start) => parseJSONObject(trimmed.slice(start)) !== undefined);
    if (parsing.length === 0) return refuse(trimmed, 'the terminal object is not valid JSON');
    if (parsing.length > 1) return refuse(trimmed, 'more than one terminal object parses, so which is the answer is ambiguous');
    prefix = trimmed.slice(0, parsing[0]).trim();
    body = trimmed.slice(parsing[0]);
  }

  const object = parseJSONObject(body);
  if (object === undefined) return refuse(trimmed, 'the terminal object is not valid JSON');
  const competing = objectsWithin(prefix);
  if (competing.length > 0) {
    return refuse(trimmed, `the prose before the terminal object contains ${competing.length} other JSON object(s), `
      + 'so which object is the answer is ambiguous');
  }
  return { object, text: body, extracted: true, fenced, prefixLength: prefix.length };
}

// MARK: - The shape a development answer must have

/** The value types a development answer field may be declared as. */
export type AnswerFieldType = 'string' | 'boolean' | 'stringArray';
/** Every key the answer must carry, and nothing else, with the type of each. */
export type AnswerShape = Record<string, AnswerFieldType>;

/**
 * Where `object` departs from `shape`, one sentence per departure; empty when it conforms.
 * The key set is exact: the prompts say "Answer with exactly this shape", and a key the task never
 * asked for is a different answer, not a decorated one.
 */
export function answerShapeViolations(object: Record<string, unknown>, shape: AnswerShape): string[] {
  const violations: string[] = [];
  for (const key of Object.keys(shape).sort()) {
    if (!(key in object)) { violations.push(`missing key "${key}"`); continue; }
    const value = object[key];
    const expected = shape[key];
    const conforms = expected === 'string' ? typeof value === 'string'
      : expected === 'boolean' ? typeof value === 'boolean'
        : Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    if (!conforms) violations.push(`key "${key}" is not a ${expected === 'stringArray' ? 'list of strings' : expected}`);
  }
  for (const key of Object.keys(object).sort()) {
    if (!(key in shape)) violations.push(`unexpected key "${key}"`);
  }
  return violations;
}
