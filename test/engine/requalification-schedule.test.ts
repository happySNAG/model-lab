// The requalification schedule (cqs1, R-50): for every route whose latest qualification verdict is safe, when
// a renewal falls due (expiresAt minus the renewal window), soonest first, up to a horizon — by the qualification
// planner's own expiry rule, called and not copied.
//
// FIXTURES ONLY, built here. Histories are hand-written cqh1 values in memory, as in qualification-planner.test.ts
// and status-export-expiry.test.ts. The one temporary root lives under os.tmpdir() and is removed after each test.
// Nothing here contacts a model, a provider or a network service, and nothing runs a request.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QualificationHistory } from '../../src/engine/qualification-history';
import {
  QualificationPlan, RENEWAL_WINDOW_MILLISECONDS, deriveQualificationPlan, latestQualificationEvidence, qualificationExpiryState,
} from '../../src/engine/qualification-planner';
import { V1_QUALIFICATION_POLICY, V2_QUALIFICATION_POLICY } from '../../src/engine/route-qualification';
import {
  REQUALIFICATION_SCHEDULE_SCHEMA, RequalificationSchedule, RequalificationScheduleInputs, deriveRequalificationSchedule,
} from '../../src/engine/requalification-schedule';

const REPOSITORY = path.resolve(__dirname, '../..');
const MACHINE = 'cmk1:requalification-schedule-machine';
const hour = 3_600_000;
const day = 24 * hour;
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MAXIMUM_AGE = V1_QUALIFICATION_POLICY.maximumAgeMilliseconds;

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-requalification-'));
  temporaries.push(directory);
  return directory;
}

/** A one-entry cqh1 history, written by hand. */
function history(routeKey: string, verdict: 'safeToRoute' | 'notRoutable', evidenceTo: string): QualificationHistory {
  const at = routeKey.indexOf(':');
  return {
    schema: 'cqh1', routeKey, provider: routeKey.slice(0, at) as QualificationHistory['provider'], modelID: routeKey.slice(at + 1),
    effort: 'any', machineKey: MACHINE,
    entries: [{
      recordedAt: evidenceTo, policyID: 'cqp1', routingPolicyVersion: 'crp2', verdict, routableCapabilities: [], capabilities: [],
      blockers: [], evidenceWindow: { from: evidenceTo, to: evidenceTo, workspaceRuns: 3, observations: 1 },
      triggeredBy: [], stalenessRecorded: [], changed: true,
    }],
    undatedWorkspaceRuns: [], corrupt: [], disclosure: 'fixture history',
  };
}

/** A history whose newest entry is unsafe, on top of an older safe one: only the newest verdict counts. */
function withNewerEntry(base: QualificationHistory, verdict: 'safeToRoute' | 'notRoutable', evidenceTo: string): QualificationHistory {
  const newer = history(base.routeKey, verdict, evidenceTo).entries[0];
  return { ...base, entries: [...base.entries, newer] };
}

/** The planner's renewal triggers, by route, from both its requests and its skips (as status-export-expiry.test.ts). */
function renewalsOf(plan: QualificationPlan): Set<string> {
  const found = new Set<string>();
  for (const request of plan.requests) if (request.trigger.kind === 'renewal') found.add(request.routeKey);
  for (const skip of plan.skipped) if (skip.trigger?.kind === 'renewal') found.add(skip.routeKey);
  return found;
}
const planAt = (histories: QualificationHistory[], now: number): QualificationPlan => deriveQualificationPlan({
  now: new Date(now), machineKey: MACHINE, histories,
  ledger: { records: [], corrupt: [], budget: 100, used: 0, ledgerDigest: 'fixture' },
});

const scheduleAt = (histories: QualificationHistory[], now: number, extra: Partial<RequalificationScheduleInputs> = {}):
  RequalificationSchedule => deriveRequalificationSchedule({ now: new Date(now), horizonMilliseconds: 365 * day, histories, ...extra });
const dueRoutes = (schedule: RequalificationSchedule): string[] =>
  schedule.scheduled.filter((entry) => entry.due).map((entry) => entry.routeKey).sort();

