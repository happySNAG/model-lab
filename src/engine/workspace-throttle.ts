// Benchmark engine · the PROVIDER-THROTTLE CIRCUIT BREAKER: recognising a provider decline that
// makes every remaining request on the same route predictably futile, and saying exactly how far
// that futility reaches.
//
// WHY THIS EXISTS. `workspace-scoring.ts` has always classified a rate limit correctly — the run is
// `runtimeError`, `providerThrottled` is set, and the model is not blamed. What no layer above it
// did was ACT on that flag. The first sealed forty-eight-run Claude matrix is the evidence: the
// subscription hit its session limit on run two, and the matrix went on to hand the same exhausted
// session forty-six more workspaces, one after another, each one declined in about half a second.
// Forty-seven durable records were written, every one of them honest, and not one of them measured
// a model. The scoring was right and the scheduling was wrong.
//
// WHAT A BREAKER MUST NOT DO. It must not turn a cell nobody ran into a failure — that is the exact
// mistake the throttle classification exists to prevent, moved one layer up. It must not delete the
// plan: a matrix that stopped at run two planned forty-eight, and the plan is what says so. And it
// must not fire on an ordinary failure. A model that changes nothing, a patch that does not apply,
// a verification command that fails, a single spawn fault on one cell — none of those say anything
// about whether the NEXT request will be served, so none of them may stop the matrix.
//
// SO THE TRIP CONDITION IS NARROW AND EVIDENCE-BORNE. It is the `providerThrottled` flag the
// scorecard already sets, which is set from exactly two agent failure kinds — `rateLimited` and
// `notAuthenticated` — and from nothing else. Both are statements about the SESSION rather than
// about the answer: one says the allowance is gone, the other says the login is. Everything else,
// including `transport`, `exitFailure` and `timeout`, stays a per-cell outcome and the matrix
// carries on. A route that genuinely became unreachable will trip the breaker on `rateLimited`
// soon enough; a route that hiccuped once will not have cost the other forty-six cells.
//
// SCOPE IS THE OTHER HALF, AND IT IS DECLARED RATHER THAN ASSUMED. "The provider is throttling" is
// not one fact. A per-model rate limit blocks one route and leaves the others; a Claude subscription
// session limit blocks every route the one CLI drives, because they share one session — which is
// why a Haiku 429 correctly predicted an Opus 429 in the failed matrix. A future driver may sit
// somewhere else again. So the scope is looked up from a per-provider table below, the table says
// which kind of thing is throttled, and a provider that has not declared one is handled
// conservatively AND SAID SO rather than quietly assumed to behave like Claude.

import { ProviderID } from './provider';

/**
 * How far a throttle reaches. Three named kinds, because they are genuinely three different facts
 * and a benchmark that collapsed them would either over-block or keep spending into a wall.
 */
export type ThrottleScope =
  /** One `provider:model@effort` route. Other routes of the same provider are unaffected. */
  | 'route'
  /** Every route of one provider, but not a shared account beyond it. */
  | 'provider'
  /** The whole subscription session a tool signs in with — every route that tool drives. */
  | 'subscriptionSession';

/**
 * What each provider's throttle reaches, as far as this build has evidence for it.
 *
 * DECLARED, NOT INFERRED. `claudeCLI` is here because the failed matrix proved it: one session
 * limit, reported as `You've hit your session limit · resets 8:10pm`, was returned identically to
 * Haiku, Sonnet, Fable and Opus within the same minute. That is a subscription session, shared by
 * every route the one CLI drives, and nothing narrower would have stopped the waste.
 *
 * A provider absent from this table is NOT assumed to work the same way — see
 * `providerThrottleScopeFor`.
 */
export const DECLARED_PROVIDER_THROTTLE_SCOPE: Partial<Record<ProviderID, ThrottleScope>> = {
  claudeCLI: 'subscriptionSession',
};

export interface ProviderThrottleScopeDecision {
  scope: ThrottleScope;
  /** True when the table above names this provider. False means the scope below is the fallback. */
  declared: boolean;
  /**
   * What is being throttled, as a key other cells can be compared against.
   *
   * For a `subscriptionSession` scope this is the provider id, because in this build one provider
   * means one CLI means one signed-in session. It is a separate field rather than a reuse of the
   * provider id so that a future driver which can tell two sessions of one provider apart — two
   * accounts, two profiles, two API keys — has somewhere to put that distinction without changing
   * the shape of everything that reads a signal.
   */
  sessionKey: string;
  /** Why the scope is what it is, in the provider's own terms. Always present. */
  note: string;
}

/**
 * How far a throttle from this provider reaches, and whether anybody actually established that.
 *
 * THE FALLBACK IS `provider`, AND IT IS A CHOICE WITH A COST. An undeclared provider's throttle
 * might in truth be per-route, in which case blocking the whole provider defers cells that would
 * have run. The alternative — assuming `route` — keeps sending into an account that may be
 * exhausted, which is what this module exists to stop, and produces more unusable records rather
 * than fewer usable ones. Deferred cells are recoverable by re-running; allowance spent on a
 * predictable decline is not. The fallback is recorded as UNDECLARED wherever it is used, so a
 * reader can see that the blast radius was chosen by this rule rather than measured.
 */
