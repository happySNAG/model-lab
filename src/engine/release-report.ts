// Benchmark engine · WHICH MODELS ARE NEW SINCE THE LAST TIME ANYONE WAS TOLD, told once.
//
// WHY A LEDGER AND NOT A DIFF. A discovery delta compares two snapshots, so a model that appeared
// between them is "new" in exactly one delta — and in none, if a refresh was missed, and in two, if a
// snapshot was replayed. A person watching for a new Claude or Codex release wants each release once,
// whichever snapshot it first appeared in. So the report is decided against a LEDGER of every model
// already reported, and a model in that ledger is never reported again.
//
// THE LEDGER. One file, `<root>/.release-reports/reported.jsonl`, one sealed record per line, appended
// and never rewritten. The rules are the observation store's and the decision log's:
//
//   IDENTITY IS THE CONTENT. `recordID` is the digest of every other field under the canonical encoding.
//   THE CHAIN IS PART OF THE CHECK. Each record names the one before it and carries its position. A
//   removed, reordered or doctored line breaks the chain, and it and every line after it are refused.
//   What the chain cannot see is the newest line removed whole; `ledgerDigest` is the value a reader
//   keeps elsewhere to notice that.
//   A TAMPERED LEDGER IS NOT APPENDED TO. "Not yet reported" decided against a ledger nobody can trust
//   would be a confident repeat, so `recordReleaseReport` writes nothing while any line fails.
//
// DECIDING IS PURE AND RECORDING IS SEPARATE. `deriveReleaseReport` reads nothing and writes nothing;
// only `recordReleaseReport`, called when the caller asks, appends. Nothing here contacts a model.
// A model in a report is a model a listing NAMED: discovered is not reachable, reachable is not qualified.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, compareCodePoints, digestObject } from './canonical';
import { DiscoverySnapshot } from './discovery-refresh';
import { AliasStatement, buildAliasTable, resolveAlias } from './model-description';
import { ProviderID } from './provider';

export const RELEASE_REPORT_SCHEMA = 'crl1';

/** One model as a release report states it. */
export interface ReportedModel {
  canonicalRouteKey: string;
  provider: ProviderID;
  canonicalModelID: string;
  /** Every listed route key that resolves to this model, sorted. */
  routeKeys: string[];
  /** The earliest `observedAt` among those routes in the snapshot. */
  firstObservedAt: string;
  /** The listing's availability for each route, as the snapshot carried it. Not a qualification. */
  availability: { routeKey: string; availability: string }[];
}

/** One line of the ledger. Every field but `recordID` is inside the digest. */
export interface ReleaseReportRecord {
  schema: typeof RELEASE_REPORT_SCHEMA;
  recordID: string;
  /** 1 for the first line, and one more for each line after it. */
  sequence: number;
  /** The record on the line before. Absent only on the first. */
  previousRecordID?: string;
  /** When it was reported. Supplied by the caller; nothing here reads a clock. */
  reportedAt: string;
  machineKey: string;
  snapshotTakenAt: string;
  models: ReportedModel[];
  provenance: string;
}

export interface CorruptReleaseLine { line: number; reason: string }

export interface ReleaseLedgerContents {
  schema: typeof RELEASE_REPORT_SCHEMA;
  filePath: string;
  records: ReleaseReportRecord[];
  /** Every route key and canonical route key any intact record reported. */
  reportedRouteKeys: Set<string>;
  corrupt: CorruptReleaseLine[];
  /** The digest of every intact recordID, in ledger order. */
  ledgerDigest: string;
}

