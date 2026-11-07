// Benchmark engine · crr2 EFFORT RECOMMENDATION, opt-in behind `--recommend-effort`. Advisory only.
//
// WHAT IT IS. crr2 ranks effort-keyed (cek1) routes as `provider:model@effort`, but on its own it never says
// which effort to use or what to escalate to. `effortRecommendationOf` reads a finished crr2 document and
// answers both, from the ranking alone:
//
//   THE EFFORT. Named only when the selected (first-ranked) entry is a cek1 effort-keyed record whose key
//   state is 'observed', meaning the tool's own telemetry measured the applied effort. Otherwise the state
//   is 'unobservable' with the reason: nothing ranked, a pooled record (derived without an effort key), or
//   an effort key nobody observed.
//
//   THE ESCALATION. The next higher level in EFFORT_LEVELS of the SAME provider:model, named only when an
//   observed cek1 entry for that exact key is in the ranking. Otherwise `none: true` with the reason. A
//   level is never skipped and never guessed: no evidence at the next level means no escalation is named.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOTHING HERE READS AN EFFORT FROM A MODEL NAME. The effort comes from the entry's `effort` (the cek1
//   `evidenceEffort` its record carries), the provider and model from the entry's own fields, and the
//   escalation key is built by `effortRouteKey` and matched against ranked entries' `effortRouteKey`.
//   NOT A SELECTION. It changes no ranking and selects, writes or launches nothing.
//   NOT A CHANGE TO crr2. Without `--recommend-effort` the crr2 document is byte-identical to what it was.

import { effortRouteKey } from './effort-keyed-routes';
import { EFFORT_LEVELS, EffortLevel } from './provider';
import { Crr2RankedRoute, Crr2Recommendation } from './route-recommendation-crr2';

export type Crr2EffortUnobservableCode = 'nothingRanked' | 'pooled' | 'effortUnobservable';
export type Crr2EscalationNoneCode = 'noObservedEffort' | 'highestEffort' | 'notRanked';

export type Crr2Escalation =
  | { effort: EffortLevel; routeKey: string; rank: number; reason: string }
  | { none: true; code: Crr2EscalationNoneCode; reason: string };

export type Crr2EffortRecommendation =
  | { state: 'observed'; effort: EffortLevel; routeKey: string; basis: string[]; escalation: Crr2Escalation }
  | { state: 'unobservable'; code: Crr2EffortUnobservableCode; reason: string; escalation: Crr2Escalation };

export type Crr2RecommendationWithEffort = Crr2Recommendation & { effortRecommendation: Crr2EffortRecommendation };

export const CRR2_EFFORT_RECOMMENDATION_RULE =
  'An effort is recommended only when the selected entry is a cek1 effort-keyed record whose key state is observed '
  + '(the tool\'s telemetry measured the applied effort); an escalation names the next higher effort of the same '
  + 'provider:model only when an observed cek1 entry for it is ranked. No effort is read from a model name.';

/** The observed effort of a ranked entry, or undefined. Read from the entry's cek1 effort only. */
function observedEffortOf(entry: Crr2RankedRoute): EffortLevel | undefined {
  return entry.effort.state === 'observed' && !entry.effort.pooled && entry.effort.effortRouteKey !== undefined
    ? entry.effort.effort : undefined;
}

function escalationFrom(first: Crr2RankedRoute, effort: EffortLevel, ranking: Crr2RankedRoute[]): Crr2Escalation {
  const index = EFFORT_LEVELS.indexOf(effort);
  const next = EFFORT_LEVELS[index + 1];
  if (next === undefined) {
    return { none: true, code: 'highestEffort', reason: `${effort} is the highest effort level modelled `
      + `(${EFFORT_LEVELS.join(', ')}), so there is no higher effort to escalate to` };
  }
  const key = effortRouteKey(first.provider, first.modelID, { state: 'observed', effort: next });
  const ranked = ranking.find((entry) => entry.effort.effortRouteKey === key && observedEffortOf(entry) === next
    && entry.provider === first.provider && entry.modelID === first.modelID);
  if (ranked === undefined) {
    return { none: true, code: 'notRanked', reason: `the next higher effort of ${first.routeKey} is ${next}, and no observed `
      + `cek1 entry ${key} is ranked, so no escalation is named; another effort is never substituted` };
  }
  return { effort: next, routeKey: key, rank: ranked.rank, reason: `${key} is the next higher effort (${next}) of `
    + `${first.routeKey} and is ranked at ${ranked.rank} on evidence observed at that effort` };
}

const NO_OBSERVED_EFFORT: Crr2Escalation = { none: true, code: 'noObservedEffort',
  reason: 'no effort was observed for the selected entry, so there is no effort to escalate from' };

/** The effort recommendation of one crr2 document. PURE: reads the document, changes nothing. */
export function effortRecommendationOf(answer: Crr2Recommendation): Crr2EffortRecommendation {
  const first = answer.ranking[0];
  if (first === undefined) {
    return { state: 'unobservable', code: 'nothingRanked',
      reason: 'nothing is ranked, so there is no selected entry whose effort could be recommended', escalation: NO_OBSERVED_EFFORT };
  }
  if (first.effort.pooled || first.effort.effortRouteKey === undefined) {
    return { state: 'unobservable', code: 'pooled', reason: `the selected entry ${first.key} was derived without an effort key `
      + '(cek1): its evidence pools every effort the runs were made at, so no single effort was observed for it',
    escalation: NO_OBSERVED_EFFORT };
  }
  const effort = observedEffortOf(first);
  if (effort === undefined) {
    return { state: 'unobservable', code: 'effortUnobservable', reason: `the selected entry ${first.key} is effort-keyed, but `
      + 'its key is unobservable: no telemetry measured the applied effort, and a requested effort that was accepted is '
      + 'not an observed one', escalation: NO_OBSERVED_EFFORT };
  }
  return { state: 'observed', effort, routeKey: first.effort.effortRouteKey, basis: first.effort.basis,
    escalation: escalationFrom(first, effort, answer.ranking) };
}

/** The crr2 document with `effortRecommendation` appended as its last key; every other key is unchanged. */
export function withEffortRecommendation(answer: Crr2Recommendation): Crr2RecommendationWithEffort {
  return { ...answer, effortRecommendation: effortRecommendationOf(answer) };
}
