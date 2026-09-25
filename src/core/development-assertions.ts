// Cernum core · the hidden assertion language for the development benchmark.
//
// WHY PREDICATES AND NOT PHRASE LISTS. Every evaluator this engine had before this pass judges a
// STRING: does the answer contain one of these forms, is it this exact word, does this JSON carry
// this key. That is the right instrument for "acknowledge that you weren't told what I had for
// breakfast" and the wrong one for "add the field to the schema, thread it through the pipeline and
// leave the generated file alone" — a question whose answer is a set of files, not a sentence.
//
// So a development assertion is a PREDICATE OVER TWO REPOSITORY SNAPSHOTS, the baseline and the
// result. It is pure, total, deterministic, and has no access to anything but those two maps: no
// clock, no filesystem, no network, no model. Two machines evaluating the same snapshots reach the
// same verdict or one of them is broken, which is the property a cross-provider comparison rests on.
//
// HIDDEN MEANS HIDDEN FROM THE CANDIDATE, NOT FROM THE READER. Every assertion is in this
// repository, in the open, sealed into the task digest and printable from the evidence. What the
// candidate never receives is the assertion text — it receives the task prompt, and the prompt is a
// separate field. `visibility` records which assertions the prompt is allowed to paraphrase
// (`stated`) and which are held out (`heldOut`), because an assertion the prompt already spells out
// measures transcription and an assertion it does not measures understanding. A task that has no
// held-out assertion is refused by the validator.
//
// SHORTCUT DETECTION IS AN ASSERTION LIKE ANY OTHER. `lacksPhrase` over the result, pointed at the
// literal expected value, is how "did it hard-code the answer rather than compute it" is asked. It
// is marked `shortcutProbe` so a failure of it is reported as a suspected shortcut rather than
// merely as a lost point, and never silently folded into a quality rate.

import { seal, compareCodePoints, JSONValue } from './digest';
import { RepoSnapshot, diffSnapshots } from './development-fixture';

/**
 * A predicate over the baseline and result snapshots.
 *
 * Every `path` is a fixture-relative POSIX path. Every predicate that reads a file reads the RESULT
 * snapshot, except `unchangedFromBaseline` / `changedFromBaseline`, which are about the pair.
 */
export type AssertionPredicate =
  | { kind: 'fileExists'; path: string }
  | { kind: 'fileAbsent'; path: string }
  | { kind: 'unchangedFromBaseline'; path: string }
  | { kind: 'changedFromBaseline'; path: string }
  /** No file outside this list may be added, removed or modified. The scope fence. */
  | { kind: 'onlyTheseTouched'; paths: string[] }
  /** Normalized, case-insensitive substring — the same `containsPhrase` the prose evaluators use. */
  | { kind: 'containsPhrase'; path: string; phrase: string }
  | { kind: 'lacksPhrase'; path: string; phrase: string }
  | { kind: 'matches'; path: string; pattern: string; flags?: string }
  | { kind: 'occursAtLeast'; path: string; pattern: string; flags?: string; minimum: number }
  | { kind: 'parsesAsJSON'; path: string }
  /** RFC-6901-lite pointer (`/a/b/0`). Deep-equal against `value` under canonical encoding. */
  | { kind: 'jsonEquals'; path: string; pointer: string; value: JSONValue }
  /** The pointer must resolve to an array containing a deep-equal member. */
  | { kind: 'jsonContains'; path: string; pointer: string; value: JSONValue }
  /** The pointer must resolve to an array that does NOT contain a deep-equal member. */
  | { kind: 'jsonExcludes'; path: string; pointer: string; value: JSONValue }
  | { kind: 'jsonHasPointer'; path: string; pointer: string }
  | { kind: 'jsonLacksPointer'; path: string; pointer: string };

export type AssertionVisibility =
  /** The prompt states, or may fairly be read as stating, what this asserts. */
  | 'stated'
  /** The prompt does not state it. Passing it is evidence of understanding, not of transcription. */
  | 'heldOut';

export interface DevelopmentAssertion {
  id: string;
  /** Plain language, for the evidence. Never sent to a candidate. */
  purpose: string;
  /** Which measured dimension of the scoring contract this assertion rolls up into. */
  metric: string;
  visibility: AssertionVisibility;
  predicate: AssertionPredicate;
  /**
   * True when this assertion exists to catch a solution that satisfies the letter of the task
   * without doing the work — a hard-coded expected value, a deleted test, a stubbed branch. Its
   * failure is reported as a suspected shortcut, separately from the quality rate.
   */
  shortcutProbe?: boolean;
}

export interface AssertionOutcome {
  id: string;
  metric: string;
  visibility: AssertionVisibility;
  shortcutProbe: boolean;
  held: boolean;
  /** Why it held or did not, in the assertion's own terms. Always populated. */
  detail: string;
}

