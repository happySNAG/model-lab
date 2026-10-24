// Benchmark engine · THE APPEND-ONLY LOG OF WHAT `candidates` ANSWERED, and why the answer moved.
//
// WHY THIS EXISTS. A candidate set is derived at read time from evidence, and nothing about it was
// kept: the next answer to the same query replaced the last one on screen, so "which routes did Cernum
// say were qualified for this on Tuesday, and what changed since" could not be asked. Ordra routes work
// on these answers, and a routing decision nobody can reconstruct is a decision nobody can audit.
//
// WHAT IT IS. One sealed, content-addressed record per logged answer, under `<root>/.routing-decisions`,
// written only when the caller asks (`cernum candidates … --log`). Each record holds the query, the
// answer, the routing contract, routing policy and qualification policy versions, the instant it was
// decided, and — against the PREVIOUS logged answer to the same query — every route added, removed or
// reordered among the candidates, each with its cause, and every policy version that moved.
//
// THE RULES, copied from the observation store and extended by one.
//
//   IDENTITY IS THE CONTENT. `recordID` is the digest of every other field under the canonical
//   encoding, and it is the file's name. A record whose bytes no longer digest to its name, or that sits
//   under another record's name, is REFUSED: reported by path with its reason and never read into an
//   answer.
//   NOTHING IS REWRITTEN. An existing record is never overwritten, corrected or deleted; a newer answer
//   is a new record that names the one before it.
//   THE CHAIN IS PART OF THE CHECK. Each record names the previous answer to its query and states the
//   change from it. On read the previous must be present, must be an answer to the same query, and the
//   stated change must be exactly what the two answers imply. A removed record, a record re-sealed with
//   a doctored answer, or a change that does not follow from its predecessor is refused like a bad
//   digest. What a chain cannot see is the newest record removed whole; `logDigest` is the value a
//   reader keeps outside this directory to notice that.
//   A TAMPERED LOG IS NOT APPENDED TO. A change reason computed against a predecessor nobody can trust
//   would be a confident falsehood, so `appendRoutingDecision` writes nothing while any record fails.
//
// NOTHING HERE READS A CLOCK, CONTACTS ANYTHING OR DECIDES A ROUTE. `decidedAt` is the caller's, the
// answer is the one `qualifiedRouteCandidates` already gave, and the log only records it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, canonicalJSON, compareCodePoints, digestObject } from './canonical';
import { atomicWriteJSON } from './ledger';
import { V1_QUALIFICATION_POLICY } from './route-qualification';
import { RouteCandidate, RouteCandidateQuery, RouteCandidateSet } from './routing-contract';

export const ROUTING_DECISION_LOG_SCHEMA = 'crd1';

/** One candidate as the log keeps it: what a later reader needs to see why it was there, no more. */
export interface LoggedCandidate {
  routeKey: string;
  /** Zero-based place in the answer, which is the order `candidates` printed. */
  position: number;
  group: RouteCandidate['group'];
  locality: RouteCandidate['locality'];
  identityConfidence: string;
  identityAdmitted: boolean;
  availabilityState: string;
  capabilityVerdict: string;
  capabilityReason: string;
  /** The qualification policy the route's record was derived under. */
  qualificationPolicyID: string;
}

export interface LoggedAnswer {
  contract: string;
  routingPolicyVersion: string;
  candidates: LoggedCandidate[];
  excluded: { routeKey: string; reasons: string[] }[];
  ordering: string;
}

export interface DecisionPolicies {
  routingContract: string;
  routingPolicy: string;
  /** Every qualification policy that decided a route in this answer, sorted. */
  qualificationPolicies: string[];
}

export interface AddedRoute { routeKey: string; position: number; group: string; causes: string[] }
export interface RemovedRoute { routeKey: string; previousPosition: number; causes: string[] }
export interface ReorderedRoute { routeKey: string; from: number; to: number; causes: string[] }
export interface PolicyChange { policy: 'routingContract' | 'routingPolicy' | 'qualificationPolicies'; from: string; to: string }

