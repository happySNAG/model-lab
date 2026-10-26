// Benchmark engine · WHICH ROUTES NEED QUALIFYING NEXT, written down as bounded request files for an
// owner-approved runner, and charged against an explicit budget. Nothing here runs anything.
//
// WHAT IT READS. The release report (crl1: each model a listing named that nobody was told about yet), the
// discovery delta (cdd1: which models changed, field by field), every route's qualification history (cqh1:
// the verdicts re-derived from the evidence) and the budget ledger this module keeps. From those it decides,
// per route, whether a qualification request is due, and which one.
//
// THE RULES, AND EACH OF THEM IS A REFUSAL SOMEWHERE BELOW.
//
//   NEVER EXECUTES. The output is a plan and, when the caller asks, files: one JSON request per route and
//   one sealed charge line per request. No model, provider, CLI or network is contacted, and no runner is
//   started. A request is a proposal an owner approves and a separate runner carries out.
//   ONE REQUEST PER ROUTE, SMOKE FIRST. A route nobody has smoke-tested since its trigger gets an identity
//   smoke request. Only a smoke that PASSED after the trigger moves the route on to the discriminator
//   matrix (pack.cernum.workspace.discriminator-one). A refused smoke means not reachable and nothing is
//   planned; a failed smoke is left for the owner rather than retried at the budget's expense.
//   METERED IS NEVER PLANNED. Cost eligibility is `costEligibilityFor`'s, with no override consulted: a
//   route classified `metered`, or `unknown_cost`, is excluded with the reason, whatever anybody authorised
//   elsewhere. Confirmed-free, subscription-included and local routes are the only ones planned.
//   CURRENT AND UNCHANGED IS NOT RE-PLANNED. A route whose latest verdict is safe to route, whose
//   qualification does not expire within the renewal window, and whose evidence postdates every change that
//   staled it, is skipped. A qualification expiring within 7 days (or already expired) is planned a renewal.
//   EVERY RUN IS CHARGED, AND THE BUDGET REFUSES. Each request states its run count. Requests are charged in
//   a fixed order against the ledger's budget; a request that does not fit in what remains is refused, not
//   shrunk. The ledger is append-only and hash-chained like the release ledger; a ledger that does not
//   verify is not charged against, because a forged "used" could hide spending.
//   NOTHING IS READ FROM A NAME. Reachability comes from the listing's availability and recorded smoke
//   results only; discovered is not reachable, and reachable is not qualified.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, compareCodePoints, digestObject } from './canonical';
import { CostEligibility, ZeroMarginalCostConfirmation, costEligibilityFor } from './cost-eligibility';
import { DiscoveryDeltaModel, DiscoveryDeltaReport } from './discovery-delta';
import { DiscoverySnapshot } from './discovery-refresh';
import { IDENTITY_SMOKE_PROMPT } from './identity-smoke';
import { ProviderID } from './provider';
import { QualificationHistory } from './qualification-history';
import { ReleaseReport } from './release-report';
import { QualificationPolicy, V1_QUALIFICATION_POLICY } from './route-qualification';
import { WORKSPACE_PACK_DISCRIMINATOR_ONE, discriminatorOnePack } from './workspace-catalog';

export const QUALIFICATION_PLAN_SCHEMA = 'cqn1';
export const QUALIFICATION_REQUEST_SCHEMA = 'cqr1';
export const REQUEST_BUDGET_LEDGER_SCHEMA = 'cqb1';

const DAY = 24 * 60 * 60 * 1_000;

/** A qualification expiring within this window, or already expired, is planned a renewal. */
export const RENEWAL_WINDOW_MILLISECONDS = 7 * DAY;

/** How long a planned request stays valid. An unrun request older than this is planned again, and charged again. */
export const REQUEST_VALIDITY_MILLISECONDS = 7 * DAY;

/** The identity smoke, as a benchmark: one prompt, one run. Its version moves when the prompt does. */
export const IDENTITY_SMOKE_BENCHMARK = { id: 'cernum.identity-smoke', version: '1', runs: 1 } as const;

export const QUALIFICATION_PLAN_DISCLOSURE =
  'A qualification plan is a list of proposals. Nothing here contacted a model, a provider or a network service, '
  + 'and nothing here runs a request: an owner approves each file and a separate runner carries it out. Metered '
  + 'and unknown-cost routes are never planned. A planned route was named by a listing or holds expiring evidence; '
  + 'discovered is not reachable, and reachable is not qualified.';

