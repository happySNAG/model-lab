// Benchmark engine · OUTCOME FEEDBACK (rule cro1): an exported Ordra route-telemetry file, ingested as sealed
// observations, so what a route actually did on real passes reaches the metrics rollup.
//
// WHAT IS READ. One JSON object per line (JSONL). Each names the Ordra pass and attempt, the provider, the model
// Ordra REQUESTED, the model the session's own reported model usage says ANSWERED, the verification result, the
// tokens and the wall-clock duration, and when the attempt was recorded. The exact shape is `RouteTelemetryLine`;
// docs/ordra-lane/route-outcome-ingest.md is its prose. Fields the shape does not name are not read.
//
// THE RULES, EACH ENFORCED HERE.
//
//   SEALED AND APPEND-ONLY. Every accepted line becomes one `routeOutcome` observation in the observation store,
//   content-addressed like every other record. Nothing already there is edited or removed.
//   IDEMPOTENT. A line whose outcome the store already holds, byte for byte, writes nothing and is reported as
//   already present. Ingesting the same file twice writes nothing the second time, quarantines included.
//   A SUBSTITUTION IS A FINDING. A requested model that differs from the reported one is recorded on the outcome
//   as a `substitution` finding, by exact string. Two names are never decided to be "the same model" from their
//   spelling: an alias the provider reports differently is a finding until something proves otherwise.
//   NOTHING IS DROPPED. A line that cannot be read as an outcome, and a line that repeats or contradicts an outcome
//   already seen, is QUARANTINED: sealed as a `routeOutcomeQuarantine` observation carrying the line's own text,
//   its line number, the file's digest and the reason. Only lines holding nothing but whitespace are skipped,
//   and they are counted.
//   OPTIONAL CONTEXT, ONLY WHEN SENT. A line may name the pass's ctt1 `taskType`, the `requestedEffort` and the
//   `appliedEffort` the session's own telemetry reported. Each is read only when the line carries it, and only then
//   does the outcome's body hold it, so a line without them seals to exactly the record it always did. They feed
//   outcome learning (`outcome-learning.ts`), never a verdict. An effort is never read from a model name.
//   FEEDS THE ROLLUP, NEVER A VERDICT. `routeOutcomeRunRows` hands outcomes to `deriveMetricsRollup` as run rows.
//   Nothing here is read by `deriveRouteQualification`, and an outcome record carries no record-level `routeKey`,
//   so neither availability, discovery nor the qualification timeline ever sees one.

import * as fs from 'node:fs';
import { CanonicalValue, canonicalJSON, compareCodePoints, sha256Bytes } from './canonical';
import {
  ObservationRecord, ObservationStoreContents, StoredObservation, appendObservations, readObservationStore, sealObservation,
} from './observation-store';
import { EFFORT_LEVELS, EffortLevel, PROVIDER_IDS, ProviderID } from './provider';
import { ALL_ORDRA_TASK_TYPES, OrdraTaskType } from './task-taxonomy';
import { WorkspaceRunRow } from './workspace-aggregate';

export const ROUTE_OUTCOME_INGEST_RULE = 'cro1';

export const ROUTE_OUTCOME_PROVENANCE =
  'an exported Ordra route-telemetry record (pass, attempt, requested and reported model, verification, tokens, duration), '
  + `ingested by cernum ingest-outcomes under rule ${ROUTE_OUTCOME_INGEST_RULE}`;

export const ROUTE_OUTCOMES_NEVER_DECIDE_A_VERDICT =
  'Ingested outcomes are sealed observations that feed the metrics rollup only. No qualification verdict reads them: '
  + 'a route is qualified by its sealed benchmark runs under the qualification policy, and an outcome Ordra reported '
  + 'neither grants nor revokes that. A requested model that differs from the reported one is a substitution finding, '
  + 'and only outcomes whose reported model is the requested one, with a verification result, reach the rollup.';

export type RouteOutcomeVerification = 'passed' | 'failed' | 'notRun';
const VERIFICATIONS: RouteOutcomeVerification[] = ['passed', 'failed', 'notRun'];

/** What a line of the exported file must hold. */
export interface RouteTelemetryLine {
  pass: string;
  /** The attempt number within the pass, from 1. */
  attempt: number;
  provider: ProviderID;
  requestedModel: string;
  /** The model the session's reported model usage names. `null` when the session reported none. */
  actualModel: string | null;
  verification: RouteOutcomeVerification;
  /** Total tokens the session reported. `null` or absent: not reported, and never estimated. */
  tokens?: number | null;
  /** Wall clock of the attempt, in whole milliseconds. `null` or absent: not recorded. */
  durationMilliseconds?: number | null;
  /** When the attempt was recorded, as an ISO-8601 instant. The observation's `observedAt`. */
  recordedAt: string;
  /** The pass's ctt1 task type. Absent: not sent, and never guessed. */
  taskType?: OrdraTaskType;
  /** The effort Ordra asked for. Absent: not sent. */
  requestedEffort?: EffortLevel;
  /** The effort the session's own telemetry reported it applied. `null` or absent: not observed. */
  appliedEffort?: EffortLevel | null;
}

