// Benchmark engine · the MATRIX-WIDE identity admission: one person's sealed authorization to run
// identity-unverifiable Codex routes across one sealed benchmark matrix.
//
// THE PROBLEM IT ADDRESSES. `cernum workspace <case>` can run a Codex route under the Pass 6 identity
// admission (`identity-admission.ts`), because that admission is sealed to ONE record's label. A
// matrix makes many records — four cases, three repeats, several models — and there was no honest
// way to hand it that admission: sealing one file to forty-eight labels by hand is not a control, and
// a single boolean "admit Codex" is exactly the provider-wide exception Pass 6 refused to offer.
//
// WHAT THIS IS. A matrix admission is written by a person, read with an explicit command-line flag
// (never an environment variable, never a configuration default), and sealed at the moment it is read
// to ONE matrix: its run label, its pack (id, version AND `cwp1:` digest), and — per admitted route —
// the provider, the requested model, the requested effort, the workspace driver, the CLI version the
// driver's flags were verified against, the execution class and the billing basis. Each route is its
// own sealed ENTRY. An admission for `gpt-5.6-sol @ medium` names that route and nothing else: not
// `@ max`, not `gpt-6-astra`, not another pack, not another driver, and not the metered API.
//
// WHAT IT IS NOT. It is not identity. An admitted route stays `requestAcceptedIdentityUnverifiable`
// before the request and `unverifiable` (or `substituted`, on a reported reroute) after it. Nothing
// here writes `verified`, fills a verified-model field, or copies the requested identifier into a
// returned one. It is not a quality judgement either: an admitted row is scored exactly like any other,
// and the identity limitation is carried beside the score rather than subtracted from it.
//
// HOW IT REACHES EACH RECORD. The matrix never hands a record the matrix-wide object to interpret.
// For every planned cell it derives an ordinary Pass 6 `IdentityAdmission` sealed to THAT record's
// label, admitting exactly that one route, and carrying a reference back to the matrix admission and
// the entry that authorised it (`matrixAdmission`). The record's manifest freezes it through the same
// path a single-record admission takes, so the existing gate (`admissionFor`) and the existing seal
// check apply to every run unchanged, and a record read on its own says which matrix admission it ran
// under. Single-record admissions carry no `matrixAdmission` field at all, so their digests — and the
// sealed Codex proof that used one — are unchanged.

import { CanonicalValue, digestObject, sha256Text } from './canonical';
import {
  ADMISSIBLE_PROVIDERS, ADMISSION_APPROVAL, ADMISSION_STAMP_LONG, AdmittedCandidateEvidence, IdentityAdmission,
  MatrixAdmissionReference, NEVER_AFFECTS, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, authorizeIdentityAdmission,
} from './identity-admission';
import { EFFORT_LEVELS, EffortLevel, PROVIDER_IDS, ProviderID } from './provider';
import { OPENCODE_WORKSPACE_IDENTITY_LIMITATION } from './workspace-opencode-driver';

export class WorkspaceMatrixAdmissionError extends Error {
  constructor(readonly code:
    | 'unreadable' | 'wrongScope' | 'missingField' | 'noCandidates' | 'providerNotAdmissible' | 'unknownProvider'
    | 'unknownEffort' | 'duplicateRoute' | 'returnedIdentityPresent' | 'sealBroken' | 'selectionMalformed',
  message: string) {
    super(message);
    this.name = 'WorkspaceMatrixAdmissionError';
  }
}

/** The one scope value a matrix admission file must declare. A single-record file declares none. */
export const WORKSPACE_MATRIX_ADMISSION_SCOPE = 'workspaceMatrix';

export const WORKSPACE_MATRIX_ADMISSION_FORMAT_VERSION = 1;

/**
 * What exact identity this admission does NOT establish, sealed into every admission and every record
 * that runs under one. Engine-authored, not operator-authored: the operator decides WHETHER to accept
 * the limitation, not how it is described.
 */
export const MATRIX_IDENTITY_LIMITATION =
  'codex exec (0.155.0) names no model in any event it emits, and its telemetry reports only what the client sent. '
  + 'Exact execution identity is therefore UNVERIFIABLE on this route: a row means "what answered when this '
  + 'identifier was requested on the Codex subscription route", not "this model answered". The stream can prove a '
  + 'substitution (a reported "model rerouted: A -> B" fails that attempt) but it cannot prove an identity, and the '
  + 'absence of a reroute report is not evidence that the requested model answered.';