export type QualificationStage = 'smoke' | 'discriminator';

/** Why a route is up for qualification. A smoke planned earlier carries its own trigger forward (`carriedFromLedger`). */
export type QualificationTriggerKind = 'new' | 'changed' | 'renewal';

export interface QualificationTrigger {
  kind: QualificationTriggerKind;
  /** Evidence older than this instant does not count for the trigger: a smoke or a run must postdate it. */
  since: string;
  /** True when the trigger makes existing evidence stale (a new model, or a material change). */
  invalidatesEvidence: boolean;
  detail: string[];
  /** True when the trigger came from an earlier smoke request in the ledger, not from this plan's inputs. */
  carriedFromLedger: boolean;
}

/** A recorded identity smoke result for one exact route key. Supplied, never inferred. */
export interface QualificationSmokeResult {
  routeKey: string;
  outcome: 'passed' | 'failed' | 'refused';
  observedAt: string;
  source: string;
}

/** One request file. Every field the runner needs to stay inside its bound is here. */
export interface QualificationRequest {
  schema: typeof QUALIFICATION_REQUEST_SCHEMA;
  requestID: string;
  /** The route, stage, trigger and benchmark. Two plans proposing the same work share it. */
  lineageKey: string;
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  machineKey: string;
  stage: QualificationStage;
  trigger: QualificationTrigger;
  benchmark: { id: string; version: string };
  /** The sealed cases to run; the smoke has none, only its prompt. */
  caseIDs: string[];
  repeatsPerCase: number;
  /** The most runs this request may spend. Charged against the budget in full, before anything runs. */
  runCount: number;
  costEligibility: CostEligibility;
  qualificationPolicyID: string;
  /** How long a qualification earned by this request would stay current, under that policy. */
  evidenceMaximumAgeMilliseconds: number;
  /** For a renewal: when the qualification being renewed expires. */
  qualificationExpiresAt?: string;
  plannedAt: string;
  /** After this instant the request is not to be run; a later plan proposes it again. */
  expiresAt: string;
  requiresOwnerApproval: true;
  disclosure: string;
}

export type QualificationSkipReason =
  | 'metered' | 'unknownCost' | 'notReachable' | 'smokeDidNotPass' | 'evidenceCurrent' | 'alreadyPlanned' | 'budgetExhausted';

export interface QualificationSkip {
  routeKey: string;
  reason: QualificationSkipReason;
  detail: string;
  stage?: QualificationStage;
  runCount?: number;
  trigger?: QualificationTrigger;
}

/** The budget as charged: what was allowed, what earlier plans used, what this plan adds, and what is left. */
export interface RequestBudget {
  budget: number;
  used: number;
  remaining: number;
  chargedByThisPlan: number;
}

export interface QualificationPlan {
  schema: typeof QUALIFICATION_PLAN_SCHEMA;
  machineKey: string;
  plannedAt: string;
  qualificationPolicyID: string;
  /** Before this plan's charges. */
  ledgerBefore: RequestBudget;
  /** After them. `used` + `remaining` never exceeds `budget`. */
  ledger: RequestBudget;
  ledgerDigest: string;
  requests: QualificationRequest[];
  /** Every route considered and not planned, with why. Budget refusals are here as `budgetExhausted`. */
  skipped: QualificationSkip[];
  disclosure: string;
}

export class QualificationPlanError extends Error {
  constructor(readonly code: 'noBudget' | 'invalidBudget' | 'ledgerTampered' | 'ledgerMoved' | 'requestExists', message: string) {
    super(message);
    this.name = 'QualificationPlanError';
  }
}

// MARK: - The budget ledger

/** A line that states the budget. The newest one in force wins; raising or lowering it is on the record. */
export interface BudgetStatement {
  kind: 'budget';
  budget: number;
  statedAt: string;
  statedBy: string;
  reason: string;
}

/** A line that charges one request's runs. */
export interface BudgetCharge {
  kind: 'charge';
  requestID: string;
  lineageKey: string;
  routeKey: string;
  stage: QualificationStage;
  trigger: QualificationTrigger;
  runCount: number;
  plannedAt: string;
  expiresAt: string;
}

export type RequestBudgetRecord = (BudgetStatement | BudgetCharge) & {
  schema: typeof REQUEST_BUDGET_LEDGER_SCHEMA;
  recordID: string;
  sequence: number;
  previousRecordID?: string;
};