/** `matched`: reported model is the requested one. `substituted`: it is not. `unreported`: the session named none. */
export type RouteOutcomeIdentity = 'matched' | 'substituted' | 'unreported';

export interface RouteOutcomeSubstitution {
  kind: 'substitution';
  requestedModel: string;
  actualModel: string;
}

/** The body of a `routeOutcome` observation. */
export interface RouteOutcome {
  rule: typeof ROUTE_OUTCOME_INGEST_RULE;
  pass: string;
  attempt: number;
  provider: ProviderID;
  routeKey: string;
  requestedModel: string;
  actualModel: string | null;
  identity: RouteOutcomeIdentity;
  verification: RouteOutcomeVerification;
  tokens: number | null;
  durationMilliseconds: number | null;
  recordedAt: string;
  findings: RouteOutcomeSubstitution[];
  /** Present only when the line named it. */
  taskType?: OrdraTaskType;
  /** Present only when the line named it. */
  requestedEffort?: EffortLevel;
  /** Present only when the line carried the key; `null` is "sent, and not observed". */
  appliedEffort?: EffortLevel | null;
}

export type RouteOutcomeQuarantineReason = 'malformed' | 'duplicate';

/** The body of a `routeOutcomeQuarantine` observation. Holds the line as it arrived. */
export interface RouteOutcomeQuarantine {
  rule: typeof ROUTE_OUTCOME_INGEST_RULE;
  reasonCode: RouteOutcomeQuarantineReason;
  reason: string;
  /** sha256 of the whole file the line came from. */
  sourceDigest: string;
  /** 1-based. */
  line: number;
  text: string;
}

export class RouteOutcomeIngestError extends Error {
  constructor(readonly code: 'unreadable', message: string) {
    super(message);
    this.name = 'RouteOutcomeIngestError';
  }
}

// MARK: - Reading one line

const isInstant = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** An optional whole, non-negative figure: absent and `null` are both "not reported". */
function optionalCount(object: Record<string, unknown>, key: string, unit: string): { ok: true; value: number | null } | { ok: false; reason: string } {
  const value = object[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { ok: false, reason: `${key} is ${JSON.stringify(value)}, not a whole non-negative number of ${unit} or null` };
  }
  return { ok: true, value };
}

/**
 * One line, read as an outcome or refused with every reason it fails.
 *
 * PURE, and it decides nothing about duplicates: whether a line repeats another is a question about the file and
 * the store, answered by `ingestRouteOutcomes`.
 */