/**
 * What moved since the previous logged answer to the same query.
 *
 * `firstAnswer` when there is no previous one; `unchanged` when the candidates, their order and every
 * policy version are the same; `changed` otherwise. Exclusion reasons that moved without moving a
 * candidate are counted in `exclusionsChanged` and are not by themselves a change of answer.
 */
export interface DecisionChange {
  basis: 'firstAnswer' | 'unchanged' | 'changed';
  added: AddedRoute[];
  removed: RemovedRoute[];
  reordered: ReorderedRoute[];
  policyChanges: PolicyChange[];
  exclusionsChanged: number;
}

/** One logged answer. Every field but `recordID` is inside the digest. */
export interface RoutingDecisionRecord {
  schema: typeof ROUTING_DECISION_LOG_SCHEMA;
  recordID: string;
  /** When the answer was given. Supplied by the caller; nothing here reads a clock. */
  decidedAt: string;
  /** The machine the query asked about. */
  machineKey: string;
  /** The digest of the query WITHOUT its routing policy version: the key "the same query" is matched on. */
  queryDigest: string;
  query: RouteCandidateQuery;
  answer: LoggedAnswer;
  policies: DecisionPolicies;
  /** The previous logged answer to the same query. Absent only on the first. */
  previousDecisionID?: string;
  change: DecisionChange;
  provenance: string;
}

export interface CorruptDecision { filePath: string; reason: string }

export interface RoutingDecisionLogContents {
  schema: typeof ROUTING_DECISION_LOG_SCHEMA;
  root: string;
  /** Every record that verified, oldest first (decidedAt, then recordID). */
  decisions: RoutingDecisionRecord[];
  /** Every file that did not verify, or whose chain did not. A non-empty list is a finding. */
  corrupt: CorruptDecision[];
  /** The digest of every verified recordID, sorted: keep it elsewhere to notice a removed newest record. */
  logDigest: string;
}

export class RoutingDecisionLogError extends Error {
  constructor(readonly code: 'logTampered' | 'outOfOrder' | 'unencodable', message: string) {
    super(message);
    this.name = 'RoutingDecisionLogError';
  }
}

// MARK: - Identity

/**
 * The query as "the same query" is decided: everything but the routing policy version.
 *
 * The policy version is left out ON PURPOSE. Asking the same question under crp1 and then crp2 is the
 * same question decided under two rules, and the log's job is to say that the rule changed and what it
 * moved — which it can only do if the two answers are recognised as answers to one query.
 */
export function routingQueryDigest(query: RouteCandidateQuery): string {
  const { routingPolicyVersion: _policy, ...rest } = query;
  return digestObject(rest as unknown as CanonicalValue);
}

function digestableDecision(record: Omit<RoutingDecisionRecord, 'recordID'>): CanonicalValue {
  return {
    schema: record.schema,
    decidedAt: record.decidedAt,
    machineKey: record.machineKey,
    queryDigest: record.queryDigest,
    query: record.query as unknown as CanonicalValue,
    answer: record.answer as unknown as CanonicalValue,
    policies: record.policies as unknown as CanonicalValue,
    previousDecisionID: record.previousDecisionID,
    change: record.change as unknown as CanonicalValue,
    provenance: record.provenance,
  } as CanonicalValue;
}

export function sealRoutingDecision(record: Omit<RoutingDecisionRecord, 'recordID' | 'schema'>): RoutingDecisionRecord {
  const withSchema: Omit<RoutingDecisionRecord, 'recordID'> = { ...record, schema: ROUTING_DECISION_LOG_SCHEMA };
  return { ...withSchema, recordID: digestObject(digestableDecision(withSchema)) };
}