export interface RequestBudgetLedgerContents {
  schema: typeof REQUEST_BUDGET_LEDGER_SCHEMA;
  filePath: string;
  records: RequestBudgetRecord[];
  corrupt: { line: number; reason: string }[];
  /** Absent when no line states a budget: then nothing may be charged. */
  budget?: number;
  used: number;
  ledgerDigest: string;
}

export function qualificationRequestDirectory(root: string): string {
  return path.join(root, '.qualification-requests');
}

export function requestBudgetLedgerPath(root: string): string {
  return path.join(qualificationRequestDirectory(root), 'budget.jsonl');
}

function digestableBudgetRecord(record: Omit<RequestBudgetRecord, 'recordID'>): CanonicalValue {
  const { recordID: _ignored, ...rest } = record as RequestBudgetRecord;
  return rest as unknown as CanonicalValue;
}

export function sealBudgetRecord(record: (BudgetStatement | BudgetCharge) & { sequence: number; previousRecordID?: string }): RequestBudgetRecord {
  const withSchema = { ...record, schema: REQUEST_BUDGET_LEDGER_SCHEMA } as Omit<RequestBudgetRecord, 'recordID'>;
  return { ...withSchema, recordID: digestObject(digestableBudgetRecord(withSchema)) } as RequestBudgetRecord;
}

function budgetLineFault(text: string, previous: RequestBudgetRecord | undefined): RequestBudgetRecord | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return `the line is not readable JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the line is not a budget ledger record';
  const record = parsed as RequestBudgetRecord;
  if (record.schema !== REQUEST_BUDGET_LEDGER_SCHEMA) return `schema is '${String(record.schema)}', not ${REQUEST_BUDGET_LEDGER_SCHEMA}`;
  if (record.kind === 'budget') {
    if (!Number.isSafeInteger(record.budget) || record.budget < 0) return 'the budget is not a whole number of runs';
  } else if (record.kind === 'charge') {
    if (!Number.isSafeInteger(record.runCount) || record.runCount < 1) return 'the charge is not a positive whole number of runs';
  } else {
    return `kind '${String((record as { kind?: unknown }).kind)}' is neither budget nor charge`;
  }
  let recomputed: string;
  try {
    recomputed = digestObject(digestableBudgetRecord(record));
  } catch (error) {
    return `the record could not be canonically encoded: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (recomputed !== record.recordID) {
    return `content digests to ${recomputed.slice(0, 16)}… but the record is named ${String(record.recordID).slice(0, 16)}…`;
  }
  const expected = (previous?.sequence ?? 0) + 1;
  if (record.sequence !== expected) return `the record says it is number ${record.sequence}, but it is number ${expected} in the ledger`;
  if (record.previousRecordID !== previous?.recordID) return 'the record does not name the line before it as its predecessor';
  return record;
}

/** Totals over intact records. Pure. */
export function summariseBudgetRecords(records: RequestBudgetRecord[]): { budget?: number; used: number } {
  let budget: number | undefined;
  let used = 0;
  for (const record of records) {
    if (record.kind === 'budget') budget = record.budget;
    else used += record.runCount;
  }
  return { ...(budget === undefined ? {} : { budget }), used };
}

/**
 * Read and verify the budget ledger. READ-ONLY: an absent ledger is an empty one with no budget.
 * The first line that fails, and every line after it, is refused, as in the release ledger.
 */
export function readRequestBudgetLedger(root: string): RequestBudgetLedgerContents {
  const filePath = requestBudgetLedgerPath(root);
  const records: RequestBudgetRecord[] = [];
  const corrupt: { line: number; reason: string }[] = [];
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let broken: number | undefined;
    lines.forEach((text, index) => {
      const line = index + 1;
      if (broken !== undefined) { corrupt.push({ line, reason: `follows line ${broken}, which did not verify` }); return; }
      const fault = budgetLineFault(text, records[records.length - 1]);
      if (typeof fault === 'string') { corrupt.push({ line, reason: fault }); broken = line; return; }
      records.push(fault);
    });
  }
  return {
    schema: REQUEST_BUDGET_LEDGER_SCHEMA, filePath, records, corrupt,
    ...summariseBudgetRecords(records),
    ledgerDigest: digestObject(records.map((record) => record.recordID)),
  };
}