/**
 * The providers `MATRIX_IDENTITY_LIMITATION` actually describes. The identity exception itself admits
 * more than one provider (`ADMISSIBLE_PROVIDERS`), but this sealed sentence is about `codex exec` and
 * would be false about any other tool, so a matrix admission refuses a route it does not describe
 * rather than sealing a limitation that misstates what that route can and cannot prove.
 */
export const MATRIX_IDENTITY_LIMITATION_DESCRIBES: ProviderID[] = ['codexCLI', 'opencodeCLI'];

/**
 * THE SEALED LIMITATION, PER PROVIDER, because the two routes are not the same fault.
 *
 * `codexCLI` keeps `MATRIX_IDENTITY_LIMITATION` byte for byte, so every Codex admission already sealed
 * — and the Codex discriminator evidence that ran under one — keeps its digest. `opencodeCLI` gets its
 * own sentence, written in the OpenCode driver, which says the thing Codex's does not: this route cannot
 * even DETECT a substitution. An admission naming routes on both providers is refused rather than sealed
 * under one provider's wording.
 */
export const MATRIX_IDENTITY_LIMITATIONS: Partial<Record<ProviderID, string>> = {
  codexCLI: MATRIX_IDENTITY_LIMITATION,
  opencodeCLI: OPENCODE_WORKSPACE_IDENTITY_LIMITATION,
};

/**
 * What every admitted run still records, printed before the matrix runs so the operator knows what the
 * admission does and does not buy.
 */
export const MATRIX_ADMISSION_EVIDENCE_STILL_RECORDED: string[] = [
  'the requested model and requested effort, frozen in each record\'s manifest and binding',
  'pre-run identity requestAcceptedIdentityUnverifiable (bindingIdentityState), resolved from identityAdmission',
  'the execution identity verdict each run establishes: unverifiable, or substituted when the tool reports a reroute',
  'a reported reroute\'s served model, as reportedModelID, and the attempt it poisoned fails',
  'this matrix admission\'s digest, the authorising entry\'s digest and the per-record admission seal, on every row',
  'the sealed fixture check, the filesystem diff, visible and hidden verification, scoring and the transcript',
  'tokens as the tool reports them, the $0 marginal charge, and plan allowance as unreported rather than zero',
];

/** One route the operator's file admits, before sealing. Every field is required. */
export interface WorkspaceMatrixAdmissionRoute {
  provider: ProviderID;
  requestedModelID: string;
  requestedEffort: EffortLevel;
  driverID: string;
  /** The CLI version the driver's flags were verified against. The driver refuses any other at run time. */
  cliVersion: string;
  executionClass: string;
  billingBasis: string;
  authenticationBasis: string;
  /** Digest of the accepted-request (identity-smoke) evidence this route's admission rests on. */
  evidenceDigest: string;
  evidenceCapturedAt: string;
}

/** A parsed operator file, before it is sealed to a matrix. */
export interface WorkspaceMatrixAdmissionRequest {
  authorizedBy: string;
  /** Why these routes should be measured even though their identity cannot be established. */
  reason: string;
  /** What the operator intends the measurement for — and, by the same stroke, what it is not for. */
  intent: string;
  pack: { id: string; version: string; digest: string };
  admitted: WorkspaceMatrixAdmissionRoute[];
  /**
   * The `cms1:` digest of the ONE cell selection this admission authorises, when it authorises a selected
   * matrix rather than a whole one. Absent means a whole-matrix admission, which no selected plan accepts.
   */
  cellSelectionDigest?: string;
  /** SHA-256 of the file's bytes as read, so the sealed object names the exact file it came from. */
  sourceFileSHA256: string;
}

/** One sealed route. `entryDigest` covers the route, the pack and the matrix label together. */
export interface WorkspaceMatrixAdmissionEntry extends WorkspaceMatrixAdmissionRoute {
  /** `provider:model@effort`, exactly as the matrix names the candidate. */
  candidate: string;
  /** Always the one legal state. Never `verified`. */
  identityState: typeof REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;
  /** Always empty, present so the emptiness is explicit. */
  returnedModelID: '';
  entryDigest: string;
}

