// Benchmark engine · the narrow exception by which a Codex candidate MIGHT one day be admitted
// without its identity ever having been proven.
//
// ============================================================================================
// THIS IS INERT. NOTHING CALLS IT. IT CHANGES NO BEHAVIOUR IN THIS PASS.
//
// It is a DESIGN, written out in full and tested, so that Pass 6 can be approved or declined
// against the real thing rather than against a paragraph describing it. `campaign-builder.ts` does
// not import this module, and the fail-closed refusal of an unproven candidate remains exactly as
// it was. Activating this is a separate, explicit decision — see `ACTIVATION_REQUIREMENTS`.
// ============================================================================================
//
// THE PROBLEM IT ADDRESSES. `codex exec --json` names no model in any event it emits. Not in
// `thread.started`, not in `item.completed`, not in `turn.completed`. All six requested Codex
// configurations answer, the requested identifier is accepted, and the tool will still not say who
// replied. So every Codex candidate is `unverifiable`, and the campaign builder refuses an unproven
// candidate by design. That refusal is correct. This module does not weaken it; it describes the
// only honest alternative to it.
//
// WHAT THE STATE MEANS, AND WHAT IT DOES NOT. `requestAcceptedIdentityUnverifiable` records exactly
// one fact: THE PROVIDER ACCEPTED THIS IDENTIFIER AND SOMETHING ANSWERED. It is not a claim about
// which model answered. A row carrying it means "what answered when `gpt-6-astra` was requested" —
// which is weaker than it sounds, and is precisely the ambiguity this engine exists to refuse. It
// is carried, stamped and never quietly upgraded.
//
// WHY IT IS NOT SIMPLY `proven` WITH A FOOTNOTE. Because a footnote is lost on the second reading
// and every chart is a second reading. The state travels with the datum, not with the report.

import { CanonicalValue, digestObject } from './canonical';
import { EffortLevel, ProviderID } from './provider';

/** The admission state's name, in one place, so every surface stamps the same word. */
export const REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE = 'requestAcceptedIdentityUnverifiable' as const;

export type IdentityAdmissionState = typeof REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;

/**
 * The ONLY provider this exception may ever apply to.
 *
 * Not a default, not a starting value — a hard restriction, enforced in `authorizeIdentityAdmission`
 * and asserted by tests. The Claude CLI names the model that answered, so a Claude candidate that
 * cannot be proven has a different problem, and this exception would hide it.
 */
export const ADMISSIBLE_PROVIDERS: ProviderID[] = ['codexCLI'];

/** Whether this pass has activated the exception. It has not, and the tests assert it. */
export const ADMISSION_IS_ACTIVE = false;

/**
 * What must be true before `ADMISSION_IS_ACTIVE` may become true. Each is a separate decision.
 */
export const ACTIVATION_REQUIREMENTS: string[] = [
  'A person approves the exception explicitly, in the knowledge that it relaxes the one guarantee '
  + 'this engine was built to keep.',
  'The campaign manifest carries an IdentityAdmission record sealed against THAT campaign — an '
  + 'authorization cannot be written once and inherited by later runs.',
  'Every surface that can display a candidate stamps the state: attempt, report, chart, export, UI '
  + 'view, terminal view. A surface that cannot stamp it must refuse to display the candidate.',
  'Routing never consults an admitted candidate. Admission is for MEASUREMENT only.',
  'The refusal of an unproven candidate remains the default for every provider and every campaign '
  + 'that does not carry the record.',
];

/** The words every surface prints. Short enough to fit a chart legend, explicit enough to not mislead. */
export const ADMISSION_STAMP_SHORT = 'identity unverifiable — request accepted only';

export const ADMISSION_STAMP_LONG =
  'The provider accepted this identifier and something answered. The tool never named the model that '
  + 'replied, so this row means "what answered when this identifier was requested", NOT "this model '
  + 'answered". It is not verified identity and must not be read, cited or charted as though it were.';

/**
 * Everything about an admitted candidate that must survive into every artefact.
 *
 * All of it is REQUIRED. A record missing any field is refused rather than defaulted, because each
 * field is the answer to a question somebody will ask of a result months later, when the run is
 * gone and the artefact is all that is left.
 */
