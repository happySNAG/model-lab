// Benchmark engine · WHEN EACH SAFE ROUTE'S QUALIFICATION FALLS DUE FOR RENEWAL, as a forward schedule (R-50).
//
// WHAT THIS IS. The qualification planner (`qualification-planner.ts`, cqn1) decides, at one instant, which
// routes need a renewal NOW. This file answers the question one step earlier: for every route whose latest
// qualification verdict is safe to route, WHEN will a renewal fall due? A renewal falls due at `dueAt`, the
// qualification's `expiresAt` minus the renewal window, which is exactly the instant from which the planner
// starts planning one. The schedule is a list of those dates, soonest first, up to a horizon.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A SECOND EXPIRY RULE. The latest verdict, its expiry and its state are the planner's own,
//   obtained by calling `latestQualificationEvidence` and `qualificationExpiryState` and defaulting to
//   `RENEWAL_WINDOW_MILLISECONDS`. Nothing here recomputes them, so the schedule cannot drift from the plan:
//   at any `now`, the routes marked `due` are exactly the routes the planner gives a renewal trigger.
//   NOT A SCHEDULER. It installs nothing, starts nothing, writes nothing and runs nothing. It is a pure
//   function of its inputs; acting on a due date is the planner's and an owner's business, not this file's.
//   NOT SILENT ABOUT WHAT IT LEAVES OUT. A route whose latest verdict is not safe, or that has no verdict
//   with a readable evidence window, is listed under `notScheduled` with the reason. Only due dates past the
//   horizon are left out of the list, and how many were is reported.
//
// THE RULE (cqs1), per route history (the last history given for a route key wins, as in the planner):
//   no entry                                     → notScheduled, noHistory
//   newest entry's evidence window has no end    → notScheduled, unreadableEvidence
//   newest verdict not safeToRoute               → notScheduled, latestVerdictNotSafe
//   otherwise expiresAt = the planner's expiry, dueAt = expiresAt - renewalWindow,
//             state = the planner's expiry state at now, due = (state is not current)
//             listed when dueAt <= now + horizon, else counted as beyondHorizon.
// Scheduled entries are sorted by dueAt, then by route key in code-point order.

import { compareCodePoints } from './canonical';
import { QualificationHistory } from './qualification-history';
import { RENEWAL_WINDOW_MILLISECONDS, latestQualificationEvidence, qualificationExpiryState } from './qualification-planner';
import { QualificationPolicy, V1_QUALIFICATION_POLICY } from './route-qualification';

export const REQUALIFICATION_SCHEDULE_SCHEMA = 'cqs1';

export const REQUALIFICATION_SCHEDULE_DISCLOSURE =
  'A requalification schedule is a list of dates. Nothing here contacted a model, a provider or a network service, '
  + 'nothing was written or installed, and nothing is run when a date arrives: the qualification planner plans a '
  + 'renewal from its due date, and an owner approves it. Dates come from the planner\'s own expiry rule.';

export interface RequalificationScheduleInputs {
  now: Date;
  /** Due dates later than `now` plus this are left out. A whole, non-negative number of milliseconds. */
  horizonMilliseconds: number;
  histories: QualificationHistory[];
  /** The qualification policy whose maximum evidence age sets the expiry. Defaults to the planner's (cqp1). */
  policy?: QualificationPolicy;
  /** Defaults to the planner's `RENEWAL_WINDOW_MILLISECONDS` (7 days). */
  renewalWindowMilliseconds?: number;
}

export type RequalificationExpiryState = ReturnType<typeof qualificationExpiryState>;

export interface ScheduledRequalification {
  routeKey: string;
  /** When the qualification stops being current: the newest evidence plus the policy's maximum age. */
  expiresAt: string;
  /** When a renewal falls due: `expiresAt` minus the renewal window. */
  dueAt: string;
  /** The planner's expiry state at `now`. */
  state: RequalificationExpiryState;
  /** True when `dueAt` is at or before `now`, i.e. the planner gives this route a renewal trigger now. */
  due: boolean;
  /** The newest entry's `evidenceWindow.to`. */
  evidenceTo: string;
}

export type NotScheduledReason = 'noHistory' | 'unreadableEvidence' | 'latestVerdictNotSafe';