export function providerThrottleScopeFor(provider: ProviderID): ProviderThrottleScopeDecision {
  const declared = DECLARED_PROVIDER_THROTTLE_SCOPE[provider];
  if (declared === 'subscriptionSession') {
    return {
      scope: 'subscriptionSession',
      declared: true,
      sessionKey: provider,
      note: `${provider} is driven through one signed-in subscription session, and every model route it offers is `
        + 'served out of that one session\'s allowance. A session limit returned for one route is therefore a '
        + 'statement about all of them, which is what the first sealed matrix observed directly: four different '
        + 'models declined within the same minute with the same reset time.',
    };
  }
  if (declared !== undefined) {
    return {
      scope: declared,
      declared: true,
      sessionKey: provider,
      note: `${provider} declares its throttle scope as ${declared} in this build.`,
    };
  }
  return {
    scope: 'provider',
    declared: false,
    sessionKey: provider,
    note: `${provider} has NOT declared how far its throttling reaches, so this build does not claim to know. `
      + 'Remaining cells on this provider are deferred rather than attempted, because allowance spent on a '
      + 'predictable decline cannot be recovered and a deferred cell can simply be run again. Cells on OTHER '
      + 'providers are untouched.',
  };
}

/** Reset or retry information, only ever as the provider itself stated it. */
export interface ThrottleReset {
  /** The provider's own words, verbatim and trimmed. Never paraphrased, never converted. */
  reported: string;
  /** A clock time the provider named, when it named one. Kept as text: it carries its own zone. */
  resetsAt?: string;
  /** A delay the provider named in seconds, when it named one. */
  retryAfterSeconds?: number;
}

/**
 * Pull reset/retry information out of a provider's decline message — or say there is none.
 *
 * READS, NEVER INVENTS. Claude Code reports `You've hit your session limit · resets 8:10pm
 * (America/Chicago)`, and that whole phrase is worth preserving exactly as written because the
 * zone is part of it. Where a provider names nothing, this returns `undefined` and the surfaces
 * above print "the provider named no reset time" rather than a guess at one.
 */
export function parseThrottleReset(detail: string): ThrottleReset | undefined {
  const resets = /reset(?:s|ting)?(?:\s+at)?\s+([^.·\n]{1,60})/i.exec(detail);
  const retryAfter = /retry[-\s]?after[:\s]+(\d{1,7})\s*(?:s|sec|secs|seconds)?/i.exec(detail)
    ?? /try again in\s+(\d{1,7})\s*(?:s|sec|secs|seconds)/i.exec(detail);
  if (resets === null && retryAfter === null) return undefined;
  const reported = (resets?.[0] ?? retryAfter?.[0] ?? '').trim();
  return {
    reported,
    resetsAt: resets === null ? undefined : resets[1].trim(),
    retryAfterSeconds: retryAfter === null ? undefined : Number(retryAfter[1]),
  };
}

/**
 * One observed provider-decline condition, and everything needed to decide what it blocks.
 *
 * This is EVIDENCE, not a verdict about any model. It names the run that observed the decline so a
 * reader can go to that record, and it carries the scope decision so a reader can see whether the
 * blast radius was declared by the provider's driver or chosen by the fallback rule.
 */
export interface ProviderThrottleSignal {
  provider: ProviderID;
  /** The candidate whose run observed it. Other candidates may or may not be blocked; see `scope`. */
  observedOnCandidate: string;
  observedOnCaseID: string;
  observedOnRepeatIndex: number;
  /** The record that holds the evidence for this signal. Sealed normally, like any other run. */
  observedInRecordRoot: string;
  /** `rateLimited` or `notAuthenticated`. Nothing else may produce a signal. */
  failureKind: string;
  /** The scorecard's own detail line, verbatim. Carries the provider's message. */
  detail: string;
  scope: ThrottleScope;
  scopeDeclared: boolean;
  sessionKey: string;
  scopeNote: string;
  reset?: ThrottleReset;
  observedAt: string;
}

/** What a workspace run has to be able to say for the breaker to read it. */
export interface ThrottleObservation {
  provider: ProviderID;
  candidate: string;
  caseID: string;
  repeatIndex: number;
  recordRoot: string;
  /** `WorkspaceScorecard.providerThrottled`. The one authority; nothing here second-guesses it. */
  providerThrottled: boolean;
  /** `WorkspaceScorecard.detail`. */
  detail: string;
  /** The deciding attempt's agent failure kind, when it had one. */
  failureKind?: string;
  observedAt?: string;
}