export interface AdmittedCandidateEvidence {
  provider: ProviderID;
  /** What was asked for. Never copied into any "returned model" field, anywhere. */
  requestedModelID: string;
  /** What effort was asked for. Transmitted and server-validated on Codex; never echoed back. */
  requestedEffort: EffortLevel;
  /** The CLI that carried the request, exactly as it reported itself. */
  cliVersion: string;
  /** How the account was authenticated. A subscription session and an API key are not the same run. */
  authenticationBasis: string;
  /** Digest of the identity-smoke evidence this admission rests on. */
  evidenceDigest: string;
  /** When that evidence was captured. */
  evidenceCapturedAt: string;
  /**
   * The returned model identity. ALWAYS EMPTY for this state, and present as a field precisely so
   * that its emptiness is explicit in every artefact rather than absent from it.
   */
  returnedModelID: '';
  state: IdentityAdmissionState;
}

/** A campaign-manifest authorization for the exception. Sealed, and bound to one campaign. */
export interface IdentityAdmission {
  admissionFormatVersion: number;
  /** The campaign this authorization is for. It is valid for no other. */
  campaignLabel: string;
  authorizedAt: string;
  /** Who said yes, in their own words. */
  authorizedBy: string;
  /** The exact configurations admitted. Not a provider-wide switch. */
  admitted: AdmittedCandidateEvidence[];
  /** Seals campaign, time, authorizer and every admitted candidate together. */
  admissionDigest: string;
}

export const ADMISSION_FORMAT_VERSION = 1;

export class IdentityAdmissionError extends Error {
  constructor(readonly code:
    | 'providerNotAdmissible' | 'noCandidates' | 'missingEvidence' | 'returnedIdentityPresent'
    | 'notAuthorized' | 'admissionMismatch' | 'notActivated',
  message: string) {
    super(message);
    this.name = 'IdentityAdmissionError';
  }
}

export interface AuthorizeAdmissionOptions {
  campaignLabel: string;
  authorizedAt: string;
  authorizedBy: string;
  admitted: AdmittedCandidateEvidence[];
}

/**
 * Write an admission record, or refuse to.
 *
 * Refusing is the common case and it is not an error condition — it is the engine declining to
 * record an exception nobody is entitled to.
 */
export function authorizeIdentityAdmission(options: AuthorizeAdmissionOptions): IdentityAdmission {
  if (options.admitted.length === 0) {
    throw new IdentityAdmissionError('noCandidates',
      'an identity admission must name the exact configurations it admits. An empty record would be a '
      + 'provider-wide exception, which is the thing this design refuses to offer.');
  }

  for (const entry of options.admitted) {
    if (!ADMISSIBLE_PROVIDERS.includes(entry.provider)) {
      throw new IdentityAdmissionError('providerNotAdmissible',
        `${entry.provider} cannot be admitted under this exception. It applies only to `
        + `${ADMISSIBLE_PROVIDERS.join(', ')}, whose CLI names no model in its reply. A candidate on a `
        + 'provider that DOES report identity and still could not be proven has a different problem, '
        + 'and admitting it here would conceal that.');
    }
    if (entry.returnedModelID !== '') {
      // Guards the exact backfill Pass 5B forbade: the requested identifier must never become the
      // returned one. If a provider ever DOES name a model, this state is the wrong one entirely.
      throw new IdentityAdmissionError('returnedIdentityPresent',
        `${entry.requestedModelID}: a returned model identity is present, so this candidate does not `
        + 'need this exception and must not be recorded under it. Never backfill the requested '
        + 'identifier into the returned-model field.');
    }
    const missing = ([
      ['requestedModelID', entry.requestedModelID], ['requestedEffort', entry.requestedEffort],
      ['cliVersion', entry.cliVersion], ['authenticationBasis', entry.authenticationBasis],
      ['evidenceDigest', entry.evidenceDigest], ['evidenceCapturedAt', entry.evidenceCapturedAt],
    ] as [string, string][]).filter(([, value]) => value.length === 0).map(([name]) => name);
    if (missing.length > 0) {
      throw new IdentityAdmissionError('missingEvidence',
        `${entry.requestedModelID || '(unnamed)'}: an admitted candidate must carry ${missing.join(', ')}. `
        + 'A weaker claim needs MORE provenance than a proof does, not less — it is the only thing a '
        + 'reader will have to judge it by.');
    }
    if (entry.state !== REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE) {
      throw new IdentityAdmissionError('admissionMismatch',
        `${entry.requestedModelID}: an admitted candidate carries the state `
        + `'${REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE}' and no other.`);
    }
  }

  const body = {
    admissionFormatVersion: ADMISSION_FORMAT_VERSION,
    campaignLabel: options.campaignLabel,
    authorizedAt: options.authorizedAt,
    authorizedBy: options.authorizedBy,
    admitted: options.admitted,
  };
  return { ...body, admissionDigest: digestObject(body as unknown as CanonicalValue) };
}