// A spread of routes. Real (subscription) route keys reach the planner's requests; unknown providers reach its
// skips with the trigger attached. Both count as renewal triggers.
const HISTORIES: QualificationHistory[] = [
  history('claudeCLI:claude-haiku-4-5', 'safeToRoute', '2026-09-30T00:00:00Z'), // expires 2026-10-30
  history('claudeCLI:claude-sonnet-4-5', 'safeToRoute', '2026-10-22T00:00:00Z'), // expires 2026-11-21
  history('codexCLI:gpt-5-codex', 'safeToRoute', '2026-10-10T12:00:00Z'), // expires 2026-11-09T12
  history('zeta:late', 'safeToRoute', '2026-10-05T00:00:00Z'), // expires 2026-11-04
  history('beta:same', 'safeToRoute', '2026-09-25T00:00:00Z'), // expires 2026-10-25
  history('alpha:same', 'safeToRoute', '2026-09-25T00:00:00Z'), // expires 2026-10-25
  history('gamma:unsafe', 'notRoutable', '2026-09-25T00:00:00Z'),
  withNewerEntry(history('eta:regressed', 'safeToRoute', '2026-09-20T00:00:00Z'), 'notRoutable', '2026-10-01T00:00:00Z'),
  { ...history('epsilon:empty', 'safeToRoute', '2026-09-25T00:00:00Z'), entries: [] },
  (() => {
    const unreadable = history('theta:unreadable', 'safeToRoute', '2026-09-25T00:00:00Z');
    return { ...unreadable, entries: [{ ...unreadable.entries[0], evidenceWindow: { ...unreadable.entries[0].evidenceWindow, to: 'not a date' } }] };
  })(),
];

// ------------------------------------------------------------------ (a) due is exactly the planner's renewals

describe('requalification schedule cqs1 · (a) the routes marked due are exactly the planner\'s renewal triggers', () => {
  it('agrees with deriveQualificationPlan at many instants, including each due date and the instant before it', () => {
    const instants = new Set<number>();
    for (let at = Date.parse('2026-10-01T00:00:00Z'); at <= Date.parse('2026-12-01T00:00:00Z'); at += 12 * hour) instants.add(at);
    for (const entry of scheduleAt(HISTORIES, Date.parse('2026-09-01T00:00:00Z')).scheduled) {
      const dueAt = Date.parse(entry.dueAt);
      instants.add(dueAt);
      instants.add(dueAt - 1_000);
      instants.add(Date.parse(entry.expiresAt));
    }
    let sawSome = false;
    let sawNone = false;
    for (const now of [...instants].sort((a, b) => a - b)) {
      const due = dueRoutes(scheduleAt(HISTORIES, now));
      const renewals = [...renewalsOf(planAt(HISTORIES, now))].sort();
      expect(due, iso(now)).toEqual(renewals);
      if (due.length > 0) sawSome = true; else sawNone = true;
    }
    // The comparison was not vacuous either way.
    expect(sawSome).toBe(true);
    expect(sawNone).toBe(true);
  });

  it('agrees under another policy and another renewal window, passed to both', () => {
    for (const now of [Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-11-03T00:00:00Z'), Date.parse('2026-11-25T00:00:00Z')]) {
      for (const renewalWindowMilliseconds of [1 * day, 7 * day, 20 * day]) {
        for (const policy of [V1_QUALIFICATION_POLICY, V2_QUALIFICATION_POLICY]) {
          const due = dueRoutes(scheduleAt(HISTORIES, now, { policy, renewalWindowMilliseconds }));
          const renewals = [...renewalsOf(deriveQualificationPlan({
            now: new Date(now), machineKey: MACHINE, histories: HISTORIES, policy, renewalWindowMilliseconds,
            ledger: { records: [], corrupt: [], budget: 100, used: 0, ledgerDigest: 'fixture' },
          }))].sort();
          expect(due, `${iso(now)} ${policy.policyID} ${renewalWindowMilliseconds}`).toEqual(renewals);
        }
      }
    }
  });

  it('lists dueAt as expiresAt minus the window and expiresAt as the planner\'s, sorted by dueAt then route key', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    const schedule = scheduleAt(HISTORIES, now);
    expect(schedule.schema).toBe(REQUALIFICATION_SCHEDULE_SCHEMA);
    expect(schedule.schema).toBe('cqs1');
    expect(schedule.generatedAt).toBe('2026-10-30T00:00:00Z');
    expect(schedule.qualificationPolicyID).toBe('cqp1');
    expect(schedule.renewalWindowMilliseconds).toBe(RENEWAL_WINDOW_MILLISECONDS);
    expect(schedule.scheduled.map((entry) => [entry.routeKey, entry.dueAt, entry.expiresAt, entry.state, entry.due])).toEqual([
      ['alpha:same', '2026-10-18T00:00:00Z', '2026-10-25T00:00:00Z', 'expired', true],
      ['beta:same', '2026-10-18T00:00:00Z', '2026-10-25T00:00:00Z', 'expired', true],
      ['claudeCLI:claude-haiku-4-5', '2026-10-23T00:00:00Z', '2026-10-30T00:00:00Z', 'expired', true],
      ['zeta:late', '2026-10-28T00:00:00Z', '2026-11-04T00:00:00Z', 'expiring', true],
      ['codexCLI:gpt-5-codex', '2026-11-02T12:00:00Z', '2026-11-09T12:00:00Z', 'current', false],
      ['claudeCLI:claude-sonnet-4-5', '2026-11-14T00:00:00Z', '2026-11-21T00:00:00Z', 'current', false],
    ]);
    for (const entry of schedule.scheduled) {
      const evidence = latestQualificationEvidence(HISTORIES.find((each) => each.routeKey === entry.routeKey), V1_QUALIFICATION_POLICY)!;
      expect(entry.expiresAt).toBe(iso(evidence.expiresAt));
      expect(Date.parse(entry.dueAt)).toBe(evidence.expiresAt - RENEWAL_WINDOW_MILLISECONDS);
      expect(entry.evidenceTo).toBe(iso(evidence.evidenceTo));
      expect(entry.state).toBe(qualificationExpiryState(evidence.expiresAt, now));
    }
  });
});

