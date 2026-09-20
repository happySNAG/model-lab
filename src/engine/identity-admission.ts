// Benchmark engine · the narrow exception by which a candidate is admitted WITHOUT its identity ever
// having been proven.
//
// ============================================================================================
// APPROVED AND ACTIVE AS OF PASS 6 — Decision 1(b), for codexCLI.
// EXTENDED TO opencodeCLI IN PASS 7, on the same terms and by a separate written approval.
//
// Pass 5C wrote this module inert, as a design, so that Pass 6 could be approved or declined
// against the real thing rather than against a paragraph describing it. Pass 6 approved it. What
// changed is ONE fact: `ADMISSION_IS_ACTIVE` is now true, which means a campaign MAY carry an
// admission record. It does not mean any campaign does. Every other refusal in this file is
// untouched, and a campaign with no sealed, self-named admission record still refuses an unproven
// candidate exactly as it did before — see `admissionFor`, whose default is refusal.
// ============================================================================================
//
// THE PROBLEM IT ADDRESSES. Some tools answer a request perfectly and will not say who answered.
//
//   CODEX. `codex exec --json` names no model in any event it emits. Not in `thread.started`, not in
//   `item.completed`, not in `turn.completed`. All six requested Codex configurations answer, the
//   requested identifier is accepted, and the tool will still not say who replied.
//
//   OPENCODE, ADDED IN PASS 7. `opencode run --format json` emits no assistant message, which is the
//   only event carrying `providerID`/`modelID`; `run` reads it solely in its non-JSON branch, to print
//   it for a person. One authorized live request on 2026-09-20 confirmed it: `opencode/big-pickle` was
//   accepted, answered, and fully measured — answer, tokens, cost, finish state all readable — and
//   named nobody. The 922 captured bytes are in `test/engine/fixtures/opencode-run-json.ts`.
//
//   THEY ARE NOT THE SAME FAULT, and the difference is recorded rather than smoothed over. Codex's
//   silence is total and declared. OpenCode HAS the field and routes it away from stdout, so a
//   substituted model returns byte-identical output and `modelMismatch` cannot fire: on that path
//   substitution is UNDETECTABLE, not merely unproven. Both are admissible; the OpenCode position is
//   strictly weaker, the approval was given knowing that, and `IDENTITY_UNNAMEABLE_BECAUSE` says so on
//   every surface that quotes a reason.
//
// So candidates on these providers are `unverifiable`, and the campaign builder refuses an unproven
// candidate by design. That refusal remains the default. This module is the only way past it, and
// it costs a person a written, sealed, per-campaign authorization to use.
//
// WHAT THE STATE MEANS, AND WHAT IT DOES NOT. `requestAcceptedIdentityUnverifiable` records exactly
// one fact: THE PROVIDER ACCEPTED THIS IDENTIFIER AND SOMETHING ANSWERED. It is not a claim about
// which model answered. A row carrying it means "what answered when `gpt-6-astra` was requested" —
// which is weaker than it sounds, and is precisely the ambiguity this engine exists to refuse. It
// is carried, stamped and never quietly upgraded.
//
// WHY IT IS NOT SIMPLY `proven` WITH A FOOTNOTE. Because a footnote is lost on the second reading
// and every chart is a second reading. The state travels with the datum, not with the report.
//
// WHAT ACTIVATION DID NOT CHANGE, and what the tests in `identity-admission-pass6.test.ts` hold
// shut:
//
//   · fail-closed is still the default. No record, a record for another campaign, a broken seal, a
//     candidate the record does not name: refused, every time, with the reason said out loud.
//   · claudeCLI can never be admitted, nor an anthropicAPI or openaiAPI candidate. Those name the model
//     that answered, so an unprovable candidate on one has a different fault and this exception would
//     hide it. Membership takes a STRUCTURAL inability to name the model, not a difficult case.
//   · the returned-model field stays empty. Forever. On every artefact.
//   · routing never consults an admitted candidate — `isRoutable`.
//   · promotion never consults one either — `isPromotable`, added in Pass 6, because a retention
//     recommendation and a capability role are promotion in every sense that matters.
//   · nothing outside this repository is touched. See `NEVER_AFFECTS`.

import { CanonicalValue, digestObject } from './canonical';
import {
  EffortLevel, IDENTITY_ADMISSIBLE_PROVIDERS, IDENTITY_UNNAMEABLE_BECAUSE, ProviderID,
  REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, isIdentityAdmissibleProvider,
} from './provider';

/**
 * The admission state's name, in one place, so every surface stamps the same word.
 *
 * Re-exported from `provider.ts` rather than declared twice: it is a member of
 * `BindingIdentityState` and has to be defined where that type is, or the two could drift. Callers
 * import it from here, where its meaning is written down.
 */
export { REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE };

export type IdentityAdmissionState = typeof REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;

/**
 * The ONLY providers this exception may ever apply to.
 *
 * Not a default, not a starting value — a hard restriction, enforced in `authorizeIdentityAdmission`
 * and asserted by tests. The Claude CLI names the model that answered, so a Claude candidate that
 * cannot be proven has a different problem, and this exception would hide it.
 *
 * The list is the same object `validateBinding` enforces, read from `provider.ts` rather than
 * restated, so the authority a person reads and the authority the validator applies cannot drift.
 * `IDENTITY_UNNAMEABLE_BECAUSE` carries each provider's reason for being on it.
 */
export const ADMISSIBLE_PROVIDERS: ProviderID[] = [...IDENTITY_ADMISSIBLE_PROVIDERS];

export { IDENTITY_UNNAMEABLE_BECAUSE, isIdentityAdmissibleProvider };

/**
 * Whether the exception exists at all. Approved in Pass 6; true.
 *
 * READ THIS CAREFULLY, because the name invites a misreading. True here means "a campaign MAY carry
 * an admission record", not "candidates are admitted". Admission is decided per campaign and per
 * configuration by `admissionFor`, which refuses unless a sealed record names that exact candidate
 * for that exact campaign. Flipping this back to false would refuse every admission everywhere,
 * which is why it stays a switch rather than being deleted now that it is on.
 */
export const ADMISSION_IS_ACTIVE = true;

/**
 * What approved the EXCEPTION ITSELF, when, and on whose authority. Written into every artefact that
 * discloses one.
 *
 * This is the Pass 6 decision that created the exception and remains its origin. Extending it to a
 * second provider in Pass 7 did not re-approve it — see `ADMISSION_PROVIDER_APPROVALS`, which records
 * per provider who approved that provider and on what evidence. The two are kept apart because "the
 * exception is approved" and "this provider is inside it" are different claims, and a reader
 * checking the second should not be handed the first.
 */
export const ADMISSION_APPROVAL = {
  pass: 'Cernum Pass 6',
  decision: '1(b) — admit Codex candidates under the narrowly scoped, recorded identity exception '
    + 'designed in Pass 5C',
  approvedAt: '2026-09-13',
  approvedBy: 'the repository owner, in writing, in the Pass 6 approval prompt',
  designedIn: 'Pass 5C, and activated without alteration: the refusals approved were the refusals shipped',
} as const;

/**
 * WHO APPROVED EACH ADMISSIBLE PROVIDER, and on what evidence.
 *
 * A provider is not admitted because its interface happens to be quiet. It is admitted because a
 * person looked at what the tool actually returns, saw that identity is structurally absent, and said
 * yes in writing. This is that record, per provider, so that adding a third provider later is
 * visibly a decision somebody made rather than an entry that appeared in a list.
 */
export const ADMISSION_PROVIDER_APPROVALS: Partial<Record<ProviderID, {
  readonly pass: string; readonly approvedAt: string; readonly approvedBy: string;
  readonly decision: string; readonly evidence: string;
}>> = {
  codexCLI: {
    pass: 'Cernum Pass 6',
    approvedAt: '2026-09-13',
    approvedBy: 'the repository owner, in writing, in the Pass 6 approval prompt',
    decision: '1(b) — admit Codex candidates under the recorded identity exception designed in Pass 5C',
    evidence: 'all six requested Codex configurations answered and `codex exec --json` named no model in '
      + 'any event it emits',
  },
  opencodeCLI: {
    pass: 'Cernum Pass 7',
    approvedAt: '2026-09-20',
    approvedBy: 'the repository owner, in writing, approving the Pass 7 governance decision put to them '
      + 'after the first live OpenCode request was measured',
    decision: 'grant opencodeCLI the existing requestAcceptedIdentityUnverifiable treatment, analogous to '
      + 'codexCLI: measured but not promotable or routable without stronger identity proof',
    evidence: 'one authorized live request to opencode/big-pickle on 2026-09-20 was accepted, answered, and '
      + 'fully measured — answer, tokens, cost and finish state all read from the envelope — and carried no '
      + 'identity field, because `opencode run --format json` emits no assistant message. The 922 captured '
      + 'bytes are committed at test/engine/fixtures/opencode-run-json.ts. The approval was given in the '
      + 'knowledge that substitution is UNDETECTABLE on this path, not merely unproven.',
  },
};

/**
 * What this exception must never reach. Not a note — each one is asserted by a test.
 *
 * The exception exists to let a MEASUREMENT be taken. Everything on this list is a decision made ON
 * a measurement, and a decision made on an identity nobody established is a decision about nothing.
 */