/** Append a budget statement. Refused on a ledger that does not verify. */
export function stateRequestBudget(root: string, statement: Omit<BudgetStatement, 'kind'>): RequestBudgetRecord {
  if (!Number.isSafeInteger(statement.budget) || statement.budget < 0) {
    throw new QualificationPlanError('invalidBudget', `a budget is a whole number of runs, not ${String(statement.budget)}.`);
  }
  const ledger = readRequestBudgetLedger(root);
  refuseCorrupt(ledger);
  const previous = ledger.records[ledger.records.length - 1];
  const record = sealBudgetRecord({
    kind: 'budget', ...statement, sequence: (previous?.sequence ?? 0) + 1,
    ...(previous === undefined ? {} : { previousRecordID: previous.recordID }),
  });
  appendLines(ledger.filePath, [JSON.stringify(record)]);
  return record;
}

function refuseCorrupt(ledger: RequestBudgetLedgerContents): void {
  if (ledger.corrupt.length > 0) {
    throw new QualificationPlanError('ledgerTampered', `${ledger.corrupt.length} line(s) of ${ledger.filePath} did not verify `
      + `(first: line ${ledger.corrupt[0].line}, ${ledger.corrupt[0].reason}). A budget charged against a ledger nobody can `
      + 'trust could hide spending, so nothing was written.');
  }
}

// MARK: - Planning

const isoOf = (milliseconds: number): string => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');

const instant = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export interface QualificationPlanInputs {
  now: Date;
  machineKey: string;
  releaseReport?: ReleaseReport;
  delta?: DiscoveryDeltaReport;
  /** The snapshot the report and the delta were taken from. Consulted for listing availability only. */
  snapshot?: DiscoverySnapshot;
  histories: QualificationHistory[];
  ledger: Pick<RequestBudgetLedgerContents, 'records' | 'corrupt' | 'budget' | 'used' | 'ledgerDigest'>;
  smokeResults?: QualificationSmokeResult[];
  /** Zero-marginal-cost confirmations, handed to `costEligibilityFor` unchanged. No override is ever consulted. */
  costConfirmations?: ZeroMarginalCostConfirmation[];
  policy?: QualificationPolicy;
  renewalWindowMilliseconds?: number;
  requestValidityMilliseconds?: number;
}

interface Candidate {
  routeKey: string;
  provider: ProviderID;
  modelID: string;
  /** Every route key that names this model. */
  routeKeys: string[];
  trigger?: QualificationTrigger;
  qualificationExpiresAt?: string;
  history?: QualificationHistory;
}

/** The order requests are charged in. */
const TRIGGER_ORDER: Record<QualificationTriggerKind, number> = { renewal: 0, changed: 1, new: 2 };
/** Which trigger wins when two name one route. */
const TRIGGER_PRECEDENCE: Record<QualificationTriggerKind, number> = { renewal: 0, new: 1, changed: 2 };

function splitRouteKey(routeKey: string): { provider: ProviderID; modelID: string } {
  const at = routeKey.indexOf(':');
  return { provider: routeKey.slice(0, at) as ProviderID, modelID: routeKey.slice(at + 1) };
}

/** The newest verdict, and when the qualification it states stops being current. */
function latestEvidence(history: QualificationHistory | undefined, policy: QualificationPolicy):
  { safe: boolean; evidenceTo: number; expiresAt: number } | undefined {
  const latest = history?.entries[history.entries.length - 1];
  if (latest === undefined) return undefined;
  const evidenceTo = instant(latest.evidenceWindow.to);
  if (evidenceTo === undefined) return undefined;
  return { safe: latest.verdict === 'safeToRoute', evidenceTo, expiresAt: evidenceTo + policy.maximumAgeMilliseconds };
}

function lineageKeyOf(routeKey: string, stage: QualificationStage, trigger: QualificationTrigger, benchmark: { id: string; version: string }): string {
  return digestObject({ routeKey, stage, triggerKind: trigger.kind, since: trigger.since, benchmark: `${benchmark.id}@${benchmark.version}` });
}

/**
 * The plan. PURE: every input is a value, nothing is read or written, nothing is run.
 *
 * Routes are considered renewals first, then changed, then new, each group by route key, and charged in that
 * order: an expiring qualification of a route already in use is protected before a new model is explored.
 */
