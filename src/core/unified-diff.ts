// Cernum core · unified diffs, written and applied, for the development benchmark's edit evidence.
//
// A DIFF HERE IS EVIDENCE, NOT A CONVENIENCE, SO IT IS ALWAYS CHECKED BY APPLYING IT. The edit
// evidence keeps the final text of every file an attempt changed AND a unified diff against the
// sealed baseline. The final text is authoritative; the diff is what a person reads. Keeping both is
// only safe if they cannot disagree, so `applyUnifiedDiff` exists to prove, on write and again on
// every re-read, that the diff applied to the baseline yields exactly the retained text. It is
// strict on purpose: a context line that does not match, a hunk count that is wrong, or a hunk out
// of order is a refusal, never a fuzzy best effort.
//
// MINIMAL WHEN IT IS CHEAP, CORRECT ALWAYS. Lines are compared with Myers' O(ND) algorithm after the
// common prefix and suffix are trimmed. An attempt that rewrote a large file wholesale could make
// that expensive, so beyond `MAX_MYERS_EDITS` the diff falls back to replacing every line between
// the common prefix and suffix. That diff is longer than it needs to be and is exactly as correct —
// which is the only property the evidence depends on.
//
// THE FORMAT IS THE ONE `git diff` AND `patch` READ: `--- a/<path>`, `+++ b/<path>` (or `/dev/null`
// for an added or removed file), `@@ -l,s +l,s @@` hunks with three lines of context, and
// `\ No newline at end of file` after a final line that has none.

export const UNIFIED_DIFF_CONTEXT_LINES = 3;

/** Beyond this many line edits the diff stops looking for the minimal script. See the header. */
export const MAX_MYERS_EDITS = 4_000;

const NO_NEWLINE = '\\ No newline at end of file';

/**
 * A text as LINE TOKENS, each carrying its own terminator. The last token lacks `\n` exactly when
 * the text does not end with one, so "the same line, with and without a final newline" are two
 * different tokens and the diff sees the difference with no special case.
 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') { out.push(text.slice(start, index + 1)); start = index + 1; }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

type Op = { kind: ' ' | '-' | '+'; token: string; /** 0-based index into the old or new side. */ oldIndex: number; newIndex: number };

/** The shortest edit script between two line arrays, or undefined when it would exceed `limit` edits. */
function myers(a: string[], b: string[], limit: number): ('=' | '-' | '+')[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], depth: number, offset: number): ('=' | '-' | '+')[] {
  const script: ('=' | '-' | '+')[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { script.push('='); x -= 1; y -= 1; }
    script.push(x === previousX ? '+' : '-');
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) { script.push('='); x -= 1; y -= 1; }
  return script.reverse();
}

function editScript(a: string[], b: string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
         && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const middle = myers(middleA, middleB, MAX_MYERS_EDITS)
    ?? [...middleA.map(() => '-' as const), ...middleB.map(() => '+' as const)];

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  const push = (kind: Op['kind']) => {
    ops.push({ kind, token: kind === '+' ? b[j] : a[i], oldIndex: i, newIndex: j });
    if (kind !== '+') i += 1;
    if (kind !== '-') j += 1;
  };
  for (let index = 0; index < prefix; index += 1) push(' ');
  for (const step of middle) push(step === '=' ? ' ' : step);
  for (let index = 0; index < suffix; index += 1) push(' ');
  return ops;
}

/** `start,count` as `diff -u` writes it: a zero-length range names the line BEFORE the hunk. */
function range(start: number, count: number): string {
  return `${count === 0 ? start : start + 1},${count}`;
}