/** Does this record's content still digest to its own name, and does its query still digest to its key? */
export function verifyRoutingDecisionRecord(record: RoutingDecisionRecord): { intact: boolean; reason: string } {
  if (record.schema !== ROUTING_DECISION_LOG_SCHEMA) {
    return { intact: false, reason: `schema is '${String(record.schema)}', not ${ROUTING_DECISION_LOG_SCHEMA}` };
  }
  for (const field of ['recordID', 'decidedAt', 'machineKey', 'queryDigest', 'provenance'] as const) {
    if (typeof record[field] !== 'string' || String(record[field]).trim().length === 0) {
      return { intact: false, reason: `${field} is missing or empty` };
    }
  }
  for (const field of ['query', 'answer', 'policies', 'change'] as const) {
    if (record[field] === null || typeof record[field] !== 'object' || Array.isArray(record[field])) {
      return { intact: false, reason: `${field} is missing or not an object` };
    }
  }
  let recomputed: string;
  let queryDigest: string;
  try {
    recomputed = digestObject(digestableDecision(record));
    queryDigest = routingQueryDigest(record.query);
  } catch (error) {
    return { intact: false, reason: `the record could not be canonically encoded: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (recomputed !== record.recordID) {
    return { intact: false, reason: `content digests to ${recomputed.slice(0, 16)}… but the record is named ${record.recordID.slice(0, 16)}…` };
  }
  if (queryDigest !== record.queryDigest) {
    return { intact: false, reason: `the query digests to ${queryDigest.slice(0, 16)}… but the record files it under ${record.queryDigest.slice(0, 16)}…` };
  }
  return { intact: true, reason: 'the content digests to its own recordID' };
}

// MARK: - The answer, as logged

/** The candidate set as the log keeps it. Pure. */
export function loggedAnswer(set: RouteCandidateSet): LoggedAnswer {
  return {
    contract: set.contract,
    routingPolicyVersion: set.routingPolicyVersion,
    candidates: set.candidates.map((candidate, position) => ({
      routeKey: candidate.routeKey,
      position,
      group: candidate.group,
      locality: candidate.locality,
      identityConfidence: candidate.identityConfidence,
      identityAdmitted: candidate.identityAdmitted,
      availabilityState: candidate.availability.state,
      capabilityVerdict: candidate.capabilityEvidence.verdict,
      capabilityReason: candidate.capabilityEvidence.reason,
      qualificationPolicyID: candidate.record.policy.policyID,
    })),
    excluded: set.excluded.map((entry) => ({ routeKey: entry.routeKey, reasons: [...entry.reasons] })),
    ordering: set.ordering,
  };
}

function policiesOf(answer: LoggedAnswer, qualificationPolicyID: string): DecisionPolicies {
  const qualification = new Set([qualificationPolicyID, ...answer.candidates.map((entry) => entry.qualificationPolicyID)]);
  return {
    routingContract: answer.contract,
    routingPolicy: answer.routingPolicyVersion,
    qualificationPolicies: [...qualification].sort(compareCodePoints),
  };
}

// MARK: - The change, and its causes

/**
 * What moved between two answers to the same query, with a cause for every move. Pure.
 *
 * REORDERED MEANS RELATIVE ORDER, NOT INDEX. A route that slid one place because another was added
 * ahead of it has not been reordered — the addition is the change, and it is reported as one. Only a
 * route whose order against the OTHER surviving routes moved is listed as reordered.
 */
export function decisionChange(previous: { answer: LoggedAnswer; policies: DecisionPolicies } | undefined,
                               current: { answer: LoggedAnswer; policies: DecisionPolicies }): DecisionChange {
  if (previous === undefined) {
    return { basis: 'firstAnswer', added: [], removed: [], reordered: [], policyChanges: [], exclusionsChanged: 0 };
  }
  const policyChanges: PolicyChange[] = [];
  if (previous.policies.routingContract !== current.policies.routingContract) {
    policyChanges.push({ policy: 'routingContract', from: previous.policies.routingContract, to: current.policies.routingContract });
  }
  if (previous.policies.routingPolicy !== current.policies.routingPolicy) {
    policyChanges.push({ policy: 'routingPolicy', from: previous.policies.routingPolicy, to: current.policies.routingPolicy });
  }
  const before = previous.policies.qualificationPolicies.join(',');
  const after = current.policies.qualificationPolicies.join(',');
  if (before !== after) policyChanges.push({ policy: 'qualificationPolicies', from: before, to: after });
  const policyCauses = policyChanges.map((entry) => `${entry.policy} changed from ${entry.from} to ${entry.to}`);

  const was = new Map(previous.answer.candidates.map((entry) => [entry.routeKey, entry]));
  const now = new Map(current.answer.candidates.map((entry) => [entry.routeKey, entry]));
  const wasExcluded = new Map(previous.answer.excluded.map((entry) => [entry.routeKey, entry.reasons]));
  const nowExcluded = new Map(current.answer.excluded.map((entry) => [entry.routeKey, entry.reasons]));

  const added: AddedRoute[] = current.answer.candidates.filter((entry) => !was.has(entry.routeKey)).map((entry) => {
    const excludedBefore = wasExcluded.get(entry.routeKey);
    return {
      routeKey: entry.routeKey, position: entry.position, group: entry.group,
      causes: [
        excludedBefore === undefined
          ? 'not considered in the previous answer: it had no availability observation on this machine then'
          : `previously excluded: ${excludedBefore.join('; ')}`,
        `now qualified: ${entry.capabilityReason}`,
        ...policyCauses,
      ],
    };
  });
  const removed: RemovedRoute[] = previous.answer.candidates.filter((entry) => !now.has(entry.routeKey)).map((entry) => {
    const excludedNow = nowExcluded.get(entry.routeKey);
    return {
      routeKey: entry.routeKey, previousPosition: entry.position,
      causes: [
        ...(excludedNow === undefined
          ? ['no longer considered: it has no availability observation on this machine now'] : excludedNow.map((reason) => `now excluded: ${reason}`)),
        ...policyCauses,
      ],
    };
  });

  const survivors = (answer: LoggedAnswer) => answer.candidates.filter((entry) => was.has(entry.routeKey) && now.has(entry.routeKey))
    .map((entry) => entry.routeKey);
  const oldOrder = survivors(previous.answer);
  const newOrder = survivors(current.answer);
  const regrouped = newOrder.filter((routeKey) => was.get(routeKey)!.group !== now.get(routeKey)!.group);
  const reordered: ReorderedRoute[] = newOrder.filter((routeKey, index) => oldOrder.indexOf(routeKey) !== index).map((routeKey) => {
    const from = was.get(routeKey)!;
    const to = now.get(routeKey)!;
    const others = regrouped.filter((other) => other !== routeKey);
    return {
      routeKey, from: from.position, to: to.position,
      causes: [
        ...(from.group !== to.group ? [`its group changed from ${from.group} to ${to.group}`] : []),
        ...(others.length > 0 ? [`moved relative to ${others.join(', ')}, whose group changed`] : []),
        ...(previous.answer.ordering !== current.answer.ordering
          ? [`the ordering rule changed from '${previous.answer.ordering}' to '${current.answer.ordering}'`] : []),
        ...policyCauses,
      ],
    };
  });

  const exclusionKey = (reasons: string[] | undefined) => (reasons === undefined ? '' : JSON.stringify(reasons));
  const excludedRoutes = new Set([...wasExcluded.keys(), ...nowExcluded.keys()]);
  const exclusionsChanged = [...excludedRoutes]
    .filter((routeKey) => exclusionKey(wasExcluded.get(routeKey)) !== exclusionKey(nowExcluded.get(routeKey))).length;

  const changed = added.length > 0 || removed.length > 0 || reordered.length > 0 || policyChanges.length > 0;
  return { basis: changed ? 'changed' : 'unchanged', added, removed, reordered, policyChanges, exclusionsChanged };
}

// MARK: - Layout

export function routingDecisionLogPath(root: string): string {
  return path.join(root, '.routing-decisions');
}

function decisionPath(root: string, recordID: string): string {
  return path.join(routingDecisionLogPath(root), `${recordID}.json`);
}

// MARK: - Reading

function compareInstants(a: string, b: string): number {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at < bt ? -1 : 1;
  return compareCodePoints(a, b);
}

function compareDecisions(a: RoutingDecisionRecord, b: RoutingDecisionRecord): number {
  return compareInstants(a.decidedAt, b.decidedAt) || compareCodePoints(a.recordID, b.recordID);
}

/**
 * Read the whole log, verify every record and every link between them.
 *
 * READ-ONLY: it creates nothing, corrects nothing and does not touch a file it refused. An absent log
 * is an empty log.
 */
export function readRoutingDecisionLog(root: string): RoutingDecisionLogContents {
  const logRoot = routingDecisionLogPath(root);
  const intact: { filePath: string; record: RoutingDecisionRecord }[] = [];
  const corrupt: CorruptDecision[] = [];
  if (fs.existsSync(logRoot)) {
    for (const name of fs.readdirSync(logRoot).filter((entry) => entry.endsWith('.json')).sort()) {
      const filePath = path.join(logRoot, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      } catch (error) {
        corrupt.push({ filePath, reason: `the file is not readable JSON: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        corrupt.push({ filePath, reason: `the file holds ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, not a routing decision` });
        continue;
      }
      const record = parsed as RoutingDecisionRecord;
      const check = verifyRoutingDecisionRecord(record);
      if (!check.intact) { corrupt.push({ filePath, reason: check.reason }); continue; }
      if (name !== `${record.recordID}.json`) {
        corrupt.push({ filePath, reason: `the file is named ${name} but holds ${record.recordID}.json` });
        continue;
      }
      intact.push({ filePath, record });
    }
  }

  // THE CHAIN. Checked over the records that verified on their own, so a refused predecessor also
  // refuses its successor: a change stated against bytes nobody can trust is not evidence either.
  const byID = new Map(intact.map((entry) => [entry.record.recordID, entry.record]));
  const decisions: RoutingDecisionRecord[] = [];
  for (const { filePath, record } of intact) {
    const reason = chainFault(record, byID, intact.map((entry) => entry.record));
    if (reason === undefined) decisions.push(record);
    else corrupt.push({ filePath, reason });
  }
  decisions.sort(compareDecisions);
  corrupt.sort((a, b) => compareCodePoints(a.filePath, b.filePath));
  return {
    schema: ROUTING_DECISION_LOG_SCHEMA, root: logRoot, decisions, corrupt,
    logDigest: digestObject(decisions.map((record) => record.recordID).sort(compareCodePoints)),
  };
}