export function deriveQualificationPlan(inputs: QualificationPlanInputs): QualificationPlan {
  const policy = inputs.policy ?? V1_QUALIFICATION_POLICY;
  const now = inputs.now.getTime();
  const plannedAt = isoOf(now);
  const renewalWindow = inputs.renewalWindowMilliseconds ?? RENEWAL_WINDOW_MILLISECONDS;
  const validity = inputs.requestValidityMilliseconds ?? REQUEST_VALIDITY_MILLISECONDS;
  if (inputs.ledger.corrupt.length > 0) {
    throw new QualificationPlanError('ledgerTampered', `${inputs.ledger.corrupt.length} budget ledger line(s) did not verify `
      + `(first: line ${inputs.ledger.corrupt[0].line}, ${inputs.ledger.corrupt[0].reason}). Nothing was planned.`);
  }
  if (inputs.ledger.budget === undefined) {
    throw new QualificationPlanError('noBudget', 'the budget ledger states no budget, so no run may be charged. State one '
      + 'explicitly (--budget) before planning. Nothing was planned.');
  }

  // THE CANDIDATES, one per model, keyed by canonical route key.
  const candidates = new Map<string, Candidate>();
  const candidate = (routeKey: string, routeKeys: string[]): Candidate => {
    const existing = candidates.get(routeKey);
    if (existing !== undefined) {
      existing.routeKeys = [...new Set([...existing.routeKeys, ...routeKeys])].sort(compareCodePoints);
      return existing;
    }
    const created: Candidate = { routeKey, ...splitRouteKey(routeKey), routeKeys: [...new Set([routeKey, ...routeKeys])].sort(compareCodePoints) };
    candidates.set(routeKey, created);
    return created;
  };
  const offer = (entry: Candidate, trigger: QualificationTrigger): void => {
    const current = entry.trigger;
    if (current === undefined || TRIGGER_PRECEDENCE[trigger.kind] > TRIGGER_PRECEDENCE[current.kind]) {
      // A change outranks a release, and both outrank a renewal: each stales the evidence the next would extend.
      entry.trigger = trigger;
    } else if (trigger.kind === current.kind && compareCodePoints(trigger.since, current.since) < 0) {
      entry.trigger = { ...current, since: trigger.since, detail: [...new Set([...trigger.detail, ...current.detail])] };
    }
  };

  for (const model of inputs.releaseReport?.newModels ?? []) {
    offer(candidate(model.canonicalRouteKey, model.routeKeys), {
      kind: 'new', since: model.firstObservedAt, invalidatesEvidence: true, carriedFromLedger: false,
      detail: [`first reported by release report ${inputs.releaseReport!.schema}; first observed ${model.firstObservedAt}`],
    });
  }
  for (const model of inputs.delta?.new ?? []) {
    offer(candidate(model.canonicalRouteKey, model.routeKeys), {
      kind: 'new', since: inputs.delta!.afterTakenAt, invalidatesEvidence: true, carriedFromLedger: false,
      detail: [`listed for the first time in the snapshot taken ${inputs.delta!.afterTakenAt}`],
    });
  }
  for (const model of inputs.delta?.changed ?? []) {
    offer(candidate(model.canonicalRouteKey, model.routeKeys), changedTrigger(model, inputs.delta!));
  }
  for (const history of inputs.histories) {
    // A history is attached to the model whose route keys name it, or stands as its own candidate.
    const owner = [...candidates.values()].find((entry) => entry.routeKeys.includes(history.routeKey))
      ?? candidate(history.routeKey, [history.routeKey]);
    owner.history = history;
    const evidence = latestEvidence(history, policy);
    if (evidence?.safe === true && evidence.expiresAt - now <= renewalWindow) {
      owner.qualificationExpiresAt = isoOf(evidence.expiresAt);
      offer(owner, {
        kind: 'renewal', since: isoOf(evidence.expiresAt - renewalWindow), invalidatesEvidence: false, carriedFromLedger: false,
        detail: [`the ${policy.policyID} qualification resting on evidence to ${isoOf(evidence.evidenceTo)} `
          + `${evidence.expiresAt <= now ? 'expired' : 'expires'} ${isoOf(evidence.expiresAt)}`],
      });
    }
  }
  // A SMOKE PLANNED EARLIER STILL OWES ITS DISCRIMINATOR, even once the model is no longer new to the report.
  const charges = inputs.ledger.records.filter((record): record is RequestBudgetRecord & BudgetCharge => record.kind === 'charge');
  for (const charge of charges) {
    if (charge.stage !== 'smoke') continue;
    const followed = charges.some((other) => other.stage === 'discriminator' && other.routeKey === charge.routeKey
      && compareCodePoints(other.trigger.since, charge.trigger.since) >= 0);
    if (followed) continue;
    const entry = candidates.get(charge.routeKey) ?? candidate(charge.routeKey, [charge.routeKey]);
    if (entry.trigger === undefined) entry.trigger = { ...charge.trigger, carriedFromLedger: true };
  }

  const ledgerBefore: RequestBudget = {
    budget: inputs.ledger.budget, used: inputs.ledger.used,
    remaining: Math.max(inputs.ledger.budget - inputs.ledger.used, 0), chargedByThisPlan: 0,
  };
  let remaining = ledgerBefore.remaining;
  let charged = 0;
  const requests: QualificationRequest[] = [];
  const skipped: QualificationSkip[] = [];

  const ordered = [...candidates.values()].sort((a, b) =>
    (a.trigger === undefined ? 9 : TRIGGER_ORDER[a.trigger.kind]) - (b.trigger === undefined ? 9 : TRIGGER_ORDER[b.trigger.kind])
    || compareCodePoints(a.routeKey, b.routeKey));

  for (const entry of ordered) {
    const evidence = latestEvidence(entry.history, policy);
    const skip = (reason: QualificationSkipReason, detail: string, extra: Partial<QualificationSkip> = {}): void => {
      skipped.push({ routeKey: entry.routeKey, reason, detail, ...(entry.trigger === undefined ? {} : { trigger: entry.trigger }), ...extra });
    };

    // 1. WHO PAYS. Decided before anything else, and with no override: metered is never planned.
    const cost = costEligibilityFor({ provider: entry.provider, modelID: entry.modelID,
      ...(inputs.costConfirmations === undefined ? {} : { confirmations: inputs.costConfirmations }) });
    if (cost.eligibility === 'metered') { skip('metered', cost.reason); continue; }
    if (cost.eligibility === 'unknown_cost') { skip('unknownCost', cost.reason); continue; }

    // 2. CURRENT AND UNCHANGED. No trigger, or a trigger the evidence already postdates.
    const current = evidence !== undefined && evidence.safe && evidence.expiresAt - now > renewalWindow;
    if (entry.trigger === undefined) {
      skip('evidenceCurrent', current
        ? `the latest verdict is safe to route and the ${policy.policyID} qualification is current until ${isoOf(evidence!.expiresAt)}; nothing changed`
        : 'nothing new, changed or expiring names this route, so nothing is due');
      continue;
    }
    const trigger = entry.trigger;
    if (current && (!trigger.invalidatesEvidence || evidence!.evidenceTo >= Date.parse(trigger.since))) {
      skip('evidenceCurrent', `the latest verdict is safe to route on evidence to ${isoOf(evidence!.evidenceTo)}, which postdates `
        + `the ${trigger.kind} trigger, and stays current until ${isoOf(evidence!.expiresAt)}`);
      continue;
    }

    // 3. REACHABLE. Only the listing's own availability and recorded smokes say so.
    const listedRoutes = (inputs.snapshot?.routes ?? []).filter((route) => entry.routeKeys.includes(route.routeKey));
    if (listedRoutes.length > 0 && listedRoutes.every((route) => route.availability === 'refused')) {
      skip('notReachable', `the listing records ${listedRoutes.map((route) => route.routeKey).join(', ')} as refused`);
      continue;
    }
    const since = Date.parse(trigger.since);
    const smoke = (inputs.smokeResults ?? [])
      .filter((result) => entry.routeKeys.includes(result.routeKey) && (instant(result.observedAt) ?? -Infinity) >= since)
      .sort((a, b) => compareCodePoints(a.observedAt, b.observedAt)).pop();
    if (smoke?.outcome === 'refused') {
      skip('notReachable', `the identity smoke of ${smoke.routeKey} at ${smoke.observedAt} was refused (${smoke.source})`);
      continue;
    }
    if (smoke?.outcome === 'failed') {
      skip('smokeDidNotPass', `the identity smoke of ${smoke.routeKey} at ${smoke.observedAt} did not pass (${smoke.source}); `
        + 'a discriminator matrix follows only a passing smoke, and a failed smoke is left to the owner rather than retried');
      continue;
    }

    // 4. ONE REQUEST: smoke first, the discriminator only after a smoke that passed since the trigger.
    const stage: QualificationStage = smoke?.outcome === 'passed' ? 'discriminator' : 'smoke';
    const benchmark = stage === 'smoke'
      ? { id: IDENTITY_SMOKE_BENCHMARK.id, version: IDENTITY_SMOKE_BENCHMARK.version }
      : { id: WORKSPACE_PACK_DISCRIMINATOR_ONE, version: discriminatorOnePack.version };
    const caseIDs = stage === 'smoke' ? [] : [...discriminatorOnePack.caseIDs];
    const repeatsPerCase = stage === 'smoke' ? IDENTITY_SMOKE_BENCHMARK.runs : discriminatorOnePack.repeatsPerCase;
    const runCount = stage === 'smoke' ? IDENTITY_SMOKE_BENCHMARK.runs : caseIDs.length * repeatsPerCase;
    const lineageKey = lineageKeyOf(entry.routeKey, stage, trigger, benchmark);

    // 5. ALREADY PLANNED. An unexpired charge for the same work is not charged again.
    const earlier = charges.find((charge) => charge.lineageKey === lineageKey && Date.parse(charge.expiresAt) > now);
    if (earlier !== undefined) {
      skip('alreadyPlanned', `request ${earlier.requestID.slice(0, 16)}… for the same work was planned ${earlier.plannedAt} and is `
        + `valid until ${earlier.expiresAt}`, { stage, runCount });
      continue;
    }

    // 6. THE BUDGET. Refused whole, never shrunk to fit.
    if (runCount > remaining) {
      skip('budgetExhausted', `the ${stage} request needs ${runCount} run(s) and the budget has ${remaining} of `
        + `${ledgerBefore.budget} left`, { stage, runCount });
      continue;
    }
    remaining -= runCount;
    charged += runCount;

    const body: Omit<QualificationRequest, 'requestID'> = {
      schema: QUALIFICATION_REQUEST_SCHEMA,
      lineageKey,
      routeKey: entry.routeKey, provider: entry.provider, modelID: entry.modelID, machineKey: inputs.machineKey,
      stage, trigger: { ...trigger, detail: [...trigger.detail, ...(smoke === undefined ? []
        : [`identity smoke passed at ${smoke.observedAt} (${smoke.source})`])] },
      benchmark, caseIDs, repeatsPerCase, runCount,
      costEligibility: cost.eligibility,
      qualificationPolicyID: policy.policyID,
      evidenceMaximumAgeMilliseconds: policy.maximumAgeMilliseconds,
      ...(trigger.kind === 'renewal' && entry.qualificationExpiresAt !== undefined ? { qualificationExpiresAt: entry.qualificationExpiresAt } : {}),
      plannedAt,
      expiresAt: isoOf(now + validity),
      requiresOwnerApproval: true,
      disclosure: stage === 'smoke'
        ? `One identity smoke ("${IDENTITY_SMOKE_PROMPT}"). Planned, not run: a runner runs it only once an owner approves this file.`
        : `The discriminator matrix, ${caseIDs.length} sealed case(s) x ${repeatsPerCase}. Planned, not run: a runner runs it only `
          + 'once an owner approves this file, and never past runCount.',
    };
    requests.push({ ...body, requestID: digestObject(body as unknown as CanonicalValue) });
  }

  return {
    schema: QUALIFICATION_PLAN_SCHEMA,
    machineKey: inputs.machineKey,
    plannedAt,
    qualificationPolicyID: policy.policyID,
    ledgerBefore,
    ledger: { budget: ledgerBefore.budget, used: ledgerBefore.used + charged, remaining, chargedByThisPlan: charged },
    ledgerDigest: inputs.ledger.ledgerDigest,
    requests,
    skipped,
    disclosure: QUALIFICATION_PLAN_DISCLOSURE,
  };
}