/**
 * The agent failure kinds that establish a condition about the SESSION rather than about an answer.
 *
 * The same two `campaign.ts` has used on the prose side since Pass 9, named again here so the
 * workspace breaker and the prose abort cannot drift apart about what a throttle is.
 */
export const THROTTLE_ESTABLISHING_FAILURES = ['rateLimited', 'notAuthenticated'] as const;

/**
 * Decide whether a sealed run established a throttle condition, and what it reaches.
 *
 * Returns `undefined` for every ordinary outcome, INCLUDING every model failure and every one-off
 * harness or transport fault. A matrix that stopped on those would stop on noise.
 */
export function detectProviderThrottle(observation: ThrottleObservation): ProviderThrottleSignal | undefined {
  if (!observation.providerThrottled) return undefined;
  // The flag is the authority, but a flag with a failure kind that is not one of the two would be a
  // contradiction, and the honest reading of a contradiction is the narrower claim: no signal.
  if (observation.failureKind !== undefined
    && !(THROTTLE_ESTABLISHING_FAILURES as readonly string[]).includes(observation.failureKind)) return undefined;

  const decision = providerThrottleScopeFor(observation.provider);
  return {
    provider: observation.provider,
    observedOnCandidate: observation.candidate,
    observedOnCaseID: observation.caseID,
    observedOnRepeatIndex: observation.repeatIndex,
    observedInRecordRoot: observation.recordRoot,
    failureKind: observation.failureKind ?? 'rateLimited',
    detail: observation.detail,
    scope: decision.scope,
    scopeDeclared: decision.declared,
    sessionKey: decision.sessionKey,
    scopeNote: decision.note,
    reset: parseThrottleReset(observation.detail),
    observedAt: observation.observedAt ?? new Date().toISOString(),
  };
}

/** The part of a matrix cell the breaker needs to decide whether a signal reaches it. */
export interface ThrottleTarget {
  provider: ProviderID;
  candidate: string;
}

/**
 * Does this signal make that cell's request predictably futile?
 *
 * `route` reaches one candidate. `provider` and `subscriptionSession` both reach every route of the
 * provider in this build — a distinction with no behavioural difference TODAY and a real one the
 * moment a driver can name two sessions of one provider, which is why they are two values rather
 * than one. A signal never reaches another provider, whatever its scope.
 */
export function throttleBlocks(signal: ProviderThrottleSignal, target: ThrottleTarget): boolean {
  if (signal.provider !== target.provider) return false;
  switch (signal.scope) {
    case 'route': return signal.observedOnCandidate === target.candidate;
    case 'provider': return true;
    case 'subscriptionSession': return signal.sessionKey === target.provider;
    default: return false;
  }
}

/** The line a deferred cell carries, so a record of the matrix says why it holds fewer runs. */
export function describeThrottleDeferral(signal: ProviderThrottleSignal): string {
  return `providerThrottledBeforeExecution: ${signal.failureKind} was returned to `
    + `${signal.observedOnCandidate} on ${signal.observedOnCaseID} repeat ${signal.observedOnRepeatIndex}, and that `
    + `condition is ${signal.scope}-scoped${signal.scopeDeclared ? '' : ' (UNDECLARED by this provider; see the note)'}`
    + `, so this cell was NOT executed. It is not a failure of the model: nothing was asked of it. `
    + `${signal.reset === undefined ? 'The provider named no reset time.' : `The provider said: ${signal.reset.reported}.`}`;
}

/** The lines a person reads about a throttle that stopped a matrix. */
export function describeProviderThrottle(signal: ProviderThrottleSignal): string[] {
  return [
    `PROVIDER THROTTLED — ${signal.provider} · ${signal.failureKind}`,
    `  observed on   ${signal.observedOnCandidate} · ${signal.observedOnCaseID} · repeat ${signal.observedOnRepeatIndex}`,
    `  evidence      ${signal.observedInRecordRoot}`,
    `  detail        ${signal.detail}`,
    `  scope         ${signal.scope}${signal.scopeDeclared ? ' (declared by this provider\'s driver)' : ' (NOT DECLARED — fallback)'}`
      + ` · session key ${signal.sessionKey}`,
    `                ${signal.scopeNote}`,
    `  reset         ${signal.reset === undefined
      ? 'the provider named no reset or retry time, so none is reported here'
      : signal.reset.reported}`,
  ];
}

/**
 * The sentence that has to travel with any matrix a breaker stopped.
 *
 * A reader who sees nine records where forty-eight were planned must be told which of the two
 * things happened, because they mean opposite things about the models involved.
 */
export const THROTTLE_STOPPED_THE_MATRIX_NOT_THE_MODELS =
  'This matrix stopped early because the PROVIDER declined, not because any model failed. Cells that were never '
  + 'executed are recorded as not executed, carry no status, no score and no zero, and are absent from every rate '
  + 'and every average. The plan they came from is preserved in full, so the difference between "planned and not '
  + 'run" and "run and failed" is readable from the record rather than inferred from a count.';