/** What a release report says: the new models, and the listed ones already told. */
export interface ReleaseReport {
  schema: typeof RELEASE_REPORT_SCHEMA;
  machineKey: string;
  snapshotTakenAt: string;
  /** The providers the report was asked about; absent means every provider in the snapshot. */
  providers?: ProviderID[];
  /** Models listed now that no intact ledger record has reported. Each appears once. */
  newModels: ReportedModel[];
  /** Canonical route keys listed now that the ledger already reported. */
  alreadyReported: string[];
  /** True when the ledger held no record: every listed model is new to it. */
  firstReport: boolean;
  /** Ledger lines that did not verify. A non-empty list means `newModels` may repeat an earlier report. */
  corrupt: CorruptReleaseLine[];
  ledgerDigest: string;
  unresolvedAliases: { routeKey: string; reason: string }[];
  disclosure: string;
}

export const RELEASE_REPORT_DISCLOSURE =
  'A new model is one a discovery listing named on this machine that no earlier release report recorded. It '
  + 'is discovered, not reachable, and reachable is not qualified: nothing here contacted a model, and '
  + 'nothing here is a recommendation or a selection. Aliases are merged only where a source stated them.';

export class ReleaseLedgerError extends Error {
  constructor(readonly code: 'ledgerTampered' | 'unencodable', message: string) {
    super(message);
    this.name = 'ReleaseLedgerError';
  }
}

// MARK: - Identity

function digestableRecord(record: Omit<ReleaseReportRecord, 'recordID'>): CanonicalValue {
  return {
    schema: record.schema,
    sequence: record.sequence,
    previousRecordID: record.previousRecordID,
    reportedAt: record.reportedAt,
    machineKey: record.machineKey,
    snapshotTakenAt: record.snapshotTakenAt,
    models: record.models as unknown as CanonicalValue,
    provenance: record.provenance,
  } as CanonicalValue;
}

export function sealReleaseRecord(record: Omit<ReleaseReportRecord, 'recordID' | 'schema'>): ReleaseReportRecord {
  const withSchema: Omit<ReleaseReportRecord, 'recordID'> = { ...record, schema: RELEASE_REPORT_SCHEMA };
  return { ...withSchema, recordID: digestObject(digestableRecord(withSchema)) };
}