/** `mlda1:` — the assertion set's identity, bound into the task digest. */
export function assertionsDigest(assertions: DevelopmentAssertion[]): string {
  return seal([...assertions].sort((a, b) => compareCodePoints(a.id, b.id)), 'mlda1:');
}

// MARK: - Evaluation

/**
 * Normalization for phrase predicates.
 *
 * Deliberately NOT `core/text.ts`'s `normalize`, which folds punctuation for prose comparison. Code
 * is punctuation: folding `charge.currency` into `charge currency` would make a phrase assertion
 * match text that does not contain the expression it names. Here the only folds are case and
 * horizontal whitespace runs, so `  charge . currency` and `charge . currency` agree and
 * `charge.currency` stays distinct from `charge_currency`.
 */
export function normalizeCode(text: string): string {
  return text.replace(/[ \t]+/g, ' ').toLowerCase();
}

export function codeContainsPhrase(haystack: string, needle: string): boolean {
  return normalizeCode(haystack).includes(normalizeCode(needle));
}

/** RFC-6901-lite. Returns `undefined` for an unresolvable pointer; `''` is the whole document. */
export function resolveJSONPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function deepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodePoints)) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * A regular expression from a sealed fixture, compiled defensively.
 *
 * The pattern comes from this repository, never from a candidate, so this is not an injection
 * boundary. It is still compiled inside a try so that a transcription error in a fixture surfaces as
 * a named assertion failure rather than as an exception thrown out of the scorer mid-campaign.
 */
function compile(pattern: string, flags: string | undefined): RegExp | undefined {
  try {
    return new RegExp(pattern, flags ?? '');
  } catch {
    return undefined;
  }
}

export interface AssertionContext {
  baseline: RepoSnapshot;
  result: RepoSnapshot;
}