function chainFault(record: RoutingDecisionRecord, byID: Map<string, RoutingDecisionRecord>,
                    all: RoutingDecisionRecord[]): string | undefined {
  if (record.previousDecisionID === undefined) {
    const earlier = all.find((other) => other.queryDigest === record.queryDigest && other.recordID !== record.recordID
      && compareInstants(other.decidedAt, record.decidedAt) < 0);
    if (earlier !== undefined) {
      return `it claims to be the first answer to its query, but ${earlier.recordID.slice(0, 16)}… answered the same query earlier`;
    }
  } else {
    const previous = byID.get(record.previousDecisionID);
    if (previous === undefined) {
      return `it names ${record.previousDecisionID.slice(0, 16)}… as the previous answer, and the log holds no intact record by that name `
        + '— it was removed or did not verify';
    }
    if (previous.queryDigest !== record.queryDigest) {
      return `its previous answer ${previous.recordID.slice(0, 16)}… answers a different query`;
    }
    if (compareInstants(previous.decidedAt, record.decidedAt) > 0) {
      return `its previous answer was decided at ${previous.decidedAt}, after this one (${record.decidedAt})`;
    }
  }
  const previous = record.previousDecisionID === undefined ? undefined : byID.get(record.previousDecisionID);
  let expected: string;
  try {
    expected = canonicalJSON(decisionChange(previous, record) as unknown as CanonicalValue);
  } catch (error) {
    return `its change could not be recomputed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (expected !== canonicalJSON(record.change as unknown as CanonicalValue)) {
    return 'the change it states is not the change its answer and its previous answer imply';
  }
  return undefined;
}

/** Every verified answer to one query, oldest first. */
export function decisionsForQuery(contents: RoutingDecisionLogContents, queryDigest: string): RoutingDecisionRecord[] {
  return contents.decisions.filter((record) => record.queryDigest === queryDigest);
}

// MARK: - Appending

export interface AppendDecisionOutcome {
  record: RoutingDecisionRecord;
  /** False when an identical record was already in the log: same answer, same instant, same predecessor. */
  written: boolean;
  filePath: string;
}

/**
 * Append one answer to the log.
 *
 * REFUSES, WRITING NOTHING, when any record in the log fails to verify, and when `decidedAt` is earlier
 * than the previous answer to the same query: a log whose order can be argued with is not a log.
 */
export function appendRoutingDecision(root: string, set: RouteCandidateSet, options: {
  decidedAt: string;
  provenance: string;
  /** The qualification policy the records were derived under. Defaults to the V1 policy. */
  qualificationPolicyID?: string;
}): AppendDecisionOutcome {
  const contents = readRoutingDecisionLog(root);
  if (contents.corrupt.length > 0) {
    throw new RoutingDecisionLogError('logTampered',
      `the routing decision log at ${contents.root} holds ${contents.corrupt.length} record(s) that did not verify, so nothing was `
      + `appended: ${contents.corrupt.map((entry) => `${path.basename(entry.filePath)}: ${entry.reason}`).join('; ')}`);
  }
  const queryDigest = routingQueryDigest(set.query);
  const history = decisionsForQuery(contents, queryDigest);
  const previous = history[history.length - 1];
  if (previous !== undefined && compareInstants(options.decidedAt, previous.decidedAt) < 0) {
    throw new RoutingDecisionLogError('outOfOrder',
      `this answer is dated ${options.decidedAt}, before the previous answer to the same query (${previous.decidedAt}). Nothing was appended.`);
  }
  const answer = loggedAnswer(set);
  const policies = policiesOf(answer, options.qualificationPolicyID ?? V1_QUALIFICATION_POLICY.policyID);
  let record: RoutingDecisionRecord;
  try {
    record = sealRoutingDecision({
      decidedAt: options.decidedAt, machineKey: set.query.machineKey, queryDigest, query: set.query, answer, policies,
      ...(previous === undefined ? {} : { previousDecisionID: previous.recordID }),
      change: decisionChange(previous, { answer, policies }),
      provenance: options.provenance,
    });
  } catch (error) {
    throw new RoutingDecisionLogError('unencodable',
      `the answer could not be canonically encoded, so it cannot be sealed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const filePath = decisionPath(root, record.recordID);
  if (fs.existsSync(filePath)) return { record, written: false, filePath };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJSON(filePath, record as unknown as CanonicalValue);
  return { record, written: true, filePath };
}

// MARK: - For a person

/** One line per change, for a terminal. */
export function describeDecisionChange(change: DecisionChange): string[] {
  if (change.basis === 'firstAnswer') return ['first logged answer to this query'];
  if (change.basis === 'unchanged') {
    return [`unchanged since the previous answer${change.exclusionsChanged > 0 ? ` (${change.exclusionsChanged} exclusion reason(s) moved)` : ''}`];
  }
  const lines: string[] = [];
  for (const entry of change.policyChanges) lines.push(`policy   ${entry.policy}: ${entry.from} -> ${entry.to}`);
  for (const entry of change.added) lines.push(`added    ${entry.routeKey} at ${entry.position}: ${entry.causes.join('; ')}`);
  for (const entry of change.removed) lines.push(`removed  ${entry.routeKey} (was ${entry.previousPosition}): ${entry.causes.join('; ')}`);
  for (const entry of change.reordered) lines.push(`moved    ${entry.routeKey} ${entry.from} -> ${entry.to}: ${entry.causes.join('; ')}`);
  if (change.exclusionsChanged > 0) lines.push(`${change.exclusionsChanged} exclusion reason(s) moved`);
  return lines;
}