export function parseRouteTelemetryLine(text: string): { ok: true; outcome: RouteOutcome } | { ok: false; reasons: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, reasons: [`the line is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reasons: [`the line holds ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}, not a telemetry record`] };
  }
  const object = parsed as Record<string, unknown>;
  const reasons: string[] = [];
  if (!nonEmpty(object.pass)) reasons.push('pass is missing or empty');
  if (typeof object.attempt !== 'number' || !Number.isSafeInteger(object.attempt) || object.attempt < 1) {
    reasons.push(`attempt is ${JSON.stringify(object.attempt)}, not a whole number from 1`);
  }
  // THE PROVIDER IS READ, NEVER INFERRED. A model name says nothing reliable about who served it.
  if (typeof object.provider !== 'string' || !PROVIDER_IDS.includes(object.provider as ProviderID)) {
    reasons.push(`provider is ${JSON.stringify(object.provider)}, not one of ${PROVIDER_IDS.join(', ')}; it is never inferred from a model name`);
  }
  if (!nonEmpty(object.requestedModel)) reasons.push('requestedModel is missing or empty');
  if (!('actualModel' in object)) {
    reasons.push('actualModel is missing; write null when the session reported no model usage');
  } else if (object.actualModel !== null && !nonEmpty(object.actualModel)) {
    reasons.push(`actualModel is ${JSON.stringify(object.actualModel)}, not a model name or null`);
  }
  if (!VERIFICATIONS.includes(object.verification as RouteOutcomeVerification)) {
    reasons.push(`verification is ${JSON.stringify(object.verification)}, not one of ${VERIFICATIONS.join(', ')}`);
  }
  const tokens = optionalCount(object, 'tokens', 'tokens');
  if (!tokens.ok) reasons.push(tokens.reason);
  const duration = optionalCount(object, 'durationMilliseconds', 'milliseconds');
  if (!duration.ok) reasons.push(duration.reason);
  if (!isInstant(object.recordedAt)) reasons.push(`recordedAt is ${JSON.stringify(object.recordedAt)}, not an ISO-8601 instant`);
  if (object.taskType !== undefined && !ALL_ORDRA_TASK_TYPES.includes(object.taskType as OrdraTaskType)) {
    reasons.push(`taskType is ${JSON.stringify(object.taskType)}, not one of ${ALL_ORDRA_TASK_TYPES.join(', ')}`);
  }
  if (object.requestedEffort !== undefined && !EFFORT_LEVELS.includes(object.requestedEffort as EffortLevel)) {
    reasons.push(`requestedEffort is ${JSON.stringify(object.requestedEffort)}, not one of ${EFFORT_LEVELS.join(', ')}`);
  }
  if (object.appliedEffort !== undefined && object.appliedEffort !== null && !EFFORT_LEVELS.includes(object.appliedEffort as EffortLevel)) {
    reasons.push(`appliedEffort is ${JSON.stringify(object.appliedEffort)}, not one of ${EFFORT_LEVELS.join(', ')} or null`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const provider = object.provider as ProviderID;
  const requestedModel = object.requestedModel as string;
  const actualModel = object.actualModel as string | null;
  const identity: RouteOutcomeIdentity = actualModel === null ? 'unreported' : actualModel === requestedModel ? 'matched' : 'substituted';
  return {
    ok: true,
    outcome: {
      rule: ROUTE_OUTCOME_INGEST_RULE,
      pass: object.pass as string,
      attempt: object.attempt as number,
      provider,
      routeKey: `${provider}:${requestedModel}`,
      requestedModel,
      actualModel,
      identity,
      verification: object.verification as RouteOutcomeVerification,
      tokens: tokens.ok ? tokens.value : null,
      durationMilliseconds: duration.ok ? duration.value : null,
      recordedAt: object.recordedAt as string,
      findings: identity === 'substituted' ? [{ kind: 'substitution', requestedModel, actualModel: actualModel as string }] : [],
      ...(object.taskType === undefined ? {} : { taskType: object.taskType as OrdraTaskType }),
      ...(object.requestedEffort === undefined ? {} : { requestedEffort: object.requestedEffort as EffortLevel }),
      ...(object.appliedEffort === undefined ? {} : { appliedEffort: object.appliedEffort as EffortLevel | null }),
    },
  };
}

// MARK: - Sealing

/**
 * An outcome as a sealed observation.
 *
 * NO RECORD-LEVEL `routeKey`, ON PURPOSE. The qualification timeline and the availability views select records by
 * that field; an outcome is neither, and keeping the route in the body is what keeps those readers from seeing it.
 * The provenance names no file, so the same outcome exported in two files is one record.
 */
export function routeOutcomeObservation(outcome: RouteOutcome, machineKey: string, machineLabel: string): ObservationRecord {
  return sealObservation({
    kind: 'routeOutcome', machineKey, machineLabel, observedAt: outcome.recordedAt,
    provenance: ROUTE_OUTCOME_PROVENANCE, provider: outcome.provider,
    body: outcome as unknown as CanonicalValue,
  });
}

/** A line that could not be ingested, sealed with its text and reason. `observedAt` is when it was quarantined. */
export function routeOutcomeQuarantineObservation(quarantine: RouteOutcomeQuarantine, machineKey: string, machineLabel: string,
                                                  observedAt: string): ObservationRecord {
  return sealObservation({
    kind: 'routeOutcomeQuarantine', machineKey, machineLabel, observedAt,
    provenance: `a line of an exported Ordra route-telemetry file that cernum ingest-outcomes quarantined under rule ${ROUTE_OUTCOME_INGEST_RULE}`,
    body: quarantine as unknown as CanonicalValue,
  });
}

// MARK: - Reading the store back

/** Every ingested outcome in the store, oldest first. */
export function routeOutcomesFrom(contents: ObservationStoreContents): { stored: StoredObservation; outcome: RouteOutcome }[] {
  return contents.observations.filter((entry) => entry.record.kind === 'routeOutcome')
    .map((stored) => ({ stored, outcome: stored.record.body as unknown as RouteOutcome }));
}

/** Every quarantined line in the store, oldest first. */
export function routeOutcomeQuarantinesFrom(contents: ObservationStoreContents): { stored: StoredObservation; quarantine: RouteOutcomeQuarantine }[] {
  return contents.observations.filter((entry) => entry.record.kind === 'routeOutcomeQuarantine')
    .map((stored) => ({ stored, quarantine: stored.record.body as unknown as RouteOutcomeQuarantine }));
}

/**
 * Ingested outcomes as run rows for `deriveMetricsRollup`, and ONLY for it.
 *
 * WHICH OUTCOMES. Those whose reported model is the requested one (`matched`) and that were verified (`passed` or
 * `failed`). A substituted outcome measured another model and is not credited to the requested route; an
 * unreported one measured a model nobody named; an unverified one has no result to count. Each stays in the store.
 *
 * A row carries no `caseID`, so it counts toward the route's own entry and toward no capability. Tokens are what
 * the session reported (`providerReported`); cost is not recorded, so the rollup reports it unknown.
 *
 * NEVER PASS THESE TO `deriveRouteQualification`. They are not sealed benchmark runs.
 */
export function routeOutcomeRunRows(contents: ObservationStoreContents): WorkspaceRunRow[] {
  return routeOutcomesFrom(contents)
    .filter(({ outcome }) => outcome.identity === 'matched' && (outcome.verification === 'passed' || outcome.verification === 'failed'))
    .map(({ stored, outcome }) => ({
      recordRoot: `routeOutcome:${stored.record.recordID}`,
      row: {
        source: 'routeOutcome', pass: outcome.pass, attempt: outcome.attempt,
        provider: outcome.provider, requestedModelID: outcome.requestedModel, reportedModelID: outcome.actualModel ?? '',
        status: outcome.verification === 'passed' ? 'pass' : 'fail',
        recordedAt: outcome.recordedAt,
        ...(outcome.durationMilliseconds === null ? {} : { wallClockMilliseconds: outcome.durationMilliseconds }),
        ...(outcome.tokens === null ? {} : { totalTokens: outcome.tokens, usageProvenance: 'providerReported' }),
      },
    }));
}

// MARK: - Ingesting

export interface RouteOutcomeIngestLine {
  line: number;
  recordID: string;
  pass: string;
  attempt: number;
  routeKey: string;
  identity: RouteOutcomeIdentity;
}

export interface RouteOutcomeQuarantined {
  line: number;
  recordID: string;
  reasonCode: RouteOutcomeQuarantineReason;
  reason: string;
  /** False when this exact quarantine was already in the store from an earlier ingest of the same file. */
  written: boolean;
}

export interface RouteOutcomeIngestResult {
  schema: typeof ROUTE_OUTCOME_INGEST_RULE;
  sourceDigest: string;
  machineKey: string;
  /** Every line of the file, blank ones included. */
  lineCount: number;
  blankLines: number;
  /** Outcomes this ingest wrote. */
  ingested: RouteOutcomeIngestLine[];
  /** Outcomes the store already held, byte for byte. Nothing was written for them. */
  alreadyPresent: RouteOutcomeIngestLine[];
  /** Every outcome in this file whose reported model is not the requested one, written now or before. */
  substitutions: (RouteOutcomeIngestLine & RouteOutcomeSubstitution)[];
  quarantined: RouteOutcomeQuarantined[];
  disclosure: string;
}

const outcomeKey = (outcome: RouteOutcome): string => `${outcome.pass}\u0000${outcome.attempt}`;

/**
 * Ingest the text of one exported file into the store under `root`.
 *
 * DUPLICATES. An outcome is identified by its pass and attempt. A line repeating an earlier line of the same file,
 * exactly or with different content, is quarantined naming that line. A line whose pass and attempt the store
 * already holds with different content is quarantined naming that record. A line the store already holds exactly
 * is the idempotent case and writes nothing. The file is checked before the store, so the reason a line is
 * quarantined is the same however many times the file is ingested.
 */
export function ingestRouteOutcomes(root: string, bytes: Uint8Array, options: {
  machineKey: string; machineLabel: string; now: Date;
}): RouteOutcomeIngestResult {
  const sourceDigest = sha256Bytes(bytes);
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const at = options.now.toISOString();

  const contents = readObservationStore(root);
  const storedByKey = new Map<string, { recordID: string; canonical: string }[]>();
  for (const { stored, outcome } of routeOutcomesFrom(contents)) {
    const key = outcomeKey(outcome);
    storedByKey.set(key, [...(storedByKey.get(key) ?? []), { recordID: stored.record.recordID, canonical: canonicalJSON(outcome as unknown as CanonicalValue) }]);
  }
  const storedQuarantines = new Set(routeOutcomeQuarantinesFrom(contents)
    .map(({ quarantine }) => canonicalJSON(quarantine as unknown as CanonicalValue)));

  const result: RouteOutcomeIngestResult = {
    schema: ROUTE_OUTCOME_INGEST_RULE, sourceDigest, machineKey: options.machineKey, lineCount: lines.length, blankLines: 0,
    ingested: [], alreadyPresent: [], substitutions: [], quarantined: [], disclosure: ROUTE_OUTCOMES_NEVER_DECIDE_A_VERDICT,
  };
  const seenInFile = new Map<string, { line: number; canonical: string }>();

  const quarantine = (line: number, lineText: string, reasonCode: RouteOutcomeQuarantineReason, reason: string): void => {
    const body: RouteOutcomeQuarantine = { rule: ROUTE_OUTCOME_INGEST_RULE, reasonCode, reason, sourceDigest, line, text: lineText };
    const canonical = canonicalJSON(body as unknown as CanonicalValue);
    const record = routeOutcomeQuarantineObservation(body, options.machineKey, options.machineLabel, at);
    // IDEMPOTENT BY CONTENT. The quarantine's own record names the moment it was made, so its identity moves
    // every run; the body does not, and a body already held is the same quarantine made before.
    if (storedQuarantines.has(canonical)) {
      result.quarantined.push({ line, recordID: record.recordID, reasonCode, reason, written: false });
      return;
    }
    const written = appendObservations(root, [record], { origin: 'observedHere', receivedAt: at });
    if (written.refused.length > 0) throw new Error(`a quarantine record was refused by the store: ${written.refused[0]!.reason}`);
    storedQuarantines.add(canonical);
    result.quarantined.push({ line, recordID: record.recordID, reasonCode, reason, written: true });
  };

  lines.forEach((lineText, index) => {
    const line = index + 1;
    if (lineText.trim().length === 0) { result.blankLines += 1; return; }
    const parsed = parseRouteTelemetryLine(lineText);
    if (!parsed.ok) { quarantine(line, lineText, 'malformed', parsed.reasons.join('; ')); return; }
    const outcome = parsed.outcome;
    let record: ObservationRecord;
    let canonical: string;
    try {
      record = routeOutcomeObservation(outcome, options.machineKey, options.machineLabel);
      canonical = canonicalJSON(outcome as unknown as CanonicalValue);
    } catch (error) {
      quarantine(line, lineText, 'malformed', `the record cannot be sealed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const key = outcomeKey(outcome);
    const earlier = seenInFile.get(key);
    if (earlier !== undefined) {
      quarantine(line, lineText, 'duplicate', earlier.canonical === canonical
        ? `an exact repeat of line ${earlier.line}: pass ${outcome.pass} attempt ${outcome.attempt} is already on that line`
        : `pass ${outcome.pass} attempt ${outcome.attempt} is already on line ${earlier.line} with different content; neither is chosen over the other`);
      return;
    }
    seenInFile.set(key, { line, canonical });
    const entry: RouteOutcomeIngestLine = { line, recordID: record.recordID, pass: outcome.pass, attempt: outcome.attempt,
      routeKey: outcome.routeKey, identity: outcome.identity };
    const stored = storedByKey.get(key) ?? [];
    if (stored.some((held) => held.canonical === canonical)) {
      result.alreadyPresent.push(entry);
    } else if (stored.length > 0) {
      quarantine(line, lineText, 'duplicate', `pass ${outcome.pass} attempt ${outcome.attempt} is already ingested as `
        + `${stored.map((held) => held.recordID).sort(compareCodePoints).join(', ')} with different content; the stored record is not replaced`);
      return;
    } else {
      const written = appendObservations(root, [record], { origin: 'observedHere', receivedAt: at });
      if (written.refused.length > 0) {
        quarantine(line, lineText, 'malformed', `the store refused the sealed record: ${written.refused[0]!.reason}`);
        return;
      }
      (written.written.length === 1 ? result.ingested : result.alreadyPresent).push(entry);
    }
    for (const finding of outcome.findings) result.substitutions.push({ ...entry, ...finding });
  });
  return result;
}

/** `ingestRouteOutcomes` over a file on disk. An unreadable file is refused whole, before anything is written. */
export function ingestRouteOutcomeFile(root: string, filePath: string, options: {
  machineKey: string; machineLabel: string; now: Date;
}): RouteOutcomeIngestResult {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw new RouteOutcomeIngestError('unreadable',
      `${filePath} could not be read (${error instanceof Error ? error.message : String(error)}). Nothing was ingested.`);
  }
  return ingestRouteOutcomes(root, bytes, options);
}