export const NEVER_AFFECTS: string[] = [
  'production routing — see isRoutable; an admitted candidate is never a routing target',
  'automatic model promotion — see isPromotable; no retention recommendation, no capability role',
  'Skippy — nothing in this engine writes to that application, and an admitted candidate reaches no '
  + 'configuration it reads',
  'Ordra — likewise',
  'any campaign that does not carry its own sealed admission record, on any provider',
];

/**
 * What had to be true before `ADMISSION_IS_ACTIVE` could become true. Each was a separate decision;
 * `ACTIVATION_SATISFIED_BY` records where each one is now actually enforced, so a reader can check
 * the claim rather than take it.
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

/**
 * Where each activation requirement is now enforced, in the same order.
 *
 * A list of requirements is a promise; this is the address of the code that keeps each one. It
 * exists so that "we satisfied the conditions" is a claim a reader can check in an afternoon rather
 * than one they have to accept.
 */
export const ACTIVATION_SATISFIED_BY: string[] = [
  'approval: ADMISSION_APPROVAL, recorded above, naming the pass, the decision and the date.',
  'per-campaign seal: authorizeIdentityAdmission seals campaignLabel, time, authorizer and every '
  + 'admitted candidate together; admissionFor refuses a record naming another campaign, and '
  + 'Campaign.create binds admissionDigest into the frozen manifest.',
  'every surface stamps it: campaign-builder writes the state onto the binding, campaign.ts writes '
  + 'it onto every ledger row, frontier-metrics carries it into every attempt and candidate '
  + 'aggregate, the terminal prints an identity-confidence block, the Campaigns view stamps the '
  + 'binding and the attempt, and assertSurfaceCanStamp refuses a surface that cannot.',
  'routing and promotion: isRoutable and isPromotable, called by ranking.ts and retention.ts, so an '
  + 'admitted candidate qualifies for no role and earns no retention recommendation.',
  'the default is unchanged: buildCampaignPlan still throws unprovenModel for every candidate no '
  + 'record admits, on every provider, in every campaign.',
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
    if (!isIdentityAdmissibleProvider(entry.provider)) {
      throw new IdentityAdmissionError('providerNotAdmissible',
        `${entry.provider} cannot be admitted under this exception. It applies only to `
        + `${ADMISSIBLE_PROVIDERS.join(', ')}, whose interfaces structurally cannot name the model that `
        + 'answered. A candidate on a provider that DOES report identity and still could not be proven '
        + 'has a different problem, and admitting it here would conceal that.');
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
export function isRoutable(state: IdentityAdmissionState | 'verified' | 'unverifiable'): boolean {
  return state === 'verified';
}

/**
 * Promotion must never consult one either. ADDED IN PASS 6.
 *
 * `isRoutable` alone was not enough, and the gap is worth naming. This engine does not route
 * anything — it recommends. A retention recommendation that says "Keep gpt-6-astra" and a capability
 * role that says "qualified: structured worker" are how a measurement becomes a decision to use a
 * model, which is promotion by every route that matters here, and neither of them passes through
 * anything called routing. So the rule is stated a second time, for the thing this engine actually
 * does, and `ranking.ts` and `retention.ts` both call it.
 *
 * An admitted candidate still gets its RATE published in full. Refusing to publish the measurement
 * would defeat the point of taking it. What is refused is the sentence that turns the measurement
 * into an instruction about a model nobody can name.
 */
export function isPromotable(state: IdentityAdmissionState | 'verified' | 'unverifiable' | string): boolean {
  return state !== REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE;
}

/** Why a measured, unpromotable candidate is not promotable, for the surface that has to say so. */
export const NOT_PROMOTABLE_BECAUSE =
  'this candidate ran under the accepted-request identity exception: the provider accepted the '
  + 'identifier and something answered, and nothing named what. Its measurements are published in '
  + 'full; a recommendation to use it is not, because a recommendation about a model nobody can name '
  + 'is a recommendation about nothing.';

/**
 * The rule that a surface which cannot stamp the state must refuse to display the candidate.
 *
 * `stamp` is what the surface is able to print. A surface with no room for one says so by passing an
 * empty string, and gets an exception rather than a quietly unlabelled row — which is the whole
 * difference between a disclosure and an intention to disclose.
 */
export function assertSurfaceCanStamp(surface: string, state: string, stamp: string): void {
  if (state !== REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE) return;
  if (stamp.trim().length === 0) {
    throw new IdentityAdmissionError('notActivated',
      `${surface} cannot stamp the accepted-request identity state, so it must not display this candidate at all. `
      + 'A surface that shows an admitted candidate without its state shows a verified-looking row, and that is the '
      + 'one outcome this exception was designed to prevent.');
  }
}