/**
 * A unified diff from `before` to `after` for one path. `undefined` on a side means the file does
 * not exist there. Returns the empty string when the two are identical.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined,
                            context: number = UNIFIED_DIFF_CONTEXT_LINES): string {
  if (before === after) return '';
  const ops = editScript(tokens(before ?? ''), tokens(after ?? ''));
  const out: string[] = [
    before === undefined ? '--- /dev/null' : `--- a/${path}`,
    after === undefined ? '+++ /dev/null' : `+++ b/${path}`,
  ];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === ' ') { index += 1; continue; }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend the hunk while the next change is within 2 x context lines of this one.
    for (;;) {
      while (end < ops.length && ops[end].kind !== ' ') end += 1;
      let next = end;
      while (next < ops.length && ops[next].kind === ' ') next += 1;
      if (next < ops.length && next - end <= 2 * context) { end = next; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== '+').length;
    const newCount = hunk.filter((op) => op.kind !== '-').length;
    out.push(`@@ -${range(hunk[0].oldIndex, oldCount)} +${range(hunk[0].newIndex, newCount)} @@`);
    for (const op of hunk) {
      const terminated = op.token.endsWith('\n');
      out.push(`${op.kind}${terminated ? op.token.slice(0, -1) : op.token}`);
      if (!terminated) out.push(NO_NEWLINE);
    }
    index = end;
  }
  return out.join('\n') + '\n';
}

export class UnifiedDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedDiffError';
  }
}

/**
 * Apply a diff produced by `unifiedDiff` to `before`, strictly. Returns the resulting text, or
 * `undefined` when the diff removes the file. Throws on any line that does not match exactly.
 */
export function applyUnifiedDiff(before: string | undefined, diff: string): string | undefined {
  if (diff.length === 0) return before;
  const lines = diff.split('\n');
  if (lines[lines.length - 1] !== '') throw new UnifiedDiffError('the diff does not end with a newline');
  lines.pop();
  if (lines.length < 2 || !lines[0].startsWith('--- ') || !lines[1].startsWith('+++ ')) {
    throw new UnifiedDiffError('the diff has no ---/+++ header');
  }
  const fromNothing = lines[0] === '--- /dev/null';
  const toNothing = lines[1] === '+++ /dev/null';
  if (fromNothing !== (before === undefined)) {
    throw new UnifiedDiffError(fromNothing ? 'the diff adds a file that already exists' : 'the diff edits a file that does not exist');
  }
  const old = tokens(before ?? '');
  const result: string[] = [];
  let cursor = 0;
  let index = 2;
  while (index < lines.length) {
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[index]);
    if (!match) throw new UnifiedDiffError(`expected a hunk header at diff line ${index + 1}: ${lines[index]}`);
    const oldCount = Number(match[2]);
    const newCount = Number(match[4]);
    const oldStart = oldCount === 0 ? Number(match[1]) : Number(match[1]) - 1;
    if (oldStart < cursor || oldStart > old.length) {
      throw new UnifiedDiffError(`the hunk at diff line ${index + 1} is out of order or beyond the end of the file`);
    }
    while (cursor < oldStart) { result.push(old[cursor]); cursor += 1; }
    index += 1;
    let seenOld = 0;
    let seenNew = 0;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      const kind = line[0];
      if (kind !== ' ' && kind !== '-' && kind !== '+') {
        throw new UnifiedDiffError(`diff line ${index + 1} is not a context, removal or addition line`);
      }
      const unterminated = lines[index + 1] === NO_NEWLINE;
      const token = unterminated ? line.slice(1) : `${line.slice(1)}\n`;
      if (kind !== '+') {
        if (old[cursor] !== token) {
          throw new UnifiedDiffError(`diff line ${index + 1} expects ${JSON.stringify(token)} at old line ${cursor + 1}, `
            + `which is ${JSON.stringify(old[cursor])}`);
        }
        cursor += 1;
        seenOld += 1;
      }
      if (kind !== '-') { result.push(token); seenNew += 1; }
      index += unterminated ? 2 : 1;
    }
    if (seenOld !== oldCount || seenNew !== newCount) {
      throw new UnifiedDiffError(`a hunk declares -${oldCount} +${newCount} and holds -${seenOld} +${seenNew}`);
    }
  }
  while (cursor < old.length) { result.push(old[cursor]); cursor += 1; }
  if (toNothing) {
    if (result.length !== 0) throw new UnifiedDiffError('the diff removes the file but leaves lines behind');
    return undefined;
  }
  return result.join('');
}
