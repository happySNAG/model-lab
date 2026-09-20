// Benchmark engine · which paths a workspace task was allowed to touch, and which it actually did.
//
// WHY THIS IS ITS OWN MODULE. "Did the model stay inside the task?" is a question with a right
// answer, and it has to be decided by a pure function of two lists — the declared scope and the
// observed change set — so that the same verdict comes out of the runner, out of a re-scoring of
// stored evidence, and out of a test. A scope check that lived inside the runner would be a scope
// check that could only ever be proven by running something.
//
// THE MATCHER IS DELIBERATELY SMALL. Three forms, and nothing else:
//
//   `src/calc.ts`     an exact path
//   `src/*.ts`        one segment, any characters within it
//   `src/**`          this directory and everything beneath it, at any depth
//
// No brace expansion, no character classes, no negation. A scope pattern is part of a case's frozen
// identity: a reader has to be able to look at one and know what it admits without running it, and
// every construct added here is a construct a case author can be surprised by.
//
// EVERY PATH IS WORKSPACE-RELATIVE, `/`-separated, and never begins with `./` or `/`. Normalization
// happens once, here, so a case authored on Windows and a change set observed on macOS compare as
// the same strings.

import { CanonicalValue } from './canonical';

export class WorkspaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

/**
 * The scope a task declares.
 *
 * `allowed` EMPTY MEANS EVERY PATH IS ALLOWED — an unconstrained task, which is a legitimate thing
 * to measure. It does not mean "nothing is allowed": a case that forbade every path could never be
 * completed, and reading an empty list that way would make an unconstrained case score
 * `scopeFailure` the moment the model did any work at all.
 *
 * `forbidden` ALWAYS WINS. A path matched by both is forbidden, because the two lists are not
 * symmetric: `allowed` describes where the work belongs and `forbidden` describes what must not be
 * edited to make the work look finished. The test file a task is judged by is the canonical example.
 */
export interface ScopePolicy extends Record<string, CanonicalValue | undefined> {
  allowed: string[];
  forbidden: string[];
}

export function scopePolicy(fields: Partial<ScopePolicy> = {}): ScopePolicy {
  return {
    allowed: normalizePatterns(fields.allowed ?? []),
    forbidden: normalizePatterns(fields.forbidden ?? []),
  };
}

/** Sorted and de-duplicated, so two policies that admit the same paths are the same bytes. */
function normalizePatterns(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const normalized = normalizeRelativePath(pattern);
    if (normalized.length === 0) throw new WorkspaceScopeError('an empty scope pattern matches nothing and says nothing; refusing it');
    out.add(normalized);
  }
  return [...out].sort(compareCodePointsAscending);
}

function compareCodePointsAscending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The one spelling of a workspace-relative path.
 *
 * Backslashes become `/`, `./` segments are dropped, repeated separators collapse, and a trailing
 * slash is removed. An absolute path and a `..` segment are REFUSED rather than normalized away:
 * both are ways of naming something outside the workspace, and quietly rewriting them into
 * something inside it would turn an escape attempt into an ordinary-looking edit.
 */
export function normalizeRelativePath(candidate: string): string {
  const unified = candidate.replace(/\\/g, '/').trim();
  if (unified.startsWith('/')) {
    throw new WorkspaceScopeError(`refusing the absolute path '${candidate}': a workspace path is relative to the workspace root`);
  }
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new WorkspaceScopeError(`refusing '${candidate}': a '..' segment names something outside the workspace`);
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Does one pattern admit one path? Pure, and the only place the three forms are interpreted. */
export function patternMatches(pattern: string, relativePath: string): boolean {
  if (pattern === '**') return true;
  const patternSegments = pattern.split('/');
  const pathSegments = relativePath.split('/');

  // `a/b/**` matches `a/b/anything/at/any/depth`, and also `a/b` itself — a directory scope that
  // excluded the directory would refuse a case that legitimately replaces it with a file.
  const trailingGlobstar = patternSegments[patternSegments.length - 1] === '**';
  if (trailingGlobstar) {
    const prefix = patternSegments.slice(0, -1);
    if (pathSegments.length < prefix.length) return false;
    return prefix.every((segment, index) => segmentMatches(segment, pathSegments[index]));
  }

  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, index) => segmentMatches(segment, pathSegments[index]));
}

/** One segment. `*` is any run of characters WITHIN a segment; it never crosses a `/`. */
function segmentMatches(patternSegment: string, pathSegment: string): boolean {
  if (patternSegment === '*') return true;
  if (!patternSegment.includes('*')) return patternSegment === pathSegment;
  const parts = patternSegment.split('*');
  let cursor = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.length === 0) continue;
    if (index === 0) {
      if (!pathSegment.startsWith(part)) return false;
      cursor = part.length;
      continue;
    }
    if (index === parts.length - 1) {
      // The last literal must reach the end, and must not overlap what has already been consumed.
      return pathSegment.length - part.length >= cursor && pathSegment.endsWith(part);
    }
    const at = pathSegment.indexOf(part, cursor);
    if (at < 0) return false;
    cursor = at + part.length;
  }
  return true;
}

export type ScopeDecision = 'inScope' | 'outOfScope' | 'forbidden';

/** Where one changed path stands. `forbidden` is checked first, because forbidden always wins. */
export function classifyPath(policy: ScopePolicy, relativePath: string): ScopeDecision {
  const normalized = normalizeRelativePath(relativePath);
  if (policy.forbidden.some((pattern) => patternMatches(pattern, normalized))) return 'forbidden';
  if (policy.allowed.length === 0) return 'inScope';
  return policy.allowed.some((pattern) => patternMatches(pattern, normalized)) ? 'inScope' : 'outOfScope';
}

export interface ScopeViolation extends Record<string, CanonicalValue | undefined> {
  path: string;
  decision: 'outOfScope' | 'forbidden';
  /** Plain language, because a scope failure is read by someone deciding whether a run is usable. */
  reason: string;
}

export interface ScopeAssessment {
  violations: ScopeViolation[];
  inScopePaths: string[];
  /** True when every changed path was admitted. The only thing a scorer needs from the happy case. */
  clean: boolean;
}

/**
 * Judge a whole change set at once.
 *
 * The result is ordered by path so two assessments of the same change set are byte-identical, which
 * is what lets the assessment be digested into the evidence rather than merely printed beside it.
 */
export function assessScope(policy: ScopePolicy, changedPaths: string[]): ScopeAssessment {
  const violations: ScopeViolation[] = [];
  const inScopePaths: string[] = [];
  for (const raw of [...changedPaths].sort(compareCodePointsAscending)) {
    const normalized = normalizeRelativePath(raw);
    const decision = classifyPath(policy, normalized);
    if (decision === 'inScope') {
      inScopePaths.push(normalized);
      continue;
    }
    violations.push({
      path: normalized,
      decision,
      reason: decision === 'forbidden'
        ? `${normalized} is named by this task's forbidden list: changing it is a way of making the work look finished `
          + 'rather than finishing it, so a run that changed it is not evidence about the task'
        : `${normalized} is outside the paths this task declared it would touch (${policy.allowed.join(', ')}); `
          + 'a change there may be correct work, but it is not the work that was measured',
    });
  }
  return { violations, inScopePaths, clean: violations.length === 0 };
}

/** The one-line summary a ledger row and a terminal both print. Empty string when nothing broke. */
export function describeScopeAssessment(assessment: ScopeAssessment): string {
  if (assessment.clean) return '';
  return assessment.violations.map((violation) => `${violation.decision}: ${violation.path}`).join('; ');
}