export interface NotScheduledRoute {
  routeKey: string;
  reason: NotScheduledReason;
  detail: string;
}

export interface RequalificationSchedule {
  schema: typeof REQUALIFICATION_SCHEDULE_SCHEMA;
  generatedAt: string;
  /** `now` plus the horizon: no listed `dueAt` is later. */
  horizonEndsAt: string;
  horizonMilliseconds: number;
  renewalWindowMilliseconds: number;
  qualificationPolicyID: string;
  scheduled: ScheduledRequalification[];
  /** How many safe routes fall due after the horizon and are therefore not listed. */
  beyondHorizon: number;
  notScheduled: NotScheduledRoute[];
  disclosure: string;
}

const isoOf = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

function wholeMilliseconds(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} is a whole, non-negative number of milliseconds, not ${String(value)}.`);
  }
}

/** The schedule. PURE: every input is a value, nothing is read, written, installed or run. */
export function deriveRequalificationSchedule(inputs: RequalificationScheduleInputs): RequalificationSchedule {
  const policy = inputs.policy ?? V1_QUALIFICATION_POLICY;
  const renewalWindow = inputs.renewalWindowMilliseconds ?? RENEWAL_WINDOW_MILLISECONDS;
  wholeMilliseconds('horizonMilliseconds', inputs.horizonMilliseconds);
  wholeMilliseconds('renewalWindowMilliseconds', renewalWindow);
  const now = inputs.now.getTime();
  if (Number.isNaN(now)) throw new RangeError('now is not a valid instant.');
  const horizonEnd = now + inputs.horizonMilliseconds;

  // One history per route key; the last one given wins, as the planner attaches the last history it reads.
  const byRoute = new Map<string, QualificationHistory>();
  for (const history of inputs.histories) byRoute.set(history.routeKey, history);

  const scheduled: (ScheduledRequalification & { dueAtMilliseconds: number })[] = [];
  const notScheduled: NotScheduledRoute[] = [];
  let beyondHorizon = 0;

  for (const [routeKey, history] of byRoute) {
    if (history.entries.length === 0) {
      notScheduled.push({ routeKey, reason: 'noHistory', detail: 'the qualification history has no entry, so no qualification exists to renew' });
      continue;
    }
    const evidence = latestQualificationEvidence(history, policy);
    if (evidence === undefined) {
      const to = history.entries[history.entries.length - 1].evidenceWindow.to;
      notScheduled.push({ routeKey, reason: 'unreadableEvidence',
        detail: `the newest entry's evidence window ends at '${String(to)}', which is not a readable instant, so no expiry can be computed` });
      continue;
    }
    if (!evidence.safe) {
      const verdict = history.entries[history.entries.length - 1].verdict;
      notScheduled.push({ routeKey, reason: 'latestVerdictNotSafe',
        detail: `the newest verdict is '${String(verdict)}', not safeToRoute, so there is no qualification to renew; `
          + 'it is qualified afresh, not renewed' });
      continue;
    }
    const dueAt = evidence.expiresAt - renewalWindow;
    if (dueAt > horizonEnd) { beyondHorizon += 1; continue; }
    const state = qualificationExpiryState(evidence.expiresAt, now, renewalWindow);
    scheduled.push({
      routeKey, expiresAt: isoOf(evidence.expiresAt), dueAt: isoOf(dueAt), state, due: state !== 'current',
      evidenceTo: isoOf(evidence.evidenceTo), dueAtMilliseconds: dueAt,
    });
  }

  scheduled.sort((a, b) => a.dueAtMilliseconds - b.dueAtMilliseconds || compareCodePoints(a.routeKey, b.routeKey));
  notScheduled.sort((a, b) => compareCodePoints(a.routeKey, b.routeKey));

  return {
    schema: REQUALIFICATION_SCHEDULE_SCHEMA,
    generatedAt: isoOf(now),
    horizonEndsAt: isoOf(horizonEnd),
    horizonMilliseconds: inputs.horizonMilliseconds,
    renewalWindowMilliseconds: renewalWindow,
    qualificationPolicyID: policy.policyID,
    scheduled: scheduled.map(({ dueAtMilliseconds: _sortKey, ...entry }) => entry),
    beyondHorizon,
    notScheduled,
    disclosure: REQUALIFICATION_SCHEDULE_DISCLOSURE,
  };
}