/** The sealed matrix-wide admission. Valid for one matrix label, one pack digest, and the routes it names. */
export interface WorkspaceMatrixIdentityAdmission {
  matrixAdmissionFormatVersion: number;
  admissionScope: typeof WORKSPACE_MATRIX_ADMISSION_SCOPE;
  matrixLabel: string;
  packID: string;
  packVersion: string;
  packDigest: string;
  authorizedAt: string;
  authorizedBy: string;
  reason: string;
  intent: string;
  sourceFileSHA256: string;
  /**
   * Present exactly on an admission for a SELECTED matrix: the `cms1:` digest of the exact cells — and,
   * for a continuation, the source campaign they were continued from — that it authorises. Part of every
   * entry's scope, so no entry of it admits a route in any other selection or in a whole matrix.
   */
  cellSelectionDigest?: string;
  identityLimitation: string;
  /** The Pass 6 approval this rests on, by name. */
  approval: string;
  entries: WorkspaceMatrixAdmissionEntry[];
  /** `cma1:` — seals everything above. */
  matrixAdmissionDigest: string;
}

/** The route a matrix is about to run, as the plan has bound it. */
export interface WorkspaceMatrixRouteFacts {
  matrixLabel: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  candidate: string;
  packID: string;
  packVersion: string;
  packDigest: string;
  driverID: string;
  cliVersion: string;
  executionClass: string;
  billingBasis: string;
}

export const matrixCandidateName = (provider: ProviderID, modelID: string, effort: EffortLevel): string =>
  `${provider}:${modelID}${effort === 'none' ? '' : `@${effort}`}`;

const requiredText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Parse an operator's matrix admission file. Refuses, naming the field, rather than defaulting anything.
 *
 * A SINGLE-RECORD FILE IS REFUSED HERE, and a matrix file is refused by the single-record reader: the
 * two carry different scopes, and a file written to admit one run must not quietly admit forty-eight.
 */