function changedTrigger(model: DiscoveryDeltaModel, delta: DiscoveryDeltaReport): QualificationTrigger {
  const detail = model.changes.length > 0
    ? model.changes.map((change) => `${change.routeKey} ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`)
    : model.detail;
  return {
    kind: 'changed', since: delta.afterTakenAt, carriedFromLedger: false,
    // Only a material change stales a qualification; a moved availability or a new alias does not.
    invalidatesEvidence: model.qualificationNowStale,
    detail: [`changed between ${delta.beforeTakenAt ?? '(no earlier snapshot)'} and ${delta.afterTakenAt}`, ...detail],
  };
}

// MARK: - Writing

/** Where a request's file goes: its stage, its route, and its id, so two never share a name. */
export function qualificationRequestFileName(request: QualificationRequest): string {
  const route = request.routeKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${request.plannedAt.replace(/[:]/g, '')}-${request.stage}-${route}-${request.requestID.slice(0, 12)}.json`;
}

/**
 * Write each request as a file and charge it on the ledger. NOT AN EXECUTION: files and ledger lines only.
 *
 * Re-checked against the ledger as it is now: one that moved since the plan was derived (another plan
 * charged in between) or does not verify is refused, and nothing is written. Request files are created
 * exclusively; one that already exists is refused rather than overwritten.
 */
export function writeQualificationPlan(root: string, plan: QualificationPlan): { files: string[]; charged: RequestBudgetRecord[] } {
  const ledger = readRequestBudgetLedger(root);
  refuseCorrupt(ledger);
  if (ledger.ledgerDigest !== plan.ledgerDigest) {
    throw new QualificationPlanError('ledgerMoved', `${ledger.filePath} changed since this plan was derived, so its charges may `
      + 'no longer fit the budget. Plan again. Nothing was written.');
  }
  if (plan.requests.length === 0) return { files: [], charged: [] };
  const directory = path.join(qualificationRequestDirectory(root), 'requests');
  fs.mkdirSync(directory, { recursive: true });
  const targets = plan.requests.map((request) => path.join(directory, qualificationRequestFileName(request)));
  const existing = targets.find((target) => fs.existsSync(target));
  if (existing !== undefined) {
    throw new QualificationPlanError('requestExists', `${existing} already exists and is not overwritten. Nothing was written.`);
  }
  // THE CHARGES FIRST. A charge whose file failed to land is a run counted and not spent, which is the safe
  // direction; a file without its charge would be a run nobody counted.
  let previous = ledger.records[ledger.records.length - 1];
  const charged: RequestBudgetRecord[] = [];
  for (const request of plan.requests) {
    const record = sealBudgetRecord({
      kind: 'charge', requestID: request.requestID, lineageKey: request.lineageKey, routeKey: request.routeKey,
      stage: request.stage, trigger: request.trigger, runCount: request.runCount, plannedAt: request.plannedAt,
      expiresAt: request.expiresAt, sequence: (previous?.sequence ?? 0) + 1,
      ...(previous === undefined ? {} : { previousRecordID: previous.recordID }),
    });
    charged.push(record);
    previous = record;
  }
  appendLines(ledger.filePath, charged.map((record) => JSON.stringify(record)));
  plan.requests.forEach((request, index) => {
    fs.writeFileSync(targets[index], `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  });
  return { files: targets, charged };
}