/** Recompute the seal. A record whose contents changed after authorization is not that record. */
export function admissionSealIsIntact(admission: IdentityAdmission): boolean {
  const { admissionDigest, ...body } = admission;
  return digestObject(body as unknown as CanonicalValue) === admissionDigest;
}

/**
 * The gate. Would this candidate be admitted, under this manifest, for this campaign?
 *
 * DEFAULT IS REFUSAL, and refusal is what happens when the answer is unclear for any reason: no
 * record, a record for another campaign, a broken seal, a candidate the record does not name, or —
 * as in this pass — the exception not being active at all.
 */
export function admissionFor(options: {
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  campaignLabel: string;
  admission?: IdentityAdmission;
  active?: boolean;
}): { admitted: boolean; reason: string; evidence?: AdmittedCandidateEvidence } {
  const active = options.active ?? ADMISSION_IS_ACTIVE;
  if (!active) {
    return { admitted: false, reason:
      'the identity admission exception is not active. An unproven candidate is refused, which is the '
      + 'default and remains so until a person activates the exception deliberately.' };
  }
  if (options.admission === undefined) {
    return { admitted: false, reason:
      'this campaign manifest carries no identity admission record, so an unproven candidate is refused.' };
  }
  if (options.admission.campaignLabel !== options.campaignLabel) {
    return { admitted: false, reason:
      `the admission record names campaign '${options.admission.campaignLabel}', not `
      + `'${options.campaignLabel}'. An exception is granted to one campaign and is never inherited.` };
  }
  if (!admissionSealIsIntact(options.admission)) {
    return { admitted: false, reason:
      'the admission record\'s seal does not match its contents, so what was authorized is not what is '
      + 'being asked for.' };
  }
  const evidence = options.admission.admitted.find((entry) =>
    entry.provider === options.provider && entry.requestedModelID === options.modelID
    && entry.requestedEffort === options.effort);
  if (evidence === undefined) {
    return { admitted: false, reason:
      `${options.modelID} at effort ${options.effort} is not named in this campaign's admission record. `
      + 'Admission is per configuration, never per provider.' };
  }
  return { admitted: true, evidence, reason: ADMISSION_STAMP_LONG };
}

/**
 * The one-line stamp a surface prints beside an admitted candidate.
 *
 * Every surface calls THIS rather than composing its own wording, so that a chart legend and a CSV
 * column and a terminal row cannot drift into describing the same state three different ways.
 */
export function admissionStamp(evidence: AdmittedCandidateEvidence): string {
  return `[${REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE}] ${evidence.requestedModelID} `
    + `(requested, effort ${evidence.requestedEffort}) — ${ADMISSION_STAMP_SHORT}; returned model: none`;
}

/** The full provenance block, for an artefact with room for it. */
export function admissionProvenance(evidence: AdmittedCandidateEvidence): string[] {
  return [
    `state: ${evidence.state}`,
    `requested model: ${evidence.requestedModelID}`,
    `requested effort: ${evidence.requestedEffort}`,
    'returned model: none — the provider named no model',
    `CLI version: ${evidence.cliVersion}`,
    `authentication: ${evidence.authenticationBasis}`,
    `evidence digest: ${evidence.evidenceDigest}`,
    `evidence captured: ${evidence.evidenceCapturedAt}`,
    ADMISSION_STAMP_LONG,
  ];
}

/**
 * Routing must never consult an admitted candidate.
 *
 * Present as a named function so the rule is greppable and testable rather than a line in a comment
 * somebody has to remember. Measurement and routing are different questions, and a candidate whose
 * identity is unknown can answer only the first.
 */
export function isRoutable(state: IdentityAdmissionState | 'verified'): boolean {
  return state === 'verified';
}