// ------------------------------------------------------------------ (b) the states at the boundary

describe('requalification schedule cqs1 · (b) states at 8, 7 and 6 days before expiry and 1 day after', () => {
  it('is current at 8 days, expiring at exactly 7 (the boundary), expiring at 6, expired 1 day after — as the planner defines them', () => {
    const route = 'claudeCLI:claude-haiku-4-5';
    const evidenceTo = '2026-10-03T00:00:00Z';
    const expiry = Date.parse(evidenceTo) + MAXIMUM_AGE;
    const histories = [history(route, 'safeToRoute', evidenceTo)];
    const expected: [string, number, 'current' | 'expiring' | 'expired'][] = [
      ['8 days before', expiry - 8 * day, 'current'],
      ['just over 7 days before', expiry - 7 * day - 1_000, 'current'],
      ['7 days before (the boundary)', expiry - 7 * day, 'expiring'],
      ['6 days before', expiry - 6 * day, 'expiring'],
      ['at expiry', expiry, 'expired'],
      ['1 day after', expiry + 1 * day, 'expired'],
    ];
    for (const [label, now, state] of expected) {
      const schedule = scheduleAt(histories, now);
      expect(schedule.scheduled, label).toHaveLength(1);
      const [entry] = schedule.scheduled;
      expect(entry.state, label).toBe(state);
      expect(entry.state, label).toBe(qualificationExpiryState(expiry, now));
      expect(entry.due, label).toBe(state !== 'current');
      expect(entry.expiresAt, label).toBe(iso(expiry));
      expect(entry.dueAt, label).toBe(iso(expiry - 7 * day));
      // The planner, at the same instant, plans a renewal exactly when the schedule says due.
      expect(renewalsOf(planAt(histories, now)).has(route), label).toBe(entry.due);
    }
  });
});

// ------------------------------------------------------------------ (c) not scheduled, with a reason