function appendLines(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(handle, lines.map((line) => `${line}\n`).join(''));
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
}

/** The plan, in lines a person reads. */
export function describeQualificationPlan(plan: QualificationPlan): string[] {
  const lines = [
    `Qualification plan ${plan.schema} · ${plan.qualificationPolicyID} · machine ${plan.machineKey} · ${plan.plannedAt}`,
    `  budget ${plan.ledger.budget} run(s) · used ${plan.ledgerBefore.used} before · this plan ${plan.ledger.chargedByThisPlan} · `
      + `remaining ${plan.ledger.remaining}`,
    `  ${plan.requests.length} request(s) · ${plan.skipped.length} route(s) not planned`,
  ];
  if (plan.requests.length > 0) lines.push('', 'PLANNED (not run; each needs an owner\'s approval)');
  for (const request of plan.requests) {
    lines.push(`  ${request.routeKey}  ${request.stage} · ${request.benchmark.id}@${request.benchmark.version} · ${request.runCount} run(s)`
      + ` · ${request.trigger.kind}${request.trigger.carriedFromLedger ? ' (carried)' : ''} · expires ${request.expiresAt}`);
    for (const sentence of request.trigger.detail) lines.push(`    ${sentence}`);
  }
  if (plan.skipped.length > 0) lines.push('', 'NOT PLANNED');
  for (const entry of plan.skipped) lines.push(`  ${entry.routeKey}  ${entry.reason}: ${entry.detail}`);
  return lines;
}