export function evaluatePredicate(predicate: AssertionPredicate, context: AssertionContext): { held: boolean; detail: string } {
  const { baseline, result } = context;

  const readResult = (path: string): string | undefined => result.get(path);
  const missing = (path: string): { held: boolean; detail: string } =>
    ({ held: false, detail: `${path} is not present in the result repository, so this assertion could not hold` });

  switch (predicate.kind) {
    case 'fileExists':
      return result.has(predicate.path)
        ? { held: true, detail: `${predicate.path} is present` }
        : { held: false, detail: `${predicate.path} is absent` };

    case 'fileAbsent':
      return result.has(predicate.path)
        ? { held: false, detail: `${predicate.path} is present and this task requires it not to be` }
        : { held: true, detail: `${predicate.path} is absent, as required` };

    case 'unchangedFromBaseline': {
      const before = baseline.get(predicate.path);
      const after = result.get(predicate.path);
      if (before === undefined) return { held: false, detail: `${predicate.path} is not in the baseline; 'unchanged' is not a question that can be asked of it` };
      if (after === undefined) return { held: false, detail: `${predicate.path} was deleted; the baseline required it to survive untouched` };
      return before === after
        ? { held: true, detail: `${predicate.path} is byte-identical to the baseline` }
        : { held: false, detail: `${predicate.path} was modified; this task required it to be left alone` };
    }

    case 'changedFromBaseline': {
      const before = baseline.get(predicate.path);
      const after = result.get(predicate.path);
      if (after === undefined) return { held: false, detail: `${predicate.path} is absent from the result, so it was not changed — it was removed or never written` };
      if (before === undefined) return { held: true, detail: `${predicate.path} was added` };
      return before === after
        ? { held: false, detail: `${predicate.path} is byte-identical to the baseline; this task required a change to it` }
        : { held: true, detail: `${predicate.path} was modified` };
    }

    case 'onlyTheseTouched': {
      const permitted = new Set(predicate.paths);
      const difference = diffSnapshots(baseline, result);
      const strayed = [...difference.added, ...difference.removed, ...difference.modified]
        .filter((path) => !permitted.has(path))
        .sort(compareCodePoints);
      return strayed.length === 0
        ? { held: true, detail: `nothing outside the ${permitted.size} in-scope path(s) was added, removed or modified` }
        : { held: false, detail: `${strayed.length} path(s) outside the task's scope were touched: ${strayed.join(', ')}` };
    }

    case 'containsPhrase': {
      const text = readResult(predicate.path);
      if (text === undefined) return missing(predicate.path);
      return codeContainsPhrase(text, predicate.phrase)
        ? { held: true, detail: `${predicate.path} contains '${predicate.phrase}'` }
        : { held: false, detail: `${predicate.path} does not contain '${predicate.phrase}'` };
    }

    case 'lacksPhrase': {
      const text = readResult(predicate.path);
      if (text === undefined) return { held: true, detail: `${predicate.path} is absent, so it cannot contain '${predicate.phrase}'` };
      return codeContainsPhrase(text, predicate.phrase)
        ? { held: false, detail: `${predicate.path} contains '${predicate.phrase}', which this task forbids` }
        : { held: true, detail: `${predicate.path} does not contain '${predicate.phrase}'` };
    }

    case 'matches': {
      const text = readResult(predicate.path);
      if (text === undefined) return missing(predicate.path);
      const expression = compile(predicate.pattern, predicate.flags);
      if (!expression) return { held: false, detail: `the fixture's pattern /${predicate.pattern}/ does not compile; this is a fixture defect, not a candidate failure` };
      return expression.test(text)
        ? { held: true, detail: `${predicate.path} matches /${predicate.pattern}/` }
        : { held: false, detail: `${predicate.path} does not match /${predicate.pattern}/` };
    }

    case 'occursAtLeast': {
      const text = readResult(predicate.path);
      if (text === undefined) return missing(predicate.path);
      const flags = predicate.flags ?? '';
      const expression = compile(predicate.pattern, flags.includes('g') ? flags : `${flags}g`);
      if (!expression) return { held: false, detail: `the fixture's pattern /${predicate.pattern}/ does not compile; this is a fixture defect, not a candidate failure` };
      const count = [...text.matchAll(expression)].length;
      return count >= predicate.minimum
        ? { held: true, detail: `${predicate.path} matches /${predicate.pattern}/ ${count} time(s); ${predicate.minimum} required` }
        : { held: false, detail: `${predicate.path} matches /${predicate.pattern}/ only ${count} time(s); ${predicate.minimum} required` };
    }

    case 'parsesAsJSON': {
      const text = readResult(predicate.path);
      if (text === undefined) return missing(predicate.path);
      try {
        JSON.parse(text);
        return { held: true, detail: `${predicate.path} parses as JSON` };
      } catch (error) {
        return { held: false, detail: `${predicate.path} does not parse as JSON: ${(error as Error).message}` };
      }
    }

    case 'jsonEquals':
    case 'jsonContains':
    case 'jsonExcludes':
    case 'jsonHasPointer':
    case 'jsonLacksPointer': {
      const text = readResult(predicate.path);
      if (text === undefined) return missing(predicate.path);
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch (error) {
        return { held: false, detail: `${predicate.path} does not parse as JSON, so '${predicate.pointer}' cannot be read: ${(error as Error).message}` };
      }
      const resolved = resolveJSONPointer(document, predicate.pointer);
      if (predicate.kind === 'jsonHasPointer') {
        return resolved === undefined
          ? { held: false, detail: `${predicate.path} has no value at '${predicate.pointer}'` }
          : { held: true, detail: `${predicate.path} carries a value at '${predicate.pointer}'` };
      }
      if (predicate.kind === 'jsonLacksPointer') {
        return resolved === undefined
          ? { held: true, detail: `${predicate.path} has no value at '${predicate.pointer}', as required` }
          : { held: false, detail: `${predicate.path} carries a value at '${predicate.pointer}', which this task forbids` };
      }
      if (resolved === undefined) return { held: false, detail: `${predicate.path} has no value at '${predicate.pointer}'` };
      if (predicate.kind === 'jsonEquals') {
        return deepEquals(resolved, predicate.value)
          ? { held: true, detail: `${predicate.path} at '${predicate.pointer}' equals the required value` }
          : { held: false, detail: `${predicate.path} at '${predicate.pointer}' is ${JSON.stringify(resolved)}, not ${JSON.stringify(predicate.value)}` };
      }
      if (!Array.isArray(resolved)) {
        return { held: false, detail: `${predicate.path} at '${predicate.pointer}' is not an array, so membership is not a question that can be asked of it` };
      }
      const present = resolved.some((member) => deepEquals(member, predicate.value));
      if (predicate.kind === 'jsonExcludes') {
        return present
          ? { held: false, detail: `${predicate.path} at '${predicate.pointer}' contains ${JSON.stringify(predicate.value)}, which this task forbids` }
          : { held: true, detail: `${predicate.path} at '${predicate.pointer}' does not contain ${JSON.stringify(predicate.value)}, as required` };
      }
      return present
        ? { held: true, detail: `${predicate.path} at '${predicate.pointer}' contains ${JSON.stringify(predicate.value)}` }
        : { held: false, detail: `${predicate.path} at '${predicate.pointer}' does not contain ${JSON.stringify(predicate.value)}` };
    }
  }
}

export function evaluateAssertions(assertions: DevelopmentAssertion[], context: AssertionContext): AssertionOutcome[] {
  return [...assertions]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((assertion) => {
      const { held, detail } = evaluatePredicate(assertion.predicate, context);
      return {
        id: assertion.id,
        metric: assertion.metric,
        visibility: assertion.visibility,
        shortcutProbe: assertion.shortcutProbe === true,
        held,
        detail,
      };
    });
}