describe('requalification schedule cqs1 · (c) unsafe and history-less routes are not scheduled, with a reason', () => {
  it('lists each unsafe, empty and unreadable route under notScheduled with its reason and never under scheduled', () => {
    const schedule = scheduleAt(HISTORIES, Date.parse('2026-10-30T00:00:00Z'));
    expect(schedule.notScheduled.map((entry) => [entry.routeKey, entry.reason])).toEqual([
      ['epsilon:empty', 'noHistory'],
      ['eta:regressed', 'latestVerdictNotSafe'],
      ['gamma:unsafe', 'latestVerdictNotSafe'],
      ['theta:unreadable', 'unreadableEvidence'],
    ]);
    for (const entry of schedule.notScheduled) expect(entry.detail.length, entry.routeKey).toBeGreaterThan(20);
    expect(schedule.notScheduled.find((entry) => entry.routeKey === 'gamma:unsafe')!.detail).toContain('notRoutable');
    const scheduledKeys = new Set(schedule.scheduled.map((entry) => entry.routeKey));
    for (const entry of schedule.notScheduled) expect(scheduledKeys.has(entry.routeKey), entry.routeKey).toBe(false);
    // Every history given is accounted for exactly once (all safe due dates fall inside a year's horizon).
    expect(schedule.scheduled.length + schedule.notScheduled.length + schedule.beyondHorizon).toBe(HISTORIES.length);
    expect(schedule.beyondHorizon).toBe(0);
  });

  it('is not scheduled whatever the instant or horizon, and an empty list of histories gives an empty schedule', () => {
    for (const now of [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')]) {
      for (const horizonMilliseconds of [0, 1_000 * day]) {
        const schedule = scheduleAt(HISTORIES.slice(6), now, { horizonMilliseconds });
        expect(schedule.scheduled).toEqual([]);
        expect(schedule.notScheduled).toHaveLength(4);
      }
    }
    const empty = scheduleAt([], Date.parse('2026-10-30T00:00:00Z'));
    expect([empty.scheduled, empty.notScheduled, empty.beyondHorizon]).toEqual([[], [], 0]);
  });
});

// ------------------------------------------------------------------ (d) the horizon

describe('requalification schedule cqs1 · (d) the horizon excludes later due dates', () => {
  it('lists only due dates at or before now plus the horizon, counts the rest, and keeps the order', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    const keys = (horizonMilliseconds: number): string[] =>
      scheduleAt(HISTORIES, now, { horizonMilliseconds }).scheduled.map((entry) => entry.routeKey);

    // A zero horizon lists only what is already due.
    const zero = scheduleAt(HISTORIES, now, { horizonMilliseconds: 0 });
    expect(zero.scheduled.every((entry) => entry.due)).toBe(true);
    expect(keys(0)).toEqual(['alpha:same', 'beta:same', 'claudeCLI:claude-haiku-4-5', 'zeta:late']);
    expect(zero.beyondHorizon).toBe(2);
    expect(zero.horizonEndsAt).toBe('2026-10-30T00:00:00Z');

    // gpt-5-codex falls due 2026-11-02T12:00Z, 3.5 days out: inclusive at exactly the horizon, excluded a second before.
    expect(keys(3.5 * day - 1_000)).not.toContain('codexCLI:gpt-5-codex');
    expect(keys(3.5 * day)).toContain('codexCLI:gpt-5-codex');
    expect(keys(3.5 * day)).not.toContain('claudeCLI:claude-sonnet-4-5');
    expect(scheduleAt(HISTORIES, now, { horizonMilliseconds: 3.5 * day }).beyondHorizon).toBe(1);

    // Sonnet falls due 2026-11-14, 15 days out.
    expect(keys(15 * day)).toEqual([
      'alpha:same', 'beta:same', 'claudeCLI:claude-haiku-4-5', 'zeta:late', 'codexCLI:gpt-5-codex', 'claudeCLI:claude-sonnet-4-5',
    ]);
    for (const horizon of [0, 1 * day, 3.5 * day, 10 * day, 15 * day, 60 * day]) {
      const schedule = scheduleAt(HISTORIES, now, { horizonMilliseconds: horizon });
      for (const entry of schedule.scheduled) expect(Date.parse(entry.dueAt)).toBeLessThanOrEqual(now + horizon);
      // The horizon only removes entries from the end; it never reorders or changes those it keeps.
      expect(schedule.scheduled).toEqual(scheduleAt(HISTORIES, now).scheduled.slice(0, schedule.scheduled.length));
      expect(schedule.notScheduled).toEqual(scheduleAt(HISTORIES, now).notScheduled);
    }
  });

  it('refuses a horizon or window that is not a whole, non-negative number of milliseconds', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scheduleAt(HISTORIES, now, { horizonMilliseconds: bad }), String(bad)).toThrow(RangeError);
      expect(() => scheduleAt(HISTORIES, now, { renewalWindowMilliseconds: bad }), String(bad)).toThrow(RangeError);
    }
  });
});

// ------------------------------------------------------------------ (e) nothing is written

function snapshotTree(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      const relative = path.relative(root, full);
      if (stat.isDirectory()) { found[`${relative}/`] = `dir ${stat.mtimeMs}`; walk(full); }
      else found[relative] = `file ${stat.size} ${stat.mtimeMs} ${fs.readFileSync(full, 'utf8')}`;
    }
  };
  walk(root);
  return found;
}

describe('requalification schedule cqs1 · (e) nothing is written', () => {
  it('leaves a temporary root unchanged, leaves its inputs unchanged, and imports no file system or process module', () => {
    const root = temporary();
    fs.mkdirSync(path.join(root, '.qualification-requests'));
    fs.writeFileSync(path.join(root, '.qualification-requests', 'budget.jsonl'), '');
    fs.writeFileSync(path.join(root, 'histories.json'), JSON.stringify(HISTORIES));
    const before = snapshotTree(root);
    const rootStat = fs.statSync(root).mtimeMs;

    const histories = JSON.parse(fs.readFileSync(path.join(root, 'histories.json'), 'utf8')) as QualificationHistory[];
    const inputsText = JSON.stringify(histories);
    const first = scheduleAt(histories, Date.parse('2026-10-30T00:00:00Z'), { horizonMilliseconds: 30 * day });
    const second = scheduleAt(histories, Date.parse('2026-10-30T00:00:00Z'), { horizonMilliseconds: 30 * day });

    expect(second).toEqual(first);
    expect(JSON.stringify(histories)).toBe(inputsText);
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.statSync(root).mtimeMs).toBe(rootStat);
    expect(first.disclosure).toContain('nothing was written or installed');

    // The module itself reaches for no file system, process, network or timer API.
    const source = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', 'requalification-schedule.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(['./canonical', './qualification-history', './qualification-planner', './route-qualification']);
    for (const forbidden of ['node:', 'require(', 'setTimeout', 'setInterval', 'Date.now', 'process.']) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});