export function verifyReleaseRecord(record: ReleaseReportRecord): { intact: boolean; reason: string } {
  if (record.schema !== RELEASE_REPORT_SCHEMA) {
    return { intact: false, reason: `schema is '${String(record.schema)}', not ${RELEASE_REPORT_SCHEMA}` };
  }
  for (const field of ['recordID', 'reportedAt', 'machineKey', 'snapshotTakenAt', 'provenance'] as const) {
    if (typeof record[field] !== 'string' || String(record[field]).trim().length === 0) {
      return { intact: false, reason: `${field} is missing or empty` };
    }
  }
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) return { intact: false, reason: 'sequence is not a positive whole number' };
  if (!Array.isArray(record.models)) return { intact: false, reason: 'models is not a list' };
  let recomputed: string;
  try {
    recomputed = digestObject(digestableRecord(record));
  } catch (error) {
    return { intact: false, reason: `the record could not be canonically encoded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return recomputed === record.recordID
    ? { intact: true, reason: 'the content digests to its own recordID' }
    : { intact: false, reason: `content digests to ${recomputed.slice(0, 16)}… but the record is named ${record.recordID.slice(0, 16)}…` };
}

// MARK: - The ledger

export function releaseLedgerPath(root: string): string {
  return path.join(root, '.release-reports', 'reported.jsonl');
}

/**
 * Read and verify the whole ledger. READ-ONLY: an absent ledger is an empty one, and nothing is created.
 *
 * The first line that fails — by parse, by digest, by sequence or by link — is refused, and so is every
 * line after it, because each of them states its place against a predecessor nobody can trust.
 */
export function readReleaseLedger(root: string): ReleaseLedgerContents {
  const filePath = releaseLedgerPath(root);
  const records: ReleaseReportRecord[] = [];
  const corrupt: CorruptReleaseLine[] = [];
  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let broken: string | undefined;
    lines.forEach((text, index) => {
      const line = index + 1;
      if (broken !== undefined) { corrupt.push({ line, reason: `follows line ${broken}, which did not verify` }); return; }
      const fault = lineFault(text, records[records.length - 1]);
      if (typeof fault === 'string') { corrupt.push({ line, reason: fault }); broken = String(line); return; }
      records.push(fault);
    });
  }
  const reportedRouteKeys = new Set<string>();
  for (const record of records) {
    for (const model of record.models) {
      reportedRouteKeys.add(model.canonicalRouteKey);
      for (const routeKey of model.routeKeys) reportedRouteKeys.add(routeKey);
    }
  }
  return {
    schema: RELEASE_REPORT_SCHEMA, filePath, records, reportedRouteKeys, corrupt,
    ledgerDigest: digestObject(records.map((record) => record.recordID)),
  };
}

function lineFault(text: string, previous: ReleaseReportRecord | undefined): ReleaseReportRecord | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return `the line is not readable JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the line is not a release report record';
  const record = parsed as ReleaseReportRecord;
  const check = verifyReleaseRecord(record);
  if (!check.intact) return check.reason;
  const expected = (previous?.sequence ?? 0) + 1;
  if (record.sequence !== expected) return `the record says it is number ${record.sequence}, but it is number ${expected} in the ledger`;
  if (record.previousRecordID !== previous?.recordID) {
    return `the record names ${record.previousRecordID?.slice(0, 16) ?? 'no'}… as its predecessor, but the line before holds `
      + `${previous?.recordID.slice(0, 16) ?? 'nothing'}…`;
  }
  return record;
}

// MARK: - Deciding

/**
 * Which listed models the ledger has not reported. PURE: the snapshot, the ledger as read, and the
 * alias statements in; nothing read, nothing written.
 *
 * A model counts as already reported when its canonical route key, or any route key that resolves to it,
 * is in the ledger — so a model reported under an alias is not reported again under its canonical id.
 */
export function deriveReleaseReport(options: {
  snapshot: DiscoverySnapshot;
  ledger: Pick<ReleaseLedgerContents, 'records' | 'reportedRouteKeys' | 'corrupt' | 'ledgerDigest'>;
  aliases?: AliasStatement[];
  providers?: ProviderID[];
}): ReleaseReport {
  const table = buildAliasTable(options.aliases ?? []);
  const unresolved: { routeKey: string; reason: string }[] = [];
  const groups = new Map<string, DiscoverySnapshot['routes']>();
  for (const route of options.snapshot.routes) {
    if (!route.listed) continue;
    if (options.providers !== undefined && !options.providers.includes(route.provider)) continue;
    const resolution = resolveAlias(table, route.provider, route.modelID);
    let canonical = route.routeKey;
    if (resolution.state === 'ambiguous') unresolved.push({ routeKey: route.routeKey, reason: resolution.reason });
    else canonical = resolution.canonicalRouteKey;
    groups.set(canonical, [...(groups.get(canonical) ?? []), route]);
  }

  const newModels: ReportedModel[] = [];
  const alreadyReported: string[] = [];
  for (const [canonicalRouteKey, routes] of [...groups.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const routeKeys = routes.map((route) => route.routeKey).sort(compareCodePoints);
    if ([canonicalRouteKey, ...routeKeys].some((key) => options.ledger.reportedRouteKeys.has(key))) {
      alreadyReported.push(canonicalRouteKey);
      continue;
    }
    const observed = routes.map((route) => route.observedAt).sort(compareCodePoints);
    newModels.push({
      canonicalRouteKey,
      provider: routes[0].provider,
      canonicalModelID: canonicalRouteKey.slice(canonicalRouteKey.indexOf(':') + 1),
      routeKeys,
      firstObservedAt: observed[0],
      availability: [...routes].sort((a, b) => compareCodePoints(a.routeKey, b.routeKey))
        .map((route) => ({ routeKey: route.routeKey, availability: route.availability ?? 'unknown' })),
    });
  }
  return {
    schema: RELEASE_REPORT_SCHEMA,
    machineKey: options.snapshot.machineKey,
    snapshotTakenAt: options.snapshot.takenAt,
    ...(options.providers === undefined ? {} : { providers: [...options.providers].sort(compareCodePoints) }),
    newModels,
    alreadyReported,
    firstReport: options.ledger.records.length === 0 && options.ledger.corrupt.length === 0,
    corrupt: options.ledger.corrupt,
    ledgerDigest: options.ledger.ledgerDigest,
    unresolvedAliases: unresolved.sort((a, b) => compareCodePoints(a.routeKey, b.routeKey)),
    disclosure: RELEASE_REPORT_DISCLOSURE,
  };
}

// MARK: - Recording

/**
 * Append the report's new models to the ledger, so no later report names them again.
 *
 * RE-DECIDED AGAINST THE LEDGER AS IT IS NOW, not as it was when the report was derived: a model another
 * report recorded in between is dropped here rather than written twice. A report with nothing new
 * writes nothing. A ledger with any line that does not verify is refused, and nothing is written.
 */
export function recordReleaseReport(root: string, report: ReleaseReport, options: { reportedAt: string; provenance?: string }): {
  written?: ReleaseReportRecord; droppedAlreadyReported: string[];
} {
  const ledger = readReleaseLedger(root);
  if (ledger.corrupt.length > 0) {
    throw new ReleaseLedgerError('ledgerTampered', `${ledger.corrupt.length} line(s) of ${ledger.filePath} did not verify `
      + `(first: line ${ledger.corrupt[0].line}, ${ledger.corrupt[0].reason}). Deciding "not yet reported" against it could `
      + 'repeat a report, so nothing was written.');
  }
  const droppedAlreadyReported: string[] = [];
  const models = report.newModels.filter((model) => {
    const seen = [model.canonicalRouteKey, ...model.routeKeys].some((key) => ledger.reportedRouteKeys.has(key));
    if (seen) droppedAlreadyReported.push(model.canonicalRouteKey);
    return !seen;
  });
  if (models.length === 0) return { droppedAlreadyReported };
  const previous = ledger.records[ledger.records.length - 1];
  const record = sealReleaseRecord({
    sequence: (previous?.sequence ?? 0) + 1,
    ...(previous === undefined ? {} : { previousRecordID: previous.recordID }),
    reportedAt: options.reportedAt,
    machineKey: report.machineKey,
    snapshotTakenAt: report.snapshotTakenAt,
    models,
    provenance: options.provenance ?? `release report over the discovery snapshot taken ${report.snapshotTakenAt}`,
  });
  appendLine(ledger.filePath, JSON.stringify(record));
  return { written: record, droppedAlreadyReported };
}

/** Append one line and flush it. The file is opened for append only; no byte already in it is touched. */
function appendLine(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(handle, `${line}\n`);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
}

/** The report, in lines a person reads. */
export function describeReleaseReport(report: ReleaseReport): string[] {
  const lines = [
    `Release report ${report.schema} · machine ${report.machineKey} · snapshot ${report.snapshotTakenAt}`
      + `${report.providers === undefined ? '' : ` · providers ${report.providers.join(', ')}`}`,
    `  ${report.newModels.length} new · ${report.alreadyReported.length} already reported`
      + `${report.firstReport ? ' · first report: the ledger is empty, so every listed model is new to it' : ''}`,
  ];
  if (report.newModels.length > 0) lines.push('', 'NEW');
  for (const model of report.newModels) {
    const aliases = model.routeKeys.filter((routeKey) => routeKey !== model.canonicalRouteKey);
    lines.push(`  ${model.canonicalRouteKey}${aliases.length === 0 ? '' : `  (also ${aliases.join(', ')})`}  first observed ${model.firstObservedAt}`);
    for (const entry of model.availability) lines.push(`    ${entry.routeKey}: listing says ${entry.availability}`);
  }
  for (const entry of report.unresolvedAliases) lines.push('', `  alias unresolved: ${entry.routeKey}: ${entry.reason}`);
  return lines;
}