export function parseWorkspaceMatrixAdmissionFile(text: string): WorkspaceMatrixAdmissionRequest {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new WorkspaceMatrixAdmissionError('unreadable',
      `the matrix admission is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkspaceMatrixAdmissionError('unreadable', 'the matrix admission must be a JSON object.');
  }
  if (parsed.admissionScope !== WORKSPACE_MATRIX_ADMISSION_SCOPE) {
    throw new WorkspaceMatrixAdmissionError('wrongScope',
      `a matrix admission must declare "admissionScope": "${WORKSPACE_MATRIX_ADMISSION_SCOPE}". This file declares `
      + `${parsed.admissionScope === undefined ? 'no scope' : `'${String(parsed.admissionScope)}'`}, which is what a `
      + 'single-record admission looks like. An authorization written for one run is never widened to a matrix.');
  }
  const missing: string[] = [];
  const need = (name: string, value: unknown): string => {
    const found = requiredText(value);
    if (found.length === 0) missing.push(name);
    return found;
  };
  const authorizedBy = need('authorizedBy', parsed.authorizedBy);
  const reason = need('reason', parsed.reason);
  const intent = need('intent', parsed.intent);
  const pack = (parsed.pack ?? {}) as Record<string, unknown>;
  const packID = need('pack.id', pack.id);
  const packVersion = need('pack.version', pack.version);
  const packDigest = need('pack.digest', pack.digest);
  if (missing.length > 0) {
    throw new WorkspaceMatrixAdmissionError('missingField',
      `a matrix admission must carry ${missing.join(', ')}. An exception across a whole matrix needs MORE `
      + 'provenance than one run does, not less.');
  }
  if (!Array.isArray(parsed.admitted) || parsed.admitted.length === 0) {
    throw new WorkspaceMatrixAdmissionError('noCandidates',
      'a matrix admission must list the exact routes it admits. An empty list would be a provider-wide exception.');
  }
  const admitted = (parsed.admitted as Record<string, unknown>[]).map((entry, index) => {
    const at = `admitted[${index}]`;
    const routeMissing: string[] = [];
    const field = (name: string): string => {
      const found = requiredText(entry?.[name]);
      if (found.length === 0) routeMissing.push(`${at}.${name}`);
      return found;
    };
    const route: WorkspaceMatrixAdmissionRoute = {
      provider: field('provider') as ProviderID,
      requestedModelID: field('requestedModelID'),
      requestedEffort: field('requestedEffort') as EffortLevel,
      driverID: field('driverID'),
      cliVersion: field('cliVersion'),
      executionClass: field('executionClass'),
      billingBasis: field('billingBasis'),
      authenticationBasis: field('authenticationBasis'),
      evidenceDigest: field('evidenceDigest'),
      evidenceCapturedAt: field('evidenceCapturedAt'),
    };
    if (routeMissing.length > 0) {
      throw new WorkspaceMatrixAdmissionError('missingField',
        `${routeMissing.join(', ')} ${routeMissing.length === 1 ? 'is' : 'are'} missing. Every admitted route names its `
        + 'provider, model, effort, driver, CLI version, execution class, billing basis, authentication basis and the '
        + 'evidence it rests on.');
    }
    for (const name of ['returnedModelID', 'verifiedModelID', 'reportedModelID']) {
      if (requiredText(entry?.[name]).length > 0) {
        throw new WorkspaceMatrixAdmissionError('returnedIdentityPresent',
          `${at}.${name} is set. A route admitted under this exception has no returned identity, and the requested `
          + 'identifier is never written where a returned one belongs.');
      }
    }
    return route;
  });
  let cellSelectionDigest: string | undefined;
  if (parsed.selection !== undefined) {
    const selection = parsed.selection as Record<string, unknown> | null;
    const digest = selection !== null && typeof selection === 'object' && !Array.isArray(selection)
      ? requiredText(selection.digest) : '';
    const extra = selection !== null && typeof selection === 'object' && !Array.isArray(selection)
      ? Object.keys(selection).filter((key) => key !== 'digest') : [];
    if (!/^cms1:[0-9a-f]{64}$/.test(digest) || extra.length > 0) {
      throw new WorkspaceMatrixAdmissionError('selectionMalformed',
        '"selection" must be { "digest": "<the cms1: digest the dry run prints>" } and nothing else. It binds this '
        + 'admission to exactly the selected cells that digest covers.');
    }
    cellSelectionDigest = digest;
  }
  return {
    authorizedBy, reason, intent,
    pack: { id: packID, version: packVersion, digest: packDigest },
    admitted,
    ...(cellSelectionDigest === undefined ? {} : { cellSelectionDigest }),
    sourceFileSHA256: sha256Text(text),
  };
}

function entryBody(route: WorkspaceMatrixAdmissionRoute): Omit<WorkspaceMatrixAdmissionEntry, 'entryDigest'> {
  return {
    ...route,
    candidate: matrixCandidateName(route.provider, route.requestedModelID, route.requestedEffort),
    identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    returnedModelID: '',
  };
}

function entryDigestOf(entry: Omit<WorkspaceMatrixAdmissionEntry, 'entryDigest'>,
                       scope: { matrixLabel: string; packID: string; packVersion: string; packDigest: string;
                         cellSelectionDigest?: string }): string {
  return 'cme1:' + digestObject({ entry, scope } as unknown as CanonicalValue);
}

/**
 * Seal an operator's matrix admission to ONE matrix. Refuses anything this exception cannot cover.
 *
 * `matrixLabel` and `authorizedAt` come from the invocation, which is what stops a file being carried
 * forward: the same file read for another matrix produces a different seal, bound to that matrix's
 * label, and only ever when the operator passes the flag again.
 */
export function sealWorkspaceMatrixAdmission(request: WorkspaceMatrixAdmissionRequest, sealing: {
  matrixLabel: string;
  authorizedAt: string;
}): WorkspaceMatrixIdentityAdmission {
  if (request.admitted.length === 0) {
    throw new WorkspaceMatrixAdmissionError('noCandidates', 'a matrix admission must name at least one route.');
  }
  const seen = new Set<string>();
  for (const route of request.admitted) {
    if (!PROVIDER_IDS.includes(route.provider)) {
      throw new WorkspaceMatrixAdmissionError('unknownProvider', `'${route.provider}' is not a provider this engine models.`);
    }
    if (!ADMISSIBLE_PROVIDERS.includes(route.provider)) {
      throw new WorkspaceMatrixAdmissionError('providerNotAdmissible',
        `${route.provider} cannot be admitted under this exception. It applies only to ${ADMISSIBLE_PROVIDERS.join(', ')}, `
        + 'whose CLI names no model. A route on a provider that DOES report identity, or on a metered API that proves it, '
        + 'has no use for this exception, and admitting it here would conceal whatever is actually wrong.');
    }
    if (!MATRIX_IDENTITY_LIMITATION_DESCRIBES.includes(route.provider)) {
      throw new WorkspaceMatrixAdmissionError('providerNotAdmissible',
        `${route.provider} is admissible to the identity exception, but not to a workspace MATRIX admission: the `
        + `limitation a matrix admission seals describes ${MATRIX_IDENTITY_LIMITATION_DESCRIBES.join(', ')} only, and `
        + 'sealing it over another tool would record a false account of what that route can prove.');
    }
    if (!EFFORT_LEVELS.includes(route.requestedEffort)) {
      throw new WorkspaceMatrixAdmissionError('unknownEffort',
        `'${route.requestedEffort}' is not an effort level this engine models. Valid: ${EFFORT_LEVELS.join(', ')}.`);
    }
    const key = matrixCandidateName(route.provider, route.requestedModelID, route.requestedEffort);
    if (seen.has(key)) {
      throw new WorkspaceMatrixAdmissionError('duplicateRoute',
        `${key} is admitted twice. One route, one entry, one seal.`);
    }
    seen.add(key);
  }
  const providers = [...new Set(request.admitted.map((route) => route.provider))];
  if (providers.length > 1) {
    throw new WorkspaceMatrixAdmissionError('providerNotAdmissible',
      `this admission names routes on ${providers.join(' and ')}. Their identity limitations are different facts, and one `
      + 'sealed admission carries one; write one admission per provider.');
  }
  const identityLimitation = MATRIX_IDENTITY_LIMITATIONS[providers[0]] ?? MATRIX_IDENTITY_LIMITATION;
  const scope = {
    matrixLabel: sealing.matrixLabel,
    packID: request.pack.id,
    packVersion: request.pack.version,
    packDigest: request.pack.digest,
    // ABSENT, NOT EMPTY, on a whole-matrix admission: the canonical encoding drops an absent key, so every
    // admission sealed before selections existed keeps its digest.
    ...(request.cellSelectionDigest === undefined ? {} : { cellSelectionDigest: request.cellSelectionDigest }),
  };
  const entries = request.admitted.map((route) => {
    const body = entryBody(route);
    return { ...body, entryDigest: entryDigestOf(body, scope) };
  });
  const body: Omit<WorkspaceMatrixIdentityAdmission, 'matrixAdmissionDigest'> = {
    matrixAdmissionFormatVersion: WORKSPACE_MATRIX_ADMISSION_FORMAT_VERSION,
    admissionScope: WORKSPACE_MATRIX_ADMISSION_SCOPE,
    ...scope,
    authorizedAt: sealing.authorizedAt,
    authorizedBy: request.authorizedBy,
    reason: request.reason,
    intent: request.intent,
    sourceFileSHA256: request.sourceFileSHA256,
    identityLimitation,
    approval: `${ADMISSION_APPROVAL.pass}, decision ${ADMISSION_APPROVAL.decision}`,
    entries,
  };
  return { ...body, matrixAdmissionDigest: 'cma1:' + digestObject(body as unknown as CanonicalValue) };
}

/** Recompute every seal: the whole admission's, and each entry's. */
export function matrixAdmissionSealIsIntact(admission: WorkspaceMatrixIdentityAdmission): boolean {
  const { matrixAdmissionDigest, ...body } = admission;
  if ('cma1:' + digestObject(body as unknown as CanonicalValue) !== matrixAdmissionDigest) return false;
  const scope = {
    matrixLabel: admission.matrixLabel, packID: admission.packID,
    packVersion: admission.packVersion, packDigest: admission.packDigest,
    ...(admission.cellSelectionDigest === undefined ? {} : { cellSelectionDigest: admission.cellSelectionDigest }),
  };
  return admission.entries.every((entry) => {
    const { entryDigest, ...entryContent } = entry;
    return entryDigestOf(entryContent, scope) === entryDigest;
  });
}

export interface MatrixAdmissionDecision {
  admitted: boolean;
  reason: string;
  entry?: WorkspaceMatrixAdmissionEntry;
  /** Every bound field that disagreed, named. Empty when admitted or when no entry named the route. */
  mismatches: string[];
}

/**
 * THE GATE. Does this matrix admission admit this exact route, in this exact matrix?
 *
 * DEFAULT IS REFUSAL. No admission, a broken seal, another matrix, another pack, a route no entry
 * names, or an entry that names the route and disagrees about ANY bound fact — driver, CLI version,
 * execution class, billing basis — is refused, and the refusal says which.
 */
export function matrixAdmissionFor(admission: WorkspaceMatrixIdentityAdmission | undefined,
                                   route: WorkspaceMatrixRouteFacts): MatrixAdmissionDecision {
  if (admission === undefined) {
    return { admitted: false, mismatches: [], reason:
      'no matrix identity admission was given (--admit-identity-unverifiable), so a route whose identity cannot be '
      + 'established is refused. Nothing carries an admission forward from an earlier matrix or campaign.' };
  }
  if (!matrixAdmissionSealIsIntact(admission)) {
    return { admitted: false, mismatches: [], reason:
      'the matrix admission\'s seal does not match its contents, so what was authorised is not what is being asked for.' };
  }
  if (admission.matrixLabel !== route.matrixLabel) {
    return { admitted: false, mismatches: ['matrixLabel'], reason:
      `the matrix admission was sealed to matrix '${admission.matrixLabel}', not '${route.matrixLabel}'. An admission `
      + 'is granted to one matrix and is never inherited.' };
  }
  const packMismatches = ([
    ['pack id', admission.packID, route.packID],
    ['pack version', admission.packVersion, route.packVersion],
    ['pack digest', admission.packDigest, route.packDigest],
  ] as const).filter(([, admitted, asked]) => admitted !== asked);
  if (packMismatches.length > 0) {
    return { admitted: false, mismatches: packMismatches.map(([name]) => name), reason:
      `the matrix admission names pack ${admission.packID}@${admission.packVersion} (${admission.packDigest}); this matrix `
      + `runs ${route.packID}@${route.packVersion} (${route.packDigest}). An admission for one sealed pack authorises no other.` };
  }
  const entry = admission.entries.find((candidate) => candidate.provider === route.provider
    && candidate.requestedModelID === route.modelID && candidate.requestedEffort === route.effort);
  if (entry === undefined) {
    return { admitted: false, mismatches: [], reason:
      `${route.candidate} is not named by the matrix admission. It admits only `
      + `${admission.entries.map((candidate) => candidate.candidate).join(', ')} — exact provider, model and effort. `
      + 'Admission is per route, never per provider, model family or effort ladder.' };
  }
  const mismatches = ([
    ['driver', entry.driverID, route.driverID],
    ['CLI version', entry.cliVersion, route.cliVersion],
    ['execution class', entry.executionClass, route.executionClass],
    ['billing basis', entry.billingBasis, route.billingBasis],
    ['candidate', entry.candidate, route.candidate],
  ] as const).filter(([, admitted, asked]) => admitted !== asked);
  if (mismatches.length > 0) {
    return { admitted: false, entry, mismatches: mismatches.map(([name]) => name), reason:
      `${route.candidate} is named by the matrix admission, but the admission and this matrix disagree about `
      + `${mismatches.map(([name, admitted, asked]) => `${name} (admitted ${admitted}, bound ${asked})`).join('; ')}. `
      + 'An admission covers the exact route it names, driven and billed the way it names.' };
  }
  return { admitted: true, entry, mismatches: [], reason: ADMISSION_STAMP_LONG };
}

/**
 * The reference a per-record admission carries back to the matrix admission.
 *
 * `cell` is given exactly when the matrix runs a selection: the record's admission then names the one
 * `cmc1:` cell it may be frozen into, beside the `cms1:` selection it came from.
 */
export function matrixAdmissionReferenceOf(admission: WorkspaceMatrixIdentityAdmission,
                                           entry: WorkspaceMatrixAdmissionEntry,
                                           cell?: { matrixCellID: string }): MatrixAdmissionReference {
  return {
    admissionScope: WORKSPACE_MATRIX_ADMISSION_SCOPE,
    matrixAdmissionDigest: admission.matrixAdmissionDigest,
    entryDigest: entry.entryDigest,
    matrixLabel: admission.matrixLabel,
    packID: admission.packID,
    packVersion: admission.packVersion,
    packDigest: admission.packDigest,
    driverID: entry.driverID,
    executionClass: entry.executionClass,
    billingBasis: entry.billingBasis,
    reason: admission.reason,
    intent: admission.intent,
    identityLimitation: admission.identityLimitation,
    ...(admission.cellSelectionDigest === undefined ? {} : { cellSelectionDigest: admission.cellSelectionDigest }),
    ...(cell === undefined ? {} : { matrixCellID: cell.matrixCellID }),
  };
}

/**
 * The ordinary Pass 6 admission ONE record of the matrix freezes, derived from the matrix admission.
 *
 * Sealed to that record's own label and admitting exactly that record's route, so the existing gate
 * (`admissionFor`) decides it exactly as it decides a single-record admission. Deterministic: the plan
 * and the run derive the same object, so a dry run shows the seal the live record will freeze.
 */
export function recordAdmissionFromMatrix(admission: WorkspaceMatrixIdentityAdmission,
                                          entry: WorkspaceMatrixAdmissionEntry, recordLabel: string,
                                          cell?: { matrixCellID: string }): IdentityAdmission {
  const evidence: AdmittedCandidateEvidence = {
    provider: entry.provider,
    requestedModelID: entry.requestedModelID,
    requestedEffort: entry.requestedEffort,
    cliVersion: entry.cliVersion,
    authenticationBasis: entry.authenticationBasis,
    evidenceDigest: entry.evidenceDigest,
    evidenceCapturedAt: entry.evidenceCapturedAt,
    returnedModelID: '',
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  };
  return authorizeIdentityAdmission({
    campaignLabel: recordLabel,
    authorizedAt: admission.authorizedAt,
    authorizedBy: admission.authorizedBy,
    admitted: [evidence],
    matrixAdmission: matrixAdmissionReferenceOf(admission, entry, cell),
  });
}

/** Everything an operator should have read before a matrix admission takes effect. One renderer. */
export function describeWorkspaceMatrixAdmission(admission: WorkspaceMatrixIdentityAdmission): string[] {
  const lines = [
    `identity admission  PRESENT — matrix scope, sealed ${admission.matrixAdmissionDigest}`,
    `  matrix            ${admission.matrixLabel}`,
    `  pack              ${admission.packID}@${admission.packVersion} · ${admission.packDigest}`,
    `  cells             ${admission.cellSelectionDigest === undefined
      ? 'the WHOLE matrix (no cell selection named)'
      : `ONLY the selection ${admission.cellSelectionDigest} — no other case, repeat, route or matrix`}`,
    `  authorised by     ${admission.authorizedBy}`,
    `  authorised at     ${admission.authorizedAt} (sealed when this command read the file; file sha256 `
      + `${admission.sourceFileSHA256.slice(0, 16)}…)`,
    `  reason            ${admission.reason}`,
    `  intent            ${admission.intent}`,
    `  approval          ${admission.approval}`,
    '  admitted routes   (each its own sealed entry; nothing else is admitted)',
  ];
  for (const entry of admission.entries) {
    lines.push(`    ${entry.candidate}  ${entry.entryDigest}`);
    lines.push(`      identity ${entry.identityState} · returned model: none · driver ${entry.driverID} `
      + `(CLI ${entry.cliVersion}) · ${entry.executionClass} · billing ${entry.billingBasis}`);
    lines.push(`      authentication ${entry.authenticationBasis}`);
    lines.push(`      evidence ${entry.evidenceDigest} · captured ${entry.evidenceCapturedAt}`);
  }
  lines.push(`  identity limit    ${admission.identityLimitation}`);
  lines.push('  still recorded on every admitted run:');
  for (const line of MATRIX_ADMISSION_EVIDENCE_STILL_RECORDED) lines.push(`    · ${line}`);
  lines.push('  this exception never affects:');
  for (const never of NEVER_AFFECTS) lines.push(`    · ${never}`);
  return lines;
}
